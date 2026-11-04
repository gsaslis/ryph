// The lease's rules against an in-memory store and a clock that moves only when a test
// moves it: taking a free lease, never taking one that is being renewed, taking one that has gone
// still for its duration by OUR clock, a holder that stops holding before anyone may take over,
// release — and the races: two takers, a renewal whose answer was lost, a release behind a renewal.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type Lease, type LeaseDeps, makeLease } from "../src/lease.ts";
import type { LeaseStore } from "../src/lease_store.ts";
import { memoryLeaseStore } from "./memory_lease_store.ts";

const T0 = Date.parse("2026-09-12T20:00:00Z");

/**
 * `now` is the monotonic clock every interval is timed on; `wallStep` is how far the wall clock
 * has been stepped away from it (an NTP correction), which only the written renewedAt may see.
 */
function gateway(
  store: LeaseStore,
  identity: string,
  clock: { now: number; wallStep?: number },
  opts: { sleep?: LeaseDeps["sleep"]; warnings?: string[] } = {},
): Lease {
  return makeLease({
    store,
    identity,
    now: () => new Date(clock.now + (clock.wallStep ?? 0)),
    monotonicMs: () => clock.now,
    diag: { debug() {}, warn: (event) => opts.warnings?.push(event) },
    timings: { durationMs: 15_000, renewDeadlineMs: 10_000, retryMs: 2_000 },
    sleep: opts.sleep,
  });
}

/**
 * A sleep on the test's clock that lets every answer already on its way arrive first, as a real
 * timer does — the in-memory store answers in microtasks, and a timer fires after them — and that
 * moves the clock only if nothing called it off meanwhile.
 */
function napsOn(clock: { now: number }): NonNullable<LeaseDeps["sleep"]> {
  return async (ms, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!signal.aborted) clock.now += ms;
  };
}

test("the first gateway creates the lease and holds it", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  assert(!a.held());
  await a.tick();
  assert(a.held());
  assertEquals(store.current()?.record.holder, "a");
  assertEquals(store.current()?.record.transitions, 0);
});

test("a lease its holder keeps renewing is never taken, however long it is held", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  const b = gateway(store, "b", clock);
  await a.tick();
  for (let i = 0; i < 60; i++) {
    clock.now += 2_000;
    await a.tick();
    await b.tick();
    assert(a.held(), `a, round ${i}`);
    assert(!b.held(), `b, round ${i}`);
  }
  assertEquals(store.current()?.record.holder, "a");
});

test("a lease that goes still is taken after its duration by the taker's clock, not the holder's", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  // Renewed a year ago by the holder's clock. A skewed or stale renewTime must not make it free:
  // only watching it stay unchanged does.
  store.overwrite({
    holder: "a",
    durationMs: 15_000,
    renewedAt: "2025-09-12T20:00:00.000Z",
    transitions: 3,
  });
  const b = gateway(store, "b", clock);
  await b.tick();
  assert(!b.held());
  clock.now += 14_999;
  await b.tick();
  assert(!b.held());
  clock.now += 1;
  await b.tick();
  assert(b.held());
  assertEquals(store.current()?.record.holder, "b");
  assertEquals(store.current()?.record.transitions, 4);
});

test("a contender whose clock runs an hour ahead takes over only after the holder stopped acting", async () => {
  const store = memoryLeaseStore();
  // Two clocks that tick together and disagree by an hour: the holder's renewTime, read by the
  // contender's clock, is an hour stale from the first renewal on.
  const holderClock = { now: T0 };
  const contenderClock = { now: T0 + 3_600_000 };
  const step = (ms: number) => {
    holderClock.now += ms;
    contenderClock.now += ms;
  };
  const a = gateway(store, "a", holderClock);
  const b = gateway(store, "b", contenderClock);
  await a.tick();
  await b.tick();
  assert(a.held());
  assert(!b.held(), "an hour-old renewTime is not an expired lease");
  // a stops renewing. Every millisecond a may still act, b may not.
  for (let at = 1_000; at < 10_000; at += 1_000) {
    step(1_000);
    await b.tick();
    assert(a.held(), `a, ${at} ms`);
    assert(!b.held(), `b, ${at} ms`);
  }
  step(1_000);
  assert(!a.held(), "a stops acting at its renew deadline");
  await b.tick();
  assert(!b.held(), "and b waits out the rest of the duration by its own clock");
  step(4_999);
  await b.tick();
  assert(!b.held());
  step(1);
  await b.tick();
  assert(b.held());
  assert(!a.held());
});

test("a stepped wall clock moves neither the holder's deadline nor the taker's count", async () => {
  const store = memoryLeaseStore();
  const holderClock: { now: number; wallStep?: number } = { now: T0 };
  const contenderClock: { now: number; wallStep?: number } = { now: T0 };
  const a = gateway(store, "a", holderClock);
  const b = gateway(store, "b", contenderClock);
  await a.tick();
  await b.tick();
  // a stops renewing; NTP then steps a's wall clock back an hour and b's forward ninety seconds.
  holderClock.wallStep = -3_600_000;
  contenderClock.wallStep = 90_000;
  holderClock.now += 10_000;
  contenderClock.now += 10_000;
  assert(!a.held(), "a stops acting at its renew deadline, the step notwithstanding");
  await b.tick();
  assert(!b.held(), "b still counts the whole duration from when it first saw the version");
  holderClock.now += 4_999;
  contenderClock.now += 4_999;
  await b.tick();
  assert(!b.held());
  contenderClock.now += 1;
  await b.tick();
  assert(b.held());
  // What b writes for an operator is its wall clock, step included.
  assertEquals(store.current()?.record.renewedAt, new Date(T0 + 15_000 + 90_000).toISOString());
});

test("a slow read does not backdate what it saw: a renewal landing during it still counts", async () => {
  const inner = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(inner, "a", clock);
  await a.tick();
  // b's first read takes 16 s to answer, and a renews while it is in flight.
  let slow = true;
  const store: LeaseStore = {
    kind: "slow",
    read: async () => {
      if (slow) {
        slow = false;
        clock.now += 16_000;
        await a.tick();
      }
      return inner.read();
    },
    create: (record) => inner.create(record),
    replace: (record, version) => inner.replace(record, version),
  };
  const b = gateway(store, "b", clock);
  await b.tick();
  assert(a.held(), "a renewed at T0+16 s, so it holds until T0+26 s");
  // Counted from when b's read was SENT, the version would look 18 s still here and b would take
  // it while a still acts. Counted from when it was seen, it has been still for 2 s.
  for (const at of [18_000, 25_999]) {
    clock.now = T0 + at;
    await b.tick();
    assert(!b.held(), `b must not hold it at ${at} ms while a does`);
  }
  // a never renews again. It stops acting at T0+26 s; b may take it at T0+31 s.
  clock.now = T0 + 26_000;
  assert(!a.held());
  clock.now = T0 + 30_999;
  await b.tick();
  assert(!b.held());
  clock.now = T0 + 31_000;
  await b.tick();
  assert(b.held());
});

test("a holder that stops renewing stops holding before anyone may take over", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  const b = gateway(store, "b", clock);
  await a.tick();
  await b.tick();
  // a freezes — a stalled event loop, a partition — and never ticks again.
  clock.now += 9_999;
  assert(a.held());
  clock.now += 1;
  assert(!a.held(), "a stops acting at its renew deadline");
  await b.tick();
  assert(!b.held(), "and b may not act yet: between the two, nobody does, on purpose");
  clock.now += 5_000;
  await b.tick();
  assert(b.held());
});

test("renewals that keep failing hold until the deadline, and keep then reports the lease lost", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const warnings: string[] = [];
  const a = gateway(store, "a", clock, { warnings, sleep: napsOn(clock) });
  await a.tick();
  store.failNext(100);
  assertEquals(await a.keep(new AbortController().signal), "lost");
  assert(!a.held());
  assertEquals(clock.now - T0, 10_000);
  assertEquals(warnings, ["lease.lost"]);
});

test("a renewal that never answers does not hold keep past the deadline: the loss is reported on time", async () => {
  const inner = memoryLeaseStore();
  const clock = { now: T0 };
  const warnings: string[] = [];
  let hang = false;
  const store: LeaseStore = {
    kind: "hanging",
    read: () => inner.read(),
    create: (record) => inner.create(record),
    // A request the API server took and never answered: no error, no status, nothing.
    replace: (record, version) => hang ? new Promise(() => {}) : inner.replace(record, version),
  };
  const a = gateway(store, "a", clock, { warnings, sleep: napsOn(clock) });
  await a.tick();
  hang = true;
  // Waiting on the renewal would leave this pod ready and serving while a successor takes over at
  // T0+15 s. A real-time guard, so the old behaviour fails the test instead of hanging it.
  let guard: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    a.keep(new AbortController().signal),
    new Promise<string>((resolve) => {
      guard = setTimeout(() => resolve("still waiting on the renewal"), 1_000);
    }),
  ]);
  clearTimeout(guard);
  assertEquals(outcome, "lost");
  assertEquals(clock.now - T0, 10_000);
  assertEquals(warnings, ["lease.lost"]);
});

test("a holder whose lease was taken notices on its next renewal", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const warnings: string[] = [];
  const a = gateway(store, "a", clock, { warnings });
  await a.tick();
  store.overwrite({
    holder: "b",
    durationMs: 15_000,
    renewedAt: new Date(T0).toISOString(),
    transitions: 1,
  });
  clock.now += 2_000;
  await a.tick();
  assert(!a.held());
  assertEquals(warnings, ["lease.lost"]);
});

test("a renewal that landed with its answer lost is not mistaken for a takeover", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const warnings: string[] = [];
  const a = gateway(store, "a", clock, { warnings });
  await a.tick();
  // Our own write, landed: the version moved, the holder is still us.
  const landed = store.current()!;
  store.overwrite({ ...landed.record, renewedAt: new Date(T0 + 1_000).toISOString() });
  clock.now += 2_000;
  await a.tick();
  assert(a.held());
  clock.now += 2_000;
  await a.tick();
  assert(a.held());
  assertEquals(store.current()?.record.holder, "a");
  assertEquals(warnings, []);
});

test("a take that landed with its answer lost is claimed only by a guarded write", async () => {
  const inner = memoryLeaseStore();
  const clock = { now: T0 };
  // Our take landed and its answer was lost: the store says "a", this process knows nothing.
  await gateway(inner, "a", clock).tick();
  let afterRead = () => {};
  const store: LeaseStore = {
    ...inner,
    read: async () => {
      const read = await inner.read();
      afterRead();
      return read;
    },
  };
  const a = gateway(store, "a", clock);
  // A taker that has seen that version still for its duration replaces it the moment after our
  // read: the read said "a", but the lease is no longer ours.
  afterRead = () => {
    afterRead = () => {};
    inner.overwrite({ ...inner.current()!.record, holder: "b" });
  };
  await a.tick();
  assert(!a.held());
  assertEquals(inner.current()?.record.holder, "b");

  // With nobody in between, the same recovery claims it.
  const c = memoryLeaseStore();
  await gateway(c, "a", clock).tick();
  const again = gateway(c, "a", clock);
  await again.tick();
  assert(again.held());
});

test("a released lease is taken at once", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  const b = gateway(store, "b", clock);
  await a.tick();
  await b.tick();
  await a.release();
  assert(!a.held());
  assertEquals(store.current()?.record.holder, null);
  await b.tick();
  assert(b.held());
  assertEquals(store.current()?.record.transitions, 1);
});

test("two gateways taking the same free lease: exactly one wins, and the other knows it", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  store.overwrite({
    holder: null,
    durationMs: 15_000,
    renewedAt: new Date(T0).toISOString(),
    transitions: 1,
  });
  const b = gateway(store, "b", clock);
  const c = gateway(store, "c", clock);
  await Promise.all([b.tick(), c.tick()]);
  assertEquals([b.held(), c.held()].filter(Boolean).length, 1);
  clock.now += 2_000;
  await Promise.all([b.tick(), c.tick()]);
  assertEquals([b.held(), c.held()].filter(Boolean).length, 1);
});

test("release waits for a renewal in flight rather than racing it", async () => {
  const inner = memoryLeaseStore();
  const clock = { now: T0 };
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let holdNextReplace = false;
  const store: LeaseStore = {
    kind: "gated",
    read: () => inner.read(),
    create: (record) => inner.create(record),
    replace: async (record, version) => {
      if (holdNextReplace) {
        holdNextReplace = false;
        await gate;
      }
      return inner.replace(record, version);
    },
  };
  const a = gateway(store, "a", clock);
  await a.tick();
  holdNextReplace = true;
  const renewal = a.tick();
  const release = a.release();
  open();
  await renewal;
  await release;
  // Had the release gone out at the version it knew before the renewal landed, it would have been
  // refused, and the next gateway would wait out the whole duration.
  assertEquals(inner.current()?.record.holder, null);
});

test("acquire waits while another gateway holds the lease, and gives up when aborted", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  await a.tick();
  const stop = new AbortController();
  let naps = 0;
  const b = gateway(store, "b", clock, {
    sleep: (ms) => {
      clock.now += ms;
      if (++naps === 3) stop.abort();
      return a.tick();
    },
  });
  await assertRejects(() => b.acquire(stop.signal));
  assert(!b.held());
  assert(a.held());
});

test("acquire resolves as soon as the holder releases", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  await a.tick();
  let naps = 0;
  const b = gateway(store, "b", clock, {
    sleep: async (ms) => {
      clock.now += ms;
      if (++naps === 2) await a.release();
      else await a.tick();
    },
  });
  await b.acquire(new AbortController().signal);
  assert(b.held());
  assertEquals(clock.now - T0, 4_000);
});

test("keep stops when told, and gives nothing up by stopping", async () => {
  const store = memoryLeaseStore();
  const clock = { now: T0 };
  const a = gateway(store, "a", clock);
  await a.tick();
  const stop = new AbortController();
  stop.abort();
  assertEquals(await a.keep(stop.signal), "stopped");
  assert(a.held());
  assertEquals(store.current()?.record.holder, "a");
});

test("timings that would leave a holder acting while someone else takes over are refused", () => {
  assertThrows(
    () =>
      makeLease({
        store: memoryLeaseStore(),
        identity: "a",
        now: () => new Date(T0),
        diag: { debug() {}, warn() {} },
        timings: { durationMs: 10_000, renewDeadlineMs: 10_000 },
      }),
    Error,
    "retry < renew deadline < duration",
  );
});
