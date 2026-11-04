// HookStore over drizzle — works unchanged on PGlite and postgres-js, like every store
// adapter in this repo. Rows and Hooks are the same shape, so nothing here maps.

import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import type { HookStore } from "../../ports/hook_store.ts";
import type { WebhooksDb } from "./db/db.ts";
import * as schema from "./db/schema.ts";

// The two partial indexes' predicates (db/schema.ts), spelled as the same literal text rather than
// bound parameters: a planner can only use a partial index for a query whose WHERE PROVES its
// predicate, and `state in ($1, $2)` proves nothing in a generic plan.
const isLive = sql`${schema.webhooks.state} in ('pending', 'delivering')`;
const isTerminal = sql`${schema.webhooks.state} in ('delivered', 'exhausted')`;

/** One queue's head: its lowest-seq live hook — the first entry of `webhooks_live_by_queue`.
 * Exported for the test that holds the plan to that index. */
export function headHookQuery(db: WebhooksDb, registrationId: string, scope: string | null) {
  const w = schema.webhooks;
  return db.select().from(w)
    .where(and(
      eq(w.registrationId, registrationId),
      // `= NULL` matches nothing in SQL, so the unscoped queue is asked for by name.
      scope === null ? isNull(w.scope) : eq(w.scope, scope),
      isLive,
    ))
    .orderBy(asc(w.seq))
    .limit(1);
}

/** The (registration, scope) of every queue whose head is DUE (`HookStore.getDueQueues`), in
 * (registration, scope) order. Exported for the test that holds its cost to the queues. */
export function dueQueuesQuery(registrationIds: readonly string[], dueAt: string) {
  const w = schema.webhooks;
  const regs = sql.join(registrationIds.map((id) => sql`(${id}::text)`), sql`, `);
  return sql`
  with recursive regs(r) as (values ${regs}),
  scopes(r, s) as (
    select regs.r, (select min(${w.scope}) from ${w}
      where ${w.registrationId} = regs.r and ${isLive}) from regs
    union all
    select scopes.r, (select min(${w.scope}) from ${w}
      where ${w.registrationId} = scopes.r and ${w.scope} > scopes.s and ${isLive})
    from scopes where scopes.s is not null
  ),
  heads as (
    select scopes.r, scopes.s, h.* from scopes cross join lateral (
      select ${w.id} as id, ${w.state} as state, ${w.nextAttemptAt} as next_at,
        ${w.leaseExpiresAt} as lease_at from ${w}
      where ${w.registrationId} = scopes.r and ${w.scope} = scopes.s and ${isLive}
      order by ${w.seq} limit 1
    ) h where scopes.s is not null
    union all
    select regs.r, null, h.* from regs cross join lateral (
      select ${w.id} as id, ${w.state} as state, ${w.nextAttemptAt} as next_at,
        ${w.leaseExpiresAt} as lease_at from ${w}
      where ${w.registrationId} = regs.r and ${w.scope} is null and ${isLive}
      order by ${w.seq} limit 1
    ) h
  )
  select r as registration_id, s as scope from heads
  where (state = 'pending' and (next_at is null or next_at <= ${dueAt}))
    or (state = 'delivering' and lease_at is not null and lease_at <= ${dueAt})
  order by r, s nulls last`;
}

export function drizzleHookStore(db: WebhooksDb): HookStore {
  return {
    async recordHook(hook) {
      // `seq` is the database's to assign; `returning` hands the completed row back.
      const [row] = await db.insert(schema.webhooks).values(hook).returning();
      return row;
    },
    async getHook(id) {
      const row = await db.query.webhooks.findFirst({ where: (w, { eq }) => eq(w.id, id) });
      return row ?? null;
    },
    async getHeadHook(registrationId, scope = null) {
      const [row] = await headHookQuery(db, registrationId, scope);
      return row ?? null;
    },
    async getDueQueues(registrationIds, dueAt) {
      if (registrationIds.length === 0) return [];
      // A loose index scan, not a DISTINCT ON: that one walked every live row of every queue to
      // keep the first of each, so a sweep's read cost the whole backlog — and during a consumer
      // outage, which is exactly when the backlog is big, it ran once per turn. Here each queue
      // costs a few probes of `webhooks_live_by_queue`: the next scope after the last one found
      // (`min(scope) … scope > s`, recursively), then that scope's lowest live seq — plus the one
      // unscoped queue per registration, which `scope > s` can never reach (NULLs compare to
      // nothing). Every subquery spells the partial index's predicate as its literal text, so
      // the planner can prove it (see `isLive`).
      //
      // And only queues whose head is DUE: one waiting out a retry clock, or leased by a live
      // deliverer, holds its queue anyway (FIFO), so handing it to the sweep only bought a turn
      // that ended before it began. The same rule `planHookSweep` applies, on the ISO text
      // timestamps every row carries (they compare as strings). Keys only: the head's row is
      // read by the turn that takes it.
      return rowsOf<{ registration_id: string; scope: string | null }>(
        await db.execute(dueQueuesQuery(registrationIds, dueAt)),
      ).map((q) => ({ registrationId: q.registration_id, scope: q.scope }));
    },
    async hasDeliveredKey(registrationId, scope, dedupeKey) {
      const w = schema.webhooks;
      const [row] = await db.select({ id: w.id }).from(w)
        .where(and(
          eq(w.registrationId, registrationId),
          scope === null ? isNull(w.scope) : eq(w.scope, scope),
          eq(w.dedupeKey, dedupeKey),
          eq(w.state, "delivered"),
        ))
        .limit(1);
      return row !== undefined;
    },
    async saveHook(hook) {
      await db.insert(schema.webhooks).values(hook)
        .onConflictDoUpdate({ target: schema.webhooks.id, set: hook });
    },
    async saveHookIfState(hook, expected, expectedAttempts) {
      // One statement, so the read and the write cannot be separated by a concurrent sweep:
      // the WHERE is the claim. `returning` reports whether this caller won it.
      const claimed = await db.update(schema.webhooks).set(hook)
        .where(and(
          eq(schema.webhooks.id, hook.id),
          inArray(schema.webhooks.state, [...expected]),
          ...(expectedAttempts === undefined
            ? []
            : [eq(schema.webhooks.attempts, expectedAttempts)]),
        ))
        .returning({ id: schema.webhooks.id });
      return claimed.length === 1;
    },
    async deleteTerminalHooks(registrationId, before, limit) {
      // Postgres' DELETE takes no LIMIT: the batch is picked by id, on `webhooks_terminal_by_age`.
      const w = schema.webhooks;
      const batch = db.select({ id: w.id }).from(w)
        .where(and(
          eq(w.registrationId, registrationId),
          isTerminal,
          lt(w.updatedAt, before),
        ))
        .orderBy(asc(w.updatedAt))
        .limit(limit);
      const gone = await db.delete(w).where(inArray(w.id, batch)).returning({ id: w.id });
      return gone.length;
    },
    async deleteHooksForRegistration(registrationId) {
      await db.delete(schema.webhooks).where(eq(schema.webhooks.registrationId, registrationId));
    },
  };
}
