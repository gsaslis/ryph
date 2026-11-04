// A person finishing a run from its page: the agent said it was done, and the person agrees, so
// the run ends the way the agent's own finish ends it — as a run that ran to its end, on the
// outcome the agent declared. Finalization leftovers always require approval; already recorded
// explicit submissions retain their existing state, regardless of the run's final outcome.
// A cancel would end it interrupted, and an interrupted run's work is never taken as a success.
//
// Delivered through the run's INBOX, as a `system` message carrying a `finish` payload, and not
// through the cancel channels (the push to the runner's control API, the heartbeat's flag). The
// inbox is how everything that is not a stop already reaches a live run, durably and at most once,
// pulled by the runner on every deployment shape; it lands in the same conversation that holds
// the agent's own finish, which is where the runner honours it — at the agent's next settle, so a
// turn under way runs to its end, and without holding for a check verdict the run is owed. The
// beats carry what this waits on, what the agent said, and never the finish itself.
//
// Finish is never offered until the runner reports an outcome on its beats, and a runner that
// reports one reads the `finish` payload, so the message's text is never handed to an agent: it
// is only what the run page's inbox shows.
//
// Invariants:
// - only a running run whose agent last declared `success` or `no-changes`, and has not called
//   its finish tool itself, is finished; anything else is refused, with why. An agent's own
//   finish may be held for a check verdict for a long while, and the run finalizes after it:
//   neither is a run left for a person to end. One posted before the beat that says the agent
//   finished still lands, and the runner ends that hold at once
// - a finish is said once: a second one while the first is on its way answers as the first did,
//   and posts nothing. Two racing each other may both post; the runner takes the first and reads
//   the second as the finish it already is
// - the request is on the run's trail (`finish-requested`), and its message is in the run's inbox,
//   from the person who sent it: who that was is the message's sender, a user id resolved to a
//   name when it is read, never a name copied onto the trail
// - every refusal says why in words the run page can show as they are

import { isTerminal } from "./lifecycle.ts";
import { type InboxDeps, postMessage } from "./inbox.ts";
import type { MessageSender, Run } from "./types.ts";
import type { TaskStore } from "../ports/task_store.ts";

export type FinishRunDeps = InboxDeps & {
  store: InboxDeps["store"] & Pick<TaskStore, "hasRunEvent">;
};

/** The finish message's text: a message is never empty. The runner reads the payload, and the run
 * page shows a badge in its place. */
export const FINISH_MESSAGE_TEXT = "Finished the run.";

export type FinishOutcome =
  | { kind: "requested"; run: Run }
  /** A finish was already requested; nothing new was posted. */
  | { kind: "already-requested"; run: Run }
  | { kind: "refused"; status: 409 | 400 | 413 | 415 | 503; error: string };

/**
 * Finishes `run` on behalf of `sender`. The run is the caller's, already loaded and authorized.
 */
export async function finishRun(
  deps: FinishRunDeps,
  run: Run,
  sender: MessageSender,
): Promise<FinishOutcome> {
  const refused = (error: string): FinishOutcome => ({ kind: "refused", status: 409, error });
  if (isTerminal(run)) return refused("This run has already ended");
  if (run.desiredState === "cancelled") return refused("This run is being cancelled");
  if (run.state !== "running") return refused("This run hasn't started yet");
  // Before the checks below: the run a person's finish is ending moves on to finalizing.
  if (await deps.store.hasRunEvent(run.id, "finish-requested")) {
    return { kind: "already-requested", run };
  }
  if (run.agentFinished === true || run.phase === "finalizing") {
    return refused("This run is already finishing");
  }
  if (run.phase !== "running") return refused("This run hasn't started yet");
  if (run.declaredOutcome !== "success" && run.declaredOutcome !== "no-changes") {
    return refused("The agent hasn't said it's done yet");
  }
  const posted = await postMessage(deps, run, {
    kind: "system",
    sender,
    text: FINISH_MESSAGE_TEXT,
    payload: { kind: "finish" },
  });
  if (posted.kind === "refused") {
    // The inbox's own words are for a runner or an API caller; the page shows these.
    return {
      kind: "refused",
      status: posted.status,
      error: posted.reason === "terminal"
        ? "This run has already ended"
        : "This run can't be finished right now",
    };
  }
  await deps.store.appendEvent({
    runId: run.id,
    at: deps.now().toISOString(),
    kind: "finish-requested",
  });
  return { kind: "requested", run: posted.run };
}
