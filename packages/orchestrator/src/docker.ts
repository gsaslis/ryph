// The docker backend as the `@ryph/orchestrator/docker` entry point: every docker adapter, the
// launcher's wire, and the clients of it — for @ryph/launcher, the one process that runs the
// docker CLI. A LEAF, like @ryph/mcp-gateway's tool_scope.ts
// and for the same reason: the barrel (mod.ts) carries the whole control plane — its store, its
// routes, its drizzle schema — and the launcher holds no platform secret and reads no database,
// so nothing of that should be in its process or its image.
//
// The adapters stay where they are and keep their tests; this file only names them.

export {
  type CheckCaps,
  DEPLOYMENT_LABEL,
  deploymentId,
  type DockerEngine,
  dockerEngine,
  type DockerOptions,
  dockerProvisioner,
  ensureGate,
  ensureImageId,
  EPHEMERAL_GATE_OWNER,
  GATE_NO_FORWARD,
  GATE_TARGET,
  gateForcedWarning,
  gateName,
  type GateOptions,
  type GateReady,
  type GateRoute,
  inspectInternalNetwork,
  internalNetworkCommand,
  internalNetworkCreateArgs,
  internalNetworkProblem,
  type InternalNetworkState,
  type InternalNetworkWords,
  listOrphanCandidates,
  type OrphanCandidates,
  reclaimCandidates,
  relayCreateArgs,
  type RelaySpec,
  runContainerOwnership,
  runNetworkProblem,
} from "./adapters/provisioner/docker.ts";
export {
  checkCapsFromEnv,
  docker,
  dockerCheckLauncher,
  type DockerExec,
  resolveCheckCaps,
} from "./adapters/check_launcher/docker.ts";
export {
  type CommandRunner,
  createEnvironmentBuilder,
  everyBuildRefused,
} from "./adapters/environment_builder/mod.ts";
export { confinedBuilderPrefix } from "./adapters/environment_builder/docker.ts";
export {
  ImageRefused,
  localImagePrefix,
  localOnlyImage,
  noEnvironmentImageRef,
} from "./adapters/environment_builder/local_images.ts";
export { dockerImagePrefetch } from "./adapters/image_prefetch/docker.ts";
export { DEFAULT_ROOTFUL_BUILDKIT_IMAGE } from "./adapters/environment_builder/cloud_build.ts";
export { checkPolicyFromEnv } from "./core/check_policy.ts";
export {
  DEFAULT_ENVIRONMENTS_CONFIG,
  type EnvironmentsConfig,
  environmentsConfigFromEnv,
} from "./core/environment_config.ts";
export { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
export type { Diagnostics } from "./ports/diagnostics.ts";
export { ImageGone } from "./ports/image_gone.ts";
export type { LaunchSpec, Provisioner } from "./ports/provisioner.ts";
export type { CheckLauncher, CheckSpec } from "./ports/check_launcher.ts";
export type { BuildSpec, EnvironmentBuilder } from "./ports/environment_builder.ts";
export type { ImagePrefetch, PrefetchImage, PrefetchName } from "./ports/image_prefetch.ts";
export * from "./adapters/launcher/wire.ts";
export {
  awaitLauncherInfo,
  awaitLauncherToken,
  engineAbsentWarning,
  gateCoverage,
  LAUNCHER_OWNED_SETTINGS,
  launcherCallerRefusal,
  type LauncherClients,
  launcherClients,
  type LauncherConnection,
  LauncherError,
  type LauncherReconcile,
  launcherTokenFromEnv,
  retryable,
  type RunAddress,
} from "./adapters/launcher/mod.ts";
