// The platform server kind: seeded once and left alone, exempt from the upstream guard, dialed
// through deployment config with the gateway's own credential and the run id, and refused every
// management action but the probe.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  ensurePlatformChatServer,
  ensurePlatformForgeServer,
  ensurePlatformMemoryServer,
  ensurePlatformWebServer,
  platformChatRow,
  platformForgeRow,
  platformMemoryRow,
  type PlatformMemorySeed,
  platformWebRow,
} from "../src/core/platform.ts";
import type { McpServer } from "../src/core/types.ts";
import { checkUpstreamUrl } from "../src/core/upstream_guard.ts";
import { makeGatewayHandler } from "../src/http/proxy.ts";
import { PLATFORM_MANAGED } from "../src/http/routes.ts";
import { makeMcpCredentialIssuer } from "../src/core/service.ts";
import {
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_CHAT_SLUG,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_FORGE_SLUG,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_MEMORY_SLUG,
  PLATFORM_RUN_ID_HEADER,
  PLATFORM_WEB_SERVER_ID,
  PLATFORM_WEB_SLUG,
} from "../src/platform.ts";
import { makeApi } from "./api.ts";
import { call, fakeDecrypt, openPolicy, server, T0 } from "./fixtures.ts";
import { memoryGatewayStore } from "./memory_store.ts";

/** The seeded row, or a failure naming what the seed said instead. */
function seeded(outcome: PlatformMemorySeed): McpServer {
  assert(outcome.ok, `the seed refused: ${outcome.ok ? "" : outcome.reason}`);
  return outcome.server;
}

test("the seed creates the row once and never rewrites it", async () => {
  const store = memoryGatewayStore();
  const first = seeded(await ensurePlatformMemoryServer(store, T0));
  assertEquals(first.id, PLATFORM_MEMORY_SERVER_ID);
  assertEquals(first.slug, PLATFORM_MEMORY_SLUG);
  assertEquals(first.kind, "platform");
  assertEquals(first.auth, "none");
  assertEquals(first.url, "platform://memory");
  const again = seeded(await ensurePlatformMemoryServer(store, "2030-01-01T00:00:00.000Z"));
  assertEquals(again.createdAt, T0, "left as it stood");
  assertEquals((await store.listServers()).length, 1);
});

test("an operator's server already holding the slug is reported, never thrown", async () => {
  const store = memoryGatewayStore();
  await store.createServer(server({ id: "ms-theirs", slug: "memory" }));
  const outcome = await ensurePlatformMemoryServer(store, T0);
  assertEquals(outcome.ok, false);
  assert(!outcome.ok);
  assert(outcome.reason.includes('slug "memory"'));
  assert(
    outcome.reason.includes("archive or rename"),
    "the log line must carry the remedy, since the row is what is missing",
  );
  assertEquals(await store.getServer(PLATFORM_MEMORY_SERVER_ID), null, "no row was forced in");
});

test("the slug conflict leaves the gateway serving its management surface", async () => {
  const { handler, store } = makeApi();
  await store.createServer(server({ id: "ms-theirs", slug: "memory", name: "Theirs" }));
  const outcome = await ensurePlatformMemoryServer(store, T0);
  assert(!outcome.ok, "the seed could not place the row");

  // Boot did not exit: the very API that fixes the conflict still answers.
  const listed = await call(handler, "GET", "/v1/mcp-servers");
  assertEquals(listed.status, 200);
  assertEquals((await listed.json()).mcpServers.map((s: { id: string }) => s.id), ["ms-theirs"]);
  const archived = await call(handler, "POST", "/internal/v1/mcp-servers/ms-theirs/archive");
  assertEquals(archived.status, 200, "the remedy is reachable, which is the whole point");
  await archived.body?.cancel();

  // And with the slug free, the next boot's seed places the row.
  assertEquals(seeded(await ensurePlatformMemoryServer(store, T0)).id, PLATFORM_MEMORY_SERVER_ID);
});

test("the upstream guard waves a platform row through: its URL is a marker, not an address", async () => {
  const strict = { allowInsecure: false, allowPrivate: false, resolve: () => Promise.resolve([]) };
  const verdict = await checkUpstreamUrl(platformMemoryRow(T0), strict);
  assertEquals(verdict.ok, true);
});

async function slice(platformWired: boolean) {
  const store = memoryGatewayStore();
  const row = seeded(await ensurePlatformMemoryServer(store, T0));
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://gw.test",
    ttlMs: 60_000,
  });
  const creds = await issuer.issue({
    runId: "r-1",
    servers: [{ serverId: row.id, allowedTools: ["search", "get"] }],
  });
  const seen: Request[] = [];
  const platformFetch = ((input: URL | Request | string, init?: RequestInit) => {
    const req = input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
    seen.push(req);
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
  }) as unknown as typeof fetch;
  const handler = makeGatewayHandler({
    store,
    decrypt: fakeDecrypt,
    now: () => new Date(T0),
    diag: { debug() {}, warn() {} },
    upstream: openPolicy,
    upstreamFetch: (() =>
      Promise.reject(
        new Error("the process-wide fetch must not be used"),
      )) as unknown as typeof fetch,
    platform: platformWired
      ? {
        memory: {
          url: "http://memory.internal/v1/memory-mcp",
          token: "gw-memory-token",
          fetch: platformFetch,
        },
      }
      : undefined,
  });
  return { handler, token: creds.token, url: creds.servers[0].url, seen };
}

const CALL = (name: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: {} },
});

test("a platform call is dialed through the deployment's fetch with the gateway's token and the run id", async () => {
  const { handler, token, url, seen } = await slice(true);
  const res = await handler(
    new Request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        [PLATFORM_RUN_ID_HEADER]: "r-forged",
        cookie: "nope",
      },
      body: JSON.stringify(CALL("search")),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "http://memory.internal/v1/memory-mcp");
  assertEquals(seen[0].headers.get("authorization"), "Bearer gw-memory-token");
  assertEquals(
    seen[0].headers.get(PLATFORM_RUN_ID_HEADER),
    "r-1",
    "the run the token names, never the header sent",
  );
  assertEquals(seen[0].headers.get("cookie"), null);

  // The frozen allowlist still applies: `propose` was not granted.
  const denied = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(CALL("propose")),
    }),
  );
  const body = await denied.json();
  assertEquals(body.error.code, -32601);
  assertEquals(seen.length, 1, "never dialed");
});

test("a platform row with no wiring answers 502, not a dial of its marker URL", async () => {
  const { handler, token, url } = await slice(false);
  const res = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(CALL("search")),
    }),
  );
  assertEquals(res.status, 502);
  assert((await res.json()).error.includes("not configured"));
});

test("the management surface lists a platform row and refuses to edit or archive it, but probes it", async () => {
  const { handler, store, probed } = makeApi();
  const row = seeded(await ensurePlatformMemoryServer(store, T0));
  const listed = await (await call(handler, "GET", "/v1/mcp-servers")).json();
  assertEquals(listed.mcpServers.map((s: { kind: string }) => s.kind), ["platform"]);
  for (
    const [method, path, body] of [
      ["PATCH", `/v1/mcp-servers/${row.id}`, { name: "x" }],
      ["POST", `/internal/v1/mcp-servers/${row.id}/archive`],
    ] as Array<[string, string, unknown?]>
  ) {
    const res = await call(handler, method, path, body);
    assertEquals(res.status, 409, `${method} ${path}`);
    assertEquals((await res.json()).code, PLATFORM_MANAGED);
  }
  assertEquals((await store.getServer(row.id))?.archivedAt, null);
  // The probe is a look, not a change: the agent form's picker lists a platform row's tools with
  // it, as it does an operator's.
  const res = await call(handler, "POST", `/v1/mcp-servers/${row.id}/probe`);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  assertEquals(probed.map((s) => s.id), [row.id]);
});

test("the chat row seeds beside memory's, on its own slug, and is a platform row like it", async () => {
  const store = memoryGatewayStore();
  seeded(await ensurePlatformMemoryServer(store, T0));
  const chat = seeded(await ensurePlatformChatServer(store, T0));
  assertEquals(chat.id, PLATFORM_CHAT_SERVER_ID);
  assertEquals(chat.slug, PLATFORM_CHAT_SLUG);
  assertEquals(chat.kind, "platform");
  assertEquals(chat.url, "platform://chat");
  assertEquals((await store.listServers()).length, 2);
  // Idempotent, and the marker URL passes the upstream guard like memory's.
  assertEquals(
    seeded(await ensurePlatformChatServer(store, "2030-01-01T00:00:00.000Z")).createdAt,
    T0,
  );
  const strict = { allowInsecure: false, allowPrivate: false, resolve: () => Promise.resolve([]) };
  assertEquals((await checkUpstreamUrl(platformChatRow(T0), strict)).ok, true);
  // An operator's `chat` server blocks the seed and names the remedy, as memory's does.
  const taken = memoryGatewayStore();
  await taken.createServer(server({ id: "ms-theirs", slug: "chat" }));
  const outcome = await ensurePlatformChatServer(taken, T0);
  assert(!outcome.ok);
  assert(outcome.reason.includes('slug "chat"') && outcome.reason.includes("chat server"));
});

test("the forge seed creates its own row beside the others", async () => {
  const store = memoryGatewayStore();
  seeded(await ensurePlatformMemoryServer(store, T0));
  const forge = seeded(await ensurePlatformForgeServer(store, T0));
  assertEquals(forge.id, PLATFORM_FORGE_SERVER_ID);
  assertEquals(forge.slug, PLATFORM_FORGE_SLUG);
  assertEquals(forge.kind, "platform");
  assertEquals(forge.url, "platform://forge");
  assertEquals(platformForgeRow(T0).auth, "none");
  assertEquals((await store.listServers()).length, 2);
});

test("the web seed creates its own row beside the others", async () => {
  const store = memoryGatewayStore();
  seeded(await ensurePlatformMemoryServer(store, T0));
  const web = seeded(await ensurePlatformWebServer(store, T0));
  assertEquals(web.id, PLATFORM_WEB_SERVER_ID);
  assertEquals(web.slug, PLATFORM_WEB_SLUG);
  assertEquals(web.kind, "platform");
  assertEquals(web.url, "platform://web");
  assertEquals(platformWebRow(T0).auth, "none");
  assertEquals((await store.listServers()).length, 2);
  // Idempotent, and the marker URL passes the upstream guard like every other platform row.
  assertEquals(
    seeded(await ensurePlatformWebServer(store, "2030-01-01T00:00:00.000Z")).createdAt,
    T0,
  );
  const strict = { allowInsecure: false, allowPrivate: false, resolve: () => Promise.resolve([]) };
  assertEquals((await checkUpstreamUrl(platformWebRow(T0), strict)).ok, true);
  // An operator's own `web` server blocks the seed and names the remedy, as memory's does.
  const taken = memoryGatewayStore();
  await taken.createServer(server({ id: "ms-theirs", slug: "web" }));
  const outcome = await ensurePlatformWebServer(taken, T0);
  assert(!outcome.ok);
  assert(outcome.reason.includes('slug "web"') && outcome.reason.includes("web server"));
});

test("a run's web call is forwarded with the gateway's own credential and METERED like any other tool", async () => {
  const store = memoryGatewayStore();
  const row = seeded(await ensurePlatformWebServer(store, T0));
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://gw.test",
    ttlMs: 60_000,
  });
  const creds = await issuer.issue({
    runId: "r-web",
    servers: [{ serverId: row.id, allowedTools: ["search", "fetch"] }],
  });
  const seen: Request[] = [];
  const handler = makeGatewayHandler({
    store,
    decrypt: fakeDecrypt,
    now: () => new Date(T0),
    diag: { debug() {}, warn() {} },
    upstream: openPolicy,
    upstreamFetch: (() =>
      Promise.reject(
        new Error("the process-wide fetch must not be used"),
      )) as unknown as typeof fetch,
    platform: {
      [PLATFORM_WEB_SLUG]: {
        url: "http://web.internal/v1/web-mcp",
        token: "gw-web-token",
        fetch: ((input: URL | Request | string, init?: RequestInit) => {
          seen.push(
            input instanceof Request ? new Request(input, init) : new Request(String(input), init),
          );
          return Promise.resolve(
            Response.json({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
          );
        }) as unknown as typeof fetch,
      },
    },
  });
  const res = await handler(
    new Request(creds.servers[0].url, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
      body: JSON.stringify(CALL("fetch")),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(seen[0].url, "http://web.internal/v1/web-mcp");
  assertEquals(seen[0].headers.get("authorization"), "Bearer gw-web-token");
  assertEquals(seen[0].headers.get(PLATFORM_RUN_ID_HEADER), "r-web");
  // The trail the /v1/mcp-usage/:runId page reads: a web call is a row like a memory call.
  const { records: usage } = await store.listUsageForRun("r-web");
  assertEquals(
    usage.map((u) => [u.serverId, u.method, u.tool, u.status]),
    [[PLATFORM_WEB_SERVER_ID, "tools/call", "fetch", "ok"]],
  );
});
