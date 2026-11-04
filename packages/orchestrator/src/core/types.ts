// The shared shapes of the orchestrator.
//
// Some types here (WorkItem, Phase, RunnerResult and their parts) mirror @ryph/runner's core
// types: they ARE the wire contract between the control plane and a runner. They are duplicated
// on purpose — importing runner internals would couple the packages at the source level; once
// the contract settles, these move to a shared protocol package.
//
// Invariants:
// - user secrets NEVER appear in these types (model keys, git credentials travel via the
//   container environment only). Two run-scoped credentials are the deliberate exception:
//   Run.tokenHash is a digest (not recoverable), and Run.controlToken is the orchestrator's own
//   credential for the runner's cancel endpoint. Neither may ever reach a user-facing response —
//   http/ redacts them (`toPublicRun`).
// - heartbeats are a gauge, not history: they update Run in place and are never persisted as
//   events. Only transitions land in the append-only RunEvent trail.

// Egress is the one policy family whose shapes live beside their rules rather than here: the
// bundle catalogue, the narrowing check and the token format are one subject, and splitting the
// types off would leave this file holding half of it. Re-exported so every reader of a policy
// still finds it in the same place as its three siblings.
import type { EgressRefusal, NetworkPolicy, RunNetworkScope } from "./egress.ts";
import type { SetupWarning } from "./setup_warnings.ts";
export type { EgressRefusal, NetworkPolicy, RunNetworkScope };

export interface AgentIdentity {
  name: string;
  email: string;
}

/**
 * What a task asks. Both are null while the task awaits its prompt:
 * it was started with no instructions, its run boots and waits, and the first message to that
 * run becomes them (core/prompt.ts). Never one without the other — a task with instructions
 * always has a title, the caller's or one made from them (core/titles.ts).
 */
export interface TaskSpec {
  title: string | null;
  instructions: string | null;
}

/**
 * What a task is FOR, when the platform authored it rather than a person: `environment-setup` is
 * the "Set up this repo's environment" task (core/environment_setup.ts). It changes nothing about
 * how the task runs — it is a normal task, visible, cancellable, its patches reviewed as usual —
 * only what the platform tells its run about the builds its patches ask for: a setup run hears
 * even that no build was due, so it is never left waiting for a result that is not coming.
 */
export type TaskPurpose = "environment-setup";

/**
 * How long a run lives past the agent's settles. Every run stays alive on an idle clock after the
 * agent settles, so people (the run page, a chatroom) and later fires can speak to it: it ends
 * when the agent calls its finish tool, when a person finishes it from its page (once the agent
 * said it was done), when the clock runs out — `idleMs` of silence, or
 * `attendedIdleMs` once a person has spoken — or when it is cancelled. Frozen onto the task and
 * the work item.
 */
export interface RunLifetime {
  idleMs: number;
  attendedIdleMs: number;
}

/** The idle clocks a run gets when its caller names none. */
export const DEFAULT_IDLE_MS = 5 * 60_000;
export const DEFAULT_ATTENDED_IDLE_MS = 30 * 60_000;

/** Who is speaking to a run, and how the runner frames it. "alert" is a fire joining a response
 * (the name is older than responses; it is internal and stored). */
export type MessageKind = "user" | "chat" | "alert" | "system";

/** A message's sender: a small union carried, never queried into. */
export type MessageSender =
  | { kind: "user"; userId: string }
  | { kind: "chat"; name: string; id: string }
  | { kind: "automation"; fireId: string }
  /** A `/ryph` follow-up in the thread the run was commanded from. The login is the one the
   * permission check cleared, and the thread is named so the framing can say where the words
   * came from — "via the run page" would be a lie, and the framing is the control. The forge
   * is carried because a repo's address cannot tell GitHub from GitLab; absent on older rows. */
  | { kind: "forge"; login: string; repoRef: string; thread: string; provider?: ForgeProvider }
  | { kind: "platform" };

/**
 * What a `system` message may carry beside its text: a structured fact the runner reads before
 * framing it for the agent. Four kinds: a patch's progress — "merged" is the cue that ends a
 * repo's generation, which the runner answers by fetching where it merged — the result of the
 * environment build a patch asked for (core/environment_feedback.ts), which the runner only
 * frames and the run page renders, the release of a change request that merged with nothing of
 * the run on it, and a person's finish, which ends the run.
 */
export type SystemPayload =
  | PatchPayload
  | EnvironmentPayload
  | ReleasedPayload
  | FinishPayload
  | ChecksPayload;

/** A settled check suite; the accompanying text remains the complete agent-facing report. */
export interface ChecksPayload {
  kind: "checks";
  suiteId: string;
  state: "passed" | "failed" | "error" | "cancelled";
  /** The request's checkout path, not the checks file's path. */
  path: string;
  commit: string;
  partial: boolean;
}

/**
 * The release cue: the change request the task's repo at `path` worked (`forgeRef`) merged with
 * nothing of this run on it, and the repo moved onto `onto` (core/merge_release.ts). The runner
 * ends the generation as a `missed` cue with `onto` does: it fetches `onto`, the agent moves the
 * run's own commits there, and its next submit opens a fresh change request. A kind of its own, never a patch's state:
 * no patch is its subject.
 */
export interface ReleasedPayload {
  kind: "released";
  path: string;
  /** The line the released change request was bound to — always the default line, since only it
   * ever works a task's `targetChangeRequest` (core/patch_lifecycle.ts `submissionTarget`). A cue
   * is routed to (path, line), never to a path alone. */
  line: string;
  onto: string;
  forgeRef: string;
  /** The generation the release ends: the release landing's (`RepoLanding.generation`), the
   * run's current one at `path`. The runner takes the cue only in that generation. */
  generation: number;
}

/**
 * A person finished the run from its page (core/finish_run.ts). The runner ends the run at the
 * agent's next settle, as the agent's own finish would (though without holding for a check
 * verdict), and never hands the agent the message.
 * Finish is never offered until the runner reports an outcome, and a runner that reports one
 * reads this payload, so the text beside it is only what the run page's inbox shows.
 */
export interface FinishPayload {
  kind: "finish";
}

export interface PatchPayload {
  kind: "patch";
  patchId: string;
  /** The repo's checkout path. */
  path: string;
  /** The patch's line (`Patch.line`): the runner routes the cue to (path, line), never to a path
   * alone — a merge on one line moves only that line's generation. */
  line: string;
  headSha: string;
  generation: number;
  /** A closed set the runner validates: a new value would be refused by a runner a version
   * behind. `held` is the git-hook gate's hold, and the runner words it as such; a landing's hold
   * (docs/patch-lifecycle.md "Landing") is told in words alone, with no payload (`notifyText`). */
  state:
    | "submitted"
    | "approved"
    | "rejected"
    | "merged"
    | "closed"
    | "failed"
    | "superseded"
    /** Held for a person's approval because it changes git hook files (`hookPaths`). */
    | "held"
    /** Its change request merged without its head (`PatchFate` `missed`). With `onto` only when
     * no patch of its generation merged at all: the cue that the generation is over, and its
     * work moves onto `onto` from where the generation began. */
    | "missed";
  forgeUrl: string | null;
  /** A rejection's or failure's reason, for the agent. */
  reason: string | null;
  /** With `held`: the hook files the patch changes, repo-relative. Absent otherwise. */
  hookPaths?: string[];
  /**
   * On a merge: the branch the repo moved onto (core/landing.ts), bare — where the forge says the
   * change request merged — which the next generation starts on. Read off the task's landing
   * record, so every cue for the generation names the same one. On `missed` only when none of
   * the generation's patches merged. Absent on every other state.
   */
  onto?: string;
  /**
   * On `merged` only: the head the runner takes as landed, which the agent's rebase starts past —
   * the cue's own, which is the newest patch of the run, path and generation that merged (only
   * that one's cue is posted: core/merge_settle.ts `cueMerged`). A merged head is in what merged,
   * or its change is exactly what merged, both ways (forge helpers/containment.ts): a head that
   * merged only in part is `missed`, and its commits move with the rest.
   */
  landedHead?: string;
}

/** A branch environment built for one of the run's patches settled — or none was built. */
export interface EnvironmentPayload {
  kind: "environment";
  patchId: string;
  /** The repo's checkout path. */
  path: string;
  headSha: string;
  /** The build; null when no build was due (the text says why). */
  environmentId: string | null;
  status: "ready" | "failed" | "superseded" | "skipped";
}

/**
 * One message in a run's inbox: durable, addressed to one run, pulled by its runner in order.
 * `seq` is per run and monotonic — the runner's cursor, the same shape as the heartbeat's
 * guard. `deliveredAt` is stamped when the runner's next poll acknowledges it. The text is
 * bounded (MAX_MESSAGE_CHARS) and, with one exception, UNTRUSTED: the runner frames it as
 * something said, never as an instruction. The exception is a `forge` sender — a `/ryph` command
 * whose author the intake checked for write access before posting it — which the runner frames as
 * AUTHORIZED and free to revise the task, because changing the work is what a follow-up command is
 * for. Either way nothing in a message can widen the run's SCOPE: a message is never work.
 */
export interface RunMessage {
  id: string;
  runId: string;
  seq: number;
  kind: MessageKind;
  sender: MessageSender;
  text: string;
  payload: SystemPayload | null;
  /** The images the message carries, in the order its `[image N]` markers count them. Refs
   * only — the bytes stay in the attachment store, and each ref is claimed by this message
   * alone (core/attachments.ts). Empty for a message of text. */
  attachments: AttachmentRef[];
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * The image formats an attachment may be, decided by sniffing the bytes and never by what a
 * client claimed: the four every vision model reads. Anything else (SVG above all: a document,
 * not a picture) is refused at the door.
 */
export type AttachmentMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Which door an attachment came through: the run page's composer, a chat transport, a forge
 * thread — or the run's own agent, an image one of its tools returned (a browser screenshot, a
 * file its read tool opened), kept so the transcript can show it. The agent's per-run cap
 * counts by it (`MAX_AGENT_ATTACHMENTS`); nothing else branches on it. */
export type AttachmentSource = "user" | "chat" | "forge" | "agent";

/** What a message, a work item and a transcript name an attachment by: never the bytes. */
export interface AttachmentRef {
  id: string;
  mime: AttachmentMime;
}

/**
 * One stored image, owned by one run (core/attachments.ts). The bytes live in the attachment
 * store under `storageKey`; this row is what proves an id belongs to a run and who used it.
 *
 * `claimedBy` is the reuse rule: null while an upload waits to be sent, then `"task"` for an
 * image the run was started with or the id of the ONE message that carried it — or `"tool"`
 * from birth, for an image the agent's own tool returned (`storeAgentAttachment`). A claimed
 * attachment cannot ride a second message — one image, one place in the conversation — and an
 * unclaimed one is never served to the runner, which only reads what it was handed.
 */
export interface Attachment {
  id: string;
  runId: string;
  mime: AttachmentMime;
  /** Size in bytes. */
  bytes: number;
  /** Hex SHA-256 of the bytes, for the record and for spotting the same image twice. */
  sha256: string;
  /**
   * The name the agent writes an image by, `img-` and the first 12 hex of `sha256`
   * (core/image_refs.ts): set on an image the agent's own tool returned, one row per ref per run;
   * null on every other.
   */
  ref: string | null;
  source: AttachmentSource;
  storageKey: string;
  claimedBy: string | null;
  createdAt: string;
}

/** How much text one message may carry — the same 16 KB head an automation payload embeds. */
export const MAX_MESSAGE_CHARS = 16 * 1024;

/** How many fires a response embeds as messages; past this only the counter grows. */
export const MAX_RESPONSE_ALERTS = 200;

/**
 * A response: what an automation opens INSTEAD of a run per fire. The first fire starts the
 * run and (when the automation names a chatroom) binds the room; later fires for the same slot
 * (`key`) join it as inbox messages; the first human message flips it to `attended`; it closes when the run does, with
 * the run's terminal state as the reason, or when a person closes it (which cancels the run).
 * The response is the durable thing; the run is an attempt at it.
 */
export interface Response {
  id: string;
  automationId: string;
  taskId: string;
  runId: string;
  chatroomId: string | null;
  state: "open" | "attended" | "closed";
  /**
   * The slot this response holds among its automation's open ones (`ResponseCorrelation`): ""
   * for the automation-wide slot, the fire's `signal.key` under `"key"` correlation, the opening
   * fire's event id under `"fire"`. At most one response per (automation, key) is open at once.
   */
  key: string;
  /** What the opening fire said it was about (`FireSignal.title`), when it said; untrusted. */
  title: string | null;
  /**
   * Whether the response opened in a conversation shared with the automation's others
   * (`ResponseConversation`), as its policy said then. Only a shared one is continued by the
   * next shared response: one opened per-response sits in a topic named for its own fire, and a
   * policy switched to shared starts its conversation afresh rather than taking over that one.
   */
  conversation: ResponseConversation;
  /** Every fire that arrived for this response, embedded or not. */
  alerts: number;
  openedAt: string;
  lastAlertAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  /** The run's terminal state, or "closed-by-user". */
  closedReason: string | null;
}

/**
 * One repository of a run's checkout — the same record the runner's `RepoEntry` is, in two
 * readings. On a `Task` it carries the upstream URL as the user named it (the user-facing
 * truth, what the forge fetches); on the run's frozen `WorkItem` it carries what the run
 * actually clones — the gateway's per-run member URL and the normalized base branch. Two
 * facts, one shape, and both credential-free: the archivable-verbatim invariant holds.
 *
 * `path` is the directory under the checkout root the clone lives in and how the agent, the
 * prompt and every patch address the repo; unique within the run. `branchNamespace` is the run's
 * branch NAMESPACE in this repo — one string across the whole run today, and the type is per entry
 * so the day one repo's namespace differs is a value change, not a shape change. No branch is
 * named the namespace itself: every LINE of work in the repo ships on `<namespace>/<line>`
 * (@ryph/shared/lines).
 * Every new entry is a connected repo: a task checks out nothing else. `connectedRepoId` is null
 * only on a LEGACY entry, stored before that rule (a raw git URL): such a task is history, read
 * and shown, never acted on again: every action that needs the repo refuses it (core/legacy.ts).
 */
export interface RepoEntry {
  connectedRepoId: string | null;
  /** What the agent is told the repo is called: "owner/name" for a connected repo. */
  name: string;
  url: string;
  ref: string;
  /**
   * The branch the work on `ref` merges into, where that is not `ref` itself: a change
   * request's base. The gateway refreshes it beside `ref`, so the run's clone holds it as
   * `origin/<target>` and can merge it to catch up. Absent for a run that starts from its own
   * base, whose target IS `ref`.
   */
  targetRef?: string;
  /**
   * `ref` is a fork pull request's head (`refs/pull/<n>/head`, fetched from the base repo): a
   * contributor's files. Everything ryph configures a run from — services, checks, the machine,
   * setup steps, context files, skills — comes from the repo's default branch instead, or not at
   * all (the runner reads nothing of `.ryph/` in such a checkout). Derived in `startTask` for
   * any `ref` that is not a branch of the repo, whichever door handed it over.
   */
  forkHead?: boolean;
  /** The forge the repo lives on, for the run's work item only (`composeWorkItem`): the runner
   * names its change requests after it. A task's own entries leave it out. */
  provider?: ForgeProvider;
  path: string;
  branchNamespace: string;
  /** What the repo IS, in a person's words — the answer to "which repo does this belong in". */
  description: string | null;
}

/**
 * A saved, named list of connected repos that belong together — a backend and its frontend —
 * checked out together by every task that targets the workspace, and by a `/ryph` command on
 * an issue in any of its repos. Archived like an agent: the row stays so a historical run
 * resolves what it named.
 */
export interface Workspace {
  id: string;
  name: string;
  /** Shown to the agent above the per-repo lines, when set. */
  description: string | null;
  /** The size class a workspace run gets (core/run_sizes.ts), by name. Null: the deployment's
   * default. Set by an admin only — the cost is the operator's. */
  sizeClass: string | null;
  /**
   * The member whose `.ryph/Dockerfile` defines the workspace's machine — one repo's, because
   * two machines cannot be merged. Null, or a
   * repo that is no longer a member: the first member. Every member's checkout and setup.yml
   * are baked regardless. Set by an admin only, like the size class.
   */
  environmentRepoId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One repo's membership in a workspace. A connected repo belongs to at most one workspace —
 * that is what makes "the workspace holding this repo" a question with one answer, which the
 * forge expansion needs. `path` is the directory the repo is checked out under, unique within
 * the workspace (the repo's name in slug form unless overridden).
 */
export interface WorkspaceRepo {
  workspaceId: string;
  connectedRepoId: string;
  /** Null: the repo's default branch. */
  ref: string | null;
  path: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The repo a task or a fire works on when it is not a workspace. */
export type AutomationTarget =
  | { kind: "repo"; connectedRepoId: string; ref: string | null }
  | { kind: "workspace"; workspaceId: string };

/**
 * What rides WorkItem.harness on the wire. Deliberately open: the orchestrator only decides
 * which agent-container image to spin up (an image pre-bakes one harness + the runner) and —
 * when the agent has a model policy — which provider/model the harness should drive. How the
 * harness does that is the image's business.
 */
export interface HarnessSpec {
  kind: string;
  provider?: string;
  model?: string;
  /** How hard the model is asked to think (pi's `--thinking`); absent: the harness's default. */
  thinking?: ThinkingLevel;
}

/**
 * pi's thinking levels (pi-ai's `ModelThinkingLevel`), least to most: what an agent's default
 * and a task's pick are spelled in, and what rides `HarnessSpec.thinking` to the runner. The
 * list is @ryph/model-proxy's `THINKING_LEVELS`, spelled here rather than imported so this core
 * stays free of the proxy package (tests/http_api_test.ts pins the two together). Which levels a
 * MODEL takes is the proxy's knowledge, on its provider list; nothing here refuses a level on
 * those grounds — pi clamps one a model does not take to the nearest it does.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** `"*"` allows every model the provider serves; a list is an exact allowlist. */
export type AllowedModels = string[] | "*";

/**
 * Which provider key an agent spends and what it may spend it on — part of the editable
 * blueprint. The key is referenced BY ID only: the secret lives sealed in the model-proxy's
 * tables and never appears in a core type, per the invariant above. Rotating the key's secret
 * under the same id changes nothing here.
 */
export interface ModelPolicy {
  /** The provider key (a @ryph/model-proxy row) this agent's runs are backed by. */
  providerKeyId: string;
  /** Denormalized from the key at assignment for validation and the harness spec. */
  provider: string;
  allowedModels: AllowedModels;
  /** Used when a task names no model; null falls back to the harness's own default. */
  defaultModel: string | null;
  /** Used when a task names no thinking level; null falls back to the harness's own default. */
  defaultThinking: ThinkingLevel | null;
}

/**
 * A run's model access, frozen at provision time like every other snapshot: editing the
 * agent's policy mid-run never changes what an in-flight run may call. (Whether the backing
 * provider key still EXISTS is deliberately live — archiving a key cuts off in-flight runs.)
 */
export interface RunModelScope {
  providerKeyId: string;
  provider: string;
  allowedModels: AllowedModels;
  /** The model chosen for this run (task override, else the policy default), if any. */
  model: string | null;
  /** The thinking level chosen for this run, by the same rule as `model`, if any. */
  thinking: ThinkingLevel | null;
}

/** `"*"` allows every tool the server reports; a list is an exact allowlist of tool names. */
export type AllowedTools = string[] | "*";

/**
 * Which MCP servers an agent may reach and which of their tools it may call — the sibling of
 * ModelPolicy, and the same rule: references BY ID only, never a secret. The server's URL and
 * credential live sealed in the mcp-gateway's tables; rotating the credential under the same id
 * changes nothing here, and archiving the server cuts off every run scoped to it.
 */
export interface ToolPolicy {
  servers: Array<{
    /** An mcp_servers row (a @ryph/mcp-gateway record). */
    serverId: string;
    allowedTools: AllowedTools;
  }>;
}

/**
 * A run's tool access, frozen at provision time beside modelScope: editing the agent's tool
 * policy mid-run never changes what an in-flight run may call. Whether each server still EXISTS
 * unarchived is deliberately live, decided by the gateway on every call.
 */
export interface RunToolScope {
  servers: Array<{ serverId: string; allowedTools: AllowedTools }>;
}

/**
 * Whether an agent remembers, and how much of it rides into each run — part of the editable
 * blueprint, beside the system prompt. `budgetTokens` bounds the brief composed at task start;
 * the platform's memory server joins the run's tool scope by default while this is set. Null:
 * no brief, no memory tools — the run starts and ends knowing nothing of previous runs.
 */
export interface MemoryPolicy {
  budgetTokens: number;
  /** Read and propose only memories addressed to this agent, never the shared canon. */
  agentOnly?: boolean;
}

/** What an agent gets when nobody said otherwise. */
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = { budgetTokens: 2_000 };

/** Where a thread-scoped write may land: only the thread the run came from (and issues the run
 * opened itself), or any thread of a repo in scope. */
export type ForgeWhere = "origin" | "any";

/**
 * Which forge actions an agent's runs may take, on which repos — the sibling of toolPolicy and
 * memoryPolicy, and the ONLY place forge capabilities are decided.
 * References and limits only, never a secret: the forge acts as its own App with credentials no
 * other process holds. Every write carries a cap, because the model loop is exactly the thing
 * that files forty identical issues. Null on the agent: no forge tools at all.
 */
export interface ForgePolicy {
  /** "run": the connected repos the run itself checks out. A list: those connected repos,
   * whether or not the run checks them out. */
  repos: "run" | { connectedRepoIds: string[] };
  /** get_* and list_* on issues and change requests. False means those tools are absent, NOT
   * that a run learns nothing about a repo: a write capability's pre-checks answer live facts in
   * their refusals — which labels a repo has, whether a thread is an issue or a change request,
   * which lines of a diff a remark could anchor to. Nothing private to the code, but not
   * nothing. */
  read: boolean;
  createIssues: { max: number } | null;
  /** add_comment. */
  comment: { where: ForgeWhere; max: number } | null;
  /** submit_review — change requests only; the cap counts reviews, not their remarks. */
  review: { where: ForgeWhere; max: number } | null;
  /** close_issue — issues only, never a change request; an optional closing note rides the same
   * write and counts once. Granting this therefore grants one agent-authored comment per close,
   * even where `comment` is null: closing with a note is one act, not a licence to comment. */
  closeIssues: { where: ForgeWhere; max: number } | null;
  /** Labels create_issue and add_labels may apply. Empty: no labelling. The forge checks each
   * already exists on the repo: the allowlist names labels, it never creates them. add_labels
   * is repo-wide — unlike `comment` and `review` it takes no `where`, so a run may label any
   * thread of a repo in scope; the allowlist is the decision. Its cap is the fixed
   * LABEL_ACTIONS_MAX, not one the policy sets. */
  labels: string[];
}

/** The ceiling on every per-run cap a forge policy may set. */
export const MAX_FORGE_CAP = 50;

/** The capabilities half of a forge policy — what rides the run's frozen scope. */
export type ForgeCapabilities = Pick<
  ForgePolicy,
  "read" | "createIssues" | "comment" | "review" | "closeIssues" | "labels"
>;

/** A forge thread in a repo of a run's scope: an issue or a change request, by the address its
 * forge spells it with ("12" on GitHub, a collaborative-object id on Radicle). */
export interface ForgeScopeThread {
  connectedRepoId: string;
  kind: "issue" | "change_request";
  ref: string;
}

/**
 * The conversation a run was started from — what a later command there finds, to reach the run
 * instead of starting a second one beside it. A forge thread (a `/ryph` command, or the change
 * request a task works on) or a chat thread (a mention of the bot in a command room, keyed by the
 * platform's `threadKey` — on Zulip the id of the mention that started it, on Slack the thread's
 * channel and root, on Discord the thread's parent channel and id, on Telegram "").
 *
 * One thread, one run, on both sides: the same agent named again is a message to the live run,
 * a different one is refused out loud until the first finishes.
 */
export type OriginConversation =
  | { kind: "forge"; connectedRepoId: string; threadKind: "issue" | "change_request"; ref: string }
  | { kind: "chat"; chatroomId: string; threadKey: string };

/**
 * A run's forge access, frozen at provision time beside toolScope: the agent's forge policy
 * resolved against THIS run — its repos, the thread it came from, who asked. The forge resolves
 * the run to this (plus the live ledger) on every tool call and enforces it; it decides nothing.
 * Whether each repo is still connected is deliberately live, like everything else a grant names.
 */
export interface RunForgeScope {
  repos: ForgeScopeRepo[];
  /**
   * The connected repos the run CHECKS OUT — what it holds the source of, which is not what it
   * may write to. Carried beside `repos` because a `repos: {connectedRepoIds}` policy replaces
   * the checkout in `repos` rather than adding to it, and the forge's visibility rule (private
   * source must not reach a public repo) is decided on both lists together. May be empty, and
   * may overlap `repos`.
   */
  sourceRepos: ForgeScopeRepo[];
  /** The thread a /ryph command came from, or the task's target change request; null otherwise
   * — including for a run started from a chat thread: nothing in the forge is "the thread this
   * run came from" then. */
  origin: ForgeScopeThread | null;
  /** Change requests checked out at start or by retargeting; comment access only. Absent on
   * older runs. Kept independently of origin and of the task's current target. */
  workedChangeRequests?: Array<{ connectedRepoId: string; ref: string }>;
  capabilities: ForgeCapabilities;
  /** What the footer on every write says: the agent, the run page, who asked. */
  provenance: {
    agentName: string;
    runUrl: string | null;
    /** The requester's forge login — null for a chat-started run, whose requester of record is
     * the room's owner and not the one who asked. */
    requestedBy: string | null;
    /** A chat-started run's commander, by sanitized display name; null otherwise. */
    requestedVia: string | null;
  };
}

/** One repo of a run's forge scope, frozen with everything the forge needs to act on it:
 * which forge, the address there, and the tenant to act as (null where the forge has none). */
export interface ForgeScopeRepo {
  connectedRepoId: string;
  provider: ForgeProvider;
  repoRef: string;
  tenantId: string | null;
  /** A GitLab project's id, filled in from the live row when the grant is resolved — never
   * frozen: the forge addresses the project by it, wherever its path has moved. */
  forgeId?: string;
}

/** The forge tools a run may be granted — bare names; the agent sees them as `forge__<name>`. */
export type ForgeReadTool =
  | "get_issue"
  | "list_issues"
  | "get_change_request"
  | "compare_change_request"
  | "list_change_requests";
export type ForgeWriteTool =
  | "create_issue"
  | "add_comment"
  | "add_labels"
  | "submit_review"
  | "close_issue";

/**
 * One write a run's agent asked the forge to make — the ledger the caps are counted in and the
 * dedupe anchor a lost response is reconciled against. Reserved BEFORE the write is attempted,
 * completed after: a row left `reserved` is a write whose outcome nobody learned.
 */
export interface ForgeToolAction {
  id: string;
  runId: string;
  tool: ForgeWriteTool;
  connectedRepoId: string;
  /** Which forge the write went to. Denormalized beside `repoRef` for the same reason it is:
   * a reader needs it to spell the address back, and a disconnected repo answers nothing. */
  provider: ForgeProvider;
  /** Denormalized at reserve time, for the trail — the repo may be renamed or disconnected. */
  repoRef: string;
  /** The thread written to, as its forge spells it; null for create_issue. */
  threadRef: string | null;
  state: "reserved" | "done" | "failed";
  /** What the write created, on the forge — the trail links to it. */
  url: string | null;
  /** The issue create_issue opened — what lets an "origin" run comment on it afterwards. */
  createdThreadRef: string | null;
  /** Why a failed write failed, in the forge's words. */
  detail: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * A repo-declared service container the run reaches BY NAME — `db:5433`, never `localhost:5433`.
 *
 * Resolved against the catalogue and the operator's policy long before it gets here
 * (core/services.ts): `image` is a digest-pinned ref this deployment allows, never the repo's
 * string, and `security` is the catalogue's, never the repo's. Empty for every ordinary run.
 */
export interface ServiceSpec {
  /** An RFC 1035 label. THIS IS THE HOSTNAME, on every backend that can do this at all. */
  name: string;
  image: string;
  command?: string[];
  /** Settings only, never a credential: a service's env is visible to anyone who can inspect
   * the container or read the run's row. These are values the repo committed. It does NOT
   * reach the agent's prompt — http/runner_api.ts narrows a service to name, port and image. */
  env: Record<string, string>;
  /** What the run dials, and what the runner's health gate waits on. */
  port: number;
  /** Added on top of `drop: ALL`. See core/services.ts on why this is per-image knowledge and
   * therefore why a catalogue exists at all. */
  security: { capabilities: string[]; allowPrivilegeEscalation: false };
  /** Docker's spelling (`1`, `1g`); the kubernetes adapter converts. */
  resources: { cpus: string; memory: string };
}

/**
 * A run's service containers, frozen at provision time beside modelScope and toolScope — and
 * for a sharper reason than those two: on Kubernetes the Pod is sealed at creation, so what a
 * run got is not merely "decided once", it is unchangeable for the run's whole life.
 */
export interface RunServices {
  services: ServiceSpec[];
  /**
   * The declaration was read from a cache entry that could not be refreshed, so it may be a
   * fetch behind the tree the run cloned. Surfaced to the agent in the generated environment
   * block, because a run silently obeying yesterday's declaration is worse than a noisy one.
   */
  stale: boolean;
}

/** Where a frozen skill came from: ryph's own catalogue, or the org skills repo. A working repo's
 * skills are the runner's to find, never frozen here. */
export type SkillSource = "catalogue" | "org";

/**
 * Where any skill a run holds came from: a frozen source, or a working repo the runner found it
 * in, named by its checkout path. The runner's report reads into the same shape.
 */
export type SkillOrigin = { source: SkillSource } | { source: "repo"; path: string };

/** One skill a run was given: what pi lists to the model, and the bundle that holds its files. */
export interface RunSkill {
  name: string;
  description: string;
  source: SkillSource;
  /** The bundle's content digest (core/skills.ts `skillDigest`); the runner fetches exactly it. */
  digest: string;
}

/**
 * What a run was given, frozen at task start like every other snapshot: a sync or a toggle
 * mid-run changes nothing for it, and `GET /v1/runs/:id/spec` serves this list.
 */
export interface RunSkills {
  skills: RunSkill[];
  /** The org repo version the org skills came from; null when none did. `syncedAt` is that
   * version's sync time, and `stale` says the latest read of the repo failed after it, so the
   * run is on the last good version rather than the repo as it stands. */
  org: {
    connectedRepoId: string;
    repoRef: string;
    commit: string;
    syncId: string;
    syncedAt: string;
    stale: boolean;
  } | null;
  /** Whether the runner may add the checked-out repos' own `.agents/skills`. */
  workingRepos: boolean;
  /** What the cap leaves for working-repo skills after the frozen ones. */
  budget: { skills: number; listingBytes: number };
}

/**
 * The deployment's skill settings, as an admin left them. No stored settings means these
 * defaults: every catalogue skill on, working-repo skills allowed, and no org skills repo.
 */
export interface SkillSettings {
  /** Catalogue skills an admin turned off, by name. Checked against the shipped catalogue on
   * write; a name a later release removed is ignored on read and dropped on the next write. */
  disabledCatalogue: string[];
  /** Whether runs may load the checked-out repos' own skills at all. An agent can turn them off
   * for itself; it cannot turn them on past this. */
  workingRepoSkills: boolean;
  /** The org skills repo; null when none is connected. */
  org: SkillOrgRepo | null;
  /** When an admin last moved any of it, and who; null for the defaults. A sync moving the
   * current version is not an admin's act and leaves both alone. */
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The org skills repo as the settings hold it: one connected repo, the branch to read, and where
 * its syncs have got to. Changing the repo or the branch clears the last three, so a version of
 * the old repo or branch is never the one runs get.
 */
export interface SkillOrgRepo {
  connectedRepoId: string;
  /** The branch to read; null reads the repo's default branch. */
  branch: string | null;
  /** The version runs get: the last sync that read a tree. Moves only on a successful sync. */
  currentSyncId: string | null;
  /** When the repo was last asked, and at which commit: moved by every answer, an unchanged one
   * included, which records no sync. A failure moves neither. */
  checkedAt: string | null;
  checkedCommit: string | null;
}

export const DEFAULT_SKILL_SETTINGS: SkillSettings = {
  disabledCatalogue: [],
  workingRepoSkills: true,
  org: null,
  updatedAt: null,
  updatedBy: null,
};

/**
 * Which skills an agent's runs may load — NARROWING ONLY: every switch can turn something off
 * that the deployment allows, none can turn on what an admin turned off. Lists name what is OFF,
 * so a skill added to the catalogue or the org repo later reaches the agent without an edit.
 * Null on the agent: DEFAULT_SKILL_POLICY, resolved at each task start.
 */
export interface SkillPolicy {
  catalogue: { disabled: string[] };
  /** `enabled: false` turns the org repo off for this agent; `disabled` is kept so turning it
   * back on restores the picks. */
  org: { enabled: boolean; disabled: string[] };
  workingRepos: { enabled: boolean };
}

export const DEFAULT_SKILL_POLICY: SkillPolicy = {
  catalogue: { disabled: [] },
  org: { enabled: true, disabled: [] },
  workingRepos: { enabled: true },
};

/**
 * The editable blueprint users create and assign tasks to: an identity, an optional
 * system prompt, and the harness kind that picks which agent-container image runs it.
 * "Ada multitasks" is many concurrent runs sharing one agentId — no more machinery than that.
 */
export interface Agent {
  id: string;
  name: string;
  /** The unique, slug-shaped address commands speak (`/ryph ada …`). Defaulted from the
   * name at creation; null only on rows born before handles existed — those agents cannot be
   * addressed from a forge thread until someone edits them. */
  handle: string | null;
  email: string;
  systemPrompt: string | null;
  /** Resolved to a container image at provision time via the orchestrator's image map. */
  harnessKind: string;
  /** Which provider key this agent spends, and on which models. Null: no model access. */
  modelPolicy: ModelPolicy | null;
  /** Which MCP servers and tools this agent may call. Null: no tool access. */
  toolPolicy: ToolPolicy | null;
  /** Whether and how much this agent remembers. Null: memory off for this agent. */
  memoryPolicy: MemoryPolicy | null;
  /** Which forge actions (issues, comments, labels, review remarks) this agent may take, and
   * where. Null: no forge tools. */
  forgePolicy: ForgePolicy | null;
  /** Which skills this agent's runs may load, as switches over the deployment's. Null: the
   * defaults (`DEFAULT_SKILL_POLICY`), so a policy equal to them is stored as null. */
  skillPolicy: SkillPolicy | null;
  /**
   * Where this agent's runs may reach on the open internet, as bundle names and hosts
   * (core/egress.ts). NARROWING ONLY: a policy may name a subset of what the deployment allows
   * and never more. Null means the deployment's own ceiling, NOT "none" — the opposite of
   * toolPolicy, and deliberately: an agent with no egress cannot run `npm ci`, which almost
   * nobody wants as the unstated default. Narrowing to nothing is spelled with empty lists.
   */
  networkPolicy: NetworkPolicy | null;
  /**
   * This agent's default run limits, under the operator's ceiling (core/run_limits.ts). Null
   * means the ceiling's values, as does a null field inside — never "uncapped".
   */
  limitPolicy: RunLimits | null;
  /**
   * Whether this agent's runs may open patches. False: the run is told it cannot, holds no
   * patch tools, ships nothing at its end, and the control plane refuses any patch it reports
   * or that is still waiting from before — read live (core/patch_permission.ts). It covers
   * patches only: what the agent may SAY on a forge or in chat is its forge and tool policies'.
   * Switching it back on is an admin's.
   */
  canOpenPatches: boolean;
  /**
   * Whether this agent's runs may publish artifacts: HTML pages every member of the instance can
   * open (core/artifacts.ts). Frozen onto the run as `WorkItem.canPublishArtifacts`, which decides
   * whether the runner offers the tool; a publish is accepted only while this reads true LIVE.
   * Off by default. Switching it on takes `agents:policy`, as the browser does; off, anyone who
   * may edit the agent.
   */
  canPublishArtifacts: boolean;
  /**
   * Whether this agent's runs get a browser: a Chromium sidecar driven through MCP tools and
   * watched live from the run page. Only where the deployment can
   * give one (`RYPH_BROWSER_IMAGE` set, on a provisioner that launches it); elsewhere the run
   * starts without one and says so. Frozen onto the run at start, as `WorkItem.browser`.
   * Switching it on is an admin's (`agents:policy`); off is anyone's who may edit the agent.
   */
  browserEnabled: boolean;
  /** Soft delete only: historical tasks and runs keep resolving their agent. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How long a run may run, how much it may spend, and how many model calls it may hold open.
 * Null is no cap. The wall clock counts from launch; spend is USD at list price, as the model
 * proxy prices it; calls in flight is what the proxy holds open at once for the run.
 */
export interface RunLimits {
  wallClockMs: number | null;
  spendUsd: number | null;
  callsInFlight: number | null;
}

export const NO_RUN_LIMITS: Readonly<RunLimits> = {
  wallClockMs: null,
  spendUsd: null,
  callsInFlight: null,
};

/**
 * The memory brief as frozen onto a run: the rendered text, the ids it carries, and the
 * evidence behind the repo claims among them — a commit and paths per memory — which the runner
 * checks against its clone and reports back as stale (see runner_api's stale route). Each
 * entry names the checkout `path` of the repo the claim is about, so the runner checks it in
 * that clone and no other (two repos can share history, and a commit alone would not say which);
 * null when the claim's repo is not in this checkout, which the runner skips.
 */
export interface MemoryBrief {
  text: string;
  memoryIds: string[];
  evidence: Array<{ memoryId: string; sha: string; paths: string[]; path: string | null }>;
}

/**
 * Extra context composed for a run — mirrors the runner's InjectedContext. `brief` is what
 * memory had to say at task start, already rendered, frozen here so `GET /runs/:id/spec` serves
 * what the run was told and the UI can show exactly which brief a run received.
 */
export interface InjectedContext {
  systemPrompt?: string;
  brief?: MemoryBrief;
}

/** The user-level ask, assigned to an agent. Immutable once accepted; every attempt is a `Run`. */
export interface Task {
  id: string;
  agentId: string;
  spec: TaskSpec;
  /**
   * What the task checks out: one entry per repo, frozen at creation, with the upstream URLs
   * as the user named them. A single-repo task is a list of one. Editing a workspace later
   * changes nothing here — the same snapshot rule agents follow.
   */
  repos: RepoEntry[];
  /** The workspace the list was taken from, for display; null for a single-repo task. */
  workspaceId: string | null;
  /** Who asked. "break-glass" is recorded as a POSITIVE fact — an absence is not an audit
   * trail. "forge" is a /ryph command in a forge thread, acting for the linked user in
   * `requestedByUserId`; "automation" is a user's automation firing, acting for its owner
   * there; "chat" is a mention in a command room, acting for the room's owner there (the
   * commander who mentioned the bot is a chat identity, not a ryph user); "token" is a script
   * or an agent holding one of the user's API tokens, acting for that user. */
  origin: "user" | "break-glass" | "forge" | "automation" | "chat" | "token";
  /** The authenticated user who created the task; null only under break-glass. */
  requestedByUserId: string | null;
  /** A "chat" task's commander: the chat identity whose mention started it, by display name,
   * sanitized to plain text (`chatDisplayName`). Not a ryph user — the task acts for
   * `requestedByUserId`, the room's owner — but the one who ASKED, which is what a reader of the
   * forge footer and the pull request's provenance needs. Null for every other origin. */
  requestedVia: { name: string } | null;
  /**
   * A "chat" task's conversation, as one key every mention in it shares (`chatConversationKey`):
   * on Zulip the channel and the topic, on Slack and Discord the channel and the thread. Null on
   * Telegram,
   * whose one key is the whole group, and for every other origin. What lets a later mention in
   * the same conversation update a page an earlier one asked for (core/artifacts.ts).
   */
  chatConversation: string | null;
  /** Set: the task works ON this change request of one of its connected repos. That repo's
   * entry is checked out at the change request's head branch, and its patch updates that change
   * request rather than opening a new one; every other repo's patch opens one of its own. Only the
   * repo's DEFAULT line (@ryph/shared/lines) works it: a patch of any other line opens a change
   * request of its own. Null: every patch becomes a change request of its own. */
  targetChangeRequest: { connectedRepoId: string; thread: string } | null;
  /**
   * Where each LINE of each repo of the checkout stands after the last merge of the run's work
   * on it, by checkout path, then line — the default line under its name, any other under
   * `<runId>/<line>`, its run's alone (core/landing.ts `landingKey`). Written with the move it records, in
   * one transaction: it is what every merged cue's `onto` is read from, what the page names, and
   * what keeps a late merge of an older generation of a line from moving it back. A merge on one
   * line never touches another line's record. Empty until something merged.
   */
  landings: Record<string, Record<string, RepoLanding>>;
  /** How long the run lives past the agent's settles; see RunLifetime. */
  lifetime: RunLifetime;
  /** Set only on a task the platform authored (see TaskPurpose); null for everything else. */
  purpose: TaskPurpose | null;
  createdAt: string;
}

/** What the last merge of a run's work on one line of one repo did to the task's checkout there. */
export interface RepoLanding {
  connectedRepoId: string;
  /** The change request that merged. */
  thread: string;
  /** The branch the line moved onto, bare: the one the forge says the change request merged
   * into. Where the line's next generation starts — for the default line also the repo's `ref`
   * from then on; any other line's next base is this alone (core/landing.ts `lineBase`). */
  onto: string;
  /** The generation of the line's branch that landed. Only a later one of the same line is
   * recorded over it. */
  generation: number;
  /** Whether it moved the repo (for any line but the default: the line) — off a change request
   * the task worked, or onto another branch — rather than leaving a run's own pull request's
   * repo on the base it already had. */
  moved: boolean;
  at: string;
  /** The run whose line landed: set on every landing of a line other than the default, the same
   * run its key under the path names (core/landing.ts `landingKey`), which is what decides whose
   * it is. A line's name is the run's own — another run's `fix` is unrelated work that merely
   * shares the word. The default line's landings are the task's. */
  runId?: string;
  /** Set when no patch landed it: a RELEASE (core/merge_release.ts) of the run named here, whose
   * change request merged with nothing of the run on it. It ends that run's `generation` at the
   * path as any landing does (core/patch_lifecycle.ts `landedVerdict`). */
  releasedRun?: string;
  /** Set on a release of a run still awaiting its prompt, which takes no message before it
   * (core/inbox.ts): the release cue it is owed, appended right after the prompt in the
   * prompt's own transaction (`TaskStore.claimTaskPrompt`), which clears this. */
  releaseCueOwed?: true;
  /** The tip of `onto` the forge read when it settled the merge, set only when the change request
   * merged into `onto` itself (core/landing.ts). A next generation that does not hold it was not
   * moved onto what merged (core/open_patch.ts). Absent where the forge read none. */
  tip?: string;
}

/** Per-connected-repo policy: does a patch need a human before it reaches the forge? */
export type SubmissionPolicy = "require-approval" | "auto";

/** Which forge a repo lives on. Every path that acts on a repo resolves its adapter from
 * this; the connected repo's row is where it comes from. `local` is a git repository on the
 * forge's own disk: no API, no threads, no identities — only git, through the gateway. */
export type ForgeProvider = "github" | "gitlab" | "radicle" | "local";

/**
 * A repo connected by an admin. `provider` says which forge it lives on and `repoRef` is its
 * address THERE, opaque outside that forge's adapter. Permissions are checked LIVE against the
 * forge (never mirrored — a stale permission row is a security bug), so this row carries
 * coordinates and policy, nothing about who may do what.
 */
export interface ConnectedRepo {
  id: string;
  provider: ForgeProvider;
  /** The GitHub App installation this repo was granted through — the tenant the boundary acts
   * as. Null for a forge with no tenants at all, where ryph writes with its own key, and for
   * every GitHub repo when the forge acts through a user token (GitHub's user mode). */
  installationId: string | null;
  /** "owner/name" on GitHub, a `rad:z…` RID on Radicle, the repository's absolute real path
   * on a `local` forge — the forge-side coordinates. */
  repoRef: string;
  /** The upstream clone URL the gateway fetches from — on `local`, the same path as
   * `repoRef`. */
  url: string;
  /** The repo's default branch, the fallback base for tasks that don't name a ref. */
  defaultBranch: string;
  submissionPolicy: SubmissionPolicy;
  /** The size class a run on this repo alone gets (core/run_sizes.ts), by name. Null: the
   * deployment's default. Set by an admin only — the cost is the operator's. */
  sizeClass: string | null;
  /** May runs push onto the branches of this repo's pull requests from forks? Off by default.
   * A run on a fork pull request checks out the fork's head either way; this decides only
   * whether its commits may land there, and GitHub has the last word at the push (the author's
   * "Allow edits from maintainers", the App's permissions). Set by a repo admin. */
  allowForkPushes: boolean;
  /** Soft delete: disconnecting stops new tasks; history keeps resolving. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * A GitLab project's id ON THE INSTANCE IT WAS CONNECTED ON, `<id>@<url>`
   * (`GitlabProject.projectId` at `.instance`), read with the row — set on every GitLab repo,
   * absent everywhere else. What the forge addresses the project by (`forgeRepoRef`): the path
   * in `repoRef` is only where it lives today, and a renamed project's old path can be taken by
   * anybody's new one. The forge refuses an id on another instance than its own, so a row from
   * before `RYPH_GITLAB_URL` changed reaches nobody. Never written through the row.
   */
  forgeId?: string;
}

/** A GitHub App installation — the tenant. Recorded when the install flow lands back on us. */
export interface GithubInstallation {
  id: string;
  /** GitHub's numeric installation id, as text (it rides URLs and API calls). */
  installationId: string;
  /** The org or user the App is installed on. */
  accountLogin: string;
  createdAt: string;
}

/**
 * One identity an admin has allowed to command agents in one connected repo, beside whatever
 * write access the forge itself reports. It exists because not every forge HAS a write tier to
 * borrow: Radicle knows delegates and nothing between them and a stranger.
 */
export interface RepoCommandAllowlistEntry {
  connectedRepoId: string;
  provider: ForgeProvider;
  /** The identity as the provider names it — a login on GitHub, a DID on Radicle, matching the
   * `login` of the linked identity auth holds. */
  subject: string;
  /** The admin who added it — an absence would be no audit trail. */
  addedBy: string;
  createdAt: string;
}

/**
 * What a connected GitLab project is beyond its row: GitLab's numeric project id — the repo's
 * identity there, where the path is only where it lives today (a project can be renamed or
 * moved, and its old path reused) — and its webhook's state in bot mode. The token a Maintainer
 * pastes is derived for (project id, `hookGeneration`); rotating it bumps the generation, and a
 * delivery at any other is refused. One per connected repo, written at connect.
 */
export interface GitlabProject {
  connectedRepoId: string;
  /** GitLab's numeric project id, as text: what the webhook URL names and its token is bound
   * to, and what an inbound event is matched on. */
  projectId: string;
  /** The instance the id is GitLab's on — `RYPH_GITLAB_URL` as the forge spelled it at connect.
   * Ids are per instance: once the deployment points at another one, this row names a project
   * nobody connected, and every path treats it as disconnected (no event matches it, the forge
   * refuses its `forgeId`). */
  instance: string;
  /** The webhook token's generation, from 1. Higher than any earlier connection of the same
   * project ever held, so a token from before an archive does not come back to life. */
  hookGeneration: number;
  /** When a delivery at the current generation was last admitted; null while none ever was.
   * Recorded at most once a minute (`HOOK_DELIVERY_RESOLUTION_MS`). */
  lastHookAt: string | null;
  /** As `lastHookAt`, for Merge Request Hook deliveries alone — the only ones a merge arrives
   * as. A hook can ring for pushes and notes all day with "Merge request events" unticked, so
   * the merge poll's silence check (core/merge_poll.ts) reads this, never `lastHookAt`. */
  lastMergeRequestHookAt: string | null;
  /** How many deliveries at the current generation the forge's door dropped over the project's
   * budgets — acknowledged to GitLab, never stored — counted apart by budget: comments (Note
   * Hooks, the `/ryph` commands nothing else recovers) and every other event (merge requests and
   * pushes, which the merge poll and the reconcile also catch). And when the last of either was
   * reported. A busy project, or a token holder flooding it; either way those events never
   * reached ryph. */
  droppedCommentHookCount: number;
  droppedOtherHookCount: number;
  lastDroppedHookAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Which of a GitLab project's budgets at the forge's door a dropped delivery was over: comments
 * (Note Hooks) or every other event — each its own, so the repo page says which were lost. */
export type GitlabHookLane = "comments" | "other";

/**
 * A normalized forge event, as the forge boundary delivers it to POST /v1/forge/events:
 * already HMAC-verified and schema-trimmed over there, already forge-agnostic. Every decision
 * — dedupe, command parsing, authorization, starting work — happens here against this shape.
 */
export interface InboundForgeEvent {
  /** The forge's delivery id — the idempotency key. */
  deliveryId: string;
  /** Dotted forge-agnostic form, e.g. "issue_comment.created". */
  kind: string;
  /**
   * Which repo it is about. `provider` and `repoRef` are what a connected repo is MATCHED on —
   * exactly, because a RID is base58 and case is meaning there, so normalizing one the way a
   * URL is normalized would merge two repos. `url` rides along for the log.
   */
  repo: {
    provider: ForgeProvider;
    repoRef: string;
    url: string;
    /** GitLab's numeric project id, the scope the webhook's token was verified for — what a
     * GitLab event is matched on (`GitlabProject.projectId`); `repoRef` is then the path the
     * forge read for it just now. Absent for every other forge. */
    forgeId?: string;
  };
  /** Who caused it, as their forge names them — a login on GitHub, a DID on Radicle.
   * Untrusted until checked live. */
  actorLogin: string;
  /** The actor's stable account id on the forge, where the forge read one (GitLab's user id):
   * a person is resolved by it, since a login can be renamed and handed on. */
  actorId?: string;
  thread: { kind: "issue" | "change_request"; ref: string } | null;
  /** The instruction-bearing text, when the event carries one. Untrusted by definition. */
  body: string | null;
  /** The forge-side id of the comment the event came from — the 👀 target. */
  sourceCommentId: string | null;
  /** Set when the comment was an inline remark on a change request's diff: which remark — the
   * id a reply in its review thread names. */
  inline?: { commentId: string };
  /** Set exactly on a `branch.updated`: the repo's DEFAULT branch moved to `commit`. `ref` is
   * the bare branch name the forge called the default at the time — so a rename arrives here
   * too. No other branch is ever reported. */
  branch?: { ref: string; commit: string };
  /** Set exactly on a `check_run.rerequested`: which of our check runs was re-requested.
   * `externalId` is the one we posted it with (`<suiteId>:<generation>:<name>`), echoed back
   * by the forge — untrusted until it matches a suite on this repo and commit. */
  checkRun?: { externalId: string; headSha: string; name: string };
  /** Set exactly on a `check_suite.rerequested`: "Re-run all checks" on our runs on `headSha`.
   * It names no run; what re-runs is what we posted on that commit. */
  checkSuite?: { headSha: string };
  /** Set on a `change_request.merged`. `heads` is what merged, by commit: GitHub's
   * `pull_request.head.sha` at the merge (never the merge commit, so a squash or rebase merge
   * names what was asked to merge), or the commit of the Radicle revision the delegates merged —
   * which may be an OLDER revision than the change request's latest. A pushed head merged when
   * git says one of them holds it (`Forge.mergeContainment`: an ancestor, or its change is
   * exactly a merged head's, both ways). Empty when the forge named none: then the settle first
   * reads `mergedHeads` off the forge's read of the change request
   * (`Forge.fetchChangeRequestHead`).
   *
   * `baseRef` is the branch the forge says it merged into, bare, as the forge reported it
   * (GitHub's `base.ref` at the merge). Untrusted text until the control plane holds it to its
   * rules. Absent when the forge did not say (Radicle). */
  merged?: { baseRef?: string; heads: string[] };
  /** Set exactly on a `change_request.pushed`: the change request's head or base may have moved.
   * `ref` is `thread.ref` (a PR number, a Radicle patch id — `patches.forge_ref`'s spelling),
   * `baseRef` the bare branch it targets, `fetchRef` where its head can be fetched when a fetch
   * by id fails (`refs/pull/42/head`; null on Radicle), `url` the change request for a person
   * (https, or null). `author` is whose change request it is (GitHub's PR author, the Radicle
   * patch's author DID). `actorLogin` is who did this (the sender; the revision's author). Both
   * identities are untrusted until checked live, and the head and base are only a claim: the
   * change request is read live before anything is asked. */
  changeRequest?: {
    ref: string;
    headSha: string;
    baseRef: string;
    fetchRef: string | null;
    url: string | null;
    author: string;
    /** The author's stable account id where the forge read one (GitLab's user id): the
     * permission gate asks about it, never the login, on a forge whose logins move. */
    authorId?: string;
    /** The head this push moved the change request away from (GitHub's `synchronize`
     * `before`); null otherwise. */
    before: string | null;
  };
  receivedAt: string;
}

/** What a fire says of itself: something is wrong, it is over, or neither — or it cannot tell. */
export type SignalStatus = "firing" | "resolved" | "update" | "unknown";

/**
 * What the automations service read out of a fire's payload with the trigger's payload format,
 * so the orchestrator never parses a payload itself. A schedule's fire, and a webhook in the
 * `raw` format, says nothing: `{ status: "unknown", key: null, title: null }`. `key` names the
 * thing the fire is about (an alert group, a PagerDuty incident) and is what `"key"` correlation
 * joins on; `title` names it for people. Both are the SENDER's text — bounded, single-line,
 * untrusted — and are never more than a label.
 */
export interface FireSignal {
  status: SignalStatus;
  key: string | null;
  title: string | null;
}

/**
 * Which open response a fire joins: `"fire"` none — every fire opens its own; `"automation"`
 * the automation's one open response; `"key"` the one open for the same `signal.key`, a fire
 * with no key falling back to the automation-wide slot.
 */
export type ResponseCorrelation = "fire" | "automation" | "key";

/**
 * Where a response talks on a platform with channels: `"per-response"` a conversation of its own
 * for each, `"shared"` the one the automation's last response was in, continued (its correlation
 * is then always `"automation"`, so only one response holds it at a time).
 */
export type ResponseConversation = "per-response" | "shared";

/**
 * An automation fire, as the automations service delivers it to POST /v1/automations/events:
 * already verified (or minted by its scheduler) and composed over there from the automation's
 * stored recipe. Every decision — dedupe, authorization, starting work — happens here against
 * this shape, at fire time, so nothing stale is trusted.
 */
export interface InboundAutomationEvent {
  /** The fire's hook id — the idempotency key. */
  eventId: string;
  automationId: string;
  /** The automation's display name — the task title carries it. */
  name: string;
  /** The automation's owner. The run acts for this user, and their repo access is what the
   * permission gate checks live. */
  ownerUserId: string;
  agentId: string;
  /** A repo (with an optional ref) or a workspace — what the run checks out. */
  target: AutomationTarget;
  /** The recipe text, exactly as the owner wrote it. */
  instructions: string;
  /** The triggering payload, verbatim. Untrusted by definition — appended to the
   * instructions as fenced, framed data, never merged into them. */
  payload: string;
  /** What the fire says of itself, as the trigger's payload format read it. */
  signal: FireSignal;
  /** Set: the fire opens or joins a RESPONSE rather than starting a run of its own — the
   * chatroom to bind (or none), where in it, and the run's idle clocks. Null: a run per fire, as
   * ever. `channelId` is for a platform with channels: the platform id of the channel each
   * response opens its own conversation in, keyed on the opening line the chat service posts
   * there. Null on Telegram, whose room is one conversation. `correlation` is which open
   * response a fire joins. `postAlert` puts the opening fire's title and payload into the
   * conversation's opening line. `conversation` is whether each response opens a conversation
   * of its own in that channel or continues the one the last response was in. */
  response: {
    chatroomId: string | null;
    channelId: string | null;
    idleMs: number;
    attendedIdleMs: number;
    correlation: ResponseCorrelation;
    postAlert: boolean;
    conversation: ResponseConversation;
  } | null;
  firedAt: string;
}

/** Where an automation event's handling ended — one row per event id, the audit trail AND
 * the dedupe, exactly as `ForgeEventOutcome` is for forge deliveries. */
export type AutomationEventOutcome =
  | "processing"
  | "no-such-agent"
  | "no-such-repo"
  | "no-such-workspace"
  | "no-linked-identity"
  | "denied"
  | "refused"
  | "started"
  /** The fire joined an open response as a message; no run started. */
  | "joined"
  /** The fire reported itself resolved and no response was open, so nothing started. */
  | "resolved"
  /** The fire was a status update (acknowledged, assigned…) with no response open to hear it,
   * so nothing started: an update never starts a run. */
  | "ignored";

export interface AutomationEventRecord {
  eventId: string;
  automationId: string;
  outcome: AutomationEventOutcome;
  /** Set when the event started work. */
  taskId: string | null;
  receivedAt: string;
  /** First seen. Never revised — a redelivery changes the verdict, not when it first arrived. */
  createdAt: string;
  /** As `ForgeEventRecord.claimedAt`: the clock the crash escape fences on. */
  claimedAt: string | null;
}

/** How a chat platform shows a channel: to its members only, to every account on the server,
 * or to anyone on the internet without one. */
export type ChatChannelVisibility = "private" | "public" | "web-public";

/**
 * Who may command agents in a command room, checked on EVERY mention — starts and follow-ups
 * alike. `group` is a platform user group asked live through the chat service (membership is the
 * team's to change without telling us); `room` is everyone in the channel, and is honoured only
 * for a PRIVATE channel: on an open server "the room" is anyone with an account.
 */
export type CommandRoomCommanders = { kind: "group"; groupId: string } | { kind: "room" };

/** One channel's own target in a command room, keyed by the platform's STABLE channel id (a
 * rename keeps it); `channelName` is for display only. */
export interface CommandRoomChannel {
  channelId: string;
  channelName: string;
  target: AutomationTarget;
  createdAt: string;
  updatedAt: string;
}

/**
 * A command room: the policy that lets a mention of the bot in a chatroom START work, kept here
 * because every field names something the control plane owns. Runs act for `ownerUserId` — the
 * admin who saved the policy — whose repo access is re-checked live on every start, as an
 * automation's owner's is on every fire. A room with no policy is a response room: a mention
 * there can only talk to a run already bound to it.
 *
 * A mention's target is its channel's row, else `defaultTarget`, else the channel is not served
 * — so a room with no default is an allowlist of channels.
 */
export interface CommandRoom {
  chatroomId: string;
  ownerUserId: string;
  /** Which agents a mention may address, by the first word after the mention. Never empty. */
  agentIds: string[];
  /** The agent a mention reaches when its first word names none of the list; in `agentIds`. */
  defaultAgentId: string;
  defaultTarget: AutomationTarget | null;
  commanders: CommandRoomCommanders;
  /** Runs this room may start per rolling hour — the bound on how fast commanders spend the
   * owner's budget. Follow-ups into a live run do not count. */
  startsPerHour: number;
  channels: CommandRoomChannel[];
  createdAt: string;
  updatedAt: string;
}

/**
 * A mention of the bot, as the chat service delivers it to POST /v1/chat/mentions: already a
 * real mention by the platform's own judgement, already stripped of bot senders, normalized
 * across platforms. Every decision — policy, commanders, dedupe, starting work — happens here.
 */
export interface InboundChatMention {
  chatroomId: string;
  /** The platform's message id — with `chatroomId`, the idempotency key. */
  messageId: string;
  /** The run whose binding this mention's conversation matched, by the chat service's locate;
   * null when it matched none. A claim to check, never an authority. */
  boundRunId: string | null;
  /** The bound binding's thread key, or the key a new run here would get. */
  threadKey: string;
  channel: { id: string; name: string; visibility: ChatChannelVisibility };
  /** The conversation's current name, for display; null where the platform has none. */
  topic: string | null;
  /** The platform's id and display name for who mentioned the bot. Untrusted until checked. */
  sender: { id: string; name: string };
  /** The message with every mention of the bot removed, trimmed. May be "". Carries an
   * `imageMarker(n)` where the nth of `images` sat, and the chat service's own note where an
   * image it could not take sat. */
  text: string;
  /** Whether the message carries a file at all — an image in `images` or not. */
  hasAttachment: boolean;
  /** The images the message carried, fetched by the chat service with the bot's credential —
   * untrusted bytes, checked again here (`storeAttachment`, `startTask`). At most
   * MAX_ATTACHMENTS. */
  images: Array<{ bytes: Uint8Array }>;
  receivedAt: string;
}

/** The door's answer to one mention — what the chat service says and does about it. */
export interface ChatMentionVerdict {
  outcome:
    | "started"
    | "joined"
    | "denied"
    | "refused"
    | "not-served"
    | "rate-limited"
    | "unverifiable"
    | "no-binding"
    | "deduped";
  /** Posted into the mention's conversation by the chat service; null says nothing. */
  reply: string | null;
  /** Whether the chat service acknowledges the mention (👀 where the platform has it). */
  react: boolean;
  runId?: string;
  taskId?: string;
}

/** Where a claimed mention's handling ended — "processing" only mid-flight. */
export type ChatMentionOutcome = Exclude<ChatMentionVerdict["outcome"], "deduped"> | "processing";

/** One row per mention that reached a side effect — the dedupe and the audit trail, as
 * `ForgeEventRecord` is for forge deliveries, keyed by (chatroomId, messageId). */
export interface ChatMentionRecord {
  chatroomId: string;
  messageId: string;
  outcome: ChatMentionOutcome;
  /** Set when the mention started or joined work. */
  taskId: string | null;
  receivedAt: string;
  /** First seen. Never revised. */
  createdAt: string;
  /** As `ForgeEventRecord.claimedAt`: the clock the crash escape fences on. */
  claimedAt: string | null;
}

/** Where an inbound event's handling ended — one row per delivery id, the audit trail AND
 * the dedupe. "processing" only ever appears mid-flight; every path ends in something else. */
export type ForgeEventOutcome =
  | "processing"
  | "no-command"
  | "malformed-command"
  | "repo-not-connected"
  | "denied"
  | "no-linked-user"
  | "ambiguous-identity"
  | "no-such-agent"
  | "refused"
  | "started"
  /** The command reached the run already working this thread, as a message; nothing started. */
  | "joined"
  /** Another agent holds this thread: refused out loud, and nothing started. */
  | "thread-busy"
  /** A pull request the platform opened was merged or closed: the patch carries the fate. */
  | "patch-settled"
  /** A pull request closing that no submitted patch of ours opened. */
  | "no-such-patch"
  /** A check run's re-run button: the suite behind it gained a generation. */
  | "checks-rerun"
  /** A check run re-request naming no suite of ours, or one that cannot re-run. */
  | "no-such-suite"
  /** A push to a change request: its head is asked for checks, and reported there. */
  | "checks-requested"
  /** A push naming a head and base already asked for (a redelivery, an edit moving neither). */
  | "checks-unchanged"
  /** A push whose head is no longer the change request's live head: nothing changed. */
  | "checks-stale"
  /** A push to a change request the forge says is closed, merged or gone: its asks withdrawn. */
  | "change-request-closed"
  /** A push to a change request whose head is one of our patches': the patch asked already. */
  | "ryph-patch"
  /** A push to a change request while checks (or change-request checks) are off here. */
  | "checks-off"
  /** A push whose author may not run code here, to a repo that declares no checks. */
  | "checks-none"
  /** A push whose author may not run code here: its head waits for someone who may to approve
   * it, on the page the change request's comment links (core/check_approvals.ts). */
  | "checks-awaiting-approval"
  /** A GitLab push to a connected repo's default branch: the environments hook was told.
   * Recorded so a ring of the same commit again is answered from the record. */
  | "branch-updated";

export interface ForgeEventRecord {
  deliveryId: string;
  kind: string;
  outcome: ForgeEventOutcome;
  /** Set when the event started work. */
  taskId: string | null;
  receivedAt: string;
  /** First seen. Never revised — a redelivery changes the verdict, not when it first arrived. */
  createdAt: string;
  /**
   * When the current handler claimed this delivery, or null if nothing ever claimed it (a rung
   * that decided before the claim). This is the clock the crash escape fences on and the one
   * adoption moves, which is exactly why it cannot be `createdAt`.
   */
  claimedAt: string | null;
}

/**
 * The one comment a forge-triggered run keeps editing: posted at start, updated on phase
 * changes and conclusion (the progress sweep reads `lastPosted` to know whether an edit is
 * due). `concludedAt` closes the row — later sweeps skip it.
 */
export interface ProgressComment {
  runId: string;
  taskId: string;
  connectedRepoId: string;
  threadKind: "issue" | "change_request";
  threadRef: string;
  /** The forge-side comment id updates are addressed to. */
  commentId: string;
  lastPosted: { state: RunState; phase: Phase | null };
  /** Consecutive FAILED edits since the last one that landed. The sweep's retry budget:
   * a comment deleted forge-side would otherwise be re-edited every tick, forever. */
  attempts: number;
  concludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One attempt at a task, and the orchestrator's unit of tracking.
 * Separate from Task even while it is 1:1 so a future retry is an insert, not a migration.
 */
export interface Run {
  id: string;
  taskId: string;
  /** Denormalized from the task so per-agent views are one indexed filter, no join. */
  agentId: string;
  state: RunState;
  /** Last phase a heartbeat reported — the gauge, not the history. */
  phase: Phase | null;
  /** Monotonic guard: a heartbeat with seq <= this is stale and never rolls state back. */
  heartbeatSeq: number;
  /** Orchestrator receive time, never runner clocks — clock skew stays the runner's problem. */
  lastHeartbeatAt: string | null;
  desiredState: "cancelled" | null;
  cancelRequestedAt: string | null;
  /** Whether a person has spoken to this run — the first `user` or `chat` message flips it,
   * and with it the idle clock. "Is anyone with her" is the first thing an engineer asks. */
  attended: boolean;
  /** When the runner's idle clock runs out, as it last advertised on a heartbeat; null while
   * the agent works, or before it first settled. The reaper backstops it. */
  idleDeadlineAt: string | null;
  /** Runner-reported settled state; absent on runs from before this gauge existed. */
  idleState?: "idle" | "waiting-for-user" | null;
  /**
   * The outcome the agent last declared through its `finish` or `report_outcome` tool, as the
   * runner carries it on every beat once said; null until it has said one, and again once a
   * message reached the agent since, until it says another. What a person's finish waits on
   * (core/finish_run.ts): the run page offers it once this is `success` or `no-changes`. Only
   * that: how the run concludes is the runner's result. Absent on rows read by a store that
   * predates it.
   */
  declaredOutcome?: DeclaredOutcome | null;
  /**
   * Whether the agent called its `finish` tool, as the runner carries it on every beat after.
   * Its own finish may be held for a check verdict for a long while, and the run finalizes after
   * it, so a person's finish is refused from here on (core/finish_run.ts). Absent on rows read
   * by a store that predates it.
   */
  agentFinished?: boolean;
  /**
   * The forge thread this run was commanded from, denormalized off `forgeScope.origin` — which
   * is jsonb, shaped by the agent's forge POLICY, and so can be null for a run that still holds
   * a thread. These three carry the fact on their own and are indexed, because "is an agent
   * already working this thread" is asked on every `/ryph` and must be one filter, no join —
   * the same reason `agentId` is denormalized here, and the join check needs that too.
   */
  originThreadRepoId: string | null;
  originThreadKind: "issue" | "change_request" | null;
  originThreadRef: string | null;
  /**
   * The chat thread this run was started from — a mention in a command room — denormalized for
   * the same reason as the three above: "is an agent already working this topic" is asked on
   * every mention. Both set, or both null; never set beside the forge three (a run has one
   * origin conversation). See `OriginConversation` and `originConversationOf`.
   */
  originChatroomId: string | null;
  originThreadKey: string | null;
  /** SHA-256 hex of the per-run bearer token the runner authenticates with. */
  tokenHash: string;
  /** The credential this orchestrator presents to the runner's cancel endpoint. */
  controlToken: string;
  /** Provisioner-specific handle (e.g. a docker container id); null until launch succeeds. */
  handle: string | null;
  /**
   * When the provisioner handed back a handle — null until launch succeeds, and set in the same
   * breath as `handle`.
   *
   * It exists because the startup grace asks "has the container come up YET", and the only
   * honest zero for that question is the moment the container was asked to exist. `createdAt`
   * was standing in for it, which is the same instant ONLY when a run launches as soon as it is
   * created. A run that waits for its environment to build does not: it sat for 13 minutes on
   * 2026-09-21, launched, and was marked lost in the same second, because the whole wait counted
   * as silence against a ten-minute grace. Every run that waited out a build died that way, and
   * the wait is the feature.
   */
  launchedAt: string | null;
  /** The run's branch NAMESPACE (helpers/ids.ts `branchNameFor`) — the same string in every repo
   * of the checkout, so "the run's branches" means one thing across them: each line it ships in a
   * repo is `<namespace>/<line>` (@ryph/shared/lines). */
  branchNamespace: string;
  // The fields below are SNAPSHOTS, frozen at provision time. Agents are editable, so
  // recomposing from live task+agent rows would drift mid-run; what a run was asked to
  // do is decided exactly once.
  /** The concrete image ref that was launched — an environment's digest-pinned image, or the
   * deployment's default image; null when unresolved (manual dev, or still waiting on a build). */
  image: string | null;
  /**
   * The environment the run launched on (`environments.id`), or the one it is waiting for while
   * `environmentWait` is set. Null: the default image, or environments are off. A real column
   * rather than only inside `environment`, because retention asks "does a live run reference
   * this image" of every candidate.
   */
  environmentId: string | null;
  /**
   * What the run's machine is, frozen when it launched — served verbatim as the spec's
   * `environment` (the runner adopts a baked checkout from it, and prepends the environment
   * block from it). A snapshot rather than a join, because retention may retire the row long
   * before anyone stops reading this run. Null only where environments are off.
   */
  environment: RunEnvironment | null;
  /**
   * Set while the run sits in `starting` without a container because the environment it needs
   * is still being built (the "wait" rows of the resolution table). Cleared when the build
   * settles: the run launches, or is refused with the build's log tail.
   */
  environmentWait: RunEnvironmentWait | null;
  /** Served verbatim by GET /runs/:id/spec — the run's spec never recomposes or drifts. */
  workItem: WorkItem;
  injectedContext: InjectedContext | null;
  /**
   * Which provider key the run may spend and which models it may call. Boot-time credentials
   * are minted from this frozen scope; null when the run calls no models.
   */
  modelScope: RunModelScope | null;
  /**
   * Which MCP servers and tools the run may call. The virtual MCP token is minted from this at
   * boot, in the same credentials fetch as the model key; null when the run calls no tools.
   */
  toolScope: RunToolScope | null;
  /**
   * Which forge actions the run may take, where, and what its writes are signed with. The forge
   * resolves the run to this on every tool call; null when the run has no forge tools.
   */
  forgeScope: RunForgeScope | null;
  /**
   * The service containers launched alongside this run, and whether the declaration they came
   * from was stale. Null for every ordinary run — the repo declared none, or this deployment
   * does not run them.
   */
  services: RunServices | null;
  /**
   * The skills the run was given — the catalogue's and the org repo's, by digest, plus whether
   * the runner may add the checked-out repos' own — frozen in `startTask`
   * (core/skills.ts `resolveRunSkills`). Null for a harness without skills support.
   */
  skills: RunSkills | null;
  /**
   * Where this run may reach on the open internet, resolved from the agent's policy against the
   * deployment's ceiling and frozen here — so tightening the deployment's allowlist mid-run does
   * not move an in-flight run, and editing the agent's policy never does.
   *
   * Unlike modelScope and toolScope, nothing reads this again after provisioning. The proxy
   * credential is minted from the same resolution at PROVISION time and handed to the container
   * in its launch env (core/start_task.ts), not fetched at boot with the model key. What sits
   * here is the record: what the UI shows, and what a reader reconstructs the run's boundary
   * from. Worth knowing before looking for a re-mint on resume that does not exist — it would
   * also be the natural place to shorten the claim's lifetime, which today is one TTL fixed when
   * the run was provisioned.
   *
   * Never null: every run has an answer, and on a deployment claiming no boundary the answer is
   * `mode: "open"` said out loud rather than a null that could be read as "denied".
   */
  networkScope: RunNetworkScope;
  /**
   * How long this run may run, how much it may spend, and how many model calls it may hold
   * open, resolved from the ceiling, the agent and the task at creation and frozen here. The
   * sweep cancels the run past the first two; the proxy is handed the second and third.
   */
  limits: RunLimits;
  // End snapshots.

  /**
   * Hosts the egress proxy refused this run, as the proxy reported them (core/egress.ts).
   *
   * Null on a run that was never refused anything, which is almost all of them — not an empty
   * array, so the column costs nothing on the common row. Written ONLY by the store's narrow
   * append (`recordRunEgressRefusal`): a report arrives while the run is mid-setup and a
   * whole-row save would put back a run that has since heartbeat, phased or finished.
   */
  egressRefusals: EgressRefusal[] | null;

  /** The runner's terminal outcome; null until the run finishes. */
  result: RunnerResult | null;
  /**
   * When memory acknowledged how this run ended; null until it has. Memory settles a run's
   * repos that changed nothing only from this report, and nothing else will ever ask again, so
   * a report that was lost is redelivered (core/reaper.ts, sweepMemoryOutcomes). Written only
   * by the store's own mark — a whole-row save never touches it.
   */
  memoryOutcomeReportedAt: string | null;
  /**
   * When the runner's skills report landed; null until it has. The runner sends one report per
   * run, and this is what holds it to one: the store's `recordSkillsReport` claims it and appends
   * the report's events in one step, so a second report (a restarted container, or one posting
   * on its own) is refused whole rather than adding claims to the trail. Written only there — a
   * whole-row save never touches it.
   */
  skillsReportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A run's git credential toward the forge gateway, hash-only — the raw token exists in the
 * runner's memory and nowhere else, delivered by the bootstrap exchange like the run token.
 * Minted at provision time when a gateway is configured; the gateway resolves a presented token
 * against these rows (via POST /v1/forge/git-keys/resolve). READ-ONLY by construction: the
 * gateway has no write path for it to unlock, so there is no scope column to get wrong.
 */
export interface GitVirtualKey {
  id: string;
  runId: string;
  /** SHA-256 hex of the token. Never the token. */
  tokenHash: string;
  /** Backstop lifetime; the primary cutoffs are revocation on run conclusion and the
   * resolve-time refusal of terminal runs. */
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * The four terminal states after "starting"/"running" map 1:1 from the runner's `Result` statuses.
 * "lost" is the orchestrator's own verdict — heartbeats stopped and no result ever arrived —
 * so by definition it can never be reported by a runner.
 */
export type RunState =
  | "starting" // row exists, container requested, no heartbeat yet
  | "running" // heartbeats flowing
  | "succeeded"
  | "failed"
  | "errored"
  | "cancelled"
  | "lost";

/**
 * Every state, sorted: live or over. A `Record` so a new `RunState` fails to compile here until
 * someone decides which it is, and the ONE place that decision lives — `TERMINAL_STATES` and
 * `LIVE_STATES` below are both read off it, so they cannot drift apart.
 */
const RUN_STATE_IS_LIVE: Record<RunState, boolean> = {
  starting: true,
  running: true,
  succeeded: false,
  failed: false,
  errored: false,
  cancelled: false,
  lost: false,
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(
  (Object.keys(RUN_STATE_IS_LIVE) as RunState[]).filter((state) => !RUN_STATE_IS_LIVE[state]),
);

/**
 * The complement of `TERMINAL_STATES`, for queries. "Not terminal" asked as `state NOT IN
 * (…terminal)` cannot use an index, so it reads every run ever made to find the handful alive —
 * measured at 55 ms and 200 MB of buffer reads a call against 100k runs, twice per reaper tick.
 * Asked as `state IN (…live)`, `runs_by_state` answers it from the live rows alone.
 */
export const LIVE_STATES: readonly RunState[] = (Object.keys(RUN_STATE_IS_LIVE) as RunState[])
  .filter((state) => RUN_STATE_IS_LIVE[state]);

/** Mirrors the runner's `Phase`. `booting` appears only in a boot-failure result — a run that
 * died fetching its spec, before any progress could be narrated. */
export type Phase =
  | "booting"
  | "cloning"
  | "preparing"
  | "setting-up"
  | "running"
  | "finalizing";

/** Mirrors the runner's `DeclaredOutcome`: how the agent says the run went. "in-progress" says
 * required work or verification remains; only "success" and "no-changes" say it is done. */
export type DeclaredOutcome = "in-progress" | "success" | "no-changes" | "failed";

/** What a runner POSTs on a heartbeat. `seq` starts at 0 and increases by 1 per beat. */
export interface Heartbeat {
  seq: number;
  phase: Phase;
  message?: string;
  /** The runner's idle clock while the agent is settled; null clears it. */
  idleDeadlineAt?: string | null;
  idleState?: "idle" | "waiting-for-user" | null;
  /** The outcome the agent last declared; carried on every beat once said. Null once a message
   * reached the agent since, until it declares another; absent keeps what is stored. */
  declaredOutcome?: DeclaredOutcome | null;
  /** The agent called its finish tool; carried on every beat after. */
  finished?: true;
}

/** How much of a result's summary the run's status comment in its thread repeats — the agent's
 * call. "minimal": the agent already posted what it did in that thread, so the comment points at
 * the run and leaves the summary out. Absent: the summary is repeated. A pull request body
 * always carries the summary. */
export type StatusComment = "full" | "minimal";

/** Mirrors the runner's ReportedResult. There is no "rejected" status — discarding output
 * is a control-plane state transition, never a report status. `branches` is what durably
 * reached the gateway: one outcome per repo of the checkout whose branch shipped, in checkout
 * order — "work reached origin" is "at least one outcome exists", whatever the status. */
export type RunnerResult =
  | {
    status: "success";
    branches: BranchOutcome[];
    summary: string;
    statusComment?: StatusComment;
    images?: ResultImage[];
  }
  | {
    status: "cancelled";
    branches: BranchOutcome[];
    summary: string;
    statusComment?: StatusComment;
    images?: ResultImage[];
  }
  | {
    status: "failure";
    reason: string;
    summary: string;
    branches: BranchOutcome[];
    statusComment?: StatusComment;
    images?: ResultImage[];
  }
  | { status: "error"; reason: string; during: Phase; branches: BranchOutcome[] };

/**
 * An image the summary shows: a `![alt](img-…)` in it that names one of the run's tool images,
 * once per ref, in the order the summary first names them. Not the runner's to say: the control
 * plane reads them out of the summary when the result lands (core/image_refs.ts), and a ref
 * naming no image of the run is left out, so the page shows its alt text.
 */
export interface ResultImage {
  ref: string;
  attachmentId: string;
  mime: AttachmentMime;
  alt: string;
}

export interface BranchOutcome {
  /** Which repo of the checkout the branch belongs to — the entry's id and path. Null only in
   * a legacy result, stored for a raw-URL entry (see `RepoEntry`); a runner never sends one. */
  connectedRepoId: string | null;
  path: string;
  name: string;
  headSha: string;
  /** Checkout base for this generation; absent in reports from older runners. */
  baseSha?: string;
  commits: CommitInfo[];
  /** The line of the run's work in this repo the branch ships (@ryph/shared/lines): `<line>` in
   * `<namespace>/<line>`, which the name must parse to. */
  line: string;
  /** Which generation of the line's branch this is: 1 until a patch of the line lands, and one
   * more each time one does (the next branch is `<namespace>/<line>-<n>`). See
   * docs/patch-lifecycle.md. */
  generation: number;
  /** The heads the runner shipped earlier for this path whose own work this branch holds in
   * full and that did not land themselves, by git: the head is an ancestor of this one; or the
   * whole head merges into this branch to nothing, from the newest point they share (its landed
   * head, else its base); or every commit of its own work has its change in this branch already
   * (a per-commit `merge-tree` that is clean and changes nothing) — never by author, date,
   * message or patch id. Birth maps them onto the run's patches (`Patch.carries`). */
  carries: string[];
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

/** The payload handed to a runner — @ryph/runner's WorkItem, verbatim. */
export interface WorkItem {
  /** Resolved at start for display; absent on runs created before size snapshots. */
  runSize?: import("./run_sizes.ts").RunSize;
  id: string;
  agent: AgentIdentity;
  spec: TaskSpec;
  /** What the run clones, one entry per repo — the gateway-shaped reading of the task's list. */
  repos: RepoEntry[];
  /** The workspace the list came from, for the agent's layout block; null otherwise. */
  workspace: { name: string; description: string | null } | null;
  harness: HarnessSpec;
  /** How long the run lives past the agent's settles. */
  lifetime: RunLifetime;
  /** The chat conversation the run is bound to, as the agent is told about it. Absent: the run
   * has no chat, or the chat service could not describe its room when the run started. */
  chat?: ChatContext;
  /** The agent's `canOpenPatches`, frozen here: the runner hides its patch tools and ships
   * nothing when false, and the control plane refuses any patch the run reports regardless. */
  canOpenPatches: boolean;
  /** The agent's `canPublishArtifacts`, frozen here: the runner offers `ryph__publish_artifact`
   * and pins the artifact design skill only when true. The control plane re-reads the live
   * switch on every publish regardless. */
  canPublishArtifacts: boolean;
  /** True when nobody follows the run while it works (an automation fire with no response): the
   * agent is told to finish once its work is submitted, not to wait for review. Absent: someone
   * may. */
  unattended?: true;
  /** True when a person started the task on the run page (origin "user" or "break-glass") and
   * talks to the run there: the agent is told that answering is not finishing, and to leave the
   * end to them or the idle clock. Absent: a forge, chat, automation or token start, and any
   * task with a purpose (an environment setup), whose instruction says when to finish. */
  interactive?: true;
  /**
   * The images the task arrived with — a forge thread's screenshots, a chat mention's photo —
   * in the order the spec's `[image N]` markers count them. Refs only: the runner fetches each
   * one's bytes from the runner surface, scoped to this run. Absent: the task had none.
   */
  attachments?: AttachmentRef[];
  /**
   * The browser sidecar the run was granted, and the loopback port it listens on: present only
   * when the agent has `browserEnabled` AND the deployment could give it one at start
   * (core/browser.ts). The runner configures it and hands its MCP tools to the agent; absent,
   * the run has no browser and its agent is told nothing about one.
   */
  browser?: { port: number };
}

/** The chat conversation the run is bound to, as the agent is told about it. Absent: the run
 * has no chat. */
export interface ChatContext {
  kind: "telegram" | "zulip" | "slack" | "discord";
  /** The Telegram group's title, the Zulip organization's name, the Slack workspace's, or the
   * Discord server's. */
  roomTitle: string;
  /** What people type to reach the bot: Telegram's @username (without the @), Zulip's bot full
   * name, Slack's bot handle, Discord's bot username. */
  botHandle: string;
  /** The room is quiet: a run that succeeds gets no closing line there, so the agent must post
   * its answer itself. Frozen onto the work item as `true` or absent (`tidyChat`). */
  quiet?: boolean;
}

/** Append-only audit trail: transitions only, ~10 per run — never one row per heartbeat.
 * Patch transitions land here too rather than in a `patch_events` table: the user's mental
 * model is "my run produced a PR", and the trail should tell that story in one place.
 * `patches` holds the state; `run_events` holds the story. */
export interface RunEvent {
  runId: string;
  at: string;
  kind:
    | "created"
    | "launched"
    | "launch-failed"
    /** The container redeemed the launch's one-shot bootstrap bearer. Its absence on a run that
     * then went silent says the exchange never landed; its presence, that it did. */
    | "bootstrap-redeemed"
    | "first-heartbeat"
    | "phase-changed"
    | "cancel-requested"
    | "cancel-pushed"
    | "cancel-confirmed"
    | "kill-requested"
    /** A model credential was reserved against the run's cap, then actually minted. Written by
     * the reservation itself, before the mint that follows it is known to succeed — so for the
     * narrow window between the two, a reader sees a credential that a failed mint may still
     * delete (`releaseCredentialSlot`). Accepted: the alternative is a second `for update`
     * transaction per boot fetch to append it only once minting is confirmed, and the race the
     * reservation closes (two boot fetches over-admitting under the cap) matters more than the
     * trail being strictly append-only for the rare failed mint. */
    | "credentials-issued"
    /** The runner found briefed memories whose evidence changed since they were observed; the
     * ids ride `detail`. Memory heard the same report. */
    | "memory-stale"
    /** A repo's base came from the forge's cache: every refresh from upstream had failed, so the
     * run may have started behind upstream. `detail` names the repo, the base, the commit it
     * started from and the first refresh that failed. The runner reports it once its clone learns
     * it, one event per repo. */
    | "base-stale"
    /** A repo's setup warned, and the run went on: a step failed or its setup.yml was invalid
     * (the run went on without the rest of that repo's steps — setup is an optimization, never a
     * reason not to start), or setup finished but left changes in the tree that were discarded
     * (`dirty`: its own setup's; `discarded`: after a step failed in another repo), the tree put
     * back to its start. `detail` is one summary line, opened by the warning's kind in brackets
     * (`[step]`, `[invalid]`, `[discarded]`, `[dirty]`) so a reader branches on that, never on
     * the words (the repo, the step, its exit code, how many steps were skipped, whether its
     * changes to the tree were discarded — or that setup.yml was invalid), then the end of the
     * step's output or the validation error, cleaned (core/setup_warnings.ts). The agent was
     * told the same. One report per run. */
    | "setup.failed"
    /** The run's services were resolved from a cache entry the forge could not refresh, so
     * they may be a fetch behind the tree the run cloned. Recorded because the run will look
     * inexplicable later if the declaration changed in between. */
    | "services-stale"
    /** Skills the run could not be given: a name another source already took, the listing cap,
     * a bundle the runner could not fetch, or one that did not validate. `detail` lists each
     * name, its source and why. Turning a skill off is a decision, not a drop, and is not here. */
    | "skills.dropped"
    /** The working-repo skills the runner loaded from the run's own clones; `detail` names each
     * with its repo. */
    | "skills.repo"
    /** Where the runner wrote the run's skills; `detail` is the directory. The run page names a
     * read under it as a skill's, and no other read. */
    | "skills.root"
    /** The org skills came from a version older than the repo as it stands, because the latest
     * read of the repo failed; `detail` names the commit, when it was synced and the failure. */
    | "skills.stale"
    /** The run's subject names a size class the configuration no longer defines, so the run
     * got the default class; the stale name rides `detail`. */
    | "size-class-unknown"
    /** The agent has a browser, and this deployment cannot give its run one (no
     * RYPH_BROWSER_IMAGE, a provisioner that does not launch it, or a harness with no MCP
     * client); `detail` says which. The run starts without it. */
    | "browser.unavailable"
    /** The run waits for its environment to build; the environment id and status ride
     * `detail`. The run is still `starting`, with no container, and cancellable. */
    | "environment.building"
    /** The environment the run waited for is ready; the run launches on it now. */
    | "environment.ready"
    /** The environment the run waited for failed to build; the run is refused, and the
     * build's log tail rides `detail`. */
    | "environment.failed"
    /** The environment could not be resolved or built (the forge, the builder or the registry
     * did not answer), so the run fell back to an older image or the default one — `detail`
     * says which and why. */
    | "environment.fallback"
    /** The launch found the run's environment image gone from the machine (a prune, a daemon
     * reset): that build is retired, and the run waits for a build of the environment again —
     * one already going, or a rebuild — `detail` says which. Once per run: a second image lost
     * the same way errors the run (`launch-failed`). */
    | "environment.image_missing"
    /** The egress proxy refused this run a host, and said so. `detail` is the host, the port
     * and the bundle an ADMIN could allow it with — the one trail that used to exist only in
     * the proxy's own stderr, where nobody reading the run could reach it. */
    | "egress.refused"
    /** A response's run could not be bound to its room's conversation, so the room hears
     * nothing of it; `detail` says why ("it was busy": another run holds the conversation). */
    | "chat.unbound"
    | "result-received"
    | "marked-lost"
    /** A person spoke to the run for the first time; the idle clock is the attended one now. */
    | "attended"
    /** The agent called its finish tool, as the first beat that said so carried it; `detail` is
     * the outcome it declared. */
    | "finished"
    /** A person finished the run from its page, once its agent had said it was done. Who did is
     * the sender of the finish message in the run's inbox. The run ends at the agent's next
     * settle. See core/finish_run.ts. */
    | "finish-requested"
    /** The runner's idle clock lapsed past the grace and the reaper asked the run to stop. */
    | "idle-expired"
    /** The run reached one of its limits and the reaper asked it to stop; `detail` names the
     * limit and its value (`wall-clock: 12h`, `spend: $20.00`). See core/run_limits.ts. */
    | "limit-reached"
    /** The agent checked a change request out mid-run, so one repo of the checkout moved onto
     * that change request's branch and its patches will land there. `detail` names the repo,
     * the change request and the branch it now sits on. See core/retarget.ts. */
    | "retargeted"
    /** A change request of the run's merged, and its repo moved onto the branch it merged into
     * (or, for one the run opened against its own base, stayed there); a change request the
     * task worked is done with, and the next patch opens one of its own. `detail` names the
     * change request, the repo and the branch. See core/landing.ts. */
    | "merge-landed"
    | "patch-opened"
    | "patch-approved"
    | "patch-rejected"
    | "patch-submitted"
    | "patch-submit-failed"
    | "patch-superseded"
    | "patch-settled"
    /** A patch sent back to `pending_approval` for a person, any approval cleared — for one of
     * two reasons. A `local` patch changes git hook files: `detail` lists them (core/
     * patch_lifecycle.ts `holdPatch`). Or its generation already landed through a sibling and
     * nothing newer of its branch replaces it: `detail` is the reason, as the patch shows it
     * (core/landing_rule.ts). */
    | "patch-held"
    /** The agent published an artifact, or a new version of one (core/artifacts.ts). `detail`
     * says so in prose, `Published "Title" (version 2)`; the ids are on the task's artifacts,
     * whose versions each name the run that published them. */
    | "artifact-published";
  detail?: string;
}

// ---------------------------------------------------------------------------
// The patch: one run's output on its way to a forge. See docs/patch-lifecycle.md.
// ---------------------------------------------------------------------------

/**
 * Seven states. `failed` is NOT terminal — it is "queued, with a clock and a reason": the
 * promise that a patch is durable and retryable always is a type-level guarantee, not a
 * convention. The only exits that lose work are human decisions (`rejected`) or a newer patch
 * (`superseded`).
 */
export type PatchState =
  | "pending_approval" // durable, waiting on a human — the require-approval default
  | "queued" // durable, the submitter takes it on the next sweep
  | "submitting" // a submitter holds the lease
  | "submitted" // the forge opened the PR — terminal
  | "failed" // retryable always: a clock (transient) or a human retry (terminal errors)
  | "rejected" // a human read it and said no — terminal
  | "superseded"; // a newer patch for the same task replaced it — terminal

/**
 * Every patch state, sorted once: over, moved by the submit sweep, or waiting on a person. A
 * `Record` for the reason `RUN_STATE_IS_LIVE` is one — a new state does not compile until someone
 * decides — and the one place that decision lives: both lists below are read off it.
 */
const PATCH_STATE_CLASS: Record<PatchState, "terminal" | "sweepable" | "waiting"> = {
  pending_approval: "waiting",
  queued: "sweepable",
  submitting: "sweepable",
  submitted: "terminal",
  failed: "sweepable",
  rejected: "terminal",
  superseded: "terminal",
};
const patchStatesThat = (kind: "terminal" | "sweepable") =>
  (Object.keys(PATCH_STATE_CLASS) as PatchState[]).filter((state) =>
    PATCH_STATE_CLASS[state] === kind
  );

export const TERMINAL_PATCH_STATES: ReadonlySet<PatchState> = new Set(patchStatesThat("terminal"));

/**
 * The states the submit sweep can move a patch out of (`planPatchSweep`): a queued patch to
 * submit, a lease to reclaim, a failure's clock to run out. NOT every non-terminal state:
 * `pending_approval` waits on a human and nothing else, and an approval backlog read in full
 * every reaper tick is a cost that grows with how far behind the reviewers are. The same goes
 * for a `failed` patch with no `nextAttemptAt` — a terminal error waiting on a person's retry —
 * which `listActivePatches` leaves out on that column.
 */
export const SWEEPABLE_PATCH_STATES: readonly PatchState[] = patchStatesThat("sweepable");

/**
 * What the forge did with a submitted patch's pull request, once it did. Not a patch state — the
 * submission machine ends at `submitted` — but the fact that arrives after it, from a webhook,
 * and the first place the platform learns whether its work was taken. Memory hears it as the
 * fate of the run's `introduced` claims: `merged` as landed, the others as dropped.
 * - `merged`: the change request merged, and its merge contained this patch's head (git's answer,
 *   docs/patch-lifecycle.md "Landing").
 * - `missed`: the change request merged WITHOUT this patch's head — a Radicle revision newer than
 *   the one the delegates merged, a push that reached the pull request after its merge, commits a
 *   person force-pushed away — or with a containment nobody could prove (`unproven`). A live
 *   run's agent moves its commits onto what merged.
 * - `closed`: closed without merging.
 */
export interface PatchFate {
  kind: "merged" | "missed" | "closed";
  at: string;
  /** A merge's branch as the forge's merge named it (core/merge_settle.ts `mergedBranchOf`),
   * kept with the verdict so a landing that failed after the settle can be written later
   * (`reconcileMergedLandings`) without the forge's event. Absent when it said nothing, and on a
   * close. */
  mergedInto?: string;
  /** On `missed` only: the forge never answered which heads the merge contained, and the settle
   * stopped asking (core/merge_record.ts `judgeMerge`) — not proven missed, only never proven
   * merged. */
  unproven?: true;
}

/**
 * A change request's merge as the forge reported it, kept per (repo, change request): what every
 * patch that reached the change request is judged against (core/merge_settle.ts
 * `reconcileMergeSettles`), the ones on it when the merge was heard and every push that came
 * after alike. Written by the merge event (or the merge poll's), which writes nothing else, and
 * grown, never replaced, by a later word of it: a redelivery or a later event naming more heads
 * (another Radicle delegate's merge of a newer revision, say), or the forge's read of what
 * merged, for a merge that named no head.
 */
export interface ChangeRequestMerge {
  connectedRepoId: string;
  /** `Patch.forgeRef`'s spelling. */
  forgeRef: string;
  /** The branch it merged into, as the forge named it (`mergedBranchOf`); null when it did not
   * say. The first word kept: a forge does not move a merge. */
  mergedInto: string | null;
  /** The heads its merges named (`InboundForgeEvent.merged.heads`), newest first
   * (core/merge_record.ts `grownHeads`): a patch merged when git says one of them
   * holds its head (`Forge.mergeContainment`). Empty when the forge never named one. */
  heads: string[];
  /** When the first merge was heard. */
  mergedAt: string;
  /** One more each time `heads` grew, and each time an ask started: a settle that read fewer
   * heads does not mark the record settled, nor stamp its clock, and a read from before an ask
   * never matches the record again (`TaskStore.stampChangeRequestMerge`). */
  version: number;
  /** When every patch on it was last judged against `heads`; null while one still waits — the
   * settle reconcile's working set, with any submitted patch on it that has no verdict yet. */
  settledAt: string | null;
  /** Asks since the last settle that brought no answer, refused or not (core/merge_record.ts
   * `judgeMerge`). */
  attempts: number;
  /** When the next ask about the patches owing a verdict may be made: while one is under way,
   * its deadline; after one that brought no answer, its backoff; after a settle that threw, its
   * retry. Null when an ask may be made at once (unsettled) or none is owed (settled). */
  nextAskAt: string | null;
  /** When every task that targeted the change request at its merge was let go of it, or found
   * its own run's landing to be let go by (core/merge_release.ts); null while a release may still
   * be owed — the release reconcile's working set. */
  releasedAt: string | null;
  /** When a release that threw is asked again (core/merge_release.ts), so one that keeps failing
   * never holds the rest back; null until one threw. */
  releaseRetryAt: string | null;
}

/** Who approved a submission. Break-glass is a positive record, never a null. */
export type PatchApprover = { kind: "user"; userId: string } | { kind: "break-glass" };

/**
 * A patch is durable the instant the gateway has the bundle; this row exists from the moment
 * the run's result lands (the bundle preceded it through the gateway). Approval gates
 * SUBMISSION, never persistence.
 */
export interface Patch {
  id: string;
  connectedRepoId: string;
  runId: string;
  taskId: string;
  /**
   * The set this patch belongs to: every patch born from one finalize shares it, so a change
   * that spans repos shows side by side and a reviewer approves its parts together. A set is a
   * GROUPING, never a transaction — the forge cannot land two repos atomically, and the platform
   * does not pretend otherwise. A single-repo run's patch is a set of one.
   */
  setId: string;
  /** The repo's directory in the run's checkout — how the run addressed it. */
  path: string;
  /**
   * The LINE of the run's work in this repo the patch belongs to (@ryph/shared/lines): one
   * independent stream with its own branch, generations and change request. Two lines of one
   * repo never stack on or supersede each other; everything that asks "the same stream of work"
   * keys on (task|run, path, line, generation). `work` unless the agent named another.
   */
  line: string;
  /** The branch the bundle carries — `<namespace>/<line>`, `<namespace>/<line>-<n>` past the
   * first generation. */
  branchName: string;
  /**
   * The commit the bundle was cut from, as the runner reported it at submit; null for a patch
   * born from a result report, where the runner names no base. The record of what the agent
   * built on; the submitter takes the base BRANCH from the task, never this.
   */
  baseSha: string | null;
  /** Which generation of its line's branch this patch belongs to (see BranchOutcome). */
  generation: number;
  /** The agent's own title and description for the pull request, when it gave them through
   * the submit tool; the task's title and the report stand in otherwise. */
  title: string | null;
  description: string | null;
  /** The branch's commits since its base as the runner reported them, oldest first — what the
   * pull request's report lists. A patch born mid-run has no result to read them from. */
  commits: CommitInfo[];
  /**
   * The run's earlier patches for this repo and path whose work this one carries in full: the
   * runner's `BranchOutcome.carries`, its heads mapped onto those patches at birth. What memory
   * follows a claim along, from the patch it was made on to the one that landed it — kept on the
   * row because the relays to memory are best-effort, and the fate report, which is reconciled,
   * repeats it.
   */
  carries: string[];
  /** The provenance anchor: the tip the gateway received, half of the idempotency key
   * `(connectedRepoId, headSha)` that makes a retried PR-open find-and-adopt, never double. */
  headSha: string;
  /** Where the gateway filed the bundle (`ports/patch_store.ts` key). */
  bundleKey: string;
  state: PatchState;
  /** Submission attempts so far. */
  attempts: number;
  /** Earliest next attempt (the backoff clock). Null: no clock — free to submit when queued,
   * waiting on a human when failed. */
  nextAttemptAt: string | null;
  /** While `submitting`: when the submitter's lease expires and the sweep may reclaim. */
  leaseExpiresAt: string | null;
  /** The last submission failure, for humans; cleared on success. */
  lastError: string | null;
  approvedBy: PatchApprover | null;
  approvedAt: string | null;
  /** Set once submitted: the forge-side identity of the PR ("42") and its URL. */
  forgeRef: string | null;
  forgeUrl: string | null;
  /**
   * Set once submitted: the branch the forge holds this patch's commits on — the pull request's
   * head on GitHub (the run's own branch, or the branch of the change request it was pushed
   * onto), `patches/<id>` on Radicle. Recorded at the submission because it is a fact of the
   * submission: the task's change request that decided it is done with once it merges.
   */
  forgeBranch: string | null;
  /** Set once submitted: the ref its diff was measured against when it was sent
   * (`submissionTarget`'s `diffRef`) — what a settled patch's diff is read against from then on,
   * whatever the task has moved to since. */
  diffRef: string | null;
  /** Set once the forge closed the pull request, merged or not. Null until then. */
  landed: PatchFate | null;
  /**
   * When memory acknowledged this patch's fate — the one relay whose loss strands work, because
   * the run's `introduced` claims wait on it forever and nothing else would ever ask again.
   *
   * Null while the fate is still open (the common case) AND while a settled fate has not been
   * acknowledged: the reaper's reconciliation reads exactly that difference and redelivers
   * (memory's reportChange is idempotent per run, so a redelivery costs nothing). A deployment
   * without memory leaves it null forever, and no sweep looks at it there.
   */
  memoryFateReportedAt: string | null;
  /** When the run was told this patch merged, or found to be over and so never told. Set once,
   * after the cue was posted: the cue goes out once per patch, however often the forge says it
   * merged, and a delivery that crashed before posting it leaves it null for the next one to
   * send. */
  mergedCuedAt: string | null;
  /** When a poster claimed the merged cue (a lease): of several deliveries racing to tell the
   * run, only the one that claims it posts. A claim older than the lease is free again. */
  mergedCueClaimedAt: string | null;
  /**
   * When a merged (or missed) patch's landing was asked of the store and answered — landed,
   * kept, released or none, whichever (`TaskStore.landMerge`, in its transaction). Null while
   * such a patch's landing is still owed: what the landing reconcile (core/merge_settle.ts
   * `reconcileMergedLandings`) looks for, so a landing lost to a failure after its settle is
   * written on a later sweep. Null on every patch whose change request did not merge.
   */
  landingAskedAt: string | null;
  /**
   * Why a person has to decide on this patch even where its repo needs no approval: its
   * generation already landed through a sibling, and nothing newer of its branch replaces it
   * (core/landing_rule.ts; `isLandingHold`): not approvable while its run goes on, since the run
   * may still replace it with a next patch, or end without one. Shown on the patch. Null for
   * every other patch.
   */
  heldReason: string | null;
  /**
   * Bumped by the store on every write that changes what the patch is or where it goes (not by
   * the cue or memory acknowledgements). A write conditioned on it is a write over the row exactly
   * as the caller read it: a person's decision, or the landing rule's, never lands on top of a
   * hold, a supersession or an approval it did not see. Callers never set it.
   */
  version: number;
  /** Terminal audit: which patch replaced this one. */
  supersededByPatchId: string | null;
  /**
   * What the forge said about the git hook files this patch changes — only ever set for a patch
   * on a `local` repository, and null there until the forge has been asked. A local patch lands
   * as a branch the owner will check out, and a hook file in a tracked folder (husky's `.husky/`,
   * say) runs on that checkout: an agent's code on the owner's computer. So such a patch waits
   * for a person whatever the repo's policy, and is not delivered while this is still null.
   */
  hookCheck: PatchHookCheck | null;
  /**
   * The hook files a person approved this patch with — exactly those they were shown, never
   * more (http/user_api.ts approve). Sent with every submission; the forge refuses ("held") a
   * patch touching a hook file not on it. Empty until someone approves one.
   */
  approvedHookPaths: string[];
  createdAt: string;
  updatedAt: string;
}

/** The forge's answer about a patch's git hook files (`Forge.checkPatchHooks`, or a submission
 * it held), with when it was given. */
export interface PatchHookCheck {
  /** Repo-relative hook files the patch touches, sorted, at most 50. */
  touched: string[];
  /** Where the repository keeps its hooks (`core.hooksPath` and `.git/hooks`), as the forge
   * read them. */
  hooksPaths: string[];
  /** More hook files are touched than `touched` lists. */
  more: boolean;
  at: string;
}

// ---------------------------------------------------------------------------
// Environments: the machine a run starts on.
// ---------------------------------------------------------------------------

/** Whose environment it is: a connected repo's, or a workspace's (one image per workspace). */
export type EnvironmentSubjectKind = "repo" | "workspace";

/**
 * `queued` and `building` are the live states. `ready` has an image. `failed` has a log.
 * `superseded` is retired: a newer build replaced it before it finished, or retention let a
 * ready image go — never a build that failed.
 */
export type EnvironmentStatus = "queued" | "building" | "ready" | "failed" | "superseded";

/** Why a build was asked for. */
export type EnvironmentTrigger =
  /** The default branch moved (`branch.updated`). */
  | "push"
  /** The hourly reconcile found a build an event should have asked for. */
  | "reconcile"
  /** The harness layer changed on deploy: stage 4 only. */
  | "harness"
  /** The deployment's universal image changed: a full rebuild. */
  | "base"
  /** An admin pressed Rebuild. */
  | "manual"
  /** A run needed it and waits for it — a branch environment, or a first build. */
  | "run"
  /** A task's patch reached the forge on a branch that changed `.ryph/` since it forked from
   * the default branch: the result goes back into that run's inbox
   * (core/environment_feedback.ts). */
  | "patch"
  /** A check suite needs the base's environment and waits for it (core/checks.ts). */
  | "check";

/**
 * The order queued builds are claimed in, lowest first, then oldest first. A re-layer, a build
 * a run asked for, a patch build and a build a check suite asked for come first: something waits
 * for each (a patch build is queued only while its run is live, and that run waits for the
 * result). A base rebuild comes last: it never blocks a run, and a deploy queues one per image.
 */
export const BUILD_PRIORITY: Readonly<Record<EnvironmentTrigger, number>> = {
  harness: 0,
  run: 0,
  patch: 0,
  check: 0,
  manual: 1,
  push: 1,
  reconcile: 1,
  base: 3,
};

/** One checkout baked into an environment image, at `/ryph/work/<path>`. Mirrors the builder
 * port's `BuildCheckout`, kept here so the record does not depend on a port. */
export interface EnvironmentCheckout {
  path: string;
  connectedRepoId: string;
  /** The branch built. */
  ref: string;
  commit: string;
}

/**
 * Everything a build of this row needs that is not configuration, recorded when it is queued —
 * so whichever replica claims the row can assemble the builder's spec from it, and a restart
 * loses no queued build.
 */
export interface EnvironmentBuildPlan {
  /** In member order. */
  checkouts: EnvironmentCheckout[];
  /** The checkout path whose `.ryph/Dockerfile` defines the machine, or null: the universal
   * image. */
  dockerfileFrom: string | null;
  /**
   * The machine below the checkouts as the forge described it (`machineKey`): `universal`, or
   * `dockerfile:<blob id>` of the environment repo's `.ryph/Dockerfile`. What lets a later build
   * of a changed definition start warm from this one. Null or absent (rows queued before it
   * existed): not known, so only the same definition starts warm from it.
   */
  machine?: string | null;
  /** `write` null: this build populates no layer cache (every branch build). */
  cacheScope: { read: string[]; write: string | null };
  /**
   * A re-layer: stage 4 only, FROM the baked image of the environment it moves onto the current
   * harness. Null: a full build.
   */
  relayerOf: { environmentId: string; bakedImage: string } | null;
  /**
   * An INCREMENTAL build: stages 2–3 on the baked image of an earlier build of the same machine,
   * so each checkout moves to its new commit in place and setup.yml reruns on a warm tree. Null
   * (or absent, on rows queued before this existed): a cold build.
   */
  warmFrom?: { environmentId: string; bakedImage: string } | null;
  /**
   * How many incremental builds the baked image stands on since the last cold one: 0 for a cold
   * build, the source's plus one for a warm build, and the source's own for a re-layer (which
   * moves the same baked image). Absent on rows queued before this existed: 0.
   */
  depth?: number;
}

/**
 * One build of one subject's environment, and — once `ready` — the image it produced. The row
 * a run freezes by `image` (a digest), and the record the environment card shows.
 */
export interface Environment {
  id: string;
  subjectKind: EnvironmentSubjectKind;
  subjectId: string;
  /** The environment repo's branch that was built. */
  ref: string;
  /** Whether `ref` was the subject's default branch when the build was queued — what the
   * resolution's "default-branch environment" means, and what writes the shared cache. */
  defaultBranch: boolean;
  /** `{path: sha}` per checkout. */
  commits: Record<string, string>;
  /** The environment definition built: every member's `.ryph/` tree at its built commit, as one
   * key (`definitionKey`). Null when no member has a `.ryph/`. */
  definition: string | null;
  /** RYPH_ENV_BASE_IMAGE and RYPH_HARNESS_IMAGE as they were when the build was queued. */
  baseDigest: string;
  harnessDigest: string;
  /** Digest-pinned; null until ready. */
  image: string | null;
  /** The same image below the harness layer — what a re-layer builds FROM; null until ready. */
  bakedImage: string | null;
  /**
   * The machine image (`.ryph/Dockerfile`) the build pushed, digest-pinned, so retention deletes
   * exactly it (`BuildSuccess.machineImage`). Null until ready, and where it pushed none.
   * Builds of one unchanged machine all name the same digest.
   */
  machineImage: string | null;
  status: EnvironmentStatus;
  /** Versions `ryph-bake` recorded, e.g. `{"rustc": "1.97.1"}`. */
  toolchains: Record<string, string>;
  sizeBytes: number | null;
  trigger: EnvironmentTrigger;
  /**
   * Why the build was queued, in a sentence: what asked, and for a branch build the refs,
   * commits and `.ryph/` trees compared and the paths changed (core/ryph_baseline.ts). Null on
   * rows queued before this was recorded.
   */
  reason?: string | null;
  plan: EnvironmentBuildPlan;
  /** The build log's key in the object store (`environments/…`); null before a build ended. */
  logRef: string | null;
  /** The last lines of the log — what a refused run and the card show without a fetch. */
  logTail: string | null;
  /** Why a failed build failed, in a sentence. */
  failure: string | null;
  /**
   * Hosts the egress proxy refused this BUILD (core/egress.ts).
   *
   * The case this exists for is not a failed build — it is a build that was refused something
   * and settled `ready` anyway, because a `RUN` step that swallows a download's exit code ships
   * an image missing whatever it was for, and the next person to learn that is a run failing
   * somewhere else entirely. So the card and the build-result message say it however the build
   * ended. Null on a build that was refused nothing.
   */
  egressRefusals: EgressRefusal[] | null;
  /**
   * What this build's setup.yml warned of when it baked: a step that failed (the rest of that
   * repo's steps skipped, its changes to the tree discarded), a setup.yml that was invalid, a
   * sibling's changes discarded after another repo's step failed, a tree setup finished but left
   * dirty (put back; that setup DID finish), or a record that could not be read. A build does
   * not fail over setup — setup is an optimization, and a run reruns it and warns again — so a
   * build with these is `ready`, and the card and the build-result message say what happened
   * (core/environment_messages.ts). Cleaned and bounded (core/setup_warnings.ts). Null, or
   * absent on rows from before this existed, when setup warned of nothing; a re-layer carries
   * its source's, read from the same image.
   */
  setupWarnings?: SetupWarning[] | null;
  /**
   * When the builder removed this `superseded` or `failed` row's images from where it kept them
   * (`EnvironmentBuilder.removeImages`) — the local store on docker, the environments registries
   * on kubernetes and Cloud Build: its environment image, its machine, and its baked one too,
   * unless another row still wanted that (a re-layer shares its source's), which then goes with
   * the last of them. A failed build's is whatever it pushed under its own names — on a registry
   * only untagged, since no digest was recorded, and deleted by the reconcile — and a row never
   * built is stamped with nothing removed. Bookkeeping: what launches go by is whether the image
   * is there, except where the launcher cannot tell before a pod pulls (a check suite's re-run on
   * kubernetes). Null on a backend that removes nothing.
   */
  imagesRemovedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The run spec's `environment` (the orchestrator ⇄ runner contract), frozen onto the run.
 * `id` is `"default"` for the default image, which is never baked.
 */
export interface RunEnvironment {
  id: string;
  image: string;
  /** True only for a built image: the runner adopts `/ryph/work/<path>` instead of cloning. */
  baked: boolean;
  commits: Record<string, string>;
  builtAt: string | null;
  toolchains: Record<string, string>;
  ref: string | null;
}

/** What a waiting run is waiting for. */
export interface RunEnvironmentWait {
  environmentId: string;
  status: "queued" | "building";
}

/**
 * What one submitted patch asked of the environment builder, and whether its run was told
 * (core/environment_feedback.ts). One row per patch — a patch is one head on one repo, so this is
 * the "one result per (run, commit)" dedup. Inserted as a CLAIM before the check reads the forge
 * (neither `environmentId` nor `note` set, `claimedUntil` the checker's lease), resolved once
 * with the build or the note, and stamped once more when the result was delivered to the run's
 * inbox (or recorded for a run that had already ended, or was never due to hear it).
 */
export interface PatchBuild {
  patchId: string;
  runId: string;
  /** The branch build the patch asked for; null when none was due, and `note` says why. */
  environmentId: string | null;
  /** The branch the patch landed on at the forge — what the build checked out. */
  branch: string | null;
  /** Why no build was due, for the tool and the run page; null when one was. */
  note: string | null;
  /** When the check was first claimed. */
  checkedAt: string;
  /**
   * While the check is unresolved: until when its checker holds it. Past it, the tick's
   * backstop (or the run's status read) takes the check over — a checker that died, or a forge
   * read that failed and is due for a retry. Null once resolved.
   */
  claimedUntil: string | null;
  /** When the run was told the result (or it was recorded for a run past hearing it). */
  reportedAt: string | null;
}
