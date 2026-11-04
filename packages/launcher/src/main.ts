// The docker launcher's composition root — the only process that runs the docker CLI, and the
// only one that holds the docker socket. It holds no platform
// secret and reads no database: what it has is the socket, two service tokens, and its own
// configuration of everything about a container a caller must not choose.
//
// Two ways to run it, one code path, the forge's precedent:
// - EMBEDDED: the binary (@ryph/host) calls `startLauncher` with the docker configuration it read
//   and two tokens it minted for this boot, binds it to loopback on a free port, and reaches it
//   with the same clients a remote launcher gets. So the binary exercises the seam every compose
//   deployment depends on.
// - STANDALONE: `main()` reads the same configuration from the environment (config.ts) and serves
//   it on RYPH_LAUNCHER_PORT for a control plane and an mcp-gateway in other containers.
//
// What it does at boot, so a caller never has to run docker for it:
// - refuses a run network that cannot confine runs (`runNetworkProblem`), the boot check the host
//   used to make itself
// - makes the run gate, in the background, and says how that went in its own log
//   (`ensureGate`'s outcomes are emitted where they happen)
// - says loudly when hosting is on and the engine cannot confine hosted servers (Podman, a
//   native engine before 28): hosting's own boot is refused then, naming why (src/tools.ts)
// - starts fetching its images ahead (the prefetch's state is its own, so a launcher restarted
//   alone does not sit "queued" until a caller asks); a caller's start is a retry
// - asks docker whether it answers, and says loudly when the socket refuses it (a group the
//   container is not in) apart from a daemon that is merely not up yet. Readiness (/readyz)
//   answers only while docker does. Callers start once the launcher has started, not once it is
//   ready, so a caller can boot against one whose docker does not answer; it warns at boot
//   (`engineAbsentWarning`) instead

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import {
  type HttpServer,
  installDrain,
  makeHealth,
  refusePublicDevSecrets,
  serve,
  type ServeHandler,
} from "@ryph/service";
import {
  BEAT_MS,
  type CommandRunner,
  createEnvironmentBuilder,
  deploymentId,
  type Diagnostics,
  docker as realDocker,
  dockerCheckLauncher,
  dockerEngine,
  type DockerExec,
  dockerImagePrefetch,
  type DockerOptions,
  dockerProvisioner,
  ensureGate,
  type EnvironmentsConfig,
  everyBuildRefused,
  gateForcedWarning,
  gateName,
  inspectInternalNetwork,
  loggerDiagnostics,
  type PrefetchName,
  runNetworkProblem,
} from "@ryph/orchestrator/docker";
import { type DockerToolCli, dockerToolHost } from "@ryph/mcp-gateway/tool-host";
import { launcherRoutes } from "./routes.ts";
import { launcherConfigFromEnv, type ToolsConfig, withTokenFiles } from "./config.ts";
import {
  edgeOf,
  egressRelayOrigin,
  prepareTools,
  toolsEngineProblem,
  verifyToolNetwork,
} from "./tools.ts";
import { statSync } from "node:fs";

export {
  gateFromEnv,
  type LauncherConfig,
  launcherConfigFromEnv,
  prefetchImages,
  prefetchOn,
  toolEgressFromEnv,
  type ToolsConfig,
  withTokenFiles,
} from "./config.ts";
export { egressRelayName, egressRelayOrigin } from "./tools.ts";

/**
 * What a launcher is built from. Every field but `port`, `serve` and the test seams is a decision
 * about containers that a request can never make — the host, embedding one, decides them from its
 * own configuration; the standalone `main` reads them from the environment.
 */
export interface LauncherStartOptions {
  /** RYPH_LAUNCHER_TOKEN: opens the run-side routes. */
  token: string;
  /** RYPH_LAUNCHER_TOOLS_TOKEN: opens the tool-host routes. Null: hosting is off. */
  toolsToken: string | null;
  /** The networks, the runtime and the gate every run, check and build is launched with. */
  docker: DockerOptions;
  /** Whether check suites are launched here. */
  checks: boolean;
  /** The docker environment builder's configuration; null: no builds here. */
  environments: EnvironmentsConfig | null;
  /** Read by the builder for its own knobs (RYPH_ENV_BUILDKIT_IMAGE …); default process.env. */
  env?: (name: string) => string | undefined;
  /** The images fetched ahead of the first launch that needs them; null: none. */
  prefetch: Array<{ name: PrefetchName; image: string }> | null;
  /**
   * How hosted MCP servers run: the tools network (made internal here), the guard's ordinary
   * network and whether the caller is on it (`joined`: the guard dialled by name, nothing
   * published), the guard's image, and the egress relay's target. Null: no hosting.
   */
  tools: ToolsConfig | null;
  /** Where to listen when `serve` is not given: every interface on this port (default 7470). */
  port?: number;
  /** How the launcher listens, when the process embedding it decides (loopback, a free port). */
  serve?: (handler: ServeHandler) => Promise<HttpServer>;
  /** Tests: one fake docker CLI for every adapter, and the tool host's and builder's. */
  exec?: DockerExec;
  toolCli?: DockerToolCli;
  run?: CommandRunner;
  /** Tests: how often a long call beats. */
  beatMs?: number;
  /** Tests: how long a request body may take to arrive (routes.ts `BODY_READ_MS`). */
  bodyReadMs?: number;
  /**
   * Whether a build's `defaultBranch` is taken at its caller's word where runs are sandboxed
   * (the docker builder's `trustDefaultBranch`). The binary's embedded launcher says yes: its
   * caller is its own process. A standalone launcher only on RYPH_ENV_TRUST_DEFAULT_BRANCH=on.
   */
  trustDefaultBranch?: boolean;
  /**
   * Whether this launcher's deployment is the docker daemon's one tenant, so its builds may run
   * unconfined: an unconfined build tags the universal image's public names, which every build
   * on the daemon reads. The binary's embedded launcher says yes. A standalone launcher never
   * does, so it builds only where RYPH_DOCKER_RUN_NETWORK confines runs, and says so in /v1/info
   * (`buildsRefused`).
   */
  soleTenant?: boolean;
  /** Tests: how long `close` waits for in-flight calls before letting go of them. */
  closeMs?: number;
}

/** A launcher that is serving. */
export interface RunningLauncher {
  server: HttpServer;
  /** Where it answers, as this process dials it. */
  url: string;
  /** Fails readiness, and stops every long call's work (a build) so the drain is not held by it. */
  beginDrain(): void;
  /**
   * Stops the work still running and the listener, waiting at most `closeMs` (2 s) for the
   * in-flight calls: a launch pulling inline or a `docker stop -t 30` would otherwise hold the
   * process that embeds this — and its database — open for as long as docker takes. What is cut
   * off is docker's to finish: the container still starts or stops, and the next boot's reconcile
   * finds it.
   */
  close(): Promise<void>;
}

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** How long `close` waits for in-flight calls. */
const CLOSE_MS = 2_000;
/** The standalone drain's default: past a graceful kill's `docker stop -t 30` (see `main`). */
export const DRAIN_DEADLINE_MS = 40_000;

/** A duration in ms from the environment, where zero means none, as every service main reads it. */
function msEnv(name: string, fallback: number, fail: (message: string) => never): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}
/** How long readiness's docker probe may take, and how long an answer counts. */
const PROBE_MS = 5_000;
const PROBE_FRESH_MS = 10_000;

/** A socket the daemon is up behind but this process may not open: a group it is not in. */
const permissionDenied = (err: unknown) =>
  /permission denied|EACCES/i.test(said(err)) && /docker|sock/i.test(said(err));

/**
 * Says why docker refused at boot, as specifically as it can: a socket this process may not open
 * names the socket's group and this process's groups, and DOCKER_GID, compose's way to give the
 * launcher that group.
 */
function socketRefusal(err: unknown): string {
  const path = /^unix:\/\//.test(process.env.DOCKER_HOST ?? "")
    ? process.env.DOCKER_HOST!.slice("unix://".length)
    : "/var/run/docker.sock";
  let group = "unknown";
  try {
    group = String(statSync(path).gid);
  } catch {
    // unreadable: said as unknown
  }
  const groups = typeof process.getgroups === "function" ? process.getgroups().join(",") : "?";
  return `the docker socket ${path} refuses this process (${said(err).split("\n")[0]}): it is ` +
    `group ${group}'s, and this process is in groups ${groups}. Every run, check and build will ` +
    `fail until it may open it — in compose, set DOCKER_GID=${group} for the launcher ` +
    "(`stat -c %g /var/run/docker.sock` on the docker host).";
}

/** Builds the adapters and starts listening. Throws on a configuration it must refuse. */
export async function startLauncher(opts: LauncherStartOptions): Promise<RunningLauncher> {
  const log = new Logger("launcher");
  const diag: Diagnostics = loggerDiagnostics("launcher");
  const exec = opts.exec ?? realDocker;
  const docker = opts.docker;
  if (opts.toolsToken !== null && opts.toolsToken === opts.token) {
    throw new Error("the launcher's two tokens must differ: they open different routes");
  }

  // A run network that cannot confine is refused here, before anything is served: a run on it
  // keeps a way out while every log line reads as confined. A daemon that does not answer is left
  // to the first confined launch, which checks again and makes the network.
  if (docker.runNetwork !== undefined) {
    if (docker.gate === undefined) throw new Error("confined runs need the run gate");
    const engine = await dockerEngine(exec).catch(() => null);
    if (engine !== null) {
      const problem = runNetworkProblem(
        docker.runNetwork,
        await inspectInternalNetwork(docker.runNetwork, exec),
        engine,
      );
      if (problem !== null) throw new Error(problem);
    }
  }

  const provisioner = dockerProvisioner(docker, diag, exec);
  const checks = opts.checks ? dockerCheckLauncher(docker, diag, exec) : null;
  // Handed the run provisioner's options, so builds are confined where runs are.
  const builder = opts.environments === null ? null : createEnvironmentBuilder(
    { ...opts.environments, builder: "docker" },
    {
      diag,
      docker,
      ...(opts.env === undefined ? {} : { env: opts.env }),
      ...(opts.run === undefined ? {} : { run: opts.run }),
      trustDefaultBranch: opts.trustDefaultBranch ?? false,
      soleTenant: opts.soleTenant ?? false,
    },
  );
  const prefetch = opts.prefetch === null || opts.prefetch.length === 0
    ? null
    : dockerImagePrefetch(opts.prefetch, loggerDiagnostics("images"), exec);
  const toolsConfig = opts.toolsToken === null ? null : opts.tools;
  const tools = toolsConfig === null ? null : {
    host: dockerToolHost(
      {
        network: toolsConfig.network,
        edge: edgeOf(toolsConfig),
        joined: toolsConfig.joined,
        // Whose servers they are: required beside the tools network's label, so a deployment
        // that shares the network still never reaches another's.
        deployment: deploymentId(docker),
        // Hosted servers run any image a tools-token holder names, so they get the runs' runtime.
        ...(docker.runtime ? { runtime: docker.runtime } : {}),
        // The one image the guard may run, and the one way out: this launcher's, not the caller's.
        guardImage: toolsConfig.guardImage,
        egressProxy: toolsConfig.egress === null ? null : egressRelayOrigin(toolsConfig.network),
        prepare: () => prepareTools(toolsConfig, deploymentId(docker), exec),
        confined: () => verifyToolNetwork(toolsConfig, exec),
      },
      ...(opts.toolCli === undefined ? [] : [opts.toolCli]),
    ),
    network: toolsConfig.network,
    joined: toolsConfig.joined,
  };

  // Whether docker answers, as readiness asks it: one probe at a time, and an answer kept for a
  // few seconds, so a prober every second does not run the docker CLI every second. A probe
  // slower than readiness's own deadline still lands, and the next ask is ready.
  let answeredAt = 0;
  let probing: Promise<void> | null = null;
  const dockerAnswers = (): Promise<void> => {
    if (Date.now() - answeredAt < PROBE_FRESH_MS) return Promise.resolve();
    probing ??= exec(["version", "--format", "{{.Server.Version}}"], {
      signal: AbortSignal.timeout(PROBE_MS),
    }).then(
      () => void (answeredAt = Date.now()),
      (err) => {
        throw new Error(`docker does not answer: ${said(err).split("\n")[0]}`);
      },
    ).finally(() => (probing = null));
    return probing;
  };

  const closing = new AbortController();
  const health = makeHealth({ ready: dockerAnswers, log: diag });
  const buildsRefused = everyBuildRefused({
    runtime: docker.runtime,
    runNetwork: docker.runNetwork,
    trustDefaultBranch: opts.trustDefaultBranch ?? false,
    soleTenant: opts.soleTenant ?? false,
  });
  const routes = launcherRoutes({
    token: opts.token,
    toolsToken: opts.toolsToken ?? crypto.randomUUID(),
    docker,
    provisioner,
    checks,
    builder,
    buildsRefused,
    prefetch,
    tools,
    exec,
    diag,
    closing: closing.signal,
    beatMs: opts.beatMs ?? BEAT_MS,
    ...(opts.bodyReadMs === undefined ? {} : { bodyReadMs: opts.bodyReadMs }),
  });
  const handler: ServeHandler = (req, info) => {
    const path = new URL(req.url).pathname;
    const probe = health.routes.find((r) => r.method === req.method && r.pattern.test(req.url));
    if (probe !== undefined && (path === "/healthz" || path === "/readyz")) {
      return probe.handler(req, {});
    }
    return routes(req, info);
  };
  const port = opts.port ?? 7470;
  const server = opts.serve
    ? await opts.serve(handler)
    : await serve({ port, onListen: () => {} }, handler);
  const host = server.addr.hostname === "0.0.0.0" || server.addr.hostname === "::"
    ? "127.0.0.1"
    : server.addr.hostname;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${server.addr.port}`;
  const bound = server.addr.hostname;
  const listening = `http://${bound.includes(":") ? `[${bound}]` : bound}:${server.addr.port}`;

  // Docker asked once now, in the background, so a socket this process may not open is a loud
  // line at boot rather than every run failing with "permission denied" later; a daemon not up
  // yet is only a warning, since it may well be on its way.
  dockerAnswers().catch((err: unknown) => {
    const cause = (err as Error).message;
    if (permissionDenied(cause)) log.error(socketRefusal(cause));
    else log.warn(`${cause} yet — runs fail to launch until it does`);
  });

  // Hosting on an engine that cannot confine it is refused at hosting's own boot (`prepareTools`),
  // in the gateway's words; said here too, since the gateway may be another container's log.
  if (toolsConfig !== null) {
    dockerEngine(exec).then(
      (engine) => {
        const problem = toolsEngineProblem(toolsConfig.network, engine);
        if (problem !== null) log.warn(`hosted MCP servers will be refused: ${problem}`);
      },
      () => {}, // docker not answering is said above
    );
  }

  // Its own images, fetched ahead from boot: the state is this process's, so nobody else would.
  prefetch?.start().catch((err: unknown) => log.warn(`image prefetch did not start: ${said(err)}`));

  // The gate now rather than at the first confined launch, so a missing image or an absent daemon
  // is a line at boot and not a run that fails minutes from now. In the background: a cold daemon
  // must not hold up serving, and every launch checks again under the same lock.
  if (docker.runNetwork !== undefined) {
    ensureGate(docker, exec).then(
      (ready) => {
        for (const forced of ready.forced ?? []) {
          log.warn(
            `run gate ${forced.gate} replaced although ${forced.live.length} confined ` +
              `container(s) were live behind it, because ${forced.why} — their open connections ` +
              `through it dropped`,
            gateForcedWarning(forced),
          );
        }
        if (ready.state === "deferred") {
          log.warn(
            `run gate left as it is: it no longer matches this configuration, but ` +
              `${ready.live?.length} confined container(s) are live behind it — it is remade on ` +
              `the first launch that finds none running, or once it has waited out the cap`,
            { gate: gateName(docker), live: ready.live?.join(",") },
          );
          return;
        }
        log.info(`run gate ${ready.state === "created" ? "started" : "up"}`, {
          gate: gateName(docker),
          runNetwork: docker.runNetwork,
          routes: docker.gate?.routes.map((r) => `${r.listen}=${r.target}:${r.port}`).join(","),
        });
      },
      (err) => log.warn(`run gate not ready — confined runs will fail to launch: ${said(err)}`),
    );
  }

  log.info(`listening on ${listening}`, {
    network: docker.network ?? "default",
    runs: docker.runNetwork === undefined ? "unconfined" : `confined to ${docker.runNetwork}`,
    runtime: docker.runtime ?? "default",
    checks: checks === null ? "off" : "on",
    builds: builder === null ? "off" : "on",
    prefetch: prefetch === null ? "off" : String(opts.prefetch!.length),
    tools: toolsConfig === null
      ? "off"
      : `${toolsConfig.network} (internal), guard on ${edgeOf(toolsConfig)}` +
        `${toolsConfig.joined ? " dialled by name" : " published on loopback"}, egress ` +
        (toolsConfig.egress === null ? "off" : `via ${egressRelayOrigin(toolsConfig.network)} to ` +
          `${toolsConfig.egress.target}:${toolsConfig.egress.port}`),
  });
  if (builder !== null && buildsRefused !== null) {
    log.warn(`builds are on, but every build is refused: ${buildsRefused}`);
  }

  return {
    server,
    url,
    beginDrain() {
      health.beginDrain();
      closing.abort();
    },
    async close() {
      closing.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cut = await Promise.race([
        server.shutdown().then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), opts.closeMs ?? CLOSE_MS))),
      ]);
      clearTimeout(timer);
      if (cut) {
        log.warn(
          "closed with docker calls still in flight (a launch pulling, a stop waiting out its " +
            "grace) — docker finishes them, and the next reconcile finds what they left",
        );
      }
    },
  };
}

export async function main(): Promise<void> {
  refusePublicDevSecrets("launcher");
  setupLoggerFromEnv();
  const log = new Logger("launcher");
  const fail = (message: string): never => {
    console.error(`error: ${message}`);
    process.exit(2);
  };
  const env = withTokenFiles((name: string) => process.env[name] || undefined, fail);
  const config = launcherConfigFromEnv(env, fail);
  let launcher: RunningLauncher;
  try {
    launcher = await startLauncher({ ...config, env });
  } catch (err) {
    fail(said(err));
  }
  // A launch in flight finishes inside the deadline; a build is stopped at once (beginDrain),
  // since one can run for an hour and dies with this process whatever happens. Not `close`'s
  // two seconds: this process holds no database to keep whole, so waiting out the deadline
  // costs nothing, and a launch answered is a run the caller does not have to reconcile. Longer
  // than every other service's by default: a graceful kill in flight is a `docker stop` waiting
  // out the run's 30 s grace, and cut off it leaves the caller not knowing the run stopped.
  installDrain({
    servers: [launcher!.server],
    beginDrain: () => launcher.beginDrain(),
    deadlineMs: msEnv("RYPH_DRAIN_DEADLINE_MS", DRAIN_DEADLINE_MS, fail),
    log,
  });
}

if (import.meta.main) {
  await main();
}
