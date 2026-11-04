// Live fan-out for the task list, as the core sees it — the same port shape the historian's
// transcript bus has, for the same reason: which mechanism carries the news is a wiring choice,
// and a deployment that grows a second control-plane replica must be able to swap the adapter
// without a caller noticing.
//
// THE NOTIFICATION IS A POINTER, NEVER THE NEWS. What travels is a task id; what a receiver does
// with it is read the row. That is what keeps a dropped notification a late list rather than a
// wrong one — and it is what lets the tail coalesce a heartbeat storm into one read.

export interface TaskFeed {
  /** Best-effort: this task changed. Never throws, never blocks the write that called it. */
  publish(taskId: string): void;
  /**
   * Returns the unsubscribe. Listeners should be total; the adapter swallows a throwing listener
   * rather than letting one broken tail wound the rest.
   */
  subscribe(listener: (taskId: string) => void): () => void;
}

/** A feed that carries nothing — what a deployment gets when nothing wires one up. */
export function silentTaskFeed(): TaskFeed {
  return { publish() {}, subscribe: () => () => {} };
}
