// The budget every host stream is counted against, driven by hand: a runner end that answers
// every stream with all it may send, browsers that never read, and an honest page beside them.
import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Duplex } from "node:stream";
import {
  Budget,
  type Cap,
  type Charge,
  holdsCharge,
  type HostMux,
  hostMux,
  LINE_FLOOR,
  MAX_FRAME,
  MAX_STREAMS,
  PER_RUN,
  POD_STREAMS,
  POD_WAITING,
  type Pressure,
  promote,
  SERVED_BYTES,
  serves,
  STALL_MS,
  STREAM_BYTES,
} from "../src/mod.ts";

/** A wire that records what it is sent. */
function fakeWire() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as unknown[],
    send(data: unknown) {
      this.sent.push(data);
    },
    close() {
      this.readyState = 3;
    },
  };
}

function dataFrame(id: number, size: number): ArrayBuffer {
  const out = new Uint8Array(4 + size).fill(66);
  new DataView(out.buffer).setUint32(0, id);
  return out.buffer;
}

/**
 * A tunnel whose runner end is hostile: every stream the host opens is sent a full frame at once
 * and another on every ack, as a dev server answering with an endless body would. `asks` streams
 * are asked for at once; what the caps refuse is counted.
 */
function hostile(budget: Budget, group: string, asks = MAX_STREAMS + 16) {
  const wire = fakeWire();
  const mux = hostMux(wire, { budget, group });
  const streams = new Set<Duplex>();
  const refused: string[] = [];
  const flood = () => {
    for (const message of wire.sent.splice(0)) {
      if (typeof message !== "string") continue;
      const signal = JSON.parse(message) as Record<string, number>;
      const id = signal.open ?? signal.ack;
      if (id !== undefined) mux.receive(dataFrame(id, MAX_FRAME));
    }
  };
  for (let i = 0; i < asks; i++) {
    mux.stream().then((stream) => {
      streams.add(stream);
      stream.on("close", () => streams.delete(stream));
      flood();
    }, (error: Error) => refused.push(error.message));
  }
  flood();
  return { mux, streams, flood, wire, refused };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A charge straight from the budget, as a relay takes one: no tunnel behind it. */
const charge = (
  budget: Budget,
  group: string,
  opts: Partial<Parameters<Budget["acquire"]>[1]> = {},
) => budget.acquire<Charge>(group, { ...opts, use: (c) => c });

/** Whether `promise` is still pending after the line has been served. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => settled = true, () => settled = true);
  await settle();
  return !settled;
}

/** A small cap, for lines short enough to fill by hand. */
const small = (open: number, waiting = 8): Cap => ({
  name: "run",
  open,
  long: open,
  waiting,
  waitingLong: waiting,
});

/** One relayed run's cap on a pod that does not own it, as @ryph/previews sets it. */
const PER_RELAY: Cap = { name: "relay", open: 32, long: 24, waiting: 128, waitingLong: 16 };

test("budget: a run's cap is one tunnel's width, which its line's tunnel check relies on", () => {
  // A request for a full tunnel is counted as fitting once a stream of its own group is freed
  // (Budget's blocker): true only while a tunnel is full exactly when its run is.
  assertEquals(PER_RUN.open, MAX_STREAMS);
});

test("budget: a run holds its cap and no more, however many tunnels it has", async () => {
  const budget = new Budget();
  // Four previews of one run, each asking for 48 streams at once: 192, three times its cap.
  const tunnels = Array.from({ length: 4 }, () => hostile(budget, "run", 48));
  await settle();
  for (const tunnel of tunnels) tunnel.flood();
  assertEquals(budget.openBy("run"), PER_RUN.open);
  assertEquals(budget.open, PER_RUN.open);
  // The rest wait in the run's line.
  assertEquals(budget.waiting, 4 * 48 - PER_RUN.open);
  for (const tunnel of tunnels) assertEquals(tunnel.refused, []);
  // Nothing of another run's: its first request goes straight in.
  const other = hostMux(fakeWire(), { budget, group: "other" });
  assert(!(await other.stream()).destroyed);
  other.close();
  for (const tunnel of tunnels) tunnel.mux.close();
  await settle();
  assertEquals(budget.open, 0);
  assertEquals(budget.waiting, 0);
});

test("budget: the process holds its streams and no more, and takes nothing back", async () => {
  // Room for 16 streams; six runs that want 80 each, in a line of 32.
  const budget = new Budget({ streams: 16, waiting: 32 });
  const runs = Array.from({ length: 6 }, (_, i) => hostile(budget, `run-${i}`));
  for (let round = 0; round < 5; round++) {
    await settle();
    for (const run of runs) run.flood();
    assert(budget.open <= budget.streams, `open ${budget.open}`);
  }
  assertEquals(budget.open, 16);
  // First come, first served, and kept: the first run's streams are all its own, none evicted.
  assertEquals(budget.openBy("run-0"), 16);
  const streams = runs.flatMap((run) => [...run.streams]);
  for (const stream of streams) assert(stream.readableLength >= MAX_FRAME);
  // The first run takes half of the line, the next half of what is left, and so on.
  assert(budget.waiting <= 32);
  for (const run of runs) run.mux.close();
  await settle();
  assertEquals(budget.open, 0);
  assertEquals(budget.waiting, 0);
});

test("budget: a request waits its turn, oldest first, then is turned away", async () => {
  const heard: string[] = [];
  const budget = new Budget({
    streams: 2,
    waitMs: 100,
    refused: (group, why, cap) => heard.push(`${group} ${why} ${cap}`),
  });
  const a = hostMux(fakeWire(), { budget, group: "a" });
  const b = hostMux(fakeWire(), { budget, group: "b" });
  const held = [await a.stream(), await a.stream()];
  const order: string[] = [];
  const first = b.stream().then((s) => (order.push("first"), s));
  const second = a.stream().then((s) => (order.push("second"), s));
  const third = b.stream().then((s) => (order.push("third"), s));
  assertEquals(budget.waiting, 3);
  held[0].destroy();
  const one = await first;
  held[1].destroy();
  const two = await second;
  assertEquals(order, ["first", "second"]);
  // Nothing frees in time for the third: it is turned away, and nothing open was touched.
  await assertRejects(() => third, Error, "preview is busy");
  assert(!one.destroyed && !two.destroyed);
  assertEquals(budget.waiting, 0);
  // What it waited on: the process's streams.
  assertEquals(heard, ["b wait expired pod"]);
  a.close();
  b.close();
  assertEquals(budget.open, 0);
});

test("budget: a full line refuses at once, a group's and the process's", async () => {
  const heard: string[] = [];
  const cap = small(1, 2);
  const budget = new Budget({
    waiting: 3,
    refused: (group, _why, cap) => heard.push(`${group} ${cap}`),
  });
  const gone = new AbortController();
  const ask = (group: string) => charge(budget, group, { cap, signal: gone.signal });
  const held = [await ask("a"), await ask("b"), await ask("c")];
  const waiting = [ask("a"), ask("a"), ask("b")];
  for (const one of waiting) one.catch(() => {});
  // The group's line is full.
  await assertRejects(() => ask("a"), Error, "preview is busy");
  // The process's is, with room in the group's.
  await assertRejects(() => ask("c"), Error, "preview is busy");
  assertEquals(budget.waiting, 3);
  assertEquals(heard, ["a run-line", "c pod-line"]);
  // Requests that leave take themselves out of line.
  gone.abort();
  await settle();
  assertEquals(budget.waiting, 0);
  for (const one of held) one.release();
  assertEquals(budget.open, 0);
});

test("budget: three hostile runs cannot fill the line; past its floor each takes at most half of what is left", async () => {
  const budget = new Budget();
  const gone = new AbortController();
  const asked = (group: string, count: number) => {
    let refused = 0;
    const all = Array.from({ length: count }, () => {
      const one = charge(budget, group, { signal: gone.signal });
      one.catch(() => refused++);
      return one;
    });
    return { all, refused: () => refused };
  };
  // Each hostile run holds its 64 streams, and asks for 600 more.
  const held: Charge[] = [];
  for (const run of ["bad-0", "bad-1", "bad-2"]) {
    for (let i = 0; i < PER_RUN.open; i++) held.push(await charge(budget, run));
  }
  const bad = ["bad-0", "bad-1", "bad-2"].map((run) => asked(run, 600));
  await settle();
  // Of the 1024 the floors' reserve leaves: its own line's 512, then half of the 512 the first
  // leaves, then its floor (128), half of the 256 the first two leave being no more.
  assertEquals(bad.map((one) => 600 - one.refused()), [512, 256, LINE_FLOOR]);
  assertEquals(budget.waiting, 896);
  // An honest run's page, 64 streams open and 86 more requests at once, still waits its turn
  // rather than failing: within its floor.
  const honest = [];
  for (let i = 0; i < PER_RUN.open; i++) honest.push(await charge(budget, "honest"));
  const page = asked("honest", 86);
  await settle();
  assertEquals(page.refused(), 0);
  assertEquals(budget.waiting, 896 + 86);
  assert(budget.waiting < POD_WAITING);
  gone.abort();
  await settle();
  for (const one of [...held, ...honest]) one.release();
  assertEquals(budget.waiting, 0);
  assertEquals(budget.open, 0);
});

test("budget: beside five runs filling the line, an honest run's cold load still has its floor", async () => {
  const budget = new Budget();
  const gone = new AbortController();
  const asked = (group: string, count: number) => {
    let refused = 0;
    for (let i = 0; i < count; i++) {
      charge(budget, group, { signal: gone.signal }).catch(() => refused++);
    }
    return () => refused;
  };
  const held: Charge[] = [];
  const runs = ["bad-0", "bad-1", "bad-2", "bad-3", "bad-4", "honest"];
  for (const run of runs) {
    for (let i = 0; i < PER_RUN.open; i++) held.push(await charge(budget, run));
  }
  // Each line-filling run asks for all it may; the halving alone would leave the sixth run some
  // 32 places, and a cold Vite load (a few hundred module requests) would meet 503s.
  for (const run of runs.slice(0, 5)) asked(run, PER_RUN.waiting);
  await settle();
  const filled = budget.waiting;
  const refused = asked("honest", LINE_FLOOR);
  await settle();
  assertEquals(refused(), 0);
  assertEquals(budget.waiting, filled + LINE_FLOOR);
  // Past its floor it is held to the halving like everyone else, and the process's line to
  // POD_WAITING whatever the floors.
  assertEquals(await pending(charge(budget, "honest", { signal: gone.signal })), false);
  assert(budget.waiting <= POD_WAITING);
  gone.abort();
  await settle();
  for (const one of held) one.release();
  assertEquals(budget.waiting, 0);
});

test("budget: an honest run keeps its floor beside seven runs filling the line, not eight; twelve floors fill it", async () => {
  /** A process whose one stream is taken, so every request waits; `bad` runs ask for all they
   * may, then `honest` for its floor. Returns how many of the honest run's were refused. */
  const beside = async (bad: number, floorsOnly = false) => {
    const budget = new Budget({ streams: 1 });
    const gone = new AbortController();
    const taken = await charge(budget, "other");
    let refused = 0;
    const ask = (group: string, count: number) => {
      for (let i = 0; i < count; i++) {
        charge(budget, group, { signal: gone.signal }).catch(() => refused++);
      }
    };
    for (let i = 0; i < bad; i++) ask(`bad-${i}`, floorsOnly ? LINE_FLOOR : PER_RUN.waiting);
    await settle();
    refused = 0;
    ask("honest", LINE_FLOOR);
    await settle();
    const result = { refused, waiting: budget.waiting };
    gone.abort();
    await settle();
    taken.release();
    assertEquals(budget.waiting, 0);
    return result;
  };
  // Three runs past their floors take 512 + 256 + 128; every other its floor.
  assertEquals(await beside(7), { refused: 0, waiting: POD_WAITING });
  assertEquals(await beside(8), { refused: LINE_FLOOR, waiting: POD_WAITING });
  // Runs that keep to their floors: eleven leave the twelfth its own, as eleven at their caps
  // leave an honest run its streams. Past that the pod is starved, of streams and line alike.
  assertEquals(await beside(11, true), { refused: 0, waiting: POD_WAITING });
  assertEquals(await beside(12, true), { refused: LINE_FLOOR, waiting: POD_WAITING });
});

test("budget: relays wait in a line of their own, and the owned runs' line and theirs never borrow", async () => {
  const caps: string[] = [];
  const budget = new Budget({
    streams: 1,
    relays: 1,
    waiting: 24,
    relayWaiting: 8,
    refused: (_group, _why, cap) => caps.push(cap),
  });
  assertEquals(new Budget({ relays: POD_STREAMS / 2 }).maxRelaysWaiting, POD_WAITING / 2);
  const gone = new AbortController();
  const run = (group: string) => charge(budget, group, { cap: small(1, 24), signal: gone.signal });
  const relay = (shard: string) =>
    charge(budget, `relay:${shard}`, { cap: small(1, 8), relay: true, signal: gone.signal });
  const held = [await run("held"), await relay("held")];
  const all: Promise<Charge>[] = [];
  // Relays fill their line...
  for (let i = 0; i < 8; i++) all.push(relay(`s${i % 2}`));
  await assertRejects(() => relay("s2"), Error, "preview is busy");
  assertEquals(caps, ["pod-relay-line"]);
  // ...and the owned runs still have every place of theirs; filling those leaves relays' alone.
  for (let i = 0; i < 24; i++) all.push(run(`r${i % 3}`));
  assertEquals([budget.waiting, budget.relaysWaiting], [32, 8]);
  await assertRejects(() => run("r3"), Error, "preview is busy");
  assertEquals(caps, ["pod-relay-line", "pod-line"]);
  for (const one of all) one.catch(() => {});
  gone.abort();
  await settle();
  assertEquals([budget.waiting, budget.relaysWaiting], [0, 0]);
  // A relay granted from the line counts out of it, too.
  const waits = charge(budget, "relay:s0", { cap: small(1, 8), relay: true });
  assertEquals(budget.relaysWaiting, 1);
  held[1].release();
  (await waits).release();
  assertEquals(budget.relaysWaiting, 0);
  held[0].release();
});

test("budget: a run's long-lived requests waiting never fill the line its short ones wait in", async () => {
  const budget = new Budget();
  const gone = new AbortController();
  const open: Charge[] = [];
  for (let i = 0; i < PER_RUN.long; i++) open.push(await charge(budget, "run", { long: true }));
  // Its long-lived cap is full: more sockets wait, in a line of their own, up to its length.
  const sockets = Array.from(
    { length: PER_RUN.waitingLong },
    () => charge(budget, "run", { long: true, signal: gone.signal }),
  );
  for (const socket of sockets) socket.catch(() => {});
  assertEquals(budget.waiting, PER_RUN.waitingLong);
  await assertRejects(() => charge(budget, "run", { long: true }), Error, "preview is busy");
  // A page's requests still go at once, past every socket in line, as long as the run has room.
  for (let i = PER_RUN.long; i < PER_RUN.open; i++) open.push(await charge(budget, "run"));
  // Then they wait, in their own line, oldest first, and a freed stream goes to the oldest short
  // request: a socket ahead of it does not fit the run's long-lived cap.
  const order: number[] = [];
  const requests = Array.from(
    { length: 3 },
    (_, i) => charge(budget, "run", { signal: gone.signal }).then((c) => (order.push(i), c)),
  );
  assert(await pending(requests[0]));
  assertEquals(budget.waiting, PER_RUN.waitingLong + 3);
  open.pop()!.release();
  const served = await requests[0];
  assertEquals(order, [0]);
  served.release();
  await requests[1];
  assertEquals(order, [0, 1]);
  // A socket's stream closing lets the oldest socket in.
  open.shift()!.release();
  (await sockets[0]).release();
  for (const one of open) one.release();
  await settle();
  gone.abort();
  const rest = await Promise.allSettled([...sockets, ...requests]);
  for (const one of rest) if (one.status === "fulfilled") one.value.release();
  assertEquals(budget.open, 0);
});

test("budget: long-lived streams hold at most their share of the process", async () => {
  // Room for 8 streams, of which 6 long-lived; every run has room of its own.
  const budget = new Budget({ streams: 8 });
  assertEquals(budget.longStreams, 6);
  const sockets: Charge[] = [];
  for (let i = 0; i < 6; i++) sockets.push(await charge(budget, `run-${i}`, { long: true }));
  // Another run's socket waits, though the process has room...
  const socket = charge(budget, "run-6", { long: true });
  assert(await pending(socket));
  // ...which is kept for every run's short requests.
  const page = [await charge(budget, "run-6"), await charge(budget, "run-7")];
  assertEquals(budget.open, budget.streams);
  assertEquals(budget.long, budget.longStreams);
  sockets[0].release();
  sockets[0] = await socket;
  for (const one of [...sockets, ...page]) one.release();
  assertEquals(budget.open, 0);
  assertEquals(budget.long, 0);
});

test("budget: relays never take the owned runs' streams, and the owned runs' short requests keep room", async () => {
  // A pod of two, at its real sizes: relays at their ceiling, every one of them long-lived as far
  // as that goes, and the owned runs' long-lived streams at theirs.
  const budget = new Budget({ relays: POD_STREAMS / 2 });
  const held: Charge[] = [];
  const relay = (shard: number, long = false) =>
    charge(budget, `relay:${shard}`, { cap: PER_RELAY, relay: true, long });
  for (let shard = 0; budget.relayed < budget.relays; shard++) {
    for (let i = 0; i < PER_RELAY.open && budget.relayed < budget.relays; i++) {
      held.push(await relay(shard, i < PER_RELAY.long && budget.long < budget.longRelays));
    }
  }
  assertEquals(budget.relayed, POD_STREAMS / 2);
  // One more shard's relay waits; the relays are full.
  const late = relay(999);
  assert(await pending(late));
  for (let run = 0; budget.long < budget.longRelays + budget.longStreams; run++) {
    for (let i = 0; i < PER_RUN.long && budget.long < budget.longRelays + budget.longStreams; i++) {
      held.push(await charge(budget, `bad-${run}`, { long: true }));
    }
  }
  // An owned run's short requests still go at once: the quarter of `streams` long-lived streams
  // cannot take, all of it.
  const page: Charge[] = [];
  for (let i = 0; i < POD_STREAMS - budget.longStreams; i++) {
    page.push(await charge(budget, `honest-${Math.floor(i / PER_RUN.open)}`));
  }
  assertEquals(page.length, POD_STREAMS / 4);
  for (const one of [...held, ...page]) one.release();
  (await late).release();
  assertEquals(budget.open, 0);
});

test("budget: an honest run keeps its whole cap beside eleven hostile runs at theirs", async () => {
  const budget = new Budget({ relays: POD_STREAMS / 2 });
  const held: Charge[] = [];
  // Eleven runs at every cap: 48 sockets and 16 short streams each.
  for (let run = 0; run < 11; run++) {
    for (let i = 0; i < PER_RUN.open; i++) {
      held.push(await charge(budget, `bad-${run}`, { long: i < PER_RUN.long }));
    }
  }
  // An honest run's HMR socket and every stream of its page go at once.
  const honest = [await charge(budget, "honest", { long: true })];
  for (let i = 1; i < PER_RUN.open; i++) honest.push(await charge(budget, "honest"));
  assertEquals(budget.open, POD_STREAMS);
  // A twelfth run fills the pod: the next run's first request waits.
  const next = charge(budget, "late");
  assert(await pending(next));
  honest.pop()!.release();
  (await next).release();
  for (const one of [...held, ...honest]) one.release();
  assertEquals(budget.open, 0);
});

test("budget: relays hold at most their part, and a shard its relay cap", async () => {
  // Room for 4 relays, 3 of them long-lived, and each shard relays at most 2 here.
  const budget = new Budget({ streams: 4, relays: 4 });
  assertEquals(budget.longRelays, 3);
  const cap: Cap = { name: "relay", open: 2, long: 2, waiting: 8, waitingLong: 8 };
  const relay = (shard: string) => charge(budget, `relay:${shard}`, { cap, relay: true });
  const relays = [await relay("a"), await relay("a")];
  // A shard at its cap waits; another still goes.
  const third = relay("a");
  assert(await pending(third));
  relays.push(await relay("b"), await relay("b"));
  assertEquals(budget.relayed, budget.relays);
  // Every shard's relays at the ceiling: another shard waits...
  const other = relay("c");
  assert(await pending(other));
  // ...and the runs this process owns still have every stream of theirs.
  const runs = await Promise.all(Array.from({ length: 4 }, () => charge(budget, "run")));
  assertEquals(budget.open, 8);
  relays[2].release();
  relays[2] = await other;
  for (const one of [...relays, ...runs]) one.release();
  (await third).release();
  assertEquals(budget.open, 0);
  assertEquals(budget.relayed, 0);
});

test("budget: a charge promoted to long-lived counts against the long caps, if they have room", async () => {
  const budget = new Budget({ streams: 4 });
  // Three of the four streams may be long-lived.
  const sockets = [
    await charge(budget, "a", { long: true }),
    await charge(budget, "b", { long: true }),
  ];
  const events = [await charge(budget, "c"), await charge(budget, "d")];
  assert(events[0].promote());
  assertEquals(budget.long, 3);
  // Promoted twice is still once.
  assert(events[0].promote());
  assertEquals(budget.long, 3);
  // The share is full: the other stays short.
  assert(!events[1].promote());
  assertEquals(budget.long, 3);
  assertEquals(budget.open, 4);
  for (const one of [...sockets, ...events]) one.release();
  assertEquals(budget.long, 0);
  assertEquals(budget.open, 0);
  // A tunnel stream is promoted through the stream it is.
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const stream = await mux.stream();
  assert(promote(stream));
  assertEquals(budget.long, 1);
  assert(!promote({}), "nothing holds no charge");
  mux.close();
  assertEquals(budget.long, 0);
});

test("budget: a stalled stream is closed only when closing it lets a request in", async () => {
  let now = 1_000_000;
  const budget = new Budget({ streams: 4, now: () => now });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const stalled = await mux.stream();
  const idle = await mux.stream();
  // A frame its reader never takes: a paused video, a breakpoint, a tab in the background.
  mux.receive(dataFrame(0, 1024));
  budget.sweep();
  // Nobody needs its room: an hour on, it is still there, and so is the idle one.
  now += 3_600_000;
  budget.sweep();
  assert(!stalled.destroyed && !idle.destroyed);

  // Another run's request waits only on its own cap, which this one's closing would not free.
  const other = await charge(budget, "other", { cap: small(1) });
  const blocked = charge(budget, "other", { cap: small(1) });
  assert(await pending(blocked));
  budget.sweep();
  assert(!stalled.destroyed);
  other.release();
  (await blocked).release();

  // The process is full and its own run has a request waiting: the stalled one goes, the idle
  // one stays.
  await mux.stream();
  await mux.stream();
  assertEquals(budget.open, budget.streams);
  const queued = mux.stream();
  budget.sweep();
  assert(stalled.destroyed, "the stalled stream was closed");
  assert(!idle.destroyed);
  (await queued).destroy();
  mux.close();
  assertEquals(budget.open, 0);
});

test("budget: one sweep closes as many stalled streams as there are requests they let in", async () => {
  let now = 1_000_000;
  const budget = new Budget({ streams: 4, now: () => now });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  // Four streams, every one stalled on a frame nobody reads.
  const streams = [];
  for (let id = 0; id < 4; id++) {
    streams.push(await mux.stream());
    mux.receive(dataFrame(id, 1024));
  }
  budget.sweep();
  now += STALL_MS;
  // Two requests wait: two of the four go, in one sweep, and the other two stay.
  const waiting = [mux.stream(), mux.stream()];
  budget.sweep();
  assertEquals(streams.filter((stream) => stream.destroyed).length, 2);
  for (const one of await Promise.all(waiting)) assert(!one.destroyed);
  assertEquals(budget.waiting, 0);
  mux.close();
  await settle();
  assertEquals(budget.open, 0);
});

test("budget: a sweep closes a stalled stream only for a request its release lets in, by group and kind", async () => {
  let now = 1_000_000;
  const budget = new Budget({ streams: 8, now: () => now });
  assertEquals(budget.longStreams, 6);
  const a = hostMux(fakeWire(), { budget, group: "a" });
  const b = hostMux(fakeWire(), { budget, group: "b" });
  // Run a: a download and three sockets, every one stalled on a frame nobody reads. Run b: as
  // many, all idle. The process is full, its long-lived share too.
  const mine: Duplex[] = [];
  for (let id = 0; id < 4; id++) {
    mine.push(await a.stream(undefined, { long: id > 0 }));
    a.receive(dataFrame(id, 1024));
  }
  const theirs: Duplex[] = [];
  for (let id = 0; id < 4; id++) theirs.push(await b.stream(undefined, { long: id > 0 }));
  assertEquals([budget.open, budget.long], [8, 6]);
  budget.sweep();
  now += STALL_MS;
  const closed = () => mine.map((one) => one.destroyed);
  // Another run's socket waits on the process and its long-lived share: only a socket's release
  // lets it in, never the download's, which is judged first.
  const socket = charge(budget, "c", { long: true });
  budget.sweep();
  assertEquals(closed(), [false, true, false, false]);
  (await socket).release();
  // The process full again, the run's own short request waits: the download's release lets it
  // in.
  const filler = await charge(budget, "d");
  const short = a.stream();
  await settle();
  assertEquals(budget.waiting, 1);
  budget.sweep();
  assertEquals(closed(), [true, true, false, false]);
  assert(theirs.every((one) => !one.destroyed), "an idle stream was closed");
  assertEquals(budget.waiting, 0);
  (await short).destroy();
  filler.release();
  // With nothing waiting, nothing more goes, an hour on.
  now += 3_600_000;
  budget.sweep();
  assertEquals(closed(), [true, true, false, false]);
  a.close();
  b.close();
  await settle();
  assertEquals(budget.open, 0);
});

test("budget: a stalled stream stays when closing it would not let the waiting request in", async () => {
  let now = 1_000_000;
  const budget = new Budget({ now: () => now });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  // A page's stalled download, and every socket the run's long-lived cap allows.
  const stalled = await mux.stream();
  mux.receive(dataFrame(0, 1024));
  const sockets = [];
  for (let i = 0; i < PER_RUN.long; i++) sockets.push(await mux.stream(undefined, { long: true }));
  // One more socket waits on the run's long-lived cap, which the download's closing would not
  // free: it stays.
  const socket = mux.stream(undefined, { long: true });
  socket.catch(() => {});
  budget.sweep();
  now += STALL_MS;
  budget.sweep();
  assert(!stalled.destroyed, "closing it would let nothing in");
  // A short request at the run's cap is another matter.
  for (let i = 1 + sockets.length; i < PER_RUN.open; i++) await mux.stream();
  const request = mux.stream();
  budget.sweep();
  assert(stalled.destroyed, "closing it let the short request in");
  assert(!(await request).destroyed);
  mux.close();
  await settle();
  assertEquals(budget.open, 0);
});

test("budget: under pressure a stream stalls after STALL_MS, and a slow reader never does", async () => {
  let now = 1_000_000;
  const budget = new Budget({ streams: 3, now: () => now });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const stalled = await mux.stream();
  const slow = await mux.stream();
  const idle = await mux.stream();
  // The process is full, and another run waits for room: whatever stalls goes. The stalled one
  // holds a frame it never takes; the slow one holds frames all along but takes a kilobyte every
  // few seconds; the idle one, an HMR socket between edits, holds nothing.
  assertEquals(budget.open, budget.streams);
  const waiting = charge(budget, "other");
  mux.receive(dataFrame(0, 1024));
  mux.receive(dataFrame(1, 16 * 1024));
  mux.receive(dataFrame(1, MAX_FRAME));
  budget.sweep();
  for (let t = 0; t < 12; t++) {
    now += 5_000;
    slow.read(1024);
    budget.sweep();
    assert(slow.readableLength > 0, "the slow reader is always behind");
    if (now - 1_000_000 < STALL_MS) assert(!stalled.destroyed, `closed after ${t} sweeps`);
  }
  assert(stalled.destroyed, "the stalled stream was closed");
  assert(!slow.destroyed, "a slow reader is not a stalled one");
  assert(!idle.destroyed, "a quiet stream holds nothing anyone needs");
  (await waiting).release();
  // An hour later, still nothing buffered: the idle one stays.
  now += 3_600_000;
  budget.sweep();
  assert(!idle.destroyed);
  mux.close();
  assertEquals(budget.open, 0);
});

test("budget: an honest run's page loads beside hostile runs at their caps", async () => {
  // Room for 4 runs' streams at their caps, and 3 hostile runs of two previews each, every one
  // asking for 80 streams of endless answers nobody reads.
  const budget = new Budget({ streams: 4 * PER_RUN.open });
  const runs = Array.from({ length: 6 }, (_, i) => hostile(budget, `bad-${i % 3}`));
  for (let round = 0; round < 3; round++) {
    await settle();
    for (const run of runs) run.flood();
  }
  for (const i of [0, 1, 2]) assertEquals(budget.openBy(`bad-${i}`), PER_RUN.open);

  // A Vite page: 150 module requests at once (HTTP/2), each answered at once by its dev server
  // and read by its browser, and the HMR socket, which stays open and quiet.
  const honest: HostMux = hostMux(fakeWire(), { budget, group: "honest" });
  const hmr = await honest.stream(undefined, { long: true });
  let served = 0;
  const failed: string[] = [];
  await Promise.all(Array.from({ length: 150 }, () =>
    honest.stream().then(async (stream) => {
      served++;
      stream.resume();
      await settle();
      stream.destroy();
    }, (error: Error) => {
      failed.push(error.message);
    })));
  assertEquals(failed, []);
  assertEquals(served, 150);
  assert(!hmr.destroyed, "the HMR socket outlived the page load");
  // The hostile runs got nothing more meanwhile, and lost nothing.
  for (const i of [0, 1, 2]) assertEquals(budget.openBy(`bad-${i}`), PER_RUN.open);
  hmr.destroy();
  honest.close();
  for (const run of runs) run.mux.close();
});

test("budget: once hostile runs fill the process, an honest request waits, then is turned away", async () => {
  const budget = new Budget({ streams: 2 * PER_RUN.open, waitMs: 50 });
  const runs = Array.from({ length: 4 }, (_, i) => hostile(budget, `bad-${i % 2}`));
  await settle();
  assertEquals(budget.open, budget.streams);
  const honest = hostMux(fakeWire(), { budget, group: "honest" });
  await assertRejects(() => honest.stream(), Error, "preview is busy");
  // A request that already waited elsewhere waits only what is left of its time.
  const started = Date.now();
  await assertRejects(() => honest.stream(undefined, { waitMs: 0 }), Error, "preview is busy");
  assert(Date.now() - started < 50, "it waited no longer than it was given");
  honest.close();
  for (const run of runs) run.mux.close();
});

test("budget: a charge whose use throws is given back, at once or after waiting", async () => {
  const budget = new Budget({ streams: 1 });
  const boom = () => {
    throw new Error("boom");
  };
  await assertRejects(() => budget.acquire("run", { use: boom }), Error, "boom");
  assertEquals(budget.open, 0);
  const held = await charge(budget, "run");
  const waited = budget.acquire("run", { use: boom });
  held.release();
  await assertRejects(() => waited, Error, "boom");
  assertEquals(budget.open, 0);
});

test("budget: a run's long-lived streams leave its last streams to short requests", async () => {
  const budget = new Budget();
  // Two previews of one run, each with room on its tunnel: the run's own cap is what holds.
  const a = hostMux(fakeWire(), { budget, group: "run" });
  const b = hostMux(fakeWire(), { budget, group: "run" });
  for (let i = 0; i < PER_RUN.long; i++) await (i % 2 ? a : b).stream(undefined, { long: true });
  const socket = a.stream(undefined, { long: true });
  assert(await pending(socket));
  // Short requests still get the rest of the run's cap.
  for (let i = PER_RUN.long; i < PER_RUN.open; i++) await (i % 2 ? a : b).stream();
  assert(await pending(a.stream()));
  assertEquals(budget.openBy("run"), PER_RUN.open);
  a.close();
  b.close();
  await settle();
  assertEquals(budget.open, 0);
});

test("budget: every refusal is reported, with the group and the limit it was", async () => {
  let now = 1_000_000;
  const heard: string[] = [];
  const budget = new Budget({
    streams: 2,
    waiting: 2,
    waitMs: 20,
    now: () => now,
    refused: (group, why, cap) => heard.push(`${group}: ${why} (${cap})`),
  });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const stalled = await mux.stream();
  mux.receive(dataFrame(0, 1024));
  await mux.stream();
  const waiting = mux.stream();
  const behind = mux.stream();
  behind.catch(() => {});
  // Within its floor the run may fill the line while nobody else waits; then it is full.
  await assertRejects(() => mux.stream(), Error, "preview is busy");
  budget.sweep();
  now += STALL_MS;
  budget.sweep();
  assert(stalled.destroyed);
  await waiting;
  await assertRejects(() => behind, Error, "preview is busy");
  await assertRejects(() => budget.acquire("other", { use: () => 1 }), Error, "preview is busy");
  assertEquals(heard, [
    "run: line full (pod-line)",
    "run: stalled (pod)",
    "run: wait expired (pod)",
    "other: wait expired (pod)",
  ]);
  mux.close();
});

test("budget: under memory pressure nothing new gets in, the line is emptied and every stream holding bytes goes", async () => {
  let pressure: Pressure = "normal";
  const heard: string[] = [];
  const budget = new Budget({
    streams: 3,
    pressure: () => pressure,
    refused: (group, why, cap) => heard.push(`${group}: ${why} (${cap})`),
  });
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const small = await mux.stream();
  const large = await mux.stream();
  const idle = await mux.stream();
  mux.receive(dataFrame(0, 1024));
  mux.receive(dataFrame(1, 16 * 1024));
  const waiting = mux.stream();
  waiting.catch(() => {});
  pressure = "high";
  // A new request is refused at once, not put in line.
  await assertRejects(() => mux.stream(), Error, "preview is busy");
  // What each holds, and how many streams hold any, as the guard reads it.
  assertEquals(budget.usage().get("run"), {
    open: 3,
    waiting: 1,
    buffered: 17 * 1024,
    holding: 2,
    overhead: 2 * STREAM_BYTES,
  });
  // At CRITICAL everyone's line is emptied, and nothing is closed: streams are the shed's.
  budget.empty("critical", () => true);
  await assertRejects(() => waiting, Error, "preview is busy");
  assert(!large.destroyed && !small.destroyed);
  assertEquals(budget.waiting, 0);
  // The guard relieves the groups it names: every stream holding bytes goes at once, its reader
  // taking them or not; a stream that holds nothing never does.
  large.read(1024);
  assertEquals(budget.relieve("high", () => true), {
    closed: 2,
    freed: 16 * 1024 + 2 * STREAM_BYTES,
  });
  assert(large.destroyed && small.destroyed);
  assert(!idle.destroyed);
  // Back to normal, room is handed out again.
  pressure = "normal";
  assert(!(await mux.stream()).destroyed);
  assertEquals(heard, [
    "run: memory (memory-high)",
    "run: memory (memory-critical)",
    "run: memory (memory-high)",
    "run: memory (memory-high)",
  ]);
  mux.close();
  assertEquals(budget.open, 0);
});

test("budget: shedding closes the streams holding the most first, relays and uploads included", async () => {
  const budget = new Budget({ relays: 4 });
  const closed: number[] = [];
  const held = async (bytes: number, relay = false) => {
    const one = await charge(
      budget,
      relay ? "relay:a" : "run",
      relay ? { relay: true, cap: PER_RELAY } : {},
    );
    one.buffered = () => bytes;
    one.close = () => {
      closed.push(bytes);
      one.release();
    };
    return one;
  };
  await held(1_000);
  await held(0);
  await held(500_000, true);
  await held(200_000);
  await held(50_000);
  // 800 kB to free: the relay's 500 kB, then the 200 kB stream, each counted with what a stream
  // costs beyond its bytes (STREAM_BYTES).
  assertEquals(budget.shed(800_000), { closed: 2, freed: 700_000 + 2 * STREAM_BYTES });
  assertEquals(closed, [500_000, 200_000]);
  // However far over, at most a quarter of what is open goes in one call (and at least one);
  // nothing that holds nothing ever does, unless its group is named.
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER).closed, 1);
  assertEquals(closed, [500_000, 200_000, 50_000]);
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER).closed, 1);
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER).closed, 0);
  assertEquals(budget.open, 1);
});

test("budget: a stream whose client is measured costs SERVED_BYTES beyond its bytes, not STREAM_BYTES as well", async () => {
  const budget = new Budget();
  const closed: string[] = [];
  const held = async (name: string, bytes: number, client?: number) => {
    const one = await charge(budget, "run");
    one.buffered = () => bytes;
    one.close = () => {
      closed.push(name);
      one.release();
    };
    const stream = {};
    holdsCharge(stream, one);
    // The client's own count (its socket's buffers and the kernel's while they fill) stands in
    // for STREAM_BYTES' estimate of them.
    if (client !== undefined) serves(stream, { held: () => client, cut: () => {} });
    return one;
  };
  await held("served", 10_000, 200_000);
  await held("unmeasured", 10_000);
  await held("idle", 0, 0);
  assertEquals(budget.usage().get("run"), {
    open: 3,
    waiting: 0,
    buffered: 220_000,
    holding: 2,
    overhead: SERVED_BYTES + STREAM_BYTES,
  });
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER, () => true), {
    closed: 1,
    freed: 210_000 + SERVED_BYTES,
  });
  assertEquals(closed, ["served"]);
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER, () => true), {
    closed: 1,
    freed: 10_000 + STREAM_BYTES,
  });
});

test("budget: shedding takes the named groups first, then streams making no progress, and spares a fast download", async () => {
  const budget = new Budget();
  const closed: string[] = [];
  const held = async (group: string, name: string, bytes: number) => {
    const one = await charge(budget, group);
    let taken = 0;
    one.buffered = () => bytes;
    one.taken = () => taken;
    one.close = () => {
      closed.push(name);
      one.release();
    };
    return { one, progress: () => taken += 1 };
  };
  const fast = await held("honest", "fast", 900_000);
  await held("honest", "stuck", 100_000);
  await held("bad", "culprit", 10_000);
  await held("bad", "culprit-idle", 0);
  for (let i = 0; i < 4; i++) await held("other", `idle-${i}`, 0);
  // The first look sees where each reader stands.
  budget.shed(0);
  fast.progress();
  // A quarter of 8 at most: the named group's two (its idle one too), then nothing else.
  assertEquals(budget.shed(Number.MAX_SAFE_INTEGER, (group) => group === "bad").closed, 2);
  assertEquals(closed, ["culprit", "culprit-idle"]);
  fast.progress();
  // Then the stream whose reader took nothing, before the larger one still downloading.
  assertEquals(budget.shed(1).closed, 1);
  assertEquals(closed, ["culprit", "culprit-idle", "stuck"]);
  assertEquals(budget.shed(1).closed, 1);
  assertEquals(closed.at(-1), "fast");
});

test("budget: under memory pressure only the groups named are refused, their line emptied, their streams closed", async () => {
  const named = new Set<string>();
  const budget = new Budget({
    streams: 4,
    pressure: (group) => (named.has(group as string) ? "high" : "normal"),
  });
  const bad = hostMux(fakeWire(), { budget, group: "bad" });
  const good = hostMux(fakeWire(), { budget, group: "good" });
  const badHolding = await bad.stream();
  const goodHolding = await good.stream();
  bad.receive(dataFrame(0, 1024));
  good.receive(dataFrame(0, 64 * 1024));
  await good.stream();
  await bad.stream();
  const badWaiting = bad.stream();
  badWaiting.catch(() => {});
  const goodWaiting = good.stream();
  named.add("bad");
  await assertRejects(() => bad.stream(), Error, "preview is busy");
  budget.relieve("high", (group) => named.has(group as string));
  await assertRejects(() => badWaiting, Error, "preview is busy");
  assert(badHolding.destroyed);
  // The other group keeps its stream, though it holds far more, and its place in line, and gets
  // the room the culprit's stream left.
  assert(!goodHolding.destroyed);
  assert(!(await goodWaiting).destroyed);
  assertEquals(budget.usage().get("good")?.open, 3);
  assertEquals(budget.usage().get("good")?.buffered, 64 * 1024);
  bad.close();
  good.close();
});
