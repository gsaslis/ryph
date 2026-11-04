import { afterEach, describe, expect, it, vi } from "vitest";

// The load remembers, per browser, which task it has already shown once: that is what tells a
// poll behind an open page apart from a first look at one, and only the first may fail the page.
// On the server there is no page on screen to keep, so every load there IS a first one.
vi.mock("$app/environment", () => ({ browser: true, building: false, dev: true, version: "t" }));
import type { HistoryWindow } from "$lib/api/history";
import type { RunUsageState } from "$lib/api/model-usage";
import { hold, type Holding } from "./holding";
import { load } from "./+page";

// The initial window is two small pages. Costs and a small missing middle resolve separately;
// neither holds the conversation off screen.

const AT = "2026-09-21T09:00:00.000Z";

const detail = (runId: string | null, taskId = "task-1", state = "running") => ({
  task: {
    id: taskId,
    agentId: "agent-1",
    spec: { title: "Ping", instructions: "Say hello." },
    repos: [],
    origin: "user",
    createdAt: AT,
  },
  agent: null,
  runs: runId === null ? [] : [{
    id: runId,
    state,
    phase: state === "running" ? "running" : null,
    branchNamespace: "ryph/ping",
    image: null,
    result: null,
    createdAt: AT,
    updatedAt: AT,
    events: [],
    messages: [],
  }],
});

const event = (seq: number) => ({
  runId: "run-1",
  lane: "",
  seq,
  at: AT,
  voice: "transcript",
  kind: "assistant",
  level: null,
  text: `event ${seq}`,
  payload: null,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A control plane holding a run of `total` events, answering the three reads the load can make and
 * recording every one of them. Model usage is refused, as it is on a deployment with no model
 * access — the load carries that as a flag rather than failing.
 */
function plane(
  total: number,
  runId: string | null = "run-1",
  taskId = "task-1",
  state = "running",
) {
  const asked: string[] = [];
  const billed: string[] = [];
  const f = (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === `/api/v1/tasks/${taskId}`) {
      return Promise.resolve(json(detail(runId, taskId, state)));
    }
    if (url.pathname.startsWith("/api/v1/model-usage")) {
      billed.push(url.pathname);
      return Promise.resolve(json({ error: "model access is disabled" }, 404));
    }
    if (!url.pathname.endsWith(`/runs/${runId}/events`)) {
      throw new Error(`no fake for ${url.pathname}`);
    }
    asked.push(url.search);
    const limit = Number(url.searchParams.get("limit") ?? 1_000);
    const all = Array.from({ length: total }, (_, i) => event(i));
    const rawBefore = url.searchParams.get("before");
    let events: ReturnType<typeof event>[];
    let cursor: number;
    let hasMore: boolean;
    if (rawBefore !== null) {
      cursor = Number(rawBefore);
      const older = all.filter((e) => e.seq < cursor);
      hasMore = older.length > limit;
      events = older.slice(Math.max(0, older.length - limit));
    } else {
      cursor = Number(url.searchParams.get("after") ?? -1);
      const newer = all.filter((e) => e.seq > cursor);
      hasMore = newer.length > limit;
      events = newer.slice(0, limit);
    }
    return Promise.resolve(json({
      events,
      firstSeq: events[0]?.seq ?? cursor,
      lastSeq: events.at(-1)?.seq ?? cursor,
      hasMore,
    }));
  };
  return { fetch: f as unknown as typeof globalThis.fetch, asked, billed };
}

/**
 * The load, called as the router calls it. Its declared return type carries the `void` a load is
 * allowed to have; this one always answers, and the history is what these tests are about.
 */
type Loaded = {
  history: HistoryWindow;
  olderHistory: Promise<HistoryWindow> | null;
  usage: Promise<RunUsageState> | null;
  detail: unknown;
  breadcrumb?: string;
};

async function run(
  fetch: typeof globalThis.fetch,
  id = "task-1",
  settle = true,
): Promise<Loaded> {
  const data = await load(
    {
      fetch,
      params: { id },
      depends: () => {},
    } as unknown as Parameters<typeof load>[0],
  );
  const result = data as unknown as Loaded;
  if (settle) {
    result.history = { ...result.history, ...await result.olderHistory };
    await result.usage;
  }
  return result;
}

describe("the task's initial and background reads", () => {
  it("returns the conversation while costs and older history are still pending", async () => {
    const historian = plane(420);
    const costs = Promise.withResolvers<Response>();
    const middle = Promise.withResolvers<Response>();
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://x");
      if (url.pathname.startsWith("/api/v1/model-usage")) return costs.promise;
      if (url.searchParams.get("after") === "49") return middle.promise;
      return historian.fetch(input, init);
    }) as unknown as typeof globalThis.fetch;

    const data = await run(fetch, "task-1", false);
    expect(data.detail).not.toBeNull();
    expect(data.history.tail!.lastSeq).toBe(419);
    expect(data.history.middle).toBeUndefined();
    let billed = false;
    let filled = false;
    void data.usage!.then(() => {
      billed = true;
    });
    void data.olderHistory!.then(() => {
      filled = true;
    });
    await Promise.resolve();
    expect(billed).toBe(false);
    expect(filled).toBe(false);

    middle.resolve(await historian.fetch("/api/v1/runs/run-1/events?after=49&limit=170"));
    expect((await data.olderHistory)!.middle!.lastSeq).toBe(219);
    expect(billed).toBe(false);
    costs.resolve(json({ error: "model access is disabled" }, 404));
    expect(await data.usage).toEqual({ usage: null, unavailable: true });
  });

  it("contains unexpected usage failures in the background promise", async () => {
    const historian = plane(20);
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("model-usage")) return Promise.reject(new Error("bad bill"));
      return historian.fetch(input, init);
    }) as typeof globalThis.fetch;
    const data = await run(fetch, "task-1", false);
    expect(data.history.tail!.lastSeq).toBe(19);
    expect(await data.usage).toEqual({ usage: null, unavailable: true });
  });
  it("closes a hole small enough to read in one go, with exactly one more request", async () => {
    // 420 events: the head reads 50, the tail reads the newest 200, and 170 are missing between
    // them. On a conversation that is a handful of rows, so the gap would be on the first screen.
    const historian = plane(420);
    const data = await run(historian.fetch);

    expect(historian.asked).toEqual([
      "?after=-1&limit=50",
      `?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
      "?after=49&limit=170",
    ]);
    expect(data.history.middle?.events.map((e) => e.seq).at(0)).toBe(50);
    expect(data.history.middle?.events.map((e) => e.seq).at(-1)).toBe(219);
    // The three pages meet: nothing between the head's end and the tail's start is missing.
    expect(data.history.head!.lastSeq + 1).toBe(data.history.middle?.firstSeq);
    expect(data.history.middle!.lastSeq + 1).toBe(data.history.tail!.firstSeq);
  });

  it("asks twice for a run whose two ends already meet", async () => {
    const historian = plane(180);
    const data = await run(historian.fetch);

    expect(historian.asked).toHaveLength(2);
    expect(data.history.middle).toBeUndefined();
  });

  it("asks twice for a run too long to close, and leaves the gap to the reader", async () => {
    // 5,000 events: 4,750 missing, five historian pages' worth. That gap sits screens above the
    // viewport, and fetches itself when somebody scrolls to it.
    const historian = plane(5_000);
    const data = await run(historian.fetch);

    expect(historian.asked).toHaveLength(2);
    expect(data.history.middle).toBeUndefined();
    expect(data.history.tail!.firstSeq - data.history.head!.lastSeq - 1).toBe(4_750);
  });

  it("asks twice at the boundary, and three times just inside it", async () => {
    // The historian answers at most 1,000 events in one read, so 1,000 missing is the widest hole
    // this can close: head 50 + hole 1,000 + tail 200.
    const fits = plane(1_250);
    await run(fits.fetch);
    expect(fits.asked).toHaveLength(3);
    expect(fits.asked[2]).toBe("?after=49&limit=1000");

    const over = plane(1_251);
    await run(over.fetch);
    expect(over.asked).toHaveLength(2);
  });

  it("reads no history at all for a task whose run has not been minted", async () => {
    const historian = plane(0, null);
    const data = await run(historian.fetch);

    expect(historian.asked).toEqual([]);
    expect(data.history.head!.events).toEqual([]);
    expect(data.history.middle).toBeUndefined();
  });
});

/**
 * A plane whose first `times` answers to the reads `match` picks out are a gateway failure.
 *
 * Two of them, not one: `apiCall` already asks a read once more after a 502/503/504, so a single
 * one never reaches this load at all — which is the first thing below.
 */
function failing(
  base: { fetch: typeof globalThis.fetch },
  match: (url: URL) => boolean,
  times: number,
  status = 503,
) {
  let left = times;
  const seen: string[] = [];
  const f = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    if (left > 0 && match(url)) {
      left--;
      seen.push(url.pathname + url.search);
      // Not JSON: a gateway that cannot reach what is behind it answers its own page, which is
      // why the message the app ends up showing is the one the bug report quoted —
      // `request failed (503)`.
      return Promise.resolve(
        new Response("upstream connect error", {
          status,
          headers: { "content-type": "text/plain" },
        }),
      );
    }
    return base.fetch(input, init);
  };
  return { fetch: f as unknown as typeof globalThis.fetch, refused: seen };
}

const isTail = (url: URL) => url.pathname.endsWith("/events") && url.searchParams.has("before");
const isHead = (url: URL) => url.pathname.endsWith("/events") && url.searchParams.has("after");
const isDetail = (url: URL) => url.pathname.startsWith("/api/v1/tasks/");

describe("a read that met a gateway", () => {
  it("never lets one 503 reach the load at all", async () => {
    // The retry inside `apiCall` absorbs it. This is the case the deployed page actually hit: one
    // transient failure on one of the four reads, on a load that re-runs every three seconds.
    const historian = plane(420);
    const control = failing(historian, isTail, 1);
    const data = await run(control.fetch);

    expect(control.refused).toHaveLength(1);
    expect(data.history.tail!.lastSeq).toBe(419);
    expect(data.history.error).toBeUndefined();
    // Three reads, plus the one that was asked twice.
    expect(historian.asked).toHaveLength(3);
  });

  it("leaves the tail out of the window, and says so, when it fails twice", async () => {
    const historian = plane(420);
    const control = failing(historian, isTail, 2);
    const data = await run(control.fetch);

    expect(data.history.tail).toBeUndefined();
    expect(data.history.error).toContain("503");
    // The head answered and is kept: what did arrive is the window.
    expect(data.history.head!.lastSeq).toBe(49);
    // ...and no middle was asked for: the hole between two ends is only knowable with both.
    expect(historian.asked).toEqual(["?after=-1&limit=50"]);
  });

  it("keeps the tail when it is the HEAD that fails", async () => {
    const historian = plane(420);
    const control = failing(historian, isHead, 2);
    const data = await run(control.fetch);

    expect(data.history.head).toBeUndefined();
    expect(data.history.tail!.lastSeq).toBe(419);
    expect(data.history.error).toContain("503");
  });

  it("leaves the hole as a gap row when only the middle read fails", async () => {
    // The third read is the one that keeps a short run's gap row off the first screen. Losing it
    // costs the run that row and nothing else, so it is not worth telling anyone about.
    const historian = plane(420);
    let seen = 0;
    const control = failing(historian, (url) => {
      // Only the forward read that is NOT the head: the middle.
      const after = url.searchParams.get("after");
      return after !== null && after !== "-1" && ++seen <= 2;
    }, 2);
    const data = await run(control.fetch);

    expect(data.history.middle).toBeUndefined();
    expect(data.history.head!.lastSeq).toBe(49);
    expect(data.history.tail!.firstSeq).toBe(220);
    expect(data.history.error).toBeUndefined();
  });
});

describe("a detail that did not answer", () => {
  it("fails the page on a FIRST look at a task, as it always has", async () => {
    // Nothing on screen to keep: a page that cannot read its task is a page that cannot be drawn.
    const historian = plane(20, "run-1", "task-cold");
    const control = failing(historian, isDetail, 2);

    await expect(run(control.fetch, "task-cold")).rejects.toThrow("503");
  });

  it("keeps the page up when the POLL behind an open one misses", async () => {
    const historian = plane(20, "run-1", "task-warm");
    const opened = await run(historian.fetch, "task-warm");
    expect(opened.detail).not.toBeNull();
    expect(opened.breadcrumb).toBe("Ping");

    // Three seconds later, the same load, and the gateway is being rolled.
    const control = failing(historian, isDetail, 2);
    const polled = await run(control.fetch, "task-warm");

    // Nothing was learned, and the load says exactly that rather than guessing at the rest: the
    // page keeps the detail, the transcript and the bill it already had.
    expect(polled.detail).toBeNull();
    expect(polled.history).toEqual({});
    // ...and the crumb is still the task's, because the task is still on screen.
    expect(polled.breadcrumb).toBe("Ping");

    // The poll after that finds the plane back, and the page adopts it again.
    const recovered = await run(historian.fetch, "task-warm");
    expect(recovered.detail).not.toBeNull();
  });
});

describe("a load behind a page that already holds the run", () => {
  // The page says what it holds; the load reads around it. Every case here is a re-run of the load
  // of a task the page is showing, which is what the poll, the cues and the actions all are.
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
  });
  const holds = (over: Partial<Holding>) => {
    release = hold(() => ({
      runId: "run-1",
      seeded: true,
      lastSeq: 399,
      billing: false,
      ...over,
    }));
  };

  it("leaves the bill to the page while the page polls it", async () => {
    const historian = plane(420, "run-1", "task-held");
    holds({ billing: true });
    const data = await run(historian.fetch, "task-held");

    expect(historian.billed).toEqual([]);
    expect(data.usage).toBeNull();
  });

  it("reads only what came after the history's end", async () => {
    // Even behind a live tail: one left half-open by a sleep or a network change delivers nothing,
    // and this read is what heals it.
    const historian = plane(420, "run-1", "task-held");
    holds({});
    const data = await run(historian.fetch, "task-held");

    expect(data.detail).not.toBeNull();
    expect(historian.asked).toEqual(["?after=399&limit=1000"]);
    expect(data.olderHistory).toBeNull();
    // The bill is still the load's while the page does not poll it.
    expect(historian.billed).toHaveLength(1);
    expect(data.history.head).toBeUndefined();
    expect(data.history.tail!.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => 400 + i),
    );
  });

  it("reads only the end of the run when more was missed than one read answers", async () => {
    const historian = plane(1_600, "run-1", "task-held");
    holds({ lastSeq: 99 });
    const data = await run(historian.fetch, "task-held");

    expect(historian.asked).toEqual([
      "?after=99&limit=1000",
      `?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
    ]);
    // The run's newest page and nothing of the stretch before it, as every re-load used to read
    // it: the history takes it as it always did, gap row and all.
    expect(data.history.tail!.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => 1_400 + i),
    );
    expect(data.history.tail!.lastSeq).toBe(1_599);
  });

  it("reads only the end of the run behind a history seeded empty, past one read", async () => {
    // A history seeded while the run had said nothing: the end of the run then opens a page of
    // its own, with the gap above it, as it did when every re-load read the newest page.
    const historian = plane(1_600, "run-1", "task-held");
    holds({ lastSeq: -1 });
    const data = await run(historian.fetch, "task-held");

    expect(historian.asked).toEqual([
      "?after=-1&limit=1000",
      `?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
    ]);
    expect(data.history.tail!.firstSeq).toBe(1_400);
    expect(data.history.tail!.events.map((e) => e.seq)[0]).toBe(1_400);
  });

  it("carries a failed read of the end as an error, as every re-load did", async () => {
    const historian = plane(1_600, "run-1", "task-held");
    holds({ lastSeq: 99 });
    const control = failing(historian, (url) => url.searchParams.has("before"), 2);
    const data = await run(control.fetch, "task-held");

    expect(data.history.tail).toBeUndefined();
    expect(data.history.error).toContain("503");
  });

  it("carries a missed read as an error, and nothing else, for the history to ignore", async () => {
    const historian = plane(420, "run-1", "task-held");
    holds({});
    const control = failing(historian, (url) => url.pathname.endsWith("/events"), 2);
    const data = await run(control.fetch, "task-held");

    expect(data.history.tail).toBeUndefined();
    expect(data.history.error).toContain("503");
  });

  it("reads the final bill once the run is over, even while the page polls it", async () => {
    // The page stops its poll the moment a detail says the run ended: the final bill is this
    // load's to read.
    const historian = plane(420, "run-1", "task-held", "succeeded");
    holds({ billing: true });
    const data = await run(historian.fetch, "task-held");

    expect(historian.asked).toEqual(["?after=399&limit=1000"]);
    expect(historian.billed).toHaveLength(1);
    expect(await data.usage).toEqual({ usage: null, unavailable: true });
  });

  it("reads the whole window for a history that was never seeded", async () => {
    // The first tail did not answer: the retry is a load, and it has to read the window afresh.
    const historian = plane(420, "run-1", "task-held");
    holds({ seeded: false, lastSeq: -1 });
    await run(historian.fetch, "task-held");

    expect(historian.asked).toHaveLength(3);
  });

  it("reads the whole window for a run the page is not holding", async () => {
    // A new attempt on the task, or another task opened in the same page: a different run.
    const historian = plane(420, "run-1", "task-held");
    holds({ runId: "run-0" });
    await run(historian.fetch, "task-held");

    expect(historian.asked).toHaveLength(3);
    expect(historian.billed).toHaveLength(1);
  });

  it("reads the whole window again once the page has let go", async () => {
    const historian = plane(420, "run-1", "task-held");
    holds({});
    release!();
    await run(historian.fetch, "task-held");

    expect(historian.asked).toHaveLength(3);
  });
});
