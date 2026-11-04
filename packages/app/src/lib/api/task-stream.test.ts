import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureFreshSessionResult as ensureFreshSession,
  renewSessionResult as renewSession,
} from "$lib/utils/auth/auth";
import { subscribeTasks, type TaskStreamSubscription } from "./tasks";
import { HIDDEN_CLOSE_MS } from "./visible-stream";

vi.mock("$lib/utils/auth/auth", () => ({
  ensureFreshSessionResult: vi.fn(),
  renewSessionResult: vi.fn(),
}));

class Source extends EventTarget {
  static CLOSED = 2;
  static instances: Source[] = [];
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 2;
  });
  constructor(readonly url: string) {
    super();
    Source.instances.push(this);
  }
  send(event: string, data: unknown = {}) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
  fail(closed = true) {
    this.readyState = closed ? 2 : 0;
    this.dispatchEvent(new Event("error"));
  }
}
class Visibility extends EventTarget {
  visibilityState = "visible";
  change(state: string) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
const page = { tasks: [], hasMore: false, nextCursor: null };
const latest = () => Source.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);
let subscription: TaskStreamSubscription;
let visibility: Visibility;
const callbacks = () => ({
  onSync: vi.fn(),
  onTask: vi.fn(),
  onLeave: vi.fn(),
  onInterrupted: vi.fn(),
  onState: vi.fn(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  Source.instances = [];
  visibility = new Visibility();
  vi.stubGlobal("document", visibility);
  vi.stubGlobal("EventSource", Source);
  vi.mocked(ensureFreshSession).mockResolvedValue("ready");
  vi.mocked(renewSession).mockResolvedValue("ready");
});
afterEach(() => {
  subscription?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("task stream recovery", () => {
  it("waits for session freshness and only reports live after a valid sync", async () => {
    let resolve!: (value: "ready") => void;
    vi.mocked(ensureFreshSession).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const opts = callbacks();
    subscription = subscribeTasks({ q: "hello" }, opts);
    expect(Source.instances).toHaveLength(0);
    resolve("ready");
    await flush();
    expect(latest().url).toContain("q=hello");
    latest().send("open");
    latest().send("sync", {});
    expect(opts.onState).not.toHaveBeenCalledWith("live");
    latest().send("sync", page);
    expect(opts.onSync).toHaveBeenCalledWith(page);
    expect(opts.onState).toHaveBeenLastCalledWith("live");
  });

  it("renews a CLOSED stream before reconnecting, discarding old events", async () => {
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    const old = latest();
    old.send("sync", page);
    old.fail();
    expect(old.close).toHaveBeenCalled();
    expect(opts.onState).toHaveBeenLastCalledWith("retrying");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewSession).toHaveBeenCalledTimes(1);
    expect(ensureFreshSession).toHaveBeenCalledTimes(2);
    old.send("sync", page);
    expect(opts.onSync).toHaveBeenCalledTimes(1);
    latest().send("sync", page);
    expect(opts.onState).toHaveBeenLastCalledWith("live");
  });

  it("bounds stalled initial sync and transient errors, then permits manual retry", async () => {
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(opts.onState).toHaveBeenLastCalledWith("retrying");
    await vi.advanceTimersByTimeAsync(1_000);
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(2_000);
    latest().fail(false);
    await vi.advanceTimersByTimeAsync(4_000);
    latest().fail(false);
    expect(opts.onState).toHaveBeenLastCalledWith("failed");
    expect(Source.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(Source.instances).toHaveLength(4);
    subscription.retry();
    await flush();
    expect(Source.instances).toHaveLength(5);
    latest().send("sync", page);
    expect(opts.onState).toHaveBeenLastCalledWith("live");
  });

  it("detects silent stalls after sync, with heartbeats extending the watchdog", async () => {
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    latest().send("sync", page);
    await vi.advanceTimersByTimeAsync(50_000);
    latest().send("heartbeat");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(opts.onState).toHaveBeenLastCalledWith("live");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(opts.onState).toHaveBeenLastCalledWith("retrying");
  });

  it("clears health while hidden and gets a new sync on resume", async () => {
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    latest().send("sync", page);
    opts.onInterrupted.mockClear();
    visibility.change("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(opts.onInterrupted).toHaveBeenCalledOnce();
    expect(opts.onState).toHaveBeenLastCalledWith("suspended");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(Source.instances).toHaveLength(1);
    subscription.retry();
    expect(Source.instances).toHaveLength(1);
    visibility.change("visible");
    await flush();
    expect(Source.instances).toHaveLength(2);
    expect(opts.onState).toHaveBeenLastCalledWith("connecting");
    latest().send("sync", page);
    expect(opts.onState).toHaveBeenLastCalledWith("live");
  });

  it("ignores pending session completions after hiding or closing", async () => {
    let resolve!: (value: "ready") => void;
    vi.mocked(ensureFreshSession).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    visibility.change("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    resolve("ready");
    await flush();
    expect(Source.instances).toHaveLength(0);
    visibility.change("visible");
    await flush();
    latest().fail();
    subscription.close();
    const states = opts.onState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    subscription.retry();
    visibility.change("visible");
    expect(Source.instances).toHaveLength(1);
    expect(opts.onState).toHaveBeenCalledTimes(states);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requests sign-in only after explicit refresh credential rejection", async () => {
    vi.mocked(renewSession).mockResolvedValue("auth-required");
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    latest().fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opts.onState).toHaveBeenLastCalledWith("auth-required");
    expect(Source.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exhausts unavailable refresh retries without requesting sign-in", async () => {
    vi.mocked(renewSession).mockResolvedValue("unavailable");
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    latest().fail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opts.onState).toHaveBeenLastCalledWith("retrying");
    expect(opts.onState).not.toHaveBeenCalledWith("auth-required");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(opts.onState).toHaveBeenLastCalledWith("failed");
    expect(opts.onState).not.toHaveBeenCalledWith("auth-required");
    expect(Source.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("malformed sync frames after health cannot keep the stream healthy indefinitely", async () => {
    const opts = callbacks();
    subscription = subscribeTasks({}, opts);
    await flush();
    latest().send("sync", page);
    await vi.advanceTimersByTimeAsync(50_000);
    latest().send("sync", {});
    await vi.advanceTimersByTimeAsync(25_000);
    expect(opts.onState).toHaveBeenLastCalledWith("retrying");
    expect(opts.onSync).toHaveBeenCalledOnce();
  });
});
