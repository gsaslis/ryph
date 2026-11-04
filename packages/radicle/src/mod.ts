// @ryph/radicle — "the bridge": the only process that touches a radicle-node's RAD_HOME.
//
// It runs beside upstream `radicle-node` in one pod, sharing one volume, and gives the rest of
// ryph an ordinary HTTP surface over a peer-to-peer forge: seed a repository, clone it read-only
// over smart HTTP, turn a verified git bundle into a Radicle patch or a new revision of one,
// read and write issues, comments and reviews — and, instead of webhooks, hold a subscription
// on the node's control socket and reconcile against storage so nothing is lost when it drops.
//
// Two invariants are worth repeating here:
// - ONLY THIS PROCESS TOUCHES RAD_HOME. The key, the storage, the COB cache: one writer.
// - EVENTS ARE A WAKE-UP CALL, RECONCILE IS CORRECTNESS. The node's stream is lossy by design
//   (bounded channel, no replay); the storage scan is what makes delivery a guarantee.
//
// Nothing here imports @ryph/forge or @ryph/orchestrator. Events leave through `EventSink`, and
// wiring that to the mailroom is the host's business, not the bridge's. `startRadicle` is the
// whole service for a host that mounts it in-process, as the `ryph` binary does in user mode.

export {
  CapabilityError,
  type ChangeState,
  type ChangeView,
  type CommentLocation,
  type CommentView,
  type DiffStat,
  type FileChange,
  FORGE_CAPABILITY_UNAVAILABLE,
  type IssueState,
  type IssueView,
  RefusedError,
  REPO_BLOCKED,
  REPO_UNAVAILABLE,
  RepoBlockedError,
  type RepoIdentity,
  RepoUnavailableError,
  type ReviewView,
  type RevisionView,
  type SubmitResult,
} from "./core/types.ts";
export {
  CHANGE_TYPE,
  ISSUE_TYPE,
  type ListFilter,
  makeRadicleService,
  type RadicleService,
  type RadicleServiceDeps,
  type RecordRunResult,
  type ReviewInput,
  type ReviewRemark,
  type SelfIdentity,
  type SubmitInput,
  type ThreadKind,
} from "./core/service.ts";
export {
  type EventConsumer,
  type EventConsumerDeps,
  makeEventConsumer,
  parseCobRef,
  type ParsedCobRef,
} from "./core/events.ts";
export {
  existingReviewId,
  flattenThread,
  isoOf,
  materializeChange,
  materializeIssue,
  toDid,
  toNid,
} from "./core/materialize.ts";

export {
  type ExecOptions,
  type ExecResult,
  orThrow,
  RadCommandError,
  type RadExec,
} from "./ports/rad.ts";
export {
  isRefsFetched,
  NodeCommandError,
  type NodeControl,
  type NodeEvent,
  type NodeStreamItem,
  NodeUnavailableError,
  type RefsFetched,
  type RefUpdate,
  type SeedScope,
} from "./ports/node.ts";
export type { JobCli, JobRunView, JobView } from "./ports/jobs.ts";
export type { Cursor, CursorStore } from "./ports/cursor_store.ts";
export type { TrackedRepo, TrackedRepoStore } from "./ports/tracked_repos.ts";
export type {
  BridgeBranchEvent,
  BridgeEvent,
  BridgeEventKind,
  BridgeThreadEvent,
  DeliverOutcome,
  EventSink,
} from "./ports/event_sink.ts";
export { type Diagnostics, SILENT_DIAGNOSTICS } from "./ports/diagnostics.ts";

export { bareRid, cliRadExec, type CliRadExecOptions } from "./adapters/rad/cli.ts";
export { parseJobList, radJobCli } from "./adapters/jobs/rad_job.ts";
export { type FakeJobCli, fakeJobCli } from "./adapters/jobs/fake.ts";
export { socketNodeControl, type SocketNodeControlOptions } from "./adapters/node/socket.ts";
export { type FakeNode, type FakeNodeOptions, startFakeNode } from "./adapters/node/fake.ts";
export { memoryCursorStore } from "./adapters/cursor_store/memory.ts";
export { drizzleCursorStore } from "./adapters/cursor_store/drizzle.ts";
export { memoryTrackedRepos } from "./adapters/tracked_repos/memory.ts";
export { drizzleTrackedRepos } from "./adapters/tracked_repos/drizzle.ts";
export {
  makeRadicleDb,
  type RadicleDbHandle,
  scopeRadicleDb,
} from "./adapters/cursor_store/db/db.ts";
export { httpEventSink, type HttpEventSinkOptions } from "./adapters/event_sink/http.ts";
export { type RecordingEventSink, recordingEventSink } from "./adapters/event_sink/recording.ts";
export { loggerDiagnostics } from "./adapters/diagnostics/logger.ts";

export {
  BRIDGE_MODE_HEADER,
  type BridgeConfig,
  type BridgeHttpDeps,
  bridgeRoutes,
} from "./http/routes.ts";
export { gitRoutes } from "./http/git.ts";
export { CLOSED_GATE } from "./helpers/auth.ts";
export {
  EXPLORER_PLACEHOLDERS,
  isExplorerTemplate,
  normalizeRid,
  renderExplorerUrl,
} from "./helpers/ids.ts";
export { type BridgeMode, type RadicleSetup, type RadicleSetupDeps, setup } from "./setup.ts";
export {
  defaultBinDir,
  type RadicleStartOptions,
  type RunningRadicle,
  startRadicle,
} from "./main.ts";
export { agentHoldsKey, keyIsEncrypted, publicKeyBlob } from "./helpers/preflight.ts";
