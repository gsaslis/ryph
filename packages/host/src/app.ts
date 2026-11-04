// One process, every service-shaped module: the orchestrator's control plane with
// @ryph/auth, @ryph/model-proxy's key CRUD, @ryph/mcp-gateway's server CRUD and
// @ryph/memory's management surface mounted into its router, and the model-proxy and
// mcp-gateway data planes as two more handlers beside it (memory's MCP data route is reached
// only through the gateway, in-process). Pure wiring — no env reads, no sockets — so a test
// builds the whole deployment from a config object and drives it with plain Request objects.
// The runner is deliberately absent: it is a spawned container that talks HTTP in every
// deployment, never an in-process module.

import type { DbCluster } from "@ryph/db";
import { Logger } from "@ryph/logger";
import {
  type AuthSetup,
  can,
  type Capability,
  drizzleAuthStore,
  scopeAuthDb,
  setup as setupAuth,
  smtpMailer,
} from "@ryph/auth";
import { makeAuthenticate, refuseUnless } from "@ryph/auth/gates";
import { type Health, makeHealth } from "@ryph/service";
import {
  drizzleHistoryStore,
  historianRoutes,
  type HistoryStore,
  makeHistorianService,
  memoryHistoryBus,
  scopeHistorianDb,
} from "@ryph/historian";
import {
  disabledProviderKeyRoutes,
  drizzleKeyStore,
  isLocalAppUrl,
  type PlatformCredentialIssuer,
  resolveProvider,
  type Route as ModelKeyRoute,
  scopeModelProxyDb,
  setup as setupModelProxy,
  type SpendLimits,
} from "@ryph/model-proxy";
import {
  directoryCatalogue,
  disabledMcpServerRoutes,
  drizzleGatewayStore,
  ensurePlatformChatServer,
  ensurePlatformForgeServer,
  ensurePlatformMemoryServer,
  ensurePlatformWebServer,
  type HostingLimits,
  type HostingService,
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_CHAT_SLUG,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_FORGE_SLUG,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_MEMORY_SLUG,
  PLATFORM_WEB_SERVER_ID,
  PLATFORM_WEB_SLUG,
  type PlatformUpstreams,
  type Route as McpRoute,
  scopeMcpGatewayDb,
  setup as setupMcpGateway,
  systemResolve,
  type ToolHost,
} from "@ryph/mcp-gateway";
import {
  type ConsolidateStats,
  drizzleMemoryStore,
  type Embedder as MemoryEmbedder,
  MCP_PATH as MEMORY_MCP_PATH,
  proxyModelClient,
  type Route as MemoryRoute,
  scopeMemoryDb,
  setup as setupMemory,
} from "@ryph/memory";
import {
  disabledChatRoutes,
  drizzleChatStore,
  MCP_PATH as CHAT_MCP_PATH,
  type PlatformApiUrls,
  platformTransports,
  type Route as ChatRoute,
  scopeChatDb,
  setup as setupChat,
} from "@ryph/chat";
import {
  MCP_PATH as WEB_MCP_PATH,
  searchBackendFromEnv,
  setup as setupWeb,
  systemResolve as resolveAddresses,
  type WebDiag,
} from "@ryph/web";
import { makeRunReadGate, type MasterKey, mintToken, unauthorized } from "@ryph/sealed";
import {
  type ArtifactThumbnailRenderer,
  type AttachmentStore,
  authStoreIdentityDirectory,
  type BrowserConfig,
  browserOffered,
  browserPosture,
  type BuildLogStore,
  cancelRun,
  type CapacityReconciler,
  type ChatAccess,
  type CheckLauncher,
  type CheckPolicy,
  type ChecksService,
  concludeOnTerminal,
  createEnvironmentBuilder,
  deliverChatMention,
  directoryServiceCatalogue,
  directorySkillCatalogue,
  drizzleArtifactStore,
  drizzleBackgroundStore,
  drizzleCheckStore,
  drizzleEnvironmentStore,
  drizzleSkillStore,
  drizzleTaskStore,
  type EgressPolicy,
  type EnvironmentService,
  type Forge,
  type ForgeChecks,
  type ForgeConnect,
  forgeIdentityProvider,
  type ForgePatchDiffs,
  type ForgeSkills,
  forgeUserModeDirectory,
  type GithubConnect,
  type GithubModeSource,
  githubModeSource,
  type GithubUserConnect,
  type GitlabConnect,
  type GitlabModeSource,
  gitlabModeSource,
  httpChatAccess,
  httpConcludeNotifier,
  httpForge,
  httpMemoryAccess,
  httpRunnerControl,
  inProcessRunImages,
  kubernetesCheckLauncher,
  type KubernetesOptions,
  kubernetesProvisioner,
  type LauncherClients,
  type LocalConnect,
  loggerDiagnostics,
  makeCapacityReconciler,
  makeHandler,
  makeInboxSignal,
  manualProvisioner,
  type MemoryAccess,
  memoryTaskFeed,
  type ModelAccess,
  noopForge,
  processArtifactHtml,
  type ProgressSweepDeps,
  proxyPlatformModel,
  publishTaskChanges,
  radicleChallengeProvider,
  type RadicleConnect,
  type ReaperDeps,
  type RemoteChecksConfig,
  type Route,
  type Run,
  runAcceptsIngest,
  runTokenMatches,
  scopeDb,
  type ServiceCatalogue,
  type ServicePolicy,
  serviceRoom,
  type SubmitterDeps,
  syncOrgSkills,
  type TaskStore,
  TERMINAL_STATES,
  type ToolAccess,
  wireChecks,
  type WiredChecks,
  type WiredDeps,
  wireEnvironments,
} from "@ryph/orchestrator";
import type {
  AppDeps,
  DeploymentLimits,
  EnvironmentsConfig,
  ImagePrefetch,
  RunSizes,
} from "@ryph/orchestrator";
import { handleAutomationEvent, refreshAutomationAccess } from "@ryph/orchestrator";
import {
  automationRoutes,
  type ChatroomDirectory,
  drizzleAutomationStore,
  httpChatroomDirectory,
  scopeAutomationsDb,
  setupAutomations,
} from "@ryph/automations";
import type { Claims } from "@ryph/auth";
import { drizzleHookStore, scopeWebhooksDb, setup as setupWebhooks } from "@ryph/webhooks";

import { localPreviews, type PreviewListener } from "./previews.ts";
import { inProcessChatAccess } from "./chat_access.ts";

export interface HostConfig {
  /** Only the localhost binary enables ephemeral loopback previews. */
  localPreviews?: boolean;
  /** One port every preview shares, instead of a loopback listener each (a ryph in a container). */
  previewListener?: PreviewListener;
  /**
   * The database every module mounted here shares, ALREADY OPEN. A cluster rather than a URL
   * because opening one is neither cheap nor repeatable: PGlite costs a few hundred megabytes
   * of resident memory that a process never gets back, and two instances on one data directory
   * both open and then silently stop seeing each other's writes. So the caller opens it once
   * and this stays what it says it is — pure wiring. The caller closes it too.
   */
  cluster: DbCluster;
  /**
   * A cluster of its own for the transcript. Null: it shares `cluster`, which is what Mode A
   * does — a deliberate relaxation, since a second PGlite instance costs those hundreds of
   * megabytes again, and under one Postgres the firehose and run-state are separate MVCC
   * connections anyway, so SQLite's single-writer-lock argument for splitting them does not
   * carry. Set: its own database, which is what Mode B does. Ignored when the historian is
   * remote.
   */
  historyCluster: DbCluster | null;
  authDisabled: boolean;
  /**
   * RYPH_MULTIUSER: whether more than one person may use this instance. Off is the local
   * binary's default — the owner is made at boot and signs in by a login link, and everything
   * that adds or re-roles another person is refused.
   */
  multiUser: boolean;
  /** The secret the app's server vouches for a client address with (see @ryph/auth's
   * `AuthRoutesDeps.proxySecret`). Absent or null: the address is taken as sent, which only
   * single-user allows — auth's setup refuses multi-user without it. */
  proxySecret?: string | null;
  /** What `ryph login` presents to mint a login link (`AuthRoutesDeps.localLoginSecret`). Absent
   * or null: no such route. */
  localLoginSecret?: string | null;
  /**
   * Seals and unseals PROVIDER KEYS — the model-proxy's master key, which in this deployment
   * happens to live in the same process. Null: model access and the data plane are dark.
   */
  masterKey: MasterKey | null;
  /** The data-plane address as seen FROM AN AGENT CONTAINER. null: credentials cannot be issued. */
  modelProxyUrl: string | null;
  virtualKeyTtlMs: number;
  /** The proxy's spend backstop and the deployment's ceiling — the model-proxy's own knobs. */
  modelSpend: SpendLimits;
  /**
   * Seals and unseals MCP SERVER CREDENTIALS — the mcp-gateway's master key, the third secret
   * class. main.ts defaults it to `masterKey` because one process
   * is one trust domain, and a deployment that later splits the gateway out does not have to
   * re-key what it already sealed. One master still gives each class its own derived key.
   * Null: tool access is dark — the server management surface answers `mcp_disabled`, agents
   * with a tool policy are refused at creation, and the gateway data plane never starts.
   */
  mcpKey: MasterKey | null;
  /** The MCP gateway data plane as seen FROM AN AGENT CONTAINER. null: tool credentials cannot
   * be issued, though servers can still be registered and probed. */
  mcpGatewayUrl: string | null;
  mcpVirtualKeyTtlMs: number;
  /** Where the gateway may dial. Both flags widen the public-https-only default; each is a route
   * the deployment chooses to grant, so main.ts logs them when set. */
  mcpUpstream: { allowInsecure: boolean; allowPrivate: boolean };
  /**
   * The tool guard's image in the provisioner backend's local store — `bun run agent-image`
   * builds it. Hosted MCP servers run on the SAME backend agents do; under manual there is
   * none, and the Add dialog says why instead of offering the catalogue.
   */
  toolGuardImage: string;
  /**
   * What hosted servers' egress claims are signed with (RYPH_EGRESS_TOOL_KEY, or minted per boot):
   * the gateway mints with it, and this process's egress proxy's tool listener verifies it.
   */
  toolEgressKey?: Uint8Array;
  /** Defaults for every tool container: memory and CPU caps, startup and backoff timing. */
  hostingLimits?: Partial<HostingLimits>;
  /**
   * Where hosted MCP servers run: under docker, the launcher's tool host (main.ts connects it),
   * or why there is none. Absent: the provisioner kind decides — manual says why not, and
   * docker without one says the launcher was reached without its tools token. Tests pass a fake.
   */
  toolHost?: ToolHost | { unavailable: string };
  /**
   * Service containers: whether a connected repo's `.ryph/services.yml` is read at all, and
   * what it may ask for. Off is the default and the shape every existing deployment has.
   */
  services: ServicePolicy;
  /**
   * The browser sidecar (RYPH_BROWSER_IMAGE and its resources); null: the deployment runs none.
   * Read by the orchestrator's own `browserConfigFromEnv`, so the two roots cannot disagree.
   */
  browser: BrowserConfig | null;
  /**
   * Egress: the operator's ceiling on where a run may reach, the key its proxy claim is signed
   * with, and how long that claim lives. `proxy` is the default, and on this deployment it is
   * the one policy whose enforcement the binary cannot provide by itself — the local backends
   * need the run on a network with no default route for it to mean anything.
   */
  egress: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
  provisioner:
    | {
      kind: "docker";
      /**
       * The docker launcher's clients (adapters/launcher in the orchestrator): every docker port
       * — runs, the reconcile, checks, builds, prefetch — reaches docker through them, embedded
       * or remote (main.ts, launcher.ts). Nothing in this process runs the docker CLI for them.
       */
      launcher: LauncherClients;
    }
    | ({ kind: "kubernetes" } & KubernetesOptions)
    | { kind: "manual" };
  /**
   * The forge git gateway AS AN AGENT CONTAINER dials it. Set: every new run clones through the
   * gateway with a run-scoped read-only key and its work leaves as a bundle. Null: no gateway —
   * runs clone their repo URL directly and push, exactly as before the forge existed.
   */
  gitGateway: { url: string; keyTtlMs: number } | null;
  /**
   * The shared service credential the forge gateway presents to resolve run keys
   * (RYPH_FORGE_TOKEN). Null: the forge surface is dark — its routes are not even mounted.
   */
  forgeToken: string | null;
  /**
   * The forge as THIS PROCESS dials it (permission checks, PR submission, OAuth exchange).
   * "noop" wires the recording fake — the whole patch lifecycle runs with no GitHub anywhere.
   * Null: no forge — connected repos cannot exist.
   */
  forge: { kind: "http"; url: string } | { kind: "noop" } | null;
  /**
   * The historian, AS AN AGENT CONTAINER dials it (RYPH_HISTORY_URL). Null: mounted in-process
   * over its own database, exactly as before. Set: a standalone historian — this host announces
   * conclusions to it and runs are told to POST transcripts there, and it is not mounted here.
   */
  historyUrl: string | null;
  /**
   * The same historian as an agent container dials it (RYPH_RUN_HISTORY_URL); null or absent:
   * `historyUrl`. Apart where runs reach it by another way than this process does.
   */
  runHistoryUrl?: string | null;
  /**
   * The shared service credential for the historian link (RYPH_HISTORY_TOKEN), guarding both
   * legs (the conclude ping out, the run-token verify in). Required when historyUrl is set.
   */
  historyToken: string | null;
  /**
   * The memory service, AS THIS PROCESS dials it (RYPH_MEMORY_URL). Null: mounted in-process
   * over the shared cluster — the management routes join this router, the orchestrator holds
   * the service directly, and the gateway's platform entry dials the MCP route in-process with a
   * token minted at boot. Set: a standalone memory service — this host composes briefs over
   * HTTP, the gateway dials the service's MCP route, and nothing memory-shaped is mounted here.
   */
  memoryUrl: string | null;
  /** The credential this process presents to a standalone memory service (RYPH_MEMORY_TOKEN).
   * Required when memoryUrl is set. */
  memoryToken: string | null;
  /** The credential the gateway presents to a standalone memory service's MCP route
   * (RYPH_MEMORY_GATEWAY_TOKEN). Required when memoryUrl is set and tool access is on. */
  memoryGatewayToken: string | null;
  /**
   * Embeddings for the in-process memory's hybrid search (main.ts builds it from
   * RYPH_MEMORY_EMBEDDINGS; the binary's is on by default and loads on first use). Null or
   * absent: full-text only. Unused when memoryUrl is set: the standalone service embeds itself.
   */
  memoryEmbedder?: MemoryEmbedder | null;
  /** The deployment's GitLab instance (RYPH_GITLAB_URL), so the in-process memory's repo-file
   * ingests read it beside gitlab.com. Null or absent: gitlab.com alone. */
  memoryGitlabUrl?: string | null;
  /**
   * The chat service, AS THIS PROCESS dials it (RYPH_CHAT_URL). Null: mounted in-process over
   * the shared cluster — the chatroom routes join this router, the orchestrator binds rooms,
   * checks commanders and reads threads through the service directly, every mention reaches the
   * orchestrator's mention door without a socket,
   * the gateway's platform entry dials the chat tool in-process with a token minted at boot, and
   * this process polls the rooms' bots. Set: a standalone chat service — this host binds rooms
   * over HTTP with RYPH_CHAT_TOKEN, mounts the mention door (POST /v1/chat/mentions) the
   * service delivers every mention to, and
   * the gateway dials the service's MCP route with RYPH_CHAT_GATEWAY_TOKEN.
   */
  chatUrl: string | null;
  /** The credential for the control plane ⇄ chat link (RYPH_CHAT_TOKEN), both directions.
   * Required when chatUrl is set. */
  chatToken: string | null;
  /** The credential the gateway presents to a standalone chat service's MCP route
   * (RYPH_CHAT_GATEWAY_TOKEN). Required when chatUrl is set and tool access is on. */
  chatGatewayToken: string | null;
  /**
   * Whether this deployment serves the web tools at all (RYPH_WEB_TOOLS, on by default). Off:
   * nothing is mounted, no row is seeded, the agent form does not list it, and no run's scope
   * carries it — the "leave it unwired" the READMEs promise, on a deployment that has no
   * separate gateway to unwire it from.
   */
  webTools: boolean;
  /**
   * The web service, AS THE GATEWAY dials it (RYPH_WEB_URL). Null: mounted in-process — it holds
   * no state, so there is nothing to share and nothing to migrate, and the gateway's platform
   * entry reaches its MCP route through a `fetch` that opens no socket, with a token minted at
   * boot. Set: a standalone web service, dialed at that URL with RYPH_WEB_GATEWAY_TOKEN.
   */
  webUrl: string | null;
  /** The credential the gateway presents to a STANDALONE web service (RYPH_WEB_GATEWAY_TOKEN).
   * Required when webUrl is set; the in-process mount mints its own. */
  webGatewayToken: string | null;
  /** The web search provider (RYPH_WEB_SEARCH_PROVIDER) and its key (RYPH_WEB_SEARCH_KEY). No
   * key: `web__search` is not offered to runs at all, and `web__fetch` still is. */
  webSearch: { provider: string | null; key: string | null };
  /** Permit plain http pages (RYPH_WEB_ALLOW_INSECURE=1). Default: https only. */
  webAllowInsecure: boolean;
  /** The whole of one page fetch, redirects included (RYPH_WEB_FETCH_TIMEOUT_MS). */
  webFetchTimeoutMs: number;
  /**
   * The forge's tool surface as the gateway dials it (RYPH_FORGE_TOOLS_URL). Null: the forge's
   * own URL, which is where the surface is served.
   */
  forgeToolsUrl: string | null;
  /**
   * The credential the gateway presents to the forge's tool surface (RYPH_FORGE_GATEWAY_TOKEN).
   * Null: no forge tools — the platform forge server is not seeded, no run is scoped to it, and a
   * forge policy is refused at the form. Needs an http forge and tool access to mean anything.
   */
  forgeGatewayToken: string | null;
  /**
   * Seals and unseals CHATROOM BOT TOKENS — the chat service's master key, the fourth secret
   * class. main.ts defaults it to `masterKey` for the reason it defaults the other two. Null
   * (and no chatUrl): chat is dark — the chatroom surface answers `chat_disabled`, responses
   * open without a room, and no run gets the chat tool.
   */
  chatKey: MasterKey | null;
  /** Telegram's, Slack's and Discord's API addresses when a stand-in replaces them
   * (RYPH_CHAT_TELEGRAM_API_URL / RYPH_CHAT_SLACK_API_URL / RYPH_CHAT_DISCORD_API_URL). Absent:
   * the platforms' own. */
  chatApiUrls?: PlatformApiUrls;
  /** The address runners are told to reach the control plane at. */
  publicUrl: string;
  /** The web app's origin as a BROWSER reaches it, for links in outward-facing text (a
   * progress comment's run link, a mailed verification link). Null: links are omitted. */
  appUrl: string | null;
  /** Outbound mail for verification and reset links. Null: links are handed to admins. */
  smtp: { url: string; from: string } | null;
  /** RYPH_AGENT_IMAGE: the image every run launches on, whatever its harness kind. */
  agentImage: string | null;
  /** RYPH_HARNESS_KINDS: the kinds an agent may be created with. */
  harnessKinds: string[];
  /** RYPH_RUN_SIZES / RYPH_RUN_SIZE_DEFAULT: the size classes a run can get. */
  runSizes: RunSizes;
  /** The RYPH_RUN_MAX_* family and RYPH_RUN_CONCURRENCY: the operator's run limits. */
  limits: DeploymentLimits;
  /** RYPH_ENVIRONMENTS and the RYPH_ENV_* family. Off by default. */
  environments: EnvironmentsConfig;
  /** Where build logs go (beside the patches) — and check logs and background command logs,
   * under their own prefixes. Null: no builds or checks run, and no background command's log is
   * kept (its record still is). */
  environmentLogs: BuildLogStore | null;
  /** The images runs launch on, fetched ahead of the first one (ports/image_prefetch.ts); null
   * where nothing is fetched ahead. The composition root starts it. */
  imagePrefetch?: ImagePrefetch | null;
  /** RYPH_CHECKS and the RYPH_CHECKS_* family. Absent or off: no checks run here. */
  checks?: CheckPolicy;
  /** Instance-owned remote checks backend; never passed to run or check containers. */
  remoteChecks?: RemoteChecksConfig | null;
  /** Where a run's images go (beside the patches, under `attachments/`). Absent or null: images
   * are refused with a 503. */
  attachmentStore?: AttachmentStore | null;
  /** Isolated artifact screenshot service; absent means previews show a placeholder. */
  artifactThumbnail?: ArtifactThumbnailRenderer | null;
  /** RYPH_CAPACITY_RECONCILE_INTERVAL_MS: how often reserved capacity is re-applied with nothing
   * owed. Absent: a minute. Read only where the provisioner can reserve (kubernetes). */
  capacityReconcileIntervalMs?: number;
  /** RYPH_REAPER_INTERVAL_MS: how often the composition root ticks reserved capacity, which
   * sizes its hold. Absent: ten seconds, the reaper's own default. */
  reaperIntervalMs?: number;
}

export interface HostApp {
  /** The control plane: user + runner surfaces, auth, and provider-key CRUD in one router. */
  handler: (req: Request) => Promise<Response>;
  /**
   * Liveness and readiness, mounted on both listeners. Nothing probes them in the single-process
   * deployment — there is no platform to answer to — but they exist so `ryph up` is the same
   * program a container runs, and `main.ts` hands `beginDrain` to the drain.
   */
  health: Health;
  /** Stop ephemeral tunnels before draining the control plane's long-lived WebSockets. */
  closePreviews(): void;
  /** The model-proxy data plane; served on its own port, null when the master key is absent. */
  proxyHandler: ((req: Request) => Promise<Response>) | null;
  /** The mcp-gateway data plane — what agent containers dial as "the MCP server"; served on its
   * own port, null when the MCP key is absent. */
  mcpGatewayHandler: ((req: Request) => Promise<Response>) | null;
  /**
   * Hosted MCP servers, NOT yet booted: main.ts calls `boot()` (it touches a container runtime,
   * which wiring must not) and ticks `supervise()` beside the reaper. Null when tool access is
   * dark; an unavailable-hosting stand-in when the backend cannot host.
   */
  hosting: HostingService | null;
  store: TaskStore;
  /** Environment builds, when on: main.ts drives its tick, its reconcile and its boot pass. */
  environments: EnvironmentService | null;
  /** Checks, when on: main.ts drives its tick. */
  checks: ChecksService | null;
  /** One read of the org skills repo, the hourly backstop to its push events; main.ts drives it
   * at boot and on an interval. Answers at once when no repo is connected. */
  reconcileSkills: () => Promise<void>;
  /** Reserved capacity, where the provisioner can hold it (kubernetes): main.ts drives its
   * tick, and stops it on shutdown. Null everywhere else. */
  capacity: CapacityReconciler | null;
  sweepDeps: ReaperDeps;
  /** Deps for the patch submitter's sweep; null without a forge — patches then simply wait. */
  patchSweepDeps: SubmitterDeps | null;
  /** Deps for the progress-comment sweep; null without a forge — no thread to edit in. */
  progressSweepDeps: ProgressSweepDeps | null;
  /** Registers a hook fired whenever a run reaches a terminal state — how main.ts kicks the
   * progress sweep so a final comment lands in milliseconds, not a tick later. */
  onTerminal(hook: () => void): void;
  /** The automations ticks, driven by main.ts like every other sweep: the mailroom's scan (each
   * automation's mailbox then drains on its own, past the tick's end), the schedule tick that
   * turns due cron slots into fires, and the hourly keep-warm access check. */
  automations: {
    tick(): Promise<void>;
    schedulerTick(): Promise<number>;
    accessTick(): Promise<number>;
  };
  /** Registers a hook fired the moment a fire is ingested into a mailbox with no drain running —
   * how main.ts kicks the scan so a fresh fire is handed over in milliseconds, not a tick later. */
  onFireIngested(hook: () => void): void;
  /** Cancels a run the way the UI's Cancel does — for `ryph up`'s exit prompt. */
  cancelRun(run: Run): Promise<void>;
  /**
   * The chatrooms' poll — one pass over every live room's bot, which main.ts ticks beside the
   * reaper. Null when chat is remote (the standalone service polls) or dark.
   */
  chat: { pollAll(signal: AbortSignal): Promise<void> } | null;
  /**
   * One pass of the memory consolidator over the in-process inbox; main.ts ticks it beside the
   * reaper. Null when memory is remote (the standalone service runs its own) — there is then no
   * inbox in this process to work.
   */
  consolidateMemory: (() => Promise<ConsolidateStats>) | null;
  /** One batch of the memory embeddings backfill (memories written before embeddings were on, or
   * whose own embedding failed); main.ts ticks it. Null when memory is remote or has no embedder. */
  backfillMemoryEmbeddings: (() => Promise<{ embedded: number; remaining: number }>) | null;
  /** Auth's housekeeping: purges accounts unproven past their grace, and dead link tokens. */
  sweepAuth: () => Promise<{ purgedUsers: number }>;
  /** How an instance is claimed: the setup token to print while it is unclaimed (multi-user),
   * or the owner made at boot and the links that sign them in (single-user). */
  auth: Pick<AuthSetup, "setupToken" | "ensureOwner" | "mintLoginLink" | "ownerSignInEmails">;
  /** Waits for the extractions running behind memory ingests; null without memory. Before the
   * clusters close, so no extraction fails onto a store that is gone. */
  drainMemory: (() => Promise<void>) | null;
  /** Closes the ChatGPT sign-in listener, if a sign-in left it open; null without model access. */
  closePlanListener: (() => Promise<void>) | null;
  /**
   * Releases what this wiring owns. NOT the clusters — those were opened by the caller, who
   * closes them; several apps may share one.
   */
  close(): void;
}

export async function buildApp(cfg: HostConfig): Promise<HostApp> {
  const diag = loggerDiagnostics("orchestrator");
  const now = () => new Date();
  // Every module below takes a schema-scoped VIEW of the one cluster the caller handed us —
  // the control plane's tables, auth's, and (further down) the model keys'. Never a second
  // open of the same database: see HostConfig.cluster.
  const cluster = cfg.cluster;

  const baseStore: TaskStore = drizzleTaskStore(scopeDb(cluster));
  // Probes the schema before any module touches its tables — makeAuthService reads the signing
  // key at construction, and an unprovisioned database must surface as this clear error, not as
  // a raw driver stack from whichever module happens to query first.
  try {
    await baseStore.listTasks({ limit: 1 });
  } catch {
    // The cluster is the caller's to close, so this only reports.
    throw new Error(
      `database ${JSON.stringify(cluster.description)} has no schema — ` +
        "run `bun run db:push` first",
    );
  }

  let forge: Forge | null = null;
  // Checks' forge surface, off the `Forge` port: the same adapter, when there is one.
  let forgeChecks: ForgeChecks | null = null;
  // A patch's diff for its reviewer, off the port for the same reason.
  let patchDiffs: ForgePatchDiffs | null = null;
  // The org skills repo's read, off the `Forge` port for the same reason.
  let forgeSkills: ForgeSkills | null = null;
  // GitHub's own connect surface, beside the forge-agnostic port: installations and OAuth are
  // GitHub's concepts, not a forge's (orchestrator's ports/forge.ts).
  let githubConnect: GithubConnect | null = null;
  // …and its user-mode counterpart: the token owner's repos, where there is no installation.
  let githubUserConnect: GithubUserConnect | null = null;
  // GitLab's: the projects the forge's token reaches and their webhook tokens, and sign-in by
  // forge. The forge answers 501 where it runs no GitLab; the noop stand-in has neither.
  let gitlabConnect: GitlabConnect | null = null;
  let forgeConnect: ForgeConnect | null = null;
  // Radicle's: seeding and identity documents. Wired beside the forge, because the forge itself
  // answers 501 where no bridge is configured, and `GET /v1/forge-providers` is what says so.
  let radicleConnect: RadicleConnect | null = null;
  // Repositories on this machine: the path is checked by the forge, which is what reads it.
  let localConnect: LocalConnect | null = null;
  if (cfg.forge?.kind === "noop") {
    const noop = noopForge(diag);
    forge = noop;
    forgeChecks = noop;
    patchDiffs = noop;
    forgeSkills = noop;
    githubConnect = noop;
    githubUserConnect = noop;
    radicleConnect = noop;
    localConnect = noop;
  } else if (cfg.forge) {
    if (cfg.forgeToken === null) {
      throw new Error("a forge URL without a forge token — the forge would refuse us");
    }
    const http = httpForge({ baseUrl: cfg.forge.url, forgeToken: cfg.forgeToken, diag });
    forge = http;
    forgeChecks = http;
    patchDiffs = http;
    forgeSkills = http;
    githubConnect = http;
    githubUserConnect = http;
    gitlabConnect = http;
    forgeConnect = http;
    radicleConnect = http;
    localConnect = http;
  }
  // App or user token: the forge's to say (orchestrator's adapters/forge/github_mode.ts). Asked
  // now without waiting — an in-process forge is already up and answers at once, so the
  // sign-in page knows before its first visit; a remote one that is not up delays nothing.
  const githubMode: GithubModeSource | null = forge === null
    ? null
    : githubModeSource({ forge, diag });
  githubMode?.get().catch((err) => diag.warn("forge.github_mode_unanswered", { err: String(err) }));
  // GitLab's likewise: a bot or one person's token.
  const gitlabMode: GitlabModeSource | null = forge === null
    ? null
    : gitlabModeSource({ forge, diag });
  gitlabMode?.get().catch((err) => diag.warn("forge.gitlab_mode_unanswered", { err: String(err) }));

  // Each mounted package exports a setup(): the package performs its own startup work and
  // returns its contributions; this root only builds the stores and passes the cross-wiring.
  // Auth signs people in through the forge, so the forge is built first and handed over.
  const authStore = drizzleAuthStore(scopeAuthDb(cluster));
  const auth = await setupAuth({
    store: authStore,
    now,
    identityProvider: githubConnect === null || githubMode === null ? null : forgeIdentityProvider({
      githubConnect,
      store: baseStore,
      githubMode,
      forgeConnect,
      gitlabMode,
    }),
    // Radicle proves an identity by a signed challenge rather than an OAuth redirect — a second
    // port, and never a way IN: there is no account on the other side to sign in to.
    challengeProvider: radicleConnect === null ? null : radicleChallengeProvider(),
    mailer: cfg.smtp === null ? null : smtpMailer(cfg.smtp),
    appUrl: cfg.appUrl,
    onMailError: (err) => diag.warn("auth.mail_failed", { err: String(err) }),
    multiUser: cfg.multiUser,
    proxySecret: cfg.proxySecret ?? null,
    // With the user surface open nobody signs in, so there is no client address to vouch for.
    requireProxySecret: !cfg.authDisabled,
    localLoginSecret: cfg.localLoginSecret ?? null,
    // Every host root mints login links: the binary for `ryph login`, `bun run up` at boot.
    loginLinks: true,
  });
  const authenticate = makeAuthenticate({
    verifier: auth.verifier,
    disabled: cfg.authDisabled,
  });
  // The mounted packages' surfaces predate the principal-bearing gate; they only need the
  // yes/no half of it.
  const authenticateGate = (req: Request) =>
    authenticate(req).then((outcome) => (outcome instanceof Response ? outcome : null));
  // The same gate answering WHO and with what, for the run-grant gates: a grant is bound to the
  // person it was minted for and needs `tasks:read` beside it, so its verifier needs the
  // bearer's subject and caps (null under break-glass, as minted).
  const grantBearer = (req: Request) =>
    authenticate(req).then((outcome) =>
      outcome instanceof Response
        ? outcome
        : outcome.kind === "user"
        ? { sub: outcome.userId, caps: outcome.caps }
        : null
    );
  // …and the same gate narrowed to one capability, for the surfaces that take one. Break-glass
  // passes here as it does everywhere.
  const gateFor = (capability: Capability) => async (req: Request): Promise<Response | null> => {
    const outcome = await authenticate(req);
    if (outcome instanceof Response) return outcome;
    return refuseUnless(outcome, capability);
  };
  // Run grants: the control plane signs them, the mounted services verify them, and both sides
  // are this process, so the key is minted here and never leaves it. A REMOTE historian verifies
  // with the token the two already share.
  const runGrantKey = mintToken();
  const runReadGateFor = (capability: Capability) =>
    makeRunReadGate({
      grantKey: runGrantKey,
      // The grant is scope proof, never identity proof: it passes only alongside a verified
      // bearer for the person it was minted for, holding `tasks:read`.
      bearer: grantBearer,
      fallback: gateFor(capability),
    });

  // @ryph/historian: mounted in-process — sharing the control plane's instance, or over a
  // database of its own when historyDb says so — OR peeled out to a standalone service when
  // RYPH_HISTORY_URL is set, the first step of the networked split. Remote, this host runs the
  // rest in-process and only announces conclusions over HTTP; the standalone historian verifies
  // run tokens back against this host's `/v1/history/.../verify` (mounted below via historyToken).
  let historyStore: HistoryStore | null = null;
  const historyCluster: DbCluster | null = cfg.historyCluster;
  let historyRoutes: Route[] = [];
  let concludeSignal: (runId: string) => void;
  if (cfg.historyUrl !== null) {
    if (cfg.historyToken === null) {
      throw new Error("RYPH_HISTORY_URL is set but RYPH_HISTORY_TOKEN is not");
    }
    concludeSignal = httpConcludeNotifier({
      historyUrl: cfg.historyUrl,
      historyToken: cfg.historyToken,
      diag,
    });
  } else {
    // No historyCluster: the transcript shares the control plane's instance, which is Mode A —
    // see HostConfig for why that relaxation is deliberate.
    historyStore = drizzleHistoryStore(scopeHistorianDb(historyCluster ?? cluster));
    try {
      await historyStore.listEvents("startup-probe", "", { limit: 1 });
    } catch {
      throw new Error(
        `history database ${JSON.stringify(historyCluster?.description ?? cluster.description)} ` +
          "has no schema — run `bun run db:push` in packages/historian first",
      );
    }
    const historian = makeHistorianService({ store: historyStore, bus: memoryHistoryBus() });
    const mounted = historianRoutes({
      service: historian,
      authenticateRunRead: runReadGateFor("tasks:read-all"),
      // The run bearer gate: the historian cannot read the runs table (different database,
      // different owner), so this root closes over the control-plane store — unknown run and
      // bad token answer alike, matching the runner surface's enumeration defense. A concluded
      // run takes its final flush and nothing after: the standalone gate's grace rule, the same
      // function, so a run token outliving its run cannot write to the record forever.
      authenticateRun: async (req, runId) => {
        const run = await baseStore.getRun(runId);
        return run !== null && runAcceptsIngest(run, now()) && await runTokenMatches(req, run);
      },
      isRunTerminal: async (runId) => {
        const run = await baseStore.getRun(runId);
        return run !== null && TERMINAL_STATES.has(run.state);
      },
    });
    historyRoutes = mounted.routes;
    concludeSignal = mounted.concludeRun;
  }
  // The store now announces a run's conclusion — in-process to the mounted historian, or over HTTP
  // to the standalone one. See the wrapper's note for why the store is the right choke point. The
  // in-process gates above read the bare store: they only ever read, and the wrapper needs the
  // conclude signal to exist first. The second wrap serves the composition root's OWN listeners
  // (main.ts registers the progress sweep's kick via `onTerminal` — the sweep loop lives there).
  const onTerminalHooks: Array<() => void> = [];
  // ...and, in the same spirit, announces every task row that moved, which is what the list's
  // live tails watch. The in-process feed and not the LISTEN/NOTIFY one because this deployment
  // IS one process — that is what @ryph/host means — so there is no peer to tell.
  const taskFeed = memoryTaskFeed();
  const store = publishTaskChanges(
    concludeOnTerminal(
      concludeOnTerminal(baseStore, concludeSignal),
      () => onTerminalHooks.forEach((hook) => hook()),
    ),
    taskFeed,
  );

  // Model access: key CRUD and virtual-key minting on the control plane, the proxy handler on
  // the data plane — both over ONE key store, the in-process replacement for the shared-file
  // seam the standalone processes use.
  let modelAccess: ModelAccess | null = null;
  let modelKeyRoutes: ModelKeyRoute[] = [];
  let proxyHandler: HostApp["proxyHandler"] = null;
  let platformIssuer: PlatformCredentialIssuer | null = null;
  let closePlanListener: HostApp["closePlanListener"] = null;
  if (cfg.masterKey) {
    const keyStore = drizzleKeyStore(scopeModelProxyDb(cluster));
    const proxy = setupModelProxy({
      store: keyStore,
      masterKey: cfg.masterKey,
      authenticate: gateFor("models:read"),
      authenticateManage: gateFor("models:manage"),
      authenticateUsage: gateFor("usage:read-all"),
      authenticateRunRead: runReadGateFor("usage:read-all"),
      proxyUrl: cfg.modelProxyUrl,
      virtualKeyTtlMs: cfg.virtualKeyTtlMs,
      limits: cfg.modelSpend,
      now,
      proxyDiag: loggerDiagnostics("model-proxy"),
      // ChatGPT plan keys only where the app is on a loopback address: the binary and
      // `bun run up`, on the person's own machine. Anywhere else they are off.
      ...(isLocalAppUrl(cfg.appUrl) ? { chatgptPlan: {} } : {}),
    });
    closePlanListener = async () => await proxy.planListener?.close();
    const issuer = proxy.issuer;
    platformIssuer = proxy.platformIssuer;
    // Adapts the package's issuer to the orchestrator's ModelAccess port — the port belongs
    // to the orchestrator, so its in-process adapter lives in the composition root.
    modelAccess = {
      async getKey(id) {
        const key = await keyStore.getProviderKey(id);
        if (key === null) return null;
        // The provider's wire dialect comes from the package's own join of built-ins and
        // custom_providers rows — never re-derived from the id here, which is a slug an admin
        // typed and says nothing about the shape. A provider that resolves to nothing is
        // config drift, and it THROWS rather than answering null for the same reason the
        // networked adapter turns the proxy's 502 into a throw: a user must not be told their
        // key does not exist because the deployment lost the endpoint it names.
        const provider = await resolveProvider(keyStore, key.provider);
        if (provider === null) {
          throw new Error(`provider key "${id}" names unknown provider "${key.provider}"`);
        }
        return {
          id: key.id,
          provider: key.provider,
          dialect: provider.dialect,
          // The ENDPOINT's kill switch, beside the key's. It has to agree with what the
          // networked adapter reads off /internal/v1/provider-keys/:id, or the same policy
          // would be accepted in one deployment and refused in the other.
          providerArchivedAt: provider.archivedAt,
          archivedAt: key.archivedAt,
        };
      },
      issueRunCredentials(scope) {
        if (issuer === null) {
          return Promise.reject(
            new Error("RYPH_MODEL_PROXY_URL is not set — no proxy for runs to dial"),
          );
        }
        return issuer.issue(scope);
      },
      revokeRunCredentials(runId) {
        return issuer === null ? Promise.resolve() : issuer.revokeForRun(runId);
      },
      async spendOf(runId) {
        return (await proxy.spendOf(runId)).spentUsd;
      },
      ceilingReached: proxy.ceilingReached,
    };
    modelKeyRoutes = proxy.routes;
    proxyHandler = proxy.proxyHandler;
  } else {
    modelKeyRoutes = disabledProviderKeyRoutes({ authenticate: authenticateGate });
  }

  // The platform's background model for the control plane's own small jobs — a task's title
  // (@ryph/orchestrator core/titles.ts): a platform credential from the proxy's issuer, spent on
  // the proxy handler without a socket, exactly as memory's below. Metered as `platform:titles`.
  const platformModel = platformIssuer === null || proxyHandler === null
    ? null
    : proxyPlatformModel({
      proxyUrl: "http://model-proxy.internal",
      credentials: () => platformIssuer.issue("titles"),
      fetch: ((input: URL | Request | string, init?: RequestInit) =>
        proxyHandler(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch,
      diag,
    });

  // @ryph/memory: mounted in-process over the shared cluster, OR a standalone service this
  // host dials — the historian's split, one module over. In-process, three things come out of
  // it: the management routes for this router, the orchestrator's MemoryAccess port over the
  // service itself, and the MCP data handler the gateway's platform entry (below) dials without
  // a socket, authenticated with a token minted right here and held by nobody else.
  let memoryRoutes: MemoryRoute[] = [];
  let memoryAccess: MemoryAccess | null = null;
  let memoryPlatform: PlatformUpstreams[string] | null = null;
  let consolidateMemory: HostApp["consolidateMemory"] = null;
  let backfillMemoryEmbeddings: HostApp["backfillMemoryEmbeddings"] = null;
  let drainMemory: HostApp["drainMemory"] = null;
  if (cfg.memoryUrl !== null) {
    if (cfg.memoryToken === null) {
      throw new Error("RYPH_MEMORY_URL is set but RYPH_MEMORY_TOKEN is not");
    }
    memoryAccess = httpMemoryAccess({
      memoryUrl: cfg.memoryUrl,
      memoryToken: cfg.memoryToken,
      diag,
    });
    if (cfg.memoryGatewayToken !== null) {
      memoryPlatform = {
        url: `${cfg.memoryUrl}${MEMORY_MCP_PATH}`,
        token: cfg.memoryGatewayToken,
      };
    }
  } else {
    const memoryStore = drizzleMemoryStore(scopeMemoryDb(cluster));
    try {
      await memoryStore.listMemories({ tenantId: "startup-probe", limit: 1 });
    } catch {
      throw new Error(
        `database ${JSON.stringify(cluster.description)} has no memory tables — ` +
          "run `bun run db:push` again",
      );
    }
    // The gateway's credential for the in-process data route: minted per boot, handed to both
    // halves here, never configured and never logged. The MCP route is reached through a
    // `fetch` over the handler, so no socket ever carries it.
    const gatewayToken = mintToken();
    // The platform's model: a credential from the proxy's platform issuer (above), spent on the
    // proxy handler through a `fetch` that never opens a socket — the same in-process shape the
    // gateway's platform entry uses below. Dark without model access, and the consolidator says
    // so in its stats.
    const model = platformIssuer === null || proxyHandler === null ? null : proxyModelClient({
      proxyUrl: "http://model-proxy.internal",
      credentials: () => platformIssuer.issue("memory"),
      fetch: ((input: URL | Request | string, init?: RequestInit) =>
        proxyHandler(
          input instanceof Request ? new Request(input, init) : new Request(String(input), init),
        )) as typeof fetch,
      diag: loggerDiagnostics("memory"),
    });
    const memory = setupMemory({
      store: memoryStore,
      authenticate,
      gatewayToken,
      serviceToken: null,
      model,
      embedder: cfg.memoryEmbedder ?? null,
      gitlabUrl: cfg.memoryGitlabUrl ?? null,
      now,
      diag: loggerDiagnostics("memory"),
    });
    memoryRoutes = memory.routes;
    memoryAccess = {
      composeBrief: (req) => memory.service.composeBrief(req),
      reportOutcome: (runId, status) => memory.service.reportOutcome(runId, status),
      reportPatch: (runId, patch) => memory.service.reportPatch(runId, patch),
      reportChange: (runId, patchId, fate, carries) =>
        memory.service.reportChange(runId, patchId, fate, carries),
      reportStale: (runId, stale) => memory.service.reportStale(runId, stale),
    };
    consolidateMemory = memory.consolidate;
    if (cfg.memoryEmbedder) backfillMemoryEmbeddings = memory.backfillEmbeddings;
    drainMemory = memory.drain;
    await memory.recoverIngests();
    const dataUrl = `http://memory.internal${MEMORY_MCP_PATH}`;
    memoryPlatform = {
      url: dataUrl,
      token: gatewayToken,
      fetch: (async (input: URL | Request | string, init?: RequestInit) => {
        const req = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        return (await memory.dataHandler(req)) ??
          new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch,
    };
  }

  // The inbox's in-process wake-up: the runner's long-poll on a run's messages is held on this
  // signal, and everything that posts a message (the run page, a chatroom mention, an alert, a
  // patch verdict) pokes it. One instance, shared by the handler and the sweeps below, or a
  // message the submitter posts would wake nobody.
  const inbox = makeInboxSignal();

  // @ryph/chat: mounted in-process over the shared cluster, OR a standalone service — the
  // memory split, one module over. In-process, four things come out of it: the chatroom routes
  // for this router, the orchestrator's ChatAccess port over the service itself, the MCP data
  // handler the gateway's platform entry dials without a socket, and the poll pass main.ts
  // ticks. Every mention reaches the orchestrator's mention door (deliverChatMention),
  // in-process — the sink closes over the wired deps built further down, which is why it is a
  // late binding rather than an argument.
  let chatRoutes: ChatRoute[] = [];
  let chatAccess: ChatAccess | null = null;
  let chatToken: string | null = null;
  let chatPlatform: PlatformUpstreams[string] | null = null;
  let chatPoll: HostApp["chat"] = null;
  let wiredDeps: WiredDeps | null = null;
  // Where the automations surface asks which platform a response's chatroom is on: the service
  // itself in-process, its management read standalone, nobody when chat is dark.
  let chatrooms: ChatroomDirectory | null = null;
  if (cfg.chatUrl !== null) {
    if (cfg.chatToken === null) {
      throw new Error("RYPH_CHAT_URL is set but RYPH_CHAT_TOKEN is not");
    }
    chatAccess = httpChatAccess({ chatUrl: cfg.chatUrl, chatToken: cfg.chatToken, diag });
    // The standalone service delivers every mention to this process's mention door with the
    // same token; the chatroom routes are its own, reached through the app's proxy.
    chatToken = cfg.chatToken;
    chatrooms = httpChatroomDirectory({ chatUrl: cfg.chatUrl });
    if (cfg.chatGatewayToken !== null) {
      chatPlatform = { url: `${cfg.chatUrl}${CHAT_MCP_PATH}`, token: cfg.chatGatewayToken };
    }
  } else if (cfg.chatKey !== null) {
    const chatStore = drizzleChatStore(scopeChatDb(cluster));
    try {
      await chatStore.listChatrooms();
    } catch {
      throw new Error(
        `database ${JSON.stringify(cluster.description)} has no chat tables — ` +
          "run `bun run db:push` again",
      );
    }
    const gatewayToken = mintToken();
    const chat = setupChat({
      store: chatStore,
      transports: platformTransports(cfg.chatApiUrls),
      sink: {
        async deliver(mention) {
          // Built below, before anything can poll: a mention arriving before then is a bug,
          // and a loud one beats a silent drop.
          if (wiredDeps === null) throw new Error("the chat sink was used before it was wired");
          // The door answers every decision as a verdict; what it throws is its own dependency
          // down — the sink's "failed", which the poller retries and then apologises for,
          // exactly as it treats the standalone door's 5xx.
          try {
            return { kind: "verdict", verdict: await deliverChatMention(wiredDeps, mention) };
          } catch (err) {
            return { kind: "failed", error: String(err) };
          }
        },
      },
      // A run's images, read from the control plane in this process — the same answers as the
      // standalone service's routes (/v1/chat/runs/:runId/images/…), with no token between.
      images: {
        async resolve(runId, refs) {
          if (wiredDeps === null) throw new Error("the chat images were used before wiring");
          return await inProcessRunImages(wiredDeps).resolve(runId, refs);
        },
        async fetch(runId, attachmentId) {
          if (wiredDeps === null) throw new Error("the chat images were used before wiring");
          return await inProcessRunImages(wiredDeps).fetch(runId, attachmentId);
        },
      },
      masterKey: cfg.chatKey,
      authenticate,
      gatewayToken,
      serviceToken: null,
      now,
      diag: loggerDiagnostics("chat"),
    });
    chatRoutes = chat.routes;
    chatAccess = inProcessChatAccess(chat.service);
    chatrooms = {
      async platformOf(chatroomId) {
        const room = await chat.service.getChatroom(chatroomId);
        return room === null || room.archivedAt !== null ? null : room.kind;
      },
      // The same creator-or-admin gate the chat routes put on GET /v1/chatrooms/:id/channels
      // (the list names private channels the bot is in), decided here off the caller's own
      // bearer, since in-process there is no HTTP surface to answer 403 with. Only a verified
      // user ever reaches here: the host's automation routes are user-gated, so a missing or
      // refused bearer is answered as "forbidden" rather than waved through.
      async channelsOf(chatroomId, authorization) {
        const caller = await authenticate(
          new Request("http://host.internal/", {
            headers: authorization === null ? {} : { authorization },
          }),
        );
        if (caller instanceof Response) return { kind: "forbidden" };
        if (caller.kind === "user" && !can(caller, "chat:manage")) {
          const owner = await chat.service.ownerOf(chatroomId);
          if (owner === null) return { kind: "none" };
          if (owner !== caller.userId) return { kind: "forbidden" };
        }
        const listed = await chat.service.listChannels(chatroomId);
        return listed === null
          ? { kind: "none" }
          : { kind: "channels", channels: listed.channels, truncated: listed.truncated };
      },
    };
    chatPlatform = {
      url: `http://chat.internal${CHAT_MCP_PATH}`,
      token: gatewayToken,
      fetch: (async (input: URL | Request | string, init?: RequestInit) => {
        const req = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        return (await chat.dataHandler(req)) ??
          new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch,
    };
    chatPoll = { pollAll: (signal) => chat.pollAll(signal) };
  } else {
    chatRoutes = disabledChatRoutes({ authenticate: authenticateGate });
  }

  // @ryph/web: the platform's web tools. The one service with nothing to mount but a handler —
  // no store, no routes, no timers — so unless the deployment points at a standalone one
  // (cfg.webUrl), it is mounted here with a token minted at boot and reached through a `fetch`
  // over the handler, exactly as memory's MCP route is. Whether a run gets `web__search` as well
  // as `web__fetch` is the search key's presence, decided once here.
  let webPlatform: PlatformUpstreams[string] | null = null;
  let closeWeb: (() => void) | null = null;
  if (!cfg.webTools) {
    // RYPH_WEB_TOOLS=off: nothing is mounted and nothing is seeded below, so there is no row for
    // the agent form to list and no entry for a run's scope. The one switch that actually takes
    // the capability away on a deployment where the gateway is this same process.
    new Logger("web").info("RYPH_WEB_TOOLS=off — no web tools are served");
  } else if (cfg.webUrl !== null) {
    if (cfg.webGatewayToken === null) {
      throw new Error("RYPH_WEB_URL is set but RYPH_WEB_GATEWAY_TOKEN is not");
    }
    webPlatform = { url: `${cfg.webUrl}${WEB_MCP_PATH}`, token: cfg.webGatewayToken };
  } else {
    const log = new Logger("web");
    const search = searchBackendFromEnv({
      provider: cfg.webSearch.provider ?? undefined,
      key: cfg.webSearch.key ?? undefined,
    });
    // At WARN, exactly as the standalone service says it: "no search tool" is a capability the
    // operator may not have meant to withhold, and the two deployments must not disagree about
    // how loudly that is said.
    if (search.backend === null) log.warn(search.reason);
    if (cfg.webAllowInsecure) {
      log.warn("RYPH_WEB_ALLOW_INSECURE=1 — plain http pages may be fetched");
    }
    const gatewayToken = mintToken();
    // The tool calls' own log: the URL a run fetched and the query it searched for are recorded
    // here and nowhere else (the gateway's usage trail keeps no arguments).
    const webDiag: WebDiag = {
      debug: (event, fields) => log.debug(event, fields),
      info: (event, fields) => log.info(event, fields),
      warn: (event, fields) => log.warn(event, fields),
    };
    const web = setupWeb({
      gatewayToken,
      search: search.backend,
      policy: { allowInsecure: cfg.webAllowInsecure, resolve: resolveAddresses },
      timeoutMs: cfg.webFetchTimeoutMs,
      diag: webDiag,
    });
    closeWeb = web.close;
    webPlatform = {
      url: `http://web.internal${WEB_MCP_PATH}`,
      token: gatewayToken,
      fetch: (async (input: URL | Request | string, init?: RequestInit) => {
        const req = input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
        return (await web.dataHandler(req)) ??
          new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }) as typeof fetch,
    };
  }

  // Tool access, the same shape one credential class over: server CRUD, probe and the usage
  // trail on the control plane, the gateway handler on its own data-plane listener — both over
  // ONE gateway store, the in-process replacement for the internal HTTP surface a standalone
  // gateway offers a remote control plane.
  let toolAccess: ToolAccess | null = null;
  let forgePlatform: PlatformUpstreams[string] | null = null;
  let mcpRoutes: McpRoute[] = [];
  let mcpGatewayHandler: HostApp["mcpGatewayHandler"] = null;
  let hosting: HostingService | null = null;
  if (cfg.mcpKey) {
    const gatewayStore = drizzleGatewayStore(scopeMcpGatewayDb(cluster));
    // Probed like the historian's tables: the gateway's are the newest in the shared database,
    // so a data directory pushed before they existed is exactly what an upgrade looks like, and
    // it must fail here with the fix named rather than as a raw driver error on the first page
    // that lists servers.
    try {
      await gatewayStore.listServers();
    } catch {
      throw new Error(
        `database ${JSON.stringify(cluster.description)} has no mcp-gateway tables — ` +
          "run `bun run db:push` again",
      );
    }
    // Hosted servers run on the backend agents run on: under docker that is the launcher, which
    // main.ts reached with the tools token (a token that opens nothing on the run side).
    const toolHost: ToolHost | { unavailable: string } = cfg.toolHost ??
      (cfg.provisioner.kind === "docker"
        ? { unavailable: "the docker launcher was not reached with a tools token" }
        : {
          unavailable: "the manual provisioner runs no containers, so nothing can host a " +
            "server — set RYPH_PROVISIONER=docker",
        });
    // The platform's memory server: a row seeded here, so the agent form lists it and every
    // remembering agent's runs can be scoped to it, and the upstream the data plane dials for
    // it — in-process or the standalone service's MCP route, per the memory block above.
    if (memoryPlatform !== null) {
      const seeded = await ensurePlatformMemoryServer(gatewayStore, now().toISOString());
      if (!seeded.ok) {
        // Boot anyway: the remedy is a call to the management surface this very process serves,
        // so failing here would take the fix down with the fault. Unwired, the memory server is
        // absent from the agent form and from every run's default scope.
        new Logger("mcp-gateway").error(seeded.reason);
        memoryPlatform = null;
      }
    }
    // The platform's chat server, the same way: the row so the agent form lists it and a
    // response's run can be scoped to it, and the upstream the data plane dials for it.
    if (chatPlatform !== null) {
      const seeded = await ensurePlatformChatServer(gatewayStore, now().toISOString());
      if (!seeded.ok) {
        new Logger("mcp-gateway").error(seeded.reason);
        chatPlatform = null;
      }
    }
    // The platform's web server: the row so the agent form lists it and every tool-capable
    // agent's runs carry it, and the upstream the data plane dials — the handler above, or the
    // standalone service.
    if (webPlatform !== null) {
      const seeded = await ensurePlatformWebServer(gatewayStore, now().toISOString());
      if (!seeded.ok) {
        new Logger("mcp-gateway").error(seeded.reason);
        webPlatform = null;
      }
    }
    // The platform's forge server: the forge is always its own process (this host dials it over
    // HTTP), so the upstream is its tool route and the token the forge was started with.
    const forgeToolsUrl = cfg.forgeToolsUrl ??
      (cfg.forge?.kind === "http" ? cfg.forge.url.replace(/\/+$/, "") : null);
    if (cfg.forgeGatewayToken !== null && forgeToolsUrl !== null && cfg.forgeToken !== null) {
      const seeded = await ensurePlatformForgeServer(gatewayStore, now().toISOString());
      if (seeded.ok) {
        forgePlatform = { url: `${forgeToolsUrl}/v1/forge-mcp`, token: cfg.forgeGatewayToken };
      } else {
        new Logger("mcp-gateway").error(seeded.reason);
      }
    }
    const gateway = setupMcpGateway({
      store: gatewayStore,
      masterKey: cfg.mcpKey,
      authenticate: gateFor("tools:read"),
      authenticateManage: gateFor("tools:manage"),
      authenticateRunRead: runReadGateFor("tools:manage"),
      gatewayUrl: cfg.mcpGatewayUrl,
      virtualKeyTtlMs: cfg.mcpVirtualKeyTtlMs,
      upstream: { ...cfg.mcpUpstream, resolve: systemResolve },
      catalogue: await directoryCatalogue(),
      toolHost,
      guardImage: cfg.toolGuardImage,
      ...(cfg.toolEgressKey === undefined ? {} : { toolEgressKey: cfg.toolEgressKey }),
      hostingLimits: cfg.hostingLimits,
      platform: {
        ...(memoryPlatform === null ? {} : { [PLATFORM_MEMORY_SLUG]: memoryPlatform }),
        ...(chatPlatform === null ? {} : { [PLATFORM_CHAT_SLUG]: chatPlatform }),
        ...(forgePlatform === null ? {} : { [PLATFORM_FORGE_SLUG]: forgePlatform }),
        ...(webPlatform === null ? {} : { [PLATFORM_WEB_SLUG]: webPlatform }),
      },
      now,
      diag: loggerDiagnostics("mcp-gateway"),
    });
    hosting = gateway.hosting;
    const issuer = gateway.issuer;
    // The orchestrator's ToolAccess port over the package's store and issuer — the port is the
    // orchestrator's, so its in-process adapter lives here, beside the ModelAccess one above.
    toolAccess = {
      async getServer(id) {
        const server = await gatewayStore.getServer(id);
        return server === null ? null : {
          id: server.id,
          slug: server.slug,
          name: server.name,
          archivedAt: server.archivedAt,
        };
      },
      issueRunCredentials(scope) {
        if (issuer === null) {
          return Promise.reject(
            new Error("RYPH_MCP_GATEWAY_URL is not set — no gateway for runs to dial"),
          );
        }
        return issuer.issue(scope);
      },
      revokeRunCredentials(runId) {
        // Straight to the store, not through the issuer: revocation is a row write and has
        // nothing to do with whether we know the gateway's address. The standalone internal
        // route does the same for the same reason — a deployment that lost RYPH_MCP_GATEWAY_URL
        // must not thereby keep every live credential alive until its 12-hour TTL.
        return gatewayStore.revokeVirtualKeysForRun(runId, now().toISOString());
      },
      async archiveServer(id) {
        const outcome = await gateway.archive(id);
        return outcome.kind === "archived"
          ? { kind: "archived", server: { ...outcome.server } }
          : outcome;
      },
    };
    mcpRoutes = gateway.routes;
    mcpGatewayHandler = gateway.gatewayHandler;
  } else {
    mcpRoutes = disabledMcpServerRoutes({ authenticate: authenticateGate });
  }

  // The catalogue is loaded only when the feature is on: an invalid entry is fatal at load, and
  // a deployment that runs no services should not fail to boot over a list it never consults.
  let serviceCatalogue: ServiceCatalogue | null = null;
  if (cfg.services.enabled) serviceCatalogue = await directoryServiceCatalogue();

  // The skills catalogue is on for every deployment, and an invalid skill is fatal at load. Its
  // bundles are stored before anything is served, so a run frozen on an older catalogue still
  // finds its digest after an upgrade.
  const skillCatalogue = await directorySkillCatalogue();
  const skillStore = drizzleSkillStore(scopeDb(cluster), now);
  await skillStore.upsertBundles(
    skillCatalogue.list().map((skill) => skillCatalogue.bundle(skill.digest)!),
  );

  // Under docker, every port is the launcher's client: this process launches nothing itself.
  const launcher = cfg.provisioner.kind === "docker" ? cfg.provisioner.launcher : null;
  const provisioner = launcher !== null
    ? launcher.provisioner
    : cfg.provisioner.kind === "kubernetes"
    ? kubernetesProvisioner(cfg.provisioner, diag)
    : manualProvisioner(diag);
  // The one boot line about the browser: off, on, or set on a backend that cannot launch it.
  const browserLine = browserPosture(cfg.browser, provisioner, cfg.provisioner.kind);
  new Logger("orchestrator")[browserLine.level](browserLine.message);
  // Docker leaves a finished run's containers, network and services behind. Reconciled on the
  // reaper's tick (see ReaperDeps.reconcile — `kill` misses a run that simply FINISHES) and once
  // here, before anything is served: the launcher lists, this reads the active runs, the launcher
  // removes what it listed and the read did not name.
  const reconcile = launcher?.reconcile;
  // The check pods' backend, a sibling of the provisioner only kubernetes and docker have.
  const checkPolicy = cfg.checks ?? null;
  const checkLauncher: CheckLauncher | null =
    checkPolicy?.enabled !== true || cfg.remoteChecks != null
      ? null
      : launcher !== null
      ? launcher.checkLauncher
      : cfg.provisioner.kind === "kubernetes"
      ? kubernetesCheckLauncher(cfg.provisioner, diag)
      : null;
  if (reconcile) await reconcile(async () => (await baseStore.listActiveRuns()).map((r) => r.id));

  // Reserved capacity, where the provisioner can hold it: placeholders per size class, applied
  // from the saved setting on the reaper's tick (core/reserved_capacity.ts in the orchestrator).
  const capacity = provisioner.capacity !== undefined && cfg.agentImage !== null
    ? makeCapacityReconciler({
      store: baseStore,
      reserver: provisioner.capacity,
      runSizes: cfg.runSizes,
      image: cfg.agentImage,
      services: serviceRoom(
        cfg.services,
        (await serviceCatalogue?.list()) ?? [],
        browserOffered(cfg.browser, provisioner) ? cfg.browser : null,
      ),
      diag,
      now,
      intervalMs: cfg.capacityReconcileIntervalMs ?? 60_000,
      tickMs: cfg.reaperIntervalMs ?? 10_000,
    })
    : null;

  // Linked identities are auth's rows in this same database; the control plane reads them
  // through the directory port rather than joining across packages.
  // In GitHub's or GitLab's user mode, every active user's login there is the token's — folded
  // in here, once, rather than at each call site that asks.
  const linkedIdentities = authStoreIdentityDirectory(authStore, {
    gitlab: gitlabMode,
    gitlabUsers: gitlabConnect,
  });
  const identityDirectory = githubMode === null && gitlabMode === null
    ? linkedIdentities
    : forgeUserModeDirectory(linkedIdentities, { github: githubMode, gitlab: gitlabMode });

  // Readiness is one cheap read of the cluster every module here shares. Liveness asks nothing:
  // a database outage must route traffic away, never restart the fleet into a crash loop.
  const health = makeHealth({ ready: () => baseStore.listTasks({ limit: 1 }), log: diag });

  const runnerControl = httpRunnerControl(provisioner, diag);
  // A publish's served document is made in a child process, killed at its deadline; the
  // composition root owns the preparer and kills any still running on shutdown.
  // This process starts it itself (the binary as itself, a source run under `node --permission`
  // where a node that can confine it is installed, else under its own runtime); it says now when
  // the sanitizer runs unconfined, or that it cannot run and every publish is refused.
  const artifactHtml = processArtifactHtml({
    onKilled: (runId) => diag.warn("artifact.sanitizer_killed", { runId }),
    onUnavailable: (why) => new Logger("orchestrator").error(why),
    onUnconfined: (why) => new Logger("orchestrator").warn(why),
  });
  const appDeps: AppDeps = {
    store,
    provisioner,
    runnerControl,
    diag,
    authenticate,
    modelAccess,
    toolAccess,
    forgeToken: cfg.forgeToken,
    // Gated on the URL, not the token alone: the run-token verify surface exists only to serve a
    // REMOTE historian, so an in-process deployment never exposes it even if a token is set.
    historyToken: cfg.historyUrl !== null ? cfg.historyToken : null,
    runGrantKeys: {
      history: cfg.historyUrl !== null ? cfg.historyToken : runGrantKey,
      models: runGrantKey,
      tools: runGrantKey,
    },
    // The automations events door stays dark: the mounted service below hands fires over
    // in-process, so there is no second process to authenticate.
    automationsToken: null,
    forge,
    githubMode,
    gitlabMode,
    githubConnect,
    githubUserConnect,
    gitlabConnect,
    radicleConnect,
    localConnect,
    serviceCatalogue,
    skillCatalogue,
    skills: skillStore,
    forgeSkills,
    patchDiffs,
    identityDirectory,
    memoryAccess,
    chatAccess,
    platformModel,
    chatToken,
    inbox,
    taskFeed,
    capacity,
    attachmentStore: cfg.attachmentStore ?? null,
    // A run's background commands: rows beside the run, logs beside the build logs.
    backgroundStore: drizzleBackgroundStore(scopeDb(cluster)),
    artifacts: drizzleArtifactStore(scopeDb(cluster)),
    artifactHtml,
    artifactThumbnail: cfg.artifactThumbnail ?? null,
    backgroundLogs: cfg.environmentLogs,
    imagePrefetch: cfg.imagePrefetch ?? null,
    now,
    config: {
      publicUrl: cfg.publicUrl,
      browser: cfg.browser,
      provisionerKind: cfg.provisioner.kind,
      agentImage: cfg.agentImage,
      harnessKinds: cfg.harnessKinds,
      runSizes: cfg.runSizes,
      limits: cfg.limits,
      environments: cfg.environments,
      gitGateway: cfg.gitGateway,
      runHistoryUrl: cfg.runHistoryUrl ?? cfg.historyUrl,
      appUrl: cfg.appUrl,
      services: cfg.services,
      egress: cfg.egress,
      // The platform entry joins a run's scope only when the gateway can serve it: tool access
      // on (a credential can be minted) and memory wired into it (the row exists, the forward
      // has a destination). Otherwise a brief may still ride the spec, but no tools do.
      platformMemoryServerId: toolAccess !== null && memoryPlatform !== null
        ? PLATFORM_MEMORY_SERVER_ID
        : null,
      // The chat tool joins a response's run on the same terms: the gateway can serve it, and
      // there is a chat service to bind the room — which is what makes the tool answer.
      platformChatServerId: toolAccess !== null && chatPlatform !== null && chatAccess !== null
        ? PLATFORM_CHAT_SERVER_ID
        : null,
      // The two the networked deployment has to ASK the gateway about are known outright here,
      // because this process is the gateway: nothing is pending, ever.
      //
      // The forge tools join a forge-policied agent's runs on the same terms: the gateway can
      // serve them, and the forge they act through is wired — it resolves their grants here. The
      // web tools join every tool-capable agent's runs on the same terms memory's do: the gateway
      // can serve them, and a web service — mounted here or standalone — is wired. `served:
      // false` does more than withhold the default entry: it drops an entry an agent's own tool
      // policy made for the web row, which is what makes RYPH_WEB_TOOLS=off take the capability
      // away rather than only stop granting it (a platform row cannot be archived, so a row
      // seeded by an earlier boot outlives the switch).
      platformTools: {
        webServerId: PLATFORM_WEB_SERVER_ID,
        web: toolAccess !== null && webPlatform !== null,
        forge: toolAccess !== null && forgePlatform !== null && forge !== null
          ? PLATFORM_FORGE_SERVER_ID
          : null,
        pending: false,
      },
    },
  };
  if (cfg.environments.enabled && cfg.environments.builder === "docker" && launcher === null) {
    throw new Error(
      "docker environment builds run in the docker launcher, which only RYPH_PROVISIONER=docker " +
        "starts — set it, or name another RYPH_ENV_BUILDER",
    );
  }
  // Environment builds, when on: the queue in this same database, the builder the configuration
  // names, and a service that launches a waiting run itself once its build lands — so it is
  // handed everything startTask is, and the doors are handed it.
  const wiredEnvironments = cfg.environments.enabled && cfg.environmentLogs !== null
    ? wireEnvironments({
      environmentStore: drizzleEnvironmentStore(scopeDb(cluster)),
      // A docker build runs in the launcher, confined as its runs are; every other builder is
      // this process's own (a Job, a Cloud Build) and needs no docker.
      builder: launcher !== null && cfg.environments.builder === "docker"
        ? launcher.environmentBuilder
        : createEnvironmentBuilder(cfg.environments, { diag }),
      logs: cfg.environmentLogs,
      start: {
        store,
        provisioner,
        diag,
        forge,
        serviceCatalogue,
        skillCatalogue,
        skills: skillStore,
        memoryAccess,
        identityDirectory,
        modelAccess,
        attachmentStore: cfg.attachmentStore ?? null,
        chatAccess,
        platformModel,
        now,
        config: appDeps.config,
      },
      config: appDeps.config,
      inbox,
      githubMode,
    })
    : null;
  appDeps.environments = wiredEnvironments?.service ?? null;
  appDeps.environmentFeedback = wiredEnvironments?.feedback ?? null;
  appDeps.startWithoutEnvironment = wiredEnvironments?.startWithoutEnvironment ?? null;

  // Checks, when on: suites in this same database, pods through the launcher, the declaration
  // read through the forge, the base's environment through the build queue above.
  let checks: ChecksService | null = null;
  let checksAwaiting: WiredChecks["awaiting"] | null = null;
  if (checkPolicy?.enabled === true && cfg.environmentLogs !== null) {
    const checkStore = drizzleCheckStore(scopeDb(cluster));
    const wired = wireChecks({
      store: checkStore,
      tasks: store,
      launcher: checkLauncher,
      remoteChecks: cfg.remoteChecks,
      forge: forgeChecks,
      environments: appDeps.environments,
      logs: cfg.environmentLogs,
      serviceCatalogue,
      inbox,
      diag,
      now,
      config: {
        policy: checkPolicy,
        agentImage: cfg.agentImage,
        runSizes: cfg.runSizes,
        gitGateway: cfg.gitGateway,
        services: cfg.services,
        egress: cfg.egress,
        appUrl: cfg.appUrl,
      },
    });
    checks = wired.service;
    checksAwaiting = wired.awaiting;
    if (checks.refusedReason !== null) diag.warn("checks.refused", { why: checks.refusedReason });
    // What a previous life left behind is the tick's orphan sweep's, within its first minute.
  }
  appDeps.checks = checks;
  appDeps.checksAwaiting = checksAwaiting;

  // What every in-process door is handed: the deps with the inbox signal on them — the same
  // signal makeHandler puts on its routes, so a message posted through any door wakes the
  // runner's poll wherever it is held.
  wiredDeps = { ...appDeps, inbox, taskFeed };

  // @ryph/automations: mounted in-process — its recipes, its fire history, and its mailroom's
  // hooks table all as views of the one cluster. Fires skip the loopback: the direct sink below
  // calls the events door's extracted core against the same deps the router serves.
  const automationsDiag = loggerDiagnostics("automations");
  const automationStore = drizzleAutomationStore(scopeAutomationsDb(cluster).db);
  try {
    await automationStore.listEnabledAutomations();
  } catch {
    throw new Error(
      `database ${JSON.stringify(cluster.description)} has no automations schema — ` +
        "run `bun run db:push` in packages/host first",
    );
  }
  const onFireIngestedHooks: Array<() => void> = [];
  const webhooks = setupWebhooks({
    store: drizzleHookStore(scopeWebhooksDb(cluster).db),
    diag: automationsDiag,
    now,
    onIngested: () => onFireIngestedHooks.forEach((hook) => hook()),
    onRateLimited: (id) => automationsSetup.recordRateLimited(id),
  });
  const automationsSetup = setupAutomations({
    store: automationStore,
    webhooks,
    sink: {
      async deliver(event) {
        const verdict = await handleAutomationEvent(wiredDeps!, event);
        const body = verdict.body as Record<string, unknown>;
        if (verdict.status === 200) {
          return {
            kind: "ok",
            outcome: typeof body.outcome === "string" ? body.outcome : "started",
            taskId: typeof body.taskId === "string" ? body.taskId : null,
            runId: typeof body.runId === "string" ? body.runId : null,
            detail: typeof body.detail === "string" ? body.detail : null,
          };
        }
        return {
          kind: "failed",
          message: typeof body.error === "string" ? body.error : `status ${verdict.status}`,
          terminal: verdict.status === 400 || verdict.status === 422,
        };
      },
      async refreshAccess(probe) {
        try {
          await refreshAutomationAccess(wiredDeps!, probe);
        } catch (err) {
          automationsDiag.warn("automations.access_refresh_failed", { err: String(err) });
        }
      },
    },
    diag: automationsDiag,
    now,
  });
  await automationsSetup.syncRegistry();
  // The CRUD surface needs the CALLER, not just permission, and it is user-only: break-glass
  // has no user behind it, so it has nothing it could own here.
  const authenticateUser = async (req: Request): Promise<Claims | Response> => {
    const outcome = await authenticate(req);
    if (outcome instanceof Response) return outcome;
    if (outcome.kind !== "user") return unauthorized();
    return {
      sub: outcome.userId,
      email: outcome.email,
      name: outcome.name,
      caps: outcome.caps,
      emailVerified: outcome.emailVerified,
      sid: outcome.sid,
      via: outcome.via,
    };
  };

  const previews = cfg.localPreviews === true && isLocalAppUrl(cfg.appUrl)
    ? localPreviews({
      authenticateRunner: async (req, runId) => {
        const run = await baseStore.getRun(runId);
        return run !== null && await runTokenMatches(req, run);
      },
      authenticateReader: makeRunReadGate({
        grantKey: cfg.historyUrl !== null ? cfg.historyToken : runGrantKey,
        bearer: grantBearer,
        fallback: gateFor("tasks:read-all"),
      }),
      active: async (runId) => {
        const run = await baseStore.getRun(runId);
        return run !== null && !TERMINAL_STATES.has(run.state);
      },
      ...(cfg.previewListener === undefined ? {} : { listener: cfg.previewListener }),
    })
    : null;
  if (previews?.listening) {
    const { hostname, port } = cfg.previewListener!;
    await previews.listening.catch((err) => {
      previews.close();
      throw new Error(
        `the preview listener could not bind ${hostname}:${port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  const handler = makeHandler(appDeps, [
    ...(previews?.routes ?? []),
    ...health.routes,
    ...auth.routes,
    ...modelKeyRoutes,
    ...mcpRoutes,
    ...historyRoutes,
    ...webhooks.routes,
    ...automationRoutes({
      store: automationStore,
      setup: automationsSetup,
      authenticate: authenticateUser,
      chatrooms,
      diag: automationsDiag,
      now,
    }),
    ...memoryRoutes,
    ...chatRoutes,
  ]);

  return {
    handler,
    health,
    closePreviews: () => previews?.close(),
    proxyHandler,
    closePlanListener,
    mcpGatewayHandler,
    hosting,
    store,
    environments: wiredEnvironments?.service ?? null,
    checks,
    reconcileSkills: async () => {
      await syncOrgSkills({ skills: skillStore, forge: forgeSkills, diag, now }, "reconcile", null);
    },
    capacity,
    // modelAccess rides the sweep so a run the reaper writes off as lost has its virtual key
    // killed too — the one conclusion that never carries a runner report. memoryAccess rides
    // it for the same reason: a lost run is an outcome memory should hear about.
    // runnerControl and chatAccess ride it too: a run whose idle clock lapsed is cancelled from
    // the sweep (pushed to its container when it advertised where), and a lost run's response
    // closes its chatroom binding like any other conclusion.
    sweepDeps: {
      store,
      provisioner,
      runnerControl,
      diag,
      modelAccess,
      toolAccess,
      memoryAccess,
      chatAccess,
      appUrl: cfg.appUrl,
      now,
      reconcile,
      settleWaitingRun: wiredEnvironments?.settleWaitingRun ?? null,
      // For the retention sweep of uploads no message ever carried.
      attachmentStore: cfg.attachmentStore ?? null,
    },
    // memoryAccess rides the patch sweep too: a patch that fails past retrying is a change
    // memory has been waiting on, and the submitter is the last place anything notices.
    // The inbox signal rides the patch sweep: a submitted patch is told to the run as a
    // message, and the poll holding on that run should hear it now rather than a second later.
    patchSweepDeps: forge === null ? null : {
      store,
      forge,
      identityDirectory,
      diag,
      memoryAccess,
      inbox,
      environmentFeedback: wiredEnvironments?.feedback ?? null,
      checks,
      appUrl: cfg.appUrl,
      // In GitHub's user mode, which has no webhooks, merges are polled (core/merge_poll.ts).
      githubMode,
      now,
    },
    progressSweepDeps: forge === null
      ? null
      : { store, forge, identityDirectory, diag, now, appUrl: cfg.appUrl },
    onTerminal: (hook) => onTerminalHooks.push(hook),
    automations: {
      tick: () => webhooks.tick(),
      schedulerTick: () => automationsSetup.schedulerTick(),
      accessTick: () => automationsSetup.accessTick(),
    },
    onFireIngested: (hook) => onFireIngestedHooks.push(hook),
    cancelRun: async (run) => {
      await cancelRun({ store, runnerControl, environments: appDeps.environments, now }, run);
    },
    consolidateMemory,
    backfillMemoryEmbeddings,
    sweepAuth: auth.sweep,
    auth,
    drainMemory,
    chat: chatPoll,
    close() {
      previews?.close();
      // Every store here is a view of a cluster the caller owns and closes. What this process
      // holds of its own is its workers: the web converter's and the artifact sanitizer's.
      closeWeb?.();
      artifactHtml.close();
    },
  };
}
