import type {
  BackgroundJob,
  CommandsEvent,
  CommandsSnapshot,
  LiveCommandsJob,
} from "$lib/api/background";

// The rules the Commands tab follows, kept apart from the component so they can be tested: how
// the live room's lines move a viewer's jobs, how those meet the durable record, and how a job's
// output is held.

/** A job as the live room describes it, in the shape the durable record has. */
export function liveJob(job: LiveCommandsJob): BackgroundJob {
  const ended = job.status === "ended"
    ? { endedAt: job.endedAt, reason: job.reason, exitCode: job.exitCode, signal: job.signal }
    : { endedAt: null, reason: null, exitCode: null, signal: null };
  return {
    id: job.id,
    label: job.label,
    command: job.command,
    cwd: job.cwd,
    service: job.service,
    startedAt: job.at,
    timeoutAt: job.timeoutAt,
    ...ended,
    hasLog: false,
    logTail: null,
    logTruncated: false,
  };
}

/** The jobs a snapshot describes, by id. */
export function snapshotJobs(snapshot: CommandsSnapshot): Map<string, BackgroundJob> {
  return new Map(snapshot.jobs.map((job) => [job.id, liveJob(job)]));
}

/**
 * One line folded into the viewer's jobs. Output moves no job, so the same map comes back and
 * nothing that reads the jobs wakes; a start or an end is a new map.
 */
export function applyCommandsEvent(
  jobs: ReadonlyMap<string, BackgroundJob>,
  event: CommandsEvent,
): ReadonlyMap<string, BackgroundJob> {
  if (event.type === "started") {
    const next = new Map(jobs);
    next.set(event.id, {
      id: event.id,
      label: event.label,
      command: event.command,
      cwd: event.cwd,
      service: event.service,
      startedAt: event.at,
      timeoutAt: event.timeoutAt,
      endedAt: null,
      reason: null,
      exitCode: null,
      signal: null,
      hasLog: false,
      logTail: null,
      logTruncated: false,
    });
    return next;
  }
  if (event.type === "exited") {
    const job = jobs.get(event.id);
    if (job === undefined) return jobs;
    const next = new Map(jobs);
    next.set(event.id, {
      ...job,
      endedAt: event.at,
      reason: event.reason,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    return next;
  }
  return jobs;
}

/**
 * The jobs the tab lists: the durable record's, met with the live room's, newest first.
 *
 * The record is the authority on what a job is and, once it says so, on how it ended: its rows
 * carry the log and the tail. The room is ahead of it in between: a job it has seen start that the
 * record has not caught up with yet, or an end the record does not have yet. A room that is stale
 * (the tab was shut) never claims a job is still running against a record that says it ended.
 */
export function mergeJobs(
  durable: readonly BackgroundJob[],
  live: ReadonlyMap<string, BackgroundJob>,
): BackgroundJob[] {
  const byId = new Map<string, BackgroundJob>();
  for (const job of durable) {
    const seen = live.get(job.id);
    byId.set(
      job.id,
      job.endedAt === null && seen !== undefined && seen.endedAt !== null
        ? {
          ...job,
          endedAt: seen.endedAt,
          reason: seen.reason,
          exitCode: seen.exitCode,
          signal: seen.signal,
        }
        : job,
    );
  }
  for (const [id, job] of live) {
    if (!byId.has(id)) byId.set(id, job);
  }
  return [...byId.values()].toSorted((a, b) =>
    b.startedAt - a.startedAt || jobNumber(b.id) - jobNumber(a.id)
  );
}

function jobNumber(id: string): number {
  const n = Number(id.replace(/^bg-/, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The job the tab shows: the one asked for, which may not be listed yet (null then, never another
 * job in its place); with none asked for, the newest running one, else the newest.
 */
export function pickJob(
  jobs: readonly BackgroundJob[],
  wanted: string | null,
): BackgroundJob | null {
  if (wanted !== null) return jobs.find((job) => job.id === wanted) ?? null;
  return jobs.find((job) => job.endedAt === null) ?? jobs[0] ?? null;
}

/**
 * The jobs as they stand once the run is over: one still open in the record was stopped with the
 * run, whose end is its end, even before the runner's exit record lands.
 */
export function settleWithRun(
  jobs: readonly BackgroundJob[],
  runEndedAt: number | null,
): BackgroundJob[] {
  if (runEndedAt === null || jobs.every((job) => job.endedAt !== null)) return [...jobs];
  return jobs.map((job) =>
    job.endedAt !== null ? job : {
      ...job,
      endedAt: Math.max(job.startedAt, runEndedAt),
      reason: "run_ended",
      exitCode: null,
      signal: null,
    }
  );
}

// ---- When to read the list again -----------------------------------------------------------

/** How often the list is read while something in it can still change. */
export const COMMANDS_POLL_MS = 3_000;
/** How long after a job ends its stored log may take to land. */
export const LOG_SETTLE_MS = 30_000;

/**
 * Whether the list can still change on its own and is worth reading again: on a live run, while
 * a job runs, or one ended so recently that its log may still be on its way.
 */
export function needsPolling(
  jobs: readonly BackgroundJob[],
  now: number,
  runLive: boolean,
): boolean {
  if (!runLive) return false;
  return jobs.some((job) =>
    job.endedAt === null || (!job.hasLog && now - job.endedAt < LOG_SETTLE_MS)
  );
}

/**
 * The cues the page reads the list on, besides the tab opening, the live room and the poll: the
 * transcript showing a new start, stop or end of a command, and the run concluding. Each answers
 * whether this observation is one, and remembers it for the next.
 */
export class CommandsCues {
  #transcript: { history: object; count: number } | null = null;
  #terminal: { runId: string | null; terminal: boolean } | null = null;

  /**
   * The transcript knows of `count` starts, stops and ends. The first count on a history is what
   * it was seeded with, which the tab reads for itself when it opens; only a count that grows
   * after it is a cue. `history` is the run's own history, and a new one starts over.
   */
  transcript(history: object, count: number): boolean {
    const before = this.#transcript;
    this.#transcript = { history, count };
    return before !== null && before.history === history && count > before.count;
  }

  /** The run's state as the page sees it; a cue only when this run turns terminal. */
  terminal(runId: string | null, terminal: boolean): boolean {
    const before = this.#terminal;
    this.#terminal = { runId, terminal };
    return before !== null && before.runId === runId && !before.terminal && terminal;
  }
}

// ---- Output -------------------------------------------------------------------------------

/** One stretch of output as it arrived, or a note that some was skipped. */
export interface OutputChunk {
  text: string;
  skipped: boolean;
}

export type OutputChange =
  | { kind: "append"; chunk: OutputChunk }
  /** The oldest `count` chunks were dropped. */
  | { kind: "trim"; count: number }
  /** Everything was replaced; read `chunks` afresh. */
  | { kind: "reset" };

/** Per job, the most output a viewer holds: the room's own ring. */
export const OUTPUT_MAX_CHARS = 256 * 1024;
/** And the most separate chunks, each of which is a node in the document. */
export const OUTPUT_MAX_CHUNKS = 4_000;

function kilobytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * A job's live output: bounded, oldest out first, and told to whoever draws it one chunk at a
 * time, so a view appends what arrived rather than drawing the whole log again.
 */
export class OutputBuffer {
  #chunks: OutputChunk[] = [];
  #chars = 0;
  readonly #listeners = new Set<(change: OutputChange) => void>();
  readonly #maxChars: number;
  readonly #maxChunks: number;

  constructor(maxChars = OUTPUT_MAX_CHARS, maxChunks = OUTPUT_MAX_CHUNKS) {
    this.#maxChars = maxChars;
    this.#maxChunks = maxChunks;
  }

  get chunks(): readonly OutputChunk[] {
    return this.#chunks;
  }

  get chars(): number {
    return this.#chars;
  }

  /** Everything held, as one string. */
  get text(): string {
    return this.#chunks.filter((c) => !c.skipped).map((c) => c.text).join("");
  }

  append(text: string): void {
    if (text === "") return;
    this.#push({
      text: text.length > this.#maxChars ? text.slice(-this.#maxChars) : text,
      skipped: false,
    });
  }

  /** The runner held back this many bytes to keep its rate. */
  skipped(bytes: number): void {
    this.#push({ text: `[${kilobytes(bytes)} of output skipped]\n`, skipped: true });
  }

  /** Start over from `text`: a snapshot's tail, or nothing. */
  reset(text = ""): void {
    const kept = text.length > this.#maxChars ? text.slice(-this.#maxChars) : text;
    this.#chunks = kept === "" ? [] : [{ text: kept, skipped: false }];
    this.#chars = kept.length;
    this.#emit({ kind: "reset" });
  }

  subscribe(listener: (change: OutputChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #push(chunk: OutputChunk): void {
    this.#chunks.push(chunk);
    this.#chars += chunk.text.length;
    this.#emit({ kind: "append", chunk });
    let drop = 0;
    let chars = this.#chars;
    while (
      drop < this.#chunks.length - 1 &&
      (chars > this.#maxChars || this.#chunks.length - drop > this.#maxChunks)
    ) {
      chars -= this.#chunks[drop].text.length;
      drop++;
    }
    if (drop === 0) return;
    this.#chunks = this.#chunks.slice(drop);
    this.#chars = chars;
    this.#emit({ kind: "trim", count: drop });
  }

  #emit(change: OutputChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}
