// The background commands' live channel: a room per run
// holding each job the agent started in the background and the recent output of each, so a viewer
// opening the run's Commands tab sees what is running RIGHT NOW. The registry and the viewer
// mailbox are core/rooms.ts, shared with the browser's channel (core/live.ts); this is the kind.
//
// Invariants:
// - memory only, never persisted: what a job was and how it ended is the orchestrator's
//   `run_background_commands`, and its whole log is stored there when it ends. A room is the jobs'
//   started and exited fields and a bounded output ring per job, nothing more.
// - a channel of its own, beside the browser's and never mixed into it: the browser's uplink
//   resets its room on every connect, and so does this one, independently.
// - bounded in BYTES and in jobs: the uplink's token is one the agent can read, so what it sends
//   is the agent's to choose. A room holds at most MAX_JOBS jobs (a further `started` is refused),
//   each job's output at most JOB_RING_BYTES (its oldest output goes first), and ROOM_BUDGET in
//   all — over that, the output of the job that ended first goes first, and only once no ended
//   job has any left does a running job's oldest output. Sizes are strings counted as UTF-8
//   (`utf8Length`, never under the real size).
// - a slow viewer may miss output (and is told, with `dropped`), never a `started` or an `exited`:
//   those are what its list of jobs is drawn from.
// - a new uplink's lines are the room's whole history: the runner opens each uplink by replaying
//   `started` for every job, its ring as `output`, and `exited` for every ended one, so opening an
//   uplink empties the room, and viewers are sent the empty room as a snapshot before the replay
//   refills it.
// - a line only lands on a job the room knows: `output`, `skipped` and `exited` for an id with no
//   `started` are refused, as are a second `started` and a second `exited` for one id.

import {
  type Broadcast,
  makeRooms,
  OVERHEAD,
  type RoomLimits,
  type RoomOut,
  type Rooms,
  type RoomUplink,
  type RoomViewer,
  SMALL,
  utf8Length,
} from "./rooms.ts";

/** How a job ended: by itself, by its timeout, by the agent's `background_stop`, or with the run. */
export type CommandEndReason = "exited" | "timeout" | "stopped" | "run_ended";

export type CommandStarted = {
  type: "started";
  at: number;
  id: string;
  label: string;
  command: string;
  cwd: string;
  service: boolean;
  /** When the runner will stop it, ms since the epoch; null for none. */
  timeoutAt: number | null;
};
export type CommandOutput = { type: "output"; at: number; id: string; text: string };
/** The runner spent its per-job budget for the window and left this many bytes out. */
export type CommandSkipped = { type: "skipped"; at: number; id: string; bytes: number };
export type CommandExited = {
  type: "exited";
  at: number;
  id: string;
  reason: CommandEndReason;
  exitCode: number | null;
  signal: string | null;
};

/** One line of the runner's commands uplink. */
export type CommandsEvent = CommandStarted | CommandOutput | CommandSkipped | CommandExited;

/** A job as a snapshot shows it: its started fields, how it ended once it has, and its output. */
export type CommandsJob = Omit<CommandStarted, "type"> & {
  status: "running" | "ended";
  reason?: CommandEndReason;
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: number;
  /** The output the room still holds, oldest first. */
  tail: string;
};

/** Everything the room holds: what a viewer is handed first, and again whenever an uplink opens
 * (which empties the room), to replace what it had. `at` is when it was built. */
export interface CommandsSnapshot {
  at: number;
  uplink: boolean;
  jobs: CommandsJob[];
}

/** One thing to send a viewer: the SSE event name and its data. */
export type CommandsOut =
  | { event: "started" | "output" | "skipped" | "exited"; data: CommandsEvent }
  | RoomOut<CommandsSnapshot>;

export type CommandsUplink = RoomUplink<CommandsEvent>;
export type CommandsViewer = RoomViewer<CommandsOut>;
export type CommandsRooms = Rooms<CommandsEvent, CommandsOut>;

/** Jobs a room holds; the runner starts at most 64 per run. */
export const MAX_JOBS = 64;
/** Output held per job, in estimated bytes. */
export const JOB_RING_BYTES = 256 * 1024;
/** What a room may hold across its jobs, in estimated bytes. */
export const ROOM_BUDGET = 2 * 1024 * 1024;

interface Chunk {
  text: string;
  bytes: number;
}

interface Job {
  started: CommandStarted;
  exited: CommandExited | null;
  /** When it ended, in the room's arrival order: the budget empties the earliest first. */
  endedOrder: number;
  chunks: Chunk[];
  /** Estimated bytes of `chunks`. */
  outputBytes: number;
  /** Estimated bytes of its started and exited fields. */
  fieldBytes: number;
}

interface CommandsState {
  jobs: Map<string, Job>;
  /** Estimated bytes held across every job's fields and output. */
  bytes: number;
}

const startedBytes = (event: CommandStarted): number =>
  OVERHEAD + event.id.length + utf8Length(event.label) + utf8Length(event.command) +
  utf8Length(event.cwd);
const chunkBytes = (text: string): number => OVERHEAD + utf8Length(text);

/** An event's size in bytes, its strings counted as UTF-8 (`utf8Length`, an upper bound) — never
 * by serializing it. */
export function commandsEventBytes(event: CommandsEvent): number {
  switch (event.type) {
    case "started":
      return startedBytes(event);
    case "output":
      return chunkBytes(event.text);
    case "skipped":
      return SMALL;
    case "exited":
      return SMALL + (event.signal?.length ?? 0);
  }
}

const dropOldestChunk = (state: CommandsState, job: Job): void => {
  const chunk = job.chunks.shift()!;
  job.outputBytes -= chunk.bytes;
  state.bytes -= chunk.bytes;
};

/** Empties output until the room is within its budget: ended jobs first, earliest ended first,
 * then the oldest output of whichever running job has the most. */
const enforceBudget = (state: CommandsState, budget: number): void => {
  while (state.bytes > budget) {
    let victim: Job | null = null;
    for (const job of state.jobs.values()) {
      if (job.chunks.length === 0) continue;
      if (victim === null) victim = job;
      else if (job.exited !== null && victim.exited === null) victim = job;
      else if (job.exited !== null && victim.exited !== null) {
        if (job.endedOrder < victim.endedOrder) victim = job;
      } else if (job.exited === null && victim.exited === null) {
        if (job.outputBytes > victim.outputBytes) victim = job;
      }
    }
    if (victim === null) return; // only fields are left, each bounded by the schema
    dropOldestChunk(state, victim);
  }
};

const jobView = (job: Job): CommandsJob => {
  const { type: _type, ...started } = job.started;
  const view: CommandsJob = {
    ...started,
    status: job.exited === null ? "running" : "ended",
    tail: job.chunks.map((chunk) => chunk.text).join(""),
  };
  if (job.exited !== null) {
    view.reason = job.exited.reason;
    view.exitCode = job.exited.exitCode;
    view.signal = job.exited.signal;
    view.endedAt = job.exited.at;
  }
  return view;
};

export function makeCommandsRooms(
  opts: RoomLimits & { roomBudget?: number; jobRingBytes?: number; maxJobs?: number } = {},
): CommandsRooms {
  const now = opts.now ?? Date.now;
  const roomBudget = opts.roomBudget ?? ROOM_BUDGET;
  const jobRing = opts.jobRingBytes ?? JOB_RING_BYTES;
  const maxJobs = opts.maxJobs ?? MAX_JOBS;
  let arrivals = 0;

  const apply = (
    state: CommandsState,
    event: CommandsEvent,
    broadcast: Broadcast<CommandsOut>,
  ): boolean => {
    const job = state.jobs.get(event.id);
    switch (event.type) {
      case "started": {
        if (job !== undefined || state.jobs.size >= maxJobs) return false;
        const fieldBytes = startedBytes(event);
        state.jobs.set(event.id, {
          started: event,
          exited: null,
          endedOrder: 0,
          chunks: [],
          outputBytes: 0,
          fieldBytes,
        });
        state.bytes += fieldBytes;
        break;
      }
      case "output": {
        if (job === undefined) return false;
        const bytes = chunkBytes(event.text);
        job.chunks.push({ text: event.text, bytes });
        job.outputBytes += bytes;
        state.bytes += bytes;
        while (job.outputBytes > jobRing && job.chunks.length > 0) dropOldestChunk(state, job);
        break;
      }
      case "skipped":
        if (job === undefined) return false;
        break;
      case "exited": {
        if (job === undefined || job.exited !== null) return false;
        job.exited = event;
        job.endedOrder = arrivals++;
        const bytes = commandsEventBytes(event);
        job.fieldBytes += bytes;
        state.bytes += bytes;
        break;
      }
    }
    enforceBudget(state, roomBudget);
    broadcast({ event: event.type, data: event }, commandsEventBytes(event));
    return true;
  };

  return makeRooms<CommandsState, CommandsEvent, CommandsSnapshot, CommandsOut>({
    // A viewer that misses a start or an exit draws a job wrong until it reconnects; output it
    // missed is only a gap. Both are bounded per uplink, by MAX_JOBS.
    keep: ["started", "exited"],
    create: () => ({ jobs: new Map(), bytes: 0 }),
    // The runner replays every job it has on each new uplink.
    reset(state) {
      state.jobs = new Map();
      state.bytes = 0;
    },
    // Bounded by ROOM_BUDGET, because the room is. Jobs in the order they started.
    snapshot: (state, uplink) => ({
      at: now(),
      uplink,
      jobs: state === null ? [] : [...state.jobs.values()].map(jobView),
    }),
    apply,
  }, opts);
}
