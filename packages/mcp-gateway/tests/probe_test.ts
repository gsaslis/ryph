// The probe against a scripted upstream: the three-request handshake, pagination, both
// framings, and every verdict.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeProbe, PROBE_RUN_ID } from "../src/http/probe.ts";
import { PLATFORM_RUN_ID_HEADER, platformMemoryRow } from "../src/core/platform.ts";
import { fakeDecrypt, openPolicy, server, T0 } from "./fixtures.ts";

interface RpcBody {
  id?: unknown;
  method?: string;
  params?: { cursor?: string };
}

interface Upstream {
  requests: Array<
    { method: string; headers: Headers; body: RpcBody | null; redirect: Request["redirect"] }
  >;
  fetch: typeof fetch;
}

/** A scripted MCP server: answers by method, in JSON or SSE framing, and hands out a session. */
function scriptedUpstream(opts: {
  sse?: boolean;
  pages?: unknown[][];
  expectAuth?: string | null;
  status?: number;
} = {}): Upstream {
  const requests: Upstream["requests"] = [];
  const pages = opts.pages ?? [[{ name: "list_issues", description: "read" }]];
  const frame = (msg: unknown) =>
    opts.sse
      ? new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, {
        headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
      })
      : Response.json(msg, { headers: { "mcp-session-id": "sess-1" } });
  return {
    requests,
    fetch: (async (input: URL | Request | string, init?: RequestInit) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
      const text = await req.text();
      const body = text === "" ? null : JSON.parse(text) as RpcBody;
      requests.push({ method: req.method, headers: req.headers, body, redirect: req.redirect });
      if (opts.expectAuth !== undefined && req.headers.get("authorization") !== opts.expectAuth) {
        return new Response("unauthorized", { status: 401 });
      }
      if (opts.status !== undefined) return new Response("boom", { status: opts.status });
      if (req.method === "DELETE" || body === null) return new Response(null, { status: 200 });
      if (body.method === "initialize") {
        return frame({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "scripted", version: "9.9" },
          },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        const page = Number(body.params?.cursor ?? "0");
        const tools = pages[page] ?? [];
        const next = page + 1 < pages.length ? String(page + 1) : undefined;
        return frame({ jsonrpc: "2.0", id: body.id, result: { tools, nextCursor: next } });
      }
      return frame({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
    }) as unknown as typeof fetch,
  };
}

const probeWith = (up: Upstream) =>
  makeProbe({ decrypt: fakeDecrypt, upstream: openPolicy, upstreamFetch: up.fetch });

test("a probe initialises, lists every page, and ends the session — with the real credential", async () => {
  const up = scriptedUpstream({
    expectAuth: "Bearer real-linear-token",
    pages: [
      [{ name: "list_issues", description: "read", annotations: { readOnlyHint: true } }],
      [{ name: "create_issue" }, { name: 5 }, "junk"],
    ],
  });
  const result = await probeWith(up)(server());
  assertEquals(result, {
    ok: true,
    protocolVersion: "2025-03-26",
    serverInfo: { name: "scripted", version: "9.9" },
    tools: [
      { name: "list_issues", description: "read", annotations: { readOnlyHint: true } },
      { name: "create_issue", description: null, annotations: null },
    ],
  });
  assertEquals(
    up.requests.map((r) => r.method === "DELETE" ? "DELETE" : r.body?.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/list", "DELETE"],
  );
  // Session and negotiated protocol version ride every request after initialize.
  assertEquals(up.requests[2].headers.get("mcp-session-id"), "sess-1");
  assertEquals(up.requests[2].headers.get("mcp-protocol-version"), "2025-03-26");
  assertEquals(up.requests[4].headers.get("mcp-session-id"), "sess-1");
  assert(up.requests.every((r) => r.headers.get("authorization") === "Bearer real-linear-token"));
});

test("the SSE framing reads the same", async () => {
  const up = scriptedUpstream({ sse: true });
  const result = await probeWith(up)(server());
  assert(result.ok);
  assertEquals(result.tools.map((t) => t.name), ["list_issues"]);
});

test("a public server sends no credential header at all", async () => {
  const up = scriptedUpstream();
  await probeWith(up)(server({ auth: "none", encryptedAuth: null, authLast4: null }));
  assert(up.requests.every((r) => r.headers.get("authorization") === null));
});

test("credential rejected, unreachable, a broken upstream, and a refused URL are distinct verdicts", async () => {
  const rejected = await probeWith(scriptedUpstream({ expectAuth: "Bearer other" }))(server());
  assertEquals(rejected.ok ? "ok" : rejected.reason, "credential_rejected");

  const down = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    upstreamFetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
  })(server());
  assertEquals(down.ok ? "ok" : down.reason, "unreachable");
  assert(!down.ok && down.detail.includes("ECONNREFUSED"));

  const broken = await probeWith(scriptedUpstream({ status: 500 }))(server());
  assertEquals(broken.ok ? "ok" : broken.reason, "protocol");

  const refused = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: { allowInsecure: false, allowPrivate: false, resolve: () => Promise.resolve([]) },
    upstreamFetch: scriptedUpstream().fetch,
  })(server({ url: "https://10.0.0.1/mcp" }));
  assertEquals(refused.ok ? "ok" : refused.reason, "policy");
});

test("a JSON-RPC error from upstream, or no answer to our id, is a protocol verdict", async () => {
  const erroring = scriptedUpstream();
  const fetchErr = ((input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    return req.text().then((t) => {
      const body = JSON.parse(t);
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: 1, message: "no" } });
      }
      return erroring.fetch(
        new Request(req.url, { method: "POST", headers: req.headers, body: t }),
      );
    });
  }) as unknown as typeof fetch;
  const r = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    upstreamFetch: fetchErr,
  })(
    server(),
  );
  assertEquals(r.ok ? "ok" : `${r.reason}:${r.detail}`, "protocol:no");

  const silent = makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    upstreamFetch: (() =>
      Promise.resolve(Response.json({ jsonrpc: "2.0", id: 999 }))) as unknown as typeof fetch,
  });
  const s = await silent(server());
  assertEquals(s.ok ? "ok" : s.reason, "protocol");
});

test("a redirect is a verdict, never followed — and no probe request would follow one", async () => {
  const up = scriptedUpstream();
  assert((await probeWith(up)(server())).ok);
  assertEquals(up.requests.map((r) => r.method), ["POST", "POST", "POST", "DELETE"]);
  assert(up.requests.every((r) => r.redirect === "manual"), "the POSTs and the DELETE alike");

  const dialed: string[] = [];
  const bounced = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    upstreamFetch: ((input: URL | Request | string, init?: RequestInit) => {
      dialed.push(
        (input instanceof Request ? new Request(input, init) : new Request(String(input), init))
          .url,
      );
      return Promise.resolve(
        new Response(null, { status: 307, headers: { location: "https://169.254.169.254/" } }),
      );
    }) as unknown as typeof fetch,
  })(server());
  assertEquals(bounced.ok ? "ok" : bounced.reason, "protocol");
  assert(!bounced.ok && bounced.detail.includes("307"));
  assertEquals(dialed, ["https://mcp.linear.example/mcp"]);
});

test("the body cap counts bytes as they arrive, with or without a length", async () => {
  let pulled = 0;
  const endless = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    maxBodyBytes: 1000,
    upstreamFetch: (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(400));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof fetch,
  })(server());
  assertEquals(endless.ok ? "ok" : endless.detail, "response exceeds the probe's cap");
  assert(pulled < 10, "the rest of a chunked body is never read");

  // 600 characters, 1200 bytes: a cap measured in UTF-16 units would have let this through.
  const wide = await makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    maxBodyBytes: 1000,
    upstreamFetch: (() =>
      Promise.resolve(new Response("é".repeat(600)))) as unknown as typeof fetch,
  })(server());
  assertEquals(wide.ok ? "ok" : wide.detail, "response exceeds the probe's cap");
});

test("a tool list longer than the page cap is a verdict, not a silently partial inventory", async () => {
  const up = scriptedUpstream({ pages: [[{ name: "a" }], [{ name: "b" }], [{ name: "c" }]] });
  const probe = (maxPages: number) =>
    makeProbe({ decrypt: fakeDecrypt, upstream: openPolicy, upstreamFetch: up.fetch, maxPages })(
      server(),
    );
  const capped = await probe(2);
  assertEquals(capped.ok ? "ok" : capped.reason, "protocol");
  assert(!capped.ok && capped.detail.includes("2 pages"));
  const exact = await probe(3);
  assert(exact.ok);
  assertEquals(exact.tools.map((t) => t.name), ["a", "b", "c"]);
});

test("a platform row is probed where a run's calls go, with the gateway's credential and the probe's run id", async () => {
  const up = scriptedUpstream({
    expectAuth: "Bearer memory-service-token",
    pages: [[{ name: "search", description: "read" }, { name: "recall" }]],
  });
  const probe = makeProbe({
    decrypt: fakeDecrypt,
    upstream: openPolicy,
    // Not the process-wide fetch: the platform entry's own, as a single binary dials in-process.
    upstreamFetch: (() =>
      Promise.reject(new Error("the marker URL must never be dialed"))) as unknown as typeof fetch,
    platform: {
      memory: {
        url: "http://memory.internal/v1/memory-mcp",
        token: "memory-service-token",
        fetch: up.fetch,
      },
    },
  });
  const r = await probe(platformMemoryRow(T0));
  assert(r.ok, JSON.stringify(r));
  assertEquals(r.tools.map((t) => t.name), ["search", "recall"]);
  const first = up.requests[0];
  assertEquals(first.headers.get(PLATFORM_RUN_ID_HEADER), PROBE_RUN_ID);
  assertEquals(first.headers.get("authorization"), "Bearer memory-service-token");
});

test("a platform row this deployment did not wire is unreachable, never a policy verdict", async () => {
  const probe = makeProbe({ decrypt: fakeDecrypt, upstream: openPolicy, platform: {} });
  const r = await probe(platformMemoryRow(T0));
  assert(!r.ok);
  assertEquals(r.reason, "unreachable");
  assert(r.detail.includes("not configured"));
});
