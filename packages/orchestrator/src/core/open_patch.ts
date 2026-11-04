// Patch birth, shared by the two doors a patch can arrive through: the runner's result (one
// per shipped branch, at the end) and the runner's mid-run patch route (one per submit, while
// the agent keeps working). Both are the same event — a bundle the gateway already holds
// becomes a row — and the rules must not drift between them:
//
// - WHETHER a patch is opened is driven by the PRESENCE of a BranchOutcome, never a status
// - a run whose agent may not open patches opens none, whatever its runner reports: the runner
//   hiding its tools is the courtesy, this refusal is the boundary. The agent is read LIVE, not
//   off the run's frozen work item: switching patches off must stop runs already going
// - only a connected repo's branch qualifies, and only one the TASK checked out: a container
//   cannot open a patch against a repo its run never held, whatever id it reports
// - the LINE the runner reports must be the one its branch's name parses to under the run's
//   namespace (@ryph/shared/lines) — the forge's intake held the bundle to the same shape — and a
//   run ships at most MAX_LINES_PER_REPO lines per repo: the runner refuses a ninth itself, and
//   this is the backstop
// - a run on a fork pull request's head (`worksForkHead`) ships its default line only: it
//   delivers onto that pull request or nowhere, and a line of its own would be a change request
//   of the contributor's code in this repo. The runner refuses one itself; this is the boundary,
//   and the reaper's fork guard and the forge's `pull/` base refusal stand behind it
// - idempotent at birth on (repo, head): the same head is the same work, so a result that
//   lists a branch the mid-run route already opened ADOPTS the row rather than doubling it
// - a newer patch supersedes a still-waiting one for the same task, repo, LINE and generation:
//   the user asked once, the newest answer is the answer (a failed one too when it is the same run
//   and path, whose commits the newer one holds) — and, of the same run, path and line, a waiting
//   one
//   (held, queued or failed) of an EARLIER generation that landed through a sibling: the
//   agent's move onto what merged carried its commits into this one (docs/
//   patch-lifecycle.md "Landing"). A patch of an earlier generation that did not land is
//   nothing to replace, and a patch of ANOTHER line never is: lines are independent work
// - a newborn of a generation that already landed (the run submitted before it heard of the
//   merge) gets the landing rule itself, like any other patch of it
// - every replacement is written over the row exactly as it was read: the submit sweep may hold
//   one, and a person may be deciding on another
// - what a patch carries is the runner's reading of its commits — every earlier head it holds,
//   the full list each time — mapped from heads onto THIS run's patches of the same repo, path and
//   line, and only those: a head names no patch of another run. It is kept on the row and repeated on
//   the patch's fate report
// - memory hears of every birth (a change per patch, with what it carries), best-effort
// - every birth asks for its head's checks (core/checks.ts), best-effort

import { mintId } from "@ryph/sealed";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { MemoryAccess } from "../ports/memory_access.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { InboxSignal } from "./inbox_signal.ts";
import type { ChecksService } from "./checks.ts";
import { notifyPatch } from "./inbox.ts";
import { reportPatchFate } from "./conclude_run.ts";
import {
  landedSiblingOf,
  openPatch,
  overlapReason,
  supersedePatch,
  UNCONFIRMED_REASON,
  unrebasedReason,
} from "./patch_lifecycle.ts";
import { hasLanding, landingOf, lineBase } from "./landing.ts";
import { applyLandingRule } from "./landing_rule.ts";
import { agentMayOpenPatches } from "./patch_permission.ts";
import { forgeRepoRef, runFacingRepoName } from "./forge_repo.ts";
import type { BranchOutcome, ConnectedRepo, Patch, Run, Task } from "./types.ts";
import type { Forge } from "../ports/forge.ts";
import { legacyRefusal } from "./legacy.ts";
import {
  DEFAULT_LINE,
  MAX_LINES_PER_REPO,
  parseLineBranch,
  runBundleKey,
} from "@ryph/shared/lines";
import { worksForkHead } from "./repo_entries.ts";

/** How many times a birth re-reads a patch it replaces whose write lost. Every loss is another
 * writer's progress, so a handful settles it; the reaper's reconcile catches any left over. */
const SUPERSEDE_ATTEMPTS = 5;

export interface OpenPatchDeps {
  store: TaskStore;
  diag: Diagnostics;
  memoryAccess?: Pick<MemoryAccess, "reportPatch" | "reportChange"> | null;
  inbox?: InboxSignal | null;
  /** Checks (core/checks.ts): a new patch's head gets a suite. Null/absent: none run here. */
  checks?: Pick<ChecksService, "patchOpened"> | null;
  /** Reads a newborn's lineage (`lineageReason`). Null/absent: it cannot be read, as when the
   * forge does not answer. */
  forge?: Pick<Forge, "patchLineage"> | null;
  now(): Date;
}

/** What a submit says about the branch beyond the outcome itself. */
export interface PatchBirth {
  branch: BranchOutcome;
  /** The commit the bundle was cut from, when the runner named it. */
  baseSha: string | null;
  title: string | null;
  description: string | null;
}

/**
 * The base a patch is born with: the runner's word, kept only when it names a commit as its head
 * does (lowercase hex of the head's own length), else null. A base is what the forge judges the
 * head's own work from when the change request merges (core/merge_settle.ts); a malformed one is
 * dropped rather than refused, since refusing the report would lose the work it carries.
 */
export function bornBase(baseSha: string | null, headSha: string): string | null {
  return baseSha !== null && baseSha.length === headSha.length &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseSha)
    ? baseSha
    : null;
}

/**
 * Why a newborn waits for a person on what its bundle holds, read by the forge
 * (`Forge.patchLineage`) rather than taken from the runner, which shares its container with the
 * agent; null when nothing says so. Two questions, each asked only where it can change the birth:
 *
 * - its line landed at an earlier generation: the next one must hold the tip the change request
 *   merged at (`RepoLanding.tip`), whether it would go out on its own or not, else it waits with
 *   `unrebasedReason`. A landing recorded with no tip (a release, the reconcile's backstop, an
 *   `into` the forge could not read) asks nothing: holding on it would hold every later birth of
 *   the line for as long as the landing stands.
 * - it would go out on its own (`autoEligible`): it must hold no commit of the run's other lines
 *   of the repo, each by its newest waiting patch — lines ship as change requests of their own,
 *   so one holding another's work repeats it.
 *
 * Neither asked, the forge is not asked: a first submit pays nothing. No answer holds a birth
 * that would otherwise go out on its own; one already waiting for a person waits as it is.
 */
async function lineageReason(
  deps: OpenPatchDeps,
  repo: ConnectedRepo,
  entry: Task["repos"][number],
  landings: Task["landings"],
  newborn: Pick<Patch, "runId" | "line" | "generation" | "bundleKey" | "branchName" | "headSha">,
  siblings: readonly Patch[],
  autoEligible: boolean,
): Promise<string | null> {
  const recorded = landingOf(landings, entry.path, newborn.line, newborn.runId);
  const landing = recorded !== undefined && recorded.connectedRepoId === repo.id &&
      newborn.generation > recorded.generation
    ? recorded
    : undefined;
  const newest = new Map<string, Patch>();
  if (autoEligible) {
    for (const p of siblings) {
      if (
        p.line === newborn.line || p.landed !== null || p.state === "rejected" ||
        p.state === "superseded"
      ) continue;
      const kept = newest.get(p.line);
      if (
        kept === undefined || p.generation > kept.generation ||
        (p.generation === kept.generation && p.createdAt > kept.createdAt)
      ) newest.set(p.line, p);
    }
  }
  const mustHold = landing?.tip;
  if (mustHold === undefined && newest.size === 0) return null;
  const answer = deps.forge
    ? await deps.forge.patchLineage(forgeRepoRef(repo), repo.url, {
      connectedRepoId: repo.id,
      targetRef: lineBase(entry, landings, newborn.line, newborn.runId),
      patch: newborn,
      others: [...newest.values()].map((p) => ({
        line: p.line,
        bundleKey: p.bundleKey,
        branchName: p.branchName,
        headSha: p.headSha,
      })),
      ...(mustHold === undefined ? {} : { mustHold }),
    })
    : { kind: "unavailable" as const, message: "no forge" };
  if (answer.kind === "unavailable") {
    deps.diag.warn("patch.lineage_unread", { runId: newborn.runId, why: answer.message });
    return autoEligible ? UNCONFIRMED_REASON : null;
  }
  if (landing?.tip !== undefined && answer.holdsTip === false) return unrebasedReason(landing.onto);
  return answer.overlaps.length > 0 ? overlapReason(answer.overlaps) : null;
}

export type OpenPatchOutcome =
  | { kind: "opened"; patch: Patch; adopted: false }
  | { kind: "adopted"; patch: Patch; adopted: true }
  /** The agent may not open patches, or the branch names a repo/path the task never held —
   * nothing to open. */
  | { kind: "refused"; reason: string };

/**
 * One shipped branch becomes a patch, or adopts the one that already is. `explicitSubmission`
 * allows an `auto` repo to skip approval only for work the agent explicitly submitted. Finalize
 * reports and result fallbacks always require approval, regardless of the run's outcome — and so
 * does any birth once the run's own state says it is finishing, whatever the runner reported.
 * Cancellation intent also keeps new work behind approval when observed at admission.
 */
export async function openPatchForRun(
  deps: OpenPatchDeps,
  run: Run,
  task: Task,
  birth: PatchBirth,
  setId: string,
  explicitSubmission: boolean,
  at: string,
): Promise<OpenPatchOutcome> {
  const { store, diag } = deps;
  const { branch } = birth;
  if (!await agentMayOpenPatches(store, run.agentId)) {
    diag.warn("patch.not_allowed", { runId: run.id, path: branch.path });
    return { kind: "refused", reason: "this run's agent may not open patches" };
  }
  if (branch.connectedRepoId === null) return { kind: "refused", reason: legacyRefusal(branch) };
  const entry = task.repos.find((r) =>
    r.connectedRepoId === branch.connectedRepoId && r.path === branch.path
  );
  if (entry === undefined) {
    diag.warn("patch.repo_not_in_task", {
      runId: run.id,
      connectedRepoId: branch.connectedRepoId,
      path: branch.path,
    });
    return { kind: "refused", reason: `the task did not check out ${branch.path}` };
  }
  const repo = await store.getConnectedRepo(branch.connectedRepoId);
  if (!repo) {
    diag.warn("patch.repo_missing", { runId: run.id, connectedRepoId: branch.connectedRepoId });
    return { kind: "refused", reason: `no such connected repo for ${branch.path}` };
  }
  // Disconnected while the run worked: nothing new is proposed to a repo the org let go of.
  // The bundle stays stored; reconnecting is a new connected repo, and a new run.
  if (repo.archivedAt !== null) {
    diag.warn("patch.repo_disconnected", { runId: run.id, connectedRepoId: repo.id });
    return { kind: "refused", reason: `${runFacingRepoName(repo)} was disconnected` };
  }

  // The line is the runner's word, and so is the branch's name; the two must agree, and the
  // name must be a line of THIS run's namespace — what the forge's intake held the bundle to.
  // Everything below keys on the line, so a report naming another would file the work under a
  // stream it never shipped on.
  // So is the generation, which the branch's name spells too: a report naming another would file
  // the work under a generation its branch never was. The name is kept bare, as the forge's
  // intake recorded it: a qualified `refs/heads/…` spelling of the same branch is the same branch.
  const name = branch.name.startsWith("refs/heads/")
    ? branch.name.slice("refs/heads/".length)
    : branch.name;
  const parsed = parseLineBranch(name, run.branchNamespace);
  if (parsed === null || parsed.line !== branch.line || parsed.generation !== branch.generation) {
    diag.warn("patch.line_mismatch", {
      runId: run.id,
      path: branch.path,
      line: branch.line,
      generation: branch.generation,
    });
    return {
      kind: "refused",
      reason: `the branch ${name} is not generation ${branch.generation} of line ` +
        `"${branch.line}" of this run's branches (${run.branchNamespace}/<line>)`,
    };
  }
  // A fork pull request's head delivers onto that pull request or nowhere: never a line of its
  // own, which would be a change request of its own in this repo. Refused before the row exists.
  if (worksForkHead(task.repos) && branch.line !== DEFAULT_LINE) {
    diag.warn("patch.fork_line_refused", { runId: run.id, path: branch.path, line: branch.line });
    return {
      kind: "refused",
      reason: `${branch.path} is a pull request from a fork, so this run ships only its line ` +
        `"${DEFAULT_LINE}", onto that pull request — never line "${branch.line}"`,
    };
  }
  const taskPatches = await store.patchesForTask(task.id);
  const ofThisRepo = taskPatches.filter((p) =>
    p.runId === run.id && p.connectedRepoId === repo.id && p.path === branch.path
  );
  // One head is one line's: another line of this run at the very same commit is the same work
  // shipped twice, which no reviewer could tell apart — and lines are unrelated work, each off
  // the base. Refused, naming the line that has it.
  const twin = ofThisRepo.find((p) => p.line !== branch.line && p.headSha === branch.headSha);
  if (twin !== undefined) {
    diag.warn("patch.head_on_other_line", {
      runId: run.id,
      path: branch.path,
      line: branch.line,
      other: twin.line,
    });
    return {
      kind: "refused",
      reason: `${branch.path}: line "${branch.line}" is at ${branch.headSha.slice(0, 12)}, the ` +
        `commit line "${twin.line}" already shipped; a line holds work of its own, so commit ` +
        `it on a branch started from the base, or submit it as "${twin.line}"`,
    };
  }
  // The cap, over the lines this run already shipped in this repo: a new line past it is refused,
  // one it has is never. Asked here for the message, and again as the row is written
  // (`createPatch`'s `maxLinesPerRepo`), where two births of new lines cannot both pass it.
  const lines = new Set(ofThisRepo.map((p) => p.line));
  const capRefusal = (count: number): OpenPatchOutcome => {
    diag.warn("patch.line_cap", { runId: run.id, path: branch.path, line: branch.line });
    return {
      kind: "refused",
      reason: `${branch.path} already has ${count} lines of work in this run, the most one ` +
        `run may ship in a repo; submit "${branch.line}" on one of them instead`,
    };
  };
  if (!lines.has(branch.line) && lines.size >= MAX_LINES_PER_REPO) return capRefusal(lines.size);

  // Idempotency at birth: the same head on the same repo is the same work — a result listing
  // a branch the mid-run route opened (and perhaps already submitted), a duplicate report, a
  // retry run that reproduced the identical commit — all adopt the existing row. Only a head a
  // person rejected, or a newer patch superseded, is open to a second row: that work was set
  // aside, and offering it again is a decision someone can take again.
  //
  // Never across generations of this run's line, nor across its lines. A fast-forward merge makes the merged tip the
  // next generation's base, so a generation that adds nothing can name the very head an older
  // generation's patch carries — and that patch is the landed generation's, which the rule below
  // never lets out. Adopting it would hand this generation's work to a patch that cannot ship.
  // Nor across runs but on the default line, the task's: another run's line of any other name is
  // its own work (core/landing.ts `landingKey`), and adopting its row would file this run's
  // report under a run that never shipped it.
  const found = await store.findPatchByRepoAndHead(repo.id, branch.headSha);
  const adoptable = found !== null &&
    (found.runId === run.id
      ? found.generation === branch.generation && found.line === branch.line
      : found.line === DEFAULT_LINE && branch.line === DEFAULT_LINE);
  // Of this run's own rows at the head, a live one first: a rejected or superseded twin found
  // first would read as nothing to adopt, and the report would open a row superseding the live one.
  const own = found === null || adoptable
    ? []
    : taskPatches.filter((p) =>
      p.runId === run.id && p.connectedRepoId === repo.id && p.headSha === branch.headSha &&
      p.line === branch.line && p.generation === branch.generation
    );
  const existing = found === null || adoptable
    ? found
    : own.find((p) => p.state !== "rejected" && p.state !== "superseded") ?? own[0] ?? null;
  if (existing !== null && existing.state !== "rejected" && existing.state !== "superseded") {
    diag.debug("patch.adopted_existing", { runId: run.id, patchId: existing.id });
    return { kind: "adopted", patch: existing, adopted: true };
  }

  const patchId = mintId("p");
  // The runner names earlier heads, the only thing it knows them by; memory knows patches.
  const carriedHeads = new Set(branch.carries);
  const carries = taskPatches.filter((p) =>
    p.runId === run.id && p.connectedRepoId === repo.id && p.path === branch.path &&
    p.line === branch.line && carriedHeads.has(p.headSha)
  ).map((p) => p.id);
  // Read again: a release since the caller read the task ends a generation too.
  const landings = (await store.getTask(task.id))?.landings ?? task.landings;
  for (const stale of taskPatches) {
    // Another line's patches are another stream of work: never replaced by this one.
    if (stale.connectedRepoId !== repo.id || stale.line !== branch.line) continue;
    // Nor is another run's line of the same name (other than the default, which is the task's):
    // the name is its run's own, and its work is unrelated (core/landing.ts `landingKey`).
    if (branch.line !== DEFAULT_LINE && stale.runId !== run.id) continue;
    const sameGeneration = stale.generation === branch.generation;
    const carried = stale.runId === run.id && stale.path === branch.path &&
      stale.generation < branch.generation &&
      (landedSiblingOf(taskPatches, stale) !== undefined ||
        hasLanding(landings, stale));
    if (!sameGeneration && !carried) continue;
    // A failed one too when it is this branch's own (same run and path): the newer patch holds at
    // least its commits (a branch's patches are cumulative), and a later retry of it would publish
    // them a second time. Another run's failed answer is not inside this one; it keeps its retry.
    const ownBranch = stale.runId === run.id && stale.path === branch.path;
    // Over the row as read; a write that lost reads it again and asks again, rather than
    // leaving a patch this birth replaces waiting beside it (a merge's hold, a sweep's claim
    // handed back, a person's approval: each may have moved it since the read).
    let current: Patch | null = stale;
    for (let attempt = 0; current !== null && attempt < SUPERSEDE_ATTEMPTS; attempt++) {
      const superseded = supersedePatch(current, patchId, at, { failed: ownBranch });
      if (superseded.kind !== "applied") break;
      const written = await store.savePatchIfState(
        superseded.patch,
        [current.state],
        undefined,
        current.version,
        superseded.events,
      );
      if (written !== null) {
        await reportPatchFate(deps, superseded.patch, "dropped");
        await notifyPatch(deps, superseded.patch, "superseded");
        break;
      }
      current = await store.getPatch(current.id);
    }
  }

  // Authentication's snapshot can predate cancellation (body parsing and the work above
  // await). Read intent at admission too; neither a stale caller nor a stale stored row may
  // undo cancellation already observed. A concurrent submit can still win admission.
  const currentRun = await store.getRun(run.id);
  const cancelled = run.desiredState === "cancelled" || currentRun?.desiredState === "cancelled";
  // Finalize is told by the run's own state, not by the runner's word (`requiresApproval`), which
  // the agent beside it could leave off: once a person asked the run to finish, the agent said it
  // finished, or the run reached its last phase, a birth is a finalize patch and waits for one.
  const finalizing = currentRun?.agentFinished === true || currentRun?.phase === "finalizing" ||
    await store.hasRunEvent(run.id, "finish-requested");
  const allowAutoApproval = explicitSubmission && !cancelled && !finalizing;
  const bundleKey = runBundleKey(run.id, repo.id, parsed, branch.headSha);
  const heldReason = await lineageReason(
    deps,
    repo,
    entry,
    landings,
    {
      runId: run.id,
      line: branch.line,
      generation: branch.generation,
      bundleKey,
      branchName: name,
      headSha: branch.headSha,
    },
    ofThisRepo,
    repo.submissionPolicy === "auto" && allowAutoApproval,
  );
  const opened = openPatch(
    {
      id: patchId,
      connectedRepoId: repo.id,
      runId: run.id,
      taskId: task.id,
      setId,
      path: branch.path,
      line: branch.line,
      branchName: name,
      headSha: branch.headSha,
      // Derived, not fetched: the gateway files bundles at exactly this key.
      bundleKey,
      baseSha: bornBase(birth.baseSha, branch.headSha),
      generation: branch.generation,
      title: birth.title,
      description: birth.description,
      commits: branch.commits,
      carries,
      heldReason,
    },
    repo.submissionPolicy,
    allowAutoApproval,
    at,
  );
  // The cap's race-free half: a birth that lost it to a concurrent one writes nothing. Only a
  // runner that submits two new lines at once gets here (its own submits take one lock), and
  // what this birth already replaced stays replaced — waiting patches of the same line, which a
  // new line of this run has none of.
  if (!await store.createPatch(opened.patch, { maxLinesPerRepo: MAX_LINES_PER_REPO })) {
    return capRefusal(MAX_LINES_PER_REPO);
  }
  for (const event of opened.events) await store.appendEvent(event);
  // Before approval, so an approver sees the verdict beside the diff — and the backstop for an
  // agent that never ran the checks itself. Cheap: a pending request, resolved on the tick.
  await deps.checks?.patchOpened(opened.patch);
  diag.debug("patch.opened", {
    runId: run.id,
    patchId,
    setId,
    state: opened.patch.state,
    repo: repo.repoRef,
    path: branch.path,
    line: branch.line,
    generation: branch.generation,
  });
  // Memory tracks a change per patch: the run's unbound `introduced` claims bind to this one.
  // Best-effort — the patch is durable either way, and the submit relays the same record again
  // with the pull request, which is a second chance for a report that did not land. What it
  // carries is on the row, and the fate report (which is reconciled) says it once more.
  if (deps.memoryAccess) {
    await deps.memoryAccess.reportPatch(run.id, {
      patchId,
      repo: entry.url,
      generation: branch.generation,
      headSha: branch.headSha,
      forgeUrl: null,
      carries,
    }).catch((err) =>
      diag.warn("memory.patch_report_failed", { runId: run.id, patchId, err: String(err) })
    );
  }
  // Last, once the row exists and memory knows it: born into a generation that already landed,
  // it is caught by the rule like any other patch of it — read afresh, so a merge that settled
  // since the read above counts. One that settles after THIS read rules the newborn itself (its
  // waiting siblings), and the reaper's reconcile is the backstop for every other interleaving.
  const fresh = await store.patchesForTask(task.id);
  await applyLandingRule(
    deps,
    fresh.find((p) => p.id === patchId) ?? opened.patch,
    fresh.some((p) => p.id === patchId) ? fresh : [...fresh, opened.patch],
    at,
    { newborn: true },
  );
  const born = await store.getPatch(patchId) ?? opened.patch;
  return { kind: "opened", patch: born, adopted: false };
}
