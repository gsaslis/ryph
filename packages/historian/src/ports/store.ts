// Persistence, as the core sees it — an append-only row-holder, same doctrine as the
// model-proxy's KeyStore: every decision happens elsewhere and lands here fully formed.

import type { HistoryEvent, LaneSummary } from "../core/types.ts";

export interface HistoryStore {
  /**
   * Idempotent append: events whose (runId, lane, seq) already exist are silently dropped. The
   * same seq in another lane of the same run is a different event.
   * Returns ONLY the newly stored events — the caller broadcasts exactly these, so a
   * retried batch can never replay onto live listeners.
   */
  append(events: HistoryEvent[]): Promise<HistoryEvent[]>;
  /**
   * A page of one lane of one run, ALWAYS ascending by seq, whichever way it was asked for:
   * - `after` (default -1): the OLDEST `limit` events with seq strictly greater — page forwards;
   * - `before`: the NEWEST `limit` events with seq strictly less — page backwards, which is how a
   *   reader opens a run at its tail and walks up. Read descending on the (runId, lane, seq)
   *   primary key and handed back ascending, so every caller sees one shape.
   *
   * `before` wins if both are given; the route refuses that combination before it gets here.
   */
  listEvents(
    runId: string,
    lane: string,
    opts?: { after?: number; before?: number; limit?: number },
  ): Promise<HistoryEvent[]>;
  /**
   * The run's subagent lanes, ordered by the n of `sa-<n>`: each lane that has a transcript
   * `subagent.start`, with that start, its latest transcript `subagent.resume` and its latest
   * transcript `subagent.end`, each clipped (`clipLaneEvent`), and `ranMs` over its latest
   * LANE_ENDS_SUMMED ends. The main lane is never listed, and neither is a lane past
   * MAX_SUBAGENT_LANES. Bounded whatever the lanes hold: what is read is a fixed number of rows per
   * lane, never a lane's whole record.
   */
  listLanes(runId: string): Promise<LaneSummary[]>;
  /**
   * Records that the control plane says this run is over. Idempotent — the conclude ping is
   * fire-and-forget and may arrive more than once, and the first `at` is the one that counts.
   */
  markConcluded(runId: string, at: string): Promise<void>;
  /** Whether `markConcluded` has ever been called for this run, by any replica, ever. */
  isConcluded(runId: string): Promise<boolean>;
  close(): Promise<void>;
}
