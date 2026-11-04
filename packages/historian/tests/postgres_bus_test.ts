// The cross-replica bus, exercised as two replicas: two independent buses over ONE database,
// which is exactly the shape the in-process listener map got wrong.
//
// `pglite:memory://` gives a real Postgres with real LISTEN/NOTIFY, but only one connection —
// so "two replicas" here means two bus instances sharing that connection's channel. That proves
// the parts this adapter owns (pointer encoding, catch-up reads, cursors, no-listener skips);
// the genuinely-two-processes half is the compose stack's to prove.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { drizzleHistoryStore } from "../src/adapters/store/drizzle.ts";
import {
  decodeLaneSignal,
  decodePointer,
  encodePointer,
  postgresHistoryBus,
} from "../src/adapters/bus/postgres.ts";
import type { HistoryEvent } from "../src/core/types.ts";
import type { HistoryStore } from "../src/ports/store.ts";
import { makeTestDb } from "./db.ts";

const quiet = { debug() {} };

/** Long enough for a NOTIFY to be delivered and its catch-up read to finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

function event(runId: string, seq: number, lane = ""): HistoryEvent {
  return {
    runId,
    lane,
    seq,
    at: "2026-09-04T12:00:00.000Z",
    voice: "transcript",
    kind: "assistant",
    level: null,
    text: `event ${seq}`,
    payload: null,
  };
}

/** Stores a batch and publishes exactly what was new, as the service does. */
async function ingest(
  store: HistoryStore,
  bus: { publish(e: HistoryEvent[]): void },
  events: HistoryEvent[],
) {
  const stored = await store.append(events);
  if (stored.length > 0) bus.publish(stored);
  return stored;
}

test("a tail on one replica sees events ingested on another", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const deps = { notify: handle.notify, listen: handle.listen, store, diag: quiet };
  const alice = await postgresHistoryBus(deps);
  const bob = await postgresHistoryBus(deps);

  try {
    const seenByBob: number[] = [];
    bob.subscribe("run-1", "", (e) => seenByBob.push(e.seq));

    // Ingested on Alice's replica. Bob holds the only tail.
    await ingest(store, alice, [event("run-1", 0), event("run-1", 1)]);
    await settle();
    assertEquals(seenByBob, [0, 1]);

    await ingest(store, alice, [event("run-1", 2)]);
    await settle();
    assertEquals(seenByBob, [0, 1, 2]);
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("a local tail is served without waiting for the round trip", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const bus = await postgresHistoryBus({
    notify: handle.notify,
    listen: handle.listen,
    store,
    diag: quiet,
  });

  try {
    const seen: number[] = [];
    bus.subscribe("run-1", "", (e) => seen.push(e.seq));
    await ingest(store, bus, [event("run-1", 0)]);
    // No settle: local fan-out is synchronous inside publish().
    assertEquals(seen, [0]);

    // And the self-notification that follows must not deliver it a second time.
    await settle();
    assertEquals(seen, [0]);
  } finally {
    await bus.close();
    await store.close();
  }
});

test("a run nobody here is tailing costs this replica no read", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  let reads = 0;
  const counting: Pick<HistoryStore, "listEvents"> = {
    listEvents: (runId, lane, opts) => {
      reads++;
      return store.listEvents(runId, lane, opts);
    },
  };
  const alice = await postgresHistoryBus({
    notify: handle.notify,
    listen: handle.listen,
    store,
    diag: quiet,
  });
  const bob = await postgresHistoryBus({
    notify: handle.notify,
    listen: handle.listen,
    store: counting,
    diag: quiet,
  });

  try {
    // Bob tails run-1 only; run-2's firehose must not touch his store at all.
    bob.subscribe("run-1", "", () => {});
    await ingest(store, alice, [event("run-2", 0), event("run-2", 1)]);
    await settle();
    assertEquals(reads, 0);

    await ingest(store, alice, [event("run-1", 0)]);
    await settle();
    assertEquals(reads > 0, true, "a tailed run should have been read back");
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("unsubscribing stops delivery, and is idempotent", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const deps = { notify: handle.notify, listen: handle.listen, store, diag: quiet };
  const alice = await postgresHistoryBus(deps);
  const bob = await postgresHistoryBus(deps);

  try {
    const first: number[] = [];
    const second: number[] = [];
    const stop = bob.subscribe("run-1", "", (e) => first.push(e.seq));
    bob.subscribe("run-1", "", (e) => second.push(e.seq));

    await ingest(store, alice, [event("run-1", 0)]);
    await settle();
    assertEquals(first, [0]);
    assertEquals(second, [0]);

    stop();
    stop(); // A second stop must not evict the listener that is still there.

    await ingest(store, alice, [event("run-1", 1)]);
    await settle();
    assertEquals(first, [0], "an unsubscribed tail kept receiving");
    assertEquals(second, [0, 1], "the surviving tail stopped receiving");
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("a listener that throws does not stop the others", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const deps = { notify: handle.notify, listen: handle.listen, store, diag: quiet };
  const alice = await postgresHistoryBus(deps);
  const bob = await postgresHistoryBus(deps);

  try {
    const survivor: number[] = [];
    bob.subscribe("run-1", "", () => {
      throw new Error("a consumer with a bug");
    });
    bob.subscribe("run-1", "", (e) => survivor.push(e.seq));

    await ingest(store, alice, [event("run-1", 0), event("run-1", 1)]);
    await settle();
    assertEquals(survivor, [0, 1]);
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("a catch-up spanning many pages delivers every event once, in order", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const deps = { notify: handle.notify, listen: handle.listen, store, diag: quiet };
  const alice = await postgresHistoryBus(deps);
  const bob = await postgresHistoryBus(deps);

  try {
    const seen: number[] = [];
    bob.subscribe("run-1", "", (e) => seen.push(e.seq));

    // Past the 500-event page size, so the read has to loop.
    const batch = Array.from({ length: 1200 }, (_, i) => event("run-1", i));
    await ingest(store, alice, batch);
    await settle();
    await settle();

    assertEquals(seen.length, 1200);
    assertEquals(seen, batch.map((e) => e.seq));
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("a pointer carries its lane, read from the right whatever the run id holds", () => {
  for (
    const [runId, lane, seq] of [["run-1", "", 0], ["run-1", "sa-12", 7], [
      "a:b",
      "sa-1",
      3,
    ]] as const
  ) {
    assertEquals(decodePointer(encodePointer(runId, lane, seq)), { runId, lane, seq });
  }
  assertEquals(encodePointer("run-1", "", 5), "run-1::5");
  // The lane-less shape, a lane that is not one, and a bad seq are all ignored, never misread.
  for (const bad of ["run-1:5", "run-1:sa-0:5", "run-1:x:5", "run-1:sa-1:-1", ":sa-1:1", "::1"]) {
    assertEquals(decodePointer(bad), null, bad);
  }
});

test("a peer's tail hears each lane apart, with each lane's own seqs", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const deps = { notify: handle.notify, listen: handle.listen, store, diag: quiet };
  const alice = await postgresHistoryBus(deps);
  const bob = await postgresHistoryBus(deps);

  try {
    const main: string[] = [];
    const child: string[] = [];
    bob.subscribe("run-1", "", (e) => main.push(`${e.lane}:${e.seq}`));
    bob.subscribe("run-1", "sa-1", (e) => child.push(`${e.lane}:${e.seq}`));

    // One batch across three lanes, the same seqs in each: a cursor shared between lanes would
    // swallow the second lane's events as already delivered.
    await ingest(store, alice, [
      event("run-1", 0),
      event("run-1", 1),
      event("run-1", 1, "sa-1"),
      event("run-1", 2, "sa-1"),
      event("run-1", 1, "sa-2"),
    ]);
    await settle();
    assertEquals(main, [":0", ":1"]);
    assertEquals(child, ["sa-1:1", "sa-1:2"]);

    // The child lane moves on alone; the main lane's tail hears nothing of it.
    await ingest(store, alice, [event("run-1", 3, "sa-1")]);
    await settle();
    assertEquals(main, [":0", ":1"]);
    assertEquals(child, ["sa-1:1", "sa-1:2", "sa-1:3"]);
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

test("a local tail on one lane is served at once, and only its lane", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  const bus = await postgresHistoryBus({
    notify: handle.notify,
    listen: handle.listen,
    store,
    diag: quiet,
  });
  try {
    const seen: string[] = [];
    bus.subscribe("run-1", "sa-1", (e) => seen.push(`${e.lane}:${e.seq}`));
    await ingest(store, bus, [event("run-1", 4), event("run-1", 4, "sa-1")]);
    // Synchronous: no settle.
    assertEquals(seen, ["sa-1:4"]);
  } finally {
    await bus.close();
    await store.close();
  }
});

test("a lane-summary change is signalled to a peer, and nothing else is", async () => {
  const handle = await makeTestDb();
  const store = drizzleHistoryStore(handle);
  let reads = 0;
  const counting: Pick<HistoryStore, "listEvents"> = {
    listEvents: (runId, lane, opts) => {
      reads++;
      return store.listEvents(runId, lane, opts);
    },
  };
  const alice = await postgresHistoryBus({ ...deps(handle), store });
  const bob = await postgresHistoryBus({ ...deps(handle), store: counting });

  try {
    const signalled: string[] = [];
    bob.subscribeLanes("run-1", (lane) => signalled.push(lane));
    await ingest(store, alice, [
      event("run-1", 0),
      { ...event("run-1", 1, "sa-1"), kind: "subagent.start" },
      event("run-1", 2, "sa-1"),
      { ...event("run-2", 1, "sa-1"), kind: "subagent.start" },
    ]);
    await settle();
    assertEquals(signalled, ["sa-1"]);
    // A signal is not a read: watching the listing costs a peer no transcript.
    assertEquals(reads, 0);

    await ingest(store, alice, [{ ...event("run-1", 3, "sa-1"), kind: "subagent.end" }]);
    await settle();
    assertEquals(signalled, ["sa-1", "sa-1"]);
    assertEquals(decodeLaneSignal("a:b:sa-3"), { runId: "a:b", lane: "sa-3" });
    for (const bad of ["run-1:", "run-1", ":sa-1", "run-1:sa-0"]) {
      assertEquals(decodeLaneSignal(bad), null, bad);
    }
  } finally {
    await alice.close();
    await bob.close();
    await store.close();
  }
});

function deps(handle: Awaited<ReturnType<typeof makeTestDb>>) {
  return { notify: handle.notify, listen: handle.listen, diag: quiet };
}
