// The historian's whole job, as pure orchestration: stamp, store, broadcast what was new.
//
// Invariants:
// - the store is the source of truth for novelty: only rows the store actually inserted are
//   published, so retried batches ack as duplicates and never re-broadcast to live listeners
// - subscribe-then-replay is the reader's dedup discipline (by seq), not the service's —
//   the service just exposes both halves
// - every read names one lane; a reader of the main lane sees exactly what it saw before lanes

import type { HistoryBus } from "../ports/bus.ts";
import type { HistoryStore } from "../ports/store.ts";
import type { HistoryEvent, IncomingHistoryEvent, LaneSummary } from "./types.ts";

export interface HistorianService {
  /** Idempotent batch ingest. Duplicates are acked, not errored. */
  ingest(
    runId: string,
    events: IncomingHistoryEvent[],
  ): Promise<{ accepted: number; duplicates: number }>;
  /** A page of one lane, ascending by seq — forwards from `after` or backwards from `before`. */
  listEvents(
    runId: string,
    lane: string,
    opts?: { after?: number; before?: number; limit?: number },
  ): Promise<HistoryEvent[]>;
  subscribe(runId: string, lane: string, listener: (event: HistoryEvent) => void): () => void;
  /** Called with a lane of this run each time its summary may have changed. */
  subscribeLanes(runId: string, listener: (lane: string) => void): () => void;
  /** The run's subagent lanes with their opening, latest continuation and latest close. */
  listLanes(runId: string): Promise<LaneSummary[]>;
}

export function makeHistorianService(
  deps: { store: HistoryStore; bus: HistoryBus },
): HistorianService {
  return {
    async ingest(runId, events) {
      const stamped = events.map((e) => ({ ...e, runId }));
      const stored = await deps.store.append(stamped);
      if (stored.length > 0) deps.bus.publish(stored);
      return { accepted: stored.length, duplicates: stamped.length - stored.length };
    },
    listEvents(runId, lane, opts) {
      return deps.store.listEvents(runId, lane, opts);
    },
    subscribe(runId, lane, listener) {
      return deps.bus.subscribe(runId, lane, listener);
    },
    subscribeLanes(runId, listener) {
      return deps.bus.subscribeLanes(runId, listener);
    },
    listLanes(runId) {
      return deps.store.listLanes(runId);
    },
  };
}
