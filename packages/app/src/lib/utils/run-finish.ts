// Whether a person may finish a live run from its page. A finish ends the run as its agent's own
// finish would, on the outcome the agent declared, so it is offered only once that outcome says
// the work is done, and only while the agent is still there to be finished: not once it called
// its finish tool itself, nor once the run is finalizing. Otherwise the run can only be
// cancelled. That includes an agent that reported its work `in-progress` (waiting on checks, a
// subagent or an answer, or still fixing a failed check): the work is not done, so Finish stays
// hidden and Cancel stays on screen. The orchestrator refuses that finish too.

import type { TaskRun } from "$lib/api/types";

type FinishFacts = Pick<TaskRun, "phase" | "declaredOutcome" | "agentFinished" | "desiredState">;

/** The agent last said the run is done: Finish takes Cancel's place. Not while it says its work
 * is in progress, nor once it said it failed. */
export function canFinish(run: FinishFacts): boolean {
  return (run.declaredOutcome === "success" || run.declaredOutcome === "no-changes") &&
    !run.agentFinished && run.phase === "running" && run.desiredState !== "cancelled";
}

/** A finish was asked for, and the run ends once the agent's turn does. */
export function finishRequested(run: Pick<TaskRun, "events">): boolean {
  return run.events.some((event) => event.kind === "finish-requested");
}

/**
 * What a live run's page shows in Cancel's place: Finish once the agent said it is done, and
 * Finishing once a finish was asked for, until the run ends. Finishing does not hang on what the
 * agent says after: a message that reaches it clears its outcome, and the finish still ends the
 * run. Unless someone cancels the run meanwhile.
 */
export function finishButton(
  run: FinishFacts & Pick<TaskRun, "events">,
): "finish" | "finishing" | null {
  if (run.desiredState === "cancelled") return null;
  if (finishRequested(run)) return "finishing";
  return canFinish(run) ? "finish" : null;
}
