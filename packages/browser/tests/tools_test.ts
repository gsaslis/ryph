// The tool runner without a browser: one call at a time, but none holds the queue past its
// deadline, and what the browser has to say reaches the next result.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ChromiumBrowser } from "../src/adapters/chromium.ts";
import { NO_VISION_REFUSAL, ToolRunner, TOOLS, toolsFor } from "../src/mcp/tools.ts";
import { text, type ToolResult } from "../src/core/tool_result.ts";

function fakeBrowser(over: Record<string, unknown> = {}) {
  const log: string[] = [];
  let notices: string[] = [];
  const browser = {
    ensureLaunched: () => Promise.resolve(),
    snapshot: () => new Promise<ToolResult>(() => {}), // never answers
    consoleMessages: () => text("No console messages since the last call."),
    recover: () => {
      log.push("recover");
      notices.push("Tab 0 was replaced.");
      return Promise.resolve();
    },
    suspect: () => log.push("suspect"),
    takeNotices: () => notices.splice(0),
    ...over,
  };
  return {
    browser: browser as unknown as ChromiumBrowser,
    log,
    setNotices: (n: string[]) => notices = n,
  };
}

const diag = { info: () => {}, warn: () => {} };
const body = (r: ToolResult) => r.content.map((c) => c.type === "text" ? c.text : "").join("\n");

test("a call past its deadline is answered, recovery runs, and the queue moves on", async () => {
  const { browser, log } = fakeBrowser();
  const runner = new ToolRunner(browser, diag, 50, { graceMs: 100 });
  const stuck = runner.call("snapshot", {})!;
  const next = runner.call("console_messages", {})!;
  const first = await stuck;
  assert(first.isError);
  assertStringIncludes(body(first), "snapshot did not finish in 50 ms and was abandoned");
  // The recovery's own notice rides on the answer it happened in.
  assertStringIncludes(body(first), "Tab 0 was replaced.");
  const second = await next;
  assert(!second.isError);
  assertEquals(body(second), "No console messages since the last call.");
  assertEquals(log, ["recover", "suspect"]);
});

test("notices the browser holds open the next result, whatever tool it is", async () => {
  const { browser, setNotices } = fakeBrowser();
  setNotices(["Tab 1 crashed (its renderer process died) and was replaced with a blank tab."]);
  const runner = new ToolRunner(browser, diag, 1_000);
  const out = await runner.call("console_messages", {})!;
  assertEquals(
    body(out),
    "Tab 1 crashed (its renderer process died) and was replaced with a blank tab.\n" +
      "No console messages since the last call.",
  );
  assertEquals(
    body(await runner.call("console_messages", {})!),
    "No console messages since the last call.",
  );
});

test("the next call waits for an abandoned one to settle, so the two never overlap", async () => {
  const log: string[] = [];
  const { browser } = fakeBrowser({
    snapshot: async () => {
      log.push("snapshot start");
      await new Promise((r) => setTimeout(r, 200));
      log.push("snapshot end");
      return text("late");
    },
    consoleMessages: () => {
      log.push("console_messages");
      return text("none");
    },
  });
  const runner = new ToolRunner(browser, diag, 50, { graceMs: 5_000 });
  const stuck = runner.call("snapshot", {})!;
  const next = runner.call("console_messages", {})!;
  assert((await stuck).isError);
  assertEquals(body(await next), "none");
  assertEquals(log, ["snapshot start", "snapshot end", "console_messages"]);
});

test("an abandoned call that never settles holds the queue for its grace only", async () => {
  const warned: string[] = [];
  const { browser } = fakeBrowser();
  const runner = new ToolRunner(browser, { info: () => {}, warn: (e) => warned.push(e) }, 50, {
    graceMs: 100,
  });
  void runner.call("snapshot", {});
  const started = performance.now();
  const next = await runner.call("console_messages", {})!;
  const ms = performance.now() - started;
  assert(!next.isError);
  assert(ms >= 140 && ms < 1_000, `${ms} ms`);
  assert(warned.includes("browser.abandoned_still_running"));
});

test("Chromium's start is not on the call's clock, and has a bound of its own", async () => {
  // A 150 ms launch under a 50 ms call deadline: the call still runs, and answers.
  const slow = fakeBrowser({
    ensureLaunched: () => new Promise((r) => setTimeout(r, 150)),
    snapshot: () => Promise.resolve(text("snapshot")),
  });
  const ok = await new ToolRunner(slow.browser, diag, 50).call("snapshot", {})!;
  assert(!ok.isError, body(ok));
  assertEquals(body(ok), "snapshot");

  // A launch that never ends is answered at the launch bound, with no recovery attempted.
  const stuck = fakeBrowser({ ensureLaunched: () => new Promise(() => {}) });
  const out = await new ToolRunner(stuck.browser, diag, 5_000, { launchMs: 50 })
    .call("snapshot", {})!;
  assert(out.isError);
  assertStringIncludes(body(out), "The browser did not start within 50 ms");
  assertEquals(stuck.log, []);

  // The tools that only read what was recorded never launch it.
  let launched = false;
  const reader = fakeBrowser({ ensureLaunched: () => (launched = true, Promise.resolve()) });
  await new ToolRunner(reader.browser, diag, 50).call("console_messages", {})!;
  assertEquals(launched, false);
});

test("vision on: every tool is listed, as before", () => {
  const { browser } = fakeBrowser();
  const runner = new ToolRunner(browser, diag, 1_000);
  assertEquals(runner.list, TOOLS);
  assertEquals(toolsFor({ vision: true }), TOOLS);
  const snapshot = runner.list.find((t) => t.name === "snapshot")!;
  assertStringIncludes(snapshot.description, "screenshot");
});

test("vision off: no screenshot listed, and nothing else mentions one", () => {
  const { browser } = fakeBrowser();
  const runner = new ToolRunner(browser, diag, 1_000, { vision: false });
  assertEquals(
    runner.list.map((t) => t.name),
    TOOLS.map((t) => t.name).filter((n) => n !== "screenshot"),
  );
  for (const t of runner.list) {
    const words = JSON.stringify(t).toLowerCase();
    for (const banned of ["screenshot", "picture", "image of"]) {
      assert(!words.includes(banned), `${t.name} mentions ${banned}: ${words}`);
    }
  }
  // The same tools otherwise: only snapshot's description changed.
  for (const t of runner.list) {
    if (t.name !== "snapshot") assertEquals(t, TOOLS.find((u) => u.name === t.name));
  }
});

test("vision off: a call to screenshot is refused without touching the browser", async () => {
  let launched = false;
  const { browser } = fakeBrowser({
    ensureLaunched: () => {
      launched = true;
      return Promise.resolve();
    },
    screenshot: () => {
      throw new Error("must not be called");
    },
  });
  const runner = new ToolRunner(browser, diag, 1_000, { vision: false });
  const out = await runner.call("screenshot", { fullPage: true })!;
  assert(out.isError);
  assertEquals(body(out), NO_VISION_REFUSAL);
  assert(!launched);
  // An unknown name is still unknown (-32601 upstream), not this refusal.
  assertEquals(runner.call("nope", {}), null);
});
