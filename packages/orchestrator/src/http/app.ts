// Assembles the three HTTP surfaces into one pure handler.
// Everything the handlers need arrives as AppDeps — no globals, no env reads — so a test
// builds the whole app from fakes and drives it with plain Request objects.

import type { Authenticate, Principal } from "@ryph/auth/gates";
import type { RunGrantKeys } from "./scope.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type {
  Forge,
  ForgePatchDiffs,
  ForgeSkills,
  GithubConnect,
  GithubModeSource,
  GithubUserConnect,
  GitlabConnect,
  LocalConnect,
  RadicleConnect,
} from "../ports/forge.ts";
import type { GitlabModeSource } from "../adapters/forge/gitlab_mode.ts";
import type { ChatAccess } from "../ports/chat_access.ts";
import type { ImagePrefetch } from "../ports/image_prefetch.ts";
import type { MemoryAccess } from "../ports/memory_access.ts";
import { type InboxSignal, makeInboxSignal } from "../core/inbox_signal.ts";
import type { Provisioner } from "../ports/provisioner.ts";
import type { ServiceCatalogue } from "../ports/service_catalogue.ts";
import type { SkillCatalogue } from "../ports/skill_catalogue.ts";
import type { SkillStore } from "../ports/skill_store.ts";
import type { ServicePolicy } from "../core/services.ts";
import type { EgressPolicy } from "../core/egress.ts";
import type { RunSizes } from "../core/run_sizes.ts";
import type { BrowserConfig } from "../core/browser.ts";
import type { EnvironmentsConfig } from "../core/environment_config.ts";
import type { EnvironmentService } from "../core/environments.ts";
import type { PlatformToolServers } from "../helpers/platform_server.ts";
import type { EnvironmentFeedback } from "../core/environment_feedback.ts";
import type { ChecksService } from "../core/checks.ts";
import type { OwedVerdict } from "../core/check_awaiting.ts";
import type { CapacityReconciler } from "../core/reserved_capacity.ts";
import type { RunnerControl } from "../ports/runner_control.ts";
import type { IdentityDirectory } from "../ports/identity_directory.ts";
import { silentTaskFeed, type TaskFeed } from "../ports/task_feed.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import type { BackgroundStore } from "../ports/background_store.ts";
import type { ArtifactStore } from "../ports/artifact_store.ts";
import type { ArtifactHtmlPreparer } from "../ports/artifact_html.ts";
import type { ArtifactThumbnailRenderer } from "../ports/artifact_thumbnail.ts";
import type { BuildLogStore } from "../ports/build_log_store.ts";
import type { Dialect } from "@ryph/model-proxy";
import type { PlatformModel } from "../ports/platform_model.ts";
import type { PreviewsService } from "../ports/previews.ts";
import { makeRouter, type Route } from "@ryph/shared/http";
import { userRoutes } from "./user_api.ts";
import { runnerRoutes } from "./runner_api.ts";
import { automationsRoutes } from "./automations_api.ts";
import { forgeRoutes } from "./forge_api.ts";
import { chatRoutes } from "./chat_api.ts";
import type { DeploymentLimits } from "../core/run_limits.ts";
import { commandRoomRoutes } from "./command_rooms_api.ts";
import { historyVerifyRoutes } from "./history_api.ts";
import { environmentRoutes } from "./environments_api.ts";
import { egressRoutes } from "./egress_api.ts";
import { checksRoutes } from "./checks_api.ts";
import { skillsRoutes } from "./skills_api.ts";
import { capacityRoutes } from "./capacity_api.ts";
import { attachmentRoutes } from "./attachments_api.ts";
import { backgroundRoutes } from "./background_api.ts";
import { artifactRoutes } from "./artifacts_api.ts";
import { previewsRoutes } from "./previews_api.ts";

export interface AppConfig {
  /** The address runners are told to reach this orchestrator at. */
  publicUrl: string;
  /**
   * The browser sidecar (`RYPH_BROWSER_IMAGE`, `RYPH_BROWSER_CPUS`, `RYPH_BROWSER_MEMORY`). Null:
   * the deployment runs none, and no run gets a browser. See core/browser.ts.
   */
  browser: BrowserConfig | null;
  /**
   * RYPH_PROVISIONER (`docker`, `kubernetes`, …), for saying which backend cannot do a thing
   * (`GET /v1/harnesses`' `provisioner`). Absent reads as unknown.
   */
  provisionerKind?: string;
  /**
   * The default agent image (`RYPH_AGENT_IMAGE`): the universal environment plus the harness
   * layer, the same for every harness kind because every image carries every harness. Null:
   * none configured, which only the manual provisioner accepts.
   */
  agentImage: string | null;
  /**
   * The harness kinds an agent may be created with (`RYPH_HARNESS_KINDS`, default `pi,echo`).
   * The kind picks which harness the runner drives, never an image.
   */
  harnessKinds: string[];
  /** The size classes a run can get (`RYPH_RUN_SIZES`) and the default one. See
   * core/run_sizes.ts. */
  runSizes: RunSizes;
  /**
   * Environment builds (`RYPH_ENVIRONMENTS` and the `RYPH_ENV_*` family). Off by default, and
   * off means every run launches on `agentImage`. See core/environment_config.ts.
   */
  environments: EnvironmentsConfig;
  /**
   * The forge git gateway, as an agent container dials it (RYPH_GIT_GATEWAY_URL). Null: no
   * gateway — runs clone their repo URL directly and push, exactly as before the forge
   * existed. Set: every new run's WorkItem.repo points at the gateway, its clone credential
   * is a run-scoped virtual key, and its work leaves as a bundle.
   */
  gitGateway: { url: string; keyTtlMs: number } | null;
  /**
   * The historian as a RUN dials it (RYPH_RUN_HISTORY_URL, else RYPH_HISTORY_URL), handed to
   * every run as its RYPH_HISTORY_URL. Not how this process dials it: the composition root keeps
   * RYPH_HISTORY_URL for its own conclude pings. Null: the historian is mounted in-process
   * (single-process host), so a run reports its transcript to this orchestrator's origin. Set: a
   * standalone historian, and every run is told to POST its transcript there instead.
   */
  runHistoryUrl: string | null;
  /**
   * RYPH_APP_URL — the web app's origin as a BROWSER reaches it, for links embedded in
   * outward-facing text (the run link in a progress comment). Distinct from `publicUrl` on
   * purpose: that is the API origin as runners dial it (often container-only, e.g.
   * host.docker.internal), which no human's browser can open. Null: links are omitted.
   */
  appUrl: string | null;
  /**
   * Service containers: whether a connected repo's `.ryph/services.yml` is read at all, and
   * what it may ask for. Off by default — see core/services.ts — because on means this
   * deployment pulls and runs images chosen from a repo's tree on the operator's machines.
   */
  services: ServicePolicy;
  /**
   * Egress: where a run may reach on the open internet, and what it presents to get there.
   *
   * `policy` is the operator's ceiling — every agent's own policy narrows it and none may widen
   * it. `key` signs the claim a run presents to the proxy, and `tokenTtlMs` bounds how long that
   * claim outlives the run that was handed it. With `key` or `policy.proxyUrl` absent no run is
   * given a route out at all, which is what default-closed means for a half-wired deployment.
   */
  egress: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
  /**
   * The gateway's platform memory server, by id, when this deployment can serve it: memory is
   * configured AND tool access is on, so the row exists and a credential can be minted for it.
   * Set, every run of an agent with a memory policy gets it in its frozen tool scope. Null: no
   * run does — a brief may still be composed, but no tools reach the container.
   */
  platformMemoryServerId: string | null;
  /**
   * The gateway's platform chat server, by id, when this deployment can serve it: a chat
   * service is wired AND tool access is on. Set, a run bound to a chatroom gets it in its frozen
   * tool scope and the agent can post there. Null: no run does.
   */
  platformChatServerId: string | null;
  /**
   * The two platform tool servers this process cannot see for itself — the forge's tool surface
   * and the web service's. Both are wired into the GATEWAY, so what this process knows is what
   * the gateway answers when asked, which it cannot do before it is listening and this process
   * must not wait for before IT is listening. Hence a holder filled in behind the listener:
   *
   * - `forge`: set, a run of an agent with a forge policy gets it in its frozen tool scope, its
   *   allowlist derived from the run's forge scope. Null: no run does, and a forge policy is
   *   refused at the form.
   * - `web` with `webServerId`: served, every tool-capable agent's runs get the row —
   *   `web__search` (where the deployment has a search key) and `web__fetch`. Not served, no run
   *   does AND any entry an agent's own tool policy made for that row is dropped, because a
   *   platform row cannot be archived and would otherwise outlive the switch that turned it off.
   */
  platformTools: PlatformToolServers;
  /**
   * The operator's run limits (`RYPH_RUN_MAX_*`, `RYPH_RUN_CONCURRENCY`,
   * `RYPH_RUN_MAX_CREDENTIALS`): the ceiling every agent's policy and every task's override
   * stay under, and the deployment-wide caps. See core/run_limits.ts.
   */
  limits: DeploymentLimits;
}

// Who a user-surface request speaks for, and the gate that says so: @ryph/auth's, shared with
// every service. The composition root decides what counts as authenticated (a verified
// @ryph/auth access token by default); the HTTP layer only asks.
export type { Authenticate, Principal };

/**
 * Model access, as the HTTP layer sees it: enough to validate an agent's policy against real
 * key rows and to mint/kill run credentials. Two adapters stand behind it and this layer cannot
 * tell them apart — an in-process @ryph/model-proxy issuer in the single-process host, or
 * adapters/model_access/http.ts against a standalone proxy's internal surface. Null when the
 * deployment has configured neither; the feature is then dark, and agents with a model policy
 * are refused at creation. Note what is absent: no secret ever crosses this interface —
 * `issueRunCredentials` returns a run-scoped VIRTUAL key, already inside the env map the runner
 * will hand its harness.
 *
 * `getKey` answers a DIALECT beside the provider id because the id no longer implies a wire
 * shape: two providers are built in, and every other one is a slug an admin typed when they
 * registered an OpenAI-compatible endpoint. "Can this harness drive this key" is a question
 * about the shape, so the shape has to travel with the key — see refuseModelPolicy.
 *
 * It answers TWO archived timestamps for the same reason: a registered endpoint can be archived
 * just as a key can, and each is a kill switch the credential issuer enforces at a run's boot.
 * Only the key's used to cross, so an agent could be created against a withdrawn endpoint and
 * every run of it then boot-failed. `providerArchivedAt` is the endpoint's, and is always null
 * for the two built-ins, which cannot be archived.
 */
export interface ModelAccess {
  getKey(
    id: string,
  ): Promise<
    {
      id: string;
      provider: string;
      dialect: Dialect;
      /** When the ENDPOINT behind the key was withdrawn; null for a live one and every built-in. */
      providerArchivedAt: string | null;
      /** When the KEY itself was archived. */
      archivedAt: string | null;
    } | null
  >;
  issueRunCredentials(scope: {
    runId: string;
    /** What the proxy attributes the run's model spend to. */
    agentId: string;
    taskId: string;
    providerKeyId: string;
    provider: string;
    allowedModels: string[] | "*";
    /** The run's spend cap and calls-in-flight cap, frozen onto the credential like the
     * allowlist; null is uncapped. */
    spendUsd: number | null;
    callsInFlight: number | null;
  }): Promise<Record<string, string>>;
  /** Kills every live credential of a concluded run. Idempotent, best-effort at call sites. */
  revokeRunCredentials(runId: string): Promise<void>;
  /** The run's priced spend so far, USD at list price — what the sweep holds against its cap.
   * Throws when the proxy cannot answer: a proxy that is down is not "$0 spent". */
  spendOf(runId: string): Promise<number>;
  /** Whether the deployment's spend ceiling is reached; false when none is set. */
  ceilingReached(): Promise<boolean>;
}

/** What the boot-time credentials fetch hands the container for its tools: ONE virtual token
 * covering every server in the run's scope, and per server the gateway URL to dial. */
export interface McpRunCredentials {
  token: string;
  servers: Array<{ slug: string; name: string; url: string }>;
}

/**
 * Tool access, as the HTTP layer sees it — the ModelAccess port one credential class over:
 * enough to validate an agent's tool policy against real server rows and to mint/kill a run's
 * virtual MCP token. The same two adapters stand behind it: an in-process @ryph/mcp-gateway
 * issuer in the single-process host, or adapters/tool_access/http.ts against a standalone
 * gateway's internal surface. Null when the deployment has configured neither; agents with a
 * tool policy are then refused at creation. No secret crosses this interface either: the
 * server lookup answers metadata, and `issueRunCredentials` returns a run-scoped VIRTUAL token
 * the gateway resolves back to the real credential on every call.
 */
export interface ToolAccess {
  getServer(
    id: string,
  ): Promise<{ id: string; slug: string; name: string; archivedAt: string | null } | null>;
  issueRunCredentials(scope: {
    runId: string;
    servers: Array<{ serverId: string; allowedTools: string[] | "*" }>;
  }): Promise<McpRunCredentials>;
  /** Kills every live MCP credential of a concluded run. Idempotent, best-effort at call sites. */
  revokeRunCredentials(runId: string): Promise<void>;
  /**
   * Archives one server — the kill switch. Ungated on the gateway side: the user route in front
   * of it (http/user/mcp_servers.ts) holds the capability gate and the "no agent still names it"
   * check. Idempotent. `missing` and `platform` are definitive; a gateway that could not answer
   * throws. `server` is the row as the gateway's API shows it, passed through unread.
   */
  archiveServer(id: string): Promise<ToolServerArchive>;
}

/** What archiving one MCP server came to, as the gateway answered it. */
export type ToolServerArchive =
  | { kind: "archived"; server: Record<string, unknown> }
  | { kind: "missing" }
  | { kind: "platform" };

export interface AppDeps {
  store: TaskStore;
  provisioner: Provisioner;
  runnerControl: RunnerControl;
  diag: Diagnostics;
  authenticate: Authenticate;
  modelAccess?: ModelAccess | null;
  toolAccess?: ToolAccess | null;
  /** The shared service credential the forge gateway presents (RYPH_FORGE_TOKEN).
   * Null/absent: the forge surface is dark — its routes are not even mounted. */
  forgeToken?: string | null;
  /**
   * The credentials run grants are signed with, one per service holding a run's records: the
   * token each already shares with this process, or one minted at boot where the service is
   * mounted in-process. Null/absent: no grants; those services' per-run reads then take their
   * own `-all` capability.
   */
  runGrantKeys?: RunGrantKeys | null;
  /** The shared service credential a standalone historian presents (RYPH_HISTORY_TOKEN).
   * Null/absent: the history verify surface is dark — its route is not even mounted, which is
   * the single-process deployment where the historian reads run rows in-process instead. */
  historyToken?: string | null;
  /** The shared service credential the automations service presents
   * (RYPH_AUTOMATIONS_TOKEN). Null/absent: the automations events surface is dark — its
   * route is not even mounted. */
  automationsToken?: string | null;
  /** The forge as the control plane dials it (ports/forge.ts). Null: no forge — connected
   * repos, permission gates, and patch submission are all dark, and no task can start. */
  forge?: Forge | null;
  /** How the forge acts on GitHub, cached (adapters/forge/github_mode.ts). Lookups of a
   * connected repo by its NAME skip a GitHub row whose tenant does not fit the mode
   * (`tenantFitsMode`): one left over from the other mode is refused by the forge, and newer
   * rows would otherwise win. Null/absent: the mode is unknown and every row fits. */
  githubMode?: GithubModeSource | null;
  /** How the forge acts on GitLab, cached (adapters/forge/gitlab_mode.ts) — where its instance
   * is: a GitLab row connected on another instance is no event's repo. Null/absent: asked of
   * `forge.providers()` when needed. */
  gitlabMode?: GitlabModeSource | null;
  /** A patch's diff, read from the forge for its reviewer (ports/forge.ts). Null: no forge, and
   * the diff route answers 503 while the rest of the patch surface still works. */
  patchDiffs?: ForgePatchDiffs | null;
  /** GitHub's own connect surface — installations and OAuth — beside the forge-agnostic port.
   * Null: this deployment has no GitHub App, and the connect routes answer 503. */
  githubConnect?: GithubConnect | null;
  /** GitHub's connect surface in USER mode — the token owner's repos, no installation. Null:
   * no forge, and the user-mode connect routes answer 503. Wired whenever a forge is; whether
   * the forge is IN user mode is its own answer (`Forge.providers`), asked per request. */
  githubUserConnect?: GithubUserConnect | null;
  /** GitLab's connect surface — the projects the forge's token reaches, and a project's webhook
   * token — beside the same port. Null: no forge that could run GitLab, and its routes answer
   * 503. Wired whenever a forge is; whether the forge RUNS GitLab, and as a bot or a person, is
   * its own answer (`Forge.providers`), asked per request. */
  gitlabConnect?: GitlabConnect | null;
  /** Radicle's own connect surface — seeding and identity documents — beside the same port.
   * Null: this deployment runs no Radicle node, and its routes answer 503 (or 404, where the
   * route's whole subject is the node). */
  radicleConnect?: RadicleConnect | null;
  /** The `local` forge's connect surface — "is this path a repository you may read". Null: no
   * forge, and connecting a local repository answers 503. A forge with no local provider is
   * wired all the same and says so itself (501), which the connect route passes on. */
  localConnect?: LocalConnect | null;
  /** Which service images this deployment knows how to run safely. Null: none are known, so a
   * declaration is satisfiable only through the operator's image allowlist. */
  serviceCatalogue?: ServiceCatalogue | null;
  /** The skills ryph ships (ports/skill_catalogue.ts). Null/absent: runs are frozen with no
   * skills, and the runner's bundle route answers 404. */
  skillCatalogue?: SkillCatalogue | null;
  /** Skills' stored state (ports/skill_store.ts): bundles by digest, so a run frozen on a
   * catalogue version this process no longer ships still fetches it, the admin's settings and the
   * org skills repo's syncs. Null/absent: only this process's catalogue, with the defaults, and
   * the skills routes refuse every write. */
  skills?: SkillStore | null;
  /** The org skills repo's forge read (ports/forge.ts `ForgeSkills`), the same adapter as
   * `forge` when there is one. Null/absent: every sync of the org skills repo fails as
   * `unavailable`, and runs keep whatever version was synced before. */
  forgeSkills?: ForgeSkills | null;
  /** Who a user is on the forge (ports/identity_directory.ts). Null: nobody has a linked
   * identity — repo gates refuse with "link first", inbound commands find no user. */
  identityDirectory?: IdentityDirectory | null;
  /** Memory, as startTask and conclusion touch it (ports/memory_access.ts). Null: no memory —
   * runs start without a brief and the platform server is never scoped. */
  memoryAccess?: MemoryAccess | null;
  /** The chat service, as the mention door, a response opening and a run concluding touch it
   * (ports/chat_access.ts). Null: no chat — responses open without a room, and a command room's
   * mention cannot be decided. */
  chatAccess?: ChatAccess | null;
  /** The platform's background model (ports/platform_model.ts), spent through the model proxy
   * on a platform credential: what names a task nobody titled (core/titles.ts). Null/absent: no
   * titles are generated — a task keeps the first line of its instructions. */
  platformModel?: PlatformModel | null;
  /** The shared service credential the chat service presents when it delivers a mention to the
   * door (RYPH_CHAT_TOKEN). Null/absent: the chat surface is dark — its route is not even
   * mounted. */
  chatToken?: string | null;
  /** Environment builds (core/environments.ts): the queue, the triggers, and what the
   * resolution asks to build. Null/absent: none here — every run launches on
   * `config.agentImage`, and the environment routes answer with `enabled: false`. */
  environments?: EnvironmentService | null;
  /** Build results for a run's patches (core/environment_feedback.ts): what the runner's
   * `environment_status` tool reads. Null/absent: environments are off or there is no forge. */
  environmentFeedback?: EnvironmentFeedback | null;
  /** Launches a run waiting on a build now, on what is ready (environments.ts). Null/absent:
   * environments are off, so no run ever waits. */
  startWithoutEnvironment?: ((runId: string, by: string) => Promise<boolean>) | null;
  /** Checks (core/checks.ts): suites, the agent's tools, the suite page, the forge reports.
   * Null/absent: none run here — the tools say so, and the suite routes answer 404. */
  checks?: ChecksService | null;
  /** Which check verdicts a run is still owed (`WiredChecks.awaiting`): what the runner holds a
   * stop on. Null/absent: none, it never waits. */
  checksAwaiting?: ((runId: string) => Promise<OwedVerdict[]>) | null;
  /** Reserved capacity (core/reserved_capacity.ts): what a page load reads the cluster through; a
   * save reaches the Lease holder on its next tick. Null/absent: the provisioner cannot reserve
   * capacity, and the routes say so — `supported: false`, and a save is a 409. */
  capacity?: CapacityReconciler | null;
  /** Where a run's images are kept (ports/attachment_store.ts): the object store patches live
   * in, under `attachments/`. Null/absent: this deployment takes no images — every upload and
   * every start that carries one is refused with a 503, never silently dropped. */
  attachmentStore?: AttachmentStore | null;
  /** A run's background commands' records (ports/background_store.ts) and where their logs go:
   * the build log store, under `runs/<runId>/background/`. Null/absent: none are recorded — the
   * runner's writes answer 503, the list is empty and every log a 404. */
  backgroundStore?: BackgroundStore | null;
  /** Where artifacts are kept (ports/artifact_store.ts). Null/absent: none are — a run's publish
   * and every artifact route answer 503, and a task lists none. */
  artifacts?: ArtifactStore | null;
  /** Makes a published document's served form, off the event loop (ports/artifact_html.ts).
   * The composition roots pass the process preparer (adapters/artifact_html/) and close it on
   * shutdown; tests pass an in-process one. Absent: a process preparer of the routes' own, never
   * closed. */
  artifactHtml?: ArtifactHtmlPreparer;
  /** Overrides RUNNER_BODY_DEADLINE_MS (http/runner_api.ts), how long a runner body may take
   * to arrive — tests shorten it. */
  runnerBodyDeadlineMs?: number;
  /** Optional isolated screenshot service. Missing/failed previews never block publication. */
  artifactThumbnail?: ArtifactThumbnailRenderer | null;
  backgroundLogs?: BuildLogStore | null;
  /** The images this deployment launches, fetched ahead of first use (ports/image_prefetch.ts).
   * Null/absent: nothing is fetched ahead, and `GET /v1/images` lists none. */
  imagePrefetch?: ImagePrefetch | null;
  /** A hosted deployment's previews service (ports/previews.ts; RYPH_PREVIEWS_URL and
   * RYPH_PREVIEWS_TOKEN). Null/absent: its routes are not even mounted, so the runner's probe is a
   * 404 — the local binary mounts its own loopback previews instead. */
  previews?: PreviewsService | null;
  /** Overrides the background log upload's body deadline (BACKGROUND_LOG_DEADLINE_MS) — tests
   * shorten it. */
  backgroundLogDeadlineMs?: number;
  /** The in-process wake-up behind the runner's inbox poll. Built by makeHandler when absent;
   * a composition root passes its own so the door and the routes share one. */
  inbox?: InboxSignal;
  /** Where the task list's live tails hear that a row moved. Absent: the stream route still
   * mounts and still answers with a snapshot, it simply never pushes — a deployment that wires
   * no feed degrades to "the list is right when you load it", not to a broken route. */
  taskFeed?: TaskFeed;
  now(): Date;
  config: AppConfig;
}

/** `AppDeps` with the signals present — what every handler is handed. */
export type WiredDeps = AppDeps & { inbox: InboxSignal; taskFeed: TaskFeed };

/**
 * `extraRoutes` mounts service-shaped packages into this server — how the @ryph/host
 * composition root joins @ryph/auth and @ryph/model-proxy's key CRUD to this router.
 */
export function makeHandler(
  deps: AppDeps,
  extraRoutes: Route[] = [],
): (req: Request) => Promise<Response> {
  const wired: WiredDeps = {
    ...deps,
    inbox: deps.inbox ?? makeInboxSignal(),
    taskFeed: deps.taskFeed ?? silentTaskFeed(),
  };
  return makeRouter([
    ...extraRoutes,
    ...userRoutes(wired),
    ...attachmentRoutes(wired),
    ...backgroundRoutes(wired),
    ...artifactRoutes(wired),
    ...commandRoomRoutes(wired),
    ...environmentRoutes(wired),
    ...checksRoutes(wired),
    ...skillsRoutes(wired),
    ...capacityRoutes(wired),
    ...runnerRoutes(wired),
    // Only with a key: without one nothing minted a claim, so nothing can present one and no
    // proxy is reporting. See http/egress_api.ts on why the claim IS the credential here.
    ...(wired.config.egress.key ? egressRoutes(wired, wired.config.egress.key) : []),
    ...(wired.forgeToken ? forgeRoutes(wired, wired.forgeToken) : []),
    ...(wired.historyToken ? historyVerifyRoutes(wired, wired.historyToken) : []),
    ...(wired.automationsToken ? automationsRoutes(wired, wired.automationsToken) : []),
    ...(wired.chatToken ? chatRoutes(wired, wired.chatToken) : []),
    ...(wired.previews ? previewsRoutes(wired, wired.previews) : []),
  ]);
}
