// The runner's side of the orchestrator's runner API: the HTTP `OrchestratorGateway` that
// reports the run upstream, plus the boot-time helpers the composition root uses on the same
// surface (fetching the run spec, reporting a boot failure).
//
// The adapter fuses two different things the port narrates separately: `Progress` events (a
// narration of phase transitions, the idle clock, and what the agent said about the run) and
// heartbeats (a liveness gauge). It remembers the last-known state from each `reportProgress` and
// POSTs it on a timer as a heartbeat — so a run parked in one phase for forty minutes still reads
// as alive. The timer lives here, not in the core: the core
// and its ports know nothing about liveness.
//
// ONE thing in an answer drives the run: a heartbeat answered with `{ cancel: true }` means the
// control plane wants this run stopped, and `onCancelRequested` fires. Everything else this
// gateway does still only reports upward.
//
// The inbound control API used to be the only way in, and could not be: it requires DIALING this
// container, which the single-process deployment can never do and a networked one can only do
// when the control plane's network reaches the run's. Where it failed, a cancel became a silent
// wait for the grace period and then a SIGKILL. So there are two channels now — the push, which
// is fast, and this, which always arrives — converging on the same abort.
//
// Invariants:
// - a heartbeat can never fail or slow the run: every failure is swallowed to a warn, the next
//   beat repairs a lost one
// - the cancel flag fires `onCancelRequested` AT MOST ONCE: the flag stays true on every
//   subsequent beat (it reads durable desired state, not an edge), and asking a harness to stop
//   twice a second would be a different bug
// - `seq` is monotonic; gaps are legal — the orchestrator only discards beats at or below the
//   last one applied, so state never rolls backwards
// - the payload carries no wall-clock time of its own — liveness time is the orchestrator's
//   receive time; the one timestamp a beat carries is the idle DEADLINE the run
//   holds, which the reaper backstops (past it plus a grace, the run is asked to stop)
// - after `reportResult` begins, no further beat is initiated (a beat already in flight may land
//   after the terminal report and draw a warn upstream — cosmetic, accepted)
//
// Two more clients on the same surface, for the run that can be spoken to: the inbox (a long
// poll of `GET …/messages`, the runner's one PULL — see ports/inbox.ts for why it is neither a
// heartbeat's answer nor a dial into the container) and the patch reporter (`POST …/patches`,
// the mid-run counterpart of the result's branches, and the one call here that has to answer).

import type {
  InboundMessage,
  Phase,
  Progress,
  Result,
  SetupFailureReport,
  SkillBundle,
  SkillReport,
  StaleBase,
  StaleMemory,
} from "../../core/types.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { Inbox } from "../../ports/inbox.ts";
import type { Attachments } from "../../ports/attachments.ts";
import type {
  BackgroundEndedRecord,
  BackgroundRecords,
  BackgroundStartedRecord,
} from "../../ports/background.ts";
import type { OrchestratorGateway } from "../../ports/orchestrator_gateway.ts";
import {
  type ChangeRequestClaim,
  ChangeRequestRefused,
  type PatchReport,
  type PatchReporter,
} from "../../ports/patch_reporter.ts";
import type { EnvironmentStatus } from "../../ports/environment_status.ts";
import type { ArtifactPublisher } from "../../ports/artifacts.ts";
import type { SkillBundles } from "../../ports/skills.ts";
import {
  type ChecksChannel,
  ChecksRefusedError,
  ChecksUnansweredError,
  type OwedVerdict,
} from "../../ports/checks.ts";
import type { AttachmentRef, ChecksDeclaration } from "../../core/types.ts";
import {
  AttachmentRefSchema,
  DeclaredChecksAnswerSchema,
  describeIssues,
  ImageRefsAnswerSchema,
  parseInboundMessages,
  RepoEntrySchema,
  SkillBundleSchema,
} from "../../schema.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** The longest progress message a heartbeat carries — far under the control plane's bound on
 * the field (its HeartbeatSchema), which refuses the beat whole past it. */
export const MAX_PROGRESS_MESSAGE = 4_000;
/** POST /v1/runs/:id/setup/failed's bounds (the orchestrator's SetupFailuresSchema). */
export const SETUP_FAILURE_LIMITS = {
  entries: 64,
  step: 200,
  text: 4_096,
  position: 1_000,
  code: 1_000_000,
} as const;
/** POST /v1/runs/:id/memory/stale's bounds (the orchestrator's StaleMemoriesSchema): memory
 * keeps 50 changed paths per memory, and the control plane reads the report under a cap sized
 * to that, not to every path a directory's diff can list. */
export const STALE_MEMORY_LIMITS = { entries: 200, paths: 50, path: 1024 } as const;

/** The staleness findings as the route accepts them: a path git lists past the schema's length
 * is left out rather than having the whole report refused. */
export function boundStaleMemories(stale: readonly StaleMemory[]): StaleMemory[] {
  const L = STALE_MEMORY_LIMITS;
  return stale.slice(0, L.entries).map((s) => ({
    ...s,
    changedPaths: s.changedPaths.filter((p) => p.length <= L.path).slice(0, L.paths),
  }));
}

function clipMessage(message: string | undefined): string | undefined {
  if (message === undefined || message.length <= MAX_PROGRESS_MESSAGE) return message;
  return `${message.slice(0, MAX_PROGRESS_MESSAGE)}…`;
}

/**
 * The setup failures as the route accepts them: at most `entries`, each label at most `step`
 * characters and never empty, each output tail or error at most `text` — the END of a tail, which
 * is where a failure says why, and the START of an error, which names the file — and every number
 * inside its range. The runner bounds them already; this holds whatever it is handed.
 */
export function boundSetupFailures(failures: readonly SetupFailureReport[]): SetupFailureReport[] {
  const L = SETUP_FAILURE_LIMITS;
  const clamp = (n: number, min: number, max: number) =>
    Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;
  return failures.slice(0, L.entries).map((f): SetupFailureReport => {
    if (f.kind === "discarded") return { ...f, after: f.after.slice(0, L.entries) };
    if (f.kind === "dirty") {
      return {
        ...f,
        files: f.files.slice(0, L.entries)
          .map((file) => file.length > L.step ? `${file.slice(0, L.step - 1)}…` : file),
      };
    }
    if (f.kind === "invalid") {
      const error = f.error.length > L.text ? `${f.error.slice(0, L.text - 1)}…` : f.error;
      return { ...f, error: error === "" ? "setup.yml is invalid" : error };
    }
    const index = clamp(f.index, 1, L.position);
    const step = f.step.length > L.step ? `${f.step.slice(0, L.step - 1)}…` : f.step;
    return {
      ...f,
      step: step === "" ? `step ${index}` : step,
      index,
      total: clamp(f.total, 1, L.position),
      code: clamp(f.code, 0, L.code),
      output: f.output.length > L.text ? `…${f.output.slice(-(L.text - 1))}` : f.output,
    };
  });
}

/** The control plane bounds its answer to one message's worth; this is the runner's own cap. */
const MAX_STATUS_CHARS = 32 * 1024;
const RESULT_DELIVERY_ATTEMPTS = 3;
const RESULT_RETRY_PAUSE_MS = 1_000;
const SPEC_FETCH_ATTEMPTS = 3;
/** The claim waits on the forge (the thread is read live before the task is re-targeted), so it
 * gets its own budget rather than the ordinary control-plane one; so does a patch report, whose
 * birth may ask the forge about the bundle. */
const CLAIM_TIMEOUT_MS = 30_000;
const SPEC_FETCH_RETRY_PAUSE_MS = 1_000;
const BOOTSTRAP_TIMEOUT_MS = 30_000;
/** The exchange's token stays redeemable for the whole startup grace, so it can wait out a
 * control-plane rollout: pauses double from the first and stop growing here, about a minute and
 * a half of them across all attempts. Nothing else can conclude the run if it gives up. */
const BOOTSTRAP_ATTEMPTS = 8;
const BOOTSTRAP_MAX_PAUSE_MS = 30_000;
/** A checks request resolves the base's checks file through the forge before it answers, so it
 * gets the claim's budget rather than the ordinary control-plane one. The control plane answers
 * within about ten seconds and finishes a slow resolution on its own, so running out of this is
 * "no answer yet", never a refusal. */
const CHECKS_TIMEOUT_MS = 30_000;
/** The declared checks are read through the forge, one file per repo; the control plane bounds
 * its answer at fifteen seconds, and this leaves room for the trip. */
const CHECKS_DECLARED_TIMEOUT_MS = 20_000;
/** A skill bundle is up to 512 KiB of files, base64 in JSON: more than an ordinary answer, and
 * fetched while the clone runs, so it gets a budget of its own. */
const SKILL_FETCH_TIMEOUT_MS = 20_000;

/** The base route every run-scoped request hangs off; a trailing slash on baseUrl is tolerated. */
function runRoute(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/runs/${encodeURIComponent(runId)}`;
}

export interface HttpOrchestratorGatewayOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  baseUrl: string;
  /** The run-scoped bearer sent on every request — a run speaks only for itself. */
  runToken: string;
  /** The run id, which addresses every route (it equals the work item id). */
  runId: string;
  /** Beat cadence. Must sit well under the orchestrator's liveness timeout. */
  heartbeatIntervalMs: number;
  /** Per-request deadline for every POST. */
  requestTimeoutMs?: number;
  /** Pause between result delivery attempts. */
  resultRetryPauseMs?: number;
  /**
   * Called at most once, when the orchestrator answers a beat asking for this run to stop.
   * Wire it to the same graceful cancel the inbound control API triggers — the run must not be
   * able to tell which channel asked.
   */
  onCancelRequested?: () => void;
  diag: Diagnostics;
}

export interface HttpOrchestratorGateway extends OrchestratorGateway {
  /** Stops the heartbeat timer. Idempotent; main's disposer backstop for abnormal exits. */
  shutdown(): void;
}

/**
 * Builds the HTTP gateway and starts its heartbeat timer.
 * Beats begin once the first `reportProgress` supplies a phase; every report also beats
 * immediately (or, behind a beat in flight, right after it), so the orchestrator's view is fresh
 * rather than up to a full interval stale.
 */
export function httpOrchestratorGateway(
  opts: HttpOrchestratorGatewayOptions,
): HttpOrchestratorGateway {
  const { runId, diag } = opts;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryPauseMs = opts.resultRetryPauseMs ?? RESULT_RETRY_PAUSE_MS;
  const route = runRoute(opts.baseUrl, runId);
  const headers = {
    authorization: `Bearer ${opts.runToken}`,
    "content-type": "application/json",
  };

  let seq = 0;
  let lastPhase: Phase | null = null;
  let lastMessage: string | undefined;
  // The idle deadline as last reported; undefined until the run reports one at all (its beats
  // before then carry no such field).
  let lastIdleDeadline: string | null | undefined;
  let lastIdleState: Progress["idleState"];
  // The outcome the agent last declared; sticky, so every beat after it carries it. Null once
  // cleared (a message reached the agent since), and every later beat carries the clear, as it
  // would the outcome: a beat lost on the way takes neither with it.
  let lastDeclaredOutcome: Progress["declaredOutcome"];
  // Whether the agent called its finish tool; sticky like the outcome.
  let lastFinished = false;
  // Whether this control plane refused a beat carrying "in-progress": one that predates the
  // outcome, in a rolling deploy, answers 400 to every beat that carries it — and the outcome is
  // sticky, so the run would go unheard (no cancel, then reaped as lost). From then on its beats
  // say null instead: the agent has not said it is done, which is all such a control plane can
  // read in it, and what offers no person's finish. "suspected" after a 400 to a beat carrying
  // it, while the next beat tries null: only if that one is taken was the outcome the cause
  // ("refused"); refused again, the 400 was about something else, and in-progress goes back on.
  let inProgress: "accepted" | "suspected" | "refused" = "accepted";
  let inFlight = false;
  // A report made while a beat was in flight: one more beat is sent once that one settles, so
  // the report is not left for the next tick of the timer.
  let beatOwed = false;
  // Set once the result is being reported: no beat is sent after it.
  let stopped = false;
  let cancelDelivered = false;

  // One shot, every failure a warn under `event`: a finding the run reports. Resolves once the
  // request is answered or timed out and never rejects, so a caller may wait on it or not.
  const reportOnce = async (path: string, body: unknown, event: string): Promise<void> => {
    try {
      const res = await fetch(`${route}/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (!res.ok) diag.warn(`${event}.rejected`, { runId, status: res.status });
    } catch (err) {
      diag.warn(`${event}.unreachable`, { runId, err: String(err) });
    }
  };

  // Sends one heartbeat. Total by construction: every outcome degrades to a warn, so callers may
  // fire-and-forget it from timers and the port.
  const beat = async (owed = false): Promise<void> => {
    // No beat before the first phase is known (the payload demands one), and no overlap. A tick
    // skipped behind a slow POST loses nothing, since the next one carries the newest phase; a
    // REPORT made behind one is owed a beat, and the one follow-up carries every report made
    // meanwhile.
    if (lastPhase === null) return;
    if (inFlight) {
      if (owed) beatOwed = true;
      return;
    }
    inFlight = true;
    // This beat says null in place of an in-progress a 400 was suspected of: it settles why.
    const probing = inProgress === "suspected" && lastDeclaredOutcome === "in-progress";
    const payload = {
      seq: seq++,
      phase: lastPhase,
      message: lastMessage,
      ...(lastIdleDeadline === undefined ? {} : { idleDeadlineAt: lastIdleDeadline }),
      ...(lastIdleState === undefined ? {} : { idleState: lastIdleState }),
      ...(lastDeclaredOutcome === undefined ? {} : {
        declaredOutcome: lastDeclaredOutcome === "in-progress" && inProgress !== "accepted"
          ? null
          : lastDeclaredOutcome,
      }),
      ...(lastFinished ? { finished: true } : {}),
    };
    try {
      const res = await fetch(`${route}/heartbeat`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The probe after a suspected refusal settles what the 400 was about.
      if (probing) {
        inProgress = res.ok ? "refused" : res.status === 400 ? "accepted" : "suspected";
      }
      if (res.ok) {
        // Tolerant by construction, in BOTH directions of a rolling deploy: an orchestrator that
        // predates this answers 204 with no body, and one that postdates a runner sends a body
        // the runner ignores. Anything unparseable is simply "no cancel asked for" — the push
        // channel and the reaper are still there, so guessing here would buy nothing.
        const answer = await res.json().catch(() => null) as { cancel?: unknown } | null;
        if (answer?.cancel === true && !cancelDelivered) {
          cancelDelivered = true;
          diag.debug("orchestrator.heartbeat.cancel_requested", { runId });
          opts.onCancelRequested?.();
        }
      } else {
        // Drain, so the connection is free for the next beat.
        await res.body?.cancel();
        if (
          res.status === 400 && payload.declaredOutcome === "in-progress" &&
          inProgress === "accepted"
        ) {
          inProgress = "suspected";
          beatOwed = true;
          diag.warn("orchestrator.heartbeat.in_progress_refused", { runId });
        }
        // 409 means the orchestrator already concluded this run: worth knowing, but not ours to
        // act on. Whatever it decided, the run either finishes and reports, or gets SIGTERMed.
        const event = res.status === 409
          ? "orchestrator.heartbeat.terminal"
          : "orchestrator.heartbeat.failed";
        diag.warn(event, { runId, status: res.status });
      }
    } catch (err) {
      diag.warn("orchestrator.heartbeat.unreachable", { runId, err: String(err) });
    } finally {
      inFlight = false;
      if (beatOwed && !stopped) {
        beatOwed = false;
        void beat();
      }
    }
  };

  const timer = setInterval(() => void beat(), opts.heartbeatIntervalMs);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  return {
    reportProgress(p: Progress): void {
      lastPhase = p.phase;
      // A deadline report carries no message and must not blank the last one: the phase's
      // narration ("waiting for db") is still what the run is doing. Nor does an outcome's.
      if (p.declaredOutcome !== undefined) lastDeclaredOutcome = p.declaredOutcome;
      if (p.finished === true) lastFinished = true;
      if (p.idleDeadlineAt !== undefined) lastIdleDeadline = p.idleDeadlineAt;
      else if (p.declaredOutcome === undefined) lastMessage = clipMessage(p.message);
      if (p.idleState !== undefined) lastIdleState = p.idleState;
      if (lastIdleState !== undefined && (p.idleDeadlineAt === null || p.phase !== "running")) {
        lastIdleState = null;
      }
      void beat(true);
    },

    reportStaleMemories(stale: StaleMemory[]): void {
      // The next brief will run the check again: a report that did not land is a signal lost,
      // never a run stalled.
      void reportOnce("memory/stale", { stale: boundStaleMemories(stale) }, "orchestrator.stale");
    },

    reportStaleBases(bases: StaleBase[]): void {
      // The name and the ref are the agent's to read in the layout; the orchestrator knows both
      // from the run the path names.
      void reportOnce(
        "base/stale",
        { bases: bases.map(({ path, commit, since }) => ({ path, commit, since })) },
        "orchestrator.base_stale",
      );
    },

    reportSetupFailures(failures: SetupFailureReport[]): Promise<void> {
      // A warning on the run's history, waited on (within the timeout) so a result that follows
      // setup cannot land first and close the run to it. A report that did not land is an event
      // missing from it, never a run held up — the agent was told either way.
      // Held to the route's bounds here (`boundSetupFailures`): one field past them would have
      // the whole report refused, and no repo's warning would land.
      return reportOnce(
        "setup/failed",
        { failures: boundSetupFailures(failures) },
        "orchestrator.setup_failed",
      );
    },

    reportSkills(report: SkillReport): void {
      // The trail is the only reader: a report that did not land is an event missing from the
      // run's history, never a run held up.
      void reportOnce("skills/report", report, "orchestrator.skills");
    },

    async reportResult(r: Result): Promise<void> {
      // Stopped first, so no beat is scheduled after the terminal report.
      stop();
      // The orchestrator re-acks duplicate results, which is what makes this retry safe: a
      // transient blip must not convert a finished run into an abnormal exit. Only exhausting
      // every attempt rejects — and that rejection is the abnormal exit, per the port contract.
      let failure: unknown;
      for (let attempt = 1; attempt <= RESULT_DELIVERY_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(`${route}/result`, {
            method: "POST",
            headers,
            body: JSON.stringify(r),
            signal: AbortSignal.timeout(timeoutMs),
          });
          await res.body?.cancel();
          if (res.ok) return;
          failure = new Error(`the orchestrator answered ${res.status}`);
        } catch (err) {
          failure = err;
        }
        if (attempt < RESULT_DELIVERY_ATTEMPTS) {
          diag.warn("orchestrator.reportResult.retrying", { runId, attempt, err: String(failure) });
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
        }
      }
      throw new Error(
        `result delivery failed after ${RESULT_DELIVERY_ATTEMPTS} attempts: ${String(failure)}`,
      );
    },

    shutdown: stop,
  };
}

export interface RunChannelOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  baseUrl: string;
  /** The run-scoped bearer sent on every request — a run speaks only for itself. */
  runToken: string;
  runId: string;
  /** Per-request deadline for the patch report; the poll's own is its wait plus this. */
  requestTimeoutMs?: number;
  diag: Diagnostics;
}

/**
 * The inbox over `GET /v1/runs/:id/messages?after=<seq>&wait=<s>`: the orchestrator holds the
 * request until a message past the cursor exists or the wait elapses, and the next call's
 * `after` is the acknowledgement that stamps delivery. Every failure throws — the core pauses
 * and asks again — except the caller's own abort, which answers nothing at all.
 */
export function httpInbox(opts: RunChannelOptions): Inbox {
  const { runId, diag } = opts;
  const route = runRoute(opts.baseUrl, runId);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    async poll(after, { waitMs, signal, ack }): Promise<InboundMessage[]> {
      if (signal.aborted) return [];
      const waitS = Math.max(0, Math.min(25, Math.floor(waitMs / 1000)));
      const url = `${route}/messages?after=${after}&wait=${waitS}${ack === false ? "&ack=0" : ""}`;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { authorization: `Bearer ${opts.runToken}` },
          // The request outlives the server's hold by the ordinary request budget, and ends
          // with the caller's signal — a cancelled run must not hang on its own poll.
          signal: AbortSignal.any([signal, AbortSignal.timeout(waitS * 1000 + timeoutMs)]),
        });
      } catch (err) {
        if (signal.aborted) return [];
        throw err;
      }
      if (!res.ok) {
        await res.body?.cancel();
        // 409: the orchestrator already concluded this run — a diagnosis, like on a beat; the
        // core's loop backs off and the run ends however it was going to.
        throw new Error(`the orchestrator answered ${res.status}`);
      }
      // Message by message: one bad message never fails the batch (schema.ts).
      const parsed = parseInboundMessages(await res.json());
      if (!parsed.ok) {
        diag.warn("orchestrator.messages.malformed", { runId, issues: parsed.issues });
        throw new Error(`the inbox answer is malformed: ${parsed.issues}`);
      }
      for (const d of parsed.degraded) {
        diag.warn("orchestrator.messages.degraded", {
          runId,
          seq: d.seq,
          dropped: d.what,
          issues: d.issues,
        });
      }
      return parsed.messages;
    },
  };
}

/** The control plane's per-image cap (core/attachments.ts there), restated — and pinned to it by
 * tests/images_test.ts: a body past it is not an image this run was handed, whatever answered. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** The most of a check log the runner takes: the control plane keeps 4 Mi characters of one,
 * which UTF-8 spells in at most four bytes each. */
export const MAX_CHECK_LOG_FETCH_BYTES = 16 * 1024 * 1024;
/** How long a check log's fetch, body and all, may take. */
const CHECK_LOG_TIMEOUT_MS = 60_000;
/** An image is up to 5 MiB, not a heartbeat: it gets longer than the ordinary request budget. */
const ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * The run's images over `GET /v1/runs/:id/runner/attachments/:attachmentId`, run-token
 * authenticated like every other door here. The body is read under the cap as it streams. A
 * network error (on the request or mid-body) or a 5xx is retried a bounded number of times, as
 * the spec and skill fetches are: one stray balancer answer would otherwise cost the agent that
 * image for good. A 4xx, or a body past the cap, is definitive and throws at once. Any failure
 * throws in the end; the core tells the agent that one image is missing.
 *
 * And `upload`, the other way, over `POST /v1/runs/:id/runner/attachments`: the same bearer,
 * per-attempt timeout and 5xx retries. A 4xx or retries run out answers null, logged; a 409 (the
 * run is over, or keeps all the images it may) also stops every later upload of the run, since
 * each would be refused the same.
 */
export function httpAttachments(
  opts: RunChannelOptions & { retryPauseMs?: number },
): Attachments {
  const route = runRoute(opts.baseUrl, opts.runId);
  const retryPauseMs = opts.retryPauseMs ?? SPEC_FETCH_RETRY_PAUSE_MS;

  /** One attempt: the bytes, a failure worth another attempt, or a throw that is final. */
  const attempt = async (ref: AttachmentRef): Promise<Uint8Array | { retry: unknown }> => {
    let res: Response;
    try {
      res = await fetch(`${route}/runner/attachments/${encodeURIComponent(ref.id)}`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
      });
    } catch (err) {
      return { retry: err };
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      return { retry: new Error(`the orchestrator answered ${res.status}`) };
    }
    if (!res.ok || res.body === null) {
      await res.body?.cancel();
      throw new Error(`the orchestrator answered ${res.status}`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let seen = 0;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        return { retry: err };
      }
      if (next.done) break;
      seen += next.value.byteLength;
      if (seen > MAX_ATTACHMENT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`the image is over ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(seen);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  /** Set by a 409 to an upload: the run is over or holds all the images it may keep, and every
   * later upload would be refused the same — so none is sent. Not by `{error: "bytes"}`: that
   * image did not fit what is left of the run's byte budget, and a smaller one still may. */
  let uploadsClosed: string | null = null;

  /** One upload attempt: the ref, a failure worth another attempt, or null, final. */
  const uploadOnce = async (
    bytes: Uint8Array,
    imageRef: string,
    signal: AbortSignal | undefined,
  ): Promise<AttachmentRef | null | { retry: unknown }> => {
    let res: Response;
    try {
      res = await fetch(`${route}/runner/attachments?ref=${encodeURIComponent(imageRef)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.runToken}`,
          "content-type": "application/octet-stream",
        },
        body: bytes as BodyInit,
        signal: signal === undefined
          ? AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS)]),
      });
    } catch (err) {
      return signal?.aborted ? null : { retry: err };
    }
    // A 429 is the run's other uploads still in flight there (the control plane takes two at
    // once): a moment later it takes this one, so it is retried like a 5xx, never final.
    if (res.status >= 500 || res.status === 429) {
      await res.body?.cancel();
      return { retry: new Error(`the orchestrator answered ${res.status}`) };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return res.ok ? { retry: err } : (logRefusal(res.status, null), null);
    }
    if (!res.ok) {
      const error = typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : null;
      logRefusal(res.status, error);
      if (res.status === 409 && error !== "bytes") uploadsClosed = error ?? "409";
      return null;
    }
    const parsed = AttachmentRefSchema.safeParse(body);
    if (!parsed.success) {
      opts.diag.warn("orchestrator.attachment.upload_malformed", {
        runId: opts.runId,
        issues: describeIssues(parsed.error),
      });
      return null;
    }
    return { id: parsed.data.id, mime: parsed.data.mime };
  };
  const logRefusal = (status: number, error: string | null) =>
    opts.diag.warn("orchestrator.attachment.upload_refused", {
      runId: opts.runId,
      status,
      error,
    });

  return {
    async upload(bytes, imageRef, signal) {
      if (uploadsClosed !== null) return null;
      for (let n = 1; n <= SPEC_FETCH_ATTEMPTS; n++) {
        if (signal?.aborted) return null;
        const got = await uploadOnce(bytes, imageRef, signal);
        if (got === null) return null;
        if (!("retry" in got)) {
          opts.diag.debug("orchestrator.attachment.uploaded", {
            runId: opts.runId,
            id: got.id,
            bytes: bytes.byteLength,
          });
          return got;
        }
        opts.diag.warn("orchestrator.attachment.upload_failed", {
          runId: opts.runId,
          attempt: n,
          err: String(got.retry),
        });
        // Backing off, n pauses after the nth failure: a busy door gets longer each time.
        if (n < SPEC_FETCH_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs * n));
        }
      }
      return null;
    },
    async resolveImageRefs(refs) {
      let failure: unknown;
      for (let n = 1; n <= SPEC_FETCH_ATTEMPTS; n++) {
        let res: Response;
        try {
          res = await fetch(`${route}/runner/images/resolve`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${opts.runToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ refs }),
            signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          failure = err;
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs * n));
          continue;
        }
        const body = await res.json().catch(() => null);
        const parsed = res.ok ? ImageRefsAnswerSchema.safeParse(body) : null;
        if (parsed?.success) {
          return { known: parsed.data.images.map((i) => i.ref), unknown: parsed.data.unknown };
        }
        failure = new Error(`the orchestrator answered ${res.status}`);
        if (res.status < 500) break;
        await new Promise((resolve) => setTimeout(resolve, retryPauseMs * n));
      }
      throw failure;
    },
    async fetch(ref) {
      let failure: unknown;
      for (let n = 1; n <= SPEC_FETCH_ATTEMPTS; n++) {
        const got = await attempt(ref);
        if (got instanceof Uint8Array) {
          opts.diag.debug("orchestrator.attachment", {
            runId: opts.runId,
            id: ref.id,
            bytes: got.byteLength,
          });
          return got;
        }
        failure = got.retry;
        if (n < SPEC_FETCH_ATTEMPTS) {
          opts.diag.warn("orchestrator.attachment.retrying", {
            runId: opts.runId,
            id: ref.id,
            attempt: n,
            err: String(failure),
          });
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
        }
      }
      throw failure;
    },
  };
}

/**
 * How long a log upload may take in all, from the call — its wait for a slot included — and any
 * one try at most. It outlasts the control plane's own 15 s deadline on a body, the most a claim
 * another upload holds can keep this one waiting ("busy"), with room for a try after it. The core
 * gives the step a little longer (core/background.ts LOG_STEP_MS, 35 s), and the run's close a
 * bound that covers an end record's tries before it (CLOSE_BOUND_MS, 60 s). Eight jobs ending at
 * once queue two at a time here, and each still has its own 30 s from its call.
 */
export const BACKGROUND_LOG_DEADLINE_MS = 30_000;
/** The control plane takes this many log uploads of a run at once (more answer 429). */
const BACKGROUND_LOGS_AT_ONCE = 2;
/** The longest pause between two tries of a log upload. */
const BACKGROUND_LOG_PAUSE_CAP_MS = 2_000;

/**
 * The background commands' durable record over `/v1/runs/:id/runner/background/:jobId` — `PUT`
 * the started record, `POST …/exit` how it ended, `PUT …/log` the end of its log as text — on
 * the run token like every other door here. Every call is idempotent on the control plane:
 * - a record is tried a bounded number of times, backing off, while the answer is a network
 *   error, a 5xx, a 429 or a 408; any other 4xx is final (the run is over, a cap is reached)
 * - a log waits for one of the control plane's two upload slots here rather than being refused
 *   there, and is tried again with jittered backoff while the answer is transient (a 429 from a
 *   slot taken elsewhere, a 408, a 5xx, a 409 whose `code` is "busy": another upload holds its
 *   claim) until its deadline, counted from the call; any other 409 is final ("running": the
 *   exit is not recorded; "lost": the claim went elsewhere)
 * Nothing here throws: each call answers whether it landed, and a record that did not costs the
 * run page that record.
 */
export function httpBackgroundRecords(
  opts: RunChannelOptions & {
    retryPauseMs?: number;
    logDeadlineMs?: number;
    logsAtOnce?: number;
    /** The clock deadlines are counted on; tests pass a fake one. */
    now?: () => number;
  },
): BackgroundRecords {
  const route = runRoute(opts.baseUrl, opts.runId);
  const retryPauseMs = opts.retryPauseMs ?? SPEC_FETCH_RETRY_PAUSE_MS;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const logDeadlineMs = opts.logDeadlineMs ?? BACKGROUND_LOG_DEADLINE_MS;
  const logsAtOnce = opts.logsAtOnce ?? BACKGROUND_LOGS_AT_ONCE;
  const now = opts.now ?? Date.now;

  let uploading = 0;
  const queue: Array<() => void> = [];
  const slot = async () => {
    while (uploading >= logsAtOnce) await new Promise<void>((resolve) => queue.push(resolve));
    uploading++;
  };
  const free = () => {
    uploading--;
    queue.shift()?.();
  };

  /** One try: landed (with the answer's body), worth another try, or final. A 409 is final
   * unless its `code` says the log's claim is busy, held by another upload that will let go. */
  const attempt = async (
    url: string,
    request: { method: string; body: string; type: string; timeoutMs: number },
  ): Promise<{ landed: unknown } | { retry: string } | { final: number }> => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: request.method,
        headers: { authorization: `Bearer ${opts.runToken}`, "content-type": request.type },
        body: request.body,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (err) {
      return { retry: String(err) };
    }
    if (res.ok) return { landed: await res.json().catch(() => null) };
    if (res.status === 409) {
      const body = await res.json().catch(() => null) as { code?: unknown } | null;
      return body?.code === "busy" ? { retry: "the log's claim is busy" } : { final: 409 };
    }
    await res.body?.cancel();
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      return { retry: `the orchestrator answered ${res.status}` };
    }
    return { final: res.status };
  };

  const send = async (
    what: "started" | "ended" | "log",
    jobId: string,
    request: { method: string; path: string; body: string; type: string; timeoutMs: number },
    deadline: number | null = null,
  ): Promise<boolean> => {
    const url = `${route}/runner/background/${encodeURIComponent(jobId)}${request.path}`;
    for (let n = 1;; n++) {
      if (deadline !== null && now() >= deadline) {
        opts.diag.warn("orchestrator.background.failed", {
          runId: opts.runId,
          jobId,
          what,
          attempts: n - 1,
          err: "its deadline passed",
        });
        return false;
      }
      const got = await attempt(url, {
        ...request,
        timeoutMs: deadline === null
          ? request.timeoutMs
          : Math.max(1, Math.min(request.timeoutMs, deadline - now())),
      });
      if ("landed" in got) {
        const landed = got.landed as { stored?: unknown; created?: unknown } | null;
        if (what === "log" && landed?.stored === false) {
          opts.diag.warn("orchestrator.background.log_not_stored", { runId: opts.runId, jobId });
        }
        // The runner is the only one that mints a job: a start it did not create was forged.
        if (what === "started" && landed?.created === false) {
          opts.diag.warn("orchestrator.background.start_forged", { runId: opts.runId, jobId });
        }
        opts.diag.debug("orchestrator.background.recorded", { runId: opts.runId, jobId, what });
        return true;
      }
      if ("final" in got) {
        opts.diag.warn("orchestrator.background.refused", {
          runId: opts.runId,
          jobId,
          what,
          status: got.final,
        });
        return false;
      }
      // Each transient answer is the ordinary course of a busy control plane; only giving up
      // is worth a warning.
      opts.diag.debug("orchestrator.background.retry", {
        runId: opts.runId,
        jobId,
        what,
        attempt: n,
        err: got.retry,
      });
      const pause = deadline === null
        ? retryPauseMs * n
        : Math.min(BACKGROUND_LOG_PAUSE_CAP_MS, retryPauseMs * 2 ** (n - 1)) *
          (0.5 + Math.random() / 2);
      if (deadline === null ? n >= SPEC_FETCH_ATTEMPTS : now() + pause >= deadline) {
        opts.diag.warn("orchestrator.background.failed", {
          runId: opts.runId,
          jobId,
          what,
          attempts: n,
          err: got.retry,
        });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  };

  return {
    started(record: BackgroundStartedRecord) {
      const { id, ...fields } = record;
      return send("started", id, {
        method: "PUT",
        path: "",
        body: JSON.stringify(fields),
        type: "application/json",
        timeoutMs,
      });
    },
    ended(id: string, record: BackgroundEndedRecord) {
      return send("ended", id, {
        method: "POST",
        path: "/exit",
        body: JSON.stringify(record),
        type: "application/json",
        timeoutMs,
      });
    },
    async log(id: string, text: string) {
      // From the call: the wait for a slot spends the same deadline as the tries.
      const deadline = now() + logDeadlineMs;
      await slot();
      try {
        return await send("log", id, {
          method: "PUT",
          path: "/log",
          body: text,
          type: "text/plain; charset=utf-8",
          timeoutMs: logDeadlineMs,
        }, deadline);
      } finally {
        free();
      }
    },
  };
}

/**
 * `environment_status` over `GET /v1/runs/:id/environment`: the control plane's text, bounded,
 * handed on verbatim. Anything but a well-formed 200 throws; the tool says it could not ask.
 */
export function httpEnvironmentStatus(opts: RunChannelOptions): EnvironmentStatus {
  const { runId, diag } = opts;
  const route = runRoute(opts.baseUrl, runId);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    async read() {
      const res = await fetch(`${route}/environment`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null) as
        | { text?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new Error(`the orchestrator could not say: ${reason}`);
      }
      if (typeof body?.text !== "string") {
        throw new Error("the environment status answer is malformed");
      }
      diag.debug("orchestrator.environment_status", { runId });
      return body.text.slice(0, MAX_STATUS_CHARS);
    },
  };
}

/** A publish carries up to 2 MiB and waits on the control plane's sanitizer (a 3 s budget plus
 * the worker's start); the runner has already waited on its own uploads still in flight, so the
 * image-ref check does not wait. More than an ordinary request's budget. */
const ARTIFACT_TIMEOUT_MS = 30_000;

/**
 * `publish_artifact` over `POST /v1/runs/:id/artifacts`, `fetch_artifact` over
 * `GET /v1/runs/:id/artifacts/:artifactId`. A 200 or 201 with what was asked for is the answer;
 * any other answer that carries the control plane's words is a refusal, handed to the agent as
 * they are; anything else throws, and the tool says it could not ask.
 */
export function httpArtifactPublisher(opts: RunChannelOptions): ArtifactPublisher {
  const { runId, diag } = opts;
  const route = `${runRoute(opts.baseUrl, runId)}/artifacts`;
  const timeoutMs = Math.max(
    opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ARTIFACT_TIMEOUT_MS,
  );
  return {
    async publish(request) {
      const res = await fetch(route, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.runToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null) as
        | { id?: unknown; version?: unknown; url?: unknown; unchanged?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        // A 5xx or an answer without words is the platform failing, not refusing.
        if (res.status >= 500 || typeof body?.error !== "string") {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : `the orchestrator answered ${res.status}`,
          );
        }
        return { kind: "refused", reason: body.error };
      }
      if (typeof body?.id !== "string" || typeof body?.version !== "number") {
        throw new Error("the artifact publish answer is malformed");
      }
      diag.debug("orchestrator.artifact_published", { runId, id: body.id, version: body.version });
      return {
        kind: "published",
        id: body.id,
        version: body.version,
        url: typeof body.url === "string" ? body.url : null,
        created: res.status === 201,
        unchanged: body.unchanged === true,
      };
    },
    async fetch(artifactId) {
      const res = await fetch(`${route}/${encodeURIComponent(artifactId)}`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null) as
        | { id?: unknown; title?: unknown; version?: unknown; html?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        if (res.status >= 500 || typeof body?.error !== "string") {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : `the orchestrator answered ${res.status}`,
          );
        }
        return { kind: "refused", reason: body.error };
      }
      if (
        typeof body?.id !== "string" || typeof body?.title !== "string" ||
        typeof body?.version !== "number" || typeof body?.html !== "string"
      ) {
        throw new Error("the artifact fetch answer is malformed");
      }
      return {
        kind: "fetched",
        id: body.id,
        title: body.title,
        version: body.version,
        html: body.html,
      };
    },
  };
}

/**
 * The checks channel over `/v1/runs/:id/checks`: a POST asks for a suite on a commit the run just
 * uploaded (202, or 200 when there is nothing to run — the text says why; no answer in time is
 * `ChecksUnansweredError`), a GET reads where the run's suites stand. Both hand on the control
 * plane's text, bounded; anything else throws with the control plane's own reason when it gave
 * one (a refusal is written for the agent). `?awaiting=1` answers only which verdicts are
 * still owed, and `/declared` what each repo's checks file declares; only the runner reads
 * those two.
 */
export function httpChecks(
  opts: RunChannelOptions & { checksTimeoutMs?: number; declaredTimeoutMs?: number },
): ChecksChannel {
  const { runId, diag } = opts;
  const route = `${runRoute(opts.baseUrl, runId)}/checks`;
  const timeoutMs = opts.checksTimeoutMs ?? Math.max(
    opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    CHECKS_TIMEOUT_MS,
  );
  const read = async (res: Response, what: string): Promise<string> => {
    // A deadline that lands while the body is read is still no answer in time, never a malformed
    // one: a 202 read as a refusal would leave the run not waiting for checks that started.
    const body = await res.json().catch((err) => {
      if (
        err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        throw err;
      }
      return null;
    }) as
      | { text?: unknown; error?: unknown }
      | null;
    if (!res.ok) {
      throw new Error(
        typeof body?.error === "string" ? body.error : `the orchestrator answered ${res.status}`,
      );
    }
    if (typeof body?.text !== "string") throw new Error(`the ${what} answer is malformed`);
    return body.text.slice(0, MAX_STATUS_CHARS);
  };
  return {
    async request(args) {
      try {
        const res = await fetch(route, {
          method: "POST",
          headers: {
            authorization: `Bearer ${opts.runToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await read(res, "checks request");
        diag.debug("orchestrator.checks_requested", { runId, status: res.status });
        return { requested: res.status === 202, text };
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          diag.warn("orchestrator.checks_unanswered", { runId, timeoutMs });
          throw new ChecksUnansweredError();
        }
        throw err;
      }
    },
    async status(at) {
      const query = new URLSearchParams();
      for (const { path, commit } of at?.commits ?? []) query.append("at", `${commit}:${path}`);
      if (at?.named) query.set("named", "1");
      const qs = query.size === 0 ? "" : `?${query}`;
      const res = await fetch(`${route}${qs}`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await read(res, "check status");
      diag.debug("orchestrator.check_status", { runId, commits: at?.commits.length ?? 0 });
      return text;
    },
    async log(args) {
      const query = new URLSearchParams({ check: args.check });
      if (args.generation !== undefined) query.set("generation", String(args.generation));
      const res = await fetch(
        `${route}/${encodeURIComponent(args.suiteId)}/log?${query}`,
        {
          headers: { authorization: `Bearer ${opts.runToken}` },
          signal: AbortSignal.timeout(CHECK_LOG_TIMEOUT_MS),
        },
      );
      if (!res.ok || res.body === null) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        const reason = typeof body?.error === "string" ? body.error : null;
        // A 4xx with a reason is the platform's answer for the agent; anything else is a failure
        // to ask.
        if (reason !== null && res.status >= 400 && res.status < 500) {
          throw new ChecksRefusedError(reason);
        }
        // No route for it: a control plane older than check logs. Asking again changes nothing.
        if (res.status === 404 || res.status === 405) {
          throw new ChecksRefusedError("the platform cannot hand out check logs yet");
        }
        throw new Error(reason ?? `the orchestrator answered ${res.status}`);
      }
      const generation = Number(res.headers.get("x-ryph-check-generation"));
      if (!Number.isInteger(generation) || generation < 1) {
        await res.body.cancel();
        throw new Error("the check log answer is malformed");
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let seen = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        seen += next.value.byteLength;
        if (seen > MAX_CHECK_LOG_FETCH_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(`the log is over ${MAX_CHECK_LOG_FETCH_BYTES} bytes`);
        }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(seen);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      diag.debug("orchestrator.check_log", { runId, suiteId: args.suiteId, bytes: seen });
      return { bytes, generation };
    },
    async awaiting() {
      const res = await fetch(`${route}?awaiting=1`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null) as
        | { owed?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `the orchestrator answered ${res.status}`,
        );
      }
      const owed = body?.owed;
      if (!Array.isArray(owed) || !owed.every(isOwedVerdict)) {
        throw new Error("the checks awaiting answer is malformed");
      }
      return owed.map((v) => ({ id: v.id, requests: [...v.requests] }));
    },
    async declared(signal?: AbortSignal): Promise<ChecksDeclaration> {
      const timeout = AbortSignal.timeout(opts.declaredTimeoutMs ?? CHECKS_DECLARED_TIMEOUT_MS);
      const res = await fetch(`${route}/declared`, {
        headers: { authorization: `Bearer ${opts.runToken}` },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`the orchestrator answered ${res.status}`);
      }
      const parsed = DeclaredChecksAnswerSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`the declared checks are malformed: ${describeIssues(parsed.error)}`);
      }
      diag.debug("orchestrator.checks_declared", {
        runId,
        repos: parsed.data.declared.length,
        unread: parsed.data.unread.length,
      });
      return parsed.data;
    },
  };
}

/**
 * Frozen skills' files over `GET /v1/runs/:id/skills/:digest`: the bundle, held to its schema, or
 * null on a 404 (the control plane holds no such bundle for this run). A network error or a 5xx
 * is retried a bounded number of times, as the spec fetch is: one stray balancer answer would
 * otherwise cost the run that skill for good. Anything else throws at once; the core drops that
 * one skill. The digest goes into the path as it is — the spec's schema already held it to
 * `sha256:<hex>`, and a colon is legal in a path segment.
 */
export function httpSkillBundles(
  opts: RunChannelOptions & { retryPauseMs?: number },
): SkillBundles {
  const { runId, diag } = opts;
  const route = runRoute(opts.baseUrl, runId);
  const retryPauseMs = opts.retryPauseMs ?? SPEC_FETCH_RETRY_PAUSE_MS;
  return {
    async fetch(digest, signal): Promise<SkillBundle | null> {
      let res: Response | null = null;
      let failure: unknown;
      for (let attempt = 1; attempt <= SPEC_FETCH_ATTEMPTS; attempt++) {
        try {
          res = await fetch(`${route}/skills/${digest}`, {
            headers: { authorization: `Bearer ${opts.runToken}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(SKILL_FETCH_TIMEOUT_MS)]),
          });
          if (res.status < 500) break;
          await res.body?.cancel();
          failure = new Error(`the orchestrator answered ${res.status}`);
          res = null;
        } catch (err) {
          // The caller's own abort is the run ending: nothing to retry for.
          if (signal.aborted) throw err;
          failure = err;
        }
        if (attempt < SPEC_FETCH_ATTEMPTS) {
          diag.warn("orchestrator.fetch_skill.retrying", {
            runId,
            digest,
            attempt,
            err: String(failure),
          });
          await new Promise((resolve) => setTimeout(resolve, retryPauseMs));
          signal.throwIfAborted();
        }
      }
      if (res === null) throw failure;
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`the orchestrator answered ${res.status}`);
      }
      const parsed = SkillBundleSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error(`the skill bundle is malformed: ${describeIssues(parsed.error)}`);
      }
      diag.debug("orchestrator.skill_fetched", { runId, digest, files: parsed.data.files.length });
      return parsed.data;
    },
  };
}

/**
 * The patch reporter over `POST /v1/runs/:id/patches`: one report, one answer — the patch's id
 * and birth state (201), or the patch an earlier report of the same head already opened (200).
 * Anything else throws; the bundle is durable regardless, and the result lists the branch.
 *
 * The same channel carries the claim (`POST /v1/runs/:id/target`), for the same reason it
 * carries the report: both are the run telling the control plane what its work is becoming, and
 * both have to be ANSWERED — the agent asked.
 */
export function httpPatchReporter(opts: RunChannelOptions): PatchReporter {
  const { runId, diag } = opts;
  const route = runRoute(opts.baseUrl, runId);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    async reportPatch(report: PatchReport) {
      const res = await fetch(`${route}/patches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.runToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(report),
        // The claim's budget: a birth may wait on the forge reading the bundle's lineage.
        signal: AbortSignal.timeout(Math.max(timeoutMs, CLAIM_TIMEOUT_MS)),
      });
      const body = await res.json().catch(() => null) as
        | {
          patchId?: unknown;
          state?: unknown;
          url?: unknown;
          forgeUrl?: unknown;
          forgeRef?: unknown;
          error?: unknown;
        }
        | null;
      if (!res.ok) {
        const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new Error(`the orchestrator refused the patch report: ${reason}`);
      }
      if (typeof body?.patchId !== "string" || typeof body?.state !== "string") {
        throw new Error("the patch report's answer is malformed");
      }
      diag.debug("orchestrator.patch_reported", {
        runId,
        patchId: body.patchId,
        state: body.state,
      });
      // A control plane a version behind names no page: the answer goes without a link.
      const url = typeof body.url === "string" && /^https?:\/\//.test(body.url) ? body.url : null;
      const forgeUrl = typeof body.forgeUrl === "string" && /^https?:\/\//.test(body.forgeUrl)
        ? body.forgeUrl
        : null;
      const forgeRef = typeof body.forgeRef === "string" && body.forgeRef.length > 0
        ? body.forgeRef
        : null;
      return { patchId: body.patchId, state: body.state, url, forgeUrl, forgeRef };
    },

    async claimChangeRequest({ path, changeRequest }): Promise<ChangeRequestClaim> {
      const res = await fetch(`${route}/target`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.runToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path, changeRequest }),
        signal: AbortSignal.timeout(Math.max(timeoutMs, CLAIM_TIMEOUT_MS)),
      });
      const body = await res.json().catch(() => null) as
        | Partial<Record<keyof ChangeRequestClaim, unknown>> & {
          error?: unknown;
          recorded?: unknown;
        }
        | null;
      if (!res.ok) {
        // The refusals are written for the agent (closed, a fork, another run holds it), so the
        // reason is passed on as it came rather than dressed up as a transport failure.
        const reason = typeof body?.error === "string"
          ? body.error
          : `the orchestrator answered ${res.status}`;
        // A 4xx is a DECISION, and a decision means nothing was recorded. A 5xx usually is not:
        // it can land after the task was re-targeted, with just the answer lost, so it goes up
        // as an ordinary failure and the caller says the claim is unconfirmed. The exception is
        // a 5xx that SAYS it wrote nothing (`recorded: false`) — the control plane gave up
        // before touching anything, and its own words are the better answer for the agent.
        if (res.status < 500 || body?.recorded === false) {
          throw new ChangeRequestRefused(reason, res.status);
        }
        throw new Error(reason);
      }
      const fields = ["connectedRepoId", "thread", "ref", "headSha", "url"] as const;
      if (fields.some((field) => typeof body?.[field] !== "string")) {
        // A 2xx that cannot be read is the same unknown: the claim was very likely applied.
        throw new Error("the change request claim's answer is malformed");
      }
      // Held to the rule the spec's own refs are: it becomes this repo's target, and every
      // fetch of it after this names it.
      if (
        body?.targetRef !== undefined &&
        !RepoEntrySchema.shape.targetRef.safeParse(body.targetRef).success
      ) {
        throw new Error("the change request claim's answer is malformed");
      }
      const claim = body as unknown as ChangeRequestClaim;
      diag.debug("orchestrator.change_request_claimed", {
        runId,
        path,
        thread: claim.thread,
        ref: claim.ref,
        headSha: claim.headSha,
      });
      return {
        connectedRepoId: claim.connectedRepoId,
        thread: claim.thread,
        ref: claim.ref,
        ...(claim.targetRef === undefined ? {} : { targetRef: claim.targetRef }),
        headSha: claim.headSha,
        url: claim.url,
      };
    },
  };
}

export interface RunSpecFetchOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  baseUrl: string;
  /** The run-scoped bearer sent on every request — a run speaks only for itself. */
  runToken: string;
  /** The run whose spec to fetch. */
  runId: string;
  /** Per-request deadline. */
  requestTimeoutMs?: number;
  /** Pause between attempts on a retryable failure. */
  retryPauseMs?: number;
  diag: Diagnostics;
}

/**
 * Fetches the run's input from the orchestrator (`GET /v1/runs/:id/spec`) — the containerized
 * composition root's counterpart to `--work-item`. Returns the raw body text; validation stays
 * at the ingest boundary with every other JSON input. The fetch doubles as the boot handshake:
 * a run that cannot reach or authenticate against the orchestrator dies here, before doing
 * work it could never report.
 *
 * Network errors and 5xx answers are retried a bounded number of times; a 4xx is definitive
 * (bad token, unknown run) and throws immediately.
 */
export async function fetchRunSpec(opts: RunSpecFetchOptions): Promise<string> {
  return (await fetchBootDocument(opts, "spec", { notFoundOk: false }))!;
}

/**
 * Fetches the run's model credentials (`GET /v1/runs/:id/credentials`) — the second half of
 * the boot handshake. The answer is an env map (typically a run-scoped virtual key plus the
 * model-proxy address) that the composition root exports before the harness spawns; `{env:{}}`
 * is the normal answer for a run that calls no models. Returns the raw body text; validation
 * stays at the ingest boundary with every other JSON input.
 *
 * Same retry shape as the spec fetch: network errors and 5xx retried a bounded number of
 * times, 4xx definitive. A failure here is a boot failure — a run that cannot obtain the
 * credentials it needs should die before doing work, not run keyless and fail opaquely
 * mid-harness. One deliberate exception: a 404 means an orchestrator predating this endpoint,
 * and answers `null` — the feature being absent upstream must not fail every boot.
 */
export function fetchRunCredentials(opts: RunSpecFetchOptions): Promise<string | null> {
  return fetchBootDocument(opts, "credentials", { notFoundOk: true });
}

function fetchBootDocument(
  opts: RunSpecFetchOptions,
  doc: string,
  { notFoundOk }: { notFoundOk: boolean },
): Promise<string | null> {
  return bootRequest(opts, doc, { method: "GET", bearer: opts.runToken, notFoundOk });
}

export interface BootstrapExchangeOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  baseUrl: string;
  /** The one-shot bearer the launch environment carried, the only one it carries. */
  bootstrapToken: string;
  runId: string;
  /** Per-request deadline. */
  requestTimeoutMs?: number;
  /** Pause between attempts on a retryable failure. */
  retryPauseMs?: number;
  diag: Diagnostics;
}

/**
 * Redeems the launch's one-shot bootstrap token for the run's own contract
 * (`POST /v1/runs/:id/bootstrap`) — the first request a container makes. Returns the raw body
 * text; validation stays at the ingest boundary, as for the spec.
 *
 * Retried like the spec fetch — network errors and 5xx, never a 4xx — but with a doubling
 * pause, since the token stays redeemable for the whole startup grace. A retry is safe because
 * the orchestrator spends the token only when it finds the row, and answers whenever it did.
 * The one ambiguous case is an answer lost after that — the retry then gets a 401, which is
 * definitive like every 4xx: a spent token is never replayed into a success.
 */
export async function exchangeBootstrap(opts: BootstrapExchangeOptions): Promise<string> {
  return (await bootRequest(opts, "bootstrap", {
    method: "POST",
    bearer: opts.bootstrapToken,
    notFoundOk: false,
    // An attempt given up on may still commit upstream and spend the token, so this one waits
    // longer than an ordinary boot request before it retries.
    timeoutMs: opts.requestTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
    attempts: BOOTSTRAP_ATTEMPTS,
    maxPauseMs: BOOTSTRAP_MAX_PAUSE_MS,
  }))!;
}

async function bootRequest(
  opts: {
    baseUrl: string;
    runId: string;
    requestTimeoutMs?: number;
    retryPauseMs?: number;
    diag: Diagnostics;
  },
  doc: string,
  {
    method,
    bearer,
    notFoundOk,
    timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    attempts = SPEC_FETCH_ATTEMPTS,
    maxPauseMs,
  }: {
    method: "GET" | "POST";
    bearer: string;
    notFoundOk: boolean;
    timeoutMs?: number;
    attempts?: number;
    /** Set, the pause doubles after every attempt up to this; unset, it stays flat. */
    maxPauseMs?: number;
  },
): Promise<string | null> {
  const { runId, diag } = opts;
  const retryPauseMs = opts.retryPauseMs ?? SPEC_FETCH_RETRY_PAUSE_MS;
  const url = `${runRoute(opts.baseUrl, runId)}/${doc}`;

  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
        // A redirect would carry the bearer to wherever it points.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.text();
      await res.body?.cancel();
      if (notFoundOk && res.status === 404) return null;
      failure = new Error(`the orchestrator answered ${res.status}`);
      if (res.status < 500) break;
    } catch (err) {
      failure = err;
    }
    if (attempt < attempts) {
      diag.warn(`orchestrator.fetch_${doc}.retrying`, { runId, attempt, err: String(failure) });
      const pause = maxPauseMs === undefined
        ? retryPauseMs
        : Math.min(retryPauseMs * 2 ** (attempt - 1), maxPauseMs);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  throw new Error(`fetching the run ${doc} from ${url} failed: ${String(failure)}`);
}

export interface BootFailureReportOptions {
  baseUrl: string;
  runToken: string;
  runId: string;
  /** What broke while assembling the run's input. */
  reason: string;
  requestTimeoutMs?: number;
  diag: Diagnostics;
}

/**
 * Reports a boot failure upstream: POSTs an error `Result` with `during: "booting"` so a run
 * that died before it could even assemble its input still concludes immediately, instead of
 * waiting out the orchestrator's liveness window. Best-effort by design — one shot, every
 * failure swallowed to a warn: the exit code already carries the outcome locally, and the
 * orchestrator's reaper remains the backstop when this report cannot land.
 */
export async function reportBootFailure(opts: BootFailureReportOptions): Promise<void> {
  const { runId, diag } = opts;
  const result: Result = { status: "error", reason: opts.reason, during: "booting", branches: [] };
  try {
    const res = await fetch(`${runRoute(opts.baseUrl, runId)}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.runToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) diag.warn("orchestrator.bootFailure.rejected", { runId, status: res.status });
  } catch (err) {
    diag.warn("orchestrator.bootFailure.unreachable", { runId, err: String(err) });
  }
}

function isOwedVerdict(v: unknown): v is OwedVerdict {
  if (typeof v !== "object" || v === null) return false;
  const { id, requests } = v as { id?: unknown; requests?: unknown };
  return typeof id === "string" && id !== "" && Array.isArray(requests) &&
    requests.every((r) => typeof r === "string" && r !== "");
}
