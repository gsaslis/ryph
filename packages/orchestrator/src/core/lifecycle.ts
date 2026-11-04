// The run state machine, as pure functions.
// Every transition takes the current Run and returns the next Run plus the events to append —
// persistence is the caller's job, so each transition is trivially unit-testable and the store
// stays a dumb row-holder.
//
// Invariants:
// - a terminal run never transitions again, with ONE deliberate exception: a late result may
//   overwrite "lost" — "lost" was the orchestrator's guess, and the runner's own report is
//   strictly better information
// - heartbeat seq is monotonic per run: a stale or reordered heartbeat is answered but never
//   applied, so state cannot roll backwards
// - a heartbeat is a report, never a channel: nothing the orchestrator answers drives the run.
//   Cancellation reaches a container through its inbound control API or the reaper's SIGTERM
// - every timestamp handed in here is orchestrator receive time, never a runner clock

import {
  type Agent,
  type AttachmentRef,
  type ChatContext,
  type Heartbeat,
  type RepoEntry,
  type Run,
  type RunEvent,
  type RunModelScope,
  type RunnerResult,
  type RunState,
  type Task,
  TERMINAL_STATES,
  type WorkItem,
} from "./types.ts";
import { describeLimit } from "./run_limits.ts";

export function isTerminal(run: Run): boolean {
  return TERMINAL_STATES.has(run.state);
}

export type HeartbeatOutcome =
  | { kind: "terminal" }
  | { kind: "stale" }
  | { kind: "applied"; run: Run; events: RunEvent[] };

/**
 * A heartbeat updates the gauge (phase, seq, lastHeartbeatAt) in place.
 * The first one also flips "starting" → "running"; a phase change is the only part that
 * becomes an event.
 */
export function applyHeartbeat(run: Run, hb: Heartbeat, at: string): HeartbeatOutcome {
  if (isTerminal(run)) return { kind: "terminal" };
  if (hb.seq <= run.heartbeatSeq) return { kind: "stale" };

  const events: RunEvent[] = [];
  if (run.state === "starting") {
    events.push({ runId: run.id, at, kind: "first-heartbeat" });
  }
  // Finalizing is the last phase, and stays once reached: a run's patches born after it are
  // finalize patches (core/open_patch.ts), which a later beat saying otherwise must not undo.
  const phase = run.phase === "finalizing" ? run.phase : hb.phase;
  if (run.phase !== phase) {
    events.push({ runId: run.id, at, kind: "phase-changed", detail: phase });
  }
  // Absent keeps what is stored; null clears it.
  const declaredOutcome = hb.declaredOutcome === undefined
    ? run.declaredOutcome ?? null
    : hb.declaredOutcome;
  const agentFinished = run.agentFinished === true || hb.finished === true;
  if (agentFinished && run.agentFinished !== true) {
    events.push({
      runId: run.id,
      at,
      kind: "finished",
      ...(declaredOutcome === null ? {} : { detail: declaredOutcome }),
    });
  }
  const next: Run = {
    ...run,
    state: "running",
    phase,
    heartbeatSeq: hb.seq,
    lastHeartbeatAt: at,
    // The idle clock is a gauge like the phase: each beat says where it stands now, and a beat
    // that says nothing about it (the agent is working) clears it — CLAMPED to what the run's
    // frozen lifetime allows, never taken as the runner states it.
    idleDeadlineAt: clampIdleDeadline(run, hb.idleDeadlineAt ?? null, at),
    idleState: phase === "running" && hb.idleDeadlineAt != null ? hb.idleState ?? null : null,
    // Unlike the phase and the clock, what the agent said about the run is kept once said: the
    // outcome stands until a beat names another or clears it (a message reached the agent), and
    // a finish stands for good. A beat that carries neither keeps both.
    declaredOutcome,
    agentFinished,
    updatedAt: at,
  };
  return { kind: "applied", run: next, events };
}

/**
 * What a heartbeat's claimed idle deadline is worth.
 *
 * The runner keeps the clock, but it does not own the CEILING: that deadline is what keeps a
 * run's live model key, MCP virtual token and git virtual key alive, and the
 * runner is the party they were issued to. The control plane froze the lifetime onto the run at
 * birth, so it can bound the claim — the stored deadline is the minimum of what the runner says
 * and what the lifetime still allows from THIS beat. A run may bring its deadline forward; it
 * may not extend it indefinitely by asking.
 *
 * Nor may it date it in the past: the floor is the beat itself. A deadline already behind the
 * beat would make the run the reaper's on its very next sweep, a platform action on a schedule
 * the run picked; floored, a run that says "now" still waits out the idle grace like any other.
 * Except that the floor never passes the deadline already on record: a runner whose clock lapsed
 * and keeps beating it is the run the reaper backstops, and a floor that moved with each beat
 * would keep that run's deadline in the present for good.
 *
 * A run waiting for its prompt is allowed the attended clock, as its runner waits on it: the
 * person who started the task is there, writing it (core/prompt.ts). So is an interactive run
 * (one started on the run page): its agent leaves the end to that person, who is reading.
 *
 * An unparseable claim is no claim.
 */
export function clampIdleDeadline(run: Run, claimed: string | null, at: string): string | null {
  const lifetime = run.workItem.lifetime;
  if (claimed === null) return null;
  const claimedMs = Date.parse(claimed);
  const atMs = Date.parse(at);
  if (Number.isNaN(claimedMs) || Number.isNaN(atMs)) return null;
  const present = run.attended || run.workItem.spec.instructions === null ||
    run.workItem.interactive === true;
  const allowed = present ? lifetime.attendedIdleMs : lifetime.idleMs;
  const recordedMs = run.idleDeadlineAt === null ? NaN : Date.parse(run.idleDeadlineAt);
  const floorMs = Number.isNaN(recordedMs) ? atMs : Math.min(atMs, recordedMs);
  return new Date(Math.max(floorMs, Math.min(claimedMs, atMs + allowed))).toISOString();
}

const STATE_FOR_STATUS: Record<RunnerResult["status"], RunState> = {
  success: "succeeded",
  cancelled: "cancelled",
  failure: "failed",
  error: "errored",
};

export type ResultOutcome =
  | { kind: "duplicate" }
  | { kind: "applied"; run: Run; events: RunEvent[] };

/**
 * The runner's report is authoritative and lands at most once; a re-POST of a result that
 * already landed is a duplicate to be re-acked, which is what makes the report idempotent.
 */
export function applyResult(run: Run, result: RunnerResult, at: string): ResultOutcome {
  if (run.result !== null) return { kind: "duplicate" };
  if (isTerminal(run) && run.state !== "lost") return { kind: "duplicate" };
  const next: Run = {
    ...run,
    state: STATE_FOR_STATUS[result.status],
    result,
    updatedAt: at,
  };
  return {
    kind: "applied",
    run: next,
    events: [{ runId: run.id, at, kind: "result-received", detail: result.status }],
  };
}

/** What a cancel request found: recorded now, recorded before, or a run already over. */
export type CancelOutcome = { kind: "terminal" | "already-requested" | "applied" };

export interface SweepConfig {
  /** Silence longer than this marks a non-terminal run "lost" (measure ~3-4x the beat interval). */
  heartbeatTimeoutMs: number;
  /**
   * How long a run may stay silent before its first heartbeat. A container that has yet to beat
   * has not necessarily failed: it may still be waiting on capacity, pulling its image, or
   * booting, none of which the orchestrator can observe. Size this against the slowest
   * provisioner in the deployment, not against the beat interval.
   */
  startupGraceMs: number;
  /** How long a cancelled run may keep running before the provisioner enforces it. */
  cancelGraceMs: number;
  /**
   * How far past its advertised idle deadline a run may go before the reaper
   * asks it to stop. The runner owns the clock and ends the run itself when it lapses; this is
   * the backstop for a runner that stopped keeping it — the same runner-primary, reaper-backstop
   * split cancellation has.
   */
  idleGraceMs: number;
}

export type SweepAction =
  | { kind: "none" }
  | { kind: "mark-lost"; run: Run; events: RunEvent[] }
  | { kind: "kill-graceful" }
  /** The idle clock lapsed past the grace: the run is asked to stop, exactly as a cancel. */
  | { kind: "idle-expired"; run: Run; events: RunEvent[] }
  /** The run reached its wall-clock or spend limit: asked to stop, exactly as a cancel. */
  | { kind: "limit-reached"; run: Run; events: RunEvent[] };

/**
 * The reaper's per-run decision, pure so it can be tested against a fake clock.
 * Liveness is judged from lastHeartbeatAt against the heartbeat timeout, falling back before the
 * first beat to createdAt against the startup grace — the window in which silence means "not up
 * yet" rather than "gone", and past which a container that never came up is given up on.
 *
 * `spentUsd` is the run's priced spend as the proxy reports it, read by the caller for a run
 * with a spend cap; null means nobody asked or the proxy could not answer, and neither cancels
 * anything — the proxy's own refusal is the backstop for a sweep that cannot count.
 */
export function planSweep(
  run: Run,
  nowMs: number,
  cfg: SweepConfig,
  spentUsd: number | null = null,
): SweepAction {
  if (isTerminal(run)) return { kind: "none" };
  // Waiting for its environment to build: no container exists to be silent, so silence means
  // nothing. The build's own timeout bounds the wait, and its settle ends it either way.
  if (run.environmentWait !== null && run.handle === null) return { kind: "none" };

  const started = run.lastHeartbeatAt !== null;
  // Before the first beat the clock runs from LAUNCH, not from creation. The two are the same
  // instant for a run that launches immediately, and they are not for a run that waited for its
  // environment to build — for which `createdAt` charges the whole wait as silence and marks it
  // lost in the same second it started. `createdAt` remains the fallback for a run with no
  // handle yet (nothing has been asked to exist, so creation IS the zero) and for rows written
  // before this field.
  const lastSeenMs = Date.parse(
    started ? run.lastHeartbeatAt! : (run.launchedAt ?? run.createdAt),
  );
  const silenceMs = nowMs - lastSeenMs;
  if (silenceMs > (started ? cfg.heartbeatTimeoutMs : cfg.startupGraceMs)) {
    const at = new Date(nowMs).toISOString();
    return {
      kind: "mark-lost",
      run: { ...run, state: "lost", updatedAt: at },
      events: [{
        runId: run.id,
        at,
        kind: "marked-lost",
        detail: `no heartbeat for ${silenceMs}ms`,
      }],
    };
  }

  if (
    run.desiredState === "cancelled" && run.cancelRequestedAt !== null &&
    nowMs - Date.parse(run.cancelRequestedAt) > cfg.cancelGraceMs
  ) {
    return { kind: "kill-graceful" };
  }

  // A run past one of its limits, and not yet asked to stop: the same cancel the idle arm
  // below produces, with an event that names the limit. The wall clock counts from LAUNCH, never
  // from creation — an environment build is not the run's time — so a run with no handle yet
  // has no clock running. Spend is what the proxy priced, handed in by the caller.
  if (run.desiredState !== "cancelled") {
    const at = new Date(nowMs).toISOString();
    const cancelled: Run = {
      ...run,
      desiredState: "cancelled",
      cancelRequestedAt: at,
      updatedAt: at,
    };
    const reached = (detail: string): SweepAction => ({
      kind: "limit-reached",
      run: cancelled,
      events: [
        { runId: run.id, at, kind: "limit-reached", detail },
        { runId: run.id, at, kind: "cancel-requested" },
      ],
    });
    const wallClockMs = run.limits.wallClockMs;
    if (
      wallClockMs !== null && run.launchedAt !== null &&
      nowMs - Date.parse(run.launchedAt) > wallClockMs
    ) {
      return reached(describeLimit("wall-clock", wallClockMs));
    }
    const spendUsd = run.limits.spendUsd;
    if (spendUsd !== null && spentUsd !== null && spentUsd >= spendUsd) {
      return reached(describeLimit("spend", spendUsd));
    }
  }

  // A run past its idle deadline by more than the grace, and not yet asked to
  // stop: it becomes a cancel request, and the cancel path (push, then the kill above once
  // ITS grace lapses) takes it from there. A run already cancelled is the arm above.
  if (
    run.desiredState !== "cancelled" && run.idleDeadlineAt !== null &&
    nowMs - Date.parse(run.idleDeadlineAt) > cfg.idleGraceMs
  ) {
    const at = new Date(nowMs).toISOString();
    return {
      kind: "idle-expired",
      run: { ...run, desiredState: "cancelled", cancelRequestedAt: at, updatedAt: at },
      events: [
        {
          runId: run.id,
          at,
          kind: "idle-expired",
          detail: `idle deadline ${run.idleDeadlineAt} passed by more than ${cfg.idleGraceMs}ms`,
        },
        { runId: run.id, at, kind: "cancel-requested" },
      ],
    };
  }

  return { kind: "none" };
}

/**
 * The exact payload a runner receives — the runner's own ingest schema validates it again.
 * Composed exactly once, at provision time, and frozen onto the run (`run.workItem`):
 * agents are editable, so composing from live rows any later would drift mid-run.
 */
export function composeWorkItem(
  task: Task,
  agent: Agent,
  runId: string,
  /**
   * What the run actually clones: the task's entries with, for a connected repo, the forge
   * gateway's per-run member URL and the normalized base branch in place of the upstream. The
   * task row keeps the user-named repos as user-facing truth; this is the honest archival
   * record of what the run was pointed at. Both are credential-free — the archivable-verbatim
   * invariant holds literally.
   */
  repos: RepoEntry[],
  /** The model and thinking level chosen for this run (each the task's pick, else the policy's
   * default), where chosen at all. */
  choice: Pick<RunModelScope, "model" | "thinking"> = { model: null, thinking: null },
  /** The workspace the task came from, as the agent is told it; null for a repo on its own. */
  workspace: WorkItem["workspace"] = null,
  /** The room a chat-bound run is bound to, as the agent is told it; null: no chat. */
  chat: ChatContext | null = null,
  /** The images the task arrived with, already stored under this run; empty: none. */
  attachments: readonly AttachmentRef[] = [],
  /** The browser the run was granted (core/browser.ts); null: none. */
  browser: WorkItem["browser"] | null = null,
): WorkItem {
  return {
    id: runId,
    agent: { name: agent.name, email: agent.email },
    spec: task.spec,
    repos,
    workspace,
    harness: {
      kind: agent.harnessKind,
      // Only what the harness needs to dial the right backend rides the wire — never the key
      // id or the allowlist, which are credential concerns the work item must stay clean of.
      ...(agent.modelPolicy === null ? {} : { provider: agent.modelPolicy.provider }),
      ...(choice.model === null ? {} : { model: choice.model }),
      ...(choice.thinking === null ? {} : { thinking: choice.thinking }),
    },
    lifetime: task.lifetime,
    ...(chat === null ? {} : { chat }),
    canOpenPatches: agent.canOpenPatches,
    // A setup task is a procedure that ends itself (core/environment_setup.ts), never a
    // conversation, wherever it was started.
    ...((task.origin === "user" || task.origin === "break-glass") && task.purpose === null
      ? { interactive: true }
      : {}),
    canPublishArtifacts: agent.canPublishArtifacts,
    ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
    ...(browser === null || browser === undefined ? {} : { browser }),
  };
}
