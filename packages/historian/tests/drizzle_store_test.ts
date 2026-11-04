// The drizzle HistoryStore honors the same port contract the memory one does — and proves
// the load-bearing trick: ON CONFLICT DO NOTHING ... RETURNING on the composite PK yields
// exactly the newly inserted rows.

import { assertEquals, assertRejects } from "@std/assert";
import { drizzleHistoryStore } from "../src/adapters/store/drizzle.ts";
import type { HistoryEvent } from "../src/core/types.ts";
import { reusableDbSuite } from "./reusable_db.ts";
import { hostileLanes, laneListing, perLaneSeqs } from "./lanes_fixture.ts";

function event(runId: string, seq: number, overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    runId,
    lane: "",
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: { nested: { seq } },
    ...overrides,
  };
}

const { test, makeTestDb } = reusableDbSuite("historian store");

test("append dedups on (runId, lane, seq) and returns only newly inserted rows", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);

  const first = await store.append([event("run-1", 0), event("run-1", 1)]);
  assertEquals(first.map((e) => e.seq), [0, 1]);

  const retry = await store.append([event("run-1", 1), event("run-1", 2)]);
  assertEquals(retry.map((e) => e.seq), [2]);

  // Same seq on ANOTHER run is not a conflict.
  const otherRun = await store.append([event("run-2", 1)]);
  assertEquals(otherRun.length, 1);

  assertEquals((await store.listEvents("run-1", "")).map((e) => e.seq), [0, 1, 2]);
  await store.close();
});

test("rows round-trip field-for-field, payload included", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);

  const original = event("run-1", 0, {
    voice: "diag",
    kind: "credentials.fetched",
    level: "warn",
    text: null,
    payload: { providers: ["anthropic"], count: 2 },
  });
  await store.append([original]);

  const [row] = await store.listEvents("run-1", "");
  assertEquals(row, original);
  await store.close();
});

test("listEvents pages ascending by seq, strictly after", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  // Insert out of order — the read side must sort.
  await store.append([4, 0, 2, 1, 3].map((seq) => event("run-1", seq)));

  assertEquals((await store.listEvents("run-1", "")).map((e) => e.seq), [0, 1, 2, 3, 4]);
  assertEquals((await store.listEvents("run-1", "", { after: 1 })).map((e) => e.seq), [2, 3, 4]);
  assertEquals(
    (await store.listEvents("run-1", "", { after: 1, limit: 2 })).map((e) => e.seq),
    [2, 3],
  );
  assertEquals(await store.listEvents("run-1", "", { after: 4 }), []);
  assertEquals(await store.listEvents("no-such-run", ""), []);
  await store.close();
});

test("listEvents pages backwards from `before`, newest first, answered ascending", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  await store.append([4, 0, 2, 1, 3].map((seq) => event("run-1", seq)));

  // Backwards means the NEWEST `limit` below the cursor (a DESC read on the primary key),
  // handed back in the same ascending order every other page uses.
  assertEquals(
    (await store.listEvents("run-1", "", { before: 4, limit: 2 })).map((e) => e.seq),
    [2, 3],
  );
  assertEquals((await store.listEvents("run-1", "", { before: 5 })).map((e) => e.seq), [
    0,
    1,
    2,
    3,
    4,
  ]);
  assertEquals((await store.listEvents("run-1", "", { before: 2 })).map((e) => e.seq), [0, 1]);
  assertEquals(await store.listEvents("run-1", "", { before: 0 }), []);
  assertEquals(await store.listEvents("no-such-run", "", { before: 99 }), []);
  await store.close();
});

// The tail page asks for "newer than any event that could exist", and the obvious way to write
// that — Number.MAX_SAFE_INTEGER — is larger than the int4 `seq` column. Postgres does not
// answer such a comparison with an empty set; it refuses the statement. Only a test on the real
// driver sees that, which is why it lives here: the store takes the cursor verbatim, and the
// route is where it is clamped into range.
test("a cursor past int4 is a query error, which is why the route clamps to int4 max", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  await store.append([0, 1, 2].map((seq) => event("run-1", seq)));

  // The largest cursor the route can hand down — the tail page, clamped. It must read the run.
  assertEquals(
    (await store.listEvents("run-1", "", { before: 2_147_483_647 })).map((e) => e.seq),
    [0, 1, 2],
  );
  assertEquals(
    (await store.listEvents("run-1", "", { after: 2_147_483_647 })).map((e) => e.seq),
    [],
  );

  // ...and one past it is the failure the clamp exists for. Should `seq` ever widen to int8,
  // this is the test that says the clamp can go.
  await assertRejects(
    () => store.listEvents("run-1", "", { before: Number.MAX_SAFE_INTEGER }),
    Error,
  );
  await store.close();
});

// Small rows, small chunk: the chunk-boundary logic is what's under test, and a chunk of 10
// exercises it without building thousand-event batches. The row counts used to be held low for
// a different reason — @libsql/client segfaulted at teardown past ~100 inserted rows — which
// went away with the driver.
test("batches larger than the insert chunk land whole, dedup included", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle, { insertChunk: 10 });

  const batch = Array.from({ length: 25 }, (_, seq) => event("run-1", seq));
  const stored = await store.append(batch);
  assertEquals(stored.length, 25);

  // A retry overlapping two chunk boundaries dedups per row, not per chunk.
  const retry = await store.append(
    [8, 9, 10, 11, 24, 25, 26].map((seq) => event("run-1", seq)),
  );
  assertEquals(retry.map((e) => e.seq), [25, 26]);
  assertEquals((await store.listEvents("run-1", "")).length, 27);
  await store.close();
});

test("a conclusion is durable, idempotent, and per run", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);

  assertEquals(await store.isConcluded("run-1"), false);
  await store.markConcluded("run-1", "2026-09-04T12:00:00.000Z");
  assertEquals(await store.isConcluded("run-1"), true);
  // Another run is unaffected — the whole reason this is a table and not a flag.
  assertEquals(await store.isConcluded("run-2"), false);

  // The ping is fire-and-forget and repeats; a second arrival must not error.
  await store.markConcluded("run-1", "2026-09-04T13:00:00.000Z");
  assertEquals(await store.isConcluded("run-1"), true);

  await store.close();
});

test("a NUL anywhere in an event is stored as U+FFFD instead of failing the batch", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);

  const stored = await store.append([
    event("run-1", 0),
    event("run-1", 1, {
      kind: "tool\u0000use",
      text: "a\u0000b",
      payload: { "k\u0000": ["x\u0000", { deep: "\u0000" }], n: 1, ok: true, none: null },
    }),
  ]);
  assertEquals(stored.map((e) => e.seq), [0, 1]);

  const [, nul] = await store.listEvents("run-1", "");
  assertEquals(nul.kind, "tool\uFFFDuse");
  assertEquals(nul.text, "a\uFFFDb");
  assertEquals(nul.payload, {
    "k\uFFFD": ["x\uFFFD", { deep: "\uFFFD" }],
    n: 1,
    ok: true,
    none: null,
  });
  await store.close();
});

test("each lane has its own seqs: append dedups on (runId, lane, seq), reads are per lane", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  await perLaneSeqs(store);
  await store.close();
});

test("listLanes answers each opened lane's start, latest resume and latest end", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  await laneListing(store);
  await store.close();
});

test("listLanes stays bounded and well-formed whatever a run writes into its lanes", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  await hostileLanes(store);
  await store.close();
});
