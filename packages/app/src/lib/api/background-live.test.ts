import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandsState } from "$lib/components/commands-pane/commands-state.svelte";
import { commandsLiveSource, type CommandsMessage, PROBE_TIMEOUT_MS } from "./background";
import { RETRY_DELAYS } from "./browser-live";

// The commands stream as a viewer drives it, against a stand-in EventSource and fetch: what it
// opens, how it retries, how it says a run has too many viewers, and when it stops for good.

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

  /** The server says something. */
  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  /** The stream is refused, or lost for good: EventSource gives up and says only "error". */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    for (const listener of this.#listeners.get("error") ?? []) listener(new Event("error"));
  }
}

const latest = () => FakeEventSource.made.at(-1)!;
const snapshot = { at: 1, uplink: true, jobs: [] };

/** Lets the probe's promise chain run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.made = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function watch(ended = () => false, grant: string | null = "g.1") {
  const messages: CommandsMessage[] = [];
  const retries: (boolean | undefined)[] = [];
  const stop = commandsLiveSource("run-1", () => grant, ended)({
    onMessage: (m) => messages.push(m),
    onRetry: (busy) => retries.push(busy),
  });
  return { messages, retries, stop };
}

describe("commandsLiveSource", () => {
  it("opens the run's commands stream through the proxy, with the history grant", () => {
    watch();
    expect(latest().url).toBe("/api/v1/runs/run-1/live/commands/stream?grant=g.1");
  });

  it("hands on what the stream says, and stops for good on done", () => {
    const { messages } = watch();
    latest().emit("snapshot", snapshot);
    latest().emit("output", { type: "output", at: 2, id: "bg-1", text: "hi\n" });
    latest().emit("dropped", { count: 3 });
    latest().emit("done");
    expect(messages.map((m) => m.kind)).toEqual(["snapshot", "event", "dropped", "done"]);
    expect(latest().closed).toBe(true);
  });

  it("retries a refused stream on the backoff, asking afresh each time", async () => {
    const { retries } = watch();
    latest().fail();
    await settle();
    expect(retries).toEqual([false]);
    expect(FakeEventSource.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
    expect(FakeEventSource.made).toHaveLength(2);
    latest().fail();
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1] - 1);
    expect(FakeEventSource.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.made).toHaveLength(3);
    // A snapshot means it held: the next failure starts the backoff over.
    latest().emit("snapshot", snapshot);
    latest().fail();
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
    expect(FakeEventSource.made).toHaveLength(4);
  });

  it("says when the run has too many viewers, and keeps to the backoff", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 429 })));
    const { retries } = watch();
    latest().fail();
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/runs/run-1/live/commands/stream?grant=g.1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(retries).toEqual([true]);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it("takes a probe that never answers as not busy, and retries anyway", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("timeout")))
      )
    );
    // The platform's timeout signal runs on the real clock; this one on the test's.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(new DOMException("timed out", "TimeoutError")), ms);
      return abort.signal;
    });
    const { retries } = watch();
    latest().fail();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(retries).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(retries).toEqual([false]);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it("stops for good on a refusal once the run is over", async () => {
    const { messages } = watch(() => true);
    latest().fail();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(messages.map((m) => m.kind)).toEqual(["done"]);
    expect(FakeEventSource.made).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens nothing more once stopped, even with a retry pending", async () => {
    const { stop } = watch();
    latest().fail();
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("opens nothing once stopped while the viewer probe is still out", async () => {
    let answer: (res: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    const { stop, retries } = watch();
    latest().fail();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    answer(new Response("", { status: 429 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retries).toEqual([]);
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("reopens for a fresh snapshot when a viewer of it lost lines", () => {
    const state = new CommandsState();
    const stop = state.connect(commandsLiveSource("run-1", () => null));
    const first = latest();
    first.emit("snapshot", snapshot);
    first.emit("dropped", { count: 5 });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.made).toHaveLength(2);
    expect(latest().url).toBe("/api/v1/runs/run-1/live/commands/stream");
    // Twice in ten seconds is once.
    latest().emit("dropped", { count: 1 });
    expect(FakeEventSource.made).toHaveLength(2);
    stop();
    expect(latest().closed).toBe(true);
  });
});
