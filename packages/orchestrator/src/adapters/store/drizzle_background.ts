// The drizzle `BackgroundStore` — the same database and conventions as drizzle_checks.ts: reads
// through `db.query.*`, and the table's columns mirror core/background.ts's `BackgroundCommand`
// field for field, so rows need no mapping.

import { and, count, eq, isNull, sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import { type RunState, TERMINAL_STATES } from "../../core/types.ts";
import type { BackgroundStore } from "../../ports/background_store.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

type Tx = Parameters<Parameters<OrchestratorDbHandle["db"]["transaction"]>[0]>[0];

export function drizzleBackgroundStore(handle: OrchestratorDbHandle): BackgroundStore {
  const { db } = handle;
  const t = schema.runBackgroundCommands;
  const byJob = (runId: string, jobId: string) => and(eq(t.runId, runId), eq(t.jobId, jobId));

  /**
   * Takes the run's row lock and answers whether the run still takes writes. The lock is what a
   * conclusion's write of the same row waits on, so a write that saw the run live lands before
   * the conclusion does, never after it. An unknown run reads as concluded: nothing may land.
   */
  const lockLive = async (tx: Tx, runId: string): Promise<boolean> => {
    const rows = rowsOf<{ state: RunState }>(
      await tx.execute(sql`select "state" from "runs" where "id" = ${runId} for update`),
    );
    return rows.length > 0 && !TERMINAL_STATES.has(rows[0].state);
  };

  const exists = async (tx: Tx, runId: string, jobId: string): Promise<boolean> =>
    (await tx.select({ jobId: t.jobId }).from(t).where(byJob(runId, jobId))).length > 0;

  return {
    async start(record, max) {
      return await db.transaction(async (tx) => {
        if (!(await lockLive(tx, record.runId))) return "concluded";
        if (await exists(tx, record.runId, record.jobId)) return "exists";
        const [held] = await tx.select({ n: count() }).from(t).where(eq(t.runId, record.runId));
        if (held.n >= max) return "full";
        await tx.insert(t).values(record);
        return "created";
      });
    },
    async end(runId, jobId, record) {
      return await db.transaction(async (tx) => {
        if (!(await lockLive(tx, runId))) return "concluded";
        // The WHERE is the once: of two exits for one job, the first sets `ended_at`.
        const ended = await tx.update(t).set(record)
          .where(and(byJob(runId, jobId), isNull(t.endedAt)))
          .returning({ jobId: t.jobId });
        if (ended.length > 0) return "ended";
        return await exists(tx, runId, jobId) ? "already" : "missing";
      });
    },
    async claimLog(runId, jobId, { claim, at, staleBefore }) {
      return await db.transaction(async (tx) => {
        if (!(await lockLive(tx, runId))) return "concluded";
        const [row] = await tx.select({
          hasLog: t.hasLog,
          claimedAt: t.logClaimedAt,
          endedAt: t.endedAt,
        }).from(t).where(byJob(runId, jobId));
        if (row === undefined) return "missing";
        if (row.hasLog) return "stored";
        if (row.endedAt === null) return "running";
        if (row.claimedAt !== null && row.claimedAt >= staleBefore) return "busy";
        // Under the run's row lock, so two claims for one job serialize: the second reads this.
        await tx.update(t).set({ logClaim: claim, logClaimedAt: at }).where(byJob(runId, jobId));
        return "claimed";
      });
    },
    async releaseLog(runId, jobId, claim) {
      await db.update(t).set({ logClaim: null, logClaimedAt: null })
        .where(and(byJob(runId, jobId), eq(t.logClaim, claim)));
    },
    async markLog(runId, jobId, claim, { key, bytes }) {
      const marked = await db.update(t)
        .set({ hasLog: true, logKey: key, logBytes: bytes, logClaim: null, logClaimedAt: null })
        .where(and(byJob(runId, jobId), eq(t.logClaim, claim)))
        .returning({ jobId: t.jobId });
      return marked.length > 0 ? "ok" : "lost";
    },
    async get(runId, jobId) {
      const row = await db.query.runBackgroundCommands.findFirst({
        where: (c, { and, eq }) => and(eq(c.runId, runId), eq(c.jobId, jobId)),
      });
      return row ?? null;
    },
    async list(runId) {
      return await db.query.runBackgroundCommands.findMany({
        where: (c, { eq }) => eq(c.runId, runId),
      });
    },
  };
}
