// A ToolHost over the wire: hosted MCP servers launched by the docker launcher (@ryph/launcher),
// the one process that holds the docker socket. What lets a
// gateway that holds the MCP master key host servers at all on docker — main.ts says why it may
// not hold the socket itself — and what the binary's in-process gateway reaches its embedded
// launcher through, so the two deployments share one seam.
//
// It is reached with RYPH_LAUNCHER_TOOLS_TOKEN, which opens the routes below and nothing else:
// not a run launch, not a build, not the reconcile. A gateway that leaks it can start and stop
// containers named `ryph-tool-*` of any image on the tools network, unprivileged and under the
// launcher's runtime (RYPH_DOCKER_RUNTIME, the runs' own) — what hosting does with the images an
// admin registers, with no admin choosing. Confined where every hosted server is: the tools
// network is internal, so such a container reaches the guard and the egress relay and nothing
// else, and through the relay only what a tool claim opens, which a token holder cannot mint.
// The guard is the one launch that lands on an ordinary network as well, which is why its image
// is the launcher's and not the caller's.
//
// The wire, served by the launcher:
//   GET  /v1/tools/info                → {reachesGuard, guardName, guardImage, network, egressProxy}
//   POST /v1/tools/network {}          → 204                   (ensureNetwork)
//   POST /v1/tools/launch {spec}       → {handle, address}
//   POST /v1/tools/stop {handle}       → 204
//   GET  /v1/tools/list                → {names}
//   POST /v1/tools/inspect {handle}    → {state}
//   POST /v1/tools/address {handle, port} → {address}
//   POST /v1/tools/logs {handle, tail} → {logs}
//   failures: {error, message}; 400 the spec failed its schema, 401 the token, 404 not_served
//   (this launcher hosts nothing) or not_found (no such route), 408 the body took too long to
//   arrive, 413 the body is too large, 500 docker
//
// Everything `info` says is the launcher's to say, read once at connect: whether this process
// dials the guard by name is a fact about the guard's ordinary network and who is on it, the
// guard's image is the one the launcher will run under that name, and the egress relay is one it
// made — all its configuration. A standalone launcher hosts with `joined` always — a 127.0.0.1
// port published on the docker host means nothing to a gateway in another container — and
// refuses a launch that asks to publish one, a guard launch of any other image, and any publish
// but the guard's.
//
// Like the docker adapter, every method throws on failure except `inspect` (and so `address`),
// which answers "unknown" for a launcher that did not answer: a probe that could not ask is not
// evidence the container is gone.
//
// A launcher briefly away is waited for, as every launcher client waits (@ryph/service's
// `untilReached`): `ensureNetwork`, `launch`, `stop` and `list` ask again, for up to `reachMs`, while
// a request provably never reached it (a refused connection, a name that does not resolve), so
// nothing is sent twice. The probes (`inspect`, `address`) and `logs` answer at once.

import { neverReached, untilReached } from "@ryph/service";
import { z } from "@zod/zod";
import type { ToolContainerState, ToolHost, ToolLaunchSpec } from "../../ports/tool_host.ts";

/**
 * The tool side of what a docker launcher decides from its own environment: the tools network its
 * hosted servers join, the OCI runtime they run under (the runs' too), the guard's image, and
 * where their egress relay sends them. A gateway reaching it must not set any of them — each would
 * read as configured here and do nothing. @ryph/orchestrator's
 * LAUNCHER_OWNED_SETTINGS takes these from here, so the run side and the tool side share one list.
 */
export const LAUNCHER_OWNED_TOOL_SETTINGS = [
  "RYPH_TOOL_NETWORK",
  "RYPH_DOCKER_RUNTIME",
  "RYPH_TOOL_GUARD_IMAGE",
  "RYPH_TOOL_EGRESS_TARGET",
] as const;

/** Why a gateway hosting through the launcher at `url` must not boot, or null. */
export function launcherToolSettingsRefusal(
  env: (name: string) => string | undefined,
  url: string,
): string | null {
  const owned = LAUNCHER_OWNED_TOOL_SETTINGS.filter((name) => env(name) !== undefined);
  if (owned.length === 0) return null;
  const one = owned.length === 1;
  return `RYPH_TOOL_HOST=launcher hosts through the docker launcher at ${url}, whose own ` +
    `configuration ${owned.join(", ")} ${one ? "is" : "are"} — set ${one ? "it" : "them"} on the ` +
    "launcher, not here";
}

/**
 * The docker launcher's wire revision: BUMP IT WHENEVER ANY WIRE SCHEMA CHANGES — the tool
 * schemas below, or the run side's in @ryph/orchestrator's adapters/launcher/wire.ts, which
 * imports this one constant. Both ends parse strictly, so a launcher and a caller of different
 * versions would read each other's every request as a bug (a 400) or every answer as garbage. The
 * launcher says its revision in `/v1/info` and `/v1/tools/info`, and every caller refuses to boot
 * on another (`wireMismatch`). Here and not in the orchestrator because it is the package both
 * sides of the wire already import.
 */
export const LAUNCHER_WIRE_REVISION = 2;

/** Why a caller speaking `LAUNCHER_WIRE_REVISION` must not use a launcher saying `said`, or null. */
export function wireMismatch(said: unknown, url: string): string | null {
  if (said === LAUNCHER_WIRE_REVISION) return null;
  const theirs = typeof said === "number" ? `wire revision ${said}` : "no wire revision (older)";
  return `the docker launcher at ${url} speaks ${theirs}, and this process speaks wire revision ` +
    `${LAUNCHER_WIRE_REVISION}: run the launcher and its callers at the same version ` +
    "(the same RYPH_VERSION)";
}

export const TOOL_ROUTES = {
  info: "/v1/tools/info",
  network: "/v1/tools/network",
  launch: "/v1/tools/launch",
  stop: "/v1/tools/stop",
  list: "/v1/tools/list",
  inspect: "/v1/tools/inspect",
  address: "/v1/tools/address",
  logs: "/v1/tools/logs",
} as const;

/**
 * Names the docker CLI's own environment must never be handed by a caller: `secretEnv` values
 * reach a container by name through the launching CLI's environment (cli.ts, `envArgs`), so a
 * secret named DOCKER_HOST would point the CLI at another daemon, and LD_PRELOAD would load a
 * library into the process that holds the socket.
 */
const CLI_ENV =
  /^(PATH|HOME|TMPDIR|SHELL|USER|IFS|ALL_PROXY|HTTPS?_PROXY|NO_PROXY|GODEBUG|GOTRACEBACK|GOMAXPROCS|GOGC)$|^(DOCKER_|LD_|DYLD_|BUILDKIT_|BUILDX_|XDG_|SSL_|NODE_|BUN_|GIT_)/i;

/** A command word or env value: never a NUL, which no argv or env can hold — the spawn would
 * refuse it, quoting the value (a secret, as like as not) in its error. */
const value = (max: number) => z.string().max(max).regex(/^[^\0]*$/, "contains a NUL byte");
const envName = z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not an env name");
const handle = z.string().max(160).regex(
  /^ryph-tool-[a-z0-9_.-]{1,118}$/,
  "not a tool container this platform names",
);

function toolSchemas(obj: typeof z.object) {
  const ToolLaunchSpec = obj({
    name: handle,
    image: z.string().max(512).regex(/^[^\s-][^\s]*$/, "not an image reference"),
    command: z.array(value(4096)).max(256),
    env: z.record(envName, value(65536)),
    secretEnv: z.record(
      envName.refine((n) => !CLI_ENV.test(n), { message: "not a name a secret may take" }),
      value(65536),
    ).optional(),
    port: z.number().int().min(1).max(65535),
    memory: z.string().max(16).regex(/^\d+[bkmgBKMG]?$/, "not a memory size"),
    cpus: z.string().max(16).regex(/^\d+(\.\d+)?$/, "not a CPU count").optional(),
    publish: obj({ hostPort: z.number().int().min(0).max(65535) }).optional(),
    lifetime: z.enum(["shared", "run"]),
  }) satisfies z.ZodType<ToolLaunchSpec>;
  return {
    Launch: obj({ spec: ToolLaunchSpec }),
    Handle: obj({ handle }),
    Address: obj({ handle, port: z.number().int().min(1).max(65535) }),
    Logs: obj({ handle, tail: z.number().int().positive().max(100_000) }),
    Empty: obj({}),
  };
}

/** What the launcher parses with: unknown keys are refused. */
export const strictToolWire = toolSchemas(z.strictObject as typeof z.object);
/** What this client parses its own spec with before sending: validated, extras dropped. */
export const laxToolWire = toolSchemas(z.object);

export const ToolInfoAnswer = z.object({
  /** `LAUNCHER_WIRE_REVISION`, as the launcher speaks it. */
  wire: z.number().int(),
  reachesGuard: z.boolean(),
  guardName: z.string().min(1),
  /** The one image a guard launch may name. */
  guardImage: z.string().min(1),
  network: z.string().min(1),
  /** The egress relay's origin on the tools network; null: hosted servers have no way out. */
  egressProxy: z.string().min(1).nullable(),
});
export type ToolInfo = z.infer<typeof ToolInfoAnswer>;

const LaunchAnswer = z.object({ handle: z.string().min(1), address: z.string().min(1) });
const NamesAnswer = z.object({ names: z.array(z.string()) });
const StateAnswer = z.object({ state: z.enum(["running", "exited", "unknown"]) });
const AddressAnswer = z.object({ address: z.string().nullable() });
const LogsAnswer = z.object({ logs: z.string() });
const ErrorAnswer = z.object({ error: z.string(), message: z.string().optional() });

export interface LauncherToolConnection {
  /** The launcher's base URL, as this process dials it. */
  url: string;
  /** RYPH_LAUNCHER_TOOLS_TOKEN. */
  token: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** How long a call waits out a launcher that cannot be connected to (`REACH_MS`, 90 s). */
  reachMs?: number;
}

/** A call that failed before a byte of it left: the launcher cannot have acted on it. */
class Unreached extends Error {}
/** The launcher's own refusal of a request (a 4xx): asking again answers the same. */
class Refused extends Error {}
/** A launcher of another wire revision (`wireMismatch`): no request means the same to both. */
export class WireMismatch extends Error {
  override name = "WireMismatch";
}

/** A launch may pull the server's image inline; everything else is one docker command. */
const LAUNCH_MS = 10 * 60_000;
const CALL_MS = 60_000;

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

async function call<T>(
  conn: LauncherToolConnection,
  path: string,
  body: unknown,
  answer: z.ZodType<T>,
  timeoutMs = CALL_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await (conn.fetch ?? fetch)(`${conn.url.replace(/\/+$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = `the docker launcher did not answer ${path}: ${said(err)}`;
    throw neverReached(err) ? new Unreached(message) : new Error(message);
  }
  if (!res.ok) {
    const parsed = ErrorAnswer.safeParse(await res.json().catch(() => null));
    const why = parsed.success ? (parsed.data.message ?? parsed.data.error) : `HTTP ${res.status}`;
    const message = `the docker launcher refused ${path}: ${why}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 408
      ? new Refused(message)
      : new Error(message);
  }
  if (res.status === 204) return answer.parse(undefined);
  const parsed = answer.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error(`the docker launcher answered ${path} with something else`);
  return parsed.data;
}

/**
 * Asks the launcher how it hosts, waiting up to `waitMs` for one that is still starting (a
 * compose stack brings the two up side by side), and answers the ToolHost. Throws when it never
 * answered, or at once when it refused (a wrong token, a launcher that hosts nothing): hosting the
 * gateway cannot describe is no hosting.
 */
export async function connectLauncherToolHost(
  conn: LauncherToolConnection,
  opts: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ToolHost> {
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    try {
      const raw = await call(conn, TOOL_ROUTES.info, undefined, z.unknown());
      const said = typeof raw === "object" && raw !== null && "wire" in raw ? raw.wire : undefined;
      const mismatch = wireMismatch(said, conn.url);
      if (mismatch !== null) throw new WireMismatch(mismatch);
      const info = ToolInfoAnswer.safeParse(raw);
      if (!info.success) {
        throw new Error(`the docker launcher answered ${TOOL_ROUTES.info} with something else`);
      }
      return launcherToolHost(conn, info.data);
    } catch (err) {
      if (err instanceof Refused || err instanceof WireMismatch || Date.now() >= deadline) {
        throw err;
      }
      await sleep(1_000);
    }
  }
}

/** The ToolHost over a launcher whose `info` is already known. */
export function launcherToolHost(conn: LauncherToolConnection, info: ToolInfo): ToolHost {
  const Nothing = z.unknown();
  /** `attempt`, asked again while the launcher cannot be connected to (see the header). */
  const reached = <T>(attempt: () => Promise<T>) =>
    untilReached(attempt, {
      unreached: (err) => err instanceof Unreached,
      ...(conn.reachMs === undefined ? {} : { budgetMs: conn.reachMs }),
      exhausted: (err, budget) =>
        new Error(`${said(err)} (still unreachable after ${Math.round(budget / 1000)} s)`),
    });
  return {
    kind: "docker",
    reachesGuard: info.reachesGuard,
    guardName: info.guardName,
    guardImage: info.guardImage,
    egressProxy: info.egressProxy,

    async ensureNetwork() {
      await reached(() => call(conn, TOOL_ROUTES.network, {}, Nothing));
    },

    async launch(spec) {
      const parsed = laxToolWire.Launch.safeParse({ spec });
      if (!parsed.success) {
        throw new Error(
          `this tool launch cannot go to the docker launcher: ${parsed.error.message}`,
        );
      }
      return await reached(() =>
        call(conn, TOOL_ROUTES.launch, parsed.data, LaunchAnswer, LAUNCH_MS)
      );
    },

    async stop(handle) {
      await reached(() => call(conn, TOOL_ROUTES.stop, { handle }, Nothing));
    },

    async list() {
      return (await reached(() => call(conn, TOOL_ROUTES.list, undefined, NamesAnswer))).names;
    },

    async inspect(handle): Promise<ToolContainerState> {
      try {
        return (await call(conn, TOOL_ROUTES.inspect, { handle }, StateAnswer)).state;
      } catch {
        return "unknown";
      }
    },

    async address(handle, port) {
      try {
        return (await call(conn, TOOL_ROUTES.address, { handle, port }, AddressAnswer)).address;
      } catch {
        return null;
      }
    },

    async logs(handle, tail) {
      return (await call(conn, TOOL_ROUTES.logs, { handle, tail }, LogsAnswer)).logs;
    },
  };
}
