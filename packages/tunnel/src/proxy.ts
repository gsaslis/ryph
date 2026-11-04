// One browser request or upgrade, proxied over one tunnel stream to the dev server. Both preview
// hosts use it: the local binary (packages/host) and the hosted service (packages/previews). The
// caller decides whether a request may pass at all; this decides only how it travels, and is
// hardened against a dev server the agent controls.
import {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { promote, serves } from "./budget.ts";

/** A fresh stream to the dev server; rejects when the tunnel is down or full, or once `signal`
 * aborts while it waits for one (the browser left). */
export type Connect = (signal: AbortSignal) => Promise<Duplex>;

/** Where a caller rewrites what crosses the proxy. Each gets a copy it may change and return. */
export interface ProxyHooks {
  /** Headers on their way to the dev server: the end-to-end ones of a request, or every header
   * of an upgrade (its own `connection` and `upgrade` included). Framing is set after this. */
  request?: (headers: IncomingHttpHeaders, req: IncomingMessage) => IncomingHttpHeaders;
  /** Headers on their way back: a response's end-to-end ones, or those of an upgrade's 101. */
  response?: (headers: IncomingHttpHeaders, status: number) => IncomingHttpHeaders;
  /** Answers a plain request no stream could be had for, in place of a bare 503: a page that
   * says so to a person, say. */
  unavailable?: (res: ServerResponse) => void;
  /** Where a small body read while the request waits is counted (`EarlyBodies.for`). Without
   * it, any body up to EARLY_BODY is read. */
  early?: EarlyBody;
}

// Hop-by-hop: they describe one connection, not the request. Forwarding the browser's
// `connection: keep-alive` would keep each single-use stream open until the dev server's own
// idle timeout, and a page loading many modules would exhaust the stream cap and get 503s.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Whether a request or response with these headers is an event stream (what EventSource asks
 * for, and what an SSE endpoint answers). */
export function eventStream(header: string | string[] | undefined): boolean {
  return /\btext\/event-stream\b/i.test([header ?? ""].flat().join(","));
}

/**
 * Whether a plain request may never end, as its headers say: one asking for an event stream. Its
 * stream counts as long-lived from the start (the budget's `long`). An event stream fetched
 * without saying so is promoted once its response says it is one (`proxyHttp`); a long poll or a
 * streamed fetch cannot be told from a short request, and counts as one. An `Upgrade` header on a
 * plain request (h2c, say) changes nothing: it is never upgraded, and the hop to another pod drops
 * it, so both pods count it alike. An upgrade is long-lived by its caller's word.
 */
export function lasting(headers: IncomingHttpHeaders): boolean {
  return eventStream(headers.accept);
}

/** The headers that describe the request rather than the connection it came on. */
export function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  // Headers a `Connection` header names are hop-by-hop as well (RFC 9110 §7.6.1).
  const named = new Set(
    String(headers.connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  return Object.fromEntries(
    Object.entries(withoutHopByHop(headers)).filter(([name]) => !named.has(name)),
  );
}

/** The headers without those that are always hop-by-hop, but keeping any a `Connection` header
 * names: for a hop between two of our own servers, where the next one must judge exactly the
 * headers this one was sent. */
export function withoutHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));
}

// What a hook returns is sent as written, and not every node:http checks names or values (Deno's
// checked neither): a CR or LF in either would end the header early and let the rest be read as
// headers of its own.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNSAFE = /[\r\n\0]/;

/** A hook's headers, checked before they reach a wire. Throws on a name that is not a token or a
 * value that is not a string, number or list of them, or that holds CR, LF or NUL: the request
 * then fails (502) rather than going out with the header silently dropped, so a hook that
 * produces one is a visible bug. */
export function sendable(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers) as [string, unknown][]) {
    if (value === undefined) continue;
    if (!TOKEN.test(name)) throw new Error("invalid header name");
    const values = (Array.isArray(value) ? value : [value]).map((one) => {
      if (typeof one !== "string" && typeof one !== "number") throw new Error("invalid header");
      const text = String(one);
      if (UNSAFE.test(text)) throw new Error("invalid header value");
      return text;
    });
    out[name] = Array.isArray(value) ? values : values[0];
  }
  return out;
}

/** How long an upgrade may wait for the dev server's answer before both ends are closed. */
export const UPGRADE_TIMEOUT_MS = 10_000;
/** Bytes a browser may send before its upgrade is answered. It should send none (a WebSocket
 * speaks only after its 101), and an upgrade may wait a while for a stream, all that time read. */
export const EARLY_LIMIT = 4 * 1024;
/** How long a refused upgrade's socket has to take its answer before it is closed outright. */
export const REFUSE_GRACE_MS = 1_000;
/** A request body this small (by its `content-length`) is read whole while the request waits for
 * a stream; a larger one, or one of unknown length, is paused unread. A paused request hides its
 * client's departure (Bun notices no FIN on a socket it does not read), so a small one would keep
 * its place in line and, once granted, reach the dev server after its browser left. Larger ones
 * are not read past what came in the read their headers did: once a body flows, Bun reads up to
 * half a MiB more of it past a `pause()` (measured on Bun 1.4.2 and 1.4.4), for every request in
 * line. That first read's share of a body sits in the request whatever `pause()` says (Bun 1.4.4;
 * 1.4.2 held it where `readableLength` did not show it), and is counted as what the paused body
 * holds (`EarlyBody.paused`). 16 KiB holds the POSTs a page sends while it loads (JSON, tRPC,
 * GraphQL queries); an upload is larger and is paused anyway. */
export const EARLY_BODY = 16 * 1024;
/** What every request's early body may hold at once, across a process that counts them
 * (`EarlyBodies`): past it a body is paused, as a large one is. A process's full line (1536
 * requests) at EARLY_BODY each would be 24 MiB; 4 MiB is still 256 bodies at the largest, and a
 * few thousand of the JSON a page sends, so only a line someone filled on purpose meets it, and
 * then all it costs is noticing a departure later. */
export const POD_EARLY = 4 * 1024 * 1024;

/** What a paused socket's kernel receive buffer is counted to hold of its body, beside what the
 * process holds of it (`EarlyBody.paused`): 128 KiB, the cap the pod sets (a pod whose sockets
 * may grow past it says so at boot). */
export const RECEIVE_BUFFER = 128 * 1024;
/** What a socket's kernel send buffer is counted to hold once its client stops reading (its
 * runtime then holds the rest): 128 KiB, the cap the pod sets, as RECEIVE_BUFFER. */
export const SEND_BUFFER = 128 * 1024;

/**
 * Aborts `socket` with a TCP reset, for a cut the server makes while its exchange is incomplete: a
 * response not all written, or a body not all read. Closed gracefully instead, a socket whose
 * client stops reading keeps what it had not sent in its kernel's send buffer (up to 128 KiB in a
 * pod) in FIN_WAIT1 for as long as the client answers the kernel's window probes: charged to the
 * process's cgroup, attributed to nobody, and counted by no cap (measured on kind: 8–9 MiB for 64
 * shed downloads, lasting as long as their viewer). A reset frees it at once. A socket that cannot
 * be reset (one that is no TCP socket; Bun 1.4.2's `resetAndDestroy` did nothing on a socket its
 * node:http accepted itself, fixed in 1.4.3) is destroyed.
 */
export function reset(socket: Duplex | null | undefined): void {
  if (!socket || socket.destroyed) return;
  const abort = (socket as { resetAndDestroy?: () => unknown }).resetAndDestroy;
  try {
    abort?.call(socket);
  } catch { /* not a TCP socket, or not connected: destroyed below */ }
  if (!socket.destroyed) socket.destroy();
}

/** What a client socket holds that a stream's own count leaves out: its buffers, the kernel's send
 * buffer when they hold anything (the client stopped reading), and its receive buffer while a body
 * still coming is paused unread (`Served.held`). */
function clientHeld(socket: Duplex | null | undefined, reading: boolean): number {
  if (!socket || socket.destroyed) return 0;
  const writing = socket.writableLength;
  return writing + (writing > 0 ? SEND_BUFFER : 0) + socket.readableLength +
    (reading && socket.isPaused() ? RECEIVE_BUFFER : 0);
}

/** Requests of one group whose large body (past EARLY_BODY, or of unknown length) may be paused
 * at once: past it such a request is answered 503 at once, even with a stream free. Each counts
 * from its headers until its stream is connected, so one granted a stream and still connecting
 * counts too. Each holds what came with its headers, the one read its paused socket takes and its
 * kernel's buffer, a read being as large as that buffer: some 384–512 KiB in a pod, so a run's
 * line full of uploads would be 256 MiB, where 128 of them hold some 64 MiB. A request with a
 * small body is never refused for it. */
export const PAUSED_WAITERS = 128;

/** One request's share of the early-body bytes (`EarlyBodies.for`). */
export interface EarlyBody {
  /** Takes room for `bytes`; false when there is none, and the body stays paused. */
  take(bytes: number): boolean;
  /** Gives back what `take` took. */
  give(bytes: number): void;
  /** Counts a body paused unread while its request waits as holding what `held` says whenever it
   * is asked, until the returned function is called; null (nothing counted) when it is `large`
   * and its group already has PAUSED_WAITERS of those waiting. A small one is never refused: what
   * it holds is its length at most. */
  paused?(held: () => number, large: boolean): (() => void) | null;
}

interface Paused {
  held: () => number;
  large: boolean;
}

/** The bytes the early bodies of every request in line hold, in all and per group: at most
 * `limit` in all, and what each group holds is part of what the memory guard measures of it.
 * Beside them, the bodies paused unread, per group: what each holds, asked as the guard samples,
 * and at most `pausedCap` large ones per group, past which `refused` is told. */
export class EarlyBodies {
  readonly limit: number;
  readonly pausedCap: number;
  readonly #refused: ((group: unknown) => void) | undefined;
  #total = 0;
  readonly #by = new Map<unknown, number>();
  readonly #paused = new Map<unknown, { all: Set<Paused>; large: number }>();

  constructor(
    limit = POD_EARLY,
    opts: { pausedCap?: number; refused?: (group: unknown) => void } = {},
  ) {
    this.limit = limit;
    this.pausedCap = opts.pausedCap ?? PAUSED_WAITERS;
    this.#refused = opts.refused;
  }

  /** Bytes held now, in all. */
  get total(): number {
    return this.#total;
  }

  /** Bytes each group with any holds now. */
  byGroup(): ReadonlyMap<unknown, number> {
    return this.#by;
  }

  /** Bytes each group's paused bodies hold now (`EarlyBody.paused`): each one asked, so this is
   * as many calls as bodies are paused, each cheap. */
  pausedByGroup(): Map<unknown, number> {
    const out = new Map<unknown, number>();
    for (const [group, { all }] of this.#paused) {
      let bytes = 0;
      for (const one of all) bytes += Math.max(0, one.held());
      if (bytes > 0) out.set(group, bytes);
    }
    return out;
  }

  /** How many large bodies `group` has paused now. */
  pausedLarge(group: unknown): number {
    return this.#paused.get(group)?.large ?? 0;
  }

  /** A request of `group`'s share. */
  for(group: unknown): EarlyBody {
    return {
      take: (bytes) => {
        if (this.#total + bytes > this.limit) return false;
        this.#total += bytes;
        this.#by.set(group, (this.#by.get(group) ?? 0) + bytes);
        return true;
      },
      give: (bytes) => {
        this.#total -= bytes;
        const left = (this.#by.get(group) ?? 0) - bytes;
        if (left > 0) this.#by.set(group, left);
        else this.#by.delete(group);
      },
      paused: (held, large) => {
        let mine = this.#paused.get(group);
        if (large && (mine?.large ?? 0) >= this.pausedCap) {
          this.#refused?.(group);
          return null;
        }
        if (mine === undefined) this.#paused.set(group, mine = { all: new Set(), large: 0 });
        const one: Paused = { held, large };
        const set = mine;
        set.all.add(one);
        if (large) set.large++;
        return () => {
          if (!set.all.delete(one)) return;
          if (large) set.large--;
          if (set.all.size === 0 && this.#paused.get(group) === set) this.#paused.delete(group);
        };
      },
    };
  }
}
/** What is read of an unread body after the answer, so the connection can serve its next request;
 * past it the connection is reset instead (`reset`). Bun 1.4.2 dropped the rest of a body whose
 * answer was sent before it arrived, whatever its size, so this was never reached there; from
 * 1.4.3 the rest comes, and this is what bounds it. */
export const DRAIN_LIMIT = 1024 * 1024;

/** Reads what is left of `req`'s body and drops it, up to DRAIN_LIMIT; past it the connection
 * is reset. The answer already said `connection: close` or will be the last on the connection. */
function drain(req: IncomingMessage): void {
  if (req.complete || req.destroyed) return;
  let read = 0;
  req.removeAllListeners("data");
  req.on("data", (chunk: Uint8Array) => {
    read += chunk.byteLength;
    if (read > DRAIN_LIMIT) reset(req.socket);
  });
  req.resume();
}

/**
 * Answers an upgrade request on its raw socket with `status` (`"404 Not Found"`) and closes it.
 * `end` sends the answer and a FIN, but on Bun a server socket whose peer never sends a FIN of its
 * own never closes; each one left so would keep its memory and its place in whatever counts open
 * sockets. So it is destroyed after a moment's grace, whatever the peer does.
 */
export function refuseUpgrade(client: Duplex, status: string): void {
  client.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
  if (client.destroyed) return;
  const grace = setTimeout(() => client.destroy(), REFUSE_GRACE_MS);
  client.once("close", () => clearTimeout(grace));
}

/** `headers` without any `content-length`: a 1xx or a 204 may not carry one (RFC 9110 §8.6). */
function withoutLength<T extends object>(headers: T): T {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  ) as T;
}

/** The `content-length` among headers about to be sent, as a number; null when there is none.
 * Throws on one that is not a single decimal number, or on two: node:http's client refuses a
 * response with either, so only a hook could make one. */
function lengthOf(headers: IncomingHttpHeaders | Record<string, string | string[]>): number | null {
  const values = Object.entries(headers)
    .filter(([name, value]) => value !== undefined && name.toLowerCase() === "content-length")
    .flatMap(([, value]) => [value].flat());
  if (values.length === 0) return null;
  const [value] = values;
  if (values.length === 1 && /^\d{1,15}$/.test(String(value))) return Number(value);
  throw new Error("invalid content-length");
}

/**
 * Never writes more of `res`'s body than the `length` it declared: past it, `res` is destroyed
 * (its connection reset) and `cut` called. Bun's node:http server writes past a declared length
 * as asked (measured on 1.4.2 and 1.4.4), and on a connection a load balancer reuses the excess
 * would be read as the next response. The client's parser never hands on a body longer than its own
 * response's length, so this is a guard for what a hook or a parser change could let through.
 */
function holdTo(res: ServerResponse, length: number, cut: () => void) {
  let left = length;
  const write = res.write;
  res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
    const size = typeof chunk === "string"
      ? Buffer.byteLength(chunk, typeof rest[0] === "string" ? rest[0] as BufferEncoding : "utf8")
      : (chunk as Uint8Array).byteLength;
    left -= size;
    if (left < 0) {
      cut();
      reset(res.socket);
      res.destroy();
      return false;
    }
    return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof res.write;
}

/** Proxies one HTTP request; answers 503 when no stream can be had, 502 when the dev server
 * fails or a hook's headers cannot be sent. Never throws. */
export async function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  connect: Connect,
  hooks: ProxyHooks = {},
): Promise<void> {
  // Outside the try, so a failure after it was had still releases it: the tunnel has few.
  let socket: Duplex | undefined;
  // A browser that leaves while its request waits for a stream gives up its place in line: its
  // response closes, or its connection does (all a departure after the body shows).
  const left = new AbortController();
  const leave = () => left.abort();
  res.once("close", leave);
  const connection = req.socket;
  connection?.once("close", leave);
  // A small body is read while it waits (the length is checked as it comes too: the header is
  // the client's word), when the process has room for it; anything else is paused: see
  // EARLY_BODY. The pipe below resumes it.
  const early: Uint8Array[] = [];
  let earlySize = 0;
  const length = Number(req.headers["content-length"] ?? 0);
  // Room taken for the body, given back once it has gone on, or the request has; and what a body
  // paused unread is counted to hold meanwhile.
  let reserved = 0;
  let unpause = () => {};
  const unreserve = () => {
    hooks.early?.give(reserved);
    reserved = 0;
    unpause();
  };
  const hold = (chunk: Uint8Array) => {
    early.push(chunk);
    earlySize += chunk.byteLength;
    if (earlySize > length) reset(req.socket);
  };
  if (req.complete) {
    // Nothing to read.
  } else if (
    req.headers["transfer-encoding"] === undefined && length > 0 && length <= EARLY_BODY &&
    (hooks.early?.take(length) ?? true)
  ) {
    reserved = hooks.early === undefined ? 0 : length;
    req.on("data", hold);
  } else {
    req.pause();
    // What it holds: what was read of it and not yet taken, here and on its socket (the read a
    // paused socket still takes lands there), and its kernel's buffer; never more than its length.
    const most = req.headers["transfer-encoding"] !== undefined || !Number.isFinite(length)
      ? Infinity
      : length;
    const held = () =>
      Math.min(most, req.readableLength + (req.socket?.readableLength ?? 0) + RECEIVE_BUFFER);
    const counted = hooks.early?.paused?.(held, most > EARLY_BODY);
    if (counted === null) {
      // Its group has as many uploads waiting as it may: turned away now, as a full line is.
      res.setHeader("connection", "close");
      res.writeHead(503).end("Preview busy");
      drain(req);
      connection?.off("close", leave);
      return;
    }
    unpause = counted ?? unpause;
  }
  try {
    socket = await connect(left.signal);
    connection?.off("close", leave);
    req.off("data", hold);
    // A body read whole while it waited leaves its request destroyed once it ended (autoDestroy):
    // that is not a departure.
    if (res.destroyed || connection?.destroyed || (req.destroyed && !req.readableEnded)) {
      unreserve();
      socket.destroy();
      return;
    }
    const stream = socket;
    // The browser's exchange cut short by this end: its response begun and not all written, or
    // its stream closed under it (stalled, or shed). Reset (`reset`), never closed gracefully,
    // and never answered after: a stream the guard closes before the dev server answered resets
    // the browser's socket rather than answering 502 (behind a load balancer the browser sees the
    // balancer's 502 either way; a client connected directly sees ECONNRESET).
    let cutShort = false;
    let answer: IncomingMessage | undefined;
    const cut = () => {
      if (cutShort || res.writableFinished) return;
      cutShort = true;
      reset(res.socket ?? connection);
      res.destroy();
    };
    // What the browser's socket holds counts as the stream's, and closing the stream cuts it.
    serves(stream, { held: () => clientHeld(connection, !req.complete), cut });
    // Every way the dev server can fail lands here, some more than once (a parse error both
    // errors and closes): a response already ended must not be ended again, which throws.
    const unavailable = (why = "Preview server unavailable") => {
      if (res.writableEnded || res.destroyed || cutShort) return;
      if (res.headersSent) cut();
      else res.writeHead(502).end(why);
    };
    const headers = endToEnd(req.headers);
    // One request per stream: `connection: close` lets either end hang up once it is done.
    const upstream = request({
      method: req.method,
      path: req.url,
      headers: {
        ...sendable(hooks.request ? hooks.request(headers, req) : headers),
        // Re-framed rather than forwarded: node:http sends a DELETE's or OPTIONS's body
        // unframed unless it is told the body is chunked.
        ...(req.headers["transfer-encoding"] ? { "transfer-encoding": "chunked" } : {}),
        connection: "close",
      },
      createConnection: () => stream,
    }, (response) => {
      // The agent's dev server picks this status. One node:http parses but will not send
      // (099, say) would throw here, outside any handler, and take the whole process down.
      answer = response;
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        unavailable("Preview server sent an invalid status");
        upstream.destroy();
        return;
      }
      // An event stream asked for without saying so holds its stream as long as one that did.
      if (eventStream(response.headers["content-type"])) promote(stream);
      let declared: number | null;
      try {
        const back = endToEnd(response.headers);
        const shaped = hooks.response ? sendable(hooks.response(back, status)) : back;
        // A 204 has no body, and may not say how long it is (RFC 9110 §8.6).
        const sent = status === 204 ? withoutLength(shaped) : shaped;
        declared = lengthOf(sent);
        res.writeHead(status, sent);
      } catch {
        upstream.destroy();
        unavailable("Preview server sent an invalid header");
        return;
      }
      // A response that stops short (its stream cut, or the dev server gone) is the browser's cut
      // short too.
      response.on("error", cut);
      response.once("close", () => {
        if (!response.complete) cut();
      });
      if (declared !== null) holdTo(res, declared, () => upstream.destroy());
      response.pipe(res);
    });
    upstream.on("error", () => unavailable());
    // A 101 to a plain request ends the upstream with no response and no error.
    upstream.on("close", () => {
      if (!res.headersSent) unavailable();
    });
    res.on("close", () => {
      // Let go before the dev server's answer was all read or the body all sent: a stream that
      // is a socket (a relay to the pod that owns the run) is reset, as the browser's would be.
      if (!(answer?.complete && req.complete)) reset(stream);
      upstream.destroy();
      // Answered before the browser finished sending (a 413, say): the rest of its body
      // is drained, as node:http drains an unread one, so the connection serves the next
      // request instead of stalling (closing it at once would reset the upload, response and
      // all); past DRAIN_LIMIT it is reset after all.
      if (!req.complete && !cutShort) {
        req.unpipe(upstream);
        drain(req);
      }
    });
    req.on("error", () => upstream.destroy());
    // What was read while it waited goes first, then the rest as it comes; the stream counts it
    // from here on.
    for (const chunk of early) upstream.write(chunk);
    unreserve();
    if (req.readableEnded) upstream.end();
    else req.pipe(upstream);
  } catch {
    unreserve();
    connection?.off("close", leave);
    req.off("data", hold);
    socket?.destroy();
    if (res.headersSent || res.destroyed) return;
    // A body still coming is drained up to DRAIN_LIMIT, and the connection then reset: it
    // serves no next request, so an upload of any size costs no more than that.
    if (!req.complete) res.setHeader("connection", "close");
    if (socket) res.writeHead(502).end("Preview request refused");
    else if (hooks.unavailable) hooks.unavailable(res);
    else res.writeHead(503).end("Preview disconnected or busy");
    drain(req);
  }
}

/** Proxies one upgrade (WebSocket only; anything else is reset) from the server's `upgrade`
 * event. Until the dev server answers, a browser that leaves or `timeoutMs` passing closes both
 * ends. Never throws. */
export async function proxyUpgrade(
  req: IncomingMessage,
  client: Duplex,
  head: Uint8Array,
  connect: Connect,
  hooks: ProxyHooks = {},
  timeoutMs = UPGRADE_TIMEOUT_MS,
): Promise<void> {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    client.destroy();
    return;
  }
  let socket: Duplex | undefined;
  let upstream: ClientRequest | undefined;
  const left = new AbortController();
  const fail = () => {
    settle();
    left.abort();
    client.destroy();
    upstream?.destroy();
    reset(socket);
  };
  // While it waits, the client is read: a closed connection only shows as its end, and a paused
  // one never does. Anything it sends meanwhile is kept for the dev server.
  const early: Uint8Array[] = [];
  let earlySize = 0;
  const onData = (chunk: Uint8Array) => {
    earlySize += chunk.length;
    if (earlySize > EARLY_LIMIT) fail();
    else early.push(chunk);
  };
  const timer = setTimeout(fail, timeoutMs);
  function settle() {
    clearTimeout(timer);
    client.off("data", onData);
    client.off("end", fail);
  }
  client.on("data", onData);
  client.on("end", fail);
  try {
    socket = await connect(left.signal);
    if (client.destroyed) {
      fail();
      return;
    }
    const stream = socket;
    const sent = upstream = request({
      method: req.method,
      path: req.url,
      headers: hooks.request ? sendable(hooks.request({ ...req.headers }, req)) : req.headers,
      createConnection: () => stream,
    });
    sent.on("upgrade", (response, remote, remoteHead) => {
      settle();
      let lines = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      try {
        if (hooks.response) {
          const headers = sendable(
            hooks.response({ ...response.headers }, response.statusCode ?? 101),
          );
          for (const [name, value] of Object.entries(withoutLength(headers))) {
            for (const one of Array.isArray(value) ? value : [value]) {
              lines += `${name}: ${one}\r\n`;
            }
          }
        } else {
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            if (response.rawHeaders[i].toLowerCase() === "content-length") continue;
            lines += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
          }
        }
      } catch {
        remote.destroy();
        fail();
        return;
      }
      client.write(`${lines}\r\n`);
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      for (const chunk of early) remote.write(chunk);
      remote.pipe(client).pipe(remote);
      // What the browser's socket holds counts as the stream's, and closing the stream (stalled,
      // or shed) resets it: a WebSocket cut by this end is reset whenever it goes, as what is
      // queued for it would otherwise wait in its kernel for a browser that may not read.
      serves(stream, { held: () => clientHeld(client, true), cut: () => reset(client) });
      remote.on("error", () => reset(client));
      client.on("error", () => reset(remote));
      client.on("close", () => remote.destroy());
      // Browsers never half-close a WebSocket; a dev server that ignores the FIN would pin
      // the stream for good. A moment's grace lets the browser's closing frame through.
      client.on("end", () => {
        const grace = setTimeout(() => remote.destroy(), 250);
        remote.once("close", () => clearTimeout(grace));
      });
      // Ended by the dev server, everything it sent goes out first; cut short (its stream closed
      // under it, the tunnel gone), the browser's socket is reset.
      remote.on("close", () => {
        if (remote.readableEnded) client.destroy();
        else reset(client);
      });
    });
    // A refused upgrade (a host check's 403, say) keeps its status rather than a bare reset.
    sent.on("response", (response) => {
      settle();
      // The status line is the dev server's: node:http parsed it, so it holds no CR or LF. A 101
      // that is no upgrade (no Upgrade header) lands here too, and is no answer to pass on.
      const status = response.statusCode ?? 0;
      refuseUpgrade(
        client,
        status < 200 || status > 599 ? "502 Bad Gateway" : `${status} ${response.statusMessage}`,
      );
      sent.destroy();
    });
    sent.on("error", fail);
    client.on("close", () => {
      // A browser that hung up lets what it sent last (its closing frame) go on; a socket that
      // broke, or that this end cut, has the stream reset, which matters when that is a socket
      // (a relay to the pod that owns the run).
      if (!client.readableEnded) reset(stream);
      sent.destroy();
    });
    sent.end();
  } catch {
    fail();
  }
}
