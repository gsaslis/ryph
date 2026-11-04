// The package's startup contract for the mounted deployment: one call builds both halves — the
// control side (server CRUD and probe routes, the credential issuer, and hosting) and the data
// side (the gateway handler) — over the ONE store the composition root provides.
//
// Hosting is wired here and STARTED by the composition root: `hosting.boot()` touches a
// container runtime (the tools network, the guard), which is a side effect a wiring function has
// no business performing, and `hosting.supervise()` belongs on the root's interval beside the
// reaper. Until boot, hosting reads unavailable, and says so.

import type { MasterKey } from "@ryph/sealed";
import { makeMcpSealer } from "./core/sealing.ts";
import {
  type HostedOutlook,
  type HostingLimits,
  type HostingService,
  makeHosting,
  unavailableHosting,
} from "./core/hosting.ts";
import type { HostingLease } from "./core/lease.ts";
import { mintToolEgressClaim } from "./core/tool_egress.ts";
import { makeMcpCredentialIssuer, type McpCredentialIssuer } from "./core/service.ts";
import type { UpstreamPolicy } from "./core/upstream_guard.ts";
import { checkUpstreamUrl } from "./core/upstream_guard.ts";
import { makeProbe } from "./http/probe.ts";
import {
  type GatewayDiag,
  type GatewayLimits,
  makeGatewayHandler,
  type PlatformUpstreams,
} from "./http/proxy.ts";
import type { Route } from "@ryph/shared/http";
import { archiveMcpServer, type ArchiveOutcome, mcpServerRoutes } from "./http/routes.ts";
import type { Catalogue } from "./ports/catalogue.ts";
import type { GatewayStore } from "./ports/gateway_store.ts";
import type { ToolHost } from "./ports/tool_host.ts";
import type { McpServer } from "./core/types.ts";

export interface McpGatewaySetupDeps {
  store: GatewayStore;
  /** RYPH_MCP_KEY, this package's own: server credentials are sealed under a key derived from it. */
  masterKey: MasterKey;
  /** The user-surface gate for server CRUD, provided by the mounting host. */
  authenticate(req: Request): Promise<Response | null>;
  /**
   * The same gate narrowed to `tools:manage` — managing a server (catalogue and custom
   * containers included), container logs, and the usage trail.
   */
  authenticateManage(req: Request): Promise<Response | null>;
  /** The gate on one run's tool-call trail: its grant from the control plane, or `tools:manage`. */
  authenticateRunRead(req: Request, runId: string): Promise<Response | null>;
  /**
   * The data plane's address as seen FROM AN AGENT CONTAINER.
   * null: credentials cannot be issued (the issuer comes back null).
   */
  gatewayUrl: string | null;
  /** Backstop lifetime of a run's virtual key. */
  virtualKeyTtlMs: number;
  /** Where the gateway may dial: the flags and the platform's resolver. */
  upstream: UpstreamPolicy;
  /** Which servers can be hosted — the shipped directory, in every deployment today. */
  catalogue: Catalogue;
  /**
   * Where hosted servers run, or `{ unavailable: reason }` for a deployment that cannot run them
   * (a manual provisioner, the standalone gateway). The reason is shown to the operator.
   */
  toolHost: ToolHost | { unavailable: string };
  /** The tool guard's image in that backend's store, unless the backend names its own
   * (`ToolHost.guardImage`: the docker launcher's). */
  guardImage?: string;
  /**
   * RYPH_EGRESS_TOOL_KEY: what hosted servers' egress claims are signed with, for a tool host that
   * sends them out through the egress proxy (`ToolHost.egressProxy`). Absent there, hosting reads
   * unavailable and says why.
   */
  toolEgressKey?: Uint8Array;
  hostingLimits?: Partial<HostingLimits>;
  /** Only where two gateway processes can overlap (Kubernetes); absent, this one always holds it. */
  hostingLease?: HostingLease;
  /** Called if that lease is lost — the standalone gateway drains so its container restarts. */
  onHostingLeaseLost?: () => void;
  now(): Date;
  diag: GatewayDiag;
  /** The outbound fetch, for tests. */
  upstreamFetch?: typeof fetch;
  /**
   * The platform servers this deployment wired, by slug (memory: the service's MCP route and
   * the gateway's token for it). The composition root seeds the matching rows; a row without an
   * entry here exists but answers 502.
   */
  platform?: PlatformUpstreams;
  limits?: Partial<GatewayLimits>;
}

export interface McpGatewaySetup {
  /** Server CRUD, probe and usage for the control plane's route table. */
  routes: Route[];
  /**
   * The kill switch, ungated: the control plane fronts it (POST /v1/mcp-servers/:id/archive),
   * because only it knows which agents still name a server. In-process, or behind the internal
   * surface.
   */
  archive(id: string): Promise<ArchiveOutcome>;
  /** Mints and revokes run credentials; null when no gateway URL is configured. */
  issuer: McpCredentialIssuer | null;
  /** The data plane — served on its own listener in every deployment. */
  gatewayHandler: (req: Request) => Promise<Response>;
  /** Hosted servers: `boot()` once at startup, `supervise()` on an interval. */
  hosting: HostingService;
}

/** Builds the package's contributions to the deployment over the provided store. */
export function setup(deps: McpGatewaySetupDeps): McpGatewaySetup {
  const { store, now } = deps;
  const sealer = makeMcpSealer(deps.masterKey);
  const decrypt = sealer.open;
  const encrypt = sealer.seal;
  const issuer = deps.gatewayUrl === null ? null : makeMcpCredentialIssuer({
    store,
    now,
    gatewayUrl: deps.gatewayUrl,
    ttlMs: deps.virtualKeyTtlMs,
  });

  // The probe and the hosting service need each other — hosting probes a starting server, and
  // the probe dials through the guard hosting launched — so the guard is read lazily.
  let hosting: HostingService | null = null;
  const toolGuard = () => hosting?.guard() ?? null;
  const hostedRoute = (serverId: string) => hosting?.route(serverId) ?? null;
  // Assigned below, before anything can ask.
  const hostedOutlook = (server: McpServer): HostedOutlook =>
    hosting?.outlook(server) ?? { coming: false, reason: "hosting has not started yet" };
  const upstream: UpstreamPolicy = deps.upstream;
  const probe = makeProbe({
    decrypt,
    upstream,
    upstreamFetch: deps.upstreamFetch,
    toolGuard,
    hostedRoute,
    hostedOutlook,
    platform: deps.platform,
  });
  const built: HostingService = "unavailable" in deps.toolHost
    ? unavailableHosting(deps.toolHost.unavailable)
    : makeHosting({
      store,
      host: deps.toolHost,
      catalogue: deps.catalogue,
      probe,
      ...(deps.guardImage === undefined ? {} : { guardImage: deps.guardImage }),
      ...(deps.toolEgressKey === undefined ? {} : {
        toolEgress: {
          mint: (subject: string) =>
            mintToolEgressClaim(deps.toolEgressKey!, {
              subject,
              issuedAt: Math.floor(now().getTime() / 1000),
            }),
        },
      }),
      now,
      diag: deps.diag,
      limits: deps.hostingLimits,
      lease: deps.hostingLease,
      onLeaseLost: deps.onHostingLeaseLost,
    });
  hosting = built;

  return {
    routes: mcpServerRoutes({
      store,
      encrypt,
      decrypt,
      authenticate: deps.authenticate,
      authenticateManage: deps.authenticateManage,
      authenticateRunRead: deps.authenticateRunRead,
      checkUpstream: (target) => checkUpstreamUrl(target, upstream),
      probe,
      catalogue: deps.catalogue,
      hosting: built,
      now,
    }),
    archive: archiveMcpServer({ store, hosting: built, now }),
    issuer,
    gatewayHandler: makeGatewayHandler({
      store,
      decrypt,
      now,
      diag: deps.diag,
      upstream,
      upstreamFetch: deps.upstreamFetch,
      toolGuard,
      hostedRoute,
      hostedOutlook,
      hostedSettling: (serverId) => hosting?.settling(serverId) ?? false,
      platform: deps.platform,
      limits: deps.limits,
    }),
    hosting: built,
  };
}
