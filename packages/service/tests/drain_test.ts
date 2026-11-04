// The drain's job is ordering and bounds. Both signal registration and `process.exit` are injected,
// so these run the real sequence in-process without a socket or a process to kill.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { type DrainOptions, installDrain } from "../src/drain.ts";

// `process.exit` never returns; the seam here records the code and does, so a test can go on to
// assert what the drain did on its way there.
const recorder = (into: number[]) =>
  ((code: number) => void into.push(code)) as (n: number) => never;

function harness(overrides: Partial<DrainOptions> = {}) {
  const events: string[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const codes: number[] = [];
  installDrain({
    servers: [],
    log: {
      info: (message) => events.push(`log:${message}`),
      warn: (message) => events.push(`log:${message}`),
    },
    exit: recorder(codes),
    addSignalListener: (signal, handler) => handlers.set(signal, handler),
    ...overrides,
  });
  /** Fires a signal and lets the drain it starts run to its exit. */
  const signal = async (sig: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    handlers.get(sig)!();
    // The handler starts the drain without awaiting it; give it room to reach the exit.
    for (let i = 0; i < 200 && codes.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { events, signal, exited: () => codes[0] ?? null, handlers };
}

test("registers SIGINT and SIGTERM by default", () => {
  const { handlers } = harness();
  assertEquals([...handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
});

test("goes unready BEFORE the listeners close, and closes resources after", async () => {
  const order: string[] = [];
  const { signal, exited } = harness({
    beginDrain: () => order.push("unready"),
    servers: [{
      shutdown: () => {
        order.push("shutdown");
        return Promise.resolve();
      },
    }],
    close: () => {
      order.push("close");
    },
  });
  await signal();
  // Unready first or the balancer keeps routing into a closing listener; resources last or
  // in-flight requests lose the database out from under them.
  assertEquals(order, ["unready", "shutdown", "close"]);
  assertEquals(exited(), 0);
});

test("drains every listener, ignoring the optional ones that are null", async () => {
  const stopped: string[] = [];
  const server = (name: string) => ({
    shutdown: () => {
      stopped.push(name);
      return Promise.resolve();
    },
  });
  const { signal } = harness({ servers: [server("control"), null, server("data"), undefined] });
  await signal();
  assertEquals(stopped.sort(), ["control", "data"]);
});

test("a listener that never drains hits the deadline instead of hanging", async () => {
  // The live case: an open SSE tail means `shutdown()` never resolves.
  const { signal, events, exited } = harness({
    servers: [{ shutdown: () => new Promise(() => {}) }],
    deadlineMs: 30,
    close: () => {
      events.push("closed");
    },
  });
  await signal();
  assert(events.includes("log:drain.deadline_exceeded"), events.join(","));
  // Past the deadline the rest of the sequence still runs — that is the whole point of bounding
  // it rather than letting the platform SIGKILL us mid-shutdown.
  assert(events.includes("closed"));
  // And the exit stays clean: one viewer watching a transcript must not fail a deploy.
  assertEquals(exited(), 0);
});

test("a listener that throws does not stop the others or the close", async () => {
  const stopped: string[] = [];
  const { signal, events, exited } = harness({
    servers: [
      { shutdown: () => Promise.reject(new Error("already closed")) },
      {
        shutdown: () => {
          stopped.push("second");
          return Promise.resolve();
        },
      },
    ],
    close: () => {
      events.push("closed");
    },
  });
  await signal();
  assertEquals(stopped, ["second"]);
  assert(events.includes("closed"));
  assertEquals(exited(), 0);
});

test("a failing close is logged, not thrown, and the process still exits", async () => {
  const { signal, events, exited } = harness({
    close: () => Promise.reject(new Error("connection already terminated")),
  });
  await signal();
  assert(events.includes("log:drain.close_failed"), events.join(","));
  assertEquals(exited(), 0);
});

/** A drain driven signal by signal, recording what it logged and how it exited. */
function manual(overrides: Partial<DrainOptions> = {}) {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const codes: number[] = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  installDrain({
    servers: [],
    log: {
      info: (message, fields) => logs.push({ message, fields }),
      warn: (message, fields) => logs.push({ message, fields }),
    },
    exit: recorder(codes),
    addSignalListener: (signal, handler) => handlers.set(signal, handler),
    ...overrides,
  });
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    for (let i = 0; i < 200 && codes.length === 0; i++) await tick();
  };
  return {
    fire: (sig: NodeJS.Signals = "SIGINT") => handlers.get(sig)!(),
    codes,
    logs,
    messages: () => logs.map((l) => l.message),
    tick,
    settle,
  };
}

// Timers only ever land late on a busy runner, never meaningfully early, so the timing tests
// record when each stream ended and assert lower bounds and gaps instead of sampling at fixed
// sleeps. `SLACK` covers a timer that rounds a millisecond early.
const SLACK = 2;

/** Records which streams ended and when, counted from `start()`. */
function endings() {
  let t0 = 0;
  const ended: string[] = [];
  const at = new Map<string, number>();
  return {
    ended,
    at: (name: string) => at.get(name)!,
    start: () => void (t0 = performance.now()),
    end: (name: string) => () => {
      ended.push(name);
      at.set(name, performance.now() - t0);
    },
    /** Waits for `count` streams to have ended, or gives up well after any timer here is due. */
    until: async (count: number) => {
      const giveUp = performance.now() + 5_000;
      while (ended.length < count && performance.now() < giveUp) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

test("keep-running leaves everything serving and a later stop asks again", async () => {
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const d = manual({
    beforeDrain: (_sig, interrupted) => {
      signals.push(interrupted);
      return Promise.resolve(signals.length === 1 ? "keep-running" : undefined);
    },
    beginDrain: () => events.push("unready"),
    servers: [{
      shutdown: () => {
        events.push("shutdown");
        return Promise.resolve();
      },
    }],
    close: () => {
      events.push("close");
    },
  });
  d.fire();
  await d.tick();
  assertEquals(events, []);
  assertEquals(d.codes, []);
  d.fire();
  await d.settle();
  assertEquals(signals.length, 2);
  assert(signals[0] !== signals[1]);
  assertEquals(events, ["unready", "shutdown", "close"]);
  assertEquals(d.codes, [0]);
});

test("a later stop can still be interrupted after cancelling shutdown", async () => {
  let attempts = 0;
  let interrupted: AbortSignal | undefined;
  const d = manual({
    beforeDrain: (_sig, signal) => {
      interrupted = signal;
      return ++attempts === 1 ? Promise.resolve("keep-running") : new Promise(() => {});
    },
  });
  d.fire();
  await d.tick();
  d.fire();
  assertEquals(attempts, 2);
  assertEquals(interrupted?.aborted, false);
  d.fire();
  await d.settle();
  assertEquals(interrupted?.aborted, true);
  assertEquals(d.codes, [0]);
});

test("an interrupt overrides keep-running even when the hook resolves first", async () => {
  let answer!: (value: "keep-running") => void;
  const d = manual({
    beforeDrain: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  d.fire();
  answer("keep-running");
  d.fire();
  await d.settle();
  assertEquals(d.codes, [0]);
});

test("a second signal skips the waiting but still closes, and exits clean", async () => {
  let closed = false;
  const d = manual({
    servers: [{ name: "control plane", server: { shutdown: () => new Promise(() => {}) } }],
    deadlineMs: 60_000,
    close: () => {
      closed = true;
    },
  });
  d.fire(); // starts a drain that would wait a minute
  await d.tick();
  d.fire(); // the operator has given up on in-flight work, not on the database
  await d.settle();
  assert(closed, "the second signal skipped the close");
  assertEquals(d.codes, [0]);
  const skipped = d.logs.find((l) => l.message === "drain.wait_skipped");
  assertEquals(skipped?.fields?.open, [{ name: "control plane" }]);
});

test("after a second signal the close is bounded, and a hung one exits non-zero", async () => {
  const d = manual({
    closeDeadlineMs: 20,
    close: () => new Promise(() => {}),
  });
  d.fire();
  await d.tick();
  d.fire();
  await d.settle();
  assert(d.messages().includes("drain.close_timed_out"), d.messages().join(","));
  assertEquals(d.codes, [130]);
});

test("without a second signal the close is not bounded", async () => {
  let release: () => void = () => {};
  const d = manual({
    closeDeadlineMs: 5,
    close: () => new Promise<void>((r) => (release = r)),
  });
  d.fire("SIGTERM");
  await d.tick(40);
  assertEquals(d.codes, []);
  release();
  await d.settle();
  assertEquals(d.codes, [0]);
});

test("a third signal exits on the spot, with the signal's exit code", async () => {
  const d = manual({
    servers: [{ shutdown: () => new Promise(() => {}) }],
    deadlineMs: 60_000,
    close: () => new Promise(() => {}), // a close that hangs too
  });
  d.fire();
  await d.tick();
  d.fire();
  await d.tick();
  d.fire();
  assertEquals(d.codes, [130]); // 128 + SIGINT
  assert(d.messages().includes("drain.forced"));
});

test("streams end once the listeners stop accepting, after going unready", async () => {
  const order: string[] = [];
  const d = manual({
    beginDrain: () => order.push("unready"),
    servers: [{
      name: "control plane",
      server: {
        shutdown: () => {
          order.push("shutdown");
          return Promise.resolve();
        },
      },
      streams: { end: () => order.push("streams"), endTails: () => {}, open: 0, inFlight: 0 },
    }],
  });
  d.fire();
  await d.settle();
  assertEquals(order, ["unready", "shutdown", "streams"]);
});

test("a listener's streams can run out a grace first, cut short by a second signal", async () => {
  const e = endings();
  const tracker = (name: string) => ({
    end: e.end(name),
    endTails: () => {},
    open: 0,
    inFlight: 0,
  });
  const hang = { shutdown: () => new Promise<void>(() => {}) };
  const d = manual({
    deadlineMs: 60_000,
    servers: [
      { name: "tails", server: hang, streams: tracker("tails") },
      { name: "work", server: hang, streams: tracker("work"), streamsGraceMs: 30 },
      { name: "long work", server: hang, streams: tracker("long work"), streamsGraceMs: 60_000 },
    ],
  });
  e.start();
  d.fire();
  // With no pause, the drain reaches the streams before its first await.
  assertEquals(e.ended, ["tails"]);
  await e.until(2);
  assertEquals(e.ended, ["tails", "work"]);
  assert(e.at("work") >= 30 - SLACK, `work ended at ${e.at("work")}ms`);
  d.fire(); // stop waiting: whatever is still in its grace ends now
  await d.settle();
  assert(e.ended.includes("long work"), e.ended.join(","));
  assertEquals(d.codes, [0]);
});

test("a stream grace is timed from the deadline's start, after the pre-stop pause", async () => {
  // With a pause as long as the grace, a grace timed from the signal would cut the work the
  // moment the listeners begin to close.
  const e = endings();
  const tracker = (name: string) => ({
    end: e.end(name),
    endTails: () => {},
    open: 0,
    inFlight: 0,
  });
  const hang = { shutdown: () => new Promise<void>(() => {}) };
  const d = manual({
    deadlineMs: 60_000,
    preStopMs: 60,
    servers: [
      { name: "tails", server: hang, streams: tracker("tails") },
      { name: "work", server: hang, streams: tracker("work"), streamsGraceMs: 60 },
    ],
  });
  e.start();
  d.fire();
  await e.until(2);
  assertEquals(e.ended, ["tails", "work"]);
  // Nothing ends during the pause: the balancer may still route here.
  assert(e.at("tails") >= 60 - SLACK, `tails ended at ${e.at("tails")}ms`);
  // The grace runs from where the tails ended, not from the signal.
  const gap = e.at("work") - e.at("tails");
  assert(gap >= 60 - SLACK, `work ended ${gap}ms after the tails`);
  d.fire();
  await d.settle();
  assertEquals(d.codes, [0]);
});

test("a graced listener's tails end after the pause, and only its work waits out the grace", async () => {
  const e = endings();
  const hang = { shutdown: () => new Promise<void>(() => {}) };
  const d = manual({
    deadlineMs: 60_000,
    preStopMs: 30,
    servers: [{
      name: "gateway",
      server: hang,
      streams: { end: e.end("all"), endTails: e.end("tails"), open: 0, inFlight: 0 },
      streamsGraceMs: 30,
    }],
  });
  e.start();
  d.fire();
  await e.until(2);
  assertEquals(e.ended, ["tails", "all"]);
  assert(e.at("tails") >= 30 - SLACK, `tails ended at ${e.at("tails")}ms`); // the pause comes first
  // Then its tails at once, like any other listener's, and the rest only after the grace.
  const gap = e.at("all") - e.at("tails");
  assert(gap >= 30 - SLACK, `the rest ended ${gap}ms after the tails`);
  d.fire();
  await d.settle();
  assertEquals(d.codes, [0]);
});

test("a second signal during the pre-stop pause ends graced streams at once", async () => {
  const ended: string[] = [];
  const d = manual({
    deadlineMs: 60_000,
    preStopMs: 60_000,
    servers: [{
      name: "work",
      server: { shutdown: () => new Promise<void>(() => {}) },
      streams: { end: () => ended.push("work"), endTails: () => {}, open: 0, inFlight: 0 },
      streamsGraceMs: 50_000,
    }],
  });
  d.fire();
  await d.tick();
  assertEquals(ended, []);
  d.fire();
  await d.settle();
  assertEquals(ended, ["work"]);
  assertEquals(d.codes, [0]);
});

test("the deadline names each listener still open, with its requests and streams", async () => {
  const d = manual({
    deadlineMs: 20,
    servers: [
      { name: "control plane", server: { shutdown: () => Promise.resolve() } },
      {
        name: "model proxy",
        server: { shutdown: () => new Promise(() => {}) },
        streams: { end: () => {}, endTails: () => {}, open: 1, inFlight: 2 },
      },
      { shutdown: () => new Promise(() => {}) },
    ],
  });
  d.fire();
  await d.settle();
  const line = d.logs.find((l) => l.message === "drain.deadline_exceeded");
  assertEquals(line?.fields?.open, [
    { name: "model proxy", inFlight: 2, streams: 1 },
    { name: "listener 2" },
  ]);
  assertEquals(d.codes, [0]);
});

test("beforeDrain runs first, with every listener still up, and the drain waits for it", async () => {
  const order: string[] = [];
  const { signal, exited } = harness({
    beforeDrain: async (sig) => {
      order.push(`before:${sig}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push("before-done");
    },
    beginDrain: () => order.push("unready"),
    servers: [{
      shutdown: () => {
        order.push("shutdown");
        return Promise.resolve();
      },
    }],
  });
  await signal("SIGINT");
  assertEquals(order, ["before:SIGINT", "before-done", "unready", "shutdown"]);
  assertEquals(exited(), 0);
});

test("a second signal during beforeDrain stops the wait, but still drains cleanly", async () => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const codes: number[] = [];
  let aborted = false;
  let closed = false;
  installDrain({
    servers: [],
    // A prompt nobody answers.
    beforeDrain: (_sig, interrupted) => {
      interrupted.addEventListener("abort", () => (aborted = true));
      return new Promise(() => {});
    },
    close: () => {
      closed = true;
    },
    log: { info: () => {}, warn: () => {} },
    exit: recorder(codes),
    addSignalListener: (signal, handler) => handlers.set(signal, handler),
  });
  handlers.get("SIGINT")!();
  await new Promise((r) => setTimeout(r, 5));
  handlers.get("SIGINT")!();
  for (let i = 0; i < 200 && codes.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert(aborted);
  // The database still closed: the second ^C gave up on the question, not on the shutdown.
  assert(closed);
  assertEquals(codes, [0]);
});

test("from beforeDrain: stop asking, then stop waiting, then exit", async () => {
  let closed = false;
  const d = manual({
    servers: [{ shutdown: () => new Promise(() => {}) }],
    deadlineMs: 60_000,
    beforeDrain: () => new Promise(() => {}),
    close: () => new Promise(() => (closed = true)), // reached, and hangs
  });
  d.fire();
  d.fire(); // stop asking
  await d.tick();
  assertEquals(d.codes, []);
  d.fire(); // stop waiting: on to the close
  await d.tick();
  assert(closed);
  assertEquals(d.codes, []);
  d.fire();
  assertEquals(d.codes, [130]);
});

test("a failing beforeDrain is logged and the drain goes ahead", async () => {
  const { signal, events, exited } = harness({
    beforeDrain: () => Promise.reject(new Error("the terminal went away")),
    close: () => {
      events.push("closed");
    },
  });
  await signal();
  assert(events.includes("log:drain.before_failed"), events.join(","));
  assert(events.includes("closed"));
  assertEquals(exited(), 0);
});

test("preStopMs holds the listeners open, unready, before closing them", async () => {
  let unreadyAt = 0;
  let shutdownAt = 0;
  const { signal } = harness({
    preStopMs: 40,
    beginDrain: () => (unreadyAt = Date.now()),
    servers: [{
      shutdown: () => {
        shutdownAt = Date.now();
        return Promise.resolve();
      },
    }],
  });
  await signal();
  // The window a load balancer needs to notice this replica left the rotation.
  assert(shutdownAt - unreadyAt >= 35, `only waited ${shutdownAt - unreadyAt}ms`);
});
