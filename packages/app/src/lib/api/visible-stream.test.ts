import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandsLiveSource, type CommandsMessage } from "./background";
import { type LiveMessage, liveStreamSource } from "./browser-live";
import { subscribeRunEvents, subscribeRunLanes } from "./history";
import { subscribeTasks } from "./tasks";
import { HIDDEN_CLOSE_MS, whileVisible } from "./visible-stream";

// Streams are held only while the tab can be seen: closed once it has been hidden a while, and
// reopened, resynced, when it is back.

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  closed = false;
  readonly #listeners = new Map<string, ((e: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.made.push(this);
  }

  addEventListener(type: string, listener: (e: Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

const open = () => FakeEventSource.made.filter((s) => !s.closed);
const latest = () => FakeEventSource.made.at(-1)!;

let page: EventTarget & { visibilityState: DocumentVisibilityState };
function show(state: DocumentVisibilityState): void {
  page.visibilityState = state;
  page.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.made = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  vi.stubGlobal("document", page);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("whileVisible", () => {
  it("closes after the tab has been hidden a while, and reopens once when it is back", () => {
    const close = vi.fn();
    const opener = vi.fn(() => close);
    const stop = whileVisible(opener);
    expect(opener).toHaveBeenCalledTimes(1);

    show("hidden");
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS - 1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);

    show("visible");
    expect(opener).toHaveBeenCalledTimes(2);
    // A second visible event (focus churn) opens nothing more.
    show("visible");
    expect(opener).toHaveBeenCalledTimes(2);

    stop();
    expect(close).toHaveBeenCalledTimes(2);
    show("hidden");
    show("visible");
    expect(opener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the stream through a quick switch away and back", () => {
    const close = vi.fn();
    const opener = vi.fn(() => close);
    whileVisible(opener);
    show("hidden");
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS / 2);
    show("visible");
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("lets a tab opened in the background go after the same delay", () => {
    page.visibilityState = "hidden";
    const close = vi.fn();
    whileVisible(() => close);
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("holds the stream open where there is no document", () => {
    vi.stubGlobal("document", undefined);
    const close = vi.fn();
    const stop = whileVisible(() => close);
    vi.advanceTimersByTime(HIDDEN_CLOSE_MS * 2);
    expect(close).not.toHaveBeenCalled();
    stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

/** Hidden long enough for the streams to go, then back. */
function awayAndBack(): void {
  show("hidden");
  vi.advanceTimersByTime(HIDDEN_CLOSE_MS);
  expect(open()).toHaveLength(0);
  show("visible");
}

const historyEvent = (seq: number) => ({
  runId: "run-1",
  lane: "",
  seq,
  at: "2026-07-16T12:00:00.000Z",
  voice: "transcript",
  kind: "assistant",
  level: null,
  text: `event ${seq}`,
  payload: null,
});

describe("the streams", () => {
  it("the task list reopens with its filters and takes the snapshot it resends", async () => {
    const onSync = vi.fn();
    const sub = subscribeTasks({}, { onSync, onTask: vi.fn(), onLeave: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    const first = latest();
    awayAndBack();
    await vi.advanceTimersByTimeAsync(0);
    expect(open()).toEqual([latest()]);
    expect(latest()).not.toBe(first);
    expect(latest().url).toBe(first.url);
    latest().emit("sync", { tasks: [], nextCursor: null, hasMore: false });
    expect(onSync).toHaveBeenCalledTimes(1);
    sub.close();
    expect(open()).toHaveLength(0);
  });

  it("the run history resumes after the last event it delivered", () => {
    const seen: number[] = [];
    const sub = subscribeRunEvents("run-1", {
      after: 4,
      grant: "g",
      onEvent: (e) => seen.push(e.seq),
    });
    expect(latest().url).toBe("/api/v1/runs/run-1/events/stream?after=4&grant=g");
    latest().emit("history", historyEvent(5));
    latest().emit("history", historyEvent(6));
    awayAndBack();
    expect(open()).toHaveLength(1);
    expect(latest().url).toBe("/api/v1/runs/run-1/events/stream?after=6&grant=g");
    latest().emit("history", historyEvent(7));
    expect(seen).toEqual([5, 6, 7]);
    sub.close();
  });

  it("a subagent's history names its lane, and resumes in it", () => {
    const sub = subscribeRunEvents("run-1", {
      after: 2,
      lane: "sa-1",
      grant: "g",
      onEvent: vi.fn(),
    });
    expect(latest().url).toBe("/api/v1/runs/run-1/events/stream?after=2&lane=sa-1&grant=g");
    latest().emit("history", { ...historyEvent(3), lane: "sa-1" });
    awayAndBack();
    expect(latest().url).toBe("/api/v1/runs/run-1/events/stream?after=3&lane=sa-1&grant=g");
    sub.close();
  });

  it("the subagent feed hands over each lane, reopens, and stays closed after done", () => {
    const seen: string[] = [];
    const onDone = vi.fn();
    const sub = subscribeRunLanes("run-1", {
      grant: "g",
      onLane: (lane) => seen.push(lane.lane),
      onDone,
    });
    expect(latest().url).toBe("/api/v1/runs/run-1/lanes/stream?grant=g");
    const start = { ...historyEvent(1), lane: "sa-1", kind: "subagent.start" };
    latest().emit("lane", { lane: "sa-1", start, resume: null, end: null, ranMs: 0 });
    latest().emit("lane", { lane: "sa-2", start: {}, resume: null, end: null, ranMs: 0 }); // malformed
    awayAndBack();
    expect(open()).toHaveLength(1);
    latest().emit("lane", { lane: "sa-1", start, resume: null, end: null, ranMs: 0 });
    expect(seen).toEqual(["sa-1", "sa-1"]);
    latest().emit("done");
    expect(onDone).toHaveBeenCalledTimes(1);
    awayAndBack();
    expect(open()).toHaveLength(0);
    sub.close();
  });

  it("the run history stays closed after done, whatever the tab does", () => {
    const onDone = vi.fn();
    subscribeRunEvents("run-1", { onEvent: vi.fn(), onDone });
    latest().emit("done");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(open()).toHaveLength(0);
    awayAndBack();
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("the browser's live room reopens and is said again whole", () => {
    const messages: LiveMessage[] = [];
    const stop = liveStreamSource(() => "/live")({ onMessage: (m) => messages.push(m) });
    awayAndBack();
    expect(open()).toHaveLength(1);
    expect(FakeEventSource.made).toHaveLength(2);
    latest().emit("snapshot", { uplink: true, status: "idle", tabs: [], frame: null });
    expect(messages.map((m) => m.kind)).toEqual(["room"]);
    stop();
    expect(open()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the commands room reopens, and a done one stays closed", () => {
    const messages: CommandsMessage[] = [];
    commandsLiveSource("run-1", () => null)({ onMessage: (m) => messages.push(m) });
    awayAndBack();
    expect(open()).toHaveLength(1);
    latest().emit("snapshot", { at: 1, uplink: true, jobs: [] });
    latest().emit("done");
    expect(messages.map((m) => m.kind)).toEqual(["snapshot", "done"]);
    awayAndBack();
    expect(FakeEventSource.made).toHaveLength(2);
  });
});
