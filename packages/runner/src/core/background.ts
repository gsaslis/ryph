// The agent's background commands (`ryph__background_run`): a shell command started on the
// agent's say-so, watched to its end, and told of — to the agent when it ends, to people while it
// runs.
//
// A job runs with exactly the agent's own powers: `bash -c` with the env pi's bash gets, the same
// uid and network. What the runner adds is only that it is watched. Each job is spawned detached,
// which makes it the leader of its own process group (and, on Linux, session) with the pid it was
// spawned with, so a signal to the group `-pid` reaches everything it started. Its stdout and
// stderr are one pipe (the shell dups one onto the other), so the log holds them in the order they were written.
//
// Invariants:
// - nothing here can fail the run: a job that cannot start is a refusal the agent reads, and
//   every later failure (a log write, a record, the uplink) is a diag line
// - every way a job ends ends its whole group: after the leader exits, what it left behind is
//   sent TERM, then KILL, and a pipe a leftover still holds is let go
// - the agent is told of an end nobody asked for — an exit or a timeout: a stop by the agent
//   or by the run sends nothing; a service may also request one readiness notice from its output
// - a running job that is no service holds the idle deadline until it can no longer be running
//   (its timeout plus the kill grace); a service holds nothing
// - once `stopAll` has begun nothing new starts, and it resolves once every job has ended
// - ids are minted here (`bg-<n>`, n from 1); nothing the agent passes names a path
// - every file here is one this side created (O_EXCL), and none is opened by path again: the raw
//   log is the agent's to read and is never read back; the stored log is read from the people's
//   view, through the handles that wrote it. What the agent does to a path changes nothing here
// - output is cleaned once, as it streams (core/output_stream.ts), and the ring, the live
//   channel, the tails and the record read only that; the stored log is the people's view of it,
//   written to disk as it streams; a label, a command and a cwd are cleaned as the job is minted
// - each job's record of an event lands (bounded) before anyone is told of it — its start before
//   the agent's answer and the live `started`, its end before the live `exited` and the notice —
//   and its log goes last; the run's reporting waits for them, bounded (`close`)
// - no live line of a job goes before its `started`; readiness waits for the start record too

import { type FileHandle, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "@std/path";
import { type Child, command } from "@ryph/process";
import type { BackgroundNoticeMessage } from "./types.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { BackgroundRecords, CommandLine, CommandsUplink } from "../ports/background.ts";
import {
  BACKGROUND_COMMAND_MAX_BYTES,
  BACKGROUND_LABEL_MAX,
  BACKGROUND_MAX_RUNNING,
  BACKGROUND_MAX_STARTED,
  BACKGROUND_TAIL_DEFAULT,
  BACKGROUND_TAIL_MAX,
  BACKGROUND_TIMEOUT_DEFAULT_MINUTES,
  BACKGROUND_TIMEOUT_MAX_MINUTES,
  BACKGROUND_TIMEOUT_MIN_MINUTES,
  type BackgroundEndReason,
  type BackgroundJobView,
  type BackgroundOutputOutcome,
  type BackgroundRunArgs,
  type BackgroundRunOutcome,
  type BackgroundStopOutcome,
} from "../ports/run_actions.ts";
import { errorMessage } from "../helpers/errors.ts";
import {
  charBytes,
  clip,
  clipBytes,
  isHighSurrogate,
  utf8Bytes,
  within,
} from "../helpers/bounds.ts";
import { OutputStream, shownText } from "./output_stream.ts";

const MINUTE_MS = 60_000;
/** TERM to KILL, for a stop and a timeout. */
const STOP_GRACE_MS = 10_000;
/** TERM to KILL when the run ends: finalize is waiting. */
const END_GRACE_MS = 5_000;
/** How long what a leader left in its group has to let go of the pipe once it is sent TERM, and
 * then once it is sent KILL, before the pipe is let go of from this side. */
const LEFTOVER_GRACE_MS = 2_000;
/** How long past a stop's grace `stopAll` waits for a job that will not be reaped. */
const REAP_SLACK_MS = 5_000;
/** How long past its timeout a job can still be running: the kill grace, and room to reap. */
const HOLD_SLACK_MS = STOP_GRACE_MS + REAP_SLACK_MS;
/** How long the run's reporting waits for the records still going up: an end record's tries
 * (three, five seconds each, with pauses) and then its log's step. */
const CLOSE_BOUND_MS = 60_000;
/** How long a job's log step may take: past the records client's own 30 s from the call (its
 * slot wait included, adapters/orchestrator/http.ts), so the client gives up first. */
const LOG_STEP_MS = 35_000;
/** How long the agent's answer, and the live `exited` and the notice, wait for the record of the
 * event to land first — so the run page's list is never behind what the agent and people heard. */
const RECORD_WAIT_MS = 5_000;
/** How long what the cleaner carries (a partial escape, a trailing `\r`) waits for what completes
 * it before it is let go. */
const RELEASE_MS = 1_000;

const LOG_MAX_BYTES = 16 * 1024 * 1024;
const LOG_TRUNCATED_LINE = "\n[ryph: log truncated at 16 MiB]\n";
/** The end of the log the record keeps; the control plane takes at most this much. It is read
 * from the people's view as it was written while the job ran, kept in two segments of this size:
 * the newer is written, and the older, once the newer fills, is emptied and written next. */
const LOG_UPLOAD_BYTES = 4 * 1024 * 1024;
const VIEW_SEGMENT_BYTES = LOG_UPLOAD_BYTES;
/** How much of the view may wait to be written before the pipe is held: the view's writes pace
 * the job as the raw log's do, which stop at its cap, or never start when its path was taken. */
const VIEW_QUEUE_BYTES = 1024 * 1024;
/** What is kept of the people's view in memory, for a replay: the last of it, from a line. */
const PEOPLE_TAIL_CHARS = 256 * 1024;
/** The most a replay sends in all, under a viewer's queue and the room's budget, and what of it an
 * ended job gets. */
const REPLAY_BYTES = 1536 * 1024;
const REPLAY_ENDED_BYTES = 16 * 1024;

/** What is kept of a job's output in memory: the agent's tail, the notice's, the replay's. */
const RING_CHARS = 256 * 1024;
const RING_LINES = BACKGROUND_TAIL_MAX;
const OUTPUT_TOOL_CHARS = 50_000;
const NOTICE_LINES = 20;
const NOTICE_CHARS = 4_096;
const RECORD_TAIL_LINES = 64;
const RECORD_TAIL_CHARS = 16 * 1024;
const RECORD_COMMAND_CHARS = 4_096;

/** The live channel's shape: output coalesced per job every FLUSH_MS, at most LIVE_PER_SECOND
 * UTF-8 bytes a second per job, each line under the historian's cap. */
const FLUSH_MS = 250;
const LIVE_PER_SECOND = 64 * 1024;
/** What waits for the next flush, per job, in UTF-8 bytes; past it, output is counted as skipped
 * at once. */
const LIVE_PENDING_BYTES = 64 * 1024;
const LIVE_TEXT_CHARS = 8 * 1024;
/** Under the historian's 16 KiB line cap, with room for the line's other fields. */
const LIVE_TEXT_BYTES = 15 * 1024;
/** The historian's cap on one line, less room for the newline and a margin. */
const LIVE_LINE_BYTES = 16 * 1024 - 64;
const LIVE_COMMAND_CHARS = 2_048;
/** From what a job printed before its `started` went out, at most this much follows it. */
const LIVE_BACKLOG_BYTES = 64 * 1024;
const LIVE_CWD_CHARS = 1_024;

const JOB_ID = /^bg-[0-9]{1,3}$/;
/** What a label may not hold: line breaks, control characters, runs of space. */
// oxlint-disable-next-line no-control-regex
const LABEL_BREAKS = /[\x00-\x1f\x7f\s]+/g;

export interface BackgroundDeps {
  diag: Diagnostics;
  /** A job's default cwd, and what a relative one is resolved against: where pi's bash starts. */
  checkoutRoot: string;
  /** The env the agent's own shell has — what the harness spawned it with. Null until it has. */
  env(): Readonly<Record<string, string>> | null;
  /** A job became ready or ended on its own/at timeout: the agent is told. False if not delivered. */
  notice(message: BackgroundNoticeMessage): boolean;
  /** What `holdUntil` answers changed. */
  holdChanged(): void;
  /** Where each job's record goes. Absent: nowhere (a CLI run). */
  records?: BackgroundRecords;
  /** Where people watch the output live. Absent: nowhere. */
  uplink?: CommandsUplink;
  /** The run's own directory for the logs, outside every clone. */
  makeDir?: () => Promise<string>;
  now?: () => number;
  /** Tests shrink these. */
  minuteMs?: number;
  stopGraceMs?: number;
  endGraceMs?: number;
  leftoverGraceMs?: number;
  flushMs?: number;
  logStepMs?: number;
  recordWaitMs?: number;
  releaseMs?: number;
  /** Tests swap the view's segment files; default: created here, O_EXCL. */
  openView?: (path: string) => Promise<FileHandle>;
}

export interface BackgroundJobs {
  run(args: BackgroundRunArgs): Promise<BackgroundRunOutcome>;
  output(args: { id?: string; tailLines?: number }): BackgroundOutputOutcome;
  stop(id: string): Promise<BackgroundStopOutcome>;
  /** The latest a running job that is no service can still be running, or null: the idle
   * deadline is never earlier. */
  holdUntil(): number | null;
  /** Stops every running job — TERM to its group, KILL after the end grace — and refuses new
   * ones; resolves once all have ended (bounded). Idempotent. */
  stopAll(): Promise<void>;
  /** `stopAll`, then the records still going up awaited up to `boundMs`, the uplink closed and
   * the logs removed. Idempotent. */
  close(boundMs?: number): Promise<void>;
}

interface Job {
  id: string;
  /** Cleaned at mint, like `shown`: the label is the agent's to write. */
  label: string;
  /** What runs, as the agent gave it. */
  command: string;
  cwd: string;
  /** The command and cwd as they are shown anywhere: cleaned. */
  shown: { command: string; cwd: string };
  service: boolean;
  readiness: { marker: string; carry: string; at: number | null; told: boolean } | null;
  logPath: string;
  startedAt: number;
  timeoutAt: number;
  pid: number;
  /** Set the moment the leader is reaped: a stop after it only reports. */
  exited: boolean;
  /** The ending asked for, once one was. */
  ending: BackgroundEndReason | null;
  ended:
    | { at: number; reason: BackgroundEndReason; exitCode: number | null; signal: string | null }
    | null;
  done: Promise<void>;
  timers: Set<ReturnType<typeof setTimeout>>;
  /** The signals sent to its group, each after the one before: a KILL never overtakes its TERM. */
  signalling: Promise<void>;
  /** The clean output as the agent reads it, each line as last drawn: its tail, the
   * notice's, the record's. */
  ring: OutputRing;
  /** The people's view as it was written, redraws as lines: what a replay or an announce sends. */
  people: PeopleTail;
  /** Raw output in, clean output out. */
  stream: OutputStream;
  /** The raw log, as this side created it: the agent's to read. Never read back here. */
  file: FileHandle | null;
  /** The people's view of the output written as it streams (`writeView`), what the stored log
   * is read from; null where there is no record to keep, or a segment could not be made. */
  viewLog: ViewLog | null;
  log: { bytes: number; truncated: boolean };
  /** Toward the uplink: what waits for the next flush, and this second's budget, in bytes. */
  live: {
    pending: string;
    pendingBytes: number;
    /** Dropped this window, told once as it rolls (or at the end). */
    skipped: number;
    windowAt: number;
    spent: number;
    /** Its `started` has gone out: until then output only reaches the ring. */
    started: boolean;
    /** What was shown last ended in a redraw (a `\r`, to people a line break). */
    afterReturn: boolean;
  };
  /** Its start record has landed or been waited for: a replay may announce it. */
  recorded: boolean;
  /** Its end record has landed or been waited for: its end may be told. */
  endTold: boolean;
  /** Lets what the cleaner carries go when nothing comes to complete it. */
  release: ReturnType<typeof setTimeout> | undefined;
  /** The record's chain: each step after the one before. */
  record: Promise<void>;
}

/** Two segments the people's view is written to in turn, by handles this side created. */
interface ViewLog {
  segments: [FileHandle, FileHandle];
  paths: [string, string];
  /** The one written to now; the other holds what came before it. */
  current: 0 | 1;
  bytes: [number, number];
  /** Every write after the one before, in order. */
  writing: Promise<void>;
  /** Handed to `writing` and not yet taken up by it, and the most that ever was. */
  queued: number;
  peak: number;
  /** Everything handed to it: what the stored log was cut from. */
  total: number;
  failed: boolean;
}

export function startBackgroundJobs(deps: BackgroundDeps): BackgroundJobs {
  const now = deps.now ?? (() => Date.now());
  const minuteMs = deps.minuteMs ?? MINUTE_MS;
  const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const endGraceMs = deps.endGraceMs ?? END_GRACE_MS;
  const leftoverGraceMs = deps.leftoverGraceMs ?? LEFTOVER_GRACE_MS;
  const flushMs = deps.flushMs ?? FLUSH_MS;
  const logStepMs = deps.logStepMs ?? LOG_STEP_MS;
  const recordWaitMs = deps.recordWaitMs ?? RECORD_WAIT_MS;
  const releaseMs = deps.releaseMs ?? RELEASE_MS;
  const makeDir = deps.makeDir ?? (() => mkdtemp(join(tmpdir(), "ryph-background-")));
  const openView = deps.openView ??
    ((path: string) => open(path, "wx+"));
  const jobs: Job[] = [];
  /** Starts past their checks and not yet in `jobs`: counted against both limits. */
  let starting = 0;
  let minted = 0;
  let dir: Promise<string> | null = null;
  let stopping: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let uplinkOpen = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const iso = (ms: number) => new Date(ms).toISOString();
  const running = () => jobs.filter((job) => job.ended === null);

  const send = (line: CommandLine) => {
    if (deps.uplink === undefined) return;
    try {
      deps.uplink.send(line);
    } catch (err) {
      deps.diag.debug("background.uplink_send_failed", { err: errorMessage(err) });
    }
  };
  const holdChanged = () => {
    try {
      deps.holdChanged();
    } catch (err) {
      deps.diag.warn("background.hold_changed_failed", { err });
    }
  };
  /** Each record step after the one before; a failure is the record's, never the run's. */
  const chain = (job: Job, what: string, step: () => Promise<void>) => {
    job.record = job.record.then(step).catch((err) =>
      deps.diag.warn("background.record_failed", { id: job.id, what, err: errorMessage(err) })
    );
  };

  const view = (job: Job): BackgroundJobView => ({
    id: job.id,
    label: job.label,
    command: job.shown.command,
    cwd: job.shown.cwd,
    service: job.service,
    logPath: job.logPath,
    startedAt: iso(job.startedAt),
    timeoutAt: iso(job.timeoutAt),
    ...(job.readiness ? { readyAt: job.readiness.at === null ? null : iso(job.readiness.at) } : {}),
    ended: job.ended === null ? null : {
      at: iso(job.ended.at),
      reason: job.ended.reason,
      exitCode: job.ended.exitCode,
      signal: job.ended.signal,
    },
    durationMs: (job.ended?.at ?? now()) - job.startedAt,
  });

  /** Sized by its JSON, not its characters, so the historian never refuses it. The command gives
   * way first, then the cwd. */
  const startedLine = (job: Job): CommandLine => {
    const line = {
      type: "started" as const,
      at: iso(job.startedAt),
      id: job.id,
      label: job.label,
      command: clip(job.shown.command, LIVE_COMMAND_CHARS),
      cwd: clip(job.shown.cwd, LIVE_CWD_CHARS),
      service: job.service,
      timeoutAt: iso(job.timeoutAt),
    };
    while (utf8Bytes(JSON.stringify(line)) > LIVE_LINE_BYTES) {
      if (line.command.length > 0) line.command = clip(line.command, line.command.length >> 1);
      else line.cwd = clip(line.cwd, line.cwd.length >> 1);
    }
    return line;
  };
  const exitedLine = (job: Job): CommandLine => ({
    type: "exited",
    at: iso(job.ended!.at),
    id: job.id,
    reason: job.ended!.reason,
    exitCode: job.ended!.exitCode,
    signal: job.ended!.signal,
  });

  /**
   * What a new uplink opens with: every job whose start is recorded, as it stands, its output
   * from the people's tail — what was written of it, so it reads as it did live — after a
   * `skipped` for what is left out. What was pending is in the tail already. A job still waiting
   * on its start record is announced by its own start. The output it replays stays under
   * REPLAY_BYTES in all, what a viewer and the room take at once: an ended job gets a short tail,
   * the running ones share the rest, each at most a tail's worth.
   */
  const replay = (): CommandLine[] => {
    const lines: CommandLine[] = [];
    const at = iso(now());
    const told = jobs.filter((job) => job.recorded);
    const ended = told.filter((job) => job.endTold).length;
    const running = told.length - ended;
    const share = running === 0 ? 0 : Math.min(
      PEOPLE_TAIL_CHARS,
      Math.floor((REPLAY_BYTES - ended * REPLAY_ENDED_BYTES) / running),
    );
    for (const job of told) {
      const live = job.live;
      live.pending = "";
      live.pendingBytes = 0;
      live.skipped = 0;
      live.started = true;
      lines.push(startedLine(job));
      const whole = job.people.text;
      let tail = lastBytes(whole, job.endTold ? REPLAY_ENDED_BYTES : share);
      if (tail.length < whole.length) tail = fromLine(tail);
      const left = job.people.dropped + utf8Bytes(whole) - utf8Bytes(tail);
      if (left > 0) lines.push({ type: "skipped", at, id: job.id, bytes: left });
      for (const text of livePieces(tail)) lines.push({ type: "output", at, id: job.id, text });
      if (job.endTold) lines.push(exitedLine(job));
    }
    return lines;
  };

  /** The job's `started` on a live uplink, then what it printed before (the last of it). Its end
   * is told after: the end's record wait is on a later link of the same chain, from later. */
  const announce = (job: Job) => {
    send(startedLine(job));
    const live = job.live;
    live.started = true;
    const shown = job.people.text;
    const backlog = lastBytes(shown, LIVE_BACKLOG_BYTES);
    live.skipped += job.people.dropped + utf8Bytes(shown) - utf8Bytes(backlog);
    live.pending = backlog;
    live.pendingBytes = utf8Bytes(backlog);
    scheduleFlush();
  };

  const sendSkipped = (job: Job, at: number) => {
    if (job.live.skipped === 0) return;
    send({ type: "skipped", at: iso(at), id: job.id, bytes: job.live.skipped });
    job.live.skipped = 0;
  };

  /** One job's pending output, within its budget for this second. `final`: the job has ended. */
  const flushJob = (job: Job, final: boolean) => {
    const live = job.live;
    const at = now();
    if (at - live.windowAt >= 1_000) {
      sendSkipped(job, at);
      live.windowAt = at;
      live.spent = 0;
    }
    const text = live.pending;
    live.pending = "";
    live.pendingBytes = 0;
    const sent = clipBytes(text, Math.max(0, LIVE_PER_SECOND - live.spent));
    if (sent.length < text.length) live.skipped += utf8Bytes(text.slice(sent.length));
    live.spent += utf8Bytes(sent);
    for (const piece of livePieces(sent)) {
      send({ type: "output", at: iso(at), id: job.id, text: piece });
    }
    if (final) sendSkipped(job, at);
  };
  const flush = () => {
    flushTimer = undefined;
    for (const job of jobs) {
      if (job.live.pending !== "") flushJob(job, false);
    }
  };
  const scheduleFlush = () => {
    if (flushTimer === undefined && deps.uplink !== undefined) {
      flushTimer = setTimeout(flush, flushMs);
    }
  };

  const tellReady = (job: Job) => {
    const ready = job.readiness;
    if (!ready || ready.at === null || ready.told || !job.recorded) return;
    if (stopping !== null || job.ending !== null || job.exited) return;
    ready.told = true;
    try {
      const delivered = deps.notice({
        kind: "system",
        sender: { kind: "platform" },
        text: `Background service ${job.id} (${JSON.stringify(job.label)}) is ready: ` +
          "its requested output marker was seen. It is still running; you can continue " +
          "with it now. This is a readiness notification, not a command exit.",
        payload: null,
        createdAt: iso(ready.at),
        background: {
          id: job.id,
          label: job.label,
          reason: "ready",
          exitCode: null,
          signal: null,
          durationMs: ready.at - job.startedAt,
        },
      });
      if (!delivered) deps.diag.debug("background.notice_dropped", { id: job.id });
    } catch (err) {
      deps.diag.warn("background.notice_failed", { id: job.id, err });
    }
  };

  /** Clean output: into the ring, which keeps a line's last redraw, and toward the uplink once the
   * job is announced, where people read a redraw as a line break. */
  const show = (job: Job, clean: string) => {
    const live = job.live;
    if (clean === "") return;
    job.ring.append(clean);
    const ready = job.readiness;
    if (ready && ready.at === null && !job.exited && job.ending === null) {
      const text = ready.carry + clean;
      if (text.includes(ready.marker)) {
        ready.at = now();
        ready.carry = "";
        tellReady(job);
      } else {
        ready.carry = ready.marker.length > 1 ? text.slice(-(ready.marker.length - 1)) : "";
      }
    }
    // A redraw is a line break to people; a `\n` right after a released one is the same break.
    const text = (live.afterReturn && clean.startsWith("\n") ? clean.slice(1) : clean)
      .replace(/\r/g, "\n");
    live.afterReturn = clean.endsWith("\r");
    if (text === "") return;
    job.people.append(text);
    writeView(job, text);
    if (deps.uplink === undefined || !live.started) return;
    const bytes = utf8Bytes(text);
    const room = Math.max(0, LIVE_PENDING_BYTES - live.pendingBytes);
    const kept = bytes <= room ? text : clipBytes(text, room);
    const keptBytes = kept === text ? bytes : utf8Bytes(kept);
    live.skipped += bytes - keptBytes;
    live.pending += kept;
    live.pendingBytes += keptBytes;
    scheduleFlush();
  };

  /**
   * The people's view, onto disk as it streams: what the stored log is read from, so it is what
   * live viewers read, cleaned already. A segment that fills hands over to the other, emptied; a
   * write that fails stops the view, and no log is stored.
   */
  const writeView = (job: Job, text: string) => {
    const view = job.viewLog;
    if (view === null || view.failed || text === "") return;
    const bytes = new TextEncoder().encode(text);
    view.total += bytes.byteLength;
    view.queued += bytes.byteLength;
    view.peak = Math.max(view.peak, view.queued);
    view.writing = view.writing.then(async () => {
      view.queued -= bytes.byteLength;
      if (view.failed) return;
      // At the segment's own end, which the next write after a handover puts back at 0.
      await writeAll(view.segments[view.current], bytes, view.bytes[view.current]);
      view.bytes[view.current] += bytes.byteLength;
      if (view.bytes[view.current] < VIEW_SEGMENT_BYTES) return;
      const next = view.current === 0 ? 1 : 0;
      await view.segments[next].truncate(0);
      view.bytes[next] = 0;
      view.current = next;
    }).catch((err) => {
      view.failed = true;
      deps.diag.warn("background.view_write_failed", { id: job.id, err: errorMessage(err) });
    });
  };

  /** Raw output as it is decoded: through the job's stream, then shown. What the cleaner carries
   * is let go after a pause if nothing completes it. */
  const take = (job: Job, text: string) => {
    if (job.release !== undefined) clearTimeout(job.release);
    job.release = undefined;
    show(job, job.stream.push(text));
    if (job.stream.holding && job.ended === null) {
      job.release = setTimeout(() => {
        job.release = undefined;
        show(job, job.stream.release());
      }, releaseMs);
    }
  };

  /** Appends to the log under its cap; past it, one closing line and nothing more. */
  const writeLog = async (job: Job, file: FileHandle | null, chunk: Uint8Array) => {
    if (file === null || job.log.truncated) return;
    const room = LOG_MAX_BYTES - job.log.bytes;
    const part = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    try {
      await writeAll(file, part);
      job.log.bytes += part.byteLength;
      if (part.byteLength < chunk.byteLength) {
        await writeAll(file, new TextEncoder().encode(LOG_TRUNCATED_LINE));
        job.log.truncated = true;
      }
    } catch (err) {
      // A disk that refuses a write keeps refusing: the log stops where it is.
      deps.diag.warn("background.log_write_failed", { id: job.id, err: errorMessage(err) });
      job.log.truncated = true;
    }
  };

  /** Sends `signal` to the job's whole group, after every signal sent to it before; resolves once
   * it is sent. A group that is gone already is no failure; anything else is warned of. */
  const signalGroup = (job: Job, signal: "SIGTERM" | "SIGKILL"): Promise<void> => {
    job.signalling = job.signalling.then(async () => {
      const failed = await signalProcessGroup(job.pid, signal);
      if (failed !== null) deps.diag.warn("background.signal_failed", { id: job.id, ...failed });
    });
    return job.signalling;
  };

  /** Asks a running job to end, TERM then KILL after `graceMs`; resolves once it has. The first
   * ending asked for is the one recorded, and a later ask only brings the KILL forward. */
  const terminate = (job: Job, reason: BackgroundEndReason, graceMs: number): Promise<void> => {
    // Reaped, but what it left is still being ended: the ask still says how it ended, so a stop
    // landing now is a stop, told to nobody.
    if (job.exited) {
      job.ending ??= reason;
      return job.done;
    }
    if (job.ending === null) {
      job.ending = reason;
      void signalGroup(job, "SIGTERM");
    }
    const kill = setTimeout(() => {
      job.timers.delete(kill);
      if (!job.exited) void signalGroup(job, "SIGKILL");
    }, graceMs);
    job.timers.add(kill);
    return job.done;
  };

  /** One job from spawn to its record: the pipe drained into the log, the ring and the uplink;
   * the leader reaped; what it left behind ended; the end told. */
  const watch = async (job: Job, proc: Child) => {
    const file = job.file;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeLog(job, file, value);
          const text = decoder.decode(value, { stream: true });
          if (text !== "") take(job, text);
          // The view's writes hold the pipe as the raw log's do: a slow disk slows the job.
          const view = job.viewLog;
          if (view !== null && view.queued > VIEW_QUEUE_BYTES) await view.writing;
        }
      } catch (err) {
        deps.diag.debug("background.read_ended", { id: job.id, err: errorMessage(err) });
      }
      const rest = decoder.decode();
      if (rest !== "") take(job, rest);
    })();
    const status = await proc.status;
    job.exited = true;
    for (const timer of job.timers) clearTimeout(timer);
    job.timers.clear();
    // Whatever the leader started is the job's, and goes with it — and the pipe closes only once
    // the last holder has let go.
    await signalGroup(job, "SIGTERM");
    if (!(await within(pump, leftoverGraceMs))) {
      await signalGroup(job, "SIGKILL");
      if (!(await within(pump, leftoverGraceMs))) {
        deps.diag.warn("background.pipe_held", { id: job.id });
        await reader.cancel().catch(() => {});
        await pump;
      }
    }
    // Nothing more comes: what the stream carries goes.
    if (job.release !== undefined) clearTimeout(job.release);
    job.release = undefined;
    show(job, job.stream.end());
    const reason = job.ending ?? "exited";
    job.ended = {
      at: now(),
      reason,
      exitCode: status.signal === null ? status.code : null,
      signal: status.signal,
    };
    deps.diag.debug("background.ended", {
      id: job.id,
      reason,
      code: status.code,
      signal: status.signal,
    });
    holdChanged();
    const records = deps.records;
    // The control plane takes a log only once the job's end is recorded there.
    let endLanded = false;
    // The record first, bounded: the run page's list is never behind what people watching and
    // the agent are told next.
    if (records !== undefined) {
      const ended = job.ended;
      chain(job, "ended", async () => {
        endLanded = await records.ended(job.id, {
          endedAt: iso(ended.at),
          reason: ended.reason,
          exitCode: ended.exitCode,
          signal: ended.signal,
          // What the stored log is: the view's total, and whether what goes up is less of it.
          logBytes: job.viewLog?.total ?? 0,
          logTruncated: job.viewLog === null || job.viewLog.failed ||
            job.viewLog.total > LOG_UPLOAD_BYTES,
          logTail: tailOf(job.ring.text, RECORD_TAIL_LINES, RECORD_TAIL_CHARS).text,
        });
      });
      // The answer to the start waited on the same chain, from earlier, for as long: it is given
      // before this wait ends, so the agent hears of the job before it hears of its end.
      await within(job.record, recordWaitMs);
    }
    // A job not yet announced has its end sent with its start.
    job.endTold = true;
    if (job.live.started) {
      flushJob(job, true);
      send(exitedLine(job));
    }
    // Told only of an end nobody asked for, and only while the run goes on.
    if ((reason === "exited" || reason === "timeout") && stopping === null) {
      try {
        const delivered = deps.notice(noticeOf(job, view(job)));
        if (!delivered) deps.diag.debug("background.notice_dropped", { id: job.id });
      } catch (err) {
        deps.diag.warn("background.notice_failed", { id: job.id, err });
      }
    }
    if (records === undefined) return await closeLog(job);
    // The log goes last, bounded on its own: its failure is its own.
    // Chained after the end record, so it waits for that to land however long it retries.
    chain(job, "log", async () => {
      if (!endLanded) {
        await closeLog(job, true);
        return deps.diag.warn("background.log_skipped", { id: job.id, why: "end not recorded" });
      }
      const upload = (async () => {
        try {
          const text = await readView(job.viewLog);
          if (text !== null) await records.log(job.id, text);
        } finally {
          await closeLog(job, true);
        }
      })().catch((err) =>
        deps.diag.warn("background.record_failed", { id: job.id, what: "log", err })
      );
      if (!(await within(upload, logStepMs))) {
        deps.diag.warn("background.log_upload_slow", { id: job.id });
      }
    });
  };

  /** Closes the raw log and the view's segments, once the view's writes are done; `remove`: the
   * segments go too, the stored log being up (or given up). The raw log stays until close: its
   * path was promised to the agent. */
  const closeLog = async (job: Job, remove = false) => {
    const view = job.viewLog;
    job.viewLog = null;
    await view?.writing;
    for (const file of [job.file, ...(view?.segments ?? [])]) {
      // A handle closed already rejects: nothing to do.
      await file?.close().catch(() => {});
    }
    job.file = null;
    if (view !== null) {
      deps.diag.debug("background.view_closed", { id: job.id, total: view.total, peak: view.peak });
      if (remove) { for (const path of view.paths) await rm(path).catch(() => {}); }
    }
  };

  const logDir = () => {
    dir ??= makeDir();
    return dir;
  };

  const find = (id: string): Job | { reason: string } => {
    const job = JOB_ID.test(id) ? jobs.find((j) => j.id === id) : undefined;
    if (job !== undefined) return job;
    const known = jobs.map((j) => j.id).join(", ");
    return {
      reason: `There is no background job ${JSON.stringify(clip(id, 40))} in this run; ${
        known === "" ? "none has been started" : `it has ${known}`
      }.`,
    };
  };

  const stopAll = (): Promise<void> => {
    stopping ??= (async () => {
      const left = running();
      if (left.length === 0) return;
      deps.diag.debug("background.stopping_all", { jobs: left.map((job) => job.id) });
      // A job whose leader has exited ended on its own, and keeps saying so: it is only waited for.
      const ended = Promise.all(
        left.map((job) => job.exited ? job.done : terminate(job, "run_ended", endGraceMs)),
      );
      const bound = endGraceMs + leftoverGraceMs * 2 + REAP_SLACK_MS + recordWaitMs;
      if (!(await within(ended, bound))) {
        deps.diag.warn("background.stop_all_unfinished", { jobs: running().map((j) => j.id) });
      }
    })();
    return stopping;
  };

  return {
    async run(args) {
      if (stopping !== null) return refused(ENDING);
      if (typeof args.command !== "string" || args.command.trim() === "") {
        return refused("command must be the shell command to run.");
      }
      if (utf8Bytes(args.command) > BACKGROUND_COMMAND_MAX_BYTES) {
        return refused(
          `command is over ${BACKGROUND_COMMAND_MAX_BYTES / 1024} KiB; put a long script in a ` +
            "file and run that.",
        );
      }
      const label = typeof args.label === "string"
        ? shownText(args.label).replace(LABEL_BREAKS, " ").trim()
        : "";
      if (label === "" || label.length > BACKGROUND_LABEL_MAX) {
        return refused(
          `label must say what the command is, for the people watching the run, in 1 to ` +
            `${BACKGROUND_LABEL_MAX} characters (an emoji counts as two).`,
        );
      }
      if (args.readyWhen !== undefined) {
        if (
          args.service !== true || typeof args.readyWhen !== "string" ||
          args.readyWhen.trim() === "" || args.readyWhen.length > 1_000 ||
          shownText(args.readyWhen) !== args.readyWhen
        ) {
          return refused("readyWhen requires service: true and 1–1000 characters of plain text.");
        }
      }
      const minutes = args.timeoutMinutes ?? BACKGROUND_TIMEOUT_DEFAULT_MINUTES;
      if (
        !Number.isInteger(minutes) || minutes < BACKGROUND_TIMEOUT_MIN_MINUTES ||
        minutes > BACKGROUND_TIMEOUT_MAX_MINUTES
      ) {
        return refused(
          `timeoutMinutes must be a whole number of minutes from ` +
            `${BACKGROUND_TIMEOUT_MIN_MINUTES} to ${BACKGROUND_TIMEOUT_MAX_MINUTES}.`,
        );
      }
      const live = running().length + starting;
      if (live >= BACKGROUND_MAX_RUNNING) {
        return refused(
          `${live} background commands are already running, the most a run may have at once. ` +
            "Wait for one to end, or stop one with ryph__background_stop.",
        );
      }
      if (jobs.length + starting >= BACKGROUND_MAX_STARTED) {
        return refused(
          `This run has started ${jobs.length + starting} background commands, the most a run ` +
            "may start.",
        );
      }
      const env = deps.env();
      if (env === null) return refused("The agent's shell has not started yet.");
      const cwd = args.cwd === undefined || args.cwd.trim() === ""
        ? deps.checkoutRoot
        : isAbsolute(args.cwd)
        ? args.cwd
        : join(deps.checkoutRoot, args.cwd);
      starting++;
      let spawned: { proc: Child; job: Job };
      try {
        try {
          if (!(await stat(cwd)).isDirectory()) {
            return refused(`cwd ${JSON.stringify(cwd)} is not a directory.`);
          }
        } catch {
          return refused(`cwd ${JSON.stringify(cwd)} does not exist.`);
        }
        let logs: string;
        try {
          logs = await logDir();
        } catch (err) {
          deps.diag.warn("background.dir_failed", { err: errorMessage(err) });
          dir = null;
          return refused("The run could not make a place for the command's output; try again.");
        }
        // Checked again: the run may have begun ending during the awaits above.
        if (stopping !== null) return refused(ENDING);
        const id = `bg-${++minted}`;
        const logPath = join(logs, `${id}.log`);
        let file: FileHandle | null = null;
        try {
          // Created here and nowhere else: a path that already holds something (a link the
          // agent planted) is refused, and the command's output is kept in memory only.
          file = await open(logPath, "wx");
        } catch (err) {
          deps.diag.warn("background.log_open_failed", { id, err: errorMessage(err) });
        }
        // The people's view, for the stored log, where there is one to keep.
        let viewLog: ViewLog | null = null;
        if (deps.records !== undefined) {
          const made: FileHandle[] = [];
          const paths: [string, string] = [join(logs, `${id}.view-0`), join(logs, `${id}.view-1`)];
          try {
            for (const path of paths) made.push(await openView(path));
            viewLog = {
              segments: [made[0], made[1]],
              paths,
              current: 0,
              bytes: [0, 0],
              writing: Promise.resolve(),
              queued: 0,
              peak: 0,
              total: 0,
              failed: false,
            };
          } catch (err) {
            for (const f of made) await f.close().catch(() => {});
            deps.diag.warn("background.view_open_failed", { id, err: errorMessage(err) });
          }
        }
        if (stopping !== null) {
          await closeAll(file, viewLog);
          return refused(ENDING);
        }
        let proc: Child;
        try {
          proc = await command("bash", {
            // The outer shell only puts stderr onto stdout and becomes the command's own shell,
            // keeping its pid: one pipe, in the order things were written.
            args: ["-c", 'exec bash -c "$1" 2>&1', "ryph-bg", args.command],
            cwd,
            env: { ...env },
            clearEnv: true,
            stdin: "null",
            stdout: "piped",
            stderr: "null",
            detached: true,
          }).spawn();
        } catch (err) {
          await closeAll(file, viewLog);
          deps.diag.warn("background.spawn_failed", { id, err: errorMessage(err) });
          return refused(`The command could not be started: ${errorMessage(err)}`);
        }
        const startedAt = now();
        let resolveDone!: () => void;
        const job: Job = {
          id,
          label,
          command: args.command,
          cwd,
          shown: {
            command: shownText(args.command),
            cwd: shownText(cwd),
          },
          service: args.service === true,
          readiness: args.readyWhen === undefined ? null : {
            marker: args.readyWhen,
            carry: "",
            at: null,
            told: false,
          },
          logPath,
          startedAt,
          timeoutAt: startedAt + minutes * minuteMs,
          pid: proc.pid,
          exited: false,
          ending: null,
          ended: null,
          done: new Promise<void>((resolve) => (resolveDone = resolve)),
          timers: new Set(),
          signalling: Promise.resolve(),
          ring: new OutputRing(),
          people: new PeopleTail(),
          stream: new OutputStream(),
          file,
          viewLog,
          log: { bytes: 0, truncated: false },
          live: {
            pending: "",
            pendingBytes: 0,
            skipped: 0,
            windowAt: startedAt,
            spent: 0,
            started: false,
            afterReturn: false,
          },
          recorded: false,
          endTold: false,
          release: undefined,
          record: Promise.resolve(),
        };
        spawned = { proc, job };
        jobs.push(job);
        void watch(job, proc)
          .catch((err) => deps.diag.warn("background.watch_failed", { id, err }))
          .finally(() => resolveDone());
      } finally {
        starting--;
      }
      const { job } = spawned;
      const timeout = setTimeout(() => {
        job.timers.delete(timeout);
        deps.diag.debug("background.timed_out", { id: job.id });
        void terminate(job, "timeout", stopGraceMs);
      }, job.timeoutAt - job.startedAt);
      job.timers.add(timeout);
      deps.diag.debug("background.started", {
        id: job.id,
        pid: job.pid,
        service: job.service,
        timeoutMinutes: minutes,
      });
      const records = deps.records;
      if (records !== undefined) {
        chain(job, "started", async () => {
          await records.started({
            id: job.id,
            label: job.label,
            command: clip(job.shown.command, RECORD_COMMAND_CHARS),
            cwd: job.shown.cwd,
            service: job.service,
            startedAt: iso(job.startedAt),
            timeoutAt: iso(job.timeoutAt),
          });
        });
        // Bounded and best effort: the run page lists the job before the agent hears it started.
        await within(job.record, recordWaitMs);
      }
      job.recorded = true;
      tellReady(job);
      // The first job opens the uplink, whose replay already carries it.
      if (deps.uplink !== undefined && uplinkOpen) {
        if (!job.live.started) announce(job);
      } else if (deps.uplink !== undefined) {
        uplinkOpen = true;
        try {
          deps.uplink.open(replay);
        } catch (err) {
          deps.diag.warn("background.uplink_open_failed", { err });
        }
      }
      holdChanged();
      return { kind: "started", job: view(job) };
    },

    output(args) {
      if (args.id === undefined) return { kind: "list", jobs: jobs.map(view) };
      const job = find(args.id);
      if ("reason" in job) return refused(job.reason);
      const lines = args.tailLines ?? BACKGROUND_TAIL_DEFAULT;
      if (!Number.isInteger(lines) || lines < 1 || lines > BACKGROUND_TAIL_MAX) {
        return refused(`tailLines must be a whole number from 1 to ${BACKGROUND_TAIL_MAX}.`);
      }
      const tail = tailOf(job.ring.text, lines, OUTPUT_TOOL_CHARS);
      return { kind: "job", job: view(job), tail: tail.text, lines: tail.lines };
    },

    async stop(id) {
      const job = find(id);
      if ("reason" in job) return refused(job.reason);
      if (job.ended !== null) return { kind: "stopped", job: view(job), already: true };
      await terminate(job, "stopped", stopGraceMs);
      return { kind: "stopped", job: view(job), already: false };
    },

    holdUntil() {
      let until: number | null = null;
      for (const job of jobs) {
        if (job.ended !== null || job.service) continue;
        until = Math.max(until ?? 0, job.timeoutAt + HOLD_SLACK_MS);
      }
      return until;
    },

    stopAll,

    close(boundMs = CLOSE_BOUND_MS) {
      closing ??= (async () => {
        await stopAll();
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        // Each job's watch first — it is what chains the last of its records — then the records.
        const records = Promise.all(jobs.map((job) => job.done))
          .then(() => Promise.all(jobs.map((job) => job.record)));
        if (!(await within(records, boundMs))) {
          deps.diag.warn("background.records_unfinished", { boundMs });
        }
        // What the bound cut short still holds its files: they are closed here, as the logs go.
        for (const job of jobs) await closeLog(job);
        await deps.uplink?.close().catch((err) =>
          deps.diag.debug("background.uplink_close_failed", { err: errorMessage(err) })
        );
        if (dir !== null) {
          const made = await dir.catch(() => null);
          if (made !== null) await rm(made, { recursive: true }).catch(() => {});
        }
      })();
      return closing;
    },
  };
}

const refused = (reason: string) => ({ kind: "refused", reason }) as const;

/** Closes a job's log and view handles that never reached a job; a failed close is nothing. */
async function closeAll(file: FileHandle | null, view: ViewLog | null): Promise<void> {
  for (const f of [file, ...(view?.segments ?? [])]) await f?.close().catch(() => {});
}

/**
 * Sends `signal` to the process group `pgid` (kill(2) on `-pgid`). Null when it was sent or the
 * group is gone already; otherwise what went wrong, as the error's code and message.
 */
export function signalProcessGroup(
  pgid: number,
  signal: "SIGTERM" | "SIGKILL",
): Promise<{ signal: string; code: string | null; stderr: string } | null> {
  // `-1` is every process this uid may signal, and `-0` the runner's own group: never a job's.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    return Promise.resolve({ signal, code: null, stderr: `not a job's process group: ${pgid}` });
  }
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? null;
    if (code === "ESRCH") return Promise.resolve(null);
    return Promise.resolve({ signal, code, stderr: clip(errorMessage(err), 1_024) });
  }
  return Promise.resolve(null);
}

const ENDING = "The run is ending, so no background command can start. Your bash tool still " +
  "works for short commands.";

/** The agent's notice of a job's end: the status, and the end of its output, after which the
 * whole log is named. */
function noticeOf(job: Job, seen: BackgroundJobView): BackgroundNoticeMessage {
  const ended = job.ended!;
  const tail = tailOf(job.ring.text, NOTICE_LINES, NOTICE_CHARS);
  const service = job.service
    ? " It was started as a service, so it was not expected to end while the run goes on."
    : "";
  const output = tail.lines === 0
    ? " It printed nothing."
    : `\n\nIts last ${tail.lines === 1 ? "line" : `${tail.lines} lines`}:\n\n${tail.text}\n\n` +
      `All of its output is in ${job.logPath}.`;
  return {
    kind: "system",
    sender: { kind: "platform" },
    text: `Background command ${job.id} (${JSON.stringify(job.label)}) ${
      describeEnd(seen)
    }.${service}${output}`,
    payload: null,
    createdAt: new Date(ended.at).toISOString(),
    background: {
      id: job.id,
      label: job.label,
      reason: ended.reason === "timeout" ? "timeout" : "exited",
      exitCode: ended.exitCode,
      signal: ended.signal,
      durationMs: seen.durationMs,
    },
  };
}

/** How a job stands, in words: "running for 3m 2s", "exited with code 1 after 4m 12s". */
export function describeEnd(job: BackgroundJobView): string {
  const took = formatDuration(job.durationMs);
  if (job.ended === null) return `running for ${took}`;
  switch (job.ended.reason) {
    case "exited":
      return job.ended.signal !== null
        ? `was killed by ${job.ended.signal} after ${took}`
        : `exited with code ${job.ended.exitCode} after ${took}`;
    case "timeout":
      return `timed out and was stopped after ${took}`;
    case "stopped":
      return `was stopped after ${took}`;
    case "run_ended":
      return `was stopped when the run ended, after ${took}`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * A job's output kept in memory: its last RING_CHARS characters and RING_LINES lines, whichever
 * is less. Newlines are counted as text arrives and leaves, so keeping it costs what it holds.
 */
export class OutputRing {
  /** Whole lines, each as last drawn. */
  #done = "";
  /** The current line, which a redraw replaces. */
  #line = "";
  /** Newlines in `#done`. */
  #lines = 0;
  /** The current line ended in a redraw: what comes next on it replaces it. */
  #redraw = false;

  /** The text kept: each line as it was last drawn, with no `\r` in it. */
  get text(): string {
    return this.#done + this.#line;
  }

  /** Clean output: a `\r` marks the current line as redrawn, and the next text on it replaces it
   * — so a progress bar keeps one line, its last, and an error before it stays in view. A redraw
   * touches only the current line, and the trim runs once per append, so a flood of redraws
   * costs its length. */
  append(text: string): void {
    const parts = text.split("\r");
    for (const [i, part] of parts.entries()) {
      if (i > 0) this.#redraw = true;
      if (part === "") continue;
      if (this.#redraw && !part.startsWith("\n")) this.#line = "";
      this.#redraw = false;
      const nl = part.lastIndexOf("\n");
      if (nl === -1) this.#line += part;
      else {
        this.#done += this.#line + part.slice(0, nl + 1);
        this.#line = part.slice(nl + 1);
        this.#lines += countNewlines(part);
      }
    }
    let all = this.#done + this.#line;
    if (all.length <= RING_CHARS && this.#lines <= RING_LINES) return;
    let lines = this.#lines;
    if (all.length > RING_CHARS) {
      let cut = all.length - RING_CHARS;
      // From a line's start where one is near, so the oldest line kept is whole.
      const nl = all.indexOf("\n", cut);
      if (nl !== -1 && nl - cut < 4_096) cut = nl + 1;
      lines -= countNewlines(all.slice(0, cut));
      all = all.slice(cut);
    }
    if (lines > RING_LINES) {
      let cut = -1;
      for (let excess = lines - RING_LINES; excess > 0; excess--) cut = all.indexOf("\n", cut + 1);
      lines -= countNewlines(all.slice(0, cut + 1));
      all = all.slice(cut + 1);
    }
    this.#lines = lines;
    const last = all.lastIndexOf("\n");
    this.#done = all.slice(0, last + 1);
    this.#line = all.slice(last + 1);
  }
}

/** The people's view kept in memory: its last PEOPLE_TAIL_CHARS, from a line's start where one
 * is near, and how many bytes of it are no longer kept. */
export class PeopleTail {
  #text = "";
  #dropped = 0;

  get text(): string {
    return this.#text;
  }

  get dropped(): number {
    return this.#dropped;
  }

  append(text: string): void {
    this.#text += text;
    if (this.#text.length <= PEOPLE_TAIL_CHARS) return;
    let cut = this.#text.length - PEOPLE_TAIL_CHARS;
    const nl = this.#text.indexOf("\n", cut);
    if (nl !== -1 && nl - cut < 4_096) cut = nl + 1;
    this.#dropped += utf8Bytes(this.#text.slice(0, cut));
    this.#text = this.#text.slice(cut);
  }
}

function countNewlines(text: string): number {
  let n = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return n;
}

/** The last `lines` lines of `text`, at most `maxChars` of it, and how many lines that is. */
export function tailOf(
  text: string,
  lines: number,
  maxChars: number,
): { text: string; lines: number } {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body === "") return { text: "", lines: 0 };
  const picked = body.split("\n").slice(-lines);
  let size = picked.reduce((sum, line) => sum + line.length + 1, -1);
  while (picked.length > 1 && size > maxChars) size -= picked.shift()!.length + 1;
  if (size > maxChars) picked[0] = picked[0].slice(-maxChars);
  return { text: picked.join("\n"), lines: picked.length };
}

/** Text cut into uplink-sized pieces: at most LIVE_TEXT_CHARS characters and LIVE_TEXT_BYTES
 * once JSON-encoded, never splitting a surrogate pair. */
export function livePieces(text: string): string[] {
  const pieces: string[] = [];
  let at = 0;
  while (at < text.length) {
    let size = Math.min(LIVE_TEXT_CHARS, text.length - at);
    for (;;) {
      if (at + size < text.length && isHighSurrogate(text.charCodeAt(at + size - 1))) size--;
      const piece = text.slice(at, at + size);
      if (size <= 1 || utf8Bytes(JSON.stringify(piece)) <= LIVE_TEXT_BYTES) {
        pieces.push(piece);
        at += piece.length;
        break;
      }
      size = Math.ceil(size / 2);
    }
  }
  return pieces;
}

/** The longest end of `text` that is at most `max` bytes as UTF-8. Output that is not UTF-8
 * decodes larger (each bad byte is three), and the control plane refuses a log over its cap. */
function lastBytes(text: string, max: number): string {
  // From the end, so a short tail of a long text costs the tail.
  let bytes = 0;
  let i = text.length;
  while (i > 0) {
    let code = text.charCodeAt(i - 1);
    let width = 1;
    if (code >= 0xdc00 && code <= 0xdfff && i >= 2) {
      const high = text.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        code = 0x10000;
        width = 2;
      }
    }
    if (bytes + charBytes(code) > max) break;
    bytes += charBytes(code);
    i -= width;
  }
  return text.slice(i);
}

/** Text cut from the front, from its first whole line where one starts near. */
function fromLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 || nl >= 4_096 ? text : text.slice(nl + 1);
}

/** Writes all of `bytes`, at `position` when given, else where the handle's last write ended. */
async function writeAll(file: FileHandle, bytes: Uint8Array, position?: number): Promise<void> {
  let at = 0;
  while (at < bytes.byteLength) {
    const { bytesWritten } = await file.write(
      bytes,
      at,
      bytes.byteLength - at,
      position === undefined ? null : position + at,
    );
    at += bytesWritten;
  }
}

/**
 * The stored log: the last LOG_UPLOAD_BYTES of the people's view as it was written while the job
 * ran — the older segment, then the newer, read through the handles this side created — from the
 * first line break where that cuts into it, if one is near. Null when there is no view, or a
 * write to it failed.
 */
async function readView(view: ViewLog | null): Promise<string | null> {
  if (view === null) return null;
  await view.writing;
  if (view.failed) return null;
  try {
    const older = view.current === 0 ? 1 : 0;
    let text = "";
    for (const n of [older, view.current]) {
      const file = view.segments[n];
      const bytes = new Uint8Array(view.bytes[n]);
      let at = 0;
      while (at < bytes.byteLength) {
        const { bytesRead } = await file.read(bytes, at, bytes.byteLength - at, at);
        if (bytesRead === 0) break;
        at += bytesRead;
      }
      text += new TextDecoder().decode(bytes.subarray(0, at));
    }
    const fitted = lastBytes(text, LOG_UPLOAD_BYTES);
    if (fitted.length === text.length) return text;
    const nl = fitted.indexOf("\n");
    return nl === -1 || nl >= 4_096 ? fitted : fitted.slice(nl + 1);
  } catch {
    return null;
  }
}
