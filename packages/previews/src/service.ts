// The hosted previews service: every preview of every run in a cell, in memory. With several
// replicas each run's previews live on one pod, its owner (core/cluster.ts), and the others
// forward what they get for that run there; with one, or none of the peer configuration, nothing
// is forwarded and nothing below the "peers" markers runs.
//
// Three listeners, all node:http; a fourth with several replicas. The API one is the control
// plane's, behind RYPH_PREVIEWS_TOKEN (and its peers', behind a credential derived from it), and
// no run reaches it. The TUNNEL one is the runners': a runner dials its tunnel there with a
// single-use ticket, and it serves nothing else, so whatever a run does to it (a flood of
// connections that never speak) costs other runs' dials at worst, never the control plane's
// calls. Nothing routes either from outside the cluster. Tunnels are `ws` sockets, which refuse a
// frame past the mux's limit as its header arrives: a 64 MiB default would let a few tunnels take
// the pod past its memory limit. They are the real package (`realWs()`), since Bun's stand-in for
// `ws` ignores `maxPayload` and buffers a frame of any size. The PUBLIC one (for its raw upgrades)
// serves `<id>.<domain>` to browsers through the load balancer, each request gated by a viewer
// cookie only a control-plane ticket mints, then proxied over the run's tunnel (@ryph/tunnel); it
// keeps an idle connection past the balancer's reuse of one. This service decides nothing about
// people or runs: the control plane has already, before it asks for a ticket.
//
// With several replicas, the PEER listener, where another pod sends a browser request for a
// preview this one owns, each on a connection of its own. It takes only requests carrying the
// peer credential (derived from the token, so only the pods hold it), takes that off, and serves
// the request through the very code the public listener uses — gate, cookie, header rewriting —
// and never sends it on again. Nothing reaches it unauthenticated: a pod sends on only a viewer's
// request (its cookie and the gate checked first) or the way in with a viewer ticket whose MAC it
// checked. The API listener forwards the control plane's calls by the run, or the preview, they
// name, to the owner's API listener. Runners need no forwarding: a registration's answer names the
// owner's own tunnel address, and the runner dials it.
//
// What keeps the pod inside its memory is its guard (memory.ts), which measures it, and what the
// service does at each of its levels (below, `pressed`); the budget's counts (@ryph/tunnel) keep
// any few runs from taking what the others need, and every listener has a ceiling on its
// connections (connections.ts).
//
// At HIGH the service refuses only the CULPRITS (`press`): the groups (a run, or a relayed run's
// shard) whose measured bytes — their streams' unread bytes either way and their browsers'
// sockets' (the kernel's buffers while they fill), plus SERVED_BYTES for each stream holding any,
// their tunnels' send queues, their requests' bodies read while they wait or paused unread — are
// at least CULPRIT_MIN, at least the mean of the groups holding any, and at least their share of
// the growth (`culpritsOf`). New ones are named only at a sample at or past
// HIGH's watermark (in the band below it, on the way down, culprits are kept and released, nobody
// new named), never within SHED_HOLD_MS of the last naming or of closing at least CULPRIT_MIN
// unless usage rose NAMING_RISE since (what closing frees reaches the counter seconds later, and
// the next-busiest honest run would otherwise look like the culprit), and only when what the runs
// hold between them EXPLAINS the pod's growth: at least half of how far it is past its baseline,
// the least it held at normal over the minutes before it was pressed, but never more than 2 ×
// HYSTERESIS below HIGH (the guard's `baseline`; with none yet, nobody is named). The cap is what
// keeps a pod held just under the watermark for minutes (by memory no run's bytes say) from making
// a spike past it a few MiB of growth an honest run's bytes explain: at a naming sample the growth
// is at least a tenth of the limit. Otherwise the memory is somewhere no run's bytes say (the
// runtime's own slack, the kernel's), and naming the largest holder would steer the guard onto
// whichever honest run is busiest: nobody is named, and `previews.memory.unexplained` says so.
// Each named group must hold its share too: half the growth split evenly among those past the
// mean, so a run holding a sliver of it is never named beside the one holding most. What none of
// this sees is memory that grows slowly without being any run's bytes: it raises the baseline as
// it goes (up to the cap), and the guard falls back on CRITICAL's shedding for it. An idle open
// stream holds nothing, and counts so, so open tabs never name a run. A culprit stays one until
// the pod is back to normal or it has held less than CULPRIT_MIN for CULPRIT_RELEASE_MS. Culprits
// get nothing new, lose their place in line, have their tunnels' queues past TUNNEL_SLACK cut, and
// lose every stream holding bytes, progressing or not: so HIGH corrects itself. Nobody else is
// touched at HIGH; with no culprit it does nothing more until CRITICAL. At CRITICAL everyone is
// refused, every line emptied, and streams are closed (`shed`): culprits' first, then those making
// no progress, then the largest, until what they held covers the way back under HIGH, at most
// every SHED_HOLD_MS (unless past PANIC); and every tunnel's queue past TUNNEL_SLACK is cut. STUCK
// — at CRITICAL for at least STUCK_CRITICAL_MS and the latest shed found nothing to close — it
// fails /healthz, and the kubelet restarts the pod (runners re-register, links and cookies
// survive); it passes again as soon as that stops holding.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import { bearerToken, timingSafeEqual } from "@ryph/sealed";
import { DEFAULT_HEADERS_MS, DEFAULT_KEEP_ALIVE_MS, frontHttpServer, realWs } from "@ryph/service";
import { json as jsonResponse, readCapped } from "@ryph/shared/http";
import {
  Budget,
  type CapName,
  type Connect,
  EarlyBodies,
  type HostMux,
  hostMux,
  lasting,
  MAX_FRAME,
  offersTunnelProtocol,
  permitted,
  POD_STREAMS,
  type Pressure,
  type ProxyHooks,
  proxyHttp,
  proxyUpgrade,
  type Refusal,
  refuseUpgrade,
  reset,
  TUNNEL_PROTOCOL,
  UPGRADE_TIMEOUT_MS,
  WAIT_MS,
  withoutHopByHop,
} from "@ryph/tunnel";
import { Connections } from "./connections.ts";
import {
  type Cluster,
  CONNECTION_HEADER,
  HOP_HEADER,
  ownerOf,
  PEER_HEADER,
  tunnelBase,
  WAIT_HEADER,
} from "./core/cluster.ts";
import { contentSecurityPolicy, validHost } from "./core/csp.ts";
import {
  landing,
  origin,
  pathOf,
  type Place,
  previewOf,
  RESERVED,
  serviceWorker,
  underDomain,
} from "./core/gate.ts";
import { downstreamHeaders, upstreamHeaders } from "./core/headers.ts";
import {
  COOKIE_TTL_S,
  cookieName,
  cookieValues,
  forwardCredential,
  type Keys,
  keys as makeKeys,
  peerCredential,
  previewId,
  setViewerCookie,
  shardOf,
  shardOfId,
  ticket,
  TUNNEL_TICKET_MS,
  VIEWER_TICKET_MS,
  viewerCookie,
  viewerCookieShaped,
  viewerCookieValid,
  viewerTicket as mintViewerTicket,
  viewerTicketValid,
} from "./core/keys.ts";
import { MemoryGuard, type MemoryReading, type MemorySource, SAMPLE_MS } from "./memory.ts";
import { forwardInternal, PeerUnreachable, relay } from "./peers.ts";

/** Previews one run may have at once. All of a run's are on its owner, so this holds per pod. */
export const PREVIEWS_PER_RUN = 4;
/** Previews this replica holds at once; a cell holds this many per replica. */
export const TOTAL = 256;
/** A relayed upgrade waits a little longer than the owner does for the dev server, so the owner's
 * own answer (a refusal, its timeout) is what reaches the client. */
const RELAY_UPGRADE_MS = UPGRADE_TIMEOUT_MS + 2_000;
/** How long a drain lets requests in flight on the public and peer listeners finish. */
export const DRAIN_GRACE_MS = 1_000;
/** Hosts one registration's allowlist may name; the orchestrator's own ceiling is 200. */
const MAX_HOSTS = 512;
/** A tunnel this long without a ping is gone, whatever its socket says. */
const PING_TIMEOUT_MS = 45_000;
const SWEEP_MS = 5_000;
/** Viewer tickets outstanding for one preview: past it, the oldest goes. Someone opening one
 * preview over and over cannot crowd out the viewers of another. */
const VIEWER_TICKETS_PER_PREVIEW = 16;
/** Viewer tickets outstanding at once, a backstop: past it, the oldest goes. */
const MAX_VIEWER_TICKETS = 4096;
/** One `preview.refused` line per run (or shard) and reason this often at most; the rest are
 * counted into the next. */
const REFUSED_LOG_MS = 10_000;
/** How many runs' refusals are remembered for that; past it, the quietest are forgotten. */
const REFUSED_KEYS = 1024;
/** Previews whose run ended (`DELETE /internal/runs/:runId`), remembered as long as a viewer
 * cookie lasts, so a tab left open on one says it ended rather than asking to wait; past it, the
 * oldest are forgotten, and say what an unknown one does. */
const ENDED = 4096;
/** A preview dropped for any other reason (its tunnel closed, it went quiet) is remembered with
 * its run this long, so a run that ends just after its runner went away still has every preview
 * of it said to have ended. */
const DROPPED_MS = 5 * 60_000;
/** Connections to the public listener past which the longest idle are closed as more come: the
 * open streams and the line's requests each ride one of their own (the balancer speaks HTTP/1.1
 * to a backend), with room to spare for the idle ones it keeps. */
export const PUBLIC_SOFT = 4096;
/** The public listener's hard ceiling (`maxConnections`): past it a connection is refused at once,
 * which the balancer answers as a 502, so the soft cap acts first. */
export const PUBLIC_MAX = 6144;
/** Connections to the tunnel listener that have not dialled a tunnel yet (a pending ticket's
 * upgrade), per source address and in all: past either one makes room for the next
 * (connections.ts). Every run reaches this listener, and in compose every run's tunnels come
 * through one address, the run gate. */
export const UNTRUSTED_PER_ADDRESS = 64;
export const UNTRUSTED_TOTAL = 256;
/** How long a connection to the tunnel listener has to dial its tunnel. */
export const UNTRUSTED_MS = 5_000;
/** The tunnel listener's hard ceiling: far past what the untrusted caps and TOTAL tunnels hold
 * together, so a runner always finds room. */
export const TUNNEL_MAX = 4096;
/** The API listener's hard ceiling: the control plane's calls and its peers' forwards, and
 * nothing else reaches it. */
export const API_MAX = 1024;
/** Registrations of one run's port, and of one run, a burst of at most this many and then one per
 * the interval: the runner re-registers a dropped tunnel with a backoff from 1 s, and each
 * re-registration replaces (terminates) the tunnel before. Past it, a 429 the runner retries. */
const REGISTER_BURST_PORT = 4;
const REGISTER_EVERY_PORT_MS = 2_000;
const REGISTER_BURST_RUN = 16;
const REGISTER_EVERY_RUN_MS = 500;
/** A group holding less than this is nobody's culprit. */
export const CULPRIT_MIN = 1024 * 1024;
/**
 * What the runs hold between them must be at least 1/EXPLAINED of how far the pod has grown since
 * its baseline (the least it held at normal over the last minutes before it was pressed) for any
 * of them to be named: less, and the memory is somewhere their bytes do not say. Half, not all:
 * what the service measures of a run undercounts what it costs (allocator and collector slack, a
 * socket's kernel buffers taken at an estimate), so asking the runs to cover all of the growth
 * would miss a real culprit; and not less, since the growth is everything since the baseline,
 * and memory no run holds (the runtime's, the kernel's) must not be able to steer the guard onto
 * whichever honest run is busiest.
 */
export const EXPLAINED = 2;

/**
 * Which of the groups `held` names (bytes each, as the service measures them) are culprits for a
 * pod `over` bytes past its baseline: none unless what they hold between them explains it
 * (EXPLAINED); else every group holding at least CULPRIT_MIN, at least the mean of those holding
 * any, and at least its share of what must be explained — `over` / EXPLAINED split evenly among
 * those groups. The share is what keeps a run holding a sliver of the growth from being named
 * beside the one holding most of it: the mean alone is low when many hold a little.
 */
export function culpritsOf(held: ReadonlyMap<unknown, number>, over: number): unknown[] {
  let total = 0;
  for (const bytes of held.values()) total += bytes;
  if (total * EXPLAINED < over) return [];
  const candidates = [...held].filter(([, bytes]) =>
    bytes >= CULPRIT_MIN && bytes * held.size >= total
  );
  return candidates
    .filter(([, bytes]) => bytes * EXPLAINED * candidates.length >= over)
    .map(([group]) => group);
}
/** After naming a culprit, nobody else is named for SHED_HOLD_MS (what closing its streams frees
 * reaches the counter seconds later), unless usage rose by at least this fraction of the limit
 * since. Closing renews the hold-off only when what it freed is CULPRIT_MIN or more: a culprit
 * that has a stream of a few bytes closed every second must not keep the next one from being
 * named. */
const NAMING_RISE = 0.01;
/** A culprit that has held less than CULPRIT_MIN this long is one no more; one that comes back is
 * named again. */
export const CULPRIT_RELEASE_MS = 60_000;
/** A tunnel's send queue past what its streams are owed (two frames) is cut under pressure: an
 * honest runner reads what it is sent. */
const TUNNEL_SLACK = 2 * (MAX_FRAME + 4);
/** Past this fraction of the limit a shed does not wait out SHED_HOLD_MS. */
const PANIC = 0.95;
/** After a shed, the next waits this long: what it freed reaches the cgroup's counter seconds
 * later, and a shed every second would close a quarter of the streams each time on stale news. */
export const SHED_HOLD_MS = 10_000;
/** At CRITICAL at least this long, and the latest shed found nothing to close: the pod is stuck,
 * and fails /healthz. */
const STUCK_CRITICAL_MS = 60_000;
/** Under pressure, idle public and peer connections this quiet are closed, once an episode: a
 * load balancer may be about to reuse one quiet for less, and its request would be an empty 502. */
export const PRESSURE_IDLE_MS = 15_000;
/** How often the service says what it holds, while it holds anything. */
const STATS_MS = 60_000;
/** Viewer cookies checked per request: a sibling preview over http may set decoys beside the real
 * one, each an HMAC to check. Only those that could be one count (well-formed, unexpired: telling
 * costs nothing), so stale cookies at longer paths never push the real one out. */
const MAX_COOKIES = 4;
/** A preview id: 32 lowercase hex, its run's shard first. */
const PREVIEW_ID = /^[a-f0-9]{32}$/;

export interface PreviewsLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  /** Default: `warn`. */
  error?(event: string, fields?: Record<string, unknown>): void;
}

export interface PreviewsOptions {
  /** RYPH_PREVIEWS_TOKEN: the control plane's bearer, and the key ids and cookies are signed with. */
  token: string;
  /** e.g. `preview.ryph-previews.example`; `http` when it is or ends in `localhost`. */
  domain: string;
  /** Only for `http` on `*.localhost`: the port browsers reach the public listener on. */
  publicPort?: number;
  /** RYPH_PREVIEWS_APP_URL, the app's origin: a cookieless navigation is sent to its open route
   * for the preview (`/previews/<id>`), which asks the control plane for a ticket. Without it,
   * that navigation is a 401 page. */
  appUrl?: string;
  /** Mounted on the public listener, for hosts that are no name under the preview domain: where
   * the kubelet and the load balancer probe, by the pod's address. The tunnel and API listeners
   * have none. `/healthz` fails while the guard says the pod is stuck. */
  health?: Array<{
    method: string;
    pattern: URLPattern;
    handler(req: Request, params: Record<string, string>): Promise<Response>;
  }>;
  log?: PreviewsLog;
  /** Where the pod's memory is read and against what limit (`memorySource` in memory.ts), and its
   * watermarks; absent, nothing guards it but the counts. */
  memory?: { source: MemorySource; high?: number; critical?: number; gc?: (() => void) | null };
  /** Streams the runs this pod owns may hold at once (@ryph/tunnel's POD_STREAMS); relays get
   * half as many again, apart. Seam for tests. */
  streams?: number;
  /** This pod among its replicas. Absent, or one replica: this pod owns every run, there is no
   * peer listener, and a registration names no tunnel address (the control plane's own applies).
   * Read as requests come, so a test may fill in ports once its listeners are bound. */
  cluster?: Cluster;
  /** Seam for tests. */
  now?: () => number;
}

export interface Previews {
  /** The tunnel listener (runners' `/tunnel/<ticket>`), not yet listening. */
  tunnel: Server;
  /** The API listener (the control plane's `/internal/*`), not yet listening. */
  api: Server;
  /** The public listener, not yet listening. */
  public: Server;
  /** The peer listener (browser requests another pod forwarded here), not yet listening; null
   * with one replica. */
  peer: Server | null;
  /** Stops the public and peer listeners: their upgraded sockets close at once, requests in
   * flight get DRAIN_GRACE_MS to finish and are then cut. */
  shutdownPublic(): Promise<void>;
  /** Runs the periodic sweep at once: expired tickets, tunnels never dialled or gone quiet. */
  sweep(): void;
  /** Closes every tunnel and socket, on every listener, and stops the sweep. */
  close(): void;
  /** How many streams the tunnels and relayed requests hold, capped per run and in all. */
  budget: Budget;
  /** The bodies of requests waiting for a stream, per group: read, or paused unread. */
  early: EarlyBodies;
  /** What measures the pod's memory and sheds past its watermarks; null without a limit. Its
   * `check()` samples once, for tests; the service samples every second on its own. */
  guard: MemoryGuard | null;
  /** What the service holds now: what its periodic `previews.memory` line says. */
  stats(): Record<string, unknown>;
  /** Where the guard stands, and the culprits it names now: at HIGH it refuses them alone, at
   * CRITICAL everyone. */
  pressure(): { level: Pressure; culprits: string[] };
}

interface Entry {
  id: string;
  runId: string;
  port: number;
  label: string;
  url: string;
  csp: string;
  /** A registration's ticket, until its tunnel connects or it expires. */
  pending: { ticket: string; expires: number } | null;
  tunnel: Tunnel | null;
  mux: HostMux | null;
  lastPing: number;
}

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: unknown) => jsonResponse(status, body, NO_STORE);

const route = (method: string, pathname: string) => ({
  method,
  pattern: new URLPattern({ pathname }),
});
const ROUTES = {
  register: route("POST", "/internal/previews"),
  list: route("GET", "/internal/runs/:runId/previews"),
  viewer: route("POST", "/internal/previews/:id/viewer"),
  lookup: route("GET", "/internal/previews/:id"),
  forget: route("DELETE", "/internal/runs/:runId"),
};
const TUNNEL = new URLPattern({ pathname: "/tunnel/:ticket" });

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The tunnels' text messages, decoded each whole. */
const utf8 = new TextDecoder();

// What this uses of `ws`, typed here: the package ships no types, and @types/ws would bring all of
// @types/node with it.
interface Tunnel {
  binaryType: "arraybuffer";
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  terminate(): void;
  /** `ping` and `pong`: control frames, which the runner has no business sending (its heartbeat
   * is the mux's own "ping" message). */
  on(event: "close" | "error" | "ping" | "pong", listener: () => void): void;
  /** With `binaryType` "arraybuffer", a binary message's data is one ArrayBuffer; a text one's is
   * a Buffer whatever `binaryType` says (ws 8 converts only binary messages). */
  on(event: "message", listener: (data: ArrayBuffer | Uint8Array, binary: boolean) => void): void;
}
interface TunnelServer {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Uint8Array,
    done: (socket: Tunnel) => void,
  ): void;
}

/** A node:http request as a fetch one, for the internal routes written against those. */
function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(req) as ReadableStream<Uint8Array>;
  return new Request(new URL(req.url ?? "/", "http://internal").href, {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response) {
  const body = new Uint8Array(await response.arrayBuffer());
  if (res.headersSent || res.destroyed) return;
  res.writeHead(response.status, Object.fromEntries(response.headers)).end(body);
}

const PAGE_STYLE = "font:16px system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem";
/** How often a page that says "in a moment" or "shortly" loads the preview again by itself: each
 * page picks a whole number of seconds in this range, so the tabs a pod sent away do not all come
 * back in the same second. */
export const RETRY_S = { min: 2, max: 5 };
const retryAfter = () => RETRY_S.min + Math.floor(Math.random() * (RETRY_S.max - RETRY_S.min + 1));
/**
 * One of our own pages. With `retry`, it loads the same URL again after RETRY_S seconds: a dev
 * server's client reloads the tab when its socket drops (Vite's does), and a tab left on a preview
 * that will be back should not need a person to come back. Only for what will be back: a preview
 * that ended never is, and a tab left on it would load it again for as long as its cookie lasts.
 * A meta refresh is no fetch or script, so the page's CSP has nothing to say about it.
 */
function page(res: ServerResponse, status: number, text: string, retry = false) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  }).end(
    `<!doctype html><meta charset="utf-8">` +
      (retry ? `<meta http-equiv="refresh" content="${retryAfter()}">` : "") +
      `<title>Preview</title><p style="${PAGE_STYLE}">${text}</p>`,
  );
}
const EXPIRED = "This preview link has expired. Open it again from Ryph.";
const NO_COOKIE = "Open this preview from Ryph.";
const MOVING = "This preview will be back in a moment.";
const UNKNOWN = "This preview isn't available. If its run is still going, it will be back shortly.";
const ENDED_PAGE = "This preview has ended.";
const NOWHERE = "There is no preview here.";

/** A top-level page load: what a link, a pasted URL or a reload sends. Without Sec-Fetch headers
 * at all (Safari before 16.4), a GET that asks for HTML. */
function navigation(req: IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  if (mode !== undefined || dest !== undefined || req.headers["sec-fetch-site"] !== undefined) {
    return mode === "navigate" && dest === "document";
  }
  return /\btext\/html\b/i.test(req.headers.accept ?? "");
}

export async function previews(opts: PreviewsOptions): Promise<Previews> {
  const now = opts.now ?? Date.now;
  const k: Keys = await makeKeys(opts.token);
  const domain = opts.domain.toLowerCase();
  const local = domain === "localhost" || domain.endsWith(".localhost");
  const place: Place = { scheme: local ? "http" : "https", domain, publicPort: opts.publicPort };
  // ---- peers: who owns what -----------------------------------------------------------------
  const cluster = opts.cluster !== undefined && opts.cluster.peers.length > 1 ? opts.cluster : null;
  const replicas = cluster?.peers.length ?? 1;
  const self = cluster?.self ?? 0;
  if (!Number.isInteger(self) || self < 0 || self >= replicas) {
    throw new RangeError(`ordinal ${self} is not one of ${replicas} replicas`);
  }
  const credential = cluster === null ? null : await peerCredential(k);
  const forwarding = cluster === null ? null : await forwardCredential(k);
  /** The ordinal holding the run whose shard this is; this pod's own with one replica. */
  const ownerOfShard = (shard: string) => cluster === null ? self : ownerOf(shard, replicas);

  const entries = new Map<string, Entry>();
  // Registrations whose runner has not dialled yet, by their ticket (`setPending`).
  const pendingTickets = new Map<string, Entry>();
  // Ids of previews whose run ended, and until when that is worth saying (insertion order is age
  // order).
  const ended = new Map<string, number>();
  // Ids of previews dropped for any other reason lately, with their run and until when.
  const dropped = new Map<string, { runId: string; until: number }>();
  const viewerTickets = new Map<string, { id: string; expires: number; path: string }>();
  // Browser connections to the public listener, and those of them that upgraded.
  const connections = new Connections({ soft: PUBLIC_SOFT, now });
  const upgraded = new Set<Duplex>();
  // Every connection to the tunnel listener, those that have not dialled a tunnel yet held to a
  // few per address and in all; and every connection to the API listener.
  const tunnelConnections = new Connections({
    untrusted: {
      perAddress: UNTRUSTED_PER_ADDRESS,
      total: UNTRUSTED_TOTAL,
      deadlineMs: UNTRUSTED_MS,
    },
    now,
  });
  const apiConnections = new Connections({ now });
  // Every connection to the peer listener, and every connection this pod opened to a peer.
  const peerConnections = new Connections({ now });
  const toPeers = new Set<Socket>();
  const trackPeer = (socket: Socket) => {
    toPeers.add(socket);
    socket.once("close", () => toPeers.delete(socket));
    if (closed) socket.destroy();
  };
  // A frame is a 4-byte stream id and at most MAX_FRAME bytes; anything longer is refused (1009)
  // as its header arrives, before it is buffered. A runner never fragments a message, and ws
  // would take up to 16384 frames of one (each a parse, and the message's earlier ones held,
  // charged to nobody, until it ends): its first continuation frame is refused (1008), and the
  // tunnel with it (`dialled`).
  // No pong for a ping: ws would queue one per ping with no regard for its backlog, and a runner
  // that sends pings and reads nothing would grow it without bound (measured: 1.6 GiB within one
  // sample). The runner's heartbeat is the mux's "ping" message; a control frame from it is a
  // broken wire (`dialled`).
  const tunnels = new (realWs().WebSocketServer)({
    noServer: true,
    maxPayload: MAX_FRAME + 4,
    maxFragments: 1,
    perMessageDeflate: false,
    autoPong: false,
    clientTracking: false,
    handleProtocols: (offered: Set<string>) =>
      offered.has(TUNNEL_PROTOCOL) ? TUNNEL_PROTOCOL : false,
  }) as unknown as TunnelServer;
  // Every tunnel's streams are counted here, each run's previews as one group under PER_RUN: a run
  // holds its caps and nothing of another's. A relay's group is `relay:<shard>`, under PER_RELAY,
  // in a part of the pod of its own. Under memory pressure the guard says, group by group, who is
  // refused (`pressureOf`).
  const streams = opts.streams ?? POD_STREAMS;
  const budget = new Budget({
    streams,
    relays: cluster === null ? 0 : Math.floor(streams / 2),
    now,
    pressure: (group) => pressureOf(group),
    refused: (group, why, cap) => refused(String(group), why, cap),
  });
  // Bodies read while their requests wait for a stream, per group: part of what the guard
  // measures of each, and capped for the pod as a whole; and those paused unread, at most
  // PAUSED_WAITERS large ones per group.
  const early = new EarlyBodies(undefined, {
    refused: (group) =>
      refused(
        String(group),
        "line full",
        `${String(group).startsWith("relay:") ? "relay" : "run"}-paused`,
      ),
  });
  // The culprits the guard names, and since when each has held less than CULPRIT_MIN (null while
  // it holds more): added to at a sample at or past HIGH's watermark whose growth since the
  // baseline the runs' bytes explain (`name`), dropped after CULPRIT_RELEASE_MS below CULPRIT_MIN,
  // forgotten at normal. At HIGH they alone
  // are refused; at CRITICAL, everyone.
  let culprits = new Map<unknown, { below: number | null }>();
  const pressureOf = (group: unknown): Pressure => {
    const level = guard?.level ?? "normal";
    return level === "high" && !culprits.has(group) ? "normal" : level;
  };
  let lastShed = -Infinity;
  // When the guard last named a culprit or closed at least CULPRIT_MIN, and what the pod held at
  // the first of those in a row (`freedNow`): nobody new is named until SHED_HOLD_MS later, unless
  // usage has risen NAMING_RISE past it.
  let lastFreed: { at: number; used: number } | null = null;
  // Whether the latest shed at CRITICAL found nothing to close: so for STUCK_CRITICAL_MS at
  // CRITICAL, the pod is stuck.
  let nothingToShed = false;
  // Whether this episode's idle public and peer connections were closed.
  let idleClosed = false;
  // Set while the guard says the pod cannot get back under its watermarks by itself: /healthz
  // fails, and the kubelet restarts it.
  let stuck: string | null = null;
  const unstick = () => {
    if (stuck !== null) opts.log?.warn("previews.memory.unstuck", memoryFields());
    stuck = null;
  };
  const guard = opts.memory === undefined ? null : new MemoryGuard({
    ...opts.memory,
    now,
    pressed: (level, reading) => press(level, reading),
    changed: (level, previous) => {
      if (level === "normal") {
        culprits = new Map();
        idleClosed = false;
        lastFreed = null;
      }
      if (level !== "critical") {
        nothingToShed = false;
        unstick();
      }
      levelChanged(previous);
    },
    sampled: () => levelSettled(),
    unreadable: (error, inARow) =>
      folded(
        "memory unreadable",
        (count) =>
          opts.log?.warn("previews.memory.unreadable", {
            error: String(error),
            inARow,
            level: guard?.level ?? "normal",
            folded: count,
          }),
      ),
    failed: (error) =>
      folded(
        "memory check failed",
        (count) =>
          (opts.log?.error ?? opts.log?.warn)?.call(opts.log, "previews.memory.failed", {
            error: String(error),
            level: guard?.level ?? "normal",
            folded: count,
          }),
      ),
  });
  guard?.start(SAMPLE_MS);
  let closed = false;

  /**
   * What each group (a run, or `relay:<shard>`) holds, as far as the service can measure it: its
   * streams' unread bytes either way and their clients' (the kernel's buffers included while they
   * fill), and what each stream holding any costs beyond them (`GroupUsage.overhead`: its parser,
   * roughly, or its client's kernel buffers too where nobody measures them), its tunnels' send
   * queues, and its waiting requests' bodies, read or paused unread. A stream holding nothing is
   * not counted at all: an idle one holds next to nothing, and counting it would name a run for
   * its open tabs.
   */
  function attributed(): Map<unknown, number> {
    const held = new Map<unknown, number>();
    const add = (group: unknown, bytes: number) => {
      if (bytes > 0) held.set(group, (held.get(group) ?? 0) + bytes);
    };
    for (const [group, use] of budget.usage()) {
      add(group, use.buffered + use.overhead);
    }
    for (const entry of entries.values()) add(entry.runId, entry.tunnel?.bufferedAmount ?? 0);
    for (const [group, bytes] of early.byGroup()) add(group, bytes);
    for (const [group, bytes] of early.pausedByGroup()) add(group, bytes);
    return held;
  }

  /** Cuts every tunnel of the groups `named` names whose queue is more than TUNNEL_SLACK past what
   * its streams are owed; returns what their queues held. Their runners re-register. */
  function cutQueues(named: (group: unknown) => boolean): number {
    let freed = 0;
    for (const entry of [...entries.values()]) {
      if (!named(entry.runId) || (entry.mux?.excess() ?? 0) <= TUNNEL_SLACK) continue;
      freed += entry.tunnel?.bufferedAmount ?? 0;
      refused(entry.runId, "memory", "memory-tunnel");
      cut(entry, "memory");
    }
    return freed;
  }

  /**
   * Names the culprits at a sample at or past HIGH's watermark (in the band below it, on the way
   * down, it only keeps and releases them): `culpritsOf` what the groups hold, against the growth
   * since the (capped) baseline, and not within SHED_HOLD_MS of the last naming or material
   * closing unless usage rose NAMING_RISE since; with no baseline yet, nobody. Releases those that
   * have held less than CULPRIT_MIN for CULPRIT_RELEASE_MS. Says what it named, and when it could
   * name nobody: for want of an explanation (`unexplained`), or because what explains the growth
   * is spread so thin no group holds its share of it (`no_culprit`).
   */
  function name(level: Exclude<Pressure, "normal">, reading: MemoryReading) {
    const held = attributed();
    let total = 0;
    for (const bytes of held.values()) total += bytes;
    const at = now();
    const released: unknown[] = [];
    for (const [group, state] of culprits) {
      if ((held.get(group) ?? 0) >= CULPRIT_MIN) state.below = null;
      else if (state.below === null) state.below = at;
      else if (at - state.below >= CULPRIT_RELEASE_MS) released.push(group);
    }
    for (const group of released) culprits.delete(group);
    // Capped (the guard's `baseline`), so it is never within 2 × HYSTERESIS of the watermark: at
    // a naming sample `over` is at least that much of the limit, which a run holding a little
    // never explains, however long the pod sat just under HIGH first.
    const baseline = guard!.baseline;
    const over = Math.max(0, reading.used - (baseline ?? 0));
    const named: unknown[] = [];
    // Below the watermark the pod is on its way down, or the counter has not caught up with what
    // was closed; and just after a naming, the same: nobody new.
    const naming = reading.used >= guard!.highBytes &&
      (lastFreed === null || at - lastFreed.at >= SHED_HOLD_MS ||
        reading.used >= lastFreed.used + reading.limit * NAMING_RISE);
    const explained = baseline !== null && total * EXPLAINED >= over;
    if (naming && explained) {
      const found = culpritsOf(held, over);
      for (const group of found) {
        if (culprits.has(group)) continue;
        culprits.set(group, { below: null });
        named.push(group);
      }
      if (named.length > 0) lastFreed = { at, used: reading.used };
      if (found.length === 0) {
        // The runs' bytes explain the growth, but spread so thin that none holds its share of
        // it: nobody is named, and HIGH does nothing more until CRITICAL. Said, with the largest
        // holder, so it is never silent.
        let largest: [unknown, number] = [null, 0];
        for (const [group, bytes] of held) if (bytes > largest[1]) largest = [group, bytes];
        folded("memory no culprit", (count) =>
          opts.log?.warn("previews.memory.no_culprit", {
            level,
            ...memoryFields(),
            usedMiB: mib(reading.used),
            baselineMiB: mib(baseline!),
            attributedMiB: mib(total),
            overMiB: mib(over),
            holders: held.size,
            largest: largest[0] === null
              ? null
              : { ...who(String(largest[0])), heldMiB: mib(largest[1]) },
            folded: count,
          }));
      }
    } else if (naming) {
      folded("memory unexplained", (count) =>
        opts.log?.warn("previews.memory.unexplained", {
          level,
          ...memoryFields(),
          usedMiB: mib(reading.used),
          baselineMiB: baseline === null ? null : mib(baseline),
          attributedMiB: mib(total),
          overMiB: mib(over),
          folded: count,
        }));
    }
    if (named.length > 0 || released.length > 0) {
      opts.log?.warn("previews.memory.culprits", {
        level,
        ...memoryFields(),
        baselineMiB: baseline === null ? null : mib(baseline),
        overMiB: mib(over),
        attributedMiB: mib(total),
        // The culprits holding the most, and what each holds.
        held: [...culprits.keys()]
          .map((group) => ({ group, bytes: held.get(group) ?? 0 }))
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 16)
          .map(({ group, bytes }) => ({ ...who(String(group)), heldMiB: mib(bytes) })),
        released: released.length,
        ...culpritFields(culprits),
      });
    }
  }

  /**
   * Renews the naming hold-off for `freed` bytes just closed: only when they are CULPRIT_MIN or
   * more, and from what the pod held at the first closing of the hold-off it renews, so neither a
   * trickle of small closings nor a pod that keeps rising while they go keeps it going.
   */
  function freedNow(freed: number, reading: MemoryReading) {
    if (freed < CULPRIT_MIN) return;
    const at = now();
    const within = lastFreed !== null && at - lastFreed.at < SHED_HOLD_MS;
    lastFreed = { at, used: within ? lastFreed!.used : reading.used };
  }

  /** What the guard has the service do at every sample past HIGH. */
  function press(level: Exclude<Pressure, "normal">, reading: MemoryReading) {
    const g = guard!;
    name(level, reading);
    const culprit = (group: unknown) => culprits.has(group);
    // Idle connections cost memory too, and the balancer opens another when it needs one; but one
    // quiet for less than PRESSURE_IDLE_MS may be about to be reused. Once an episode for those,
    // and every sample for the tunnel listener's that have not dialled a tunnel and have been
    // idle MIN_IDLE_MS (connections.ts).
    if (!idleClosed) {
      idleClosed = true;
      connections.closeIdle(Infinity, { idleMs: PRESSURE_IDLE_MS });
      peerConnections.closeIdle(Infinity, { idleMs: PRESSURE_IDLE_MS });
    }
    tunnelConnections.closeIdle(Infinity, { untrustedOnly: true });
    if (level === "high") {
      // Culprits lose every stream holding bytes, and their tunnels' queues past the slack.
      if (culprits.size === 0) return;
      const cutFreed = cutQueues(culprit);
      const relief = budget.relieve(level, culprit);
      freedNow(cutFreed + relief.freed, reading);
      return;
    }
    // CRITICAL: everyone's line goes, nothing new is let in (`pressureOf`), and every tunnel's
    // queue past the slack is cut.
    budget.empty(level, () => true);
    let freed = cutQueues(() => true);
    const at = now();
    if (at - lastShed >= SHED_HOLD_MS || reading.used >= reading.limit * PANIC) {
      lastShed = at;
      const over = reading.used - g.highBytes - freed;
      const shed = over > 0 ? budget.shed(over, culprit) : { closed: 0, freed: 0 };
      freed += shed.freed;
      freedNow(freed, reading);
      nothingToShed = freed === 0;
      if (!nothingToShed) unstick();
      // Loud, every time: viewers just lost streams so that every run on the pod would not.
      if (shed.closed > 0) {
        opts.log?.warn("previews.memory.shed", {
          ...memoryFields(),
          overMiB: mib(over),
          closed: shed.closed,
          freedMiB: Math.round(shed.freed / 2 ** 20),
          ...culpritFields(culprits),
        });
      }
    }
    // Stuck — at CRITICAL at least STUCK_CRITICAL_MS, and the latest shed found nothing to close:
    // nothing it does brings the pod back. A restart does; its runners re-register.
    const criticalFor = at - (g.criticalSince ?? at);
    if (stuck === null && nothingToShed && criticalFor >= STUCK_CRITICAL_MS) {
      stuck = `critical for ${
        Math.round(criticalFor / 1000)
      } s and the latest shed found nothing to close`;
      (opts.log?.error ?? opts.log?.warn)?.call(opts.log, "previews.memory.stuck", {
        reason: stuck,
        ...memoryFields(),
      });
    }
  }

  /** The groups named, as a log says them: runs by id, relays by shard. Never more than a few. */
  function culpritFields(named: Map<unknown, unknown>) {
    const all = [...named.keys()].map(String);
    return {
      runs: all.filter((one) => !one.startsWith("relay:")).slice(0, 16),
      shards: all.filter((one) => one.startsWith("relay:")).map((one) => one.slice(6)).slice(0, 16),
      culprits: all.length,
    };
  }

  const mib = (bytes: number) => Math.round(bytes / 2 ** 20);
  /** A group as a log says it: a run by id, a relay by shard. */
  const who = (group: string) =>
    group.startsWith("relay:") ? { shard: group.slice("relay:".length) } : { runId: group };

  /**
   * The level's changes, said as they happen, at most one line per REFUSED_LOG_MS; changes in
   * between are counted, and once the window is over the next sample says where it then stands
   * (`levelSettled`), so the last line about the level is always the level it is at.
   */
  let levelSaid = { at: -Infinity, level: "normal" as Pressure, unsaid: 0 };
  function levelChanged(previous: Pressure) {
    const at = now();
    if (at - levelSaid.at < REFUSED_LOG_MS) {
      levelSaid.unsaid++;
      return;
    }
    sayLevel(previous, at);
  }
  function levelSettled() {
    if (levelSaid.unsaid > 0 && now() - levelSaid.at >= REFUSED_LOG_MS) {
      sayLevel(levelSaid.level, now());
    }
  }
  function sayLevel(previous: Pressure, at: number) {
    const level = guard?.level ?? "normal";
    opts.log?.warn("previews.memory.pressure", {
      level,
      previous,
      ...memoryFields(),
      folded: levelSaid.unsaid,
    });
    levelSaid = { at, level, unsaid: 0 };
  }

  /** The guard's last sample, in whole MiB. */
  const memoryFields = () => {
    const last = guard?.last;
    return {
      memoryMiB: last ? Math.round(last.used / 2 ** 20) : null,
      limitMiB: last ? Math.round(last.limit / 2 ** 20) : null,
      source: guard?.source.kind ?? null,
    };
  };
  /** What the service holds now, for the periodic line and for tests. */
  function stats(): Record<string, unknown> {
    const usage = process.memoryUsage();
    return {
      ...memoryFields(),
      level: guard?.level ?? "normal",
      culprits: culprits.size,
      stuck: stuck !== null,
      attributedMiB: Math.round([...attributed().values()].reduce((a, b) => a + b, 0) / 2 ** 20),
      earlyMiB: Math.round(early.total / 2 ** 20),
      rssMiB: Math.round(usage.rss / 2 ** 20),
      heapMiB: Math.round(usage.heapUsed / 2 ** 20),
      previews: entries.size,
      open: budget.open,
      long: budget.long,
      relayed: budget.relayed,
      waiting: budget.waiting,
      publicConnections: connections.size,
      peerConnections: peerConnections.size,
      tunnelConnections: tunnelConnections.size,
      untrustedConnections: tunnelConnections.untrusted,
      apiConnections: apiConnections.size,
    };
  }
  // Once a minute while anything is open, what the pod holds, for log-based metrics: never a
  // ticket, a cookie or a header.
  const statsTimer = setInterval(() => {
    if (entries.size === 0 && budget.open === 0 && connections.size === 0) return;
    opts.log?.info("previews.memory", stats());
  }, STATS_MS);
  (statsTimer as { unref?: () => void }).unref?.();

  // What a person meets as a 503 is said here too, or nobody sees honest users hitting a cap: once
  // per run (or shard, for a relay) and reason per REFUSED_LOG_MS, with how many were folded in.
  // Never a ticket, a cookie or a header: the run and the reason are all it says.
  // A relay's line names the shard, which is the first 8 hex of every preview id of its run (and
  // of the runs' `preview.registered` lines), so it joins to its run there.
  const lastRefused = new Map<string, { at: number; folded: number }>();
  function refused(group: string, why: Refusal | "peer unreachable", cap: CapName) {
    folded(
      `${group} ${why} ${cap}`,
      (count) =>
        opts.log?.warn("preview.refused", { ...who(group), reason: why, cap, folded: count }),
    );
  }
  /** Says `key`'s line once per REFUSED_LOG_MS, with how many were folded into it since. */
  function folded(key: string, say: (folded: number) => void) {
    const seen = lastRefused.get(key);
    const at = now();
    if (seen !== undefined && at - seen.at < REFUSED_LOG_MS) {
      seen.folded++;
      return;
    }
    lastRefused.delete(key);
    if (lastRefused.size >= REFUSED_KEYS) {
      for (const [old, held] of lastRefused) {
        if (at - held.at >= REFUSED_LOG_MS) lastRefused.delete(old);
      }
      // Still full, of keys all heard from just now: the oldest go.
      for (const old of lastRefused.keys()) {
        if (lastRefused.size < REFUSED_KEYS) break;
        lastRefused.delete(old);
      }
    }
    lastRefused.set(key, { at, folded: 0 });
    say(seen?.folded ?? 0);
  }

  const open = (entry: Entry) => entry.tunnel?.readyState === WebSocket.OPEN;
  /** Sets `entry`'s pending registration (or none), keeping `pendingTickets` in step. */
  function setPending(entry: Entry, pending: Entry["pending"]) {
    if (entry.pending !== null) pendingTickets.delete(entry.pending.ticket);
    entry.pending = pending;
    if (pending !== null) pendingTickets.set(pending.ticket, entry);
  }
  /** The preview a live ticket is for: a lookup by the ticket itself, never a scan comparing it
   * to each. */
  const pendingFor = (value: string) => {
    const entry = pendingTickets.get(value);
    return entry !== undefined && entries.get(entry.id) === entry &&
        entry.pending !== null && entry.pending.expires > now()
      ? entry
      : undefined;
  };

  // Every tunnel that goes is terminated, never closed: a close frame queues behind whatever the
  // socket has not sent, and ws then keeps the socket, and that backlog, for up to 30 s where
  // nothing here counts it. The runner re-registers on any close, so nothing is lost by it.
  function drop(entry: Entry, why: string) {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    setPending(entry, null);
    dropped.delete(entry.id);
    dropped.set(entry.id, { runId: entry.runId, until: now() + DROPPED_MS });
    entry.mux?.close();
    entry.tunnel?.terminate();
    opts.log?.info("preview.closed", { id: entry.id, runId: entry.runId, why });
  }

  /** Terminates the preview's tunnel; the preview goes with it unless a re-registration is about
   * to dial. */
  function cut(entry: Entry, why: string) {
    const socket = entry.tunnel;
    if (socket === null) return;
    socket.terminate();
    lost(entry, socket, why);
  }

  /** A tunnel that ended: the preview goes with it, unless a re-registration is about to dial. */
  function lost(entry: Entry, socket: Tunnel, why = "tunnel closed") {
    if (entry.tunnel !== socket) return;
    entry.mux?.close();
    entry.tunnel = null;
    entry.mux = null;
    if (entry.pending === null || entry.pending.expires <= now()) drop(entry, why);
  }

  /** A stream of the preview's tunnel; `long` for one that may never end (see `lasting`), and
   * `waitMs` for a request that already waited on the pod that relayed it. */
  const connect =
    (entry: Entry, long: boolean, waitMs?: number) => (signal: AbortSignal): Promise<Duplex> => {
      if (entries.get(entry.id) !== entry || !open(entry) || !entry.mux) {
        return Promise.reject(new Error("preview disconnected"));
      }
      return entry.mux.stream(signal, { long, waitMs });
    };

  /** A person's page load that found no stream is told to wait a moment, and tries again. */
  const unavailable = (req: IncomingMessage): ProxyHooks =>
    navigation(req) ? { unavailable: (res) => page(res, 503, MOVING, true) } : {};

  const hooks = (entry: Entry, req: IncomingMessage): ProxyHooks => {
    const target = { port: entry.port, origin: origin(place, entry.id), csp: entry.csp };
    return {
      request: (headers) => upstreamHeaders(headers, target),
      response: (headers) => downstreamHeaders(headers, target),
      early: early.for(entry.runId),
      ...unavailable(req),
    };
  };

  async function viewer(req: IncomingMessage, id: string): Promise<boolean> {
    const cookies = cookieValues(req.headers.cookie, cookieName(place.scheme));
    // Over http the name has no `__Host-` prefix, so a sibling preview can toss decoys at it with
    // longer paths, which sort first: the first few that could be one are checked, one HMAC each,
    // and a page that buries the viewer's own under more is refused, as it asked to be. Not just
    // the first: one well-formed decoy (any 64 hex digits and a time) would then lock the viewer
    // out.
    let checked = 0;
    for (const value of cookies) {
      if (!viewerCookieShaped(value, now())) continue;
      if (await viewerCookieValid(k, id, value, now())) return true;
      if (++checked >= MAX_COOKIES) break;
    }
    return false;
  }

  // ---- internal -----------------------------------------------------------------------------

  // Registrations lately, per run and per run's port: tokens left and when they were counted.
  const registrations = new Map<string, { tokens: number; at: number }>();
  /** The tokens in `key`'s bucket now, which holds `burst` and gains one every `everyMs`. */
  function tokens(key: string, burst: number, everyMs: number): number {
    const held = registrations.get(key);
    return held === undefined ? burst : Math.min(burst, held.tokens + (now() - held.at) / everyMs);
  }
  /** Takes a token from every bucket of `buckets`, or from none when any is empty: false then. */
  function take(...buckets: [key: string, burst: number, everyMs: number][]): boolean {
    const left = buckets.map((bucket) => tokens(...bucket));
    if (left.some((one) => one < 1)) return false;
    buckets.forEach(([key], i) => keep(key, left[i] - 1));
    return true;
  }
  function keep(key: string, tokens: number) {
    const at = now();
    registrations.delete(key);
    registrations.set(key, { tokens, at });
    // Forgotten once full again; a backstop past ENDED keys, the oldest first.
    for (const [old, one] of registrations) {
      if (registrations.size <= ENDED && at - one.at < REGISTER_BURST_RUN * REGISTER_EVERY_RUN_MS) {
        break;
      }
      registrations.delete(old);
    }
  }

  async function register(input: unknown): Promise<Response> {
    const { runId, port, label, hosts } = (input ?? {}) as Record<string, unknown>;
    if (
      typeof runId !== "string" || !RUN_ID.test(runId) ||
      !Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535 ||
      typeof label !== "string" || label.length < 1 || label.length > 80
    ) {
      return json(400, { error: "port must be 1024–65535 and label 1–80 characters" });
    }
    if (
      hosts !== null &&
      (!Array.isArray(hosts) || hosts.length > MAX_HOSTS ||
        !hosts.every((host) => typeof host === "string" && validHost(host)))
    ) {
      return json(400, { error: "hosts must be null or a list of hostnames" });
    }
    const id = await previewId(k, runId, port as number);
    // Nothing awaits from here on, so concurrent registrations cannot both slip under a limit.
    if (closed) return json(503, { error: "shutting down" });
    // Each registration replaces its port's tunnel: a runner that registers in a loop churns
    // tunnels, and their buffers, as fast as it likes. A few, then a pace; the runner retries a
    // 429 with its backoff.
    if (
      !take(
        [`run ${runId}`, REGISTER_BURST_RUN, REGISTER_EVERY_RUN_MS],
        [`port ${runId} ${port}`, REGISTER_BURST_PORT, REGISTER_EVERY_PORT_MS],
      )
    ) {
      folded(`${runId} registering`, (count) =>
        opts.log?.warn("preview.refused", {
          runId,
          reason: "registering too often",
          cap: "register",
          folded: count,
        }));
      return json(429, { error: "registering too often" });
    }
    let entry = entries.get(id);
    if (!entry) {
      const own = [...entries.values()].filter((e) => e.runId === runId).length;
      if (own >= PREVIEWS_PER_RUN || entries.size >= TOTAL) {
        return json(429, { error: "preview limit reached" });
      }
      // A run the control plane said ended does not come back; if it does, it is its own word.
      ended.delete(id);
      dropped.delete(id);
      entry = {
        id,
        runId,
        port: port as number,
        label,
        url: origin(place, id),
        csp: "",
        pending: null,
        tunnel: null,
        mux: null,
        lastPing: now(),
      };
      entries.set(id, entry);
    }
    // Again for the same port: the new details, and a new ticket. The tunnel already open keeps
    // serving until the new one connects.
    entry.label = label;
    entry.csp = contentSecurityPolicy(hosts as string[] | null);
    const pending = { ticket: ticket(), expires: now() + TUNNEL_TICKET_MS };
    setPending(entry, pending);
    opts.log?.info("preview.registered", { id, runId, port });
    return json(201, {
      id,
      url: entry.url,
      ticket: pending.ticket,
      // With several replicas the runner dials this pod itself, by its own address: any other pod
      // holds no such ticket, and refuses it.
      ...(cluster === null ? {} : { tunnelBase: tunnelBase(cluster.peers[self]) }),
    });
  }

  function list(runId: string): Response {
    return json(200, {
      previews: [...entries.values()]
        .filter((e) => e.runId === runId && open(e))
        .map(({ id, port, label, url }) => ({ id, port, label, url })),
    });
  }

  async function viewerTicket(input: unknown, id: string): Promise<Response> {
    const { runId, path } = (input ?? {}) as { runId?: unknown; path?: unknown };
    const known = entries.get(id);
    if (!known || known.runId !== runId || !open(known)) return json(404, { error: "not found" });
    // Signed before anything is counted, so nothing awaits between the counting and the keeping.
    const value = await mintViewerTicket(k, id, now());
    const entry = entries.get(id);
    if (!entry || entry.runId !== runId || !open(entry)) return json(404, { error: "not found" });
    sweepTickets();
    // Insertion order is age order, so the first found are the oldest.
    const own = [...viewerTickets].filter(([, held]) => held.id === id);
    const excess = Math.max(0, own.length + 1 - VIEWER_TICKETS_PER_PREVIEW);
    for (const [old] of own.slice(0, excess)) {
      viewerTickets.delete(old);
    }
    for (const [old] of viewerTickets) {
      if (viewerTickets.size < MAX_VIEWER_TICKETS) break;
      viewerTickets.delete(old);
    }
    viewerTickets.set(value, { id, expires: now() + VIEWER_TICKET_MS, path: landing(path) });
    return json(200, { url: `${entry.url}/__ryph/enter?ticket=${value}` });
  }

  /** Which run a preview belongs to, for the control plane's open by preview id alone (the link a
   * cookieless page load is sent to names nothing else). Known is enough: whether its tunnel is
   * open is the viewer ticket's to say. */
  function lookup(id: string): Response {
    const entry = entries.get(id);
    return entry ? json(200, { runId: entry.runId }) : json(404, { error: "not found" });
  }

  /** The runner's upgrade: its single-use ticket is the credential, and its connection is trusted
   * (connections.ts) once the ticket is spent on a tunnel, never before: a dial refused here
   * leaves its ticket unspent, and must not leave a trusted connection behind, or one ticket would
   * buy as many as a run cares to dial. */
  function dialled(req: IncomingMessage, client: Duplex, head: Uint8Array, value: string) {
    const refuse = (status: string) => refuseUpgrade(client, status);
    if (closed) return refuse("503 Service Unavailable");
    const entry = pendingFor(value);
    if (!entry) return refuse("404 Not Found");
    if (req.headers.upgrade?.toLowerCase() !== "websocket") return refuse("400 Bad Request");
    // A runner built against other framing: refused before its ticket is spent, and said so.
    // Said once a while per run, as refusals are: a runner may dial again and again, each
    // re-registration a new ticket.
    const offered = req.headers["sec-websocket-protocol"];
    if (!offersTunnelProtocol(offered)) {
      folded(`${entry.runId} protocol`, (count) =>
        opts.log?.warn("preview.tunnel.protocol", {
          id: entry.id,
          runId: entry.runId,
          offered: String(offered ?? "").slice(0, 200),
          expected: TUNNEL_PROTOCOL,
          folded: count,
        }));
      return refuse("400 Bad Request");
    }
    setPending(entry, null);
    tunnels.handleUpgrade(req, client, head, (socket) => {
      tunnelConnections.trust(client);
      socket.binaryType = "arraybuffer";
      const previous = { tunnel: entry.tunnel, mux: entry.mux };
      entry.tunnel = socket;
      entry.mux = hostMux(socket, { budget, group: entry.runId });
      entry.lastPing = now();
      // The re-registration's tunnel replaces the old one, whose close is then not this entry's;
      // terminated, so its queue goes with it.
      previous.mux?.close();
      previous.tunnel?.terminate();
      const mux = entry.mux;
      socket.on("close", () => lost(entry, socket));
      // A broken wire, whatever broke it: an oversized frame or a fragmented message (ws would
      // read and discard the rest while it waits for a closing handshake), a control frame (a
      // ping would otherwise be answered with a pong queued past any backlog check), a message
      // the mux refuses.
      const broken = () => {
        socket.terminate();
        lost(entry, socket, "tunnel broken");
      };
      socket.on("error", broken);
      socket.on("ping", broken);
      socket.on("pong", broken);
      socket.on("message", (data: ArrayBuffer | Uint8Array, binary: boolean) => {
        const received = mux.receive(binary ? data : utf8.decode(data));
        if (received === "invalid") broken();
        else if (received === "ping" && entry.tunnel === socket) entry.lastPing = now();
      });
      opts.log?.info("preview.tunnel", { id: entry.id, runId: entry.runId });
    });
  }

  /** The shard of the run a call names, or null when it names none (every pod answers that
   * alike, as its own). */
  const shardOfRun = async (runId: unknown) =>
    typeof runId === "string" && RUN_ID.test(runId) ? await shardOf(k, runId) : null;

  /**
   * The answer from the owner of `shard` when that is another pod; null when it is this one, or
   * when there is no shard (every pod answers that alike). A call that already `hopped` once is
   * never sent on: a pod that does not own the run under its own view says so (503), and the
   * control plane's caller retries.
   */
  async function elsewhere(
    req: Request,
    hopped: boolean,
    shard: string | null,
    body?: Uint8Array,
  ): Promise<Response | null> {
    if (cluster === null || shard === null) return null;
    const owner = ownerOfShard(shard);
    if (owner === self) return null;
    if (hopped) return json(503, { error: "not this replica's run" });
    const url = new URL(req.url);
    const answer = await forwardInternal(
      cluster.peers[owner],
      { method: req.method, path: url.pathname + url.search, body },
      { header: HOP_HEADER, credential: forwarding! },
      trackPeer,
    );
    if (answer === null || answer.status < 200 || answer.status > 599) {
      return json(503, { error: "previews replica unavailable" });
    }
    const empty = answer.status === 204 || answer.status === 205 || answer.status === 304;
    return new Response(empty ? null : answer.body, {
      status: answer.status,
      headers: {
        "cache-control": "no-store",
        ...(answer.contentType && !empty ? { "content-type": answer.contentType } : {}),
      },
    });
  }

  /** A route's JSON body, read whole (so it can be forwarded as read) and parsed; throws past
   * `max` bytes, or when it is not JSON. */
  async function body(req: Request, max: number): Promise<{ bytes: Uint8Array; input: unknown }> {
    const text = await readCapped(req, max);
    if (text === null) throw new Error("body too large");
    return { bytes: new TextEncoder().encode(text), input: JSON.parse(text) };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/internal/")) return json(404, { error: "not found" });
    // Another pod's forward carries the forward credential in place of the bearer, and has
    // hopped: it is never forwarded again. Either one, never both, and neither travels further.
    const hop = req.headers.get(HOP_HEADER);
    const hopped = hop !== null;
    if (hopped) {
      if (forwarding === null || !timingSafeEqual(hop, forwarding)) {
        return json(401, { error: "unauthorized" });
      }
    } else {
      if (!await k.bearer(bearerToken(req))) return json(401, { error: "unauthorized" });
    }
    const match = (r: { method: string; pattern: URLPattern }) =>
      r.method === req.method ? r.pattern.exec(url)?.pathname.groups : undefined;
    let groups;
    if (match(ROUTES.register)) {
      let read;
      try {
        read = await body(req, 128 * 1024);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const runId = (read.input as { runId?: unknown } | null)?.runId;
      return await elsewhere(req, hopped, await shardOfRun(runId), read.bytes) ??
        await register(read.input);
    }
    if ((groups = match(ROUTES.list))) {
      return await elsewhere(req, hopped, await shardOfRun(groups.runId)) ?? list(groups.runId!);
    }
    if ((groups = match(ROUTES.lookup))) {
      const id = groups.id!;
      if (!PREVIEW_ID.test(id)) return json(404, { error: "not found" });
      return await elsewhere(req, hopped, shardOfId(id)) ?? lookup(id);
    }
    if ((groups = match(ROUTES.viewer))) {
      let read;
      try {
        // A runId and a path of up to MAX_LANDING, escaped.
        read = await body(req, 8 * 1024);
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      const runId = (read.input as { runId?: unknown } | null)?.runId;
      return await elsewhere(req, hopped, await shardOfRun(runId), read.bytes) ??
        await viewerTicket(read.input, groups.id!);
    }
    if ((groups = match(ROUTES.forget))) {
      const forwarded = await elsewhere(req, hopped, await shardOfRun(groups.runId));
      if (forwarded) return forwarded;
      for (const entry of [...entries.values()]) {
        if (entry.runId !== groups.runId) continue;
        drop(entry, "run ended");
      }
      // Its previews dropped just before (a runner that went away as its run ended) are as ended.
      sweepDropped();
      for (const [id, held] of [...dropped]) {
        if (held.runId !== groups.runId) continue;
        dropped.delete(id);
        remember(id);
      }
      return new Response(null, { status: 204, headers: NO_STORE });
    }
    return json(404, { error: "not found" });
  }

  /** Remembers that `id`'s run ended, for as long as a cookie for it lasts. */
  function remember(id: string) {
    ended.delete(id);
    sweepEnded();
    for (const old of ended.keys()) {
      if (ended.size < ENDED) break;
      ended.delete(old);
    }
    ended.set(id, now() + COOKIE_TTL_S * 1000);
  }
  function sweepEnded() {
    for (const [id, until] of ended) {
      if (until > now()) break;
      ended.delete(id);
    }
  }
  function sweepDropped() {
    for (const [id, held] of dropped) {
      if (held.until > now()) break;
      dropped.delete(id);
    }
    // Every preview a pod ever held drops once: a backstop as large as what is remembered ended.
    for (const id of dropped.keys()) {
      if (dropped.size <= ENDED) break;
      dropped.delete(id);
    }
  }

  // ---- public -------------------------------------------------------------------------------

  /** Only the link itself spends a ticket: a HEAD or OPTIONS ahead of it (a link preview, a
   * prefetch) must not, here or on the way to the owner. */
  function onlyGet(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === "GET") return true;
    if (!res.headersSent) res.writeHead(405, { allow: "GET", "cache-control": "no-store" }).end();
    return false;
  }
  const ticketOf = (req: IncomingMessage) =>
    new URLSearchParams(req.url!.split("?")[1] ?? "").get("ticket") ?? "";

  /** `/__ryph/enter` on the owner: the ticket is spent, the cookie set. */
  async function enter(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!onlyGet(req, res)) return;
    const value = ticketOf(req);
    const held = viewerTickets.get(value);
    if (held) viewerTickets.delete(value);
    if (!held || held.id !== id || held.expires <= now()) {
      page(res, 403, EXPIRED);
      return;
    }
    const cookie = setViewerCookie(await viewerCookie(k, id, now()), place.scheme);
    if (res.headersSent || res.destroyed) return;
    res.writeHead(303, {
      location: held.path,
      "set-cookie": cookie,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }).end();
  }

  /**
   * A request without a viewer cookie. A page load (a link an agent posted, a pasted URL) is sent
   * to the app's open route for this preview, which asks the control plane for a ticket as the
   * person and brings them back to the same path; the route names the preview alone, so any pod
   * answers it here, owner or not, and nothing about the run leaves with it. Anything else is the
   * 401 page.
   */
  function stranger(req: IncomingMessage, res: ServerResponse, id: string) {
    if (opts.appUrl === undefined || !navigation(req)) return page(res, 401, NO_COOKIE);
    const wanted = landing(req.url);
    const query = wanted === "/" ? "" : `?path=${encodeURIComponent(wanted)}`;
    if (res.headersSent || res.destroyed) return;
    res.writeHead(303, {
      location: `${opts.appUrl}/previews/${id}${query}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }).end();
  }

  /**
   * The health routes, for a request whose Host is no name under the preview domain: the
   * kubelet's probes and a load balancer's health check ask by the pod's address. `/healthz`
   * fails while the pod is stuck (`press`), so the kubelet's liveness probe restarts it. The
   * answer is `ok` or `not ok` and nothing more: what the pod is going through is its log's to
   * say, not something anyone who can reach the listener may poll.
   */
  async function health(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (underDomain(place, req.headers.host)) return false;
    const url = new URL(req.url ?? "/", "http://health");
    const answer = (ok: boolean) => {
      res.writeHead(ok ? 200 : 503, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(ok ? "ok" : "not ok");
      return true;
    };
    if (req.method === "GET" && url.pathname === "/healthz" && stuck !== null) return answer(false);
    for (const route of opts.health ?? []) {
      if (route.method !== req.method || !route.pattern.test(url)) continue;
      const response = await route.handler(new Request(url.href), {});
      await response.body?.cancel();
      return answer(response.ok);
    }
    return false;
  }

  /**
   * A browser request, straight from the front door or `forwarded` by another pod over the peer
   * listener: the same code either way, so a forwarded request meets the same gate, cookie check
   * and header rewriting as a direct one. Only a request for a preview another pod owns differs:
   * sent there when it is direct, refused when it already hopped. What is sent there is a viewer's
   * request (its cookie checked here first: every pod holds the key, and the cookie is a MAC over
   * the preview id, and its gate) or the way in with a ticket whose MAC this pod checked, never
   * anything else, and it is counted against the run's relay caps here. This pod cannot map the id
   * to its run, so the run's key here is its shard, which is as much the run's as its id is (two
   * runs share one only by a 32-bit collision, and then share a cap).
   */
  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    forwarded: boolean,
    waitMs?: number,
  ) {
    const id = previewOf(place, req.headers.host);
    const path = pathOf(req.url);
    if (id === null || path === null) {
      if (id === null && path !== null && !forwarded && await health(req, res)) return;
      return page(res, 404, NOWHERE);
    }
    const owner = ownerOfShard(shardOfId(id));
    if (owner !== self && forwarded) return page(res, 503, MOVING, navigation(req));
    if (path === `${RESERVED}enter`) {
      if (owner === self) return await enter(req, res, id);
      if (!onlyGet(req, res)) return;
      // A forged, expired or another preview's ticket is answered here and reaches no other pod.
      if (!await viewerTicketValid(k, id, ticketOf(req), now())) return page(res, 403, EXPIRED);
      return await proxyHttp(req, res, relayTo(owner, id, false), peerHttpHooks(req, id));
    }
    if (path.startsWith(RESERVED)) return page(res, 404, NOWHERE);
    if (!await viewer(req, id)) return stranger(req, res, id);
    // The gate is the preview's own, and its origin is known from the id alone: judged here
    // before anything is relayed, so a sibling preview's page cannot have a viewer's browser
    // spend another run's relays on requests its owner would refuse anyway. The owner judges
    // again.
    if (!permitted(req.headers, origin(place, id), false) || serviceWorker(req.headers)) {
      if (!res.headersSent) res.writeHead(403, { "cache-control": "no-store" }).end();
      return;
    }
    if (owner !== self) {
      return await proxyHttp(
        req,
        res,
        relayTo(owner, id, lasting(req.headers)),
        peerHttpHooks(req, id),
      );
    }
    const entry = entries.get(id);
    if (!entry) {
      // A run the control plane said ended: for good, and said so, with no reload.
      sweepEnded();
      if (ended.has(id)) return page(res, 404, ENDED_PAGE);
      // Unknown here: a run that ended before this pod last started, or one whose runner has
      // not re-registered since (within a minute: its backoff). Nothing tells those apart.
      return page(res, 404, UNKNOWN, navigation(req));
    }
    // Registered again and not yet dialled, its old tunnel gone: back in a moment.
    if (!open(entry)) return page(res, 503, MOVING, navigation(req));
    await proxyHttp(req, res, connect(entry, lasting(req.headers), waitMs), hooks(entry, req));
  }

  /** A browser's upgrade, direct or `forwarded`, as `serve` above: only a viewer's, ever. */
  async function upgrade(
    req: IncomingMessage,
    client: Duplex,
    head: Uint8Array,
    forwarded: boolean,
  ) {
    upgraded.add(client);
    client.on("close", () => upgraded.delete(client));
    connections.upgraded(client);
    peerConnections.upgraded(client);
    const id = previewOf(place, req.headers.host);
    const path = pathOf(req.url);
    const refuse = (status: string) => refuseUpgrade(client, status);
    if (id === null || path === null || path.startsWith(RESERVED)) return refuse("404 Not Found");
    const owner = ownerOfShard(shardOfId(id));
    if (owner !== self && forwarded) return refuse("503 Service Unavailable");
    if (!await viewer(req, id)) return refuse("401 Unauthorized");
    // Before any relay, as for a plain request.
    if (!permitted(req.headers, origin(place, id), true)) return refuse("403 Forbidden");
    if (owner !== self) {
      return await proxyUpgrade(
        req,
        client,
        head,
        relayTo(owner, id, true),
        peerHooks,
        RELAY_UPGRADE_MS,
      );
    }
    const entry = entries.get(id);
    if (!entry) return refuse("404 Not Found");
    if (!open(entry)) return refuse("503 Service Unavailable");
    if (client.destroyed) return;
    await proxyUpgrade(req, client, head, connect(entry, true), hooks(entry, req));
  }

  /** Every listener's request timeout is off, as @ryph/service's `serve` has it: a slow upload
   * or a long download is the browser's to finish (Node's default cuts it at 300 s; Bun has
   * none). `maxConnections` is the hard ceiling Bun honours: past it a new connection is closed
   * at once. */
  const limited = (listener: Server, most: number) => {
    listener.requestTimeout = 0;
    listener.maxConnections = most;
    return listener;
  };
  /** The public listener keeps an idle connection past a Google Cloud load balancer's 600 s
   * reuse of it, as @ryph/service's `serve` does: one closed first is an empty 502. Bun ignores
   * `headersTimeout`; the front gives a connection's first request 10 s to send its headers
   * (`frontHttpServer`, as Bun does for the connections it accepts); it is set for Node. */
  const keptAlive = (listener: Server) => {
    listener.keepAliveTimeout = DEFAULT_KEEP_ALIVE_MS;
    listener.headersTimeout = DEFAULT_HEADERS_MS;
    return listener;
  };

  // The API listener: the control plane's calls, behind its bearer, and its peers' forwards of
  // them, behind the forward credential. No run reaches it.
  const api = limited(
    createServer((req, res) => {
      let request;
      try {
        request = toRequest(req);
      } catch {
        res.writeHead(400).end();
        return;
      }
      handle(request).then((response) => send(res, response)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    }),
    API_MAX,
  );
  api.on("connection", (socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    apiConnections.add(socket);
  });
  apiConnections.watch(api);
  // Nothing on it upgrades.
  api.on("upgrade", (_req: IncomingMessage, client: Duplex) => {
    client.on("error", () => client.destroy());
    refuseUpgrade(client, "404 Not Found");
  });

  // The TUNNEL listener: a runner's upgrade with its ticket, and nothing else. A plain request is
  // a 404 whatever it names, a pending ticket or not, so it tells nobody which tickets are live.
  // Every run reaches it: a connection that has not dialled a tunnel within UNTRUSTED_MS goes,
  // and past a few per address or in all one makes room for the next (connections.ts), so a run
  // that opens connections and sends nothing cannot take the pod's memory, nor keep a run at
  // another address from dialling.
  const tunnelListener = limited(
    createServer((_req, res) => {
      res.writeHead(404, { "cache-control": "no-store", connection: "close" }).end();
    }),
    TUNNEL_MAX,
  );
  tunnelListener.on("connection", (socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    tunnelConnections.add(socket);
  });
  tunnelConnections.watch(tunnelListener);
  tunnelListener.on("upgrade", (req: IncomingMessage, client: Duplex, head: Uint8Array) => {
    client.on("error", () => client.destroy());
    tunnelConnections.upgraded(client);
    let match = null;
    try {
      const url = new URL(req.url ?? "/", "http://tunnel");
      if (req.method === "GET") match = TUNNEL.exec(url);
    } catch { /* not a URL: not a tunnel */ }
    if (!match) return refuseUpgrade(client, "404 Not Found");
    // A ticket another pod holds is not this one's to follow: a 404, as any unknown one is.
    dialled(req, client, head, match.pathname.groups.ticket!);
  });

  // Fronted (`frontHttpServer`): its upgrades pipe a browser's socket to a tunnel stream, which
  // pauses it when the runner stops acking. Bun 1.4.2's own upgraded sockets did not pause; 1.4.4's
  // do, and the front stays for its keepalive and its upgrades closed on a FIN.
  const server = limited(
    keptAlive(frontHttpServer(createServer((req, res) => {
      // Only a peer's word counts, and only on the peer listener.
      delete req.headers[WAIT_HEADER];
      delete req.headers[CONNECTION_HEADER];
      serve(req, res, false).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    }))),
    PUBLIC_MAX,
  );
  server.on("connection", (socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    connections.add(socket);
  });
  connections.watch(server);
  server.on("upgrade", (req: IncomingMessage, client: Duplex, head: Uint8Array) => {
    client.on("error", () => client.destroy());
    delete req.headers[WAIT_HEADER];
    delete req.headers[CONNECTION_HEADER];
    upgrade(req, client, head, false).catch(() => client.destroy());
  });

  // ---- peers: forwarding ---------------------------------------------------------------------

  /**
   * Where a browser request for another pod's preview goes: a fresh connection to that pod's peer
   * listener, counted in this pod's budget to `group` under PER_RELAY like a tunnel stream. The
   * address comes from configuration by ordinal and nothing else; the Host has only picked which
   * ordinal, and only once it passed `previewOf`.
   */
  const relayTo = (owner: number, id: string, long: boolean): Connect => {
    const group = `relay:${shardOfId(id)}`;
    const peer = cluster!.peers[owner];
    const connect = relay(peer, peer.peerPort, trackPeer, { budget, group, long });
    return async (signal) => {
      try {
        return await connect(signal);
      } catch (error) {
        // The budget says its own refusals; an owner that cannot be reached is said here.
        if (error instanceof PeerUnreachable) refused(group, "peer unreachable", "peer");
        throw error;
      }
    };
  };
  /** An upgrade's head goes on as it came, plus this pod's peer credential, which replaces any a
   * client sent. Nothing about the hop is added: the owner sees the browser's own headers and
   * nothing else of ours. */
  const peerHooks: ProxyHooks = {
    request: (headers) => ({ ...headers, [PEER_HEADER]: credential! }),
  };
  /** A plain request's the same way: every header the browser sent but those always hop-by-hop
   * (which `proxyHttp` drops and re-frames), so even one the browser's `Connection` names reaches
   * the owner, whose gate judges exactly what this pod was sent, with the browser's `Connection`
   * itself beside it (CONNECTION_HEADER), so the owner drops those on the way to the dev server
   * as a direct request's are; and what is left of its wait for a stream, which it spent here
   * waiting for a relay. A page load that finds no room on the way is told to wait a moment. */
  const peerHttpHooks = (req: IncomingMessage, id: string): ProxyHooks => {
    const started = now();
    return {
      early: early.for(`relay:${shardOfId(id)}`),
      request: (_headers, original) => ({
        ...withoutHopByHop(original.headers),
        ...(original.headers.connection === undefined
          ? {}
          : { [CONNECTION_HEADER]: original.headers.connection }),
        [PEER_HEADER]: credential!,
        [WAIT_HEADER]: String(Math.max(0, WAIT_MS - (now() - started))),
      }),
      ...unavailable(req),
    };
  };

  /** True when `req` carries this cluster's peer credential. Taken off the request either way,
   * before anything else reads it. */
  function fromPeer(req: IncomingMessage): boolean {
    const presented = req.headers[PEER_HEADER];
    delete req.headers[PEER_HEADER];
    return typeof presented === "string" && credential !== null &&
      timingSafeEqual(presented, credential);
  }
  /** What a peer says is left of a relayed request's wait, taken off the request: whole
   * milliseconds up to WAIT_MS, or undefined (the whole wait) for anything else. */
  function waitLeft(req: IncomingMessage): number | undefined {
    const said = req.headers[WAIT_HEADER];
    delete req.headers[WAIT_HEADER];
    return typeof said === "string" && /^[0-9]{1,6}$/.test(said)
      ? Math.min(Number(said), WAIT_MS)
      : undefined;
  }

  // The PEER listener: browser requests another pod forwarded, served exactly as the public
  // listener serves its own, and never forwarded again.
  // Every relay is a connection of its own, closed after its request (`connection: close`), so
  // nothing here is kept alive past node's default; at most every other pod's relays at once.
  // Fronted as the public listener is: it relays browsers' upgrades the same way.
  const peer = cluster === null ? null : limited(
    frontHttpServer(createServer((req, res) => {
      if (!fromPeer(req)) {
        if (!res.headersSent) res.writeHead(403, { "cache-control": "no-store" }).end();
        return;
      }
      // The browser's own `Connection`, as the pod that relayed it was sent it.
      const connection = req.headers[CONNECTION_HEADER];
      delete req.headers[CONNECTION_HEADER];
      if (typeof connection === "string") req.headers.connection = connection;
      else delete req.headers.connection;
      serve(req, res, true, waitLeft(req)).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
    })),
    budget.relays * (replicas - 1) + 64,
  );
  peer?.on("connection", (socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    peerConnections.add(socket);
  });
  if (peer) peerConnections.watch(peer);
  peer?.on("upgrade", (req: IncomingMessage, client: Duplex, head: Uint8Array) => {
    client.on("error", () => client.destroy());
    if (!fromPeer(req)) {
      refuseUpgrade(client, "403 Forbidden");
      return;
    }
    // An upgrade's wait is its own (UPGRADE_TIMEOUT_MS), from the moment it arrived anywhere; its
    // own `Connection` travels as it is.
    delete req.headers[WAIT_HEADER];
    delete req.headers[CONNECTION_HEADER];
    upgrade(req, client, head, true).catch(() => client.destroy());
  });

  // ---- sweep --------------------------------------------------------------------------------

  function sweepTickets() {
    for (const [value, held] of viewerTickets) {
      if (held.expires <= now()) viewerTickets.delete(value);
    }
  }
  function sweep() {
    sweepTickets();
    sweepEnded();
    sweepDropped();
    for (const entry of [...entries.values()]) {
      if (entry.pending && entry.pending.expires <= now()) setPending(entry, null);
      if (entry.tunnel === null) {
        // Registered, but the runner never dialled in time.
        if (entry.pending === null) drop(entry, "never connected");
      } else if (now() - entry.lastPing > PING_TIMEOUT_MS) {
        // A quiet proxy may hold a dead socket open; the runner pings every 15 s.
        drop(entry, "no ping");
      } else if (entry.mux?.overBacklog()) {
        // Whatever queued it (the mux checks its own sends): a runner that does not read.
        cut(entry, "tunnel backlog");
      }
    }
  }
  const timer = setInterval(sweep, SWEEP_MS);

  let publicDown: Promise<void> | undefined;
  return {
    tunnel: tunnelListener,
    api,
    public: server,
    peer,
    budget,
    early,
    guard,
    stats,
    pressure: () => ({
      level: guard?.level ?? "normal",
      culprits: [...culprits.keys()].map(String),
    }),
    sweep,
    shutdownPublic() {
      if (publicDown) return publicDown;
      publicDown = Promise.all(
        [server, ...(peer ? [peer] : [])].map((listener) =>
          new Promise<void>((resolve) => {
            listener.close(() => resolve());
            // Idle keep-alives would hold the close until their own timeout.
            listener.closeIdleConnections?.();
          })
        ),
      ).then(() => clearTimeout(cut));
      // A WebSocket never finishes on its own; the browser reconnects, through whichever replica.
      // Reset, as every cut of an exchange still under way is (`reset`).
      for (const socket of upgraded) reset(socket);
      // Nor need an SSE stream, a long poll or a slow download, and the tunnels close only once
      // these are done: waiting on one would hold every preview of this pod's runs down until the
      // drain deadline, the listeners already shut, the runners not yet told to re-register. So
      // what is still in flight after a moment's grace is cut; a browser retries it, and its
      // runner re-registers at once.
      const cut = setTimeout(() => {
        for (const socket of [...connections.sockets(), ...peerConnections.sockets(), ...toPeers]) {
          reset(socket);
        }
      }, DRAIN_GRACE_MS);
      return publicDown;
    },
    close() {
      closed = true;
      clearInterval(timer);
      clearInterval(statsTimer);
      guard?.stop();
      for (const entry of [...entries.values()]) drop(entry, "shutting down");
      viewerTickets.clear();
      ended.clear();
      dropped.clear();
      for (const socket of connections.sockets()) reset(socket);
      for (const socket of upgraded) reset(socket);
      for (const socket of tunnelConnections.sockets()) socket.destroy();
      for (const socket of apiConnections.sockets()) socket.destroy();
      for (const socket of peerConnections.sockets()) reset(socket);
      // Relaying stops with it: every connection this pod opened to a peer.
      for (const socket of toPeers) reset(socket);
      tunnelListener.closeAllConnections?.();
      api.closeAllConnections?.();
      peer?.closeAllConnections?.();
    },
  };
}
