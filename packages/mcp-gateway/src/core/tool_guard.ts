// The tool guard's contract, as the gateway speaks it: the one published entry point onto the
// tools network, a token-gated reverse proxy the gateway launches at boot (images/tool-guard/).
//
// Everything here is shared by the side that launches the guard (core/hosting.ts), the side that
// dials it (the data plane and the probe), and the launchers that name containers. The guard image is a separate program and cannot import this file, so it carries its own copy of
// the header name and the route-table format; change them in both places.
//
// Invariants:
// - the guard token exists in this process's memory and in the guard's env, and nowhere else: it
//   is minted fresh on every gateway boot, never written to a row, never logged
// - a run never holds it. The guard's published port can be reachable from the run network on
//   docker (measured), so the token, not
//   the network, is what keeps a run from dialling a hosted server around the gateway
// - what runs under the guard's name is the guard and only the guard: its image the backend's, its
//   launch exactly `guardLaunchSpec`'s shape (`guardSpecProblem`), whoever asks
// - a hosted credential's ADDRESS is a pure function of the launch it is bound to: the launch key
//   names the container (`toolContainerName`), the guard routes `/<key>/mcp` only to that name
//   (`addressOfKey`, checked here and again by the guard), and the data plane computes the key from
//   the row as it stands right before it dials. No launch of other inputs can sit at that address,
//   so whatever else goes wrong — a stale route, a superseded launch, a row edited in the database
//   — the outcome is "not found" or "not ready", never another container

import type { ToolLaunchSpec } from "../ports/tool_host.ts";

/** The header the guard checks on every request, and strips before forwarding. */
export const TOOL_GUARD_TOKEN_HEADER = "X-Ryph-Tool-Token";

/** The port the guard listens on inside its container. */
export const TOOL_GUARD_PORT = 8080;

/**
 * A hosted launch's key: 32 lowercase hex (128 bits of a SHA-256 over exactly the inputs the
 * launch was made from — core/sealing.ts `launchKey`). It names the container, and it is the path
 * the guard routes, so an address is a function of the launch and of nothing else.
 */
export const LAUNCH_KEY = /^[0-9a-f]{32}$/;

/** The one name a hosted vendor container may have: its launch key's. */
export const TOOL_CONTAINER_NAME = /^ryph-tool-[0-9a-f]{32}$/;

/** The container a launch key names. Throws on anything but a key: there is no other name. */
export function toolContainerName(key: string): string {
  if (!LAUNCH_KEY.test(key)) throw new Error("not a launch key");
  return `ryph-tool-${key}`;
}

/**
 * Why `name` may not be launched as a hosted vendor container, or null: it must be exactly a
 * launch key's name, so nothing else ever runs under one (the launchers ask this of every
 * launch that is not the guard's).
 */
export function toolNameProblem(name: string): string | null {
  return TOOL_CONTAINER_NAME.test(name)
    ? null
    : `not a hosted container name (ryph-tool-<32 hex launch key>): ${JSON.stringify(name)}`;
}

/** The guard's route for one launch — the path the data plane and the probe dial. */
export function guardRoutePath(key: string): string {
  return `/${key}/mcp`;
}

/** Where the gateway reaches the guard right now, and the token it must present there. */
export interface ToolGuardAccess {
  /** `http://127.0.0.1:<port>` where the guard is published, `http://<ip>:8080` where it is not. */
  origin: string;
  token: string;
}

/** One launch as the guard routes it: `/<key>/mcp` → `<address><path>`. */
export interface GuardRoute {
  /** The launch key. */
  key: string;
  /**
   * `host:port` on the tools network, where the host is the key's container name (docker) or that
   * name's Service (`<name>.<namespace>.svc`, kubernetes). Anything else is refused on both sides.
   */
  address: string;
  path: string;
  /**
   * The server's caller token — every row but a catalogue entry that opted out with a reviewed
   * reason has one. The guard sends it as `Authorization: Bearer …` on this route, and the server
   * refuses anyone without it: what keeps one hosted server on the tools network from speaking to
   * another's, and what holds where the network does not (OrbStack, measured).
   */
  callerToken?: string;
}

/** Whether `address` is the key's own container: its name, or a DNS name under it. */
export function addressOfKey(key: string, address: string): boolean {
  const host = address.slice(0, address.lastIndexOf(":"));
  const name = toolContainerName(key);
  return host === name || host.startsWith(`${name}.`);
}

/**
 * The guard's route table as its env carries it: `key=host:port/path`, comma-separated. Keys and
 * addresses cannot contain either separator, so the format needs no escaping. Throws on a route
 * whose address is not its key's container: the guard would refuse the table anyway.
 */
export function formatGuardRoutes(routes: GuardRoute[]): string {
  return [...routes]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      if (!addressOfKey(r.key, r.address)) {
        throw new Error(`the route for ${r.key} names another container (${r.address})`);
      }
      return `${r.key}=${r.address}${r.path}`;
    })
    .join(",");
}

/** The caller tokens, by key, in their own env var: `key=token`, comma-separated, hex tokens. */
export function formatCallerTokens(routes: GuardRoute[]): string {
  return [...routes]
    .filter((r) => r.callerToken !== undefined)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => `${r.key}=${r.callerToken}`)
    .join(",");
}

/** The guard's memory cap: a small byte-streaming proxy, nothing a larger cap would help. */
export const GUARD_MEMORY = "256m";
/** The most a guard launch may ask for: anything past it is not the gateway's spec. */
const GUARD_MAX_MEMORY_BYTES = 512 * 1024 ** 2;
const GUARD_MAX_CPUS = 2;

/** What the guard's launch carries, beyond the name and image its backend decides. */
export interface GuardLaunch {
  name: string;
  image: string;
  /** `formatGuardRoutes`. */
  routes: string;
  /** The guard token, minted per gateway boot. */
  token: string;
  /** `formatCallerTokens`. */
  callers: string;
  /** Publish on the host's loopback: only where the gateway cannot dial the guard by name. */
  publish?: { hostPort: number };
}

/**
 * The guard's ToolLaunchSpec, as core/hosting.ts launches it — the one shape `guardSpecProblem`
 * lets through, so a var added here and not there fails the launcher's test, not a deployment.
 */
export function guardLaunchSpec(g: GuardLaunch): ToolLaunchSpec {
  return {
    name: g.name,
    image: g.image,
    command: [],
    // The routes are addresses; the two token maps are secrets, and travel by name.
    env: { RYPH_TOOL_ROUTES: g.routes },
    secretEnv: { RYPH_TOOL_GUARD_TOKEN: g.token, RYPH_TOOL_CALLER_TOKENS: g.callers },
    port: TOOL_GUARD_PORT,
    memory: GUARD_MEMORY,
    ...(g.publish === undefined ? {} : { publish: g.publish }),
    lifetime: "shared",
  };
}

/** The env names the guard reads (images/tool-guard/main.ts), split as `guardLaunchSpec` splits them. */
const GUARD_ENV = new Set(["RYPH_TOOL_ROUTES"]);
const GUARD_SECRET_ENV = new Set(["RYPH_TOOL_GUARD_TOKEN", "RYPH_TOOL_CALLER_TOKENS"]);

/** `512m` → bytes; null for a spelling docker would not take either. */
function memoryBytes(memory: string): number | null {
  const m = memory.match(/^(\d+)([bkmgBKMG]?)$/);
  if (m === null) return null;
  const unit = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase()]!;
  return Number(m[1]) * unit;
}

/**
 * Why `spec`, launched under the guard's name, is not the guard's launch — or null. The guard is
 * the one hosted container on an ordinary network beside the tools network, under docker's
 * default runtime, so a fixed image is not enough: the image is node, and an env var of the
 * caller's (NODE_OPTIONS=--import=data:…) or a command of its own would run the caller's code
 * there, on the deployment network with the internet. So its shape is fixed too — no command,
 * only the env the guard reads, its own port, a bounded cap — and anything else is refused,
 * by the launcher at its route and by the docker adapter again before the CLI sees it.
 */
export function guardSpecProblem(spec: ToolLaunchSpec): string | null {
  if (spec.command.length > 0) return "the tool guard takes no command";
  const env = Object.keys(spec.env).filter((name) => !GUARD_ENV.has(name));
  if (env.length > 0) return `the tool guard reads no ${env.join(", ")}`;
  const secrets = Object.keys(spec.secretEnv ?? {}).filter((name) => !GUARD_SECRET_ENV.has(name));
  if (secrets.length > 0) return `the tool guard reads no ${secrets.join(", ")}`;
  if (spec.port !== TOOL_GUARD_PORT) return `the tool guard listens on ${TOOL_GUARD_PORT}`;
  const bytes = memoryBytes(spec.memory);
  if (bytes === null || bytes === 0 || bytes > GUARD_MAX_MEMORY_BYTES) {
    return `the tool guard's memory cap is at most ${GUARD_MAX_MEMORY_BYTES / 1024 ** 2}m`;
  }
  if (spec.cpus !== undefined && !(Number(spec.cpus) > 0 && Number(spec.cpus) <= GUARD_MAX_CPUS)) {
    return `the tool guard's CPU cap is at most ${GUARD_MAX_CPUS}`;
  }
  if (spec.lifetime !== "shared") return "the tool guard is shared";
  return null;
}
