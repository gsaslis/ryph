// An honest runner end is never told its wire is broken, however busy its dev server is: over a
// real loopback WebSocket (the local binary's own path, where a round trip is tens of µs and an
// honest stream sends tens of thousands of messages a second), and against random honest work
// over a wire that delivers late and in batches.
import { setDefaultTimeout, test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { createServer as httpServer, request } from "node:http";
import type { Duplex } from "node:stream";
import { serve } from "@ryph/service";
import {
  Budget,
  type HostMux,
  hostMux,
  MAX_FRAME,
  type PacerOptions,
  RUN_ACK_BURST,
  runnerMux,
  terminate,
  TUNNEL_PROTOCOL,
  type Wire,
} from "../src/mod.ts";

/** A tunnel over a real WebSocket on loopback, its runner end dialing `port`; counts what the
 * host received and whether any of it was refused. `pace` narrows its acks' pace. */
async function realTunnel(port: number, pace?: PacerOptions) {
  let host!: HostMux;
  const state = { received: 0, invalid: null as string | null };
  const opened = Promise.withResolvers<void>();
  const server = await serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req, info) => {
    const { socket, response } = info.upgradeWebSocket(req, {
      protocol: TUNNEL_PROTOCOL,
      maxPayload: MAX_FRAME + 4,
      maxFragments: 1,
    });
    socket.binaryType = "arraybuffer";
    host = hostMux(socket, { budget: new Budget({ pace }), group: "run" });
    socket.onmessage = ({ data }) => {
      state.received++;
      if (host.receive(data) === "invalid" && state.invalid === null) {
        state.invalid = typeof data === "string" ? data : `a frame of ${data.byteLength}`;
        // Cut at once, as the hosts do (`terminate`). A closing handshake waits for the runner's
        // close frame, which Bun 1.4.4's client sends behind everything it already queued (1.4.2
        // dropped that queue on the host's close). Under gVisor a flood of tiny messages drains
        // from loopback at some ten a second once the first 27 KiB are in, so the handshake would
        // outlast ws's 30 s close timeout.
        terminate(socket);
      }
    };
    socket.onopen = () => opened.resolve();
    socket.onclose = () => host.close();
    return response;
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.addr.port}`, TUNNEL_PROTOCOL);
  ws.binaryType = "arraybuffer";
  const runner = runnerMux(ws, () => connect({ host: "127.0.0.1", port, allowHalfOpen: true }));
  ws.onmessage = ({ data }) => runner.receive(data);
  const runnerClosed = new Promise<void>((resolve) =>
    ws.addEventListener("close", () => resolve())
  );
  ws.onclose = () => runner.close();
  await new Promise((resolve) => ws.onopen = resolve);
  await opened.promise;
  return {
    host,
    state,
    runnerWs: ws,
    runnerClosed,
    async close() {
      ws.close();
      await runnerClosed;
      await server.shutdown();
    },
  };
}

const listening = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );

// The random honest load is fixed work: ~4.7 s on a two-CPU Linux, past bun's default.
setDefaultTimeout(60_000);

/** A process pace so narrow that a burst of messages always outruns it. The run's own is left as
 * it is: it also bounds the run's late messages (one per stream an honest page load finishes), and
 * a run held to 64 of those is refused honest ones no deployment's pace would. */
const NARROW: PacerOptions = { burst: 64, rate: 2048 };

/** Polls `ok` until it holds or `ms` pass: a real wire's pace on a loaded machine varies. */
async function until(ok: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return ok();
}

for (
  const [what, pace] of [
    ["", undefined],
    // A pace so narrow every module waits on it: the load is slowed, never broken.
    [", its acks' pace narrowed so it is held to it,", NARROW],
  ] as const
) {
  test(`tunnel: a cold load of a 1000-module page over a real WebSocket${what} never breaks the tunnel`, async () => {
    await coldLoad(pace);
  });
}

async function coldLoad(pace?: PacerOptions) {
  const body = new Uint8Array(3000).fill(97);
  const dev = httpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/javascript", "content-length": body.length });
    res.end(body);
  });
  const tunnel = await realTunnel(await listening(dev), pace);
  try {
    // A hundred at a time, as a browser sends them over one HTTP/2 connection.
    let next = 0;
    let loaded = 0;
    const one = async (i: number) => {
      const stream = await tunnel.host.stream();
      await new Promise<void>((resolve, reject) => {
        const req = request({
          path: `/m${i}.js`,
          headers: { connection: "close" },
          createConnection: () => stream as unknown as Socket,
        }, (res) => {
          res.resume();
          res.on("end", () => {
            loaded++;
            stream.destroy();
            resolve();
          });
        });
        req.on("error", reject);
        req.end();
      });
    };
    await Promise.all(Array.from({ length: 100 }, async () => {
      while (next < 1000) await one(next++);
    }));
    assertEquals(tunnel.state.invalid, null);
    assertEquals(loaded, 1000);
    // Past a burst of acks' worth of messages, so the pace was in play.
    if (pace) assert(tunnel.state.received > pace.burst!, `${tunnel.state.received} messages`);
  } finally {
    await tunnel.close();
    dev.close();
  }
}

test("tunnel: a fine-grained event stream over a real WebSocket is slowed by the acks' pace, never broken", async () => {
  // A kilobyte an event, one per macrotask, minding backpressure: an async source piped into an
  // event stream, as fast as the tunnel takes it.
  const dev = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("error", () => {});
    let open = true;
    socket.on("close", () => open = false);
    const event = new TextEncoder().encode(`data: ${"x".repeat(1000)}\n\n`);
    const pump = () => {
      if (!open) return;
      if (socket.write(event)) setImmediate(pump);
      else socket.once("drain", pump);
    };
    pump();
    socket.resume();
  });
  const tunnel = await realTunnel(await listening(dev));
  try {
    const streams = await Promise.all([0, 1].map(() => tunnel.host.stream()));
    let bytes = 0;
    for (const stream of streams) {
      stream.on("error", () => {});
      stream.on("data", (chunk: Uint8Array) => bytes += chunk.byteLength);
    }
    // Well past the burst: the pace held it back, and it kept going. Polled, not timed: under a
    // parallel load a fixed wait fell short of it now and then.
    const kept = await until(() =>
      tunnel.state.invalid !== null ||
      (tunnel.state.received > 2 * RUN_ACK_BURST && bytes > 4 * 1024 * 1024)
    );
    for (const stream of streams) stream.destroy();
    assertEquals(tunnel.state.invalid, null);
    assert(kept, `${tunnel.state.received} messages, ${bytes} bytes`);
  } finally {
    await tunnel.close();
    dev.close();
  }
});

test("tunnel: over a real WebSocket, a runner that floods what answers nothing, or frames it was never acked for, is still cut off", async () => {
  const dev = createServer((socket: Socket) => socket.on("error", () => {}));
  const port = await listening(dev);
  for (const flood of ["late", "unacked"] as const) {
    // A runner sending slower than the acks' pace is acked as it goes, as an honest one is, so the
    // pace is narrowed below what even a slow machine (a check pod under gVisor) delivers.
    const tunnel = await realTunnel(port, flood === "unacked" ? NARROW : undefined);
    try {
      const stream = await tunnel.host.stream();
      stream.on("error", () => {});
      stream.resume();
      if (flood === "late") stream.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const frame = new Uint8Array(5);
      for (let i = 0; i < 4 * RUN_ACK_BURST; i++) {
        tunnel.runnerWs.send(flood === "late" ? '{"close":0}' : frame);
      }
      await within(tunnel.runnerClosed, 10_000, `the ${flood} flood`);
      assert(tunnel.state.invalid !== null, flood);
    } finally {
      await tunnel.close();
    }
  }
  dev.close();
});

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} was not cut off in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** A wire that records what it is sent, for driving one end by hand. */
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

function dataFrame(id: number, length: number): ArrayBuffer {
  const out = new Uint8Array(4 + length).fill(66);
  new DataView(out.buffer).setUint32(0, id);
  return out.buffer;
}

test("tunnel: a reader that asks for more than the mark at once is sent full frames, and the next unacked one is still refused", async () => {
  const wire = fakeWire();
  const host = hostMux(wire);
  const stream = await host.stream();
  stream.on("error", () => {});
  // More than a frame at once: the stream's mark rises to fit it.
  assertEquals(stream.read(100_000), null);
  assert(stream.readableHighWaterMark >= 100_000, `${stream.readableHighWaterMark}`);
  const acks = () => wire.sent.filter((one) => one === '{"ack":0}').length;
  assertEquals(host.receive(dataFrame(0, MAX_FRAME)), "ok");
  assertEquals(acks(), 1);
  // Below the risen mark this end acked, so the next full frame is honest.
  assertEquals(host.receive(dataFrame(0, MAX_FRAME)), "ok");
  assertEquals(acks(), 1);
  assertEquals(stream.readableLength, 2 * MAX_FRAME);
  // Past the mark, no ack went: a third is one too many.
  assertEquals(host.receive(dataFrame(0, MAX_FRAME)), "invalid");
  host.close();
});

/** mulberry32: the same sequence for the same seed, so a failure can be replayed. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two ends of a wire: in order each way, each message delivered on a later macrotask, a random
 * batch at a time; `bufferedAmount` is what is still on its way. */
function wirePair(random: () => number) {
  interface End extends Wire {
    readyState: number;
    onmessage: (data: string | ArrayBuffer) => void;
    peer: End;
  }
  const end = (): End => {
    const queue: { data: string | ArrayBuffer; bytes: number }[] = [];
    let queued = 0;
    let scheduled = false;
    const pump = () => {
      if (scheduled) return;
      scheduled = true;
      const later = random() < 0.5
        ? setImmediate
        : (fn: () => void) => setTimeout(fn, Math.floor(random() * 3));
      later(() => {
        scheduled = false;
        for (let n = 1 + Math.floor(random() * 8); n > 0 && queue.length > 0; n--) {
          if (self.peer.readyState !== 1) return;
          const message = queue.shift()!;
          queued -= message.bytes;
          self.peer.onmessage(message.data);
        }
        if (queue.length > 0) pump();
      });
    };
    const self: End = {
      readyState: 1,
      get bufferedAmount() {
        return queued;
      },
      onmessage: () => {},
      peer: null as unknown as End,
      send(data) {
        if (self.readyState !== 1) return;
        const message = typeof data === "string"
          ? { data, bytes: data.length }
          : { data: data.slice().buffer as ArrayBuffer, bytes: data.byteLength };
        queue.push(message);
        queued += message.bytes;
        pump();
      },
      close() {
        self.readyState = 3;
        self.peer.readyState = 3;
      },
    };
    return self;
  };
  const a = end();
  const b = end();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}

/** A dev server whose first line from the browser's side says what to do. */
function devServer(random: () => number): Server {
  return createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Uint8Array) => {
      head += new TextDecoder().decode(chunk);
      const newline = head.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      const [command, arg] = head.slice(0, newline).split(" ");
      const n = Number(arg);
      if (command === "down") {
        // n bytes in uneven writes, sometimes after a pause, minding backpressure.
        let left = n;
        const go = (): void => {
          while (left > 0) {
            const size = Math.min(left, 1 + Math.floor(random() * 100_000));
            left -= size;
            const more = socket.write(new Uint8Array(size).fill(66));
            if (random() < 0.1) return void setTimeout(go, 1);
            if (!more) return void socket.once("drain", go);
          }
          if (random() < 0.15) socket.destroy();
          else socket.end();
        };
        go();
        socket.resume();
      } else if (command === "up") {
        let got = 0;
        socket.on("data", (chunk: Uint8Array) => got += chunk.byteLength);
        socket.on("end", () => socket.end(`got ${got}`));
      } else if (command === "echo") {
        socket.pipe(socket);
      } else if (command === "chatty") {
        // Many tiny writes: hot reloads, an event stream.
        let ticks = 0;
        const timer = setInterval(() => {
          for (let i = 0; i < 20; i++) socket.write("data: x\n\n");
          if (++ticks > n) {
            clearInterval(timer);
            socket.end();
          }
        }, 1);
        socket.on("close", () => clearInterval(timer));
        socket.resume();
      } else if (command === "rst") {
        socket.write("partial");
        setTimeout(() => socket.destroy(), Math.floor(random() * 5));
      } else if (command === "half") {
        socket.end(new Uint8Array(n).fill(67));
        socket.resume();
      } else socket.destroy();
    };
    socket.on("data", onData);
  });
}

test("tunnel: random honest work between real ends over a late, batching wire is never refused", async () => {
  const random = prng(0x5eed);
  const dev = devServer(random);
  const port = await listening(dev);
  const refused: string[] = [];
  let opened = 0;
  try {
    for (let round = 0; round < 4; round++) {
      const [hostWire, runnerWire] = wirePair(random);
      const host = hostMux(hostWire, { budget: new Budget(), group: "run" });
      const runner = runnerMux(
        runnerWire,
        () => connect({ host: "127.0.0.1", port, allowHalfOpen: true }),
      );
      const down = () => {
        hostWire.close();
        host.close();
        runner.close();
      };
      hostWire.onmessage = (data) => {
        if (host.receive(data) === "invalid") {
          refused.push(`host, round ${round}: ${typeof data === "string" ? data : "a frame"}`);
          down();
        }
      };
      runnerWire.onmessage = (data) => {
        if (runner.receive(data) === "invalid") refused.push(`runner, round ${round}`);
      };
      const jobs: Promise<void>[] = [];
      for (let n = 20 + Math.floor(random() * 60); n > 0; n--) {
        jobs.push((async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * 30)));
          let stream: Duplex;
          try {
            stream = await host.stream(undefined, { long: random() < 0.1, waitMs: 2_000 });
          } catch {
            return;
          }
          opened++;
          stream.on("error", () => {});
          const done = new Promise<void>((resolve) => {
            stream.on("close", () => resolve());
            setTimeout(() => {
              stream.destroy();
              resolve();
            }, 1_500);
          });
          // How the browser's side reads: as it comes, a few bytes or many at once (past the
          // mark too), or pausing and resuming.
          const reads = random();
          if (reads < 0.4) stream.resume();
          else {
            const timer = setInterval(() => {
              if (stream.destroyed) return clearInterval(timer);
              if (reads < 0.7) stream.read(1 + Math.floor(random() * 200_000));
              else if (random() < 0.5) stream.pause();
              else stream.resume();
            }, reads < 0.7 ? 1 : 2);
            stream.on("close", () => clearInterval(timer));
          }
          stream.on("end", () => {
            if (random() < 0.5) stream.end();
          });
          const kind = random();
          if (kind < 0.25) stream.write(`down ${Math.floor(random() * 600_000)}\n`);
          else if (kind < 0.45) {
            stream.write("up\n");
            for (let left = Math.floor(random() * 400_000); left > 0 && !stream.destroyed;) {
              const size = Math.min(left, 1 + Math.floor(random() * 150_000));
              left -= size;
              if (!stream.write(new Uint8Array(size))) {
                await new Promise((resolve) => {
                  stream.once("drain", resolve);
                  stream.once("close", resolve);
                });
              }
            }
            stream.end();
          } else if (kind < 0.65) {
            stream.write("echo\n");
            for (let i = 0; i < 30 && !stream.destroyed; i++) {
              stream.write(new Uint8Array(1 + Math.floor(random() * 3000)));
              if (random() < 0.3) await new Promise((resolve) => setTimeout(resolve, 1));
            }
            if (random() < 0.5) stream.end();
          } else if (kind < 0.75) stream.write(`chatty ${Math.floor(random() * 20)}\n`);
          else if (kind < 0.85) stream.write("rst\n");
          else stream.write(`half ${Math.floor(random() * 200_000)}\n`);
          // The browser goes away, now and then.
          if (random() < 0.25) setTimeout(() => stream.destroy(), Math.floor(random() * 20));
          await done;
        })());
      }
      // Now and then the wire dies under it all.
      if (random() < 0.25) setTimeout(down, 50);
      await Promise.all(jobs);
      down();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    dev.close();
  }
  assertEquals(refused, []);
  assert(opened > 50, `${opened} streams`);
});
