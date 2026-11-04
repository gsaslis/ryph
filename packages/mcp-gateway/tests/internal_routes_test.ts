// The internal surface: the four questions a remote control plane asks, the service gate on
// every one of them, and the definitive-vs-retryable split that decides whether a run boot-fails
// now or keeps retrying.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { internalMcpRoutes } from "../src/http/internal.ts";
import { archiveMcpServer, PLATFORM_MANAGED } from "../src/http/routes.ts";
import { unavailableHosting } from "../src/core/hosting.ts";
import { ensurePlatformMemoryServer } from "../src/core/platform.ts";
import { makeServiceGate } from "@ryph/sealed";
import { makeMcpCredentialIssuer } from "../src/core/service.ts";
import type { GatewayStore } from "../src/ports/gateway_store.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { sha256Hex } from "@ryph/sealed";
import { call, router, server, T0 } from "./fixtures.ts";

const TOKEN = "service-secret";
const NOW = new Date(T0);

function makeApi(opts: { store?: GatewayStore; gatewayUrl?: string | null } = {}) {
  const store = opts.store ?? memoryGatewayStore();
  const gatewayUrl = opts.gatewayUrl === undefined ? "http://gw.internal:7430" : opts.gatewayUrl;
  const warnings: string[] = [];
  const routes = internalMcpRoutes({
    store,
    issuer: gatewayUrl === null
      ? null
      : makeMcpCredentialIssuer({ store, now: () => NOW, gatewayUrl, ttlMs: 60_000 }),
    archive: archiveMcpServer({ store, hosting: unavailableHosting("none"), now: () => NOW }),
    authenticate: makeServiceGate(TOKEN),
    now: () => NOW,
    diag: { warn: (event) => warnings.push(event) },
  });
  return { handler: router(routes), store, warnings };
}

const SCOPE = { servers: [{ serverId: "ms-1", allowedTools: ["list_issues"] }] };

test("every internal route refuses without the service token", async () => {
  const { handler } = makeApi();
  for (
    const [method, path] of [
      ["GET", "/internal/v1/mcp-servers/ms-1"],
      ["POST", "/internal/v1/mcp-servers/ms-1/archive"],
      ["POST", "/internal/v1/runs/run-1/mcp-credentials"],
      ["DELETE", "/internal/v1/runs/run-1/mcp-credentials"],
    ] as const
  ) {
    for (const token of [null, "wrong-secret"]) {
      const res = await call(handler, method, path, undefined, token);
      assertEquals(res.status, 401, `${method} ${path} with ${token}`);
      await res.body?.cancel();
    }
  }
});

test("the server lookup answers metadata only, and 404s an unknown id", async () => {
  const { handler, store } = makeApi();
  await store.createServer(server());
  const found = await call(handler, "GET", "/internal/v1/mcp-servers/ms-1", undefined, TOKEN);
  assertEquals(found.status, 200);
  // Exactly what a tool-policy check reads. No URL, no last4, and above all no sealed
  // credential: the control plane cannot open one and must never receive one.
  assertEquals(await found.json(), {
    id: "ms-1",
    slug: "linear",
    name: "Linear",
    archivedAt: null,
  });
  const missing = await call(handler, "GET", "/internal/v1/mcp-servers/ms-nope", undefined, TOKEN);
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

test("issue mints the run's token and returns the container's server list", async () => {
  const { handler, store } = makeApi();
  await store.createServer(server());
  const res = await call(handler, "POST", "/internal/v1/runs/run-1/mcp-credentials", SCOPE, TOKEN);
  assertEquals(res.status, 200);
  const creds = await res.json() as { token: string; servers: unknown[] };
  assert(creds.token.startsWith("ryph-mcp-"));
  assertEquals(creds.servers, [
    { slug: "linear", name: "Linear", url: "http://gw.internal:7430/v1/mcp/run-1/linear" },
  ]);
  const stored = await store.getVirtualKeyByTokenHash(await sha256Hex(creds.token));
  assertEquals(stored?.runId, "run-1");
  assertEquals(stored?.scope[0].allowedTools, ["list_issues"]);
});

test("a definitive refusal answers 400, so the caller knows retrying cannot help", async () => {
  const { handler, store, warnings } = makeApi();
  await store.createServer(server({ id: "ms-archived", archivedAt: T0 }));
  for (
    const body of [
      { servers: [{ serverId: "ms-nope", allowedTools: "*" }] },
      { servers: [{ serverId: "ms-archived", allowedTools: "*" }] },
      {
        servers: [{ serverId: "ms-1", allowedTools: "*" }, { serverId: "ms-1", allowedTools: "*" }],
      },
    ]
  ) {
    await store.saveServer(server()); // ms-1 live for the duplicate case
    const res = await call(handler, "POST", "/internal/v1/runs/run-1/mcp-credentials", body, TOKEN);
    assertEquals(res.status, 400, JSON.stringify(body));
    assert(typeof (await res.json()).error === "string");
  }
  assertEquals(warnings, []);
});

test("a store that is down answers 503, not 400", async () => {
  const broken: GatewayStore = {
    ...memoryGatewayStore(),
    getServer: () => Promise.reject(new Error("connection terminated unexpectedly")),
  };
  const { handler, warnings } = makeApi({ store: broken });
  const res = await call(handler, "POST", "/internal/v1/runs/run-1/mcp-credentials", SCOPE, TOKEN);
  assertEquals(res.status, 503);
  await res.body?.cancel();
  assertEquals(warnings, ["internal.issue_failed"]);
});

test("issue without a gateway address refuses, and says which knob is missing", async () => {
  const { handler, store } = makeApi({ gatewayUrl: null });
  await store.createServer(server());
  const res = await call(handler, "POST", "/internal/v1/runs/run-1/mcp-credentials", SCOPE, TOKEN);
  assertEquals(res.status, 503);
  assert((await res.json() as { error: string }).error.includes("RYPH_MCP_GATEWAY_URL"));
});

test("issue validates its body before it reaches the issuer", async () => {
  const { handler } = makeApi();
  for (
    const body of [
      { servers: [] },
      { servers: [{ allowedTools: "*" }] },
      { servers: [{ serverId: "ms-1", allowedTools: "everything" }] },
      { servers: [{ serverId: "ms-1", allowedTools: ["has space"] }] },
    ]
  ) {
    const res = await call(handler, "POST", "/internal/v1/runs/run-1/mcp-credentials", body, TOKEN);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
});

test("revoke kills a run's live credential, is idempotent, and needs no gateway address", async () => {
  const { handler, store } = makeApi();
  await store.createServer(server());
  const issued = await call(
    handler,
    "POST",
    "/internal/v1/runs/run-1/mcp-credentials",
    SCOPE,
    TOKEN,
  );
  const { token } = await issued.json() as { token: string };

  const first = await call(
    handler,
    "DELETE",
    "/internal/v1/runs/run-1/mcp-credentials",
    undefined,
    TOKEN,
  );
  assertEquals(first.status, 204);
  assertEquals((await store.getVirtualKeyByTokenHash(await sha256Hex(token)))?.revokedAt, T0);
  assertEquals(
    (await call(handler, "DELETE", "/internal/v1/runs/run-1/mcp-credentials", undefined, TOKEN))
      .status,
    204,
  );
  assertEquals(
    (await call(handler, "DELETE", "/internal/v1/runs/nope/mcp-credentials", undefined, TOKEN))
      .status,
    204,
  );

  const dark = makeApi({ gatewayUrl: null });
  assertEquals(
    (await call(
      dark.handler,
      "DELETE",
      "/internal/v1/runs/run-1/mcp-credentials",
      undefined,
      TOKEN,
    ))
      .status,
    204,
  );
});

test("archive is the kill switch with no question asked, idempotent, and never a platform row's", async () => {
  const { handler, store } = makeApi();
  await store.createServer(server());
  const path = "/internal/v1/mcp-servers/ms-1/archive";
  const first = await call(handler, "POST", path, undefined, TOKEN);
  assertEquals(first.status, 200);
  const archived = await first.json() as { id: string; archivedAt: string | null };
  assertEquals([archived.id, archived.archivedAt], ["ms-1", T0]);
  // The public shape: no sealed credential rides it.
  assert(!("encryptedAuth" in archived));
  assertEquals((await store.getServer("ms-1"))?.archivedAt, T0);
  // A repeat answers as the row stands.
  const again = await call(handler, "POST", path, undefined, TOKEN);
  assertEquals(again.status, 200);
  assertEquals((await again.json() as { archivedAt: string }).archivedAt, T0);

  const missing = await call(
    handler,
    "POST",
    "/internal/v1/mcp-servers/ms-nope/archive",
    undefined,
    TOKEN,
  );
  assertEquals(missing.status, 404);
  await missing.body?.cancel();

  const seeded = await ensurePlatformMemoryServer(store, T0);
  assert(seeded.ok);
  const platform = await call(
    handler,
    "POST",
    `/internal/v1/mcp-servers/${seeded.server.id}/archive`,
    undefined,
    TOKEN,
  );
  assertEquals(platform.status, 409);
  assertEquals((await platform.json() as { code: string }).code, PLATFORM_MANAGED);
  assertEquals((await store.getServer(seeded.server.id))?.archivedAt, null);
});
