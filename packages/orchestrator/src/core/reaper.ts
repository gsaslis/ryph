// The reaper: the periodic sweep that turns silence into state.
// It walks every non-terminal run, asks the pure planner what to do, and enforces the answer
// through the ports — mark lost when heartbeats stopped, escalate a cancel the runner is
// ignoring into a provisioner-level kill.
//
// Invariants:
// - the sweep never throws: a throw on any single run is caught and warned, and the next sweep
//   re-lists and retries whatever it left undone
// - a graceful cancel-escalation kill is best-effort — a failure is warned and re-issued next sweep
// - a "lost" verdict kills the container *before* recording the loss, so a genuinely failed kill
//   propagates and keeps the run active to retry, and the record never outlives a container still
//   holding live credentials (an already-exited container counts as a successful kill)
// - a "lost" verdict also CONCLUDES the run's credentials, exactly as the runner's own report
//   does: a container the sweep could not reach may still have leaked its virtual keys, so the
//   one path that ends a run without a report is the one that most needs them dead

import type { TaskStore } from "../ports/task_store.ts";
import type { Provisioner } from "../ports/provisioner.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { Forge, GithubModeSource } from "../ports/forge.ts";
import type { IdentityDirectory } from "../ports/identity_directory.ts";
import type { RunnerControl } from "../ports/runner_control.ts";
import type { MemoryAccess } from "../ports/memory_access.ts";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import { sweepUnclaimedAttachments } from "./attachments.ts";
import {
  concludeRun,
  type ConcludeRunDeps,
  conclusionOverdue,
  patchUrlOf,
  releaseRunBinding,
  reportPatchFate,
  reportRunOutcome,
  type RunCredentialRevoker,
} from "./conclude_run.ts";
import { actsAsPerson, forgeRepoRef, runFacingText } from "./forge_repo.ts";
import { agentMayOpenPatches, patchMayShip } from "./patch_permission.ts";
import type { EnvironmentFeedback } from "./environment_feedback.ts";
import type { ChecksService } from "./checks.ts";
import { notifyPatch } from "./inbox.ts";
import { applyLandingRule, reconcileLandingRule } from "./landing_rule.ts";
import { lineBase } from "./landing.ts";
import { mergeVerdictPending } from "./merge_record.ts";
import { reconcileMergeReleases, releaseTarget } from "./merge_release.ts";
import { reconcileMergedLandings, reconcileMergeSettles, sweepMergedCues } from "./merge_settle.ts";
import {
  type MergePollConfig,
  pollChangeRequestEnds,
  pollChangeRequestSoon,
  recordRefusedMerge,
} from "./merge_poll.ts";
import type { InboxSignal } from "./inbox_signal.ts";
import { planSweep, type SweepConfig } from "./lifecycle.ts";
import type { RunSpendReader } from "./run_limits.ts";
import {
  failHookCheck,
  forgeBranchOf,
  holdPatch,
  markFailed,
  markSubmitted,
  markSubmitting,
  patchFateForMemory,
  type PatchSubmitConfig,
  planPatchSweep,
  recordHookCheck,
  submissionTarget,
  touchesHooks,
} from "./patch_lifecycle.ts";
import { composeProgressComment, composeReport } from "./report.ts";
import { FORGE_WRITE_TOOLS, forgeCapFor } from "./forge_tools.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import { worksForkHead } from "./repo_entries.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";
import { bodyToSend, summaryToSend } from "./image_refs.ts";
import {
  type ConnectedRepo,
  type ForgeProvider,
  type Patch,
  type ProgressComment,
  type Run,
  type RunState,
  TERMINAL_STATES,
} from "./types.ts";

export interface ReaperDeps {
  store: TaskStore;
  provisioner: Provisioner;
  diag: Diagnostics;
  /** To revoke a lost run's credentials, and to read a capped run's spend for the limit arm.
   * Null/absent where the deployment has neither. */
  modelAccess?: (RunCredentialRevoker & Partial<RunSpendReader>) | null;
  toolAccess?: RunCredentialRevoker | null;
  /** Null/absent: no memory, so a lost run's outcome goes unreported. */
  memoryAccess?: ConcludeRunDeps["memoryAccess"];
  /** Null/absent: no chat service, so a lost run's room hears nothing. */
  chatAccess?: ConcludeRunDeps["chatAccess"];
  /** Where run images live, for the retention sweep of uploads no message carried
   * (core/attachments.ts `sweepUnclaimedAttachments`). Null/absent: rows are still swept, and
   * there are no blobs to delete. */
  attachmentStore?: AttachmentStore | null;
  appUrl?: string | null;
  /** Pushes an idle-expired run's cancel to its container; absent, the heartbeat's answer
   * carries it — the same two channels a user's cancel has. */
  runnerControl?: RunnerControl | null;
  /**
   * The backstop for a run waiting on an environment build: the build's settle hook launches
   * or refuses its waiters, but a replica that died between the two leaves a run waiting on a
   * build that is long over. Called for every waiting run each tick; absent where environments
   * are not built (no run ever waits there).
   */
  settleWaitingRun?: ((run: Run) => Promise<void>) | null;
  now(): Date;
  /**
   * Reconcile the container runtime against the runs the store still considers active.
   *
   * Set for the docker backend, the one where a run leaves anything behind that the store does
   * not name: its stopped agent container, its network and its services. A Kubernetes Job cascades.
   * It is a callback rather than a `Provisioner` method for that reason — the composition root
   * knows which adapter it built, and the others have nothing to do.
   *
   * On the SWEEP and not only at boot, which is the part that was wrong before: `kill` runs for
   * a run that is lost or cancelled, and a run that simply FINISHES never reaches it. Its
   * services would keep running and its network stay allocated until the control plane next
   * restarted — so a deployment leaked a Postgres per successful run, and hit docker's ~31
   * network ceiling on ordinary success rather than on any failure.
   *
   * Handed a LISTER rather than a list, and the implementation must call it only after it has
   * enumerated the runtime. Launches run concurrently with the sweep, and a run's row is
   * written before `launch` creates anything — so a store read taken after the enumeration
   * names every run whose objects that enumeration saw. A snapshot from the top of the tick
   * does not: a launch landing mid-sweep would have its network reclaimed out from under it.
   */
  reconcile?(listActiveRunIds: () => Promise<string[]>): Promise<void>;
}

export async function sweep(deps: ReaperDeps, cfg: SweepConfig): Promise<void> {
  const { store, provisioner, diag } = deps;
  const active = await store.listActiveRuns();
  const spends = await readSpends(active);

  // Each run is swept in isolation: a throw on one (a failing kill below is deliberately allowed
  // to propagate) must not abort the tick and starve the runs after it. The next tick re-lists
  // and retries whatever this one left undone.
  for (const run of active) {
    try {
      await sweepRun(run, spends.get(run.id) ?? null);
    } catch (err) {
      diag.warn("reaper.run_failed", { runId: run.id, err: String(err) });
    }
  }

  // Against the store as it stands when the reconcile asks, NOT `active` above: that snapshot
  // predates every launch that landed during the loop, and a run absent from it would have its
  // freshly created network and services reclaimed. See ReaperDeps.reconcile for the ordering.
  //
  // Last, and best-effort: reclaiming leftovers must never be the reason a liveness sweep did
  // not happen.
  if (deps.reconcile) {
    await deps.reconcile(async () => (await store.listActiveRuns()).map((run) => run.id))
      .catch((err) => diag.warn("reaper.reconcile_failed", { err: String(err) }));
  }

  // The other reconciliation: patches whose fate memory never acknowledged. Rides this sweep
  // rather than the patch one because a settled patch is TERMINAL and the submitter only ever
  // lists active rows — and because the deps are already here. Last and best-effort, like the
  // runtime reconcile above.
  await sweepMemoryFates(deps).catch((err) =>
    diag.warn("reaper.memory_fates_failed", { err: String(err) })
  );
  await sweepMemoryOutcomes(deps).catch((err) =>
    diag.warn("reaper.memory_outcomes_failed", { err: String(err) })
  );
  await sweepStaleResponses(deps).catch((err) =>
    diag.warn("reaper.stale_responses_failed", { err: String(err) })
  );
  await sweepUnclaimedAttachments(deps).catch((err) =>
    diag.warn("reaper.unclaimed_attachments_failed", { err: String(err) })
  );
  // Sealed launch credentials nobody redeemed: a run cancelled or lost before it booted.
  await store.deleteExpiredBootstraps(deps.now().toISOString()).catch((err) =>
    diag.warn("reaper.expired_bootstraps_failed", { err: String(err) })
  );

  /**
   * Every capped run's spend as the proxy reports it, read in parallel before the loop so a
   * slow proxy costs the tick one timeout rather than one per run. A proxy that cannot answer
   * for a run is a null: the plan then cancels nothing over spend, and the proxy's own refusal
   * is what bounds the run until the next tick can count again. Asked only for a run the plan
   * could act on, a launched one not already asked to stop, since it is one call per run.
   */
  async function readSpends(runs: Run[]): Promise<Map<string, number | null>> {
    const spendOf = deps.modelAccess?.spendOf;
    const spends = new Map<string, number | null>();
    if (spendOf === undefined) return spends;
    const capped = runs.filter((run) =>
      run.limits.spendUsd !== null && run.launchedAt !== null &&
      run.desiredState !== "cancelled"
    );
    await Promise.all(capped.map(async (run) => {
      try {
        spends.set(run.id, await spendOf(run.id));
      } catch (err) {
        diag.warn("reaper.spend_read_failed", { runId: run.id, err: String(err) });
        spends.set(run.id, null);
      }
    }));
    return spends;
  }

  async function concludeCancelled(run: Run): Promise<void> {
    // Inspection/kill may have yielded to a runner report or its first heartbeat. Do not
    // overwrite either with the pre-start cancellation verdict.
    const current = await store.getRun(run.id);
    if (
      current === null || TERMINAL_STATES.has(current.state) || current.lastHeartbeatAt !== null
    ) {
      return;
    }
    const at = deps.now().toISOString();
    const cancelled = await store.saveRunTransition(
      { ...current, state: "cancelled", updatedAt: at },
      current,
    );
    if (cancelled === null) return;
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "cancel-confirmed",
      detail: "cancelled before the first heartbeat",
    });
    await concludeRun(deps, cancelled, at);
  }

  async function sweepRun(run: Run, spentUsd: number | null): Promise<void> {
    if (run.environmentWait !== null && run.handle === null) {
      if (deps.settleWaitingRun) {
        await deps.settleWaitingRun(run);
        return;
      }
      // Waiting on a build nothing here will ever finish: environments were turned off since
      // it started waiting. Refused, as a failed build would refuse it — never left waiting.
      const at = deps.now().toISOString();
      const refused = { ...run, state: "errored" as const, environmentWait: null, updatedAt: at };
      if (!(await store.saveRunIfWaiting(refused, run.environmentWait.environmentId))) return;
      await store.appendEvent({
        runId: run.id,
        at,
        kind: "environment.failed",
        detail: `environment ${run.environmentWait.environmentId} will not be built here any ` +
          "more (environments are off) — the run is not started",
      });
      return;
    }
    // A runner refused bootstrap after cancellation can never report its own end. Runtime
    // evidence beats the startup clock, but an unavailable runtime (unknown) proves nothing.
    if (
      run.desiredState === "cancelled" && run.lastHeartbeatAt === null &&
      run.handle !== null && await provisioner.inspect(run.handle) === "exited"
    ) {
      // Also ask to reclaim services. Docker cannot read a removed agent's run label;
      // in that case this tick's reconcile reclaims them after the run becomes terminal.
      await provisioner.kill(run.handle, { graceful: false });
      await concludeCancelled(run);
      return;
    }
    const action = planSweep(run, deps.now().getTime(), cfg, spentUsd);
    switch (action.kind) {
      case "none":
        break;

      case "mark-lost": {
        // Kill before recording the loss, not after. A lost run leaves the active set, so a kill
        // deferred until after the save has no retry if it fails — the container would outlive its
        // record with live credentials. Killing first means a failure throws before the run is
        // written off, leaving it active for the next tick to try again.
        if (run.handle !== null) await provisioner.kill(run.handle, { graceful: false });
        // The timeout is still the hard-kill backstop when inspection cannot confirm an exit.
        // A never-started run deliberately stopped by its user is cancelled, not lost.
        // If a first heartbeat landed during the kill, concludeCancelled leaves that live
        // row alone. The container is already killed; a runner result can still arrive,
        // otherwise the ordinary heartbeat timeout marks it lost on a later sweep.
        if (run.desiredState === "cancelled" && run.lastHeartbeatAt === null) {
          await concludeCancelled(run);
          break;
        }
        const lost = await store.saveRunTransition(action.run, run);
        if (lost === null) break;
        for (const event of action.events) await store.appendEvent(event);
        // The run is written off, so its credentials die with it — the same conclusion the
        // runner's own result would have triggered. Best-effort inside, so a gateway that is
        // down cannot keep the sweep from recording the loss it already persisted.
        // A run the reaper concluded delivered no result, so no patch was born from it.
        await concludeRun(deps, lost, deps.now().toISOString());
        diag.warn("reaper.lost", { runId: run.id });
        break;
      }

      case "idle-expired":
      case "limit-reached": {
        // The runner owns the idle clock and ends the run itself when it lapses; a run this
        // far past its own deadline stopped keeping it. A run past a limit is the same shape
        // with the orchestrator as the clock's owner. From here it is a cancel: recorded,
        // pushed where the provisioner can reach the container, and carried by the next heartbeat's
        // answer either way — then the kill above, once the cancel grace lapses too.
        // Guarded only by what the verdict rests on: a beat in the meantime does not undo a
        // spent limit, and only a moved idle deadline undoes an idle expiry.
        const cancellation = await store.requestRunCancel(
          run.id,
          action.run.updatedAt,
          action.kind === "idle-expired" ? { idleDeadlineAt: run.idleDeadlineAt } : undefined,
        );
        if (!cancellation.applied || cancellation.run === null) break;
        const target = cancellation.run;
        for (const event of action.events) await store.appendEvent(event);
        if (action.kind === "idle-expired") {
          diag.warn("reaper.idle_expired", { runId: run.id, idleDeadlineAt: run.idleDeadlineAt });
        } else {
          diag.warn("reaper.limit_reached", { runId: run.id, limit: action.events[0].detail });
        }
        if (deps.runnerControl) {
          const pushed = await deps.runnerControl.requestCancel(target);
          if (pushed) {
            await store.appendEvent({
              runId: run.id,
              at: deps.now().toISOString(),
              kind: "cancel-pushed",
            });
          }
        }
        break;
      }

      case "kill-graceful": {
        // Retry enforcement, not the transcript entry. A failed kill must remain retryable;
        // the durable event also survives a reaper restart without adding a schema marker.
        if (run.handle === null) break;
        diag.debug("reaper.kill_graceful", { runId: run.id });
        if (!(await store.hasRunEvent(run.id, "kill-requested"))) {
          await store.appendEvent({
            runId: run.id,
            at: deps.now().toISOString(),
            kind: "kill-requested",
            detail: "cancel grace period expired",
          });
        }
        await provisioner.kill(run.handle, { graceful: true }).catch((err) =>
          diag.warn("reaper.kill_failed", { runId: run.id, err: String(err) })
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The memory reconciliation: the fourth rider on the tick, and the only one that exists
// because a BEST-EFFORT call can be lost.
//
// Every other memory relay is fire-and-warn, and rightly so: a missed outcome is a missed
// confirmation, a missed staleness report is a check nobody ran. A missed CHANGE report is
// different in kind — the run's `introduced` claims sit in the inbox waiting for a fate that
// will never be asked for again, and the only person who can clear them is a human who does
// not know why they are there. So the fate is recorded on the patch when memory acknowledges
// it, and every settled patch missing that acknowledgement is redelivered here. Idempotent on
// the memory side (a repo's change settles once per run), so redelivery is free.
// ---------------------------------------------------------------------------

export interface MemoryFateDeps {
  store: Pick<TaskStore, "listPatchesAwaitingMemoryFate" | "markPatchFateReported">;
  diag: Diagnostics;
  /** Null/absent: no memory in this deployment, so there is nothing to reconcile. */
  memoryAccess?: ConcludeRunDeps["memoryAccess"];
  now(): Date;
}

export async function sweepMemoryFates(deps: MemoryFateDeps): Promise<void> {
  if (!deps.memoryAccess) return;
  const owed = await deps.store.listPatchesAwaitingMemoryFate();
  let relayed = 0;
  for (const patch of owed) {
    // A row can be listed and still owe nothing — a `failed` patch with its retry clock still
    // running is settled for nobody. The store's filter is the cheap half; this is the exact one.
    const fate = patchFateForMemory(patch);
    if (fate === null) continue;
    // Best-effort per patch, like every sweep here: the acknowledgement is written only when
    // the report lands, so a failure simply comes back on the next tick.
    await reportPatchFate(deps, patch, fate);
    relayed++;
  }
  if (relayed > 0) deps.diag.debug("reaper.memory_fates_relayed", { patches: relayed });
}

/**
 * How long a concluded run is left to its own result handler before the sweep redelivers its
 * outcome. The handler opens the run's patches and THEN reports, so a sweep that fired in
 * between would bind the run's unbound claims before its last patch was on record.
 */
export const MEMORY_OUTCOME_GRACE_MS = 5 * 60 * 1000;
/** Runs redelivered per tick, so a backlog drains without one tick carrying all of it. */
const MEMORY_OUTCOMES_PER_TICK = 50;

export interface MemoryOutcomeDeps {
  store: Pick<TaskStore, "listRunsAwaitingMemoryOutcome" | "markRunMemoryOutcomeReported">;
  diag: Diagnostics;
  memoryAccess?: ConcludeRunDeps["memoryAccess"];
  now(): Date;
}

/** The outcome half of the memory reconciliation: every concluded run whose report memory
 * never acknowledged is reported again. */
export async function sweepMemoryOutcomes(deps: MemoryOutcomeDeps): Promise<void> {
  if (!deps.memoryAccess) return;
  const before = new Date(deps.now().getTime() - MEMORY_OUTCOME_GRACE_MS).toISOString();
  const owed = await deps.store.listRunsAwaitingMemoryOutcome(before, MEMORY_OUTCOMES_PER_TICK);
  for (const run of owed) {
    await reportRunOutcome(deps, run, deps.now().toISOString());
  }
  if (owed.length > 0) deps.diag.debug("reaper.memory_outcomes_relayed", { runs: owed.length });
}

export interface StaleResponseDeps {
  store: Pick<TaskStore, "listOpenResponses" | "getRun" | "closeResponse">;
  diag: Diagnostics;
  /** Null/absent: no chat service, so no binding can have been left behind. */
  chatAccess?: ConcludeRunDeps["chatAccess"];
  now(): Date;
}

/**
 * The backstop for a response stranded OPEN on a run that is already over.
 *
 * `concludeRun` closes a response with its run, but best-effort like every step there: a crash
 * between the result landing and that close leaves a row nothing else will ever close. The
 * automations door would then join every later fire to it — answering "joined" while the run
 * that could act is gone — so the automation silently stops starting runs. The door checks the
 * run itself now; this is the sweep that stops the row rotting in the first place, and it runs
 * every tick because the working set is only ever the handful of live responses.
 */
export async function sweepStaleResponses(deps: StaleResponseDeps): Promise<void> {
  let closed = 0;
  for (const response of await deps.store.listOpenResponses()) {
    const run = await deps.store.getRun(response.runId);
    if (run !== null && !TERMINAL_STATES.has(run.state)) continue;
    // A run only just over is still being concluded, and its conclusion closes this row behind
    // the binding's closing line. Released now, that line would never be said; the sweep waits
    // out the conclusion's grace, as a backstop for a crash can (`CONCLUSION_GRACE_MS`).
    if (!conclusionOverdue(run, response, deps.now())) continue;
    const at = deps.now().toISOString();
    const reason = run?.state ?? "lost";
    // Whatever stranded the row likely stranded the room's binding too, and that one holds the
    // conversation — a shared one the automation's next response must continue. Released first
    // and without a word, as the conclusion should have closed it (`releaseRunBinding`).
    if (response.chatroomId !== null) await releaseRunBinding(deps, response.runId, reason);
    if (await deps.store.closeResponse(response.id, at, reason)) closed += 1;
  }
  if (closed > 0) deps.diag.debug("reaper.stale_responses_closed", { responses: closed });
}

// ---------------------------------------------------------------------------
// The submitter: the patch half of the reaper — sits beside `sweep` on the same interval,
// with the same contract. `planPatchSweep` decides purely; delivery goes through the forge
// port, and is free to fail, because this sweep always fires again.
// ---------------------------------------------------------------------------

export interface SubmitterDeps {
  store: TaskStore;
  forge: Forge;
  /** Resolves the requester's forge login for the provenance block. Null: unattributed. */
  identityDirectory: IdentityDirectory | null;
  diag: Diagnostics;
  /** Null/absent: no memory, so a patch that dies here is a fate nobody is waiting for, and a
   * submitted one's pull request goes unrecorded there. */
  memoryAccess?: Pick<MemoryAccess, "reportChange" | "reportPatch"> | null;
  /** Wakes a live run's poll when its inbox hears of the patch; absent, the poll's clock does. */
  inbox?: InboxSignal | null;
  /** A submitted patch whose `.ryph/` differs gets its branch built and its run told the result
   * (core/environment_feedback.ts). Null/absent where environments are not built. */
  environmentFeedback?: Pick<EnvironmentFeedback, "patchSubmitted"> | null;
  /** A submitted patch's head has its checks reported to the forge (core/checks.ts). Null/absent
   * where checks do not run. */
  checks?: Pick<ChecksService, "patchSubmitted" | "changeRequestEnded"> | null;
  /** How the forge acts on GitHub: in user mode, which delivers no events, the change requests
   * our patches reached are polled for their merge (core/merge_poll.ts). Absent: never polled. */
  githubMode?: GithubModeSource | null;
  /** The merge poll's clock; absent, its defaults. */
  mergePoll?: MergePollConfig;
  /** The web app's browser-facing origin (RYPH_APP_URL): a patch held for a person is told to
   * its run with a link to its page. Null/absent: the note names no link. */
  appUrl?: string | null;
  now(): Date;
}

/**
 * Who the report names as having asked, looked up at delivery time rather than at request time:
 * a link made after the run still lands in the report. A login, or — where every user acts as
 * one account (GitHub's user mode) — the requester's ryph name, never that account's login.
 */
async function requesterOf(
  deps: { identityDirectory: IdentityDirectory | null },
  userId: string | null,
  provider: ForgeProvider,
): Promise<{ requestedByLogin: string | null; requestedByName: string | null }> {
  // A local repository has no identities to sign as: its delivery is a branch on disk, with
  // no body anyone reads on a forge.
  const requester = userId === null || deps.identityDirectory === null || provider === "local"
    ? null
    : await deps.identityDirectory.requesterFor(userId, provider);
  return {
    requestedByLogin: requester !== null && "login" in requester ? requester.login : null,
    requestedByName: requester !== null && "name" in requester ? requester.name : null,
  };
}

export async function sweepPatches(deps: SubmitterDeps, cfg: PatchSubmitConfig): Promise<void> {
  const { store, diag } = deps;
  // Every step, and every patch, is its own attempt: one that throws is warned and the rest of
  // the tick goes on — above all the trailing steps, which a throwing delivery must never starve.
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      diag.warn("reaper.patch_sweep_step_failed", { step: name, err: String(err) });
    }
  };
  // First, so what it holds or replaces is not in the snapshot below as still deliverable (and
  // the claim and the pre-delivery check ask the rule again for anything it raced) — nor asked
  // about by the hook check next.
  await step("landing_rule", () => reconcileLandingRule(deps));
  // Then the hook check, so a `local` patch checked clean on this tick is read back below and
  // goes on its way in the same one. Ridden on this sweep rather than a tick of its own because
  // it is part of getting a patch delivered, and every composition root already drives this one.
  await step("hook_checks", () => sweepHookChecks(deps, cfg));
  let active: Patch[] = [];
  await step("list", async () => {
    active = await store.listActivePatches();
  });
  /** Each repo's forge, read once per sweep: only the hook gate below asks. */
  const providers = new Map<string, ForgeProvider | null>();
  const providerOf = async (connectedRepoId: string) => {
    if (!providers.has(connectedRepoId)) {
      providers.set(
        connectedRepoId,
        (await store.getConnectedRepo(connectedRepoId))?.provider ?? null,
      );
    }
    return providers.get(connectedRepoId) ?? null;
  };

  for (const patch of active) {
    try {
      await sweepOne(deps, cfg, patch, providerOf);
    } catch (err) {
      diag.warn("reaper.patch_sweep_failed", { patchId: patch.id, err: String(err) });
    }
  }
  // Where the forge delivers no events (GitHub's user mode), the change requests our patches
  // reached are asked whether they merged or closed, and an end goes the forge event's way
  // (core/merge_poll.ts). Before the reconciles, so a push the merge did not see settles on the
  // same tick.
  await step("merge_poll", () => pollChangeRequestEnds(deps, deps.mergePoll));
  // A merge whose landing failed after its settle is landed, ruled and cued now: nothing else
  // would ask again once the poll has heard it merged.
  await step("merged_landings", () => reconcileMergedLandings(deps));
  // Best-effort, like everything on this tick.
  await step("merged_cues", () => sweepMergedCues(deps));
  // A task that works a merged change request with nothing of its current run on it is let go,
  // and its live run sent the release cue (core/merge_release.ts): rows alone, never the forge.
  await step("merge_releases", () => reconcileMergeReleases(deps));
  // Last, since it asks the forge: every recorded merge is settled from its record — each patch
  // judged by git's containment, landed, ruled and cued, a push that reached the change request
  // after the merge included (core/merge_settle.ts). The step waits on its asks a bounded time,
  // so a slow forge holds the next tick back that much at most; an ask still under way then
  // finishes on its own.
  await step("merged_settles", () => reconcileMergeSettles(deps));
}

/** One patch of the submit sweep: what its plan says, done. */
async function sweepOne(
  deps: SubmitterDeps,
  cfg: PatchSubmitConfig,
  patch: Patch,
  providerOf: (connectedRepoId: string) => Promise<ForgeProvider | null>,
): Promise<void> {
  const { store, diag } = deps;
  const at = deps.now().toISOString();
  const action = planPatchSweep(patch, deps.now().getTime(), at);
  switch (action.kind) {
    case "none":
      break;

    case "reclaim": // a submitter died mid-flight; hand the patch back to the queue
    case "requeue": { // a failed patch's clock ran out
      // Over the row as this sweep read it — the dead submitter's lease, or the failure — and
      // nothing else: a retirement, a settle or a person may have written it since.
      const moved = await store.savePatchIfState(
        action.patch,
        [patch.state],
        patch.state === "submitting" ? patch.leaseExpiresAt ?? undefined : undefined,
        patch.version,
      );
      if (moved) diag.debug(`reaper.patch_${action.kind}`, { patchId: patch.id });
      break;
    }

    case "submit":
      // An agent whose patches were switched off after this one opened: the patch waits,
      // untouched, and goes on its way if they are switched back on. Read live, every sweep.
      // A patch whose run is gone goes on to submitOne, which fails it for good as before.
      if (await patchMayShip(store, patch) === "locked") {
        diag.debug("reaper.patch_held_agent_locked", { patchId: patch.id });
        break;
      }
      // A `local` patch is not delivered before the forge has said which git hook files it
      // changes: under `auto` nobody else would ever look. `sweepHookChecks` asks, and an
      // answer it cannot get leaves the patch here, waiting, rather than shipped unchecked.
      if (patch.hookCheck === null && await providerOf(patch.connectedRepoId) === "local") {
        diag.debug("reaper.patch_awaits_hook_check", { patchId: patch.id });
        break;
      }
      await submitOne(deps, patch, cfg);
      break;
  }
}

/**
 * The hook check: for every `local` patch still waiting to be delivered that nobody has asked
 * about, ask the forge which git hook files it changes (measured as its live diff is) and keep
 * the answer. A queued one that touches any is held for a person (`recordHookCheck`), and its
 * run is told why — a waiting one that touches any too, so the run's record shows what the
 * approval is about. No answer this time (the forge unreachable, or a failure it called
 * retryable) leaves the patch unchecked — and so undelivered — for the next tick. An answer that
 * never will come (a terminal refusal, a patch whose rows no longer resolve) or one that cannot
 * be read spends an attempt, and fails a queued patch for good once that is all it can do
 * (`failHookCheck`): a patch never waits on this check forever. Never throws; every patch is its
 * own attempt.
 */
async function sweepHookChecks(deps: SubmitterDeps, cfg: PatchSubmitConfig): Promise<void> {
  const { store, diag } = deps;
  let waiting: Patch[];
  try {
    waiting = await store.listPatchesAwaitingHookCheck();
  } catch (err) {
    diag.warn("reaper.hook_check_list_failed", { err: String(err) });
    return;
  }
  for (const patch of waiting) {
    try {
      await checkHooksOf(deps, patch, cfg);
    } catch (err) {
      diag.warn("reaper.hook_check_failed", { patchId: patch.id, err: String(err) });
    }
  }
}

async function checkHooksOf(
  deps: SubmitterDeps,
  patch: Patch,
  cfg: PatchSubmitConfig,
): Promise<void> {
  const { store, forge, diag } = deps;
  // A check that failed waits out its backoff clock, as a failed delivery does.
  if (patch.nextAttemptAt !== null && Date.parse(patch.nextAttemptAt) > deps.now().getTime()) {
    return;
  }
  const [task, repo] = await Promise.all([
    store.getTask(patch.taskId),
    store.getConnectedRepo(patch.connectedRepoId),
  ]);
  if (repo !== null && repo.provider !== "local") return;
  // Where the diff is measured from: the same ask the reviewer's diff makes (user_api
  // `measurePatch`), so the files a person is shown are the files this found.
  const entry = task?.repos.find((r) =>
    r.connectedRepoId === patch.connectedRepoId && r.path === patch.path
  );
  // A patch whose rows no longer resolve can never be checked — nor delivered, which waits on
  // this check: it fails here, for good, as `submitOne` would fail it.
  if (task === null || repo === null || entry === undefined) {
    await hookCheckFailed(
      deps,
      patch,
      {
        message: "the patch's task, repo or checkout entry no longer resolves",
        terminal: true,
      },
      repo,
      cfg,
    );
    return;
  }
  if (repo.archivedAt !== null) {
    await hookCheckFailed(
      deps,
      patch,
      {
        message: `${repo.repoRef} was disconnected`,
        terminal: true,
      },
      repo,
      cfg,
    );
    return;
  }
  const target = submissionTarget(
    task,
    await store.patchesForTask(task.id),
    patch,
    lineBase(entry, task.landings, patch.line, patch.runId),
    repo.provider,
  );
  const answer = await forge.checkPatchHooks(forgeRepoRef(repo), repo.url, {
    connectedRepoId: repo.id,
    bundleKey: patch.bundleKey,
    branchName: patch.branchName,
    headSha: patch.headSha,
    baseSha: patch.baseSha,
    targetRef: target.diffRef,
    mode: "live",
  });
  if (answer.kind === "unavailable") {
    // Asked again next tick: nothing that is not a real answer may let the patch through.
    diag.warn("reaper.hook_check_unanswered", { patchId: patch.id, why: answer.message });
    return;
  }
  if (answer.kind !== "checked") {
    await hookCheckFailed(
      deps,
      patch,
      {
        message: answer.message,
        terminal: answer.kind === "refused",
      },
      repo,
      cfg,
    );
    return;
  }
  const at = deps.now().toISOString();
  const outcome = recordHookCheck(patch, {
    touched: answer.touched,
    hooksPaths: answer.hooksPaths,
    more: answer.more,
    at,
  }, at);
  if (outcome.kind === "refused") return;
  // Over the row exactly as it was read (its version): a person who approved (or rejected) it
  // meanwhile decided on the patch as it stood, a landing may have held or replaced it, and the
  // next tick asks again about what it is now. Its events with it, or neither.
  if (
    await store.savePatchIfState(
      outcome.patch,
      [patch.state],
      undefined,
      patch.version,
      outcome.events,
    ) === null
  ) {
    diag.debug("reaper.hook_check_raced", { patchId: patch.id });
    return;
  }
  if (touchesHooks(outcome.patch.hookCheck)) {
    if (outcome.patch.state !== patch.state) {
      diag.warn("reaper.patch_held_for_hooks", { patchId: patch.id });
    }
    await notifyPatch(deps, outcome.patch, "held", null, undefined, {
      provider: repo.provider,
      patchUrl: patchUrlOf(deps.appUrl, outcome.patch.id),
    });
  }
}

/** A hook check that counts against the patch (`failHookCheck`), recorded — and, when it failed
 * the patch for good, heard by memory and the run, as a failed delivery is. */
async function hookCheckFailed(
  deps: SubmitterDeps,
  patch: Patch,
  error: { message: string; terminal: boolean },
  repo: ConnectedRepo | null,
  cfg: PatchSubmitConfig,
): Promise<void> {
  const { store, diag } = deps;
  const outcome = failHookCheck(patch, error, deps.now().toISOString(), cfg);
  diag.warn("reaper.hook_check_refused", {
    patchId: patch.id,
    terminal: error.terminal,
    message: error.message,
  });
  if (outcome.kind === "refused") return;
  if (
    await store.savePatchIfState(
      outcome.patch,
      [patch.state],
      undefined,
      patch.version,
      outcome.events,
    ) === null
  ) {
    diag.debug("reaper.hook_check_raced", { patchId: patch.id });
    return;
  }
  const fate = patchFateForMemory(outcome.patch);
  if (fate !== null) {
    const reason = outcome.patch.lastError ?? error.message;
    await reportPatchFate(deps, outcome.patch, fate);
    await notifyPatch(
      deps,
      outcome.patch,
      "failed",
      repo === null ? reason : runFacingText(repo, reason),
      undefined,
      { provider: repo?.provider ?? null },
    );
  }
}

/** One delivery attempt: take the lease, compose the submission, ask the forge, record the
 * verdict. Every failure lands as a `failed` state with the right clock — never a throw. */
async function submitOne(deps: SubmitterDeps, patch: Patch, cfg: PatchSubmitConfig): Promise<void> {
  const { store, forge, diag } = deps;

  const taken = markSubmitting(patch, deps.now().toISOString(), cfg);
  if (taken.kind === "refused") return; // e.g. a clock started between listing and now
  // The lease only becomes real here. `markSubmitting` above is pure and judged `patch` — a copy
  // read at the top of this sweep — so a concurrent submitter that read the same copy also got
  // "applied". The conditional write is what decides which of them delivers; the loser returns
  // without touching the forge, and the next sweep finds the patch already handled.
  // Over the row exactly as the sweep listed it (its version): a patch that went queued → held →
  // approved → queued again since is the same state with a different story, and claiming the
  // listed copy would put the old approval back over the hold.
  const claimedVersion = await store.savePatchIfState(
    taken.patch,
    [patch.state],
    undefined,
    patch.version,
  );
  if (claimedVersion === null) {
    diag.debug("reaper.patch_claim_lost", { patchId: patch.id, state: patch.state });
    return;
  }

  /** The patch's repo once it resolves — what the run's copy of a failure is worded for. */
  let resolvedRepo: ConnectedRepo | null = null;
  const fail = async (message: string, terminal: boolean) => {
    const failed = markFailed(taken.patch, { message, terminal }, deps.now().toISOString(), cfg);
    if (
      failed.kind === "applied" &&
      // Under this sweep's lease only: one that lapsed may find the patch handed on since.
      await store.savePatchIfState(
        failed.patch,
        ["submitting"],
        taken.patch.leaseExpiresAt ?? undefined,
        undefined,
        failed.events,
      )
    ) {
      // A failure with no clock left — a terminal forge refusal, or attempts exhausted — is
      // where this patch stops moving on its own, so it is where memory has to hear that the
      // run's change is not coming. `failed` with a clock says nothing: the next sweep tries
      // again. (A human retry that later lands re-settles nothing on memory's side, which is
      // the accepted cost of not leaving the claims waiting on a patch nobody will retry.)
      // The run hears it too, while it is alive to: an agent mid-conversation can revise.
      const fate = patchFateForMemory(failed.patch);
      if (fate !== null) {
        await reportPatchFate(deps, failed.patch, fate);
        await notifyPatch(
          deps,
          failed.patch,
          "failed",
          resolvedRepo === null ? message : runFacingText(resolvedRepo, message),
          undefined,
          { provider: resolvedRepo?.provider ?? null },
        );
      }
    }
    diag.warn("reaper.patch_submit_failed", { patchId: patch.id, terminal, message });
  };

  // Everything the submission needs comes from rows; a dangling reference is terminal —
  // retrying will never make a deleted task reappear.
  const [task, run, repo] = await Promise.all([
    store.getTask(patch.taskId),
    store.getRun(patch.runId),
    store.getConnectedRepo(patch.connectedRepoId),
  ]);
  if (!task || !run || !repo) {
    await fail("the patch's task, run, or repo no longer resolves", true);
    return;
  }
  resolvedRepo = repo;
  // A repo disconnected after the patch opened: the installation token would still push, but
  // the org let the repo go, and a disconnect never heals (reconnecting is a new row).
  if (repo.archivedAt !== null) {
    await fail(`${repo.repoRef} was disconnected`, true);
    return;
  }

  // A sibling of this patch's generation merged: it is never delivered on its own
  // (docs/patch-lifecycle.md "Landing") — replaced by a newer patch that carries it, or held.
  // Asked here, after the claim and with the rows fresh, so a merge settled or a successor born
  // while this sweep was listing still catches it before any work is spent on a submission that
  // will not happen — and asked once more just before delivery, below. The claim bumped the
  // row's version, which the rule's write is conditioned on, along with the lease. Answers the
  // task's patches the rule judged, or null when it ruled the patch.
  const claimed: Patch = { ...taken.patch, version: claimedVersion };
  const landed = async (): Promise<readonly Patch[] | null> => {
    const fresh = await store.patchesForTask(patch.taskId);
    const ruled = taken.patch.leaseExpiresAt !== null &&
      await applyLandingRule(deps, claimed, fresh, deps.now().toISOString(), {
        lease: taken.patch.leaseExpiresAt,
      });
    return ruled ? null : fresh;
  };
  if (await landed() === null) return;

  // The repo's entry in the task's checkout: where the base ref comes from, and which of the
  // run's branches this patch is. A patch names a repo the task never held only through a bug,
  // and a bug that would otherwise open a pull request against the wrong base is terminal.
  const entry = task.repos.find((r) => r.connectedRepoId === repo.id && r.path === patch.path);
  if (entry === undefined) {
    await fail("the patch's repo is not in its task's checkout", true);
    return;
  }

  // The report: the run's own account plus the unsuppressable provenance block. The
  // requester's login is looked up at submit time — a link made after the run still lands.
  // The commits are THIS repo's: a pull request carries its own part of the change, and says
  // how many other parts there are — never which, since this repo may be public and a sibling
  // private. The count is what the PATCH ROWS say, never the result's branch list: a branch
  // whose row failed to open is not a pull request anyone will find.
  const requester = await requesterOf(deps, task.requestedByUserId, repo.provider);
  // The commits are the patch's own, as the runner reported them at birth — a patch born
  // mid-run has no result to read them from, and the result's summary is absent then too:
  // the agent's description (above the report) is its account of a mid-run patch.
  const result = run.result;
  const siblings = (await store.patchesForSet(patch.setId)).filter((p) => p.id !== patch.id);
  // The description shares the body: its images count first against the per-body limit.
  const summary = summaryToSend(result, patch.description ?? "");
  const report = composeReport({
    runId: run.id,
    agentName: run.workItem.agent.name,
    runUrl: deps.appUrl ? `${deps.appUrl}/tasks/${task.id}` : null,
    description: patch.description,
    summary,
    branches: [{ path: patch.path, line: patch.line, commits: patch.commits }],
    // a patch exists only for a run that shipped a branch, so this body never says no-changes
    noChanges: false,
    // Other REPOSITORIES: another line of this one is a change request in the same place, not a
    // part of the change kept elsewhere.
    otherParts: new Set(
      siblings.filter((p) => p.connectedRepoId !== patch.connectedRepoId || p.path !== patch.path)
        .map((p) => `${p.connectedRepoId}\0${p.path}`),
    ).size,
    provenance: {
      origin: task.origin,
      ...requester,
      requestedVia: task.requestedVia?.name ?? null,
    },
  });
  // Only the description's and the summary's images are shown; a ref anywhere else is text.
  const body = bodyToSend(
    report,
    `${patch.description ?? ""}\n${summary}`,
  );

  // The branch the task started from in this repo, as a branch NAME — the same normalization
  // the gateway serves it under. For a new PR that is its base. For a task working ON a pull
  // request in this repo it is that pull request's head branch, and the commits are pushed
  // onto it instead. For a fork's pull request it is `pull/<n>/head`, the head as the base repo
  // keeps it: the fork-head check below lets such a patch go onto pull request <n> only, and
  // the forge refuses that base for anything else.
  let baseBranch: string;
  try {
    baseBranch =
      normalizeBaseRef(lineBase(entry, task.landings, patch.line, patch.runId)).localBranch;
  } catch (err) {
    await fail(`the task's base ref cannot anchor a PR: ${err}`, true);
    return;
  }
  // The patch is handed back exactly as it was before this sweep took it — no attempt spent, no
  // failure recorded — and waits in the sweep. Only while the lease is still this sweep's, in
  // one conditional write: one that stalled past it may find another sweep holding the patch
  // now, and handing back over that claim could send it twice.
  const handBack = async () => {
    if (taken.patch.leaseExpiresAt !== null) {
      await store.savePatchIfState(patch, ["submitting"], taken.patch.leaseExpiresAt);
    }
  };

  // Asked again as late as it can be: the switch may have flipped during the reads above. The
  // patch waits in the sweep while the agent is locked.
  if (!await agentMayOpenPatches(store, run.agentId)) {
    await handBack();
    diag.debug("reaper.patch_held_agent_locked", { patchId: patch.id });
    return;
  }
  // The last look before the forge: everything above took round trips, and a merge settled or a
  // successor born in that time must still keep this patch in. Where it goes is read from the
  // rows as they stand now, since a landing may have moved it: onto the task's own pull request,
  // or the one an earlier patch of this branch opened while it is still open; else a fresh one
  // against the task's base (core/patch_lifecycle.ts). The task is read BEFORE the rule is asked:
  // a release committed between the two then finds the rule holding the patch, where read after
  // it the task would already say "no change request" and send a patch built on the merged one's
  // head to a fresh one. One committed after both leaves the task still naming the merged change
  // request, which the gate below catches.
  const freshTask = await store.getTask(task.id);
  // Where it goes is read off the same patches the rule judged: a sibling's verdict written
  // between two reads could otherwise send a patch of a generation that landed to a fresh change
  // request.
  const judged = await landed();
  if (judged === null) return;
  if (freshTask === null) {
    await fail("the patch's task no longer resolves", true);
    return;
  }
  const freshEntry = freshTask.repos.find((r) =>
    r.connectedRepoId === repo.id && r.path === patch.path
  );
  let freshBase = baseBranch;
  try {
    if (freshEntry !== undefined) {
      freshBase =
        normalizeBaseRef(lineBase(freshEntry, freshTask.landings, patch.line, patch.runId))
          .localBranch;
    }
  } catch {
    // unchanged: the base read above already anchored it
  }
  const target = submissionTarget(
    freshTask,
    judged,
    patch,
    freshBase,
    repo.provider,
  );
  // Never onto a change request whose merge was heard (docs/patch-lifecycle.md "Landing"): a
  // merged GitHub pull request refuses the push, but a merged Radicle patch takes it as one more
  // revision nobody will merge. While the merge's verdicts are still out the patch waits, as it
  // was: once they are in, the rule replaces or holds it, or the landing moved where it goes.
  // A task still working the change request the merge settled is let go of it here, if the
  // release reconcile has not yet (core/merge_release.ts) — or the patch waits for its own run's
  // landing to do it — and the patch handed to the landing rule: the release ended its run's
  // generation, so a patch of it is held or replaced, and a later one is read again next sweep
  // against the released task and opens a fresh change request. The only other change request a
  // patch goes onto is an earlier patch of its branch's, whose verdict the merge owes or gave.
  if (target.changeRequest !== null) {
    const merge = await store.getChangeRequestMerge(repo.id, target.changeRequest);
    if (merge !== null) {
      const onIt = await store.patchesByRepoAndForgeRef(repo.id, target.changeRequest);
      if (mergeVerdictPending(merge, onIt)) {
        await handBack();
        diag.debug("reaper.patch_awaits_merge_verdict", { patchId: patch.id });
        return;
      }
      const worked = freshTask.targetChangeRequest;
      if (
        worked !== null && worked.connectedRepoId === repo.id &&
        worked.thread === target.changeRequest
      ) {
        const released = await releaseTarget(deps, repo, merge, task.id).catch((err) => {
          diag.warn("reaper.merge_release_failed", { patchId: patch.id, err: String(err) });
          return "failed" as const;
        });
        diag.debug("reaper.patch_task_released", { patchId: patch.id, released });
        // Handed to the rule, never to delivery: the release ended the run's generation, so a
        // patch of it, built on the merged change request's head, is held or replaced as for a
        // landed one. Anything else (a patch of a later generation; no release made) waits a tick.
        if (await landed() !== null) await handBack();
        return;
      }
      // Otherwise it is an earlier patch of this branch's change request, read open above and
      // judged since: its verdict ends the generation, so the rule holds or replaces this one.
      if (await landed() !== null) await handBack();
      return;
    }
  }
  // A run on a fork's head delivers onto that pull request or nowhere, whatever the repo's policy
  // and whatever the agent asked for: the code it ran was the contributor's, and a branch or a
  // change request of its own in this repo is exactly what that code must not be able to make.
  // Read off the task as it stands now, so a pull request let go of (merged, then released) is
  // nowhere left to go rather than a fresh change request. The forge refuses the same shape.
  // Only its default line ever ships: birth refuses any other (core/open_patch.ts), and so does
  // this, whatever change request such a patch would find.
  const forkTask = worksForkHead(freshTask.repos);
  if (forkTask) {
    const own = freshTask.targetChangeRequest;
    if (
      own === null || own.connectedRepoId !== repo.id || freshEntry?.forkHead !== true ||
      patch.line !== DEFAULT_LINE || target.changeRequest !== own.thread
    ) {
      diag.warn("reaper.fork_patch_refused", { patchId: patch.id });
      await fail(
        own === null
          ? "this run worked a pull request from a fork, which it no longer works, and such a " +
            "run delivers onto that pull request or nowhere"
          : `this run worked #${own.thread} from a fork, so it delivers onto that pull request ` +
            "or nowhere — never as a change request of its own",
        true,
      );
      return;
    }
  }
  const outcome = await forge.submitPatch({
    // What a person approved, and only that: the forge holds a local patch touching any other.
    approvedHookPaths: [...patch.approvedHookPaths],
    bundleKey: patch.bundleKey,
    branchName: patch.branchName,
    headSha: patch.headSha,
    repo: forgeRepoRef(repo),
    repoUrl: repo.url,
    baseBranch: target.branch,
    // The agent's own words when it gave them through the submit tool; the task's otherwise. A
    // patch comes from a run that was given its instructions, so the task has a title; the
    // branch stands in only for a row that says otherwise.
    title: patch.title ?? task.spec.title ?? patch.branchName,
    body,
    runId: run.id,
    ...(target.changeRequest === null ? {} : { changeRequest: target.changeRequest }),
    // The repo's switch as it stands NOW, read with the row above: one turned off while the run
    // worked stops the push. Sent only for a fork-head run and only when on, so a forge that
    // does not know the field yet refuses nothing but the push it could not have made anyway.
    ...(forkTask && repo.allowForkPushes ? { allowForkPush: true } : {}),
  });

  if (outcome.kind === "submitted") {
    const done = markSubmitted(
      taken.patch,
      {
        ref: outcome.ref,
        url: outcome.url,
        branch: forgeBranchOf(repo.provider, target, patch, outcome.ref),
        diffRef: target.diffRef,
      },
      deps.now().toISOString(),
    );
    // Under this sweep's lease only. The delivery has happened either way; a lease that lapsed
    // mid-delivery leaves the row to the sweep that took it since, which finds the change request
    // the forge now holds for this head and adopts it.
    if (
      done.kind === "applied" &&
      await store.savePatchIfState(
        done.patch,
        ["submitting"],
        taken.patch.leaseExpiresAt ?? undefined,
        undefined,
        done.events,
      )
    ) {
      // Memory's record of the change gains its pull request (an upsert — the birth relay may
      // also have been lost, and this is its second chance); the run, while alive, hears where
      // its patch went. Both best-effort, like every relay off this sweep.
      if (deps.memoryAccess) {
        await deps.memoryAccess.reportPatch(patch.runId, {
          patchId: patch.id,
          repo: entry.url,
          generation: patch.generation,
          headSha: patch.headSha,
          forgeUrl: outcome.url,
          carries: patch.carries,
        }).catch((err) =>
          diag.warn("memory.patch_report_failed", { patchId: patch.id, err: String(err) })
        );
      }
      await notifyPatch(deps, done.patch, "submitted", null, undefined, {
        provider: repo.provider,
      });
      // Now the patch is a branch at the forge, it can be built. Never throws; the check is two
      // tree reads for a patch that did not touch `.ryph/`.
      await deps.environmentFeedback?.patchSubmitted(done.patch);
      // And now the commit exists at the forge, its checks can be posted there — `queued` at
      // once, so a required check is never absent. Never throws: a row, due now.
      await deps.checks?.patchSubmitted(done.patch);
      // Pushed onto a change request whose merge was recorded meanwhile: judged against that
      // record by the sweep's settle reconcile (core/merge_settle.ts `reconcileMergeSettles`),
      // never here.
    }
    diag.debug("reaper.patch_submitted", { patchId: patch.id, url: outcome.url });
  } else if (outcome.kind === "held") {
    // Nothing was pushed: the patch changes git hook files nobody approved — new since the check,
    // or never shown. Back to a person, with what the forge found, and no attempt spent on it
    // as a failure. Only while the lease is still this sweep's, as every hand-back here.
    const at = deps.now().toISOString();
    const held = holdPatch(taken.patch, {
      touched: outcome.touched,
      hooksPaths: outcome.hooksPaths,
      more: outcome.more,
      at,
    }, at);
    if (
      held.kind === "applied" &&
      await store.savePatchIfState(
        held.patch,
        ["submitting"],
        taken.patch.leaseExpiresAt ?? undefined,
        undefined,
        held.events,
      )
    ) {
      await notifyPatch(deps, held.patch, "held", null, undefined, {
        provider: repo.provider,
        patchUrl: patchUrlOf(deps.appUrl, held.patch.id),
      });
    }
    diag.warn("reaper.patch_held_for_hooks", { patchId: patch.id });
  } else if (outcome.ended !== undefined && target.changeRequest !== null) {
    // Refused because the change request it was to go onto ended, which this side may not have
    // heard: in user mode the poll asks on the next tick (core/merge_poll.ts). A merge is not
    // this patch's failure when the merge's record will hand it somewhere else, so it stays
    // retryable on its clock: an earlier patch of this branch on that change request settles
    // and the landing rule (`landedSiblingOf`: same run, repo, path and generation) supersedes
    // or holds this one; and a change request the task itself works, with nothing of the branch
    // on it, lets the task go once the merge is recorded (core/merge_release.ts), whose release
    // ends this patch's generation, so the rule holds or replaces it as well. Either way it is
    // never sent onto the merged one, which the forge refuses again, and it fails for good once
    // its attempts are gone. Anything else stays terminal: a close a retry would only undo.
    await pollChangeRequestSoon(deps, repo.id, target.changeRequest);
    // A merge with no record — its event lost, or no poll left to ask — is recorded from the
    // forge's own read, so the record rules this patch instead of each retry being refused again.
    if (outcome.ended === "merged") await recordRefusedMerge(deps, repo, target.changeRequest);
    const worked = freshTask.targetChangeRequest;
    const handedOn = outcome.ended === "merged" && (
      (target.earlier !== undefined && target.earlier.forgeRef === target.changeRequest &&
        target.earlier.path === patch.path) ||
      (worked !== null && worked.connectedRepoId === repo.id &&
        worked.thread === target.changeRequest)
    );
    await fail(outcome.message, handedOn ? false : outcome.terminal);
  } else {
    await fail(outcome.message, outcome.terminal);
  }
}

// ---------------------------------------------------------------------------
// The progress sweep: the third rider on the reaper's tick. For every open progress comment
// (a forge-triggered run's face in its thread), edit the comment when the run's (state, phase)
// moved past what was last posted — and on a terminal state, embed the full report and close
// the row. Same contract as its siblings: best-effort per row, never a throw, the next tick
// sees the same evidence. `lastPosted` is saved only AFTER the edit lands, so a failed GitHub
// call retries by construction. The composition roots additionally KICK this sweep from the
// store's terminal hook, so the final edit lands in milliseconds rather than a tick later.
// ---------------------------------------------------------------------------

export interface ProgressSweepDeps {
  store: TaskStore;
  forge: Forge;
  /** Resolves the requester's forge login for the final report. Null: unattributed. */
  identityDirectory: IdentityDirectory | null;
  diag: Diagnostics;
  now(): Date;
  /** The web app's browser-facing origin (RYPH_APP_URL); null omits run links. */
  appUrl: string | null;
}

/**
 * Consecutive failed edits before a row is closed as unreachable. The tension: too low and a
 * real GitHub outage silences a comment that would have healed; too high and a deleted
 * comment is re-PATCHed pointlessly for ages. At the ~10s tick, 180 attempts is ~30 minutes
 * of outage survived — and a permanently dead comment stops costing anything within the same
 * half hour. A landed edit resets the count.
 */
const MAX_PROGRESS_EDIT_ATTEMPTS = 180;

/**
 * Posts the progress comment a run keeps in a forge thread, and records it so the sweep keeps
 * editing it through the run's life and embeds the final report at the end. Except where the
 * forge writes as one person (`actsAsPerson`: GitHub user-token repos, GitLab in user mode), every run that works in a thread gets one — a `/ryph` command's, and a task
 * started from the app on a pull request, whose commits land on that pull request and must say
 * who asked (the forge ignores a report body when it pushes onto an existing pull request).
 * Best-effort: the run exists, and
 * no comment means no row, so the sweep only ever edits comments that exist.
 */
export async function openProgressComment(
  deps: {
    store: Pick<TaskStore, "saveProgressComment">;
    /** `providers` is asked only for a GitLab repo, whose mode says whether ryph writes as a
     * person there (`actsAsPerson`); without it a GitLab repo gets no progress comment. */
    forge: Pick<Forge, "postComment"> & Partial<Pick<Forge, "providers">>;
    diag: Diagnostics;
    now(): Date;
    appUrl: string | null;
  },
  args: {
    repo: ConnectedRepo;
    thread: { kind: "issue" | "change_request"; ref: string };
    runId: string;
    taskId: string;
    agentName: string;
    state: RunState;
  },
): Promise<void> {
  // "Act as you" must not post automatic status chatter under the person's identity. Without
  // a row the sweep has nothing to update, including when the run finishes.
  const providers = args.repo.provider === "gitlab"
    ? await deps.forge.providers?.().catch(() => undefined)
    : undefined;
  if (actsAsPerson(args.repo, providers)) return;

  try {
    const posted = await deps.forge.postComment(
      forgeRepoRef(args.repo),
      args.thread,
      composeProgressComment({
        runId: args.runId,
        taskId: args.taskId,
        agentName: args.agentName,
        state: args.state,
        phase: null,
        appUrl: deps.appUrl,
        report: null,
      }),
    );
    const at = deps.now().toISOString();
    await deps.store.saveProgressComment({
      runId: args.runId,
      taskId: args.taskId,
      connectedRepoId: args.repo.id,
      threadKind: args.thread.kind,
      threadRef: args.thread.ref,
      commentId: posted.commentId,
      lastPosted: { state: args.state, phase: null },
      attempts: 0,
      concludedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  } catch (err) {
    deps.diag.warn("progress_comment.open_failed", { runId: args.runId, err: String(err) });
  }
}

export async function sweepProgressComments(deps: ProgressSweepDeps): Promise<void> {
  const open = await deps.store.listOpenProgressComments();
  for (const comment of open) {
    try {
      await updateProgressComment(deps, comment);
    } catch (err) {
      deps.diag.warn("reaper.progress_update_failed", {
        runId: comment.runId,
        err: String(err),
      });
    }
  }
}

async function updateProgressComment(
  deps: ProgressSweepDeps,
  comment: ProgressComment,
): Promise<void> {
  const { store, forge, diag } = deps;
  const at = () => deps.now().toISOString();

  const [run, task, repo] = await Promise.all([
    store.getRun(comment.runId),
    store.getTask(comment.taskId),
    store.getConnectedRepo(comment.connectedRepoId),
  ]);
  if (!run || !task || !repo) {
    // Dangling references never heal; close the row so the sweep stops re-reading it.
    diag.warn("reaper.progress_comment_dangling", { runId: comment.runId });
    await store.saveProgressComment({ ...comment, concludedAt: at(), updatedAt: at() });
    return;
  }

  if (run.state === comment.lastPosted.state && run.phase === comment.lastPosted.phase) {
    // Already posted — but a run BORN terminal (launch failed before the first comment) can
    // leave an open row whose posted state will never move again. Close it; nothing to edit.
    if (TERMINAL_STATES.has(run.state)) {
      await store.saveProgressComment({ ...comment, concludedAt: at(), updatedAt: at() });
    }
    return;
  }

  // A terminal run's edit carries the same report a PR body gets — one composed artifact,
  // several delivery targets. The requester's login is looked up at edit time, like the
  // submitter does: a link made after the run still lands.
  const terminal = TERMINAL_STATES.has(run.state);
  let report: string | null = null;
  let summary = "";
  if (terminal) {
    const requester = await requesterOf(deps, task.requestedByUserId, repo.provider);
    const result = run.result;
    // The comment lives in THIS repo's thread, which may be public while a sibling of the
    // workspace is private: it shows this repo's commits, and counts the other parts.
    // A run that may not open patches shipped nothing, whatever branches its runner reports:
    // none is listed, and the comment does not claim no changes were needed.
    // What the run was TOLD decides, never the live switch: turning an agent off later must not
    // rewrite the comments of runs that really did ship. Absent (a run from before the switch
    // existed) reads as allowed, as the runner defaults it.
    const patchless = run.workItem.canOpenPatches === false;
    // A branch is listed only if its head became a patch: one the control plane
    // refused at birth (its agent switched off mid-run, say) shipped nothing, and its commit
    // subjects are the runner's words, not a change anyone will find. Matched on what identifies
    // a patch at birth — repo and head — across the task, so a head another run of it already
    // opened counts and an earlier head on the same path does not.
    const born = new Set(
      (await store.patchesForTask(task.id)).map((p) => `${p.connectedRepoId} ${p.headSha}`),
    );
    const shipped = patchless
      ? []
      : (result?.branches ?? []).filter((b) =>
        b.commits.length > 0 && born.has(`${b.connectedRepoId} ${b.headSha}`)
      );
    const here = new Set(
      task.repos.filter((r) => r.connectedRepoId === repo.id).map((r) => r.path),
    );
    const own = shipped.filter((b) => here.has(b.path));
    // "minimal" is the AGENT's claim that it already said in this thread what it did — and this
    // comment is the one place a maintainer reading the issue will look. Honoured only where the
    // ledger backs it: a settled comment or review by THIS run, on THIS thread. A run that never
    // wrote here (no capability, refused, over its cap, or a response lost) keeps its full
    // summary, so one word from a prompt-injected agent cannot erase its own account of the run
    // from the place that account is read.
    const actions = await store.listForgeToolActions(run.id);
    const claimsMinimal = result !== null && "statusComment" in result &&
      result.statusComment === "minimal";
    const spokeInThread = claimsMinimal &&
      actions.some((action) =>
        action.state === "done" && action.connectedRepoId === comment.connectedRepoId &&
        action.threadRef === comment.threadRef &&
        (action.tool === "add_comment" || action.tool === "submit_review")
      );
    // A cap spent to the last one, said where the maintainer is reading. The caps are per RUN and
    // a thread's conversation is now one run, so the fourth thing asked here meets the budget the
    // first three spent — and the refusal only ever reached the model. Counted as the ledger
    // counts: attempts, failed ones included, which is what the cap itself counts.
    const capabilities = run.forgeScope?.capabilities ?? null;
    const spentCaps = capabilities === null ? [] : FORGE_WRITE_TOOLS.flatMap((tool) => {
      const max = forgeCapFor(capabilities, tool);
      return max !== null && actions.filter((action) => action.tool === tool).length >= max
        ? [{ tool, max }]
        : [];
    });
    summary = summaryToSend(result);
    report = composeReport({
      runId: run.id,
      agentName: run.workItem.agent.name,
      runUrl: deps.appUrl ? `${deps.appUrl}/tasks/${task.id}` : null,
      summary,
      summaryInThread: spokeInThread,
      spentCaps,
      branches: own.map((b) => ({ path: b.path, commits: b.commits })),
      // Counted by repository, not by branch: each may have shipped several lines.
      otherParts: new Set(shipped.filter((b) => !here.has(b.path)).map((b) => b.path)).size,
      noChanges: !patchless && result?.status === "success" && result.branches.length === 0,
      provenance: {
        origin: task.origin,
        ...requester,
        requestedVia: task.requestedVia?.name ?? null,
      },
    });
  }

  try {
    await forge.updateComment(
      forgeRepoRef(repo),
      comment.commentId,
      // The report carries the agent's summary, image refs and all, rendered by the forge; a
      // ref anywhere else in the comment is text.
      bodyToSend(
        composeProgressComment({
          runId: run.id,
          taskId: task.id,
          agentName: run.workItem.agent.name,
          state: run.state,
          phase: run.phase,
          appUrl: deps.appUrl,
          report,
        }),
        summary,
      ),
      run.id,
    );
  } catch (err) {
    // A failed edit leaves lastPosted stale — the next tick retries — but not forever: a
    // comment deleted forge-side never heals, and the budget is what stops an eternal PATCH.
    const attempts = comment.attempts + 1;
    const gaveUp = attempts >= MAX_PROGRESS_EDIT_ATTEMPTS;
    await store.saveProgressComment({
      ...comment,
      attempts,
      concludedAt: gaveUp ? at() : null,
      updatedAt: at(),
    });
    diag.warn("reaper.progress_update_failed", {
      runId: comment.runId,
      attempts,
      gaveUp,
      err: String(err),
    });
    return;
  }
  // Only after the edit lands does lastPosted advance (and the failure count reset).
  await store.saveProgressComment({
    ...comment,
    lastPosted: { state: run.state, phase: run.phase },
    attempts: 0,
    concludedAt: terminal ? at() : null,
    updatedAt: at(),
  });
  diag.debug("reaper.progress_comment_updated", {
    runId: run.id,
    state: run.state,
    phase: run.phase,
    concluded: terminal,
  });
}
