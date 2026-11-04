// The memory guard and the connection ceilings, driven by hand: cgroup files from fixtures, a
// reading the test sets, and a clock it moves.
import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { Connections, MIN_IDLE_MS, UNTRUSTED_GRACE_MS } from "../src/connections.ts";
import { fraction, retiredEnv } from "../src/main.ts";
import {
  badWatermarks,
  BASELINE_MS,
  GC_EVERY_MS,
  HIGH,
  HYSTERESIS,
  MemoryGuard,
  type MemorySource,
  memorySource,
  uncappedSocketBuffers,
} from "../src/memory.ts";

const fixtures = new URL("./fixtures/cgroup/", import.meta.url).pathname;
const MiB = 2 ** 20;

test("memory: cgroup v2 is read against memory.max, less the inactive file cache", () => {
  const source = memorySource({ root: `${fixtures}v2` })!;
  assertEquals(source.kind, "cgroup2");
  assertEquals(source.limit, 768 * MiB);
  // memory.current less inactive_file, as the kubelet's working set is.
  assertEquals(source.used(), 524288000 - 104857600);
});

test("memory: cgroup v1 is read against memory.limit_in_bytes, less the inactive file cache", () => {
  const source = memorySource({ root: `${fixtures}v1` })!;
  assertEquals(source.kind, "cgroup1");
  assertEquals(source.limit, 768 * MiB);
  // The hierarchy's own total, not this cgroup's alone.
  assertEquals(source.used(), 524288000 - 104857600);
});

test("memory: without a cgroup limit, the RSS against the one it is given, or nothing", () => {
  for (const root of [`${fixtures}v2-unlimited`, `${fixtures}v1-unlimited`, `${fixtures}none`]) {
    assertEquals(memorySource({ root }), null, root);
    const source = memorySource({ root, limitBytes: 512 * MiB, rss: () => 42 })!;
    assertEquals(source.kind, "rss");
    assertEquals(source.limit, 512 * MiB);
    assertEquals(source.used(), 42);
  }
  // The real process's, here on a machine with no cgroup of its own at that path.
  const own = memorySource({ root: `${fixtures}none`, limitBytes: 1024 * MiB })!;
  assert(own.used() > 0);
});

test("memory: a counter that cannot be read leaves the level as it was, until a few in a row", () => {
  const files: Record<string, string> = { "/cg/memory.max": "1000\n", "/cg/memory.current": "800" };
  const source = memorySource({ root: "/cg", read: (path) => files[path] ?? null })!;
  const unreadable: number[] = [];
  const changes: string[] = [];
  const guard = new MemoryGuard({
    source,
    gc: null,
    unreadable: (_error, inARow) => unreadable.push(inARow),
    changed: (level, previous) => changes.push(`${previous}→${level}`),
  });
  assertEquals(guard.check(), "high");
  delete files["/cg/memory.current"];
  assertEquals(guard.check(), "high");
  files["/cg/memory.current"] = "garbage";
  assertEquals(guard.check(), "high");
  // Refusing on a reading it no longer has would refuse forever: it fails open, and says so.
  assertEquals(guard.check(), "normal");
  assertEquals(unreadable, [1, 2, 3]);
  assertEquals(changes, ["normal→high", "high→normal"]);
  // And reads again as soon as it can.
  files["/cg/memory.current"] = "950";
  assertEquals(guard.check(), "critical");
});

/** A source whose reading the test sets. */
function fake(limit = 1000) {
  const at = { used: 0 };
  const source: MemorySource = { kind: "rss", limit, used: () => at.used };
  return { at, source };
}

test("memory: a timed sample whose shedding throws is reported, and the guard keeps sampling", async () => {
  const { at, source } = fake();
  const failed: unknown[] = [];
  let samples = 0;
  const guard = new MemoryGuard({
    source,
    gc: null,
    sampled: () => samples++,
    pressed: () => {
      throw new Error("shedding broke");
    },
    failed: (error) => failed.push(error),
  });
  // check() itself still throws, so a test sees what broke.
  at.used = 800;
  let thrown: unknown = null;
  try {
    guard.check();
  } catch (error) {
    thrown = error;
  }
  assertMatch(String(thrown), /shedding broke/);
  guard.start(5);
  try {
    for (let i = 0; i < 200 && failed.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    guard.stop();
  }
  assert(failed.length >= 3, `${failed.length} failures reported`);
  assertMatch(String(failed[0]), /shedding broke/);
  assert(samples >= 4, `${samples} samples`);
});

test("memory: the guard is normal, high and critical by its watermarks, and says each change", () => {
  const { at, source } = fake();
  const changes: string[] = [];
  const pressed: string[] = [];
  const guard = new MemoryGuard({
    source,
    gc: null,
    changed: (level, previous, reading) => changes.push(`${previous}→${level} ${reading?.used}`),
    pressed: (level) => pressed.push(level),
  });
  assertEquals([guard.highBytes, guard.criticalBytes], [750, 900]);
  assertEquals([guard.highExitBytes, guard.criticalExitBytes], [700, 850]);
  at.used = 749;
  assertEquals(guard.check(), "normal");
  at.used = 750;
  assertEquals(guard.check(), "high");
  assertEquals(guard.check(), "high");
  at.used = 900;
  assertEquals(guard.check(), "critical");
  at.used = 100;
  assertEquals(guard.check(), "normal");
  assertEquals(changes, ["normal→high 750", "high→critical 900", "critical→normal 100"]);
  // Every sample past HIGH acts, not only the first.
  assertEquals(pressed, ["high", "high", "critical"]);
  assertEquals(guard.last, { used: 100, limit: 1000 });
});

test("memory: each level is left only below its exit, so a pod at a watermark does not flap", () => {
  const { at, source } = fake();
  let now = 0;
  const changes: string[] = [];
  const guard = new MemoryGuard({
    source,
    gc: null,
    now: () => now,
    changed: (level, previous) => changes.push(`${previous}→${level}`),
  });
  // Around the high watermark, in and out by a few bytes: high from the first time on.
  for (const used of [760, 740, 755, 701, 749, 700]) {
    at.used = used;
    now += 1000;
    assertEquals(guard.check(), "high", String(used));
  }
  assertEquals(guard.criticalSince, null);
  at.used = 905;
  now += 1000;
  assertEquals(guard.check(), "critical");
  assertEquals(guard.criticalSince, now);
  for (const used of [880, 899, 850]) {
    at.used = used;
    assertEquals(guard.check(), "critical", String(used));
  }
  at.used = 849;
  assertEquals(guard.check(), "high");
  assertEquals(guard.criticalSince, null);
  at.used = 699;
  assertEquals(guard.check(), "normal");
  assertEquals(changes, ["normal→high", "high→critical", "critical→high", "high→normal"]);
});

test("memory: past HIGH it collects garbage at most every GC_EVERY_MS, and never samples again at once", () => {
  const { at, source } = fake();
  let now = 0;
  let collected = 0;
  let reads = 0;
  const counted: MemorySource = { ...source, used: () => (reads++, source.used()) };
  const guard = new MemoryGuard({
    source: counted,
    now: () => now,
    gc: () => {
      collected++;
      at.used -= 200;
    },
  });
  at.used = 800;
  // What a collection frees reaches the counter seconds later: this sample stands.
  assertEquals(guard.check(), "high");
  assertEquals([collected, reads], [1, 1]);
  at.used = 950;
  now += GC_EVERY_MS - 1;
  assertEquals(guard.check(), "critical");
  assertEquals(collected, 1);
  now += 1;
  assertEquals(guard.check(), "critical");
  assertEquals([collected, reads], [2, 3]);
  // Nothing to collect below HIGH.
  at.used = 10;
  now += GC_EVERY_MS;
  assertEquals(guard.check(), "normal");
  assertEquals(collected, 2);
});

test("memory: the baseline is the least of the normal samples of the last minutes, held while pressed", () => {
  const at = { used: 0 };
  let now = 0;
  const source: MemorySource = { kind: "rss", limit: 1000, used: () => at.used };
  const guard = new MemoryGuard({ source, gc: null, now: () => now });
  const sample = (used: number) => {
    at.used = used;
    now += 1_000;
    return guard.check();
  };
  // A pod that starts pressed has none.
  assertEquals(sample(800), "high");
  assertEquals(guard.baseline, null);
  assertEquals(sample(600), "normal");
  assertEquals(guard.baseline, 600);
  // The least of them, not the latest.
  assertEquals(sample(650), "normal");
  assertEquals(sample(620), "normal");
  assertEquals(guard.baseline, 600);
  // While pressed, however long, it stays what the pod held before.
  assertEquals(sample(760), "high");
  assertEquals(guard.baseline, 600);
  now += 10 * BASELINE_MS;
  assertEquals(sample(770), "high");
  assertEquals(guard.baseline, 600);
  assertEquals(sample(500), "normal");
  // Back at normal: a new low is the baseline at once...
  assertEquals(guard.baseline, 500);
  // ...and a low older than BASELINE_MS is forgotten, so a pod that grew is measured against what
  // it holds now.
  for (let i = 0; i <= BASELINE_MS / 1_000; i++) sample(640 + (i % 5));
  assertEquals(guard.baseline, 640);
});

test("memory: the baseline is never more than 2 × HYSTERESIS below HIGH, however long the pod sat higher", () => {
  const at = { used: 0 };
  let now = 0;
  const source: MemorySource = { kind: "rss", limit: 1000, used: () => at.used };
  const guard = new MemoryGuard({ source, gc: null, now: () => now });
  assertEquals(guard.baselineCapBytes, Math.floor(1000 * (HIGH - 2 * HYSTERESIS)));
  // Just under the watermark for longer than the baseline looks back.
  for (let i = 0; i <= BASELINE_MS / 1_000 + 1; i++) {
    at.used = 740 + (i % 9);
    now += 1_000;
    assertEquals(guard.check(), "normal");
  }
  assertEquals(guard.baseline, 650);
  // Pressed, a spike just past the watermark is still the 2 × HYSTERESIS past the cap.
  at.used = 751;
  now += 1_000;
  assertEquals(guard.check(), "high");
  assertEquals(guard.baseline, 650);
  // Below the cap it is the least it held, as ever; and with HIGH lower, so is the cap.
  at.used = 600;
  now += 1_000;
  assertEquals(guard.check(), "normal");
  assertEquals(guard.baseline, 600);
  const low = new MemoryGuard({ source, gc: null, high: 0.5, critical: 0.6 });
  assertEquals(low.baselineCapBytes, 400);
});

test("memory: watermarks must be ordered inside the limit", () => {
  for (const [high, critical] of [[0.9, 0.75], [0, 0.5], [0.04, 0.5], [0.5, 1.5]]) {
    let threw = false;
    try {
      new MemoryGuard({ source: fake().source, high, critical });
    } catch {
      threw = true;
    }
    assert(threw, `${high} ${critical}`);
    assertMatch(badWatermarks(high, critical) ?? "", /must be 0.05 < high < critical <= 1/);
  }
  assertEquals(badWatermarks(0.75, 0.9), null);
  // A critical of 1 (refuse everyone only at the limit) is a watermark, and the variable takes it.
  assertEquals(badWatermarks(0.75, 1), null);
  assertEquals(fraction("1"), 1);
  assertEquals(fraction("0.9"), 0.9);
  for (const raw of ["0", "1.01", "-0.5", "x", ""]) assertEquals(fraction(raw), null, raw);
});

test("main: a retired variable still set is said at boot, with what replaced it", () => {
  assertEquals(retiredEnv(() => undefined), {});
  const said = retiredEnv((name) => name === "RYPH_PREVIEWS_INTERNAL_PORT" ? "7491" : undefined);
  assertEquals(Object.keys(said), ["RYPH_PREVIEWS_INTERNAL_PORT"]);
  assertMatch(
    said.RYPH_PREVIEWS_INTERNAL_PORT,
    /RYPH_PREVIEWS_TUNNEL_PORT.*RYPH_PREVIEWS_API_PORT/,
  );
});

/** A socket stand-in: what Connections needs of one. */
function socket(address = "10.0.0.1") {
  const one = new EventEmitter() as EventEmitter & { remoteAddress: string; destroyed: boolean };
  one.remoteAddress = address;
  one.destroyed = false;
  (one as unknown as { destroy(): void }).destroy = () => {
    one.destroyed = true;
    one.emit("close");
  };
  return one as unknown as Duplex & { destroyed: boolean };
}

test("connections: past the soft cap the longest idle go, never one in use", () => {
  let now = 0;
  const held = new Connections({ soft: 3, minIdleMs: 0, now: () => now });
  const [a, b, c] = [socket(), socket(), socket()];
  for (const one of [a, b, c]) {
    held.add(one);
    now += 10;
  }
  held.busy(a);
  held.upgraded(b);
  // `c` is the only idle one; a fourth makes room by closing it.
  const d = socket();
  held.add(d);
  assert(c.destroyed);
  assert(!a.destroyed && !b.destroyed && !d.destroyed);
  assertEquals(held.size, 3);
  // A request that ends makes its connection idle from then; the longest idle goes first.
  now += 10;
  held.done(a);
  now += 10;
  const e = socket();
  held.add(e);
  assert(d.destroyed, "d had been idle longest");
  assert(!a.destroyed);
  // Nothing idle: past the soft cap it is the hard cap's to refuse.
  held.busy(a);
  held.busy(e);
  held.add(socket());
  assertEquals(held.size, 4);
  assertEquals(held.closeIdle(10), 1);
});

test("connections: idle is by when a connection last finished a request, and finding none looks no further than the first that is not", () => {
  let now = 0;
  const held = new Connections({ soft: Infinity, minIdleMs: 0, now: () => now });
  const [a, b, c] = [socket(), socket(), socket()];
  for (const one of [a, b, c]) held.add(one);
  // Each serves a request; `b` finishes first, then `c`, then `a`.
  for (const one of [a, b, c]) held.busy(one);
  for (const one of [b, c, a]) {
    now += 10;
    held.done(one);
  }
  assertEquals(held.closeIdle(10, { idleMs: 15 }), 1);
  assert(b.destroyed && !c.destroyed && !a.destroyed);
  // Two requests at once on `c`: idle only once both are done.
  held.busy(c);
  held.busy(c);
  now += 100;
  held.done(c);
  assertEquals(held.idle, 1);
  held.done(c);
  now += 1;
  assertEquals(held.closeIdle(1), 1);
  assert(a.destroyed, "a has rested longest");
  // Thousands busy: none idle, and nothing past the first resting one is looked at.
  const busy = Array.from({ length: 5_000 }, () => socket());
  for (const one of busy) {
    held.add(one);
    held.busy(one);
  }
  assertEquals(held.idle, 1);
  assertEquals(held.closeIdle(10, { idleMs: 1_000 }), 0);
  assertEquals(held.closeIdle(10), 1);
  assertEquals(held.idle, 0);
});

test("connections: only a connection quiet for MIN_IDLE_MS is idle, a just-accepted one included", () => {
  let now = 0;
  const held = new Connections({ now: () => now });
  const fresh = socket();
  const used = socket();
  held.add(fresh);
  held.add(used);
  held.busy(used);
  now += MIN_IDLE_MS - 1;
  held.done(used);
  // Its first request's headers may still be arriving: not idle yet.
  assertEquals(held.idle, 0);
  assertEquals(held.closeIdle(10), 0);
  now += 1;
  assertEquals(held.idle, 1);
  assertEquals(held.closeIdle(10), 1);
  assert(fresh.destroyed && !used.destroyed);
  now += MIN_IDLE_MS;
  assertEquals(held.closeIdle(10), 1);
  assert(used.destroyed);
});

test("connections: a gone socket is not taken on", () => {
  const held = new Connections();
  const gone = socket();
  gone.destroy();
  assertEquals(held.add(gone), false);
  assertEquals(held.size, 0);
});

test("connections: untrusted ones are capped per address and in all, the silent making room", () => {
  let now = 0;
  const held = new Connections({
    untrusted: { perAddress: 2, total: 3, deadlineMs: 60_000 },
    now: () => now,
  });
  const next = (address: string) => {
    now += 1;
    const one = socket(address);
    assert(held.add(one));
    return one;
  };
  // Silent ones have no grace: a third from one address evicts its oldest at once.
  const [a, b] = [next("gate"), next("gate")];
  const c = next("gate");
  assert(a.destroyed && !b.destroyed && !c.destroyed);
  // Trusted (it dialled its tunnel): counted against no untrusted cap again.
  held.trust(b);
  const d = next("gate");
  assert(!b.destroyed && !c.destroyed && !d.destroyed);
  assertEquals(held.untrusted, 2);
  // In all: past three, the address holding the most gives one up, whatever its age, so a fresh
  // address always gets in.
  const e = next("pod-1");
  const f = next("pod-2");
  assert(c.destroyed, "the oldest of the address holding the most");
  assert(!d.destroyed && !e.destroyed && !f.destroyed && !b.destroyed);
  assertEquals(held.untrusted, 3);
  assertEquals(held.size, 4);
});

test("connections: one that spoke keeps its grace from its own address; the silent never have one", () => {
  let now = 0;
  const held = new Connections({
    untrusted: { perAddress: 2, total: 8, deadlineMs: 60_000 },
    now: () => now,
  });
  // An honest dial whose request arrived (it is being served), and a flood behind it.
  const honest = socket("gate");
  assert(held.add(honest));
  held.upgraded(honest);
  now += 1;
  const spoke = socket("gate");
  assert(held.add(spoke));
  held.busy(spoke);
  for (let i = 0; i < 100; i++) {
    now += 1;
    const flood = socket("gate");
    assertEquals(held.add(flood), false);
    assert(flood.destroyed);
  }
  assert(!honest.destroyed && !spoke.destroyed);
  // Past the grace the oldest makes room again.
  now += UNTRUSTED_GRACE_MS;
  assert(held.add(socket("gate")));
  assert(honest.destroyed, "the oldest, past its grace");
  assert(!spoke.destroyed);
  // A silent one makes room before one that spoke, though younger.
  held.trust(spoke);
  const talker = socket("pod");
  assert(held.add(talker));
  held.busy(talker);
  now += 1;
  const quiet = socket("pod");
  assert(held.add(quiet));
  now += 1;
  assert(held.add(socket("pod")));
  assert(quiet.destroyed && !talker.destroyed);
});

/** A sustained flood: `flooders` addresses each open a connection every millisecond for
 * `seconds`, and say nothing; `honest` opens one every 100 ms whose request arrives `speaksMs`
 * later and which dials its tunnel (is trusted) `dialsMs` after that. How many honest dials got
 * through, of how many. */
function flood(opts: {
  flooders: string[];
  honest: string;
  seconds: number;
  speaksMs: number;
  dialsMs: number;
}) {
  let now = 0;
  const held = new Connections({
    untrusted: { perAddress: 64, total: 256, deadlineMs: 5_000 },
    now: () => now,
  });
  const all: (Duplex & { destroyed: boolean })[] = [];
  const pending: { one: Duplex & { destroyed: boolean }; opened: number; spoke: boolean }[] = [];
  let dialled = 0;
  let tried = 0;
  for (; now < opts.seconds * 1000; now++) {
    for (const address of opts.flooders) {
      const one = socket(address);
      all.push(one);
      held.add(one);
    }
    if (now % 100 === 0) {
      const one = socket(opts.honest);
      all.push(one);
      tried++;
      if (held.add(one)) pending.push({ one, opened: now, spoke: false });
    }
    for (const dial of [...pending]) {
      if (dial.one.destroyed) {
        pending.splice(pending.indexOf(dial), 1);
      } else if (!dial.spoke && now - dial.opened >= opts.speaksMs) {
        dial.spoke = true;
        held.upgraded(dial.one);
      } else if (dial.spoke && now - dial.opened >= opts.speaksMs + opts.dialsMs) {
        held.trust(dial.one);
        dialled++;
        pending.splice(pending.indexOf(dial), 1);
      }
    }
    assert(held.untrusted <= 256);
  }
  for (const one of all) one.destroy();
  return { dialled, tried: tried - pending.length };
}

test("connections: a sustained flood from run pods never keeps another run's dial out (a cluster)", () => {
  // Four run pods, each at its own address, each opening a thousand connections a second for
  // ten seconds and saying nothing: the per-address and total caps both full all along. A run at
  // another address dials ten times a second, its request arriving a few milliseconds after it
  // connects, as on a cluster network: every dial gets through.
  const result = flood({
    flooders: ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
    honest: "10.0.0.9",
    seconds: 10,
    speaksMs: 5,
    dialsMs: 5,
  });
  assertEquals(result.dialled, 100);
  assertEquals(result.tried, 100);
});

test("connections: behind one address a flood can keep another run's dial out while it lasts, as documented (compose)", () => {
  // Every run's tunnel comes through the run gate's one address, so nothing tells the flooder's
  // connections from an honest run's. A dial whose request arrives within the time the flood
  // takes to open the per-address cap's worth (64 ms here) gets through; one that is slower is
  // closed while still silent, every time, for as long as the flood lasts, and its runner dials
  // again.
  const quick = flood({
    flooders: ["gate"],
    honest: "gate",
    seconds: 10,
    speaksMs: 20,
    dialsMs: 5,
  });
  assertEquals(quick.dialled, 100);
  const slow = flood({
    flooders: ["gate"],
    honest: "gate",
    seconds: 10,
    speaksMs: 100,
    dialsMs: 5,
  });
  assertEquals(slow.dialled, 0);
});

test("connections: closing idle ones can ask for a longer idle time", () => {
  let now = 0;
  const held = new Connections({ now: () => now });
  const [old, recent] = [socket(), socket()];
  held.add(old);
  now += 10_000;
  held.add(recent);
  now += MIN_IDLE_MS;
  assertEquals(held.closeIdle(10, { idleMs: 15_000 }), 0);
  now += 3_000;
  assertEquals(held.closeIdle(10, { idleMs: 15_000 }), 1);
  assert(old.destroyed && !recent.destroyed);
});

test("connections: an untrusted one is closed at its deadline, a trusted one never", async () => {
  const held = new Connections({ untrusted: { perAddress: 8, total: 8, deadlineMs: 20 } });
  const [silent, trusted] = [socket(), socket()];
  held.add(silent);
  held.add(trusted);
  held.trust(trusted);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(silent.destroyed);
  assert(!trusted.destroyed);
  assertEquals(held.size, 1);
  assertEquals(held.untrusted, 0);
});

test("connections: a real listener's idle keep-alive connections are closed, its busy ones kept", async () => {
  let release = () => {};
  const server = createServer((req, res) => {
    if (req.url === "/slow") release = () => res.end("slow");
    else res.end("ok");
  });
  const held = new Connections({ soft: Infinity, minIdleMs: 0 });
  server.on("connection", (one: Socket) => held.add(one));
  held.watch(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const open = async () => {
    const one = connect({ host: "127.0.0.1", port });
    one.on("error", () => {});
    await new Promise((resolve) => one.once("connect", resolve));
    return one;
  };
  const answer = (one: Socket, path: string) => {
    one.write(`GET ${path} HTTP/1.1\r\nhost: x\r\n\r\n`);
    return new Promise<void>((resolve) => one.once("data", () => resolve()));
  };
  const idle = await open();
  await answer(idle, "/");
  const busy = await open();
  const slow = answer(busy, "/slow");
  for (let i = 0; i < 100 && held.size < 2; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(held.idle, 1);
  const closed = new Promise<void>((resolve) => idle.once("close", () => resolve()));
  assertEquals(held.closeIdle(held.idle), 1);
  await closed;
  release();
  await slow;
  assert(!busy.destroyed);
  busy.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("memory: socket buffers the kernel may grow past 128 KiB are reported, so the boot line warns", () => {
  const from = (rmem: string | null, wmem: string | null) => (path: string) =>
    path.endsWith("tcp_rmem") ? rmem : path.endsWith("tcp_wmem") ? wmem : null;
  // The chart's sysctls.
  assertEquals(uncappedSocketBuffers(from("4096 32768 131072\n", "4096 16384 131072\n")), null);
  // Linux's defaults.
  assertEquals(
    uncappedSocketBuffers(from("4096\t131072\t6291456\n", "4096\t16384\t4194304\n")),
    { rmem: 6291456, wmem: 4194304 },
  );
  assertEquals(uncappedSocketBuffers(from("4096 32768 131072", "4096 16384 262144")), {
    rmem: 131072,
    wmem: 262144,
  });
  // Nothing to read (not Linux): nothing to say.
  assertEquals(uncappedSocketBuffers(from(null, null)), null);
});
