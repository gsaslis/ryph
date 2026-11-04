// `frontHttpServer` over real sockets: what it is for (an upgraded socket that pauses, bodies held
// both ways), and what it must keep of node:http's own listener (connection cap, deadlines, close).

import { afterEach, expect, test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, Socket } from "node:net";
import { Writable } from "node:stream";
import type { Duplex } from "node:stream";
import { frontHttpServer, frontOf } from "../src/front.ts";

const MiB = 2 ** 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const servers: Server[] = [];
const sockets: Duplex[] = [];
afterEach(async () => {
  // Server ends too: a paused one whose client left is not told (nothing reads it).
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
    ),
  );
});

/** `server`, fronted unless `native`, listening on a loopback port. */
async function listening(
  server: Server,
  opts: { native?: boolean; firstRequestMs?: number; log?: (error: Error) => void } = {},
) {
  if (!opts.native) {
    frontHttpServer(server, { firstRequestMs: opts.firstRequestMs, sweepMs: 50, log: opts.log });
  }
  server.on("connection", (socket: Duplex) => sockets.push(socket));
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as { port: number }).port;
}

function dial(port: number): Socket {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}

/** Writes `socket` full as fast as it drains, until it closes. Returns what it has written. */
function flood(socket: Socket): () => number {
  const batch = new Uint8Array(MiB).fill(1);
  let sent = 0;
  const pump = () => {
    while (!socket.destroyed && sent < 2 ** 34) {
      sent += batch.byteLength;
      if (!socket.write(batch)) return void socket.once("drain", pump);
    }
  };
  pump();
  return () => sent - socket.writableLength;
}

/** The most `measure` reads over `ms`, stopping early past `stop`. */
async function peakOver(ms: number, measure: () => number, stop = 64 * MiB) {
  let peak = 0;
  const until = Date.now() + ms;
  while (Date.now() < until && peak <= stop) {
    await sleep(10);
    peak = Math.max(peak, measure());
  }
  return peak;
}

/** An upgraded socket piped into a sink that never takes anything, as a relay whose far end
 * stopped reading has it; the client uploads as fast as it may. The peak the socket holds. */
async function stalledUpgrade(native: boolean) {
  let upgraded: Duplex | undefined;
  const server = createServer();
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    upgraded = socket;
    socket.on("error", () => socket.destroy());
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    socket.pipe(new Writable({ highWaterMark: 16 * 1024, write() {} }));
  });
  const port = await listening(server, { native });
  const client = dial(port);
  client.write(
    "GET / HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n" +
      "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await new Promise((resolve) => client.once("data", resolve));
  flood(client);
  return await peakOver(1_000, () => upgraded?.readableLength ?? 0);
}

test("front: an upgraded socket whose pipe stops reading holds a read or two", async () => {
  const peak = await stalledUpgrade(false);
  assert(peak <= 2 * MiB, `${(peak / MiB).toFixed(1)} MiB held`);
});

// The Bun 1.4.2 bug the front was written for (docs/runtime.md, Bun bugs): fixed in 1.4.3.
test("Bun: a node:http-upgraded socket whose pipe stops reading holds a read or two", async () => {
  const peak = await stalledUpgrade(true);
  assert(peak <= 2 * MiB, `${(peak / MiB).toFixed(1)} MiB held`);
});

test("front: a request body paused or piped into a sink that stopped holds a read or two", async () => {
  for (const how of ["paused", "piped"]) {
    let req: IncomingMessage | undefined;
    const server = createServer((r) => {
      req = r;
      if (how === "paused") r.pause();
      else r.pipe(new Writable({ highWaterMark: 16 * 1024, write() {} }));
    });
    const client = dial(await listening(server));
    client.write("POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100000000000\r\n\r\n");
    flood(client);
    const peak = await peakOver(
      1_000,
      () => (req?.readableLength ?? 0) + (req?.socket.readableLength ?? 0),
    );
    assert(peak <= 2 * MiB, `${how}: ${(peak / MiB).toFixed(1)} MiB held`);
  }
});

test("front: a body read slowly arrives whole, and one left unread lets the next request in", async () => {
  // Read slowly, a chunk a millisecond: every byte, in order of arrival.
  const body = new Uint8Array(8 * MiB).map((_, i) => i % 251);
  let got = 0;
  let same = true;
  const done = Promise.withResolvers<void>();
  const slow = createServer((req, res) => {
    req.pipe(
      new Writable({
        highWaterMark: 16 * 1024,
        write(chunk: Uint8Array, _encoding, callback) {
          for (const byte of chunk) same &&= byte === (got++ % 251);
          setTimeout(callback, 1);
        },
        final(callback) {
          res.end(String(got));
          done.resolve();
          callback();
        },
      }),
    );
  });
  const slowPort = await listening(slow);
  const answer = fetch(`http://127.0.0.1:${slowPort}/`, { method: "POST", body });
  await done.promise;
  assertEquals(await (await answer).text(), String(body.byteLength));
  assert(same);

  // Answered without reading its body, on a keep-alive connection: the next request is read.
  // One at a time: Bun's node:http loses a request pipelined on an emitted socket (Bun bugs).
  const unread = createServer((req, res) => res.end(`${req.method} ${req.url}`));
  const client = dial(await listening(unread));
  let replies = "";
  client.on("data", (chunk) => replies += chunk);
  const heads = [
    "POST /a HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n",
    "POST /b HTTP/1.1\r\nhost: x\r\ncontent-length: 5\r\n\r\nhello",
    "POST /c HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    `POST /d HTTP/1.1\r\nhost: x\r\ncontent-length: ${4 * MiB}\r\n\r\n${"x".repeat(4 * MiB)}`,
    "GET /e HTTP/1.1\r\nhost: x\r\n\r\n",
  ];
  for (const [i, head] of heads.entries()) {
    const path = `/${"abcde"[i]}`;
    client.write(head);
    for (let j = 0; j < 200 && !replies.includes(` ${path}`); j++) await sleep(10);
  }
  assertEquals(replies.match(/(POST|GET) \/[a-e]/g), [
    "POST /a",
    "POST /b",
    "POST /c",
    "POST /d",
    "GET /e",
  ]);
});

test("front: a response to a client that does not read holds what the socket buffers", async () => {
  let written = 0;
  let res: ServerResponse | undefined;
  const server = createServer((_req, r) => {
    res = r;
    r.writeHead(200, { "content-length": String(1e11) });
    const chunk = new Uint8Array(64 * 1024).fill(66);
    const pump = () => {
      while (written < 2 ** 34) {
        written += chunk.byteLength;
        if (!r.write(chunk)) return void r.once("drain", pump);
      }
    };
    pump();
  });
  const client = dial(await listening(server));
  client.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  client.once("data", () => client.pause());
  await peakOver(1_000, () => written);
  assert(res !== undefined);
  // The client's kernel buffers, the pod's, and the socket's own: a few MiB, never the gigabytes
  // a `drain` regardless of the socket would let through.
  assert(written <= 32 * MiB, `${(written / MiB).toFixed(1)} MiB written`);
  assert((res.socket?.writableLength ?? 0) <= MiB);
});

test("front: maxConnections, a first request's deadline and keepAliveTimeout", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  server.maxConnections = 2;
  server.keepAliveTimeout = 300;
  const port = await listening(server, { firstRequestMs: 300 });
  const closed = (socket: Socket) =>
    new Promise<number>((resolve) => {
      const started = Date.now();
      socket.once("close", () => resolve(Date.now() - started));
    });
  // A silent connection, and one that answered a request and sits idle.
  const silent = dial(port);
  const idle = dial(port);
  idle.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  await new Promise((resolve) => idle.once("data", resolve));
  const silentClosed = closed(silent);
  const idleClosed = closed(idle);
  // Past the cap, a third is closed at once.
  const third = dial(port);
  expect(await closed(third)).toBeLessThan(250);
  expect(await silentClosed).toBeLessThan(2_000);
  expect(await idleClosed).toBeLessThan(2_000);
  // Room again: a new connection is served.
  const again = dial(port);
  again.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
  let reply = "";
  again.on("data", (chunk) => reply += chunk);
  await new Promise((resolve) => again.once("close", resolve));
  assert(reply.startsWith("HTTP/1.1 200"), reply);
});

test("front: close() stops listening, closes idle connections at once and busy ones after their response", async () => {
  const answer = Promise.withResolvers<void>();
  const server = createServer(async (req, res) => {
    if (req.url === "/slow") await answer.promise;
    res.end("ok");
  });
  const port = await listening(server);
  assert(server.listening);
  const idle = dial(port);
  idle.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  await new Promise((resolve) => idle.once("data", resolve));
  const busy = dial(port);
  let reply = "";
  busy.on("data", (chunk) => reply += chunk);
  busy.write("GET /slow HTTP/1.1\r\nhost: x\r\n\r\n");
  await sleep(50);
  const idleClosed = new Promise((resolve) => idle.once("close", resolve));
  const busyClosed = new Promise((resolve) => busy.once("close", resolve));
  const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
  await idleClosed;
  assert(!server.listening);
  assert(!busy.destroyed);
  answer.resolve();
  await busyClosed;
  assert(reply.startsWith("HTTP/1.1 200"), reply);
  await stopped;
  servers.splice(servers.indexOf(server), 1);
});

test("front: each connection gets TCP keepalive and no Nagle delay, as node:http's own", async () => {
  const keepAlive: [boolean | undefined, number | undefined][] = [];
  const noDelay: (boolean | undefined)[] = [];
  const { setKeepAlive, setNoDelay } = Socket.prototype;
  Socket.prototype.setKeepAlive = function (this: Socket, enable?: boolean, delay?: number) {
    keepAlive.push([enable, delay]);
    return setKeepAlive.call(this, enable, delay);
  } as typeof setKeepAlive;
  Socket.prototype.setNoDelay = function (this: Socket, on?: boolean) {
    noDelay.push(on);
    return setNoDelay.call(this, on);
  };
  try {
    const server = createServer((_req, res) => res.end("ok"));
    frontHttpServer(server, { tcpKeepAliveMs: 1_234 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const reply = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    assertEquals(await reply.text(), "ok");
  } finally {
    Socket.prototype.setKeepAlive = setKeepAlive;
    Socket.prototype.setNoDelay = setNoDelay;
  }
  assert(keepAlive.some(([on, ms]) => on === true && ms === 1_234), JSON.stringify(keepAlive));
  assert(noDelay.includes(true), JSON.stringify(noDelay));
});

test("front: an error once listening is said, not thrown, when the server has no listener; one while it listens is the caller's", async () => {
  const said: Error[] = [];
  const server = createServer((_req, res) => res.end("ok"));
  await listening(server, { log: (error) => said.push(error) });
  // An accept failing for want of descriptors, say.
  frontOf(server)!.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
  assertEquals(said.map((error) => error.message), ["accept EMFILE"]);
  // With a listener of its own, the server hears it instead.
  const heard: Error[] = [];
  server.on("error", (error) => heard.push(error));
  frontOf(server)!.emit("error", new Error("again"));
  assertEquals(heard.map((error) => error.message), ["again"]);
  assertEquals(said.length, 1);

  // A port already taken fails the caller's listen, as node:http's own does.
  const taken = (server.address() as { port: number }).port;
  const other = createServer();
  frontHttpServer(other, { log: (error) => said.push(error) });
  const failed = await new Promise<Error>((resolve) => {
    other.once("error", resolve);
    other.listen(taken, "127.0.0.1");
  });
  assertEquals((failed as { code?: string }).code, "EADDRINUSE");
  assertEquals(said.length, 1);
});

test("front: a request whose connection closes before its body is read whole is aborted, as on an accepted socket", async () => {
  const seen = async (native: boolean, read: boolean, listen = true) => {
    const events: string[] = [];
    const done = Promise.withResolvers<void>();
    const server = createServer((req) => {
      req.on("aborted", () => events.push("aborted"));
      if (listen) {
        req.on("error", (error: Error & { code?: string }) => events.push(`error ${error.code}`));
      }
      req.on("close", () => {
        events.push("close");
        done.resolve();
      });
      if (read) req.resume();
      else req.pause();
    });
    const client = dial(await listening(server, { native }));
    client.write("POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100000\r\n\r\nabc");
    await sleep(50);
    client.resetAndDestroy();
    await done.promise;
    return events;
  };
  for (const read of [true, false]) {
    const native = await seen(true, read);
    assertEquals(native, ["aborted", "error ECONNRESET", "close"], `native, read ${read}`);
    assertEquals(await seen(false, read), native, `fronted, read ${read}`);
  }
  // With nobody listening for its error, none is thrown.
  assertEquals(await seen(true, false, false), ["aborted", "close"]);
  assertEquals(await seen(false, false, false), ["aborted", "close"]);
});

test("front: a server closed and listening again serves new connections", async () => {
  const server = createServer((_req, res) => res.end("ok"));
  const port = await listening(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const client = dial(port);
  let reply = "";
  client.on("data", (chunk) => reply += chunk);
  client.write("GET / HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n");
  await new Promise((resolve) => client.once("close", resolve));
  assert(reply.startsWith("HTTP/1.1 200"), reply);
});

test("front: requests pipelined on one connection are each answered, in order", async () => {
  const server = createServer((req, res) => setTimeout(() => res.end(`ok ${req.url}`), 20));
  const client = dial(await listening(server));
  let reply = "";
  client.on("data", (chunk) => reply += chunk);
  client.write(
    "GET /a HTTP/1.1\r\nhost: x\r\n\r\nGET /b HTTP/1.1\r\nhost: x\r\n\r\n" +
      "POST /c HTTP/1.1\r\nhost: x\r\ncontent-length: 3\r\n\r\nabc" +
      "GET /d HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
  );
  await new Promise((resolve) => client.once("close", resolve));
  assertEquals(reply.match(/ok \/\w/g), ["ok /a", "ok /b", "ok /c", "ok /d"]);
});
