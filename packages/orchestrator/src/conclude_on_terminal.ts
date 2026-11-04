// A composition helper: wraps a TaskStore so a run reaching a terminal state announces itself
// to the historian. Offered by the package because it knows which states are terminal; the
// composition root that mounts the historian (the host today) supplies the `concludeRun` signal.

import { type Run, TERMINAL_STATES } from "./core/types.ts";
import type { TaskStore } from "./ports/task_store.ts";

/**
 * Tells the historian when a run reaches a terminal state, so it can hang up that run's live
 * tails — a concluded run is the one thing a watcher needs to know that never appears in the
 * history itself (the lifecycle trail is the orchestrator's, in `run_events`).
 *
 * The store is the choke point on purpose. Every terminal path — the runner's result, a user's
 * cancel, the reaper's `lost` verdict or its kill, and the conditional `saveRunIfWaiting` that
 * ends a run still waiting on its build (a cancel, or the reaper's refusal of a failed build) —
 * has to persist the run to make it real, so one wrapper catches all of them and no path added
 * later can forget to announce itself. The notification fires AFTER the write lands, which is
 * what lets a client reload on `done` and be certain it reads the final state. The core stays
 * unaware the historian exists.
 */
export function concludeOnTerminal(
  inner: TaskStore,
  concludeRun: (runId: string) => void,
): TaskStore {
  return {
    ...inner,
    async saveRunTransition(run, expected) {
      const landed = await inner.saveRunTransition(run, expected);
      if (landed && TERMINAL_STATES.has(landed.state)) concludeRun(landed.id);
      return landed;
    },
    async saveRunResult(run) {
      const landed = await inner.saveRunResult(run);
      if (landed && TERMINAL_STATES.has(landed.state)) concludeRun(landed.id);
      return landed;
    },
    async saveRunIfWaiting(run: Run, environmentId: string): Promise<boolean> {
      const landed = await inner.saveRunIfWaiting(run, environmentId);
      // The conditional write that ends a run still waiting on its image build — a cancel while
      // the build runs, the reaper's refusal when it fails or times out. Only the caller whose
      // claim landed announces: a losing claim wrote nothing, and the winner (whichever path it
      // was) announces for itself. Same rule as publish_task_changes.ts.
      if (landed && TERMINAL_STATES.has(run.state)) concludeRun(run.id);
      return landed;
    },
    async saveRunIfUnlaunched(run: Run): Promise<boolean> {
      const landed = await inner.saveRunIfUnlaunched(run);
      // A launch that failed ends the run here: the same rule as saveRunIfWaiting.
      if (landed && TERMINAL_STATES.has(run.state)) concludeRun(run.id);
      return landed;
    },
  };
}
