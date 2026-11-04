import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { MAX_JSON_BODY_BYTES } from "@ryph/shared/http";
import { internalMcpRoutes } from "../src/http/internal.ts";
import { makeServiceGate } from "@ryph/sealed";
import { ADMIN, makeApi } from "./api.ts";
import { router, T0 } from "./fixtures.ts";
import { memoryGatewayStore } from "./memory_store.ts";

function streamed(path: string, text: string, token: string | null = ADMIN) {
  const bytes = new TextEncoder().encode(text);
  const req = new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  });
  assertEquals(req.headers.has("content-length"), false);
  return req;
}

test("MCP management caps create and optional restart bodies after auth, before side effects", async () => {
  const { handler, store, sealed } = makeApi();
  const valid = JSON.stringify({
    name: "Remote",
    slug: "remote",
    url: "https://mcp.example.com",
    auth: "none",
  });
  for (const path of ["/v1/mcp-servers", "/v1/mcp-servers/missing/restart"]) {
    const payload = (path.endsWith("restart") ? "" : valid).padEnd(MAX_JSON_BODY_BYTES + 1);
    assertEquals((await handler(streamed(path, payload, null))).status, 401);
    const res = await handler(streamed(path, payload));
    assertEquals(res.status, 413);
    assertStringIncludes((await res.json()).error, String(MAX_JSON_BODY_BYTES));
    assertEquals(await store.listServers(), []);
    assertEquals(sealed, []);
  }
  assertEquals(
    (await handler(streamed("/v1/mcp-servers", valid.padEnd(MAX_JSON_BODY_BYTES)))).status,
    201,
  );
  // Whitespace at the limit is still an optional empty body, not invalid JSON or overflow.
  assertEquals(
    (await handler(
      streamed("/v1/mcp-servers/missing/restart", " ".repeat(MAX_JSON_BODY_BYTES)),
    )).status,
    404,
  );
  assertEquals((await handler(streamed("/v1/mcp-servers", "{"))).status, 400);
});

test("MCP internal credentials cap precedes issuance and preserves service authentication", async () => {
  let issued = 0;
  const handler = router(internalMcpRoutes({
    store: memoryGatewayStore(),
    issuer: {
      issue: () => {
        issued++;
        throw new Error("issued");
      },
      revokeForRun: () => Promise.resolve(),
    },
    archive: () => Promise.resolve({ kind: "missing" }),
    authenticate: makeServiceGate("service-secret"),
    now: () => new Date(T0),
    diag: { warn() {} },
  }));
  const path = "/internal/v1/runs/r-1/mcp-credentials";
  const valid = JSON.stringify({ servers: [{ serverId: "ms-1", allowedTools: ["list"] }] });
  const oversized = valid.padEnd(MAX_JSON_BODY_BYTES + 1);
  assertEquals((await handler(streamed(path, oversized, null))).status, 401);
  const res = await handler(streamed(path, oversized, "service-secret"));
  assertEquals(res.status, 413);
  assertStringIncludes((await res.json()).error, String(MAX_JSON_BODY_BYTES));
  assertEquals(issued, 0);
  assertEquals(
    (await handler(streamed(path, valid.padEnd(MAX_JSON_BODY_BYTES), "service-secret"))).status,
    503,
  );
  assertEquals(issued, 1);
});
