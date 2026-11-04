// The in-process wake-up behind the runner's long-poll: a message posted on THIS replica ends
// the wait at once instead of a second later. It is an optimisation, never the correctness —
// the poll re-reads the store on its own clock regardless, which is how a message posted on
// another replica arrives, and how a replica with no signal at all still delivers. So this
// stays deliberately tiny: no persistence, no cross-process fan-out, no NOTIFY.

export interface InboxSignal {
  /** Resolves when `notify(runId)` is called, when `ms` elapse, or when `signal` aborts. */
  wait(runId: string, ms: number, signal?: AbortSignal): Promise<void>;
  /** Wakes every waiter on the run. */
  notify(runId: string): void;
}

export function makeInboxSignal(): InboxSignal {
  const waiters = new Map<string, Set<() => void>>();
  return {
    wait(runId, ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const set = waiters.get(runId) ?? new Set();
        waiters.set(runId, set);
        const done = () => {
          set.delete(done);
          if (set.size === 0 && waiters.get(runId) === set) waiters.delete(runId);
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        // Nothing between here and the listener below can call `done` — the abort case was
        // answered above — so the timer is always set by the time it is cleared.
        const timer = setTimeout(done, ms);
        set.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
    notify(runId) {
      const set = waiters.get(runId);
      if (set === undefined) return;
      for (const done of [...set]) done();
    },
  };
}
