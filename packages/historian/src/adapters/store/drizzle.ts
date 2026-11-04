// The drizzle `HistoryStore` on Postgres — reads via the relational `db.query.*` API, writes
// via the builder, same conventions as the other packages' stores.
//
// Idempotency lands here as one statement: INSERT ... ON CONFLICT DO NOTHING RETURNING, which
// returns exactly the rows actually inserted and nothing for the ones that conflicted —
// precisely the "what was new" answer the port demands. Verified on Postgres for the shape that
// matters: a runner replaying an overlapping batch gets back only the genuinely new events.

import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import { rowsOf } from "@ryph/db";
import {
  clipLaneEvent,
  compareLanes,
  type HistoryEvent,
  type HistoryVoice,
  LANE_END,
  LANE_ENDS_SUMMED,
  LANE_RESUME,
  LANE_START,
  type LaneSummary,
  MAX_STRETCH_MS,
  MAX_SUBAGENT_LANES,
} from "../../core/types.ts";
import type { HistoryStore } from "../../ports/store.ts";
import type { HistorianDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

// Postgres' bind-parameter ceiling is 65535, so at 9 columns per row a single statement holds
// about 7000 events. Chunking at 1000 keeps statement size and peak memory bounded well under
// that rather than working around a driver limit — SQLite's ~999-parameter ceiling capped this
// near 124, and libsql's native teardown crash under `deno test` (which is why this was 100 and
// why tests had to stay below it) is gone with the driver. Still overridable so tests can
// exercise chunk boundaries without building thousand-event batches.
const INSERT_CHUNK = 1_000;

/** Postgres cannot hold U+0000 in text or jsonb, and one such event would fail its whole batch
 * on every retry, so NULs become U+FFFD — in keys too — before anything is written. */
function storable(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("\u0000", "\uFFFD");
  if (Array.isArray(value)) return value.map(storable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storable(v)]));
  }
  return value;
}

/** One lifecycle row as the listing's raw read hands it back: the payload as JSON text, so that
 * PGlite and postgres-js, which do not parse a raw read's jsonb alike, answer the same. */
interface PickedRow {
  lane: string;
  seq: number | string;
  at: string;
  voice: HistoryVoice;
  kind: string;
  level: "debug" | "warn" | null;
  text: string | null;
  payload: string | null;
}

/**
 * Folds one lane listing's rows — at most one per lane and kind, already the right ones — and each
 * lane's summed end durations into the port's answer: lanes with a start, in lane order, each
 * event clipped as a summary carries it (`clipLaneEvent`). Shared
 * with the test double so the two cannot disagree about what "listed" means.
 */
export function summarize(rows: HistoryEvent[], ranMs: Map<string, number>): LaneSummary[] {
  const lanes = new Map<string, Partial<Record<string, HistoryEvent>>>();
  for (const row of rows) {
    let kinds = lanes.get(row.lane);
    if (kinds === undefined) {
      kinds = {};
      lanes.set(row.lane, kinds);
    }
    kinds[row.kind] = row;
  }
  const out: LaneSummary[] = [];
  for (const [lane, kinds] of lanes) {
    const start = kinds[LANE_START];
    // A lane that has written but not (yet, or ever) opened is not one the listing knows.
    if (start === undefined) continue;
    const resume = kinds[LANE_RESUME];
    const end = kinds[LANE_END];
    out.push({
      lane,
      start: clipLaneEvent(start),
      resume: resume === undefined ? null : clipLaneEvent(resume),
      end: end === undefined ? null : clipLaneEvent(end),
      ranMs: ranMs.get(lane) ?? 0,
    });
  }
  return out.sort((a, b) => compareLanes(a.lane, b.lane));
}

export function drizzleHistoryStore(
  handle: HistorianDbHandle,
  opts?: { insertChunk?: number },
): HistoryStore {
  const { db } = handle;
  const insertChunk = opts?.insertChunk ?? INSERT_CHUNK;

  return {
    async append(events) {
      const stored: HistoryEvent[] = [];
      for (let i = 0; i < events.length; i += insertChunk) {
        const chunk = events.slice(i, i + insertChunk).map((e) => ({
          ...e,
          kind: storable(e.kind) as string,
          text: storable(e.text) as string | null,
          payload: storable(e.payload),
        }));
        const rows = await db.insert(schema.historyEvents)
          .values(chunk)
          .onConflictDoNothing()
          .returning();
        stored.push(...(rows as HistoryEvent[]));
      }
      // A chunk inserts in given order, but the port promises nothing about return order —
      // callers publish per event; readers sort by seq.
      return stored;
    },
    async listEvents(runId, lane, opts) {
      // Paging backwards is the same index read from the other end: DESC on (run_id, lane, seq)
      // with both leading columns pinned is still an index scan on the primary key with no sort,
      // and `limit` then takes the NEWEST n below the cursor rather than the oldest. Reversing
      // here is what keeps the port's promise that every page comes back ascending, whichever
      // direction it was asked for.
      const inLane = and(
        eq(schema.historyEvents.runId, runId),
        eq(schema.historyEvents.lane, lane),
      );
      if (opts?.before !== undefined) {
        const rows = await db.query.historyEvents.findMany({
          where: and(inLane, lt(schema.historyEvents.seq, opts.before)),
          orderBy: desc(schema.historyEvents.seq),
          limit: opts.limit,
        });
        return (rows as HistoryEvent[]).reverse();
      }
      const after = opts?.after ?? -1;
      // `limit: undefined` is simply no limit, so the absent case needs no branch of its own.
      const rows = await db.query.historyEvents.findMany({
        where: and(inLane, gt(schema.historyEvents.seq, after)),
        orderBy: asc(schema.historyEvents.seq),
        limit: opts?.limit,
      });
      return rows as HistoryEvent[];
    },
    async listLanes(runId) {
      // Bounded by construction, whatever a lane holds: a run's lanes are sa-1 to
      // MAX_SUBAGENT_LANES and no other, so the listing probes exactly those, and each probe is a
      // LIMITed read from one end of the lifecycle index (db/schema.ts) — the first start, the
      // latest resume, the latest end, and for `ranMs` the latest LANE_ENDS_SUMMED ends. The run
      // token is the agent's to read, so a lane can hold anything; none of it is read here but
      // those rows. The kinds and the voice are literals, never parameters: the index is partial,
      // and only a literal lets Postgres prove a cached generic plan may use it.
      const t = schema.historyEvents;
      const lit = (value: string) => sql.raw(`'${value}'`);
      const num = (value: number) => sql.raw(String(value));
      const lanes = sql`generate_series(1, ${num(MAX_SUBAGENT_LANES)}) as s(n)`;
      const transcript = lit("transcript");
      // A row `h` of lane sa-<s.n> of this run, in the transcript.
      const inLane = sql`h.run_id = ${runId} and h.lane = 'sa-' || s.n and h.voice = ${transcript}`;
      const pick = (kind: string, order: "asc" | "desc") =>
        sql`(select h.lane, h.seq, h.at, h.voice, h.kind, h.level, h.text, h.payload::text as payload
          from ${t} h where ${inLane} and h.kind = ${lit(kind)}
          order by h.seq ${sql.raw(order)} limit 1)`;
      const picked = rowsOf<PickedRow>(
        await db.execute(sql`select e.* from ${lanes}
          cross join lateral (
            ${pick(LANE_START, "asc")} union all ${pick(LANE_RESUME, "desc")}
            union all ${pick(LANE_END, "desc")}
          ) e`),
      );
      // Each end's `durationMs`, clamped as `stretchMs` has it: a JSON number from 0 to
      // MAX_STRETCH_MS counts, anything else counts nothing. CASE, not AND, so the cast is only
      // ever asked of a number.
      const d = sql.raw("e.d");
      const ran = rowsOf<{ lane: string; ran_ms: number | string }>(
        await db.execute(sql`select 'sa-' || s.n as lane, coalesce(sum(case
            when ${d} is null or jsonb_typeof(${d}) <> 'number' then 0
            when ${d}::numeric between 0 and ${num(MAX_STRETCH_MS)} then ${d}::numeric::float8
            else 0 end), 0)::float8 as ran_ms
          from ${lanes}
          cross join lateral (
            select h.payload -> 'durationMs' as d from ${t} h
            where ${inLane} and h.kind = ${lit(LANE_END)}
            order by h.seq desc limit ${num(LANE_ENDS_SUMMED)}
          ) e
          group by s.n`),
      );
      const rows: HistoryEvent[] = picked.map((r) => ({
        runId,
        lane: r.lane,
        seq: Number(r.seq),
        at: r.at,
        voice: r.voice,
        kind: r.kind,
        level: r.level,
        text: r.text,
        payload: r.payload === null ? null : JSON.parse(r.payload),
      }));
      return summarize(rows, new Map(ran.map((r) => [r.lane, Number(r.ran_ms)])));
    },
    async markConcluded(runId, at) {
      // The ping is fire-and-forget and repeats; the first arrival owns the timestamp.
      await db.insert(schema.historyConcludedRuns)
        .values({ runId, at })
        .onConflictDoNothing();
    },
    async isConcluded(runId) {
      const row = await db.query.historyConcludedRuns.findFirst({
        where: eq(schema.historyConcludedRuns.runId, runId),
      });
      return row !== undefined;
    },
    close: handle.close,
  };
}
