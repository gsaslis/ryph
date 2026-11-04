// One row per (repository, COB reference): how far the event consumer has read it.
//
// Small, hot and entirely derived — losing this table costs one replay of every COB reference,
// which the stable delivery ids make harmless. It is persisted rather than kept in memory for
// one reason: a restart must not re-deliver every comment in every seeded repository.
//
// The key is the PAIR, because one COB has one reference per author and each advances on its
// own. It is a UNIQUE INDEX and not a composite `primaryKey()`, which is not a style choice:
// drizzle-kit 0.31 cannot introspect a table with a composite primary key — `pushSchema`
// against one exits the whole process with status 1 and no error, which silently kills the
// migration-drift test (and would kill `db:push` on an existing database the same way).
// The unique index gives the same guarantee, and `onConflictDoUpdate` targets it identically.
//
// The index also serves "every cursor for this repository": (rid, ref) is a prefix scan on rid.

import { boolean, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const radicleCursors = pgTable("radicle_cursors", {
  /** `rad:z…`, canonical form. */
  rid: text("rid").notNull(),
  /** `refs/namespaces/<nid>/refs/cobs/<type>/<id>`, or `refs/heads/<default>` for the
   * canonical default branch's last delivered head. */
  ref: text("ref").notNull(),
  /** The object id already turned into events. */
  oid: text("oid").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  uniqueIndex("radicle_cursors_by_rid_ref").on(t.rid, t.ref),
]);

// One row per repository a USER-MODE bridge has connected (`ports/tracked_repos.ts`). Empty in a
// deployment, whose node is its own and whose storage is the set.
//
// Unlike the cursors this is not derived from anything: losing it means the bridge watches
// nothing until each repository is connected again, and forgets which seeding policies on
// somebody's node it wrote itself.
export const radicleTrackedRepos = pgTable("radicle_tracked_repos", {
  /** `rad:z…`, canonical form. */
  rid: text("rid").primaryKey(),
  /** Whether ryph wrote the node's seeding policy for it — and so may remove it again. */
  createdPolicy: boolean("created_policy").notNull(),
  /** Disconnected while the node could not remove the policy ryph wrote: out of scope, and the
   * removal retried until it lands. */
  unseedPending: boolean("unseed_pending").notNull().default(false),
  trackedAt: text("tracked_at").notNull(),
});
