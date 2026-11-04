// The cross-replica `TaskFeed`, on Postgres LISTEN/NOTIFY — the same mechanism the historian's
// transcript bus uses, in its simplest possible form.
//
// The in-process feed (memory.ts) is a listener set, which is right for one process and silently
// wrong for several: a task list open on replica A would never move for a run heartbeating on
// replica B, and the list would look frozen with no error anywhere to explain it. The control
// plane runs one replica today; this exists so that stops being load-bearing.
//
// WHAT TRAVELS IS A TASK ID, NEVER A ROW. Postgres caps a NOTIFY payload at 8000 bytes and drops
// notifications outright when a listener falls behind, so a task summary must not ride one — and
// should not, because a dropped notification would then be a wrong list rather than a late one.
// A receiver re-reads the row, which is also what makes a duplicate harmless.
//
// A publish fans out to this process's own listeners synchronously AND notifies peers, so the
// local tail never pays a round trip through the database to hear what this process just wrote.
// The self-notification that follows is delivered back here and fans the same id out a second
// time; that costs one idempotent frame, which a tail's coalescing window usually swallows
// before it is ever sent. Deduping it would mean holding per-task state for no gain.

import type { TaskFeed } from "../../ports/task_feed.ts";

/** The channel every replica of the control plane announces task changes on. */
export const TASK_FEED_CHANNEL = "ryph_task_changes";

export interface PostgresTaskFeedDeps {
  /** The signal pair from the orchestrator's own `DbHandle` — see @ryph/db. */
  notify(channel: string, payload: string): Promise<void>;
  listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>>;
  diag: { debug(event: string, fields?: Record<string, unknown>): void };
}

export interface PostgresTaskFeed extends TaskFeed {
  /** Drops the subscription. Idempotent. */
  close(): Promise<void>;
}

export async function postgresTaskFeed(deps: PostgresTaskFeedDeps): Promise<PostgresTaskFeed> {
  const listeners = new Set<(taskId: string) => void>();

  const fanOut = (taskId: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(taskId);
      } catch {
        // One broken tail must not wound the rest.
      }
    }
  };

  const unlisten = await deps.listen(TASK_FEED_CHANNEL, (payload) => {
    // Nobody here is watching anything: no tail, no work.
    if (payload === "" || listeners.size === 0) return;
    fanOut(payload);
  });

  let closed = false;
  return {
    publish(taskId) {
      fanOut(taskId);
      // Fire and forget: the port says publish never throws, and a lost notification costs a
      // peer's list some latency, never a row.
      deps.notify(TASK_FEED_CHANNEL, taskId).catch((err) => {
        deps.diag.debug("task_feed.notify_failed", { taskId, err: String(err) });
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        listeners.delete(listener);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      await unlisten();
    },
  };
}
