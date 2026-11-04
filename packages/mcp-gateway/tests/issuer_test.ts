// The credential issuer: what the result carries, what lands in a row, and every refusal.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  gatewayPathFor,
  makeMcpCredentialIssuer,
  McpCredentialRefusedError,
} from "../src/core/service.ts";
import { memoryGatewayStore } from "./memory_store.ts";
import { sha256Hex } from "@ryph/sealed";
import { server, T0 } from "./fixtures.ts";

function makeIssuer(store = memoryGatewayStore()) {
  const issuer = makeMcpCredentialIssuer({
    store,
    now: () => new Date(T0),
    gatewayUrl: "http://mcp-gateway.internal:7430/",
    ttlMs: 60_000,
  });
  return { issuer, store };
}

const SCOPE = {
  runId: "r-1",
  servers: [{ serverId: "ms-1", allowedTools: ["list_issues"] as string[] | "*" }],
};

test("issue mints one token for the run and a gateway URL per server; only a hash lands", async () => {
  const { issuer, store } = makeIssuer();
  await store.createServer(server());
  await store.createServer(server({ id: "ms-2", slug: "github", name: "GitHub" }));

  const creds = await issuer.issue({
    runId: "r-1",
    servers: [
      { serverId: "ms-1", allowedTools: ["list_issues"] },
      { serverId: "ms-2", allowedTools: "*" },
    ],
  });
  assert(creds.token.startsWith("ryph-mcp-"), "recognizably a ryph credential");
  assertEquals(creds.servers, [
    { slug: "linear", name: "Linear", url: "http://mcp-gateway.internal:7430/v1/mcp/r-1/linear" },
    { slug: "github", name: "GitHub", url: "http://mcp-gateway.internal:7430/v1/mcp/r-1/github" },
  ]);

  const row = await store.getVirtualKeyByTokenHash(await sha256Hex(creds.token));
  assert(row !== null);
  assertEquals(row.runId, "r-1");
  assertEquals(row.scope, [
    { serverId: "ms-1", slug: "linear", allowedTools: ["list_issues"] },
    { serverId: "ms-2", slug: "github", allowedTools: "*" },
  ]);
  assertEquals(row.expiresAt, "2026-01-01T00:01:00.000Z"); // now + ttl
  assertEquals(row.revokedAt, null);
  assert(!JSON.stringify(row).includes(creds.token), "the raw token never lands in a row");
});

test("gatewayPathFor escapes what it is given", () => {
  assertEquals(gatewayPathFor("r-1", "linear"), "/v1/mcp/r-1/linear");
  assertEquals(gatewayPathFor("r 1", "a/b"), "/v1/mcp/r%201/a%2Fb");
});

test("issue refuses an unknown or archived server, a duplicate, and an empty scope", async () => {
  const { issuer, store } = makeIssuer();
  await assertRejects(() => issuer.issue(SCOPE), Error, "does not exist");

  await store.createServer(server({ archivedAt: T0 }));
  await assertRejects(() => issuer.issue(SCOPE), Error, "archived");

  // Archiving is one-way, so the remaining refusals need a store where ms-1 is live.
  const { issuer: fresh, store: freshStore } = makeIssuer();
  await freshStore.createServer(server());
  await assertRejects(
    () =>
      fresh.issue({
        runId: "r-1",
        servers: [...SCOPE.servers, { serverId: "ms-1", allowedTools: "*" }],
      }),
    Error,
    "named twice",
  );
  await assertRejects(() => fresh.issue({ runId: "r-1", servers: [] }), Error, "no servers");
});

test("a concluded run gets no credential: issue after revoke is a definitive refusal", async () => {
  const { issuer, store } = makeIssuer();
  await store.createServer(server());
  const before = (await issuer.issue(SCOPE)).token;
  await issuer.revokeForRun("r-1");
  await assertRejects(() => issuer.issue(SCOPE), McpCredentialRefusedError, "concluded");
  // …and the credential issued before the revoke is as dead as the rest.
  const row = await store.getVirtualKeyByTokenHash(await sha256Hex(before));
  assertEquals(row?.revokedAt, T0);
});

test("revokeForRun kills every live credential of the run and only that run's", async () => {
  const { issuer, store } = makeIssuer();
  await store.createServer(server());

  const first = (await issuer.issue(SCOPE)).token;
  const second = (await issuer.issue(SCOPE)).token; // a refetched boot
  const other = (await issuer.issue({ ...SCOPE, runId: "r-2" })).token;

  await issuer.revokeForRun("r-1");
  for (const token of [first, second]) {
    const row = await store.getVirtualKeyByTokenHash(await sha256Hex(token));
    assertEquals(row?.revokedAt, T0);
  }
  const otherRow = await store.getVirtualKeyByTokenHash(await sha256Hex(other));
  assertEquals(otherRow?.revokedAt, null);
});
