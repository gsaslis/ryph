// The drizzle `KeyStore` on Postgres — reads via the relational `db.query.*` API, writes via
// the builder, same conventions as the orchestrator's store.

import {
  and,
  type AnyColumn,
  eq,
  gt,
  gte,
  isNull,
  like,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { SEALED_FORMAT } from "@ryph/sealed";
import { NO_SECRET, PLATFORM_PRINCIPAL_PREFIX } from "../../core/types.ts";
import { customProviderSpec, endpointShape } from "../../core/registry.ts";
import type { UsageDimension } from "../../core/usage_report.ts";
import type { KeyStore } from "../../ports/key_store.ts";
import type { ModelProxyDb, ModelProxyDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

/** The one row the platform policy table holds. */
const PLATFORM_POLICY_ID = "default";
/** The one row the agent host table holds. */
const AGENT_HOST_ID = "default";

/** How often a waiting lock is asked for again, and how long it is waited for in all. */
const LOCK_POLL_MS = 50;
const LOCK_WAIT_MS = 60_000;

/**
 * A provider key's advisory lock number: FNV-1a over the id, in the range a LockSession takes.
 * Two ids that collide only ever serialize each other's refreshes, which costs a wait and
 * nothing else.
 */
function lockKeyOf(id: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`provider_key:${id}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Whatever a grouped read runs on: the database itself, or a transaction inside it. */
type Queryable = Pick<ModelProxyDb, "select">;

const usage = schema.proxyUsage;

/** The grouping key per report dimension; null for `model`, which the row carries anyway. */
function usageKey(by: UsageDimension): SQL<string | null> | null {
  switch (by) {
    case "model":
      return null;
    case "agent":
      // Spend with no agent is a platform principal's; it is grouped under that principal. The
      // prefix carries no LIKE metacharacter and no quote, so it is inlined as it stands.
      return sql`coalesce(${usage.agentId}, case when ${usage.runId} like '${
        sql.raw(PLATFORM_PRINCIPAL_PREFIX)
      }%' then ${usage.runId} end)`;
    case "providerKey":
      return sql`${usage.providerKeyId}`;
    case "day":
      return sql`substr(${usage.at}, 1, 10)`;
    case "task":
      return sql`${usage.taskId}`;
  }
}

const sumOf = (column: AnyColumn) =>
  sql<number>`coalesce(sum(${column}), 0)::float8`.mapWith(Number);

export function drizzleKeyStore(handle: ModelProxyDbHandle): KeyStore {
  const { db } = handle;
  // Provider-key locks are taken ONE AT A TIME in this process, each on a connection reserved
  // for that one acquisition and handed back after it: a lock belongs to the session that took
  // it, so a pooled handle could not release it, and a connection kept for the life of the
  // process would hold one of a small pool (two on GKE) forever. One at a time because the work
  // under a lock reads and writes through the pool too: two held at once on a pool of two
  // would leave those reads nothing to run on. The locks guard token refreshes and the status
  // marks around them, which are rare, so the queue costs nothing that matters.
  let lockQueue: Promise<unknown> = Promise.resolve();
  const lockedOnce = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    // A connection that cannot be had fails this acquisition only; the next opens its own.
    const session = await handle.lockSession();
    try {
      const key = lockKeyOf(id);
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (!(await session.tryLock(key))) {
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for provider key "${id}"'s lock`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
      try {
        return await fn();
      } finally {
        // An unlock that fails is a connection that failed, and its locks went with it.
        await session.unlock(key).catch(() => {});
      }
    } finally {
      await session.close();
    }
  };

  return {
    async createProviderKey(key) {
      await db.insert(schema.providerKeys).values(key);
    },
    async getProviderKey(id) {
      const row = await db.query.providerKeys.findFirst({
        where: (k, { eq }) => eq(k.id, id),
      });
      return row ?? null;
    },
    async listProviderKeys() {
      return await db.query.providerKeys.findMany({
        orderBy: (k, { asc, desc }) => [desc(k.createdAt), asc(k.id)],
      });
    },
    async saveProviderKey(key) {
      await db.insert(schema.providerKeys).values(key)
        .onConflictDoUpdate({ target: schema.providerKeys.id, set: key });
    },

    async updateProviderKey(id, patch) {
      const [row] = await db.update(schema.providerKeys)
        .set(patch)
        .where(eq(schema.providerKeys.id, id))
        .returning();
      return row ?? null;
    },
    withProviderKeyLock(id, fn) {
      const turn = lockQueue.then(() => lockedOnce(id, fn));
      lockQueue = turn.catch(() => {});
      return turn;
    },
    async replaceProviderKeySecret(id, expected, next, at) {
      const rows = await db.update(schema.providerKeys)
        .set({ encryptedSecret: next, updatedAt: at })
        .where(and(
          eq(schema.providerKeys.id, id),
          eq(schema.providerKeys.encryptedSecret, expected),
        ))
        .returning({ id: schema.providerKeys.id });
      return rows.length > 0;
    },
    async markPlanNeedsReauth(id, expected, at) {
      const rows = await db.update(schema.providerKeys)
        .set({ planStatus: "needs_reauth", updatedAt: at })
        .where(and(
          eq(schema.providerKeys.id, id),
          eq(schema.providerKeys.encryptedSecret, expected),
        ))
        .returning({ id: schema.providerKeys.id });
      return rows.length > 0;
    },
    async markPlanLimited(id, at) {
      const rows = await db.update(schema.providerKeys)
        .set({ planStatus: "limited", planLimitedAt: at, updatedAt: at })
        .where(and(
          eq(schema.providerKeys.id, id),
          or(
            isNull(schema.providerKeys.planStatus),
            ne(schema.providerKeys.planStatus, "needs_reauth"),
          ),
        ))
        .returning({ id: schema.providerKeys.id });
      return rows.length > 0;
    },
    async clearPlanLimited(id, at) {
      const rows = await db.update(schema.providerKeys)
        .set({ planStatus: "active", planLimitedAt: null, updatedAt: at })
        .where(and(
          eq(schema.providerKeys.id, id),
          eq(schema.providerKeys.planStatus, "limited"),
        ))
        .returning({ id: schema.providerKeys.id });
      return rows.length > 0;
    },

    async claimAgentHostId(candidate, at) {
      await db.insert(schema.chatgptAgentHost)
        .values({ id: AGENT_HOST_ID, extAgentHostId: candidate, createdAt: at })
        .onConflictDoNothing();
      const row = await db.query.chatgptAgentHost.findFirst({
        where: (h, { eq }) => eq(h.id, AGENT_HOST_ID),
      });
      if (row === undefined) throw new Error("the agent host id did not persist");
      return row.extAgentHostId;
    },
    async createSignIn(row) {
      await db.insert(schema.chatgptSignIns).values(row);
    },
    async getSignIn(id) {
      const row = await db.query.chatgptSignIns.findFirst({ where: (s, { eq }) => eq(s.id, id) });
      return row ?? null;
    },
    async getSignInByState(state) {
      const row = await db.query.chatgptSignIns.findFirst({
        where: (s, { eq }) => eq(s.state, state),
      });
      return row ?? null;
    },
    async claimSignIn(id, nowIso) {
      // One UPDATE, so two completions racing each other cannot both see `pending`.
      const [row] = await db.update(schema.chatgptSignIns)
        .set({ status: "exchanging", updatedAt: nowIso })
        .where(and(
          eq(schema.chatgptSignIns.id, id),
          eq(schema.chatgptSignIns.status, "pending"),
          gt(schema.chatgptSignIns.expiresAt, nowIso),
        ))
        .returning();
      return row ?? null;
    },
    async finishSignIn(id, outcome) {
      await db.update(schema.chatgptSignIns)
        .set({
          status: outcome.status,
          error: outcome.error,
          resultKeyId: outcome.resultKeyId,
          updatedAt: outcome.at,
        })
        .where(eq(schema.chatgptSignIns.id, id));
    },
    async pruneSignIns(before) {
      await db.delete(schema.chatgptSignIns).where(lt(schema.chatgptSignIns.expiresAt, before));
    },

    async listCustomProviders() {
      return await db.query.customProviders.findMany({
        orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
      });
    },
    async getCustomProvider(id) {
      const row = await db.query.customProviders.findFirst({
        where: (p, { eq }) => eq(p.id, id),
      });
      return row ?? null;
    },
    async createCustomProvider(row) {
      await db.insert(schema.customProviders).values(row);
    },
    async updateCustomProvider(id, patch) {
      const shapeTouched = patch.baseUrl !== undefined || patch.authHeader !== undefined ||
        patch.authScheme !== undefined || patch.extraHeaders !== undefined;
      if (!shapeTouched) {
        const [row] = await db.update(schema.customProviders)
          .set(patch)
          .where(eq(schema.customProviders.id, id))
          .returning();
        return row === undefined ? null : { provider: row, keysCleared: 0 };
      }
      // The request shape and the keys sealed for it move together or not at all: the row
      // locked, the old shape read under the lock, and the keys' secrets dropped only when it
      // changed. A secret written for the old shape holds this row FOR SHARE while it checks the
      // shape and writes (`writeProviderKeySealedFor`), so it lands before this, or is refused.
      return await db.transaction(async (tx) => {
        const [current] = await tx.select()
          .from(schema.customProviders)
          .where(eq(schema.customProviders.id, id))
          .for("update");
        if (current === undefined) return null;
        const [row] = await tx.update(schema.customProviders)
          .set(patch)
          .where(eq(schema.customProviders.id, id))
          .returning();
        if (row === undefined) return null;
        if (endpointShape(customProviderSpec(current)) === endpointShape(customProviderSpec(row))) {
          return { provider: row, keysCleared: 0 };
        }
        // Counted as `needsSecret` reads them: a live key that held a secret that opened.
        const held = await tx.select({ id: schema.providerKeys.id })
          .from(schema.providerKeys)
          .where(and(
            eq(schema.providerKeys.provider, id),
            isNull(schema.providerKeys.archivedAt),
            like(schema.providerKeys.encryptedSecret, `${SEALED_FORMAT}.%`),
          ));
        await tx.update(schema.providerKeys)
          .set({ encryptedSecret: NO_SECRET, updatedAt: patch.updatedAt })
          .where(and(
            eq(schema.providerKeys.provider, id),
            ne(schema.providerKeys.encryptedSecret, NO_SECRET),
          ));
        return { provider: row, keysCleared: held.length };
      });
    },
    async writeProviderKeySealedFor(sealedFor, write) {
      return await db.transaction(async (tx) => {
        const [endpoint] = await tx.select()
          .from(schema.customProviders)
          .where(eq(schema.customProviders.id, sealedFor.providerId))
          .for("share");
        if (
          endpoint === undefined ||
          endpointShape(customProviderSpec(endpoint)) !== sealedFor.shape
        ) return { moved: true as const };
        if ("create" in write) {
          await tx.insert(schema.providerKeys).values(write.create);
          return { moved: false as const, key: write.create };
        }
        const [row] = await tx.update(schema.providerKeys)
          .set(write.patch)
          .where(eq(schema.providerKeys.id, write.id))
          .returning();
        return { moved: false as const, key: row ?? null };
      });
    },
    async archiveCustomProvider(id, at) {
      // Idempotent: the first archiving is the one that counts, so a second call leaves the
      // original timestamp — the same shape the provider-key route hands this store.
      await db.update(schema.customProviders)
        .set({ archivedAt: at, updatedAt: at })
        .where(and(
          eq(schema.customProviders.id, id),
          isNull(schema.customProviders.archivedAt),
        ));
    },

    async createVirtualKey(key) {
      await db.insert(schema.virtualKeys).values(key);
    },
    async getVirtualKeyByTokenHash(tokenHash) {
      const row = await db.query.virtualKeys.findFirst({
        where: (k, { eq }) => eq(k.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async revokeVirtualKeysForRun(runId, at) {
      await db.update(schema.virtualKeys)
        .set({ revokedAt: at })
        .where(and(eq(schema.virtualKeys.runId, runId), isNull(schema.virtualKeys.revokedAt)));
    },
    async revokePlatformVirtualKeys(at) {
      // The prefix carries no LIKE metacharacter, so it needs no escaping.
      await db.update(schema.virtualKeys)
        .set({ revokedAt: at })
        .where(and(
          like(schema.virtualKeys.runId, `${PLATFORM_PRINCIPAL_PREFIX}%`),
          isNull(schema.virtualKeys.revokedAt),
        ));
    },

    async getPlatformPolicy() {
      const row = await db.query.platformModelPolicy.findFirst({
        where: (p, { eq }) => eq(p.id, PLATFORM_POLICY_ID),
      });
      if (row === undefined) return null;
      const { id: _id, ...policy } = row;
      return policy;
    },
    async savePlatformPolicy(policy) {
      const row = { id: PLATFORM_POLICY_ID, ...policy };
      await db.insert(schema.platformModelPolicy).values(row)
        .onConflictDoUpdate({ target: schema.platformModelPolicy.id, set: policy });
    },
    async clearPlatformPolicy() {
      await db.delete(schema.platformModelPolicy)
        .where(eq(schema.platformModelPolicy.id, PLATFORM_POLICY_ID));
    },

    async recordUsage(record) {
      await db.insert(schema.proxyUsage).values(record);
    },
    async listUsageForRun(runId) {
      const rows = await db.query.proxyUsage.findMany({
        where: (u, { eq }) => eq(u.runId, runId),
        orderBy: (u, { asc }) => [asc(u.seq)],
      });
      return rows.map(({ seq: _seq, ...record }) => record);
    },
    async aggregateUsage(query) {
      const thresholds = query.tierThresholds
        .filter((t) => Number.isSafeInteger(t) && t > 0)
        .toSorted((a, b) => b - a);
      const totalInput =
        sql`(coalesce(${usage.inputTokens}, 0) + coalesce(${usage.cacheReadTokens}, 0) + coalesce(${usage.cacheWriteTokens}, 0))`;
      // Thresholds are INLINED, never bound: the expression appears in both SELECT and GROUP BY,
      // and two placeholders would be two different expressions to Postgres. They are validated
      // integers above, so nothing but digits reaches the SQL.
      const tierFloor = thresholds.length === 0 ? sql`0` : sql`(case ${
        sql.join(
          thresholds.map((t) =>
            sql`when ${totalInput} > ${sql.raw(String(t))} then ${sql.raw(String(t))}`
          ),
          sql` `,
        )
      } else 0 end)`;
      const conditions: SQL[] = [];
      if (query.runId !== undefined) conditions.push(eq(usage.runId, query.runId));
      if (query.from !== undefined) conditions.push(gte(usage.at, query.from));
      if (query.to !== undefined) conditions.push(lt(usage.at, query.to));
      const where = conditions.length === 0 ? undefined : and(...conditions);

      const group = (on: Queryable, by: UsageDimension) => {
        const key = usageKey(by);
        return on
          .select({
            key: key ?? sql<string | null>`null`,
            provider: usage.provider,
            model: usage.model,
            tierFloor: sql<number>`${tierFloor}`.mapWith(Number),
            requests: sql<number>`count(*)::int`.mapWith(Number),
            failedRequests: sql<number>`(count(*) filter (where ${usage.status} >= 400))::int`
              .mapWith(Number),
            meteredRequests: sql<number>`count(${usage.inputTokens})::int`.mapWith(Number),
            inputTokens: sumOf(usage.inputTokens),
            outputTokens: sumOf(usage.outputTokens),
            cacheReadTokens: sumOf(usage.cacheReadTokens),
            cacheWriteTokens: sumOf(usage.cacheWriteTokens),
            cacheWrite1hTokens: sumOf(usage.cacheWrite1hTokens),
            reasoningTokens: sumOf(usage.reasoningTokens),
          })
          .from(usage)
          .where(where)
          .groupBy(
            ...(key === null ? [] : [key]),
            usage.provider,
            usage.model,
            tierFloor,
          );
      };

      if (query.by.length === 0) return [];
      // One dimension needs no snapshot of its own. Several MUST share one: REPEATABLE READ
      // fixes the snapshot at the first statement, so a row inserted while the report runs is
      // invisible to every one of them rather than to some. Sequential on purpose — one
      // transaction is one connection.
      if (query.by.length === 1) return [await group(db, query.by[0])];
      return await db.transaction(async (tx) => {
        const breakdowns = [];
        for (const by of query.by) breakdowns.push(await group(tx, by));
        return breakdowns;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    async close() {
      await lockQueue;
      await handle.close();
    },
  };
}
