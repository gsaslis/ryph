// The run gate: the one door out of a confined docker run network, and it opens onto ryph alone.
//
// WHY IT EXISTS. Under docker, a run on an `--internal` network has no route anywhere — not the
// internet, not DNS for outside names, and not the host either (measured on Docker Desktop:
// `host.docker.internal` does not resolve there and the gateway refuses). That is the boundary
// wanted, minus one thing: the control plane, model proxy, MCP gateway, forge and egress proxy
// have to be reachable. So the provisioner puts this container on BOTH the internal run network
// and an ordinary one, and it relays a fixed list of TCP ports to where those services listen and
// nothing else (packages/orchestrator/src/adapters/provisioner/docker.ts). In the binary that is
// one place, the host-resident `ryph` process; in a networked deployment each port has a service
// of its own, so each route names its own target.
//
//   run  →  <gate>:7411  →  host.docker.internal:7411   control plane
//   run  →  <gate>:7460  →  host.docker.internal:7460   egress proxy — the only way to the internet
//   run  →  <gate>:22    →  nothing listens, so nothing answers
//
// BYTES, NOT A PROTOCOL. Every service behind it authenticates its own callers (run tokens,
// virtual keys, the egress claim), so there is nothing for this process to check — and nothing
// for it to hold. It carries no credential, reads no file and needs no shell; compromising it
// buys the ports it already relays.
//
// THE ROUTE LIST IS THE POLICY. A route is `<listen>=<host>:<port>`: what the gate listens on, and
// exactly where it relays. The short forms relay to the `--target` host, which they then require:
// a bare `<port>` to the same port there, `<listen>:<port>` to another. A port no route names is
// not listened on, and a target that is not listening simply refuses. What a run can reach is
// exactly this list; the egress proxy behind 7460 refuses loopback and private destinations, so it
// cannot be used to reach anything the list leaves out.
//
// Configuration is argv, so `docker inspect` of the gate reads as its whole policy:
//   run-gate [--per-source 256] 7411=host.docker.internal:7411 7460=egress-proxy:7460
//   run-gate --target host.docker.internal 7411 7420 7430 7460
//
// SHARED, SO BOUNDED PER RUN. Every confined run on the deployment goes through this one process,
// so one run must not be able to starve the rest: each source address (one run's container, its
// browser riding along in the same namespace) may hold `--per-source` relays at once and is
// refused past it, and the gate as a whole holds at most MAX_CONNECTIONS. A relay that carries
// nothing either way for IDLE_TIMEOUT_MS is closed, so an abandoned socket gives its slot back —
// long enough for a model stream between tokens or a long-poll to sit quiet.
//
// HALF-OPEN, AS TCP IS. A client that finishes its request and shuts down its writing half still
// wants the answer: each side's end is passed on as the other's end of writing, and the relay
// closes once both directions have ended.

import net from "node:net";
import process from "node:process";

/** How long a dial to the target may take before the run's connection is dropped. */
const DIAL_TIMEOUT_MS = 10_000;
/** A ceiling on open relays across every port, so the gate keeps file descriptors to spare (two
 * per relay; the provisioner sets the container's nofile limit well above twice this). */
export const MAX_CONNECTIONS = 4_096;
/** Relays one source address may hold at once, unless `--per-source` says otherwise. */
export const DEFAULT_PER_SOURCE = 256;
/** A relay quiet in both directions this long is closed. Any byte either way resets it. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;

export interface GateRoute {
  /** The port the gate listens on. */
  listen: number;
  /** The host it relays that port to, resolved per connection. */
  host: string;
  /** The port on `host` it relays to. */
  port: number;
}

export interface GateConfig {
  routes: GateRoute[];
  /** Relays one source address may hold at once. */
  perSource: number;
}

/** A target hostname: a DNS name or an IPv4 address, never anything that could read as a flag.
 * Every route's host is held to it, whichever form named it. */
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

function portOf(raw: string, item: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new Error(`malformed port in ${JSON.stringify(item)}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`port out of range in ${JSON.stringify(item)}`);
  return port;
}

/**
 * `[--target <host>] <route>…` → the gate's policy, each route `<listen>=<host>:<port>`, or
 * `<port>[:<target port>]` on the `--target` host. Throws on anything malformed or ambiguous: a
 * gate that guessed at its own route list would be a gate nobody could read.
 */
export function parseGateArgs(argv: readonly string[]): GateConfig {
  let target: string | null = null;
  let perSource: number | null = null;
  /** Routes in argv order; a short form's host is filled in once `--target` is known, which may
   * come after it. */
  const routes: Array<{ listen: number; host: string | null; port: number }> = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--target") {
      const value = argv[++i];
      if (value === undefined || !HOSTNAME.test(value)) {
        throw new Error("--target needs a hostname");
      }
      target = value;
      continue;
    }
    if (item === "--per-source") {
      const value = argv[++i];
      if (value === undefined || !/^[1-9]\d{0,5}$/.test(value) || perSource !== null) {
        throw new Error("--per-source needs one positive count");
      }
      perSource = Number(value);
      continue;
    }
    let route: { listen: number; host: string | null; port: number };
    const at = item.indexOf("=");
    if (at !== -1) {
      const [host, port, extra] = item.slice(at + 1).split(":");
      if (port === undefined || extra !== undefined || !HOSTNAME.test(host)) {
        throw new Error(`malformed route ${JSON.stringify(item)}: want <listen>=<host>:<port>`);
      }
      route = { listen: portOf(item.slice(0, at), item), host, port: portOf(port, item) };
    } else {
      const [listen, port, extra] = item.split(":");
      if (extra !== undefined) throw new Error(`malformed route ${JSON.stringify(item)}`);
      route = {
        listen: portOf(listen, item),
        host: null,
        port: port === undefined ? portOf(listen, item) : portOf(port, item),
      };
    }
    if (routes.some((r) => r.listen === route.listen)) {
      throw new Error(`port ${route.listen} is listed twice`);
    }
    routes.push(route);
  }
  if (routes.length === 0) throw new Error("no routes: a gate with nothing to relay is a mistake");
  const bare = routes.find((r) => r.host === null);
  if (bare !== undefined && target === null) {
    throw new Error(
      `route ${bare.listen} names no host and there is no --target: the gate must be told where ` +
        "each port goes",
    );
  }
  return {
    routes: routes.map((r) => ({ listen: r.listen, host: r.host ?? target!, port: r.port })),
    perSource: perSource ?? DEFAULT_PER_SOURCE,
  };
}

export interface GateLimits {
  /** The gate-wide ceiling on open relays. */
  maxConnections?: number;
  /** Close a relay quiet in both directions this long. */
  idleMs?: number;
}

/**
 * One listener per route, each piping bytes to its own `host:port`. Resolves once every listener is
 * up; `hostname` is the bind address (all interfaces in the container, the test's loopback).
 * `limits` exists for the test; the binary takes the defaults.
 */
export async function serveGate(
  config: GateConfig,
  hostname = "0.0.0.0",
  log: (line: string) => void = (line) => console.error(line),
  limits: GateLimits = {},
): Promise<{ close(): Promise<void>; ports: number[] }> {
  const maxConnections = limits.maxConnections ?? MAX_CONNECTIONS;
  const idleMs = limits.idleMs ?? IDLE_TIMEOUT_MS;
  /** Open relays per source address, across every port: a run is one source whichever it dials. */
  const bySource = new Map<string, number>();
  let open = 0;
  // Said once per source until it drops back under, not per refused connection: a run hammering
  // its cap must not also flood the gate's log.
  const capped = new Set<string>();

  const servers: net.Server[] = [];
  for (const route of config.routes) {
    // Half-open both ways (see the header): node's default ends a socket's writing half the
    // moment its reading half ends, which drops an answer still on its way.
    const server = net.createServer({ allowHalfOpen: true }, (client) => {
      const source = client.remoteAddress ?? "unknown";
      const held = bySource.get(source) ?? 0;
      if (held >= config.perSource || open >= maxConnections) {
        if (!capped.has(source)) {
          capped.add(source);
          log(
            held >= config.perSource
              ? `gate: ${source} holds ${held} relays, its cap — refusing more until some close`
              : `gate: ${open} relays open, the gate's cap — refusing more until some close`,
          );
        }
        client.destroy();
        return;
      }
      bySource.set(source, held + 1);
      open++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        open--;
        const left = (bySource.get(source) ?? 1) - 1;
        if (left <= 0) bySource.delete(source);
        else bySource.set(source, left);
        if (left < config.perSource) capped.delete(source);
      };

      // The target resolved per connection, not once: the name is the daemon's to move.
      const upstream = net.connect({ host: route.host, port: route.port, allowHalfOpen: true });
      const timer = setTimeout(
        () => upstream.destroy(new Error("dial timed out")),
        DIAL_TIMEOUT_MS,
      );
      upstream.once("connect", () => clearTimeout(timer));
      const drop = () => {
        clearTimeout(timer);
        release();
        client.destroy();
        upstream.destroy();
      };
      // Idle on both sockets: node's socket timeout resets on any read or write on that socket,
      // so a relay streaming one way only keeps both alive.
      client.setTimeout(idleMs, drop);
      upstream.setTimeout(idleMs, drop);
      client.on("error", drop);
      upstream.on("error", (err) => {
        log(`gate: ${route.host}:${route.port} — ${err.message}`);
        drop();
      });
      // `close` comes once a socket is done both ways (or failed): either one closing ends the
      // relay. A half-close alone is passed on by `pipe`, which ends the other side's writing.
      client.on("close", drop);
      upstream.on("close", drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    // Kept for the server's whole life, not only while it binds: an accept that fails (EMFILE
    // under load) is an `error` on the server, and unhandled it would take every run's relay down.
    const bound = new Promise<void>((resolve, reject) => {
      let listening = false;
      server.on("error", (err) => {
        if (!listening) reject(err);
        else log(`gate: listener ${route.listen} — ${err.message}`);
      });
      server.listen(route.listen, hostname, () => {
        listening = true;
        resolve();
      });
    });
    await bound;
    servers.push(server);
  }
  return {
    ports: servers.map((s) => (s.address() as net.AddressInfo).port),
    close: () =>
      Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => {}),
  };
}

if (import.meta.main) {
  let config: GateConfig;
  try {
    config = parseGateArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`run-gate: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  await serveGate(config);
  console.error(
    `run-gate: relaying ${
      config.routes.map((r) => `${r.listen}→${r.host}:${r.port}`).join(", ")
    }, at most ${config.perSource} per source`,
  );
  // A relay that dies takes every confined run's control channel with it; the restart policy
  // brings it back, so an exit is better than a process limping on in an unknown state.
  process.on("uncaughtException", (err) => {
    console.error(`run-gate: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
  // As PID 1 this process has no default action for a signal it does not handle; without these a
  // stop waits out the grace period and ends in SIGKILL.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => process.exit(0));
  }
}
