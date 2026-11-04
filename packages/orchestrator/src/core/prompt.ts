// The prompt: the first message to a task started without instructions.
//
// Such a task's run boots its sandbox completely and waits; the first message a person sends it
// IS the task — stored as its instructions, so a re-run and every other reader of
// `spec.instructions` keep working, and handed to the agent as its first turn. Messages after it
// are ordinary messages.
//
// Invariants:
// - the claim is one store write (`claimTaskPrompt`), conditioned on the task still having no
//   instructions: of two first messages racing, exactly one becomes the prompt, and the other is
//   posted as an ordinary message after it, with a later seq
// - the claim re-reads the run's state under its lock: a run that ended after it was read here
//   refuses the prompt (409, `terminal`) rather than taking one nobody will ever read
// - only a person's message from the run page can be the prompt: every other producer is refused
//   while a task awaits it (core/inbox.ts), so nothing ever reaches the run's inbox ahead of it,
//   and its runner may take the first message it reads as the prompt
// - the prompt's images become the task's own: the work item names them, as it names the images
//   any task starts with, so a re-run copies them (`readTaskStartImages`)
// - the prompt does not mark the run attended: it is the task, not someone joining it — a run
//   started with its instructions is not attended either. The WAIT for it is on the attended
//   clock all the same (core/lifecycle.ts `clampIdleDeadline`): whoever started the task is
//   there, writing it
// - the title is the prompt's first line at once, and the background model's once it answers
//   (core/titles.ts)

import type { TaskStore } from "../ports/task_store.ts";
import { AttachmentClaimConflict, claimableAttachments } from "./attachments.ts";
import { type InboxDeps, postMessage, type PostOutcome, textRefusal } from "./inbox.ts";
import { isTerminal } from "./lifecycle.ts";
import { withEveryMarker } from "./thread_context.ts";
import { fallbackTitle, startTitling, type TitleDeps } from "./titles.ts";
import type { MessageSender, Run } from "./types.ts";
import { mintId } from "@ryph/sealed";

export type PromptDeps = InboxDeps & {
  store: InboxDeps["store"] & Pick<TaskStore, "claimTaskPrompt"> & TitleDeps["store"];
  platformModel: TitleDeps["platformModel"];
};

/** Whether the run's task was still waiting for its prompt when `run` was read. */
export function runAwaitsPrompt(run: Pick<Run, "workItem">): boolean {
  return run.workItem.spec.instructions === null;
}

/**
 * A person's message to a run: the prompt when the run's task still awaits one, an ordinary
 * message otherwise — including when another message became the prompt first. The run is the
 * caller's, already authenticated, as `postMessage` takes it.
 */
export async function postUserMessage(
  deps: PromptDeps,
  run: Run,
  input: { sender: MessageSender; text: string; attachmentIds?: readonly string[] },
): Promise<PostOutcome> {
  const ordinary = (current: Run) => postMessage(deps, current, { kind: "user", ...input });
  if (!runAwaitsPrompt(run)) return await ordinary(run);
  if (isTerminal(run)) {
    return {
      kind: "refused",
      status: 409,
      error: `run is terminal (${run.state})`,
      reason: "terminal",
    };
  }
  const tooLong = textRefusal(input.text);
  if (tooLong !== null) return tooLong;
  const claimable = await claimableAttachments(deps.store, run.id, input.attachmentIds ?? []);
  if (claimable.kind === "refused") return claimable;
  const text = input.text.trim();
  if (text === "" && claimable.refs.length === 0) {
    return { kind: "refused", status: 400, error: "a message needs text or an image" };
  }
  // Every image named in the instructions, as a task that starts with images has them: the run
  // page's composer writes no markers, and a re-run hands the agent these words again.
  const instructions = withEveryMarker(text, claimable.refs.length).trim();
  const title = fallbackTitle(instructions);
  const at = deps.now().toISOString();
  let claim;
  try {
    claim = await deps.store.claimTaskPrompt({ taskId: run.taskId, instructions, title }, {
      id: mintId("rm"),
      runId: run.id,
      kind: "user",
      sender: input.sender,
      text: input.text,
      payload: null,
      attachments: claimable.refs,
      createdAt: at,
      deliveredAt: null,
    });
  } catch (err) {
    if (err instanceof AttachmentClaimConflict) {
      return { kind: "refused", status: 409, error: err.message };
    }
    throw err;
  }
  if (claim.kind === "terminal") {
    // The run ended between the read above and the claim — it idled out, or was cancelled.
    return {
      kind: "refused",
      status: 409,
      error: `run is terminal (${claim.state})`,
      reason: "terminal",
    };
  }
  if (claim.kind === "taken") {
    // Another message became the prompt first: this one follows it like any other.
    const current = await deps.store.getRun(run.id);
    if (current === null) return { kind: "refused", status: 409, error: "the run is gone" };
    return await ordinary(current);
  }
  const { message } = claim;
  deps.diag.debug("inbox.prompted", { runId: run.id, taskId: run.taskId, seq: message.seq });
  deps.inbox?.notify(run.id);
  startTitling(deps, run.taskId, title);
  const current = await deps.store.getRun(run.id) ?? run;
  return { kind: "posted", message, run: current };
}
