// The docker launcher as this process reaches it: started in
// this process and dialled over loopback (RYPH_LAUNCHER_URL unset or `embedded`, the binary), or
// a launcher service somewhere else (RYPH_LAUNCHER_URL=<url>, a compose deployment). Either way
// everything docker-shaped — runs, the reconcile, checks, builds, prefetch, hosted MCP servers —
// goes through the same clients, so the binary exercises the seam a compose deployment depends on.
//
// Embedded, the forge's precedent: both tokens are minted per boot (both ends live in this
// process, so a fresh pair costs nothing and is written nowhere), and the listener is bound to
// loopback on a port the kernel picks — nothing but this process dials it, so it needs no port of
// its own to collide with. Its configuration is this process's: the docker options, the gate,
// the builder, the images to fetch ahead, the tools network.
//
// Remote, its configuration is its own, and this process holds no docker CLI and calls none:
// what it needs to know about the launcher (whether runs are confined, what the gate is called,
// the engine) it asks the launcher (`info`).

import {
  awaitLauncherInfo,
  type LauncherClients,
  launcherClients,
  type LauncherInfo,
  loggerDiagnostics,
} from "@ryph/orchestrator";
import { connectLauncherToolHost, type ToolHost, WireMismatch } from "@ryph/mcp-gateway/tool-host";
import { mintToken as mint } from "@ryph/sealed";
import { serve } from "@ryph/service";
import { type LauncherStartOptions, type RunningLauncher, startLauncher } from "@ryph/launcher";

/** The RYPH_LAUNCHER_URL that starts the launcher in this process (also what unset means). */
export const EMBEDDED_LAUNCHER = "embedded";

export interface HostLauncher {
  clients: LauncherClients;
  /** What it said of itself at boot. */
  info: LauncherInfo;
  /** Hosted MCP servers through it, or why there are none. */
  toolHost: ToolHost | { unavailable: string };
  /** The launcher this process runs, to close on the drain; null when it is remote. */
  embedded: RunningLauncher | null;
  /** Where it was reached, for the boot summary. */
  url: string;
}

export interface ConnectLauncherOptions {
  /** RYPH_LAUNCHER_URL: unset or `embedded` starts one here. */
  setting: string | undefined;
  /** RYPH_LAUNCHER_TOKEN and RYPH_LAUNCHER_TOOLS_TOKEN, for a remote launcher. */
  token: string | undefined;
  toolsToken: string | undefined;
  /** Whether this process hosts MCP servers at all (tool access on). */
  hosting: boolean;
  /** The embedded launcher's configuration, everything but its tokens and its listener. */
  embedded: () => Omit<
    LauncherStartOptions,
    "token" | "toolsToken" | "serve" | "port" | "trustDefaultBranch" | "soleTenant"
  >;
  /** How long a remote launcher may take to answer at boot (a compose stack starts both). */
  waitMs?: number;
}

/**
 * Why an EMBEDDED launcher must not host MCP servers for this process where it runs, or null.
 *
 * Hosting's addresses assume one of two positions. On the docker host (the binary as it usually
 * runs) the guard is published on the host's loopback, which is this process's, and the egress
 * relay dials `host.docker.internal`, which is this process too. As a container on the
 * deployment network that the run gate relays to by name (`joined`: RYPH_DOCKER_GATE_TARGET,
 * which RYPH_DOCKER_RUN_NETWORK requires) the guard is dialled by name and the relay sends to that
 * name. A process that is a container and NOT joined has neither: its loopback is not the docker
 * host's, where the guard is published, and `host.docker.internal` is the host, where its tool
 * listener is not — so every hosted server would launch and never answer, with nothing said.
 * Refused at boot, naming the fix, rather than guessing a third position from the network alone.
 */
export function embeddedHostingRefusal(o: {
  hosting: boolean;
  joined: boolean;
  /** This process runs in a container: RYPH_BIND_SCOPE=container, or the runtime's marker file. */
  inContainer: boolean;
}): string | null {
  if (!o.hosting || o.joined || !o.inContainer) return null;
  return "this process runs in a container with the launcher embedded (RYPH_LAUNCHER_URL unset), " +
    "where hosted MCP servers cannot reach it: the tool guard would be published on the docker " +
    "host's loopback, not this container's, and their egress would go to host.docker.internal, " +
    "which is not this process. Set RYPH_DOCKER_RUN_NETWORK and RYPH_DOCKER_GATE_TARGET (this " +
    "container's name on RYPH_DOCKER_NETWORK) so both are reached by name, or run the launcher " +
    "as its own service and point RYPH_LAUNCHER_URL at it (deploy/compose)";
}

/** Throws with the message the boot fails on. */
export async function connectLauncher(opts: ConnectLauncherOptions): Promise<HostLauncher> {
  const diag = loggerDiagnostics("launcher");
  const setting = opts.setting?.trim() || EMBEDDED_LAUNCHER;
  let url: string;
  let token: string;
  let toolsToken: string | null;
  let embedded: RunningLauncher | null = null;
  if (setting === EMBEDDED_LAUNCHER) {
    token = mint();
    toolsToken = opts.hosting ? mint() : null;
    embedded = await startLauncher({
      ...opts.embedded(),
      token,
      toolsToken,
      // Its one caller is this process, so a build's `defaultBranch` is this process's own word:
      // no trust boundary lies between them, and builds behave as they did in-process.
      trustDefaultBranch: true,
      // The binary is the daemon's one tenant, so an unconfined build may tag the universal
      // image's public names, as builds did in-process (the docker builder's header).
      soleTenant: true,
      serve: (handler) => serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler),
    });
    url = embedded.url;
  } else {
    if (!URL.canParse(setting) || !/^https?:$/.test(new URL(setting).protocol)) {
      throw new Error(`RYPH_LAUNCHER_URL must be an http(s) URL or "embedded", got ${setting}`);
    }
    url = setting.replace(/\/+$/, "");
    token = opts.token ??
      (() => {
        throw new Error("RYPH_LAUNCHER_URL names a launcher, which needs RYPH_LAUNCHER_TOKEN");
      })();
    toolsToken = opts.toolsToken ?? null;
  }

  const clients = launcherClients({ url, token }, diag);
  let info: LauncherInfo;
  try {
    info = await awaitLauncherInfo(clients, url, embedded === null ? (opts.waitMs ?? 30_000) : 0);
  } catch (err) {
    await embedded?.close();
    throw err;
  }

  let toolHost: HostLauncher["toolHost"];
  if (!opts.hosting) {
    toolHost = { unavailable: "tool access is off on this deployment" };
  } else if (toolsToken === null) {
    toolHost = {
      unavailable: "the docker launcher is reached without RYPH_LAUNCHER_TOOLS_TOKEN, so hosted " +
        "servers cannot be launched — set it, or register the server as a remote URL",
    };
  } else {
    // The run side has just answered, so the launcher is up; a tool side that does not answer
    // within the run side's wait (a wrong tools token, a launcher that hosts nothing) takes
    // hosting away, said here, rather than the whole boot.
    try {
      toolHost = await connectLauncherToolHost({ url, token: toolsToken }, {
        waitMs: embedded === null ? (opts.waitMs ?? 30_000) : 0,
      });
    } catch (err) {
      // A launcher of another version is no launcher to boot against at all.
      if (err instanceof WireMismatch) throw err;
      const why = err instanceof Error ? err.message : String(err);
      diag.warn("launcher.tools_unavailable", { url, err: why });
      toolHost = {
        unavailable:
          `the docker launcher at ${url} does not host MCP servers for this process: ${why}`,
      };
    }
  }
  return { clients, info, toolHost, embedded, url };
}
