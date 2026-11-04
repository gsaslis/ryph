import { describe, expect, it } from "vitest";
import type { HistoryWindow } from "$lib/api/history";
import type { HistoryEvent, RunMessage, RunnerResult } from "$lib/api/types";
import { KEEP_AROUND, MAX_PAGES, OLDER_PAGE, RunHistory } from "./run-history.svelte";

// A run's history is read at its tail and back from there, so the seams this guards are the ones
// paging opens: what a page holds, what the hole between two pages says, what happens to a tool
// call whose two halves land in different pages, and what is dropped when too much is held.

const AT = (seq: number) => new Date(Date.UTC(2026, 8, 21, 12, 0, 0) + seq * 1_000).toISOString();

function event(seq: number, over: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    runId: "run-1",
    lane: "",
    seq,
    at: AT(seq),
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: null,
    ...over,
  };
}

describe("empty assistant messages", () => {
  it("omits empty historical rows, including in diagnostic mode", () => {
    const history = new RunHistory("run-1");
    const events = [
      event(0),
      event(1, { text: "" }),
      event(2, { text: null }),
      event(3, { text: " \n\t " }),
      event(4),
    ];
    history.seed(window(events, events, false));
    for (const diagnostics of [false, true]) {
      history.showDiag = diagnostics;
      expect(history.rows.filter((row) => row.kind === "event").map((row) => row.key))
        .toEqual(["h0", "h4"]);
    }
  });

  it("omits empty live arrivals without dropping subsequent text or tool calls", () => {
    const history = new RunHistory("run-1");
    history.seed(window([event(0)], [event(0)], false));
    history.absorb(event(1, { text: "" }));
    history.absorb(event(2, {
      kind: "tool_use",
      text: "",
      payload: { toolCallId: "c1", toolName: "read", args: { path: "/w/file.ts" } },
    }));
    history.absorb(event(3, { text: "  A real reply  " }));
    expect(history.rows.some((row) => row.key === "h1")).toBe(false);
    expect(history.rows.some((row) => row.kind === "tool")).toBe(true);
    expect(history.rows.find((row) => row.key === "h3"))
      .toMatchObject({ event: { text: "  A real reply  " } });
  });
});

describe("context usage", () => {
  const usage = (seq: number, tokens: number | null = 60_000) =>
    event(seq, {
      kind: "system",
      text: "context_usage",
      payload: {
        status: tokens === null ? "recalculating" : "ready",
        tokens,
        contextWindow: 200_000,
        percent: tokens === null ? null : 30,
      },
    });

  it("hydrates from history without becoming transcript activity, and ignores older snapshots", () => {
    const history = new RunHistory("run-1");
    history.seed(window([event(0), usage(1)], [event(4), usage(5)], true));
    expect(history.contextUsage?.tokens).toBe(60_000);
    expect(history.lastSpoken?.seq).toBe(4);
    expect(JSON.stringify(history.rows)).not.toContain("context_usage");
    history.absorb(usage(6, null));
    history.seed(window([usage(1)], [usage(5)], true));
    expect(history.contextUsage?.status).toBe("recalculating");
    expect(history.lastSpoken?.seq).toBe(4);
    expect(new RunHistory("run-2").contextUsage).toBeNull();
  });

  it("rejects invalid snapshots and retains state when the live tail moves to another page", () => {
    const history = new RunHistory("run-1");
    history.seed(window([usage(0)], [usage(0)], false));
    for (let seq = 1; seq <= OLDER_PAGE + 1; seq++) history.absorb(event(seq));
    history.absorb(event(OLDER_PAGE + 2, {
      kind: "system",
      text: "context_usage",
      payload: { status: "ready", tokens: -1 },
    }));
    expect(history.contextUsage?.tokens).toBe(60_000);
  });
});

const range = (from: number, to: number, over: Partial<HistoryEvent> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => event(from + i, over));

const page = (events: HistoryEvent[], hasMore: boolean) => ({
  events,
  firstSeq: events[0]?.seq ?? -1,
  lastSeq: events[events.length - 1]?.seq ?? -1,
  hasMore,
});

const window = (head: HistoryEvent[], tail: HistoryEvent[], hasMore = true): HistoryWindow => ({
  head: page(head, hasMore),
  tail: page(tail, hasMore),
});

/**
 * A historian holding `total` events, answering `before` pages. Records what was asked for, so a
 * test can say not just what landed but that nothing was fetched twice.
 */
function fakeHistorian(events: HistoryEvent[]) {
  const asked: number[] = [];
  const f = (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit") ?? OLDER_PAGE);
    asked.push(before);
    const older = events.filter((e) => e.seq < before);
    const slice = older.slice(Math.max(0, older.length - limit));
    return Promise.resolve(
      new Response(JSON.stringify(page(slice, older.length > limit)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: f as unknown as typeof globalThis.fetch, asked };
}

/**
 * A historian that answers when the test says so, for the seams that only exist while a fetch is
 * in flight: two gaps at once, a run swapped underneath one, a tail landing during one.
 */
function heldHistorian(events: HistoryEvent[]) {
  const waiting: { before: number; release: () => void }[] = [];
  const f = (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit") ?? OLDER_PAGE);
    return new Promise<Response>((resolve) => {
      waiting.push({
        before,
        release: () => {
          const older = events.filter((e) => e.seq < before);
          const slice = older.slice(Math.max(0, older.length - limit));
          resolve(
            new Response(JSON.stringify(page(slice, older.length > limit)), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
      });
    });
  };
  return {
    fetch: f as unknown as typeof globalThis.fetch,
    get pending() {
      return waiting.map((w) => w.before);
    },
    /** Answer the request made for `before`, and let its `await` run. */
    async release(before: number) {
      const at = waiting.findIndex((w) => w.before === before);
      waiting.splice(at, 1)[0].release();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const seqsOf = (history: RunHistory) =>
  history.rows.flatMap((row) =>
    row.kind === "event" ? [row.event.seq] : row.kind === "tool" ? [row.call.seq] : []
  );

const gapsOf = (history: RunHistory) =>
  history.rows.flatMap((row) =>
    row.kind === "gap" ? [{ before: row.before, count: row.count }] : []
  );

const detail = {
  lifecycle: [],
  messages: [],
  result: null,
  egressNote: null,
  live: false,
};

const lifecycle = (kind: string, at: string, detail?: string) => ({
  runId: "run-1",
  at,
  kind,
  ...(detail === undefined ? {} : { detail }),
});

const kindsOf = (history: RunHistory) => history.rows.map((row) => row.kind);

const message = (seq: number, at: string): RunMessage =>
  ({
    seq,
    kind: "user",
    sender: { kind: "user", userId: "u-1" },
    text: "do the thing",
    createdAt: at,
    payload: null,
  }) as unknown as RunMessage;

const success: RunnerResult = {
  status: "success",
  branches: [],
  summary: "Did the thing.",
  images: [],
};

describe("seeding the window", () => {
  it("holds the head and the tail as two pages, with the hole between them named", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(2_300, 2_499)));

    expect(seqsOf(history).at(0)).toBe(0);
    expect(seqsOf(history).at(-1)).toBe(2_499);
    expect(gapsOf(history)).toEqual([{ before: 2_300, count: 2_250 }]);
    expect(history.hasOlder).toBe(true);
    expect(history.lastSeq).toBe(2_499);
  });

  it("a run shorter than one page is one page, with no hole and nothing older", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, 9), false));

    expect(seqsOf(history)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gapsOf(history)).toEqual([]);
    expect(history.hasOlder).toBe(false);
  });

  it("an overlapping tail is deduped against the head rather than drawn twice", () => {
    const history = new RunHistory("run-1");
    // The head read fifty and the tail read the newest eighty of an eighty-one event run: the
    // thirty they share are one stretch of the run and must be held once.
    history.seed(window(range(0, 49), range(30, 80), false));

    expect(seqsOf(history)).toEqual(Array.from({ length: 81 }, (_, i) => i));
    expect(gapsOf(history)).toEqual([]);
  });

  it("a retry is a history of its own, and the run that was keeps its rows", () => {
    // One instance per run, because the run is a constructor argument: the retry cannot be this
    // history pointed somewhere else. That is the whole rule — the transcript drawing a run reads
    // its rows for as long as it is mounted, and the page it is on outlives the run it shows. When
    // the two runs shared one history, seeding the next one shrank the list under a virtualiser
    // still holding the last one's row count, and it read past the end of it mid-flush.
    const first = new RunHistory("run-1");
    first.seed(window(range(0, 49), range(2_300, 2_499)));
    first.expanded.add("h2400");

    const retry = new RunHistory("run-2");
    retry.seed(window(range(0, 9), range(0, 9), false));

    expect(seqsOf(retry)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(retry.runId).toBe("run-2");
    // Row keys are per run: seqs restart at 0, so what was open belonged to the other run.
    expect(retry.expanded.size).toBe(0);
    // ...and nothing of the first run's moved. Its rows are as long as they were.
    expect(seqsOf(first).at(-1)).toBe(2_499);
    expect(first.rows.length).toBe(251); // 50 + a gap row + 200
    expect(first.expanded.size).toBe(1);
  });

  it("takes the middle page the load closed the hole with, as one contiguous stretch", () => {
    // A short run's two ends land on the same screen once the diag voice is filtered out, so the
    // load reads what is between them too rather than let a gap row draw and fetch itself in front
    // of the reader. Three pages that meet are one stretch with no hole to name.
    const history = new RunHistory("run-1");
    history.seed({
      head: page(range(0, 49), true),
      middle: page(range(50, 219), true),
      tail: page(range(220, 419), true),
    });

    expect(gapsOf(history)).toEqual([]);
    expect(seqsOf(history)).toHaveLength(420);
    expect(seqsOf(history).at(0)).toBe(0);
    expect(seqsOf(history).at(-1)).toBe(419);
    expect(history.hasOlder).toBe(false);
  });

  it("merges a deferred middle after a refresh without losing streamed events or duplicating rows", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(220, 419)));
    expect(gapsOf(history)).toHaveLength(1);
    // A poll completes before the first middle read; the tail and live stream move on.
    history.seed(window(range(0, 49), range(230, 429)));
    history.absorb(event(430));
    const middle = page(range(50, 219), true);
    history.seed({ middle });
    history.seed({ middle });

    expect(gapsOf(history)).toEqual([]);
    expect(seqsOf(history)).toHaveLength(431);
    expect(history.lastSeq).toBe(430);
    expect(history.hasOlder).toBe(false);
  });

  it("a hole too wide to read in one go is still a hole", () => {
    // What the load hands over when it declined: two pages, and the gap row that says how much of
    // the run is not here. It sits screens above the viewport, where it fetches itself when
    // somebody scrolls to it.
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(2_300, 2_499)));

    expect(gapsOf(history)).toEqual([{ before: 2_300, count: 2_250 }]);
  });

  it("a load re-run under the same run does not take the middle page twice", () => {
    const history = new RunHistory("run-1");
    const head = page(range(0, 49), true);
    const middle = page(range(50, 219), true);
    history.seed({ head, middle, tail: page(range(220, 419), true) });
    // The poller, three seconds later: the same window, with two more events on the end of it.
    history.seed({ head, middle, tail: page(range(220, 421), true) });

    expect(gapsOf(history)).toEqual([]);
    expect(seqsOf(history)).toHaveLength(422);
    expect(history.lastSeq).toBe(421);
  });

  it("a task whose run has not been minted yet holds nothing to draw", () => {
    // The page mints a history per run, and a task that has not been picked up has no run at all.
    const history = new RunHistory(null);
    history.seed(window(range(0, 9), range(0, 9), false));

    expect(history.rows).toEqual([]);
    expect(history.lastSeq).toBe(-1);
    expect(history.hasOlder).toBe(false);
  });

  it("a load re-run under the same run keeps the pages and takes only what the tail missed", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(2_300, 2_499)));
    history.seed(window(range(0, 49), range(2_300, 2_502)));

    expect(history.lastSeq).toBe(2_502);
    expect(gapsOf(history)).toEqual([{ before: 2_300, count: 2_250 }]);
  });
});

describe("the live tail", () => {
  it("appends to the newest page and ignores a seq it already holds", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(2_300, 2_309)));

    history.absorb(event(2_309)); // replay overlap: the stream repeats on reconnect
    history.absorb(event(2_310));
    history.absorb(event(2_310)); // ...and again

    expect(seqsOf(history).slice(-3)).toEqual([2_308, 2_309, 2_310]);
    expect(history.lastSeq).toBe(2_310);
  });

  it("starts a new page once one has grown to a page's worth", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(1_000, 1_000 + OLDER_PAGE - 1)));
    history.absorb(event(2_000));

    // Not one page growing without limit for as long as the run lasts: the new event opens a
    // page of its own, which is what keeps eviction able to drop anything at all.
    expect(history.rows.filter((row) => row.kind === "gap")).toHaveLength(2);
  });
});

describe("the last thing the run said", () => {
  it("holds across a page boundary when the new page opens on a diag event", () => {
    // The load's tail is exactly a page's worth, so on any run that long the first event the
    // stream delivers opens a page of its own. A diag event there used to leave nothing "said" on
    // the newest page, and an idle agent read as working a few seconds after the page opened.
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(1_000, 1_000 + OLDER_PAGE - 1)));
    expect(history.lastSpoken?.seq).toBe(1_000 + OLDER_PAGE - 1);

    history.absorb(event(2_000, { voice: "diag", kind: "conversation.held_for_verdict" }));

    expect(history.lastSpoken?.kind).toBe("assistant");
    expect(history.lastSpoken?.seq).toBe(1_000 + OLDER_PAGE - 1);
  });

  it("is not moved by a compaction after the turn, or by a mark", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 4), range(0, 4), false));

    history.absorb(event(5, { kind: "system", text: "compaction_start" }));
    history.absorb(event(6, { kind: "system", text: "compaction_end" }));
    history.absorb(event(7, { kind: "final", text: null, payload: { seq: 4 } }));

    expect(history.lastSpoken?.seq).toBe(4);
  });

  it("moves on what starts a turn", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 4), range(0, 4), false));

    history.absorb(event(5, { kind: "inbound", text: "hello" }));
    expect(history.lastSpoken?.kind).toBe("inbound");

    history.absorb(event(6, { kind: "system", text: "agent_start" }));
    expect(history.lastSpoken?.seq).toBe(6);
  });

  it("is not moved back by an older page landing", async () => {
    const all = range(0, 999);
    const { fetch } = fakeHistorian(all);
    const history = new RunHistory("run-1", fetch);
    history.seed(window(range(0, 9), range(800, 999)));

    await history.loadOlder();

    expect(history.lastSpoken?.seq).toBe(999);
  });

  it("is nothing before the run has said anything", () => {
    const history = new RunHistory("run-1");
    history.seed(window([], [], false));
    history.absorb(event(0, { voice: "diag", kind: "runner.started" }));

    expect(history.lastSpoken).toBeNull();
  });
});

describe("loading older pages", () => {
  it("prepends the page above, in order, and closes the hole as it goes", async () => {
    const all = range(0, 999);
    const historian = fakeHistorian(all);
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));

    await history.loadOlder();

    expect(historian.asked).toEqual([800]);
    expect(seqsOf(history).slice(0, 51)).toEqual([...Array(50).keys(), 600]);
    expect(gapsOf(history)).toEqual([{ before: 600, count: 550 }]);
    expect(history.hasOlder).toBe(true);
  });

  it("stops being loadable once the head and the rest meet", async () => {
    const all = range(0, 299);
    const historian = fakeHistorian(all);
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(100, 299)));

    await history.loadOlder();

    expect(seqsOf(history)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(gapsOf(history)).toEqual([]);
    expect(history.hasOlder).toBe(false);
    // At the head, so nothing more is asked for however often the sentinel fires.
    await history.loadOlder();
    expect(historian.asked).toEqual([100]);
  });

  it("is a no-op while one is in flight", async () => {
    const historian = fakeHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));

    await Promise.all([history.loadOlder(), history.loadOlder(), history.loadOlder()]);

    expect(historian.asked).toEqual([800]);
  });

  it("a gap that answers with nothing is closed rather than asked again", async () => {
    // A hole the seq arithmetic saw but that holds no events: asking again would answer the same
    // nothing every time the row scrolled into view.
    const historian = fakeHistorian(range(0, 49));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));

    await history.loadGap(800);

    expect(gapsOf(history)).toEqual([]);
    expect(history.hasOlder).toBe(false);
  });

  it("a failed page leaves the gap where it is, with a retry on it", async () => {
    const angry = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "nope" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof globalThis.fetch;
    const history = new RunHistory("run-1", angry);
    history.seed(window(range(0, 49), range(800, 999)));

    await history.loadOlder();

    expect(gapsOf(history)).toEqual([{ before: 800, count: 750 }]);
    expect(history.rows.find((row) => row.kind === "gap")).toMatchObject({ failed: true });
    expect(history.hasOlder).toBe(true);
  });

  it("re-fetches a gap that eviction left behind", async () => {
    const historian = fakeHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));
    await history.loadOlder(); // 600..799
    await history.loadOlder(); // 400..599

    // Pretend the middle page went: what is left must still name the hole and be able to fill it.
    const hole = gapsOf(history);
    expect(hole).toEqual([{ before: 400, count: 350 }]);
    await history.loadGap(400);
    expect(gapsOf(history)).toEqual([{ before: 200, count: 150 }]);
    expect(historian.asked).toEqual([800, 600, 400]);
  });
});

describe("eviction", () => {
  /** A history with `pages` pages loaded, the reader sitting at the oldest of them. */
  async function deep(pages: number, live: boolean): Promise<RunHistory> {
    const total = pages * OLDER_PAGE + 200;
    const all = range(0, total - 1);
    const history = new RunHistory("run-1", fakeHistorian(all).fetch);
    history.setDetail({ ...detail, live });
    history.seed(window(range(0, 49), all.slice(-OLDER_PAGE)));
    for (let i = 0; i < pages; i++) {
      history.noteViewport(history.rows.find((row) => row.kind === "event")?.event.seq ?? 0);
      await history.loadOlder();
    }
    return history;
  }

  it("keeps at most MAX_PAGES and leaves a hole where a page went", async () => {
    const history = await deep(MAX_PAGES + 6, false);
    const loaded = new Set(history.rows.flatMap((r) => r.kind === "event" ? [r.event.seq] : []));
    expect(loaded.size).toBeLessThanOrEqual((MAX_PAGES + 1) * OLDER_PAGE);
    // Every page that went left its hole behind, so the list still knows the run is longer than
    // what it holds and can fetch the rest back.
    expect(gapsOf(history).length).toBeGreaterThan(0);
  });

  it("never drops the head page — the workspace root lives there", async () => {
    const history = await deep(MAX_PAGES + 6, false);
    expect(seqsOf(history)[0]).toBe(0);
  });

  it("never drops the newest page — the tail appends to it", async () => {
    const history = await deep(MAX_PAGES + 6, true);
    expect(history.lastSeq).toBe(seqsOf(history).at(-1));
    // The tail still lands where it is meant to.
    const next = history.lastSeq + 1;
    history.absorb(event(next));
    expect(seqsOf(history).at(-1)).toBe(next);
  });

  it("keeps the pages around the reader", async () => {
    const history = await deep(MAX_PAGES + 6, false);
    const here = history.rows.find((row) => row.kind === "event")?.event.seq ?? 0;
    const loaded = seqsOf(history);
    // KEEP_AROUND pages either side of where the reader is, still there.
    expect(loaded.filter((seq) => seq > here && seq < here + KEEP_AROUND * OLDER_PAGE).length)
      .toBeGreaterThan(0);
  });
});

describe("outcome report visibility", () => {
  const use = (seq: number, name = "ryph__report_outcome") =>
    event(seq, {
      kind: "tool_use",
      payload: { toolCallId: `c${seq}`, toolName: name, args: { outcome: "completed" } },
    });
  const result = (seq: number, callSeq: number, isError = false) =>
    event(seq, {
      kind: "tool_result",
      payload: {
        toolCallId: `c${callSeq}`,
        isError,
        result: { content: [{ type: "text", text: isError ? "failed" : "ok" }] },
      },
    });

  it("hides pending and successful reports and their results, but preserves other tools", () => {
    const history = new RunHistory("run-1");
    history.absorb(use(0));
    expect(history.rows).toEqual([]);
    history.absorb(result(1, 0));
    expect(history.rows).toEqual([]);
    history.absorb(use(2, "ryph__finish"));
    history.absorb(use(3, "bash"));
    history.absorb(use(4, "other__report_outcome"));
    expect(seqsOf(history)).toEqual([2, 3, 4]);

    history.showDiag = true;
    expect(seqsOf(history)).toEqual([0, 2, 3, 4]);
    const report = history.rows[0];
    expect(report.kind === "tool" && report.call.done).toBe(true);
    history.showDiag = false;
    expect(seqsOf(history)).toEqual([2, 3, 4]);
  });

  it("reveals a pending report when its failure arrives without duplicating its result", () => {
    const history = new RunHistory("run-1");
    history.absorb(use(0));
    expect(history.rows).toEqual([]);
    history.absorb(result(1, 0, true));
    expect(seqsOf(history)).toEqual([0]);
    const report = history.rows[0];
    expect(report.kind === "tool" && report.call.isError).toBe(true);
    history.showDiag = true;
    expect(seqsOf(history)).toEqual([0]);
  });

  it("keeps a result absorbed across pages in normal and diagnostic views", async () => {
    const all = [...range(0, 299), use(300), result(301, 300), ...range(302, 399)];
    const history = new RunHistory("run-1", fakeHistorian(all).fetch);
    history.seed(window(range(0, 49), all.slice(301)));
    // Without the call's page we cannot identify the result as bookkeeping.
    expect(seqsOf(history)).toContain(301);
    await history.loadOlder();
    expect(seqsOf(history)).not.toContain(300);
    expect(seqsOf(history)).not.toContain(301);
    history.showDiag = true;
    expect(seqsOf(history)).toContain(300);
    expect(seqsOf(history)).not.toContain(301);
    history.showDiag = false;
    expect(seqsOf(history)).not.toContain(300);
    expect(seqsOf(history)).not.toContain(301);
  });
});

describe("tool calls across a page boundary", () => {
  const use = (seq: number, id: string) =>
    event(seq, {
      kind: "tool_use",
      text: null,
      payload: { toolCallId: id, toolName: "bash", args: { command: "ls" } },
    });
  const result = (seq: number, id: string) =>
    event(seq, {
      kind: "tool_result",
      text: "ok",
      payload: { toolCallId: id, result: { content: [{ type: "text", text: "a\nb" }] } },
    });

  it("folds a result whose call sits in the page above it", async () => {
    // The call ran at the very end of one page and answered at the top of the next: neither page
    // holds both halves, and the row has to be one row all the same.
    const all = [...range(0, 299), use(300, "c1"), result(301, "c1"), ...range(302, 399)];
    const historian = fakeHistorian(all);
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), all.slice(301)));

    // Before the older page lands, the lone result is a row of its own rather than nothing.
    expect(seqsOf(history)).toContain(301);

    await history.loadOlder();

    const call = history.rows.find((row) => row.kind === "tool" && row.call.seq === 300);
    expect(call).toBeDefined();
    expect(call?.kind === "tool" && call.call.done).toBe(true);
    expect(call?.kind === "tool" && call.call.view.kind).toBe("bash");
    // ...and the result does not also render on its own.
    expect(seqsOf(history)).not.toContain(301);
  });

  it("relativises a deep page's paths against the root the head page named", async () => {
    const root = event(0, {
      voice: "diag",
      kind: "workspace.created",
      text: null,
      payload: { dir: "/tmp/ryph-run-1/workspace" },
    });
    const reading = event(300, {
      kind: "tool_use",
      text: null,
      payload: {
        toolCallId: "c9",
        toolName: "read",
        args: { path: "/tmp/ryph-run-1/workspace/src/main.ts" },
      },
    });
    const all = [root, ...range(1, 299), reading, result(301, "c9"), ...range(302, 399)];
    const history = new RunHistory("run-1", fakeHistorian(all).fetch);
    history.seed(window([root, ...range(1, 49)], all.slice(-50)));

    await history.loadOlder();

    const call = history.rows.find((row) => row.kind === "tool" && row.call.seq === 300);
    // The root is a per-run temp directory nobody can read; what names the file is its path in
    // the repo, and only the head page has ever seen the event that says where the repo was.
    expect(call?.kind === "tool" && call.call.view.kind === "read" && call.call.view.path)
      .toBe("src/main.ts");
  });
});

describe("what a tail event leaves alone", () => {
  const use = (seq: number, id: string, name = "read") =>
    event(seq, {
      kind: "tool_use",
      text: null,
      payload: { toolCallId: id, toolName: name, args: { path: "/w/src/main.ts" } },
    });
  const result = (seq: number, id: string, text = "a\nb\nc") =>
    event(seq, {
      kind: "tool_result",
      text: "ok",
      payload: { toolCallId: id, result: { content: [{ type: "text", text }] } },
    });
  const callAt = (history: RunHistory, seq: number) => {
    const row = history.rows.find((r) => r.kind === "tool" && r.call.seq === seq);
    return row?.kind === "tool" ? row.call : null;
  };

  it("hands back the SAME call object for a call nothing has happened to", () => {
    // The live tail re-merges the newest page on every event it delivers. A call that is over —
    // its `tool_use` and its result both held, neither rewritten — must come out of that merge as
    // the object it already was: an equal-but-new one reaches an open row as a changed prop, and
    // the syntax highlighter tears its render down and rebuilds it, which is a card flashing back
    // to plain text and a transcript following the tail scrolling against the dip.
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), [...range(0, 9), use(10, "c1"), result(11, "c1")], false));

    const before = callAt(history, 10);
    expect(before?.view.kind).toBe("read");

    history.absorb(event(12)); // an unrelated event, on the same page
    history.absorb(event(13));

    expect(callAt(history, 10)).toBe(before);
  });

  it("...and a new one for the call whose result has just arrived", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), [...range(0, 9), use(10, "c1")], false));

    const inFlight = callAt(history, 10);
    expect(inFlight?.done).toBe(false);

    history.absorb(result(11, "c1"));

    const answered = callAt(history, 10);
    expect(answered).not.toBe(inFlight);
    expect(answered?.done).toBe(true);
    expect(answered?.view.kind).toBe("read");
  });

  it("keeps a page's calls when the page BELOW it grows", () => {
    // The page above the newest is re-merged too — its cache key carries the newest page's version,
    // because a call at its bottom can be answered at the top of the one below.
    const history = new RunHistory("run-1");
    const tail = [...range(200, 208), use(209, "c1"), result(210, "c1"), ...range(211, 399)];
    history.seed(window(range(0, 49), tail, false));

    const before = callAt(history, 209);
    expect(before).not.toBeNull();

    history.absorb(event(400)); // the tail rolls onto a new page
    history.absorb(event(401));

    expect(callAt(history, 209)).toBe(before);
  });
});

describe("the run's detail", () => {
  it("puts the result last, after every event", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, 9), false));
    history.setDetail({ ...detail, result: success, egressNote: "blocked example.com" });

    const last = history.rows.at(-1);
    expect(last?.kind).toBe("result");
    expect(last?.kind === "result" && last.result).toBe(success);
    expect(last?.kind === "result" && last.egressNote).toBe("blocked example.com");
  });

  it("puts the live row after everything while the run is going", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, 9), false));
    history.setDetail({ ...detail, live: true });
    expect(history.rows.at(-1)?.kind).toBe("live");
  });

  it("hides the closing message the result was taken from", () => {
    const closing = event(9, { payload: { final: true }, text: "Did the thing." });
    const history = new RunHistory("run-1");
    history.seed(window([...range(0, 8), closing], [...range(0, 8), closing], false));

    // Without a result there is nothing for it to be a duplicate of, so it stays.
    expect(seqsOf(history)).toContain(9);
    history.setDetail({ ...detail, result: success });
    expect(seqsOf(history)).not.toContain(9);
    expect(history.rows.at(-1)?.kind).toBe("result");
  });

  it("hides it when the mark is an event of its own naming the seq", () => {
    // What the runner actually emits: a transcript event of kind `final` whose payload names the
    // seq of the assistant message the summary was taken off.
    const closing = event(8, { text: "Did the thing." });
    const mark = event(9, { kind: "final", text: null, payload: { seq: 8 } });
    const history = new RunHistory("run-1");
    const events = [...range(0, 7), closing, mark];
    history.seed(window(events, events, false));

    // The marker is machinery and is never a row, result or no result.
    expect(seqsOf(history)).not.toContain(9);
    expect(seqsOf(history)).toContain(8);

    history.setDetail({ ...detail, result: success });
    expect(seqsOf(history)).not.toContain(8);
  });

  it("a run recorded before the mark existed keeps its closing message", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, 9), false));
    history.setDetail({ ...detail, result: success });
    expect(seqsOf(history)).toContain(9);
  });

  it("drops an inbox message into the page whose stretch of time holds it", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(2_300, 2_499)));
    history.setDetail({ ...detail, messages: [message(1, AT(2_350))] });

    const rows = history.rows;
    const at = rows.findIndex((row) => row.kind === "message");
    expect(at).toBeGreaterThan(0);
    // In the tail page, between the events either side of it in time — not at the top of the run.
    const before = rows[at - 1];
    expect(before.kind === "event" && before.event.seq).toBe(2_350);
  });

  it("keeps a diag event out of the rows until diagnostics are asked for", () => {
    const noisy = event(5, { voice: "diag", kind: "workspace.created" });
    const history = new RunHistory("run-1");
    const events = [...range(0, 4), noisy, ...range(6, 9)];
    history.seed(window(events, events, false));

    expect(seqsOf(history)).not.toContain(5);
    history.showDiag = true;
    expect(seqsOf(history)).toContain(5);
  });

  it("leaves out the framed copy of a message, which the message's own row already shows", () => {
    const framed = event(5, { kind: "inbound", payload: { seq: 3, kind: "chat" } });
    const wake = event(7, { kind: "inbound", payload: { kind: "system", wake: {} } });
    const history = new RunHistory("run-1");
    const events = [...range(0, 4), framed, event(6), wake, ...range(8, 9)];
    history.seed(window(events, events, false));

    expect(seqsOf(history)).not.toContain(5);
    // A wake-up is in no inbox, so its framed copy is all there is of it.
    expect(seqsOf(history)).toContain(7);
  });

  it.each(["exited", "ready"])(
    "draws a background command's %s notice as its own row",
    (reason) => {
      const notice = event(5, {
        kind: "inbound",
        payload: {
          kind: "system",
          sender: { kind: "platform" },
          text: `bg-2 ${reason}`,
          payload: null,
          background: {
            id: "bg-2",
            label: "Test suite",
            reason,
            exitCode: reason === "ready" ? null : 1,
            signal: null,
            durationMs: 252_000,
          },
        },
      });
      const history = new RunHistory("run-1");
      const events = [...range(0, 4), notice, ...range(6, 7)];
      history.seed(window(events, events, false));

      const row = history.rows.find((r) => r.kind === "background");
      expect(row).toMatchObject({
        kind: "background",
        seq: 5,
        notice: {
          id: "bg-2",
          label: "Test suite",
          reason,
          exitCode: reason === "ready" ? null : 1,
        },
      });
      // Details retain both originals, even without a Commands record.
      expect(row?.kind === "background" && row.event).toEqual(notice);
      expect(history.expanded.size).toBe(0);
      // ...and not as the generic event row as well.
      expect(seqsOf(history)).not.toContain(5);
    },
  );
});

describe("routine machine notes", () => {
  const routine = [
    "created",
    "launched",
    "bootstrap-redeemed",
    "first-heartbeat",
    "credentials-issued",
    "phase-changed",
    "attended",
    "result-received",
    "skills.root",
    "skills.repo",
  ];
  const machines = (history: RunHistory) =>
    history.rows.flatMap((row) => row.kind === "machine" ? row.events.map((e) => e.kind) : []);

  it.each([false, true])(
    "restores lifecycle notes with diagnostics (loaded pages: %s)",
    (loaded) => {
      const history = new RunHistory("run-1");
      if (loaded) history.seed(window([event(0)], [event(0)], false));
      history.setDetail({
        ...detail,
        lifecycle: routine.map((kind, i) => lifecycle(kind, AT(i + 1))),
      });
      expect(machines(history)).toEqual([]);
      history.showDiag = true;
      expect(machines(history)).toEqual(routine);
      history.showDiag = false;
      expect(machines(history)).toEqual([]);
      history.showDiag = true;
      expect(machines(history)).toEqual(routine);
    },
  );

  it("filters system notes in cached pages without changing activity or the history cursor", () => {
    const history = new RunHistory("run-1");
    const events = [
      event(0, { kind: "system", text: "session" }),
      event(1, { kind: "system", text: "agent_start" }),
      event(2, { kind: "system", text: "compaction_start" }),
      event(3, { kind: "system", text: "compaction_end", payload: { aborted: false } }),
      event(4, { kind: "system", text: "context_usage" }),
    ];
    history.seed(window(events, events, false));
    expect(history.rows).toEqual([]);
    expect(history.lastSpoken?.seq).toBe(1);
    history.showDiag = true;
    expect(machines(history)).toEqual([
      "session",
      "agent_start",
      "compaction_start",
      "compaction_end",
    ]);
    history.showDiag = false;
    expect(history.rows).toEqual([]);
    expect(history.lastSpoken?.seq).toBe(1);
    expect(history.lastSeq).toBe(4);
  });

  it.each([{ errorMessage: "compaction failed" }, { aborted: true }])(
    "keeps unsuccessful compaction visible: %j",
    (payload) => {
      const history = new RunHistory("run-1");
      history.absorb(event(0, { kind: "system", text: "compaction_end", payload }));
      expect(machines(history)).toEqual(["compaction_end"]);
      expect(history.lastSpoken).toBeNull();
      history.showDiag = true;
      expect(machines(history)).toEqual(["compaction_end"]);
    },
  );

  it("keeps warnings, work milestones and unknown machine notes with either toggle setting", () => {
    const history = new RunHistory("run-1");
    const milestones = ["provisioning", "cancel-requested", "patch-created", "future-event"];
    history.setDetail({
      ...detail,
      lifecycle: [
        ...milestones.map((kind, i) => lifecycle(kind, AT(i))),
        ...[
          "limit-reached",
          "base-stale",
          "skills.dropped",
          "skills.stale",
          "browser.unavailable",
          "setup.failed",
        ]
          .map((kind, i) => lifecycle(kind, AT(i + 10), "warning")),
      ],
    });
    history.absorb(event(0, { kind: "system", text: "retry" }));
    history.absorb(event(1, { kind: "system", text: "finished" }));
    const rows = history.rows;
    expect(machines(history)).toEqual(expect.arrayContaining([...milestones, "retry", "finished"]));
    expect(kindsOf(history)).toEqual(
      expect.arrayContaining(["limit", "stale", "skills", "browser", "setup"]),
    );
    history.showDiag = true;
    expect(history.rows).toEqual(rows);
    history.showDiag = false;
    expect(history.rows).toEqual(rows);
  });
});

describe("a run with no history of its own", () => {
  // Queued, provisioning, waiting on an environment build, or dead before the runner ever started:
  // the historian has nothing, and everything that HAS happened arrives with the task detail.
  const empty = window([], [], false);

  it("draws the lifecycle trail and the inbox when there are no pages at all", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [lifecycle("created", AT(1)), lifecycle("provisioning", AT(2))],
      messages: [message(1, AT(3))],
      live: true,
    });

    expect(kindsOf(history)).toEqual(["machine", "message", "live"]);
    expect(history.bare).toBe(false);
  });

  it("is bare when only routine machine notes have happened", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    expect(history.bare).toBe(true);
    history.setDetail({ ...detail, live: true });
    // A spinner is not a transcript.
    expect(history.bare).toBe(true);
    history.setDetail({ ...detail, lifecycle: [lifecycle("created", AT(1))], live: true });
    expect(history.bare).toBe(true);
    history.showDiag = true;
    expect(history.bare).toBe(false);
  });

  it("puts the result under the trail when a run died before it recorded anything", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [lifecycle("created", AT(1)), lifecycle("launched", AT(2))],
      result: {
        status: "error",
        reason: "the image would not pull",
        during: "booting",
        branches: [],
      },
    });

    expect(kindsOf(history)).toEqual(["result"]);
    history.showDiag = true;
    expect(kindsOf(history)).toEqual(["machine", "result"]);
  });

  it("keeps the trail in time order beside the events once a page does arrive", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 4), range(0, 4), false));
    history.setDetail({ ...detail, lifecycle: [lifecycle("result-received", AT(9))] });

    expect(kindsOf(history).at(-1)).toBe("event");
    history.showDiag = true;
    // Later than every event, so it sorts to the end of the page it was placed in.
    expect(kindsOf(history).at(-1)).toBe("machine");
  });
});

describe("the mark on the message the summary came from", () => {
  const marker = (seq: number, names: number | null, over: Record<string, unknown> = {}) =>
    event(seq, { kind: "final", text: null, payload: { seq: names, ...over } });

  const errored: RunnerResult = {
    status: "error",
    reason: "the run died",
    during: "running",
    branches: [],
  };

  it("keeps the closing message when the result carries no summary to replace it", () => {
    // An `error` result has a reason and no summary: hiding the agent's last words would take the
    // only account of what happened off the page.
    const history = new RunHistory("run-1");
    const events = [...range(0, 8), marker(9, 8)];
    history.seed(window(events, events, false));
    history.setDetail({ ...detail, result: errored });

    expect(seqsOf(history)).toContain(8);
    expect(seqsOf(history)).not.toContain(9);
  });

  it("keeps it when the summary is empty", () => {
    const history = new RunHistory("run-1");
    const events = [...range(0, 8), marker(9, 8)];
    history.seed(window(events, events, false));
    history.setDetail({
      ...detail,
      result: { status: "success", branches: [], summary: "   ", images: [] },
    });

    expect(seqsOf(history)).toContain(8);
  });

  it("takes the LAST mark as the run's word, and a mark that names nothing hides nothing", () => {
    // A run that ends through `finish` takes its summary from there, so the core
    // supersedes the mark it made on the closing message.
    const history = new RunHistory("run-1");
    const events = [...range(0, 7), marker(8, 7), marker(9, null)];
    history.seed(window(events, events, false));
    history.setDetail({ ...detail, result: success });

    expect(seqsOf(history)).toContain(7);
    // Neither marker is ever a row.
    expect(seqsOf(history)).not.toContain(8);
    expect(seqsOf(history)).not.toContain(9);
  });

  it("reads `superseded` the same way", () => {
    const history = new RunHistory("run-1");
    const events = [...range(0, 7), marker(8, 7), marker(9, 7, { superseded: true })];
    history.seed(window(events, events, false));
    history.setDetail({ ...detail, result: success });

    expect(seqsOf(history)).toContain(7);
  });

  it("an earlier mark arriving later does not unseat the last one", async () => {
    // Pages are loaded in whatever order the reader scrolls, so "last" is by seq, not by arrival:
    // here the retraction is what the tail carries, and the mark it retracts only turns up when
    // somebody scrolls back far enough to fetch the page it sits on.
    const all = [
      ...range(0, 300),
      event(301, { text: "Did the thing." }),
      marker(302, 301),
      ...range(303, 399),
      marker(400, null),
    ];
    const history = new RunHistory("run-1", fakeHistorian(all).fetch);
    history.seed(window(range(0, 9), all.slice(-2)));
    history.setDetail({ ...detail, result: success });
    expect(history.rows.some((row) => row.kind === "result")).toBe(true);

    // The older page lands, carrying the mark that named seq 301.
    await history.loadGap(399);

    // The retraction is still the run's last word, so the message it un-named is drawn.
    expect(seqsOf(history)).toContain(301);
    expect(seqsOf(history)).not.toContain(302);
  });

  it("finds a mark the live tail left on an earlier page", () => {
    // The tail rolls to a new page every 200 events and the runner keeps narrating after the mark,
    // which used to strand it: the marker drew as a junk row and the message was said twice.
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, OLDER_PAGE - 3), false));
    const closing = OLDER_PAGE - 2;
    history.absorb(event(closing, { text: "Did the thing." }));
    history.absorb(marker(closing + 1, closing));
    for (let seq = closing + 2; seq < closing + 8; seq++) {
      history.absorb(event(seq, { voice: "diag", kind: "heartbeat" }));
    }
    history.setDetail({ ...detail, result: success });

    expect(seqsOf(history)).not.toContain(closing);
    expect(seqsOf(history)).not.toContain(closing + 1);
    // ...and the marker is not a row even with diagnostics on.
    history.showDiag = true;
    expect(seqsOf(history)).not.toContain(closing + 1);
  });
});

describe("pages in flight", () => {
  it("holds two gaps at once without either losing its answer", async () => {
    const historian = heldHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    // Two holes, and both of them real: a gap is only ever the stretch above a loaded page, so a
    // second one needs a second page to sit above — here the stretch the load closed in the
    // middle, with the tail out of its reach.
    history.seed({
      head: page(range(0, 49), true),
      middle: page(range(400, 499), true),
      tail: page(range(800, 999), true),
    });
    expect(gapsOf(history)).toEqual([
      { before: 400, count: 350 },
      { before: 800, count: 300 },
    ]);

    const top = history.loadGap(800);
    const middle = history.loadGap(400); // the hole below the reader, scrolled into
    expect(historian.pending).toEqual([800, 400]);

    await historian.release(400);
    await historian.release(800);
    await Promise.all([top, middle]);

    expect(seqsOf(history)).toContain(799); // the 800 page landed
    expect(seqsOf(history)).toContain(399); // ...and so did the 400 one
    expect(history.loadingOlder).toBe(false);
  });

  it("a page in flight when a retry lands stays in the run it was asked for", async () => {
    const historian = heldHistorian(range(0, 999));
    const abandoned = new RunHistory("run-1", historian.fetch);
    abandoned.seed(window(range(0, 49), range(800, 999)));

    const inFlight = abandoned.loadGap(800);
    // The retry: a history of its own, and the page still in flight belongs to neither it nor the
    // transcript now on screen. Sharing one history is what made the seqs collide.
    const retry = new RunHistory("run-2");
    retry.seed(window(range(0, 9), range(0, 9), false));
    await historian.release(800);
    await inFlight;

    expect(seqsOf(retry)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seqsOf(abandoned)).toContain(799);
    expect(abandoned.loadingOlder).toBe(false);
  });

  it("takes the tail while a page above is still in flight", async () => {
    const historian = heldHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));

    const inFlight = history.loadGap(800);
    history.absorb(event(1_000));
    await historian.release(800);
    await inFlight;

    expect(history.lastSeq).toBe(1_000);
    expect(seqsOf(history).at(-1)).toBe(1_000);
    expect(seqsOf(history)).toContain(799);
  });
});

describe("holes that turn out to be empty", () => {
  it("widens the first page down to the start of the run", async () => {
    // Nothing above the oldest page and no head page either: the widened page becomes the head.
    const historian = fakeHistorian(range(500, 999));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed({ head: page([], false), tail: page(range(800, 999), true) });

    await history.loadGap(800);
    expect(gapsOf(history)).toEqual([{ before: 600, count: 600 }]);
    await history.loadGap(600);

    // 500..599 came back, and there is genuinely nothing below it.
    expect(gapsOf(history)).toEqual([]);
    expect(history.hasOlder).toBe(false);
    expect(seqsOf(history)[0]).toBe(500);
  });

  // The memos are filed under a page's `firstSeq`, and closing a gap moves it: the entry under the
  // old range is dropped with it, so it can never be handed to whatever page starts there next.
  it("keeps drawing a page whose range moved under it", async () => {
    const historian = fakeHistorian(range(0, 49));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));
    // Draw once, so the page at 800 has rows filed under 800.
    expect(seqsOf(history)).toContain(800);

    await history.loadGap(800); // nothing there: the page at 800 widens down to 50
    expect(gapsOf(history)).toEqual([]);

    // The rows still describe the page, whatever its range is called now.
    history.showDiag = true;
    expect(seqsOf(history)).toContain(800);
    expect(seqsOf(history)).toContain(49);
  });

  it("closes a gap whose page turns out to be covered at both ends", async () => {
    const historian = fakeHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    // The head already holds 0..49 and the tail 50..999: the page asked for is wholly inside them.
    history.seed({ head: page(range(0, 49), true), tail: page(range(50, 999), true) });
    const before = seqsOf(history).length;

    await history.loadGap(60);

    expect(seqsOf(history)).toHaveLength(before);
    expect(gapsOf(history)).toEqual([]);
  });
});

describe("eviction under a live tail", () => {
  it("caps the pages a long watch holds, not just the ones scrolled back to", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 9), range(0, 9), false));
    history.noteViewport(0);

    // A day of watching: one page per OLDER_PAGE events, and nobody has scrolled anywhere.
    let seq = 10;
    for (let i = 0; i < (MAX_PAGES + 8) * OLDER_PAGE; i++) history.absorb(event(seq++));

    const gaps = gapsOf(history);
    expect(gaps.length).toBeGreaterThan(0); // pages went, and said so
    expect(history.lastSeq).toBe(seq - 1); // the tail still lands
    expect(seqsOf(history)[0]).toBe(0); // the head is still pinned
  });
});

describe("asking for what is not there", () => {
  // The two rules that fetch older pages by themselves — the dead end at the top of the document,
  // and a gap row coming into view — both fire on a scroll frame, and on a run shorter than one
  // fold both are true from the moment the page opens and stay true. What stops that being a
  // request is that there is nothing to request; what stops it being a "Loading…" row is this.
  it("fetches nothing, and says nothing is loading, on a run with no hole in it", async () => {
    const historian = fakeHistorian(range(0, 9));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 9), range(0, 9), false));

    expect(history.hasOlder).toBe(false);
    await history.loadOlder();
    await history.loadOlder();

    expect(historian.asked).toEqual([]);
    expect(history.loadingOlder).toBe(false);
    expect(gapsOf(history)).toEqual([]);
  });

  it("refuses an anchor that names no hole", async () => {
    const historian = fakeHistorian(range(0, 999));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed(window(range(0, 49), range(800, 999)));

    // 900 is inside the tail page and 60 is inside no page at all: neither is the top of a hole,
    // and a fetch for either would put an anchor in flight that no gap row could ever draw —
    // `loadingOlder` set over a transcript with nothing to load, and the virtualiser told to hold
    // the viewport still for a page that will insert nothing.
    await history.loadGap(900);
    await history.loadGap(60);

    expect(historian.asked).toEqual([]);
    expect(history.loadingOlder).toBe(false);
    expect(gapsOf(history)).toEqual([{ before: 800, count: 750 }]);
  });

  it("refuses the anchor of a hole that has just been closed", async () => {
    // The head holds 0..49 and the tail 60..999, so ten events are missing — and the historian
    // turns out to have none of them, which widens the tail page down to meet the head. The
    // sentinel that asked is still on screen for the frame after; asking again must cost nothing.
    const historian = fakeHistorian(range(0, 49));
    const history = new RunHistory("run-1", historian.fetch);
    history.seed({ head: page(range(0, 49), true), tail: page(range(60, 999), true) });
    expect(gapsOf(history)).toEqual([{ before: 60, count: 10 }]);

    await history.loadGap(60);
    expect(gapsOf(history)).toEqual([]);
    expect(history.hasOlder).toBe(false);

    await history.loadGap(60);
    expect(historian.asked).toEqual([60]);
    expect(history.loadingOlder).toBe(false);
  });
});

describe("a window one of whose reads did not answer", () => {
  // The load re-runs every three seconds on a live run and makes three or four reads each time, so
  // a gateway being rolled under it will answer one of them 503 sooner or later. That used to be
  // the whole page. What a read that did not answer costs now is its own page of the window.
  it("takes nothing from a first window that arrived without its tail", () => {
    const history = new RunHistory("run-1");
    history.seed({ head: page(range(0, 49), true), error: "request failed (503)" });

    // Not seeded, so the page draws its retry — and so the NEXT window is still a first one.
    expect(history.seeded).toBe(false);
    expect(history.rows).toEqual([]);
    expect(history.lastSeq).toBe(-1);
  });

  it("seeds properly from the next window, once one arrives whole", () => {
    const history = new RunHistory("run-1");
    history.seed({ head: page(range(0, 49), true), error: "request failed (503)" });
    history.seed(window(range(0, 49), range(800, 999)));

    expect(history.seeded).toBe(true);
    expect(seqsOf(history).at(0)).toBe(0);
    expect(seqsOf(history).at(-1)).toBe(999);
    expect(gapsOf(history)).toEqual([{ before: 800, count: 750 }]);
  });

  it("seeds a window that arrived without its HEAD, and says the start is not loaded", () => {
    // The tail is the end of the run, which is where the page opens and what everything else is
    // placed against; the head is fifty events of booting up and the checkout path. Missing, the
    // run simply starts above what is loaded — which is a gap row, and a thing the transcript
    // already knows how to say and to fetch.
    const history = new RunHistory("run-1");
    history.seed({ tail: page(range(800, 999), true), error: "request failed (503)" });

    expect(history.seeded).toBe(true);
    expect(seqsOf(history).at(-1)).toBe(999);
    expect(gapsOf(history)).toEqual([{ before: 800, count: 800 }]);
    expect(history.hasOlder).toBe(true);
  });

  it("keeps the rows the reader is looking at when a RE-load comes back empty-handed", () => {
    const history = new RunHistory("run-1");
    history.seed(window(range(0, 49), range(800, 999)));
    history.absorb(event(1_000));
    const before = history.rows;

    history.seed({ head: page(range(0, 49), true), error: "request failed (503)" });

    expect(history.rows).toEqual(before);
    expect(history.lastSeq).toBe(1_000);
    expect(history.seeded).toBe(true);
  });

  it("leaves the hole as a gap row when only the middle read failed", () => {
    // The load asks for the middle to keep a short run's gap row off the first screen. Without it
    // the hole is simply a hole, which is the shape every longer run has anyway.
    const history = new RunHistory("run-1");
    history.seed({ head: page(range(0, 49), true), tail: page(range(220, 419), true) });

    expect(history.seeded).toBe(true);
    expect(gapsOf(history)).toEqual([{ before: 220, count: 170 }]);
  });
});

describe("a reached limit", () => {
  const empty = window([], [], false);

  it("is its own row, never folded into the grey run events", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [
        lifecycle("created", AT(1)),
        lifecycle("limit-reached", AT(2), "spend: $20.00"),
        lifecycle("cancel-requested", AT(3)),
      ],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["limit", "machine", "live"]);
    const row = history.rows[0];
    expect(row.kind === "limit" && row.detail).toBe("spend: $20.00");
  });

  it("is joined by a base served from the forge's cache, which is its own row too", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [
        lifecycle("phase-changed", AT(1), "cloning"),
        lifecycle("base-stale", AT(2), "`web/` (acme/web) started from `main` at 1a2b3c4"),
        lifecycle("phase-changed", AT(3), "preparing"),
      ],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["stale", "live"]);
    const row = history.rows[0];
    expect(row.kind === "stale" && row.detail).toBe(
      "`web/` (acme/web) started from `main` at 1a2b3c4",
    );
  });

  it("is joined by skills the run lost and org skills behind the repo, each its own row", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [
        lifecycle("created", AT(1)),
        lifecycle("skills.dropped", AT(2), "release (org): the name is already taken"),
        lifecycle("skills.stale", AT(3), "the org skills came from acme/skills at 1a2b3c4d5e6f"),
        lifecycle("skills.repo", AT(4), "deploy (`api/`)"),
      ],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["skills", "skills", "live"]);
    const [dropped, stale] = [history.rows[0], history.rows[1]];
    expect(dropped.kind === "skills" && [dropped.what, dropped.detail]).toEqual([
      "dropped",
      "release (org): the name is already taken",
    ]);
    expect(stale.kind === "skills" && stale.what).toBe("stale");
  });

  it("is joined by a browser the run started without, its own row", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    const why = "the agent has a browser, but this deployment runs none (RYPH_BROWSER_IMAGE is " +
      "unset or off), so this run started without one";
    history.setDetail({
      ...detail,
      lifecycle: [lifecycle("created", AT(1)), lifecycle("browser.unavailable", AT(2), why)],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["browser", "live"]);
    const row = history.rows[0];
    expect(row.kind === "browser" && row.detail).toBe(why);
  });

  it("is joined by a conversation the run could not post in, its own row", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [lifecycle("created", AT(1)), lifecycle("chat.unbound", AT(2), "it was busy")],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["unbound", "live"]);
    const row = history.rows[0];
    expect(row.kind === "unbound" && row.detail).toBe("it was busy");
  });

  it("is joined by a setup that did not finish, its own row with the output apart", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    const summary = "`web/`: step 2 of 3 (install deps) exited with code 1, so the step after " +
      "it was skipped, and the run went on.";
    history.setDetail({
      ...detail,
      lifecycle: [
        lifecycle("created", AT(1)),
        lifecycle("setup.failed", AT(2), `[step] ${summary}\nnpm ERR! one\nnpm ERR! two`),
        lifecycle("setup.failed", AT(3), `[step] ${summary}`),
      ],
      live: true,
    });
    expect(kindsOf(history)).toEqual(["setup", "setup", "live"]);
    const [withOutput, silent] = history.rows;
    expect(withOutput.kind === "setup" && withOutput.summary).toBe(summary);
    expect(withOutput.kind === "setup" && withOutput.output).toBe("npm ERR! one\nnpm ERR! two");
    expect(silent.kind === "setup" && silent.output).toBe("");
    expect(withOutput.kind === "setup" && withOutput.discarded).toBe(false);
  });

  it("marks a setup warning whose repo's setup finished as changes discarded, by its kind", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    history.setDetail({
      ...detail,
      lifecycle: [
        lifecycle("created", AT(1)),
        lifecycle(
          "setup.failed",
          AT(2),
          "[discarded] `api/`: changes left in it after setup failed in `web/` were discarded, " +
            "since they " +
            "could not be told apart from what the failed step did, and the run went on.",
        ),
        lifecycle(
          "setup.failed",
          AT(3),
          "[dirty] `web/`: setup.yml finished but left changes in the tree (`package-lock.json`), " +
            "which were discarded so they do not ship as work — add build output to .gitignore — " +
            "and the run went on.",
        ),
        // The kind decides, never the words: an untagged summary that reads like a discard is not.
        lifecycle(
          "setup.failed",
          AT(4),
          "`web/`: setup.yml finished but left changes in the tree, which were discarded.",
        ),
      ],
      live: true,
    });
    const [sibling, dirty, untagged] = history.rows;
    expect(sibling.kind === "setup" && sibling.discarded).toBe(true);
    expect(dirty.kind === "setup" && dirty.discarded).toBe(true);
    expect(dirty.kind === "setup" && dirty.summary.startsWith("`web/`:")).toBe(true);
    expect(untagged.kind === "setup" && untagged.discarded).toBe(false);
  });

  it("names the limit on the result row, and null when none ended the run", () => {
    const history = new RunHistory("run-1");
    history.seed(empty);
    const cancelled: RunnerResult = { status: "cancelled", branches: [], summary: "", images: [] };
    history.setDetail({
      ...detail,
      lifecycle: [lifecycle("limit-reached", AT(1), "wall-clock: 1h")],
      result: cancelled,
    });
    const result = history.rows.find((row) => row.kind === "result");
    expect(result?.kind === "result" && result.limit).toBe("wall-clock: 1h");

    history.setDetail({ ...detail, result: success });
    const plain = history.rows.find((row) => row.kind === "result");
    expect(plain?.kind === "result" && plain.limit).toBeNull();
  });
});

// A subagent's transcript is a lane of the run's history, drawn by the same class. Constructed
// without a lane it is the run's own, exactly as before.
describe("a subagent's lane", () => {
  const laneEvent = (seq: number, over: Partial<HistoryEvent> = {}) =>
    event(seq, { lane: "sa-1", ...over });

  it("is the run's own transcript unless a lane is named", () => {
    expect(new RunHistory("run-1").lane).toBe("");
    expect(new RunHistory("run-1", fetch, () => null, { lane: "sa-2" }).lane).toBe("sa-2");
  });

  it("reads older pages from its own lane", async () => {
    const asked: string[] = [];
    const events = Array.from({ length: 400 }, (_, i) => laneEvent(i + 1));
    const f = ((input: string | URL | Request) => {
      const url = new URL(String(input), "http://x");
      asked.push(url.searchParams.get("lane") ?? "");
      const before = Number(url.searchParams.get("before"));
      const older = events.filter((e) => e.seq < before);
      const slice = older.slice(Math.max(0, older.length - OLDER_PAGE));
      return Promise.resolve(
        new Response(JSON.stringify(page(slice, older.length > OLDER_PAGE)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const history = new RunHistory("run-1", f, () => null, { lane: "sa-1" });
    history.seed(window(range(1, 10, { lane: "sa-1" }), range(380, 400, { lane: "sa-1" })));
    await history.loadOlder();
    expect(asked).toEqual(["sa-1"]);
  });

  // A subagent's lane counts from 1, so its first event is the start of the lane, not an event
  // after one that was never loaded.
  it("opens at its first event with nothing missing above it", () => {
    const history = new RunHistory("run-1", fetch, () => null, { lane: "sa-1" });
    history.absorb(laneEvent(1, { kind: "subagent.start" }));
    history.absorb(laneEvent(2));
    expect(history.rows.some((row) => row.kind === "gap")).toBe(false);
    expect(history.hasOlder).toBe(false);
  });

  it("the run's own lane, met first past its start, still says what is missing", () => {
    const history = new RunHistory("run-1");
    history.absorb(event(5));
    expect(history.rows[0]).toMatchObject({ kind: "gap", count: 5 });
  });

  it("takes the run's checkout when its own head names none", () => {
    const run = new RunHistory("run-1");
    run.seed(window(
      [event(0, {
        voice: "diag",
        kind: "workspace.created",
        payload: { dir: "/tmp/ryph-x" },
      })],
      [event(0)],
      false,
    ));
    expect(run.root).toBe("/tmp/ryph-x");
    const lane = new RunHistory("run-1", fetch, () => null, {
      lane: "sa-1",
      root: () => run.root,
    });
    lane.seed(window([laneEvent(1)], [laneEvent(1)], false));
    expect(lane.root).toBe("/tmp/ryph-x");
  });

  it("draws its marks as events of their own", () => {
    const history = new RunHistory("run-1", fetch, () => null, { lane: "sa-1" });
    history.seed(window(
      [
        laneEvent(1, {
          kind: "subagent.start",
          payload: { id: "sa-1", label: "Find callers", mode: "explore", task: "Find them." },
        }),
        laneEvent(2, {
          kind: "subagent.end",
          text: null,
          payload: { id: "sa-1", reason: "answered", answerChars: 3, durationMs: 1_000 },
        }),
      ],
      [],
      false,
    ));
    expect(history.rows.map((row) => row.kind === "event" ? row.event.kind : row.kind)).toEqual([
      "subagent.start",
      "subagent.end",
    ]);
  });
});

// A subagent's end reaches the agent as a platform message, narrated as `inbound` with `subagent`
// beside its text, and is drawn as one line naming it rather than as the whole answer.
describe("a subagent's end notice", () => {
  it("is a row of its own, and any other inbound stays an event", () => {
    const history = new RunHistory("run-1");
    const notice = { id: "sa-2", label: "Find callers", reason: "answered", durationMs: 41_000 };
    history.seed(window(
      [
        event(0, {
          kind: "inbound",
          text: "Subagent sa-2 answered: …",
          payload: { kind: "system", sender: { kind: "platform" }, text: "…", subagent: notice },
        }),
        event(1, { kind: "inbound", text: "a wake-up", payload: { kind: "system", text: "x" } }),
      ],
      [],
      false,
    ));
    expect(history.rows.map((row) => row.kind)).toEqual(["subagent", "event"]);
    expect(history.rows[0]).toMatchObject({
      seq: 0,
      notice,
      event: { text: "Subagent sa-2 answered: …", payload: { text: "…" } },
    });
    expect(history.expanded.size).toBe(0);
  });
});
