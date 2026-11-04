// The sidecar end to end against a REAL Chromium: the HTTP surface on a socket, the real MCP SDK
// client on /mcp, a local page server standing in for the agent's dev server, and the /live
// stream read alongside. Skipped — cleanly, with one line saying why — on a machine without
// Playwright's headless shell (`bun run install-shell` installs it).

import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serve } from "@ryph/service";
import { createSidecar } from "../src/sidecar.ts";
import type { LiveEvent } from "../src/core/live.ts";
import { type CallResult, executable, haveChromium, refOf, textOf } from "./_harness.ts";

const PAGE = `<!doctype html>
<html><head><title>Greeter</title></head><body>
<h1 id="out">Hello</h1>
<label>Name <input id="name"></label>
<select id="pick" aria-label="Colour"><option value="r">Red</option><option value="g">Green</option></select>
<button id="greet" onclick="greet()">Greet</button>
<button onclick="alert('boo')">Alert</button>
<button onmouseover="document.getElementById('out').textContent='hovered'">Hover me</button>
<a href="/second" target="_blank">Second in a new tab</a>
<a href="/second">Second</a>
<p id="later"></p>
<script>
  function greet() {
    const name = document.getElementById('name').value;
    console.log('greeting ' + name);
    fetch('/api/greet?name=' + encodeURIComponent(name)).then(r => r.json()).then(j => {
      document.getElementById('out').textContent = j.message;
    });
  }
  console.error('boot error from the page');
  setTimeout(() => { document.getElementById('later').textContent = 'arrived late'; }, 400);
  window.__seeded = window.__seed ?? null;
</script>
</body></html>`;

async function pageServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/greet") {
      return Response.json({ message: `Hi, ${url.searchParams.get("name")}!` });
    }
    if (url.pathname === "/second") {
      return new Response("<title>Second</title><h2>Second page</h2>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.pathname === "/missing.js") return new Response("nope", { status: 404 });
    return new Response(PAGE, { headers: { "content-type": "text/html" } });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

test.skipIf(!haveChromium)(
  "the sidecar drives a real Chromium through MCP and streams it on /live",
  async () => {
    const warnings: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const sidecar = createSidecar({
      diag: { info: () => {}, warn: (event, fields) => warnings.push({ event, fields }) },
      ...(executable ? { executablePath: executable } : {}),
    });
    const server = await serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      sidecar.handler,
    );
    const base = `http://127.0.0.1:${server.addr.port}`;
    const site = await pageServer();
    const token = "t".repeat(64);
    const lines: LiveEvent[] = [];
    let client: Client | null = null;
    try {
      // Before /configure: 503 for everything but the health check.
      assertEquals(await fetch(`${base}/healthz`).then(async (r) => [r.status, await r.text()]), [
        200,
        "ok",
      ]);
      const early = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
      await early.body?.cancel();
      assertEquals(early.status, 503);

      const configured = await fetch(`${base}/configure`, {
        method: "POST",
        body: JSON.stringify({ token, proxy: null }),
      });
      assertEquals(configured.status, 204);
      const again = await fetch(`${base}/configure`, {
        method: "POST",
        body: JSON.stringify({ token: "x".repeat(64), proxy: null }),
      });
      await again.body?.cancel();
      assertEquals(again.status, 409);
      const anon = await fetch(`${base}/live`);
      await anon.body?.cancel();
      assertEquals(anon.status, 401);

      // The live stream, read in the background for the whole test.
      const live = await fetch(`${base}/live`, { headers: { authorization: `Bearer ${token}` } });
      assertEquals(live.status, 200);
      const reading = (async () => {
        const reader = live.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            lines.push(JSON.parse(buf.slice(0, nl)));
            buf = buf.slice(nl + 1);
          }
        }
      })();

      client = new Client({ name: "test", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        await client!.callTool({ name, arguments: args }) as CallResult;

      const listed = await client.listTools() as { tools: Array<{ name: string }> };
      assertEquals(listed.tools.length, 19);

      // navigate: the report carries URL, title, the boot console error, and a snapshot.
      const launchStart = performance.now();
      const nav = textOf(await call("navigate", { url: site.url.replace("http://", "") }));
      console.log(
        `first navigate (launch included): ${Math.round(performance.now() - launchStart)} ms`,
      );
      assertStringIncludes(nav, "Untrusted page content follows");
      assertStringIncludes(nav, "Title: Greeter");
      assertStringIncludes(nav, "boot error from the page");
      assertMatch(nav, /button "Greet" \[ref=e\d+\]/);

      // type + click: the click's fetch lands before the report is written.
      const typed = textOf(
        await call("type", {
          ref: refOf(nav, /textbox "Name"/),
          element: "the name field",
          text: "Ada",
        }),
      );
      assertStringIncludes(typed, "Typed into “the name field”");
      const clicked = textOf(
        await call("click", { ref: refOf(typed, /button "Greet"/), element: "Greet" }),
      );
      assertStringIncludes(clicked, "Hi, Ada!");

      // A ref that does not exist is a refusal the model can act on.
      const gone = await call("click", { ref: "e999", element: "nothing" });
      assert(gone.isError);
      assertStringIncludes(textOf(gone), "Take a snapshot");

      // A dialog is dismissed and reported.
      const alerted = textOf(
        await call("click", { ref: refOf(clicked, /button "Alert"/), element: "Alert" }),
      );
      assertStringIncludes(alerted, "alert (dismissed): boo");

      const hovered = textOf(
        await call("hover", { ref: refOf(alerted, /button "Hover me"/), element: "Hover me" }),
      );
      assertStringIncludes(hovered, "hovered");
      const selected = textOf(
        await call("select_option", {
          ref: refOf(hovered, /combobox "Colour"/),
          element: "Colour",
          values: ["Green"],
        }),
      );
      assertStringIncludes(selected, "Selected “Green”");

      // evaluate: a value, a DOM node described, an awaited promise, and a loop that is stopped.
      assertStringIncludes(
        textOf(await call("evaluate", { function: "() => document.title" })),
        '"Greeter"',
      );
      const node = textOf(
        await call("evaluate", {
          function: "(el) => el",
          ref: refOf(selected, /button "Greet"/),
        }),
      );
      assertStringIncludes(node, '<button#greet> \\"Greet\\"');
      assertStringIncludes(
        textOf(
          await call("evaluate", {
            function:
              "async () => { await new Promise(r => setTimeout(r, 50)); return { n: 1n, u: undefined } }",
          }),
        ),
        '"n": "1n"',
      );
      const loopStart = performance.now();
      const looped = await call("evaluate", {
        function: "() => { while (true) {} }",
        timeoutMs: 1000,
      });
      const loopMs = Math.round(performance.now() - loopStart);
      console.log(`while(true) evaluate stopped after ${loopMs} ms`);
      assert(looped.isError);
      assertStringIncludes(textOf(looped), "stopped after 1000 ms");
      assert(loopMs < 5_000);
      // …and the page answers again afterwards.
      assertStringIncludes(textOf(await call("evaluate", { function: "() => 1 + 1" })), "2");
      const big = textOf(await call("evaluate", { function: "() => 'x'.repeat(100000)" }));
      assertStringIncludes(big, "The result was cut at 20 KB");
      const threw = await call("evaluate", { function: "() => { throw new Error('kaboom') }" });
      assert(threw.isError);
      assertStringIncludes(textOf(threw), "kaboom");

      // screenshot: MCP image content.
      const shot = await call("screenshot", {});
      const image = shot.content.find((c) => c.type === "image");
      assert(image?.data && image.data.length > 1000);
      assertEquals(image.mimeType, "image/png");

      // add_init_script: applies from the next load on.
      const added = textOf(await call("add_init_script", { script: "window.__seed = 'seeded';" }));
      assertStringIncludes(added, "1 init script held");
      await call("reload");
      assertStringIncludes(
        textOf(await call("evaluate", { function: "() => window.__seeded" })),
        '"seeded"',
      );

      // wait_for text that arrives late.
      assertStringIncludes(
        textOf(await call("wait_for", { text: "arrived late" })),
        "arrived late",
      );

      // console and network, since the last call.
      const consoleList = textOf(await call("console_messages", {}));
      assertStringIncludes(consoleList, "greeting Ada");
      assertStringIncludes(textOf(await call("console_messages", {})), "No console messages");
      await call("navigate", { url: site.url });
      const net = textOf(await call("network_requests", {}));
      assertMatch(net, /GET http:\/\/127\.0\.0\.1:\d+\/ → 200 \(document/);

      // tabs: a link with target=_blank adds a tab without switching.
      const nav2 = textOf(await call("snapshot"));
      const popped = textOf(
        await call("click", {
          ref: refOf(nav2, /link "Second in a new tab"/),
          element: "new tab link",
        }),
      );
      assertStringIncludes(popped, "Tabs:");
      assertStringIncludes(
        textOf(await call("tabs", { action: "select", index: 1 })),
        "Second page",
      );
      assertStringIncludes(textOf(await call("tabs", { action: "close" })), "Title: Greeter");
      assertStringIncludes(textOf(await call("tabs", { action: "list" })), "1 tab:");

      // press_key, scroll, resize, back.
      await call("press_key", { key: "Tab" });
      await call("scroll", { deltaY: 200 });
      await call("resize", { width: 800, height: 600 });
      const second = textOf(await call("snapshot"));
      await call("click", { ref: refOf(second, /link "Second" \[/), element: "Second" });
      assertStringIncludes(textOf(await call("back")), "Title: Greeter");

      // Bad arguments are refusals, not crashes.
      const bad = await call("navigate", { url: "file:///etc/passwd" });
      assert(bad.isError);
      assertStringIncludes(textOf(bad), "only http(s)");

      // Let the throttle's trailing frame land, then end the stream and look at what came.
      await new Promise((r) => setTimeout(r, 300));
      await client.close();
      client = null;
      await sidecar.close();
      await reading.catch(() => {});

      assertEquals(lines[0].type, "snapshot");
      assertEquals((lines[0] as { status: string }).status, "idle");
      const types = new Set(lines.map((l) => l.type));
      for (const t of ["frame", "tabs", "console", "network", "action", "status"]) {
        assert(types.has(t as LiveEvent["type"]), `no ${t} line on /live (got ${[...types]})`);
      }
      const frames = lines.filter((l) => l.type === "frame") as Array<
        Extract<LiveEvent, { type: "frame" }>
      >;
      const f = frames.at(-1)!.frame;
      assertEquals(f.mime, "image/jpeg");
      assert(f.width > 0 && f.height > 0);
      assertEquals(f.viewport, { width: 800, height: 600 });
      const actions = lines.filter((l) => l.type === "action") as Array<
        Extract<LiveEvent, { type: "action" }>
      >;
      const click = actions.find((a) => a.tool === "click");
      assert(click?.target && click.target.width > 0, "a click action carries its target");
      // At most ~10 fps: no two forwarded frames closer than the throttle's window, give or take
      // the timer's own jitter.
      for (let i = 1; i < frames.length; i++) {
        assert(
          frames[i].at - frames[i - 1].at >= 90,
          `frames ${frames[i - 1].at} and ${frames[i].at} too close`,
        );
      }
      const statuses = lines.filter((l) => l.type === "status").map((l) =>
        (l as { status: string }).status
      );
      assertEquals(statuses, ["launching", "active", "closed"]);
      console.log(
        `live: ${lines.length} lines, ${frames.length} frames; sandbox warnings: ${warnings.length}`,
      );
    } finally {
      await client?.close().catch(() => {});
      await sidecar.close().catch(() => {});
      await server.shutdown();
      await site.close();
    }
  },
);
