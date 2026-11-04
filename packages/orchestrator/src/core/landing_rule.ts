// The landed-generation rule (docs/patch-lifecycle.md "Landing"): a patch whose generation
// already landed through a sibling is never delivered on its own. Applied where one could get
// out — at the merge to the run's waiting siblings, in the submit sweep after its claim and again
// just before delivery, at a birth to the newborn itself, when a person approves or retries — and
// reconciled on every submit sweep (`reconcileLandingRule`), since each of those reads a snapshot
// a racing merge can slip past. One of two answers, written over the row exactly as it was read
// (its version), with its event in the same write:
//
// - superseded, by the newest patch of the branch that is newer than it — the next generation
//   the runner carried its commits into, a newer waiting patch of its own generation, or the
//   merged sibling itself when that came after it — so a generation never holds two patches one
//   containing the other, nor holds work that already merged;
// - held: back at `pending_approval` whatever the repo's policy, its approval reset, the fixed
//   reason on it (`heldReasonFor`: a sibling merged, or the branch's change request merged
//   without it). Where approving would send it is not stored: it moves with the
//   task, and is read when the patch is shown (`heldDestinationOf`). A held patch of a live run
//   cannot be approved: the agent is asked to move its work onto what merged and submit again,
//   and that birth supersedes it (core/open_patch.ts). The run may end without one; then
//   a person may approve it, looking at its diff.
//
// A held patch's fate is still open, so memory hears nothing of it; a superseded one is dropped,
// and memory follows the claim to the patch that carries it.

import type { Diagnostics } from "../ports/diagnostics.ts";
import type { MemoryAccess } from "../ports/memory_access.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { InboxSignal } from "./inbox_signal.ts";
import { inCode, notifyPatch, notifyText } from "./inbox.ts";
import { hasLanding, lineBase } from "./landing.ts";
import { reportPatchFate } from "./conclude_run.ts";
import {
  heldDestination,
  heldReasonFor,
  isPatchWaiting,
  landedSiblingOf,
  landedVerdict,
  retireLanded,
  submissionTarget,
} from "./patch_lifecycle.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import type { ConnectedRepo, Patch, Task } from "./types.ts";

export interface LandingRuleDeps {
  store: TaskStore;
  diag: Diagnostics;
  memoryAccess?: Pick<MemoryAccess, "reportChange"> | null;
  inbox?: InboxSignal | null;
  now(): Date;
}

/** What the agent is told of a hold. Short and plain; the reason a person reads stays on the
 * patch. */
export function heldNote(
  patch: Patch,
  newborn: boolean,
  landed = true,
  ended: "merged" | "missed" = "merged",
): string {
  const which = newborn
    ? `The patch you just submitted for ${inCode(patch.path)}`
    : `Your patch for ${inCode(patch.path)} (head ${inCode(patch.headSha.slice(0, 7))})`;
  // Said as it happened: a patch of the branch merged, or the branch's change request merged
  // without any of its patches.
  const what = ended === "merged"
    ? "a patch of that branch merged"
    : "that branch's change request merged without any of its patches";
  // With no landing recorded the run is never told where to move its commits, and submitting
  // again only makes another patch to hold: a person decides.
  if (!landed) {
    return `${which} is on hold: ${what}, but ryph could not tell where, so it waits for a ` +
      "person.";
  }
  return `${which} is on hold: ${what} before it was sent. Rebase its work onto what merged, ` +
    "as the message about the merge says, then call submit_patch now, so it goes out " +
    (ended === "merged" ? "on top of what merged." : "from where the repo stands now.");
}

/** The note to a run whose merged change request could be let go but not landed: its cue never
 * comes, and its later patches of that generation are held. */
export function releasedNote(path: string): string {
  return `The change request for ${inCode(path)} merged, but ryph could not tell where, so ` +
    "further patches of this repository wait for a person.";
}

/** Where approving held `patch` would send it now, as the submission would: read when it is
 * shown, never stored, since the task moves under it. */
export function heldDestinationOf(
  task: Pick<Task, "repos" | "targetChangeRequest" | "landings">,
  repo: Pick<ConnectedRepo, "provider"> | null,
  patches: readonly Patch[],
  patch: Patch,
): string {
  const entry = task.repos.find((r) =>
    r.connectedRepoId === patch.connectedRepoId && r.path === patch.path
  );
  let base = entry === undefined
    ? "its base"
    : lineBase(entry, task.landings, patch.line, patch.runId);
  try {
    if (entry !== undefined) base = normalizeBaseRef(base).localBranch;
  } catch {
    // a base no branch spells: named as the task holds it
  }
  return heldDestination(
    submissionTarget(task, patches, patch, base, repo?.provider ?? "github"),
  );
}

/**
 * Applies the rule to one patch, read as it is (and, for one the sweep claimed, under its
 * `lease`). Answers whether the patch was caught — true even when another writer got to it
 * first, since either way it must not go on as it was. `newborn`: the patch was just born, and
 * the agent is told of THIS patch rather than an earlier one.
 */
export async function applyLandingRule(
  deps: LandingRuleDeps,
  patch: Patch,
  patches: readonly Patch[],
  at: string,
  opts: { lease?: string; newborn?: boolean } = {},
): Promise<boolean> {
  // A patch the sweep is delivering is the sweep's alone: only the holder of its lease rules it
  // (after its claim, and again before delivery). Anyone else leaves it to that sweep.
  if (patch.state === "submitting" && opts.lease === undefined) return false;
  // The task's landings too: a release of the run ends its generation as a landing does.
  const task = await deps.store.getTask(patch.taskId);
  const verdict = landedVerdict(patch, patches, task?.landings ?? {});
  if (verdict.kind === "none") return false;
  const sibling = landedSiblingOf(patches, patch);
  const next = retireLanded(patch, verdict, at, heldReasonFor(sibling));
  if (next.kind === "refused") return true;
  // The retirement and its event in one transaction: a redelivery that finds the row moved
  // writes nothing, so an event lost after the write would be lost for good.
  if (
    !await deps.store.savePatchIfState(
      next.patch,
      [patch.state],
      opts.lease,
      patch.version,
      next.events,
    )
  ) {
    deps.diag.debug("patch.landing_rule_lost", { patchId: patch.id, state: patch.state });
    return true;
  }
  // What follows is best-effort, and lost with a crash here: the agent's note (its next read
  // of the patch says the same), and memory's fate, which the reaper redelivers for a
  // superseded patch until memory acknowledges it.
  // A held patch may still go out, so its fate stays open, and the run is told in words alone
  // (`notifyText`). A replaced one is dropped as a patch, and memory follows the claim to the
  // patch that carries it.
  if (verdict.kind === "superseded") {
    await reportPatchFate(deps, next.patch, "dropped");
    await notifyPatch(
      deps,
      next.patch,
      "superseded",
      verdict.by.landed?.kind === "merged"
        ? "its commits merged with a newer patch of the same branch"
        : "a newer patch of the same branch holds its commits",
      undefined,
      { newborn: opts.newborn === true },
    );
  } else {
    // A landing still owed (settled, not landed yet: the event's later step, or the landing
    // reconcile's) is coming, and its cue with it; only one asked and not recorded is unknown.
    const owed = sibling?.landingAskedAt === null;
    const landed = owed || (task !== null && hasLanding(task.landings, patch));
    await notifyText(
      deps,
      patch.runId,
      heldNote(
        patch,
        opts.newborn === true,
        landed,
        sibling?.landed?.kind === "merged" ? "merged" : "missed",
      ),
    );
  }
  deps.diag.debug("patch.landing_rule", { patchId: patch.id, verdict: verdict.kind });
  return true;
}

/**
 * At a merge: every waiting patch of the merged patch's run that the merge just caught — the
 * same repo, path, line and generation. The one the sweep holds is left to the sweep, which asks the
 * same question after its claim and again before it delivers. `snapshot`: the task's patches as
 * the caller read them. Answers whether the rule wrote (or lost a write), so the caller knows
 * its snapshot went stale.
 */
export async function settleLandedSiblings(
  deps: LandingRuleDeps,
  merged: Patch,
  at: string,
  snapshot?: readonly Patch[],
): Promise<boolean> {
  const patches = snapshot ?? await deps.store.patchesForTask(merged.taskId);
  let wrote = false;
  for (const patch of patches) {
    if (
      patch.runId !== merged.runId || patch.connectedRepoId !== merged.connectedRepoId ||
      patch.path !== merged.path || patch.line !== merged.line ||
      patch.generation !== merged.generation ||
      !isPatchWaiting(patch)
    ) continue;
    // Caught, or lost to another writer: either way the snapshot no longer holds.
    if (await applyLandingRule(deps, patch, patches, at)) wrote = true;
  }
  return wrote;
}

/** How many patches one reconcile rules. A merge catches at most a handful; the rest wait a tick. */
export const LANDING_RECONCILE_LIMIT = 50;

/**
 * The rule's backstop, on every submit sweep: every waiting patch it still has an answer for
 * (`listPatchesDueLandingRule`), ruled over a fresh read of its task. The entry points (a
 * merge, a birth, a claim) each read a snapshot, and a merge that commits between another's read
 * and write is invisible to it — a birth that read before the merge leaves its newborn unruled,
 * a merge that read before the birth leaves the older patch held beside its replacement. Each
 * write is over the row as read (its version), so a reconcile racing an entry point writes once,
 * and a row it lost is due again next tick. Never throws.
 */
export async function reconcileLandingRule(
  deps: LandingRuleDeps,
  limit = LANDING_RECONCILE_LIMIT,
): Promise<void> {
  let due: Patch[];
  try {
    due = await deps.store.listPatchesDueLandingRule(limit);
  } catch (err) {
    deps.diag.warn("patch.landing_reconcile_failed", { err: String(err) });
    return;
  }
  const byTask = Map.groupBy(due, (p) => p.taskId);
  for (const [taskId, mine] of byTask) {
    try {
      const patches = await deps.store.patchesForTask(taskId);
      for (const { id } of mine) {
        const patch = patches.find((p) => p.id === id);
        if (patch === undefined || !isPatchWaiting(patch)) continue;
        if (await applyLandingRule(deps, patch, patches, deps.now().toISOString())) {
          deps.diag.debug("patch.landing_reconciled", { patchId: id });
        }
      }
    } catch (err) {
      deps.diag.warn("patch.landing_reconcile_failed", { taskId, err: String(err) });
    }
  }
}
