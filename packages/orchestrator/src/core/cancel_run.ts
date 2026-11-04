// Cancelling a run, extracted from the HTTP handler so every door cancels the same way: the
// user surface (POST /v1/tasks/:id/cancel) and `ryph up`'s exit prompt both land here.
// Records the intent, then pushes it down to the runner where its provisioner can reach it; the
// reaper's provisioner kill after the grace period is the backstop, so a failed push is no failure.
//
// A run still waiting for its environment has no container to tell: it is cancelled on the
// spot, and the build it waited for is called off when the run was its only reason.

import type { CancelOutcome } from "./lifecycle.ts";
import { type Run, TERMINAL_STATES } from "./types.ts";
import type { EnvironmentService } from "./environments.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { RunnerControl } from "../ports/runner_control.ts";

export interface CancelRunDeps {
  store: TaskStore;
  runnerControl: RunnerControl;
  /** Null/absent: no builds to call off. */
  environments?: Pick<EnvironmentService, "release"> | null;
  now(): Date;
}

/** `terminal`: nothing to cancel. Otherwise the cancel is on record, and pushed when it could be. */
export async function cancelRun(
  deps: CancelRunDeps,
  given: Run,
): Promise<{ kind: CancelOutcome["kind"]; pushed: boolean }> {
  const { store, runnerControl } = deps;
  let run = given;
  if (run.environmentWait !== null && run.handle === null) {
    // Nothing was launched, so nothing has to stop: the run ends here. Its credentials were
    // never minted, and the reaper's reconciliations settle the rest (memory, a response).
    const at = deps.now().toISOString();
    const waited = run.environmentWait.environmentId;
    const cancelled = await store.saveRunIfWaiting({
      ...run,
      state: "cancelled",
      desiredState: "cancelled",
      cancelRequestedAt: run.cancelRequestedAt ?? at,
      environmentWait: null,
      updatedAt: at,
    }, waited);
    if (cancelled) {
      await store.appendEvent({
        runId: run.id,
        at,
        kind: "cancel-requested",
        detail: `cancelled while waiting for environment ${waited}`,
      });
      await deps.environments?.release(waited, "the run waiting for it was cancelled");
      return { kind: "applied", pushed: false };
    }
    // Its build settled first, and the run launched or was refused: cancel what it is now.
    const current = await store.getRun(run.id);
    if (current === null) return { kind: "terminal", pushed: false };
    run = current;
  }
  const at = deps.now().toISOString();
  const outcome = await store.requestRunCancel(run.id, at);
  const target = outcome.run;
  if (target === null || TERMINAL_STATES.has(target.state)) {
    return { kind: "terminal", pushed: false };
  }
  const kind = outcome.applied ? "applied" : "already-requested";
  if (outcome.applied) {
    await store.appendEvent({ runId: run.id, at, kind: "cancel-requested" });
  }
  const pushed = await runnerControl.requestCancel(target);
  if (pushed) {
    await store.appendEvent({ runId: run.id, at: deps.now().toISOString(), kind: "cancel-pushed" });
  }
  return { kind, pushed };
}
