// A test fixture, not a deployment option. It used to be both: `RYPH_DB=memory` ran this as
// a second implementation of every store port, free to drift from the drizzle one without any
// test noticing. `pglite:memory://` replaced that — it is the real driver over real PostgreSQL,
// so throwaway databases now exercise the production path.
//
// What is left here is a fast double for tests that care about behaviour ABOVE the store and
// want no database at all. Anything asserting on SQL belongs on makeTestDb() instead.

import { summarize } from "../src/adapters/store/drizzle.ts";
import {
  type HistoryEvent,
  LANE,
  LANE_END,
  LANE_ENDS_SUMMED,
  LANE_RESUME,
  LANE_START,
  MAIN_LANE,
  stretchMs,
} from "../src/core/types.ts";
import type { HistoryStore } from "../src/ports/store.ts";

export function memoryHistoryStore(): HistoryStore {
  // run -> lane -> seq: the primary key, as nested maps.
  const runs = new Map<string, Map<string, Map<number, HistoryEvent>>>();
  const concluded = new Map<string, string>();

  return {
    append(events) {
      const stored: HistoryEvent[] = [];
      for (const event of events) {
        let run = runs.get(event.runId);
        if (!run) {
          run = new Map();
          runs.set(event.runId, run);
        }
        let lane = run.get(event.lane);
        if (!lane) {
          lane = new Map();
          run.set(event.lane, lane);
        }
        if (lane.has(event.seq)) continue;
        const copy = structuredClone(event);
        lane.set(event.seq, copy);
        stored.push(structuredClone(copy));
      }
      return Promise.resolve(stored);
    },
    listEvents(runId, lane, opts) {
      const limit = opts?.limit ?? Infinity;
      const all = [...(runs.get(runId)?.get(lane)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
      // Backwards: the NEWEST `limit` below the cursor, handed back ascending — the drizzle
      // store's DESC read, expressed as a slice.
      if (opts?.before !== undefined) {
        const below = all.filter((e) => e.seq < opts.before!);
        const events = limit === Infinity ? below : below.slice(Math.max(0, below.length - limit));
        return Promise.resolve(structuredClone(events));
      }
      const after = opts?.after ?? -1;
      const events = all.filter((e) => e.seq > after).slice(0, limit);
      return Promise.resolve(structuredClone(events));
    },
    listLanes(runId) {
      // The drizzle store's DISTINCT ON, by hand: the earliest start, the latest resume and end.
      const picked: HistoryEvent[] = [];
      const ranMs = new Map<string, number>();
      for (const [lane, events] of runs.get(runId) ?? []) {
        // The drizzle store probes the lanes there can be, and only those.
        if (lane === MAIN_LANE || !LANE.test(lane)) continue;
        const ascending = [...events.values()].sort((a, b) => a.seq - b.seq);
        const of = (kind: string) =>
          ascending.filter((e) => e.voice === "transcript" && e.kind === kind);
        const start = of(LANE_START)[0];
        const resume = of(LANE_RESUME).at(-1);
        const end = of(LANE_END).at(-1);
        for (const e of [start, resume, end]) if (e !== undefined) picked.push(e);
        // The aggregate, by hand: the latest LANE_ENDS_SUMMED ends, each clamped by stretchMs.
        for (const e of of(LANE_END).slice(-LANE_ENDS_SUMMED)) {
          ranMs.set(lane, (ranMs.get(lane) ?? 0) + stretchMs(e.payload));
        }
      }
      return Promise.resolve(structuredClone(summarize(picked, ranMs)));
    },
    markConcluded(runId, at) {
      // First writer wins, matching the drizzle store's ON CONFLICT DO NOTHING.
      if (!concluded.has(runId)) concluded.set(runId, at);
      return Promise.resolve();
    },
    isConcluded(runId) {
      return Promise.resolve(concluded.has(runId));
    },
    async close() {},
  };
}
