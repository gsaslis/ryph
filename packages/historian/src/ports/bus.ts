// Live fan-out, as the core sees it. A port precisely so that splitting the historian into
// its own process later is a wiring change (swap in a poll-tail or an external bus), not a
// refactor — today's adapter is an in-process listener map.

import type { HistoryEvent } from "../core/types.ts";

export interface HistoryBus {
  /** Best-effort broadcast, each event to the live listeners of its run's lane. Never throws. */
  publish(events: HistoryEvent[]): void;
  /**
   * Listens to ONE lane of a run: a listener on the main lane never hears a subagent's events,
   * nor the other way round. Returns the unsubscribe. Listeners should be total; the adapter
   * swallows a throwing listener rather than letting one broken consumer wound the rest.
   */
  subscribe(runId: string, lane: string, listener: (event: HistoryEvent) => void): () => void;
  /**
   * Listens for any lane of a run whose summary changed: called with the lane each time an event
   * `changesLaneSummary` is published for it. A signal, not the news — the listener reads the
   * listing from the store — and it may arrive more than once for one change. Returns the
   * unsubscribe, idempotent like `subscribe`'s.
   */
  subscribeLanes(runId: string, listener: (lane: string) => void): () => void;
}
