// The tool guard image's program (images/tool-guard/main.ts), driven from here because this is
// the package whose contract it implements: the token gate, the route table the gateway writes,
// what is stripped and rewritten on the way through, and — over real loopback sockets — that an
// SSE answer streams through rather than arriving all at once.

import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "@std/assert";
import type { AddressInfo } from "node:net";
import { serve } from "@ryph/service";
import {
  applyCallerTokens,
  type Forward,
  listen,
  makeGuard,
  parseRoutes,
  TOKEN_HEADER,
} from "../../../images/tool-guard/main.ts";
import {
  formatCallerTokens,
  formatGuardRoutes,
  TOOL_GUARD_TOKEN_HEADER,
} from "../src/core/tool_guard.ts";

const TOKEN = "t".repeat(64);
/** Two launch keys, as core/sealing.ts `launchKey` spells them. */
const KA = "a1".repeat(16);
const KB = "b2".repeat(16);
const ROUTES = parseRoutes(
  `${KA}=ryph-tool-${KA}:8000/mcp,${KB}=ryph-tool-${KB}.ryph-tools.svc:9000/`,
);

function recordingForward() {
  const calls: Array<{ target: Parameters<Forward>[0]; headers: Headers; body: string }> = [];
  const forward: Forward = async (target, init) => {
    calls.push({
      target,
      headers: init.headers,
      body: init.body === null ? "" : await new Response(init.body).text(),
    });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "s-1", connection: "close" },
    });
  };
  return { calls, forward };
}

const req = (path: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`http://guard.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
  });

test("the gateway's header name and route format are the guard's", () => {
  assertEquals(TOOL_GUARD_TOKEN_HEADER.toLowerCase(), TOKEN_HEADER);
  const table = formatGuardRoutes([
    { key: KB, address: `ryph-tool-${KB}.ryph-tools.svc:8000`, path: "/mcp" },
    { key: KA, address: `ryph-tool-${KA}:8000`, path: "/api/mcp" },
  ]);
  assertEquals(
    [...parseRoutes(table)],
    [
      [KA, { host: `ryph-tool-${KA}`, port: 8000, path: "/api/mcp" }],
      [KB, { host: `ryph-tool-${KB}.ryph-tools.svc`, port: 8000, path: "/mcp" }],
    ],
  );
  assertEquals(parseRoutes("").size, 0);

  // And the caller tokens, in their own variable, land on the routes they name.
  const withCaller = [
    { key: KA, address: `ryph-tool-${KA}:8000`, path: "/mcp", callerToken: "a".repeat(64) },
    { key: KB, address: `ryph-tool-${KB}:9000`, path: "/mcp" },
  ];
  const routes = parseRoutes(formatGuardRoutes(withCaller));
  applyCallerTokens(routes, formatCallerTokens(withCaller));
  assertEquals(routes.get(KA)?.callerToken, "a".repeat(64));
  assertEquals(routes.get(KB)?.callerToken, undefined);
});

test("malformed or duplicated routes fail the boot", () => {
  const ok = `${KA}=ryph-tool-${KA}:1/mcp`;
  for (
    const raw of [
      KA,
      `${KA}=ryph-tool-${KA}`,
      `${KA.toUpperCase()}=ryph-tool-${KA}:1/mcp`,
      `grafana=ryph-tool-grafana:1/mcp`, // a slug is no key
      `${ok},${ok}`,
      `${KA}=ryph-tool-${KA}:1mcp`,
    ]
  ) {
    assertThrows(() => parseRoutes(raw), Error, undefined, raw);
  }
});

test("a route to any host but its key's own container fails the boot, on both sides", () => {
  for (
    const host of [
      `ryph-tool-${KB}`, // another launch's container
      `ryph-tool-${KA}x`, // a longer name that starts like it
      `ryph-tool-${KA}-old`,
      "10.0.0.4", // an address, not a name
      "ryph-tool-guard",
      `evil.ryph-tool-${KA}`,
    ]
  ) {
    assertThrows(() => parseRoutes(`${KA}=${host}:8000/mcp`), Error, undefined, host);
    assertThrows(
      () => formatGuardRoutes([{ key: KA, address: `${host}:8000`, path: "/mcp" }]),
      Error,
      undefined,
      host,
    );
  }
});

test("no token, or the wrong one, is a 401 and nothing is forwarded", async () => {
  const { calls, forward } = recordingForward();
  const guard = makeGuard({ token: TOKEN, routes: ROUTES, forward });
  const attempts: Array<Record<string, string>> = [
    {},
    { [TOKEN_HEADER]: "nope" },
    { [TOKEN_HEADER]: TOKEN.slice(1) },
  ];
  for (const headers of attempts) {
    const res = await guard(req(`/${KA}/mcp`, headers, "{}"));
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }
  // An unknown route is only distinguishable from a known one WITH the token.
  const unknown = await guard(req("/nope/mcp"));
  assertEquals(unknown.status, 401);
  await unknown.body?.cancel();
  assertEquals(calls.length, 0);
});

test("with the token: routed by key, token stripped, Host rewritten, body intact", async () => {
  const { calls, forward } = recordingForward();
  const guard = makeGuard({ token: TOKEN, routes: ROUTES, forward });
  const res = await guard(req(`/${KA}/mcp?x=1`, {
    [TOKEN_HEADER]: TOKEN,
    "content-type": "application/json",
    "x-grafana-service-account-token": "glsa_real",
    "mcp-session-id": "s-1",
    origin: "https://evil.example",
    connection: "keep-alive",
  }, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("mcp-session-id"), "s-1");
  assertEquals(res.headers.get("connection"), null, "hop-by-hop headers stay on their hop");
  assertEquals(await res.text(), '{"ok":true}');

  const [call] = calls;
  assertEquals(call.target, { host: `ryph-tool-${KA}`, port: 8000, path: "/mcp?x=1" });
  assertEquals(call.headers.get(TOKEN_HEADER), null, "the hosted server never sees the token");
  assertEquals(call.headers.get("host"), "localhost:8000");
  assertEquals(call.headers.get("origin"), null);
  assertEquals(call.headers.get("connection"), null);
  assertEquals(call.headers.get("x-grafana-service-account-token"), "glsa_real");
  assertEquals(call.body, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

  const unknown = await guard(req("/nope/mcp", { [TOKEN_HEADER]: TOKEN }));
  assertEquals(unknown.status, 404);
  await unknown.body?.cancel();
  for (
    const path of [
      `/${KA}`,
      `/${KA}/mcp/extra`,
      `/${KA}/sse`,
      "/grafana/mcp",
      `/${"c".repeat(32)}/mcp`,
    ]
  ) {
    const off = await guard(req(path, { [TOKEN_HEADER]: TOKEN }));
    assertEquals(off.status, 404, path);
    await off.body?.cancel();
  }
});

test("a route with a caller token presents it, replacing any Authorization that came in", async () => {
  const { calls, forward } = recordingForward();
  const routes = parseRoutes(`${KA}=ryph-tool-${KA}:8000/mcp,${KB}=ryph-tool-${KB}:9000/mcp`);
  applyCallerTokens(routes, `${KA}=${"c".repeat(64)}`);
  const guard = makeGuard({ token: TOKEN, routes, forward });
  for (const path of [`/${KA}/mcp`, `/${KB}/mcp`]) {
    const res = await guard(req(path, {
      [TOKEN_HEADER]: TOKEN,
      authorization: "Bearer from-the-sealed-map",
    }, "{}"));
    await res.body?.cancel();
  }
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${"c".repeat(64)}`);
  // A route without one forwards Authorization untouched — a custom server's own bearer credential.
  assertEquals(calls[1].headers.get("authorization"), "Bearer from-the-sealed-map");

  assertThrows(
    () => applyCallerTokens(parseRoutes(""), `${KA}=${"c".repeat(64)}`),
    Error,
    "unknown",
  );
  assertThrows(() => applyCallerTokens(routes, `${KA}=short`), Error, "malformed");
});

test("an upstream that does not answer is a 502, not a hang or a crash", async () => {
  const guard = makeGuard({
    token: TOKEN,
    routes: ROUTES,
    forward: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  const res = await guard(req(`/${KA}/mcp`, { [TOKEN_HEADER]: TOKEN }, "{}"));
  assertEquals(res.status, 502);
  await res.body?.cancel();
});

test("over real sockets: the Host the server wants, and SSE streamed as it is written", async () => {
  // A stand-in MCP server with mcp-grafana's DNS-rebinding rule: anything but a loopback Host is
  // a 403. The guard dials it by address and presents localhost, and each SSE event arrives
  // before the next is written.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const upstream = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (r) => {
    const host = r.headers.get("host") ?? "";
    if (!/^localhost:\d+$/.test(host)) {
      return new Response("forbidden: host not allowed", { status: 403 });
    }
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode("event: message\ndata: first\n\n"));
        await gate;
        c.enqueue(new TextEncoder().encode("event: message\ndata: second\n\n"));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  // Built by hand: a loopback stand-in is no key's container, which `parseRoutes` refuses.
  const routes = new Map([[KA, { host: "127.0.0.1", port: upstream.addr.port, path: "/mcp" }]]);
  const guardServer = await listen(
    { hostname: "127.0.0.1", port: 0 },
    makeGuard({ token: TOKEN, routes }),
  );
  const guardPort = (guardServer.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${guardPort}/${KA}/mcp`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert(first.includes("data: first"), first);
    release();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert(rest.includes("data: second"), rest);
  } finally {
    release();
    guardServer.closeAllConnections();
    await new Promise((r) => guardServer.close(r));
    await upstream.shutdown();
  }
});
