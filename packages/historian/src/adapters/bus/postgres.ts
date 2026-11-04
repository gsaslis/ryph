// The cross-replica `HistoryBus`, on Postgres LISTEN/NOTIFY.
//
// The in-process bus (memory.ts) is a listener map, which is exactly right for one process and
// silently wrong for several: an SSE tail on replica A never sees an event ingested on replica B,
// so a viewer watching a run gets a transcript that stops for no visible reason and resumes if
// they reload onto a different replica.
//
// THE NOTIFICATION IS A POINTER, NEVER THE NEWS. Postgres caps a NOTIFY payload at 8000 bytes and
// drops notifications outright if a listener falls behind, so a transcript chunk cannot ride it —
// and should not, because then a dropped notification would be lost data rather than a late read.
// What travels is `<runId>:<lane>:<maxSeq>`, one per lane a batch touched (each lane has its own
// seq counter, so a pointer means nothing without its lane); what a receiver does with it is read
// that lane from the store. Run ids and lanes are short, so a pointer is nowhere near the cap.
//
// A lane's summary changing (a subagent's start, resume or end) also travels apart, on
// HISTORY_LANES_CHANNEL as `<runId>:<lane>`: the lane listing's live stream wants that signal and
// none of the lane's transcript, so it is never resolved through a catch-up read.
//
// Local delivery does NOT go through the database. A publish fans out to this process's own
// listeners immediately and advances the run's cursor, so the self-notification that follows
// finds nothing new and does nothing. The tail of a run being ingested here stays as fast as it
// was before the split, and only a peer's events pay for a round trip.
//
// What this does NOT promise: exactly-once. A notification can be dropped, and the fetch after
// one can lose a race with a commit. Both are survivable by construction — the reader dedups by
// seq, re-reads from the store when the run concludes, and the paginated GET is the complete
// record either way. This is a liveness mechanism sitting on top of a durable one.

import { changesLaneSummary, type HistoryEvent, LANE, MAIN_LANE } from "../../core/types.ts";
import type { HistoryBus } from "../../ports/bus.ts";
import type { HistoryStore } from "../../ports/store.ts";
import { joinSet, laneKey, signalLane } from "./memory.ts";

/** The channel every replica of the historian listens on for new transcript events. */
export const HISTORY_CHANNEL = "ryph_history_events";

/**
 * The channel a conclusion travels on, payload = the run id. It lives here beside the events
 * channel rather than in main.ts so the two names cannot drift apart; the conclude signal is not
 * this bus's business otherwise, and the composition root wires it directly.
 */
export const HISTORY_CONCLUDE_CHANNEL = "ryph_history_concluded";

/**
 * The channel a lane-summary change travels on, payload `<runId>:<lane>`: a batch that stored a
 * subagent's start, resume or end. Apart from the events channel because its listeners want the
 * signal and none of the lane's transcript, so a peer never reads a lane to learn this.
 */
export const HISTORY_LANES_CHANNEL = "ryph_history_lanes";

/** How many events one catch-up read pulls at a time; it loops until the pointer is reached. */
const CATCH_UP_PAGE = 500;

export interface PostgresHistoryBusDeps {
  /** The signal pair from the historian's own `DbHandle` — see @ryph/db. */
  notify(channel: string, payload: string): Promise<void>;
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  /** Where a notification's pointer is resolved into actual events. */
  store: Pick<HistoryStore, "listEvents">;
  diag: { debug(event: string, fields?: Record<string, unknown>): void };
}

export interface PostgresHistoryBus extends HistoryBus {
  /** Drops the subscription. Idempotent. */
  close(): Promise<void>;
}

/** `<runId>:<lane>:<seq>` — read from the right: neither a seq nor a lane holds a colon, so the
 * last two colons are the only ones to find, whatever the run id holds. The main lane is empty:
 * `<runId>::<seq>`. */
export function encodePointer(runId: string, lane: string, seq: number): string {
  return `${runId}:${lane}:${seq}`;
}

export function decodePointer(
  payload: string,
): { runId: string; lane: string; seq: number } | null {
  const seqCut = payload.lastIndexOf(":");
  if (seqCut <= 0) return null;
  const seq = Number(payload.slice(seqCut + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  const laneCut = payload.lastIndexOf(":", seqCut - 1);
  if (laneCut <= 0) return null;
  const lane = payload.slice(laneCut + 1, seqCut);
  if (!LANE.test(lane)) return null;
  return { runId: payload.slice(0, laneCut), lane, seq };
}

/** `<runId>:<lane>` for a subagent's lane, read from the right as a pointer is. */
export function decodeLaneSignal(payload: string): { runId: string; lane: string } | null {
  const cut = payload.lastIndexOf(":");
  if (cut <= 0) return null;
  const lane = payload.slice(cut + 1);
  if (lane === MAIN_LANE || !LANE.test(lane)) return null;
  return { runId: payload.slice(0, cut), lane };
}

export async function postgresHistoryBus(
  deps: PostgresHistoryBusDeps,
): Promise<PostgresHistoryBus> {
  // Every map below is keyed by `laneKey(runId, lane)`: a lane has its own seq counter, so its
  // listeners, its cursor and its catch-up are its own.
  const listeners = new Map<string, Set<(event: HistoryEvent) => void>>();
  // The highest seq this process has already handed to its listeners, per lane. It is what makes
  // the self-notification a no-op and what bounds a catch-up read.
  const cursor = new Map<string, number>();
  // One catch-up per lane at a time: notifications arrive per batch, and two overlapping reads
  // would fan the same events out twice for no gain.
  const fetching = new Set<string>();
  // Set while a catch-up is in flight, so a notification that lands mid-read is not lost.
  const pending = new Map<string, number>();
  // Lane-summary listeners, by run. No cursor: the signal is idempotent, and the listener reads.
  const laneListeners = new Map<string, Set<(lane: string) => void>>();

  const fanOut = (key: string, event: HistoryEvent): void => {
    for (const listener of listeners.get(key) ?? []) {
      try {
        listener(event);
      } catch {
        // One broken consumer must not wound the rest.
      }
    }
  };

  /** Reads everything past this lane's cursor and fans it out, in pages. */
  const catchUp = async (runId: string, lane: string, upTo: number): Promise<void> => {
    const key = laneKey(runId, lane);
    if (fetching.has(key)) {
      // Remember the furthest pointer seen; the in-flight read finishes and then chases it.
      pending.set(key, Math.max(pending.get(key) ?? -1, upTo));
      return;
    }
    fetching.add(key);
    try {
      let target = upTo;
      for (;;) {
        // Re-read each pass: a local publish may have advanced it while this was awaiting.
        let from = cursor.get(key) ?? -1;
        while (from < target) {
          // No local listener means nothing to deliver to — the whole point of checking here is
          // that a busy lane nobody is watching costs this replica nothing at all.
          if ((listeners.get(key)?.size ?? 0) === 0) return;
          const page = await deps.store.listEvents(runId, lane, {
            after: from,
            limit: CATCH_UP_PAGE,
          });
          if (page.length === 0) break;
          for (const event of page) {
            if (event.seq <= (cursor.get(key) ?? -1)) continue;
            cursor.set(key, event.seq);
            fanOut(key, event);
          }
          from = cursor.get(key) ?? from;
        }
        const chased = pending.get(key);
        if (chased === undefined || chased <= (cursor.get(key) ?? -1)) break;
        pending.delete(key);
        target = chased;
      }
    } catch (err) {
      // Best effort by contract: the reader replays from the store when the run concludes, and
      // the paginated GET is the record regardless.
      deps.diag.debug("history_bus.catch_up_failed", { runId, lane, err: String(err) });
    } finally {
      fetching.delete(key);
      pending.delete(key);
    }
  };

  const unlisten = await deps.listen(HISTORY_CHANNEL, (payload) => {
    const pointer = decodePointer(payload);
    if (pointer === null) return;
    const key = laneKey(pointer.runId, pointer.lane);
    // Nobody here is watching this lane: do not read, do not allocate a cursor.
    if ((listeners.get(key)?.size ?? 0) === 0) return;
    if (pointer.seq <= (cursor.get(key) ?? -1)) return;
    void catchUp(pointer.runId, pointer.lane, pointer.seq);
  });

  const unlistenLanes = await deps.listen(HISTORY_LANES_CHANNEL, (payload) => {
    const signal = decodeLaneSignal(payload);
    if (signal === null) return;
    // Our own publish signalled locally already; hearing it again costs the listener one read.
    signalLane(laneListeners, signal.runId, signal.lane);
  });

  let closed = false;
  return {
    publish(events) {
      const highest = new Map<string, { runId: string; lane: string; seq: number }>();
      const changed = new Map<string, { runId: string; lane: string }>();
      for (const event of events) {
        if (changesLaneSummary(event)) {
          changed.set(laneKey(event.runId, event.lane), { runId: event.runId, lane: event.lane });
        }
        const key = laneKey(event.runId, event.lane);
        // Local first, and synchronously, so a tail on this replica is not slowed by a round
        // trip through the database to hear about an event this very process just stored.
        if (event.seq > (cursor.get(key) ?? -1)) {
          cursor.set(key, event.seq);
          fanOut(key, event);
        }
        const top = highest.get(key);
        if (top === undefined || event.seq > top.seq) {
          highest.set(key, { runId: event.runId, lane: event.lane, seq: event.seq });
        }
      }
      for (const { runId, lane, seq } of highest.values()) {
        // Fire and forget: the port says publish never throws, and a lost notification costs a
        // peer's tail some latency, never a row.
        deps.notify(HISTORY_CHANNEL, encodePointer(runId, lane, seq)).catch((err) => {
          deps.diag.debug("history_bus.notify_failed", { runId, lane, err: String(err) });
        });
      }
      for (const { runId, lane } of changed.values()) {
        signalLane(laneListeners, runId, lane);
        deps.notify(HISTORY_LANES_CHANNEL, `${runId}:${lane}`).catch((err) => {
          deps.diag.debug("history_bus.notify_failed", { runId, lane, err: String(err) });
        });
      }
    },

    subscribe(runId, lane, listener) {
      const key = laneKey(runId, lane);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      // Idempotent for the same reason the memory bus's is — see adapters/bus/memory.ts.
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set.delete(listener);
        if (set.size === 0 && listeners.get(key) === set) {
          listeners.delete(key);
          // The cursor is only meaningful while someone is listening, and a lane nobody watches
          // must not pin an entry for the life of the process.
          cursor.delete(key);
        }
      };
    },

    subscribeLanes(runId, listener) {
      return joinSet(laneListeners, runId, listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      await unlisten();
      await unlistenLanes();
    },
  };
}
