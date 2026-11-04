// The standalone launcher's configuration, read from its environment. Everything a request cannot
// say is here: the networks, the runtime, the gate, whether checks and builds run at all, the
// images fetched ahead, the tools network. The embedded launcher is handed the same shape by the
// host (packages/host/src/launcher.ts), which reads the same variables for itself.

import {
  checkCapsFromEnv,
  checkPolicyFromEnv,
  DEFAULT_ROOTFUL_BUILDKIT_IMAGE,
  type DockerOptions,
  type EnvironmentsConfig,
  environmentsConfigFromEnv,
  type GateOptions,
  type GateRoute,
  type PrefetchName,
} from "@ryph/orchestrator/docker";
import { TOOLS_NETWORK } from "@ryph/mcp-gateway/tool-host";
import { mintToken } from "@ryph/sealed";
import { mintedFile } from "@ryph/service";
import { join } from "node:path";

export interface LauncherConfig {
  port: number;
  token: string;
  /** Null: no tool-host routes, so hosting is off. */
  toolsToken: string | null;
  docker: DockerOptions;
  checks: boolean;
  /** Null: no build routes. */
  environments: EnvironmentsConfig | null;
  /** Null: nothing fetched ahead. */
  prefetch: Array<{ name: PrefetchName; image: string }> | null;
  /** Null: no tools token, so no hosting. */
  tools: ToolsConfig | null;
  /** RYPH_ENV_TRUST_DEFAULT_BRANCH: whether a build's `defaultBranch` is taken at the caller's
   * word where runs are sandboxed (the docker builder's `trustDefaultBranch`). Default off. */
  trustDefaultBranch: boolean;
}

/**
 * How a launcher hosts MCP servers: everything about their containers a tools-token holder must
 * not choose. The tools network is made internal with gateway mode `isolated` (src/tools.ts), so
 * a vendor's container reaches the guard and the egress relay and nothing else.
 */
export interface ToolsConfig {
  /** The tools network: vendors' containers, the guard's second side, the relay's second side. */
  network: string;
  /** Whether the gateway is a container on `edge`, dialling the guard by name (nothing published). */
  joined: boolean;
  /**
   * The ordinary network the guard and the egress relay are created on — the deployment's, where
   * the gateway and the egress proxy are. Unset: one the launcher makes beside the tools network
   * (`toolEdgeNetwork`), for a deployment with no network of its own.
   */
  edge?: string;
  /** The one image the tool guard runs: a guard launch naming any other is refused. */
  guardImage: string;
  /**
   * The egress relay: the run gate's image, relaying :7460 on the tools network to the egress
   * proxy's tool listener at `target:port` (RYPH_TOOL_EGRESS_TARGET). Null: hosted servers have no
   * way out at all.
   */
  egress: { image: string; target: string; port: number } | null;
}

type Env = (name: string) => string | undefined;

/** A launcher-only switch: on or off, `fallback` unset. The shared switches (RYPH_CHECKS,
 * RYPH_ENVIRONMENTS) are read by the readers every composition root uses. */
const onOff = (env: Env, name: string, fallback: boolean, fail: (m: string) => never) => {
  const raw = env(name)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "on") return true;
  if (raw === "off") return false;
  return fail(`${name} must be "on" or "off", got ${JSON.stringify(raw)}`);
};

/**
 * The run gate, from RYPH_DOCKER_GATE_*: its image, the routes it relays and whose it is. A
 * standalone launcher has no database to name an owner by, so it mints one into its home (HOME,
 * its own volume in compose) on its first boot and keeps it, as the binary keeps its database:
 * a launcher whose deployment network is renamed then still knows its old gate for its own, and
 * one on a fresh volume beside a live gate does not take it from under that gate's runs.
 * RYPH_DOCKER_GATE_OWNER names one outright.
 *
 * RYPH_DOCKER_GATE_ROUTES is the gate's own route grammar, comma-separated: `<listen>=<host>:<port>`
 * per run-facing address, e.g. `7411=control-plane:7411,7420=model-proxy:7420`. Each route is a
 * port a confined run dials on the gate and the service behind it, so the list is exactly what a
 * run can reach of the deployment. Spelled out rather than derived: the launcher does not know
 * the addresses runs are handed, which are the control plane's configuration.
 */
export function gateFromEnv(env: Env, fail: (message: string) => never): GateOptions {
  const image = env("RYPH_DOCKER_GATE_IMAGE")?.trim() ||
    fail("RYPH_DOCKER_RUN_NETWORK confines runs, which needs RYPH_DOCKER_GATE_IMAGE");
  const raw = env("RYPH_DOCKER_GATE_ROUTES")?.trim() ||
    fail("RYPH_DOCKER_RUN_NETWORK confines runs, which needs RYPH_DOCKER_GATE_ROUTES");
  const routes: GateRoute[] = [];
  for (const entry of raw.split(",").map((r) => r.trim()).filter((r) => r !== "")) {
    const match = /^(\d{1,5})=([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/.exec(entry);
    const listen = Number(match?.[1]);
    const port = Number(match?.[3]);
    if (match === null || !validPort(listen) || !validPort(port)) {
      fail(
        `RYPH_DOCKER_GATE_ROUTES entries are <listen>=<host>:<port>, got ${JSON.stringify(entry)}`,
      );
    }
    if (routes.some((r) => r.listen === listen)) {
      fail(`RYPH_DOCKER_GATE_ROUTES lists port ${listen} twice`);
    }
    routes.push({ listen, target: match![2], port });
  }
  return { image, routes, owner: env("RYPH_DOCKER_GATE_OWNER")?.trim() || gateOwner(env, fail) };
}

/** The persistent owner id in the launcher's home (see `gateFromEnv`). */
function gateOwner(env: Env, fail: (message: string) => never): string {
  const home = env("HOME")?.trim() ||
    fail(
      "a confined launcher keeps its gate's owner in HOME, which is unset; set HOME or " +
        "RYPH_DOCKER_GATE_OWNER",
    );
  const path = join(home, "gate-owner");
  try {
    return `launcher-${mintedFile(path, () => mintToken().slice(0, 16))}`;
  } catch (err) {
    return fail(`the gate's owner could not be kept in ${path}: ${(err as Error).message}`);
  }
}

/** RYPH_IMAGE_PREFETCH: whether a docker launcher fetches its images ahead. Default on. One
 * reader for the standalone launcher and the binary's embedded one. */
export function prefetchOn(env: Env, fail: (message: string) => never): boolean {
  return onOff(env, "RYPH_IMAGE_PREFETCH", true, fail);
}

/**
 * The images a docker launcher fetches ahead of the first launch that needs each: every image a
 * run, a hosted tool server or a build launches on, of the ones it was told. One list for the
 * standalone launcher and the binary's embedded one, so neither fetches what the other leaves to
 * a first launch. An image unset, empty or `off` (in any case, as browserImage reads it) is left out. `toolGuard` only where hosting is
 * on, and `builds` only where builds are; a confined build's own BuildKit runs on
 * RYPH_ENV_BUILDKIT_IMAGE (createEnvironmentBuilder reads the same, with the same default).
 */
export function prefetchImages(input: {
  agent: string | null | undefined;
  gate: string | null | undefined;
  browser: string | null | undefined;
  toolGuard: string | null | undefined;
  builds: {
    harness: string | null | undefined;
    universal: string | null | undefined;
    confined: boolean;
  } | null;
  env: Env;
}): Array<{ name: PrefetchName; image: string }> {
  const { builds } = input;
  return ([
    ["agent", input.agent],
    ["run-gate", input.gate],
    ["browser", input.browser],
    ["tool-guard", input.toolGuard],
    ["harness", builds?.harness],
    ["universal", builds?.universal],
    [
      "buildkit",
      builds?.confined
        ? input.env("RYPH_ENV_BUILDKIT_IMAGE")?.trim() || DEFAULT_ROOTFUL_BUILDKIT_IMAGE
        : null,
    ],
  ] as Array<[PrefetchName, string | null | undefined]>).flatMap(([name, image]) =>
    image?.trim() && image.trim().toLowerCase() !== "off" ? [{ name, image: image.trim() }] : []
  );
}

/**
 * RYPH_TOOL_EGRESS_TARGET: where the egress relay sends hosted servers, `<host>:<port>` on the
 * deployment network — the egress proxy's tool listener (`egress-proxy:7461`, or `ryph:7461`
 * where the binary serves it) — or `off`, for hosted servers with no way out at all. Required
 * wherever hosting is on: the launcher cannot guess where the proxy is, and a default that
 * silently cut every vendor off its API would be found one failed tool call at a time.
 */
export function toolEgressFromEnv(
  env: Env,
  fail: (message: string) => never,
): { image: string; target: string; port: number } | null {
  const raw = env("RYPH_TOOL_EGRESS_TARGET")?.trim() ||
    fail(
      "RYPH_LAUNCHER_TOOLS_TOKEN hosts MCP servers, which needs RYPH_TOOL_EGRESS_TARGET: the " +
        "egress proxy's tool listener as <host>:<port> on RYPH_DOCKER_NETWORK (their one way " +
        "to the internet), or off for none",
    );
  if (raw === "off") return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$/.exec(raw);
  const port = Number(match?.[2]);
  if (match === null || !validPort(port)) {
    fail(`RYPH_TOOL_EGRESS_TARGET is <host>:<port> or off, got ${JSON.stringify(raw)}`);
  }
  const image = env("RYPH_DOCKER_GATE_IMAGE")?.trim() ||
    fail(
      "RYPH_TOOL_EGRESS_TARGET relays hosted servers to the egress proxy through the run gate's " +
        "image, which needs RYPH_DOCKER_GATE_IMAGE",
    );
  return { image, target: match![1], port };
}

/** A standalone launcher's default tools network: `ryph-tools-<deployment network>`. */
export function toolsNetworkFor(network: string): string {
  return `${TOOLS_NETWORK}-${network}`;
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

export function launcherConfigFromEnv(env: Env, fail: (message: string) => never): LauncherConfig {
  const rawPort = env("RYPH_LAUNCHER_PORT")?.trim() || "7470";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`RYPH_LAUNCHER_PORT must be a TCP port, got ${JSON.stringify(rawPort)}`);
  }
  const token = env("RYPH_LAUNCHER_TOKEN")?.trim() ||
    fail("RYPH_LAUNCHER_TOKEN is required: the credential the control plane presents");
  const toolsToken = env("RYPH_LAUNCHER_TOOLS_TOKEN")?.trim() || null;
  if (toolsToken === token) {
    fail(
      "RYPH_LAUNCHER_TOOLS_TOKEN must differ from RYPH_LAUNCHER_TOKEN, since they open different routes",
    );
  }

  // The deployment's identity on the daemon: its labels, its gate's name and its environment
  // images' prefix all derive from it. Unset, a standalone launcher would take the binary's
  // "default" identity, and on a daemon it shares with a binary (or another such launcher) each
  // would reclaim, untag and gate the other's objects as its own.
  const network = env("RYPH_DOCKER_NETWORK")?.trim() ||
    fail(
      "RYPH_DOCKER_NETWORK is required. It names the deployment's docker network, and is also " +
        "its identity on the daemon: its labels, its gate's name, its environment images' prefix",
    );
  const runNetwork = env("RYPH_DOCKER_RUN_NETWORK")?.trim() || undefined;
  const runtime = env("RYPH_DOCKER_RUNTIME")?.trim() || undefined;
  // The binary's one-target spelling: here every route names its own target, so a value set would
  // read as configured and do nothing.
  if (env("RYPH_DOCKER_GATE_TARGET") !== undefined) {
    fail(
      "RYPH_DOCKER_GATE_TARGET is the binary's; a standalone launcher's gate names a target per " +
        "route in RYPH_DOCKER_GATE_ROUTES (<listen>=<host>:<port>)",
    );
  }
  if (env("RYPH_DOCKER_GATE_ROUTES") !== undefined && runNetwork === undefined) {
    fail("RYPH_DOCKER_GATE_ROUTES is the run gate's, which only RYPH_DOCKER_RUN_NETWORK makes");
  }
  const docker: DockerOptions = {
    network,
    ...(runtime === undefined ? {} : { runtime }),
    ...(runNetwork === undefined ? {} : { runNetwork, gate: gateFromEnv(env, fail) }),
    checkCaps: checkCapsFromEnv(env, fail),
  };

  // The two switches every composition root reads, read the same way here.
  // The switch alone: the size classes a check may name are the control plane's to hold.
  const checks = checkPolicyFromEnv(env, fail, null).enabled;
  // The builder's own knobs (RYPH_ENV_BUILDKIT_IMAGE, RYPH_ENV_CACHE_DIR, RYPH_ENV_TEMP_DIR,
  // RYPH_ENV_BUILD_PLATFORM, RYPH_ENV_IMAGE_REMOVAL) are read where every docker builder reads them,
  // createEnvironmentBuilder; the build's inputs arrive in each BuildSpec. The builder is docker:
  // this is the process that runs docker builds, and naming another here is refused.
  const named = environmentsConfigFromEnv(env, fail, "docker");
  if (named.enabled && named.builder !== "docker") {
    fail(`RYPH_ENV_BUILDER=${named.builder}: a docker launcher runs docker builds only`);
  }
  const environments: EnvironmentsConfig | null = named.enabled ? named : null;
  const builds = environments !== null;
  const trustDefaultBranch = onOff(env, "RYPH_ENV_TRUST_DEFAULT_BRANCH", false, fail);

  // Hosting: always `joined`, since a port published on this machine's loopback means nothing to
  // a gateway in another container — the gateway is on the deployment network, the guard's
  // ordinary side, and dials it by name. The tools network is the deployment's own
  // (`ryph-tools-<RYPH_DOCKER_NETWORK>`, the networked stack's spelling), never the binary's
  // `ryph-tools`: the tool guard's name derives from the network, so a shared one would have two
  // deployments replace each other's guard. The guard's image and the relay's target are the
  // launcher's, never the caller's: they decide what lands on the deployment network and where
  // a vendor's bytes may go.
  if (toolsToken === null && env("RYPH_TOOL_EGRESS_TARGET") !== undefined) {
    fail("RYPH_TOOL_EGRESS_TARGET is hosting's, which only RYPH_LAUNCHER_TOOLS_TOKEN turns on");
  }
  const tools: ToolsConfig | null = toolsToken === null ? null : {
    network: env("RYPH_TOOL_NETWORK")?.trim() || toolsNetworkFor(network),
    joined: true,
    edge: network,
    guardImage: env("RYPH_TOOL_GUARD_IMAGE")?.trim() ||
      fail(
        "RYPH_LAUNCHER_TOOLS_TOKEN hosts MCP servers, which needs RYPH_TOOL_GUARD_IMAGE: the " +
          "one image the tool guard may run",
      ),
    egress: toolEgressFromEnv(env, fail),
  };

  // The images runs, hosted servers and builds launch on, fetched ahead as the binary fetches
  // them: whichever of them this launcher was told about.
  const prefetch = prefetchOn(env, fail)
    ? prefetchImages({
      agent: env("RYPH_AGENT_IMAGE"),
      // The run gate's image, which the egress relay runs too.
      gate: docker.gate?.image ?? tools?.egress?.image,
      browser: env("RYPH_BROWSER_IMAGE"),
      toolGuard: tools?.guardImage,
      builds: builds
        ? {
          harness: env("RYPH_HARNESS_IMAGE"),
          universal: env("RYPH_ENV_BASE_IMAGE"),
          confined: runNetwork !== undefined,
        }
        : null,
      env,
    })
    : null;

  return {
    port,
    token,
    toolsToken,
    docker,
    checks,
    environments,
    prefetch,
    tools,
    trustDefaultBranch,
  };
}

/**
 * The two tokens where a deployment hands out no secrets (deploy/compose): `<name>_FILE` names a
 * file in a volume the caller mounts read-only, and the launcher mints it on its first boot
 * (`mintedFile`: never seen half-written, one winner when two boot at once), then reads it on
 * every boot after. The precedent is RYPH_SECRETS_KEY_FILE, which the binary mints the same way.
 * Readable by anyone who mounts the volume, which is the caller alone: the volume is the
 * boundary, as the database's socket volume is.
 *
 * Returns the environment with the tokens filled in from their files; a variable set outright
 * wins over its file. The caller reads the same files (`launcherTokenFromEnv`).
 */
export function withTokenFiles(env: Env, fail: (message: string) => never): Env {
  const filled = new Map<string, string>();
  for (const name of ["RYPH_LAUNCHER_TOKEN", "RYPH_LAUNCHER_TOOLS_TOKEN"]) {
    const path = env(`${name}_FILE`)?.trim();
    if (env(name)?.trim() || !path) continue;
    try {
      filled.set(name, mintedFile(path, mintToken));
    } catch (err) {
      fail(`${name}_FILE=${path} could not be minted or read: ${(err as Error).message}`);
    }
  }
  return (name) => filled.get(name) ?? env(name);
}
