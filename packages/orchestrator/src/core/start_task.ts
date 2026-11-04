// Task creation, extracted from the HTTP handler so every door can start work the same way:
// the user surface (POST /v1/tasks), the forge intake (a /ryph command), the automations door
// and the chat door (a mention in a command room) all land here.
// Everything from "the agent and repo are resolved and the caller is allowed" onward — model
// resolution, id/token/branch minting, the gateway's virtual key, the frozen snapshots,
// persistence, launch. What stays with each door: authentication, agent/repo resolution, and
// the live permission gate, because WHO may ask differs per door while WHAT starting means
// must not.
//
// The invariants are the ones the handler always kept (see http/user_api.ts): ids and tokens
// are minted here and never accepted; the work item is composed exactly once and frozen onto
// the run; the rows are persisted before the container launches, and a failed launch is
// recorded as an errored run, never a silent drop.

import type {
  Agent,
  ChatContext,
  ConnectedRepo,
  Environment,
  ForgeScopeThread,
  GitVirtualKey,
  InjectedContext,
  MemoryBrief,
  OriginConversation,
  RepoEntry,
  Run,
  RunEnvironment,
  RunEvent,
  RunForgeScope,
  RunLifetime,
  RunLimits,
  RunServices,
  RunToolScope,
  Task,
  TaskPurpose,
  TaskSpec,
  ThinkingLevel,
  Workspace,
} from "./types.ts";
import { DEFAULT_ATTENDED_IDLE_MS, DEFAULT_IDLE_MS, DEFAULT_SKILL_SETTINGS } from "./types.ts";
import { composeWorkItem } from "./lifecycle.ts";
import {
  checkRunStartImages,
  discardAttachmentBlobs,
  planRunAttachments,
  type RunStartImage,
  storeRunAttachmentBlobs,
} from "./attachments.ts";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import { type BrowserConfig, browserGrant, browserWithheld } from "./browser.ts";
import { forgeRepoRef } from "./forge_repo.ts";
import { MAX_REPOS } from "./workspaces.ts";
import {
  forRuns,
  resolveServices,
  type ServiceDeclaration,
  type ServicePolicy,
  servicesRef,
  unionDeclarations,
} from "./services.ts";
import { type EgressPolicy, liveCeiling, mintEgressToken, resolveNetworkScope } from "./egress.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";
import { sealBootstrap } from "./bootstrap.ts";
import { FORGE_CHECK_CONCURRENCY, mapWithConcurrency } from "../helpers/concurrency.ts";
import { branchNameFor } from "../helpers/ids.ts";
import type { PlatformToolServers } from "../helpers/platform_server.ts";
import { isBranchRef, normalizeBaseRef } from "@ryph/shared/refs";
import { worksForkHead } from "./repo_entries.ts";
import { parseServicesYaml } from "../helpers/services.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { Provisioner } from "../ports/provisioner.ts";
import { ImageGone } from "../ports/image_gone.ts";
import type { Forge } from "../ports/forge.ts";
import type { IdentityDirectory } from "../ports/identity_directory.ts";
import type { ServiceCatalogue } from "../ports/service_catalogue.ts";
import type { SkillCatalogue } from "../ports/skill_catalogue.ts";
import type { SkillStore } from "../ports/skill_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { ComposedBrief, MemoryAccess } from "../ports/memory_access.ts";
import type { ChatAccess } from "../ports/chat_access.ts";
import type { PlatformModel } from "../ports/platform_model.ts";
import { fallbackTitle, startTitling } from "./titles.ts";
import { supportsSkills, supportsTools } from "./harness_tools.ts";
import { describeDrops, describeStale, resolveRunSkills } from "./skills.ts";
import { ENVIRONMENT_SETUP, SETUP_SKILL } from "./environment_setup.ts";
import { ARTIFACT_SKILL } from "./artifacts.ts";
import { composeForgeScope, forgeAllowedTools, forgePolicyRepoIds } from "./forge_tools.ts";
import { runUrlOf } from "./conclude_run.ts";
import { resolveRunSize, type RunSize, type RunSizes } from "./run_sizes.ts";
import {
  deadlineSecondsFor,
  type DeploymentLimits,
  resolveRunLimits,
  type SpendGate,
  spendIncluded,
} from "./run_limits.ts";
import {
  defaultRunEnvironment,
  type EnvironmentResolution,
  resolveEnvironment,
  runEnvironmentOf,
} from "./environment_resolve.ts";
import { byNewestBuilt, type EnvironmentService, sameImage } from "./environments.ts";

/** The slice of the app config that starting a task consumes — structurally a subset of
 * http/app.ts's AppConfig, restated here because the core cannot import the HTTP layer. */
export interface StartTaskConfig {
  publicUrl: string;
  /** The deployment's browser sidecar (RYPH_BROWSER_IMAGE and its resources); null: none, and
   * no run gets a browser. See core/browser.ts. */
  browser: BrowserConfig | null;
  /** The default agent image (RYPH_AGENT_IMAGE) every run launches on. Null: none configured,
   * which only the manual provisioner accepts. */
  agentImage: string | null;
  /** The deployment's size classes (RYPH_RUN_SIZES); a run's is resolved here, once. */
  runSizes: RunSizes;
  gitGateway: { url: string; keyTtlMs: number } | null;
  /** The historian as a run dials it (AppConfig.runHistoryUrl). */
  runHistoryUrl: string | null;
  /** The operator's service-container switches. Disabled is the default and the common case. */
  services: ServicePolicy;
  /** The operator's egress ceiling, the key a run's proxy claim is signed with, and how long
   * that claim lives. See http/app.ts. */
  egress: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
  /** The platform memory server's row id, when this deployment can serve it (see AppConfig). */
  platformMemoryServerId: string | null;
  /** The platform chat server's row id, when this deployment can serve it (see AppConfig). */
  platformChatServerId: string | null;
  /**
   * The platform tool servers whose availability this process learns from the gateway AFTER it
   * is listening — the forge's and the web's. A holder rather than two values, and read at every
   * task start rather than closed over, because it is filled in behind the listener (see
   * helpers/platform_server.ts). While `pending`, a run gets neither, and that is said out loud.
   */
  platformTools: PlatformToolServers;
  /** The web app's origin as a browser reaches it — the run link a forge write is signed with. */
  appUrl: string | null;
  /** The operator's run limits: the ceiling and the deployment-wide caps (core/run_limits.ts). */
  limits: DeploymentLimits;
}

/**
 * Every port is required, null where the deployment has none: an absent port reads as "off"
 * here, so a start path that forgot one would silently start runs without it (a chat start once
 * launched on the plain agent image because it never passed `environments`). The doors build
 * this with `startTaskDeps` (http/start_deps.ts).
 */
export interface StartTaskDeps {
  store: TaskStore;
  provisioner: Provisioner;
  diag: Diagnostics;
  /** Reads the connected repo's service declaration. Null: no forge, so no declaration. */
  forge: Forge | null;
  /** What this deployment knows how to run safely. Null: the composition root built none, so
   * only the operator's image allowlist can satisfy a declaration. */
  serviceCatalogue: ServiceCatalogue | null;
  /** The skills ryph ships (ports/skill_catalogue.ts). Null: runs are frozen with none. */
  skillCatalogue: SkillCatalogue | null;
  /** The admin's skill settings and the org skills repo's current version
   * (ports/skill_store.ts). Null: runs are frozen against the defaults, with no org
   * skills. */
  skills: SkillStore | null;
  /** Composes the brief. Null: no memory in this deployment — runs start without one. */
  memoryAccess: MemoryAccess | null;
  /** Resolves the requester's forge login for the provenance block. Null: nobody is named. */
  identityDirectory: IdentityDirectory | null;
  /** Environment builds (core/environments.ts). Null, or off: every run launches on
   * `config.agentImage`, exactly as before environments existed. */
  environments: EnvironmentService | null;
  /** Answers whether the deployment's spend ceiling is reached. Null: no model access,
   * so no ceiling to ask about. */
  modelAccess: SpendGate | null;
  /** Where the images a task starts with are kept (core/attachments.ts). Null: a start that
   * carries images is refused with a 503. */
  attachmentStore: AttachmentStore | null;
  /** Describes a chat-bound run's room to its agent. Null: no chat service in this
   * deployment — a bound run then starts without the room's facts, as it would if the service
   * had not answered. */
  chatAccess: Pick<ChatAccess, "describeRoom"> | null;
  /** The background model a task with no title is named by (core/titles.ts). Null: none, and
   * such a task keeps the first line of its instructions. */
  platformModel: PlatformModel | null;
  now(): Date;
  config: StartTaskConfig;
}

/**
 * One repo the task checks out, as a door resolved it: the connected repo row
 * (the caller has already run the live permission gate on it — this function never re-asks),
 * the ref to start from, and how the agent will address it.
 */
export interface StartTaskRepo {
  /** The connected repo the entry checks out: a task checks out nothing else. */
  connectedRepo: ConnectedRepo;
  /** The upstream URL as the user named it: the connected repo's own. */
  url: string;
  ref: string;
  /** The branch the work on `ref` merges into, when that is not `ref` itself (a change
   * request's base); see `RepoEntry.targetRef`. */
  targetRef?: string;
  /** `ref` is a fork pull request's head; see `RepoEntry.forkHead`. */
  forkHead?: boolean;
  /** The directory under the checkout root; unique within the task. */
  path: string;
  /** What the agent is told the repo is called. */
  name: string;
  description: string | null;
}

export interface StartTaskArgs {
  /** Resolved and un-archived — the caller's lookup, refused before this is built. */
  agent: Agent;
  /**
   * What the task asks. A null title is made from the instructions — their first line at once,
   * then the background model's (core/titles.ts). Null instructions start the task awaiting its
   * prompt: the run boots and waits, and the first message to it becomes them (core/prompt.ts);
   * the title must then be null too, and the task carries no images.
   */
  spec: TaskSpec;
  /** What the task checks out, in order. Never empty; paths unique. */
  repos: StartTaskRepo[];
  /** The workspace the list came from — for display on the task, for the agent's layout
   * block, which names it and carries its description, and for its size class. Absent
   * otherwise. */
  workspace?: Pick<Workspace, "id" | "name" | "description" | "sizeClass" | "environmentRepoId">;
  /** The task's model pick; undefined = the agent policy's default. */
  model?: string;
  /** The task's thinking level; undefined = the agent policy's default. */
  thinking?: ThinkingLevel;
  origin: Task["origin"];
  requestedByUserId: string | null;
  /** A chat task's commander (already sanitized); absent for every other origin. */
  requestedVia?: { name: string };
  /** A chat task's conversation key (`Task.chatConversation`); absent for every other origin and
   * on Telegram. */
  chatConversation?: string;
  /** The pull request the task works on, when it does — that repo's entry must then name its
   * head branch. Absent: every patch opens a pull request of its own. */
  targetChangeRequest?: { connectedRepoId: string; thread: string };
  /** How long the run lives past the agent's settles. Absent: the default idle clocks. */
  lifetime?: RunLifetime;
  /** Nobody follows the run while it works (an automation fire with no response to join): its
   * agent finishes once its work is submitted instead of waiting for review. Absent: someone may. */
  unattended?: boolean;
  /** The task's own limits, already gated by the door for raising; absent fields fall through
   * to the agent's policy and then the ceiling. */
  limits?: Partial<RunLimits>;
  /** Set only by a door that authors the task itself (the environment setup route). */
  purpose?: TaskPurpose;
  /** The chatroom the run will be bound to (a response's, or a command room's): the platform's
   * chat server joins the run's tool scope, so the agent can post there. Absent: no chat tool. */
  chatroomId?: string;
  /** The conversation the task was commanded from — a forge thread (the thread an "origin"
   * forge policy lets the run write to) or a chat thread. Absent: the target pull request, if
   * any, is the origin. */
  originConversation?: OriginConversation;
  /**
   * The images the task arrives with — a forge thread's screenshots, a chat mention's photo —
   * as the bytes the door fetched, in order. The door writes `imageMarker(n)`
   * (core/attachments.ts) into the spec where the Nth one sat; the runner hands them to the agent
   * with the task, saved as files it can open again. Every one must be an allowed image under
   * the cap, or the start is refused whole. Absent: none.
   */
  images?: readonly RunStartImage[];
}

export type StartTaskOutcome =
  | {
    kind: "refused";
    status: number;
    error: string;
    extra?: Record<string, unknown>;
    /**
     * Which repo of the checkout this refusal is ABOUT, when it is about one, plus a summary
     * that names no repo, no ref, no path and no file.
     *
     * `error` is free text and routinely interpolates the repo's full name, its base ref and
     * its checkout directory. A `/ryph` refusal is posted into the commanded repo's thread,
     * which may be public while a sibling is private — so the forge door relays the summary
     * instead of the text whenever this names a repo other than the commanded one. Structured
     * rather than scrubbed: a redactor over free text is a guess, and this is not.
     */
    about?: { connectedRepoId: string; summary: string };
  }
  | { kind: "started"; taskId: string; runId: string; state: Run["state"] };

/**
 * The conversation a run works in: the thread a command came from — on the forge or in a chat —
 * else the pull request the task targets.
 *
 * One notion, several doors. A run whose commits land on #42 is working that thread whether a
 * comment or the app started it — so every reader derives it HERE: the run's forge scope (where
 * an "origin" policy lets the agent write) and the columns the intakes ask "is an agent already
 * working this thread". Two copies of this rule would let a task started from the app hold a
 * thread for one purpose and not the other, which is exactly the gap that lets two runs push
 * onto one branch.
 */
export function originConversationFor(
  args: Pick<StartTaskArgs, "originConversation" | "targetChangeRequest">,
): OriginConversation | null {
  return args.originConversation ?? (args.targetChangeRequest === undefined ? null : {
    kind: "forge",
    connectedRepoId: args.targetChangeRequest.connectedRepoId,
    threadKind: "change_request",
    ref: args.targetChangeRequest.thread,
  });
}

/** The forge thread of an origin conversation — what the forge scope's `origin` is. A chat
 * thread is no forge thread: a chat-started run has no origin on the forge. */
export function forgeOriginOf(origin: OriginConversation | null): ForgeScopeThread | null {
  return origin?.kind === "forge"
    ? { connectedRepoId: origin.connectedRepoId, kind: origin.threadKind, ref: origin.ref }
    : null;
}

/** A run's origin conversation, read back off its denormalized columns. */
export function originConversationOf(
  run: Pick<
    Run,
    | "originThreadRepoId"
    | "originThreadKind"
    | "originThreadRef"
    | "originChatroomId"
    | "originThreadKey"
  >,
): OriginConversation | null {
  if (
    run.originThreadRepoId !== null && run.originThreadKind !== null &&
    run.originThreadRef !== null
  ) {
    return {
      kind: "forge",
      connectedRepoId: run.originThreadRepoId,
      threadKind: run.originThreadKind,
      ref: run.originThreadRef,
    };
  }
  if (run.originChatroomId !== null && run.originThreadKey !== null) {
    return { kind: "chat", chatroomId: run.originChatroomId, threadKey: run.originThreadKey };
  }
  return null;
}

/** The refusal for a deployment at `RYPH_RUN_CONCURRENCY`, the same at the door and at the insert. */
function deploymentFull(max: number): StartTaskOutcome {
  return {
    kind: "refused",
    status: 429,
    error: `this deployment already has ${max} runs live (RYPH_RUN_CONCURRENCY) — try again ` +
      "when one finishes",
    extra: { code: "limit_reached", limit: "concurrent-runs", max },
  };
}

export async function startTask(
  deps: StartTaskDeps,
  asked: StartTaskArgs,
): Promise<StartTaskOutcome> {
  // Whether an entry is a pull request's head is decided HERE, for every door, from the ref
  // itself: anything but a branch of the repository (`refs/pull/<n>/head`, or its local
  // spelling) is somebody else's code, whichever door let it in and whether or not that door
  // said so. The doors refuse such refs from people; this is what holds if one ever does not.
  const args: StartTaskArgs = {
    ...asked,
    repos: asked.repos.map((r) =>
      r.forkHead === true || isBranchRef(r.ref) ? r : { ...r, forkHead: true }
    ),
  };
  const { store, diag, config } = deps;
  const { agent } = args;
  const nowIso = () => deps.now().toISOString();

  // The run's model: the task's pick, else the policy default, both bounded by the agent's
  // allowlist. Checked HERE so a bad pick dies at creation — and enforced again server-side
  // by the proxy, where the allowlist is policy rather than a harness flag.
  const policy = agent.modelPolicy;
  if (args.model !== undefined && policy === null) {
    return {
      kind: "refused",
      status: 400,
      error: "agent has no model policy; a task cannot pick a model",
    };
  }
  if (
    args.model !== undefined && policy !== null && policy.allowedModels !== "*" &&
    !policy.allowedModels.includes(args.model)
  ) {
    // An access-control decision, not a malformed request — surface it for the operator/audit
    // trail (the user already sees the rejection in the refusal below).
    diag.warn("task.model_denied", {
      agentId: agent.id,
      requestedModel: args.model,
      allowedModels: policy.allowedModels,
    });
    return {
      kind: "refused",
      status: 400,
      error: `model "${args.model}" is not in the agent's allowlist`,
      extra: { allowedModels: policy.allowedModels },
    };
  }
  const model = args.model ?? policy?.defaultModel ?? null;
  // The thinking level by the same rule, and refused by the same one: without a policy the
  // harness drives its own default model, which nobody here chose a level for. Not checked
  // against what the model takes — nothing here can know that for every provider, and pi
  // clamps a level the model does not take to the nearest one it does.
  if (args.thinking !== undefined && policy === null) {
    return {
      kind: "refused",
      status: 400,
      error: "agent has no model policy; a task cannot pick a thinking level",
    };
  }
  const thinking = args.thinking ?? policy?.defaultThinking ?? null;

  // A task without instructions awaits its prompt, and has neither a title nor images until it
  // arrives: the title is made from the prompt, and the images ride it.
  const awaiting = args.spec.instructions === null;
  if (awaiting && args.spec.title !== null) {
    return { kind: "refused", status: 400, error: "a title goes with instructions" };
  }
  if (awaiting && (args.images ?? []).length > 0) {
    return { kind: "refused", status: 400, error: "images go with instructions" };
  }

  // The images, checked before anything is queued or written: a start with an image it cannot
  // take is refused whole, never started without it — the spec's `[image N]` markers count them.
  const images = args.images ?? [];
  const imagesChecked = checkRunStartImages(deps, images);
  if (imagesChecked.kind === "refused") return imagesChecked;

  // The deployment's spend ceiling is the last line, asked at the door so a run is not started
  // only to have its first model call refused. Asked for a run that will hold a model
  // credential: one without cannot spend through the proxy, and the ceiling has nothing to
  // say to it, and neither to one on a plan whose usage is included: it adds nothing to the
  // spend the ceiling counts, and the proxy lets its calls through past it. A proxy that cannot
  // answer does not refuse the task: the proxy still refuses the calls, and a door closed by a
  // blink helps nobody.
  if (deps.modelAccess && policy !== null && !spendIncluded(policy.provider)) {
    let reached = false;
    try {
      reached = await deps.modelAccess.ceilingReached();
    } catch (err) {
      diag.warn("task.ceiling_unreadable", { err: String(err) });
    }
    if (reached) {
      return {
        kind: "refused",
        status: 403,
        error: "this deployment has reached its model spend ceiling " +
          "(RYPH_MODEL_SPEND_CEILING_USD); no task can start until the window moves on",
        extra: { code: "limit_reached", limit: "deployment-spend" },
      };
    }
  }

  // The list, checked once more at the one place every door meets: not empty, and every path
  // its own. The doors compose the paths (a workspace's are unique by construction, a single
  // repo's is one), so a duplicate here is a bug worth a loud refusal rather than a run that
  // clones two repos into one directory.
  if (args.repos.length === 0) {
    return { kind: "refused", status: 400, error: "a task checks out at least one repo" };
  }
  if (new Set(args.repos.map((r) => r.path)).size !== args.repos.length) {
    return { kind: "refused", status: 400, error: "every repo in a task needs its own path" };
  }
  if (args.repos.length > MAX_REPOS) {
    return {
      kind: "refused",
      status: 400,
      error: `a task checks out at most ${MAX_REPOS} repos (${args.repos.length} asked)`,
    };
  }
  // A fork's head is checked out alone: its code runs with the run's git grant, and a sibling
  // beside it would be a repository that code could read and a patch it could ship.
  if (worksForkHead(args.repos) && args.repos.length > 1) {
    return {
      kind: "refused",
      status: 400,
      error: "a pull request's head from a fork is checked out on its own, never beside " +
        "other repos",
    };
  }
  if (
    args.targetChangeRequest !== undefined &&
    !args.repos.some((r) => r.connectedRepo.id === args.targetChangeRequest?.connectedRepoId)
  ) {
    return {
      kind: "refused",
      status: 400,
      error: "the pull request the task works on must belong to a repo it checks out",
    };
  }

  // The skills, frozen here like every other snapshot: the admin's settings and the org repo's
  // current version are read live, never cached in the process, so a sync or a toggle is in
  // effect for the next run on every replica. A setup run is pinned to its skill over the
  // agent's own switch; an admin's still wins, and then the task is refused: its instruction
  // leaves every `.ryph/` rule to that skill (core/environment_setup.ts), so a run without it
  // would only guess.
  const skillsOn = supportsSkills(agent.harnessKind);
  const [skillSettings, orgVersion] = skillsOn && deps.skills
    ? await Promise.all([deps.skills.settings(), deps.skills.currentOrg()])
    : [DEFAULT_SKILL_SETTINGS, null];
  const resolvedSkills = resolveRunSkills({
    supportsSkills: skillsOn,
    // The artifact skill is about a tool only an agent that may publish holds: any other run is
    // not given it, so nothing invites it to look for that tool.
    catalogue: (deps.skillCatalogue?.list() ?? [])
      .filter((s) => agent.canPublishArtifacts || s.name !== ARTIFACT_SKILL),
    settings: skillSettings,
    org: orgVersion,
    policy: agent.skillPolicy,
    // And an agent that may publish artifacts is pinned to the skill that says how to make one
    // that renders under the content route's sandbox (core/artifacts.ts).
    pinned: [
      ...(args.purpose === ENVIRONMENT_SETUP ? [SETUP_SKILL] : []),
      ...(agent.canPublishArtifacts ? [ARTIFACT_SKILL] : []),
    ],
  });
  if (
    args.purpose === ENVIRONMENT_SETUP &&
    !(resolvedSkills.skills?.skills ?? []).some((s) => s.name === SETUP_SKILL)
  ) {
    const why = !skillsOn
      ? `${agent.name}'s harness (${agent.harnessKind}) cannot load skills: pick an agent on a ` +
        "harness that can"
      : (deps.skillCatalogue?.list() ?? []).some((s) => s.name === SETUP_SKILL)
      ? "an admin turned it off"
      : "this deployment does not ship it";
    return {
      kind: "refused",
      status: 409,
      error: `setting up an environment needs the ${SETUP_SKILL} skill, and ${why}`,
    };
  }

  const at = nowIso();
  const runId = mintId("r");
  // One branch namespace for the whole run: the same string in every repo, so "the run's
  // branches" means one thing across every repo it touched — each line of work it ships in a repo
  // is `<namespace>/<line>` (@ryph/shared/lines). Per entry on the type, one value today.
  // Named by the handle — the address people already use for the agent — and by its name only
  // for an agent born before handles existed.
  const branchNamespace = branchNameFor(agent.handle ?? agent.name, runId);
  // A task with instructions and no title is titled with their first line now, and the model's
  // title replaces it once the task is on record (below).
  const untitled = args.spec.instructions !== null && args.spec.title === null;
  const task: Task = {
    id: mintId("t"),
    agentId: agent.id,
    spec: {
      title: args.spec.title ??
        (args.spec.instructions === null ? null : fallbackTitle(args.spec.instructions)),
      instructions: args.spec.instructions,
    },
    repos: args.repos.map((r) => ({
      connectedRepoId: r.connectedRepo.id,
      name: r.name,
      url: r.url,
      ref: r.ref,
      ...(r.targetRef === undefined ? {} : { targetRef: r.targetRef }),
      ...(r.forkHead === true ? { forkHead: true } : {}),
      path: r.path,
      branchNamespace,
      description: r.description,
    })),
    workspaceId: args.workspace?.id ?? null,
    origin: args.origin,
    requestedByUserId: args.requestedByUserId,
    requestedVia: args.requestedVia ?? null,
    chatConversation: args.chatConversation ?? null,
    targetChangeRequest: args.targetChangeRequest ?? null,
    landings: {},
    lifetime: args.lifetime ??
      { idleMs: DEFAULT_IDLE_MS, attendedIdleMs: DEFAULT_ATTENDED_IDLE_MS },
    purpose: args.purpose ?? null,
    createdAt: at,
  };

  // The forge gateway interposes on the run's entire git story: the WorkItem's entry becomes the
  // gateway's per-run MEMBER URL and the NORMALIZED base branch (the cache serves every base as a
  // local branch, by the same `normalizeBaseRef` this side computes it with), the clone
  // credential becomes ONE run-scoped virtual key the gateway resolves back here to the run's
  // whole set, and the task row keeps the user-named repos as user-facing truth. Two facts, two
  // columns.
  //
  // It is the only way a run reaches a repository. A run is never handed a credential for a git
  // host (the agent can read the runner's environment), so with no gateway there is nothing a run
  // could clone, and the task is refused before anything is persisted.
  const gateway = config.gitGateway;
  if (gateway === null) {
    return {
      kind: "refused",
      status: 503,
      error: "runs reach repositories only through the git gateway, which is not configured " +
        "(RYPH_GIT_GATEWAY_URL is unset)",
    };
  }
  const reposForRun: RepoEntry[] = [];
  for (const [index, entry] of task.repos.entries()) {
    const source = args.repos[index];
    let localBranch: string;
    try {
      localBranch = normalizeBaseRef(entry.ref).localBranch;
    } catch (err) {
      // e.g. a refs/tags/* base: refused at creation, the first boundary it crosses.
      return {
        kind: "refused",
        status: 400,
        error: `${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
        about: {
          connectedRepoId: source.connectedRepo.id,
          summary: "is checked out at a ref that does not name a branch",
        },
      };
    }
    let forRun: RepoEntry = {
      ...entry,
      url: `${gateway.url}/v1/git/${runId}/${source.connectedRepo.id}/repo.git`,
      ref: localBranch,
      provider: source.connectedRepo.provider,
    };
    // The target as a branch name, however the run fetches it: the runner names it as
    // `origin/<target>`, which a qualified `refs/heads/…` would never match. The door proved it
    // normalizes (`mergeTargetOf`), so this cannot throw for a target that reached here.
    if (entry.targetRef !== undefined) {
      forRun = { ...forRun, targetRef: normalizeBaseRef(entry.targetRef).localBranch };
    }
    reposForRun.push(forRun);
  }
  const gitToken = mintToken();
  const gitKey: GitVirtualKey = {
    id: mintId("gk"),
    runId,
    tokenHash: await sha256Hex(gitToken),
    expiresAt: new Date(deps.now().getTime() + gateway.keyTtlMs).toISOString(),
    revokedAt: null,
    createdAt: at,
  };

  // The service containers, resolved BEFORE anything is persisted so a refusal costs no rows.
  //
  // Read only when the feature is on: with it off, the declaration is not fetched at all,
  // because doing so would put a forge round trip on every task creation in every deployment
  // that will never use this. That makes a declaration inert rather than refused here — and the
  // runner closes the gap from the other side, failing loudly when its checkout declares
  // services its spec did not bring (see @ryph/runner's core/run.ts).
  //
  // Every connected repo's file, as one union: hostnames are shared across the run.
  let runServices: RunServices | null = null;
  if (config.services.enabled) {
    const resolved = await resolveRunServices(
      deps,
      task.repos.map((entry, i) => ({ repo: args.repos[i].connectedRepo, entry })),
    );
    if (resolved.kind === "refused") return resolved;
    runServices = resolved.services;
  }

  // Where this run may reach on the internet, resolved against the deployment's ceiling and
  // refused here if the agent's policy no longer fits inside it.
  //
  // CHECKED AT EVERY LAUNCH, not only when the policy is saved: an admin who tightens the
  // deployment's allowlist must bind the agents saved while it was wider, and the alternative
  // is a run quietly reaching more than the deployment now allows. Refused rather than narrowed
  // to the intersection, because silently dropping a bundle is how a `setup.yml` starts failing
  // with nothing to point at.
  //
  // READ HERE rather than off the boot config, which is what makes an allowlist edit take
  // effect on the next run instead of the next restart.
  const ceiling = await liveCeiling(store, config.egress.policy);
  const network = resolveNetworkScope(agent.networkPolicy, ceiling);
  if (network.kind === "refused") {
    return { kind: "refused", status: 400, error: network.error };
  }

  // The live-run cap, read once the request is known to be well-formed and before anything is
  // queued or written on the run's behalf. The count that decides is the one `createTask` takes
  // under its lock; this read only spares a deployment already full an environment build and a
  // memory scope row for a run refused at the last step.
  if (config.limits.concurrency !== null) {
    const live = await store.countActiveRuns();
    if (live >= config.limits.concurrency) return deploymentFull(config.limits.concurrency);
  }

  // The machine: an environment's digest, the default image, or — when the environment it needs
  // is still being built — nothing yet, and the run waits in `starting` without a container.
  // Resolved BEFORE anything is persisted, like the services, so a refusal (a build that failed
  // at exactly these inputs) costs no rows.
  const resolvedEnvironment = await resolveEnvironment(deps, {
    agentImage: config.agentImage,
    ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    repos: args.repos,
  });
  if (resolvedEnvironment.kind === "refused") return resolvedEnvironment;
  const waitOn = resolvedEnvironment.kind === "wait" ? resolvedEnvironment.environment : null;

  // The images, as the run will name them: ids, keys and hashes, nothing stored yet. The refs
  // freeze onto the work item; the rows ride the run's own insert; the blobs are stored last,
  // just before it (below).
  const plannedImages = await planRunAttachments(runId, imagesChecked.images, at);

  // The room a bound run's agent is told it is in, frozen with the rest: which platform, the
  // group's or organization's name, and what people type to reach the bot — without which "the
  // response's chat" is a phrase the agent cannot connect to anything. Never a refusal: a room the
  // service cannot describe is a run told less, not a run that does not start.
  let chat: ChatContext | null = null;
  if (args.chatroomId !== undefined) {
    chat = tidyChat(await deps.chatAccess?.describeRoom(args.chatroomId) ?? null);
    if (chat === null) {
      diag.debug("task.chat_context_missing", {
        runId,
        chatroomId: args.chatroomId,
        reason: deps.chatAccess ? "the chat service could not describe the room" : "no chat access",
      });
    }
  }

  // The size class: a workspace run takes the workspace's, a run of one connected repo takes
  // that repo's, and anything else — a class nobody chose — the deployment default.
  // A class the configuration stopped defining degrades to the default and says so on the run,
  // rather than refusing: renaming a class must not lock out every repo that picked it.
  const { size, stale: staleSize } = resolveRunSize(
    config.runSizes,
    sizeChoiceOf(args.workspace ?? null, args.repos.map((r) => r.connectedRepo)),
  );

  // The browser, decided here with the rest of the snapshot: granted only where the agent asked
  // and the deployment can launch one — into this run's pod, which only the provisioner can say
  // (a cluster without native sidecars, a size class with no disk left for it). Never a refusal —
  // see core/browser.ts.
  let browser = browserGrant(agent, config.browser, deps.provisioner);
  if (browser.kind === "granted" && deps.provisioner.browserRefusal !== undefined) {
    const why = await deps.provisioner.browserRefusal(size, runServices?.services.length ?? 0);
    if (why !== null) browser = browserWithheld(why);
  }

  // The snapshots: what this run is asked to do, decided exactly once, right here.
  const workItem = composeWorkItem(
    task,
    agent,
    runId,
    reposForRun,
    { model, thinking },
    args.workspace === undefined
      ? null
      : { name: args.workspace.name, description: args.workspace.description },
    chat,
    plannedImages.refs,
    browser.kind === "granted" ? browser.browser : null,
  );
  workItem.runSize = size;
  if (args.unattended === true) workItem.unattended = true;

  // The brief: what memory has to say about these repos and the org, under the agent's budget,
  // frozen here so the spec serves what the run was told and never a recomposition. Best-effort
  // by contract — a brief that could not be composed is a memoryless run, never a failed one.
  // Keyed on the USER-NAMED repos, never the clone URLs: the gateway's per-run addresses name
  // no repository anyone would recognise next time.
  //
  // Whether the CALL landed is tracked apart from what it returned, because composing the brief
  // is also what opens the run on the memory side: memory writes the run's scope row there, and
  // only then can the memory tools answer anything. A null brief (memory on, nothing to say)
  // still wrote it; a throw wrote nothing, and scoping the tools in anyway would boot a run
  // whose every memory__* call fails for its whole life. See composeToolScope.
  let brief: InjectedContext["brief"];
  let briefComposed = false;
  // Not for a run on a fork's head: memory is the agent's across every repo and run, so a brief
  // would hand the contributor's code what other runs learned, and the tools would let it write
  // what later runs are told. No brief composed is no memory tools either (composeToolScope).
  if (agent.memoryPolicy !== null && deps.memoryAccess && !worksForkHead(task.repos)) {
    try {
      const composed = await deps.memoryAccess.composeBrief({
        runId,
        taskId: task.id,
        agentId: agent.id,
        repos: task.repos.map((r) => r.url),
        // A task awaiting its prompt is briefed on its repos alone: there are no words yet.
        task: { title: task.spec.title ?? "", instructions: task.spec.instructions ?? "" },
        budgetTokens: agent.memoryPolicy.budgetTokens,
        ...(agent.memoryPolicy.agentOnly ? { agentOnly: true } : {}),
      });
      if (composed !== null) brief = freezeBrief(composed, task.repos);
      briefComposed = true;
      diag.debug("task.brief_composed", {
        runId,
        memories: composed?.memoryIds.length ?? 0,
        budgetTokens: agent.memoryPolicy.budgetTokens,
      });
    } catch (err) {
      diag.warn("task.brief_failed", { runId, err: String(err) });
    }
  }
  const injectedContext: InjectedContext | null = agent.systemPrompt === null && brief === undefined
    ? null
    : {
      ...(agent.systemPrompt === null ? {} : { systemPrompt: agent.systemPrompt }),
      ...(brief === undefined ? {} : { brief }),
    };
  // The model scope freezes WITH the other snapshots: editing the agent's policy mid-run
  // never changes what this run may call. Credentials are minted from it at boot, not here.
  const modelScope = policy === null ? null : {
    providerKeyId: policy.providerKeyId,
    provider: policy.provider,
    allowedModels: policy.allowedModels,
    model,
    thinking,
  };
  // The forge scope freezes with them: the agent's forge policy resolved against this run.
  const forgeScope = await resolveForgeScope(deps, args, task);
  // The tool scope freezes the same way, and for the same reason. A copy, not the policy
  // object itself: the agent row stays editable and this snapshot must not follow it.
  const toolScope = composeToolScope(
    agent,
    config.platformMemoryServerId,
    briefComposed,
    args.chatroomId === undefined ? null : config.platformChatServerId,
    forgeScope === null || config.platformTools.forge === null ? null : {
      serverId: config.platformTools.forge,
      allowedTools: forgeAllowedTools(forgeScope.capabilities),
    },
    { serverId: config.platformTools.webServerId, served: config.platformTools.web },
    worksForkHead(task.repos),
  );
  // A run that starts in the window between the listener opening and the gateway answering gets
  // no web or forge tools. Said here, once per run, because the alternative — noticing later that
  // an agent had no web tools for the first minute after a rollout — is a puzzle rather than a
  // fact.
  if (config.platformTools.pending) {
    deps.diag.debug("run.platform_tools_pending", {
      runId,
      reason: "the gateway has not answered which platform tool servers it holds yet",
    });
  }
  const runnerToken = mintToken();
  const origin = originConversationFor(args);
  const run: Run = {
    id: runId,
    taskId: task.id,
    agentId: agent.id,
    state: "starting",
    phase: null,
    heartbeatSeq: -1,
    lastHeartbeatAt: null,
    desiredState: null,
    cancelRequestedAt: null,
    attended: false,
    idleDeadlineAt: null,
    // The conversation this run works in — commanded from it, or targeted as a pull request.
    // What a later command there finds, to reach this run instead of starting a second beside it.
    originThreadRepoId: origin?.kind === "forge" ? origin.connectedRepoId : null,
    originThreadKind: origin?.kind === "forge" ? origin.threadKind : null,
    originThreadRef: origin?.kind === "forge" ? origin.ref : null,
    originChatroomId: origin?.kind === "chat" ? origin.chatroomId : null,
    originThreadKey: origin?.kind === "chat" ? origin.threadKey : null,
    tokenHash: await sha256Hex(runnerToken),
    controlToken: mintToken(),
    handle: null,
    launchedAt: null,
    branchNamespace,
    ...runFieldsOf(resolvedEnvironment),
    workItem,
    injectedContext,
    modelScope,
    toolScope,
    forgeScope,
    services: runServices,
    skills: resolvedSkills.skills,
    networkScope: network.scope,
    limits: resolveRunLimits(config.limits.ceiling, agent.limitPolicy, args.limits),
    egressRefusals: null,
    result: null,
    memoryOutcomeReportedAt: null,
    skillsReportedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  // A waiting run holds no git credential yet: it is minted with the rest of the launch, when
  // the build lands — a key for a container that may never exist would only be one more thing
  // to leak.
  const maxLive = config.limits.concurrency;
  // The images' bytes go to the store here, the last step before the insert: everything that
  // could refuse the start without writing has had its say, so the only refusal left is the
  // insert's own (a deployment at its live-run cap — ordinary at capacity, and a chat or forge
  // retry would re-upload every image each time). That one, or an insert that throws, has the
  // blobs deleted again; the rows go in WITH the run, in its transaction, so no run is ever on
  // record naming an image it has no row for.
  await storeRunAttachmentBlobs(deps, plannedImages);
  let created: "created" | "full";
  try {
    created = await store.createTask(task, run, waitOn === null ? gitKey : undefined, {
      maxLive,
      attachments: plannedImages.rows,
    });
  } catch (err) {
    await discardAttachmentBlobs(deps, plannedImages.rows);
    throw err;
  }
  if (created === "full") {
    await discardAttachmentBlobs(deps, plannedImages.rows);
    if (maxLive === null) throw new Error("createTask answered full with no live-run cap");
    return deploymentFull(maxLive);
  }
  await store.appendEvent({ runId: run.id, at, kind: "created" });
  if (untitled && task.spec.title !== null) startTitling(deps, task.id, task.spec.title);
  for (const event of resolvedEnvironment.events) {
    await store.appendEvent({ runId: run.id, at, ...event });
  }
  if (staleSize !== null) {
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "size-class-unknown",
      detail: `size class "${staleSize}" is no longer configured (RYPH_RUN_SIZES), so this run ` +
        `got the default class "${size.name}"`,
    });
  }
  if (resolvedSkills.drops.length > 0) {
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "skills.dropped",
      detail: describeDrops(resolvedSkills.drops),
    });
  }
  const orgFailure = orgVersion?.lastFailure ?? null;
  if (resolvedSkills.skills?.org?.stale && orgVersion !== null && orgFailure !== null) {
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "skills.stale",
      detail: describeStale(orgVersion, orgFailure),
    });
  }
  if (browser.kind === "unavailable") {
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "browser.unavailable",
      detail: browser.why,
    });
  }
  if (runServices?.stale) {
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "services-stale",
      detail: "the forge could not refresh the repo cache; services came from the entry as it " +
        "stood, so they may be a fetch behind the tree this run clones",
    });
  }

  // Waiting: the run is on record, cancellable, and launches when its build settles
  // (`settleWaitingRun`, below).
  if (waitOn !== null) {
    await catchUpWait(deps, run.id, waitOn.id);
    const after = await store.getRun(run.id);
    return { kind: "started", taskId: task.id, runId: run.id, state: after?.state ?? run.state };
  }

  const launched = await launchRun(deps, run, { runnerToken, gitToken, size });
  return { kind: "started", taskId: task.id, runId: run.id, state: launched.state };
}

/** What a resolution that launches or waits puts on the run: the machine, or the build it waits
 * for. The one reading of a resolution, for a run starting and for one whose image went. */
function runFieldsOf(
  resolution: Exclude<EnvironmentResolution, { kind: "refused" }>,
): Pick<Run, "image" | "environmentId" | "environment" | "environmentWait"> {
  if (resolution.kind === "launch") {
    return {
      image: resolution.image,
      environmentId: resolution.environmentId,
      environment: resolution.environment,
      environmentWait: null,
    };
  }
  const { environment } = resolution;
  return {
    image: null,
    environmentId: environment.id,
    environment: null,
    environmentWait: {
      environmentId: environment.id,
      status: environment.status === "building" ? "building" : "queued",
    },
  };
}

/** A run just put on a build's wait: the build may have moved while the run was being written —
 * started, or even finished — and its settle hook looked for waiters before this one was there.
 * Catch the run up to it now. */
async function catchUpWait(
  deps: StartTaskDeps,
  runId: string,
  environmentId: string,
): Promise<void> {
  deps.diag.debug("task.environment_wait", { runId, environmentId });
  const current = await deps.environments?.store.getEnvironment(environmentId);
  if (current) await settleWaitingRun(deps, runId, current);
}

/** A fresh git key for a run about to launch, when there is a gateway to present it to. */
async function mintGitKey(deps: StartTaskDeps, runId: string, at: string) {
  const gateway = deps.config.gitGateway;
  if (gateway === null) return undefined;
  const gitToken = mintToken();
  await deps.store.createGitKey({
    id: mintId("gk"),
    runId,
    tokenHash: await sha256Hex(gitToken),
    expiresAt: new Date(deps.now().getTime() + gateway.keyTtlMs).toISOString(),
    revokedAt: null,
    createdAt: at,
  });
  return gitToken;
}

/**
 * The size class a run gets: a workspace run takes the workspace's, a run of one connected repo
 * takes that repo's, and anything else — a repo disconnected since, a class nobody chose — the
 * default.
 */
function sizeChoiceOf(
  workspace: Pick<Workspace, "sizeClass"> | null,
  repos: ReadonlyArray<ConnectedRepo | null>,
): string | null {
  if (workspace !== null) return workspace.sizeClass;
  return repos.length === 1 ? repos[0]?.sizeClass ?? null : null;
}

/** How long a provisioner's launch call may take on top of the startup grace before the
 * bootstrap it carries expires under a runner that is still booting inside its grace. */
const BOOTSTRAP_LAUNCH_SLACK_MS = 5 * 60 * 1000;

/**
 * Hands a persisted run to the provisioner, and records how that went. The one launch path: a
 * run starting now, and a run whose environment just finished building.
 */
async function launchRun(
  deps: StartTaskDeps,
  run: Run,
  launch: { runnerToken: string; gitToken: string | undefined; size: RunSize },
): Promise<Run> {
  const { store, provisioner, diag, config } = deps;
  const nowIso = () => deps.now().toISOString();
  const { runnerToken, gitToken } = launch;
  const runServices = run.services;
  // The bootstrap response, NOT the container environment. Seal it under the one-shot bearer
  // before launch; a database-backed atomic exchange gives it to the runner on boot. Neither
  // the provisioner nor /proc/1/environ ever holds these long-lived credentials.
  const env: Record<string, string> = {
    RYPH_ORCHESTRATOR_URL: config.publicUrl,
    RYPH_RUN_ID: run.id,
    RYPH_RUN_TOKEN: runnerToken,
    RYPH_CONTROL_TOKEN: run.controlToken,
    ...(gitToken && config.gitGateway !== null
      ? { RYPH_GIT_ORIGIN: config.gitGateway.url, RYPH_GIT_TOKEN: gitToken }
      : {}),
    // Where the runner POSTs its transcript. Set only for a standalone historian; unset, the
    // runner falls back to the orchestrator origin, where the historian is mounted in-process.
    ...(config.runHistoryUrl !== null ? { RYPH_HISTORY_URL: config.runHistoryUrl } : {}),
    // The runner explicitly supplies this claim to setup and harness children through their
    // proxy environment, never through its own process environment. Absent means no route out.
    ...(await egressEnv(deps, run.id, run.networkScope)),
  };

  let launched: Run;
  try {
    const bootstrapToken = mintToken();
    await store.saveBootstrap(
      run.id,
      await sha256Hex(bootstrapToken),
      await sealBootstrap(bootstrapToken, run.id, env),
      // Past the reaper's own deadline, which counts the grace from `launchedAt` — stamped only
      // once the launch below returns. Until then the reaper refusing a lost run is what closes
      // the exchange; the expiry is the backstop and the sweep's horizon.
      new Date(
        deps.now().getTime() + config.limits.startupGraceMs + BOOTSTRAP_LAUNCH_SLACK_MS,
      ).toISOString(),
    );
    const launchEnv: Record<string, string> = {
      RYPH_ORCHESTRATOR_URL: config.publicUrl,
      RYPH_RUN_ID: run.id,
      RYPH_BOOTSTRAP_TOKEN: bootstrapToken,
      // Provisioners use the proxy address to check their network configuration; no claim.
      ...(env.RYPH_EGRESS_PROXY ? { RYPH_EGRESS_PROXY: env.RYPH_EGRESS_PROXY } : {}),
    };
    const deadlineSeconds = deadlineSecondsFor(run.limits, config.limits.deadlineGraceMs);
    const { handle } = await provisioner.launch({
      runId: run.id,
      image: run.image,
      size: launch.size,
      env: launchEnv,
      services: runServices?.services ?? [],
      // From the frozen grant and the configuration as it stands at launch: a run that waited
      // out an environment build across a restart that turned the browser off launches without
      // one, and its runner says the browser never answered.
      browser: run.workItem.browser !== undefined && config.browser !== null
        ? {
          image: config.browser.image,
          port: run.workItem.browser.port,
          resources: { cpu: config.browser.cpus, memory: config.browser.memory },
        }
        : null,
      ...(deadlineSeconds === null ? {} : { deadlineSeconds }),
    });
    // `launchedAt` beside `handle`, never apart from it: the startup grace is counted from here,
    // and a handle without a launch time would fall back to `createdAt` — which for a run that
    // waited out an environment build is long enough ago to be lost on arrival.
    launched = { ...run, handle, launchedAt: nowIso(), updatedAt: nowIso() };
    await store.appendEvent({ runId: run.id, at: launched.updatedAt, kind: "launched" });
  } catch (err) {
    diag.warn("provision.launch_failed", { runId: run.id, err: String(err) });
    // Nothing will ever redeem it; the sealed credentials should not outlive the launch.
    await store.deleteBootstrap(run.id).catch((e) =>
      diag.warn("provision.bootstrap_cleanup_failed", { runId: run.id, err: String(e) })
    );
    return await afterFailedLaunch(deps, run, err, launch.size);
  }
  // Provisioning only owns the handle and launch time. Even a run that is still starting
  // may have received a prompt, been attended, or been retargeted while launch awaited:
  // never restore the launch's snapshot over those writes (or over a heartbeat/result).
  launched = await store.recordRunLaunch(run.id, launched.handle, launched.launchedAt!) ??
    launched;
  return launched;
}

/** Whether a stored run is still the one a launch was handed: starting, no container, waiting on
 * no build, and nobody has asked it to stop. */
function unlaunched(run: Run | null): run is Run {
  return run !== null && run.state === "starting" && run.handle === null &&
    run.environmentWait === null && run.desiredState === null;
}

/**
 * A launch threw. A run whose environment image turned out gone goes round once more
 * (`relaunchGoneImage`); any other is errored with the failure. Every write is conditioned on
 * the stored run still being unlaunched (`saveRunIfUnlaunched`): the launch took seconds, and a
 * cancel that landed meanwhile ends the run cancelled instead of being written over.
 */
async function afterFailedLaunch(
  deps: StartTaskDeps,
  run: Run,
  err: unknown,
  size: RunSize,
): Promise<Run> {
  const { store } = deps;
  let detail = String(err);
  if (err instanceof ImageGone) {
    const gone = await relaunchGoneImage(deps, run, err, size);
    if (gone?.kind === "handled") return gone.run;
    if (gone?.kind === "refused") detail = gone.detail;
  }
  const at = deps.now().toISOString();
  const errored: Run = { ...run, state: "errored", updatedAt: at };
  if (await store.saveRunIfUnlaunched(errored)) {
    await store.appendEvent({ runId: run.id, at, kind: "launch-failed", detail });
    return errored;
  }
  const current = await store.getRun(run.id);
  if (current === null) return errored;
  if (
    current.state !== "starting" || current.handle !== null || current.desiredState !== "cancelled"
  ) return current;
  // Asked to stop while its launch was failing: nothing runs, so it ends here, as a waiting run
  // cancelled does.
  const cancelled = await store.saveRunTransition(
    { ...current, state: "cancelled", environmentWait: null, updatedAt: at },
    current,
  );
  if (cancelled === null) return await store.getRun(run.id) ?? current;
  await store.appendEvent({
    runId: run.id,
    at,
    kind: "launch-failed",
    detail: `${detail} — the run had been cancelled meanwhile, so it ends cancelled`,
  });
  return cancelled;
}

/**
 * A launch found the run's environment image gone from the machine (`ImageGone`: a prune, a
 * daemon reset). The build baked on it is retired as a check suite's is (`imageMissing`), so no
 * run resolves to it again, and the run's environment is resolved once more, exactly as a run
 * starting now resolves it (`resolveEnvironment`): it launches on what that names, waits for the
 * build it names, or is refused with its reason. Once only: a run that already lost one image
 * this way is refused, not sent round again. Null where the run named no environment build: the
 * failure is then an ordinary launch failure.
 */
async function relaunchGoneImage(
  deps: StartTaskDeps,
  run: Run,
  err: ImageGone,
  size: RunSize,
): Promise<{ kind: "handled"; run: Run } | { kind: "refused"; detail: string } | null> {
  const { store, diag, config } = deps;
  const service = deps.environments ?? null;
  const { environmentId, image } = run;
  if (service === null || environmentId === null || image === null) return null;
  diag.warn("environments.run_image_gone", { runId: run.id, environmentId, image });
  await service.imageMissing(environmentId, image).catch((e) =>
    diag.warn("environments.image_missing_failed", { environmentId, err: String(e) })
  );
  const missing = `the environment image ${image} (environment ${environmentId}) is no longer ` +
    `on this machine (${err.message}), so that build is retired`;
  const again = (await store.listEvents(run.id)).some((e) =>
    e.kind === "environment.image_missing"
  );
  if (again) {
    return {
      kind: "refused",
      detail: `${missing}; it is the second image this run lost before it could start, so the ` +
        `run is not started — start it again`,
    };
  }
  // Re-read: a cancel may have landed during the launch, and then nothing goes round again.
  const current = await store.getRun(run.id);
  const task = await store.getTask(run.taskId);
  if (!unlaunched(current) || task === null) return { kind: "refused", detail: missing };

  // The run's checkout as its start resolved it: the task keeps each repo's ref as the door
  // named it, and the workspace it came from.
  const connected = await Promise.all(
    task.repos.map((r) =>
      r.connectedRepoId === null ? null : store.getConnectedRepo(r.connectedRepoId)
    ),
  );
  const resolution = await resolveEnvironment(deps, {
    agentImage: config.agentImage,
    ...(task.workspaceId === null ? {} : { workspace: { id: task.workspaceId } }),
    repos: task.repos.flatMap((r, i) => {
      const repo = connected[i];
      return repo === null
        ? []
        : [{ connectedRepo: repo, ref: r.ref, ...(r.forkHead === true ? { forkHead: true } : {}) }];
    }),
  });
  if (resolution.kind === "refused") {
    return { kind: "refused", detail: `${missing}; ${resolution.error}` };
  }

  const at = deps.now().toISOString();
  // The failed launch's git key goes with it: whatever launches next mints its own.
  await store.revokeGitKeysForRun(run.id, at);
  const runnerToken = mintToken();
  const next: Run = {
    ...current,
    ...runFieldsOf(resolution),
    tokenHash: await sha256Hex(runnerToken),
    updatedAt: at,
  };
  if (!(await store.saveRunIfUnlaunched(next))) return { kind: "refused", detail: missing };
  await store.appendEvent({
    runId: run.id,
    at,
    kind: "environment.image_missing",
    detail: resolution.kind === "wait"
      ? `${missing}: waiting for environment ${resolution.environment.id} ` +
        `(${resolution.environment.status})`
      : `${missing}: launching on ${
        resolution.environmentId === null
          ? "the default image"
          : `environment ${resolution.environmentId} (${resolution.image})`
      }`,
  });
  for (const event of resolution.events) await store.appendEvent({ runId: run.id, at, ...event });
  if (resolution.kind === "wait") {
    await catchUpWait(deps, run.id, resolution.environment.id);
    return { kind: "handled", run: (await store.getRun(run.id)) ?? next };
  }
  const gitToken = await mintGitKey(deps, run.id, at);
  return { kind: "handled", run: await launchRun(deps, next, { runnerToken, gitToken, size }) };
}

/**
 * A build a run waits for moved: the run follows it. Building, the run's wait says so. Ready,
 * the run launches on it — with credentials minted NOW, since a waiting run was given none.
 * Superseded by a later build of the same inputs (a Rebuild), the run follows that build.
 * Failed (or retired before it finished), the run is refused with the build's log tail, as a
 * run whose services could not be read is: an agent on the wrong machine only fails somewhere
 * harder to read.
 *
 * Idempotent, and safe to call for a run that already moved on, and CONCURRENTLY: the build's
 * settle hook, the reaper's backstop and startTask's catch-up may all hold the same waiting run.
 * Every write is conditioned on the stored row still waiting on THIS environment
 * (`saveRunIfWaiting`), and the launch happens only for the caller whose write took the run out
 * of waiting — so a run launches once, and never after a cancel landed.
 */
export async function settleWaitingRun(
  deps: StartTaskDeps,
  runId: string,
  environment: Environment,
): Promise<void> {
  const { store, diag } = deps;
  const run = await store.getRun(runId);
  if (run === null || run.environmentWait?.environmentId !== environment.id) return;
  if (run.state !== "starting" || run.handle !== null) return;
  const at = deps.now().toISOString();

  if (environment.status === "queued" || environment.status === "building") {
    if (run.environmentWait.status !== environment.status) {
      const moved = await store.saveRunIfWaiting({
        ...run,
        environmentWait: { environmentId: environment.id, status: environment.status },
        updatedAt: at,
      }, environment.id);
      if (moved && environment.status === "building") {
        await store.appendEvent({
          runId: run.id,
          at,
          kind: "environment.building",
          detail: `environment ${environment.id} started building`,
        });
      }
    }
    return;
  }

  // Superseded by a Rebuild of the same inputs: the run waits on that build instead. It asked
  // for exactly this machine, and may have started waiting after the Rebuild's own hand-over.
  const successor = await deps.environments?.successorOf(environment) ?? null;
  if (successor !== null) {
    const moved = await store.saveRunIfWaiting({
      ...run,
      environmentWait: {
        environmentId: successor.id,
        status: successor.status === "building" ? "building" : "queued",
      },
      updatedAt: at,
    }, environment.id);
    if (!moved) return;
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "environment.building",
      detail: `environment ${environment.id} was superseded: waiting for environment ` +
        `${successor.id}, a build of the same inputs`,
    });
    // Re-read: it may have moved since it was found, and its settle hook would not see this run.
    const current = await deps.environments?.store.getEnvironment(successor.id) ?? successor;
    await settleWaitingRun(deps, run.id, current);
    return;
  }

  if (environment.status !== "ready" || environment.image === null) {
    const refused: Run = { ...run, state: "errored", environmentWait: null, updatedAt: at };
    if (!(await store.saveRunIfWaiting(refused, environment.id))) return;
    await store.appendEvent({
      runId: run.id,
      at,
      kind: "environment.failed",
      detail:
        `environment ${environment.id} ${
          environment.status === "failed" ? "failed to build" : "was retired before it finished"
        }${environment.failure === null ? "" : ` (${environment.failure})`} — the run is not ` +
        `started. The build's log ends:\n${environment.logTail ?? "(no log)"}`,
    });
    diag.warn("task.environment_failed", { runId: run.id, environmentId: environment.id });
    return;
  }

  await launchFromWait(deps, run, environment.id, {
    image: environment.image,
    environmentId: environment.id,
    environment: runEnvironmentOf(environment),
  }, {
    kind: "environment.ready",
    detail: `environment ${environment.id} is ready: ${environment.image}`,
  });
}

/** What a run that stops waiting launches on. */
interface LaunchTarget {
  image: string | null;
  environmentId: string | null;
  environment: RunEnvironment | null;
}

/**
 * Takes a waiting run out of its wait and launches it on `target`, minting what a waiting run was
 * not given: a runner token (the one minted at creation was never handed to anything), the git
 * key, the size. Answers whether this caller launched it.
 *
 * The write that takes the run out of waiting is the claim: only the caller whose write landed
 * goes on to mint a git key and launch. A cancel that got there first wrote the run off, and this
 * one lands on nothing. (Past it the run is an ordinary starting run, and a cancel takes the
 * ordinary path: recorded, and carried to the container.)
 */
async function launchFromWait(
  deps: StartTaskDeps,
  run: Run,
  waitingOn: string,
  target: LaunchTarget,
  event: { kind: RunEvent["kind"]; detail: string },
): Promise<boolean> {
  const { store, config } = deps;
  const at = deps.now().toISOString();
  const task = await store.getTask(run.taskId);
  if (task === null) return false;
  const workspace = task.workspaceId === null ? null : await store.getWorkspace(task.workspaceId);
  const connected = await Promise.all(
    task.repos.map((r) =>
      r.connectedRepoId === null ? null : store.getConnectedRepo(r.connectedRepoId)
    ),
  );
  const { size } = resolveRunSize(config.runSizes, sizeChoiceOf(workspace, connected));
  const runnerToken = mintToken();
  const launching: Run = {
    ...run,
    ...target,
    workItem: { ...run.workItem, runSize: size },
    environmentWait: null,
    tokenHash: await sha256Hex(runnerToken),
    updatedAt: at,
  };
  if (!(await store.saveRunIfWaiting(launching, waitingOn))) return false;
  const gitToken = await mintGitKey(deps, run.id, at);
  await store.appendEvent({ runId: run.id, at, ...event });
  await launchRun(deps, launching, { runnerToken, gitToken, size });
  return true;
}

/**
 * A person chose not to wait: the run launches now on the newest ready default-branch
 * environment of the same subject (on the current harness), or the default image when there is
 * none, and says so in its events. The build it was waiting for goes on — it is what the next run
 * gets — so nothing is released here. Answers false when the run was not waiting (any more).
 */
export async function startWithoutEnvironment(
  deps: StartTaskDeps,
  runId: string,
  by: string,
): Promise<boolean> {
  const run = await deps.store.getRun(runId);
  const wait = run?.environmentWait ?? null;
  if (run === null || wait === null || run.state !== "starting" || run.handle !== null) {
    return false;
  }
  // The default image, recorded as a default launch with environments on records it.
  const agentImage = deps.config.agentImage;
  let target: LaunchTarget = {
    image: agentImage,
    environmentId: null,
    environment: agentImage === null ? null : defaultRunEnvironment(agentImage),
  };
  let what = "the default image";
  const service = deps.environments ?? null;
  const waitedOn = service === null ? null : await service.store.getEnvironment(wait.environmentId);
  if (service !== null && waitedOn !== null) {
    const harness = service.config.environments.harnessImage ?? "";
    const ready = (await service.store.listEnvironmentsForSubject(
      waitedOn.subjectKind,
      waitedOn.subjectId,
    )).filter((row) =>
      row.defaultBranch && row.status === "ready" && row.image !== null &&
      sameImage(row.harnessDigest, harness)
    ).sort(byNewestBuilt)[0];
    if (ready !== undefined) {
      target = {
        image: ready.image,
        environmentId: ready.id,
        environment: runEnvironmentOf(ready),
      };
      what = `the newest ready environment (${ready.id}, built from ${ready.ref})`;
    }
  }
  return await launchFromWait(deps, run, wait.environmentId, target, {
    kind: "environment.fallback",
    detail: `${by} started this run without waiting for environment ${wait.environmentId} — ` +
      `it uses ${what}`,
  });
}

/**
 * The two variables that carry a run's way out, or nothing at all.
 *
 * The token is a SIGNED CLAIM carrying the allowlist, not a handle the proxy looks up: that is
 * what lets the proxy hold no database, no control listener and no link back here (see
 * core/egress.ts). It is minted per run and dies on its expiry — there is no revocation list,
 * because the proxy has nowhere to read one from and pretending otherwise would be the one lie
 * in this design.
 *
 * WHICH MAKES THE TTL THE ONLY BOUND THERE IS, and the window it has to cover is now the RUN:
 * the runner puts this behind HTTPS_PROXY for the setup steps and for the harness alike, so the
 * last legitimate reader is the agent at the end of a long day. `RYPH_EGRESS_TOKEN_TTL_MS` is a
 * day for that reason rather than the hour the setup window used to need. A claim that leaks —
 * out of the run's Secret, out of `docker inspect`, out of a setup step that echoed its
 * environment, or out of this process's `/proc/1/environ` inside the container — is a bearer
 * credential for another run's allowlist to anything that can reach the proxy, and the only
 * thing that takes it away is the clock. Widening that window is the price of an agent that can
 * resolve a dependency, and it is paid in a claim that names package registries and holds no
 * credential of its own.
 *
 * Nothing is set when the deployment claims no boundary, has no key, or has no proxy address.
 * The run then simply has no way out, which every backend's manifest already enforces or
 * honestly admits it does not.
 */
async function egressEnv(
  deps: StartTaskDeps,
  runId: string,
  scope: { mode: string; hosts: string[] },
): Promise<Record<string, string>> {
  const { policy, key, tokenTtlMs } = deps.config.egress;
  if (scope.mode !== "proxy" || key === null || policy.proxyUrl === null) return {};
  const expiresAt = Math.floor((deps.now().getTime() + tokenTtlMs) / 1000);
  return {
    RYPH_EGRESS_PROXY: policy.proxyUrl,
    RYPH_EGRESS_TOKEN: await mintEgressToken(key, { runId, expiresAt, hosts: scope.hosts }),
  };
}

/**
 * The run's frozen tool scope: the agent's policy, copied — plus the platform's memory server
 * when the agent remembers, this deployment can serve it, and the run's brief was composed. In
 * scope BY DEFAULT: the agent's policy may name the server to narrow its tools (read-only
 * memory is `search` and `get`), and opts out by having no memory policy at all. A harness that
 * cannot drive tools gets none of this — the brief still rides the spec, the tools would only
 * fail the boot.
 *
 * `briefComposed` is the fourth condition and the non-obvious one: composing the brief is the
 * ONLY writer of the run's scope row on the memory side, so a brief call that threw leaves the
 * memory server with no run to answer for. Scoping it in regardless hands the agent a set of
 * tools that fail every call for the whole run — worse than not having them, because the agent
 * spends turns discovering it. A brief that composed to null still counts: memory was asked,
 * memory wrote the row, it simply had nothing to say.
 *
 * The platform's chat server joins the same way when the run has a chatroom to post into —
 * `platformChatServerId` is passed only then (a deployment that serves it, and a task bound to
 * a room) — so an ordinary run never sees a chat tool.
 *
 * The platform's web server joins every tool-capable agent's runs wherever the deployment serves
 * it — because reading a page is not a capability over anything of ours: it is read-only,
 * metered, and everything it returns is framed as untrusted third-party text. An agent's tool
 * policy may name the row to narrow it to one of its two tools; an entry it already made is left
 * exactly as it stands.
 *
 * `platformWeb` carries the row's id AND whether it is served, and both halves matter. Where it
 * is NOT served — the deployment turned the tools off, or the gateway has not answered yet — the
 * id is what lets this drop a scope entry an agent's own tool policy made. Nothing else would:
 * a platform row cannot be archived, so it stays in the picker and stays saveable, and without
 * this an agent whose policy names it would keep the tools an operator has just taken away.
 *
 * The platform's forge server joins when the run has a forge scope, with its allowlist DERIVED
 * from the scope's capabilities — `platformForge` is passed only then — so the gateway's
 * `tools/list` filter is the forge policy, never a second choice made in a tool policy (which may
 * not name the row at all).
 *
 * `confined` is a run on a fork pull request's head (`worksForkHead`): the contributor's code
 * runs there with the run's gateway token in its environment, so the run gets only what holds
 * nothing beyond the run itself — the forge server, already confined to the pull request
 * (`confinedPolicy`), and the web server, whose one key is spent server-side and never shown.
 * The agent's own servers (a catalogue entry's PAT, a remote server's key), memory and chat are
 * left out, and a policy entry survives only where it narrows the web row.
 *
 * Null exactly when there is nothing to scope, so a policy-less agent without memory keeps the
 * boot fetch's `{env: {}}` answer and the extension never loads.
 */
export function composeToolScope(
  agent: Pick<Agent, "toolPolicy" | "memoryPolicy" | "harnessKind">,
  platformMemoryServerId: string | null,
  briefComposed: boolean,
  platformChatServerId: string | null = null,
  platformForge: { serverId: string; allowedTools: string[] } | null = null,
  platformWeb: { serverId: string; served: boolean } | null = null,
  confined = false,
): RunToolScope | null {
  const servers: RunToolScope["servers"] = (agent.toolPolicy?.servers ?? [])
    .filter((s) => !confined || (platformWeb !== null && s.serverId === platformWeb.serverId))
    // An entry for a platform server this deployment does not serve is dropped here, before
    // anything else looks at the scope. It is the one class of entry a policy can hold that
    // nothing downstream would refuse for us: an unserved platform row is not archived and not
    // missing — the gateway may still hold it from a boot when the tools were on — so the run
    // would get a credential for tools the operator turned off.
    .filter((s) =>
      !(platformWeb !== null && !platformWeb.served && s.serverId === platformWeb.serverId)
    )
    .map((s) => ({
      serverId: s.serverId,
      allowedTools: s.allowedTools === "*" ? "*" as const : [...s.allowedTools],
    }));
  if (
    !confined && platformMemoryServerId !== null && agent.memoryPolicy !== null &&
    briefComposed &&
    supportsTools(agent.harnessKind) &&
    !servers.some((s) => s.serverId === platformMemoryServerId)
  ) {
    servers.push({ serverId: platformMemoryServerId, allowedTools: "*" });
  }
  if (
    !confined && platformChatServerId !== null && supportsTools(agent.harnessKind) &&
    !servers.some((s) => s.serverId === platformChatServerId)
  ) {
    servers.push({ serverId: platformChatServerId, allowedTools: "*" });
  }
  // The web tools, on the same terms as memory's and with no policy of their own to ask: where
  // the deployment serves them, every tool-capable agent gets them. An agent's tool policy may
  // still NAME the row to narrow it to one of the two tools — the entry above is kept then, and
  // this adds nothing.
  if (
    platformWeb !== null && platformWeb.served && supportsTools(agent.harnessKind) &&
    !servers.some((s) => s.serverId === platformWeb.serverId)
  ) {
    servers.push({ serverId: platformWeb.serverId, allowedTools: "*" });
  }
  if (
    platformForge !== null && platformForge.allowedTools.length > 0 &&
    supportsTools(agent.harnessKind)
  ) {
    const at = servers.findIndex((s) => s.serverId === platformForge.serverId);
    if (at !== -1) servers.splice(at, 1);
    servers.push({
      serverId: platformForge.serverId,
      allowedTools: [...platformForge.allowedTools],
    });
  }
  return servers.length === 0 ? null : { servers };
}

/**
 * The agent's forge policy resolved against this run, or null when the run gets no forge tools:
 * no policy, a deployment that does not serve them, a harness that cannot drive tools, a
 * checkout of local repositories only, or no repo left to act on. A listed repo disconnected
 * since the policy was saved is dropped, not refused: the policy was valid when an admin set
 * it, and the rest of it still is.
 *
 * A local repository is never a forge-tool repo to WRITE to: it has no issues, threads or
 * reviews, so a listed one is dropped like a disconnected one, and `composeForgeScope` leaves
 * a checked-out one out of the writable set. It is still SOURCE: it rides `sourceRepos`, and
 * the forge answers a local repository's visibility as private — which it is, a directory on
 * the owner's disk — so the forge's own rule (a run holding private source may not write to a
 * public repo) fences a mixed checkout's writes exactly as it fences a private GitHub repo's.
 * A checkout of local repositories only has nothing to write to, so it gets no tools at all.
 */
async function resolveForgeScope(
  deps: StartTaskDeps,
  args: StartTaskArgs,
  task: Task,
): Promise<RunForgeScope | null> {
  const { store, diag, config } = deps;
  const { agent } = args;
  const policy = agent.forgePolicy;
  if (policy === null || config.platformTools.forge === null) return null;
  if (!supportsTools(agent.harnessKind)) return null;

  const runRepos = args.repos.map((r) => r.connectedRepo);
  if (runRepos.length > 0 && runRepos.every((r) => r.provider === "local")) {
    diag.debug("task.forge_scope_local", { agentId: agent.id });
    return null;
  }
  const listedRepos: ConnectedRepo[] = [];
  for (const id of forgePolicyRepoIds(policy)) {
    const repo = await store.getConnectedRepo(id);
    if (repo === null || repo.archivedAt !== null || repo.provider === "local") {
      diag.warn("task.forge_repo_unavailable", { agentId: agent.id, connectedRepoId: id });
      continue;
    }
    listedRepos.push(repo);
  }
  const origin = forgeOriginOf(originConversationFor(args));
  // The footer names who asked, AS THAT FORGE names them: a GitHub login signs nothing on
  // Radicle. Read for the forge the scope's own repos live on — a run holds one today, and a
  // mixed set would still sign with the forge its writes go to. Never `local`: nothing is
  // written there, and it has no logins to sign with.
  const provider = (runRepos.find((r) => r.provider !== "local") ?? listedRepos[0])?.provider ??
    null;
  //
  // A chat-started run is signed with its commander's chat name INSTEAD: its requester of record
  // is the room's owner, who asked for nothing — "asked by @owner" on an issue someone else
  // requested misattributes it, and on GitHub pings the owner besides.
  //
  // Only ever a login the requester holds themselves: where everyone acts as one account
  // (GitHub's user mode) the directory answers a name instead, which the footer has no
  // spelling for, and it names nobody rather than the account's owner (ports/identity_directory.ts).
  const requester = args.requestedVia !== undefined || args.requestedByUserId === null ||
      !deps.identityDirectory || provider === null
    ? null
    : await deps.identityDirectory.requesterFor(args.requestedByUserId, provider);
  const requestedBy = requester !== null && "login" in requester ? requester.login : null;
  const scope = composeForgeScope({
    policy,
    runRepos,
    listedRepos,
    origin,
    targetChangeRequest: task.targetChangeRequest,
    confined: worksForkHead(task.repos),
    provenance: {
      agentName: agent.name,
      runUrl: runUrlOf(config.appUrl, task.id),
      requestedBy,
      requestedVia: args.requestedVia?.name ?? null,
    },
  });
  if (scope === null) diag.debug("task.forge_scope_empty", { agentId: agent.id });
  return scope;
}

/**
 * The declarations → what the provisioner may launch, or a refusal naming what to change.
 *
 * Every arm refuses rather than proceeds, and the reason is the measurement this feature was
 * built on: a repo whose Redis is missing does not fail its test suite, it HANGS — ten minutes,
 * no output, an eager reconnect loop. So "we could not read the declaration" must never become
 * "the repo declares nothing"; it becomes a task that did not start, with a sentence saying so.
 *
 * One file per connected repo of the checkout, read out of the forge cache exactly as one is
 * read today, then unioned: the same name in two repos is one service, and two repos that
 * disagree about it are refused naming both.
 */
async function resolveRunServices(
  deps: StartTaskDeps,
  repos: ReadonlyArray<{ repo: ConnectedRepo; entry: RepoEntry }>,
): Promise<
  { kind: "ok"; services: RunServices | null } | Extract<StartTaskOutcome, { kind: "refused" }>
> {
  const { forge, diag } = deps;
  if (!forge) {
    // Connected repos require the forge, so this is a wiring fault rather than a user error.
    return {
      kind: "refused",
      status: 503,
      error: "service containers are on, but this orchestrator has no forge to read " +
        ".ryph/services.yml through",
    };
  }
  const perRepo: Array<{ repo: string; declarations: ServiceDeclaration[] }> = [];
  let stale = false;
  // Read side by side, a few at a time: on a hanging forge each read waits out its own deadline
  // before the cached copy answers, and a workspace read one repo at a time would add those up.
  // The answers are then walked in checkout order, so a refusal names the same repo it always
  // did.
  const answers = await mapWithConcurrency(
    repos,
    FORGE_CHECK_CONCURRENCY,
    ({ repo, entry }) =>
      forge.readServicesFile(forgeRepoRef(repo), repo.url, servicesRef(repo, entry)),
  );
  for (const [i, { repo, entry }] of repos.entries()) {
    const ref = servicesRef(repo, entry);
    const answer = answers[i];
    if (answer.kind === "absent") continue;
    if (answer.kind === "unavailable") {
      diag.warn("task.services_unavailable", { repo: repo.repoRef, ref, detail: answer.detail });
      return {
        kind: "refused",
        status: 503,
        error: `could not read ${repo.repoRef}'s .ryph/services.yml at ${ref} ` +
          `(${answer.detail}) — the run is not started, because a run whose services are ` +
          `silently absent hangs rather than fails`,
        about: {
          connectedRepoId: repo.id,
          summary: "has a .ryph/services.yml that could not be read, so the run was not started",
        },
      };
    }
    if (answer.kind === "invalid") {
      return {
        kind: "refused",
        status: 400,
        error: `${repo.repoRef}: ${answer.detail}`,
        about: { connectedRepoId: repo.id, summary: "has a .ryph/services.yml that is not valid" },
      };
    }
    let declarations: ServiceDeclaration[];
    try {
      declarations = parseServicesYaml(answer.text);
    } catch (err) {
      return {
        kind: "refused",
        status: 400,
        error: `${repo.repoRef}'s .ryph/services.yml (at ${ref}): ${
          err instanceof Error ? err.message : err
        }`,
        about: {
          connectedRepoId: repo.id,
          summary: "has a .ryph/services.yml that could not be parsed",
        },
      };
    }
    stale ||= answer.stale;
    // The checks-only ones are not this run's to start. Left out before the union, so a repo
    // whose only service is checks-only launches exactly as one with no services.yml does.
    perRepo.push({ repo: repo.repoRef, declarations: forRuns(declarations) });
  }
  const union = unionDeclarations(perRepo);
  if (union.kind === "refused") {
    return { kind: "refused", status: 400, error: `.ryph/services.yml: ${union.error}` };
  }
  if (union.declarations.length === 0) return { kind: "ok", services: null };

  const catalogue = (await deps.serviceCatalogue?.list()) ?? [];
  // Every address the bootstrap exchange hands the run for reaching the platform, so no service
  // can be named after one of their hosts. The runner checks the credentials fetch's own.
  const { config } = deps;
  const resolved = resolveServices(union.declarations, catalogue, config.services, {
    RYPH_ORCHESTRATOR_URL: config.publicUrl,
    RYPH_GIT_ORIGIN: config.gitGateway?.url ?? null,
    RYPH_HISTORY_URL: config.runHistoryUrl,
  });
  if (resolved.kind === "refused") {
    return { kind: "refused", status: 400, error: `.ryph/services.yml: ${resolved.error}` };
  }
  diag.debug("task.services_resolved", {
    repos: repos.map((r) => r.repo.repoRef),
    services: resolved.services.map((s) => s.name),
    stale,
  });
  return { kind: "ok", services: { services: resolved.services, stale } };
}

/**
 * The brief as the run carries it: memory names each evidence entry's REPO (as the brief
 * request named it, which is the task's own URL for it); the runner needs the checkout PATH to
 * run the staleness check in that clone and no other — two repos can share history, and a
 * commit alone would not say which. A repo the task does not hold maps to null, which the
 * runner skips.
 */
export function freezeBrief(
  composed: ComposedBrief,
  repos: ReadonlyArray<{ url: string; path: string }>,
): MemoryBrief {
  return {
    text: composed.text,
    memoryIds: composed.memoryIds,
    evidence: composed.evidence.map(({ repo, ...entry }) => ({
      ...entry,
      path: repos.find((r) => r.url === repo)?.path ?? null,
    })),
  };
}

/** The most of a room name or a bot handle the agent is told — the runner refuses longer. */
const CHAT_FIELD_MAX = 128;

/**
 * The room facts as the runner accepts them: one line each, trimmed, bounded. The runner refuses
 * a work item whose chat fields carry a newline or nothing but whitespace, and a refused work item
 * is a run that errors at boot — for a group title, which an admin typed. So the fields are
 * tidied here, on both the HTTP and the in-process path, and a field with nothing left is the
 * whole context gone: a run told less, never a run that does not start.
 */
function tidyChat(chat: ChatContext | null): ChatContext | null {
  if (chat === null) return null;
  const line = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, CHAT_FIELD_MAX);
  const roomTitle = line(chat.roomTitle);
  const botHandle = line(chat.botHandle);
  if (roomTitle === "" || botHandle === "") return null;
  return { kind: chat.kind, roomTitle, botHandle, ...(chat.quiet ? { quiet: true } : {}) };
}
