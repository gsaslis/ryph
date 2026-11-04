import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_REFRESH_MS } from "$lib/utils/run-refresh";
import {
  MOVING_REFRESH_MS,
  refreshCadence,
  type RefreshNeeds,
  RefreshScheduler,
  RUN_GRANT_REFRESH_MS,
  STARTING_REFRESH_MS,
  STREAM_LOST_REFRESH_MS,
} from "./refresh";

// The task page used to keep an interval per reason it had to re-read itself, each re-running the
// whole load on its own phase. These pin that the one clock that replaced them asks no less often
// than the fastest of them did, in every state the page can be in, never runs two loads at once
// while loads land, and — like those intervals — never lets one load that hangs stop it.

const at = (over: Partial<RefreshNeeds>): RefreshNeeds => ({
  hasRun: true,
  terminal: false,
  waitingOnBuild: false,
  streamLost: false,
  starting: false,
  moving: false,
  ...over,
});

describe("how stale the task page's load may get", () => {
  it("renews the grants of a finished run, and nothing more", () => {
    expect(refreshCadence(at({ terminal: true }))).toBe(RUN_GRANT_REFRESH_MS);
  });

  it("keeps the backstop on a live run whose tail holds", () => {
    expect(refreshCadence(at({}))).toBe(RUN_REFRESH_MS);
  });

  it("reads on the stream's beat once the tail is lost", () => {
    expect(refreshCadence(at({ streamLost: true }))).toBe(STREAM_LOST_REFRESH_MS);
    // A lost tail of a run that is over is no reason at all: the run is not moving.
    expect(refreshCadence(at({ streamLost: true, terminal: true }))).toBe(RUN_GRANT_REFRESH_MS);
  });

  it("watches a pending build closely, and a start nothing else follows", () => {
    expect(refreshCadence(at({ waitingOnBuild: true }))).toBe(STARTING_REFRESH_MS);
    expect(refreshCadence(at({ starting: true }))).toBe(STARTING_REFRESH_MS);
    expect(refreshCadence(at({ waitingOnBuild: true, terminal: true }))).toBe(
      RUN_GRANT_REFRESH_MS,
    );
  });

  it("asks for a run not minted yet while it is starting, and not otherwise", () => {
    expect(refreshCadence(at({ hasRun: false, starting: true }))).toBe(STARTING_REFRESH_MS);
    expect(refreshCadence(at({ hasRun: false }))).toBeNull();
  });

  it("follows what moves on its own, on any run, ended or not", () => {
    expect(refreshCadence(at({ moving: true, terminal: true }))).toBe(MOVING_REFRESH_MS);
    expect(refreshCadence(at({ moving: true }))).toBe(MOVING_REFRESH_MS);
  });

  it("takes the shortest of every reason it has", () => {
    expect(refreshCadence(at({ moving: true, waitingOnBuild: true }))).toBe(STARTING_REFRESH_MS);
  });
});

describe("the task page's refresh clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A load that takes `ms` to land, counting how many start. */
  function loads(ms = 0) {
    const started: number[] = [];
    const reload = vi.fn(() => {
      started.push(Date.now());
      return new Promise<void>((resolve) => setTimeout(resolve, ms));
    });
    return { reload, started };
  }

  it("reads on its cadence, counted from when the last load started", async () => {
    const { reload, started } = loads(100);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual([t0 + 1_000]);
    // The next one counts from when that one started, as an interval's ticks did.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual([t0 + 1_000, t0 + 2_000]);
    clock.dispose();
  });

  it("keeps a slow load's period at its cadence", async () => {
    const { reload, started } = loads(2_000);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 3_000;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(started).toEqual([t0 + 3_000, t0 + 6_000, t0 + 9_000]);
    clock.dispose();
  });

  it("reads at once when a shorter cadence is already overdue", async () => {
    const { reload, started } = loads();
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 15_000;
    await vi.advanceTimersByTimeAsync(10_000);
    clock.cadence = 3_000;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([t0 + 10_000]);
    clock.dispose();
  });

  it("stops reading when nothing needs it", async () => {
    const { reload } = loads();
    const clock = new RefreshScheduler(reload);
    clock.cadence = 1_000;
    clock.cadence = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();
    clock.dispose();
  });

  it("never runs two loads at once, and owes one to every request made during one", async () => {
    const { reload, started } = loads(500);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    const first = clock.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual([t0]);
    // Three cues while the first is in flight: one more load, shared by all three.
    const owed = [clock.request(), clock.request(), clock.request()];
    let settled = 0;
    for (const p of owed) void p.then(() => settled++);
    await vi.advanceTimersByTimeAsync(400);
    await first;
    expect(started).toEqual([t0, t0 + 500]);
    expect(settled).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(3);
    expect(started).toHaveLength(2);
    // Nothing in flight any more: the next request starts at once.
    void clock.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([t0, t0 + 500, t0 + 1_000]);
    clock.dispose();
  });

  it("starts an action's load at once, and resolves when that one lands", async () => {
    const { reload, started } = loads(500);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    void clock.request();
    await vi.advanceTimersByTimeAsync(100);
    let landed = false;
    const action = clock.now().then(() => (landed = true));
    await vi.advanceTimersByTimeAsync(0);
    // Not after the load in flight: beside it, as `invalidate` would.
    expect(started).toEqual([t0, t0 + 100]);
    await vi.advanceTimersByTimeAsync(500);
    await action;
    expect(landed).toBe(true);
    expect(started).toHaveLength(2);
    clock.dispose();
  });

  it("lets an action's load stand for the cues owed one, and owes one to the cues during it", async () => {
    const { reload, started } = loads(500);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    void clock.request();
    await vi.advanceTimersByTimeAsync(100);
    let cueSettled = false;
    void clock.request().then(() => (cueSettled = true));
    void clock.now();
    await vi.advanceTimersByTimeAsync(500);
    // The cue made before the action is answered by the action's load, and no other.
    expect(cueSettled).toBe(true);
    expect(started).toEqual([t0, t0 + 100]);

    void clock.now();
    await vi.advanceTimersByTimeAsync(100);
    void clock.request();
    await vi.advanceTimersByTimeAsync(400);
    // A cue during the action's load is owed one after it, as during any other.
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([t0, t0 + 100, t0 + 600, t0 + 1_100]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toHaveLength(4);
    clock.dispose();
  });

  it("counts its cadence from an action's load", async () => {
    const { reload, started } = loads(100);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 1_000;
    await vi.advanceTimersByTimeAsync(600);
    void clock.now();
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual([t0 + 600]);
    // Started at 600: the next tick is a full cadence after it, not the 1s the clock first aimed at.
    await vi.advanceTimersByTimeAsync(899);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([t0 + 600, t0 + 1_600]);
    clock.dispose();
  });

  it("adds no load while one lands inside its cadence", async () => {
    const { reload, started } = loads(900);
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 1_000;
    void clock.request();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toEqual([t0, t0 + 1_000, t0 + 2_000, t0 + 3_000]);
    clock.dispose();
  });

  /** A load whose first request never settles, as one on a connection left half-open, and then lands in `ms`. */
  function hangsOnce(ms = 100) {
    const started: number[] = [];
    const reload = vi.fn(() => {
      started.push(Date.now());
      if (started.length === 1) return new Promise<void>(() => {});
      return new Promise<void>((resolve) => setTimeout(resolve, ms));
    });
    return { reload, started };
  }

  it("supersedes a load that never lands once its cadence is up", async () => {
    const { reload, started } = hangsOnce();
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 3_000;
    void clock.request();
    // A cue while it hangs is owed a load, and the one that supersedes it answers that.
    await vi.advanceTimersByTimeAsync(500);
    let cueSettled = false;
    void clock.request().then(() => (cueSettled = true));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(started).toEqual([t0, t0 + 3_000]);
    await vi.advanceTimersByTimeAsync(100);
    expect(cueSettled).toBe(true);
    // And the clock goes on from there.
    await vi.advanceTimersByTimeAsync(2_900);
    expect(started).toEqual([t0, t0 + 3_000, t0 + 6_000]);
    clock.dispose();
  });

  it("keeps its clock and its cues going once an action lands past a load that never does", async () => {
    const { reload, started } = hangsOnce();
    const clock = new RefreshScheduler(reload);
    const t0 = Date.now();
    clock.cadence = 3_000;
    void clock.request();
    await vi.advanceTimersByTimeAsync(500);
    let landed = false;
    void clock.now().then(() => (landed = true));
    await vi.advanceTimersByTimeAsync(50);
    // A cue while the action's load is in flight — the live tail saying the run is done.
    let cueSettled = false;
    void clock.request().then(() => (cueSettled = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(landed).toBe(true);
    // The hung load is forgotten: the cue is served as soon as the action's load lands.
    expect(started).toEqual([t0, t0 + 500, t0 + 600]);
    await vi.advanceTimersByTimeAsync(100);
    expect(cueSettled).toBe(true);
    // And the clock counts on from the last load that started.
    await vi.advanceTimersByTimeAsync(2_900);
    expect(started).toEqual([t0, t0 + 500, t0 + 600, t0 + 3_600]);
    // A cue with nothing in flight starts at once, hung load or not.
    await vi.advanceTimersByTimeAsync(100);
    void clock.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([t0, t0 + 500, t0 + 600, t0 + 3_600, t0 + 3_700]);
    clock.dispose();
  });

  it("keeps its clock going after a load that failed", async () => {
    let calls = 0;
    const clock = new RefreshScheduler(() => {
      calls++;
      return Promise.reject(new Error("offline"));
    });
    clock.cadence = 1_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(3);
    await expect(clock.request()).rejects.toThrow("offline");
    clock.dispose();
  });

  it("reads nothing once disposed, and lets an owed request go", async () => {
    const { reload } = loads(500);
    const clock = new RefreshScheduler(reload);
    clock.cadence = 1_000;
    void clock.request();
    const owed = clock.request();
    clock.dispose();
    await owed;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
