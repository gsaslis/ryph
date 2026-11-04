// The tool host's docker half, as the `@ryph/mcp-gateway/tool-host` entry point: the docker
// ToolHost the launcher runs, and the wire and client the gateway reaches it with. A leaf, like
// tool_scope.ts and platform.ts, for their reason: the barrel carries the gateway's store, data
// plane and db factory, none of which belongs in @ryph/launcher, the process that holds the
// docker socket and nothing else.

export type {
  ToolContainerState,
  ToolHost,
  ToolLaunch,
  ToolLaunchSpec,
} from "./ports/tool_host.ts";
export {
  dockerGuardName,
  type DockerToolCli,
  dockerToolHost,
  type DockerToolHostOptions,
  guardCreateArgs,
  toolEdgeNetwork,
  toolLaunchArgs,
} from "./adapters/tool_host/docker.ts";
export {
  TOOL_DEPLOYMENT_LABEL,
  TOOL_NETWORK_LABEL,
  TOOLS_NETWORK,
} from "./adapters/tool_host/cli.ts";
export {
  connectLauncherToolHost,
  LAUNCHER_OWNED_TOOL_SETTINGS,
  LAUNCHER_WIRE_REVISION,
  type LauncherToolConnection,
  launcherToolHost,
  launcherToolSettingsRefusal,
  laxToolWire,
  strictToolWire,
  TOOL_ROUTES,
  type ToolInfo,
  ToolInfoAnswer,
  WireMismatch,
  wireMismatch,
} from "./adapters/tool_host/launcher.ts";
export {
  GUARD_MEMORY,
  type GuardLaunch,
  guardLaunchSpec,
  guardSpecProblem,
  TOOL_GUARD_PORT,
  toolNameProblem,
} from "./core/tool_guard.ts";
export {
  mintToolEgressClaim,
  mintToolEgressKey,
  TOOL_PROXY_ENV_NAMES,
  toolEgressKeyFromEnv,
  toolProxyEnv,
} from "./core/tool_egress.ts";
