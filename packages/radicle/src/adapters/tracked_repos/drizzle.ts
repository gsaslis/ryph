// `TrackedRepoStore` on the bridge's own tables, beside the cursors.
//
// `track` is an upsert that ORs `created_policy` with what the row already says: a second
// connect finds the policy the first one wrote and must not overwrite "ours" with "not ours",
// and a leftover row that says "not ours" is corrected the moment ryph does write one.

import { asc, eq, sql } from "drizzle-orm";
import type { TrackedRepo, TrackedRepoStore } from "../../ports/tracked_repos.ts";
import type { RadicleDbHandle } from "../cursor_store/db/db.ts";
import { radicleTrackedRepos } from "../cursor_store/db/schema.ts";

export function drizzleTrackedRepos(handle: RadicleDbHandle): TrackedRepoStore {
  const { db } = handle;
  const t = radicleTrackedRepos;
  const shape = (r: typeof t.$inferSelect): TrackedRepo => ({
    rid: r.rid,
    createdPolicy: r.createdPolicy,
    unseedPending: r.unseedPending,
    trackedAt: r.trackedAt,
  });
  return {
    async list() {
      const rows = await db.query.radicleTrackedRepos.findMany({
        where: eq(t.unseedPending, false),
        orderBy: asc(t.rid),
      });
      return rows.map(shape);
    },
    async get(rid) {
      const row = await db.query.radicleTrackedRepos.findFirst({ where: eq(t.rid, rid) });
      return row === undefined ? null : shape(row);
    },
    async track(rid, createdPolicy) {
      await db.insert(t)
        .values({ rid, createdPolicy, unseedPending: false, trackedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: t.rid,
          set: {
            createdPolicy: sql`${t.createdPolicy} OR excluded.created_policy`,
            unseedPending: false,
            trackedAt: sql`excluded.tracked_at`,
          },
        });
    },
    async markUnseedPending(rid) {
      await db.update(t).set({ unseedPending: true }).where(eq(t.rid, rid));
    },
    async pendingUnseeds() {
      const rows = await db.query.radicleTrackedRepos.findMany({
        where: eq(t.unseedPending, true),
        orderBy: asc(t.trackedAt),
      });
      return rows.map(shape);
    },
    async untrack(rid) {
      const rows = await db.delete(t).where(eq(t.rid, rid)).returning();
      return rows.length === 0 ? null : shape(rows[0]);
    },
  };
}
