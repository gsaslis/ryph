import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { createServer, type IncomingMessage, request } from "node:http";
import { connect as tcp, createServer as createNetServer } from "node:net";
import {
  Budget,
  type Connect,
  DRAIN_LIMIT,
  EARLY_LIMIT,
  EarlyBodies,
  endToEnd,
  holdsCharge,
  lasting,
  PAUSED_WAITERS,
  type ProxyHooks,
  proxyHttp,
  proxyUpgrade,
  RECEIVE_BUFFER,
  REFUSE_GRACE_MS,
  withoutHopByHop,
} from "../src/mod.ts";

// The proxy only needs a Duplex per request, so a plain TCP socket to the dev server stands in
// for a tunnel stream here; the full path over the mux is tested in packages/host.
async function front(connect: Connect, hooks?: ProxyHooks) {
  const server = createServer((req, res) => void proxyHttp(req, res, connect, hooks));
  server.on("upgrade", (req, client, head) => void proxyUpgrade(req, client, head, connect, hooks));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function dev() {
  const seen: IncomingMessage[] = [];
  const sockets = new Set<{ destroy(): void }>();
  const server = createServer((req, res) => {
    seen.push(req);
    res.setHeader("set-cookie", ["a=1; Domain=example.com", "b=2"]);
    res.end(`${req.headers.host} ${req.headers["x-added"] ?? "-"}`);
  });
  server.on("upgrade", (req, socket) => {
    seen.push(req);
    sockets.add(socket);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
        "x-dev: 1\r\n\r\n",
    );
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    seen,
    sockets,
    connect: () => Promise.resolve(tcp({ host: "127.0.0.1", port, allowHalfOpen: true })),
  };
}

function get(port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/x", headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    },
  );
}

const close = (server: { close(cb: () => void): void; closeAllConnections?(): void }) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

test("endToEnd drops hop-by-hop headers and those Connection names", () => {
  assertEquals(
    endToEnd({ connection: "keep-alive, X-Secret", "x-secret": "1", te: "trailers", a: "b" }),
    { a: "b" },
  );
});

test("withoutHopByHop keeps what Connection names, for a hop that must see it all", () => {
  assertEquals(
    withoutHopByHop({
      connection: "keep-alive, Origin",
      origin: "https://evil.example",
      te: "trailers",
      a: "b",
    }),
    { origin: "https://evil.example", a: "b" },
  );
});

test("proxy hooks rewrite request and response headers, the 101 included", async () => {
  const upstream = await dev();
  const hooks: ProxyHooks = {
    request(headers, req) {
      return { ...headers, host: "localhost:1", "x-added": req.url ?? "" };
    },
    response(headers, status) {
      const out = { ...headers, "x-status": String(status) };
      out["set-cookie"] = (headers["set-cookie"] ?? []).map((c) => c.replace(/; Domain=.*/, ""));
      return out;
    },
  };
  const proxy = await front(upstream.connect, hooks);
  try {
    const plain = await get(proxy.port, { connection: "keep-alive" });
    assertEquals(plain.status, 200);
    assertEquals(plain.body, "localhost:1 /x");
    assertEquals(plain.headers["x-status"], "200");
    assertEquals(plain.headers["set-cookie"], ["a=1", "b=2"]);
    assertEquals(upstream.seen[0].headers.connection, "close");

    const upgraded = await new Promise<IncomingMessage["headers"]>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy.port,
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.headers);
      });
      req.on("error", reject);
      req.end();
    });
    assertEquals(upgraded["x-status"], "101");
    assertEquals(upgraded["x-dev"], "1");
    // The upgrade's own headers reach the dev server, hooked.
    assertEquals(upstream.seen[1].headers.upgrade, "websocket");
    assertEquals(upstream.seen[1].headers["x-added"], "/");
  } finally {
    for (const socket of upstream.sockets) socket.destroy();
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("proxy answers 503 without a stream and resets a non-WebSocket upgrade", async () => {
  const proxy = await front(() => Promise.reject(new Error("busy")));
  try {
    const refused = await get(proxy.port);
    assertEquals(refused.status, 503);
    const outcome = await new Promise<string>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: proxy.port,
        headers: { connection: "Upgrade", upgrade: "h2c" },
      });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", () => resolve("answered"));
      req.on("error", () => resolve("reset"));
      req.end();
    });
    assertEquals(outcome, "reset");
  } finally {
    await close(proxy.server);
  }
  // The caller may answer in its own words.
  const worded = await front(() => Promise.reject(new Error("busy")), {
    unavailable: (res) => res.writeHead(503, { "x-page": "1" }).end("back soon"),
  });
  try {
    const refused = await get(worded.port);
    assertEquals([refused.status, refused.headers["x-page"], refused.body], [
      503,
      "1",
      "back soon",
    ]);
  } finally {
    await close(worded.server);
  }
});

/** A dev server that accepts upgrades and never answers them; `closed` counts the streams that
 * hung up on it. */
async function silent() {
  const sockets = new Set<{ destroy(): void }>();
  let closed = 0;
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    // Read, or the server may never notice the other end left (Deno's node:http did not), and
    // its `close` may not follow.
    socket.on("data", () => {});
    socket.on("end", () => closed++);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    sockets,
    closed: () => closed,
    connect: () => Promise.resolve(tcp({ host: "127.0.0.1", port, allowHalfOpen: true })),
  };
}

/** Streams handed out by `connect`, to see whether the proxy released each one. */
function tracked(connect: Connect) {
  const streams: import("node:stream").Duplex[] = [];
  return {
    streams,
    connect: async (signal: AbortSignal) => {
      const stream = await connect(signal);
      streams.push(stream);
      return stream;
    },
  };
}

/** A raw WebSocket handshake through the proxy: the head it got back, or how it ended. */
function rawUpgrade(port: number, leaveAfterMs?: number) {
  return new Promise<string>((resolve) => {
    const socket = tcp({ host: "127.0.0.1", port });
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk;
      if (got.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(got || "closed"));
    socket.write(
      "GET /hmr HTTP/1.1\r\nhost: a\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n",
    );
    if (leaveAfterMs !== undefined) setTimeout(() => socket.destroy(), leaveAfterMs);
  });
}

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a throwing request hook answers 502 and releases its stream", async () => {
  const upstream = await dev();
  const streams = tracked(upstream.connect);
  const proxy = await front(streams.connect, {
    request() {
      throw new Error("hook bug");
    },
  });
  try {
    assertEquals((await get(proxy.port)).status, 502);
    assertEquals(await rawUpgrade(proxy.port), "closed");
    assertEquals(streams.streams.length, 2);
    await until("both streams destroyed", () => streams.streams.every((s) => s.destroyed));
  } finally {
    for (const socket of upstream.sockets) socket.destroy();
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("a throwing response hook on an upgrade closes both ends instead of crashing", async () => {
  const upstream = await dev();
  const streams = tracked(upstream.connect);
  const proxy = await front(streams.connect, {
    response(headers, status) {
      if (status === 101) throw new Error("hook bug");
      return headers;
    },
  });
  try {
    assertEquals(await rawUpgrade(proxy.port), "closed");
    await until("the stream destroyed", () => streams.streams.every((s) => s.destroyed));
  } finally {
    for (const socket of upstream.sockets) socket.destroy();
    await close(proxy.server);
    await close(upstream.server);
  }
});

test("hook output that would split a header is never sent", async () => {
  const upstream = await dev();
  const hooks: ProxyHooks = {
    response: (headers) => ({ ...headers, "x-i": "a\r\nInjected: 1" }),
  };
  const proxy = await front(upstream.connect, hooks);
  try {
    const plain = await get(proxy.port);
    assertEquals(plain.status, 502);
    assertEquals(plain.headers.injected, undefined);
    const head = await rawUpgrade(proxy.port);
    assertEquals(/injected/i.test(head), false, head);
    assertEquals(head.startsWith("HTTP/1.1 101"), false, head);
  } finally {
    for (const socket of upstream.sockets) socket.destroy();
    await close(proxy.server);
    await close(upstream.server);
  }
  // A name that is not a token is refused the same way, on the way in too.
  const upstream2 = await dev();
  const proxy2 = await front(upstream2.connect, {
    request: (headers) => ({ ...headers, "x y": "1" }),
  });
  try {
    assertEquals((await get(proxy2.port)).status, 502);
    assertEquals(upstream2.seen.length, 0);
  } finally {
    await close(proxy2.server);
    await close(upstream2.server);
  }
});

test("a pending upgrade ends when the browser leaves, or after the timeout", async () => {
  const upstream = await silent();
  const server = createServer();
  server.on(
    "upgrade",
    (req, client, head) => void proxyUpgrade(req, client, head, upstream.connect, {}, 1000),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // The browser gives up before the dev server answers: the stream goes with it.
    await rawUpgrade(port, 50);
    await until("the stream released after the browser left", () => upstream.closed() === 1, 500);
    // The browser waits, the dev server never answers: both go at the timeout.
    const started = Date.now();
    assertEquals(await rawUpgrade(port), "closed");
    const waited = Date.now() - started;
    assertEquals(waited >= 900 && waited < 3000, true, `waited ${waited} ms`);
    await until("the stream released at the timeout", () => upstream.closed() === 2);
  } finally {
    for (const socket of upstream.sockets) socket.destroy();
    await close(server);
    await close(upstream.server);
  }
});

test("a refused upgrade is answered and closed, even when the browser never hangs up", async () => {
  // A dev server that refuses the upgrade (a host check's 403) and keeps its socket open.
  const refusing = createServer();
  const kept = new Set<{ destroy(): void }>();
  refusing.on("upgrade", (_req, socket) => {
    // Its own to close: Bun 1.4.4's `server.close()` waits on an upgraded socket, as Node's does,
    // and one whose peer sent a FIN stays half-open (1.4.2 closed it, and did not wait).
    kept.add(socket);
    socket.on("error", () => {});
    socket.write("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  const port = (refusing.address() as { port: number }).port;
  const clientClosed = Promise.withResolvers<number>();
  const server = createServer();
  server.on("upgrade", (req, client, head) => {
    const since = Date.now();
    client.on("close", () => clientClosed.resolve(Date.now() - since));
    void proxyUpgrade(
      req,
      client,
      head,
      () => Promise.resolve(tcp({ host: "127.0.0.1", port, allowHalfOpen: true })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A client that reads the answer and never sends a FIN of its own.
  const browser = tcp({
    host: "127.0.0.1",
    port: (server.address() as { port: number }).port,
    allowHalfOpen: true,
  });
  browser.on("error", () => {});
  let answer = "";
  browser.on("data", (chunk) => answer += chunk);
  browser.write(
    "GET /hmr HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n" +
      "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  try {
    const after = await Promise.race([
      clientClosed.promise,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), REFUSE_GRACE_MS + 3000)),
    ]);
    assert(after >= 0, "the refused socket was never closed");
    assert(answer.startsWith("HTTP/1.1 403 Forbidden\r\n"), answer);
  } finally {
    browser.destroy();
    for (const socket of kept) socket.destroy();
    await close(server);
    await close(refusing);
  }
});

/** A dev server that answers every request on its connection with `answer`, raw. */
async function answering(answer: string) {
  const upstream = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.write(answer));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  return {
    connect: () => Promise.resolve(tcp({ host: "127.0.0.1", port, allowHalfOpen: true })),
    close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  };
}

/** Whether `text` holds a whole response head. */
const headRead = (text: string) => text.includes("\r\n\r\n");

/** What a browser reads of an upgrade through `port` until a whole answer head is in, the
 * connection closes, or `ms` passes. */
async function upgradeAnswer(port: number, ms = REFUSE_GRACE_MS + 5_000) {
  const browser = tcp({ host: "127.0.0.1", port });
  browser.on("error", () => {});
  let answer = "";
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    browser.on("data", (chunk) => {
      answer += chunk;
      if (headRead(answer)) done();
    });
    browser.once("close", done);
    browser.write(
      "GET /hmr HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: websocket\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
  });
  browser.destroy();
  return answer;
}

test("a 204 or a 101 is passed on without the content-length its dev server gave it", async () => {
  const noContent = await answering("HTTP/1.1 204 No Content\r\ncontent-length: 5\r\n\r\n");
  const switching = await answering(
    "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
      "content-length: 0\r\n\r\n",
  );
  const plain = await front(noContent.connect);
  const upgraded = await front(switching.connect);
  try {
    const head = (await rawResponses(plain.port, "/x", 5_000, headRead)).split("\r\n\r\n")[0];
    assertMatch(head, /^HTTP\/1\.1 204 /);
    assert(!/\r\ncontent-length:/i.test(head), head);
    const answer = await upgradeAnswer(upgraded.port);
    assertMatch(answer, /^HTTP\/1\.1 101 /);
    assert(!/\r\ncontent-length:/i.test(answer.split("\r\n\r\n")[0]), answer);
  } finally {
    await close(plain.server);
    await close(upgraded.server);
    await noContent.close();
    await switching.close();
  }
});

test("a 101 that is no upgrade is answered 502, never passed on", async () => {
  const bare = await answering("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  const { server, port } = await front(bare.connect);
  try {
    const answer = await upgradeAnswer(port);
    assertMatch(answer, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  } finally {
    await close(server);
    await bare.close();
  }
});

test("a request asking for an event stream is long-lived, and so is one answered with one", async () => {
  assert(lasting({ accept: "text/event-stream" }));
  assert(lasting({ accept: "text/html, Text/Event-Stream;q=0.9" }));
  // A plain request's Upgrade (h2c) is never upgraded, and the hop to another pod drops it.
  assert(!lasting({ upgrade: "h2c" }));
  assert(!lasting({ accept: "*/*" }));
  assert(!lasting({}));

  // A dev server that answers an event stream to a fetch that never said it wanted one, and a
  // plain answer to another: only the first stream's charge is promoted.
  const sse = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: hi\n\n");
    } else res.end("plain");
  });
  await new Promise<void>((resolve) => sse.listen(0, "127.0.0.1", resolve));
  const port = (sse.address() as { port: number }).port;
  const budget = new Budget();
  const proxy = await front((signal) =>
    budget.acquire("run", {
      signal,
      use: (charge) => {
        const stream = tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
        holdsCharge(stream, charge);
        stream.once("close", () => charge.release());
        return stream;
      },
    })
  );
  try {
    assertEquals((await get(proxy.port)).body, "plain");
    assertEquals(budget.long, 0);
    const events = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, path: "/events" }, resolve);
      req.on("error", reject);
      req.end();
    });
    assertEquals(events.headers["content-type"], "text/event-stream");
    assertEquals(budget.long, 1, "the event stream's charge is long-lived");
    events.destroy();
    await until("the event stream released", () => budget.open === 0);
    assertEquals(budget.long, 0);
  } finally {
    await close(proxy.server);
    sse.closeAllConnections();
    await close(sse);
  }
});

test("a request waiting for a stream has its body left unread, and sent whole once it has one", async () => {
  // A dev server that counts what it is sent.
  let received = -1;
  const upstream = createServer((req, res) => {
    let size = 0;
    req.on("data", (chunk: Uint8Array) => size += chunk.byteLength);
    req.on("end", () => {
      received = size;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let grant = () => {};
  const granted = new Promise<void>((resolve) => grant = resolve);
  const waiting: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    waiting.push(req);
    void proxyHttp(req, res, async () => {
      await granted;
      return tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const body = 4 * 1024 * 1024;
  try {
    const answer = new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        method: "POST",
        path: "/upload",
        headers: { "content-length": String(body) },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(new Uint8Array(body));
    });
    await until("the request reached the proxy", () => waiting.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Nothing more of the body was read into the process while it waited than came in the read
    // its headers did, a read being at most Bun's 512 KiB. Bun 1.4.4 pushes that read's share of
    // the body into the request whatever `pause()` says; 1.4.2 held it where `readableLength`
    // did not show it.
    assert(waiting[0].readableLength <= 512 * 1024, `${waiting[0].readableLength} read`);
    grant();
    assertEquals(await answer, 200);
    assertEquals(received, body);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("an upgrade that sends more than a few KiB while it waits for a stream is closed", async () => {
  let asked = 0;
  const server = createServer();
  server.on(
    "upgrade",
    (req, client, head) =>
      void proxyUpgrade(req, client, head, (signal) =>
        new Promise((_resolve, reject) => {
          asked++;
          signal.addEventListener("abort", () => reject(new Error("left")), { once: true });
        })),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const socket = tcp({ host: "127.0.0.1", port });
  try {
    await new Promise((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => {});
    socket.write(
      "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
        "sec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await until("the upgrade waits", () => asked === 1);
    socket.write(new Uint8Array(EARLY_LIMIT + 1));
    await closed;
  } finally {
    socket.destroy();
    await close(server);
  }
});

test("a small POST whose browser left while it waited gives up its place, and is never sent", async () => {
  const left: string[] = [];
  let reached = 0;
  const upstream = createServer((_req, res) => {
    reached++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let grant = () => {};
  const granted = new Promise<void>((resolve) => grant = resolve);
  const { server, port: frontPort } = await front(async (signal) => {
    signal.addEventListener("abort", () => left.push("left"), { once: true });
    await granted;
    return tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
  });
  try {
    const socket = tcp({ host: "127.0.0.1", port: frontPort });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      "POST /save HTTP/1.1\r\nhost: x\r\ncontent-length: 5\r\n\r\nhello",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The browser goes (a FIN, as a closed tab sends) while its request is still in line.
    socket.end();
    await until("the request left the line", () => left.length === 1);
    grant();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(reached, 0);
  } finally {
    grant();
    await close(server);
    await close(upstream);
  }
});

test("small bodies are read while they wait only while the process has room, and counted by group", async () => {
  let received: string[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      received.push(body);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let grant = () => {};
  const granted = new Promise<void>((resolve) => grant = resolve);
  const bodies = new EarlyBodies(8);
  const waiting: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    waiting.push(req);
    void proxyHttp(req, res, async () => {
      await granted;
      return tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
    }, { early: bodies.for(req.url) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = (path: string, body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        method: "POST",
        path,
        agent: false,
        headers: { "content-length": String(body.length) },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    const first = post("/a", "hello");
    await until("the first is in line", () => waiting.length === 1);
    const second = post("/b", "world");
    await until("the second is in line", () => waiting.length === 2);
    const upload = "x".repeat(RECEIVE_BUFFER + 64 * 1024);
    const third = post("/c", upload);
    await until("the third is in line", () => waiting.length === 3);
    // Polled, not a fixed wait: under a parallel load the first body's read can take a while.
    await until("the first body read", () => bodies.total === 5);
    // Room for one: the first is read and counted to its group, the others paused unread and
    // counted as what they hold, asked live: what was read of them here and on their sockets and
    // their kernel's buffer, never more than their length.
    assertEquals(bodies.total, 5);
    assertEquals([...bodies.byGroup()], [["/a", 5]]);
    const paused = bodies.pausedByGroup();
    assertEquals([...paused.keys()], ["/b", "/c"]);
    assertEquals(paused.get("/b"), 5);
    const large = waiting[2];
    assertEquals(
      paused.get("/c"),
      Math.min(
        upload.length,
        large.readableLength + large.socket.readableLength + RECEIVE_BUFFER,
      ),
    );
    assert(paused.get("/c")! >= RECEIVE_BUFFER);
    assertEquals(bodies.pausedLarge("/c"), 1);
    assertEquals(bodies.pausedLarge("/b"), 0);
    // Paused, but its few bytes came in the read its headers did, and sit in the request (Bun
    // 1.4.4, as above): counted as paused, not as an early body.
    assert(waiting[1].readableLength <= 5);
    grant();
    assertEquals(await Promise.all([first, second, third]), [200, 200, 200]);
    assertEquals(received.sort(), ["hello", "world", upload]);
    // Given back once each went on.
    assertEquals(bodies.total, 0);
    assertEquals(bodies.byGroup().size, 0);
    assertEquals(bodies.pausedByGroup().size, 0);
  } finally {
    received = [];
    await close(server);
    await close(upstream);
  }
});

test("a group holds at most its cap of large bodies paused in line; past it a large one is a 503, a small one waits", async () => {
  let received = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      received++;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let grant = () => {};
  const granted = new Promise<void>((resolve) => grant = resolve);
  const refusedBy: unknown[] = [];
  // No room for early bodies, so the small one is paused too: it still waits.
  const bodies = new EarlyBodies(0, { pausedCap: 2, refused: (group) => refusedBy.push(group) });
  const waiting: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    waiting.push(req);
    void proxyHttp(req, res, async () => {
      await granted;
      return tcp({ host: "127.0.0.1", port, allowHalfOpen: true });
    }, { early: bodies.for(req.url!.split("?")[0]) });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = (path: string, body: string, chunked = false) =>
    new Promise<{ status: number; connection?: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: (server.address() as { port: number }).port,
        method: "POST",
        path,
        agent: false,
        headers: chunked
          ? { "transfer-encoding": "chunked" }
          : { "content-length": String(body.length) },
      }, (res) => {
        res.resume();
        res.on(
          "end",
          () => resolve({ status: res.statusCode!, connection: res.headers.connection }),
        );
      });
      req.on("error", reject);
      req.end(body);
    });
  const upload = "x".repeat(64 * 1024);
  assertEquals(new EarlyBodies().pausedCap, PAUSED_WAITERS);
  try {
    const first = post("/a?1", upload);
    const second = post("/a?2", "y", true);
    await until("two large ones wait", () => bodies.pausedLarge("/a") === 2);
    // A third large one of the group is turned away at once, with its connection.
    assertEquals(await post("/a?3", upload), { status: 503, connection: "close" });
    assertEquals(refusedBy, ["/a"]);
    // A small one of the same group waits, and another group's large one too.
    const small = post("/a?4", "hello");
    const other = post("/b", upload);
    await until("both wait", () => waiting.length === 5);
    await until("both counted", () => bodies.pausedLarge("/b") === 1);
    assertEquals(bodies.pausedLarge("/a"), 2);
    grant();
    assertEquals((await Promise.all([first, second, small, other])).map((r) => r.status), [
      200,
      200,
      200,
      200,
    ]);
    assertEquals(received, 4);
    assertEquals(bodies.pausedByGroup().size, 0);
    assertEquals(bodies.pausedLarge("/a"), 0);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test("a request refused while its body is still coming says connection: close, and a large upload is cut", async () => {
  const { server, port } = await front(() => Promise.reject(new Error("busy")));
  try {
    const socket = tcp({ host: "127.0.0.1", port });
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    let answer = "";
    socket.on("data", (chunk) => answer += chunk);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("POST /x HTTP/1.1\r\nhost: x\r\ncontent-length: 67108864\r\n\r\n");
    // A 64 MiB upload, of which the server reads at most DRAIN_LIMIT before it lets go.
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    for (let i = 0; i < 64 && !socket.destroyed; i++) {
      socket.write(chunk);
      sent += chunk.byteLength;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await closed;
    assert(sent <= DRAIN_LIMIT + 4 * chunk.byteLength, `${sent} sent`);
    assertMatch(answer, /^HTTP\/1\.1 503 /);
    assertMatch(answer, /\r\nconnection: close\r\n/i);
  } finally {
    await close(server);
  }
});

/** What a raw client reads of one GET through `port` until the connection closes, `ms` passes,
 * or what it read is `enough`: each response's head and how many body bytes followed it. */
async function rawResponses(
  port: number,
  path: string,
  ms = 1_500,
  enough: (text: string) => boolean = () => false,
) {
  const client = tcp({ host: "127.0.0.1", port });
  client.on("error", () => {});
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    client.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
      if (enough(Buffer.concat(chunks).toString("latin1"))) done();
    });
    client.once("close", done);
    client.write(`GET ${path} HTTP/1.1\r\nhost: x\r\n\r\n`);
  });
  client.destroy();
  return Buffer.concat(chunks).toString("latin1");
}

test("proxyHttp never sends more of a body than the content-length it forwarded, whatever the dev server sends", async () => {
  const body = "hello world!";
  const smuggled = "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nPWNED!";
  const hostile: Record<string, string> = {
    "cl-te":
      `HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: chunked\r\n\r\nc\r\n${body}\r\n0\r\n\r\n`,
    "te-cl":
      `HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-length: 5\r\n\r\nc\r\n${body}\r\n0\r\n\r\n`,
    "dup-cl": `HTTP/1.1 200 OK\r\ncontent-length: 5\r\ncontent-length: 12\r\n\r\n${body}`,
    "dup-cl-same": `HTTP/1.1 200 OK\r\ncontent-length: 5\r\ncontent-length: 5\r\n\r\n${body}`,
    "comma-cl": `HTTP/1.1 200 OK\r\ncontent-length: 5, 12\r\n\r\n${body}`,
    "te-identity":
      `HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: identity\r\n\r\n${body}`,
    "te-gzip-chunked":
      `HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: gzip, chunked\r\n\r\nc\r\n${body}\r\n0\r\n\r\n`,
    "connection-cl":
      `HTTP/1.1 200 OK\r\nconnection: content-length\r\ncontent-length: 5\r\n\r\n${body}`,
    "204-cl": "HTTP/1.1 204 No Content\r\ncontent-length: 5\r\n\r\nhello",
    "304-cl": "HTTP/1.1 304 Not Modified\r\ncontent-length: 5\r\n\r\nhello",
    "longer": `HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n${body}${smuggled}`,
    "longer-later": `HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello`,
  };
  const upstream = createNetServer((socket) => {
    socket.on("error", () => {});
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk;
      const path = /^GET \/(\S+)/.exec(head)?.[1];
      if (path === undefined || !head.includes("\r\n\r\n")) return;
      socket.write(hostile[path]);
      // The excess a moment later, in a read of its own.
      if (path === "longer-later") setTimeout(() => socket.end(` world!${smuggled}`), 50);
      else socket.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const devPort = (upstream.address() as { port: number }).port;
  const { server, port } = await front(() =>
    Promise.resolve(tcp({ host: "127.0.0.1", port: devPort, allowHalfOpen: true }))
  );
  try {
    const paths = Object.keys(hostile);
    const outs = await Promise.all(paths.map((path) => rawResponses(port, `/${path}`)));
    for (const [i, path] of paths.entries()) {
      const out = outs[i];
      assert(!out.includes("PWNED"), `${path}: ${JSON.stringify(out)}`);
      // At most one response, and never more body than its length.
      assertEquals(out.match(/HTTP\/1\.1 \d{3}/g)?.length ?? 0, out === "" ? 0 : 1, path);
      const [head, ...rest] = out.split("\r\n\r\n");
      const length = /\r\ncontent-length: *([^\r\n]*)/i.exec(head)?.[1];
      if (length !== undefined) {
        assertMatch(length, /^\d+$/, path);
        assert(rest.join("\r\n\r\n").length <= Number(length), `${path}: ${JSON.stringify(out)}`);
      }
    }
  } finally {
    await close(server);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("proxyHttp cuts a response whose body would run past the content-length a hook declared", async () => {
  const upstream = createServer((_req, res) => res.end("hello world!"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const devPort = (upstream.address() as { port: number }).port;
  const { server, port } = await front(
    () => Promise.resolve(tcp({ host: "127.0.0.1", port: devPort, allowHalfOpen: true })),
    { response: (headers) => ({ ...headers, "content-length": "5" }) },
  );
  try {
    const out = await rawResponses(port, "/x");
    const [head, ...rest] = out.split("\r\n\r\n");
    // Cut, the connection reset with it (what the client had not read of it may go too): nothing
    // past the declared length reaches the client.
    if (out !== "") assertMatch(head, /^HTTP\/1\.1 200/);
    assert(rest.join("\r\n\r\n").length <= 5, JSON.stringify(out));
    assert(!out.includes("world"), JSON.stringify(out));
  } finally {
    await close(server);
  }
  // A hook's length that is not one decimal number, in whatever case, is a 502, never sent.
  await Promise.all(["5, 12", "-1", "0x5", ["5", "5"]].map(async (length) => {
    const hooked = await front(
      () => Promise.resolve(tcp({ host: "127.0.0.1", port: devPort, allowHalfOpen: true })),
      { response: (headers) => ({ ...headers, "Content-Length": length }) },
    );
    try {
      assertMatch(
        await rawResponses(hooked.port, "/x", 5_000, headRead),
        /^HTTP\/1\.1 502 /,
        String(length),
      );
    } finally {
      await close(hooked.server);
    }
  }));
  await close(upstream);
});
