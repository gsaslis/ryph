// The service's one job, proven: stamp, store, broadcast only what was new.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { makeHistorianService } from "../src/core/service.ts";
import { memoryHistoryStore } from "./memory_store.ts";
import { memoryHistoryBus } from "../src/adapters/bus/memory.ts";
import type { HistoryEvent, IncomingHistoryEvent } from "../src/core/types.ts";

function event(seq: number, overrides: Partial<IncomingHistoryEvent> = {}): IncomingHistoryEvent {
  return {
    lane: "",
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

test("ingest stamps the runId and stores in seq order", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });

  const outcome = await service.ingest("run-1", [event(1), event(0)]);
  assertEquals(outcome, { accepted: 2, duplicates: 0 });

  const events = await service.listEvents("run-1", "");
  assertEquals(events.map((e) => e.seq), [0, 1]);
  assertEquals(events.every((e) => e.runId === "run-1"), true);
});

test("re-ingesting a batch acks duplicates and stores nothing twice", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });

  await service.ingest("run-1", [event(0), event(1)]);
  const retry = await service.ingest("run-1", [event(0), event(1), event(2)]);
  assertEquals(retry, { accepted: 1, duplicates: 2 });

  const events = await service.listEvents("run-1", "");
  assertEquals(events.map((e) => e.seq), [0, 1, 2]);
});

test("only newly stored events reach live listeners", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const seen: number[] = [];
  service.subscribe("run-1", "", (e) => seen.push(e.seq));

  await service.ingest("run-1", [event(0), event(1)]);
  await service.ingest("run-1", [event(0), event(1), event(2)]); // the retry

  assertEquals(seen, [0, 1, 2]);
});

test("runs are isolated: listeners and listing see only their run", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const seen: string[] = [];
  service.subscribe("run-a", "", (e) => seen.push(`${e.runId}:${e.seq}`));

  await service.ingest("run-a", [event(0)]);
  await service.ingest("run-b", [event(0), event(1)]);

  assertEquals(seen, ["run-a:0"]);
  assertEquals((await service.listEvents("run-b", "")).length, 2);
});

test("unsubscribe stops delivery; a throwing listener does not wound the rest", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const seen: number[] = [];
  service.subscribe("run-1", "", () => {
    throw new Error("broken consumer");
  });
  const unsubscribe = service.subscribe("run-1", "", (e) => seen.push(e.seq));

  await service.ingest("run-1", [event(0)]);
  unsubscribe();
  await service.ingest("run-1", [event(1)]);

  assertEquals(seen, [0]);
});

// The bug this guards: the unsubscribe closes over the Set its listener joined, and emptying that
// Set removes the run's entry from the listener map. Call it twice — which the SSE handler's `stop`
// can do, since both `cancel` and `hangUp` reach it — and the second call operates on a Set that is
// no longer the map's. Without the guard it deletes the entry anyway, taking whoever subscribed in
// between down with it: a tail still open, still holding a live subscription, receiving nothing.
test("a stale unsubscribe cannot silence the tail that replaced it", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });

  // The first tail comes and goes, emptying the run's listener set.
  const unsubscribeFirst = service.subscribe("run-1", "", () => {});
  unsubscribeFirst();

  // A second watcher arrives on the same run — a reload, or another operator.
  const seen: number[] = [];
  service.subscribe("run-1", "", (e) => seen.push(e.seq));

  // The first tail's cleanup runs again, as a second `stop()` would.
  unsubscribeFirst();

  await service.ingest("run-1", [event(0)]);
  assertEquals(seen, [0], "the surviving tail must still receive live events");
});

test("both voices share one seq space and interleave in order", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });

  await service.ingest("run-1", [
    event(0, { voice: "diag", kind: "credentials.fetched", level: "debug", payload: {} }),
    event(1, { kind: "assistant" }),
    event(2, { voice: "diag", kind: "pi.spawn", level: "debug" }),
  ]);

  const events: HistoryEvent[] = await service.listEvents("run-1", "");
  assertEquals(events.map((e) => `${e.voice}:${e.kind}`), [
    "diag:credentials.fetched",
    "transcript:assistant",
    "diag:pi.spawn",
  ]);
});

test("lanes are isolated: each has its own seqs, listeners and listing", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const main: string[] = [];
  const child: string[] = [];
  service.subscribe("run-1", "", (e) => main.push(`${e.lane}:${e.seq}`));
  service.subscribe("run-1", "sa-1", (e) => child.push(`${e.lane}:${e.seq}`));

  // One batch may carry several lanes, and the same seq in each.
  const outcome = await service.ingest("run-1", [
    event(1),
    event(1, { lane: "sa-1", kind: "subagent.start" }),
    event(2, { lane: "sa-1" }),
  ]);
  assertEquals(outcome, { accepted: 3, duplicates: 0 });
  // A retry dedups per lane.
  assertEquals(
    await service.ingest("run-1", [event(1, { lane: "sa-1" }), event(2)]),
    { accepted: 1, duplicates: 1 },
  );

  assertEquals(main, [":1", ":2"]);
  assertEquals(child, ["sa-1:1", "sa-1:2"]);
  assertEquals((await service.listEvents("run-1", "")).map((e) => e.seq), [1, 2]);
  assertEquals((await service.listEvents("run-1", "sa-1")).map((e) => e.kind), [
    "subagent.start",
    "assistant",
  ]);
  assertEquals((await service.listLanes("run-1")).map((l) => [l.lane, l.start.seq, l.end]), [
    ["sa-1", 1, null],
  ]);
});

test("lane-summary signals name the lane, for a start, resume or end in a subagent's lane only", async () => {
  const service = makeHistorianService({ store: memoryHistoryStore(), bus: memoryHistoryBus() });
  const signalled: string[] = [];
  const stop = service.subscribeLanes("run-1", (lane) => signalled.push(lane));
  service.subscribeLanes("run-2", (lane) => signalled.push(`run-2 ${lane}`));

  await service.ingest("run-1", [
    event(1, { lane: "sa-1", kind: "subagent.start" }),
    event(2, { lane: "sa-1" }),
    event(1, { kind: "subagent.start" }), // the main lane
    event(3, { lane: "sa-1", voice: "diag", kind: "subagent.end", level: "debug" }),
    event(1, { lane: "sa-2", kind: "subagent.end" }),
  ]);
  // A retry stores nothing, so signals nothing.
  await service.ingest("run-1", [event(1, { lane: "sa-1", kind: "subagent.start" })]);
  assertEquals(signalled, ["sa-1", "sa-2"]);

  stop();
  stop();
  await service.ingest("run-1", [event(4, { lane: "sa-1", kind: "subagent.resume" })]);
  assertEquals(signalled, ["sa-1", "sa-2"]);
});
