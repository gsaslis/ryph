import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunUsageState } from "$lib/api/model-usage";
import type { HistoryEvent } from "$lib/api/types";
import type { RunHistory } from "$lib/components/run-history/run-history.svelte";

// The live tail is the one thing here with a socket behind it: the fake hands each subscription's
// callbacks back to the test, which plays the historian.
type Callbacks = {
  after?: number;
  grant?: string | null;
  onEvent(event: HistoryEvent): void;
  onDone?(): void;
  onError?(): void;
};
const subscriptions: { runId: string; opts: Callbacks; closed: boolean }[] = [];
vi.mock("$lib/api/history", () => ({
  subscribeRunEvents: (runId: string, opts: Callbacks) => {
    const sub = { runId, opts, closed: false };
    subscriptions.push(sub);
    return { close: () => (sub.closed = true) };
  },
}));
const usageReads: {
  runId: string;
  grant: string | null | undefined;
  resolve(value: RunUsageState): void;
}[] = [];
vi.mock("$lib/api/model-usage", () => ({
  getRunUsageState: (_f: unknown, runId: string, grant?: string | null) => {
    const answer = Promise.withResolvers<RunUsageState>();
    usageReads.push({ runId, grant, resolve: answer.resolve });
    return answer.promise;
  },
}));

const { CUE_SETTLE_MS, RunTail } = await import("./run-tail.svelte");
const { RunBill, USAGE_POLL_MS } = await import("./run-bill.svelte");

const AT = "2026-09-21T09:00:00.000Z";
const event = (seq: number, over: Partial<HistoryEvent> = {}): HistoryEvent => ({
  runId: "run-1",
  lane: "",
  seq,
  at: AT,
  voice: "transcript",
  kind: "assistant",
  level: null,
  text: `event ${seq}`,
  payload: null,
  ...over,
});

/** Just enough of a history for the tail: where it ends, and what it was handed. */
function heldHistory(lastSeq: number) {
  const absorbed: number[] = [];
  const history = {
    lastSeq,
    absorb: (e: HistoryEvent) => absorbed.push(e.seq),
  } as unknown as RunHistory;
  return { history, absorbed };
}

beforeEach(() => {
  vi.useFakeTimers();
  subscriptions.length = 0;
  usageReads.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the run's live tail", () => {
  it("resumes from the history's end, and hands it every new event once", () => {
    const tail = new RunTail();
    const { history, absorbed } = heldHistory(9);
    const close = tail.connect("run-1", history, "g", { behind: vi.fn(), done: vi.fn() });
    const [sub] = subscriptions;
    expect(sub.opts.after).toBe(9);
    expect(sub.opts.grant).toBe("g");

    sub.opts.onEvent(event(9));
    sub.opts.onEvent(event(10));
    sub.opts.onEvent(event(10));
    sub.opts.onEvent(event(11));
    expect(absorbed).toEqual([10, 11]);

    close();
    expect(sub.closed).toBe(true);
  });

  it("asks for the load once per burst of cues, after it settles", () => {
    const tail = new RunTail();
    const behind = vi.fn();
    tail.connect("run-1", heldHistory(-1).history, null, { behind, done: vi.fn() });
    const [sub] = subscriptions;
    const inbound = (seq: number) => event(seq, { kind: "inbound", payload: { seq } });
    sub.opts.onEvent(inbound(0));
    sub.opts.onEvent(inbound(1));
    sub.opts.onEvent(event(2)); // not a cue
    expect(behind).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CUE_SETTLE_MS);
    expect(behind).toHaveBeenCalledTimes(1);
    sub.opts.onEvent(inbound(3));
    vi.advanceTimersByTime(CUE_SETTLE_MS);
    expect(behind).toHaveBeenCalledTimes(2);
  });

  it("drops a pending cue when it is closed", () => {
    const tail = new RunTail();
    const behind = vi.fn();
    const close = tail.connect("run-1", heldHistory(-1).history, null, { behind, done: vi.fn() });
    subscriptions[0].opts.onEvent(event(0, { kind: "inbound", payload: { seq: 0 } }));
    close();
    vi.advanceTimersByTime(CUE_SETTLE_MS);
    expect(behind).not.toHaveBeenCalled();
  });

  it("says it is lost when the stream fails for good", () => {
    const tail = new RunTail();
    const close = tail.connect("run-1", heldHistory(-1).history, null, {
      behind: vi.fn(),
      done: vi.fn(),
    });
    subscriptions[0].opts.onError!();
    expect(tail.lost).toBe(true);
    // Closed — the run ended, or another one opened — it is no longer anyone's fallback.
    close();
    expect(tail.lost).toBe(false);
  });

  it("asks for the final load when the run's stream is done", () => {
    const tail = new RunTail();
    const done = vi.fn();
    tail.connect("run-1", heldHistory(-1).history, null, { behind: vi.fn(), done });
    subscriptions[0].opts.onDone!();
    expect(done).toHaveBeenCalledTimes(1);
    expect(tail.lost).toBe(false);
  });
});

const bill = (requests: number): RunUsageState => ({
  usage: { totals: { requests } } as unknown as RunUsageState["usage"],
  unavailable: false,
});
const requestsOf = (state: RunUsageState) =>
  (state.usage as unknown as { totals: { requests: number } } | null)?.totals.requests ?? null;
const answer = (i: number, value: RunUsageState) => usageReads[i].resolve(value);

describe("the run's bill", () => {
  it("shows the newest read asked for, whichever answers first", async () => {
    let runId: string | null = "run-1";
    const held = new RunBill(() => runId);
    const older = Promise.withResolvers<RunUsageState>();
    const newer = Promise.withResolvers<RunUsageState>();
    held.take("run-1", older.promise);
    held.take("run-1", newer.promise);
    newer.resolve(bill(2));
    await vi.advanceTimersByTimeAsync(0);
    older.resolve(bill(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(requestsOf(held.current)).toBe(2);
    // Never another run's.
    runId = "run-2";
    expect(held.current).toEqual({ usage: null, unavailable: false });
  });

  it("is read on its own clock while polled, and says so for the load", async () => {
    let grant = "g1";
    const held = new RunBill(() => "run-1");
    const stop = held.poll("run-1", () => grant);
    expect(held.polls("run-1")).toBe(true);
    expect(held.polls("run-2")).toBe(false);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    grant = "g2";
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(usageReads.map((r) => r.grant)).toEqual(["g1", "g2"]);
    answer(1, bill(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(requestsOf(held.current)).toBe(4);
    stop();
    expect(held.polls("run-1")).toBe(false);
  });

  it("throws away a poll that lands after it stopped, so the concluding load has the last word", async () => {
    const held = new RunBill(() => "run-1");
    const stop = held.poll("run-1", () => null);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    stop();
    const final = Promise.withResolvers<RunUsageState>();
    held.take("run-1", final.promise);
    final.resolve(bill(9));
    await vi.advanceTimersByTimeAsync(0);
    answer(0, bill(7));
    await vi.advanceTimersByTimeAsync(0);
    expect(requestsOf(held.current)).toBe(9);
  });

  it("keeps what it had when a read fails", async () => {
    const held = new RunBill(() => "run-1");
    held.take("run-1", Promise.resolve(bill(3)));
    await vi.advanceTimersByTimeAsync(0);
    held.take("run-1", Promise.reject(new Error("offline")));
    await vi.advanceTimersByTimeAsync(0);
    expect(requestsOf(held.current)).toBe(3);
  });
});
