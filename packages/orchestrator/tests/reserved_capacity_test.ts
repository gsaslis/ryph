// Reserved capacity's core: what a saved row plans, which saves are refused, and when the
// reconciler actually asks the backend — due from boot, owed again when the holder sees the row
// move, otherwise once an interval, only while holding the backend's lease (by the lease's own
// clock rules, @ryph/service's), and never a throw when the backend is down.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import type { LeaseStore } from "@ryph/service";
import {
  holdSeconds,
  leaseTimings,
  makeCapacityReconciler,
  planReservations,
  reservable,
  type ReservedCapacity,
  reservedCapacityRefusal,
  slotsOf,
} from "../src/core/reserved_capacity.ts";
import { parseRunSizes, type RunSizes } from "../src/core/run_sizes.ts";
import { DEFAULT_SERVICE_POLICY, serviceRoom } from "../src/core/services.ts";
import type { CapacityReserver, Reservation, ServiceRoom } from "../src/ports/provisioner.ts";
import { fakeClock, recordingDiagnostics } from "./doubles.ts";
import { type MemoryLeaseStore, memoryLeaseStore } from "../../service/tests/memory_lease_store.ts";

function sizesOf(spec: string): RunSizes {
  const parsed = parseRunSizes(spec, undefined);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
}

const SIZES = sizesOf(
  "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;" +
    "large:cpu=7,memory=16Gi,ephemeral-storage=10Gi,work-volume=50Gi;" +
    "bare:ephemeral-storage=1Gi",
);

const ROOM: ServiceRoom = { count: 3, cpus: "1", memory: "1g", browser: null };

const saved = (
  slots: Record<string, number>,
  updatedAt = "2026-01-01T00:00:00.000Z",
): ReservedCapacity => ({ slots, updatedAt, updatedBy: "u-1" });

/**
 * A backend that records every plan, and fails while `down` is set (`applyDown`: only its
 * applies). Its lease is an in-memory store any number of replicas can share; `identity` makes
 * this one a replica of its own.
 */
function fakeReserver(lease: MemoryLeaseStore = memoryLeaseStore(), identity = "me") {
  const applied: Array<
    {
      image: string;
      services: ServiceRoom;
      reservations: Array<[string, number]>;
    }
  > = [];
  /** The `held` each apply was given, latest last. */
  const helds: Array<() => boolean> = [];
  const state = { down: false, applyDown: false };
  const store: LeaseStore = {
    kind: "fake",
    read: () => state.down ? Promise.reject(new Error("connection refused")) : lease.read(),
    create: (record) =>
      state.down ? Promise.reject(new Error("connection refused")) : lease.create(record),
    replace: (record, version) =>
      state.down ? Promise.reject(new Error("connection refused")) : lease.replace(record, version),
  };
  const reserver: CapacityReserver = {
    lease: store,
    identity,
    apply(plan) {
      if (state.down || state.applyDown) return Promise.reject(new Error("connection refused"));
      applied.push({
        image: plan.image,
        services: plan.services,
        reservations: plan.reservations.map((r: Reservation) => [r.size.name, r.slots]),
      });
      helds.push(plan.held);
      return Promise.resolve();
    },
    status: () => Promise.resolve([{ sizeClass: "standard", ready: 1 }]),
    // The backend's own judgement; here, every class fits the whole room.
    servicesHeld: (_size, room) => room.count,
  };
  return { reserver, applied, helds, state, lease };
}

/** The lease as another replica would hold it, renewed by that replica's clock at some point. */
const OTHERS = {
  holder: "another replica",
  durationMs: 180_000,
  renewedAt: "2020-01-01T00:00:00.000Z",
  transitions: 0,
};

function reconciler(
  opts: {
    row?: ReservedCapacity | null;
    afterRead?: () => void;
    tickMs?: number;
    clock?: ReturnType<typeof fakeClock>;
    backend?: ReturnType<typeof fakeReserver>;
  } = {},
) {
  const clock = opts.clock ?? fakeClock();
  const backend = opts.backend ?? fakeReserver();
  const { diag, events } = recordingDiagnostics();
  let row = opts.row ?? null;
  const reads = { count: 0 };
  const rc = makeCapacityReconciler({
    store: {
      getReservedCapacity: () => {
        reads.count++;
        const read = row;
        opts.afterRead?.();
        return Promise.resolve(read);
      },
    },
    reserver: backend.reserver,
    runSizes: SIZES,
    image: "registry.example/ryph-agent:1",
    services: ROOM,
    diag,
    now: clock.now,
    monotonicMs: () => clock.now().getTime(),
    intervalMs: 60_000,
    tickMs: opts.tickMs ?? 10_000,
  });
  return {
    rc,
    clock,
    backend,
    events,
    reads,
    setRow: (next: ReservedCapacity | null) => (row = next),
  };
}

test("a pass writes only while the lease is held, which lapses two thirds into the hold", async () => {
  const { rc, clock, backend } = reconciler({ row: saved({ standard: 1 }) });
  await rc.tick();
  const held = backend.helds[0];
  // 60 s interval, 10 s tick: a 180 s hold, so 120 s from the renewal to write in, and the last
  // 60 s nobody writes: not this replica, and nobody else may take it over yet.
  assertEquals(leaseTimings(60_000, 10_000), {
    durationMs: 180_000,
    renewDeadlineMs: 120_000,
    retryMs: 60_000,
  });
  clock.advance(119_999);
  assertEquals(held(), true);
  clock.advance(1);
  assertEquals(held(), false);
});

test("a class is reservable only when it sets cpu, memory and ephemeral storage", () => {
  assertEquals(SIZES.classes.map((c) => [c.name, reservable(c)]), [
    ["standard", true],
    ["large", true],
    ["bare", false],
  ]);
  // One unset dimension is a per-container default the cluster fills in, once in the placeholder
  // and once per container in the pods it reserves for, so the slot would come up short.
  const partial = sizesOf(
    "nocpu:memory=8Gi,ephemeral-storage=10Gi;nomem:cpu=4,ephemeral-storage=10Gi;nodisk:cpu=4,memory=8Gi",
  );
  assertEquals(partial.classes.map(reservable), [false, false, false]);
});

test("the plan names every configured class, in order, zero where nothing is saved", () => {
  const plan = (row: ReservedCapacity | null) =>
    planReservations(SIZES, row).map((r) => [r.size.name, r.slots]);
  assertEquals(plan(null), [["standard", 0], ["large", 0], ["bare", 0]]);
  // A class the configuration dropped is ignored; an unreservable one is never held, whatever an
  // older row says.
  assertEquals(plan(saved({ large: 2, gone: 5, bare: 3 })), [
    ["standard", 0],
    ["large", 2],
    ["bare", 0],
  ]);
});

test("a class named like an Object.prototype key reads as 0 when the row lacks it", () => {
  const sizes = sizesOf("constructor:cpu=1,memory=1Gi;tostring:cpu=1");
  assertEquals(slotsOf({}, "constructor"), 0);
  assertEquals(slotsOf({ constructor: 3 }, "constructor"), 3);
  assertEquals(
    planReservations(sizes, saved({})).map((r) => [r.size.name, r.slots]),
    [["constructor", 0], ["tostring", 0]],
  );
});

test("a save naming an unknown class, or reserving an unreservable one, is refused", () => {
  assertEquals(reservedCapacityRefusal(SIZES, { standard: 2, large: 0 }), null);
  assertEquals(reservedCapacityRefusal(SIZES, { bare: 0 }), null);
  assertEquals(
    reservedCapacityRefusal(SIZES, { huge: 1 }),
    'RYPH_RUN_SIZES defines no class "huge"',
  );
  assertEquals(
    reservedCapacityRefusal(SIZES, { bare: 1 }),
    'size class "bare" leaves cpu, memory or ephemeral-storage unset, so its pods can outgrow a ' +
      "slot; set all three in RYPH_RUN_SIZES to reserve it",
  );
});

test("the first tick reconciles, then nothing until the interval or the row moves", async () => {
  const { rc, clock, backend, setRow } = reconciler({ row: saved({ standard: 2 }) });
  // Due from boot: a deploy that moves the image moves the placeholders on the first tick.
  await rc.tick();
  assertEquals(backend.applied, [{
    image: "registry.example/ryph-agent:1",
    services: ROOM,
    reservations: [["standard", 2], ["large", 0], ["bare", 0]],
  }]);

  clock.advance(10_000);
  await rc.tick();
  assertEquals(backend.applied.length, 1);

  // A save, on this replica or any other: the holder's next tick sees the row move.
  setRow(saved({ large: 1 }, "2026-01-01T00:00:10.000Z"));
  await rc.tick();
  assertEquals(backend.applied.length, 2);
  assertEquals(backend.applied[1].reservations, [["standard", 0], ["large", 1], ["bare", 0]]);

  // The interval is the backstop for a placeholder deleted by hand.
  clock.advance(59_999);
  await rc.tick();
  assertEquals(backend.applied.length, 2);
  clock.advance(1);
  await rc.tick();
  assertEquals(backend.applied.length, 3);
});

test("a backend that is down is logged and retried at the interval, never thrown", async () => {
  const { rc, clock, backend, events } = reconciler();
  backend.state.down = true;
  await rc.tick();
  assertEquals(events.filter((e) => e.event.endsWith("_failed")).map((e) => e.event), [
    "capacity.lease_failed",
  ]);

  // Not every reaper tick: a dead API server is asked once an interval, not every ten seconds.
  backend.state.down = false;
  clock.advance(10_000);
  await rc.tick();
  assertEquals(backend.applied.length, 0);
  clock.advance(50_000);
  await rc.tick();
  assertEquals(backend.applied.length, 1);

  // Held, and the apply itself refused.
  backend.state.applyDown = true;
  clock.advance(60_000);
  await rc.tick();
  assertEquals(events.filter((e) => e.event.endsWith("_failed")).map((e) => e.event), [
    "capacity.lease_failed",
    "capacity.reconcile_failed",
  ]);
  assertEquals(
    String(events.find((e) => e.event === "capacity.reconcile_failed")?.fields?.err),
    "Error: connection refused",
  );
});

test("a save that lands after a pass read the row is owed a pass of its own", async () => {
  let landed = false;
  const { rc, backend, setRow, reads } = reconciler({
    row: saved({ standard: 1 }),
    // The save lands the moment after the pass read the row, before its apply.
    afterRead: () => {
      if (landed) return;
      landed = true;
      setRow(saved({ standard: 3 }, "2026-01-01T00:00:05.000Z"));
    },
  });
  await rc.tick();
  assertEquals(reads.count, 1);
  assertEquals(backend.applied[0].reservations[0], ["standard", 1]);
  await rc.tick();
  assertEquals(backend.applied.length, 2);
  assertEquals(backend.applied[1].reservations[0], ["standard", 3]);
});

test("a replica that does not hold the lease applies nothing, and asks once an interval", async () => {
  const { rc, clock, backend, setRow, reads } = reconciler({ row: saved({ standard: 1 }) });
  backend.lease.overwrite(OTHERS);
  await rc.tick();
  assertEquals(backend.applied.length, 0);
  // Not even the row is read: it could not apply it.
  assertEquals(reads.count, 0);

  // A save served here moves the row, but the holder is the one that applies it.
  setRow(saved({ standard: 2 }, "2026-01-01T00:00:10.000Z"));
  clock.advance(10_000);
  await rc.tick();
  assertEquals(reads.count, 0);

  // The holder went away without a word. Its lease is taken once this replica has seen it
  // unchanged for the whole hold by its own clock, at the first due pass after that.
  for (let at = 60_000; at < 180_000; at += 60_000) {
    clock.advance(at === 60_000 ? 50_000 : 60_000);
    await rc.tick();
    assertEquals(backend.applied.length, 0, `${at} ms`);
  }
  clock.advance(60_000);
  await rc.tick();
  assertEquals(backend.applied.map((a) => a.reservations[0]), [["standard", 2]]);
  assertEquals(backend.lease.current()?.record.holder, "me");
});

test("a save served by another replica reaches the holder on its next tick", async () => {
  // Two replicas over one row and one lease: `a` holds it, `b` served the save.
  const clock = fakeClock();
  const lease = memoryLeaseStore();
  let row: ReservedCapacity | null = saved({ standard: 1 });
  const replica = (who: string) => {
    const backend = fakeReserver(lease, who);
    const rc = makeCapacityReconciler({
      store: { getReservedCapacity: () => Promise.resolve(row) },
      reserver: backend.reserver,
      runSizes: SIZES,
      image: "registry.example/ryph-agent:1",
      services: ROOM,
      diag: recordingDiagnostics().diag,
      now: clock.now,
      monotonicMs: () => clock.now().getTime(),
      intervalMs: 60_000,
      tickMs: 10_000,
    });
    return { rc, backend };
  };
  const a = replica("a");
  const b = replica("b");
  await a.rc.tick();
  await b.rc.tick();
  assertEquals(a.backend.applied.length, 1);
  assertEquals(b.backend.applied.length, 0);

  row = saved({ standard: 4 }, "2026-01-01T00:00:10.000Z");
  clock.advance(10_000);
  await b.rc.tick();
  await a.rc.tick();
  assertEquals(a.backend.applied.length, 2);
  assertEquals(a.backend.applied[1].reservations[0], ["standard", 4]);
  assertEquals(b.backend.applied.length, 0);
});

test("a replica whose clock runs an hour ahead takes over only after the holder stopped writing", async () => {
  // The finding the shared lease fixed: a contender judged the holder's renewTime by its OWN
  // clock, so one running ahead took over while the holder could still write.
  const lease = memoryLeaseStore();
  const holderClock = fakeClock("2026-01-01T00:00:00.000Z");
  const contenderClock = fakeClock("2026-01-01T01:00:00.000Z");
  const holder = reconciler({
    row: saved({ standard: 1 }),
    clock: holderClock,
    backend: fakeReserver(lease, "holder"),
  });
  const contender = reconciler({
    row: saved({ standard: 1 }),
    clock: contenderClock,
    backend: fakeReserver(lease, "contender"),
  });
  await holder.rc.tick();
  await contender.rc.tick();
  assertEquals(holder.backend.applied.length, 1);
  assertEquals(contender.backend.applied.length, 0);
  // The holder hangs from here on: no tick, no release. Its last pass may still be writing.
  const stillWriting = holder.backend.helds[0];
  let tookOverAt: number | null = null;
  for (let elapsed = 10_000; elapsed <= 300_000; elapsed += 10_000) {
    holderClock.advance(10_000);
    contenderClock.advance(10_000);
    await contender.rc.tick();
    if (contender.backend.applied.length > 0 && tookOverAt === null) tookOverAt = elapsed;
    if (tookOverAt !== null) assertEquals(stillWriting(), false, `two writers at ${elapsed} ms`);
  }
  // Seen at 0, unchanged for the 180 s hold, taken at the first due pass from then on.
  assertEquals(tookOverAt, 180_000);
  assertEquals(lease.current()?.record.holder, "contender");
});

test("the hold is three intervals, never under a minute, and renewed every pass", async () => {
  assertEquals(holdSeconds(60_000, 10_000), 180);
  assertEquals(holdSeconds(1_000, 1_000), 60);
  assertEquals(holdSeconds(100_500, 10_000), 302);
  const { rc, clock, backend } = reconciler();
  await rc.tick();
  const first = backend.lease.current()!;
  assertEquals(first.record.durationMs, 180_000);
  clock.advance(60_000);
  await rc.tick();
  const second = backend.lease.current()!;
  assertEquals(second.record.holder, "me");
  assertEquals(Number(second.version) > Number(first.version), true);
});

test("a tick slower than the interval paces the renewals, so the hold follows it", async () => {
  // RYPH_REAPER_INTERVAL_MS above the reconcile interval: a pass runs only every 200 s, and a
  // hold of three reconcile intervals (180 s) would lapse before each renewal.
  assertEquals(holdSeconds(10_000, 60_000), 180);
  assertEquals(holdSeconds(60_000, 200_000), 600);
  assertEquals(leaseTimings(60_000, 200_000).renewDeadlineMs, 400_000);
  const { rc, clock, backend } = reconciler({ tickMs: 200_000 });
  await rc.tick();
  clock.advance(200_000);
  await rc.tick();
  assertEquals(backend.lease.current()?.record.durationMs, 600_000);
  assertEquals(backend.helds.at(-1)!(), true);
});

test("a holder keeps the lease through one failed renewal, and not two", async () => {
  const { rc, clock, backend } = reconciler({ row: saved({ standard: 1 }) });
  await rc.tick();
  backend.state.down = true;
  clock.advance(60_000);
  await rc.tick();
  backend.state.down = false;
  clock.advance(60_000);
  await rc.tick();
  assertEquals(backend.applied.length, 2);

  backend.state.down = true;
  clock.advance(60_000);
  await rc.tick();
  clock.advance(60_000);
  await rc.tick();
  assertEquals(backend.helds.at(-1)!(), false);
});

test("stop gives the lease up, free at once to the next replica, and ends the passes", async () => {
  const { rc, clock, backend } = reconciler();
  await rc.tick();
  await rc.stop();
  assertEquals(backend.lease.current()?.record.holder, null);
  const version = backend.lease.current()?.version;
  clock.advance(60_000);
  await rc.tick();
  assertEquals(backend.applied.length, 1);
  assertEquals(backend.lease.current()?.version, version);

  // Another replica's next pass takes it without waiting out the hold.
  const next = reconciler({ clock, backend: fakeReserver(backend.lease, "next") });
  await next.rc.tick();
  assertEquals(next.backend.applied.length, 1);
});

test("stop during a tick's row read waits for it and leaves the lease released", async () => {
  const clock = fakeClock();
  const backend = fakeReserver();
  const { diag } = recordingDiagnostics();
  let row: ReservedCapacity | null = saved({ standard: 1 });
  let block: { release: () => void } | null = null;
  const rc = makeCapacityReconciler({
    store: {
      getReservedCapacity: async () => {
        const read = row;
        if (block !== null) await new Promise<void>((resolve) => (block = { release: resolve }));
        return read;
      },
    },
    reserver: backend.reserver,
    runSizes: SIZES,
    image: "registry.example/ryph-agent:1",
    services: ROOM,
    diag,
    now: clock.now,
    monotonicMs: () => clock.now().getTime(),
    intervalMs: 60_000,
    tickMs: 10_000,
  });
  await rc.tick();
  const version = backend.lease.current()?.version;

  // A save lands just before shutdown; the holder's next (not due) tick is reading it when the
  // drain stops the reconciler.
  row = saved({ standard: 2 }, "2026-01-01T00:00:10.000Z");
  clock.advance(10_000);
  block = { release: () => {} };
  const ticking = rc.tick();
  await Promise.resolve();
  const stopping = rc.stop();
  (block as { release: () => void }).release();
  await Promise.all([ticking, stopping]);

  // The tick did not renew the lease for the exiting process, only the release wrote it.
  assertEquals(Number(backend.lease.current()?.version), Number(version) + 1);
  assertEquals(backend.lease.current()?.record.holder, null);
  assertEquals(backend.applied.length, 1);
});

test("a release that fails is logged, never thrown", async () => {
  const { rc, backend, events } = reconciler();
  await rc.tick();
  backend.state.down = true;
  await rc.stop();
  assertEquals(events.filter((e) => e.event.endsWith("_failed")).map((e) => e.event), [
    "capacity.release_failed",
  ]);
});

test("status is the backend's", async () => {
  const { rc } = reconciler();
  assertEquals(await rc.status(), [{ sizeClass: "standard", ready: 1 }]);
});

test("each slot is told the service room, and answers how many services it holds", () => {
  const { rc } = reconciler();
  assertEquals(rc.servicesHeld(SIZES.classes[0]), 3);
});

test("the service room is the policy's count and cpu, and the largest memory a service gets", () => {
  const on = { ...DEFAULT_SERVICE_POLICY, enabled: true };
  const entry = (memory: string) => ({
    id: "x",
    name: "x",
    description: "",
    docs: "https://example.com",
    versions: {},
    defaultPort: 1,
    capabilities: [],
    memory,
    env: [],
  });
  // The policy's 1g is more than every floor here, so it stands.
  assertEquals(serviceRoom(on, [entry("512m"), entry("256m")]), {
    count: 3,
    cpus: "1",
    memory: "1g",
    browser: null,
  });
  // A floor above the policy is what one of those services actually gets.
  assertEquals(serviceRoom({ ...on, memory: "256m" }, [entry("512m"), entry("2g")]).memory, "2g");
  // No catalogue: an image outside one gets the policy's.
  assertEquals(serviceRoom({ ...on, max: 5, cpus: "0.5" }, []), {
    count: 5,
    cpus: "0.5",
    memory: "1g",
    browser: null,
  });
  // A browser rides along as given, services on or off.
  assertEquals(
    serviceRoom({ ...on, enabled: false }, [], { cpus: "1", memory: "1536Mi" }).browser,
    { cpus: "1", memory: "1536Mi" },
  );
  // Services off: nothing to hold room for.
  assertEquals(serviceRoom(DEFAULT_SERVICE_POLICY, [entry("2g")]).count, 0);
});
