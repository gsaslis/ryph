// The drizzle schema for the historian's one table. Same conventions as the orchestrator's
// schema: drizzle-kit applies it (push locally/tests, migrations at deploy time), ISO-8601
// text timestamps, columns mirror the core type field-for-field so rows need no mapping.
//
// Where these rows live is DEPLOYMENT-DEPENDENT, and deliberately so:
// - Mode B (networked): its own database, `ryph_history`. The append firehose then neither
//   contends with nor bloats run-state, and a standalone historian takes its database with it.
// - Mode A (single process): the same PGlite instance as every other module's tables. A second
//   instance would cost a few hundred megabytes of resident memory for an engine that is
//   single-connection anyway, and under one Postgres these are separate MVCC connections, so
//   the contention argument that made the split matter under SQLite's single writer lock does
//   not apply. A local relaxation of the rule, not an erosion of it.
//
// Either way there is no FK to `runs` — in Mode B that table is in another database entirely,
// and the schema must not differ between the two modes.

import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { HistoryVoice } from "../../../core/types.ts";

export const historyEvents = pgTable("history_events", {
  runId: text("run_id").notNull(),
  // `''` is the run's own transcript, `sa-<n>` a subagent's (core/types.ts). Every row written
  // before lanes existed is the run's own, which is what the default says.
  lane: text("lane").notNull().default(""),
  // Runner-assigned, one counter per lane; (run_id, lane, seq) is both the total order within a
  // lane and the idempotency key.
  seq: integer("seq").notNull(),
  at: text("at").notNull(),
  voice: text("voice").$type<HistoryVoice>().notNull(),
  kind: text("kind").notNull(),
  level: text("level").$type<"debug" | "warn">(),
  text: text("text"),
  payload: jsonb("payload"),
}, (t) => [
  // The primary key IS the read index: every query is "this run's lane, ascending seq".
  primaryKey({ columns: [t.runId, t.lane, t.seq] }),
  // The lane listing's: a lane's transcript starts, resumes and ends, by kind, in seq order, so
  // each one the listing wants (the first start, the latest resume, the latest ends) is a probe
  // from one end of a short range, however many other rows the lane holds. The predicate is in the
  // listing's own literals (drizzle.ts), which is what lets Postgres prove a read uses it.
  index("history_events_lane_lifecycle")
    .on(t.runId, t.lane, t.kind, t.seq)
    .where(
      sql`${t.voice} = 'transcript' and ${t.kind} in ('subagent.start', 'subagent.resume', 'subagent.end')`,
    ),
]);

/**
 * Runs the control plane has told us are over — the durable half of "is this run finished?".
 *
 * It exists because the answer used to be a `Set` in one process's memory, which made it wrong
 * in two ways at once: a replica that did not receive the conclude ping never learned, and a
 * restart forgot everything it had. A tail on such a run idles forever instead of closing, and
 * the run's cached token stays valid past the run.
 *
 * Deliberately NOT a lookup against the control plane's `runs` table. In Mode B that table is in
 * another database owned by another service, and making transcript reads depend on the control
 * plane's availability would mean a control-plane blip takes the read path down with it. This is
 * a signal we were sent and chose to keep, which is the whole reason the conclude ping exists.
 */
export const historyConcludedRuns = pgTable("history_concluded_runs", {
  runId: text("run_id").primaryKey(),
  at: text("at").notNull(),
});
