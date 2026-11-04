// A test fixture, not a deployment option: a fast double for tests that care about behaviour
// ABOVE the store and want no database at all. Anything asserting on SQL belongs on makeTestDb().

import type { McpServer, McpUsageRecord, McpVirtualKey } from "../src/core/types.ts";
import { clampUsageLimit, type GatewayStore, usageCursor } from "../src/ports/gateway_store.ts";

/** The adapter's rule: an archived row holds no credential, whatever a write carries. */
function wiped(server: McpServer): McpServer {
  return server.archivedAt === null ? server : { ...server, encryptedAuth: null, authLast4: null };
}

export function memoryGatewayStore(): GatewayStore {
  const servers = new Map<string, McpServer>();
  const virtualKeys = new Map<string, McpVirtualKey>();
  const revokedRuns = new Map<string, string>();
  const usage: { seq: number; record: McpUsageRecord }[] = [];

  const liveBySlug = (slug: string) =>
    [...servers.values()].find((s) => s.slug === slug && s.archivedAt === null);

  return {
    createServer(server) {
      if (server.archivedAt === null && liveBySlug(server.slug)) {
        return Promise.resolve("slug_taken");
      }
      servers.set(server.id, structuredClone(server));
      return Promise.resolve("created");
    },
    getServer(id) {
      const server = servers.get(id);
      return Promise.resolve(server ? structuredClone(server) : null);
    },
    getLiveServerBySlug(slug) {
      const server = liveBySlug(slug);
      return Promise.resolve(server ? structuredClone(server) : null);
    },
    listServers() {
      const all = [...servers.values()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
      );
      return Promise.resolve(structuredClone(all));
    },
    saveServer(server) {
      const archivedAt = servers.get(server.id)?.archivedAt ?? server.archivedAt;
      servers.set(server.id, structuredClone(wiped({ ...server, archivedAt })));
      return Promise.resolve();
    },
    updateServer(id, edit) {
      const server = servers.get(id);
      if (!server) return Promise.resolve(null);
      Object.assign(server, wiped({ ...server, ...structuredClone(edit) }));
      return Promise.resolve(structuredClone(server));
    },
    async updateServerIf(id, edit, holds) {
      const server = servers.get(id);
      if (!server) return null;
      // The judgement and the write in one turn of the event loop, as the adapter's lock makes
      // them: an async `holds` is awaited on a copy, then re-checked against the live row.
      const judged = structuredClone(server);
      if (!(await holds(judged))) return "changed";
      if (JSON.stringify(servers.get(id)) !== JSON.stringify(judged)) return "changed";
      Object.assign(server, wiped({ ...server, ...structuredClone(edit) }));
      return structuredClone(server);
    },
    markHostedUrls() {
      let changed = 0;
      for (const server of servers.values()) {
        if (server.kind !== "hosted" || server.url === `hosted://${server.slug}`) continue;
        server.url = `hosted://${server.slug}`;
        changed++;
      }
      return Promise.resolve(changed);
    },
    archiveServer(id, at) {
      const server = servers.get(id);
      if (!server) return Promise.resolve(null);
      if (server.archivedAt === null) {
        Object.assign(server, wiped({ ...server, archivedAt: at, updatedAt: at }));
      }
      return Promise.resolve(structuredClone(server));
    },

    createVirtualKey(key) {
      if (revokedRuns.has(key.runId)) return Promise.resolve("run_revoked");
      virtualKeys.set(key.id, structuredClone(key));
      return Promise.resolve("created");
    },
    getVirtualKeyByTokenHash(tokenHash) {
      const key = [...virtualKeys.values()].find((k) => k.tokenHash === tokenHash);
      if (!key) return Promise.resolve(null);
      const revokedAt = revokedRuns.get(key.runId) ?? key.revokedAt;
      return Promise.resolve(structuredClone({ ...key, revokedAt }));
    },
    revokeVirtualKeysForRun(runId, at) {
      if (!revokedRuns.has(runId)) revokedRuns.set(runId, at);
      for (const key of virtualKeys.values()) {
        if (key.runId === runId && key.revokedAt === null) key.revokedAt = at;
      }
      return Promise.resolve();
    },

    recordUsage(record) {
      // The array index stands in for the adapter's serial counter, so the cursor means the same
      // thing here as it does on Postgres.
      usage.push({ seq: usage.length + 1, record: structuredClone(record) });
      return Promise.resolve();
    },
    listUsageForRun(runId, query) {
      const limit = clampUsageLimit(query?.limit);
      const before = usageCursor(query?.cursor);
      const newestFirst = usage
        .filter((u) => u.record.runId === runId && (before === null || u.seq < before))
        .reverse();
      const page = newestFirst.slice(0, limit);
      return Promise.resolve({
        records: structuredClone(page.map((u) => u.record).reverse()),
        nextCursor: newestFirst.length > limit ? String(page[page.length - 1].seq) : null,
      });
    },
    async close() {},
  };
}
