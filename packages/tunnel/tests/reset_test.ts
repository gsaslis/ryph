// A cut this end makes while an exchange is under way resets the browser's socket: closed
// gracefully, what its kernel had not sent would wait there (FIN_WAIT1) for as long as the browser
// answers window probes without reading, charged to the process and to nobody else. The browser
// sees ECONNRESET, and the server's socket is gone at once. A finished exchange still ends
// gracefully. The preview listeners are fronted (`frontHttpServer`), as here: Bun 1.4.2 reset
// only sockets node:net accepted; 1.4.3 and later reset node:http's own as well.
import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as tcp, createServer as createNetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { frontHttpServer } from "@ryph/service";
import {
  Budget,
  type Charge,
  type Connect,
  holdsCharge,
  proxyHttp,
  proxyUpgrade,
  RECEIVE_BUFFER,
  reset,
  SEND_BUFFER,
} from "../src/mod.ts";

const listen = async (server: Server | ReturnType<typeof createNetServer>) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as { port: number }).port;
};

const stop = (server: Server | ReturnType<typeof createNetServer>) =>
  new Promise<void>((resolve) => {
    (server as Server).closeAllConnections?.();
    server.close(() => resolve());
  });

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The sockets on 127.0.0.1:`port` (where every listener here is) other than its listener, as the
 * kernel lists them: one closed and still sending (FIN_WAIT1) included. Null where there is no way
 * to ask. The address counts: the same port number is free on every other address, and on a busy
 * machine an unrelated connection (another program's, from the LAN address) takes it as its
 * ephemeral port, to be listed for as long as it lasts. */
function kernelSockets(port: number): string[] | null {
  if (process.platform === "linux") {
    // 127.0.0.1 as /proc/net/tcp writes it: the address's bytes in host (little-endian) order.
    const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
    let rows: string[];
    try {
      rows = readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1);
    } catch {
      return null;
    }
    return rows
      .map((row) => row.trim().split(/\s+/))
      // 0A is LISTEN.
      .filter(([, address, , state]) => address === local && state !== "0A")
      .map((row) => row.slice(1, 4).join(" "));
  }
  if (process.platform === "darwin") {
    return execFileSync("netstat", ["-an", "-p", "tcp"], { maxBuffer: 256 * 2 ** 20 }).toString()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[3] === `127.0.0.1.${port}` && cols[5] !== "LISTEN")
      .map((cols) => cols.join(" "));
  }
  return null;
}

/** Until the kernel holds no socket on `port` but its listener: a reset one is gone at once. Says
 * what it still lists when it gives up. */
const goneFromKernel = async (port: number) => {
  let left: string[] = [];
  await until(
    "the kernel lets go of the server's socket",
    () => (left = kernelSockets(port) ?? []).length === 0,
    10_000,
  ).catch((error) => {
    throw new Error(`${error.message}; still listed:\n${left.join("\n")}`);
  });
};

/** A dev server whose `/endless` is a download that never ends, and whose upgrade answers 101
 * and then sends without end; anything else is a short answer. */
async function devServer() {
  const chunk = new Uint8Array(64 * 1024);
  const server = createServer((req, res) => {
    if (req.url !== "/endless") {
      res.end("short");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const more = () => {
      while (!res.destroyed && res.write(chunk));
    };
    res.on("drain", more);
    more();
  });
  server.on("upgrade", (_req, socket: Duplex) => {
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    );
    const more = () => {
      while (!socket.destroyed && socket.write(chunk));
    };
    socket.on("drain", more);
    more();
  });
  return { server, port: await listen(server) };
}

/** A `Connect` to `port` whose streams are charged in `budget`, closed (as a stall or a shed
 * closes one) by destroying them with an error; `charges` and `streams` are what it handed out. */
function charged(port: number, budget: Budget) {
  const charges: Charge[] = [];
  const streams: Socket[] = [];
  const connect: Connect = (signal) =>
    budget.acquire("run", {
      signal,
      use: (charge) => {
        const stream = tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
        stream.on("error", () => {});
        holdsCharge(stream, charge);
        charge.buffered = () => stream.readableLength + stream.writableLength;
        charge.close = () => stream.destroy(new Error("tunnel stream stalled"));
        stream.once("close", () => charge.release());
        charges.push(charge);
        streams.push(stream);
        return stream as Duplex;
      },
    });
  return { connect, charges, streams };
}

/** A fronted proxy to `connect`, and the server sockets its browsers came on. */
async function proxy(connect: Connect) {
  const sockets: Duplex[] = [];
  const server = frontHttpServer(createServer((req, res) => {
    sockets.push(req.socket);
    void proxyHttp(req, res, connect);
  }));
  server.on("upgrade", (req, client: Duplex, head) => {
    sockets.push(client);
    void proxyUpgrade(req, client, head, connect);
  });
  return { server, sockets, port: await listen(server) };
}

/**
 * A browser that sends `head` and stops reading once it has the answer's head, and how its socket
 * ended (`reset`, `end`, or `open` after `ms`) once it reads again. A server's reset can be lost
 * on the way to a socket whose window it fell outside (seen on macOS; no reset is retransmitted),
 * so once what it reads goes quiet it sends a byte, which a reset server's kernel answers with
 * another. A graceful close would have shown as `end` by then: it follows the last byte read.
 */
async function stalled(port: number, head: string) {
  const socket = tcp({ host: "127.0.0.1", port });
  let got = "";
  const headed = Promise.withResolvers<void>();
  const onData = (chunk: Uint8Array) => {
    got += Buffer.from(chunk).toString("latin1");
    if (got.includes("\r\n\r\n")) {
      socket.off("data", onData);
      socket.pause();
      headed.resolve();
    }
  };
  socket.on("data", onData);
  const ended = new Promise<string>((resolve) => {
    socket.on(
      "error",
      (error: NodeJS.ErrnoException) =>
        resolve(error.code === "ECONNRESET" ? "reset" : `error ${error.code}`),
    );
    socket.on("end", () => resolve("end"));
  });
  socket.write(head);
  await headed.promise;
  return {
    socket,
    head: got,
    /** Reads again, and says how the socket ended. */
    outcome: (ms = 10_000) => {
      socket.on("data", () => {});
      socket.resume();
      let read = -1;
      const poke = setInterval(() => {
        if (socket.bytesRead === read && !socket.destroyed) socket.write("x");
        read = socket.bytesRead;
      }, 200);
      void ended.then(() => clearInterval(poke));
      setTimeout(() => clearInterval(poke), ms);
      return Promise.race([
        ended,
        new Promise<string>((resolve) => setTimeout(() => resolve("open"), ms)),
      ]);
    },
  };
}

test("the kernel keeps a socket closed with bytes unsent while its client reads nothing; a reset one it does not", async () => {
  // What the live test found, on loopback: 4 MiB written to a client that reads none of it, then
  // closed. Destroyed, the socket stays in FIN_WAIT1 holding what it had not sent, for as long as
  // the client answers window probes; reset, it is gone.
  const big = new Uint8Array(4 * 2 ** 20);
  for (const how of ["destroy", "reset"] as const) {
    const closed = Promise.withResolvers<void>();
    const server = createNetServer((socket) => {
      socket.on("error", () => {});
      socket.write(big);
      setTimeout(() => {
        if (how === "reset") reset(socket);
        else socket.destroy();
        closed.resolve();
      }, 200);
    });
    const port = await listen(server);
    const client = tcp({ host: "127.0.0.1", port });
    client.on("error", () => {});
    client.pause();
    await closed.promise;
    let left: string[] | null;
    if (how === "reset") {
      // Reset, it goes as soon as the kernel gets to it, however loaded the machine.
      await goneFromKernel(port).catch(() => {});
      left = kernelSockets(port);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 400));
      left = kernelSockets(port);
    }
    client.destroy();
    await stop(server);
    if (left === null) return;
    // The client's own socket is on another port: only the server's is listed. Linux keeps the
    // destroyed one; a netstack that frees it at once (gVisor's, in a check pod) lists none.
    if (how === "destroy") assert(left.length <= 1, left.join("\n"));
    else assertEquals(left, []);
  }
});

test("reset aborts a socket with a reset, and destroys one it cannot reset", async () => {
  const accepted = Promise.withResolvers<Socket>();
  const server = createNetServer((socket) => accepted.resolve(socket));
  const port = await listen(server);
  const client = tcp({ host: "127.0.0.1", port });
  const outcome = new Promise<string>((resolve) => {
    client.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    client.on("end", () => resolve("end"));
  });
  const socket = await accepted.promise;
  reset(socket);
  assert(socket.destroyed);
  assertEquals(await outcome, "ECONNRESET");
  // Not a socket at all, or nothing: destroyed, or nothing done.
  const { PassThrough } = await import("node:stream");
  const plain = new PassThrough();
  reset(plain);
  assert(plain.destroyed);
  reset(undefined);
  client.destroy();
  await stop(server);
});

test("reset resets a socket Bun's node:http accepted itself, a request's or an upgraded one", async () => {
  // Bun 1.4.2's `resetAndDestroy` did nothing on these (not even a close); 1.4.3 fixed it.
  for (const upgrade of [false, true]) {
    const accepted = Promise.withResolvers<Duplex>();
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      accepted.resolve(req.socket);
    });
    server.on("upgrade", (_req, socket: Duplex) => accepted.resolve(socket));
    const port = await listen(server);
    const client = tcp({ host: "127.0.0.1", port });
    const outcome = new Promise<string>((resolve) => {
      client.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      client.on("end", () => resolve("end"));
    });
    client.write(
      upgrade
        ? "GET / HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n"
        : "GET / HTTP/1.1\r\nhost: x\r\n\r\n",
    );
    reset(await accepted.promise);
    assertEquals(await outcome, "ECONNRESET", upgrade ? "upgraded" : "request");
    client.destroy();
    await stop(server);
  }
});

test("a stream closed under pressure resets a download its browser stopped reading", async () => {
  const dev = await devServer();
  const budget = new Budget();
  const up = charged(dev.port, budget);
  const front = await proxy(up.connect);
  try {
    const browser = await stalled(front.port, "GET /endless HTTP/1.1\r\nhost: x\r\n\r\n");
    assertMatch(browser.head, /^HTTP\/1\.1 200 /);
    // The browser's socket backs up: its kernel's send buffer counts as the stream's.
    await until("the browser's socket backs up", () => up.charges[0].buffered() > SEND_BUFFER);
    assertEquals(budget.relieve("high", () => true).closed, 1);
    // Gone at once, not closing behind the kernel's back, though the browser still reads nothing.
    assert(front.sockets[0].destroyed);
    await goneFromKernel(front.port);
    assertEquals(await browser.outcome(), "reset");
    await until("the charge is released", () => budget.open === 0);
  } finally {
    await stop(front.server);
    await stop(dev.server);
  }
});

test("a stream that dies mid-response (its tunnel gone) resets the browser, and a shed does too", async () => {
  const dev = await devServer();
  const budget = new Budget();
  const up = charged(dev.port, budget);
  const front = await proxy(up.connect);
  try {
    // The stream destroyed with no error, as a tunnel's loss destroys its streams.
    const first = await stalled(front.port, "GET /endless HTTP/1.1\r\nhost: x\r\n\r\n");
    await until("the stream is open", () => up.streams.length === 1);
    up.streams[0].destroy();
    await goneFromKernel(front.port);
    assertEquals(await first.outcome(), "reset");
    // CRITICAL's shed, whoever's it is.
    const second = await stalled(front.port, "GET /endless HTTP/1.1\r\nhost: x\r\n\r\n");
    await until("the browser's socket backs up", () => up.charges[1].buffered() > SEND_BUFFER);
    assertEquals(budget.shed(1).closed, 1);
    await goneFromKernel(front.port);
    assertEquals(await second.outcome(), "reset");
  } finally {
    await stop(front.server);
    await stop(dev.server);
  }
});

test("an upload paused unread counts its socket's buffer, and a shed resets it", async () => {
  // A dev server that takes the connection and reads nothing: the upload backs up to the browser.
  const held: Socket[] = [];
  const quiet = createNetServer({ pauseOnConnect: true }, (socket) => {
    socket.on("error", () => {});
    held.push(socket);
  });
  const quietPort = await listen(quiet);
  const budget = new Budget();
  const up = charged(quietPort, budget);
  const front = await proxy(up.connect);
  const browser = tcp({ host: "127.0.0.1", port: front.port });
  try {
    // A reset may not reach a client whose own sends are stuck behind a zero window until its
    // next probe; a graceful close would reach it at once, as an end.
    const outcome = new Promise<string>((resolve) => {
      browser.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      browser.on("end", () => resolve("end"));
      setTimeout(() => resolve("none yet"), 1_000);
    });
    browser.write(`POST /upload HTTP/1.1\r\nhost: x\r\ncontent-length: ${64 * 2 ** 20}\r\n\r\n`);
    const chunk = new Uint8Array(64 * 1024);
    const send = () => {
      while (!browser.destroyed && browser.write(chunk));
    };
    browser.on("drain", send);
    send();
    await until("the stream is open", () => up.charges.length === 1);
    // Paused on the server: its kernel's receive buffer counts as the stream's.
    await until(
      "the upload is paused",
      () => front.sockets[0].isPaused() && up.charges[0].buffered() >= RECEIVE_BUFFER,
    );
    assertEquals(budget.relieve("critical", () => true).closed, 1);
    assert(front.sockets[0].destroyed);
    await goneFromKernel(front.port);
    assertMatch(await outcome, /^(ECONNRESET|EPIPE|none yet)$/);
  } finally {
    browser.destroy();
    for (const socket of held) socket.destroy();
    await stop(front.server);
    await stop(quiet);
  }
});

test("an upgrade cut under pressure resets the browser's socket", async () => {
  const dev = await devServer();
  const budget = new Budget();
  const up = charged(dev.port, budget);
  const front = await proxy(up.connect);
  try {
    const browser = await stalled(
      front.port,
      "GET /hmr HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    assertMatch(browser.head, /^HTTP\/1\.1 101 /);
    await until("the browser's socket backs up", () => up.charges[0].buffered() > SEND_BUFFER);
    assertEquals(budget.relieve("high", () => true).closed, 1);
    assert(front.sockets[0].destroyed);
    await goneFromKernel(front.port);
    assertEquals(await browser.outcome(), "reset");
  } finally {
    await stop(front.server);
    await stop(dev.server);
  }
});

test("a finished response leaves its keep-alive connection open, and it ends gracefully", async () => {
  const dev = await devServer();
  const budget = new Budget();
  const up = charged(dev.port, budget);
  const front = await proxy(up.connect);
  front.server.keepAliveTimeout = 300;
  try {
    const socket = tcp({ host: "127.0.0.1", port: front.port });
    let got = "";
    socket.on("data", (chunk) => got += chunk);
    const ended = new Promise<string>((resolve) => {
      socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      socket.on("end", () => resolve("end"));
    });
    socket.write("GET /a HTTP/1.1\r\nhost: x\r\n\r\n");
    await until("the first answer", () => got.endsWith("short"));
    // Its stream is let go once the response is done, and no reset follows.
    await until("the stream is let go", () => budget.open === 0);
    socket.write("GET /b HTTP/1.1\r\nhost: x\r\n\r\n");
    await until("the second answer", () => got.split("short").length === 3);
    assertEquals(got.match(/HTTP\/1\.1 200 /g)?.length, 2);
    // Idle past the keep-alive timeout: closed with a FIN.
    assertEquals(await ended, "end");
    socket.destroy();
  } finally {
    await stop(front.server);
    await stop(dev.server);
  }
});
