// The memory HistoryStore honors the port contract: idempotent append that returns only
// what was new, and seq-ordered pagination.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { memoryHistoryStore } from "./memory_store.ts";
import type { HistoryEvent } from "../src/core/types.ts";
import { hostileLanes, laneListing, perLaneSeqs } from "./lanes_fixture.ts";

function event(runId: string, seq: number): HistoryEvent {
  return {
    runId,
    lane: "",
    seq,
    at: "2026-07-16T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: { seq },
  };
}

test("append returns only newly stored events", async () => {
  const store = memoryHistoryStore();

  const first = await store.append([event("run-1", 0), event("run-1", 1)]);
  assertEquals(first.map((e) => e.seq), [0, 1]);

  const retry = await store.append([event("run-1", 1), event("run-1", 2)]);
  assertEquals(retry.map((e) => e.seq), [2]);

  assertEquals((await store.listEvents("run-1", "")).map((e) => e.seq), [0, 1, 2]);
});

test("listEvents pages ascending by seq, strictly after", async () => {
  const store = memoryHistoryStore();
  await store.append([0, 1, 2, 3, 4].map((seq) => event("run-1", seq)));

  assertEquals((await store.listEvents("run-1", "", { after: 1 })).map((e) => e.seq), [2, 3, 4]);
  assertEquals(
    (await store.listEvents("run-1", "", { after: 1, limit: 2 })).map((e) => e.seq),
    [2, 3],
  );
  assertEquals(await store.listEvents("run-1", "", { after: 4 }), []);
  assertEquals(await store.listEvents("no-such-run", ""), []);
});

test("listEvents pages backwards from `before`, newest first, answered ascending", async () => {
  const store = memoryHistoryStore();
  await store.append([0, 1, 2, 3, 4].map((seq) => event("run-1", seq)));

  // The NEWEST two below the cursor — not the oldest two, which is what a naive filter+slice
  // would give — and still ascending.
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
});

test("stored events are copies — mutating the input later changes nothing", async () => {
  const store = memoryHistoryStore();
  const original = event("run-1", 0);
  await store.append([original]);
  (original.payload as { seq: number }).seq = 999;

  const [stored] = await store.listEvents("run-1", "");
  assertEquals(stored.payload, { seq: 0 });
});

test("each lane has its own seqs: append dedups on (runId, lane, seq), reads are per lane", async () => {
  await perLaneSeqs(memoryHistoryStore());
});

test("listLanes answers each opened lane's start, latest resume and latest end", async () => {
  await laneListing(memoryHistoryStore());
});

test("listLanes stays bounded and well-formed whatever a run writes into its lanes", async () => {
  await hostileLanes(memoryHistoryStore());
});
