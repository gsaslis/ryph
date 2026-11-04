// The HTTP surface, driven as a pure handler with fakes — no sockets. Covers the auth split
// (run bearer on ingest, user gate on reads), idempotent ingest acks, list pagination, and
// the SSE stream's replay → live-tail discipline.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeHistorianService } from "../src/core/service.ts";
import { memoryHistoryStore } from "./memory_store.ts";
import { memoryHistoryBus } from "../src/adapters/bus/memory.ts";
import { historianRoutes, MAX_INGESTS_IN_FLIGHT, MAX_PAGE_BYTES } from "../src/http/routes.ts";
import { MAX_INGEST_BYTES } from "../src/schema.ts";
import { LANE_SUMMARY_TEXT_MAX, MAX_SUBAGENT_LANES } from "../src/core/types.ts";
import type { HistorianService } from "../src/core/service.ts";

const RUN_TOKEN = "good-token";

/** A page of `GET /v1/runs/:id/events`, as much of it as these tests read. */
interface EventsPage {
  events: { seq: number }[];
  hasMore: boolean;
  firstSeq: number;
  lastSeq: number;
}
const eventsPage = async (res: Response) => await res.json() as EventsPage;

/** One turn of the timer queue — long enough for a stream's `start` to run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

function makeApp(
  opts: {
    terminal?: boolean;
    concludeGraceMs?: number;
    laneRefreshMs?: number;
    ingestDeadlineMs?: number;
    /** The one bearer the read gate takes. */
    reader?: string;
  } = {},
): {
  service: HistorianService;
  handle: (req: Request) => Promise<Response>;
  concludeRun: (runId: string) => void;
} {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const { routes, concludeRun } = historianRoutes({
    service,
    concludeGraceMs: opts.concludeGraceMs,
    ingestDeadlineMs: opts.ingestDeadlineMs,
    // No window by default, so each settle below sees its own refresh; the window has its own test.
    laneRefreshMs: opts.laneRefreshMs ?? 0,
    authenticateRunRead: (req) =>
      Promise.resolve(
        req.headers.get("authorization") === `Bearer ${opts.reader ?? "user-token"}`
          ? null
          : new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      ),
    authenticateRun: (req, runId) =>
      Promise.resolve(
        runId === "run-1" && req.headers.get("authorization") === `Bearer ${RUN_TOKEN}`,
      ),
    isRunTerminal: () => Promise.resolve(opts.terminal ?? false),
  });
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url);
      if (!match) continue;
      return await route.handler(req, match.pathname.groups as Record<string, string>);
    }
    return new Response("no route", { status: 404 });
  };
  return { service, handle, concludeRun };
}

function ingestRequest(events: unknown[], token = RUN_TOKEN, runId = "run-1"): Request {
  return new Request(`http://x/v1/runs/${runId}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

function wireEvent(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: { seq },
    ...overrides,
  };
}

test("ingest caps streamed bytes before JSON parsing, even without Content-Length", async () => {
  const { handle, service } = makeApp();
  for (const declared of [undefined, "1", String(MAX_INGEST_BYTES + 1)]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("界".repeat(200_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = new Headers({ authorization: `Bearer ${RUN_TOKEN}` });
    if (declared) headers.set("content-length", declared);
    const res = await handle(
      new Request("http://x/v1/runs/run-1/events", {
        method: "POST",
        headers,
        body,
      }),
    );
    assertEquals(res.status, 413);
    assert(cancelled);
  }
  // Exactly the byte ceiling is permitted, including whitespace not represented in the schema.
  const data = JSON.stringify({ events: [wireEvent(0)] });
  const res = await handle(
    new Request("http://x/v1/runs/run-1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_TOKEN}`, "content-type": "application/json" },
      body: data + " ".repeat(MAX_INGEST_BYTES - data.length),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await service.listEvents("run-1", "", {})).length, 1);
});

test("byte-bounded pages traverse long prose in both directions without gaps", async () => {
  const { handle } = makeApp();
  for (let seq = 0; seq < 20; seq++) {
    assertEquals(
      (await handle(ingestRequest([wireEvent(seq, { text: "界".repeat(128_000) })]))).status,
      200,
    );
  }
  for (const backwards of [false, true]) {
    let cursor = backwards ? 100 : -1;
    const seen: number[] = [];
    for (let page = 0; page < 20; page++) {
      const res = await handle(
        new Request(
          `http://x/v1/runs/run-1/events?${backwards ? "before" : "after"}=${cursor}`,
          { headers: { authorization: "Bearer user-token" } },
        ),
      );
      const raw = await res.text();
      assert(new TextEncoder().encode(raw).byteLength <= MAX_PAGE_BYTES);
      const body = JSON.parse(raw);
      const seqs = body.events.map((e: { seq: number }) => e.seq);
      assert(seqs.length > 0);
      if (backwards) seen.unshift(...seqs);
      else seen.push(...seqs);
      cursor = backwards ? body.firstSeq : body.lastSeq;
      if (!body.hasMore) break;
    }
    assertEquals(seen, Array.from({ length: 20 }, (_, i) => i));
  }
});

test("small-event pages grow read windows and preserve forward/backward cursors", async () => {
  const { handle, service } = makeApp();
  for (let start = 0; start < 1100; start += 100) {
    assertEquals(
      (await handle(ingestRequest(Array.from({ length: 100 }, (_, i) => wireEvent(start + i)))))
        .status,
      200,
    );
  }
  const listEvents = service.listEvents.bind(service);
  const limits: (number | undefined)[] = [];
  service.listEvents = (runId, lane, opts) => {
    limits.push(opts?.limit);
    return listEvents(runId, lane, opts);
  };
  for (const backwards of [false, true]) {
    let cursor = backwards ? 1100 : -1;
    const seen: number[] = [];
    for (let page = 0; page < 2; page++) {
      limits.length = 0;
      const res = await handle(
        new Request(
          `http://x/v1/runs/run-1/events?limit=1000&${backwards ? "before" : "after"}=${cursor}`,
          { headers: { authorization: "Bearer user-token" } },
        ),
      );
      const body = await eventsPage(res);
      const seqs = body.events.map((e: { seq: number }) => e.seq);
      assertEquals(seqs.length, page === 0 ? 1000 : 100);
      assertEquals(body.hasMore, page === 0);
      assertEquals(body.firstSeq, seqs[0]);
      assertEquals(body.lastSeq, seqs[seqs.length - 1]);
      assertEquals(limits, page === 0 ? [8, 16, 32, 64, 128, 256, 497] : [8, 16, 32, 64]);
      if (backwards) seen.unshift(...seqs);
      else seen.push(...seqs);
      cursor = backwards ? body.firstSeq : body.lastSeq;
    }
    assertEquals(seen, Array.from({ length: 1100 }, (_, i) => i));
  }
});

test("ingest requires the run bearer — unknown run and bad token answer alike", async () => {
  const { handle } = makeApp();

  const badToken = await handle(ingestRequest([wireEvent(0)], "wrong-token"));
  assertEquals(badToken.status, 401);
  const unknownRun = await handle(ingestRequest([wireEvent(0)], RUN_TOKEN, "run-nope"));
  assertEquals(unknownRun.status, 401);
});

/** An ingest whose body sends `head` and then waits for `finish`. */
function heldIngest(head: string) {
  let finish: (rest: string) => void = () => {};
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(head));
      finish = (rest) => {
        try {
          c.enqueue(new TextEncoder().encode(rest));
          c.close();
        } catch {
          // Cancelled by the route already.
        }
      };
    },
    pull() {
      pulled = true;
    },
  }, { highWaterMark: 0 });
  const req = new Request("http://x/v1/runs/run-1/events", {
    method: "POST",
    headers: { authorization: `Bearer ${RUN_TOKEN}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  return { req, finish: (rest: string) => finish(rest), pulled: () => pulled };
}

test("a run's ingests in flight are bounded, and the next is 429 unread", async () => {
  const { handle } = makeApp();
  const held = Array.from({ length: MAX_INGESTS_IN_FLIGHT }, () => heldIngest('{"events":'));
  const pending = held.map((h) => handle(h.req));
  await settle();
  const extra = heldIngest('{"events":');
  const busy = await handle(extra.req);
  assertEquals(busy.status, 429);
  assertEquals(extra.pulled(), false);
  held.forEach((h, i) => h.finish(JSON.stringify([wireEvent(i)]) + "}"));
  for (const res of await Promise.all(pending)) assertEquals(res.status, 200);
  assertEquals((await handle(ingestRequest([wireEvent(9)]))).status, 200);
});

test("an ingest still arriving at its deadline is cut off with a 408", async () => {
  const { handle } = makeApp({ ingestDeadlineMs: 50 });
  const drip = heldIngest('{"events":[');
  const res = await handle(drip.req);
  assertEquals(res.status, 408);
  // Its slot is given back.
  assertEquals((await handle(ingestRequest([wireEvent(0)]))).status, 200);
});

test("ingest stores a batch and acks a retry's duplicates", async () => {
  const { handle } = makeApp();

  const first = await handle(ingestRequest([wireEvent(0), wireEvent(1)]));
  assertEquals(first.status, 200);
  assertEquals(await first.json(), { accepted: 2, duplicates: 0 });

  const retry = await handle(ingestRequest([wireEvent(0), wireEvent(1), wireEvent(2)]));
  assertEquals(await retry.json(), { accepted: 1, duplicates: 2 });
});

test("ingest refuses malformed batches", async () => {
  const { handle } = makeApp();

  assertEquals((await handle(ingestRequest([]))).status, 400); // empty
  assertEquals((await handle(ingestRequest([{ seq: -1 }]))).status, 400); // not an event
  assertEquals(
    (await handle(ingestRequest([wireEvent(0, { voice: "opera" })]))).status,
    400,
  );
  const oversize = wireEvent(0, { payload: { blob: "x".repeat(70_000) } });
  assertEquals((await handle(ingestRequest([oversize]))).status, 400);
  // Wire defaults: level/text/payload may be omitted entirely.
  const minimal = await handle(
    ingestRequest([{ seq: 0, at: "2026-07-16T12:00:00.000Z", voice: "diag", kind: "pi.spawn" }]),
  );
  assertEquals(minimal.status, 200);
});

test("list requires the user gate and pages by after/limit", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2, 3].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );

  const denied = await handle(new Request("http://x/v1/runs/run-1/events"));
  assertEquals(denied.status, 401);

  const auth = { headers: { authorization: "Bearer user-token" } };
  const all = await handle(new Request("http://x/v1/runs/run-1/events", auth));
  assertEquals((await eventsPage(all)).events.length, 4);

  const page = await handle(new Request("http://x/v1/runs/run-1/events?after=1&limit=2", auth));
  const body = await eventsPage(page);
  assertEquals(body.events.map((e: { seq: number }) => e.seq), [2, 3]);
  assertEquals(body.lastSeq, 3);

  const bad = await handle(new Request("http://x/v1/runs/run-1/events?after=x", auth));
  assertEquals(bad.status, 400);

  const badLimit = await handle(new Request("http://x/v1/runs/run-1/events?limit=0", auth));
  assertEquals(badLimit.status, 400);
  const hugeLimit = await handle(new Request("http://x/v1/runs/run-1/events?limit=1001", auth));
  assertEquals(hugeLimit.status, 400);
});

// The route validated a `limit` it never applied, so a caller that omitted it got the whole run —
// and the only caller omitted it. `hasMore` is what lets that caller still collect everything.
test("list is bounded, and says when a page is not the end", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2, 3, 4].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );
  const auth = { headers: { authorization: "Bearer user-token" } };
  const page = async (query: string) =>
    await eventsPage(await handle(new Request(`http://x/v1/runs/run-1/events${query}`, auth)));

  const first = await page("?limit=2");
  assertEquals(first.events.map((e: { seq: number }) => e.seq), [0, 1]);
  assertEquals(first.hasMore, true);
  assertEquals(first.lastSeq, 1);

  const next = await page(`?after=${first.lastSeq}&limit=2`);
  assertEquals(next.events.map((e: { seq: number }) => e.seq), [2, 3]);
  assertEquals(next.hasMore, true);

  const last = await page(`?after=${next.lastSeq}&limit=2`);
  assertEquals(last.events.map((e: { seq: number }) => e.seq), [4]);
  assertEquals(last.hasMore, false, "a short page is the end");

  // An exact fit is the case a full-page heuristic gets wrong: 5 events, asked for in fives.
  const exact = await page("?limit=5");
  assertEquals(exact.events.length, 5);
  assertEquals(
    exact.hasMore,
    false,
    "an exactly-full page with nothing behind it is still the end",
  );

  // ...and one short of exact must not claim to be the end.
  const short = await page("?limit=4");
  assertEquals(short.hasMore, true);
});

// Opening a run at its tail: the reader asks for the newest page, then walks up by `before`.
// Every page still arrives ascending, so the only thing that changes direction is `hasMore`.
test("list pages backwards by before, ascending, with hasMore meaning older events exist", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2, 3, 4, 5].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );
  const auth = { headers: { authorization: "Bearer user-token" } };
  const page = async (query: string) =>
    await eventsPage(await handle(new Request(`http://x/v1/runs/run-1/events${query}`, auth)));

  // The tail page: "before everything" is how the app asks for the newest events.
  const tail = await page(`?before=${Number.MAX_SAFE_INTEGER}&limit=2`);
  assertEquals(tail.events.map((e: { seq: number }) => e.seq), [4, 5]);
  assertEquals(tail.firstSeq, 4);
  assertEquals(tail.lastSeq, 5);
  assertEquals(tail.hasMore, true, "older events exist");

  // ...and up, by the page's own firstSeq.
  const older = await page(`?before=${tail.firstSeq}&limit=2`);
  assertEquals(older.events.map((e: { seq: number }) => e.seq), [2, 3]);
  assertEquals(older.hasMore, true);

  const oldest = await page(`?before=${older.firstSeq}&limit=2`);
  assertEquals(oldest.events.map((e: { seq: number }) => e.seq), [0, 1]);
  assertEquals(oldest.firstSeq, 0);
  assertEquals(oldest.hasMore, false, "an exactly-full page at the head is still the head");

  // Off the head: an empty page reports the cursor it was asked from, for both ends.
  const empty = await page("?before=0&limit=2");
  assertEquals(empty.events, []);
  assertEquals(empty.firstSeq, 0);
  assertEquals(empty.lastSeq, 0);
  assertEquals(empty.hasMore, false);
});

test("a forward page reports firstSeq too, and the two cursors are mutually exclusive", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );
  const auth = { headers: { authorization: "Bearer user-token" } };

  const forward = await eventsPage(
    await handle(new Request("http://x/v1/runs/run-1/events?after=0&limit=2", auth)),
  );
  assertEquals(forward.firstSeq, 1);
  assertEquals(forward.lastSeq, 2);

  const exhausted = await eventsPage(
    await handle(new Request("http://x/v1/runs/run-1/events?after=2", auth)),
  );
  assertEquals(exhausted.events, []);
  assertEquals(exhausted.firstSeq, 2);
  assertEquals(exhausted.lastSeq, 2);

  const both = await handle(
    new Request("http://x/v1/runs/run-1/events?after=0&before=2", auth),
  );
  assertEquals(both.status, 400);

  const garbage = await handle(new Request("http://x/v1/runs/run-1/events?before=x", auth));
  assertEquals(garbage.status, 400);
  const fractional = await handle(new Request("http://x/v1/runs/run-1/events?before=1.5", auth));
  assertEquals(fractional.status, 400);
});

// The app opens a run at its tail with `before=<Number.MAX_SAFE_INTEGER>`. `seq` is int4, so
// that cursor reaches Postgres as an out-of-range bind parameter and takes the whole statement
// down — a 500 for the single most common read there is.
test("a cursor past int4 is clamped, not a failed query", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );
  const auth = { headers: { authorization: "Bearer user-token" } };
  const page = async (query: string) => {
    const res = await handle(new Request(`http://x/v1/runs/run-1/events${query}`, auth));
    assertEquals(res.status, 200, query);
    return await eventsPage(res);
  };

  const tail = await page(`?before=${Number.MAX_SAFE_INTEGER}&limit=2`);
  assertEquals(tail.events.map((e: { seq: number }) => e.seq), [1, 2]);
  assertEquals(tail.hasMore, true);

  // The other direction cannot 500 either — past every event is simply the end of the run.
  const past = await page(`?after=${Number.MAX_SAFE_INTEGER}`);
  assertEquals(past.events, []);
  assertEquals(past.hasMore, false);
  // The cursor an empty page reports is the one actually read, so it is a cursor that works.
  assertEquals(past.lastSeq, 2_147_483_647);

  // Below the bottom of the column is the same story from the other end.
  const under = await page(`?before=-${Number.MAX_SAFE_INTEGER}`);
  assertEquals(under.events, []);
  assertEquals(under.firstSeq, -1);
});

// The stream's cursor reaches the same int4 column, and a reconnecting EventSource presents
// whatever id it last saw — including one a client made up.
test("the stream clamps its cursor too, from the query and from Last-Event-ID", async () => {
  const { handle, service } = makeApp({ terminal: true });
  const asked: number[] = [];
  const listEvents = service.listEvents.bind(service);
  service.listEvents = (runId, lane, opts) => {
    if (opts?.after !== undefined) asked.push(opts.after);
    return listEvents(runId, lane, opts);
  };
  const auth = { authorization: "Bearer user-token" };

  const fromQuery = await handle(
    new Request(`http://x/v1/runs/run-1/events/stream?after=${Number.MAX_SAFE_INTEGER}`, {
      headers: auth,
    }),
  );
  await fromQuery.body?.cancel();
  const fromHeader = await handle(
    new Request("http://x/v1/runs/run-1/events/stream", {
      headers: { ...auth, "last-event-id": String(Number.MAX_SAFE_INTEGER) },
    }),
  );
  await fromHeader.body?.cancel();
  await settle();

  assert(asked.length >= 2, "both tails replayed");
  assert(
    asked.every((after) => after <= 2_147_483_647),
    `every replay cursor must fit int4, got ${asked.join(", ")}`,
  );
});

async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      // Comments (the open line, keepalives) are not events.
      if (!frame.startsWith(":")) frames.push(frame);
    }
  }
  await reader.cancel();
  return frames;
}

test("the stream opens with a comment before the replay is read, so its headers leave at once", async () => {
  const { handle, service } = makeApp();
  // A replay that never answers: whatever the stream says first, it says without it.
  service.listEvents = () => new Promise(() => {});
  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream", {
      headers: { authorization: "Bearer user-token" },
    }),
  );
  const reader = res.body!.getReader();
  assertEquals(new TextDecoder().decode((await reader.read()).value), ": open\n\n");
  await reader.cancel();
});

test("stream replays from `after`, then tails live events without duplicates", async () => {
  const { handle, service } = makeApp();
  const event = (seq: number) => ({
    lane: "",
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: null,
  });
  await service.ingest("run-1", [event(0), event(1)]);

  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream?after=0", {
      headers: { authorization: "Bearer user-token" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");

  // The live tail: a re-ingest of seq 1 (duplicate) plus fresh seq 2 — only 2 may arrive.
  await service.ingest("run-1", [event(1), event(2)]);

  const frames = await readFrames(res, 2);
  assertEquals(frames.length, 2);
  assertStringIncludes(frames[0], "id: 1");
  assertStringIncludes(frames[0], "event: history");
  assertStringIncludes(frames[0], '"text":"event 1"');
  assertStringIncludes(frames[1], "id: 2");
});

// The other half of "never misses, never duplicates". The dedup half is pinned above; this is the
// half the buffer exists for, and it only shows up in the window the replay query is open: the
// handler subscribes FIRST, so an event published while the store is being read lands in the buffer
// rather than nowhere. Deleting the buffer and sending live events straight through leaves every
// other test in this file green — nothing else ingests inside that window — and loses the whole
// replay, because a live event arriving first pushes `lastSent` past it and the dedup then discards
// the replay as already-seen. Parking the query is what holds the window open long enough to prove
// it.
test("an event published during the replay is buffered, not lost", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const event = (seq: number) => ({
    lane: "",
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: null,
  });
  await service.ingest("run-1", [event(0), event(1)]);

  let releaseReplay: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => (releaseReplay = resolve));
  let park = true;
  let didPark = false;
  const listEvents = service.listEvents.bind(service);
  service.listEvents = async (runId, lane, opts) => {
    if (park) {
      park = false;
      didPark = true;
      await parked;
    }
    return await listEvents(runId, lane, opts);
  };

  const { routes } = historianRoutes({
    service,
    authenticateRunRead: () => Promise.resolve(null),
    authenticateRun: () => Promise.resolve(true),
    isRunTerminal: () => Promise.resolve(false),
  });
  const stream = routes.find((r) => r.pattern.pathname.endsWith("/stream"))!;
  const res = await stream.handler(
    new Request("http://x/v1/runs/run-1/events/stream"),
    { id: "run-1" },
  ) as Response;
  for (let i = 0; !didPark && i < 100; i++) await settle();
  assert(didPark, "the replay query should have parked");

  // Published while the replay is still open — the exact window the buffer is for.
  await service.ingest("run-1", [event(2)]);
  releaseReplay!();

  // All three, in seq order, each exactly once.
  const frames = await readFrames(res, 3);
  assertEquals(frames.map((f) => f.split("\n")[0]), ["id: 0", "id: 1", "id: 2"]);
});

test("stream honors Last-Event-ID over the query param", async () => {
  const { handle, service } = makeApp();
  await service.ingest(
    "run-1",
    [0, 1, 2].map((seq) => ({
      lane: "",
      seq,
      at: "2026-07-16T12:00:00.000Z",
      voice: "transcript" as const,
      kind: "assistant",
      level: null,
      text: null,
      payload: null,
    })),
  );

  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream?after=0", {
      headers: { authorization: "Bearer user-token", "last-event-id": "1" },
    }),
  );
  const frames = await readFrames(res, 1);
  assertStringIncludes(frames[0], "id: 2");
});

test("a terminal run's stream replays, says done, and closes", async () => {
  const { handle, service } = makeApp({ terminal: true });
  await service.ingest("run-1", [{
    lane: "",
    seq: 0,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: null,
    payload: null,
  }]);

  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream", {
      headers: { authorization: "Bearer user-token" },
    }),
  );
  // Read to the end: the stream must actually close.
  const text = await res.text();
  assertStringIncludes(text, "id: 0");
  assertStringIncludes(text, "event: done");
  assert(text.endsWith("data: {}\n\n"));
});

test("a run concluding while watched closes its tail — after the runner's last batch", async () => {
  // The bug this guards: a run that goes terminal mid-watch announces nothing on the bus, so a
  // tail with no other signal idles on keepalives forever and its watchers never see the end.
  const { handle, service, concludeRun } = makeApp({ concludeGraceMs: 25 });
  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream", {
      headers: { authorization: "Bearer user-token" },
    }),
  );
  assertEquals(res.status, 200);

  // The host persisted the run in a terminal state and says so...
  concludeRun("run-1");
  // ...but the runner flushes its LAST batch on the way out, after its result. `done` must not
  // outrun it, or the record it promises is complete would be missing its ending.
  await service.ingest("run-1", [{
    lane: "",
    seq: 0,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: "the last word",
    payload: null,
  }]);

  const text = await res.text(); // resolves only once the tail actually hangs up
  assertStringIncludes(text, '"text":"the last word"');
  assertStringIncludes(text, "event: done");
  assert(text.indexOf("the last word") < text.indexOf("event: done"));
});

test("concluding a run nobody is watching is a no-op", () => {
  const { concludeRun } = makeApp();
  concludeRun("run-1"); // must not throw: the host fires this for every run, watched or not
  concludeRun("run-1"); // and idempotently
});

// The bug this guards, and the interleaving that reaches it. `stop()` runs from two places — the
// stream's `cancel`, and `hangUp` — so it can run twice: a watcher closes their tab while the grace
// callback is parked on its re-read, and when that read returns, the enqueue throws, `hangUp` runs,
// and `stop` fires a second time. The detach it calls closes over a Set that the first `stop`
// already removed from `tails`. Ungoverned, the second call deletes the map entry again — but by
// then the entry belongs to whoever opened a tail on this run in the meantime, and that tail is left
// open, subscribed, and unreachable by `concludeRun`. It would hang on keepalives forever.
test("a hung-up tail cannot swallow the conclusion of the tail that replaced it", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });

  // Park the grace callback's re-read, which is what gives the hang-up something to race against.
  let releaseReRead: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => (releaseReRead = resolve));
  let park = false;
  let didPark = false;
  const listEvents = service.listEvents.bind(service);
  service.listEvents = async (runId, lane, opts) => {
    if (park) {
      park = false;
      didPark = true;
      await parked;
    }
    return await listEvents(runId, lane, opts);
  };

  const { routes, concludeRun } = historianRoutes({
    service,
    concludeGraceMs: 5,
    authenticateRunRead: () => Promise.resolve(null),
    authenticateRun: () => Promise.resolve(true),
    isRunTerminal: () => Promise.resolve(false),
  });
  const stream = routes.find((r) => r.pattern.pathname.endsWith("/stream"))!;
  const open = async (): Promise<Response> => {
    const res = await stream.handler(
      new Request("http://x/v1/runs/run-1/events/stream"),
      { id: "run-1" },
    );
    // The handler returns as soon as the stream's `start` hits its first await, so the tail is not
    // registered yet. Everything below depends on it being registered, hence the settle.
    await settle();
    return res;
  };

  const a = await open();
  const readerA = a.body!.getReader();

  // A's run concludes: the grace timer fires and its re-read parks.
  park = true;
  concludeRun("run-1");
  for (let i = 0; !didPark && i < 100; i++) await settle();
  assert(didPark, "the grace callback's re-read should have parked");

  // A's watcher closes the tab while that re-read is still parked. stop() runs, once.
  await readerA.cancel();

  // B opens on the same run, registering under a Set of its own.
  const b = await open();

  // The parked read returns: A's callback resumes, its enqueue throws on the cancelled stream,
  // hangUp runs, and stop() fires a SECOND time. Its detach must not reach B's registration.
  await service.ingest("run-1", [{
    lane: "",
    seq: 0,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: "after the hang-up",
    payload: null,
  }]);
  releaseReRead!();
  await settle();

  // B is still watching, so B must still be told the run is over.
  concludeRun("run-1");
  const text = await Promise.race([
    new Response(b.body).text(),
    // Without the guard B is orphaned and this never resolves — fail loudly instead of hanging.
    new Promise<string>((r) => setTimeout(() => r("<tail orphaned: never concluded>"), 5_000)),
  ]);
  assertStringIncludes(text, "event: done");
});

// ---- lanes -------------------------------------------------------------------------------------

const userAuth = { authorization: "Bearer user-token" };

test("ingest takes a lane per event, and each lane keeps its own seqs and dedup", async () => {
  const { handle } = makeApp();

  const first = await handle(ingestRequest([
    wireEvent(1),
    wireEvent(1, { lane: "sa-1", kind: "subagent.start" }),
    wireEvent(1, { lane: "sa-2", kind: "subagent.start" }),
  ]));
  assertEquals(await first.json(), { accepted: 3, duplicates: 0 });
  const retry = await handle(ingestRequest([
    wireEvent(1, { lane: "sa-1" }),
    wireEvent(2, { lane: "sa-1" }),
    wireEvent(1, { lane: "" }),
  ]));
  assertEquals(await retry.json(), { accepted: 1, duplicates: 2 });

  // The main lane reads exactly as it did before lanes: absent and empty are the same lane.
  for (const query of ["", "?lane="]) {
    const page = await (await handle(
      new Request(`http://x/v1/runs/run-1/events${query}`, { headers: userAuth }),
    )).json() as { events: { seq: number; lane: string; kind: string }[] };
    assertEquals(page.events.map((e) => [e.lane, e.seq, e.kind]), [["", 1, "assistant"]]);
  }
  const child = await eventsPage(
    await handle(new Request("http://x/v1/runs/run-1/events?lane=sa-1", { headers: userAuth })),
  );
  assertEquals(child.events.map((e) => e.seq), [1, 2]);
  assertEquals([child.firstSeq, child.lastSeq, child.hasMore], [1, 2, false]);
  const backwards = await eventsPage(
    await handle(
      new Request("http://x/v1/runs/run-1/events?lane=sa-1&before=2", { headers: userAuth }),
    ),
  );
  assertEquals(backwards.events.map((e) => e.seq), [1]);
});

test('a lane that is not "" or sa-<n> is a 400, on ingest and on every read', async () => {
  const { handle } = makeApp();
  const bad = ["sa-0", "sa-01", "sa-17", "sa-20", "sa-160", "sa-9999", "sa-10000", "sa-"];
  for (const lane of [...bad, "main", "SA-1", " sa-1", "sa-1 ", 7]) {
    assertEquals((await handle(ingestRequest([wireEvent(0, { lane })]))).status, 400, `${lane}`);
  }
  for (const lane of [...bad, "x", "sa-1:2"]) {
    const q = encodeURIComponent(lane);
    for (const path of ["events", "events/stream"]) {
      const res = await handle(
        new Request(`http://x/v1/runs/run-1/${path}?lane=${q}`, { headers: userAuth }),
      );
      assertEquals(res.status, 400, `${path} ${lane}`);
      assertStringIncludes((await res.json() as { error: string }).error, "lane");
    }
  }
  // Every legal shape is taken: the main lane and sa-1 to sa-MAX_SUBAGENT_LANES.
  for (const lane of ["", ...Array.from({ length: MAX_SUBAGENT_LANES }, (_, i) => `sa-${i + 1}`)]) {
    assertEquals((await handle(ingestRequest([wireEvent(0, { lane })]))).status, 200, lane);
  }
});

test("a lane's stream replays and tails that lane only; the main stream never sees it", async () => {
  const { handle, service } = makeApp();
  const ev = (lane: string, seq: number) => ({
    lane,
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind: "assistant",
    level: null,
    text: `${lane || "main"} ${seq}`,
    payload: null,
  });
  await service.ingest("run-1", [ev("", 0), ev("sa-1", 1)]);

  const child = await handle(
    new Request("http://x/v1/runs/run-1/events/stream?lane=sa-1", { headers: userAuth }),
  );
  const main = await handle(
    new Request("http://x/v1/runs/run-1/events/stream", { headers: userAuth }),
  );
  await settle();
  // Live: one batch across both lanes, the same seq in each.
  await service.ingest("run-1", [ev("", 1), ev("sa-1", 2), ev("sa-2", 1)]);

  const childFrames = await readFrames(child, 2);
  assertEquals(childFrames.map((f) => f.split("\n")[0]), ["id: 1", "id: 2"]);
  assert(childFrames.every((f) => f.includes('"lane":"sa-1"')));
  const mainFrames = await readFrames(main, 2);
  assertEquals(mainFrames.map((f) => f.split("\n")[0]), ["id: 0", "id: 1"]);
  assert(mainFrames.every((f) => f.includes('"lane":""') && f.includes('"text":"main ')));
});

test("a lane's stream resumes from Last-Event-ID in that lane's counter, and ends with the run", async () => {
  const { handle, service, concludeRun } = makeApp({ concludeGraceMs: 5 });
  const ev = (lane: string, seq: number) => ({
    lane,
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind: "assistant",
    level: null,
    text: null,
    payload: null,
  });
  await service.ingest("run-1", [1, 2, 3, 4, 5].map((seq) => ev("", seq)));
  await service.ingest("run-1", [1, 2, 3].map((seq) => ev("sa-3", seq)));

  const res = await handle(
    new Request("http://x/v1/runs/run-1/events/stream?lane=sa-3", {
      headers: { ...userAuth, "last-event-id": "2" },
    }),
  );
  await settle();
  concludeRun("run-1");
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  const frames = text.split("\n\n").filter((f) => f !== "" && !f.startsWith(":"));
  assertEquals(frames.map((f) => f.split("\n")[0]), ["id: 3", "event: done"]);
});

test("GET /lanes lists each opened lane in order, under the same gate as /events", async () => {
  const { handle } = makeApp();
  const start = (lane: string, seq: number) =>
    wireEvent(seq, {
      lane,
      kind: "subagent.start",
      text: `label ${lane}`,
      payload: { id: lane, label: `label ${lane}`, mode: "work", task: "do it" },
    });
  const end = (lane: string, seq: number) =>
    wireEvent(seq, {
      lane,
      kind: "subagent.end",
      text: null,
      payload: { id: lane, reason: "answered", answerChars: 3, durationMs: 9 },
    });
  const resume = (lane: string, seq: number) =>
    wireEvent(seq, {
      lane,
      kind: "subagent.resume",
      text: "more",
      payload: { id: lane, message: "more" },
    });
  assertEquals(
    (await handle(ingestRequest([
      wireEvent(0),
      start("sa-2", 1),
      end("sa-2", 2),
      resume("sa-2", 3),
      start("sa-1", 1),
      wireEvent(2, { lane: "sa-1" }),
      end("sa-1", 3),
      start("sa-11", 1),
      wireEvent(1, { lane: "sa-5" }),
    ]))).status,
    200,
  );

  const denied = await handle(new Request("http://x/v1/runs/run-1/lanes"));
  assertEquals(denied.status, 401);

  const res = await handle(new Request("http://x/v1/runs/run-1/lanes", { headers: userAuth }));
  assertEquals(res.status, 200);
  const body = await res.json() as {
    lanes: {
      lane: string;
      start: { seq: number; kind: string; runId: string; lane: string; payload: unknown };
      resume: { seq: number } | null;
      end: { seq: number } | null;
      ranMs: number;
    }[];
  };
  assertEquals(body.lanes.map((l) => l.lane), ["sa-1", "sa-2", "sa-11"]);
  assertEquals(body.lanes.map((l) => l.ranMs), [9, 9, 0]);
  const [one, two, eleven] = body.lanes;
  assertEquals(
    [one.start.runId, one.start.lane, one.start.kind, one.start.payload],
    ["run-1", "sa-1", "subagent.start", {
      id: "sa-1",
      label: "label sa-1",
      mode: "work",
      task: "do it",
    }],
  );
  // ended / running again after a resume / running in its first stretch
  assertEquals([one.resume, one.end?.seq], [null, 3]);
  assertEquals([two.resume?.seq, two.end?.seq], [3, 2]);
  assertEquals([eleven.resume, eleven.end], [null, null]);

  // A run with no subagents lists none.
  const none = await handle(new Request("http://x/v1/runs/run-2/lanes", { headers: userAuth }));
  assertEquals(await none.json(), { lanes: [] });
});

// The run token is readable by the agent, so a lane's lifecycle events are the agent's to write: a
// summary goes to every viewer on every change, and carries only a clipped projection of them.
test("GET /lanes clips what it lists; the lane's own events keep it whole", async () => {
  const { handle } = makeApp();
  const long = "t".repeat(20_000);
  const start = wireEvent(1, {
    lane: "sa-1",
    kind: "subagent.start",
    text: "x".repeat(8_000),
    payload: { id: "sa-1", label: "l", mode: "work", task: long, junk: "j".repeat(30_000) },
  });
  const resume = wireEvent(2, {
    lane: "sa-1",
    kind: "subagent.resume",
    text: "m",
    payload: { id: "sa-1", message: long, nested: { deep: long } },
  });
  const end = wireEvent(3, {
    lane: "sa-1",
    kind: "subagent.end",
    text: null,
    payload: { id: "sa-1", reason: "answered", answerChars: 3, durationMs: 9, extra: [long] },
  });
  assertEquals((await handle(ingestRequest([start, resume, end]))).status, 200);

  const res = await handle(new Request("http://x/v1/runs/run-1/lanes", { headers: userAuth }));
  const raw = await res.text();
  assert(raw.length < 4 * LANE_SUMMARY_TEXT_MAX, `${raw.length} chars`);
  const [lane] = (JSON.parse(raw) as {
    lanes: {
      start: { text: string; payload: Record<string, unknown> };
      resume: { payload: Record<string, unknown> };
      end: { payload: Record<string, unknown> };
    }[];
  }).lanes;
  assertEquals(lane.start.text.length, LANE_SUMMARY_TEXT_MAX);
  assertEquals(Object.keys(lane.start.payload), ["id", "label", "mode", "task"]);
  assertEquals((lane.start.payload.task as string).length, LANE_SUMMARY_TEXT_MAX);
  assert((lane.start.payload.task as string).endsWith("…"));
  assertEquals(Object.keys(lane.resume.payload), ["id", "message"]);
  assertEquals(lane.end.payload, { id: "sa-1", reason: "answered", answerChars: 3, durationMs: 9 });

  const whole = await (await handle(
    new Request("http://x/v1/runs/run-1/events?lane=sa-1", { headers: userAuth }),
  )).json() as { events: { payload: { task?: string } }[] };
  assertEquals(whole.events[0].payload.task, long);
});

/** Reads an SSE body to its end and hands back its non-comment frames. */
async function readAll(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text.split("\n\n").filter((f) => f !== "" && !f.startsWith(":"));
}
const laneOf = (frame: string) =>
  frame.startsWith("event: lane\n")
    ? JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as {
      lane: string;
      resume: { seq: number } | null;
      end: { seq: number } | null;
      ranMs: number;
    }
    : null;

test("the lanes stream sends the listing, then each lane's fresh summary, then done", async () => {
  const { handle, service, concludeRun } = makeApp({ concludeGraceMs: 5 });
  const ev = (lane: string, seq: number, kind = "assistant") => ({
    lane,
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind,
    level: null,
    text: null,
    payload: null,
  });
  await service.ingest("run-1", [ev("sa-1", 1, "subagent.start"), ev("sa-1", 2)]);

  assertEquals((await handle(new Request("http://x/v1/runs/run-1/lanes/stream"))).status, 401);
  const res = await handle(
    new Request("http://x/v1/runs/run-1/lanes/stream", { headers: userAuth }),
  );
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  await settle();

  // Ordinary chunks, a diagnostic and the main lane change no summary: nothing is sent for them.
  await service.ingest("run-1", [
    ev("sa-1", 3),
    ev("", 1, "subagent.start"),
    { ...ev("sa-1", 4, "subagent.end"), voice: "diag" as const, level: "debug" as const },
  ]);
  await settle();
  // A second lane opens, the first ends; a retried batch changes nothing more.
  const ended = { ...ev("sa-1", 5, "subagent.end"), payload: { id: "sa-1", durationMs: 40 } };
  await service.ingest("run-1", [ev("sa-2", 1, "subagent.start"), ended]);
  await service.ingest("run-1", [ended]);
  await settle();
  await service.ingest("run-1", [ev("sa-1", 6, "subagent.resume")]);
  await settle();
  concludeRun("run-1");

  const frames = await readAll(res);
  assertEquals(frames.at(-1), "event: done\ndata: {}");
  const sent = frames.slice(0, -1).map(laneOf);
  assertEquals(sent.map((l) => l?.ranMs), [0, 40, 0, 40]);
  assertEquals(sent.map((l) => [l?.lane, l?.resume?.seq ?? null, l?.end?.seq ?? null]), [
    ["sa-1", null, null], // the listing on connect
    ["sa-1", null, 5], // one batch's signals, one read, sent in lane order
    ["sa-2", null, null],
    ["sa-1", 6, 5], // running again
  ]);
});

// Signals are ingest's, which the agent drives: however many arrive, one stream reads the listing
// at most once per window, and the last read still carries the latest of every lane.
test("the lanes stream reads its listing at most once per window, however many signals", async () => {
  const { handle, service, concludeRun } = makeApp({ concludeGraceMs: 5, laneRefreshMs: 150 });
  let reads = 0;
  const listLanes = service.listLanes.bind(service);
  service.listLanes = (runId) => {
    reads++;
    return listLanes(runId);
  };
  const ev = (lane: string, seq: number, kind: string) => ({
    lane,
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript" as const,
    kind,
    level: null,
    text: null,
    payload: { id: lane, durationMs: 1 },
  });
  await service.ingest("run-1", [ev("sa-1", 1, "subagent.start")]);
  const res = await handle(
    new Request("http://x/v1/runs/run-1/lanes/stream", { headers: userAuth }),
  );
  await settle();
  assertEquals(reads, 1);

  // Forty signals, one batch each, inside one window: one more read, at the window's end.
  const began = Date.now();
  for (let seq = 2; seq < 42; seq++) {
    await service.ingest("run-1", [
      ev("sa-1", seq, seq % 2 === 0 ? "subagent.end" : "subagent.resume"),
    ]);
  }
  assert(Date.now() - began < 150, "the signals did not fit in one window");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assertEquals(reads, 2);

  concludeRun("run-1");
  const frames = await readAll(res);
  assertEquals(frames.at(-1), "event: done\ndata: {}");
  const sent = frames.slice(0, -1).map(laneOf);
  // The listing on connect, then the window's one read: the latest end (40) and resume (41).
  assertEquals(sent.map((l) => [l?.resume?.seq ?? null, l?.end?.seq ?? null, l?.ranMs]), [
    [null, null, 0],
    [41, 40, 20],
  ]);
  // The conclusion's read went through the same window.
  assertEquals(reads, 3);
});

test("the lanes stream on a finished run sends the listing and hangs up at once", async () => {
  const { handle, service } = makeApp({ terminal: true });
  await service.ingest("run-1", [{
    lane: "sa-1",
    seq: 1,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "subagent.start",
    level: null,
    text: null,
    payload: null,
  }]);
  const frames = await readAll(
    await handle(new Request("http://x/v1/runs/run-1/lanes/stream", { headers: userAuth })),
  );
  assertEquals(frames.map((f) => laneOf(f)?.lane ?? f), ["sa-1", "event: done\ndata: {}"]);
});

// The never-miss half: a lane that opens while the listing is being read is still sent, because
// the signal was subscribed to first and is refreshed once the listing is out.
test("a lane opened while the lanes stream reads its listing is not lost", async () => {
  const { handle, service, concludeRun } = makeApp({ concludeGraceMs: 5 });
  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => (release = resolve));
  let park = true;
  const listLanes = service.listLanes.bind(service);
  service.listLanes = async (runId) => {
    if (park) {
      park = false;
      const answer = await listLanes(runId); // the listing as it was before the lane opened
      await parked;
      return answer;
    }
    return await listLanes(runId);
  };
  const res = await handle(
    new Request("http://x/v1/runs/run-1/lanes/stream", { headers: userAuth }),
  );
  await settle();
  await service.ingest("run-1", [{
    lane: "sa-1",
    seq: 1,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "subagent.start",
    level: null,
    text: null,
    payload: null,
  }]);
  release!();
  await settle();
  concludeRun("run-1");
  const frames = await readAll(res);
  assertEquals(frames.map((f) => laneOf(f)?.lane ?? f), ["sa-1", "event: done\ndata: {}"]);
});

// A client can hang up while a stream's `start` is still awaiting its first reads. `cancel` then
// runs before the tail and the keepalive exist, and a stream that set them up anyway afterwards
// left an interval ticking forever and a tail that a conclusion would still wake. Each stream, each
// await it parks on: after the hang-up nothing may be left running.
for (const path of ["events/stream", "lanes/stream"]) {
  for (const parkOn of ["read", "terminal check"]) {
    test(`a ${path} client that hangs up during its ${parkOn} leaves no timer or tail`, async () => {
      const service = makeHistorianService({
        store: memoryHistoryStore(),
        bus: memoryHistoryBus(),
      });
      let release: (() => void) | undefined;
      const parked = new Promise<void>((resolve) => (release = resolve));
      let didPark = false;
      const park = async () => {
        didPark = true;
        await parked;
      };
      let reads = 0;
      const listEvents = service.listEvents.bind(service);
      const listLanes = service.listLanes.bind(service);
      service.listEvents = async (runId, lane, opts) => {
        reads++;
        if (parkOn === "read" && reads === 1) await park();
        return await listEvents(runId, lane, opts);
      };
      service.listLanes = async (runId) => {
        reads++;
        if (parkOn === "read" && reads === 1) await park();
        return await listLanes(runId);
      };
      const { routes, concludeRun } = historianRoutes({
        service,
        concludeGraceMs: 5,
        authenticateRunRead: () => Promise.resolve(null),
        authenticateRun: () => Promise.resolve(true),
        isRunTerminal: async () => {
          if (parkOn === "terminal check") await park();
          return false;
        },
      });
      const route = routes.find((r) => r.method === "GET" && r.pattern.pathname.endsWith(path))!;

      // Every interval made while the stream lives, and whether it was cleared.
      const live = new Set<unknown>();
      const realSet = globalThis.setInterval;
      const realClear = globalThis.clearInterval;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const id = realSet(...args);
        live.add(id);
        return id;
      }) as typeof setInterval;
      globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
        live.delete(id);
        realClear(id);
      }) as typeof clearInterval;
      try {
        const res = await route.handler(
          new Request(`http://x/v1/runs/run-1/${path}`),
          { id: "run-1" },
        ) as Response;
        for (let i = 0; !didPark && i < 100; i++) await settle();
        assert(didPark, `the ${parkOn} should have parked`);
        await res.body!.cancel(); // the client hangs up mid-start
        release!();
        await settle();
        assertEquals(live.size, 0, "a keepalive outlived its stream");

        // A tail left behind would wake on the conclusion and read the store again.
        const before = reads;
        concludeRun("run-1");
        await settle();
        assertEquals(reads, before, "a tail outlived its stream");
      } finally {
        for (const id of live) realClear(id as Parameters<typeof clearInterval>[0]);
        globalThis.setInterval = realSet;
        globalThis.clearInterval = realClear;
      }
    });
  }
}

for (const via of ["token", "session"] as const) {
  test(
    `every stream ${
      via === "token"
        ? "an API token holds open ends when it expires"
        : "a session holds outlives its bearer"
    }`,
    async () => {
      const b64url = (value: unknown) =>
        btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      // Expired a second ago: the gate (stubbed here) took it at open.
      const expired = `${b64url({ alg: "EdDSA" })}.${
        b64url({ sub: "u-1", via, exp: Math.floor(Date.now() / 1000) - 1 })
      }.sig`;
      const { handle } = makeApp({ reader: expired });
      for (const path of ["events/stream", "lanes/stream", "live/stream", "live/commands/stream"]) {
        const res = await handle(
          new Request(`http://x/v1/runs/run-1/${path}`, {
            headers: { authorization: `Bearer ${expired}` },
          }),
        );
        assertEquals(res.status, 200, path);
        const reader = res.body!.getReader();
        let text = "";
        const closed = (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return true;
            text += new TextDecoder().decode(value);
          }
        })();
        const outcome = await Promise.race([
          closed,
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
        ]);
        // A token's stream closes at once; a browser session's EventSource would reconnect with
        // the same expired cookie and grant and be refused, so its stream stays open.
        assertEquals(outcome, via === "token", path);
        assert(!text.includes("event: done"), `${path}: an expiry is not the run's end`);
        if (via === "session") await reader.cancel();
      }
    },
  );
}
