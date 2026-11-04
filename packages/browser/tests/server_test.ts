// The HTTP surface without a browser: health, the one-shot configure, the 503 before it, the
// bearer after it, and MCP over the handler with a stand-in tool set.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { LiveHub } from "../src/core/live.ts";
import { makeHandler } from "../src/http/server.ts";
import type { ToolServer } from "@ryph/shared/mcp";
import type { SidecarConfig } from "../src/core/config.ts";

const token = "s".repeat(64);
const diag = { info: () => {}, warn: () => {} };

function setup() {
  const hub = new LiveHub();
  const started: SidecarConfig[] = [];
  const tools: ToolServer["tools"] = {
    list: () => [{ name: "snapshot", description: "d", inputSchema: { type: "object" } }],
    call: (name) =>
      name === "snapshot" ? Promise.resolve({ content: [{ type: "text", text: "tree" }] }) : null,
  };
  const handler = makeHandler({
    hub,
    diag,
    start: (config) => {
      started.push(config);
      return tools;
    },
  });
  const req = (path: string, init: RequestInit = {}) =>
    handler(new Request(`http://sidecar${path}`, init));
  const configure = (body: unknown) =>
    req("/configure", { method: "POST", body: JSON.stringify(body) });
  const rpc = (body: unknown, auth = token) =>
    req("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { hub, started, req, configure, rpc };
}

test("healthz answers before anything is configured", async () => {
  const { req } = setup();
  const res = await req("/healthz");
  assertEquals([res.status, await res.text()], [200, "ok"]);
});

test("every other route is 503 until configured", async () => {
  const { req } = setup();
  for (const path of ["/mcp", "/live"]) {
    const res = await req(path, { headers: { authorization: `Bearer ${token}` } });
    await res.body?.cancel();
    assertEquals(res.status, 503, path);
  }
});

test("configure is one-shot: the first good body wins, a bad one spends nothing", async () => {
  const { configure, started } = setup();
  const bad = await configure({ token: "short", proxy: null });
  await bad.body?.cancel();
  assertEquals(bad.status, 400);
  assertEquals((await configure({ token, proxy: null })).status, 204);
  const again = await configure({ token: "x".repeat(64), proxy: null });
  await again.body?.cancel();
  assertEquals(again.status, 409);
  assertEquals(started.length, 1);
  assertEquals(started[0].token, token);
});

test("a configure with a wrong vision is 400 and spends nothing; vision reaches start", async () => {
  const { configure, started } = setup();
  const bad = await configure({ token, proxy: null, vision: "no" });
  assertEquals(bad.status, 400);
  assert((await bad.json()).error.startsWith("vision:"));
  assertEquals(started.length, 0);
  assertEquals((await configure({ token, proxy: null, vision: false })).status, 204);
  assertEquals(started[0].vision, false);
});

test("two racing configures: exactly one wins", async () => {
  const { configure, started } = setup();
  const [a, b] = await Promise.all([
    configure({ token, proxy: null }),
    configure({ token: "y".repeat(64), proxy: null }),
  ]);
  await a.body?.cancel();
  await b.body?.cancel();
  assertEquals([a.status, b.status].sort(), [204, 409]);
  assertEquals(started.length, 1);
});

test("after configure, /mcp and /live want the bearer", async () => {
  const { configure, rpc, req } = setup();
  await configure({ token, proxy: null });
  const wrong = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope");
  await wrong.body?.cancel();
  assertEquals(wrong.status, 401);
  const none = await req("/live");
  await none.body?.cancel();
  assertEquals(none.status, 401);
  const ok = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
  assertEquals(await ok.json(), { jsonrpc: "2.0", id: 1, result: {} });
});

test("MCP: initialize, tools/list, tools/call, unknown tool, batch, notification", async () => {
  const { configure, rpc } = setup();
  await configure({ token, proxy: null });
  const init = await (await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  })).json();
  assertEquals(init.result.serverInfo.name, "ryph-browser");
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assertEquals(list.result.tools.map((t: { name: string }) => t.name), ["snapshot"]);
  const call =
    await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "snapshot" } }))
      .json();
  assertEquals(call.result.content[0].text, "tree");
  const unknown =
    await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } }))
      .json();
  assertEquals(unknown.error.code, -32601);
  const batch = await rpc([{ jsonrpc: "2.0", id: 5, method: "ping" }]);
  assertEquals(batch.status, 400);
  await batch.body?.cancel();
  const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assertEquals(note.status, 202);
});

test("/live opens with the snapshot line, as NDJSON", async () => {
  const { configure, req } = setup();
  await configure({ token, proxy: null });
  const res = await req("/live", { headers: { authorization: `Bearer ${token}` } });
  assertEquals(res.headers.get("content-type"), "application/x-ndjson");
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  const line = new TextDecoder().decode(value);
  assert(line.endsWith("\n"));
  const event = JSON.parse(line);
  assertEquals([event.type, event.status, event.tabs, event.frame], ["snapshot", "idle", [], null]);
  await reader.cancel();
});

test("an oversized MCP body is refused before it is parsed", async () => {
  const { configure, req } = setup();
  await configure({ token, proxy: null });
  const res = await req("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "x".repeat(2 * 1024 * 1024),
  });
  await res.body?.cancel();
  assertEquals(res.status, 413);
});
