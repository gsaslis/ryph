// A fetch handler on a node:http listener: what `Deno.serve` was to every service here.
//
// Every service is written as `(req: Request) => Response`, and the drain, the stream tracker and
// the routers all assume web-standard requests and responses. node:http speaks IncomingMessage and
// ServerResponse instead, so this is the one place the two meet. It runs under Bun and under Node
// alike: nothing here is a `Bun.*` API.
//
// What it keeps from `Deno.serve`, because callers lean on each of these:
// - bodies STREAM both ways. A runner's NDJSON uplink is a request body open for a whole run, and
//   an SSE tail is a response that never ends; buffering either would hang it. Writes honour
//   backpressure, so a slow reader holds back its producer rather than growing a buffer.
// - `req.signal` aborts when the client goes away, and also once the response is done, the way
//   Deno's did (its "legacy abort"): cleanup hung off the signal runs either way.
// - a body cut short reaches the handler as an ERROR, never as an end: a truncated upload must not
//   read as a whole one. Likewise a response body that errors mid-stream resets the connection,
//   so the client's read fails instead of seeing a clean end.
// - `onError` answers a throwing handler (default: log it, 500), and hears a body that errored
//   after its headers went out.
// - `shutdown()` stops accepting, lets in-flight requests finish, and closes idle keep-alive
//   connections so they do not hold it open; upgraded WebSockets do not hold it either. `finished`
//   settles once the listener is closed and every connection with it.
// - `info.remoteAddr`, and `info.upgradeWebSocket` in place of `Deno.upgradeWebSocket`.
//
// What differs: binding is ASYNC. `Deno.serve` bound before returning and threw a bind failure
// synchronously; node:http reports one as an event. So `serve()` resolves once listening and
// rejects with the bind error (`err.code`: EADDRINUSE, EADDRNOTAVAIL, EACCES), and a caller
// awaits it. Deno also compressed eligible responses on its own; this does not.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { bindError } from "./listen.ts";
import { realWs, type WsSocket } from "./ws.ts";

/** Where a listener is bound, or where a request came from. */
export interface NetAddr {
  transport: "tcp";
  hostname: string;
  port: number;
}

export interface UpgradeWebSocketOptions {
  /** The subprotocol to answer with, when the client offered it. */
  protocol?: string;
  /**
   * Seconds between pings; a socket that has not answered the previous one by the next is closed.
   * Default 120, `Deno.upgradeWebSocket`'s; 0 turns it off.
   */
  idleTimeout?: number;
  /**
   * The largest message accepted, in bytes; a bigger one closes the socket (1009) as its header
   * arrives, before its payload is buffered. Default 64 MiB, `Deno.upgradeWebSocket`'s.
   */
  maxPayload?: number;
  /**
   * The most frames one message may arrive in; a message in more closes the socket (1008, and an
   * `error`) as the one past it arrives. Default 16384, `ws`'s own. 1 refuses a fragmented message
   * at its second frame (its first fragment, up to `maxPayload`, is held until then): each
   * continuation frame costs parsing and the message's earlier ones are held until it ends, so a
   * peer that never fragments (a preview tunnel) is held to whole messages.
   */
  maxFragments?: number;
  /**
   * A ping from the peer terminates the socket instead of being answered, as does a pong when
   * this end sends no pings (`idleTimeout: 0`). For a peer with a heartbeat of its own (a preview
   * tunnel): `ws` queues a pong per ping with no regard for its backlog, so a peer that pings and
   * never reads would grow it without bound. Default false.
   */
  refusePings?: boolean;
}

export interface ServeHandlerInfo {
  /** The peer of this connection: the client, or the proxy in front of it. */
  remoteAddr: NetAddr;
  /**
   * Accepts a WebSocket upgrade, in place of `Deno.upgradeWebSocket`: return `response` from the
   * handler and the handshake completes with it; `socket` opens after that. Throws on a request
   * that is not a WebSocket upgrade.
   */
  upgradeWebSocket(
    req: Request,
    opts?: UpgradeWebSocketOptions,
  ): { socket: WebSocket; response: Response };
}

export type ServeHandler = (req: Request, info: ServeHandlerInfo) => Response | Promise<Response>;

export interface ServeOptions {
  /** Default 8000, as `Deno.serve`. 0 picks a free port; `addr.port` says which. */
  port?: number;
  /** Default "0.0.0.0", as `Deno.serve` (node's own default would be dual-stack `::`). */
  hostname?: string;
  /** Shuts the listener down when aborted. */
  signal?: AbortSignal;
  /** Called once listening. Default prints `Deno.serve`'s banner to stderr; pass `() => {}` to silence it. */
  onListen?: (addr: NetAddr) => void;
  /**
   * Answers a handler that threw, and hears a response body that errored after its headers went
   * out (its answer then goes nowhere). Default logs it and answers 500.
   */
  onError?: (err: unknown) => Response | Promise<Response>;
  /**
   * How long an idle keep-alive connection is kept. Default 620 s: a Google Cloud load balancer
   * reuses an idle backend connection for up to 600 s, and one this end closed first is an empty
   * 502/503 nobody logged. node's own default is 5 s.
   */
  keepAliveTimeoutMs?: number;
  /**
   * How long a request's headers may take to arrive. Default 630 s, just past the keep-alive.
   * Bun's node:http ignores it and applies its own limit (about 10 s, measured); Node honours it.
   */
  headersTimeoutMs?: number;
}

export interface HttpServer {
  /** Where it listens: the real port when asked for port 0. */
  readonly addr: NetAddr;
  /** Settles once the listener has closed and every connection with it, upgraded ones included. */
  readonly finished: Promise<void>;
  /**
   * Stops accepting and resolves once in-flight requests have finished; idle keep-alive
   * connections are closed, not waited on. Upgraded WebSockets are the caller's to close, and
   * not waited on either.
   */
  shutdown(): Promise<void>;
  /** Keeps the process up while listening (the default). */
  ref(): void;
  /** Lets the process exit while this still listens. */
  unref(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/** How long an idle keep-alive connection is kept, past a Google Cloud load balancer's 600 s
 * reuse of an idle backend connection (`keepAliveTimeoutMs`). For any node:http listener behind
 * one, not only `serve`'s. */
export const DEFAULT_KEEP_ALIVE_MS = 620_000;
/** Just past it (`headersTimeoutMs`); Bun ignores it. */
export const DEFAULT_HEADERS_MS = 630_000;
const DEFAULT_IDLE_TIMEOUT_S = 120;
const DEFAULT_MAX_PAYLOAD = 64 * 1024 * 1024;

function defaultOnError(err: unknown): Response {
  console.error(err);
  return new Response("Internal Server Error", { status: 500 });
}

function defaultOnListen(addr: NetAddr): void {
  const local = addr.hostname === "0.0.0.0" || addr.hostname === "::"
    ? ` (http://localhost:${addr.port}/)`
    : "";
  console.error(`Listening on ${urlOf(addr)}${local}`);
}

const urlOf = (addr: NetAddr): string =>
  `http://${addr.hostname.includes(":") ? `[${addr.hostname}]` : addr.hostname}:${addr.port}/`;

function remoteOf(socket: Socket | Duplex): NetAddr {
  const s = socket as Socket;
  return { transport: "tcp", hostname: s.remoteAddress ?? "", port: s.remotePort ?? 0 };
}

/** The request's headers as sent, repeats included (`rawHeaders` keeps each one). */
function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  return headers;
}

/**
 * The request's URL, built the way `Deno.serve` built it: from the Host header, falling back to
 * the listener's own address. Throws on one that does not parse, which is answered 400.
 */
function urlFor(req: IncomingMessage, addr: NetAddr): URL {
  const host = req.headers.host ?? urlOf(addr).slice("http://".length, -1);
  const base = new URL(`http://${host}`);
  if (
    base.pathname !== "/" || base.search !== "" || base.hash !== "" || base.username !== "" ||
    base.password !== ""
  ) {
    throw new TypeError("invalid Host header");
  }
  let target = req.url ?? "/";
  // An absolute-form target (one meant for a proxy) counts for its path only: the Host header
  // names the origin, as it does for every other request.
  if (!target.startsWith("/")) {
    const absolute = new URL(target);
    target = absolute.pathname + absolute.search;
  }
  // Concatenated, never resolved: `//elsewhere/x` is a path here, not another origin.
  return new URL(base.origin + target);
}

/**
 * Headers that describe one connection, not the response: node frames the body and manages the
 * connection itself, so a handler's (often an upstream's, relayed whole by a proxy) never go out.
 * A `transfer-encoding: chunked` beside node's own Content-Length would have the client and any
 * proxy in between frame the body differently.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** The response's headers for node, every Set-Cookie its own header line, hop-by-hop ones dropped. */
function nodeHeaders(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of headers) {
    if (name === "set-cookie" || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) out["set-cookie"] = cookies;
  return out;
}

/** Whether the handler asked for the connection to close after this response. */
const asksClose = (headers: Headers): boolean =>
  (headers.get("connection") ?? "").split(",").some((t) => t.trim().toLowerCase() === "close");

/**
 * The Content-Type a body without one goes out with. A string body carries
 * `text/plain;charset=UTF-8` by the fetch spec, which `Deno.serve` sent; Bun's `Response` leaves
 * it off, and a browser sniffs an untyped body, HTML included. Bun cannot tell a string body
 * from bytes, so every untyped body gets it: never rendered as a page.
 */
const DEFAULT_CONTENT_TYPE = "text/plain;charset=UTF-8";

/** The handler's Content-Length, when it is one well-formed number. */
function declaredLength(headers: Record<string, string | string[]>): number | null {
  const value = headers["content-length"];
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

/** How much of a body is held back to learn whether it is whole; past it, it streams. */
const BUFFER_CAP = 1024 * 1024;

/** Waits for `drain` or for the response to go away, whichever is first. */
const drained = (res: ServerResponse): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });

/**
 * Writes `response` to `res`, streaming its body with backpressure. A body that is already whole
 * by the next turn of the event loop goes out with a Content-Length, its real one whatever the
 * handler said, as `Deno.serve`'s did; anything still coming is sent chunked, its headers at once,
 * so an SSE tail's go out before its first event. A streamed body is held to a Content-Length the
 * handler declared, as `Deno.serve` held it: one byte past it, or an end short of it, cuts the
 * connection rather than sending a body that frames differently from its header.
 *
 * The body is cancelled on every path that does not read it to its end, the client having left
 * before the handler answered included: a source nobody cancels (a git process, an open file, a
 * tail's subscription) would otherwise stay forever, one per request a client walks away from.
 */
async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  onBodyError: (err: unknown) => void,
): Promise<void> {
  const headers = nodeHeaders(response.headers);
  if (asksClose(response.headers)) res.shouldKeepAlive = false;
  const body = response.body;
  const bodyless = body === null || req.method === "HEAD" || NO_BODY_STATUS.has(response.status);
  if (bodyless) {
    // A HEAD answer keeps the Content-Length its GET would have, when the handler set one.
    // Anything else sends no bytes, so it says so: a relayed upstream null-body response keeps
    // its Content-Length, and the client would read the next response as this one's body.
    // 204, 1xx and 101 carry none; 304 may keep its 200's, as HEAD does.
    if (req.method !== "HEAD" && response.status !== 304) {
      delete headers["content-length"];
      if (!NO_BODY_STATUS.has(response.status) && response.status >= 200) {
        headers["content-length"] = "0";
      }
    }
    if (body !== null) await body.cancel().catch(() => {});
    if (res.destroyed) return;
    res.writeHead(response.status, response.statusText || undefined, headers);
    res.end();
    return;
  }
  // The client may have left while the handler worked; `close` has fired already then.
  if (res.destroyed || req.socket.destroyed) {
    await body.cancel().catch(() => {});
    return;
  }
  if (headers["content-type"] === undefined) headers["content-type"] = DEFAULT_CONTENT_TYPE;
  const reader = body.getReader();
  let complete = false;
  // Client gone: stop pulling, which runs the source's own cancel (a tail's unsubscribe).
  const gone = () => void reader.cancel().catch(() => {});
  res.once("close", gone);
  const turn = Symbol("turn");
  const nextTurn = () => new Promise<typeof turn>((r) => setImmediate(() => r(turn)));
  try {
    // Whatever the body has ready within this turn of the event loop: all of an in-memory one,
    // nothing of a tail that has not produced yet. Capped, so a fast producer is not buffered.
    const ready: Uint8Array[] = [];
    let readyBytes = 0;
    let next: Promise<ReadableStreamReadResult<Uint8Array>> | null = reader.read();
    while (readyBytes < BUFFER_CAP) {
      const chunk = await Promise.race([next!, nextTurn()]);
      if (chunk === turn) break;
      if (chunk.done) {
        complete = true;
        next = null;
        break;
      }
      ready.push(chunk.value);
      readyBytes += chunk.value.byteLength;
      next = reader.read();
    }
    if (res.destroyed) return;
    if (complete) {
      // Whole: sent with its real length, as `Deno.serve` sent an in-memory body.
      res.writeHead(response.status, response.statusText || undefined, {
        ...headers,
        "content-length": String(readyBytes),
      });
      res.end(Buffer.concat(ready));
      return;
    }
    const declared = declaredLength(headers);
    if (declared === null) delete headers["content-length"];
    res.writeHead(response.status, response.statusText || undefined, headers);
    // Headers out now, whatever comes next: an SSE client waits on them.
    res.flushHeaders();
    let sent = 0;
    const write = async (chunk: Uint8Array): Promise<boolean> => {
      sent += chunk.byteLength;
      if (declared !== null && sent > declared) return false;
      if (!res.write(chunk)) await drained(res);
      return true;
    };
    for (const chunk of ready) {
      if (!(await write(chunk))) {
        throw new Error(`the body ran past its Content-Length ${declared}`);
      }
    }
    for (let chunk = await next!; !chunk.done; chunk = await reader.read()) {
      if (res.destroyed) return;
      if (!(await write(chunk.value))) {
        throw new Error(`the body ran past its Content-Length ${declared}`);
      }
    }
    complete = true;
    if (declared !== null && sent < declared) {
      throw new Error(`the body ended at ${sent} of its Content-Length ${declared}`);
    }
    res.end();
  } catch (err) {
    onBodyError(err);
    if (res.destroyed) return;
    // Before the headers, a status can still say so; after them only a reset can, so the client
    // reads an error rather than a clean end.
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    res.off("close", gone);
    if (!complete) await reader.cancel().catch(() => {});
  }
}

/** How much of a request body is read ahead of the handler before the socket is paused. */
const BODY_HIGH_WATER = 64 * 1024;

/**
 * A request body as a web stream: read as the handler reads, paused when it falls behind, and
 * ERRORED when the client goes before sending all of it, so a cut-short body never reads as a
 * whole one. Written out rather than `Readable.toWeb`, so the pause, the cut and a cancel that
 * lets the rest drain away behave the same under Bun and Node rather than per runtime's adapter.
 */
function bodyOf(req: IncomingMessage): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      });
      req.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      const cut = (err?: Error) => {
        if (settled) return;
        settled = true;
        controller.error(err ?? new Error("the request body was cut short"));
      };
      req.once("error", cut);
      req.once("close", () => {
        if (!req.complete) cut();
      });
    },
    pull() {
      req.resume();
    },
    cancel() {
      // Nobody will read the rest: let it flow and fall away, so the answer can still go out on
      // this connection.
      settled = true;
      req.resume();
    },
  }, { highWaterMark: BODY_HIGH_WATER, size: (chunk) => chunk?.byteLength ?? 0 });
}

/** A fetch Request for a node request; the body streams, and errors if cut short. */
function toRequest(
  req: IncomingMessage,
  url: URL,
  signal: AbortSignal,
  withBody: boolean,
): Request {
  const method = req.method ?? "GET";
  const body = withBody && method !== "GET" && method !== "HEAD" ? bodyOf(req) : undefined;
  return new Request(url.href, {
    method,
    headers: headersOf(req),
    body,
    signal,
    // Required by the constructor for a stream body.
    duplex: "half",
  } as RequestInit);
}

/**
 * A response written straight to a socket that never became an HTTP response: an upgrade refused.
 * Streamed with backpressure and cancelled when the client goes, like any other body: a handler
 * may answer a handshake with its SSE tail. Close-delimited, so no length has to be known.
 */
async function writeRaw(socket: Duplex, response: Response): Promise<void> {
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || "Refused"}`];
  const headers = nodeHeaders(response.headers);
  delete headers["content-length"];
  const body = NO_BODY_STATUS.has(response.status) ? null : response.body;
  if (body !== null && headers["content-type"] === undefined) {
    headers["content-type"] = DEFAULT_CONTENT_TYPE;
  }
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  lines.push("connection: close", "", "");
  if (socket.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  if (body === null) {
    await response.body?.cancel().catch(() => {});
    socket.end(lines.join("\r\n"));
    return;
  }
  const reader = body.getReader();
  let complete = false;
  const gone = () => void reader.cancel().catch(() => {});
  socket.once("close", gone);
  const drainedOrGone = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        resolve();
      };
      socket.on("drain", done);
      socket.on("close", done);
    });
  try {
    if (!socket.write(lines.join("\r\n"))) await drainedOrGone();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (socket.destroyed) return;
      if (!socket.write(chunk.value)) await drainedOrGone();
    }
    complete = true;
    socket.end();
  } catch {
    // A body that failed: the client reads a cut connection, not a clean end.
    socket.destroy();
  } finally {
    socket.off("close", gone);
    if (!complete) await reader.cancel().catch(() => {});
  }
}

// ---- WebSocket ------------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type Listener = ((ev: Event) => void) | null;

/**
 * The server end of an upgraded socket, shaped like the browser `WebSocket` a Deno handler was
 * handed: CONNECTING until the handshake is written, then the events and `send`/`close` of the
 * standard interface, over a `ws` socket underneath.
 */
class ServerWebSocket extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  binaryType: BinaryType = "blob";
  readonly url: string;
  #ws: WsSocket | null = null;
  #state = CONNECTING;
  #handlers: Record<"open" | "message" | "close" | "error", Listener> = {
    open: null,
    message: null,
    close: null,
    error: null,
  };

  constructor(url: string) {
    super();
    this.url = url;
  }

  get readyState(): number {
    return this.#state;
  }
  get bufferedAmount(): number {
    return this.#ws?.bufferedAmount ?? 0;
  }
  get protocol(): string {
    return this.#ws?.protocol ?? "";
  }
  get extensions(): string {
    return this.#ws?.extensions ?? "";
  }

  get onopen(): Listener {
    return this.#handlers.open;
  }
  set onopen(fn: Listener) {
    this.#handlers.open = fn;
  }
  get onmessage(): Listener {
    return this.#handlers.message;
  }
  set onmessage(fn: Listener) {
    this.#handlers.message = fn;
  }
  get onclose(): Listener {
    return this.#handlers.close;
  }
  set onclose(fn: Listener) {
    this.#handlers.close = fn;
  }
  get onerror(): Listener {
    return this.#handlers.error;
  }
  set onerror(fn: Listener) {
    this.#handlers.error = fn;
  }

  #emit(type: "open" | "message" | "close" | "error", ev: Event): void {
    this.#handlers[type]?.call(this, ev);
    this.dispatchEvent(ev);
  }

  /** Takes over the handshake's `ws` socket. Internal to `serve`. A socket its handler closed
   * before the handshake finished stays closed: the `ws` socket goes at once. */
  attach(ws: WsSocket): void {
    if (this.#state !== CONNECTING) {
      ws.terminate();
      this.abandon();
      return;
    }
    this.#ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer, binary: boolean) => {
      let payload: string | ArrayBuffer | Blob;
      if (!binary) payload = data.toString("utf8");
      else {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        payload = this.binaryType === "blob" ? new Blob([copy]) : copy.buffer;
      }
      this.#emit("message", new MessageEvent("message", { data: payload }));
    });
    ws.on("error", (err: Error) => {
      this.#emit("error", Object.assign(new Event("error"), { error: err, message: err.message }));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.#state = CLOSED;
      this.#emit("close", closeEvent(code, reason.toString("utf8")));
    });
    this.#state = OPEN;
    this.#emit("open", new Event("open"));
  }

  /** The handshake never completed, or its handler closed the socket first. Internal to
   * `serve`. Closed by its handler, it says only that it closed: nothing failed. */
  abandon(): void {
    if (this.#state === CLOSED) return;
    const closedByHandler = this.#state === CLOSING;
    this.#state = CLOSED;
    if (!closedByHandler) this.#emit("error", new Event("error"));
    this.#emit("close", closeEvent(1006, ""));
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.#state === CONNECTING || this.#ws === null) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    // Sent after close: dropped, as a browser WebSocket drops it.
    if (this.#state !== OPEN) return;
    const ws = this.#ws;
    if (typeof data === "string") ws.send(data);
    else if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => ws.readyState === OPEN && ws.send(new Uint8Array(buf)));
    } else if (ArrayBuffer.isView(data)) {
      ws.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { binary: true });
    } else ws.send(new Uint8Array(data), { binary: true });
  }

  /** Destroys the socket at once, whatever it has queued (`ws`'s own `terminate`). Not part of
   * the WebSocket standard: a caller that knows it is talking to this one may use it. */
  terminate(): void {
    if (this.#state === CLOSED) return;
    // Before the handshake (no `ws` yet): CLOSING until `serve` refuses it (`abandon`).
    this.#state = CLOSING;
    this.#ws?.terminate();
  }

  close(code?: number, reason?: string): void {
    if (this.#state === CLOSING || this.#state === CLOSED) return;
    this.#state = CLOSING;
    // Before the handshake: `serve` refuses it instead, and says it closed (`abandon`).
    if (this.#ws === null) return;
    this.#ws.close(code, reason);
  }
}

function closeEvent(code: number, reason: string): Event {
  const Ctor = (globalThis as { CloseEvent?: typeof CloseEvent }).CloseEvent;
  if (Ctor) return new Ctor("close", { code, reason, wasClean: code !== 1006 });
  return Object.assign(new Event("close"), { code, reason, wasClean: code !== 1006 });
}

interface PendingUpgrade {
  socket: ServerWebSocket;
  opts: UpgradeWebSocketOptions;
}

/** Pings every `seconds`; a socket that has not answered the previous ping is cut. */
function keepPinging(ws: WsSocket, seconds: number): void {
  if (seconds <= 0) return;
  let answered = true;
  ws.on("pong", () => (answered = true));
  const timer = setInterval(() => {
    if (!answered) {
      ws.terminate();
      return;
    }
    answered = false;
    try {
      ws.ping();
    } catch {
      // Closing already.
    }
  }, seconds * 1000);
  timer.unref();
  ws.on("close", () => clearInterval(timer));
}

/** A WebSocket handshake: `Upgrade: websocket` with its key. Nothing else is upgraded. */
function isWebSocketHandshake(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade;
  return typeof upgrade === "string" && upgrade.trim().toLowerCase() === "websocket" &&
    typeof req.headers["sec-websocket-key"] === "string";
}

// ---- serve ----------------------------------------------------------------------------------

/**
 * Serves `handler` on a node:http listener, resolving once it listens. Rejects with the bind
 * error, its `code` the real reason (`bindError`: Bun's node:http calls every failure
 * EADDRINUSE), instead of throwing synchronously as `Deno.serve` did.
 */
export function serve(opts: ServeOptions, handler: ServeHandler): Promise<HttpServer> {
  const onError = opts.onError ?? defaultOnError;
  const onListen = opts.onListen ?? defaultOnListen;
  const hostname = opts.hostname ?? "0.0.0.0";
  let addr: NetAddr = { transport: "tcp", hostname, port: opts.port ?? 8000 };
  let closing = false;
  const finished = Promise.withResolvers<void>();

  const notUpgrade = (): never => {
    throw new TypeError("Invalid Header: 'upgrade' header must contain 'websocket'");
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const abort = new AbortController();
    const socket = req.socket;
    busy.set(socket, (busy.get(socket) ?? 0) + 1);
    // Client gone, or the response done: either way the request is over (Deno's legacy abort).
    res.once("close", () => {
      abort.abort();
      busy.set(socket, (busy.get(socket) ?? 1) - 1);
      // Its connection kept alive past a shutdown that began while it was busy: closed now, or
      // `server.close()` waits on it (Bun 1.4.4, as Node; 1.4.2 did not wait), and a response
      // whose headers went out before the shutdown keeps its connection whatever
      // `shouldKeepAlive` says after them (measured on 1.4.2 and 1.4.4).
      if (closing) setImmediate(closeQuiet);
    });
    // Once shutting down, every response closes its connection, so none sits idle after.
    if (closing) res.shouldKeepAlive = false;
    let request: Request;
    try {
      request = toRequest(req, urlFor(req, addr), abort.signal, true);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const info: ServeHandlerInfo = {
      remoteAddr: remoteOf(req.socket),
      upgradeWebSocket: notUpgrade,
    };
    const reportBodyError = (err: unknown) => {
      Promise.resolve().then(() => onError(err)).catch(() => {});
    };
    (async () => {
      let response: Response;
      try {
        response = await handler(request, info);
      } catch (err) {
        try {
          response = await onError(err);
        } catch (inner) {
          console.error(inner);
          response = new Response("Internal Server Error", { status: 500 });
        }
      }
      if (closing) res.shouldKeepAlive = false;
      await respond(req, res, response, reportBodyError);
    })().catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgraded(socket);
    socket.on("error", () => socket.destroy());
    const abort = new AbortController();
    socket.once("close", () => abort.abort());
    // A client that hangs up before its handshake is answered is gone: closed here, as `ws` closes
    // it once it has the socket. Bun 1.4.4 leaves an upgraded socket half-open on its client's FIN,
    // as Node does, where 1.4.2 closed it; left so, the handler's signal never aborts.
    const hungUp = () => socket.destroy();
    socket.once("end", hungUp);
    let request: Request;
    try {
      request = toRequest(req, urlFor(req, addr), abort.signal, false);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    const pending = new WeakMap<Response, PendingUpgrade>();
    // Every socket the handler made, so those it did not answer with still end CLOSED.
    const made: ServerWebSocket[] = [];
    const info: ServeHandlerInfo = {
      remoteAddr: remoteOf(socket),
      upgradeWebSocket(upgraded, upgradeOpts = {}) {
        if (upgraded !== request) {
          throw new TypeError("upgradeWebSocket: not the request this handler was given");
        }
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") notUpgrade();
        const ws = new ServerWebSocket(request.url.replace(/^http/, "ws"));
        made.push(ws);
        const response = new Response(null, { status: 200 });
        pending.set(response, { socket: ws, opts: upgradeOpts });
        return { socket: ws as unknown as WebSocket, response };
      },
    };
    (async () => {
      let response: Response;
      try {
        response = await handler(request, info);
      } catch (err) {
        response = await Promise.resolve(onError(err)).catch(() =>
          new Response("Internal Server Error", { status: 500 })
        );
      }
      const upgrade = pending.get(response);
      // A socket the handler made but did not answer with (it threw, or answered otherwise) never
      // opens: it ends CLOSED, not stuck where the handler left it.
      for (const one of made) if (one !== upgrade?.socket) one.abandon();
      if (upgrade === undefined) return writeRaw(socket, response);
      // Closed by its handler before the handshake: refused, never opened.
      if (closing || socket.destroyed || upgrade.socket.readyState !== CONNECTING) {
        upgrade.socket.abandon();
        socket.destroy();
        return;
      }
      const { protocol, idleTimeout = DEFAULT_IDLE_TIMEOUT_S } = upgrade.opts;
      // The limit is ws's own option, read per frame header; set for this socket's handshake.
      const maxPayload = upgrade.opts.maxPayload ?? DEFAULT_MAX_PAYLOAD;
      const refusePings = upgrade.opts.refusePings === true;
      const server = new (realWs().WebSocketServer)({
        noServer: true,
        maxPayload,
        ...(upgrade.opts.maxFragments === undefined
          ? {}
          : { maxFragments: upgrade.opts.maxFragments }),
        autoPong: !refusePings,
        handleProtocols: (offered: Set<string>) =>
          protocol !== undefined && offered.has(protocol) ? protocol : false,
      });
      // ws refuses a handshake it finds bad (its key, its version) by destroying the socket, and
      // never calls back: the socket would stay CONNECTING, and whatever its handler keeps for it
      // with it.
      socket.once("close", () => {
        if (upgrade.socket.readyState === CONNECTING) upgrade.socket.abandon();
      });
      socket.off("end", hungUp);
      server.handleUpgrade(req, socket, head, (ws: WsSocket) => {
        keepPinging(ws, idleTimeout);
        if (refusePings) {
          ws.on("ping", () => ws.terminate());
          if (idleTimeout <= 0) ws.on("pong", () => ws.terminate());
        }
        upgrade.socket.attach(ws);
      });
    })().catch((err) => {
      console.error(err);
      socket.destroy();
    });
  };

  const server: Server = createServer(
    {
      requestTimeout: 0,
      // Only a WebSocket handshake leaves HTTP: node would hand every request with an Upgrade
      // header to `upgrade`, an `Upgrade: h2c` POST (curl --http2, Java's HttpClient) included,
      // its body dropped. Anything else is an ordinary request, served as one.
      shouldUpgradeCallback: isWebSocketHandshake,
    } as Parameters<typeof createServer>[0],
    onRequest,
  );
  server.keepAliveTimeout = opts.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_MS;
  server.headersTimeout = opts.headersTimeoutMs ?? DEFAULT_HEADERS_MS;
  // A request body may stream for a whole run (a runner's uplink): no overall request deadline.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_err: Error, socket: Duplex) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });
  server.on("close", () => finished.resolve());

  // Every connection not upgraded, which is what `shutdown()` waits on. `server.close()` waits on
  // upgraded ones too in Bun 1.4.4, as in Node (1.4.2 did not), and a WebSocket is its caller's
  // to close: one left open would hold the shutdown to the drain's deadline.
  const plain = new Set<Duplex>();
  // Requests in flight per connection. A keep-alive connection partway through its next
  // request's headers is not idle to `closeIdleConnections()` (Bun 1.4.4), so a client trickling
  // them would hold the shutdown to `headersTimeout`; one with no request in flight is cut here.
  const busy = new WeakMap<Duplex, number>();
  function closeQuiet() {
    server.closeIdleConnections();
    for (const socket of plain) {
      if (!busy.get(socket) && socket.writableLength === 0) socket.destroy();
    }
  }
  let stopped: (() => void) | null = null;
  const settle = () => {
    if (stopped !== null && plain.size === 0) stopped();
  };
  server.on("connection", (socket: Duplex) => {
    plain.add(socket);
    socket.once("close", () => {
      plain.delete(socket);
      settle();
    });
  });
  function upgraded(socket: Duplex) {
    plain.delete(socket);
    settle();
  }

  let shutdown: Promise<void> | null = null;
  const stop = (): Promise<void> =>
    shutdown ??= new Promise<void>((resolve) => {
      closing = true;
      stopped = resolve;
      // Stops accepting; `finished` settles once every connection, upgraded ones included, is
      // gone.
      server.close();
      // Idle keep-alives would hold the close until their own timeout; busy ones close once
      // their response is out (`shouldKeepAlive` and the `close` watch in `onRequest`).
      closeQuiet();
      settle();
    });

  return new Promise<HttpServer>((resolve, reject) => {
    const port = opts.port ?? 8000;
    const failed = (err: Error) => {
      server.off("listening", listening);
      void bindError(err, hostname, port).then(reject);
    };
    const listening = () => {
      server.off("error", failed);
      const bound = server.address();
      if (bound !== null && typeof bound === "object") {
        addr = { transport: "tcp", hostname: bound.address, port: bound.port };
      }
      if (opts.signal) {
        if (opts.signal.aborted) void stop();
        else opts.signal.addEventListener("abort", () => void stop(), { once: true });
      }
      try {
        onListen(addr);
      } catch (err) {
        console.error(err);
      }
      resolve({
        get addr() {
          return addr;
        },
        finished: finished.promise,
        shutdown: stop,
        ref: () => void server.ref(),
        unref: () => void server.unref(),
        [Symbol.asyncDispose]: stop,
      });
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, hostname);
  });
}
