import { describe, expect, it } from "vitest";
import {
  getLaneWindow,
  getRunEventsAfter,
  getRunEventsBefore,
  getRunHead,
  getRunLanes,
  getRunTail,
} from "./history";

// A run's history is read from both ends: the newest page when the task page opens, older pages as
// somebody scrolls back into them. Every page comes back ascending whichever way it was read, so
// the seam this guards is that a backwards page is cut at its OLD end and still reads forwards.

const event = (seq: number) => ({
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

/** A historian holding `total` events, paging in either direction. Records what was asked. */
function fakeHistorian(total: number) {
  const asked: string[] = [];
  const fetch = (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    asked.push(url.pathname + url.search);
    const limit = Number(url.searchParams.get("limit") ?? 1_000);
    const rawBefore = url.searchParams.get("before");
    const all = Array.from({ length: total }, (_, i) => event(i));

    let events: ReturnType<typeof event>[];
    let hasMore: boolean;
    let cursor: number;
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
    return Promise.resolve(
      new Response(
        JSON.stringify({
          events,
          firstSeq: events[0]?.seq ?? cursor,
          lastSeq: events[events.length - 1]?.seq ?? cursor,
          hasMore,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, asked };
}

describe("reading a run's history from either end", () => {
  it("the tail is the newest page, ascending, and knows older ones remain", async () => {
    const historian = fakeHistorian(2_500);
    const page = await getRunTail(historian.fetch, "run-1", 200);

    expect(page.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => 2_300 + i),
    );
    expect(page.firstSeq).toBe(2_300);
    expect(page.lastSeq).toBe(2_499);
    expect(page.hasMore).toBe(true);
    // There is no seq for "the end of the run", so the newest page is asked for as everything
    // below the largest seq anything can hold.
    expect(historian.asked[0]).toBe(
      `/api/v1/runs/run-1/events?before=${Number.MAX_SAFE_INTEGER}&limit=200`,
    );
  });

  it("the head is the first events of the run", async () => {
    const historian = fakeHistorian(2_500);
    const page = await getRunHead(historian.fetch, "run-1", 50);

    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(page.firstSeq).toBe(0);
    expect(page.lastSeq).toBe(49);
    expect(historian.asked[0]).toBe("/api/v1/runs/run-1/events?after=-1&limit=50");
  });

  it("a page older than a seq stops one short of it", async () => {
    const historian = fakeHistorian(2_500);
    const page = await getRunEventsBefore(historian.fetch, "run-1", 2_300, 100);

    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 2_200 + i));
    expect(page.hasMore).toBe(true);
  });

  it("a page newer than a seq starts one past it", async () => {
    const historian = fakeHistorian(2_500);
    const page = await getRunEventsAfter(historian.fetch, "run-1", 2_400, 100);

    expect(page.events.map((e) => e.seq)).toEqual(Array.from({ length: 99 }, (_, i) => 2_401 + i));
    expect(page.hasMore).toBe(false);
  });

  it("a run shorter than the page hands back all of it and says there is no more", async () => {
    const historian = fakeHistorian(10);
    const page = await getRunTail(historian.fetch, "run-1", 200);

    expect(page.events).toHaveLength(10);
    expect(page.firstSeq).toBe(0);
    expect(page.lastSeq).toBe(9);
    expect(page.hasMore).toBe(false);
  });

  // An empty run has no seqs to report a range from, and the page must still be usable as a
  // cursor rather than reporting a seq that does not exist.
  it("an empty run pages to the cursor it was asked from", async () => {
    const historian = fakeHistorian(0);
    const page = await getRunTail(historian.fetch, "run-1", 200);

    expect(page.events).toEqual([]);
    expect(page.firstSeq).toBe(Number.MAX_SAFE_INTEGER);
    expect(page.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
    expect(page.hasMore).toBe(false);
  });

  // The `firstSeq` half of the contract is newer than the route, so it is defaulted rather than
  // required — a page that carries events takes its range off them either way.
  it("survives a page that names no firstSeq", async () => {
    const terse = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ events: [event(7), event(8)], lastSeq: 8, hasMore: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof globalThis.fetch;

    const page = await getRunTail(terse, "run-1", 200);
    expect(page.firstSeq).toBe(7);
    expect(page.lastSeq).toBe(8);
  });
});

// A subagent's transcript is a lane of the run's history: the same reads, scoped to it. The run's
// own lane is never named, so its requests are the ones they always were.
describe("reading a subagent's lane", () => {
  it("names the lane on every read, and the grant after it", async () => {
    const historian = fakeHistorian(10);
    await getRunTail(historian.fetch, "run-1", 200, "g", "sa-2");
    await getRunHead(historian.fetch, "run-1", 50, null, "sa-2");
    await getRunEventsBefore(historian.fetch, "run-1", 5, 100, null, "sa-2");
    await getRunEventsAfter(historian.fetch, "run-1", 5, 100, null, "sa-2");
    expect(historian.asked).toEqual([
      `/api/v1/runs/run-1/events?before=${Number.MAX_SAFE_INTEGER}&limit=200&lane=sa-2&grant=g`,
      "/api/v1/runs/run-1/events?after=-1&limit=50&lane=sa-2",
      "/api/v1/runs/run-1/events?before=5&limit=100&lane=sa-2",
      "/api/v1/runs/run-1/events?after=5&limit=100&lane=sa-2",
    ]);
  });

  it("a lane's window closes a small hole between its ends in the same read", async () => {
    const historian = fakeHistorian(400);
    const window = await getLaneWindow(historian.fetch, "run-1", "sa-1");
    expect(window.head?.lastSeq).toBe(49);
    expect(window.tail?.firstSeq).toBe(200);
    expect(window.middle?.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 150 }, (_, i) => 50 + i),
    );
    expect(historian.asked.every((q) => q.includes("lane=sa-1"))).toBe(true);
  });

  it("the main lane is never named", async () => {
    const historian = fakeHistorian(10);
    await getRunTail(historian.fetch, "run-1", 200, null, "");
    expect(historian.asked[0]).not.toContain("lane");
  });
});

describe("listing a run's subagents", () => {
  const laneEvent = (lane: string, seq: number, kind: string, payload: unknown) => ({
    ...event(seq),
    lane,
    kind,
    text: kind === "subagent.start" ? "Find the callers" : null,
    payload,
  });

  it("reads the lanes with the grant, as the historian lists them", async () => {
    const asked: string[] = [];
    const lanes = [
      {
        lane: "sa-1",
        start: laneEvent("sa-1", 1, "subagent.start", {
          id: "sa-1",
          label: "Find the callers",
          mode: "explore",
          task: "Find every caller.",
        }),
        resume: null,
        end: laneEvent("sa-1", 9, "subagent.end", {
          id: "sa-1",
          reason: "answered",
          answerChars: 120,
          durationMs: 40_000,
        }),
        ranMs: 40_000,
      },
    ];
    const fetch = ((input: string | URL | Request) => {
      asked.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ lanes }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;

    const listed = await getRunLanes(fetch, "run-1", "g");
    expect(asked[0]).toMatch(/\/v1\/runs\/run-1\/lanes\?grant=g$/);
    expect(listed).toHaveLength(1);
    expect(listed[0].lane).toBe("sa-1");
    expect(listed[0].resume).toBeNull();
    expect(listed[0].end?.seq).toBe(9);
  });

  it("refuses a listing whose events are not events", async () => {
    const fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lanes: [{ lane: "sa-1", start: {}, resume: null, end: null }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof globalThis.fetch;
    await expect(getRunLanes(fetch, "run-1")).rejects.toThrow();
  });
});
