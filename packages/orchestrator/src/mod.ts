// @ryph/orchestrator — the control plane, as a mountable module.
//
// What a composition root needs to serve this package: the pure handler factory
// (makeHandler + the dep types it consumes), the user-surface gate, the reaper sweep,
// and the adapter factories that stand behind the ports. A composition root picks the
// adapters, builds AppDeps, and owns the socket — this module never reads env or listens.

export {
  type AppConfig,
  type AppDeps,
  type Authenticate,
  makeHandler,
  type McpRunCredentials,
  type ModelAccess,
  type ToolAccess,
  type ToolServerArchive,
} from "./http/app.ts";
export {
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_FORGE_SERVER_ID,
  supportsTools,
} from "./core/harness_tools.ts";
export type { MemoryAccess, MemoryPatch, MemoryRunOutcome } from "./ports/memory_access.ts";
export { httpMemoryAccess } from "./adapters/memory_access/http.ts";
export type { PlatformCompletion, PlatformModel } from "./ports/platform_model.ts";
export {
  httpPlatformCredentials,
  type PlatformCredential,
  type PlatformCredentialSource,
  proxyPlatformModel,
} from "./adapters/platform_model/proxy.ts";
export {
  type ChatAccess,
  type ChatThread,
  type ChatThreadOutcome,
  type CommanderVerdict,
  ConversationBusyError,
} from "./ports/chat_access.ts";
export { httpChatAccess } from "./adapters/chat_access/http.ts";
export { type InboxSignal, makeInboxSignal } from "./core/inbox_signal.ts";
export { deliverChatMention } from "./http/chat_api.ts";
export { inProcessRunImages } from "./http/service_images.ts";
export type { WiredDeps } from "./http/app.ts";
export { composeToolScope } from "./core/start_task.ts";
export { runTokenMatches } from "./http/auth.ts";
export { INGEST_GRACE_MS, runAcceptsIngest } from "./http/history_api.ts";
export { handleAutomationEvent, refreshAutomationAccess } from "./http/automations_api.ts";
export type {
  ChatMentionVerdict,
  InboundAutomationEvent,
  InboundChatMention,
} from "./core/types.ts";
export type { Route } from "@ryph/shared/http";
export {
  type ProgressSweepDeps,
  type ReaperDeps,
  type SubmitterDeps,
  sweep,
  sweepPatches,
  sweepProgressComments,
} from "./core/reaper.ts";
export type { SweepConfig } from "./core/lifecycle.ts";
export { cancelRun, type CancelRunDeps } from "./core/cancel_run.ts";
export {
  type CapacityReconciler,
  makeCapacityReconciler,
  MAX_RESERVED_SLOTS,
  type ReservedCapacity,
} from "./core/reserved_capacity.ts";
export type { RunnerControl } from "./ports/runner_control.ts";
export { DEFAULT_PATCH_SUBMIT_CONFIG, type PatchSubmitConfig } from "./core/patch_lifecycle.ts";
export { DEFAULT_MERGE_POLL_CONFIG, type MergePollConfig } from "./core/merge_poll.ts";
export {
  DEFAULT_MEMORY_POLICY,
  NO_RUN_LIMITS,
  type Response,
  type Run,
  type RunLifetime,
  type RunLimits,
  type RunMessage,
  TERMINAL_STATES,
} from "./core/types.ts";
export { concludeOnTerminal } from "./conclude_on_terminal.ts";
export { publishTaskChanges } from "./publish_task_changes.ts";
export { silentTaskFeed, type TaskFeed } from "./ports/task_feed.ts";
export { memoryTaskFeed } from "./adapters/task_feed/memory.ts";
export { postgresTaskFeed, TASK_FEED_CHANNEL } from "./adapters/task_feed/postgres.ts";
export { httpConcludeNotifier } from "./adapters/history_notify/http.ts";
export {
  clampPageLimit,
  decodeListCursor,
  DEFAULT_TASK_PAGE,
  encodeListCursor,
  MAX_TASK_PAGE,
  TASK_STATUS_BUCKETS,
  type TaskListQuery,
  type TaskListRow,
  type TaskPage,
  type TaskStatusBucket,
  type TaskStore,
} from "./ports/task_store.ts";
export type {
  CapacityReserver,
  Provisioner,
  Reservation,
  ReservationStatus,
} from "./ports/provisioner.ts";
export type { Diagnostics } from "./ports/diagnostics.ts";
export type {
  Forge,
  ForgeChecks,
  ForgeConnect,
  ForgePatchDiffs,
  ForgeProviders,
  ForgeSkills,
  GithubConnect,
  GithubMode,
  GithubRepoListing,
  GithubUserConnect,
  GitlabConnect,
  GitlabMode,
  LocalConnect,
  RadicleConnect,
  RadicleMode,
} from "./ports/forge.ts";
export type { IdentityDirectory } from "./ports/identity_directory.ts";
export { drizzleTaskStore } from "./adapters/store/drizzle.ts";
export { makeDb } from "./adapters/store/db/db.ts";
export { scopeDb } from "./adapters/store/db/db.ts";
export {
  defaultRunNetwork,
  dockerEngine,
  dockerProvisioner,
  ensureGate,
  ensureRunNetwork,
  EPHEMERAL_GATE_OWNER,
  GATE_TARGET,
  gateName,
  gateRoutesFor,
  inspectInternalNetwork,
  localBridgeGateway,
  reclaimOrphans,
  runNetworkProblem,
} from "./adapters/provisioner/docker.ts";
export { checkCapsFromEnv } from "./adapters/check_launcher/docker.ts";
export type {
  CheckCaps,
  DockerEngine,
  DockerOptions,
  GateAddress,
  GateForced,
  GateOptions,
  GateReady,
  GateRoute,
  InternalNetworkState,
} from "./adapters/provisioner/docker.ts";
export {
  type KubernetesOptions,
  kubernetesOptionsFromEnv,
  kubernetesProvisioner,
} from "./adapters/provisioner/kubernetes.ts";
export { manualProvisioner } from "./adapters/provisioner/manual.ts";
export type { EnvironmentBuilder } from "./ports/environment_builder.ts";
export {
  createEnvironmentBuilder,
  type EnvironmentBuilderDeps,
} from "./adapters/environment_builder/mod.ts";
export {
  DEFAULT_SERVICE_POLICY,
  type ServicePolicy,
  servicePolicyFromEnv,
  type ServiceRoom,
  serviceRoom,
} from "./core/services.ts";
export {
  type BrowserConfig,
  browserConfigFromEnv,
  browserImage,
  browserOffered,
  browserPosture,
} from "./core/browser.ts";
export {
  DEFAULT_EGRESS_BUNDLES,
  DEFAULT_EGRESS_POLICY,
  EGRESS_BUNDLES,
  type EgressBundle,
  egressKeyFromEnv,
  type EgressPolicy,
  egressPolicyFromEnv,
  type NetworkPolicy,
  resolveNetworkScope,
  type RunNetworkScope,
  unwiredEgressWarning,
} from "./core/egress.ts";
export {
  DEFAULT_RUN_SIZES,
  parseRunSizes,
  type RunSize,
  type RunSizes,
  runSizesFromEnv,
} from "./core/run_sizes.ts";
export {
  type DeploymentLimits,
  deploymentLimitsFromEnv,
  resolveRunLimits,
  RUN_LIMIT_BOUNDS,
} from "./core/run_limits.ts";
export {
  DEFAULT_ENVIRONMENTS_CONFIG,
  DEFAULT_HARNESS_KINDS,
  type EnvironmentsConfig,
  environmentsConfigFromEnv,
  harnessKindsFromEnv,
} from "./core/environment_config.ts";
export type { EnvironmentService } from "./core/environments.ts";
export { type WiredEnvironments, wireEnvironments } from "./environments.ts";
export { drizzleEnvironmentStore } from "./adapters/store/drizzle_environments.ts";
export { buildLogStoreFromEnv } from "./adapters/build_log/patch_store.ts";
export type { BuildLogStore } from "./ports/build_log_store.ts";
export { drizzleBackgroundStore } from "./adapters/store/drizzle_background.ts";
export type { BackgroundStore } from "./ports/background_store.ts";
export { drizzleArtifactStore } from "./adapters/store/drizzle_artifacts.ts";
export { processArtifactHtml } from "./adapters/artifact_html/process_preparer.ts";
export { artifactThumbnailFromEnv } from "./adapters/artifact_html/http_thumbnail.ts";
export type { ArtifactThumbnailRenderer } from "./ports/artifact_thumbnail.ts";
export {
  ARTIFACT_SANITIZER_SUBCOMMAND,
  runArtifactSanitizer,
} from "./adapters/artifact_html/sanitizer.ts";
export type { ArtifactStore } from "./ports/artifact_store.ts";
export { attachmentStoreFromEnv } from "./adapters/attachment_store/patch_store.ts";
export type { AttachmentStore } from "./ports/attachment_store.ts";
export {
  checkRunStartImages,
  imageMarker,
  inspectImage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type RunStartImage,
  sniffImage,
  storeAttachment,
} from "./core/attachments.ts";
export type { Attachment, AttachmentMime, AttachmentRef, AttachmentSource } from "./core/types.ts";
export { type CheckPolicy, checkPolicyFromEnv, DEFAULT_CHECK_POLICY } from "./core/check_policy.ts";
export {
  CHECK_PLATFORM_EXIT,
  checkRecordName,
  type ChecksConfig,
  type ChecksService,
} from "./core/checks.ts";
export type { CheckSuite, CheckSuiteState, CheckSuiteView } from "./core/check_types.ts";
export { wireChecks, type WiredChecks } from "./checks.ts";
export { type RemoteChecksConfig, remoteChecksConfigFromEnv } from "./core/remote_checks_config.ts";
export { drizzleCheckStore } from "./adapters/store/drizzle_checks.ts";
export type { CheckStore } from "./ports/check_store.ts";
export type { CheckLauncher } from "./ports/check_launcher.ts";
export { kubernetesCheckLauncher } from "./adapters/check_launcher/kubernetes.ts";
export { dockerCheckLauncher } from "./adapters/check_launcher/docker.ts";
export { dockerImagePrefetch } from "./adapters/image_prefetch/docker.ts";
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
  type LauncherInfo,
  type LauncherReconcile,
  launcherTokenFromEnv,
  type RunAddress,
} from "./adapters/launcher/mod.ts";
export type {
  ImagePrefetch,
  PrefetchImage,
  PrefetchName,
  PrefetchState,
} from "./ports/image_prefetch.ts";
export type { ServiceCatalogue } from "./ports/service_catalogue.ts";
export { directoryServiceCatalogue } from "./adapters/service_catalogue/directory.ts";
export type { SkillCatalogue } from "./ports/skill_catalogue.ts";
export type { SkillStore } from "./ports/skill_store.ts";
export { directorySkillCatalogue } from "./adapters/skill_catalogue/directory.ts";
export { drizzleSkillStore } from "./adapters/store/drizzle_skills.ts";
export { type SkillsSyncDeps, syncOrgSkills } from "./core/skills_sync.ts";
export { httpRunnerControl } from "./adapters/runner_control/http.ts";
export { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";
export { noopForge } from "./adapters/forge/noop.ts";
export { httpForge } from "./adapters/forge/http.ts";
export { type GithubModeSource, githubModeSource } from "./adapters/forge/github_mode.ts";
export { type GitlabModeSource, gitlabModeSource } from "./adapters/forge/gitlab_mode.ts";
export { authStoreIdentityDirectory } from "./adapters/identity_directory/auth_store.ts";
export {
  type ForgeModeSources,
  forgeUserModeDirectory,
} from "./adapters/identity_directory/forge_user_mode.ts";
export { forgeIdentityProvider } from "./adapters/identity_provider/forge.ts";
export { radicleChallengeProvider } from "./adapters/challenge_provider/radicle.ts";
