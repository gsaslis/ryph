// The patch state machine, as pure functions — the same contract as core/lifecycle.ts:
// every transition takes the current Patch and returns the next Patch plus the events to
// append, persistence is the caller's job, and the store stays a dumb row-holder.
// The full story (and the arguments) is docs/patch-lifecycle.md.
//
// Invariants:
// - a patch is durable the instant it is opened, under EVERY policy: `pending_approval` and
//   `queued` differ only in what unblocks them. Approval gates submission, never persistence
// - `failed` is not terminal — it is "queued, with a clock and a reason". The only exits that
//   lose work are a human's `rejected` or a newer patch's `superseded`
// - WHETHER a patch is opened is driven by the PRESENCE of a BranchOutcome, never
//   `status === "success"` — a run that needed no code changes succeeds with no commits,
//   and keying on success alone would open empty patches for it
// - the STATE it is born into is a different question: `auto` may skip approval for explicit
//   submissions, never finalization leftovers. Cancellation intent also keeps new work held
//   at `pending_approval` for a human
// - `markSubmitting` records intent (and takes the lease); the forge call is the caller's
//   delivery, free to fail, because `planPatchSweep` always fires again
// - the lease guards a submitter that DIED; a submitter running CONCURRENTLY is stopped one layer
//   out, by `savePatchIfState`. `markSubmitting` is pure and judges the copy it is handed, so two
//   sweeps holding the same copy both get "applied" here — the conditional write is what decides
//   which of them delivers. Reading this transition as the exclusion is the mistake to avoid
// - the sweep never throws: every enforcement is best-effort, the next sweep sees the same
//   evidence and tries again

import {
  type CommitInfo,
  type ForgeProvider,
  type Patch,
  type PatchApprover,
  type PatchFate,
  type PatchHookCheck,
  type RunEvent,
  type SubmissionPolicy,
  type Task,
  TERMINAL_PATCH_STATES,
} from "./types.ts";
import type { MemoryChangeFate } from "../ports/memory_access.ts";
import { hasLanding } from "./landing.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";

export function isPatchTerminal(patch: Patch): boolean {
  return TERMINAL_PATCH_STATES.has(patch.state);
}

/**
 * The earlier patch of the same branch whose change request `patch` is pushed onto, if any: one
 * of the same run, repo, path, line and generation, submitted, with a change request that has not
 * landed. Never one of another line: each line is its own change request.
 * Patches are cumulative on one branch until it lands, so the submission pushes onto it rather
 * than opening a second change request from the same branch (core/reaper.ts), and what approving
 * `patch` publishes is only what it adds on top. The newest such, as each pushes onto the last.
 * One place for this, so the submission and the diff a reviewer reads never disagree.
 */
export function earlierOpenPatch(patches: readonly Patch[], patch: Patch): Patch | undefined {
  return patches
    .filter((p) =>
      p.id !== patch.id && p.runId === patch.runId &&
      p.connectedRepoId === patch.connectedRepoId && p.path === patch.path &&
      p.line === patch.line && p.generation === patch.generation &&
      p.createdAt <= patch.createdAt && p.state === "submitted" && p.landed === null &&
      p.forgeRef !== null
    )
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
}

/**
 * Where a submission lands `patch`: the change request it is pushed onto, if any; the branch the
 * submission stages it on (`branch`, the forge's `baseBranch`); and the ref its diff is measured
 * against (`diffRef`), which is that change request's head as the forge serves it.
 *
 * Onto a change request in two cases. The task's own, for the repo the command came from, and
 * only for its DEFAULT line (@ryph/shared/lines) — a task binds the change request it targets to
 * that one line, and every other line of the repo is a change request of its own: the branch is
 * that change request's head branch, which is the task's ref in this repo (`baseBranch`),
 * whichever patch of the line pushes onto it. Or the one an earlier patch of this
 * branch opened while it is still open (`earlierOpenPatch`): on GitHub the branch is that patch's
 * own, which is the pull request's head. On Radicle the earlier patch's head is a Radicle patch,
 * which the forge's git door serves only as `patches/<id>`, never as the branch the run pushed:
 * the submission stages on the line's base, as the patch's first revision did, and adds a
 * revision to it; the diff is measured against `patches/<id>`, so it shows what that revision
 * adds. On a local repository the earlier patch's "change request" is its branch in the
 * repository (the forge answers `ref` = the branch name), which is fast-forwarded exactly as a
 * pull request's head is — GitHub's shape. Else a fresh change request against `baseBranch`.
 *
 * `baseBranch` is the patch's LINE's base (core/landing.ts `lineBase`), never the repo's `ref`
 * read raw: for any line but the default, in a task that works a change request, `ref` is that
 * change request's head, and a line of its own opened against it would stack on it.
 *
 * The submission (core/reaper.ts) and the diff a reviewer reads both take it from here, so what
 * is shown is measured against where approving actually lands it.
 */
export function submissionTarget(
  task: Pick<Task, "targetChangeRequest">,
  patches: readonly Patch[],
  patch: Patch,
  baseBranch: string,
  provider: ForgeProvider,
): { branch: string; diffRef: string; changeRequest: string | null; earlier: Patch | undefined } {
  const earlier = earlierOpenPatch(patches, patch);
  if (
    task.targetChangeRequest !== null &&
    task.targetChangeRequest.connectedRepoId === patch.connectedRepoId &&
    patch.line === DEFAULT_LINE
  ) {
    return {
      branch: baseBranch,
      diffRef: baseBranch,
      changeRequest: task.targetChangeRequest.thread,
      earlier,
    };
  }
  if (earlier !== undefined && earlier.forgeRef !== null) {
    switch (provider) {
      case "radicle":
        return {
          branch: baseBranch,
          diffRef: `patches/${earlier.forgeRef}`,
          changeRequest: earlier.forgeRef,
          earlier,
        };
      case "github":
      case "gitlab":
      case "local":
        return {
          branch: earlier.branchName,
          diffRef: earlier.branchName,
          changeRequest: earlier.forgeRef,
          earlier,
        };
    }
  }
  return { branch: baseBranch, diffRef: baseBranch, changeRequest: null, earlier };
}

/** Whether a patch's change request merged, whether or not the merge contained it: its
 * generation is over either way. */
export function isMergeVerdict(fate: PatchFate | null): boolean {
  return fate?.kind === "merged" || fate?.kind === "missed";
}

/**
 * The patch of `patch`'s own branch whose change request already MERGED, if any: same run, repo,
 * path, line and generation, settled `merged` — or `missed`, when the merge did not contain it, which
 * ends the generation all the same. A merged one first. One rule hangs off it (`landedVerdict`,
 * docs/patch-lifecycle.md "Landing"): a patch is never delivered on its own once such a sibling
 * exists. Its change request is done, and its commits past what merged are the runner's next
 * patch to carry onto the new base; delivered itself, it would publish the merged commits a
 * second time, or go out from a base the repo has moved off.
 */
export function landedSiblingOf(patches: readonly Patch[], patch: Patch): Patch | undefined {
  const siblings = patches.filter((p) =>
    p.id !== patch.id && p.runId === patch.runId && p.connectedRepoId === patch.connectedRepoId &&
    p.path === patch.path && p.line === patch.line && p.generation === patch.generation &&
    isMergeVerdict(p.landed)
  );
  return siblings.find((p) => p.landed?.kind === "merged") ?? siblings[0];
}

/** Waiting for a person or the sweep, and nobody's delivery yet: what a newer patch may replace. */
export function isPatchWaiting(patch: Patch): boolean {
  return isPatchUnpublished(patch) && patch.state !== "submitting";
}

/**
 * Whether the landing rule speaks to this patch at all: one still on its way — waiting for a
 * person or the sweep, or in the sweep's hands — and a failure only while its retry clock runs.
 * A failure with no clock left waits on a person's retry and goes nowhere on its own; the rule
 * has nothing to stop, and holding the failures that predate it would flood the queue with holds
 * naming a destination the task no longer has. SQL twin: `listPatchesDueLandingRule`.
 */
export function isRuledByLanding(patch: Patch): boolean {
  return patch.state === "pending_approval" || patch.state === "queued" ||
    patch.state === "submitting" || (patch.state === "failed" && patch.nextAttemptAt !== null);
}

/** Whether a newer patch may replace an older one under the landing rule: not rejected, not
 * superseded, not closed or missed (its change request ended without it, so it carries nothing
 * anywhere), and not failed with no retry clock left. SQL twin: the `n.` clauses of
 * `listPatchesDueLandingRule`. */
function canReplace(p: Patch): boolean {
  return p.state !== "rejected" && p.state !== "superseded" && p.landed?.kind !== "closed" &&
    p.landed?.kind !== "missed" && !(p.state === "failed" && p.nextAttemptAt === null);
}

/** What becomes of a patch whose generation landed through a sibling (`landedSiblingOf`). */
export type LandedVerdict =
  /** No sibling merged, or it is held already (`heldReason`) and nothing newer replaces it: as
   * ever — a person decides a held patch, and one who approved it is not overruled. */
  | { kind: "none" }
  /** A newer patch of the same branch exists — a later generation, or a newer patch of the same
   * one that is waiting or merged — and holds at least its commits: replaced by it. (Patches of
   * one generation are cumulative: one born before the sibling that merged is inside the merge.) */
  | { kind: "superseded"; by: Patch }
  /** It is the newest: held for a person, who decides once nothing newer can come. */
  | { kind: "held" };

/**
 * The one rule for a patch whose generation landed through a sibling: it is never delivered on
 * its own. Replaced by the newest patch of its branch that is newer than it — a later generation,
 * a newer waiting patch, or the merged sibling itself when that came after it — so a generation
 * never holds two patches one containing the other, nor holds work that already merged; else
 * held. Pure.
 */
export function landedVerdict(
  patch: Patch,
  patches: readonly Patch[],
  /** The task's landings: one recorded at the patch's generation or later ended it, whether a
   * sibling's landing wrote it or a release did (core/landing.ts `releaseMergedTarget`). */
  landings: Task["landings"] = {},
): LandedVerdict {
  if (!isRuledByLanding(patch)) return { kind: "none" };
  if (landedSiblingOf(patches, patch) === undefined && !hasLanding(landings, patch)) {
    return { kind: "none" };
  }
  const newer = patches
    .filter((p) =>
      p.id !== patch.id && p.runId === patch.runId &&
      p.connectedRepoId === patch.connectedRepoId && p.path === patch.path &&
      // Only the same line's: another line's generations are its own, and its work is not this.
      p.line === patch.line &&
      // Only a patch still on its way, or merged, replaces another: one declined, replaced,
      // closed, missed or failed for good carries nothing anywhere, and a person who turned the next
      // generation down may still send this one.
      canReplace(p) &&
      (p.generation > patch.generation ||
        (p.generation === patch.generation && p.createdAt > patch.createdAt &&
          (isPatchWaiting(p) || p.landed?.kind === "merged")))
    )
    .toSorted((a, b) =>
      b.generation - a.generation ||
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
    )[0];
  if (newer !== undefined) return { kind: "superseded", by: newer };
  // Held already: a person decides it, and one who approved it is not overruled. A hold for
  // another reason gives way to this one, which also waits for the run.
  return isLandingHold(patch) ? { kind: "none" } : { kind: "held" };
}

/** Why a held patch waits for a person (`Patch.heldReason`). The reason alone: where approving
 * it would send it moves with the task, and is read when it is shown (`heldDestination`). */
export const HELD_REASON =
  "A patch of the same branch merged before this one was sent, so it may repeat commits that " +
  "already merged.";
/** The same, where the change request the branch works merged without any of its patches. */
export const HELD_REASON_ENDED =
  "The change request this branch works merged without any of its patches before this one " +
  "was sent, so it would go out from a base the repo has moved off.";

/** Every reason `heldReasonFor` gives, which is what makes a landing hold (`isLandingHold`). */
export const LANDING_HOLD_REASONS: readonly string[] = [HELD_REASON, HELD_REASON_ENDED];

/** The held reason of a patch whose branch does not hold the tip its line's change request
 * merged at (`RepoLanding.tip`): a person sees its diff before it goes out. */
export function unrebasedReason(onto: string): string {
  const name = `\`${onto.replaceAll("`", "'")}\``;
  return `Not rebased onto ${name} after its change request merged there; its diff may repeat ` +
    "merged work.";
}

/** The held reason of a patch holding commits of other lines of its repo (core/open_patch.ts):
 * each line ships as its own change request, so sent as it is it would repeat their work. */
export function overlapReason(lines: readonly string[]): string {
  const names = lines.map((l) => `\`${l.replaceAll("`", "'")}\``).join(", ");
  return lines.length === 1
    ? `Holds commits of line ${names}, which ships as its own change request.`
    : `Holds commits of lines ${names}, which ship as their own change requests.`;
}

/** The held reason of a patch the forge could not check for either of those (core/open_patch.ts):
 * held rather than sent unchecked. */
export const UNCONFIRMED_REASON =
  "Could not confirm that this patch holds what its line merged and no other line's commits.";

/** Whether a patch is held because its generation landed (`retireLanded`): approvable only once
 * its run ends, and never held again by the landing rule. Told by its reason being one of the
 * landing rule's own (`heldReasonFor`); every other reason is a review hold, which a person may
 * send with its diff in view while the run goes on. */
export function isLandingHold(patch: Pick<Patch, "heldReason">): boolean {
  return patch.heldReason !== null && LANDING_HOLD_REASONS.includes(patch.heldReason);
}

/** The held reason for a generation that ended the way its landed sibling says: merged, or (a
 * missed sibling, or none: a release) without anything of the branch. */
export function heldReasonFor(sibling: Patch | undefined): string {
  return sibling?.landed?.kind === "merged" ? HELD_REASON : HELD_REASON_ENDED;
}

/** Where approving a held patch sends it, as the submission would now (`submissionTarget`). */
export function heldDestination(
  target: Pick<ReturnType<typeof submissionTarget>, "branch" | "changeRequest">,
): string {
  return target.changeRequest === null
    ? `Approving it opens a new change request against ${target.branch}.`
    : `Approving it pushes it onto the open change request #${target.changeRequest}.`;
}

/**
 * Applies a `landedVerdict` to a patch nothing has published — the submit sweep applies it to a
 * patch it has just claimed (`submitting`). Superseded by the newer patch, or held: back at
 * `pending_approval` whatever the repo's policy, the reason on it. Either answer drops an approval
 * the patch had: what a person approved was this patch going where it would have gone then.
 * The caller writes it conditioned on the row it read.
 */
export function retireLanded(
  patch: Patch,
  verdict: Exclude<LandedVerdict, { kind: "none" }>,
  at: string,
  reason: string,
): PatchTransitionOutcome {
  if (!isPatchUnpublished(patch)) {
    return { kind: "refused", why: `patch is ${patch.state}; only unpublished patches retire` };
  }
  const quiet = {
    leaseExpiresAt: null,
    nextAttemptAt: null,
    approvedBy: null,
    approvedAt: null,
    approvedHookPaths: [],
    updatedAt: at,
  };
  if (verdict.kind === "held") {
    return {
      kind: "applied",
      patch: {
        ...patch,
        ...quiet,
        state: "pending_approval",
        heldReason: reason,
        // A hold at delivery hands back the attempt `markSubmitting` took, as a hook hold does
        // (`holdPatch`): nothing failed.
        attempts: patch.state === "submitting" ? Math.max(0, patch.attempts - 1) : patch.attempts,
      },
      events: [{ runId: patch.runId, at, kind: "patch-held", detail: reason }],
    };
  }
  return {
    kind: "applied",
    patch: { ...patch, ...quiet, state: "superseded", supersededByPatchId: verdict.by.id },
    events: [{ runId: patch.runId, at, kind: "patch-superseded", detail: verdict.by.id }],
  };
}

/**
 * The branch a delivered submission left the patch's commits on, from where it was sent
 * (`submissionTarget`) and the change request the forge answered with. On Radicle every change
 * request is served as `patches/<id>`. On GitHub a push onto an existing pull request lands on
 * that pull request's head, which is the target's branch; a fresh one is opened from the
 * patch's own branch, and `target.branch` is then its base instead. On a local repository the
 * patch IS a branch, opened and fast-forwarded the same way, so GitHub's answer is its answer too.
 */
export function forgeBranchOf(
  provider: ForgeProvider,
  target: Pick<ReturnType<typeof submissionTarget>, "branch" | "changeRequest">,
  patch: Pick<Patch, "branchName">,
  forgeRef: string,
): string {
  if (provider === "radicle") return `patches/${forgeRef}`;
  return target.changeRequest !== null ? target.branch : patch.branchName;
}

/** Whether a patch can still be published: its diff is then measured against where it lands. */
export function isPatchUnpublished(patch: Patch): boolean {
  return patch.state === "pending_approval" || patch.state === "queued" ||
    patch.state === "submitting" || patch.state === "failed";
}

/** Everything a patch is born knowing. All of it comes from rows that already exist — birth
 * touches nothing external, which is what makes it unconditional. */
export interface OpenPatchArgs {
  id: string;
  connectedRepoId: string;
  runId: string;
  taskId: string;
  /** Shared by every patch born from the same finalize. */
  setId: string;
  /** The repo's directory in the run's checkout. */
  path: string;
  /** The line of the run's work in the repo (@ryph/shared/lines). */
  line: string;
  branchName: string;
  /** From the run's BranchOutcome — the same SHA the gateway recorded on intake. */
  headSha: string;
  /** Derived, not fetched: where the gateway files the bundle (@ryph/shared/lines `runBundleKey`). */
  bundleKey: string;
  /** What the runner said at submit (see Patch): the base, the generation, its own words. */
  baseSha: string | null;
  generation: number;
  title: string | null;
  description: string | null;
  commits: CommitInfo[];
  /** The earlier patches of the run's same repo and path it carries (see Patch). */
  carries: string[];
  /** Why it waits for a person whatever the policy or admission, when the server found a reason
   * (core/open_patch.ts): its branch is not on where its line merged (`unrebasedReason`), it
   * holds another line's commits, or neither could be confirmed. */
  heldReason: string | null;
}

/**
 * Birth. The policy decides only WHICH state the patch is born into — and this is the only
 * time the policy is consulted; changing a repo's policy later never touches existing rows.
 *
 * `auto` skips the gate only when admission allows it: an explicit submission without
 * cancellation intent. Finalization still saves committed work, but always requires a human
 * to approve it, even when the run reports success. A finalization patch is held without a
 * reason, as any other patch awaiting approval — except one born with a reason (`heldReason`),
 * which waits whatever the policy or admission with its reason on it, so a person approves it
 * only with its diff in view. `isLandingHold` never mistakes that reason for a landing hold.
 */
export function openPatch(
  args: OpenPatchArgs,
  policy: SubmissionPolicy,
  allowAutoApproval: boolean,
  at: string,
): { patch: Patch; events: RunEvent[] } {
  const heldReason = args.heldReason;
  const patch: Patch = {
    id: args.id,
    connectedRepoId: args.connectedRepoId,
    runId: args.runId,
    taskId: args.taskId,
    setId: args.setId,
    path: args.path,
    line: args.line,
    branchName: args.branchName,
    headSha: args.headSha,
    bundleKey: args.bundleKey,
    baseSha: args.baseSha,
    generation: args.generation,
    title: args.title,
    description: args.description,
    commits: args.commits,
    carries: args.carries,
    state: policy === "auto" && allowAutoApproval && heldReason === null
      ? "queued"
      : "pending_approval",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    approvedBy: null,
    approvedAt: null,
    forgeRef: null,
    forgeUrl: null,
    forgeBranch: null,
    diffRef: null,
    landed: null,
    mergedCuedAt: null,
    mergedCueClaimedAt: null,
    landingAskedAt: null,
    heldReason,
    version: 0,
    supersededByPatchId: null,
    memoryFateReportedAt: null,
    hookCheck: null,
    approvedHookPaths: [],
    createdAt: at,
    updatedAt: at,
  };
  const events: RunEvent[] = [{ runId: args.runId, at, kind: "patch-opened", detail: patch.state }];
  if (heldReason !== null) {
    events.push({ runId: args.runId, at, kind: "patch-held", detail: heldReason.slice(0, 500) });
  }
  return { patch, events };
}

export type PatchTransitionOutcome =
  | { kind: "refused"; why: string }
  | { kind: "applied"; patch: Patch; events: RunEvent[] };

/**
 * A human (or break-glass) says yes: pending_approval → queued. `hookPaths`, for a patch on a
 * `local` repository, is the git hook files this approval covers — the caller decides which
 * (only those the person was shown); absent leaves the patch's list as it was.
 */
export function approvePatch(
  patch: Patch,
  approver: PatchApprover,
  at: string,
  hookPaths?: readonly string[],
): PatchTransitionOutcome {
  if (patch.state !== "pending_approval") {
    return { kind: "refused", why: `patch is ${patch.state}, not pending_approval` };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "queued",
      // A waiting patch's only clock is its hook check's backoff (`failHookCheck`): approved, it
      // is asked about at once rather than when that clock says.
      nextAttemptAt: null,
      approvedBy: approver,
      approvedAt: at,
      ...(hookPaths === undefined ? {} : { approvedHookPaths: [...hookPaths] }),
      updatedAt: at,
    },
    events: [{
      runId: patch.runId,
      at,
      kind: "patch-approved",
      // Break-glass is recorded as a positive fact — an absence is not an audit trail.
      detail: approver.kind === "user" ? approver.userId : "break-glass",
    }],
  };
}

/** The verdicts each verdict may still be revised to (`settlePatch`). */
const REVISIONS: Record<PatchFate["kind"], readonly PatchFate["kind"][]> = {
  closed: ["merged", "missed"],
  missed: ["merged"],
  merged: [],
};

/**
 * The forge's verdict on the change request a submitted patch reached: merged with its head,
 * merged without it (`missed`), or closed. Not a state change — `submitted` stays terminal — but
 * the fate recorded beside it, once: a redelivery of the same verdict is refused, and so is a
 * verdict for a patch that never reached the forge.
 *
 * A verdict may be revised only toward more of the work having landed: closed → merged or
 * missed, and missed → merged. A person can reopen a closed GitHub pull request and merge it,
 * and a merge record's heads may grow (a later event or the forge's read naming a head an earlier
 * word did not), against which a `missed` is judged again: each is then the LAST word about work
 * that really did land, and refusing it would leave the run's claims dropped for code that is now
 * on the default branch. Nothing goes the other
 * way: merged → anything is GitHub's ordinary "closed after merge" noise or an older merge
 * arriving late, and a redelivery of a verdict already recorded is a duplicate either way.
 *
 * The acknowledgement is cleared with the revision on purpose: memory heard "dropped" and now
 * has to hear "landed", so the reconciliation must see this patch as owing a report again. So is
 * the merge's cue (`mergedCuedAt`): a missed patch's note said its commits did not merge, and the
 * run is owed the one that says they did.
 *
 * A merge's verdict, merged or missed, owes its landing (`landingAskedAt` null) until the store
 * answers it. `merge`, on a merge's verdict only: `mergedInto`, the branch the forge named
 * (its merge record's, core/merge_settle.ts `reconcileMergeSettles`), kept on the verdict so a landing that
 * failed after this write can still be made (core/merge_settle.ts `reconcileMergedLandings`);
 * and `unproven`, a `missed` nobody proved, kept on the verdict for the run's note.
 */
export function settlePatch(
  patch: Patch,
  fate: PatchFate["kind"],
  at: string,
  merge?: { mergedInto: string | undefined; unproven?: boolean },
): PatchTransitionOutcome {
  if (patch.state !== "submitted") {
    return { kind: "refused", why: `patch is ${patch.state}, not submitted` };
  }
  if (patch.landed !== null && !REVISIONS[patch.landed.kind].includes(fate)) {
    return { kind: "refused", why: `patch already ${patch.landed.kind}` };
  }
  const merged = fate !== "closed";
  return {
    kind: "applied",
    patch: {
      ...patch,
      landed: {
        kind: fate,
        at,
        ...(merged && merge?.mergedInto !== undefined ? { mergedInto: merge.mergedInto } : {}),
        ...(fate === "missed" && merge?.unproven === true ? { unproven: true as const } : {}),
      },
      memoryFateReportedAt: null,
      mergedCuedAt: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      updatedAt: at,
    },
    events: [{ runId: patch.runId, at, kind: "patch-settled", detail: fate }],
  };
}

/** A human says no: pending_approval → rejected. Terminal — the work was read and declined,
 * which is a different outcome from a lost run, and the state machine says so. */
export function rejectPatch(
  patch: Patch,
  rejecter: PatchApprover,
  at: string,
): PatchTransitionOutcome {
  if (patch.state !== "pending_approval") {
    return { kind: "refused", why: `patch is ${patch.state}, not pending_approval` };
  }
  return {
    kind: "applied",
    patch: { ...patch, state: "rejected", updatedAt: at },
    events: [{
      runId: patch.runId,
      at,
      kind: "patch-rejected",
      detail: rejecter.kind === "user" ? rejecter.userId : "break-glass",
    }],
  };
}

/** A newer patch for the same task AND repo replaces a not-yet-submitted one. The caller
 * narrows to the repo: a set's other members are other repos' answers, not stale ones.
 *
 * `failed` too only when the caller says so: a birth, whose patch holds at least the failed one's
 * commits (docs/patch-lifecycle.md "Landing"). */
export function supersedePatch(
  patch: Patch,
  byPatchId: string,
  at: string,
  opts: { failed?: boolean } = {},
): PatchTransitionOutcome {
  if (
    patch.state !== "pending_approval" && patch.state !== "queued" &&
    !(opts.failed === true && patch.state === "failed")
  ) {
    return { kind: "refused", why: `patch is ${patch.state}; only waiting patches supersede` };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "superseded",
      supersededByPatchId: byPatchId,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: at,
    },
    events: [{ runId: patch.runId, at, kind: "patch-superseded", detail: byPatchId }],
  };
}

/**
 * A `local` patch changes git hook files nobody approved: queued | submitting → pending_approval,
 * with the forge's answer recorded and any approval CLEARED. The patch lands as a branch the
 * owner will check out, and a hook file in a tracked folder runs on that checkout — an agent's
 * code on the owner's computer — so it waits for a person whatever the repo's policy says, and
 * an approval given before these files were known approved something else. The lease and any
 * clock go with it: nothing is in flight, and nothing is due until a person says so. A hold at
 * delivery (from `submitting`) hands back the attempt `markSubmitting` took: nothing failed, so
 * a later real failure keeps its whole retry budget.
 */
export function holdPatch(
  patch: Patch,
  check: PatchHookCheck,
  at: string,
): PatchTransitionOutcome {
  if (patch.state !== "queued" && patch.state !== "submitting") {
    return { kind: "refused", why: `patch is ${patch.state}, not queued/submitting` };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "pending_approval",
      hookCheck: { ...check, touched: [...check.touched], hooksPaths: [...check.hooksPaths] },
      attempts: patch.state === "submitting" ? Math.max(0, patch.attempts - 1) : patch.attempts,
      approvedBy: null,
      approvedAt: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: at,
    },
    events: [heldEvent(patch, check, at)],
  };
}

/** The run's record that a patch waits for a person over its git hook files. */
function heldEvent(patch: Patch, check: PatchHookCheck, at: string): RunEvent {
  return {
    runId: patch.runId,
    at,
    kind: "patch-held",
    detail: `git hooks: ${check.touched.join(", ")}${check.more ? ", and more" : ""}`
      .slice(0, 500),
  };
}

/** Whether a hook check found git hook files a person has to look at. */
export function touchesHooks(check: PatchHookCheck | null): boolean {
  return check !== null && (check.touched.length > 0 || check.more);
}

/**
 * The forge's first word on a `local` patch's git hook files, while it waits to be delivered
 * (pending_approval or queued, never asked before). Hooks touched on a `queued` patch hold it
 * (`holdPatch`): nobody approved them, under `auto` least of all. Anything else is only recorded
 * — a patch already waiting for a person is shown the files when they look (and its run's record
 * says so, a `patch-held` event as a hold's), and a clean answer lets a queued one go. An answer
 * ends the check's own retries (`failHookCheck`): its attempts, clock and error are cleared, since
 * none of them was a delivery.
 */
export function recordHookCheck(
  patch: Patch,
  check: PatchHookCheck,
  at: string,
): PatchTransitionOutcome {
  if (patch.state !== "pending_approval" && patch.state !== "queued") {
    return { kind: "refused", why: `patch is ${patch.state}; only a waiting patch is checked` };
  }
  if (patch.hookCheck !== null) return { kind: "refused", why: "already checked" };
  const answered = { ...patch, attempts: 0, nextAttemptAt: null, lastError: null };
  if (patch.state === "queued" && touchesHooks(check)) return holdPatch(answered, check, at);
  return {
    kind: "applied",
    patch: {
      ...answered,
      hookCheck: { ...check, touched: [...check.touched], hooksPaths: [...check.hooksPaths] },
      updatedAt: at,
    },
    events: touchesHooks(check) ? [heldEvent(patch, check, at)] : [],
  };
}

/** How `failHookCheck` opens a patch's `lastError`: what tells a failed hook check's reason
 * apart from any other on a patch (`hookCheckErrorOf`). */
const HOOK_CHECK_FAILED = "the git hook check failed: ";

/**
 * Why a waiting patch's hook check could not be answered, as the forge put it — null when it was
 * answered, never asked, only unanswered so far (an unreachable forge spends nothing and records
 * nothing), or the patch is no longer waiting. A `pending_approval` patch carrying one is asked
 * about again only on its backoff clock and is never failed for it (`failHookCheck`), so the
 * person deciding is the one who has to hear it: approved, it is asked at once, and a terminal
 * answer then fails it with this reason, undelivered.
 */
export function hookCheckErrorOf(patch: Patch): string | null {
  if (patch.hookCheck !== null) return null;
  if (patch.state !== "pending_approval" && patch.state !== "queued") return null;
  if (patch.lastError === null || !patch.lastError.startsWith(HOOK_CHECK_FAILED)) return null;
  return patch.lastError.slice(HOOK_CHECK_FAILED.length);
}

/**
 * The forge could not answer a waiting `local` patch's hook check, and said so in a way that
 * counts: `terminal` (it never will — the bundle gone, the branch it lands on deleted, too many
 * paths) or an answer this could not read. A check nobody can answer must not leave the patch
 * waiting forever, so each such answer spends one of the patch's attempts and sets a backoff
 * clock, as a failed delivery does. A `queued` patch FAILS (no clock: a person decides) on a
 * terminal answer or once its attempts are gone — `lastError` says why, and nothing was pushed.
 * A `pending_approval` one never fails here: a failed patch's retry skips the approval it is
 * still waiting for. It keeps the clock and the reason, and its approval asks again at once.
 */
export function failHookCheck(
  patch: Patch,
  error: SubmitError,
  at: string,
  cfg: PatchSubmitConfig = DEFAULT_PATCH_SUBMIT_CONFIG,
): PatchTransitionOutcome {
  if (patch.state !== "pending_approval" && patch.state !== "queued") {
    return { kind: "refused", why: `patch is ${patch.state}; only a waiting patch is checked` };
  }
  if (patch.hookCheck !== null) return { kind: "refused", why: "already checked" };
  const attempts = patch.attempts + 1;
  const lastError = `${HOOK_CHECK_FAILED}${error.message}`.slice(0, 2_000);
  if (patch.state === "queued" && (error.terminal || attempts >= cfg.maxAttempts)) {
    return {
      kind: "applied",
      patch: {
        ...patch,
        state: "failed",
        attempts,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError,
        updatedAt: at,
      },
      events: [{
        runId: patch.runId,
        at,
        kind: "patch-submit-failed",
        detail: `terminal: ${lastError}`.slice(0, 500),
      }],
    };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      attempts,
      nextAttemptAt: new Date(
        Date.parse(at) + Math.min(cfg.baseBackoffMs * 2 ** (attempts - 1), cfg.maxBackoffMs),
      ).toISOString(),
      lastError,
      updatedAt: at,
    },
    events: [],
  };
}

/** A human re-queues a failed patch without waiting out its clock (or after a terminal
 * failure, which set no clock). failed → queued. */
export function retryPatch(patch: Patch, at: string): PatchTransitionOutcome {
  if (patch.state !== "failed") {
    return { kind: "refused", why: `patch is ${patch.state}, not failed` };
  }
  return {
    kind: "applied",
    patch: { ...patch, state: "queued", nextAttemptAt: null, updatedAt: at },
    events: [],
  };
}

export interface PatchSubmitConfig {
  /** How long a submitter may hold a patch before the sweep reclaims it. */
  leaseMs: number;
  /** First retry delay; doubles per attempt. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** After this many attempts a retryable failure stops setting a clock — a human decides. */
  maxAttempts: number;
}

export const DEFAULT_PATCH_SUBMIT_CONFIG: PatchSubmitConfig = {
  leaseMs: 2 * 60_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  maxAttempts: 8,
};

/**
 * The submitter takes the lease: queued | failed → submitting. Records INTENT — the forge
 * call that follows is delivery, and is free to fail. Refuses while a backoff clock is still
 * running, so a sweep racing the clock cannot burn attempts early.
 */
export function markSubmitting(
  patch: Patch,
  at: string,
  cfg: PatchSubmitConfig = DEFAULT_PATCH_SUBMIT_CONFIG,
): PatchTransitionOutcome {
  if (patch.state !== "queued" && patch.state !== "failed") {
    return { kind: "refused", why: `patch is ${patch.state}, not queued/failed` };
  }
  if (patch.nextAttemptAt !== null && Date.parse(patch.nextAttemptAt) > Date.parse(at)) {
    return { kind: "refused", why: `next attempt is not due until ${patch.nextAttemptAt}` };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "submitting",
      attempts: patch.attempts + 1,
      leaseExpiresAt: new Date(Date.parse(at) + cfg.leaseMs).toISOString(),
      updatedAt: at,
    },
    events: [],
  };
}

/** Delivery succeeded: submitting → submitted, carrying the forge-side identity. Terminal. */
export function markSubmitted(
  patch: Patch,
  /** `url` is null where the forge has no web address for the change — a Radicle deployment
   * with no explorer configured, where the change request's id IS its address. The ref is
   * never null: without it the patch has no forge identity and cannot be settled. `branch` is
   * where the commits now sit (`forgeBranchOf`), `diffRef` what the submission measured them
   * against (`submissionTarget`). */
  forge: { ref: string; url: string | null; branch: string; diffRef: string },
  at: string,
): PatchTransitionOutcome {
  if (patch.state !== "submitting") {
    return { kind: "refused", why: `patch is ${patch.state}, not submitting` };
  }
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "submitted",
      forgeRef: forge.ref,
      forgeUrl: forge.url,
      forgeBranch: forge.branch,
      diffRef: forge.diffRef,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: null,
      updatedAt: at,
    },
    events: [{ runId: patch.runId, at, kind: "patch-submitted", detail: forge.url ?? forge.ref }],
  };
}

/** How delivery failed. The two kinds look identical at the call site and must not be
 * treated alike: retrying a permanent refusal only burns the rate limit. */
export interface SubmitError {
  message: string;
  /** True for e.g. a 403 on the repo or a deleted base ref; false for 502s, timeouts,
   * rate limits, the forge being down. */
  terminal: boolean;
}

/**
 * Delivery failed: submitting → failed. Retryable errors get a clock (exponential backoff);
 * terminal errors — and exhausted attempts — get none, and wait for a human. Both remain
 * retryable by that human always; `failed` never strands work.
 */
export function markFailed(
  patch: Patch,
  error: SubmitError,
  at: string,
  cfg: PatchSubmitConfig = DEFAULT_PATCH_SUBMIT_CONFIG,
): PatchTransitionOutcome {
  if (patch.state !== "submitting") {
    return { kind: "refused", why: `patch is ${patch.state}, not submitting` };
  }
  const clock = !error.terminal && patch.attempts < cfg.maxAttempts
    ? new Date(
      Date.parse(at) +
        Math.min(cfg.baseBackoffMs * 2 ** (patch.attempts - 1), cfg.maxBackoffMs),
    ).toISOString()
    : null;
  return {
    kind: "applied",
    patch: {
      ...patch,
      state: "failed",
      nextAttemptAt: clock,
      leaseExpiresAt: null,
      lastError: error.message,
      updatedAt: at,
    },
    events: [{
      runId: patch.runId,
      at,
      kind: "patch-submit-failed",
      detail: `${error.terminal ? "terminal" : "retryable"}: ${error.message}`.slice(0, 500),
    }],
  };
}

/**
 * What memory is owed about this patch's change, or null while nothing is settled yet.
 *
 * The one place the question "is this work over?" is answered for memory, because four
 * different call sites ask it and a run's `introduced` claims wait on the answer:
 * - the pull request closed, merged or not — the fate the forge declared
 * - a human rejected the patch, or a newer one superseded it
 * - delivery failed with no clock left: a terminal forge error, or attempts exhausted. That is
 *   not a state the patch leaves on its own — only a human retry moves it — so leaving memory
 *   waiting there means waiting forever. A later human retry that lands is not lost either:
 *   memory settles a run's change once, and the patch is asked about again only if it settles
 *
 * `failed` WITH a clock is deliberately null: the next sweep will try again, and telling memory
 * the change was dropped between two attempts would settle it on a patch still in flight.
 */
export function patchFateForMemory(patch: Patch): MemoryChangeFate | null {
  if (patch.landed !== null) return patch.landed.kind === "merged" ? "landed" : "dropped";
  if (patch.state === "rejected" || patch.state === "superseded") return "dropped";
  if (patch.state === "failed" && patch.nextAttemptAt === null) return "dropped";
  return null;
}

export type PatchSweepAction =
  | { kind: "none" }
  /** The patch is due: take the lease (markSubmitting) and deliver. */
  | { kind: "submit" }
  /** A submitter died mid-flight: its lease expired, hand the patch back to the queue. */
  | { kind: "reclaim"; patch: Patch }
  /** A failed patch's clock ran out: back to the queue for the next submit. */
  | { kind: "requeue"; patch: Patch };

/**
 * The sweep's per-patch decision, pure so it can be tested against a fake clock — sits
 * beside `planSweep` in the reaper, same contract, same best-effort discipline.
 */
export function planPatchSweep(patch: Patch, nowMs: number, at: string): PatchSweepAction {
  switch (patch.state) {
    case "queued":
      if (patch.nextAttemptAt === null || Date.parse(patch.nextAttemptAt) <= nowMs) {
        return { kind: "submit" };
      }
      return { kind: "none" };
    case "submitting":
      if (patch.leaseExpiresAt !== null && Date.parse(patch.leaseExpiresAt) <= nowMs) {
        return {
          kind: "reclaim",
          patch: { ...patch, state: "queued", leaseExpiresAt: null, updatedAt: at },
        };
      }
      return { kind: "none" };
    case "failed":
      if (patch.nextAttemptAt !== null && Date.parse(patch.nextAttemptAt) <= nowMs) {
        return {
          kind: "requeue",
          patch: { ...patch, state: "queued", nextAttemptAt: null, updatedAt: at },
        };
      }
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}
