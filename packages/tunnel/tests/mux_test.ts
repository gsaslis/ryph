import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { type Duplex, PassThrough } from "node:stream";
import { serve } from "@ryph/service";
import {
  Budget,
  type HostMux,
  hostMux,
  LATE_CREDIT,
  LATE_PER_STREAM,
  LATE_RATE,
  LATE_SLACK,
  MAX_BACKLOG,
  MAX_BUFFERED,
  MAX_FRAME,
  MAX_QUEUED_SENDS,
  MAX_STREAMS,
  runnerMux,
  TUNNEL_PROTOCOL,
} from "../src/mod.ts";

// The dev server: the first line a connection sends says what to do with it.
//   echo        answer every byte back
//   big <n>     send n bytes, then close
//   burst       send three 10 kB chunks, then close at once
function upstream(): Promise<Server> {
  const server = createServer((socket: Socket) => {
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Uint8Array) => {
      head += new TextDecoder().decode(chunk);
      const newline = head.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      const [command, arg] = head.slice(0, newline).split(" ");
      const rest = head.slice(newline + 1);
      if (command === "echo") {
        if (rest) socket.write(rest);
        socket.pipe(socket);
      } else if (command === "big") {
        socket.end(new Uint8Array(Number(arg)).fill(66));
      } else if (command === "burst") {
        for (let i = 0; i < 3; i++) socket.write(new Uint8Array(10_000).fill(65 + i));
        socket.end();
      }
    };
    socket.on("data", onData);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Both ends over a real WebSocket, the runner end dialing `port`. */
async function pair(port: number) {
  let host!: HostMux;
  const hostSocket = Promise.withResolvers<WebSocket>();
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req, info) => {
    const { socket, response } = info.upgradeWebSocket(req, {
      protocol: TUNNEL_PROTOCOL,
      maxPayload: MAX_FRAME + 4,
    });
    socket.binaryType = "arraybuffer";
    host = hostMux(socket);
    socket.onmessage = ({ data }) => {
      if (host.receive(data) === "invalid") socket.close();
    };
    socket.onopen = () => hostSocket.resolve(socket);
    socket.onclose = () => host.close();
    return response;
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.addr.port}`, TUNNEL_PROTOCOL);
  ws.binaryType = "arraybuffer";
  const runner = runnerMux(ws, () => connect({ host: "127.0.0.1", port, allowHalfOpen: true }));
  ws.onmessage = ({ data }) => {
    if (runner.receive(data) === "invalid") ws.close();
  };
  const runnerClosed = new Promise<void>((resolve) =>
    ws.addEventListener("close", () => resolve())
  );
  ws.onclose = () => runner.close();
  await new Promise((resolve) => ws.onopen = resolve);
  const hostWs = await hostSocket.promise;
  return {
    host,
    runner,
    hostWs,
    runnerWs: ws,
    runnerClosed,
    async close() {
      ws.close();
      hostWs.close();
      await runnerClosed;
      await server.shutdown();
    },
  };
}

/** What a stream delivers until it ends (the far end half-closed) or closes (aborted). */
function collect(stream: Duplex): Promise<{ bytes: Uint8Array; ended: boolean }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let ended = false;
    stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    stream.on("end", () => {
      ended = true;
      finish();
    });
    stream.on("close", finish);
    function finish() {
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      resolve({ bytes, ended });
    }
  });
}

/** Every stream a tunnel carries, opened at once. */
const all = (host: HostMux) =>
  Promise.all(Array.from({ length: MAX_STREAMS }, () => host.stream()));

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

test("tunnel: many streams interleave on one socket, each getting its own bytes", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const results = await within(
      Promise.all(Array.from({ length: MAX_STREAMS }, async (_, i) => {
        const stream = await ends.host.stream();
        const done = collect(stream);
        const payload = `stream ${i} `.repeat(2000);
        stream.write(`echo\n${payload}`);
        // The echo answers as it reads; half-close once all of it is back.
        let seen = 0;
        stream.on("data", (chunk: Uint8Array) => {
          seen += chunk.byteLength;
          if (seen === payload.length) stream.end();
        });
        const { bytes } = await done;
        return [payload, new TextDecoder().decode(bytes)];
      })),
      10_000,
      "interleaved echoes",
    );
    for (const [sent, received] of results) assertEquals(received, sent);
    assertEquals(ends.host.size, 0);
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: a stalled reader holds back only its own stream", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const size = 8 * 1024 * 1024;
    const slow = await ends.host.stream();
    slow.write(`big ${size}\n`);
    slow.pause();
    // Let the slow stream fill what it may: one frame in flight, so nowhere near 8 MB.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert(slow.readableLength <= 2 * MAX_FRAME, `buffered ${slow.readableLength}`);

    const quick = await ends.host.stream();
    quick.write("big 300000\n");
    const { bytes } = await within(collect(quick), 5000, "the quick stream");
    assertEquals(bytes.byteLength, 300_000);

    const slowDone = collect(slow);
    slow.resume();
    const all = await within(slowDone, 10_000, "the slow stream");
    assertEquals(all.bytes.byteLength, size);
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: a stream closed right after its end still delivers what was not read", async () => {
  // The dev server sends and closes at once, while node:http (under a slow browser) has the
  // stream paused: the bytes it holds must still arrive, then the end.
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const stream = await ends.host.stream();
    const done = collect(stream);
    stream.pause();
    stream.write("burst\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    stream.resume();
    const { bytes, ended } = await within(done, 3000, "the burst");
    assertEquals(bytes.byteLength, 30_000);
    assert(ended);
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: the stream cap holds the extra one back, and frees with a close", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const streams = await all(ends.host);
    let again: Duplex | undefined;
    const waiting = ends.host.stream().then((s) => again = s);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(again, undefined);
    assertEquals(ends.host.size, MAX_STREAMS);
    streams[0].destroy();
    await within(waiting, 1000, "the stream freed by a close");
    for (const stream of [...streams, again]) stream?.destroy();
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: past the cap a stream waits its turn, and a closed tunnel lets the waiters go", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const streams = await all(ends.host);
    let served = 0;
    const waiters = [ends.host.stream(), ends.host.stream()].map((p) =>
      p.then((s) => {
        served++;
        return s;
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(served, 0);
    streams[0].destroy();
    const first = await within(waiters[0], 3000, "the first waiter");
    assertEquals(served, 1);
    assertEquals(ends.host.size, MAX_STREAMS);
    first.destroy();
    (await within(waiters[1], 3000, "the second waiter")).destroy();
    streams[0] = await ends.host.stream();
    const last = ends.host.stream();
    ends.host.close();
    await assertRejects(() => last, Error, "preview disconnected");
    for (const stream of streams) stream.destroy();
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: a request abandoned while it waits gives up its place", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const streams = await all(ends.host);
    const left = new AbortController();
    const abandoned = ends.host.stream(left.signal);
    left.abort();
    await assertRejects(() => abandoned, Error, "request abandoned");
    // Its place is gone: a freed stream is not opened for it.
    streams[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(ends.host.size, MAX_STREAMS - 1);
    for (const stream of streams) stream.destroy();
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: a dev server that is not there closes the stream at once", async () => {
  const idle = createServer();
  await new Promise<void>((resolve) => idle.listen(0, "127.0.0.1", resolve));
  const port = (idle.address() as AddressInfo).port;
  await new Promise((resolve) => idle.close(resolve));
  const ends = await pair(port);
  try {
    const stream = await ends.host.stream();
    const { bytes, ended } = await within(collect(stream), 3000, "the refused stream");
    assertEquals(bytes.byteLength, 0);
    assert(!ended);
    assertEquals(ends.host.size, 0);
  } finally {
    await ends.close();
  }
});

/** A wire that records what it is sent, for driving one end by hand. */
function fakeWire(bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
    closed: false,
    sent: [] as unknown[],
    send(data: unknown) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
      this.readyState = 3;
    },
  };
}

function dataFrame(id: number, text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out.buffer;
}

test("tunnel: a malformed message is a broken wire; a late frame is not", async () => {
  const wire = fakeWire();
  const runner = runnerMux(wire, () => {
    throw new Error("must not dial");
  });
  for (const bad of ["nonsense", "{}", '{"open":-1}', '{"ack":1.5}', '{"ack":1,"end":1}', 7]) {
    assertEquals(hostMux(fakeWire()).receive(bad), "invalid", String(bad));
    assertEquals(runner.receive(bad), "invalid", String(bad));
  }
  // Only the host opens streams, and only ids it handed out exist.
  for (
    const bad of ['{"open":1}', '{"ack":0}', new ArrayBuffer(2), new ArrayBuffer(4 + MAX_FRAME + 1)]
  ) {
    assertEquals(hostMux(fakeWire()).receive(bad), "invalid", String(bad));
  }
  // Once broken, broken: whatever comes after is refused too, at no cost.
  const broken = hostMux(fakeWire());
  assertEquals(broken.receive("nonsense"), "invalid");
  assertEquals(broken.receive("ping"), "invalid");
  const host = hostMux(wire);
  // A stream the host already let go of: what was in flight for it is late, not wrong.
  (await host.stream()).destroy();
  assertEquals(host.receive(dataFrame(0, "late")), "ok");
  assertEquals(host.receive('{"end":0}'), "ok");
  assertEquals(host.receive('{"close":0}'), "ok");
  assertEquals(runner.receive('{"close":41}'), "ok");
  assertEquals(host.receive("ping"), "ping");
});

test("tunnel: the host refuses floods from the runner end", async () => {
  // Pings past the heartbeat's pace.
  const pinged = hostMux(fakeWire());
  const answers = Array.from({ length: 20 }, () => pinged.receive("ping"));
  assert(answers.includes("invalid"));

  // Late frames for finished streams, without end.
  const late = hostMux(fakeWire());
  (await late.stream()).destroy();
  const replies = Array.from({ length: 200 }, () => late.receive('{"close":0}'));
  assert(replies.includes("invalid"));

  // An ack for a frame that was never sent.
  const acked = hostMux(fakeWire());
  await acked.stream();
  assertEquals(acked.receive('{"ack":0}'), "invalid");
});

test("tunnel: late credit is earned per stream let go and capped, so a runner cannot bank it by streams opened", async () => {
  // Twenty thousand streams opened and let go earned at most LATE_CREDIT: what used to grow with
  // every stream ever opened (some 80 000 late 64 KiB frames, 4.9 GiB, taken with no time passing).
  const clock = 0;
  const host = hostMux(fakeWire(), { budget: new Budget(), now: () => clock });
  for (let i = 0; i < 20_000; i++) (await host.stream()).destroy();
  const big = dataFrame(0, "x".repeat(MAX_FRAME));
  let taken = 0;
  for (let i = 0; i < 2 * LATE_CREDIT && host.receive(big) === "ok"; i++) taken++;
  assertEquals(taken, LATE_CREDIT);
  // Broken: whatever comes after is refused at no cost.
  assertEquals(host.receive('{"close":0}'), "invalid");
});

test("tunnel: late credit is spent by each late message, and earned only as streams are let go", async () => {
  let clock = 0;
  const host = hostMux(fakeWire(), { budget: new Budget(), now: () => clock });
  // One stream let go: its share and the slack, spread over time so the late bucket never binds.
  (await host.stream()).destroy();
  let taken = 0;
  for (let i = 0; i < 1_000 && host.receive('{"close":0}') === "ok"; i++) {
    taken++;
    clock += 10;
  }
  assertEquals(taken, LATE_SLACK + LATE_PER_STREAM);
});

test("tunnel: late messages past their own bucket break the tunnel, however much credit it holds", async () => {
  let clock = 0;
  const host = hostMux(fakeWire(), { budget: new Budget(), now: () => clock });
  // Credit to the cap, earned over time; then twice the bucket's rate for a second.
  for (let i = 0; i < MAX_STREAMS; i++) (await host.stream()).destroy();
  clock += 1_000;
  let answer = "ok";
  for (let i = 0; i < 2 * LATE_RATE && answer === "ok"; i++) {
    clock += 500 / LATE_RATE;
    answer = host.receive('{"close":0}');
    // Credit keeps pace: a stream let go now and then, as a churning browser would.
    if (i % LATE_PER_STREAM === 0) (await host.stream()).destroy();
  }
  assertEquals(answer, "invalid");
});

test("tunnel: an honest runner's late messages never break the tunnel, however many streams finish", async () => {
  let clock = 0;
  // Their pace keeps the same clock: a thousand streams a second is a thousand a second to it.
  const host = hostMux(fakeWire(), { budget: new Budget({ now: () => clock }), now: () => clock });
  // Everything a runner may have in flight for a stream when the host lets it go.
  const late = (id: number) => [
    dataFrame(id, "late"),
    `{"ack":${id}}`,
    `{"end":${id}}`,
    `{"close":${id}}`,
  ];
  // A page torn down mid-load: every stream of a full tunnel let go at once, each with all four of
  // its late messages in flight, at no time passing.
  const streams = await Promise.all(Array.from({ length: MAX_STREAMS }, () => host.stream()));
  for (const stream of streams) stream.destroy();
  for (let id = 0; id < MAX_STREAMS; id++) {
    for (const one of late(id)) assertEquals(host.receive(one), "ok", `stream ${id}`);
  }
  // Ten thousand streams, a thousand a second, each finishing with its four late messages.
  for (let id = MAX_STREAMS; id < MAX_STREAMS + 10_000; id++) {
    (await host.stream()).destroy();
    clock += 1;
    for (const one of late(id)) assertEquals(host.receive(one), "ok", `stream ${id}`);
  }
  host.close();
});

test("tunnel: a runner that acks what it never reads cannot grow the host's backlog", async () => {
  const wire = fakeWire((MAX_STREAMS + 2) * MAX_FRAME);
  const host = hostMux(wire);
  const stream = await host.stream();
  const error = await new Promise<Error | null | undefined>((resolve) =>
    stream.write(new Uint8Array(10), resolve)
  );
  assert(error instanceof Error);
  assert(wire.closed);
});

test("tunnel: a runner that provokes acks it never reads is cut off", async () => {
  // An empty frame demands an ack and carries nothing: no honest end sends one.
  const empty = hostMux(fakeWire());
  (await empty.stream()).resume();
  assertEquals(empty.receive(dataFrame(0, "")), "invalid");

  // Tiny frames the reader takes at once, each acked, while the runner reads nothing back (each
  // acked at once: the clock moves a second a message, so the acks' pace never holds one back).
  const wire = fakeWire(64 * 1024);
  let clock = 0;
  const host = hostMux(wire, { now: () => clock += 1000 });
  wire.bufferedAmount = 0;
  (await host.stream()).resume();
  wire.bufferedAmount = 64 * 1024;
  for (let i = 0; i < 10_000 && !wire.closed; i++) host.receive(dataFrame(0, "x"));
  assert(wire.closed);
});

test("tunnel: a close with a write in flight still delivers what was not read", async () => {
  // The dev server answered and closed while the browser was still sending: the answer stays.
  const wire = fakeWire();
  const host = hostMux(wire);
  const stream = await host.stream();
  const written = new Promise<Error | null | undefined>((resolve) =>
    stream.write(new TextEncoder().encode("more body"), resolve)
  );
  stream.pause();
  assertEquals(host.receive(dataFrame(0, "hello")), "ok");
  assertEquals(host.receive('{"end":0}'), "ok");
  assertEquals(host.receive('{"close":0}'), "ok");
  assertEquals(await written, null);
  const done = collect(stream);
  stream.resume();
  const { bytes, ended } = await within(done, 1000, "the drained stream");
  assertEquals(new TextDecoder().decode(bytes), "hello");
  assert(ended);
});

test("tunnel: a dev server that half-closes still gets what is sent after", async () => {
  let received = "";
  const gotAll = Promise.withResolvers<void>();
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("error", () => {});
    socket.end("bye");
    socket.on("data", (chunk: Uint8Array) => received += new TextDecoder().decode(chunk));
    socket.on("end", () => gotAll.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const stream = await ends.host.stream();
    let got = "";
    stream.on("data", (chunk: Uint8Array) => got += new TextDecoder().decode(chunk));
    await new Promise<void>((resolve) => stream.once("end", resolve));
    assertEquals(got, "bye");
    stream.end("written after the server ended");
    await within(gotAll.promise, 3000, "the late write");
    assertEquals(received, "written after the server ended");
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: a stream freed at the cap is free on both ends at once", async () => {
  const server = await upstream();
  const ends = await pair((server.address() as { port: number }).port);
  try {
    const streams = await all(ends.host);
    for (let i = 0; i < 50; i++) {
      streams[i % MAX_STREAMS].destroy();
      const fresh = await ends.host.stream();
      streams[i % MAX_STREAMS] = fresh;
      const answer = new Promise<string>((resolve) =>
        fresh.once("data", (chunk: Uint8Array) => resolve(new TextDecoder().decode(chunk)))
      );
      fresh.write("echo\nhi");
      assertEquals(await within(answer, 2000, `replacement ${i}`), "hi");
    }
    for (const stream of streams) stream.destroy();
  } finally {
    await ends.close();
    server.close();
  }
});

test("tunnel: the runner refuses a reused stream id", async () => {
  const server = await upstream();
  const wire = fakeWire();
  const port = (server.address() as { port: number }).port;
  const sockets: Socket[] = [];
  const runner = runnerMux(wire, () => {
    const socket = connect({ host: "127.0.0.1", port });
    sockets.push(socket);
    return socket;
  });
  try {
    assertEquals(runner.receive('{"open":3}'), "ok");
    assertEquals(runner.receive('{"open":3}'), "invalid");
  } finally {
    runner.close();
    await Promise.all(
      sockets.map((s) => new Promise((r) => s.destroyed ? r(0) : s.on("close", r))),
    );
    server.close();
  }
});

test("tunnel: the runner keeps one frame in flight however the dev server's chunks arrive", () => {
  const wire = fakeWire();
  // Stands in for the dev server's socket, its chunks handed over by hand.
  const tcp = new PassThrough();
  const runner = runnerMux(wire, () => tcp as unknown as Socket);
  assertEquals(runner.receive('{"open":0}'), "ok");
  // A chunk longer than a frame, then another before any ack: a paused socket may still hand
  // over one it had already read. The second joins what is left; it neither replaces it nor
  // goes out as a second frame in flight.
  tcp.emit("data", new Uint8Array(MAX_FRAME + 10).fill(1));
  tcp.emit("data", new Uint8Array(5).fill(2));
  const frames = () => wire.sent.filter((m) => typeof m !== "string") as Uint8Array[];
  assertEquals(frames().length, 1);
  assertEquals(runner.receive('{"ack":0}'), "ok");
  assertEquals(frames().length, 2);
  assertEquals([...frames()[1].subarray(4)], [...Array(10).fill(1), ...Array(5).fill(2)]);
  runner.close();
});

test("tunnel: two people loading an unbundled page over HTTP/2 at once are served whole", async () => {
  // Each browser keeps up to 100 requests in flight on its one connection (the usual HTTP/2
  // stream limit) until its 300 modules are in: 200 at once at one tunnel of 64 streams.
  const budget = new Budget();
  const mux = hostMux(fakeWire(), { budget, group: "run" });
  const failed: string[] = [];
  let served = 0;
  const viewer = async () => {
    let left = 300;
    const lane = async () => {
      while (left > 0) {
        left--;
        try {
          const stream = await mux.stream();
          await new Promise((resolve) => setTimeout(resolve, 0));
          stream.destroy();
          served++;
        } catch (error) {
          failed.push((error as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: 100 }, lane));
  };
  await Promise.all([viewer(), viewer()]);
  assertEquals(failed, []);
  assertEquals(served, 600);
  mux.close();
  assertEquals(budget.open, 0);
  assertEquals(budget.waiting, 0);
});

test("tunnel: the host sends a write as frames of at most MAX_FRAME, one per ack, and ends after the last", async () => {
  const wire = fakeWire();
  const host = hostMux(wire);
  const stream = await host.stream();
  assertEquals(wire.sent.splice(0), ['{"open":0}']);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const sizes = [0, 1, MAX_FRAME - 1, MAX_FRAME, MAX_FRAME + 1, 2 * MAX_FRAME + 3];
  for (const [index, size] of sizes.entries()) {
    const last = index === sizes.length - 1;
    let done = false;
    stream.write(new Uint8Array(size).fill(7), () => done = true);
    // The last write's end is asked for at once: it must wait for every frame to be acked.
    if (last) stream.end();
    let sent = 0;
    let frames = 0;
    for (let round = 0; round < 10 && !done; round++) {
      await tick();
      const out = wire.sent.splice(0);
      const data = out.filter((message) => typeof message !== "string") as Uint8Array[];
      assert(!out.includes('{"end":0}'), `end sent with ${size - sent} bytes unacked`);
      // One frame in flight, never empty, never past MAX_FRAME.
      assert(data.length <= 1, `${data.length} frames in flight`);
      for (const one of data) {
        assertEquals(new DataView(one.buffer, one.byteOffset).getUint32(0), 0);
        const payload = one.byteLength - 4;
        assert(payload > 0 && payload <= MAX_FRAME, `a frame of ${payload} bytes`);
        sent += payload;
        frames++;
        assertEquals(host.receive('{"ack":0}'), "ok");
      }
    }
    await tick();
    assert(done, `the write of ${size} bytes finished`);
    assertEquals(sent, size);
    assertEquals(frames, Math.ceil(size / MAX_FRAME));
    // Every ack was for a frame in flight: one more is a broken wire.
    if (!last) assertEquals(wire.sent.filter((m) => typeof m !== "string"), []);
  }
  await tick();
  assertEquals(wire.sent.splice(0), ['{"end":0}']);
  stream.destroy();
});

test("tunnel: concurrent honest uploads, each with its one frame in flight, are never cut as stuck", async () => {
  // The worst an honest runner looks: every frame it has not acked yet still sits in the host's
  // queue (the kernel's buffers full), three uploads at once, thousands of sends.
  const wire = {
    ...fakeWire(),
    send(data: unknown) {
      this.sent.push(data);
      if (typeof data !== "string") this.bufferedAmount += (data as Uint8Array).byteLength;
    },
  };
  const host = hostMux(wire);
  const size = 8 * 1024 * 1024;
  let excess = 0;
  let failed = 0;
  for (let i = 0; i < 3; i++) {
    const stream = await host.stream();
    stream.write(new Uint8Array(size), (error) => error && failed++);
  }
  let delivered = 0;
  for (let round = 0; round < 1_000 && delivered < 3 * size && !wire.closed; round++) {
    const frames = wire.sent.splice(0).filter((m) => typeof m !== "string") as Uint8Array[];
    for (const frame of frames) {
      // The runner read it: it leaves the queue, and is acked.
      wire.bufferedAmount -= frame.byteLength;
      delivered += frame.byteLength - 4;
      host.receive(`{"ack":${new DataView(frame.buffer, frame.byteOffset).getUint32(0)}}`);
    }
    excess = Math.max(excess, host.excess());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert(!wire.closed, "an honest tunnel was cut");
  // What it has queued is every frame owed an ack: nothing the guard would cut it for.
  assert(excess < 1024, `${excess} bytes past what is owed`);
  assertEquals(delivered, 3 * size);
  assertEquals(failed, 0);
  host.close();
});

test("tunnel: frames that already left the queue earn no credit, so an ack flood behind them is cut by count", async () => {
  // A wire that queues what it is sent, byte for byte, until the test drains it.
  const wire = {
    ...fakeWire(),
    sends: 0,
    send(data: unknown) {
      this.sends++;
      this.bufferedAmount += typeof data === "string"
        ? data.length
        : (data as Uint8Array).byteLength;
    },
  };
  // The clock moves a second a message: the acks' pace is not what this is about.
  let clock = 0;
  const host = hostMux(wire, { now: () => clock += 1000 });
  // A page load: every stream has a frame of its request out, which the runner reads and never
  // acks, so every stream is owed an ack.
  const streams = await all(host);
  for (const stream of streams) {
    stream.resume();
    stream.write(new Uint8Array(MAX_FRAME), () => {});
  }
  assertEquals(wire.sends, 2 * MAX_STREAMS);
  // Owed, and still queued: none of it is excess, only the streams' opens are.
  assert(host.excess() < 1024, `${host.excess()} bytes past what is owed`);
  // The runner read them all: they left the queue, and the acks still owed earn nothing.
  wire.bufferedAmount = 0;
  assertEquals(host.excess(), 0);
  // Then it stops reading and floods tiny frames the browsers take at once: the host acks each
  // with a send of its own, and the queue grows by count, a few bytes at a time.
  const before = wire.sends;
  for (let i = 0; i < 4 * MAX_QUEUED_SENDS && !wire.closed; i++) {
    host.receive(dataFrame(i % MAX_STREAMS, "x"));
    if (i === 100) assertEquals(host.excess(), wire.bufferedAmount);
  }
  assert(wire.closed, "the tunnel was never cut");
  assert(wire.bufferedAmount < MAX_BACKLOG / 100, "cut by count, not by bytes");
  assertEquals(wire.sends - before, MAX_QUEUED_SENDS);
});

test("tunnel: a backlog past MAX_BACKLOG terminates the socket rather than queueing a close behind it", async () => {
  let terminated = false;
  const wire = {
    ...fakeWire(MAX_BACKLOG + 1),
    terminate() {
      terminated = true;
      this.readyState = 3;
    },
  };
  const host = hostMux(wire);
  const stream = await host.stream();
  stream.write(new Uint8Array(10), () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(terminated);
  assert(!wire.closed, "a graceful close would wait behind the backlog");
});

test("tunnel: a reload of a page whose uploads were in flight to a slow runner does not cut the tunnel; a second one does", async () => {
  let terminated = false;
  // A wire that queues what it is sent, byte for byte: the runner reads nothing meanwhile.
  const wire = {
    ...fakeWire(),
    send(data: unknown) {
      this.bufferedAmount += typeof data === "string"
        ? data.length
        : (data as Uint8Array).byteLength;
    },
    terminate() {
      terminated = true;
      this.readyState = 3;
    },
  };
  const host = hostMux(wire);
  /** Every stream of a tunnel uploading a frame, none of them acked. */
  const uploads = async () => {
    const streams = await all(host);
    for (const stream of streams) {
      stream.on("error", () => {});
      stream.write(new Uint8Array(MAX_FRAME), () => {});
    }
    return streams;
  };
  const first = await uploads();
  assert(!terminated);
  // The reload: every stream goes (their frames stay queued, owed to nobody now), and the page's
  // uploads go again on new streams.
  for (const stream of first) stream.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await uploads();
  assert(wire.bufferedAmount > MAX_BACKLOG, "past what the bytes alone once allowed");
  assert(!terminated, "an honest tunnel was cut");
  assert(!host.overBacklog());
  // Again before the runner read any of it: past what any honest runner leaves.
  for (const stream of second) stream.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.allSettled(Array.from({ length: MAX_STREAMS }, () => host.stream()))
    .then((streams) => {
      for (const one of streams) {
        if (one.status === "fulfilled") {
          one.value.on("error", () => {});
          one.value.write(new Uint8Array(MAX_FRAME), () => {});
        }
      }
    });
  assert(terminated, "the tunnel was never cut");
  assert(wire.bufferedAmount <= MAX_BUFFERED + MAX_FRAME + 64);
  host.close();
});
