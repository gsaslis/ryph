// @ryph/memory — what agents remember across runs: a canon of one-claim memories, the inbox
// agents propose into, the signal log that ranks them, and the two ways a run reads them — a
// token-budgeted brief the orchestrator freezes into the run's snapshot, and MCP tools behind
// the gateway's `platform` server.
//
// Two halves, and where each one lands depends on the deployment:
// - the CONTROL side (setup → routes, service, MemoryAccess): the management surface for the
//   app, and composeBrief/reportOutcome for the orchestrator. In the single process @ryph/host
//   calls setup() and spreads the routes into its router; standalone, src/main.ts serves them on
//   its own listener beside the internal surface a remote orchestrator dials.
// - the DATA side (setup → dataHandler): the MCP route the gateway forwards a run's tool calls
//   to, service-authed with the gateway's token and scoped by the run id it names.
//
// Storage is its own schema owner (drizzle.config.ts, one migration set), sharing the instance
// under the single process and owning a database when standalone — the historian's shape.

export type {
  Audience,
  Basis,
  Brief,
  BriefEvidence,
  ChangeFate,
  Evidence,
  Feedback,
  IngestStats,
  Memory,
  MemoryChange,
  MemoryKind,
  MemoryRun,
  MemoryStatus,
  Proposal,
  ProposalEvidence,
  ProposalFlag,
  ProposalOrigin,
  ProposalStatus,
  Provenance,
  RunOutcome,
  Source,
  SourceKind,
  SourceSection,
  SourceStatus,
  StaleReport,
  Subject,
  Trust,
} from "./core/types.ts";
export {
  DEFAULT_BRIEF_BUDGET_TOKENS,
  MAX_MEMORY_TEXT,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  TENANT_DEFAULT,
  TRUSTS,
} from "./core/types.ts";
export {
  type BriefPreview,
  type ComposeBriefRequest,
  type ConsolidateStats,
  type InboxProposal,
  type IngestInput,
  type IngestOutcome,
  type IngestStarted,
  makeMemoryService,
  type MemoryDetail,
  type MemoryDiag,
  type MemoryHealth,
  MemoryRefusedError,
  type MemoryService,
  type MemoryServiceDeps,
  type MoveOutcome,
  type WithdrawOutcome,
} from "./core/service.ts";
export type {
  CompletionRequest,
  ModelClient,
  PlatformCredential,
  PlatformCredentialSource,
} from "./ports/model.ts";
export { proxyModelClient, type ProxyModelClientOptions } from "./adapters/model/proxy.ts";
export { type Fetcher, type Fetchers, FetchRefusedError } from "./ports/fetcher.ts";
export { type UrlFetcher, urlFetcher, type UrlFetcherOptions } from "./adapters/fetch/url.ts";
export { repoFileFetcher } from "./adapters/fetch/repo_file.ts";
export { findSection, renderDoc, splitSections } from "./core/sections.ts";
export type { Embedder } from "./ports/embedder.ts";
export {
  LOCAL_EMBEDDING_FILES,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_REPO,
  LOCAL_EMBEDDING_REVISION,
  localEmbedder,
  type LocalEmbedderOptions,
  TRANSFORMERS_VERSION,
} from "./adapters/embed/local.ts";
export { workerEmbedder } from "./adapters/embed/worker_embedder.ts";
export { degradingEmbedder, type LoadableEmbedder } from "./adapters/embed/degrading.ts";
export { cosine, relevanceOf } from "./core/vector.ts";
export {
  httpPlatformCredentials,
  type HttpPlatformCredentialsOptions,
} from "./adapters/model/platform_http.ts";
export { canonicalRepo, type RunScope, subjectKey } from "./core/subject.ts";
export { composeBrief, estimateTokens } from "./core/brief.ts";
export { DECAY_DAYS, type ScoreBreakdown, scoreMemory, TRUST_WEIGHT } from "./core/score.ts";
export { isInstructionShaped, isSecretShaped, screen } from "./core/screen.ts";
export type { MemoryQuery, MemoryStore, ScoredMemory, SubjectCount } from "./ports/store.ts";
export {
  disabledMemoryRoutes,
  MEMORY_DISABLED,
  memoryRoutes,
  type MemoryRoutesDeps,
  type PublicMemory,
  type Route,
  toPublicMemory,
} from "./http/routes.ts";
export { internalMemoryRoutes, type InternalRoutesDeps } from "./http/internal.ts";
export { makeMemoryDataHandler, MCP_PATH, RUN_ID_HEADER } from "./http/data.ts";
export { TOOLS } from "./mcp/tools.ts";
export { type MemorySetup, type MemorySetupDeps, setup } from "./setup.ts";
export { drizzleMemoryStore } from "./adapters/store/drizzle.ts";
export { makeMemoryDb, type MemoryDbHandle, scopeMemoryDb } from "./adapters/store/db/db.ts";
