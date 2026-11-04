// The data plane, driven in-process with a fake upstream: authentication, the frozen scope, the
// tool allowlist, the tools/list filter in both framings, header allowlisting both ways,
// credential substitution, every cap, and the audit trail.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { makeGatewayHandler } from "../src/http/proxy.ts";
import { makeMcpCredentialIssuer } from "../src/core/service.ts";
import type { McpServer } from "../src/core/types.ts";
import type { GatewayStore } from "../src/ports/gateway_store.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { fakeDecrypt, openPolicy, server, T0 } from "./fixtures.ts";

const silentDiag = { debug() {}, warn() {} };

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: Request["redirect"];
}

/** A full slice: a real store, a really-minted virtual key, a recording fake upstream. */
async function makeSlice(opts: {
  server?: McpServer;
  allowedTools?: string[] | "*";
  nowMs?: number;
  upstream?: (req: Request) => Response | Promise<Response>;
  limits?: Parameters<typeof makeGatewayHandler>[0]["limits"];
  policy?: typeof openPolicy;
  store?: GatewayStore;
} = {}) {
  const store = opts.store ?? memoryGatewayStore();
  const srv = opts.server ?? server();
  await store.createServer(srv);
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://gw.test",
    ttlMs: 60_000,
  });
  const creds = await issuer.issue({
    runId: "r-1",
    servers: [{ serverId: srv.id, allowedTools: opts.allowedTools ?? "*" }],
  });

  const seen: Seen[] = [];
  const upstream = opts.upstream ?? (() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
  const handler = makeGatewayHandler({
    store,
    decrypt: fakeDecrypt,
    now: () => new Date(opts.nowMs ?? Date.parse(T0)),
    diag: silentDiag,
    upstream: opts.policy ?? openPolicy,
    limits: opts.limits,
    upstreamFetch: (async (input: URL | Request | string, init?: RequestInit) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: await req.text(),
        redirect: req.redirect,
      });
      return await upstream(req);
    }) as unknown as typeof fetch,
  });
  return { handler, store, token: creds.token, url: creds.servers[0].url, seen, issuer };
}

function post(
  url: string,
  token: string | null,
  message: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders,
    },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
}

const CALL = (name: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

test("an allowed call forwards: real credential in, virtual token gone, headers allowlisted", async () => {
  const { handler, token, url, seen } = await makeSlice();
  const res = await handler(post(url, token, CALL("list_issues"), {
    "mcp-session-id": "sess-1",
    "mcp-protocol-version": "2025-06-18",
    cookie: "sneaky=1",
    "x-forwarded-for": "10.0.0.1",
  }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });

  assertEquals(seen.length, 1);
  const up = seen[0];
  assertEquals(up.url, "https://mcp.linear.example/mcp"); // the server's URL, not our path
  assertEquals(up.method, "POST");
  assertEquals(up.headers.get("authorization"), "Bearer real-linear-token");
  assertEquals(up.headers.get("mcp-session-id"), "sess-1");
  assertEquals(up.headers.get("mcp-protocol-version"), "2025-06-18");
  assertEquals(up.headers.get("accept"), "application/json, text/event-stream");
  assertEquals(up.headers.get("cookie"), null);
  assertEquals(up.headers.get("x-forwarded-for"), null);
  assert(!up.body.includes("ryph-mcp-"), "the virtual token never reaches upstream");
  assertEquals(JSON.parse(up.body), CALL("list_issues"));
});

test("a headers-authenticated server gets every header set; a public one gets none", async () => {
  const headered = server({
    auth: "headers",
    encryptedAuth: 'sealed:{"X-Api-Key":"k-1","X-Team":"t-2"}',
  });
  const a = await makeSlice({ server: headered });
  await a.handler(post(a.url, a.token, CALL("x")));
  assertEquals(a.seen[0].headers.get("x-api-key"), "k-1");
  assertEquals(a.seen[0].headers.get("x-team"), "t-2");
  assertEquals(a.seen[0].headers.get("authorization"), null);

  const b = await makeSlice({
    server: server({ auth: "none", encryptedAuth: null, authLast4: null }),
  });
  await b.handler(post(b.url, b.token, CALL("x")));
  assertEquals(b.seen[0].headers.get("authorization"), null);
});

test("no token, an unknown token, an expired token, a revoked run, wrong run, wrong slug: identical 401s", async () => {
  const { handler, token, url, issuer, seen } = await makeSlice();
  const bodies: string[] = [];
  const check = async (req: Request) => {
    const res = await handler(req);
    assertEquals(res.status, 401);
    bodies.push(await res.text());
  };
  await check(post(url, null, CALL("x")));
  await check(post(url, "ryph-mcp-forged", CALL("x")));
  await check(post("http://gw.test/v1/mcp/r-2/linear", token, CALL("x")));
  await check(post("http://gw.test/v1/mcp/r-1/github", token, CALL("x")));

  const late = await makeSlice({ nowMs: Date.parse(T0) + 61_000 });
  await (async () => {
    const res = await late.handler(post(late.url, late.token, CALL("x")));
    assertEquals(res.status, 401);
    bodies.push(await res.text());
  })();

  await issuer.revokeForRun("r-1");
  await check(post(url, token, CALL("x")));

  assertEquals(new Set(bodies).size, 1, "every refusal reads the same");
  assertEquals(seen.length, 0, "upstream never dialed");
});

test("archiving the server cuts off an in-flight run: 403, not 401", async () => {
  const { handler, store, token, url } = await makeSlice();
  await store.saveServer(server({ archivedAt: T0 }));
  const res = await handler(post(url, token, CALL("x")));
  assertEquals(res.status, 403);
  assert((await res.json()).error.includes("archived"));
});

test("a tool outside the allowlist answers -32601 without dialing upstream; '*' allows all", async () => {
  const { handler, store, token, url, seen } = await makeSlice({
    allowedTools: ["list_issues"],
  });
  const denied = await handler(post(url, token, CALL("delete_team", 42)));
  assertEquals(denied.status, 200);
  assertEquals(await denied.json(), {
    jsonrpc: "2.0",
    id: 42,
    error: { code: -32601, message: "Unknown tool: delete_team" },
  });
  assertEquals(seen.length, 0);

  const nameless = await handler(
    post(url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
  );
  assertEquals((await nameless.json()).error.code, -32601);

  assertEquals((await handler(post(url, token, CALL("list_issues")))).status, 200);
  assertEquals(seen.length, 1);

  const { records: usage } = await store.listUsageForRun("r-1");
  assertEquals(usage.map((u) => [u.method, u.tool, u.status]), [
    ["tools/call", "delete_team", "denied"],
    ["tools/call", null, "denied"],
    ["tools/call", "list_issues", "ok"],
  ]);
  assertEquals(usage[0].httpStatus, null);
  assertEquals(usage[2].httpStatus, 200);
  assertEquals(usage[2].serverId, "ms-1");

  const star = await makeSlice({ allowedTools: "*" });
  assertEquals((await star.handler(post(star.url, star.token, CALL("anything")))).status, 200);
});

test("every method outside the client's five is denied without upstream being dialed", async () => {
  const { handler, store, token, url, seen } = await makeSlice({ allowedTools: "*" });
  const denied = [
    "resources/list",
    "resources/read",
    "prompts/get",
    "completion/complete",
    "logging/setLevel",
    "vendor/exfiltrate",
  ];
  for (const [i, method] of denied.entries()) {
    const res = await handler(post(url, token, { jsonrpc: "2.0", id: i, method, params: {} }));
    assertEquals(res.status, 200, method);
    assertEquals(await res.json(), {
      jsonrpc: "2.0",
      id: i,
      error: { code: -32601, message: `Method not found: ${method}` },
    }, method);
  }
  assertEquals(seen.length, 0, "the real credential never left the process");
  const usage = (await store.listUsageForRun("r-1")).records;
  assertEquals(
    usage.map((u) => [u.method, u.tool, u.status]),
    denied.map((m) => [m, null, "denied"]),
  );

  // The five a client actually needs still go through, and so does a response with no method.
  for (
    const message of [
      { jsonrpc: "2.0", id: 9, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 9, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x", arguments: {} } },
      { jsonrpc: "2.0", id: 9, result: {} },
    ]
  ) {
    const res = await handler(post(url, token, message));
    assertEquals(res.status, 200, JSON.stringify(message));
    await res.body?.cancel();
  }
  assertEquals(seen.length, 5);
});

test("a batch, a non-object, garbage, and an oversized body die at the door", async () => {
  const { handler, token, url, seen } = await makeSlice({ limits: { requestBodyBytes: 200 } });
  const batch = await handler(post(url, token, [CALL("a"), CALL("b")]));
  assertEquals(batch.status, 400);
  assert((await batch.json()).error.message.includes("batch"));
  assertEquals((await handler(post(url, token, "42"))).status, 400);
  assertEquals((await handler(post(url, token, "{nope"))).status, 400);
  const big = await handler(post(url, token, { id: 1, method: "ping", pad: "x".repeat(300) }));
  assertEquals(big.status, 413);
  assertEquals(seen.length, 0);
});

test("a message another parser could read differently is refused before upstream", async () => {
  const { handler, store, token, url, seen } = await makeSlice({
    allowedTools: ["search_dashboards"],
  });
  for (
    const body of [
      // Go's encoding/json would run resources/read; here it once passed as a client response.
      '{"jsonrpc":"2.0","id":1,"Method":"resources/read","params":{"uri":"x"}}',
      // The allowlist saw search_dashboards; a case-insensitive, last-wins upstream ran the other.
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_dashboards","Name":"update_dashboard","arguments":{}}}',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_dashboards","name":"update_dashboard"}}',
      '{"jsonrpc":"2.0","id":1,"method":"ping","method":"resources/read"}',
      '{"jsonrpc":"2.0","method":"notifications/initialized","METHOD":"prompts/get"}',
      '{"jsonrpc":"2.0","id":1,"method":null,"params":{}}',
      '{"jsonrpc":"2.0","id":1}',
    ]
  ) {
    const res = await handler(post(url, token, body));
    assertEquals(res.status, 400, body);
    const answer = await res.json();
    assertEquals(answer.jsonrpc, "2.0", body);
    assertEquals(answer.id, null, body);
    assertEquals(answer.error.code, -32600, body);
  }
  const bad = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: Uint8Array.from([
        ...new TextEncoder().encode('{"jsonrpc":"2.0","id":"'),
        0xff,
        0x22,
        0x7d,
      ]),
    }),
  );
  assertEquals(bad.status, 400);
  assertEquals((await bad.json()).error.code, -32700);
  assertEquals(seen.length, 0, "nothing ambiguous reached upstream");
  assertEquals((await store.listUsageForRun("r-1")).records, []);
});

test("upstream gets the judged message re-serialised, never the client's bytes", async () => {
  const { handler, token, url, seen } = await makeSlice({ allowedTools: ["get_issue"] });
  const body = '{ "jsonrpc":"2.0", "id":3, "method":"tools/call", "params":{"n\\u0061me":' +
    '"get_issue", "arguments":{"Name":"data, not a key the gateway reads","id":12345678901234567890}}}';
  const res = await handler(post(url, token, body));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(
    seen[0].body,
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_issue",' +
      '"arguments":{"Name":"data, not a key the gateway reads","id":12345678901234567890}}}',
  );
});

const LIST = (id = 2) => ({
  jsonrpc: "2.0",
  id,
  result: {
    tools: [
      { name: "list_issues", description: "read" },
      { name: "delete_team", description: "ouch" },
    ],
  },
});

test("tools/list is filtered in the JSON framing", async () => {
  const { handler, token, url } = await makeSlice({
    allowedTools: ["list_issues"],
    upstream: () => Response.json(LIST()),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.tools.map((t: { name: string }) => t.name), ["list_issues"]);
});

test("tools/list is filtered in the SSE framing, and the framing survives", async () => {
  const sse = `event: message\ndata: ${JSON.stringify(LIST())}\n\n`;
  const { handler, token, url } = await makeSlice({
    allowedTools: ["list_issues"],
    upstream: () =>
      new Response(sse, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": "s-9" },
      }),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("mcp-session-id"), "s-9");
  const text = await res.text();
  assert(text.startsWith("event: message\ndata: "));
  assert(!text.includes("delete_team"));
  assert(text.includes("list_issues"));
});

test("the tools/list filter fails closed whatever the content-type says, or does not say", async () => {
  const sse = `event: message\ndata: ${JSON.stringify(LIST())}\n\n`;
  // A conforming server may shout the media type, mislabel it, or send no label at all — and an
  // SSE body used to fall down the JSON path, fail to parse, and be returned raw and unfiltered.
  const labels: Array<Record<string, string>> = [
    { "content-type": "Text/Event-Stream" },
    { "content-type": "application/octet-stream" },
    {},
  ];
  for (const headers of labels) {
    const { handler, token, url } = await makeSlice({
      allowedTools: ["list_issues"],
      upstream: () => new Response(sse, { headers }),
    });
    const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const label = JSON.stringify(headers);
    assertEquals(res.status, 200, label);
    const text = await res.text();
    assert(!text.includes("delete_team"), `${label}: the denied tool leaked`);
    assert(text.includes("list_issues"), label);
  }

  // A body in neither framing cannot be filtered, so it is refused, not relayed.
  const opaque = await makeSlice({
    allowedTools: ["list_issues"],
    upstream: () =>
      new Response("<html>delete_team lives here</html>", {
        headers: { "content-type": "text/html" },
      }),
  });
  const res = await opaque.handler(
    post(opaque.url, opaque.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }),
  );
  assertEquals(res.status, 502);
  assert(!(await res.text()).includes("delete_team"));
});

test("an oversized tools/list answers 502 rather than leaking through unfiltered", async () => {
  const { handler, token, url } = await makeSlice({
    allowedTools: ["a"],
    limits: { toolsListBytes: 100 },
    upstream: () =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: Array.from({ length: 50 }, (_, i) => ({ name: `tool_${i}` })) },
      }),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assertEquals(res.status, 502);
  await res.body?.cancel();
});

test("everything else streams through, with response headers allowlisted", async () => {
  const { handler, token, url } = await makeSlice({
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
            controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
            controller.close();
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "mcp-session-id": "s-1",
            "set-cookie": "upstream=secret",
            server: "nginx",
            "www-authenticate": "Bearer realm=x",
          },
        },
      ),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 1, method: "initialize" }));
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("mcp-session-id"), "s-1");
  assertEquals(res.headers.get("set-cookie"), null);
  assertEquals(res.headers.get("server"), null);
  assertEquals(res.headers.get("www-authenticate"), null);
  assertEquals(await res.text(), "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n");
});

test("a filtered tools/list carries no event id, and a GET may not resume with one", async () => {
  const sse = `event: message\nid: e1\ndata: ${JSON.stringify(LIST())}\n\n`;
  const { handler, token, url, seen } = await makeSlice({
    allowedTools: ["list_issues"],
    upstream: () =>
      new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const listed = await handler(
    post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
      "last-event-id": "e0",
    }),
  );
  const text = await listed.text();
  assert(!text.includes("id: e1"), "upstream's resumption id must not reach the client");
  assert(!text.includes("delete_team"));
  assertEquals(seen[0].headers.get("last-event-id"), "e0", "a POST may still resume");

  // The GET stream is never filtered — it answers no request — so it may not resume either.
  await handler(
    new Request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "last-event-id": "e1" },
    }),
  );
  assertEquals(seen[1].method, "GET");
  assertEquals(seen[1].headers.get("last-event-id"), null);
});

test("the GET stream and DELETE pass through with the session id", async () => {
  const { handler, token, url, seen } = await makeSlice({
    upstream: (req) =>
      req.method === "GET"
        ? new Response("event: message\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
        : new Response(null, { status: 200 }),
  });
  const headers = { authorization: `Bearer ${token}`, "mcp-session-id": "s-1" };
  const stream = await handler(new Request(url, { method: "GET", headers }));
  assertEquals(stream.status, 200);
  assertEquals(await stream.text(), "event: message\ndata: {}\n\n");
  assertEquals(seen[0].method, "GET");
  assertEquals(seen[0].headers.get("mcp-session-id"), "s-1");

  const bye = await handler(new Request(url, { method: "DELETE", headers }));
  assertEquals(bye.status, 200);
  assertEquals(seen[1].method, "DELETE");

  assertEquals((await handler(new Request(url, { method: "PUT", headers }))).status, 405);
  assertEquals(
    (await handler(new Request("http://gw.test/v1/other", { headers }))).status,
    404,
  );
  // A malformed percent-escape is a path we do not know, not a 500 with a stack trace in the log.
  for (const path of ["/v1/mcp/%ZZ/linear", "/v1/mcp/r-1/%E0%A4%A"]) {
    const res = await handler(new Request(`http://gw.test${path}`, { headers }));
    assertEquals(res.status, 404, path);
    await res.body?.cancel();
  }
});

test("upstream refusing OUR credential becomes a JSON-RPC error and a 'rejected' row", async () => {
  const { handler, store, token, url } = await makeSlice({
    upstream: () => new Response("nope", { status: 401, headers: { "www-authenticate": "x" } }),
  });
  const res = await handler(post(url, token, CALL("list_issues", 5)));
  assertEquals(res.status, 200); // never a raw 401: the client would go looking for OAuth
  assertEquals(await res.json(), {
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32000, message: "the upstream rejected the gateway's credential" },
  });
  assertEquals(res.headers.get("www-authenticate"), null);
  const [row] = (await store.listUsageForRun("r-1")).records;
  assertEquals([row.status, row.httpStatus], ["rejected", 401]);

  // A notification (no id) has nothing to answer on; the transport status says it.
  const notif = await handler(
    post(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assertEquals(notif.status, 502);
  await notif.body?.cancel();
});

test("an unreachable upstream answers 502 and an 'error' row, never a hang or a throw", async () => {
  const { handler, store, token, url } = await makeSlice({
    upstream: () => {
      throw new Error("connection refused");
    },
  });
  const res = await handler(post(url, token, CALL("list_issues")));
  assertEquals(res.status, 502);
  await res.body?.cancel();
  const [row] = (await store.listUsageForRun("r-1")).records;
  assertEquals([row.status, row.httpStatus], ["error", null]);
});

test("an upstream that is slow to answer headers is cut off at the timeout", async () => {
  const { handler, token, url } = await makeSlice({
    limits: { upstreamHeadersTimeoutMs: 20 },
    upstream: (req) =>
      new Promise((resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(req.signal.reason));
        setTimeout(() => resolve(Response.json({})), 1_000);
      }),
  });
  const res = await handler(post(url, token, CALL("x")));
  assertEquals(res.status, 502);
  await res.body?.cancel();
});

test("a response past the cap is cut while streaming", async () => {
  const { handler, token, url } = await makeSlice({
    limits: { responseBytes: 100 },
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < 10; i++) {
              controller.enqueue(new Uint8Array(50)); // 500 bytes in all
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const res = await handler(post(url, token, CALL("x")));
  assertEquals(res.status, 200); // headers were already fine; the body is what gets cut
  await assertRejects(() => res.text(), Error, "cap");
});

test("concurrent POSTs per run are capped; the slot frees when the response is drained", async () => {
  let releaseUpstream = () => {};
  const held = new Promise<void>((r) => releaseUpstream = r);
  const { handler, token, url } = await makeSlice({
    limits: { perRunInFlight: 1 },
    upstream: async () => {
      await held;
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
  });
  const first = handler(post(url, token, CALL("a")));
  await new Promise((r) => setTimeout(r, 5)); // let the first take its slot
  const second = await handler(post(url, token, CALL("b")));
  assertEquals(second.status, 429);
  await second.body?.cancel();

  releaseUpstream();
  const done = await first;
  assertEquals(done.status, 200);
  await done.text(); // drain: the slot is released here
  const third = await handler(post(url, token, CALL("c")));
  assertEquals(third.status, 200);
  await third.body?.cancel();
});

test("the run's request budget counts denied calls too, and 429s past it", async () => {
  const { handler, token, url, seen } = await makeSlice({
    allowedTools: ["list_issues"],
    limits: { perRunRequests: 3 },
  });
  // The cheapest path of all — a loop of calls to a tool that does not exist — is metered like
  // any other: it costs a usage row and a connection, so it costs budget.
  for (let i = 0; i < 3; i++) {
    const res = await handler(post(url, token, CALL("nope", i)));
    assertEquals(res.status, 200, `call ${i}`);
    assertEquals((await res.json()).error.code, -32601);
  }
  assertEquals(seen.length, 0, "not one of them was forwarded");

  const spent = await handler(post(url, token, CALL("list_issues")));
  assertEquals(spent.status, 429);
  assert((await spent.json()).error.includes("budget"));
  assertEquals(seen.length, 0, "and the one past the budget is not forwarded either");

  // A different run has its own budget.
  const other = await makeSlice({ limits: { perRunRequests: 3 } });
  assertEquals((await other.handler(post(other.url, other.token, CALL("x")))).status, 200);
});

test("concurrent GET streams per run are capped; a closed stream frees its slot", async () => {
  const open: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const { handler, token, url } = await makeSlice({
    limits: { perRunGetStreams: 1 },
    upstream: (req) =>
      req.method === "GET"
        ? new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              open.push(controller);
              controller.enqueue(new TextEncoder().encode(": open\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
        : Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
  });
  const get = () =>
    handler(new Request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } }));

  const first = await get();
  assertEquals(first.status, 200);
  const reader = first.body!.getReader();
  await reader.read(); // the stream is live, and holding the run's one slot

  const second = await get();
  assertEquals(second.status, 429);
  assert((await second.json()).error.includes("streams"));

  await reader.cancel(); // the client hangs up: the slot comes back
  const third = await get();
  assertEquals(third.status, 200);
  await third.body?.cancel();
  for (const controller of open) {
    try {
      controller.close();
    } catch {
      // already closed by the cancel above
    }
  }
});

test("a tools/list body that never ends is cut at its own deadline", async () => {
  const { handler, token, url } = await makeSlice({
    limits: { toolsListReadMs: 20 },
    upstream: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
          },
          // and never another chunk, and never a close
          pull() {},
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assertEquals(res.status, 502);
  assert((await res.json()).error.includes("too long"));
});

test("an upstream the policy refuses is never dialed: 502 and an 'error' row", async () => {
  const { handler, store, token, url, seen } = await makeSlice({
    server: server({ url: "https://10.0.0.7/mcp" }),
    policy: { allowInsecure: false, allowPrivate: false, resolve: () => Promise.resolve([]) },
  });
  const res = await handler(post(url, token, CALL("x")));
  assertEquals(res.status, 502);
  assert((await res.json()).error.includes("policy"));
  assertEquals(seen.length, 0);
  assertEquals((await store.listUsageForRun("r-1")).records[0].status, "error");
});

test("every forwarded request lands one usage row with method and duration", async () => {
  let t = Date.parse(T0);
  const store = memoryGatewayStore();
  const { handler, token, url } = await makeSlice({
    store,
    upstream: () => {
      t += 250;
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
  });
  // A fresh handler over the same store, with a clock we advance inside the upstream call.
  const timed = makeGatewayHandler({
    store,
    decrypt: fakeDecrypt,
    now: () => new Date(t),
    diag: silentDiag,
    upstream: openPolicy,
    upstreamFetch: (() => {
      t += 250;
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    }) as unknown as typeof fetch,
  });
  void handler;
  await timed(post(url, token, { jsonrpc: "2.0", id: 1, method: "initialize" }));
  await timed(post(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }));
  const { records: usage } = await store.listUsageForRun("r-1");
  assertEquals(usage.map((u) => u.method), ["initialize", "notifications/initialized"]);
  assertEquals(usage[0].durationMs, 250);
  assertEquals(usage[0].tool, null);
});

test("a redirect from upstream is never followed: 502 and an 'error' row", async () => {
  const { handler, store, token, url, seen } = await makeSlice({
    upstream: () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      }),
  });
  const res = await handler(post(url, token, CALL("x")));
  assertEquals(res.status, 502);
  assertEquals(res.headers.get("location"), null);
  await res.body?.cancel();
  assertEquals(seen.map((s) => s.redirect), ["manual"], "fetch is told not to follow");
  const [row] = (await store.listUsageForRun("r-1")).records;
  assertEquals([row.status, row.httpStatus], ["error", 307]);
});

test("an upstream body that fails mid-stream still frees the run's slot", async () => {
  const { handler, token, url } = await makeSlice({
    limits: { perRunInFlight: 1 },
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"jsonrpc":'));
          },
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  for (let i = 0; i < 3; i++) {
    const res = await handler(post(url, token, CALL("x")));
    assertEquals(res.status, 200, `call ${i} must not find the slot still held`);
    await assertRejects(() => res.text(), Error, "reset");
  }
});

test("tools/list over SSE is filtered however the event is framed", async () => {
  const json = JSON.stringify(LIST());
  const comma = json.indexOf(",");
  // CRLF line endings, and the document split over two data lines a client joins back up.
  const sse = `event: message\r\ndata: ${json.slice(0, comma + 1)}\r\ndata: ${
    json.slice(comma + 1)
  }\r\n\r\n`;
  const { handler, token, url } = await makeSlice({
    allowedTools: ["list_issues"],
    upstream: () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  });
  const res = await handler(post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const text = await res.text();
  assert(!text.includes("delete_team"));
  assert(text.includes("list_issues"));
});
