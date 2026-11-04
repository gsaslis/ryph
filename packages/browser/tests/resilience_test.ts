// The sidecar against pages that fight back, in a REAL Chromium: a click handler that never
// returns, a renderer that crashes, a "Leave site?" prompt, a page that redefines the builtins
// `evaluate` serialises with — and launches that go wrong. Each was a bug before it was a test.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Browser, chromium } from "playwright-core";
import type { LiveEvent } from "../src/core/live.ts";
import {
  type Harness,
  haveChromium,
  pages,
  refOf,
  sleep,
  startHarness,
  textOf,
} from "./_harness.ts";

const chromiumTest = test.skipIf(!haveChromium);

type Launch = typeof chromium.launch;

/** Runs `fn` with chromium.launch wrapped (the adapter imports the same object), then restores it. */
async function withLaunch<T>(wrap: (real: Launch) => Launch, fn: () => Promise<T>): Promise<T> {
  const real = chromium.launch.bind(chromium);
  chromium.launch = wrap(real);
  try {
    return await fn();
  } finally {
    chromium.launch = real;
  }
}

async function using(
  harness: Promise<Harness>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness;
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const actions = (lines: LiveEvent[]) =>
  lines.filter((l) => l.type === "action") as Array<Extract<LiveEvent, { type: "action" }>>;

chromiumTest("a click handler that never returns does not wedge the calls after it", async () => {
  const site = await pages({
    "/": `<title>Spin</title><button onclick="while(true){}">Spin</button>`,
    "/next": "<title>Next</title><h1>Next page</h1>",
  });
  await using(startHarness(), async (h) => {
    const nav = textOf(await h.call("navigate", { url: site.url }));
    const clicked = await h.call("click", {
      ref: refOf(nav, /button "Spin"/),
      element: "Spin",
    });
    assert(clicked.isError, "the click itself cannot finish");

    // Before the fix this never answered: keyboard.press has no deadline of its own.
    const started = performance.now();
    const pressed = await h.call("press_key", { key: "Tab" });
    const pressMs = Math.round(performance.now() - started);
    console.log(`press_key after the hang: ${pressMs} ms`);
    assert(!pressed.isError, textOf(pressed));
    assertStringIncludes(textOf(pressed), "it was stopped");
    assert(pressMs < 15_000);

    const next = await h.call("navigate", { url: `${site.url}/next` });
    assert(!next.isError, textOf(next));
    assertStringIncludes(textOf(next), "Title: Next");
  });
  await site.close();
});

chromiumTest(
  "a page stuck where no script can be stopped (a sync XHR) is replaced with a fresh tab",
  async () => {
    const never = Promise.withResolvers<Response>();
    const site = await pages({
      "/": `<title>Sync</title><button onclick="const x = new XMLHttpRequest();
x.open('GET', '/never', false); x.send()">Hang</button>`,
      "/never": () => never.promise,
      "/next": "<title>Next</title><h1>Next page</h1>",
    });
    await using(startHarness(), async (h) => {
      const nav = textOf(await h.call("navigate", { url: site.url }));
      const clicked = await h.call("click", { ref: refOf(nav, /button "Hang"/), element: "Hang" });
      assert(clicked.isError);
      const next = await h.call("navigate", { url: `${site.url}/next` });
      assert(!next.isError, textOf(next));
      assertStringIncludes(textOf(next), "Tab 0 stopped answering");
      assertStringIncludes(textOf(next), "Title: Next");
      assert(h.warnings.some((w) => w.event === "browser.tab_replaced"));
    });
    never.resolve(new Response("late"));
    await site.close();
  },
);

chromiumTest(
  "a call past the overall deadline is abandoned, the tab is woken, and the queue moves on",
  async () => {
    // A script that holds the page longer than the deadline, via the agent's own evaluate with
    // a timeout past it: the deadline, not evaluate's own timer, has to end it.
    const site = await pages({ "/": "<title>Busy</title><p>busy</p>" });
    await using(startHarness({ callDeadlineMs: 3_000 }), async (h) => {
      await h.call("navigate", { url: site.url });
      const started = performance.now();
      const stuck = await h.call("evaluate", {
        function: "() => { while (true) {} }",
        timeoutMs: 20_000,
      });
      const ms = Math.round(performance.now() - started);
      console.log(`deadline answered after ${ms} ms`);
      assert(stuck.isError);
      assertStringIncludes(textOf(stuck), "did not finish in 3 s");
      assert(ms < 10_000);
      const after = await h.call("evaluate", { function: "() => document.title" });
      assert(!after.isError, textOf(after));
      assertStringIncludes(textOf(after), '"Busy"');
      assert(h.warnings.some((w) => w.event === "browser.tool_deadline"));
    });
    await site.close();
  },
);

chromiumTest(
  "an abandoned call's late report does not eat the next call's console errors",
  async () => {
    // A (wait_for 5.5 s) is abandoned at the 4 s deadline but goes on to write its report at
    // 5.5 s. B (navigate) logs an error at once and then waits 2.5 s for a slow image before its own
    // report. Run side by side, A's late report took B's error from the shared cursor and B
    // answered without it.
    const site = await pages({
      "/": "<title>Start</title><p>start</p>",
      "/b": `<title>B</title><script>console.error("caused by B")</script><img src="/slow">`,
      "/slow": async () => {
        await sleep(2_500);
        return new Response("", { headers: { "content-type": "image/png" } });
      },
    });
    await using(startHarness({ callDeadlineMs: 4_000 }), async (h) => {
      await h.call("navigate", { url: site.url });
      const a = h.call("wait_for", { seconds: 5.5 });
      const b = h.call("navigate", { url: `${site.url}/b` });
      const first = await a;
      assert(first.isError);
      assertStringIncludes(textOf(first), "did not finish in 4 s");
      const second = await b;
      assert(!second.isError, textOf(second));
      assertStringIncludes(textOf(second), "Title: B");
      assertStringIncludes(textOf(second), "caused by B");
    });
    await site.close();
  },
);

chromiumTest("a crashed tab is replaced, streamed again, and the next result says so", async () => {
  const site = await pages({ "/": "<title>Fragile</title><p>fragile</p>" });
  let browser: Browser | null = null;
  await withLaunch(
    (real) => async (o) => (browser = await real(o)),
    () =>
      using(startHarness(), async (h) => {
        await h.call("navigate", { url: site.url });
        const tabsBefore = h.lines.filter((l) => l.type === "tabs").length;
        const page = browser!.contexts()[0].pages()[0];
        const cdp = await page.context().newCDPSession(page);
        void cdp.send("Page.crash").catch(() => {});
        // Replaced at once, before any call: a tabs line and fresh frames from the new tab.
        const replaced = (t: LiveEvent) =>
          t.type === "tabs" && t.tabs[0] !== undefined && t.tabs[0].id !== "t1" &&
          t.tabs[0].active;
        for (let i = 0; i < 50; i++) {
          const tabs = h.lines.filter((l) => l.type === "tabs").slice(tabsBefore);
          if (tabs.some(replaced)) break;
          await sleep(100);
        }
        // And no viewer saw the half-way state: every tabs line has an active tab.
        const during = h.lines.filter((l) => l.type === "tabs").slice(tabsBefore) as Array<
          Extract<LiveEvent, { type: "tabs" }>
        >;
        for (const t of during) {
          assert(t.tabs.some((tab) => tab.active), `no active tab: ${JSON.stringify(t.tabs)}`);
        }
        const last = h.lines.filter((l) => l.type === "tabs").at(-1) as Extract<
          LiveEvent,
          { type: "tabs" }
        >;
        assertEquals(last.tabs.length, 1);
        assert(last.tabs[0].id !== "t1" && last.tabs[0].active, JSON.stringify(last.tabs));
        const reopened = await h.call("navigate", { url: site.url });
        assert(!reopened.isError, textOf(reopened));
        assertStringIncludes(textOf(reopened), "Tab 0 crashed");
        assertStringIncludes(textOf(reopened), "Title: Fragile");
        await sleep(300);
        const frames = h.lines.filter((l) => l.type === "frame") as Array<
          Extract<LiveEvent, { type: "frame" }>
        >;
        assertEquals(frames.at(-1)!.frame.tabId, last.tabs[0].id);
        const statuses = h.lines.filter((l) => l.type === "status").map((l) =>
          (l as { status: string }).status
        );
        assertEquals(statuses, ["launching", "active"], "a tab crash is not a browser crash");
      }),
  );
  await site.close();
});

chromiumTest(
  "a 'Leave site?' prompt is accepted, so the agent can leave a form it typed into",
  async () => {
    const site = await pages({
      "/": `<title>Form</title><input aria-label="name"><a href="/other">Leave</a>
<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>`,
      "/other": "<title>Other</title><p>other</p>",
    });
    await using(startHarness(), async (h) => {
      const nav = textOf(await h.call("navigate", { url: site.url }));
      // Typed key by key: Chromium only asks "Leave site?" of a page the user touched.
      await h.call("type", {
        ref: refOf(nav, /textbox "name"/),
        element: "name",
        text: "x",
        slowly: true,
      });
      const left = await h.call("navigate", { url: `${site.url}/other` });
      assert(!left.isError, textOf(left));
      assertStringIncludes(textOf(left), "Title: Other");
      assertStringIncludes(textOf(left), "beforeunload (accepted)");
    });
    await site.close();
  },
);

chromiumTest(
  "evaluate's cap holds against a page that redefines JSON.stringify and String#slice",
  async () => {
    const site = await pages({
      "/": `<title>Hostile</title><script>
JSON.stringify = () => "x".repeat(5000000);
String.prototype.slice = function () { return String(this); };
window.__store = { n: 42 };
</script>`,
    });
    await using(startHarness(), async (h) => {
      await h.call("navigate", { url: site.url });
      const out = await h.call("evaluate", { function: "() => window.__store" });
      const body = textOf(out);
      console.log(`hostile evaluate answered ${body.length} chars`);
      assert(!out.isError, body);
      assertStringIncludes(body, "The result was cut at 20 KB of");
      assert(body.length < 21 * 1024, `${body.length} chars`);
    });
    await site.close();
  },
);

chromiumTest(
  "an action's target is measured after the element is scrolled into view; summaries are clipped",
  async () => {
    const options = Array.from(
      { length: 60 },
      (_, i) => `<option>${"option number " + i + " ".repeat(1) + "x".repeat(40)}</option>`,
    ).join("");
    const site = await pages({
      "/": `<title>Long</title><div style="height:3000px"></div><button>Far</button>
<select multiple aria-label="Many">${options}</select>`,
    });
    await using(startHarness(), async (h) => {
      const nav = textOf(await h.call("navigate", { url: site.url }));
      await h.call("click", { ref: refOf(nav, /button "Far"/), element: "Far" });
      const values = Array.from({ length: 60 }, (_, i) => `option number ${i} ${"x".repeat(40)}`);
      const picked = await h.call("select_option", {
        ref: refOf(nav, /listbox "Many"/),
        element: "Many",
        values,
      });
      assert(!picked.isError, textOf(picked));
      const click = actions(h.lines).find((a) => a.tool === "click")!;
      assert(click.target, "the click carries a target");
      assert(
        click.target.y >= 0 && click.target.y + click.target.height <= 800,
        `target ${JSON.stringify(click.target)} is not inside the viewport`,
      );
      const select = actions(h.lines).find((a) => a.tool === "select_option")!;
      assert(select.summary.length <= 300, `summary is ${select.summary.length} chars`);
    });
    await site.close();
  },
);

chromiumTest(
  "RYPH_BROWSER_SANDBOX=required never falls back: a clear error, and status closed",
  async () => {
    const tried: boolean[] = [];
    await withLaunch(
      (real) => (o) => {
        tried.push(o?.chromiumSandbox === true);
        if (o?.chromiumSandbox) {
          return Promise.reject(new Error("browser closed\n[err] No usable sandbox! (test)"));
        }
        return real(o);
      },
      () =>
        using(startHarness({ sandbox: "required" }), async (h) => {
          const out = await h.call("navigate", { url: "about:blank" });
          assert(out.isError);
          assertStringIncludes(textOf(out), "RYPH_BROWSER_SANDBOX=required");
          assertStringIncludes(textOf(out), "No usable sandbox! (test)");
          assert(!textOf(out).includes("Untrusted page content"), "the platform's own words");
          assertEquals(tried, [true]);
          // /live is its own connection, so its last line can land after the tool's answer.
          const lastStatus = () =>
            (h.lines.filter((l) => l.type === "status").at(-1) as { status: string } | undefined)
              ?.status;
          for (let i = 0; i < 100 && lastStatus() !== "closed"; i++) await sleep(20);
          assertEquals(lastStatus(), "closed");
        }),
    );
  },
);

chromiumTest(
  "RYPH_BROWSER_SANDBOX=off launches without the sandbox, and without trying it first",
  async () => {
    const tried: boolean[] = [];
    await withLaunch(
      (real) => (o) => {
        tried.push(o?.chromiumSandbox === true);
        return real(o);
      },
      () =>
        using(startHarness({ sandbox: "off" }), async (h) => {
          const out = await h.call("navigate", { url: "about:blank" });
          assert(!out.isError, textOf(out));
          assertEquals(tried, [false]);
          assert(!h.warnings.some((w) => w.event === "browser.sandbox_unavailable"));
        }),
    );
  },
);

chromiumTest("a launch that fails after Chromium started closes that Chromium", async () => {
  const launched: Browser[] = [];
  await withLaunch(
    (real) => async (o) => {
      const browser = await real(o);
      launched.push(browser);
      browser.newContext = () => Promise.reject(new Error("no context for you"));
      return browser;
    },
    () =>
      using(startHarness({ sandbox: "off" }), async (h) => {
        const out = await h.call("navigate", { url: "about:blank" });
        assert(out.isError);
        assertStringIncludes(textOf(out), "no context for you");
        assertEquals(launched.length, 1);
        assert(!launched[0].isConnected(), "the half-launched Chromium is still running");
        // /live is its own connection, so its last line can land after the tool's answer.
        const lastStatus = () =>
          (h.lines.filter((l) => l.type === "status").at(-1) as { status: string } | undefined)
            ?.status;
        for (let i = 0; i < 100 && lastStatus() !== "closed"; i++) await sleep(20);
        assertEquals(lastStatus(), "closed");
      }),
  );
});

chromiumTest("a tab visited over and over does not hoard old documents in its heap", async () => {
  // The soak's finding at a test's scale: the floor is lowered from 64 MiB so 40 visits cross
  // it. Without the collection the heap keeps every visit's document (~1 MiB each here).
  const site = await pages({
    "/": `<title>Again</title><input aria-label="name"><button>Go</button>`,
  });
  let browser: Browser | null = null;
  await withLaunch(
    (real) => async (o) => (browser = await real(o)),
    () =>
      using(startHarness({ heapTidyBytes: 8 * 1024 * 1024 }), async (h) => {
        for (let i = 0; i < 40; i++) await h.call("navigate", { url: site.url });
        const page = browser!.contexts()[0].pages()[0];
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable");
        const { metrics } = await cdp.send("Performance.getMetrics");
        const documents = metrics.find((m) => m.name === "Documents")!.value;
        const { usedSize } = await cdp.send("Runtime.getHeapUsage");
        console.log(
          `after 40 visits: ${documents} documents, heap ${Math.round(usedSize / 1048576)} MiB`,
        );
        assert(documents < 25, `${documents} documents still held`);
        assert(usedSize < 20 * 1024 * 1024, `heap at ${usedSize}`);
      }),
  );
  await site.close();
});
