// The pace a host's acks keep: per run across its tunnels, per process split fairly between the
// runs that want it, each frame charged what it costs the host. Driven on a clock of the test's
// own, the pacer served by hand (`serve`) as its timer would.
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  ackCost,
  Budget,
  hostMux,
  MAX_FRAME,
  MAX_STREAMS,
  Pacer,
  POD_ACK_BURST,
  POD_ACK_RATE,
  RUN_ACK_BURST,
  RUN_ACK_RATE,
} from "../src/mod.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A wire that counts the acks it is sent. */
function ackWire() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    acks: 0,
    send(data: unknown) {
      if (typeof data === "string" && data.startsWith('{"ack"')) this.acks++;
    },
    close() {
      this.readyState = 3;
    },
  };
}

function dataFrame(id: number, length: number): ArrayBuffer {
  const out = new Uint8Array(4 + length).fill(66);
  new DataView(out.buffer).setUint32(0, id);
  return out.buffer;
}

test("pace: a frame costs a unit and one per 4 KiB, so tiny frames buy no more of the host than bulk", () => {
  assertEquals(ackCost(1), 1);
  assertEquals(ackCost(4095), 1);
  assertEquals(ackCost(4096), 2);
  assertEquals(ackCost(MAX_FRAME), 17);
  // Per byte a full frame is some 3800 times cheaper than a 1-byte one: a run's units buy
  // RUN_ACK_RATE tiny frames a second, or ~95 MB of full ones.
  assert(MAX_FRAME / ackCost(MAX_FRAME) > 3800 * (1 / ackCost(1)));
  assert(RUN_ACK_RATE / ackCost(MAX_FRAME) * MAX_FRAME > 90e6);
  // The process's pace is a fair share of more than one run's, and holds a run's burst.
  assert(POD_ACK_RATE > RUN_ACK_RATE && POD_ACK_BURST >= RUN_ACK_BURST);
});

test("pace: a run's tunnels share one pace, and another run's are not held to it", async () => {
  const clock = 0;
  const budget = new Budget({ pace: { now: () => clock } });
  // Four tunnels of one run, each a stream whose runner sends 1-byte frames, each once the last
  // is acked, until no ack comes: the clock never moves.
  const tunnels = await Promise.all(Array.from({ length: 4 }, async () => {
    const wire = ackWire();
    const mux = hostMux(wire, { budget, group: "run" });
    (await mux.stream()).resume();
    return { wire, mux, sent: 0 };
  }));
  for (let moved = true; moved;) {
    moved = false;
    for (const tunnel of tunnels) {
      if (tunnel.wire.acks < tunnel.sent) continue;
      assertEquals(tunnel.mux.receive(dataFrame(0, 1)), "ok");
      tunnel.sent++;
      moved = true;
    }
    // The readers take what was pushed.
    await tick();
  }
  // One run's burst between them, not four.
  assertEquals(tunnels.reduce((sum, one) => sum + one.wire.acks, 0), RUN_ACK_BURST);
  // Another run's frames are acked at once: it has its own pace.
  const wire = ackWire();
  const other = hostMux(wire, { budget, group: "other" });
  (await other.stream()).resume();
  assertEquals(other.receive(dataFrame(0, 1)), "ok");
  assertEquals(wire.acks, 1);
  for (const tunnel of tunnels) tunnel.mux.close();
  other.close();
});

/** Rounds of `ms` milliseconds of a pacer's clock, served each millisecond as its timer would. */
async function run(pacer: Pacer, clock: { now: number }, ms: number) {
  for (let i = 0; i < ms; i++) {
    clock.now += 1;
    pacer.serve();
    // What its acks paced again goes in turn.
    await tick();
  }
}

/** A run whose runner answers every ack at once with another frame of `cost`, on `streams`
 * streams: as many acks waiting as it has streams, always. Counts what it was let spend. */
function flood(pacer: Pacer, group: string, cost: number, streams: number) {
  const spent = { units: 0 };
  for (let i = 0; i < streams; i++) {
    const again = () => {
      spent.units += cost;
      queueMicrotask(() => pacer.pace(group, cost, again));
    };
    pacer.pace(group, cost, again);
  }
  return spent;
}

test("pace: runs contending for the process each get an equal part, and one alone has its own pace", async () => {
  const clock = { now: 0 };
  const opts = { runRate: 1000, runBurst: 10, rate: 1500, burst: 10, now: () => clock.now };
  // Alone, a run has its own rate: more than its part when others contend.
  const alone = new Pacer(opts);
  const solo = flood(alone, "a", 1, 48);
  await run(alone, clock, 1000);
  assert(Math.abs(solo.units - 1000) <= 20, `${solo.units} units alone`);
  // Two hostile runs sending tiny frames on 48 streams each, and an honest bulk download on one:
  // each gets a third of the process's units, whatever its frames cost.
  const pacer = new Pacer(opts);
  const hostile = [flood(pacer, "a", 1, 48), flood(pacer, "b", 1, 48)];
  const honest = flood(pacer, "h", ackCost(MAX_FRAME), 1);
  await run(pacer, clock, 1000);
  const [a, b, h] = [hostile[0].units, hostile[1].units, honest.units].map((units) => units);
  for (const units of [a, b, h]) assert(units >= 450 && units <= 560, `${a} ${b} ${h}`);
  // The process's pace holds across them.
  assert(a + b + h <= 1500 + 10 + 3 * 17, `${a + b + h} in all`);
});

test("pace: beside two hostile runs, an honest event stream's acks wait a millisecond or two, not their turn behind the floods", async () => {
  const clock = { now: 0 };
  const pacer = new Pacer({
    runRate: 1000,
    runBurst: 10,
    rate: 1500,
    burst: 10,
    now: () => clock.now,
  });
  flood(pacer, "a", 1, 48);
  flood(pacer, "b", 1, 48);
  let worst = 0;
  for (let i = 0; i < 100; i++) {
    // An event every 10 ms, its ack waited on.
    const at = clock.now;
    let acked: number | null = null;
    pacer.pace("events", 1, () => acked = clock.now);
    await run(pacer, clock, 10);
    assert(acked !== null, `event ${i} was never acked`);
    worst = Math.max(worst, acked - at);
  }
  // At most the process's next token or two, at 1.5 a millisecond; never behind 96 waiting acks.
  assert(worst <= 2, `${worst} ms`);
});

test("pace: a run that spent while nobody contended is not held to it once others come", async () => {
  const clock = { now: 0 };
  const pacer = new Pacer({
    runRate: 1000,
    runBurst: 10,
    rate: 1000,
    burst: 10,
    now: () => clock.now,
  });
  // "a" alone for a long while, then "b" comes: they split the process evenly from then on.
  const a = flood(pacer, "a", 1, 8);
  await run(pacer, clock, 2000);
  const before = a.units;
  const b = flood(pacer, "b", 1, 8);
  await run(pacer, clock, 1000);
  const since = a.units - before;
  assert(Math.abs(since - b.units) <= 20, `${since} and ${b.units}`);
});

test("pace: an ack cancelled while it waits leaves the line at once, and its run is charged what it would have cost", () => {
  const clock = { now: 0 };
  const pacer = new Pacer({
    runRate: 1000,
    runBurst: 1,
    rate: 1000,
    burst: 1,
    now: () => clock.now,
  });
  let sent = 0;
  // The run's one token goes; then three acks of streams that go away, and one that stays.
  pacer.pace("run", 1, () => sent++);
  const gone = Array.from({ length: 3 }, () => pacer.pace("run", 100, () => sent += 100));
  pacer.pace("run", 1, () => sent++);
  assertEquals([sent, pacer.waiting], [1, 4]);
  for (const cancel of gone) cancel();
  // Counted out of the line at once, and never sent.
  assertEquals(pacer.waiting, 1);
  // Their frames were taken all the same: 300 units the run waits off before its next ack.
  while (sent === 1 && clock.now < 1000) {
    clock.now += 1;
    pacer.serve();
  }
  assert(clock.now >= 300 && clock.now <= 302, `the ack went at ${clock.now} ms`);
  assertEquals([sent, pacer.waiting], [2, 0]);
  // A cancel after its ack went, or a second one, charges nothing.
  for (const cancel of gone) cancel();
  clock.now += 1;
  pacer.pace("run", 1, () => sent++);
  assertEquals(sent, 3);
});

test("pace: late messages are charged to their run's pace", async () => {
  let clock = 0;
  const budget = new Budget({ pace: { now: () => clock, runBurst: 20, burst: 20 } });
  const wire = ackWire();
  const host = hostMux(wire, { budget, group: "run" });
  (await host.stream()).destroy();
  // A late full frame costs what an acked one would: 17 of the run's 20 units.
  assertEquals(host.receive(dataFrame(0, MAX_FRAME)), "ok");
  (await host.stream()).resume();
  // Three units are left: three tiny frames are acked at once, the fourth waits for the clock.
  for (let i = 0; i < 4; i++) {
    assertEquals(host.receive(dataFrame(1, 1)), "ok");
    await tick();
  }
  assertEquals([wire.acks, budget.pacer.waiting], [3, 1]);
  clock += 1000;
  budget.pacer.serve();
  assertEquals([wire.acks, budget.pacer.waiting], [4, 0]);
  host.close();
});

test("pace: a run's late messages go into debt of their own at most a burst deep, and are held to its rate past it", () => {
  const clock = { now: 0 };
  const pacer = new Pacer({ now: () => clock.now });
  const full = ackCost(MAX_FRAME);
  // At once: its burst, and a burst of debt.
  let taken = 0;
  while (pacer.late("run", full)) taken += full;
  assert(taken > 2 * RUN_ACK_BURST - full && taken <= 2 * RUN_ACK_BURST, `${taken} units`);
  // Then, offered at ~2.8 times its rate for a second, it takes its rate.
  taken = 0;
  for (let ms = 0; ms < 1000; ms++) {
    clock.now += 1;
    for (let i = 0; i < 4; i++) if (pacer.late("run", full)) taken += full;
  }
  assert(Math.abs(taken - RUN_ACK_RATE) <= 2 * full, `${taken} units in a second`);
  // Another run's are its own.
  assert(pacer.late("other", full));
});

test("pace: a run's late messages are paid for in its own turn: another run's ack never waits on them, and the process never goes into debt for them", async () => {
  const clock = { now: 0 };
  const pacer = new Pacer({ now: () => clock.now });
  // The hostile run floods acks on 48 streams, and every millisecond offers ~2.8 times its rate
  // in late full frames on top.
  flood(pacer, "hostile", 1, 48);
  let lowest = Infinity;
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    // An honest run's ack every 10 ms, timed.
    const at = clock.now;
    let acked: number | null = null;
    pacer.pace("honest", 1, () => acked = clock.now);
    for (let ms = 0; ms < 10; ms++) {
      clock.now += 1;
      for (let k = 0; k < 4; k++) pacer.late("hostile", ackCost(MAX_FRAME));
      lowest = Math.min(lowest, pacer.tokens);
      pacer.serve();
      await tick();
    }
    assert(acked !== null, `ack ${i} was never sent`);
    worst = Math.max(worst, acked - at);
  }
  assert(worst <= 2, `${worst} ms`);
  // At most a millisecond's credit, and a frame, below empty.
  assert(lowest >= -(POD_ACK_RATE / 1000 + ackCost(MAX_FRAME)), `${lowest} tokens`);
});

test("pace: a runner that churns streams to send late full frames past its run's pace is cut off, and another run's first ack does not wait on it", async () => {
  let clock = 0;
  const budget = new Budget({ now: () => clock });
  const host = hostMux(ackWire(), { budget, group: "hostile", now: () => clock });
  // A thousand streams a second, each closed by the runner and followed by four full frames:
  // some 3.5 times the run's rate (before, 18 000 of 18 000 were taken, 938 MiB in 3 s).
  let taken = 0;
  let answer = "ok";
  for (let i = 0; i < 3000 && answer === "ok"; i++) {
    clock = i;
    (await host.stream()).resume();
    for (
      const one of [
        dataFrame(i, MAX_FRAME),
        `{"close":${i}}`,
        ...Array(4).fill(dataFrame(i, MAX_FRAME)),
      ]
    ) {
      answer = host.receive(one);
      if (answer !== "ok") break;
      taken++;
    }
    budget.pacer.serve();
  }
  assertEquals(answer, "invalid");
  // Two bursts and its rate's worth for the time it took, not three seconds of it.
  assert(taken < 2000, `${taken} messages taken`);
  assert(budget.pacer.tokens >= -(POD_ACK_RATE / 1000 + ackCost(MAX_FRAME)));
  // An honest run's first ack goes at once (it waited 237–985 ms before).
  const wire = ackWire();
  const honest = hostMux(wire, { budget, group: "honest", now: () => clock });
  (await honest.stream()).resume();
  assertEquals(honest.receive(dataFrame(0, 1)), "ok");
  assertEquals(wire.acks, 1);
  host.close();
  honest.close();
});

test("pace: an honest runner's late full frames, every stream of a run let go at once and then a thousand a second, never break its tunnel", async () => {
  let clock = 0;
  const budget = new Budget({ now: () => clock });
  const host = hostMux(ackWire(), { budget, group: "run", now: () => clock });
  // The most a runner may have in flight for a stream the host lets go: a full frame, an ack, an
  // end and a close.
  const late = (
    id: number,
  ) => [dataFrame(id, MAX_FRAME), `{"ack":${id}}`, `{"end":${id}}`, `{"close":${id}}`];
  const streams = await Promise.all(Array.from({ length: MAX_STREAMS }, () => host.stream()));
  for (const stream of streams) stream.destroy();
  for (let id = 0; id < MAX_STREAMS; id++) {
    for (const one of late(id)) assertEquals(host.receive(one), "ok", `stream ${id}`);
  }
  for (let id = MAX_STREAMS; id < MAX_STREAMS + 10_000; id++) {
    clock += 1;
    (await host.stream()).destroy();
    for (const one of late(id)) assertEquals(host.receive(one), "ok", `stream ${id}`);
  }
  host.close();
});

test("pace: streams that come and go while their run is in debt leave no acks waiting, and pin nothing", async () => {
  let clock = 0;
  const budget = new Budget({ now: () => clock });
  const host = hostMux(ackWire(), { budget, group: "run", now: () => clock });
  // Deep in debt: every ack waits.
  budget.pacer.charge("run", 100 * RUN_ACK_BURST);
  // A stream that stays, its ack at the head of the run's line.
  (await host.stream()).resume();
  assertEquals(host.receive(dataFrame(0, 1)), "ok");
  assertEquals(budget.pacer.waiting, 1);
  // Three thousand that come and go, each with a frame its reader took, its ack waiting when it
  // goes (before, 2900 of them stayed queued, pinning 45.8 MiB of streams nobody could reach).
  const gone: WeakRef<object>[] = [];
  for (let i = 1; i <= 3000; i++) {
    clock = i;
    const stream = await host.stream();
    stream.resume();
    gone.push(new WeakRef(stream));
    assertEquals(host.receive(dataFrame(i, 16_000)), "ok");
    assertEquals(budget.pacer.waiting, 2);
    assertEquals(host.receive(`{"close":${i}}`), "ok");
    assertEquals(budget.pacer.waiting, 1);
    budget.pacer.serve();
  }
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const reachable = gone.filter((one) => one.deref() !== undefined).length;
  assert(reachable <= 3, `${reachable} of the streams gone are still reachable`);
  host.close();
});

test("pace: runs that come and go while contention never breaks are forgotten", async () => {
  const clock = { now: 0 };
  const pacer = new Pacer({
    runRate: 1000,
    runBurst: 10,
    rate: 1000,
    burst: 10,
    now: () => clock.now,
  });
  // Always waiting, so contention never breaks.
  flood(pacer, "flood", 5, 2);
  for (let i = 0; i < 5000; i++) {
    pacer.pace(`run-${i}`, 1, () => {});
    await run(pacer, clock, 1);
  }
  // What still waits is let go; then a while on, a probe prunes.
  await run(pacer, clock, 100);
  clock.now += 5000;
  pacer.pace("probe", 1, () => {});
  // The flood and the probe: before, 4996 of the 5000 were remembered.
  assert(pacer.runs <= 2, `${pacer.runs} runs remembered`);
});

test("pace: a run forgotten while it paces is not split in two", () => {
  const clock = { now: 0 };
  const pacer = new Pacer({
    runRate: 0.001,
    runBurst: 10,
    rate: 100,
    burst: 10,
    now: () => clock.now,
  });
  let sent = 0;
  // "a" is remembered, its bucket full.
  pacer.pace("a", 0, () => {});
  // The process deep in debt (an ack's cost may take it there on credit): what comes next waits.
  clock.now += 10;
  pacer.pace("b", 2000, () => {});
  // Past the prune's interval: "a"'s next ack is the one that prunes.
  clock.now = 10_000;
  for (let i = 0; i < 40; i++) pacer.pace("a", 1, () => sent++);
  assertEquals(pacer.waiting, 40);
  for (let i = 0; i < 300; i++) {
    clock.now += 100;
    pacer.serve();
  }
  // One bucket's worth. Forgotten after its lookup, its first ack would have waited in a run of
  // its own and the rest in another, with a full bucket of its own: 11.
  assertEquals(sent, 10);
});

test("pace: a send that throws while its timer serves the line is said, not thrown, and the line is served after", () => {
  const clock = { now: 0 };
  // The pacer's timers, fired by hand.
  const timers: (() => void)[] = [];
  const said: unknown[] = [];
  const [setTimer, clearTimer] = [globalThis.setTimeout, globalThis.clearTimeout];
  globalThis.setTimeout = ((fire: () => void) => {
    timers.push(fire);
    return { unref() {} };
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
  try {
    const pacer = new Pacer({
      runRate: 1000,
      runBurst: 1,
      rate: 1000,
      burst: 1,
      now: () => clock.now,
      log: (error) => said.push(error),
    });
    let sent = 0;
    pacer.pace("run", 1, () => sent++);
    pacer.pace("run", 1, () => {
      throw new Error("send failed");
    });
    pacer.pace("run", 1, () => sent++);
    assertEquals(timers.length, 1);
    clock.now += 1;
    // Said, not thrown out of the timer, where it would take the process down.
    timers.shift()!();
    assertEquals(said.map(String), ["Error: send failed"]);
    // It comes back for the next all the same (before, nothing did until the next ack came).
    assertEquals(timers.length, 1);
    clock.now += 1;
    timers.shift()!();
    assertEquals([sent, pacer.waiting], [2, 0]);
  } finally {
    globalThis.setTimeout = setTimer;
    globalThis.clearTimeout = clearTimer;
  }
});

test("pace: beside two floods, a light run's burst of small messages, each sent once the last is acked, is not held a timer tick apiece", async () => {
  const clock = { now: 0 };
  const pacer = new Pacer({ now: () => clock.now });
  flood(pacer, "a", 1, 48);
  flood(pacer, "b", 1, 48);
  await run(pacer, clock, 100);
  // Two hundred messages, at most fifteen a millisecond (what a real one managed alone: 200 in
  // ~13 ms), each once the last is acked.
  let acked = 0;
  let inFlight = false;
  const start = clock.now;
  while (acked < 200 && clock.now - start < 1000) {
    for (let i = 0; i < 15 && !inFlight && acked < 200; i++) {
      inFlight = true;
      pacer.pace("light", 1, () => {
        acked++;
        inFlight = false;
      });
    }
    await run(pacer, clock, 1);
  }
  // Before, ~200 ms: a tick for each once it had spent a unit.
  assert(clock.now - start <= 30, `${clock.now - start} ms for 200`);
});

test("pace: a clock stepped back credits nothing when it comes forward again", () => {
  const clock = { now: 1000 };
  const pacer = new Pacer({
    runRate: 1000,
    runBurst: 10,
    rate: 1000,
    burst: 10,
    now: () => clock.now,
  });
  // Into the deepest debt late messages may take.
  assertEquals(pacer.late("run", 20), true);
  assertEquals(pacer.late("run", 1), false);
  // Back a second (NTP, a VM resumed), then forward to where it was: no time has passed.
  clock.now = 0;
  assertEquals(pacer.late("run", 1), false);
  clock.now = 1000;
  assertEquals(pacer.late("run", 1), false);
  // A millisecond past it, a unit is earned.
  clock.now = 1001;
  assertEquals(pacer.late("run", 1), true);
});
