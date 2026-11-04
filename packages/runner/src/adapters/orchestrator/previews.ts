// Optional capability: the local binary and hosted deployments with a previews service. The run
// token only registers the preview; a single-use ticket, inside the tunnel URL the registration
// answers with, connects its one socket, which carries every browser connection as a stream
// (@ryph/tunnel). The browser never sees a platform credential.
import { connect } from "node:net";
import { runnerMux, TUNNEL_PROTOCOL } from "@ryph/tunnel";

/** Who can open a preview, as the registration answers it: `machine` for the local binary's
 * loopback listeners (whoever is at the machine running ryph), `run` for a hosted one (whoever can
 * see the run). */
export type Audience = "machine" | "run";

/** An exposed port, as the agent is told about it. */
export interface Exposure {
  url: string;
  audience: Audience;
}

export interface PreviewAccess {
  expose(port: number, label: string): Promise<Exposure>;
  close(): void;
}

/** Which loopback the server answers on: dev servers bound to `localhost` are often `::1` only. */
function listening(port: number): Promise<string | null> {
  const attempt = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (ok: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 2000);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return attempt("127.0.0.1").then(async (v4) =>
    v4 ? "127.0.0.1" : (await attempt("::1")) ? "::1" : null
  );
}

/** A registration that will never succeed by retrying: the request is invalid, the run ended, the
 * capability went away, the token stopped working, or the server is gone. */
class Final extends Error {}

const FINAL_STATUSES = new Set([400, 401, 404, 410]);
const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const HEARTBEAT_MS = 15_000;

/** One exposed port: its tunnel while up, and its reconnect state while down. */
interface Exposed {
  label: string;
  url: string;
  audience: Audience;
  ws: WebSocket | null;
  /** The registration and dial under way; every caller for this port shares it. */
  attempt: Promise<Exposure> | null;
  retry: ReturnType<typeof setTimeout> | undefined;
  delay: number;
}

export async function runnerPreviews(opts: {
  baseUrl: string;
  runId: string;
  runToken: string;
  /** The runner's own loopback listeners (its control API, its tool server, the browser
   * sidecar). They hold run credentials, so no preview may front them. Read at each call:
   * some bind after this is built. */
  reserved: () => Iterable<number>;
}): Promise<PreviewAccess | undefined> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const path = `${base}/v1/runs/${encodeURIComponent(opts.runId)}/runner/previews`;
  const headers = { authorization: `Bearer ${opts.runToken}`, "content-type": "application/json" };
  try {
    const available = await fetch(path, { headers, signal: AbortSignal.timeout(3000) });
    const body = await available.json();
    if (!available.ok || body.enabled !== true) return undefined;
  } catch {
    return undefined;
  }
  const tunnels = new Set<WebSocket>();
  // Ports with a tunnel up, or one being re-established after it dropped.
  const exposed = new Map<number, Exposed>();
  // First registrations under way: two calls for one port at once share one.
  const inflight = new Map<number, Promise<Exposure>>();
  let closed = false;

  function tunnelUrl(value: unknown): string {
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      throw new Final("preview registration answered without a tunnel URL");
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Final("preview registration answered with a tunnel URL that is not ws: or wss:");
    }
    return url.href;
  }

  /** Registers the port and dials its tunnel. Resolves once the tunnel is open and carrying. */
  async function register(
    port: number,
    label: string,
  ): Promise<Exposure & { ws: WebSocket; host: string }> {
    const host = await listening(port);
    if (host === null) {
      throw new Final(
        `Nothing is listening on port ${port} in this run (tried 127.0.0.1 and ::1). ` +
          "Start the server first, then expose it.",
      );
    }
    if (closed) throw new Final("run previews have closed");
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ port, label }),
      // Longer than the control plane's own 5 s wait on the previews service, so a slow service
      // reaches the agent as the control plane's 502, not as this abort.
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = `Preview registration refused (${response.status})`;
      throw FINAL_STATUSES.has(response.status) ? new Final(message) : new Error(message);
    }
    const preview = await response.json();
    // The subprotocol names the framing; a host that speaks other framing refuses the dial.
    const ws = new WebSocket(tunnelUrl(preview.tunnel), TUNNEL_PROTOCOL);
    ws.binaryType = "arraybuffer";
    tunnels.add(ws);
    // A registration that never connects must not stay in the set close() sweeps.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("preview tunnel timed out"));
      }, 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("preview tunnel failed"));
      };
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error("preview tunnel closed"));
      };
    }).catch((error) => {
      tunnels.delete(ws);
      throw error;
    });
    if (closed) {
      ws.close();
      tunnels.delete(ws);
      throw new Final("run previews have closed");
    }
    // Only the local binary answers `machine`; anything else, or nothing, is a hosted preview.
    const audience: Audience = preview.audience === "machine" ? "machine" : "run";
    return { url: preview.url, audience, ws, host };
  }

  /** Puts an open tunnel to work for `entry`; when it drops, the port is re-registered. */
  function carry(port: number, entry: Exposed, ws: WebSocket, host: string) {
    const mux = runnerMux(ws, () => connect({ host, port, allowHalfOpen: true }));
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, HEARTBEAT_MS);
    const since = Date.now();
    entry.ws = ws;
    ws.onclose = () => {
      clearInterval(heartbeat);
      tunnels.delete(ws);
      mux.close();
      if (entry.ws !== ws) return;
      entry.ws = null;
      // An attempt already under way (an expose() that saw this socket closing) replaces it.
      if (closed || exposed.get(port) !== entry || entry.attempt) return;
      // A tunnel that held for a while starts the backoff over; one that keeps dropping at
      // once does not.
      if (Date.now() - since >= MAX_RETRY_MS) entry.delay = FIRST_RETRY_MS;
      schedule(port, entry);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = ({ data }) => {
      if (mux.receive(data) === "invalid") ws.close();
    };
  }

  function schedule(port: number, entry: Exposed) {
    const delay = entry.delay;
    entry.delay = Math.min(delay * 2, MAX_RETRY_MS);
    entry.retry = setTimeout(() => {
      entry.retry = undefined;
      // Nobody waits on a background attempt; its failure only decides what happens next.
      reconnect(port, entry).catch(() => {});
    }, delay);
  }

  /** Re-registers a dropped port now, cutting any backoff wait short. */
  function reconnect(port: number, entry: Exposed): Promise<Exposure> {
    if (entry.attempt) return entry.attempt;
    clearTimeout(entry.retry);
    entry.retry = undefined;
    const attempt = register(port, entry.label).then(
      ({ url, audience, ws, host }) => {
        entry.url = url;
        entry.audience = audience;
        carry(port, entry, ws, host);
        return { url, audience };
      },
      (error) => {
        if (exposed.get(port) === entry) {
          if (closed || error instanceof Final) exposed.delete(port);
          else schedule(port, entry);
        }
        throw error;
      },
    ).finally(() => {
      entry.attempt = null;
    });
    entry.attempt = attempt;
    return attempt;
  }

  async function first(port: number, label: string): Promise<Exposure> {
    const { url, audience, ws, host } = await register(port, label);
    const entry: Exposed = {
      label,
      url,
      audience,
      ws: null,
      attempt: null,
      retry: undefined,
      delay: FIRST_RETRY_MS,
    };
    exposed.set(port, entry);
    carry(port, entry, ws, host);
    return { url, audience };
  }

  return {
    expose(port, label) {
      if (closed) return Promise.reject(new Error("run previews have closed"));
      if (
        !Number.isInteger(port) || port < 1024 || port > 65535 || label.length < 1 ||
        label.length > 80
      ) {
        return Promise.reject(new Error("port must be 1024–65535 and label 1–80 characters"));
      }
      if ([...opts.reserved()].includes(port)) {
        return Promise.reject(
          new Error(`port ${port} is one of ryph's own services in this run, not an application`),
        );
      }
      const existing = exposed.get(port);
      if (existing?.ws?.readyState === WebSocket.OPEN) {
        return Promise.resolve({ url: existing.url, audience: existing.audience });
      }
      // Dropped and waiting to come back: try now rather than racing a second registration.
      if (existing) return reconnect(port, existing);
      const pending = inflight.get(port);
      if (pending) return pending;
      const registering = first(port, label).finally(() => inflight.delete(port));
      inflight.set(port, registering);
      return registering;
    },
    close() {
      closed = true;
      for (const entry of exposed.values()) clearTimeout(entry.retry);
      exposed.clear();
      for (const ws of tunnels) ws.close();
    },
  };
}
