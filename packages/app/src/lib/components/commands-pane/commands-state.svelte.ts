import type { BackgroundJob, CommandsMessage, CommandsSource } from "$lib/api/background";
import { applyCommandsEvent, OutputBuffer, snapshotJobs } from "./commands-view";

/** The soonest a stream that lost lines is reopened again, for a fresh snapshot. */
const RESYNC_MIN_MS = 10_000;

/** The most output held across every job of a run; past it, ended jobs' output goes first. */
const TOTAL_MAX_CHARS = 4 * 1024 * 1024;

/**
 * One run's background commands as the page holds them: the job the tab shows, and, while the tab
 * is open, the live room. One per run, made by the page; the tab calls `connect` when it mounts
 * and the stream is shut, and the room forgotten, when it unmounts.
 *
 * Output is held outside Svelte's reactivity, in a buffer per job that a view subscribes to: a
 * chunk arriving four times a second per job appends to the view showing it and wakes nothing
 * else. What is reactive is what the list reads: the jobs, and which of them has any output.
 */
export class CommandsState {
  /** The job the tab shows; null for "whichever is newest". */
  selected = $state<string | null>(null);
  /** The jobs as the room describes them; only the ended ones while the tab is shut. */
  jobs = $state.raw<ReadonlyMap<string, BackgroundJob>>(new Map());
  /** The jobs whose buffer holds anything. */
  withOutput = $state.raw<ReadonlySet<string>>(new Set());
  connection = $state<"connecting" | "open" | "retrying" | "closed">("closed");
  /** The runner is relaying; null until the stream says. */
  uplink = $state<boolean | null>(null);
  /** The room is gone: the run concluded. */
  done = $state(false);
  /** Lines a slow viewer lost since the last snapshot. */
  dropped = $state(0);
  /** Bumped whenever the room says a job started or ended, or lost lines that may have: the cue
   * for the page to read the durable list again. */
  changes = $state(0);
  /** The historian turned the stream away: the run has too many viewers. Cleared once it opens. */
  busy = $state(false);

  readonly #buffers = new Map<string, OutputBuffer>();
  /** Reopens the stream, for a fresh snapshot; null while it is shut. */
  #resync: (() => void) | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A job's live output. Made on first ask; it fills only while the stream is open. */
  buffer(id: string): OutputBuffer {
    let buffer = this.#buffers.get(id);
    if (buffer === undefined) {
      buffer = new OutputBuffer();
      this.#buffers.set(id, buffer);
    }
    return buffer;
  }

  connect(source: CommandsSource): () => void {
    this.connection = "connecting";
    this.done = false;
    const open = () =>
      source({
        onMessage: (message) => this.apply(message),
        onOpen: () => {
          if (!this.done) this.connection = "open";
        },
        onRetry: (busy = false) => {
          if (this.done) return;
          this.connection = "retrying";
          this.busy = busy;
        },
      });
    let stop = open();
    let resynced = -Infinity;
    this.#resync = () => {
      const now = this.#now();
      if (now - resynced < RESYNC_MIN_MS) return;
      resynced = now;
      stop();
      stop = open();
    };
    return () => {
      this.#resync = null;
      stop();
      this.#forget();
    };
  }

  /** One message, folded in. Public so a test or a fixture can drive it without a source. */
  apply(message: CommandsMessage): void {
    switch (message.kind) {
      case "snapshot": {
        this.connection = "open";
        this.busy = false;
        this.uplink = message.snapshot.uplink;
        // The room as it stands now: whatever was lost before it is said again in it.
        this.dropped = 0;
        // The room as it stands, over the ends this viewer already knew of: a room that started
        // afresh (a new uplink) says nothing of the jobs that ended before it.
        this.jobs = new Map([
          ...[...this.jobs].filter(([, job]) => job.endedAt !== null),
          ...snapshotJobs(message.snapshot),
        ]);
        // Everything is said again on a snapshot: each buffer starts over from the room's tail.
        for (const [id, buffer] of this.#buffers) {
          if (!this.jobs.has(id)) buffer.reset();
        }
        for (const job of message.snapshot.jobs) this.buffer(job.id).reset(job.tail);
        this.#marked();
        return;
      }
      case "event": {
        const event = message.event;
        if (event.type === "output") {
          this.buffer(event.id).append(event.text);
          this.#mark(event.id);
          this.#bound();
          return;
        }
        if (event.type === "skipped") {
          this.buffer(event.id).skipped(event.bytes);
          this.#mark(event.id);
          return;
        }
        // A new uplink replays every job, its start first and then its output: a start is where
        // a job's output begins again, whatever this viewer held of it.
        if (event.type === "started" && this.buffer(event.id).chars > 0) {
          this.buffer(event.id).reset();
          this.#marked();
        }
        this.jobs = applyCommandsEvent(this.jobs, event);
        this.changes++;
        return;
      }
      case "uplink":
        this.uplink = message.connected;
        return;
      case "dropped":
        // What was lost may have been a start or an end: the list is read again. And output
        // that was lost is only said again in a snapshot, which a reopened stream starts with.
        this.dropped += message.count;
        this.changes++;
        this.#resync?.();
        return;
      case "done":
        this.done = true;
        this.connection = "closed";
        return;
    }
  }

  #mark(id: string): void {
    if (this.withOutput.has(id)) return;
    this.withOutput = new Set([...this.withOutput, id]);
  }

  #marked(): void {
    const held = new Set<string>();
    for (const [id, buffer] of this.#buffers) if (buffer.chars > 0) held.add(id);
    this.withOutput = held;
  }

  /** Past the run-wide bound, the output of the jobs that ended longest ago is let go. */
  #bound(): void {
    let total = 0;
    for (const buffer of this.#buffers.values()) total += buffer.chars;
    if (total <= TOTAL_MAX_CHARS) return;
    const ended = [...this.jobs.values()]
      .filter((job) => job.endedAt !== null && job.id !== this.selected)
      .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const job of ended) {
      const buffer = this.#buffers.get(job.id);
      if (buffer === undefined || buffer.chars === 0) continue;
      total -= buffer.chars;
      buffer.reset();
      if (total <= TOTAL_MAX_CHARS) break;
    }
    this.#marked();
  }

  #forget(): void {
    for (const buffer of this.#buffers.values()) buffer.reset();
    // How a job ended, as the room said, is kept: the record may not have it yet, and it never
    // goes stale. Whether one is still running does, once nothing is listening.
    this.jobs = new Map([...this.jobs].filter(([, job]) => job.endedAt !== null));
    this.withOutput = new Set();
    this.connection = "closed";
    this.uplink = null;
    this.dropped = 0;
    this.busy = false;
  }
}
