// The STANDALONE composition root — the MCP gateway as its own process, for the networked
// deployment where each service is its own socket. The default single-process deployment is the
// ryph binary, which instead calls setup() and spreads this package's routes into its own
// router; this file knows which adapter stands behind each gate, reads the environment, and owns
// the sockets.
//
// TWO LISTENERS, deliberately, because the two halves this package has (see mod.ts) have nothing
// in common but a store:
// - the DATA plane (RYPH_MCP_GATEWAY_PORT): what agent containers dial as "the MCP server".
//   Authenticates virtual tokens, forwards tool calls with the real credential, and must be
//   reachable from the run network — which is exactly the network least entitled to a management
//   surface.
// - the CONTROL plane (RYPH_MCP_GATEWAY_CONTROL_PORT): server CRUD and probe for users, gated
//   by the same @ryph/auth JWKS the orchestrator verifies against, plus the internal surface
//   the control plane dials to mint and kill run credentials. Nothing an agent container should
//   be able to reach at all.
//
// HOSTING IS OFF UNLESS THE DEPLOYMENT NAMES A BACKEND — `RYPH_TOOL_HOST`, unset by default.
// Hosted servers need somewhere to run a vendor's container, and the LOCAL backend is a docker
// socket, which this repository refuses to hand a master-key-holding process (the networked
// compose.yaml withholds exactly that from the control plane). So `RYPH_TOOL_HOST=docker` does not
// exist here, and unset the catalogue answers `hostingAvailable: false` with the reason, and a
// vendor server is declared as a compose service and registered as a remote URL
// (deploy/compose-networked/README.md has the recipe).
//
// `RYPH_TOOL_HOST=launcher` is how docker hosting happens without the socket: the docker
// launcher (@ryph/launcher) holds it, and this process reaches it at RYPH_LAUNCHER_URL with
// RYPH_LAUNCHER_TOOLS_TOKEN — a token that opens the launcher's tool-host routes and none of its
// run-side ones, so what a compromise of this process gains is starting and stopping unprivileged
// `ryph-tool-*` containers of any image on the tools network, under the launcher's runtime
// (RYPH_DOCKER_RUNTIME, the one runs get) — what hosting a vendor's image does, minus the admin
// who chose that image. It gains no run, no mount and no other network: the tools network is
// internal, and the guard, the one container also on an ordinary network, runs the launcher's
// image and no other. The launcher hosts with `joined` (adapters/tool_host/launcher.ts): this
// process is on the guard's ordinary network (the deployment's) — never on the tools network —
// and dials the guard by name. The guard's image and the tools network's way out are the
// launcher's to say; what this process brings is RYPH_EGRESS_TOOL_KEY, which signs the claim
// every hosted server presents to the egress proxy's tool listener (core/tool_egress.ts) and
// opens nothing a run's key does. No hosting lease: docker has no rolling update, and compose
// replaces this container stop-first, so there is never a second gateway acting on the same
// names — the one-gateway-by-construction case `SOLE_GATEWAY` exists for (core/lease.ts).
//
// `RYPH_TOOL_HOST=kubernetes` is the backend that changes the answer, and it is not the same
// bargain. What it hands this process is not a socket that is root on the machine but a
// ServiceAccount token whose Role covers six verbs in ONE namespace — it cannot read a Secret
// back, cannot touch the services' or the runs' namespace, and cannot reach the node. On top of
// that the tools namespace has NetworkPolicies a run cannot cross, which is a boundary neither
// local backend can actually enforce. See adapters/tool_host/kubernetes.ts and
// deploy/helm/ryph/templates/tools.yaml, which declares every object that grant names.
//
// The master key lives HERE and only here. RYPH_MCP_KEY seals MCP credentials; the model
// proxy's RYPH_SECRETS_KEY is a different key for a different secret class, and a compromise of
// one process opens one class.

import { Logger, setupLoggerFromEnv } from "@ryph/logger";
import { verifierFromUrl } from "@ryph/auth";
import {
  installDrain,
  makeHealth,
  makeLease,
  quietDrainErrors,
  refusePublicDevSecrets,
  secretFromEnv,
  serve,
  trackStreams,
} from "@ryph/service";
import { importMasterKey, makeRunReadGate, makeServiceGate, type MasterKey } from "@ryph/sealed";
import { makeRouter } from "@ryph/shared/http";
import { systemResolve } from "./adapters/dns.ts";
import { makeCapabilityGate, makeGrantBearer } from "@ryph/auth/gates";
import { directoryCatalogue } from "./adapters/catalogue/directory.ts";
import {
  kubernetesToolHost,
  kubernetesToolHostOptionsFromEnv,
} from "./adapters/tool_host/kubernetes.ts";
import type { ToolHost } from "./ports/tool_host.ts";
import {
  connectLauncherToolHost,
  launcherToolSettingsRefusal,
} from "./adapters/tool_host/launcher.ts";
import { HOSTING_LEASE_NAME, hostingLeaseStore } from "./adapters/lease/kubernetes.ts";
import type { HostingLease } from "./core/lease.ts";
import { toolEgressKeyFromEnv } from "./core/tool_egress.ts";
import { internalMcpRoutes } from "./http/internal.ts";
import { DEFAULT_LIMITS, type PlatformUpstreams } from "./http/proxy.ts";
import {
  ensurePlatformChatServer,
  ensurePlatformForgeServer,
  ensurePlatformMemoryServer,
  ensurePlatformWebServer,
  PLATFORM_CHAT_SLUG,
  PLATFORM_FORGE_SLUG,
  PLATFORM_MEMORY_SLUG,
  PLATFORM_WEB_SLUG,
} from "./core/platform.ts";
import { setup } from "./setup.ts";
import { drizzleGatewayStore } from "./adapters/store/drizzle.ts";
import { makeMcpGatewayDb } from "./adapters/store/db/db.ts";

const env = (name: string): string | undefined => process.env[name] || undefined;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

const intEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** How long before the drain deadline a still-open stream is ended. */
const STREAM_CUT_BEFORE_DEADLINE_MS = 3_000;

/** Like `intEnv`, but zero is a meaningful answer — "no pause", "no deadline". */
const msEnv = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

/** `1`, `true`, `yes` (any case) switch a flag on; anything else, including unset, leaves it off. */
const flagEnv = (name: string): boolean => /^(1|true|yes)$/i.test(env(name) ?? "");

export async function main(): Promise<void> {
  refusePublicDevSecrets("mcp-gateway");
  const port = intEnv("RYPH_MCP_GATEWAY_PORT", 7430);
  const controlPort = intEnv("RYPH_MCP_GATEWAY_CONTROL_PORT", 7431);
  setupLoggerFromEnv();
  const log = new Logger("mcp-gateway");
  const diag = {
    debug: (event: string, fields?: Record<string, unknown>) => log.debug(event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => log.warn(event, fields),
  };

  const masterKeyHex = env("RYPH_MCP_KEY") ??
    fail("RYPH_MCP_KEY is required — the gateway cannot unseal credentials without it");
  let masterKey: MasterKey;
  try {
    masterKey = await importMasterKey(masterKeyHex);
  } catch (err) {
    fail(`RYPH_MCP_KEY: ${err instanceof Error ? err.message : String(err)}`);
  }

  // A ryph database URL (see @ryph/db). A standalone gateway owns its own database and is
  // the only reader and writer of these tables; the control plane reaches them over the internal
  // surface below, never by connecting here.
  const dbUrl = env("RYPH_DB") ?? "pglite:./data/ryph";
  const dbHandle = await makeMcpGatewayDb(dbUrl);
  const store = drizzleGatewayStore(dbHandle);
  try {
    await store.listServers();
  } catch (err) {
    // The handle's description is password-redacted; the raw URL never reaches a log.
    fail(
      `database ${dbHandle.description} did not answer the startup probe ` +
        `(${err instanceof Error ? err.message : String(err)}) — if it has no schema, run ` +
        "`bun run db:push` in packages/mcp-gateway. On Kubernetes the pod's `migrate` init " +
        "container applies it before this starts: read its log (`kubectl logs <pod> -c migrate`). " +
        "If the database did not answer at all, check RYPH_DB and the NetworkPolicy to the database",
    );
  }

  // What an AGENT CONTAINER dials — a container-network address, not this process's bind address.
  // Unset, servers can still be registered and probed; only minting is refused, and it says so.
  const gatewayUrl = env("RYPH_MCP_GATEWAY_URL") ?? null;
  if (gatewayUrl === null) {
    log.warn("RYPH_MCP_GATEWAY_URL unset — runs with a tool policy will fail at boot");
  }

  // Where the gateway may dial. Both flags widen the default; both are logged when set, because
  // each is a route the deployment is choosing to grant.
  const upstream = {
    allowInsecure: flagEnv("RYPH_MCP_ALLOW_INSECURE"),
    allowPrivate: flagEnv("RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS"),
    resolve: systemResolve,
  };
  if (upstream.allowInsecure) {
    log.warn("RYPH_MCP_ALLOW_INSECURE — plain http upstreams permitted");
  }
  if (upstream.allowPrivate) {
    log.warn("RYPH_MCP_ALLOW_PRIVATE_UPSTREAMS — private-range upstreams permitted");
  }

  // Server CRUD: the same @ryph/auth verification the orchestrator does, against the SAME JWKS,
  // which is what lets the app forward one user bearer to whichever service owns the path.
  const authDisabled = env("RYPH_AUTH") === "off";
  if (authDisabled) log.warn("RYPH_AUTH=off — the server management surface is OPEN");
  const authUrl = env("RYPH_AUTH_URL");
  if (authUrl && !URL.canParse("/.well-known/jwks.json", authUrl)) {
    fail(`RYPH_AUTH_URL must be a valid absolute URL, got ${JSON.stringify(authUrl)}`);
  }
  const verifier = authUrl
    ? verifierFromUrl(new URL("/.well-known/jwks.json", authUrl).href)
    : { verify: () => Promise.resolve(null) };
  if (!authUrl && !authDisabled) {
    log.warn("RYPH_AUTH_URL unset — no user token verifies, so nobody can manage servers");
  }
  const gateOpts = {
    verifier,
    disabled: authDisabled,
  };
  // Two gates over one verification: listing servers takes `tools:read` (the agent form needs
  // the names), managing one — and so its credential — takes `tools:manage`.
  const authenticate = makeCapabilityGate(gateOpts, "tools:read");
  const authenticateManage = makeCapabilityGate(gateOpts, "tools:manage");

  let catalogue;
  try {
    catalogue = await directoryCatalogue();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // Where hosted servers run, if anywhere. Unset is the compose posture and the safe default:
  // hosting reads unavailable and the app shows the reason on the catalogue cards.
  const toolHostKind = env("RYPH_TOOL_HOST") ?? "none";
  const guardImage = env("RYPH_TOOL_GUARD_IMAGE") ?? "";
  // Hosted servers' egress claims are signed with this; the egress proxy's tool listener holds the
  // same. Only a tool host that relays them to the proxy uses it (the docker launcher).
  const toolEgressKey = toolEgressKeyFromEnv(env, fail);
  let toolHost: ToolHost | { unavailable: string };
  let hostingLease: HostingLease | undefined;
  if (toolHostKind === "none") {
    toolHost = {
      unavailable: "this deployment runs no container backend for the gateway — register the " +
        "server as a remote URL instead, or set RYPH_TOOL_HOST (deploy/README.md)",
    };
  } else if (toolHostKind === "kubernetes") {
    if (guardImage === "") {
      fail(
        "RYPH_TOOL_HOST=kubernetes needs RYPH_TOOL_GUARD_IMAGE — the tool guard is the one " +
          "entry point onto the tools namespace, and a cluster has no local image store to " +
          "find it in (`bun run images:publish` publishes it beside the services)",
      );
    }
    const kube = kubernetesToolHostOptionsFromEnv(env, fail);
    // Kubernetes runs two gateways at once through every rolling update and every eviction, and
    // hosting acts by name, so here it takes a lease before it acts (core/lease.ts). The identity
    // is per PROCESS: a container the kubelet restarts must not think it holds its old lease.
    const lease = makeLease({
      store: hostingLeaseStore({ ...kube, name: HOSTING_LEASE_NAME }),
      identity: `${env("HOSTNAME") ?? "mcp-gateway"}-${crypto.randomUUID().slice(0, 8)}`,
      now: () => new Date(),
      diag,
    });
    hostingLease = lease;
    // Hosting checks the lease before each launch or stop; the adapter checks it again before each
    // request inside one, which is where a stalled holder would otherwise resume.
    toolHost = kubernetesToolHost(kube, { mayAct: () => lease.held() });
  } else if (toolHostKind === "launcher") {
    // The guard's image is the launcher's (RYPH_TOOL_GUARD_IMAGE there, refused here), and it
    // says it in its info.
    const url = env("RYPH_LAUNCHER_URL") ??
      fail("RYPH_TOOL_HOST=launcher needs RYPH_LAUNCHER_URL, where the docker launcher listens");
    const owned = launcherToolSettingsRefusal(env, url);
    if (owned !== null) fail(owned);
    // The variable or the file RYPH_LAUNCHER_TOOLS_TOKEN_FILE names, as every launcher caller
    // reads its token (deploy/compose: minted by the launcher into a volume mounted read-only).
    let token: string | undefined;
    try {
      token = secretFromEnv(env, "RYPH_LAUNCHER_TOOLS_TOKEN");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    if (token === undefined) {
      fail(
        "RYPH_TOOL_HOST=launcher needs RYPH_LAUNCHER_TOOLS_TOKEN, or a file named by " +
          "RYPH_LAUNCHER_TOOLS_TOKEN_FILE: its credential for the launcher's tool routes",
      );
    }
    try {
      toolHost = await connectLauncherToolHost({ url, token });
    } catch (err) {
      fail(`the docker launcher at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A launcher that confines hosted servers and relays them to the egress proxy needs every
    // one of them to carry a claim this process signs: without the key, none reaches its API.
    if (toolHost.egressProxy != null && toolEgressKey === null) {
      fail(
        `the docker launcher at ${url} sends hosted servers to the internet through the egress ` +
          "proxy, which needs RYPH_EGRESS_TOOL_KEY here to sign their claims (the egress proxy " +
          "holds the same) — `bun run compose:init` writes one",
      );
    }
  } else {
    fail(
      `RYPH_TOOL_HOST must be "kubernetes", "launcher" or unset, got ${
        JSON.stringify(toolHostKind)
      }`,
    );
  }

  // How long a launched server gets to answer before it reads unreachable. A tool pod may first
  // wait for a node: Autopilot took about two and a half minutes to add a gVisor node when
  // measured, and a window shorter than that deletes the pod the node was being made for, only
  // for the relaunch to wait all over again.
  const hostingStartupTimeoutMs = intEnv("RYPH_MCP_HOSTING_STARTUP_TIMEOUT_MS", 5 * 60_000);

  /** Set once the drain is installed; a lost hosting lease uses it to take the process down. */
  let requestDrain: (() => Promise<void>) | null = null;

  // The platform's memory server: wired when the deployment names the memory service and the
  // credential this gateway presents to it. The row is seeded here, at boot, so the agent form
  // lists it and the orchestrator's default scope entry resolves; without both variables there is
  // no row, and an orchestrator that adds the entry anyway boot-fails its runs with the reason.
  const memoryUrl = env("RYPH_MEMORY_URL")?.replace(/\/+$/, "") ?? null;
  const memoryGatewayToken = env("RYPH_MEMORY_GATEWAY_TOKEN") ?? null;
  if ((memoryUrl === null) !== (memoryGatewayToken === null)) {
    fail("RYPH_MEMORY_URL and RYPH_MEMORY_GATEWAY_TOKEN must be set together");
  }
  const platform: PlatformUpstreams = {};
  if (memoryUrl !== null && memoryGatewayToken !== null) {
    const seeded = await ensurePlatformMemoryServer(store, new Date().toISOString());
    if (seeded.ok) {
      platform[PLATFORM_MEMORY_SLUG] = {
        url: `${memoryUrl}/v1/memory-mcp`,
        token: memoryGatewayToken,
      };
    } else {
      // Serve anyway: the remedy — renaming or archiving the server holding the slug — is a call
      // to the management surface THIS process serves, so exiting would take the fix down with
      // the fault. The platform upstream stays unwired and a run scoped to it gets the 502.
      log.error(seeded.reason);
    }
  }
  // The platform's chat server, the same way: the chat service's MCP route and the credential
  // this gateway presents to it. A run a response bound to a chatroom carries the row in its
  // frozen scope; every other run never sees it.
  const chatUrl = env("RYPH_CHAT_URL")?.replace(/\/+$/, "") ?? null;
  const chatGatewayToken = env("RYPH_CHAT_GATEWAY_TOKEN") ?? null;
  if ((chatUrl === null) !== (chatGatewayToken === null)) {
    fail("RYPH_CHAT_URL and RYPH_CHAT_GATEWAY_TOKEN must be set together");
  }
  if (chatUrl !== null && chatGatewayToken !== null) {
    const seeded = await ensurePlatformChatServer(store, new Date().toISOString());
    if (seeded.ok) {
      platform[PLATFORM_CHAT_SLUG] = { url: `${chatUrl}/v1/chat-mcp`, token: chatGatewayToken };
    } else {
      log.error(seeded.reason);
    }
  }
  // The platform's forge server, the same way once more: the forge's tool surface and the
  // credential this gateway presents to it. The orchestrator adds the row to a run's frozen scope
  // only for an agent with a forge policy, with the allowlist its capabilities derive.
  const forgeToolsUrl = env("RYPH_FORGE_TOOLS_URL")?.replace(/\/+$/, "") ?? null;
  const forgeGatewayToken = env("RYPH_FORGE_GATEWAY_TOKEN") ?? null;
  if ((forgeToolsUrl === null) !== (forgeGatewayToken === null)) {
    fail("RYPH_FORGE_TOOLS_URL and RYPH_FORGE_GATEWAY_TOKEN must be set together");
  }
  if (forgeToolsUrl !== null && forgeGatewayToken !== null) {
    const seeded = await ensurePlatformForgeServer(store, new Date().toISOString());
    if (seeded.ok) {
      platform[PLATFORM_FORGE_SLUG] = {
        url: `${forgeToolsUrl}/v1/forge-mcp`,
        token: forgeGatewayToken,
      };
    } else {
      log.error(seeded.reason);
    }
  }

  // The platform's web server: the web service's MCP route and the credential this gateway
  // presents to it. Unlike the three above it carries no state of the platform's at all — what
  // it grants a run is the public internet, read-only, metered here like every other tool call.
  // A deployment that does not name it simply has no web tools: the row is not seeded, the agent
  // form does not list it, and the orchestrator's default entry never resolves.
  const webUrl = env("RYPH_WEB_URL")?.replace(/\/+$/, "") ?? null;
  const webGatewayToken = env("RYPH_WEB_GATEWAY_TOKEN") ?? null;
  if ((webUrl === null) !== (webGatewayToken === null)) {
    fail("RYPH_WEB_URL and RYPH_WEB_GATEWAY_TOKEN must be set together");
  }
  if (webUrl !== null && webGatewayToken !== null) {
    const seeded = await ensurePlatformWebServer(store, new Date().toISOString());
    if (seeded.ok) {
      platform[PLATFORM_WEB_SLUG] = { url: `${webUrl}/v1/web-mcp`, token: webGatewayToken };
    } else {
      log.error(seeded.reason);
    }
  }

  // The control plane presents this on the internal surface, and signs run grants with it: a
  // run's trail is read with the grant minted for that run, or by whoever manages tools.
  const gatewayToken = env("RYPH_MCP_GATEWAY_TOKEN") ?? null;
  const gateway = setup({
    store,
    masterKey,
    authenticate,
    authenticateManage,
    authenticateRunRead: makeRunReadGate({
      grantKey: gatewayToken,
      // As on the model proxy: the grant proves scope, a verified bearer proves identity, and
      // neither substitutes for the other.
      bearer: makeGrantBearer(gateOpts),
      fallback: authenticateManage,
    }),
    gatewayUrl,
    virtualKeyTtlMs: intEnv("RYPH_MCP_VIRTUAL_KEY_TTL_MS", 12 * 60 * 60 * 1000),
    // Every other cap is a code default (see DEFAULT_LIMITS); this one is a deployment's to set,
    // because what a run legitimately spends depends on the agents it runs.
    limits: {
      perRunRequests: intEnv("RYPH_MCP_PER_RUN_REQUESTS", DEFAULT_LIMITS.perRunRequests),
    },
    upstream,
    catalogue,
    toolHost,
    ...(guardImage === "" ? {} : { guardImage }),
    ...(toolEgressKey === null ? {} : { toolEgressKey }),
    hostingLimits: { startupTimeoutMs: hostingStartupTimeoutMs },
    hostingLease,
    platform: Object.keys(platform).length === 0 ? undefined : platform,
    // Restart rather than recover in place: a drain and an exit put this process back in the one
    // state known to be sound — waiting for the lease — once the kubelet restarts the container.
    onHostingLeaseLost: () => {
      log.warn("hosting lease lost — draining, so the container restarts and waits for it again");
      void requestDrain?.();
    },
    now: () => new Date(),
    diag,
  });

  // The internal surface exists only for a REMOTE control plane, so it is gated on having a
  // credential to check rather than mounted unauthenticated.
  if (gatewayToken === null) {
    log.warn(
      "RYPH_MCP_GATEWAY_TOKEN unset — the internal surface is dark, so no control plane can " +
        "issue run credentials from this gateway",
    );
  }
  const internalRoutes = gatewayToken === null ? [] : internalMcpRoutes({
    store,
    issuer: gateway.issuer,
    archive: gateway.archive,
    authenticate: makeServiceGate(gatewayToken),
    now: () => new Date(),
    diag,
  });

  // Readiness is one cheap read of the table both halves depend on. Liveness asks nothing: a
  // database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({ ready: () => store.listServers(), log: diag });

  const dataStreams = trackStreams({ work: (req) => req.method === "POST" });
  const controlStreams = trackStreams();
  const dataServer = await serve(
    { port, onError: quietDrainErrors },
    dataStreams.wrap(async (req) => {
      for (const route of health.routes) {
        if (req.method === route.method && route.pattern.exec(req.url)) {
          return await route.handler(req, {});
        }
      }
      return await gateway.gatewayHandler(req);
    }),
  );
  const controlServer = await serve(
    { port: controlPort },
    controlStreams.wrap(makeRouter([...health.routes, ...gateway.routes, ...internalRoutes])),
  );
  log.info(`data plane on :${port}, control plane on :${controlPort}`, {
    db: dbHandle.description,
    gatewayUrl: gatewayUrl ?? "unset",
    auth: authUrl ?? (authDisabled ? "off" : "none"),
    internal: gatewayToken === null ? "dark" : "on",
    hosting: toolHostKind,
    memory: memoryUrl ?? "off",
    chat: chatUrl ?? "off",
    forge: forgeToolsUrl ?? "off",
  });

  // Hosted MCP servers: boot in the BACKGROUND — the namespace check, the guard, then a
  // reconcile against every hosted row — so a slow image pull never holds up the listeners. The
  // gateway is ready before hosting is; until it lands the catalogue says hosting is starting.
  // (Mode A does the same, in packages/host/src/main.ts, for the same reason.)
  const hosting = gateway.hosting;
  let supervisor: ReturnType<typeof setInterval> | null = null;
  /** Set as the drain stops hosting — a boot finishing after that has nothing to report. */
  let hostingStopped = false;
  if (toolHostKind !== "none") {
    hosting.boot().then(() => {
      if (hostingStopped) return;
      const availability = hosting.availability();
      if (availability.available) {
        log.info("hosted MCP servers on", {
          backend: toolHostKind,
          guard: hosting.guard()?.origin ?? "?",
        });
      } else {
        log.warn(`hosted MCP servers unavailable — ${availability.reason}`);
      }
    });
    // Slower than the reaper's tick: each one is a probe per healthy server, and a server three
    // probes from "unreachable" should not get there in thirty seconds.
    let superviseInFlight = false;
    supervisor = setInterval(() => {
      if (superviseInFlight) return;
      superviseInFlight = true;
      hosting.supervise()
        .catch((err) => diag.warn("hosting.supervise_failed", { err: String(err) }))
        .finally(() => (superviseInFlight = false));
    }, intEnv("RYPH_MCP_SUPERVISOR_INTERVAL_MS", 30_000));
  }

  // A tool call can legitimately run for a while, so a POST's stream is work: it gets most of the
  // deadline before the drain cuts it, which lands the cut inside the deadline rather than at it,
  // and a cut forward is a failed tool call the harness sees and can retry. The server→client GET
  // stream lives for the whole session; it is a tail, ended at once, and the client reconnects.
  const deadlineMs = msEnv("RYPH_DRAIN_DEADLINE_MS", 25_000);
  requestDrain = installDrain({
    servers: [
      {
        name: "data plane",
        server: dataServer,
        streams: dataStreams,
        streamsGraceMs: Math.max(0, deadlineMs - STREAM_CUT_BEFORE_DEADLINE_MS),
      },
      { name: "control plane", server: controlServer, streams: controlStreams },
    ],
    beginDrain: health.beginDrain,
    close: async () => {
      hostingStopped = true;
      if (supervisor !== null) clearInterval(supervisor);
      // Every hosted container and the guard, and no row touched: the next boot relaunches what
      // the rows say should run. Nothing they hold outlives this process — the guard's token
      // rotates on every boot, and so does each caller token — so a Deployment left standing
      // would be relaunched at the next boot anyway, and answer nobody until then. Then the
      // hosting lease is released, so the next gateway starts once this sweep is done — and a
      // process that lost the lease sweeps nothing (core/hosting.ts).
      await hosting.shutdown();
      await store.close();
    },
    preStopMs: msEnv("RYPH_PRE_STOP_MS", 0),
    deadlineMs,
    log,
  });
}

if (import.meta.main) {
  await main();
}
