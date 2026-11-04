// The run inbox: durable messages addressed to a run, which its runner pulls in order and
// hands to the agent. Every producer lands here — the run page, a chatroom's mention, a
// fire joining a response, the platform's own note about a patch — so the rule that guards
// the runner's invariant is enforced in one place:
//
//   a run's WORK is fixed at birth; what the outside may hand in afterward is a message, and a
//   message can only ever be read.
//
// Invariants:
// - a message is bounded text, never work: no task, repo, credential or scope rides one, and
//   the runner frames it as untrusted before the agent sees it
// - a message may carry images (core/attachments.ts), by the ids of attachments already stored
//   on THIS run and never sent before; the append claims them in its own transaction. With
//   images the text may be empty, without them it may not
// - a terminal run refuses messages, as it refuses heartbeats: there is nobody to read them.
//   The exception is a record: a patch held for approval or submitted is noted on a terminal
//   run too (`notifyPatch`), so a person can still find its approval or delivery notice
// - the first `user` or `chat` message flips the run to attended — recorded as an event and
//   mirrored onto its response — because the idle clock and the room both care who is there
// - posting never throws for the caller's sake: a refusal is a value with a status
// - a run whose task awaits its prompt takes no message here: its first one is the task, and a
//   person's message becomes it through core/prompt.ts

import type { Diagnostics } from "../ports/diagnostics.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { InboxSignal } from "./inbox_signal.ts";
import { isTerminal } from "./lifecycle.ts";
import { AttachmentClaimConflict, claimableAttachments } from "./attachments.ts";
import { mintId } from "@ryph/sealed";
import { DEFAULT_LINE } from "@ryph/shared/lines";
import {
  type ForgeProvider,
  MAX_MESSAGE_CHARS,
  type MessageKind,
  type MessageSender,
  type Patch,
  type PatchPayload,
  type Run,
  type RunMessage,
  type SystemPayload,
} from "./types.ts";

export interface InboxDeps {
  store: Pick<
    TaskStore,
    | "appendRunMessage"
    | "markRunAttended"
    | "appendEvent"
    | "findResponseByRun"
    | "markResponseActivity"
    | "getRun"
    | "listAttachmentsByIds"
  >;
  diag: Diagnostics;
  /** Wakes the runner's long-poll on this replica; absent, the poll's own clock delivers. */
  inbox?: InboxSignal | null;
  now(): Date;
}

export interface MessageInput {
  kind: MessageKind;
  sender: MessageSender;
  text: string;
  payload?: SystemPayload | null;
  /**
   * The images the message carries: ids `storeAttachment` (core/attachments.ts) answered for
   * THIS run, in the order the text's `imageMarker(n)` placeholders count them. Each must be
   * unclaimed; posting claims it. Any producer may pass them — the run page, a chat transport,
   * a forge follow-up.
   */
  attachmentIds?: readonly string[];
}

/**
 * `reason: "terminal"` marks the one refusal that says the run has ended. It shares its 409 with
 * an image another message claimed first, and a producer that would start a fresh run when the
 * old one is gone (a chat or forge join) must tell the two apart by this, never by the status.
 */
export type PostOutcome =
  | {
    kind: "refused";
    status: 409 | 400 | 413 | 415 | 503;
    error: string;
    reason?: "terminal" | "cap";
  }
  | { kind: "posted"; message: RunMessage; run: Run };

/**
 * Whether `text` is too long for a message — the check `postMessage` makes, exported so a
 * producer that stores images before posting (a chat join) can make it first and store nothing
 * for a message that was never going to be taken.
 */
export function textRefusal(text: string): Extract<PostOutcome, { kind: "refused" }> | null {
  if (text.length <= MAX_MESSAGE_CHARS) return null;
  return {
    kind: "refused",
    status: 400,
    error: `a message carries at most ${MAX_MESSAGE_CHARS} characters`,
  };
}

/**
 * Appends one message to a run's inbox. The run is the caller's (already loaded, already
 * authenticated); what comes back is the run as it stands after — attended, possibly — so a
 * caller that goes on to touch it does not read a stale row.
 */
export async function postMessage(
  deps: InboxDeps,
  run: Run,
  input: MessageInput,
): Promise<PostOutcome> {
  const { store, diag } = deps;
  if (isTerminal(run)) {
    return {
      kind: "refused",
      status: 409,
      error: `run is terminal (${run.state})`,
      reason: "terminal",
    };
  }
  // A run whose task awaits its prompt takes nothing before it: its first message IS the task,
  // and only a person gives that, through core/prompt.ts. Read off the caller's copy, which can
  // only be stale in the safe direction — the prompt's own write sets the work item's spec.
  if (run.workItem.spec.instructions === null) {
    return {
      kind: "refused",
      status: 409,
      error: "the run is waiting for its instructions, which a person gives it from the run page",
    };
  }
  const tooLong = textRefusal(input.text);
  if (tooLong !== null) return tooLong;
  const claimable = await claimableAttachments(store, run.id, input.attachmentIds ?? []);
  if (claimable.kind === "refused") return claimable;
  if (input.text.trim() === "" && claimable.refs.length === 0) {
    return { kind: "refused", status: 400, error: "a message needs text or an image" };
  }
  const at = deps.now().toISOString();
  let message: RunMessage;
  try {
    message = await store.appendRunMessage({
      id: mintId("rm"),
      runId: run.id,
      kind: input.kind,
      sender: input.sender,
      text: input.text,
      payload: input.payload ?? null,
      attachments: claimable.refs,
      createdAt: at,
      deliveredAt: null,
    });
  } catch (err) {
    // Checked above, and lost to a message that claimed the same image in between.
    if (err instanceof AttachmentClaimConflict) {
      return { kind: "refused", status: 409, error: err.message };
    }
    throw err;
  }

  // A person is with the run now. Recorded once, on the run and on its response, because the
  // clock the runner keeps and the state the room shows both turn on it.
  //
  // Both writes are NARROW, and that is the whole point. `run` here is the caller's copy, read
  // before this message was appended; the runner may have reported its result in the meantime,
  // and a full-row write of that copy would put `state: running, result: null` back over a
  // concluded run — after its credentials were revoked — leaving a run no result can ever reach
  // again. The same for the response: a person clicking Close must not be undone by a message
  // that was already in flight.
  let next = run;
  const spoken = input.kind === "user" || input.kind === "chat";
  if (spoken && !run.attended) {
    const marked = await store.markRunAttended(run.id, at);
    next = marked.run ?? run;
    if (marked.flipped) await store.appendEvent({ runId: run.id, at, kind: "attended" });
  }
  // Best-effort: the message is in, so the post is done. A caller that saw a throw here would
  // post it again.
  try {
    const response = await store.findResponseByRun(run.id);
    if (response !== null && response.state !== "closed") {
      await store.markResponseActivity(response.id, at, spoken);
    }
  } catch (err) {
    diag.warn("inbox.response_activity_failed", { runId: run.id, err: String(err) });
  }
  diag.debug("inbox.posted", { runId: run.id, seq: message.seq, kind: input.kind });
  deps.inbox?.notify(run.id);
  return { kind: "posted", message, run: next };
}

/** A name a forge chose, inside a code span: a backtick in it would close the span early and
 * let the rest of the name read as the platform's own words. */
export function inCode(name: string): string {
  return `\`${name.replaceAll("`", "'")}\``;
}

/** Where a landing cue's text defers to the runner: the runner adds the exact command as a note
 * of its own (runner core/patches.ts), and says why when it does nothing. Never asserted to be
 * there: a runner that could not act on the cue may add none, and the agent then catches up with
 * the tool that fetches and merges. */
export const RUNNER_NOTE = "ryph adds a note with the exact command; if there is none, call " +
  "ryph__update_from_base";

/** How a patch's progress reads to the agent, beside the structured payload the runner acts on.
 * "Change request", never "pull request": the repo may be on Radicle. A `local` repository is
 * told apart because its delivery is not a change request at all: the patch becomes a branch in
 * a repository on the deployment's disk, with no link to share. */
function patchNote(
  patch: Patch,
  state: PatchPayload["state"],
  reason: string | null,
  onto: string | undefined,
  newborn: boolean,
  provider: ForgeProvider | null,
  patchUrl: string | null = null,
): string {
  /** The patch the note is about, named so it cannot be mistaken for another: the one the agent
   * just submitted, or one of its patches by its head. */
  // A repo's default line goes unnamed, as it always has; any other is named, since the agent may
  // have several patches open there, one per line.
  const subject = patch.line === DEFAULT_LINE
    ? inCode(patch.path)
    : `${inCode(patch.path)} (line ${inCode(patch.line)})`;
  const which = newborn
    ? `The patch you just submitted for ${subject}`
    : `Your patch for ${subject} (head ${inCode(patch.headSha.slice(0, 7))})`;
  const where = patch.forgeUrl === null ? "" : ` (${patch.forgeUrl})`;
  const yours = `Your patch for ${subject}`;
  if (provider === "local" && (state === "submitted" || state === "approved")) {
    return state === "submitted"
      ? `${yours} is now the branch ${inCode(patch.forgeRef ?? patch.branchName)} ` +
        "in the repository on this machine. There is no link to share: whoever works there " +
        "checks the branch out."
      : `${yours} was approved; the platform is pushing its branch into the repository on ` +
        "this machine now, and a message says so once it is there.";
  }
  switch (state) {
    case "submitted": {
      const ref = patch.forgeRef === null ? "" : ` ${inCode(patch.forgeRef)}`;
      const share = patch.forgeUrl !== null
        ? "the link"
        : patch.forgeRef !== null
        ? "the change request id"
        : "the news";
      return `${yours} is now an open change request${ref}${where}. Nobody has been told yet: ` +
        `this is the moment to share ${share} wherever you are working.`;
    }
    case "approved":
      return `${yours} was approved; the platform is opening the change request now, and a ` +
        "message names it once it is open.";
    case "rejected":
      return `${yours} was rejected${reason === null ? "" : `: ${reason}`}.`;
    case "merged": {
      // The agent moves its own work. The exact rebase is the runner's note to spell out, added
      // to this text: only the runner knows the line's local branch and its landed head, which
      // moves forward only (a squash or a rebase merge gave the landed commits new shas, so the
      // rebase starts past that head and replays nothing that merged).
      const into = onto === undefined
        ? "the branch it merged into: ryph adds a note naming that branch and the exact " +
          "command; if there is none, call ryph__update_from_base"
        : `${inCode(`origin/${onto}`)}: ${RUNNER_NOTE}`;
      return `${yours} was merged${onto === undefined ? "" : ` into ${inCode(onto)}`}${where}, ` +
        "and that change request is done. To go on with this branch, rebase what you did " +
        `after it onto ${into}. Your next submit_patch opens a new change request.`;
    }
    case "missed": {
      // Said plainly either way: what merged, what did not, and that nothing is lost. `onto`
      // only when none of the generation's patches merged: the repo moved, and the agent moves
      // the generation's work there, past the base it was cut from.
      const why = patch.landed?.unproven === true
        ? " (ryph could not confirm that the merge holds its commits, so it counts them as not " +
          "merged)"
        : "";
      if (onto === undefined) {
        return `${which} is not in what merged: its change request${where} merged without all ` +
          `of its commits${why}. What your branch still holds of them goes out with your next ` +
          "submit_patch, once your branch is on what merged.";
      }
      return `${which} is not in what merged: its change request${where} merged into ` +
        `${inCode(onto)} without it${why}, and that change request is done. Those commits are ` +
        `not in ${inCode(onto)}. Rebase them onto ${inCode(`origin/${onto}`)} ` +
        `(${RUNNER_NOTE}) and submit again.`;
    }
    case "closed":
      return `The change request for ${lowerFirst(which)} was closed without merging${where}.`;
    case "failed":
      return `Submitting ${lowerFirst(yours)} failed${
        reason === null ? "" : `: ${reason}`
      }. A person can retry it from the patch queue.`;
    case "superseded":
      return reason === null
        ? `${which} was replaced by a newer one.`
        : `${which} will not be sent: ${reason}.`;
    case "held":
      return heldNote(patch, patchUrl);
  }
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Tells a live run something about one of its patches in words alone, with no payload: for news
 * the runner has no state to change for (a hold), so a runner a version behind, which validates
 * every patch payload it knows strictly, is never handed one it would refuse.
 */
export async function notifyText(deps: InboxDeps, runId: string, text: string): Promise<void> {
  const run = await deps.store.getRun(runId);
  if (run === null || isTerminal(run)) return;
  const outcome = await postMessage(deps, run, {
    kind: "system",
    sender: { kind: "platform" },
    text,
    payload: null,
  }).catch((err): PostOutcome => ({ kind: "refused", status: 400, error: String(err) }));
  if (outcome.kind === "refused" && outcome.status !== 409) {
    deps.diag.warn("inbox.note_failed", { runId, err: outcome.error });
  }
}

/** The most of a held patch's hook file list the note spells out; the rest is counted. */
const HELD_NOTE_PATHS_CHARS = 2_000;

/**
 * Why a patch on a `local` repository waits for a person even where the repo needs no approval,
 * in words the agent can pass on — and a plain instruction not to route around it, since the
 * obvious workarounds (moving the hook elsewhere, renaming it, delivering it some other way) are
 * exactly what the hold exists to stop.
 */
function heldNote(patch: Patch, patchUrl: string | null): string {
  const touched = patch.hookCheck?.touched ?? [];
  const listed: string[] = [];
  let chars = 0;
  for (const path of touched) {
    if (chars + path.length > HELD_NOTE_PATHS_CHARS) break;
    listed.push(`\`${path}\``);
    chars += path.length + 4;
  }
  const rest = touched.length - listed.length + (patch.hookCheck?.more ? 1 : 0);
  const files = listed.length === 0
    ? "git hook files"
    : `git hook files (${listed.join(", ")}${rest > 0 ? `, and more` : ""})`;
  return `Your patch for \`${patch.path}\` changes ${files}. This repository is on the ` +
    "owner's computer, and git hooks run there when the branch is checked out, so a person " +
    "must look at the patch and approve it in ryph before it reaches the repository — " +
    "whatever the repository's usual approval setting. Tell whoever you are working with that " +
    "the patch is waiting for that approval, and why" +
    (patchUrl === null ? ". " : `, and give them its page, where they approve it: ${patchUrl}. `) +
    "Do not try to get around it: no moving, " +
    "renaming or re-submitting the hook changes to slip past the check. A message tells you " +
    "once it is approved.";
}

/**
 * Tells the run what became of one of its patches — a `system` message with the structured
 * payload the runner reads (a merge ends the generation) and a line for the agent. Only a
 * live run hears it: a terminal run has nobody to read its inbox. Held and submitted notices
 * are kept on a terminal run all the same. A run can end (a finish, its idle clock) before its
 * patch is checked or delivered, and a person reading the run still needs its approval notice
 * or delivery link — so the note is appended to the run's record (the messages its page reads)
 * without waking anything: no runner polls a terminal run, nothing is attended, no response
 * touched. Best-effort, like every relay off the patch lifecycle — except that it answers how it
 * went, so the one cue that must not be lost (a merge, which moves the runner's branch) can be
 * marked sent only once it was.
 */
export async function notifyPatch(
  deps: InboxDeps,
  patch: Patch,
  state: PatchPayload["state"],
  reason: string | null = null,
  /** A merge's `PatchPayload.onto`: where the repo stands after it (core/landing.ts). */
  onto?: string,
  /** `newborn`: the note is about the patch the agent just submitted. `provider`: the patch's
   * repo's forge, where the caller has it to hand — only the wording turns on it. `patchUrl`:
   * the patch's page in the app, which a hold's note hands the agent to pass on. `landedHead`: a
   * merged cue's (`PatchPayload`), its own head when the caller names none. */
  opts: {
    newborn?: boolean;
    provider?: ForgeProvider | null;
    patchUrl?: string | null;
    landedHead?: string;
  } = {},
): Promise<"posted" | "nobody" | "failed"> {
  const run = await deps.store.getRun(patch.runId);
  if (run === null) return "nobody";
  const note = {
    kind: "system" as const,
    sender: { kind: "platform" as const },
    text: patchNote(
      patch,
      state,
      reason,
      onto,
      opts.newborn === true,
      opts.provider ?? null,
      opts.patchUrl ?? null,
    ),
    payload: {
      kind: "patch" as const,
      patchId: patch.id,
      path: patch.path,
      // Routed to (path, line): a cue moves only its own line's state in the checkout.
      line: patch.line,
      headSha: patch.headSha,
      generation: patch.generation,
      state,
      forgeUrl: patch.forgeUrl,
      reason,
      ...(state === "held" ? { hookPaths: [...(patch.hookCheck?.touched ?? [])] } : {}),
      ...(onto === undefined ? {} : { onto }),
      ...(state === "merged" ? { landedHead: opts.landedHead ?? patch.headSha } : {}),
    },
  };
  if (isTerminal(run)) {
    if (state !== "held" && state !== "submitted") return "nobody";
    try {
      await deps.store.appendRunMessage({
        id: mintId("rm"),
        runId: run.id,
        ...note,
        attachments: [],
        createdAt: deps.now().toISOString(),
        deliveredAt: null,
      });
    } catch (err) {
      deps.diag.warn("inbox.patch_note_failed", { patchId: patch.id, err: String(err) });
      if (state === "submitted") return "failed";
    }
    return "nobody";
  }
  const outcome = await postMessage(deps, run, note)
    .catch((err): PostOutcome => ({ kind: "refused", status: 400, error: String(err) }));
  if (outcome.kind === "posted") return "posted";
  // A 409 is a run that ended under the post: nobody is left to tell.
  if (outcome.status === 409) return "nobody";
  deps.diag.warn("inbox.patch_note_failed", { patchId: patch.id, err: outcome.error });
  return "failed";
}
