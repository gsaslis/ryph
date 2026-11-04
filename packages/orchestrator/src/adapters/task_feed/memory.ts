// The in-process `TaskFeed` — a listener set, which is exactly right for one process and
// silently wrong for several (see postgres.ts). Tests and the single-process binary use this.

import type { TaskFeed } from "../../ports/task_feed.ts";

export function memoryTaskFeed(): TaskFeed {
  const listeners = new Set<(taskId: string) => void>();
  return {
    publish(taskId) {
      for (const listener of [...listeners]) {
        try {
          listener(taskId);
        } catch {
          // One broken tail must not wound the rest.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      // Idempotent: a second call must not remove a listener that re-subscribed since.
      let done = false;
      return () => {
        if (done) return;
        done = true;
        listeners.delete(listener);
      };
    },
  };
}
