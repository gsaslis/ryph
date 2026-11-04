// The drizzle `GatewayStore` on Postgres — reads via the relational `db.query.*` API, writes via
// the builder, same conventions as the model-proxy's store.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { McpServer } from "../../core/types.ts";
import {
  clampUsageLimit,
  type GatewayStore,
  type McpServerEdit,
  usageCursor,
} from "../../ports/gateway_store.ts";
import type { McpGatewayDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

type ServerRow = typeof schema.mcpServers.$inferSelect;

/** The one mapping in this store: `host` is an object on the record and five columns here. */
function hostColumns(host: McpServer["host"]) {
  return {
    hostHandle: host?.handle ?? null,
    hostStatus: host?.status ?? null,
    hostImageDigest: host?.imageDigest ?? null,
    hostStartedAt: host?.startedAt ?? null,
    hostError: host?.lastError ?? null,
  };
}

function toRow(server: McpServer): ServerRow {
  const { host, ...rest } = server;
  return { ...rest, ...hostColumns(host) };
}

const servers = schema.mcpServers;

/**
 * A credential column as written: the value on a live row, null on an archived one. Archiving
 * wipes the credential, and no write that raced the archive (or came after it) seals one back.
 */
function unlessArchived(value: string | null) {
  return sql`case when ${servers.archivedAt} is null then ${value} else null end`;
}

/** An edit's columns: a `host` it names becomes all five, and nothing it leaves out is written. */
function editColumns(edit: McpServerEdit): PgUpdateSetSource<typeof servers> {
  const { host, encryptedAuth, authLast4, ...rest } = edit;
  return {
    ...rest,
    ...(host === undefined ? {} : hostColumns(host)),
    ...(encryptedAuth === undefined ? {} : { encryptedAuth: unlessArchived(encryptedAuth) }),
    ...(authLast4 === undefined ? {} : { authLast4: unlessArchived(authLast4) }),
  };
}

function fromRow(row: ServerRow): McpServer {
  const { hostHandle, hostStatus, hostImageDigest, hostStartedAt, hostError, ...rest } = row;
  return {
    ...rest,
    host: hostStatus === null ? null : {
      handle: hostHandle,
      status: hostStatus,
      imageDigest: hostImageDigest,
      startedAt: hostStartedAt,
      lastError: hostError,
    },
  };
}

export function drizzleGatewayStore(handle: McpGatewayDbHandle): GatewayStore {
  const { db } = handle;
  const keys = schema.mcpVirtualKeys;

  const getServer = async (id: string) => {
    const row = await db.query.mcpServers.findFirst({ where: (s, { eq }) => eq(s.id, id) });
    return row ? fromRow(row) : null;
  };

  return {
    async createServer(server) {
      // The conflict target names the partial index, so only a LIVE twin is a conflict — and the
      // check is the insert itself, not a read two racing creates could both pass.
      const inserted = await db.insert(servers).values(toRow(server))
        .onConflictDoNothing({ target: servers.slug, where: sql`${servers.archivedAt} is null` })
        .returning({ id: servers.id });
      return inserted.length === 1 ? "created" : "slug_taken";
    },
    getServer,
    async getLiveServerBySlug(slug) {
      const row = await db.query.mcpServers.findFirst({
        where: (s, { and, eq, isNull }) => and(eq(s.slug, slug), isNull(s.archivedAt)),
      });
      return row ? fromRow(row) : null;
    },
    async listServers() {
      const rows = await db.query.mcpServers.findMany({
        orderBy: (s, { asc, desc }) => [desc(s.createdAt), asc(s.id)],
      });
      return rows.map(fromRow);
    },
    async saveServer(server) {
      const row = toRow(server);
      await db.insert(servers).values(row).onConflictDoUpdate({
        target: servers.id,
        set: {
          ...row,
          archivedAt: sql`coalesce(${servers.archivedAt}, excluded.archived_at)`,
          encryptedAuth: unlessArchived(row.encryptedAuth),
          authLast4: unlessArchived(row.authLast4),
        },
      });
    },
    async updateServer(id, edit) {
      const [row] = await db.update(servers).set(editColumns(edit)).where(eq(servers.id, id))
        .returning();
      return row ? fromRow(row) : null;
    },
    async updateServerIf(id, edit, holds) {
      // The row locked for the read, so the destination `holds` judges is the one the write lands
      // on: a concurrent edit waits for this one, or this one waits and reads what it wrote.
      return await db.transaction(async (tx) => {
        const [current] = await tx.select().from(servers).where(eq(servers.id, id)).for("update");
        if (current === undefined) return null;
        if (!(await holds(fromRow(current)))) return "changed" as const;
        const [row] = await tx.update(servers).set(editColumns(edit)).where(eq(servers.id, id))
          .returning();
        return row ? fromRow(row) : null;
      });
    },
    async markHostedUrls() {
      const marker = sql`'hosted://' || ${servers.slug}`;
      const rows = await db.update(servers)
        .set({ url: marker })
        .where(and(eq(servers.kind, "hosted"), sql`${servers.url} <> ${marker}`))
        .returning({ id: servers.id });
      return rows.length;
    },
    async archiveServer(id, at) {
      const [row] = await db.update(servers)
        // The credential goes with it: nothing decrypts an archived row's again.
        .set({ archivedAt: at, updatedAt: at, encryptedAuth: null, authLast4: null })
        .where(and(eq(servers.id, id), isNull(servers.archivedAt)))
        .returning();
      // No row updated: already archived (idempotent — answer it as it stands) or no such server.
      return row ? fromRow(row) : await getServer(id);
    },

    async createVirtualKey(key) {
      // A read before the write, so not airtight on its own — the lookup's join is what makes a
      // key that slips past this dead anyway. This is the definitive answer for the common case.
      const revoked = await db.query.mcpRevokedRuns.findFirst({
        where: (r, { eq }) => eq(r.runId, key.runId),
      });
      if (revoked) return "run_revoked";
      await db.insert(keys).values(key);
      return "created";
    },
    async getVirtualKeyByTokenHash(tokenHash) {
      const [row] = await db.select({ key: keys, runRevokedAt: schema.mcpRevokedRuns.revokedAt })
        .from(keys)
        .leftJoin(schema.mcpRevokedRuns, eq(schema.mcpRevokedRuns.runId, keys.runId))
        .where(eq(keys.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      // The run's revocation is the authoritative time; a key row stamped later (one that slipped
      // in, caught by a repeated revoke) carries a later stamp of the same fact.
      return { ...row.key, revokedAt: row.runRevokedAt ?? row.key.revokedAt };
    },
    async revokeVirtualKeysForRun(runId, at) {
      // The run first: from the moment it commits, every key of the run is dead at lookup.
      await db.insert(schema.mcpRevokedRuns).values({ runId, revokedAt: at }).onConflictDoNothing();
      await db.update(keys)
        .set({ revokedAt: at })
        .where(and(eq(keys.runId, runId), isNull(keys.revokedAt)));
    },

    async recordUsage(record) {
      await db.insert(schema.mcpUsage).values(record);
    },
    async listUsageForRun(runId, query) {
      // Newest-first off the (run_id, seq) index, one row further than asked: that extra row is
      // how the page knows an older one exists without a count over a trail the agent sized.
      const limit = clampUsageLimit(query?.limit);
      const before = usageCursor(query?.cursor);
      const rows = await db.query.mcpUsage.findMany({
        where: (u, { and, eq, lt }) =>
          before === null ? eq(u.runId, runId) : and(eq(u.runId, runId), lt(u.seq, before)),
        orderBy: (u, { desc }) => [desc(u.seq)],
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const oldest = page.at(-1);
      return {
        records: page.reverse().map(({ seq: _seq, ...record }) => record),
        // The row's own counter is the cursor, and stays an adapter detail: it leaves here as an
        // opaque string and comes back as one.
        nextCursor: rows.length > limit && oldest ? String(oldest.seq) : null,
      };
    },
    close: handle.close,
  };
}
