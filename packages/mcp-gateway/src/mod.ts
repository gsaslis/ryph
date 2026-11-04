// @ryph/mcp-gateway — tool access for agent runs: real MCP credentials sealed in one place,
// run-scoped virtual tokens everywhere else, and every tool call through a host we own.
//
// The model-proxy's silhouette, one credential class over. Two halves, and where each one lands
// depends on the deployment:
// - the CONTROL side (setup, plus the mcpServerRoutes/makeMcpCredentialIssuer pieces it composes,
//   and the stores): server CRUD and probe on the user surface, virtual tokens minted at the
//   runner's boot-time credentials fetch. In the single process @ryph/host calls setup() and
//   spreads the routes into its own router; standalone, src/main.ts serves them on their own
//   control listener, alongside internalMcpRoutes — the service-authed surface a remote control
//   plane dials instead of holding an in-process issuer.
// - the DATA side (makeGatewayHandler): the listener agent containers dial as "the MCP server" —
//   authenticates virtual tokens, enforces the frozen server and tool scope, substitutes the real
//   credential at the edge, meters every call. Its own socket in both deployments.
//
// Hosted servers ride the control side: a Catalogue of what can be hosted, a ToolHost that runs
// it (docker or kubernetes), and the hosting service that launches, fronts (the tool guard) and
// supervises each one. setup() wires them; the composition root boots them and ticks the
// supervisor, because both touch a container runtime.
//
// The master key (RYPH_MCP_KEY) is this package's, and only its two halves ever hold it.

export type {
  AllowedTools,
  CustomContainer,
  HostSettings,
  HostState,
  HostStatus,
  McpAuthKind,
  McpServer,
  McpServerKind,
  McpUsageRecord,
  McpUsageStatus,
  McpVirtualKey,
  PublicHostStatus,
  PublicMcpServer,
  ScopedServer,
} from "./core/types.ts";
export { needsSecret, SECRET_REQUIRED, toPublicMcpServer } from "./core/types.ts";
export {
  gatewayPathFor,
  makeMcpCredentialIssuer,
  type McpCredentialIssuer,
  type McpCredentialIssuerDeps,
  type McpCredentialRefusedError,
  type McpCredentials,
  type McpCredentialScope,
} from "./core/service.ts";
export { decide, type GatewayDecision, isMethodAllowed, isToolAllowed } from "./core/enforce.ts";
export {
  checkUpstreamUrl,
  type UpstreamPolicy,
  type UpstreamTarget,
  type UpstreamVerdict,
} from "./core/upstream_guard.ts";
export {
  DEFAULT_HOSTING_LIMITS,
  GUARD_NAME,
  type HostedRouteState,
  type HostingAvailability,
  type HostingLimits,
  type HostingService,
  makeHosting,
  unavailableHosting,
} from "./core/hosting.ts";
export { type CatalogueEntry, CatalogueEntrySchema } from "./core/catalogue.ts";
export {
  TOOL_GUARD_TOKEN_HEADER,
  toolContainerName,
  type ToolGuardAccess,
  toolNameProblem,
} from "./core/tool_guard.ts";
export {
  DEFAULT_LIMITS,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  type GatewayDiag,
  type GatewayHandlerDeps,
  type GatewayLimits,
  makeGatewayHandler,
  type PlatformUpstreams,
} from "./http/proxy.ts";
export { makeProbe, type ProbeDeps, type ProbedTool, type ProbeResult } from "./http/probe.ts";
export {
  archiveMcpServer,
  type ArchiveOutcome,
  CREDENTIAL_REQUIRED,
  disabledMcpServerRoutes,
  HOSTING_UNAVAILABLE,
  MCP_DISABLED,
  mcpServerRoutes,
  type McpServerRoutesDeps,
  PLATFORM_MANAGED,
  SERVER_ARCHIVED,
  SERVER_CHANGED,
} from "./http/routes.ts";
export type { Route } from "@ryph/shared/http";
export {
  ensurePlatformChatServer,
  ensurePlatformForgeServer,
  ensurePlatformMemoryServer,
  ensurePlatformServer,
  ensurePlatformWebServer,
  isPlatformServer,
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_CHAT_SLUG,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_FORGE_SLUG,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_MEMORY_SLUG,
  PLATFORM_RUN_ID_HEADER,
  PLATFORM_WEB_SERVER_ID,
  PLATFORM_WEB_SLUG,
  platformChatRow,
  platformForgeRow,
  platformMemoryRow,
  type PlatformMemorySeed,
  type PlatformSeed,
  platformWebRow,
} from "./core/platform.ts";
export { internalMcpRoutes, type InternalRoutesDeps } from "./http/internal.ts";
export { type McpGatewaySetup, type McpGatewaySetupDeps, setup } from "./setup.ts";
export { HOSTED_NOT_RUNNING, HOSTED_STALE, HOSTED_STARTING, launchKey } from "./core/sealing.ts";
export { CREDENTIAL_HEADER_REFUSED } from "./core/credential_headers.ts";
export { AllowedToolsSchema, SLUG_PATTERN } from "./schema.ts";
export { MAX_USAGE_PAGE } from "./ports/gateway_store.ts";
export type { GatewayStore, UsagePage, UsageQuery } from "./ports/gateway_store.ts";
export type { Catalogue } from "./ports/catalogue.ts";
export type { ToolHost, ToolLaunch, ToolLaunchSpec } from "./ports/tool_host.ts";
export { CATALOGUE_DIR, directoryCatalogue } from "./adapters/catalogue/directory.ts";
export { dockerToolHost } from "./adapters/tool_host/docker.ts";
export { TOOLS_NETWORK } from "./adapters/tool_host/cli.ts";
export {
  mintToolEgressClaim,
  mintToolEgressKey,
  TOOL_PROXY_ENV_NAMES,
  toolEgressKeyFromEnv,
  toolProxyEnv,
} from "./core/tool_egress.ts";
export { drizzleGatewayStore } from "./adapters/store/drizzle.ts";
export { makeMcpGatewayDb, scopeMcpGatewayDb } from "./adapters/store/db/db.ts";
export { systemResolve } from "./adapters/dns.ts";
