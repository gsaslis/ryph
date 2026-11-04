// The in-process `HistoryBus` — a listener map, sufficient while the historian mounts inside
// the host process. A split-out deployment swaps this adapter, not the callers.

import { changesLaneSummary, type HistoryEvent } from "../../core/types.ts";
import type { HistoryBus } from "../../ports/bus.ts";

/** A run's lane as one map key. A lane never holds a newline (core/types.ts `LANE`), so this
 * cannot collide; shared with the postgres bus. */
export const laneKey = (runId: string, lane: string): string => `${runId}\n${lane}`;

export function memoryHistoryBus(): HistoryBus {
  // Keyed by `laneKey`: a subscription is to one lane of one run.
  const listeners = new Map<string, Set<(event: HistoryEvent) => void>>();
  // Keyed by run: the lane-summary signal is the run's, across its lanes.
  const laneListeners = new Map<string, Set<(lane: string) => void>>();

  return {
    publish(events) {
      for (const event of events) {
        if (changesLaneSummary(event)) signalLane(laneListeners, event.runId, event.lane);
        for (const listener of listeners.get(laneKey(event.runId, event.lane)) ?? []) {
          try {
            listener(event);
          } catch {
            // One broken consumer must not wound the rest.
          }
        }
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
      // Idempotent, and deliberately so: the unsubscribe closes over the Set it joined, which the
      // line below may well have removed from the map by the time it is called twice. A second call
      // would then empty a Set nobody is in and delete the map entry — which by now belongs to
      // WHOEVER SUBSCRIBED NEXT, orphaning a live tail that never learns it stopped receiving.
      // The tails registry in http/routes.ts has the same shape and the same guard.
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set.delete(listener);
        // Identity-checked as well as size-checked, so this can only ever remove its own Set.
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key);
      };
    },
    subscribeLanes(runId, listener) {
      return joinSet(laneListeners, runId, listener);
    },
  };
}

/** Calls every lane-summary listener of this run with the lane, swallowing a throwing one. */
export function signalLane(
  laneListeners: Map<string, Set<(lane: string) => void>>,
  runId: string,
  lane: string,
): void {
  for (const listener of laneListeners.get(runId) ?? []) {
    try {
      listener(lane);
    } catch {
      // One broken consumer must not wound the rest.
    }
  }
}

/** Adds `listener` to `map`'s set under `key` and returns its idempotent, identity-checked removal
 * — the same guard as `subscribe`'s, for the same reason. */
export function joinSet<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set.delete(listener);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}
