import { describe, expect, it } from "vitest";
import type { BackgroundJob, CommandsMessage } from "$lib/api/background";
import { CommandsState } from "./commands-state.svelte";
import {
  applyCommandsEvent,
  CommandsCues,
  LOG_SETTLE_MS,
  mergeJobs,
  needsPolling,
  OutputBuffer,
  type OutputChange,
  pickJob,
  settleWithRun,
} from "./commands-view";

// The Commands tab lists the durable record met with the live room, and draws a job's output as
// it arrives. Pinned here: which side wins when they disagree, how the room's lines move a viewer,
// and that output stays bounded and is told to its view one chunk at a time.

function job(id: string, over: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id,
    label: `job ${id}`,
    command: "make",
    cwd: "/w",
    service: false,
    startedAt: 1_000,
    timeoutAt: null,
    endedAt: null,
    reason: null,
    exitCode: null,
    signal: null,
    hasLog: false,
    logTail: null,
    logTruncated: false,
    ...over,
  };
}

const ended = { endedAt: 5_000, reason: "exited" as const, exitCode: 1, signal: null };

describe("mergeJobs", () => {
  it("lists both sides' jobs once, newest first", () => {
    const merged = mergeJobs(
      [job("bg-1", { startedAt: 1_000 }), job("bg-2", { startedAt: 2_000 })],
      new Map([["bg-3", job("bg-3", { startedAt: 3_000 })], ["bg-1", job("bg-1")]]),
    );
    expect(merged.map((j) => j.id)).toEqual(["bg-3", "bg-2", "bg-1"]);
  });

  it("takes an end the room has seen before the record has", () => {
    const [merged] = mergeJobs(
      [job("bg-1", { hasLog: false, label: "from the record" })],
      new Map([["bg-1", job("bg-1", { ...ended, label: "from the room" })]]),
    );
    expect(merged).toMatchObject({ label: "from the record", endedAt: 5_000, exitCode: 1 });
  });

  it("never lets a stale room call an ended job running", () => {
    const [merged] = mergeJobs(
      [job("bg-1", { ...ended, hasLog: true })],
      new Map([["bg-1", job("bg-1")]]),
    );
    expect(merged).toMatchObject({ endedAt: 5_000, reason: "exited", hasLog: true });
  });

  it("orders jobs started in the same millisecond by their number", () => {
    const merged = mergeJobs([job("bg-9"), job("bg-10")], new Map());
    expect(merged.map((j) => j.id)).toEqual(["bg-10", "bg-9"]);
  });
});

describe("pickJob", () => {
  const jobs = [job("bg-3", ended), job("bg-2"), job("bg-1")];

  it("opens on the job asked for, else the newest running one, else the newest", () => {
    expect(pickJob(jobs, "bg-1")?.id).toBe("bg-1");
    expect(pickJob(jobs, null)?.id).toBe("bg-2");
    // A job asked for that is not listed yet is not stood in for by another.
    expect(pickJob(jobs, "bg-99")).toBeNull();
    expect(pickJob([job("bg-1", ended)], null)?.id).toBe("bg-1");
    expect(pickJob([], null)).toBeNull();
  });
});

describe("settleWithRun", () => {
  it("ends a job still open on a run that is over, with the run", () => {
    const [open, done] = settleWithRun([job("bg-2"), job("bg-1", ended)], 9_000);
    expect(open).toMatchObject({ endedAt: 9_000, reason: "run_ended", exitCode: null });
    expect(done).toMatchObject(ended);
  });

  it("leaves a live run's jobs as they are", () => {
    expect(settleWithRun([job("bg-1")], null)[0].endedAt).toBeNull();
  });
});

describe("needsPolling", () => {
  const now = 100_000;

  it("reads again while a job runs, or one ended recently without its log", () => {
    expect(needsPolling([job("bg-1")], now, true)).toBe(true);
    expect(needsPolling([job("bg-1", { ...ended, endedAt: now - 1_000 })], now, true)).toBe(true);
  });

  it("stops once every job has ended and its log landed, or is long past waiting for", () => {
    const logged = job("bg-1", { ...ended, endedAt: now - 1_000, hasLog: true });
    const stale = job("bg-2", { ...ended, endedAt: now - LOG_SETTLE_MS - 1 });
    expect(needsPolling([logged, stale], now, true)).toBe(false);
    expect(needsPolling([], now, true)).toBe(false);
  });

  it("never on a run that is over", () => {
    expect(needsPolling([job("bg-1")], now, false)).toBe(false);
  });
});

describe("CommandsCues", () => {
  it("cues on the transcript's count growing past what it was seeded with", () => {
    const cues = new CommandsCues();
    const history = {};
    expect(cues.transcript(history, 3)).toBe(false); // the seed
    expect(cues.transcript(history, 3)).toBe(false);
    expect(cues.transcript(history, 4)).toBe(true);
    expect(cues.transcript(history, 4)).toBe(false);
    // Another run's history starts over.
    expect(cues.transcript({}, 9)).toBe(false);
  });

  it("cues once as a run turns terminal, and not on a run first seen over", () => {
    const cues = new CommandsCues();
    expect(cues.terminal("run-1", false)).toBe(false);
    expect(cues.terminal("run-1", true)).toBe(true);
    expect(cues.terminal("run-1", true)).toBe(false);
    expect(cues.terminal("run-2", true)).toBe(false);
  });
});

describe("applyCommandsEvent", () => {
  it("adds a started job, and ends it on its exit", () => {
    let jobs = applyCommandsEvent(new Map(), {
      type: "started",
      at: 10,
      id: "bg-1",
      label: "Build",
      command: "make",
      cwd: "/w",
      service: false,
      timeoutAt: 1_810,
    });
    expect(jobs.get("bg-1")).toMatchObject({ startedAt: 10, endedAt: null, timeoutAt: 1_810 });
    jobs = applyCommandsEvent(jobs, {
      type: "exited",
      at: 50,
      id: "bg-1",
      reason: "timeout",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(jobs.get("bg-1")).toMatchObject({ endedAt: 50, reason: "timeout", signal: "SIGTERM" });
  });

  it("hands back the same map for output, so nothing reading the jobs wakes", () => {
    const jobs = new Map([["bg-1", job("bg-1")]]);
    expect(applyCommandsEvent(jobs, { type: "output", at: 1, id: "bg-1", text: "x" })).toBe(jobs);
    expect(
      applyCommandsEvent(jobs, {
        type: "exited",
        at: 1,
        id: "bg-7",
        reason: "stopped",
        exitCode: null,
        signal: null,
      }),
    ).toBe(jobs);
  });
});

describe("OutputBuffer", () => {
  it("tells its view each chunk as it arrives", () => {
    const buffer = new OutputBuffer();
    const changes: OutputChange[] = [];
    buffer.subscribe((change) => changes.push(change));
    buffer.append("one\n");
    buffer.append("");
    buffer.skipped(8192);
    buffer.append("two\n");
    expect(changes.map((c) => c.kind)).toEqual(["append", "append", "append"]);
    expect(buffer.chunks[1]).toEqual({ text: "[8 KB of output skipped]\n", skipped: true });
    // The note is the viewer's, not the command's: copying the output leaves it out.
    expect(buffer.text).toBe("one\ntwo\n");
  });

  it("lets the oldest output go past its bound, and says how much", () => {
    const buffer = new OutputBuffer(10, 100);
    const changes: OutputChange[] = [];
    buffer.subscribe((change) => changes.push(change));
    buffer.append("aaaa");
    buffer.append("bbbb");
    buffer.append("cccc");
    expect(buffer.text).toBe("bbbbcccc");
    expect(buffer.chars).toBe(8);
    expect(changes.at(-1)).toEqual({ kind: "trim", count: 1 });
  });

  it("keeps the end of one chunk longer than the whole bound", () => {
    const buffer = new OutputBuffer(4, 100);
    buffer.append("abcdefgh");
    expect(buffer.text).toBe("efgh");
  });

  it("bounds the number of chunks too", () => {
    const buffer = new OutputBuffer(1_000, 3);
    for (const text of ["a", "b", "c", "d", "e"]) buffer.append(text);
    expect(buffer.chunks.map((c) => c.text)).toEqual(["c", "d", "e"]);
  });

  it("starts over on a reset", () => {
    const buffer = new OutputBuffer();
    const changes: OutputChange[] = [];
    buffer.append("old");
    buffer.subscribe((change) => changes.push(change));
    buffer.reset("tail\n");
    expect(buffer.text).toBe("tail\n");
    expect(changes).toEqual([{ kind: "reset" }]);
    buffer.reset();
    expect(buffer.chars).toBe(0);
  });
});

describe("CommandsState", () => {
  const snapshot = (tail: string): CommandsMessage => ({
    kind: "snapshot",
    snapshot: {
      uplink: true,
      jobs: [
        {
          at: 1,
          id: "bg-1",
          label: "Build",
          command: "make",
          cwd: "/w",
          service: false,
          timeoutAt: null,
          status: "running",
          tail,
        },
      ],
    },
  });

  it("starts each buffer over from a snapshot, so a reconnect repeats nothing", () => {
    const state = new CommandsState();
    state.apply(snapshot("a\n"));
    state.apply({ kind: "event", event: { type: "output", at: 2, id: "bg-1", text: "b\n" } });
    expect(state.buffer("bg-1").text).toBe("a\nb\n");
    state.apply(snapshot("a\nb\n"));
    expect(state.buffer("bg-1").text).toBe("a\nb\n");
    expect(state.jobs.get("bg-1")?.endedAt).toBeNull();
    expect(state.withOutput.has("bg-1")).toBe(true);
    expect(state.uplink).toBe(true);
  });

  it("asks for the list again on a start, an end or lost lines, and not on output", () => {
    const state = new CommandsState();
    state.apply(snapshot("a\n"));
    state.apply({ kind: "event", event: { type: "output", at: 2, id: "bg-1", text: "b\n" } });
    expect(state.changes).toBe(0);
    state.apply({
      kind: "event",
      event: { type: "exited", at: 3, id: "bg-1", reason: "exited", exitCode: 0, signal: null },
    });
    state.apply({ kind: "dropped", count: 2 });
    expect(state.changes).toBe(2);
    expect(state.dropped).toBe(2);
    // A snapshot says the room again, so nothing is missing from it any more.
    state.apply(snapshot("a\n"));
    expect(state.dropped).toBe(0);
  });

  it("reopens the stream on lost lines, at most once in ten seconds", () => {
    let now = 0;
    const state = new CommandsState(() => now);
    let opened = 0;
    let closed = 0;
    const stop = state.connect(() => {
      opened++;
      return () => closed++;
    });
    state.apply({ kind: "dropped", count: 1 });
    expect([opened, closed]).toEqual([2, 1]);
    now = 5_000;
    state.apply({ kind: "dropped", count: 1 });
    expect(opened).toBe(2);
    now = 10_000;
    state.apply({ kind: "dropped", count: 1 });
    expect(opened).toBe(3);
    stop();
    state.apply({ kind: "dropped", count: 1 });
    expect([opened, closed]).toEqual([3, 3]);
  });

  it("says when the run has too many viewers, until the stream opens", () => {
    const state = new CommandsState();
    let retry: ((busy?: boolean) => void) | undefined;
    state.connect((h) => {
      retry = h.onRetry;
      return () => {};
    });
    retry!(true);
    expect([state.connection, state.busy]).toEqual(["retrying", true]);
    state.apply(snapshot(""));
    expect(state.busy).toBe(false);
  });

  it("keeps how jobs ended once shut, and over a snapshot of a room started afresh", () => {
    const state = new CommandsState();
    const stop = state.connect(() => () => {});
    state.apply(snapshot(""));
    state.apply({
      kind: "event",
      event: { type: "exited", at: 3, id: "bg-1", reason: "stopped", exitCode: null, signal: null },
    });
    stop();
    expect(state.jobs.get("bg-1")).toMatchObject({ endedAt: 3, reason: "stopped" });
    state.connect(() => () => {});
    state.apply({ kind: "snapshot", snapshot: { uplink: true, jobs: [] } });
    expect(state.jobs.get("bg-1")?.reason).toBe("stopped");
  });

  it("does not repeat an ended job's output when a new uplink replays it", () => {
    const state = new CommandsState();
    const started = {
      type: "started" as const,
      at: 1,
      id: "bg-1",
      label: "Build",
      command: "make",
      cwd: "/w",
      service: false,
      timeoutAt: null,
    };
    const replay = () => {
      state.apply({ kind: "event", event: started });
      state.apply({ kind: "event", event: { type: "output", at: 2, id: "bg-1", text: "log\n" } });
      state.apply({
        kind: "event",
        event: { type: "exited", at: 3, id: "bg-1", reason: "exited", exitCode: 0, signal: null },
      });
    };
    state.connect(() => () => {});
    replay();
    // Twice cut: each new uplink empties the room, then replays the job from its start.
    for (let cut = 0; cut < 2; cut++) {
      state.apply({ kind: "snapshot", snapshot: { uplink: true, jobs: [] } });
      replay();
    }
    expect(state.buffer("bg-1").text).toBe("log\n");
    expect(state.jobs.get("bg-1")).toMatchObject({ endedAt: 3, reason: "exited" });
  });

  it("holds the stream's state until it is shut, and forgets the room then", () => {
    const state = new CommandsState();
    let handlers: Parameters<Parameters<CommandsState["connect"]>[0]>[0] | null = null;
    let stopped = false;
    const stop = state.connect((h) => {
      handlers = h;
      return () => (stopped = true);
    });
    expect(state.connection).toBe("connecting");
    handlers!.onRetry?.();
    expect(state.connection).toBe("retrying");
    handlers!.onMessage(snapshot("x"));
    expect(state.connection).toBe("open");
    handlers!.onMessage({ kind: "dropped", count: 3 });
    expect(state.dropped).toBe(3);
    handlers!.onMessage({ kind: "done" });
    expect(state.done).toBe(true);
    stop();
    expect(stopped).toBe(true);
    expect(state.jobs.size).toBe(0);
    expect(state.buffer("bg-1").chars).toBe(0);
    expect(state.connection).toBe("closed");
  });
});
