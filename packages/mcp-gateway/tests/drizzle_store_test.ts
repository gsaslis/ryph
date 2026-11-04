// The drizzle adapter round-trips the same shapes the memory store does, on an in-memory db with
// the schema pushed straight from db/schema.ts (see tests/db.ts) — including the partial unique
// index that makes a slug unique among LIVE servers only.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { drizzleGatewayStore } from "../src/adapters/store/drizzle.ts";
import type { McpVirtualKey } from "../src/core/types.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { reusableDbSuite } from "./reusable_db.ts";
import { server, T0 } from "./fixtures.ts";

const { test, makeTestDb } = reusableDbSuite("mcp-gateway store");

const T1 = "2026-01-01T01:00:00.000Z";

const virtualKey: McpVirtualKey = {
  id: "mk-1",
  runId: "r-1",
  tokenHash: "hash-1",
  scope: [{ serverId: "ms-1", slug: "linear", allowedTools: ["list_issues"] }],
  expiresAt: T1,
  revokedAt: null,
  createdAt: T0,
};

test("drizzle store round-trips servers, virtual keys, and usage", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    const srv = server({ description: "issues", encryptedAuth: "v1.aXY=.Y3Q=" });
    await store.createServer(srv);
    assertEquals(await store.getServer("ms-1"), srv);
    assertEquals(await store.getLiveServerBySlug("linear"), srv);
    assertEquals(await store.getLiveServerBySlug("github"), null);
    assertEquals((await store.listServers()).map((s) => s.id), ["ms-1"]);
    await store.saveServer({ ...srv, archivedAt: T1, updatedAt: T1 });
    assertEquals((await store.getServer("ms-1"))?.archivedAt, T1);
    assertEquals(await store.getLiveServerBySlug("linear"), null, "archived rows free the slug");

    await store.createVirtualKey(virtualKey);
    await store.createVirtualKey({
      ...virtualKey,
      id: "mk-2",
      runId: "r-2",
      tokenHash: "hash-2",
      scope: [{ serverId: "ms-1", slug: "linear", allowedTools: "*" }],
    });
    // The lookup column round-trips, including both allowlist shapes inside the jsonb scope.
    assertEquals(await store.getVirtualKeyByTokenHash("hash-1"), virtualKey);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-2"))?.scope[0].allowedTools, "*");
    assertEquals(await store.getVirtualKeyByTokenHash("hash-none"), null);

    // Revocation is per run and stamps only live keys.
    await store.revokeVirtualKeysForRun("r-1", T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1);
    assertEquals((await store.getVirtualKeyByTokenHash("hash-2"))?.revokedAt, null);
    await store.revokeVirtualKeysForRun("r-1", "2026-01-01T02:00:00.000Z");
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1); // unchanged

    await store.recordUsage({
      runId: "r-1",
      serverId: "ms-1",
      method: "tools/call",
      tool: "list_issues",
      status: "ok",
      httpStatus: 200,
      durationMs: 42,
      at: T0,
    });
    await store.recordUsage({
      runId: "r-1",
      serverId: "ms-1",
      method: "tools/call",
      tool: "delete_team",
      status: "denied",
      httpStatus: null,
      durationMs: 0,
      at: T1,
    });
    const { records: usage, nextCursor } = await store.listUsageForRun("r-1");
    assertEquals(usage.length, 2);
    assertEquals(usage[0].tool, "list_issues");
    assertEquals(usage[1].status, "denied");
    assertEquals(usage[1].httpStatus, null);
    assert(!("seq" in usage[0]), "the row's own counter stays an adapter detail");
    assertEquals(nextCursor, null, "two rows is the whole trail");
    assertEquals((await store.listUsageForRun("r-none")).records, []);

    // A page is a window on the NEWEST rows, and says so: the cursor walks backwards from it.
    const newest = await store.listUsageForRun("r-1", { limit: 1 });
    assertEquals(newest.records.map((u) => u.tool), ["delete_team"]);
    assert(newest.nextCursor !== null, "an older row is left, so a cursor comes with the page");
    const older = await store.listUsageForRun("r-1", { limit: 1, cursor: newest.nextCursor });
    assertEquals(older.records.map((u) => u.tool), ["list_issues"]);
    assertEquals(older.nextCursor, null);
  } finally {
    await store.close();
  }
});

test("a hosted server's container state round-trips through its host_* columns", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    const hosted = server({
      id: "ms-h",
      slug: "grafana",
      kind: "hosted",
      url: "http://127.0.0.1:54321/grafana/mcp",
      catalogueId: "grafana",
      settings: { GRAFANA_URL: "https://grafana.example.com", readOnly: true },
      host: {
        handle: "ryph-tool-grafana-ms-h",
        status: "healthy",
        imageDigest: `sha256:${"a".repeat(64)}`,
        startedAt: T0,
        lastError: null,
      },
    });
    await store.createServer(hosted);
    assertEquals(await store.getServer("ms-h"), hosted);
    const custom = server({
      id: "ms-c",
      slug: "internal",
      kind: "hosted",
      custom: {
        image: `r.example.com/t@sha256:${"b".repeat(64)}`,
        command: [],
        port: 9000,
        path: "/mcp",
        callerAuth: { env: "TOOLS_SERVER_TOKEN" },
      },
      host: {
        handle: null,
        status: "unreachable",
        imageDigest: null,
        startedAt: null,
        lastError: "no",
      },
    });
    await store.saveServer(custom);
    assertEquals(await store.getServer("ms-c"), custom);
    // A remote row reads back with no host at all, and kind defaulted.
    await store.createServer(server({ id: "ms-r", slug: "linear" }));
    const remote = await store.getServer("ms-r");
    assertEquals([remote?.kind, remote?.host, remote?.settings], ["remote", null, null]);
  } finally {
    await store.close();
  }
});

test("an edit naming host writes the host_* columns, and nothing the edit leaves out", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    const hosted = server({
      id: "ms-h",
      slug: "grafana",
      kind: "hosted",
      catalogueId: "grafana",
      settings: { GRAFANA_URL: "https://grafana.example.com" },
      host: {
        handle: null,
        status: "starting",
        imageDigest: null,
        startedAt: null,
        lastError: null,
      },
    });
    await store.createServer(hosted);
    // A rename lands between the hosting service's read of the row and its status write…
    await store.updateServer("ms-h", { name: "Grafana (prod)", updatedAt: T1 });
    const host = {
      handle: "ryph-tool-grafana-ms-h",
      status: "healthy" as const,
      imageDigest: `sha256:${"a".repeat(64)}`,
      startedAt: T1,
      lastError: null,
    };
    const url = "http://127.0.0.1:54321/grafana/mcp";
    const flipped = await store.updateServer("ms-h", { url, host, updatedAt: T1 });
    // …and survives it.
    assertEquals(flipped, { ...hosted, name: "Grafana (prod)", url, host, updatedAt: T1 });
    assertEquals(await store.getServer("ms-h"), flipped);
    // An operator's settings edit, in turn, leaves the container state alone.
    const edited = await store.updateServer("ms-h", {
      settings: { GRAFANA_URL: "https://grafana2.example.com" },
      updatedAt: T1,
    });
    assertEquals(edited?.host, host);
  } finally {
    await store.close();
  }
});

test("the database itself refuses two LIVE servers with one slug, and allows an archived twin", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    assertEquals(await store.createServer(server({ id: "ms-1" })), "created");
    // Racing creates both reach the insert; the loser is an answer, not a thrown 500.
    const [a, b] = await Promise.all([
      store.createServer(server({ id: "ms-2" })),
      store.createServer(server({ id: "ms-4" })),
    ]);
    assertEquals([a, b], ["slug_taken", "slug_taken"]);
    await store.archiveServer("ms-1", T0);
    assertEquals(await store.createServer(server({ id: "ms-3" })), "created"); // free again
    assertEquals((await store.getLiveServerBySlug("linear"))?.id, "ms-3");
    // Only the slug is answered: any other conflict (a duplicate id) still throws.
    await assertRejects(() => store.createServer(server({ id: "ms-3", slug: "other" })));
  } finally {
    await store.close();
  }
});

test("archiving wipes the credential, and no write seals one back on the archived row", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    const sealed = server({ encryptedAuth: "sealed:old", authLast4: "1234" });
    await store.createServer(sealed);
    const archived = await store.archiveServer("ms-1", T0);
    assertEquals([archived?.encryptedAuth, archived?.authLast4], [null, null]);

    // A rotation that read the row before the archive landed, and a whole stale row, both lose.
    await store.updateServer("ms-1", {
      encryptedAuth: "sealed:new",
      authLast4: "5678",
      updatedAt: T1,
    });
    assertEquals((await store.getServer("ms-1"))?.encryptedAuth, null);
    assertEquals(
      await store.updateServerIf("ms-1", { encryptedAuth: "sealed:new", updatedAt: T1 }, () => true)
        .then((s) => s === "changed" ? s : s?.encryptedAuth),
      null,
    );
    await store.saveServer({ ...sealed, updatedAt: T1 });
    const row = await store.getServer("ms-1");
    assertEquals([row?.encryptedAuth, row?.authLast4, row?.archivedAt], [null, null, T0]);

    // A live row still takes a rotation.
    await store.createServer(server({ id: "ms-2", slug: "github" }));
    await store.updateServer("ms-2", { encryptedAuth: "sealed:live", updatedAt: T1 });
    assertEquals((await store.getServer("ms-2"))?.encryptedAuth, "sealed:live");
  } finally {
    await store.close();
  }
});

test("archiving is one-way, and an edit writes only the fields it names", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    const stale = server();
    await store.createServer(stale);
    assertEquals((await store.archiveServer("ms-1", T0))?.archivedAt, T0);
    assertEquals((await store.archiveServer("ms-1", T1))?.archivedAt, T0, "idempotent");
    assertEquals(await store.archiveServer("ms-nope", T0), null);

    // A PATCH that read the row before the archive landed cannot bring it back…
    const edited = await store.updateServer("ms-1", { name: "Linear (org)", updatedAt: T1 });
    assertEquals([edited?.name, edited?.archivedAt, edited?.url], ["Linear (org)", T0, stale.url]);
    // …and neither can a whole stale row written over it.
    await store.saveServer({ ...stale, updatedAt: T1 });
    assertEquals((await store.getServer("ms-1"))?.archivedAt, T0);
    assertEquals(await store.updateServer("ms-nope", { updatedAt: T1 }), null);

    // A rotation and a rename racing each other both land.
    await store.createServer(server({ id: "ms-2", slug: "github" }));
    await Promise.all([
      store.updateServer("ms-2", {
        auth: "bearer",
        encryptedAuth: "sealed:rotated",
        authLast4: "ated",
        updatedAt: T1,
      }),
      store.updateServer("ms-2", { name: "GitHub", updatedAt: T1 }),
    ]);
    const both = await store.getServer("ms-2");
    assertEquals([both?.encryptedAuth, both?.name], ["sealed:rotated", "GitHub"]);
  } finally {
    await store.close();
  }
});

test("a revoked run stays revoked: later keys are refused, and one that slips in is dead", async () => {
  const handle = await makeTestDb();
  const store = drizzleGatewayStore(handle);
  try {
    await store.revokeVirtualKeysForRun("r-1", T1);
    assertEquals(await store.createVirtualKey(virtualKey), "run_revoked");
    assertEquals(await store.getVirtualKeyByTokenHash("hash-1"), null, "nothing was written");

    // The race the refusal alone cannot close: a key inserted after the revocation committed,
    // past the check. The lookup still reads it as revoked.
    await handle.db.insert(schema.mcpVirtualKeys).values({ ...virtualKey, id: "mk-late" });
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1);

    // Other runs are untouched, and the first revocation's time stands.
    assertEquals(
      await store.createVirtualKey({
        ...virtualKey,
        id: "mk-2",
        runId: "r-2",
        tokenHash: "hash-2",
      }),
      "created",
    );
    assertEquals((await store.getVirtualKeyByTokenHash("hash-2"))?.revokedAt, null);
    await store.revokeVirtualKeysForRun("r-1", "2026-01-01T02:00:00.000Z");
    assertEquals((await store.getVirtualKeyByTokenHash("hash-1"))?.revokedAt, T1);
  } finally {
    await store.close();
  }
});

test("hosted rows get their marker url in one idempotent write; remote rows are untouched", async () => {
  const store = drizzleGatewayStore(await makeTestDb());
  try {
    await store.createServer(server({ id: "ms-r", slug: "remote" }));
    await store.createServer(server({
      id: "ms-h",
      slug: "grafana",
      kind: "hosted",
      url: "http://ryph-tool-guard:8080/grafana/mcp",
    }));
    await store.createServer(server({
      id: "ms-m",
      slug: "marked",
      kind: "hosted",
      url: "hosted://marked",
    }));
    const remoteUrl = (await store.getServer("ms-r"))!.url;
    assertEquals(await store.markHostedUrls(), 1);
    assertEquals((await store.getServer("ms-h"))!.url, "hosted://grafana");
    assertEquals((await store.getServer("ms-r"))!.url, remoteUrl);
    assertEquals(await store.markHostedUrls(), 0);
  } finally {
    await store.close();
  }
});
