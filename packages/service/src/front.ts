// A node:net listener in front of a node:http server, for a server whose upgraded sockets are
// piped or paused. It was written for two Bun 1.4.2 bugs, both fixed in 1.4.3 (measured on 1.4.4,
// `tests/front_test.ts`): `pause()` on an upgraded socket Bun's node:http accepted itself did not
// stop reads, so a `pipe()` whose far end stopped reading buffered the near end's uploads without
// bound (5.4 GB in half a second), and `resetAndDestroy()` on such a socket did nothing. What it
// still gives a listener over Bun's own accepting: a first-request deadline of its own (Bun's is
// about 12 s and not configurable), TCP keepalive on every socket (a paused one never sees its
// client's FIN), and an upgraded socket closed by its client's FIN rather than left half-open
// (Bun 1.4.4 leaves its own half-open, as Node does). Bun's own accepting passes the rest of
// `front_test.ts` on 1.4.4, so keeping the front is a choice now, not a fix. A socket node:net
// accepted is handed to node:http with `emit("connection", socket)`, with keep-alive, pipelining,
// bodies and upgrades as before (docs/runtime.md, "Bun bugs").
//
// Bun's node:http does less for an emitted socket than for one it accepted, and what it leaves
// out is done here: a request body's backpressure (`pauseBody`: left out, it buffers without
// bound), `maxConnections` (past it a new connection is closed at once), the deadline for a
// connection's first request, `keepAliveTimeout` between requests, and `close()` closing idle
// connections and each busy one once its response is out. A response's `drain`, a request's
// `aborted` when its connection closes first, and pipelined requests are Bun's own on 1.4.4 (on
// 1.4.2 an emitted socket had none of them: `drain` came at once whatever the socket held, and a
// request that arrived before the previous response ended lost its connection). The server's
// `listen`, `address`, `close`, `closeIdleConnections`, `closeAllConnections`, `listening`, `ref`
// and `unref` act on the front, so callers use the server as they would without it.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** How long a new connection has to send its first request's headers: about Bun's own deadline
 * for the connections its node:http accepts (measured on 1.4.2 and 1.4.4: 12 s). */
export const FIRST_REQUEST_MS = 10_000;
/** How often deadlines are checked: Bun's own are as coarse. */
const SWEEP_MS = 1_000;
/** How long a connection is silent before TCP keepalive probes it. A client gone without a
 * reset is noticed once its kernel forgets the connection (a closed socket's FIN_WAIT_2) and the
 * next probe is answered with one: a minute or two after its kernel lets go (measured on macOS),
 * longer for an upload behind a zero window, whose probes keep the connection from going silent. */
export const TCP_KEEPALIVE_MS = 60_000;
/** Node's default `keepAliveTimeout`, used when the server has none set. */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

export interface FrontOptions {
  /** See FIRST_REQUEST_MS. */
  firstRequestMs?: number;
  /** How often deadlines are checked. Default 1 s. */
  sweepMs?: number;
  /** See TCP_KEEPALIVE_MS. */
  tcpKeepAliveMs?: number;
  /** Where an error of the front's is said once it is listening and the server has no `error`
   * listener of its own (an accept failing for want of descriptors, say), rather than thrown.
   * Default `console.error`. */
  log?: (error: Error) => void;
}

const fronts = new WeakMap<Server, NetServer>();

/** The node:net listener in front of `server`, for tests. */
export function frontOf(server: Server): NetServer | undefined {
  return fronts.get(server);
}

interface Held {
  /** Requests in flight on it. */
  active: number;
  /** Upgraded: the upgrade handler's from here, with no deadline. */
  upgraded: boolean;
  /** When it is closed unless a request arrives first; Infinity while one is in flight. */
  deadline: number;
}

/**
 * Puts a node:net listener in front of `server` (one not yet listening) and returns it, its
 * listening methods now the front's. It must have an `upgrade` listener of its own, as a fronted
 * server's upgrades are the point: with none, an upgrade's connection is destroyed.
 */
export function frontHttpServer<S extends Server>(server: S, opts: FrontOptions = {}): S {
  const firstRequestMs = opts.firstRequestMs ?? FIRST_REQUEST_MS;
  const sweepMs = opts.sweepMs ?? SWEEP_MS;
  const tcpKeepAliveMs = opts.tcpKeepAliveMs ?? TCP_KEEPALIVE_MS;
  const log = opts.log ?? ((error: Error) => console.error(`listener error: ${error}`));
  const held = new Map<Duplex, Held>();
  let closing = false;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  const idle = (h: Held) => h.active === 0 && !h.upgraded;
  const sweep = () => {
    const now = Date.now();
    for (const [socket, h] of held) {
      if (idle(h) && h.deadline <= now) socket.destroy();
    }
  };
  const forget = (socket: Duplex) => {
    held.delete(socket);
    if (held.size === 0 && sweeper !== undefined) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  };

  // Not half-open, as node:net's default: a client's FIN ends the socket. For a request, Bun's
  // node:http answers none followed by a FIN either way (measured on 1.4.2, accepted or emitted);
  // an upgraded socket is closed by it rather than left half-open, holding its place in
  // `maxConnections`, until its handler notices (Bun 1.4.4 leaves its own accepted ones half-open).
  const front: NetServer = createNetServer({ allowHalfOpen: false }, (socket: Socket) => {
    socket.on("error", () => socket.destroy());
    const most = server.maxConnections;
    if (closing || (most > 0 && held.size >= most)) {
      socket.destroy();
      return;
    }
    // As node:http sets its own: no Nagle delay on small responses, and keepalive (see
    // TCP_KEEPALIVE_MS).
    socket.setNoDelay(true);
    socket.setKeepAlive(true, tcpKeepAliveMs);
    held.set(socket, { active: 0, upgraded: false, deadline: Date.now() + firstRequestMs });
    socket.once("close", () => forget(socket));
    if (sweeper === undefined) {
      sweeper = setInterval(sweep, sweepMs);
      (sweeper as { unref?: () => void }).unref?.();
    }
    server.emit("connection", socket);
  });
  fronts.set(server, front);
  // Before it listens, as node:http's own: a listen that fails is the caller's to hear. After, an
  // error nobody listens for is said, never thrown: thrown, it would take the process down.
  front.on("error", (error) => {
    if (front.listening && server.listenerCount("error") === 0) log(error);
    else server.emit("error", error);
  });
  front.on("listening", () => server.emit("listening"));

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const socket = req.socket;
    const h = held.get(socket);
    if (h === undefined) return;
    h.active++;
    h.deadline = Infinity;
    pauseBody(req, socket);
    res.once("close", () => {
      h.active = Math.max(0, h.active - 1);
      if (!idle(h)) return;
      if (closing) {
        socket.end();
        return;
      }
      // Node's meaning: 0 is no timeout, and unset is its default.
      const keepAlive = server.keepAliveTimeout ?? KEEP_ALIVE_TIMEOUT_MS;
      h.deadline = keepAlive > 0 ? Date.now() + keepAlive : Infinity;
    });
  });
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    const h = held.get(socket);
    if (h !== undefined) {
      h.upgraded = true;
      h.deadline = Infinity;
    }
    if (server.listenerCount("upgrade") === 1) socket.destroy();
  });

  const closeIdle = () => {
    for (const [socket, h] of held) if (idle(h)) socket.destroy();
  };
  Object.defineProperty(server, "listening", {
    configurable: true,
    get: () => front.listening,
  });
  Object.assign(server, {
    listen: (...args: unknown[]) => {
      closing = false;
      (front.listen as (...a: unknown[]) => NetServer)(...args);
      return server;
    },
    address: () => front.address(),
    close: (callback?: (error?: Error) => void) => {
      closing = true;
      front.close(callback);
      closeIdle();
      return server;
    },
    closeIdleConnections: closeIdle,
    // As node:http's: an upgraded socket is no longer the server's.
    closeAllConnections: () => {
      for (const [socket, h] of held) if (!h.upgraded) socket.destroy();
    },
    ref: () => {
      front.ref();
      return server;
    },
    unref: () => {
      front.unref();
      return server;
    },
  });
  return server;
}

/**
 * Holds `req`'s body to its buffer, as Node's node:http does: the socket is paused once the body
 * has its high-water mark unread, and resumed when its reader asks for more. On an emitted socket
 * Bun's node:http pushes the body into `req` whatever `req.pause()` says (measured on 1.4.2: 2.5 GB
 * buffered in 250 ms behind a pipe that does not drain; on 1.4.4 still, 96 MiB in 30 ms), where
 * an accepted socket holds 512 KiB. Bun reads the rest of a body its handler left unread through
 * the same `_read`, so a keep-alive connection goes on.
 */
function pauseBody(req: IncomingMessage, socket: Duplex) {
  const push = req.push;
  const read = req._read;
  // Nothing more of a body is read until its reader asks, as Bun holds an accepted socket's: a
  // request waiting with its body paused holds its kernel's receive buffer, what came with its
  // headers, and the one read a paused socket still takes, a read being as large as that buffer
  // (128 KiB each where the pod caps it: some 384–512 KiB in all).
  if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"]) {
    socket.pause();
  }
  req.push = function (chunk: unknown, encoding?: BufferEncoding) {
    const more = push.call(this, chunk, encoding);
    // Its end: the connection's next request is read whether or not anyone reads this one's.
    if (chunk === null) socket.resume();
    else if (this.readableLength >= this.readableHighWaterMark) socket.pause();
    return more;
  };
  req._read = function (size: number) {
    socket.resume();
    return read.call(this, size);
  };
}
