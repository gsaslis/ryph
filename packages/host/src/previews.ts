// Local-binary previews. Only loopback listeners are public; the runner dials OUT with a
// single-use ticket, and every browser connection rides that one socket as a stream
// (@ryph/tunnel). Tickets and preview hostnames are capabilities, never platform credentials.
// Nothing is persisted.
//
// Each preview gets a listener of its own on a free loopback port by default. A ryph in a
// container has no loopback a browser shares, so it can name ONE port instead (`listener`):
// every preview is served there, told apart by its host name, and the port can be published.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { json as jsonResponse, type Route, route } from "@ryph/shared/http";
import { frontHttpServer, type ServeHandler, type ServeHandlerInfo } from "@ryph/service";
import {
  Budget,
  type HostMux,
  hostMux,
  lasting,
  MAX_FRAME,
  offersTunnelProtocol,
  permitted,
  proxyHttp,
  proxyUpgrade,
  terminate,
  TUNNEL_PROTOCOL,
} from "@ryph/tunnel";

const json = (status: number, body: unknown) =>
  jsonResponse(status, body, { "cache-control": "no-store" });
const token = () => crypto.randomUUID().replaceAll("-", "");

// The connection each request came in on, for the one route that upgrades it (the tunnel below):
// a route sees only the request, and serve() hands the upgrade to the handler beside it.
const connections = new WeakMap<Request, ServeHandlerInfo>();

/**
 * `handler` as a serve() handler that remembers which connection each request arrived on, so a
 * route can accept a WebSocket upgrade there. It goes outermost, around anything that might pass
 * a different Request object on.
 */
export function acceptingUpgrades(
  handler: (req: Request) => Response | Promise<Response>,
): ServeHandler {
  return (req, info) => {
    connections.set(req, info);
    return handler(req);
  };
}

export interface Preview {
  id: string;
  port: number;
  label: string;
  url: string;
}

/** One port every preview shares, routed by host name (`<id>.localhost`). */
export interface PreviewListener {
  /** The port it listens on. */
  port: number;
  /** The address it binds: loopback unless something in front (a published port) needs more. */
  hostname: string;
  /** The port a browser reaches it at, when a published container port maps it elsewhere.
   * Unset is `port`. */
  publicPort?: number;
}

/** Browser connections one preview may hold open at once. */
const PREVIEW_CONNECTIONS = 32;
const PREVIEW_HOST = /^([0-9a-f]{32})\.localhost(?::\d+)?$/;

export function localPreviews(opts: {
  authenticateRunner(req: Request, runId: string): Promise<boolean>;
  authenticateReader(req: Request, runId: string): Promise<Response | null>;
  active(runId: string): Promise<boolean>;
  /** Serve every preview on this one port instead of a loopback listener each. */
  listener?: PreviewListener;
}) {
  type Entry = {
    runId: string;
    view: Preview;
    tunnel: WebSocket | null;
    mux: HostMux | null;
    tunnelTicket: string | null;
    lastPing: number;
    close(): void;
    /** A stream of the tunnel; `long` for one that may never end (`lasting` in @ryph/tunnel),
     * which may hold only part of the run's streams (PER_RUN's `long`). */
    connect(signal: AbortSignal, long?: boolean): Promise<Duplex>;
    request(req: IncomingMessage, res: ServerResponse): void;
    upgrade(req: IncomingMessage, client: Duplex, head: Buffer): void;
    /** Takes a browser connection on, or refuses it past the cap. Each counted once. */
    adopt(socket: Duplex): boolean;
  };
  const entries = new Map<string, Entry>();
  // Entries whose runner has not dialled yet, by their tunnel ticket: a lookup, never a scan.
  const byTicket = new Map<string, Entry>();
  let closed = false;
  // How many streams every preview's tunnels may hold in this process, and whose: the hosted
  // service's per-run counts, so one run's previews never take another's. No memory guard: this
  // process is the whole binary (the control plane, the app, every service), so its memory is not
  // the previews' to shed, and a desktop has no cgroup limit for it to be killed at.
  const budget = new Budget();
  const reservations = new Map<string, number>();

  // The shared listener, when there is one: started now, and `listening` says whether it came up,
  // so a port that is taken fails the boot rather than an agent's first preview. Which entry a
  // request is for is its host name.
  const entryFor = (req: IncomingMessage) => {
    const id = PREVIEW_HOST.exec(req.headers.host ?? "")?.[1];
    return id === undefined ? undefined : entries.get(id);
  };
  let shared: { server: Server; ready: Promise<number> } | null = null;
  if (opts.listener !== undefined) {
    // Fronted (`frontHttpServer`), as each preview's own listener is below.
    const server = frontHttpServer(createServer((req, res) => {
      const entry = entryFor(req);
      if (entry === undefined || !entry.adopt(req.socket)) res.writeHead(404).end();
      else entry.request(req, res);
    }));
    server.on("connection", (socket) => socket.on("error", () => socket.destroy()));
    server.on("upgrade", (req, client, head) => {
      const entry = entryFor(req);
      if (entry === undefined || !entry.adopt(client)) client.destroy();
      else entry.upgrade(req, client, head);
    });
    const { port, hostname } = opts.listener;
    const ready = new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, hostname, () => {
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("no address"));
        else resolve(address.port);
      });
    });
    // Never an unhandled rejection: whoever awaits `listening` is told.
    ready.catch(() => {});
    shared = { server, ready };
  }

  async function create(runId: string, port: number, label: string): Promise<Entry> {
    const id = token();
    const hostname = `${id}.localhost`;
    // Browser connections, counted apart from streams: idle browser keep-alives must not
    // starve the streams a page load needs.
    const sockets = new Set<Duplex>();
    let authority = "";
    let ended = false;
    // Opening the link from ryph is a top-level navigation. A foreign page silently fetching or
    // framing the preview is not, even if its author learned the hostname. Tools that are not
    // browsers send no Origin, and may still open a WebSocket on this loopback listener.
    const allowed = (req: IncomingMessage, upgrade: boolean) =>
      req.headers.host === authority && req.url?.startsWith("/") && !req.url.startsWith("//") &&
      permitted(req.headers, `http://${authority}`, upgrade, { originlessUpgrade: true });
    const entry: Entry = {
      runId,
      view: { id, port, label, url: "" },
      tunnel: null,
      mux: null,
      tunnelTicket: token(),
      lastPing: Date.now(),
      close() {
        if (ended) return;
        ended = true;
        clearTimeout(startup);
        entries.delete(id);
        if (entry.tunnelTicket !== null) byTicket.delete(entry.tunnelTicket);
        for (const socket of sockets) socket.destroy();
        entry.mux?.close();
        // At once, whatever it still has queued: a close frame would wait behind it.
        if (entry.tunnel) terminate(entry.tunnel);
        own?.close();
      },
      connect(signal: AbortSignal, long = false) {
        if (ended || entry.tunnel?.readyState !== WebSocket.OPEN || !entry.mux) {
          return Promise.reject(new Error("preview disconnected"));
        }
        return entry.mux.stream(signal, { long });
      },
      request(req, res) {
        if (!allowed(req, false)) res.writeHead(403).end();
        else void proxyHttp(req, res, (signal) => entry.connect(signal, lasting(req.headers)));
      },
      upgrade(req, client, head) {
        if (!allowed(req, true)) client.destroy();
        else void proxyUpgrade(req, client, head, (signal) => entry.connect(signal, true));
      },
      adopt(socket) {
        if (sockets.has(socket)) return true;
        if (ended || sockets.size >= PREVIEW_CONNECTIONS) return false;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        return true;
      },
    };
    // A listener of its own, unless every preview shares one.
    let own: Server | null = null;
    if (shared === null) {
      // Fronted (`frontHttpServer`): its upgrades pipe a browser's socket to a tunnel stream, which
      // pauses it when the runner stops acking. Bun 1.4.2's own upgraded sockets did not pause;
      // 1.4.4's do, and the front stays for its keepalive and its upgrades closed on a FIN.
      own = frontHttpServer(createServer((req, res) => entry.request(req, res)));
      own.maxConnections = PREVIEW_CONNECTIONS;
      // No headersTimeout: the front gives a first request its own deadline (FIRST_REQUEST_MS).
      own.on("connection", (socket) => {
        entry.adopt(socket);
        socket.on("error", () => socket.destroy());
      });
      own.on("upgrade", (req, client, head) => entry.upgrade(req, client, head));
    }
    // Registration without a connected runner cannot leave a listener behind.
    const startup = setTimeout(() => {
      if (entry.tunnel?.readyState !== WebSocket.OPEN) entry.close();
    }, 10_000);
    try {
      let port: number;
      if (own === null) {
        const bound = await shared!.ready.catch((err) => {
          throw new Error(
            `the preview listener on ${opts.listener!.hostname}:${opts.listener!.port} ` +
              `could not start: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        port = opts.listener!.publicPort ?? bound;
      } else {
        const server = own;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("no preview address");
        }
        port = address.port;
      }
      authority = `${hostname}:${port}`;
      entry.view.url = `http://${authority}`;
      if (closed) {
        entry.close();
        throw new Error("previews closed");
      }
      entries.set(id, entry);
      byTicket.set(entry.tunnelTicket!, entry);
      return entry;
    } catch (error) {
      entry.close();
      throw error;
    }
  }

  const runner = async (req: Request, runId: string) => {
    if (!await opts.authenticateRunner(req, runId)) return json(401, { error: "unauthorized" });
    if (!await opts.active(runId)) return json(410, { error: "run ended" });
    return null;
  };
  const routes: Route[] = [
    route(
      "GET",
      "/v1/runs/:runId/runner/previews",
      async (req, { runId }) => await runner(req, runId) ?? json(200, { enabled: true }),
    ),
    route("POST", "/v1/runs/:runId/runner/previews", async (req, { runId }) => {
      const refused = await runner(req, runId);
      if (refused) return refused;
      let input;
      try {
        const reader = req.body?.getReader();
        if (!reader) return json(400, { error: "missing body" });
        const chunks: number[] = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (chunks.length + value.length > 1024) {
              await reader.cancel();
              return json(400, { error: "preview request too large" });
            }
            chunks.push(...value);
          }
        } finally {
          reader.releaseLock();
        }
        input = JSON.parse(new TextDecoder().decode(new Uint8Array(chunks)));
      } catch {
        return json(400, { error: "invalid JSON" });
      }
      if (
        !input || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535 ||
        typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80
      ) {
        return json(400, { error: "port must be 1024–65535 and label 1–80 characters" });
      }
      const own = [...entries.values()].filter((e) => e.runId === runId);
      const creating = reservations.get(runId) ?? 0;
      const total = [...reservations.values()].reduce((sum, n) => sum + n, 0);
      if (closed || own.length + creating >= 4 || entries.size + total >= 64) {
        return json(429, { error: "preview limit reached" });
      }
      reservations.set(runId, creating + 1);
      try {
        const entry = await create(runId, input.port, input.label);
        // Dialled as the runner reached this route: the same origin, over ws(s).
        const tunnel = new URL(
          `/v1/local-previews/tunnel/${encodeURIComponent(entry.tunnelTicket!)}`,
          req.url,
        );
        tunnel.protocol = tunnel.protocol === "https:" ? "wss:" : "ws:";
        return json(201, {
          ...entry.view,
          ticket: entry.tunnelTicket,
          tunnel: tunnel.href,
          // Only whoever is at this machine reaches a loopback listener.
          audience: "machine",
        });
      } finally {
        const left = (reservations.get(runId) ?? 1) - 1;
        if (left === 0) reservations.delete(runId);
        else reservations.set(runId, left);
      }
    }),
    route("GET", "/v1/runs/:runId/previews", async (req, { runId }) => {
      const refused = await opts.authenticateReader(req, runId);
      if (refused) return refused;
      // One lookup for the run asked about; the sweep may not have caught up with its end.
      if (!await opts.active(runId).catch(() => false)) return json(200, { previews: [] });
      return json(200, {
        previews: [...entries.values()]
          .filter((e) => e.runId === runId && e.tunnel?.readyState === WebSocket.OPEN)
          .map((e) => e.view),
      });
    }),
    // The app opens a preview through here on every deployment; locally the answer is the
    // preview's own URL, since the loopback listener needs no viewer ticket.
    route("POST", "/v1/runs/:runId/previews/:previewId/open", async (req, { runId, previewId }) => {
      const refused = await opts.authenticateReader(req, runId);
      if (refused) return refused;
      if (!await opts.active(runId).catch(() => false)) return json(410, { error: "run ended" });
      const entry = entries.get(previewId);
      if (entry?.runId !== runId || entry.tunnel?.readyState !== WebSocket.OPEN) {
        return json(404, { error: "not found" });
      }
      return json(200, { url: entry.view.url });
    }),
    route("GET", "/v1/local-previews/tunnel/:ticket", (req, { ticket }) => {
      const entry = byTicket.get(ticket);
      if (!entry || !entries.has(entry.view.id)) {
        return json(404, { error: "not found" });
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(400, {});
      // A runner built against other framing fails here, its ticket unspent, and not mid-stream.
      if (!offersTunnelProtocol(req.headers.get("sec-websocket-protocol"))) {
        return json(400, { error: `the tunnel must speak ${TUNNEL_PROTOCOL}` });
      }
      // A listener that did not wire `acceptingUpgrades` cannot carry a tunnel.
      const connection = connections.get(req);
      if (connection === undefined) return json(501, { error: "no WebSocket upgrades here" });
      byTicket.delete(ticket);
      entry.tunnelTicket = null;
      // A frame is a 4-byte stream id and at most MAX_FRAME bytes; a longer one closes the socket
      // as its header arrives, rather than being buffered up to serve()'s 64 MiB default. A runner
      // never fragments a message, so the first continuation frame breaks the tunnel too, rather
      // than each costing a parse and the message's earlier ones held until it ends. The
      // runner's heartbeat is the mux's own "ping" (and the sweep below its deadline), so this end
      // sends no protocol pings, and a ping or pong from the runner ends the tunnel: answered, a
      // flood of pings it never reads would queue a pong each, past any backlog check.
      const { socket, response } = connection.upgradeWebSocket(req, {
        protocol: TUNNEL_PROTOCOL,
        maxPayload: MAX_FRAME + 4,
        maxFragments: 1,
        idleTimeout: 0,
        refusePings: true,
      });
      socket.binaryType = "arraybuffer";
      entry.tunnel = socket;
      entry.mux = hostMux(socket, { budget, group: entry.runId });
      socket.onclose = () => entry.close();
      socket.onerror = () => entry.close();
      socket.onmessage = ({ data }) => {
        const received = entry.mux!.receive(data);
        if (received === "invalid") entry.close();
        // A small heartbeat prevents quiet proxies from dropping an idle preview.
        else if (received === "ping") entry.lastPing = Date.now();
      };
      return response;
    }),
  ];
  // A backstop: a runner that exits closes its tunnel socket, which closes its previews at once.
  // So one lookup per run with previews every few seconds, never overlapping.
  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const runs = new Map<string, Entry[]>();
      for (const entry of entries.values()) {
        if (Date.now() - entry.lastPing > 45_000) entry.close();
        else runs.set(entry.runId, [...runs.get(entry.runId) ?? [], entry]);
      }
      for (const [runId, own] of runs) {
        const alive = await opts.active(runId).catch(() => false);
        if (!alive) { for (const entry of own) entry.close(); }
      }
    } finally {
      sweeping = false;
    }
  }
  const timer = setInterval(() => {
    void sweep().catch(() => {});
  }, 5000);
  return {
    routes,
    /** The shared listener's port once it listens; null when each preview has its own. */
    listening: shared?.ready ?? null,
    close() {
      closed = true;
      clearInterval(timer);
      for (const entry of entries.values()) entry.close();
      shared?.server.close();
    },
  };
}
