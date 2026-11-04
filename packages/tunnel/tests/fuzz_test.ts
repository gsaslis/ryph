// The host end of a tunnel against a hostile runner end: whatever it is sent, in whatever order,
// it never throws, never grows work or memory with repetition, and either stays consistent or
// says the wire is broken.
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { Duplex } from "node:stream";
import {
  Budget,
  hostMux,
  MAX_BACKLOG,
  MAX_BUFFERED,
  MAX_FRAME,
  MAX_QUEUED_SENDS,
  MAX_STREAMS,
  RUN_ACK_BURST,
  RUN_ACK_RATE,
} from "../src/mod.ts";

/** A wire that takes what it is sent and keeps none of it. */
function fakeWire() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    closed: false,
    sends: 0,
    send(_data: unknown) {
      this.sends++;
    },
    close() {
      this.closed = true;
      this.readyState = 3;
    },
  };
}

function dataFrame(id: number, length: number): ArrayBuffer {
  const out = new Uint8Array(4 + length).fill(66);
  new DataView(out.buffer).setUint32(0, id);
  return out.buffer;
}

/** mulberry32: the same sequence for the same seed, so a failure can be replayed. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("tunnel: a runner's end after its end and close is refused, and never adds a listener", async () => {
  const host = hostMux(fakeWire());
  const stream = await host.stream();
  stream.on("error", () => {});
  stream.pause();
  assertEquals(host.receive(dataFrame(0, 10)), "ok");
  assertEquals(host.receive('{"end":0}'), "ok");
  const listeners = stream.listenerCount("end");
  // Draining: the reader has not taken what was sent, so the stream waits for it to.
  assertEquals(host.receive('{"close":0}'), "ok");
  assertEquals(stream.listenerCount("end"), listeners + 1);
  // A second close was a listener each, without bound: 100k of them some 21 MiB.
  assertEquals(host.receive('{"close":0}'), "invalid");
  for (let i = 0; i < 100_000; i++) host.receive('{"close":0}');
  assertEquals(stream.listenerCount("end"), listeners + 1);
  host.close();
});

test("tunnel: what a runner says of a stream must apply in the state the stream is in", async () => {
  /** A fresh tunnel with one stream whose reader takes nothing, and what `say` gets. */
  const after = async (...say: (string | ArrayBuffer)[]) => {
    const host = hostMux(fakeWire());
    const stream = await host.stream();
    stream.on("error", () => {});
    stream.pause();
    const answers = say.map((one) => host.receive(one));
    host.close();
    return answers;
  };
  // Honest: a frame, end, close; or close alone.
  assertEquals(await after(dataFrame(0, 1), '{"end":0}', '{"close":0}'), ["ok", "ok", "ok"]);
  assertEquals(await after('{"close":0}'), ["ok"]);
  // An end after an end, data after an end, an end after a close.
  assertEquals(await after('{"end":0}', '{"end":0}'), ["ok", "invalid"]);
  assertEquals(await after('{"end":0}', dataFrame(0, 1)), ["ok", "invalid"]);
  assertEquals(await after('{"end":0}', '{"close":0}', '{"end":0}'), ["ok", "ok", "invalid"]);
  // A second frame before this end acked the first: the reader took nothing, so no ack went.
  const big = dataFrame(0, MAX_FRAME);
  assertEquals(await after(big, big), ["ok", "invalid"]);
  // An ack with nothing in flight.
  assertEquals(await after('{"ack":0}'), ["invalid"]);
});

test("tunnel: past the acks' pace a runner is slowed, never broken; one that does not wait for its ack is", async () => {
  let clock = 0;
  // A tick of the clock that refills a token, whatever the float rounding of 1000 / rate.
  const step = 1000 / RUN_ACK_RATE * 1.001;
  const wire = Object.assign(fakeWire(), { acks: 0 });
  wire.send = (data: unknown) => {
    wire.sends++;
    if (data === '{"ack":0}') wire.acks++;
  };
  const honest = hostMux(wire, { budget: new Budget({ now: () => clock }) });
  (await honest.stream()).resume();
  // Tiny frames, each taken at once, the next sent only once the last is acked: the burst goes
  // at once, and then each ack waits for the clock.
  for (let i = 0; i < RUN_ACK_BURST; i++) assertEquals(honest.receive(dataFrame(0, 1)), "ok");
  assertEquals(wire.acks, RUN_ACK_BURST);
  assertEquals(honest.receive(dataFrame(0, 1)), "ok");
  assertEquals(wire.acks, RUN_ACK_BURST);
  // The clock has not moved: the ack waits on, and a frame sent without it is one too many.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(wire.acks, RUN_ACK_BURST);
  clock += step;
  for (let i = 0; i < 100 && wire.acks === RUN_ACK_BURST; i++) await tick();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(wire.acks, RUN_ACK_BURST + 1);
  // For as long as it keeps to the rate, every frame is acked.
  for (let i = 0; i < 4 * RUN_ACK_BURST; i++) {
    clock += step;
    assertEquals(honest.receive(dataFrame(0, 1)), "ok");
    // The reader takes what is pushed on the next tick: past its mark (16 KiB of 1-byte frames)
    // the ack would wait for it.
    if (i % 1024 === 1023) await tick();
  }
  assertEquals(wire.acks, 5 * RUN_ACK_BURST + 1);
  honest.close();
  // Frames sent as fast as they are acked, without waiting for the ack: within the burst they
  // pass (each was acked before the next came), past it the next has no ack to answer.
  const pipelined = hostMux(fakeWire(), { budget: new Budget({ now: () => clock }) });
  (await pipelined.stream()).resume();
  const answers = Array.from(
    { length: RUN_ACK_BURST + 2 },
    () => pipelined.receive(dataFrame(0, 1)),
  );
  assertEquals(answers.filter((one) => one === "ok").length, RUN_ACK_BURST + 1);
  assertEquals(answers.at(-1), "invalid");
  pipelined.close();
});

/** What an honest runner may say of each stream, kept from what the host sent it. */
interface Model {
  /** It may send a frame: it has not, or the host acked the last. */
  mayData: boolean;
  /** Frames the host sent that it has not acked. */
  owed: number;
  ended: boolean;
  closed: boolean;
}

/** A wire that takes what it is sent, keeps none of it, and tells `model` what it was. Its queue
 * (`bufferedAmount`) is what `queue` says of what was sent so far: nothing, a fixed amount, or all
 * of it (a runner that reads nothing). Once closed or terminated it takes nothing more, as a
 * socket would, and says what its queue held when it was terminated. */
function modelWire(model: Map<number, Model>) {
  let sent = 0;
  const wire = {
    readyState: 1,
    sends: 0,
    queue: (_sent: number) => 0,
    terminatedAt: null as number | null,
    get bufferedAmount() {
      return wire.queue(sent);
    },
    close() {
      wire.readyState = 3;
    },
    terminate() {
      wire.terminatedAt = wire.bufferedAmount;
      wire.close();
    },
    send(data: unknown) {
      if (wire.readyState !== 1) return;
      wire.sends++;
      if (data instanceof Uint8Array) {
        sent += data.byteLength;
        const one = model.get(new DataView(data.buffer, data.byteOffset).getUint32(0));
        if (one) one.owed++;
        return;
      }
      sent += String(data).length;
      const [[signal, id]] = Object.entries(JSON.parse(String(data)) as Record<string, number>);
      if (signal === "open") model.set(id, { mayData: true, owed: 0, ended: false, closed: false });
      else if (signal === "ack") model.get(id)!.mayData = true;
      else if (signal === "close") model.delete(id);
    },
  };
  return wire;
}

interface Hostile {
  seed: number;
  /** Change the wire under it: its queue, and its state (closed mid-frame). */
  wireChanges: boolean;
  /** A budget with few streams, so requests wait in line, each for a while of its own. */
  lines: boolean;
}

/** Rounds of a hostile runner end against a host end, until 40k messages are in: whatever it is
 * sent, in whatever order, the host never throws, never grows work with repetition, and either
 * stays consistent or says the wire is broken. */
async function hostile(opts: Hostile) {
  const random = prng(opts.seed);
  const pick = <T>(of: readonly T[]) => of[Math.floor(random() * of.length)];
  let clock = 0;
  const pace = { now: () => clock };
  const budget = opts.lines ? new Budget({ streams: 6, waiting: 24, pace }) : new Budget({ pace });
  const garbage = [
    "nonsense",
    "{",
    "{}",
    "null",
    '{"ack":"0"}',
    '{"ack":-1}',
    '{"ack":1.5}',
    '{"ack":0,"end":0}',
    '{"__proto__":0}',
    '{"constructor":0}',
    "x".repeat(65),
    "ping ",
    new ArrayBuffer(0),
    new ArrayBuffer(4),
    new ArrayBuffer(4 + MAX_FRAME + 1),
    7,
    null,
    new Uint8Array(8),
  ];
  const queues: ((sent: number) => number)[] = [
    () => 0,
    () => 64 * 1024,
    () => MAX_BACKLOG + 1,
    () => MAX_BUFFERED + 1,
    // Nothing ever leaves: every send stays queued.
    (sent) => sent,
  ];
  const times: number[] = [];
  // Why each terminated wire was: its queue past MAX_BUFFERED, past MAX_BACKLOG beyond what its
  // streams were owed, or neither, so its count of sends (MAX_QUEUED_SENDS).
  const terminated = new Set<string>();
  let rounds = 0;
  let broken = 0;
  let oks = 0;
  let draining = 0;
  let waited = 0;
  let closedMidFrame = 0;
  while (times.length < 40_000) {
    rounds++;
    const model = new Map<number, Model>();
    const wire = modelWire(model);
    const host = hostMux(wire, { budget, group: "fuzz", now: () => clock });
    if (opts.wireChanges) wire.queue = pick([...queues, () => 0, () => 0]);
    // Once its socket is gone, a host is torn down: a few late messages, and the round ends.
    let afterClose = Infinity;
    const streams: Duplex[] = [];
    const asked = new Set<Promise<unknown>>();
    // How often the runner strays from what an honest one says: some rounds hardly ever, so
    // streams reach every state first; and once it strays, how often it says it again.
    // With the wire changing, some rounds never stray, so a socket's queue has time to fill.
    const strays = pick(opts.wireChanges ? [0, 0.002, 0.01, 0.05, 0.3] : [0.002, 0.01, 0.05, 0.3]);
    let last: unknown = null;
    for (let step = 0; step < 4_000; step++) {
      clock += random() < 0.5 ? 0 : 1;
      if (wire.readyState !== 1 && --afterClose < 0) break;
      const roll = random();
      if (opts.wireChanges && roll < 0.004) {
        // Its queue changes under it: drained, stuck, past what an honest runner leaves.
        wire.queue = pick(queues);
        continue;
      }
      if (opts.wireChanges && roll < 0.0045 && wire.readyState === 1) {
        // The socket goes, whatever is in flight on it.
        if ([...model.values()].some((one) => one.owed > 0)) closedMidFrame++;
        wire.close();
        afterClose = 50;
        continue;
      }
      if (opts.wireChanges && roll < 0.006) {
        // A dev server's stream of tiny writes, each frame sent as soon as the last is acked:
        // acks by the thousand, which a socket that does not drain queues.
        const [id, one] = [...model].find(([, one]) => one.mayData && !one.ended) ?? [];
        for (let i = 0; i < 2 * MAX_QUEUED_SENDS && one?.mayData && wire.readyState === 1; i++) {
          // Within the acks' pace, so each is acked at once.
          clock += 1000 / RUN_ACK_RATE * 1.001;
          one.mayData = false;
          if (host.receive(dataFrame(id!, 1)) !== "ok") break;
        }
        continue;
      }
      if (roll < 0.05 && host.size < MAX_STREAMS) {
        const controller = new AbortController();
        const waitMs = opts.lines ? pick([0, 1, 5, 20]) : 0;
        const one = host.stream(controller.signal, { waitMs, long: random() < 0.2 })
          .then((stream) => {
            stream.on("error", () => {});
            if (random() < 0.5) stream.resume();
            streams.push(stream);
          }, () => {})
          .finally(() => asked.delete(one));
        asked.add(one);
        if (opts.lines) {
          // A stream granted at once is in hand before the next step; one in line waits on.
          await Promise.race([one, tick()]);
          waited += budget.waiting > 0 ? 1 : 0;
          // Now and then the browser gives up while it waits.
          if (random() < 0.1) setTimeout(() => controller.abort(), Math.floor(random() * 5));
          if (random() < 0.05) await new Promise((resolve) => setTimeout(resolve, 1));
        } else await one;
        continue;
      }
      const live = streams.filter((one) => !one.destroyed);
      if (roll < 0.1 && live.length > 0) {
        // This end's own doing: what node:http and a browser would do to a stream.
        const stream = pick(live);
        const act = random();
        if (act < 0.3) stream.write(new Uint8Array(1 + Math.floor(random() * 2 * MAX_FRAME)));
        else if (act < 0.4) stream.end();
        else if (act < 0.5) stream.destroy();
        else if (act < 0.8) stream.resume();
        else stream.pause();
        if (random() < 0.3) await tick();
        continue;
      }
      let message: unknown;
      if (last !== null && random() < strays) {
        // The same again: what made work grow with repetition.
        message = last;
      } else if (random() < strays) {
        // Anything at all, for any id, handed out or not.
        const id = random() < 0.9
          ? Math.floor(random() * (streams.length + 1))
          : pick([streams.length + 1, 2 ** 31, 0xffffffff]);
        const kind = random();
        if (kind < 0.3) message = dataFrame(id, 1 + Math.floor(random() * MAX_FRAME));
        else if (kind < 0.8) {
          message = JSON.stringify({ [pick(["ack", "end", "close", "open"])]: id });
        } else if (kind < 0.85) message = "ping";
        else message = pick(garbage);
      } else {
        // What an honest runner may say now, of a stream the host has open.
        const moves: unknown[] = [];
        for (const [id, one] of model) {
          if (one.closed) continue;
          if (one.mayData && !one.ended) {
            moves.push(() => (one.mayData = false, dataFrame(id, 1 + Math.floor(random() * 512))));
          }
          if (one.owed > 0) moves.push(() => (one.owed--, JSON.stringify({ ack: id })));
          if (!one.ended && random() < 0.2) {
            moves.push(() => (one.ended = true, JSON.stringify({ end: id })));
          }
          if (random() < 0.05) moves.push(() => (one.closed = true, JSON.stringify({ close: id })));
        }
        if (moves.length === 0) continue;
        message = (pick(moves) as () => unknown)();
      }
      last = message;
      const started = performance.now();
      const answer = host.receive(message);
      times.push(performance.now() - started);
      if (answer === "ok") oks++;
      draining += streams.filter((one) => one.listenerCount("end") > 0).length;
      // Never more than its own listener and the stream's: whatever was repeated.
      for (const stream of streams) assert(stream.listenerCount("end") <= 2, "end listeners grew");
      assert(host.size <= MAX_STREAMS);
      assertEquals(host.size, streams.filter((one) => !one.destroyed).length);
      assertEquals(budget.open, host.size);
      assert(budget.open <= budget.streams);
      if (answer === "invalid") {
        // Broken: refused from now on, and torn down as its host would.
        assertEquals(host.receive('{"ack":0}'), "invalid");
        broken++;
        break;
      }
    }
    if (wire.terminatedAt !== null) {
      terminated.add(
        wire.terminatedAt > MAX_BUFFERED
          ? "buffered"
          : wire.terminatedAt > MAX_BACKLOG
          ? "backlog"
          : "sends",
      );
    }
    host.close();
    await Promise.all(asked);
    await tick();
    assertEquals(host.size, 0);
    assertEquals(budget.open, 0, "a closed tunnel's streams are still charged");
    assertEquals(budget.waiting, 0, "a closed tunnel's requests are still in line");
  }
  // It reached what matters: streams draining after the runner's close, and broken wires.
  assert(rounds > 10 && broken > 0, `${rounds} rounds, ${broken} broken`);
  assert(oks > times.length / 2 && draining > 0, `${oks} ok, ${draining} draining`);
  if (opts.lines) assert(waited > 0, "nothing ever waited in line");
  if (opts.wireChanges) {
    assert(closedMidFrame > 0, "no wire closed with a frame in flight");
    assertEquals([...terminated].sort(), ["backlog", "buffered", "sends"]);
  }
  // Per message, the last stretch costs what the first did: nothing grows with repetition.
  const fifth = Math.floor(times.length / 5);
  const mean = (from: number) => times.slice(from, from + fifth).reduce((a, b) => a + b, 0) / fifth;
  const first = mean(0);
  const lastFifth = mean(times.length - fifth);
  assert(
    lastFifth < 4 * first + 0.01,
    `${first.toFixed(4)} ms a message at first, ${lastFifth.toFixed(4)} last`,
  );
}

test("tunnel: random messages from a hostile runner never throw, grow work, or leak", async () => {
  await hostile({ seed: 0x7e57, wireChanges: false, lines: false });
});

test("tunnel: a hostile runner over a socket whose queue and state change, with requests waiting in line, never throws, leaks or miscounts", async () => {
  await hostile({ seed: 0xb10c, wireChanges: true, lines: true });
});
