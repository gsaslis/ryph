// The shared shapes of the runner.
// These types cross every seam it owns (harness, git, narrator, memory)
// and make no assumption about who drives the run.
//
// Invariants:
// - secrets NEVER appear in these types;
//   model keys and git credentials stay in adapter-private memory and explicit child envs,
//   never the runner's own environment, so every payload here is archivable verbatim

import type { DeclaredOutcome } from "../ports/harness.ts";

/** How much of `summary` the run's status comment in its thread repeats — the agent's call.
 * "minimal": what the run did is already posted in that thread, so the comment only points at
 * the run. Absent: the comment repeats the summary. The summary is kept whole either way. */
export type StatusComment = "full" | "minimal";

/** What a run is asked to do. */
export interface WorkItem {
  /** Unique per run. Tags every output of the run: progress, transcript, commit trailer. */
  id: string;
  /** The name and email the run's commits are authored as. */
  agent: AgentIdentity;
  /** The actual ask, harness-agnostic — or, both halves null, a task awaiting its prompt: the
   * run boots its sandbox and waits, and the first message to it is the ask (core/run.ts). */
  spec: WorkItemSpec;
  /**
   * What the run checks out: one entry per repository, each cloned into its own directory
   * under the checkout root, in this order. Never empty — a single-repo task is a list of one,
   * and there is no second shape. Every entry names the branch the run's work leaves on IN
   * THAT REPO; a change that spans entries becomes one branch, and one patch, per entry.
   */
  repos: RepoEntry[];
  /**
   * The workspace the list was taken from, when it was one: its name and what a person said
   * it is for, shown to the agent above the per-repo lines. Null for a repo on its own.
   */
  workspace: { name: string; description: string | null } | null;
  /** Which coding agent drives the run. */
  harness: HarnessSpec;
  /**
   * How long the run waits once the agent settles: every run waits for the next message on an
   * idle clock (a longer one once a person has spoken to it), until the agent calls the finish
   * tool, a person finishes the run from its page, or the clock runs out. Frozen with the rest:
   * what the outside may hand in afterwards is a message, never work.
   */
  lifetime: RunLifetime;
  /** The chat conversation the run is bound to, as the agent is told about it. Absent: the run
   * has no chat. */
  chat?: ChatContext;
  /**
   * Whether the run may open patches. False: the agent is told it cannot and holds no patch
   * tools, and nothing ships at the end — whatever the agent changed stays in the box. The
   * control plane refuses a patch from such a run anyway; this side is what keeps the agent
   * from trying.
   */
  canOpenPatches: boolean;
  /**
   * Whether the run may publish artifacts: HTML pages every member of the instance can open.
   * True: the agent holds `publish_artifact`, is told when to use it, and gets the artifact design
   * skill. The control plane re-reads the agent's switch on every publish regardless.
   */
  canPublishArtifacts: boolean;
  /** True when nobody follows the run while it works (an automation fire with no response): the
   * agent is told to finish once its work is submitted, since no review will reach it. Absent:
   * someone may. */
  unattended?: true;
  /** True when a person started the run on its page and talks to it there: the agent is told
   * that answering is not finishing. Absent: anything else. */
  interactive?: true;
  /**
   * The images the task came with — a forge thread's screenshots, a chat mention's photo — in
   * the order the spec's `[image N]` markers count them. Fetched and handed to the agent with
   * the task. Absent: none.
   */
  attachments?: AttachmentRef[];
  /**
   * The browser sidecar the platform launched beside this run, and the loopback port it listens
   * on. Absent: no browser, and the agent is told nothing about one. Present, the runner
   * configures it, hands the agent its tools, and relays what it shows to the run page — all
   * best-effort: a browser that never answers is a run without one, never a failed run.
   */
  browser?: { port: number };
}

/**
 * The chat a run is bound to, named the way the people in it know it. Told to the agent so that
 * "the chat" is a place it can picture: live, a response run bound to a Telegram group told
 * that very group it had not seen anything sent to it on Telegram, and asked for everything to
 * be re-sent "through the platform chat" — it never knew the two were the same room.
 */
export interface ChatContext {
  kind: "telegram" | "zulip" | "slack" | "discord";
  /** The Telegram group's title, the Zulip organization's name, the Slack workspace's, or the
   * Discord server's. */
  roomTitle: string;
  /** What people type to reach the bot: Telegram's @username (without the @), Zulip's bot full
   * name, Slack's bot handle, Discord's bot username. */
  botHandle: string;
  /** The room is quiet: the platform posts nothing there when the run succeeds, so the agent's
   * own posts are the only answer the people in it see. Absent: it posts the run's closing line. */
  quiet?: true;
}

/**
 * A run's idle clocks: how long it waits for its next message once the agent settles, before it
 * ends on its own. `idleMs` is the clock while nobody has spoken to the run; `attendedIdleMs`
 * takes over once a person has (the first user or chat message) — a run a person is with may
 * wait longer for their next word than a run nobody is watching.
 */
export interface RunLifetime {
  idleMs: number;
  attendedIdleMs: number;
}

export interface AgentIdentity {
  name: string;
  email: string;
}

export interface TaskSpec {
  title: string;
  instructions: string;
}

/** The ask as the work item freezes it: a `TaskSpec`, or both null while the task awaits its
 * prompt. Never one without the other. */
export type WorkItemSpec = TaskSpec | { title: null; instructions: null };

/**
 * One repository of the checkout, as the orchestrator froze it. `url` is what this run clones
 * (through the forge gateway, a per-run member URL; otherwise the upstream itself) and `ref`
 * the starting point; `path` is the directory under the checkout root the clone lives in, and
 * how the agent, the prompt and every patch address the repo; `branchNamespace` is the run's
 * branch namespace in this repo: every line of its work leaves on a branch under it,
 * `<namespace>/<line>` (@ryph/shared/lines), and on nothing else. `name` and `description` are for
 * the agent — what the repo is called and what it is, written by a person, because no recipe
 * can say which repo a fire belongs to. `connectedRepoId` is the connected repo the entry
 * checks out: every entry is one.
 */
export interface RepoEntry {
  connectedRepoId: string;
  name: string;
  url: string;
  ref: string;
  /** The branch the work on `ref` merges into, where that is not `ref` itself — a change
   * request's base. The clone holds it as `origin/<targetRef>`; `update_from_base` merges it.
   * Absent: the run started from its own base, and `ref` is what it catches up with. */
  targetRef?: string;
  /** The checkout is a fork pull request's head: a contributor's files, not this repository's.
   * Nothing in it configures or runs automatically — no `.ryph/` setup, services or
   * `environment.md`, no context file quoted into the prompt, no skills. The control plane
   * resolved the run's services, checks and machine from the repository's default branch;
   * what this checkout says about them is material for the agent to read, never instructions. */
  forkHead?: boolean;
  /** The forge the repository lives on, so the agent is told what its change requests are
   * called there. Absent: a control plane that does not say. */
  provider?: "github" | "gitlab" | "radicle" | "local";
  path: string;
  branchNamespace: string;
  description: string | null;
}

/**
 * pi's thinking levels (pi-ai's `ModelThinkingLevel`), least to most — what `--thinking` takes.
 * The control plane's own copy is @ryph/orchestrator's `THINKING_LEVELS`, and @ryph/host's
 * tests pin the two together: the runner ships in the agent image and imports no other package.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** One member per shipped adapter: a kind lands here together with the adapter that runs it,
 * so the ingest boundary never accepts work the binary cannot execute. */
export type HarnessSpec =
  | { kind: "echo" }
  /** `thinking` is any flag-safe string, not only a `ThinkingLevel`: a control plane newer than
   * this runner may name a level it lacks, and the pi adapter drops that one with a warning. */
  | { kind: "pi"; provider?: string; model?: string; thinking?: string };

/**
 * Additional context composed for this run, supplied by the caller: persona or prompt layers, and
 * the memory BRIEF — what previous runs and people recorded about this repo and the org, already
 * rendered under a token budget by the orchestrator, frozen with the rest of the spec. The brief
 * reaches the core through the Memory port (adapters/memory/spec.ts), so the seam stays one place.
 */
export interface InjectedContext {
  systemPrompt?: string;
  brief?: MemoryBrief;
}

/**
 * The memory brief as the orchestrator froze it: the rendered text, the ids it carries, and the
 * evidence behind its repo claims — a commit and the paths a claim is evidence for. The runner
 * checks each against the clone in `preparing` (`git diff --name-only <sha>..HEAD -- <paths>`)
 * and reports the stale ones upstream; they still ride the prompt, under "may be outdated".
 */
export interface MemoryBrief {
  text: string;
  memoryIds: string[];
  evidence: BriefEvidence[];
}

export interface BriefEvidence {
  memoryId: string;
  sha: string;
  paths: string[];
  /** The directory in this checkout of the repo the claim is about (an entry's `path`), or
   * null when that repo is not part of this checkout — the check is skipped for it. Resolved
   * upstream, where the memory's repo and the task's entries are both known. */
  path: string | null;
}

/** A briefed memory whose evidence paths changed since it was observed. */
export interface StaleMemory {
  memoryId: string;
  changedPaths: string[];
  /** The commit the check diffed TO — this clone's base, cut before the run did any work of
   * its own. A confirmation from this run re-anchors the claim's evidence to it, so it has to
   * be a commit the repository itself has: a commit this run made would resolve in no later
   * clone, and "cannot tell" would exempt the claim from the check forever. Nullable because
   * the wire defaults it away; a report without it counts and re-anchors nothing. */
  headSha: string | null;
}

/**
 * A repo whose base the origin could only serve from a copy it could not refresh: the forge
 * gateway's cache during an upstream outage. `commit` is the base this run started from (the
 * clone's HEAD before any work), `since` the ISO instant the refreshes began to fail. Said to
 * the agent under the repo's heading, and reported upstream once as the run's history.
 */
export interface StaleBase {
  path: string;
  name: string;
  ref: string;
  commit: string;
  since: string;
}

/**
 * A repo whose setup did not finish, which the run went on without: a step that failed (its
 * label, its 1-based position of `total`, its exit code, the end of its output — repo-authored,
 * cleaned and bounded — and whether what it left in the tree was discarded), or a setup.yml that
 * could not be used at all (`error`, and no step ran), or changes in a repo whose own setup
 * did not fail, discarded because a step failed in `after` (helpers/environment.ts
 * `SetupDiscarded`), or changes a repo's own setup left when no step failed, discarded too
 * (`files`, `SetupDirty`). Said to the agent in the machine block,
 * and reported upstream once as the run's history, so a person reading the run sees the warning
 * without opening its trace.
 */
export type SetupFailureReport =
  | {
    kind: "step";
    path: string;
    step: string;
    index: number;
    total: number;
    code: number;
    output: string;
    discarded: boolean;
  }
  | { kind: "invalid"; path: string; error: string }
  | { kind: "discarded"; path: string; after: string[] }
  | { kind: "dirty"; path: string; files: string[] };

/**
 * One service container the platform launched beside this run — a database, a cache — reachable
 * BY NAME and never on `localhost`. The runner does not start these and cannot: it waits for
 * them, and tells the agent they are there.
 */
export interface RunService {
  /** The hostname. This is the whole contract, identical on every backend that supports it. */
  name: string;
  port: number;
  /** Narration only: what the agent is told is running, and what the trace records. */
  image: string;
}

/** The run's services, as the spec delivers them. */
export interface RunServices {
  list: RunService[];
  /**
   * The declaration was read from a repo cache the forge could not refresh, so it may be a
   * fetch behind the tree this run cloned. Said out loud in the agent's environment block: a
   * run quietly obeying an old declaration is worse than a run that mentions it.
   */
  stale: boolean;
}

/**
 * The machine this run was launched on, as the control plane resolved it.
 * `baked` is the one field the runner acts on: the image
 * already holds each repo's checkout at `/ryph/work/<path>`, with its setup run, and the run
 * adopts it instead of cloning. The rest is what the agent is told about its environment.
 */
export interface RunEnvironment {
  /** The environment's id, or "default" for the deployment's default image. */
  id: string;
  /** The image, digest-pinned. */
  image: string;
  baked: boolean;
  /** The commit each repo's checkout was built from, keyed by its path. */
  commits: Record<string, string>;
  /** When the image was built, ISO 8601; null when nobody recorded it. */
  builtAt: string | null;
  /** Toolchain versions the build recorded, keyed by tool (`rustc`, `node`, …). */
  toolchains: Record<string, string>;
  /** The branch the image was built from; null for the default image. */
  ref: string | null;
}

/** Where a frozen skill came from. A working repo's own skills are this runner's to find. */
export type SkillSource = "catalogue" | "org";

/**
 * Where any skill the run holds came from: a frozen source, or a working repo named by its
 * checkout path. One shape for a prepared skill, the harness's list and a drop, so each becomes
 * the next by spreading it.
 */
export type SkillOrigin = { source: SkillSource } | { source: "repo"; path: string };

/** One skill the control plane froze onto the run: what the agent's harness lists, and the
 * content digest of the bundle that holds its files. */
export interface RunSkill {
  name: string;
  description: string;
  source: SkillSource;
  digest: string;
}

/**
 * The skills the control plane froze onto the run: ryph's catalogue
 * and the org skills repo, by digest, plus whether this runner may add the checked-out repos' own
 * and how much of the listing cap is left for them.
 */
export interface RunSkills {
  skills: RunSkill[];
  workingRepos: boolean;
  budget: { skills: number; listingBytes: number };
}

/** One frozen skill's files, as `GET /v1/runs/:id/skills/:digest` serves them. `content` is
 * base64: a skill's assets may be binary. */
export interface SkillBundle {
  files: Array<{ path: string; executable: boolean; content: string }>;
}

/** Why a skill did not reach the agent. */
export type SkillDropReason = "collision" | "cap" | "reserved" | "invalid" | "unavailable";

/**
 * The runner's half of the run's skills trail, reported once, just before the harness starts:
 * the working-repo skills it loaded, and every skill it could not give the agent.
 */
export interface SkillReport {
  /** The directory every skill was written under, or null when none was made. The run page
   * counts a read as a skill's only under it, so a checkout file shaped like one is not. */
  root: string | null;
  loaded: Array<{ path: string; name: string }>;
  dropped: SkillDrop[];
}

/**
 * One skill the agent was not given, as the control plane's `SkillDrop` reads it: a repo skill
 * names its repo's path and nothing else does, and a collision names the source that holds the
 * name. The control plane refuses a report that breaks either rule.
 */
export type SkillDrop =
  & { name: string; detail?: string }
  & SkillOrigin
  & (
    | { reason: "collision"; winner: SkillOrigin["source"] }
    | { reason: Exclude<SkillDropReason, "collision"> }
  );

/**
 * A run's complete input as the orchestrator serves it on boot:
 * the frozen `WorkItem` plus whatever `InjectedContext` was composed for the run
 * (null when there is none).
 */
export interface RunSpec {
  workItem: WorkItem;
  injectedContext: InjectedContext | null;
  /** Null when the run has none — and also when the orchestrator predates this field, which
   * is the same thing from here: nothing was launched, so nothing is waited for. */
  services: RunServices | null;
  /** Null when the control plane resolved no environment — a CLI run, or environments off. */
  environment: RunEnvironment | null;
  /** Whether the platform runs repositories' declared checks for this run. Null when the
   * control plane runs none, or predates the field — the same thing from here. What each repo
   * declares is asked for on its own (`ChecksChannel.declared`), while the run clones. */
  checks: { enabled: boolean } | null;
  /** The skills section, unread: `readRunSkills` (schema.ts) reads it apart from the rest of the
   * spec, so a section this runner refuses costs the run its skills and not the run. */
  skills?: unknown;
}

/** One repo's declared checks, as the platform read them at the run's start: what the prompt
 * shows so the agent knows what each check runs. */
export interface DeclaredChecks {
  /** The checkout directory. */
  path: string;
  /** How the prompt names the repo: its forge address, or a local repository's folder name —
   * the platform never sends a host path. Display only. */
  repoRef: string;
  /** The branch the file was read on. */
  checksRef: string;
  /** Setup steps, run once before the checks. */
  setup: string[];
  checks: Array<{ name: string; run: string; timeoutSeconds: number; services: string[] }>;
}

/** What the platform could tell of the run's checks files at the start: the repos whose file
 * it read, and the repos whose file it could not read (`"*"` when it does not know which).
 * A repo with no checks file is in neither. */
export interface ChecksDeclaration {
  declared: DeclaredChecks[];
  unread: string[];
}

/**
 * The authoritative outcome of a run.
 * "failure" is the agent's outcome: it ran and did not deliver.
 * "error" is the machinery's: something around the agent broke —
 * the agent may even have succeeded.
 * A "success" with no branches delivered by doing nothing: the agent said it was done and
 * made no commits — a question answered, a review with nothing to fix — so there was
 * nothing to push.
 * Every status exits normally: a returned `Result` means the runner did its job.
 * Abnormal exit = could not even report.
 *
 * `branches` is what durably left the box: one outcome per repository whose branch reached
 * the remote, in checkout order. "Work reached origin" is "at least one outcome exists" —
 * a "success" has one unless it delivered by doing nothing, and every other status carries whatever had already shipped
 * before the run stopped, so a bundle the gateway holds is never reported as if it did not.
 */
export type Result =
  | { status: "success"; branches: BranchOutcome[]; summary: string; statusComment?: StatusComment }
  | {
    status: "cancelled";
    branches: BranchOutcome[];
    summary: string;
    statusComment?: StatusComment;
  }
  | {
    status: "failure";
    reason: string;
    /** The agent's own account of the run — kept even though it delivered nothing. */
    summary: string;
    branches: BranchOutcome[];
    statusComment?: StatusComment;
  }
  | {
    status: "error";
    reason: string;
    /** The phase that broke. A report that cannot be delivered is no phase: it exits abnormally. */
    during: Phase;
    branches: BranchOutcome[];
  };

// A `BranchOutcome` exists if the branch reached the remote:
// it is built only after a successful push,
// so an entry in `Result.branches` IS the "pushed" signal for that repo.
// (If we ever need to report committed-but-unpushed work, add an explicit flag then —
// today those commits die with the checkout, so there is nothing meaningful to report.)
export interface BranchOutcome {
  /** Which repo of the checkout this branch belongs to — the entry's `connectedRepoId` and
   * `path`, so the control plane opens the patch against the right repo without guessing. */
  connectedRepoId: string;
  path: string;
  /** The line of the repo this branch is (@ryph/shared/lines): `name` is `<namespace>/<line>`, or
   * `…-<n>` in a later generation. A repo ships one branch per line. */
  line: string;
  name: string;
  headSha: string;
  /** The actual shipping base, which moves with each generation after a patch landed. */
  baseSha?: string;
  commits: CommitInfo[];
  /**
   * Which generation of the run's branch this is. A run starts at 1; once its change request
   * MERGES — with a patch of it, or without any (a missed cue that names `onto`, or a release) —
   * next submit ships as generation 2 (`<branch>-2`), on the merged tip. The control plane files
   * the patch under it, and a later patch of the same generation is cumulative on the same pull
   * request.
   */
  generation: number;
  /**
   * The heads this clone shipped earlier in the run whose own work this branch carries in full
   * (helpers/checkout.ts `carriesWork`), and that did not land themselves: what memory follows a
   * claim along, from the patch it was made on to the one that landed it. Every one of them,
   * newest first, at most 500.
   */
  carries: string[];
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

/**
 * Best-effort liveness/narration emitted during a run.
 * Purely informational: consumers may act on it or ignore it, and no delivery is guaranteed.
 */
export interface Progress {
  workItemId: string;
  phase: Phase;
  message?: string;
  /**
   * When the run's idle clock runs out, as the runner currently holds it — the control plane's
   * reaper backstops it. Null: the clock is not running (the agent is at work).
   */
  idleDeadlineAt?: string | null;
  /** Present only while settled; null clears a previous idle indication. */
  idleState?: "idle" | "waiting-for-user" | null;
  /**
   * The outcome the agent last declared, through `finish` or `report_outcome`. Carried on every
   * beat once said: the run page offers a person the run's finish once it is `success` or
   * `no-changes`, and the control plane refuses one before then. Null once a message reached the
   * agent since: it is acting on something new, so the outcome it declared before no longer
   * stands for the page (how the run concludes still does), until it declares one again.
   */
  declaredOutcome?: DeclaredOutcome | null;
  /**
   * The agent called its `finish` tool. Carried beside the outcome on every beat after, so the
   * run page stops offering a person the run's finish while the agent's own is held for a
   * verdict or the run is finalizing, and the control plane refuses one.
   */
  finished?: true;
}

/** The phases a run moves through. Each one narrates progress as it begins — except
 * "booting", which precedes the pipeline: it appears only in the error `Result` of a run
 * that failed while still assembling its input, before any progress could be narrated. */
export type Phase =
  | "booting"
  | "cloning"
  | "preparing"
  | "setting-up"
  | "running"
  | "finalizing";

/** One normalized piece of live narration.
 * `raw` preserves the harness-native payload:
 * normalization may be lossy, so the original is retained for lossless archival. */
export interface TranscriptChunk {
  /** The normalized event category a harness maps its native output onto. */
  kind:
    | "assistant" // Model's natural-language output.
    | "tool_use" // The agent invoking a tool (edit, bash, read).
    | "tool_result" // Output fed back from a tool.
    | "thinking" // The model's reasoning/scratchpad before it acts.
    | "system" // Out-of-turn lifecycle/metadata (init, model info, config).
    | "inbound" // A message from the run's inbox, as the agent was handed it.
    /**
     * A back-reference, not narration: `raw` is `{ seq }`, the history seq of the `assistant`
     * event the run's result was derived from. It exists because that is only known once the
     * run settles, by which time the message itself is long sent. A reader hides the event it
     * names — the run's result already says what that message said.
     *
     * `seq: null` names nothing, and the LAST mark of a run wins: that is how the core retracts
     * the harness's mark when it overrides the summary (a run ending through the finish
     * tool), where folding the marked row would delete a message nothing else repeats.
     */
    | "final"
    /**
     * A subagent's lifecycle, written into ITS lane, never the run's own (core/subagents.ts):
     * its start (`raw` the id, label, mode and task), a continuation's start (`subagent.resume`,
     * the parent's message), a steer it was handed while it worked (`subagent.message`), and the
     * end of each stretch of its work (`subagent.end`, why it ended and how long it took).
     */
    | "subagent.start"
    | "subagent.resume"
    | "subagent.message"
    | "subagent.end";
  text?: string;
  raw?: unknown;
}

/**
 * Who a message in the run's inbox came from. Carried, never queried into: the runner names the
 * sender in the framing it hands the agent, and nothing more.
 */
export type MessageSender =
  | { kind: "user"; userId: string }
  | { kind: "chat"; name: string; id: string }
  | { kind: "automation"; fireId: string }
  /** A `/ryph` follow-up in the forge thread the run was commanded from. */
  | { kind: "forge"; login: string; repoRef: string; thread: string }
  | { kind: "platform" }
  /** Never on the wire: a message whose sender or kind this runner cannot read (a newer control
   * plane's), kept for its text alone (schema.ts `parseInboundMessages`). Framed as such, never
   * as the platform's. */
  | { kind: "unidentified" };

/**
 * What a `system` message may carry beside its text: a structured cue the runner reads BEFORE
 * framing the text for the agent. A landed patch is the one that changes the run's mechanics —
 * once it merges, the next submit of that repo starts a new generation. An environment
 * build's result is carried for the run page; the runner only frames its text. A release ends a
 * generation whose change request merged with nothing of the run on it. A finish is a
 * person ending the run from its page, which the conversation takes as a finish and never hands
 * the agent (core/conversation.ts).
 */
export type SystemPayload =
  | PatchPayload
  | ReleasedPayload
  | EnvironmentPayload
  | FinishPayload
  | ChecksPayload;

/** Informational suite result, carried into history without acting as a lifecycle cue. */
export interface ChecksPayload {
  kind: "checks";
  suiteId: string;
  state: "passed" | "failed" | "error" | "cancelled";
  /** The request's checkout path, not the checks file's path. */
  path: string;
  commit: string;
  partial: boolean;
}

/** A cue the shipper takes (core/patches.ts `onPatchCue`): a patch's news, or a release. */
export type PatchCue = PatchPayload | ReleasedPayload;

/**
 * What taking a cue came to (core/patches.ts `onPatchCue`): false, a repeat of one already taken,
 * which is no news for the agent; true, news; or news with a line the cue's text gains before the
 * agent reads it (`note`): what the runner's fetch after a landing found.
 */
export type CueTaken = boolean | { note: string };

/**
 * The change request the repo at `path` worked merged with nothing of this run on it, and the
 * control plane let the task go of it: the repo moved onto `onto`, and the task targets no change
 * request any more. The agent moves the run's own commits onto `onto`, and the next submit ships
 * them as a new generation, which opens a fresh change request. A patch the run shipped in that
 * generation never reached the change request (the control plane releases only a run none of
 * whose patches did), so it moves with the rest.
 */
export interface ReleasedPayload {
  kind: "released";
  /** The repo's checkout path. */
  path: string;
  /** The line of the repo the release is about (@ryph/shared/lines): the cue is routed to it
   * alone. */
  line: string;
  /** The generation the release ends, as the control plane recorded it: a release cued before
   * the clone moved on is told from one about where it is now by it. */
  generation: number;
  /** The branch the repo moved onto: where the change request merged. */
  onto: string;
  /** The change request that merged, as the forge names it. */
  forgeRef: string;
}

/**
 * A person finished the run from its page, once its agent had said it was done. The run ends the
 * way the agent's own `finish` ends it, after the current turn settles, with the outcome the agent
 * last reported; unlike it, the run never holds for a check verdict it is owed, and a hold already
 * open ends at once. Only ever offered once this runner reported that outcome, so the runner that
 * reads it always knows the cue; the message's text is only what the run page's inbox shows.
 */
export interface FinishPayload {
  kind: "finish";
}

/** The result of the environment build one of the run's patches asked for, or that none was
 * due. */
export interface EnvironmentPayload {
  kind: "environment";
  patchId: string;
  path: string;
  headSha: string;
  environmentId: string | null;
  status: "ready" | "failed" | "superseded" | "skipped";
}

export type PatchPayload = {
  kind: "patch";
  patchId: string;
  /** The repo's checkout path. */
  path: string;
  /** The line of the repo the patch shipped on (@ryph/shared/lines): the cue is routed to (path,
   * line), never to a path alone. */
  line: string;
  headSha: string;
  generation: number;
  state:
    | "submitted"
    | "approved"
    | "rejected"
    | "merged"
    | "closed"
    | "failed"
    | "superseded"
    /** Held for a person's approval: the patch changes git hook files (`hookPaths`) of a
     * repository on the owner's computer. Back to waiting, not failed. */
    | "held"
    /** Its change request merged without its head. With `onto` only when no patch of its
     * generation merged: the generation is over, and its whole work moves onto `onto`. */
    | "missed";
  forgeUrl: string | null;
  /** A rejection's or a failure's reason. */
  reason: string | null;
  /**
   * On a merge: the branch the control plane moved the repo onto — where the forge says the
   * change request merged — which the next generation starts on. Always sent on a merge; a cue
   * without it comes from a control plane a version behind, and the branch's own target stands in.
   * On `missed`, only when it ends the generation.
   */
  onto?: string;
  /**
   * On a merge, always: the head of the newest patch of the run, path and generation that
   * merged — in the merged head's history, or its change exactly the merged head's, both ways
   * (forge helpers/containment.ts) — the cue's own, since the control plane posts only the
   * newest merged patch. What the agent's rebase starts past (`LineState.landedHead`): every
   * commit up to it landed. A head that merged only in part is `missed`, never this.
   */
  landedHead?: string;
  /** With `held`: the hook files, repo-relative. */
  hookPaths?: string[];
};

/**
 * One message from the run's inbox, as the orchestrator serves it (`GET /v1/runs/:id/messages`).
 * `seq` is the runner's cursor: monotonic per run, the same guard shape the heartbeat uses. The
 * text is UNTRUSTED — a person or a system said it — and is framed as such before the agent
 * reads it (core/conversation.ts). One exception: a `forge` sender is a `/ryph` command whose
 * author the control plane checked for write access before posting, framed as AUTHORIZED and free
 * to revise the task, because changing the work is what a follow-up command is for. No message is
 * ever WORK, authorized or not: none carries a repo, a credential or a scope.
 */
export interface InboundMessage {
  seq: number;
  /** "alert" is a later fire joining a response run — an internal name, older than responses. */
  kind: "user" | "chat" | "alert" | "system";
  sender: MessageSender;
  text: string;
  payload: SystemPayload | null;
  /** The images the message carries, in the order the text's `[image N]` markers count them.
   * Refs only: the runner fetches each one's bytes from the control plane before the message
   * reaches the agent (core/images.ts). As untrusted as the text. */
  attachments: AttachmentRef[];
  createdAt: string;
}

/**
 * An image the control plane holds for this run, by id: on the work item (the task came with
 * it) or on an inbox message. Never the bytes — those are fetched, scoped to the run, saved
 * outside every clone, and handed to the harness (core/images.ts). The ref is what the
 * transcript keeps, so a reader can draw the image without the history ever holding it.
 */
export interface AttachmentRef {
  id: string;
  mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/**
 * The wake-up the agent asked for (`ryph__wake_me`), handed to it the way an inbox message is —
 * framed, fenced, narrated as `inbound` — but minted by the runner itself, not served by the
 * control plane. So it has no `seq`: the seq is the inbox's cursor, and a number here would be
 * one a reader could mistake for a message the inbox holds, or a cursor could be moved by. What
 * it carries instead is `wake`, the one field no inbox message has, which is how a reader of the
 * `inbound` chunk's `raw` tells the two apart.
 */
export interface WakeUpMessage {
  kind: "system";
  sender: { kind: "platform" };
  text: string;
  payload: null;
  createdAt: string;
  wake: { afterMinutes: number; note: string | null };
}

/**
 * A check-verdict hold that reached its bound with verdicts still owed and no finish, told to the
 * agent the way a wake-up is — framed, fenced, narrated as `inbound`, no `seq` — and minted by the
 * runner (core/conversation.ts). `checksLate` tells it apart in the `inbound` chunk's `raw`.
 */
export interface ChecksLateMessage {
  kind: "system";
  sender: { kind: "platform" };
  text: string;
  payload: null;
  createdAt: string;
  /** How many verdicts were still owed when the hold gave up; null when that could not be read. */
  checksLate: { owed: number | null };
}

/**
 * A background command's readiness or end (`ryph__background_run`), handed to the agent the way a wake-up is
 * — framed, fenced, narrated as `inbound`, no `seq` — and minted by the runner when the job
 * becomes ready, exits or times out. It carries `background` where a wake-up carries `wake`, so a reader of the
 * `inbound` chunk's `raw` tells it apart from both a wake-up and an inbox message.
 */
export interface BackgroundNoticeMessage {
  kind: "system";
  sender: { kind: "platform" };
  text: string;
  payload: null;
  createdAt: string;
  background: {
    id: string;
    label: string;
    reason: "exited" | "timeout" | "ready";
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
  };
}

/**
 * The end of a stretch of a subagent's work that the agent did not stop (`ryph__subagent_start`),
 * carrying how it ended and its answer — the way the agent waits for one — handed to it the
 * way a background command's end is — framed, fenced, narrated as `inbound`, no `seq` — and
 * minted by the runner (core/subagents.ts). It carries `subagent` where a background notice
 * carries `background`, so a reader of the `inbound` chunk's `raw` tells the two apart.
 */
export interface SubagentNoticeMessage {
  kind: "system";
  sender: { kind: "platform" };
  text: string;
  payload: null;
  createdAt: string;
  subagent: {
    id: string;
    label: string;
    reason: "answered" | "timeout" | "failed";
    durationMs: number;
  };
}
