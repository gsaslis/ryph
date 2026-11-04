// Environments: WHEN a subject's image is built and FROM WHAT. The builder port owns HOW; this file
// owns the queue, the build's inputs, the triggers that ask for builds, and retention. Which
// environment a RUN gets is core/environment_resolve.ts, which asks this service to build when a
// run has to wait.
//
// The queue is the `environments` table. A build is queued as a row carrying its whole plan
// (checkouts, commits, cache scopes), any replica with a free slot claims it — the store caps
// claims at RYPH_ENV_BUILD_CONCURRENCY deployment-wide — and the replica that claimed it runs it,
// under a wall-clock cap and an abort signal.
//
// A replica that goes away mid-build — a rollout, a crash — leaves a `building` row it is no
// longer running. That row is ADOPTED, not waited out. MEASURED on a GKE deployment: two
// builds completed at 21:00, the control-plane pod was replaced at 21:18, and because a build's
// only trace was an AbortController in the dead pod's memory, both rows sat `building` for ever.
// The concurrency cap counts `building` rows, so at two of them the whole queue wedged, and the
// recovery that existed keyed off `startedAt + buildTimeoutMs`, which had just been raised to 180
// minutes for slow harness builds — turning a one-hour wedge into a three-hour one. Two clocks
// that have nothing to do with each other were wired together.
//
// So they are separated here. `buildTimeoutMs` bounds how long a build may TAKE, and it is
// enforced where the build is (the adapter's own cap, and `activeDeadlineSeconds` on the Job).
// Whether anyone is still running a build is a different question with its own answer: the
// replica running one stamps `updatedAt` on its row every tick, and a row that stops being
// stamped for STRANDED_AFTER_MS has no owner. One replica claims such a row
// (`claimStrandedBuild`) and asks the BUILDER what became of the build — the backend's own
// durable record, a kubernetes Job, is the truth, and neither replica's memory is. The Job is
// still running: attach to it and settle when it ends, so a redeploy mid-build costs nothing. It
// finished while nobody was watching: read its result out of its pod log and settle on that,
// success or failure. It is not there at all: fail the row now, within a tick.
//
// Invariants:
// - only a DEFAULT-BRANCH build writes the subject's shared layer cache; a branch build reads it
//   and writes no cache at all, so it can never seed layers another build picks up
// - a build's credentials are its own and die with it: a git key that resolves only to its
//   checkouts and only while it is building, and an egress claim minted at the deployment's
//   ceiling (a build serves every agent, so no one agent's narrower policy applies)
// - the control plane handles commit ids, tree ids and digests only — never a Dockerfile's text
// - a build a run or a check suite waits for is never superseded out from under it; a build
//   nobody waits for is, when a newer one for the same branch is queued, when the run that asked
//   for it goes, or when the check suite that asked for it takes a ready image instead. A
//   Rebuild of the same inputs moves a live build's waiting runs onto itself first, and a run
//   that only starts waiting on the old build later follows it there (`successorOf`). A check's
//   ask supersedes nothing: it is a build of the base AS IT WAS, and must neither cancel the
//   branch's current build nor be mistaken for it
// - settling is conditional on the stored status, so a build superseded while it ran never
//   writes `ready` over that verdict — which is also what makes adoption safe to get wrong: two
//   replicas watching one build produce at most one settle, and only the settle that lands
//   writes anything at all, log blob included
// - the builder's record of a build outlives the reading of it and is discarded once the ROW is
//   written, so a control plane that dies in between costs a re-read, not a lost build
// - a build is never waited for on the way out. The drain deadline is seconds and a build is
//   tens of minutes, so a replica leaving hands its builds on by simply stopping; the next tick
//   anywhere adopts them
// - retention never retires an image a live run references (one a launch found gone from the
//   machine is retired all the same: `imageMissing`), and on a builder that removes images
//   (docker's store, Artifact Registry) removes a retired row's images only after
//   IMAGE_REMOVAL_GRACE_MS, and never while a live run, an unsettled check suite or a build in
//   flight still uses them
// - a harness upgrade RE-LAYERS: stage 4 on the ready row's baked image, never a re-clone of a
//   commit its branch may have dropped. A re-layer that failed is not asked for again on the
//   same harness; the next ask is a full build of where the branch stands now
// - an environment's identity is its DEFINITION: every member's `.ryph/` tree, not only the
//   environment repo's (`definitionKey`). A change under any member's `.ryph/` is a new
//   definition and builds now; a re-layer keeps its source's definition, so it never passes for
//   a newer one
// - a rebuild of the same machine starts from the last trusted ready image of it (`warmSource`):
//   a default-branch build from a default-branch image only, a branch build from its own or the
//   default branch's, never another branch's — the layer cache's rule, applied to whole trees

import type {
  ConnectedRepo,
  Environment,
  EnvironmentBuildPlan,
  EnvironmentCheckout,
  EnvironmentSubjectKind,
  EnvironmentTrigger,
  Run,
} from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import type { EnvironmentsConfig } from "./environment_config.ts";
import { type EgressPolicy, liveCeiling, mintEgressToken, resolveNetworkScope } from "./egress.ts";
import { fitsForge, forgeRepoRef, githubModeOf, gitlabModeOf } from "./forge_repo.ts";
import { defaultPathFor, resolveWorkspace } from "./workspaces.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import { digestOf } from "../helpers/digest.ts";
import { setupBroke, setupUnfinishedIn, setupWarningsForBuild } from "./setup_warnings.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";
import type {
  AdoptSpec,
  BuildResult,
  BuildSpec,
  EnvironmentBuilder,
  PassSummary,
} from "../ports/environment_builder.ts";
import { gatewayGitEnv, proxyEnv } from "../helpers/credentials.ts";
import type { BuildLogStore } from "../ports/build_log_store.ts";
import type { EnvironmentStore } from "../ports/environment_store.ts";
import { compareWithBaseline, type RyphBaseline } from "./ryph_baseline.ts";
import type { Forge, GithubModeSource, RyphTree } from "../ports/forge.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { TaskStore } from "../ports/task_store.ts";

/**
 * Whether two image references pin the SAME image — by digest, not by spelling.
 *
 * `RYPH_ENV_BASE_IMAGE` and `RYPH_HARNESS_IMAGE` are full references, tag and all
 * (`…/ryph-universal:<deploy tag>@sha256:…`), because a build needs the whole thing to pull. The
 * tag moves on every deploy even when the content does not: a deploy that mirrors the universal
 * image re-tags it rather than building a new one. Compared as strings, that reads as a changed
 * base and queues a FULL REBUILD of every default-branch environment on every deploy — measured
 * on GKE, 45 minutes of building to produce the image that already existed.
 * Two digest-pinned references are the same image when their digests match, whatever tag either
 * one carries; anything unpinned falls back to an exact comparison, which is all it can mean.
 */
export function sameImage(a: string, b: string): boolean {
  const [left, right] = [digestOf(a), digestOf(b)];
  return left !== null && right !== null ? left === right : a === b;
}

/** Branch images go after this long without a newer build. */
export const BRANCH_IMAGE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** How long a retired row's images stay, on a builder that removes them, before they are. */
export const IMAGE_REMOVAL_GRACE_MS = 30 * 60 * 1000;
/** How often the tick looks for retired images to remove. */
export const IMAGE_REMOVAL_EVERY_MS = 5 * 60 * 1000;
/** How many retired rows a removal pass reads at a time; it reads on until none are left. */
export const IMAGE_REMOVAL_BATCH = 50;
/** What one removal pass did, for its line in the log. */
interface RemovalTally {
  rowsSeen: number;
  rowsStamped: number;
  unanswered: number;
  failures: number;
  firstError?: string;
}

/** How often the removal pass also reconciles a registry's untagged images against the rows. */
export const RECONCILE_EVERY_MS = 60 * 60 * 1000;
/** How long past the build timeout a layer-cache export another replaced is kept, for a build
 * still reading it (`EnvironmentBuilder.pruneCache`; docker's own cache keeps the same margin). */
export const CACHE_RETIRED_GRACE_MS = 10 * 60 * 1000;
/** A removal pass ends after this many removals in a row fail outright (the daemon is down, or
 * hung past the builder's timeout); the next pass starts over. */
export const IMAGE_REMOVAL_FAILURES = 3;
/**
 * How long past its own timeout a build's things outlive it: its git key's expiry, its egress
 * claim's, and the last-resort floor in `tick` for a row whose builder cannot be asked at all.
 * The replica running a build aborts it at the timeout, so past this nothing of it is wanted.
 */
export const ORPHAN_GRACE_MS = 5 * 60 * 1000;
/**
 * How long a `building` row may go unstamped before any replica treats it as STRANDED and goes
 * asking the builder about it.
 *
 * Deliberately NOT derived from `buildTimeoutMs`: how long a build may take and whether anyone is
 * still running it are unrelated questions, and answering the second with the first is what turned
 * a stranded row into a three-hour wedge in practice. The replica running a build stamps its row
 * on every tick of the reaper (10 s by default), so a minute is six missed stamps — long enough
 * that a slow tick, a garbage-collection pause or a database blip is not mistaken for a dead
 * replica, and short enough that a rollout's builds are picked up before anyone notices. A
 * deployment whose reaper interval approaches this would adopt its own live builds, which costs
 * a redundant watcher and nothing else (a settle is conditional either way).
 */
export const STRANDED_AFTER_MS = 60 * 1000;
/**
 * How long past its abort a build's adapter may take to hand its slot back before the core stops
 * waiting for it. The builders stop within seconds of the signal; one that does not (an API call
 * that hangs) must not keep the slot, the row and the runs waiting on it for ever.
 */
export const ABANDON_GRACE_MS = 60 * 1000;
/** How much of a running build's log is handed out at once: its end, where the build is. */
const LIVE_LOG_CHARS = 256 * 1024;
/** How much of a log rides the row — the tail a refused run and the card show. */
const LOG_TAIL_LINES = 40;
const LOG_TAIL_CHARS = 4_000;

/** The slice of the app config builds consume. */
export interface EnvironmentsServiceConfig {
  environments: EnvironmentsConfig;
  /** The gateway as a build's clone dials it; null: clones go to the repo URLs directly. */
  gitGateway: { url: string; keyTtlMs: number } | null;
  egress: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
}

export interface EnvironmentsDeps {
  store: EnvironmentStore;
  tasks: Pick<
    TaskStore,
    | "listActiveRuns"
    | "getConnectedRepo"
    | "listConnectedRepos"
    | "saveConnectedRepo"
    | "getWorkspace"
    | "listWorkspaces"
    | "listWorkspaceRepos"
    | "findWorkspaceRepo"
    | "getEgressAllowlist"
    | "saveRunIfWaiting"
    | "appendEvent"
  >;
  builder: EnvironmentBuilder;
  logs: BuildLogStore;
  /** Null: no forge, so no connected repo, so nothing to build. */
  forge: Forge | null;
  /** How the forge acts on GitHub. A GitHub row whose tenant does not fit it is no subject and
   * is not reconciled (`fitsForge`): the forge refuses every read of it, every tick — as it does
   * a GitLab row connected on another instance (GitLab's mode is read off `forge`).
   * Null/absent: the mode is unknown and every row is one. */
  githubMode?: GithubModeSource | null;
  diag: Diagnostics;
  now(): Date;
  config: EnvironmentsServiceConfig;
  /** ABANDON_GRACE_MS unless given; a test's is short. */
  abandonGraceMs?: number;
}

/** One repo of a subject's checkout. */
export interface SubjectMember {
  repo: ConnectedRepo;
  /** The directory under /ryph/work — the runner's layout, so the same directory a run uses. */
  path: string;
  /** The ref a default-branch build checks it out at: its workspace ref, or its default branch. */
  ref: string;
}

/** A repo or a workspace, resolved to its members and the one whose Dockerfile counts. */
export interface EnvironmentSubject {
  kind: EnvironmentSubjectKind;
  id: string;
  members: SubjectMember[];
  environmentRepo: SubjectMember;
}

/**
 * One key for a subject's whole environment definition: every member's `.ryph/` tree.
 *
 * A repo keys on its `.ryph/` tree id as it is, so a check can name it from one forge read
 * (`tree:<id>`, core/checks.ts). A workspace, of one member or several, keys on a hash over the
 * environment repo's path and each member's `(path, tree or none)`, sorted by path. So a member
 * that adds, changes or drops its `.ryph/` changes the key, and so does a member joining,
 * leaving or moving to another path, or another member becoming the one whose Dockerfile counts.
 * Null when no member has a `.ryph/` at all: the subject describes no machine.
 */
export async function definitionKey(
  kind: EnvironmentSubjectKind,
  members: ReadonlyArray<{ path: string; tree: string | null }>,
  environmentPath: string,
): Promise<string | null> {
  if (members.every((m) => m.tree === null)) return null;
  if (kind === "repo") return members[0].tree;
  const lines = members
    .map((m) => `${m.path}\u0000${m.tree ?? "-"}`)
    .sort();
  return `sha256:${await sha256Hex([`env\u0000${environmentPath}`, ...lines].join("\n"))}`;
}

/** Why a build was asked for, when its caller said nothing more specific. */
export function defaultReason(
  request: Pick<BuildRequest, "trigger" | "ref" | "defaultBranch" | "relayerOf" | "force">,
  commits: Record<string, string>,
): string {
  const at = Object.entries(commits).map(([path, sha]) => `${path} at ${sha.slice(0, 12)}`)
    .join(", ");
  const what = `${request.defaultBranch ? "the default branch" : "branch"} ${request.ref}` +
    (at === "" ? "" : ` (${at})`);
  switch (request.trigger) {
    case "push":
      return `${what}: the default branch moved`;
    case "reconcile":
      return `${what}: the scheduled reconcile found no build of the default branch's head`;
    case "harness":
      return request.relayerOf !== undefined
        ? `${what}: the harness layer changed, so ${request.relayerOf.id} is re-layered onto it`
        : `${what}: the harness layer changed`;
    case "base":
      return `${what}: the universal base image changed`;
    case "manual":
      return `${what}: rebuilt by hand${request.force ? " (forced)" : ""}`;
    case "run":
      return `${what}: a run needed it`;
    case "patch":
      return `${what}: a task's patch changed .ryph/`;
    case "check":
      return `${what}: a check suite needed it`;
  }
}

/**
 * The machine below the checkouts, as far as the forge can say: `universal` when the environment
 * repo has no `.ryph/Dockerfile`, else `dockerfile:<its blob id>`. Two builds of one subject with
 * the same key, base image and Dockerfile owner start from the same machine, whatever else under
 * any `.ryph/` differs (setup.yml, environment.md). Null when the forge did not say.
 *
 * Only the Dockerfile itself: its build context is the whole repo, so a file it `COPY`s can move
 * the machine while this stays. The builder checks the machine it built against the warm source's
 * record and builds cold when they differ (docs/environment-builders.md, "The machine is
 * checked, not assumed").
 */
export function machineKey(read: Pick<RyphTree, "dockerfile" | "dockerfileBlob">): string | null {
  if (!read.dockerfile) return "universal";
  return read.dockerfileBlob === null ? null : `dockerfile:${read.dockerfileBlob}`;
}

/** What `planFor` reads off the forge: the checkouts a build takes, the definition they make,
 * whether the environment repo's `.ryph/` has a Dockerfile, and the machine (`machineKey`). */
export interface SubjectPlan {
  checkouts: EnvironmentCheckout[];
  definition: string | null;
  dockerfile: boolean;
  machine: string | null;
}

/** What `enqueue` builds. */
export interface BuildRequest {
  subject: EnvironmentSubject;
  ref: string;
  defaultBranch: boolean;
  checkouts: EnvironmentCheckout[];
  definition: string | null;
  dockerfile: boolean;
  /** `machineKey` of the environment repo's read; null when not known. A re-layer keeps its
   * source's. */
  machine: string | null;
  trigger: EnvironmentTrigger;
  /** Why it is asked for, in a sentence (`Environment.reason`); a sentence naming the trigger
   * when the caller gives none. */
  reason?: string;
  /** Re-layer this ready row, which must have a `bakedImage`: its plan and base, stage 4 on the
   * current harness. */
  relayerOf?: Environment;
  /** Build even when a ready image of exactly these inputs exists (Rebuild). */
  force?: boolean;
}

export interface EnvironmentService {
  readonly config: EnvironmentsServiceConfig;
  readonly store: EnvironmentStore;
  readonly builderKind: EnvironmentBuilder["kind"];
  /** Whether environments are on at all — off, every run is on the default image. */
  readonly enabled: boolean;
  /** Why this deployment cannot build (manual), for the card; null when it can. */
  readonly refusedReason: string | null;
  /** Set when the builder or registry looks down — the last build could not even be attempted.
   * The resolution falls back rather than wait while this is set. */
  builderFault(): string | null;
  loadSubject(kind: EnvironmentSubjectKind, id: string): Promise<EnvironmentSubject | null>;
  /** The environment repo's branch → the plan a build of it would run, read off the forge: one
   * read per member, all at once, for its commit and its `.ryph/` tree. `refs` overrides members' refs (a
   * run's checkout); `envCommit` pins the environment repo to one commit on `envRef` instead of
   * its head (a patch's). Throws when the forge cannot answer. */
  planFor(
    subject: EnvironmentSubject,
    envRef: string,
    refs?: ReadonlyMap<string, string>,
    envCommit?: string,
  ): Promise<SubjectPlan>;
  /** Whether a branch changed `.ryph/` since it forked from the default branch, or only fell
   * behind one that did (core/ryph_baseline.ts), read through this service's forge. Never
   * throws: an unanswerable read is "its own", and `onError` hears why. */
  baseline(input: Omit<Parameters<typeof compareWithBaseline>[0], "forge">): Promise<RyphBaseline>;
  /** Queues a build, or, unforced, answers the live or ready row that already covers it. */
  enqueue(request: BuildRequest): Promise<Environment>;
  /**
   * For a superseded build, the newest other build of exactly its inputs that is still going
   * (else ready): a Rebuild's, which took its place. A run still waiting on the superseded build follows
   * it there rather than being refused (start_task.ts settleWaitingRun). Null for anything else.
   */
  successorOf(environment: Environment): Promise<Environment | null>;
  /** Supersedes the live builds of branch `ref` (not the default branch's), other than `keep`,
   * that nobody waits for, as `enqueue` does for the build it queues: what the branch's newest
   * patch moved past. */
  supersedeBranch(
    subject: EnvironmentSubject,
    ref: string,
    keep: Environment | null,
    why: string,
  ): Promise<void>;
  /** A run or a check suite stopped waiting for this build: abort it when it was a run's or a
   * check's ask and nobody else waits, with `why` as its failure. */
  release(environmentId: string, why: string): Promise<void>;
  /** The default-branch trigger: ask the forge where the subject stands and build what is due. */
  refreshSubject(subject: EnvironmentSubject, trigger: EnvironmentTrigger): Promise<void>;
  /** Claims queued builds while slots are free. */
  pump(): Promise<void>;
  /**
   * The short tick: heartbeat the builds this replica is running, abort the ones whose row moved
   * on, take over the stranded rows nobody is stamping, then pump.
   */
  tick(): Promise<void>;
  /** The hourly backstop: every subject refreshed, every repo's default branch re-read,
   * retention swept. */
  reconcile(): Promise<void>;
  /**
   * What a deploy changed: re-layer images on an old harness, rebuild images on an old base.
   * Named for when it matters, but idempotent — it compares digests and joins builds already
   * queued — so the reconcile tick runs it too, and a replica that lost the boot race to an
   * older one still catches up within the hour.
   */
  onBoot(): Promise<void>;
  /** A launch found `image`, this build's, gone from the machine (a daemon reset, an
   * `image prune -a`): this build and every other naming it as its baked image (a re-layer shares
   * its source's) are retired where still ready, so the next ask builds again rather than pick
   * one. */
  imageMissing(environmentId: string, image: string): Promise<void>;
  /** Retire what retention lets go, and remove the images of what it retired where the builder
   * can (`EnvironmentBuilder.removeImages`). */
  sweepRetention(): Promise<void>;
  /** Registered by the composition root: what to do with runs waiting on a settled build. */
  onSettled(hook: (environment: Environment) => Promise<void>): void;
  /** Registered by the composition root: work that rides the short tick after the queue's
   * (the build-result delivery backstop). */
  onTick(hook: () => Promise<void>): void;
  /** Registered by the composition root: waiters this service cannot see — check suites. A
   * build any hook answers true for is waited on, and is not superseded. */
  addWaiters(hook: (environmentId: string) => Promise<boolean>): void;
  /** Registered by the composition root: users of a build's image this service cannot see —
   * check suites. A superseded build any hook answers true for keeps its image. */
  addImageHolders(hook: (environmentId: string) => Promise<boolean>): void;
  /**
   * Resolves when no build this replica is running — started here or adopted here — is still
   * going, nor an image removal a tick or a sweep started. For tests. NOT for the drain: builds
   * run for tens of minutes against a drain deadline of seconds, so a replica on its way out hands
   * its builds over by stopping, and whichever replica ticks next adopts them.
   */
  idle(): Promise<void>;
  /** Full log text once the build has settled; while it runs, the tail of what it has logged so
   * far (`EnvironmentBuilder.liveLog`). Null when there is none. */
  readLog(environment: Environment): Promise<string | null>;
}

/** `repo-<id>` / `workspace-<id>`: the adapter derives the pushed image name from it. */
export function subjectKey(kind: EnvironmentSubjectKind, id: string): string {
  return `${kind}-${id}`;
}

/**
 * Which rows replace one another: one subject's builds of one ref, the default branch's apart
 * from a branch build of the same name. A check builds the default branch as a branch build (at
 * its base commit, which may be behind), and that image must never retire the default branch's
 * own, nor stand in for it when the deploy re-layers what is newest.
 */
export function retentionGroup(
  row: Pick<Environment, "subjectKind" | "subjectId" | "ref" | "defaultBranch">,
): string {
  return [row.subjectKind, row.subjectId, row.ref, row.defaultBranch ? "default" : "branch"]
    .join("\u0000");
}

/**
 * The layer-cache scopes a build may read and write. Default branch: its subject's shared
 * scope, both ways. Any other branch: the shared one, and it writes none — not even a scope of
 * its own, which another branch's build could write too and a third would then read. That is the
 * whole of the cache-poisoning rule.
 */
export function cacheScopeFor(
  kind: EnvironmentSubjectKind,
  id: string,
  defaultBranch: boolean,
): EnvironmentBuildPlan["cacheScope"] {
  const shared = subjectKey(kind, id);
  if (defaultBranch) return { read: [shared], write: shared };
  return { read: [shared], write: null };
}

/**
 * The ready image an INCREMENTAL build of these inputs may start from, or null: build cold.
 *
 * A warm build is stages 2–3 on an earlier build's baked image: each checkout moves to its new
 * commit in place, so git rewrites only what changed and the tree's ignored build output
 * (`target/`, `node_modules/`) survives, and setup.yml reruns on it — the same thing a run does at
 * start, which is what setup.yml is already obliged to make cheap. That is only the same machine
 * when everything below the checkout is the same, so a source must match on:
 * - the machine: the base image, the Dockerfile's owner, and either the same definition (every
 *   member's `.ryph/`) or the same `machineKey` (the environment repo's Dockerfile, or none). So a
 *   member's setup.yml or environment.md edit builds warm, and setup.yml reruns on the warm tree
 *   as it does at every run; a Dockerfile edit builds cold. A row queued before the key existed
 *   has none, and matches on the definition alone
 * - the checkouts, in order, path and repo: a workspace that gained, lost or swapped a member is a
 *   new layout
 *
 * And it must be TRUSTED as a starting point, because whatever its tree holds becomes this
 * build's: a default-branch build starts only from a default-branch image, never a branch's (the
 * same rule as the layer cache). A branch build may also start from its own branch's last image,
 * which its own code built.
 *
 * Never a build whose setup.yml broke (a step failed, or the file was invalid): a put-back keeps
 * the ignored files its step failed on, and a tree warmed from it would carry them on. So a repo
 * whose step fails at every build builds cold once no ready image whose setup did not break is left.
 *
 * Cold instead when every candidate's chain is at `maxDepth`, when the ask is a forced Rebuild, and when a warm
 * build of this branch has failed since the source was built — a warm tree that broke a build is
 * not tried again until a cold build has proved or disproved it.
 *
 * And cold for a patch's build (trigger `patch`): it exists to prove a changed definition, and a
 * warm image still holds what a removed setup step left outside the tree (a `cargo install`, files
 * under `$HOME` or `/opt`), so a setup.yml that only works on that residue would pass.
 * Default-branch rebuilds stay warm and carry such leftovers until the next cold build.
 */
export function warmSource(
  history: Environment[],
  want: {
    ref: string;
    defaultBranch: boolean;
    definition: string | null;
    machine: string | null;
    baseImage: string;
    dockerfileFrom: string | null;
    checkouts: Array<{ path: string; connectedRepoId: string }>;
    force: boolean;
    trigger: EnvironmentTrigger;
  },
  maxDepth: number,
): Environment | null {
  if (maxDepth <= 0 || want.force || want.definition === null) return null;
  if (want.trigger === "patch") return null;
  const trusted = (row: Environment) =>
    row.defaultBranch || (!want.defaultBranch && row.ref === want.ref);
  // Each path must hold the same repo: a workspace member swapped for another at the same path
  // would have the new repo's commit fetched into the old repo's clone.
  const layout = (checkouts: Array<{ path: string; connectedRepoId: string }>) =>
    checkouts.map((c) => `${c.path}\u0000${c.connectedRepoId}`).join("\u0001");
  const samePaths = (row: Environment) => layout(row.plan.checkouts) === layout(want.checkouts);
  const sameMachine = (row: Environment) =>
    row.definition === want.definition ||
    (want.machine !== null && (row.plan.machine ?? null) === want.machine);
  const candidates = history.filter((row) =>
    row.status === "ready" && row.bakedImage !== null && trusted(row) && sameMachine(row) &&
    sameImage(row.baseDigest, want.baseImage) &&
    row.plan.dockerfileFrom === want.dockerfileFrom && samePaths(row) &&
    !(row.setupWarnings ?? []).some(setupBroke)
  ).sort((a, b) =>
    // The branch's own image first: it is the nearest tree to where the branch is now.
    Number(b.ref === want.ref) - Number(a.ref === want.ref) || byNewestBuilt(a, b)
  );
  // The nearest one the chain still allows: a branch's own image at the cap gives way to the
  // default branch's, which may be shallower.
  const source = candidates.find((row) => (row.plan.depth ?? 0) + 1 <= maxDepth);
  if (source === undefined) return null;
  const since = Date.parse(source.finishedAt ?? source.createdAt);
  // This machine's own failures only: a check's build of the default branch at its base
  // (`defaultBranch: false`) failing warm says nothing about the default branch's own builds.
  const warmFailed = history.some((row) =>
    row.ref === want.ref && row.defaultBranch === want.defaultBranch &&
    row.status === "failed" && (row.plan.warmFrom ?? null) !== null &&
    Date.parse(row.createdAt) >= since
  );
  return warmFailed ? null : source;
}

/**
 * Whether a ready build's setup.yml did not finish (`Environment.setupWarnings`, any kind but
 * `dirty`: a setup that finished and only had what it left in the tree discarded built the
 * machine its definition describes). Such an image serves a run — a run reruns setup.yml and
 * warns again — but it answers only for the commit it was built at: a step can fail on a
 * lockfile or a script outside `.ryph/`, so a new commit may be built again early, once per
 * episode (`warningRebuildDue`). And a check suite, which does not rerun setup.yml, prefers a
 * clean image of the same definition over it (`newestForChecks`), which retention keeps
 * (`retainedOfGroup`).
 */
export function setupUnfinished(row: Pick<Environment, "setupWarnings">): boolean {
  return setupUnfinishedIn(row.setupWarnings);
}

/** Whether a build completed with an image: ready, or retired since. Not a failed build, and
 * not one superseded before it finished (those never had an image). */
function builtImage(row: Environment): boolean {
  return (row.status === "ready" || row.status === "superseded") && row.image !== null &&
    row.finishedAt !== null;
}

/**
 * Whether `latest` — a ready build whose setup.yml did not finish — earns a build of a newer
 * commit now, ahead of the usual cadence: the commit may be the fix (a lockfile, a script setup.yml
 * runs). Once per warning episode: only when the completed build before it, of the same
 * definition, finished setup.yml (or there is none). The early build that follows is then itself
 * preceded by a warned build, so when it warns too — a step that fails only at build time, for a
 * service, a secret or a host a build has no way to reach, fails on every commit — no further
 * build is early: the default branch falls back to `rebuildIntervalMs`, a branch to the builds a
 * `.ryph/` change asks for. A clean build ends the episode. A re-layer is judged by the build
 * whose tree it carries. `rows` is the group's history, any order and status.
 */
export function warningRebuildDue(latest: Environment, rows: readonly Environment[]): boolean {
  if (latest.status !== "ready" || !setupUnfinished(latest)) return false;
  const byId = new Map(rows.map((r) => [r.id, r]));
  let tree = latest;
  for (let hops = 0; tree.plan.relayerOf !== null && hops < rows.length; hops++) {
    const source = byId.get(tree.plan.relayerOf.environmentId);
    if (source === undefined) break;
    tree = source;
  }
  const before =
    rows.filter((r) =>
      r.id !== tree.id && r.id !== latest.id && r.plan.relayerOf === null &&
      r.definition === tree.definition && builtImage(r) && byNewestBuilt(tree, r) < 0
    ).sort(byNewestBuilt)[0];
  return before === undefined || !setupUnfinished(before);
}

/**
 * The image a launcher that does NOT rerun `.ryph/setup.yml` — a check suite — takes of these
 * ready rows: the newest, unless its setup.yml did not finish and a clean one OF THE SAME
 * DEFINITION exists, the newest such — that one lacks nothing the definition asks for, where the
 * warned one lacks what its failed steps would have installed, and a check run on it fails on
 * that rather than on the change it judges. A clean image of an older definition is not the
 * machine the repo describes now, so the newest is taken over it, and the check feedback's
 * "setup unfinished" sentence explains. Null with no rows.
 */
export function newestForChecks(rows: readonly Environment[]): Environment | null {
  const ready = [...rows].sort(byNewestBuilt);
  const newest = ready[0];
  if (newest === undefined) return null;
  if (!setupUnfinished(newest)) return newest;
  return ready.find((row) => row.definition === newest.definition && !setupUnfinished(row)) ??
    newest;
}

/**
 * The ready rows of one retention group (`retentionGroup`) that retention keeps: the newest —
 * and the image a check suite launches on instead while the newest's setup.yml did not finish
 * (`newestForChecks`: a clean one of the same definition), until a clean successor settles. A
 * clean image of an older definition is not kept for it. Everything else in the group may
 * retire. `rows` need not be sorted.
 */
export function retainedOfGroup(rows: Environment[]): Set<string> {
  const ready = rows.filter((row) => row.status === "ready");
  const keep = new Set<string>();
  const newest = [...ready].sort(byNewestBuilt)[0];
  if (newest === undefined) return keep;
  keep.add(newest.id);
  keep.add(newestForChecks(ready)!.id);
  return keep;
}

/** What a build does, which is most of what decides how long it takes. */
export type BuildKind = "full" | "incremental" | "relayer";

export function buildKindOf(row: Environment): BuildKind {
  if (row.plan.relayerOf !== null) return "relayer";
  return (row.plan.warmFrom ?? null) !== null ? "incremental" : "full";
}

/**
 * How long a build of this kind usually takes for this subject: the median of its last five
 * ready builds of the same kind, or null with none to go by. An estimate for a person watching,
 * never a deadline — a cold build after a lockfile change is slower than the last one and nothing
 * here pretends otherwise.
 */
export function typicalBuildMs(history: Environment[], kind: BuildKind): number | null {
  const took = history
    .filter((row) =>
      row.status !== "queued" && row.status !== "building" && row.status !== "failed" &&
      row.image !== null && row.startedAt !== null && row.finishedAt !== null &&
      buildKindOf(row) === kind
    )
    .sort(byNewestBuilt)
    .slice(0, 5)
    .map((row) => Date.parse(row.finishedAt!) - Date.parse(row.startedAt!))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (took.length === 0) return null;
  const mid = Math.floor(took.length / 2);
  return took.length % 2 === 1 ? took[mid] : Math.round((took[mid - 1] + took[mid]) / 2);
}

/** The last lines of a log, bounded. */
export function logTailOf(log: string): string {
  const lines = log.trimEnd().split("\n");
  const tail = lines.slice(-LOG_TAIL_LINES).join("\n");
  return tail.length > LOG_TAIL_CHARS ? tail.slice(-LOG_TAIL_CHARS) : tail;
}

/** Why a deployment on this builder cannot build at all, or null. */
export function builderRefusal(kind: EnvironmentBuilder["kind"]): string | null {
  if (kind === "manual") {
    return "the manual provisioner builds nothing: every run uses the default image " +
      "(set RYPH_ENV_BUILDER, or run a docker or kubernetes provisioner)";
  }
  return null;
}

/**
 * The registry hosts of image references, where one is named: `europe-docker.pkg.dev/p/r@…` →
 * `europe-docker.pkg.dev`. A bare `ryph-harness:dev` names none — a local image, or Docker Hub,
 * which a deployment that wants it allows like any other host.
 */
export function registryHosts(refs: ReadonlyArray<string | null>): string[] {
  const hosts = new Set<string>();
  for (const ref of refs) {
    if (ref === null || !ref.includes("/")) continue;
    const first = ref.split("/")[0];
    if (!first.includes(".") && !first.includes(":") && first !== "localhost") continue;
    hosts.add(first.replace(/:\d+$/, "").toLowerCase());
  }
  return [...hosts].sort();
}

const nullIfEmpty = <T>(items: T[]): T[] | null => items.length === 0 ? null : items;

/** Whether two commit maps name the same commits. */
function sameCommits(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Two builds of one machine: the same commits, definition, harness and base, of the same kind. */
function sameInputs(a: Environment, b: Environment): boolean {
  return a.defaultBranch === b.defaultBranch && sameCommits(a.commits, b.commits) &&
    a.definition === b.definition && sameImage(a.harnessDigest, b.harnessDigest) &&
    sameImage(a.baseDigest, b.baseDigest);
}

const byNewest = (a: Environment, b: Environment) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Ready images, newest BUILT first: a re-layer queued before a base rebuild may land after it. */
export const byNewestBuilt = (a: Environment, b: Environment) =>
  (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt) || byNewest(a, b);

export function makeEnvironmentService(deps: EnvironmentsDeps): EnvironmentService {
  const { store, tasks, builder, diag, config } = deps;
  const envConfig = config.environments;
  const refusedReason = builderRefusal(builder.kind);
  const nowIso = () => deps.now().toISOString();

  /** Builds this replica runs, by row id. */
  const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let fault: string | null = null;
  let pumping = false;
  let pumpAgain = false;
  const settledHooks: Array<(environment: Environment) => Promise<void>> = [];
  const tickHooks: Array<() => Promise<void>> = [];

  const liveRuns = async (): Promise<Run[]> =>
    (await tasks.listActiveRuns()).filter((r) => !TERMINAL_STATES.has(r.state));
  const waitersOf = async (environmentId: string): Promise<Run[]> =>
    (await liveRuns()).filter((r) => r.environmentWait?.environmentId === environmentId);
  const waiterHooks: Array<(environmentId: string) => Promise<boolean>> = [];
  const imageHolderHooks: Array<(environmentId: string) => Promise<boolean>> = [];
  /** Whether anything waits for this build: a live run, or what a hook knows of. A hook that
   * cannot answer is a yes — keeping a build is the cheap mistake. */
  const waitedOn = async (environmentId: string): Promise<boolean> => {
    if ((await waitersOf(environmentId)).length > 0) return true;
    for (const hook of waiterHooks) {
      if (await hook(environmentId).catch(() => true)) return true;
    }
    return false;
  };

  const loadSubject = async (
    kind: EnvironmentSubjectKind,
    id: string,
  ): Promise<EnvironmentSubject | null> => {
    if (kind === "repo") {
      const repo = await tasks.getConnectedRepo(id);
      if (repo === null || repo.archivedAt !== null) return null;
      const member = { repo, path: defaultPathFor(repo.repoRef), ref: repo.defaultBranch };
      return { kind, id, members: [member], environmentRepo: member };
    }
    const resolved = await resolveWorkspace(tasks, id);
    if (resolved.kind === "refused") return null;
    const members = resolved.members.map(({ membership, repo }) => ({
      repo,
      path: membership.path,
      ref: membership.ref ?? repo.defaultBranch,
    }));
    // A chosen repo that has since left the workspace is as good as none: the first member.
    const chosen = members.find((m) => m.repo.id === resolved.workspace.environmentRepoId);
    return { kind, id, members, environmentRepo: chosen ?? members[0] };
  };

  const planFor: EnvironmentService["planFor"] = async (subject, envRef, refs, envCommit) => {
    const forge = deps.forge;
    if (forge === null) throw new Error("no forge to read the repos' heads through");
    // One read per member, all at once: the commit the build checks out and the `.ryph/` tree
    // that is its part of the definition. The environment repo's Dockerfile alone shapes the
    // machine. Each read is a different repo, so one slow member costs its own time, not the sum.
    const reads = await Promise.all(subject.members.map(async (member) => {
      const isEnvRepo = member.repo.id === subject.environmentRepo.repo.id;
      const ref = isEnvRepo ? envRef : refs?.get(member.repo.id) ?? member.ref;
      const read = await forge.ryphTree(
        forgeRepoRef(member.repo),
        member.repo.url,
        isEnvRepo && envCommit !== undefined ? envCommit : ref,
      );
      return { member, isEnvRepo, ref, read };
    }));
    const checkouts: EnvironmentCheckout[] = reads.map(({ member, ref, read }) => ({
      path: member.path,
      connectedRepoId: member.repo.id,
      ref: normalizeBaseRef(ref).localBranch,
      commit: read.commit,
    }));
    const trees = reads.map(({ member, read }) => ({ path: member.path, tree: read.tree }));
    const envRead = reads.find(({ isEnvRepo }) => isEnvRepo)!.read;
    const definition = await definitionKey(subject.kind, trees, subject.environmentRepo.path);
    return { checkouts, definition, dockerfile: envRead.dockerfile, machine: machineKey(envRead) };
  };

  const commitsOf = (checkouts: EnvironmentCheckout[]): Record<string, string> =>
    Object.fromEntries(checkouts.map((c) => [c.path, c.commit]));

  /**
   * Aborts a build nobody needs any more. A local one is signalled; one on another replica is
   * marked, and that replica's tick sees the mark and aborts its own. A queued one never starts.
   *
   * A row nobody here is running is the case the mark alone cannot reach: the abort is a call
   * into a map this process does not have, and the row leaves `building`, so the stranded sweep
   * will never look at it again either. If the replica that started it is gone, nothing is left
   * to stop the build — so the builder's own record of it is discarded here, which is what ends a
   * Job that would otherwise run out its deadline holding a node and a work volume for an image
   * nobody will ever launch. Asked for a queued row too, where there is nothing to discard and
   * saying so costs one refused call: the row may have been claimed between the listing and the
   * mark, and a build started in that gap has a record like any other.
   */
  const supersede = async (row: Environment, why: string): Promise<void> => {
    const at = nowIso();
    const marked = await store.saveEnvironmentIfStatus(
      { ...row, status: "superseded", failure: why, finishedAt: at, updatedAt: at },
      ["queued", "building"],
    );
    if (!marked) return;
    const local = inFlight.get(row.id);
    if (local !== undefined) local.controller.abort(why);
    else {
      await builder.discard(row.id).catch((err) =>
        diag.warn("environments.discard_failed", { environmentId: row.id, err: String(err) })
      );
    }
    await store.revokeBuildGitKeys(row.id, at);
    diag.debug("environments.superseded", { environmentId: row.id, why });
  };

  const successorOf: EnvironmentService["successorOf"] = async (row) => {
    if (row.status !== "superseded") return null;
    const history = await store.listEnvironmentsForSubject(row.subjectKind, row.subjectId, {
      ref: row.ref,
    });
    // No age test: two rows can share a timestamp. Nothing superseded is a candidate, so a
    // build can never be its own successor's successor. A live build first: it is the Rebuild.
    const same = history.filter((other) => other.id !== row.id && sameInputs(other, row));
    return same.find((other) => other.status === "queued" || other.status === "building") ??
      same.find((other) => other.status === "ready") ?? null;
  };

  /**
   * Moves the runs waiting on `from` to wait on `to` instead. Written through the waiting run's
   * compare-and-set, so a run `from` launched, refused or a cancel took in the meantime stays
   * where it is. Should `to` settle before a run is moved, the reaper's backstop launches it.
   */
  const handOverWaiters = async (from: Environment, to: Environment): Promise<void> => {
    for (const run of await waitersOf(from.id)) {
      if (run.state !== "starting" || run.handle !== null) continue;
      const at = nowIso();
      const moved = await tasks.saveRunIfWaiting({
        ...run,
        environmentWait: { environmentId: to.id, status: "queued" },
        updatedAt: at,
      }, from.id);
      if (!moved) continue;
      await tasks.appendEvent({
        runId: run.id,
        at,
        kind: "environment.building",
        detail: `environment ${from.id} was rebuilt by hand: waiting for environment ${to.id}`,
      });
    }
  };

  /** Supersedes the live builds in `history` (one branch's) on that side of it, other than
   * `except`, that nobody waits for. */
  const supersedeLive = async (
    history: Environment[],
    defaultBranch: boolean,
    except: string | null,
    why: string,
  ): Promise<void> => {
    for (const row of history) {
      if (row.status !== "queued" && row.status !== "building") continue;
      if (row.defaultBranch !== defaultBranch || row.id === except) continue;
      if (await waitedOn(row.id)) continue;
      await supersede(row, why);
    }
  };

  const enqueue: EnvironmentService["enqueue"] = async (request) => {
    const { subject, ref, relayerOf } = request;
    if (relayerOf !== undefined && relayerOf.bakedImage === null) {
      throw new Error(`environment ${relayerOf.id} has no baked image to re-layer`);
    }
    const harness = envConfig.harnessImage ?? "";
    const base = relayerOf?.baseDigest ?? envConfig.baseImage ?? "";
    const commits = relayerOf?.commits ?? commitsOf(request.checkouts);
    const relayerOnly = relayerOf !== undefined;
    const history = await store.listEnvironmentsForSubject(subject.kind, subject.id, { ref });
    // A default-branch row and a branch row of the same ref are different machines, even at one
    // commit: a check's build of the default branch at its base (`defaultBranch: false`) must
    // never answer for the default branch's own image, nor that image for it.
    const covers = (row: Environment) =>
      row.defaultBranch === request.defaultBranch &&
      sameCommits(row.commits, commits) && row.definition === request.definition &&
      sameImage(row.harnessDigest, harness) && sameImage(row.baseDigest, base);
    // Idempotent: a build of exactly these inputs already queued or running is THE build, and
    // an unforced ask for inputs already built is answered by the image. A forced ask (Rebuild)
    // joins nothing: a person presses it because the build that is going is no good any more —
    // refused a host the allowlist has since let in, say — so it queues a fresh one and takes
    // that build's place below.
    const live = history.filter((row) =>
      (row.status === "queued" || row.status === "building") && covers(row)
    );
    if (live.length > 0 && !request.force) return live[0];
    if (!request.force) {
      const built = history.find((row) => row.status === "ready" && covers(row));
      if (built !== undefined) return built;
      // A deploy's asks (and the hourly one that repeats them) are not retries: the same inputs
      // on the same harness and base fail the same way, so the failure is the answer until one
      // of them moves — a new commit, a Rebuild, the next deploy.
      if (request.trigger === "harness" || request.trigger === "base") {
        const failed = history.find((row) => row.status === "failed" && covers(row));
        if (failed !== undefined) return failed;
      }
    }

    // Older builds of this branch nobody waits for are superseded by this one — unless this one
    // is a re-layer or a base rebuild: the first finishes what a queued build would anyway, and
    // the second is the lowest priority there is and must not cancel the re-layer runs wait for.
    // Nor a check's: it builds the base at an older commit, which replaces nothing.
    const supersedes = !relayerOnly && request.trigger !== "base" && request.trigger !== "check";
    if (supersedes) {
      await supersedeLive(
        history,
        request.defaultBranch,
        null,
        "a newer build of this branch was queued",
      );
    }

    const at = nowIso();
    const dockerfileFrom = request.dockerfile ? subject.environmentRepo.path : null;
    // A re-layer carries its source's depth: it moves the same baked image onto a new harness.
    const warm = relayerOnly ? null : warmSource(
      await store.listEnvironmentsForSubject(subject.kind, subject.id),
      {
        ref,
        defaultBranch: request.defaultBranch,
        definition: request.definition,
        machine: request.machine,
        baseImage: base,
        dockerfileFrom,
        checkouts: request.checkouts,
        force: request.force === true,
        trigger: request.trigger,
      },
      envConfig.warmChain,
    );
    const plan: EnvironmentBuildPlan = relayerOf !== undefined
      ? {
        ...relayerOf.plan,
        relayerOf: { environmentId: relayerOf.id, bakedImage: relayerOf.bakedImage! },
        warmFrom: null,
        depth: relayerOf.plan.depth ?? 0,
      }
      : {
        checkouts: request.checkouts,
        dockerfileFrom,
        machine: request.machine,
        cacheScope: cacheScopeFor(subject.kind, subject.id, request.defaultBranch),
        relayerOf: null,
        warmFrom: warm === null ? null : { environmentId: warm.id, bakedImage: warm.bakedImage! },
        depth: warm === null ? 0 : (warm.plan.depth ?? 0) + 1,
      };
    const row: Environment = {
      id: mintId("env"),
      subjectKind: subject.kind,
      subjectId: subject.id,
      ref,
      defaultBranch: request.defaultBranch,
      commits,
      definition: request.definition,
      baseDigest: base,
      harnessDigest: harness,
      image: null,
      bakedImage: null,
      machineImage: null,
      status: "queued",
      toolchains: {},
      sizeBytes: null,
      trigger: request.trigger,
      reason: request.reason ?? defaultReason(request, commits),
      plan,
      logRef: null,
      logTail: null,
      failure: null,
      egressRefusals: null,
      setupWarnings: null,
      imagesRemovedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.createEnvironment(row);
    diag.debug("environments.queued", {
      environmentId: row.id,
      subject: subjectKey(subject.kind, subject.id),
      ref,
      trigger: request.trigger,
      relayerOnly,
      warmFrom: plan.warmFrom?.environmentId ?? null,
    });
    // A Rebuild takes over the runs waiting on the build of the same inputs it replaces, then
    // supersedes that build. They asked for exactly this machine, and the fresh build is the one
    // with a chance of making it. A waiter it cannot move (a check suite) keeps the old build
    // going, as the supersede rule says: a waiter is never left on a build nobody runs.
    // A run that took `old` from an ask racing this one may only start waiting on it after the
    // first hand-over listed its waiters: the second, once `old` is superseded, moves it; one
    // that comes later still follows here when it settles (`successorOf`), never refused.
    for (const old of request.force ? live : []) {
      await handOverWaiters(old, row);
      if (await waitedOn(old.id)) continue;
      await supersede(old, "rebuilt by hand");
      await handOverWaiters(old, row);
    }
    // Not awaited: the caller wants the row, and the build happens behind it.
    pump().catch((err) => diag.warn("environments.pump_failed", { err: String(err) }));
    return row;
  };

  const release: EnvironmentService["release"] = async (environmentId, why) => {
    const row = await store.getEnvironment(environmentId);
    if (row === null || (row.status !== "queued" && row.status !== "building")) return;
    // Only a branch build a run or a check suite asked for is theirs to call off. A
    // default-branch build is the subject's, and useful to the next run whether or not this one
    // stayed.
    if (row.defaultBranch || (row.trigger !== "run" && row.trigger !== "check")) return;
    if (await waitedOn(row.id)) return;
    await supersede(row, why);
  };

  /** The builder's spec for a claimed row: the plan plus this moment's credentials. */
  const specFor = async (row: Environment): Promise<BuildSpec> => {
    const relayerFrom = row.plan.relayerOf?.bakedImage ?? null;
    const base = {
      environmentId: row.id,
      subjectKey: subjectKey(row.subjectKind, row.subjectId),
      dockerfileFrom: row.plan.dockerfileFrom,
      checkouts: row.plan.checkouts,
      baseImage: row.baseDigest,
      harnessImage: row.harnessDigest,
      defaultBranch: row.defaultBranch,
      cacheScope: row.plan.cacheScope,
      relayerFrom,
      warmFrom: relayerFrom === null ? row.plan.warmFrom?.bakedImage ?? null : null,
      timeoutMs: envConfig.buildTimeoutMs,
    };
    // A re-layer clones nothing, so it is given no git credential at all.
    if (relayerFrom !== null) {
      return { ...base, proxyEnv: await proxyEnvFor(row), clone: { urls: {}, env: {} } };
    }
    const repos = new Map<string, ConnectedRepo>();
    for (const checkout of row.plan.checkouts) {
      const repo = await tasks.getConnectedRepo(checkout.connectedRepoId);
      if (repo === null || repo.archivedAt !== null) {
        throw new Error(`${checkout.path}: its repo is disconnected`);
      }
      repos.set(checkout.path, repo);
    }
    const urls: Record<string, string> = {};
    let cloneEnv: Record<string, string> = {};
    const gateway = config.gitGateway;
    if (gateway !== null) {
      // The clone goes through the gateway on a key of the build's own, which resolves to these
      // checkouts only and only while this row is building (http/forge_api.ts).
      const token = mintToken();
      const at = nowIso();
      await store.createBuildGitKey({
        id: mintId("bk"),
        environmentId: row.id,
        tokenHash: await sha256Hex(token),
        expiresAt: new Date(deps.now().getTime() + envConfig.buildTimeoutMs + ORPHAN_GRACE_MS)
          .toISOString(),
        revokedAt: null,
        createdAt: at,
      });
      // The gateway as the builder's clone dials it, which is not always where a run does.
      const base = envConfig.buildGatewayUrl ?? gateway.url;
      for (const checkout of row.plan.checkouts) {
        urls[checkout.path] = `${base}/v1/git/${row.id}/${checkout.connectedRepoId}/repo.git`;
      }
      cloneEnv = gatewayGitEnv(base, token);
    } else {
      for (const checkout of row.plan.checkouts) {
        urls[checkout.path] = repos.get(checkout.path)!.url;
      }
    }
    return { ...base, proxyEnv: await proxyEnvFor(row), clone: { urls, env: cloneEnv } };
  };

  /**
   * The build's way out: a claim minted exactly like a run's, but at the deployment's CEILING —
   * a build serves every agent, so no one agent's narrower policy applies. Handed to the build as
   * Docker's predefined proxy args, which BuildKit keeps out of the image history. Empty when the
   * deployment claims no boundary or has not wired one; the builder then confines as it can.
   *
   * Plus the registries the build's own images live in: where the builder has no way out but the
   * proxy (kubernetes), BuildKit pulls the base and harness and pushes the result through it too.
   * Those are the platform's registries, named by the operator, never by the repo.
   */
  const proxyEnvFor = async (row: Environment): Promise<Record<string, string>> => {
    const environmentId = row.id;
    const { policy, key, tokenTtlMs } = config.egress;
    if (policy.mode !== "proxy" || key === null || policy.proxyUrl === null) return {};
    const ceiling = await liveCeiling(tasks, policy);
    const scope = resolveNetworkScope(null, ceiling);
    if (scope.kind === "refused") throw new Error(scope.error);
    const token = await mintEgressToken(key, {
      runId: environmentId,
      expiresAt: Math.floor(
        (deps.now().getTime() + Math.min(tokenTtlMs, envConfig.buildTimeoutMs + ORPHAN_GRACE_MS)) /
          1000,
      ),
      hosts: [
        ...new Set([
          ...scope.scope.hosts,
          ...registryHosts([
            row.baseDigest,
            row.harnessDigest,
            envConfig.registry,
            envConfig.branchRegistry,
          ]),
        ]),
      ],
    });
    // The proxy as the BUILDER dials it: a Cloud Build worker is outside the cluster.
    return proxyEnv(envConfig.buildProxyUrl ?? policy.proxyUrl, environmentId, token);
  };

  const settle = async (row: Environment, result: BuildResult, aborted: string | null) => {
    const at = nowIso();
    // Named now, WRITTEN only if this settle wins the row. Two watchers of one build reach here
    // with two results (the window adoption cannot close — see `adoptBuild`), and the one whose
    // compare-and-set loses must leave nothing behind: a log put before the save would drop its
    // own narration — "the build job disappeared" — on the key the winning row points at, so the
    // page would show a ready image beside the wrong build's log, and the real one would be gone.
    const logRef = result.log !== "" ? `environments/${row.id}.log` : null;
    // An incremental build the builder built cold instead (its machine changed under the image it
    // would have started from) is recorded as what it is: the start of a new chain.
    const wentCold = result.ok && result.warm === false && (row.plan.warmFrom ?? null) !== null;
    const settled: Environment = result.ok
      ? {
        ...row,
        plan: wentCold ? { ...row.plan, warmFrom: null, depth: 0 } : row.plan,
        status: "ready",
        image: result.image,
        bakedImage: result.bakedImage,
        machineImage: result.machineImage ?? null,
        sizeBytes: result.sizeBytes,
        toolchains: result.toolchains,
        // A setup.yml that did not finish is a warning on a READY build, never its failure:
        // the row carries it to the card and to the build-result message. Only the build's own
        // checkout paths, an unreadable record named on the first of them.
        setupWarnings: nullIfEmpty(
          setupWarningsForBuild(result.setupWarnings ?? [], row.plan.checkouts.map((c) => c.path)),
        ),
        logRef,
        logTail: logTailOf(result.log),
        failure: null,
        finishedAt: at,
        updatedAt: at,
      }
      : {
        ...row,
        status: aborted !== null ? "superseded" : "failed",
        logRef,
        logTail: result.logTail !== "" ? result.logTail : logTailOf(result.log),
        failure: aborted ?? result.message,
        finishedAt: at,
        updatedAt: at,
      };
    const landed = await store.saveEnvironmentIfStatus(settled, ["building"]);
    await store.revokeBuildGitKeys(row.id, at);
    // The result is safe in the row, so the builder's record of the build can go — and not one
    // moment earlier (ports/environment_builder.ts). A settle that lost asks too: the record is
    // named for the environment, so it can only ever be this build's, and the winner has already
    // read everything it holds.
    await builder.discard(row.id).catch((err) =>
      diag.warn("environments.discard_failed", { environmentId: row.id, err: String(err) })
    );
    if (!landed) {
      diag.debug("environments.settle_dropped", { environmentId: row.id });
      await dropUnrecorded(row, result);
      return;
    }
    if (logRef !== null) {
      try {
        await deps.logs.put(logRef, result.log);
      } catch (err) {
        diag.warn("environments.log_put_failed", { environmentId: row.id, err: String(err) });
        // The row points at a key that is not there: say so, rather than offer a log that 404s.
        await store.saveEnvironmentIfStatus({ ...settled, logRef: null }, [settled.status]);
      }
    }
    diag.debug("environments.settled", {
      environmentId: row.id,
      status: settled.status,
      failure: settled.failure,
    });
    if (settled.status === "ready") {
      await retireGroup(settled).catch((err) =>
        diag.warn("environments.retention_failed", { environmentId: row.id, err: String(err) })
      );
    }
    // Re-read rather than announce the copy just written: the refusals column is the store's
    // narrow append alone (drizzle_environments.ts), so `settled` cannot carry a host the proxy
    // reported while this build ran — which is the one thing the hooks below must say.
    await announce(await store.getEnvironment(row.id) ?? settled);
  };

  /**
   * A build that succeeded after its row moved on (superseded while it ran): no row records its
   * images, so nothing could ever take them or retire them. Its own names go now, and nothing it
   * reported is deleted on its word: a digest it claims could be one a build still in flight has
   * just pushed and not yet recorded, which no row names yet to protect. Untagged, its images are
   * the reconcile's, whose age gate outlives any build that could still record them (on docker a
   * name is the image, so untagging it is the removal).
   */
  const dropUnrecorded = async (row: Environment, result: BuildResult) => {
    if (!result.ok || builder.removeImages === undefined) return;
    const stored = await store.getEnvironment(row.id);
    if (stored?.image === result.image) return;
    await builder.removeImages({
      environmentId: row.id,
      subjectKey: subjectKey(row.subjectKind, row.subjectId),
      defaultBranch: row.defaultBranch,
      recorded: false,
      image: null,
      machineImage: null,
      bakedImage: null,
    }).catch((err) =>
      diag.warn("environments.remove_images_failed", { environmentId: row.id, err: String(err) })
    );
  };

  /**
   * The images of `refs` that only row `id` names, as a filter: the others come back null, to be
   * kept. A recorded digest is the build's own report, and two builds can report one digest — the
   * machine of every build of an unchanged `.ryph/Dockerfile` does, an identical image could, and
   * a build whose steps reach its log could claim another's — so before one is handed to
   * `removeImages` to delete, every other row not yet done with and every live run's frozen image
   * is asked. The registry's own refusal to delete a tagged version is no substitute: whoever may
   * push may move a tag off a version too.
   *
   * `liveDigests` is read once per removal pass rather than per row, and that stays sound because
   * of the per-row store query, not the registry: a run that starts during the pass launches on a
   * READY row, which is not done with and names its digest, so the query this asks for each row
   * sees it whatever the run list said at the start. The ready row's tag on the version, which an
   * unforced delete would be refused over, is only a second layer: anything that may write the
   * registry may move a tag.
   */
  const notNamedByOthers = async (
    id: string,
    refs: Array<string | null>,
    liveDigests: ReadonlySet<string>,
  ): Promise<(ref: string | null) => string | null> => {
    const digests = refs.map(digestOf).filter((d): d is string => d !== null);
    if (digests.length === 0) return (ref) => ref;
    const named = new Set<string>();
    const name = (ref: string | null | undefined) => {
      const digest = digestOf(ref);
      if (digest !== null) named.add(digest);
    };
    for (const other of await store.listEnvironmentsNamingDigests(digests)) {
      if (other.id === id || other.imagesRemovedAt) continue;
      [other.image, other.bakedImage, other.machineImage].forEach(name);
    }
    return (ref) => {
      const digest = digestOf(ref);
      return digest !== null && (named.has(digest) || liveDigests.has(digest)) ? null : ref;
    };
  };

  const announce = async (row: Environment) => {
    for (const hook of settledHooks) {
      await hook(row).catch((err) =>
        diag.warn("environments.settled_hook_failed", { environmentId: row.id, err: String(err) })
      );
    }
  };

  const run = async (row: Environment, controller: AbortController): Promise<void> => {
    let timedOut = false;
    // The core's own cap, a little past the builder's (a tenth of it, at most 30 s), and past
    // that the adapter gets ABANDON_GRACE_MS to act on the abort: one that ignores its timeout,
    // or hangs on a call that never returns, still frees the slot — the build is settled without
    // it and the adapter's eventual answer, if any, is dropped.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("the build ran past RYPH_ENV_BUILD_TIMEOUT");
    }, envConfig.buildTimeoutMs + Math.min(30_000, Math.ceil(envConfig.buildTimeoutMs / 10)));
    let abandonTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const abandoned = new Promise<BuildResult>((resolve) => {
      onAbort = () => {
        abandonTimer = setTimeout(() => {
          const message = "the builder did not stop when told to, and was abandoned";
          diag.warn("environments.build_abandoned", { environmentId: row.id });
          resolve({ ok: false, kind: "failed", message, logTail: message, log: "" });
        }, deps.abandonGraceMs ?? ABANDON_GRACE_MS);
      };
    });
    const stopWatching = () => {
      controller.signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      clearTimeout(abandonTimer);
    };
    let result: BuildResult;
    // Waiting runs see the build start.
    await announce(row);
    let spec: BuildSpec;
    try {
      spec = await specFor(row);
    } catch (err) {
      // The build's inputs could not be assembled (a repo disconnected since it was queued, an
      // egress ceiling the deployment no longer allows): this build fails, the builder is fine.
      stopWatching();
      const message = `the build could not be prepared: ${
        err instanceof Error ? err.message : String(err)
      }`;
      await settle(row, { ok: false, kind: "failed", message, logTail: message, log: "" }, null);
      return;
    }
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      result = await Promise.race([builder.build(spec, { signal: controller.signal }), abandoned]);
      if (result.ok) {
        fault = null;
      } else if (result.kind === "refused") {
        fault = result.message;
      }
    } catch (err) {
      // A reject is a bug in the adapter: nothing was built, and the runs that would wait for
      // the next build fall back instead until one succeeds.
      fault = String(err instanceof Error ? err.message : err);
      diag.warn("environments.build_threw", { environmentId: row.id, err: String(err) });
      result = { ok: false, kind: "failed", message: fault, logTail: "", log: "" };
    } finally {
      stopWatching();
    }
    const aborted = controller.signal.aborted && !timedOut
      ? String(controller.signal.reason ?? "aborted")
      : null;
    if (timedOut && !result.ok) {
      result = { ...result, kind: "timeout", message: "the build ran past RYPH_ENV_BUILD_TIMEOUT" };
    }
    await settle(row, result, aborted);
  };

  /** The spec an adoption is assembled from: the row, and nothing else. No forge read and no
   * freshly minted credential — the build being taken over already has everything it needed, and
   * a repo disconnected since it started must not stop its result being collected. */
  const adoptSpecFor = (row: Environment): AdoptSpec => ({
    environmentId: row.id,
    subjectKey: subjectKey(row.subjectKind, row.subjectId),
    defaultBranch: row.defaultBranch,
    relayerFrom: row.plan.relayerOf?.bakedImage ?? null,
    timeoutMs: envConfig.buildTimeoutMs,
  });

  /**
   * Whether the CLUSTER would have ended this build by now on its own — the row's start plus the
   * cap the build carries, plus the grace. Not the "is anyone running this" question (that one is
   * `STRANDED_AFTER_MS`, and it is answered by the heartbeat): this is the last-resort floor for a
   * row whose builder cannot be asked at all, where the one thing still known is that the deadline
   * the build was created with has passed.
   */
  const pastTheBuildersDeadline = (row: Environment): boolean =>
    row.startedAt !== null &&
    deps.now().getTime() - Date.parse(row.startedAt) > envConfig.buildTimeoutMs + ORPHAN_GRACE_MS;

  /**
   * Takes over a build this replica did not start, once its row has been claimed for exactly that.
   *
   * ON TWO REPLICAS. The claim is a compare-and-set on the row's `updatedAt`, so of all the
   * replicas whose tick finds the same cold row, one adopts it and the rest read null and move on.
   * The narrow window this does not close is a replica that was running the build all along and
   * merely stalled past the heartbeat: it keeps going, and so a second watcher joins it. That is
   * survivable by construction — adoption WATCHES, it starts nothing — and the settle both of
   * them reach is `saveEnvironmentIfStatus(…, ["building"])`, which exactly one of them wins. The
   * loser logs `settle_dropped` and the hooks fire once. One exception: docker's adoption removes
   * the tags a dead process made, so a replica that only stalled and then settles ready leaves a
   * row whose image is gone, which the next check launch finds and retires (`imageMissing`).
   *
   * That compare-and-set decides WHICH settle lands, though, not which is right, and the two
   * watchers do not carry the same answer: the record is discarded once a settle is done with it,
   * and a watcher that polls after that sees a Job that disappeared, which it reports as a failed
   * build. So the ORDER matters, and it is the reason `discard` is a call of its own. A result is
   * written to the row first and the record dropped after, so a 404 is only ever reachable once
   * the row has already left `building` — the manufactured failure can be produced but never
   * lands, and a build that succeeded is never recorded as failed by its own second watcher.
   */
  const adoptBuild = async (row: Environment, controller: AbortController): Promise<void> => {
    const outcome = await builder.adopt(adoptSpecFor(row), { signal: controller.signal });
    if (outcome.kind === "unknown") {
      // Nothing was learned, so nothing is decided: the claim stamped the row, so the next tick
      // to find it cold asks again. Unless the build's own deadline has passed, in which case
      // waiting longer cannot make the answer better.
      diag.warn("environments.adopt_unanswered", { environmentId: row.id, why: outcome.why });
      if (!pastTheBuildersDeadline(row)) return;
      const message = `the orchestrator running this build went away, and the builder could ` +
        `not be asked what became of it (${outcome.why})`;
      await settle(row, { ok: false, kind: "failed", message, logTail: message, log: "" }, null);
      return;
    }
    if (outcome.kind === "gone") {
      const message = "the orchestrator running this build went away before it finished, and " +
        "the builder has no record of it left";
      diag.warn("environments.adopt_gone", { environmentId: row.id });
      await settle(row, { ok: false, kind: "failed", message, logTail: message, log: "" }, null);
      return;
    }
    // A build that came back with an image proves the builder works, whoever started it, so it
    // clears a fault the same way one of this replica's own does.
    if (outcome.result.ok) fault = null;
    diag.debug("environments.adopted", { environmentId: row.id, ok: outcome.result.ok });
    const aborted = controller.signal.aborted
      ? String(controller.signal.reason ?? "aborted")
      : null;
    await settle(row, outcome.result, aborted);
  };

  /** Puts one build — started here or taken over here — in the in-flight map for its lifetime, so
   * the tick heartbeats its row, an abort reaches it, and the slot is pumped when it ends. */
  const start = (row: Environment, work: (controller: AbortController) => Promise<void>) => {
    const controller = new AbortController();
    const done = work(controller)
      .catch((err) =>
        diag.warn("environments.run_failed", { environmentId: row.id, err: String(err) })
      )
      .finally(() => {
        inFlight.delete(row.id);
        pump().catch((err) => diag.warn("environments.pump_failed", { err: String(err) }));
      });
    inFlight.set(row.id, { controller, done });
  };

  const pump: EnvironmentService["pump"] = async () => {
    if (!envConfig.enabled || refusedReason !== null) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        while (true) {
          const claimed = await store.claimNextBuild(nowIso(), envConfig.buildConcurrency);
          if (claimed === null) break;
          diag.debug("environments.claimed", { environmentId: claimed.id });
          start(claimed, (controller) => run(claimed, controller));
        }
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  };

  const tick: EnvironmentService["tick"] = async () => {
    if (!envConfig.enabled) return;
    // Every build this replica has: aborted when its row moved on — superseded, or settled by
    // somebody else — and otherwise HEARTBEATED. The stamp is the only claim a running build
    // makes on its row, and it is what keeps another replica from adopting a build that is going
    // perfectly well.
    const beat = nowIso();
    for (const [id, entry] of inFlight) {
      const row = await store.getEnvironment(id);
      if (row === null || row.status !== "building") {
        entry.controller.abort(row?.failure ?? "the build's row moved on");
        continue;
      }
      await store.touchBuild(id, beat);
    }
    // Stranded rows: `building`, nobody here is running them, and unstamped for longer than a
    // heartbeat can plausibly be late. One replica claims each (a compare-and-set on the stamp)
    // and takes it over — which means asking the builder what became of the build, not guessing.
    const cold = deps.now().getTime() - STRANDED_AFTER_MS;
    for (const row of await store.listEnvironmentsByStatus(["building"])) {
      if (inFlight.has(row.id)) continue;
      if (Date.parse(row.updatedAt) > cold) continue;
      const claimed = await store.claimStrandedBuild(row.id, row.updatedAt, nowIso());
      if (claimed === null) continue;
      diag.warn("environments.stranded", {
        environmentId: row.id,
        unstampedSince: row.updatedAt,
      });
      start(claimed, (controller) => adoptBuild(claimed, controller));
    }
    await pump();
    // Not awaited: removing images is the daemon's time, not the tick's.
    if (deps.now().getTime() - lastImageRemoval >= IMAGE_REMOVAL_EVERY_MS) {
      lastImageRemoval = deps.now().getTime();
      void removeRetiredImages();
    }
    for (const hook of tickHooks) {
      await hook().catch((err) => diag.warn("environments.tick_hook_failed", { err: String(err) }));
    }
  };

  /** Retires what retention lets go in one row's group (`retentionGroup`). */
  const retireGroup = async (of: Environment) => {
    const ready = (await store.listEnvironmentsForSubject(of.subjectKind, of.subjectId, {
      ref: of.ref,
    }))
      .filter((row) => row.status === "ready" && row.defaultBranch === of.defaultBranch);
    if (ready.length <= 1) return;
    // A build whose setup.yml did not finish never retires the newest clean one before it.
    const keep = retainedOfGroup(ready);
    const referenced = new Set((await liveRuns()).map((r) => r.environmentId));
    for (const row of ready) {
      if (keep.has(row.id) || referenced.has(row.id)) continue;
      const at = nowIso();
      await store.saveEnvironmentIfStatus(
        { ...row, status: "superseded", updatedAt: at },
        ["ready"],
      );
    }
  };

  const sweepRetention: EnvironmentService["sweepRetention"] = async () => {
    const ready = await store.listEnvironmentsByStatus(["ready"]);
    const groups = new Map<string, Environment[]>();
    for (const row of ready) {
      const key = retentionGroup(row);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const referenced = new Set((await liveRuns()).map((r) => r.environmentId));
    const now = deps.now().getTime();
    for (const rows of groups.values()) {
      const keep = retainedOfGroup(rows);
      for (const row of rows) {
        if (referenced.has(row.id)) continue;
        const older = !keep.has(row.id);
        const expiredBranch = !row.defaultBranch &&
          now - Date.parse(row.finishedAt ?? row.createdAt) > BRANCH_IMAGE_TTL_MS;
        if (!older && !expiredBranch) continue;
        const at = nowIso();
        if (
          await store.saveEnvironmentIfStatus({ ...row, status: "superseded", updatedAt: at }, [
            "ready",
          ])
        ) {
          diag.debug("environments.retired", { environmentId: row.id, expiredBranch });
        }
      }
    }
    // Not awaited, as on the tick: the reconcile does not wait out the daemon's time.
    void removeRetiredImages();
  };

  const imageMissing: EnvironmentService["imageMissing"] = async (environmentId, image) => {
    const own = await store.getEnvironment(environmentId);
    const rows = [
      ...(own === null ? [] : [own]),
      ...await store.listEnvironmentsByBakedImage(image),
    ];
    for (const row of rows) {
      if (row.status !== "ready") continue;
      if (
        await store.saveEnvironmentIfStatus({ ...row, status: "superseded", updatedAt: nowIso() }, [
          "ready",
        ])
      ) {
        diag.warn("environments.image_missing", { environmentId: row.id, image });
      }
    }
  };

  /** The image removal under way in this process, so a tick never starts a second beside it. */
  let removingImages: Promise<void> | null = null;
  let lastImageRemoval = -Infinity;
  let lastReconcile = -Infinity;
  const removeRetiredImages = (): Promise<void> => {
    removingImages ??= removeRetiredImagesNow()
      .catch((err) => diag.warn("environments.remove_images_failed", { err: String(err) }))
      .then(pruneCache)
      .then(reconcileImages)
      .finally(() => (removingImages = null));
    return removingImages;
  };

  /**
   * The longest a build's backend may still be running it after its row stopped being stamped:
   * its timeout, as long again in a queue that starts the clock only when it runs (Cloud Build's
   * `queueTtl` is the timeout, and its own timeout begins at execution), and ORPHAN_GRACE_MS. A
   * build no row recorded is left alone until then (`removeRetiredImagesNow`).
   */
  const unrecordedLifetimeMs = 2 * envConfig.buildTimeoutMs + ORPHAN_GRACE_MS;

  /**
   * What the registry holds untagged and nothing names, deleted (`EnvironmentBuilder.
   * reconcileImages`) — once every RECONCILE_EVERY_MS, since it lists every package. The builder
   * lists; what still names a digest is decided here: any row not yet done with (whatever its
   * status: a ready row, a held one, a failed one owed a pass), a live run's frozen image, and
   * the image a queued or running build starts from. Untagged for longer than a build no row
   * recorded may live, plus the removal grace, so what it lists is past every push and claim.
   */
  const reconcileImages = async () => {
    if (builder.reconcileImages === undefined) return;
    if (deps.now().getTime() - lastReconcile < RECONCILE_EVERY_MS) return;
    lastReconcile = deps.now().getTime();
    const inUse = async (digests: string[]): Promise<Set<string>> => {
      const named = new Set<string>();
      const name = (ref: string | null | undefined) => {
        const digest = digestOf(ref);
        if (digest !== null) named.add(digest);
      };
      for (const row of await store.listEnvironmentsNamingDigests(digests)) {
        if (row.imagesRemovedAt) continue;
        [row.image, row.bakedImage, row.machineImage].forEach(name);
      }
      for (const run of await liveRuns()) name(run.image);
      for (const row of await store.listEnvironmentsByStatus(["queued", "building"])) {
        name(row.plan.relayerOf?.bakedImage);
        name(row.plan.warmFrom?.bakedImage);
      }
      return new Set(digests.filter((digest) => named.has(digest)));
    };
    await builder.reconcileImages({
      untaggedForMs: unrecordedLifetimeMs + IMAGE_REMOVAL_GRACE_MS,
      inUse,
    }).then(
      (summary) => sayPass("environments.images_reconciled", summary),
      (err) => diag.warn("environments.reconcile_images_failed", { err: String(err) }),
    );
  };

  /** One line for a prune or a reconcile that did something or failed — at warn, the level a
   * deployment's logs keep; what each deletion was stays at debug. */
  const sayPass = (event: string, summary: PassSummary) => {
    if (summary.deleteRequested > 0 || summary.failures > 0 || (summary.packageFailures ?? 0) > 0) {
      diag.warn(event, { ...summary });
    }
  };

  /**
   * The layer cache, where it lives in a registry (`EnvironmentBuilder.pruneCache`): an export a
   * newer one replaced goes once every build that could have resolved it has ended — the build
   * timeout, and CACHE_RETIRED_GRACE_MS past it for one whose watcher lags. On the removal pass,
   * so it is paced as removals are; docker prunes its cache directories at each build instead.
   */
  const pruneCache = async () => {
    await builder.pruneCache?.({ retiredForMs: envConfig.buildTimeoutMs + CACHE_RETIRED_GRACE_MS })
      .then(
        (summary) => sayPass("environments.cache_pruned", summary),
        (err) => diag.warn("environments.prune_cache_failed", { err: String(err) }),
      );
  };

  /**
   * Removes the images of superseded builds nothing needs any more, on a builder that can
   * (`EnvironmentBuilder.removeImages`: docker's store, an Artifact Registry), once they have been
   * retired for IMAGE_REMOVAL_GRACE_MS: what resolved a row just before it was retired (a run
   * starting, a suite attaching, a re-layer queued from it) has written its claim on it by then.
   * Oldest retired first, a page at a time past the last row seen, so rows held or kept for long
   * never stand in front of the rest; a builder that keeps failing ends the pass
   * (IMAGE_REMOVAL_FAILURES). One removal at a time, on one pass per replica, so a backlog of
   * hundreds is worked through at the registry's pace rather than all at once.
   *
   * The same pass takes what builds that no row records pushed: a `failed` row's, or one
   * superseded mid-build (`image` null), which may have pushed a machine or an image before it
   * ended — the registry builders cannot take those back at the end of the build, because the
   * build's watcher does not know whether its own verdict is the one that lands. Not before its
   * backend can no longer be running it (`unrecordedLifetimeMs`); a row never claimed pushed
   * nothing and is only stamped. On a registry such a row is only untagged — nothing recorded
   * which digests it pushed — and `reconcileImages` deletes what that leaves untagged.
   *
   * Held: a live run's build, one a queued or running build starts from, and one a hook knows of
   * (an unsettled check suite). The grace is what makes that enough: resolution only ever picks a
   * ready row, so whatever still launches on a retired one resolved it before it was retired and
   * has been holding it since. What slips anyway — a suite launching the very moment of the read
   * — is caught on docker by the machine itself: docker refuses to remove an image a container
   * uses, and a launch that finds its image gone needs another, which the checks engine answers
   * (`ImageGone`). A registry refuses nothing, and a kubernetes pod pulls after its launch, so
   * there a slip surfaces as the pod failing to pull, which the run or the suite reports as such.
   * What reads the stamp is a check suite's re-run: an image retention says it removed is gone,
   * wherever the launcher cannot tell (`imageGone` in core/checks.ts).
   *
   * A row is stamped only once it is done with, so a pass that dies midway is simply done again.
   * Its baked image goes with it unless something else wants that image. Another unstamped row
   * naming it (a re-layer shares its source's), or a build in flight from it, takes it over, and
   * the row is done; a holder of a row already done with — a check still running there — leaves
   * the row unstamped, to remove the image on a later pass. So a shared baked image goes with the
   * last row naming it — and when two replicas each hand it to the other's row at once, with
   * whichever re-reads last after stamping.
   */
  const removeRetiredImagesNow = async () => {
    const remove = builder.removeImages?.bind(builder);
    if (remove === undefined) return;
    const nowMs = () => deps.now().getTime();
    const before = new Date(nowMs() - IMAGE_REMOVAL_GRACE_MS).toISOString();
    const page = await store.listImagesToRemove(before, IMAGE_REMOVAL_BATCH);
    if (page.length === 0) return;
    // What this pass did, said once at its end when it did anything or failed: rows looked at,
    // rows done with, rows the builder did not answer for, removals that failed, and the
    // deletions the registry accepted for them.
    const tally: RemovalTally = { rowsSeen: 0, rowsStamped: 0, unanswered: 0, failures: 0 };
    const deletesBefore = builder.removalStats?.().versionsDeleteRequested ?? 0;
    try {
      await removePages(page, before, nowMs, remove, tally);
    } finally {
      const versionsDeleteRequested = (builder.removalStats?.().versionsDeleteRequested ?? 0) -
        deletesBefore;
      if (tally.rowsStamped > 0 || tally.failures > 0 || versionsDeleteRequested > 0) {
        diag.warn("environments.images_removal_pass", { ...tally, versionsDeleteRequested });
      }
    }
  };

  const removePages = async (
    first: Environment[],
    before: string,
    nowMs: () => number,
    remove: NonNullable<EnvironmentBuilder["removeImages"]>,
    tally: RemovalTally,
  ) => {
    let page = first;
    const runs = await liveRuns();
    const held = new Set(runs.map((r) => r.environmentId));
    const live = new Set(runs.map((r) => digestOf(r.image)).filter((d): d is string => d !== null));
    const inFlightBaked = new Set<string>();
    for (const row of await store.listEnvironmentsByStatus(["queued", "building"])) {
      for (const from of [row.plan.relayerOf, row.plan.warmFrom]) {
        if (!from) continue;
        held.add(from.environmentId);
        inFlightBaked.add(from.bakedImage);
      }
    }
    const holds = async (environmentId: string) => {
      if (held.has(environmentId)) return true;
      for (const hook of imageHolderHooks) {
        if (await hook(environmentId).catch(() => true)) return true;
      }
      return false;
    };
    /** Who else wants a baked image: `taken`, a row or build that will see to it itself (an
     * unstamped row naming it, a build in flight from it); `held`, only a holder of a row already
     * done with (a check on it still runs there), so the asking row stays the one to remove it;
     * or nobody. */
    const bakedWanted = async (baked: string, by: string): Promise<"taken" | "held" | null> => {
      if (inFlightBaked.has(baked)) return "taken";
      let wanted: "held" | null = null;
      for (const other of await store.listEnvironmentsByBakedImage(baked)) {
        if (other.id === by) continue;
        if (other.status !== "superseded" || !other.imagesRemovedAt) return "taken";
        if (wanted === null && await holds(other.id)) wanted = "held";
      }
      return wanted;
    };
    let failures = 0;
    const tryRemove = async (row: Environment, baked: string | null) => {
      try {
        const mine = await notNamedByOthers(row.id, [row.image, row.machineImage, baked], live);
        const removed = await remove({
          environmentId: row.id,
          subjectKey: subjectKey(row.subjectKind, row.subjectId),
          defaultBranch: row.defaultBranch,
          // Null for a row that never recorded an image (it failed, or was superseded mid-build):
          // it may still have pushed some under its own names, which no row will ever name.
          recorded: row.image !== null,
          image: mine(row.image),
          machineImage: mine(row.machineImage),
          bakedImage: mine(baked),
        });
        failures = 0;
        if (!removed) tally.unanswered++;
        return removed;
      } catch (err) {
        failures++;
        tally.failures++;
        tally.firstError ??= String(err);
        diag.warn("environments.remove_images_failed", { environmentId: row.id, err: String(err) });
        return false;
      }
    };
    while (page.length > 0) {
      for (const row of page) {
        if (failures >= IMAGE_REMOVAL_FAILURES) return;
        tally.rowsSeen++;
        // Never claimed: nothing was built, so nothing was pushed, and there is nothing to ask.
        if (row.startedAt === null) {
          await store.markEnvironmentImagesRemoved(row.id, nowIso());
          tally.rowsStamped++;
          continue;
        }
        // A build no row recorded may have outlived its row: abandoned by a replica that went
        // away, failed past its deadline, or adopted as gone, its backend may still be running it
        // and push afterwards. Not before it cannot be.
        if (row.image === null && Date.parse(row.startedAt) + unrecordedLifetimeMs > nowMs()) {
          continue;
        }
        if (await holds(row.id)) continue;
        const baked = row.bakedImage;
        const wanted = baked === null ? null : await bakedWanted(baked, row.id);
        // Kept by the builder, not answered, or its baked image held: the row stays unstamped,
        // and a later pass removes what is left.
        if (!await tryRemove(row, wanted === null ? baked : null)) continue;
        if (wanted === "held") continue;
        await store.markEnvironmentImagesRemoved(row.id, nowIso());
        tally.rowsStamped++;
        if (wanted === "taken" && !inFlightBaked.has(baked!)) {
          // Handed to another row, which another replica may have stamped just now on the same
          // reading of this one: whoever stamps last finds every row done, and removes it. One
          // that cannot takes its stamp back, so a later pass is still owed it.
          const now = await bakedWanted(baked!, row.id);
          if (now === "held" || (now === null && !await tryRemove(row, baked))) {
            await store.markEnvironmentImagesRemoved(row.id, null);
            tally.rowsStamped--;
            continue;
          }
        }
        diag.debug("environments.images_removed", { environmentId: row.id });
      }
      if (page.length < IMAGE_REMOVAL_BATCH) return;
      page = await store.listImagesToRemove(before, IMAGE_REMOVAL_BATCH, page.at(-1));
    }
  };

  const refreshSubject: EnvironmentService["refreshSubject"] = async (subject, trigger) => {
    if (!envConfig.enabled || refusedReason !== null) return;
    // The subject's own "default branch": the environment repo's ref in it — its default branch
    // for a repo, the ref a workspace pins it at for a workspace.
    const ref = subject.environmentRepo.ref;
    const plan = await planFor(subject, ref);
    const history = (await store.listEnvironmentsForSubject(subject.kind, subject.id, { ref }))
      .filter((row) => row.defaultBranch);
    if (plan.definition === null) {
      // No `.ryph/` in any member any more: the subject describes no machine, so what was built
      // for the old description retires rather than being served on — except a build a run is
      // waiting for, which that run was promised and launches on.
      for (const row of history) {
        if (row.status === "queued" || row.status === "building") {
          if (await waitedOn(row.id)) continue;
          await supersede(
            row,
            subject.kind === "repo"
              ? "the repo no longer has a .ryph directory"
              : "no member of the workspace has a .ryph directory any more",
          );
        } else if (row.status === "ready") {
          const referenced = (await liveRuns()).some((r) => r.environmentId === row.id);
          if (!referenced) {
            await store.saveEnvironmentIfStatus(
              { ...row, status: "superseded", updatedAt: nowIso() },
              ["ready"],
            );
          }
        }
      }
      return;
    }
    const latest = history.filter((row) => row.status !== "superseded").sort(byNewest)[0];
    const commits = commitsOf(plan.checkouts);
    const request: BuildRequest = {
      subject,
      ref,
      defaultBranch: true,
      checkouts: plan.checkouts,
      definition: plan.definition,
      dockerfile: plan.dockerfile,
      machine: plan.machine,
      trigger,
    };
    if (latest === undefined || latest.definition !== plan.definition) {
      // A new definition (or the first): build now. Any member's `.ryph/` counts, so a member
      // that adds or edits its setup.yml is built now, not at the next interval.
      await enqueue(request);
      return;
    }
    if (sameCommits(latest.commits, commits)) return;
    // Only code moved, under an image whose setup.yml did not finish: the commit may be the fix
    // (a lockfile, a script setup.yml runs), so it is built now — the image is ready but not
    // what the definition describes, and checks run on it without rerunning setup.yml. Once per
    // episode (`warningRebuildDue`): a step that fails at every build would otherwise have a busy
    // repo building back to back for ever. After that, the interval below.
    if (warningRebuildDue(latest, history)) {
      await enqueue(request);
      return;
    }
    // Only code moved: the image needs to stay warm, not current — runs fetch their own commit.
    // Aged from the build that cloned these commits: a re-layer moves an old tree onto a new
    // harness, and must not make it look fresh.
    const age = deps.now().getTime() - Date.parse(clonedAt(latest, history));
    if (age >= envConfig.rebuildIntervalMs) await enqueue(request);
  };

  /** When the tree in a row's image was cloned: its own creation, or for a re-layer its source's,
   * followed back through every re-layer in between. */
  const clonedAt = (row: Environment, history: Environment[]): string => {
    const byId = new Map(history.map((r) => [r.id, r]));
    let at = row;
    for (let hops = 0; at.plan.relayerOf !== null && hops < history.length; hops++) {
      const source = byId.get(at.plan.relayerOf.environmentId);
      if (source === undefined) break;
      at = source;
    }
    return at.createdAt;
  };

  /** Which rows the forge can act on as it runs now (`fitsForge`), its modes asked once. */
  const rowsThatFit = async (): Promise<(repo: ConnectedRepo) => boolean> => {
    const github = await githubModeOf(deps.githubMode);
    const gitlab = await gitlabModeOf(deps.forge, deps.now().getTime());
    return (repo) => fitsForge(repo, github, gitlab);
  };

  /** Every live subject: each connected repo, each workspace. */
  const allSubjects = async (): Promise<EnvironmentSubject[]> => {
    const subjects: EnvironmentSubject[] = [];
    const fits = await rowsThatFit();
    for (const repo of await tasks.listConnectedRepos()) {
      if (repo.archivedAt !== null || !fits(repo)) continue;
      const subject = await loadSubject("repo", repo.id);
      if (subject !== null) subjects.push(subject);
    }
    for (const workspace of await tasks.listWorkspaces()) {
      if (workspace.archivedAt !== null) continue;
      const subject = await loadSubject("workspace", workspace.id);
      // A workspace holding a row of the other mode, or of another instance, is unbuildable the
      // same way.
      if (subject !== null && subject.members.every((m) => fits(m.repo))) {
        subjects.push(subject);
      }
    }
    return subjects;
  };

  const reconcile: EnvironmentService["reconcile"] = async () => {
    if (!envConfig.enabled || deps.forge === null) return;
    const forge = deps.forge;
    // First the default branches, which nothing else refreshes: the connected repo's record is
    // as old as its connection unless a branch.updated corrected it.
    const fits = await rowsThatFit();
    for (const listed of await tasks.listConnectedRepos()) {
      if (listed.archivedAt !== null || !fits(listed)) continue;
      try {
        const head = await forge.defaultBranchHead(forgeRepoRef(listed), listed.url);
        const repo = await tasks.getConnectedRepo(listed.id);
        if (repo !== null && repo.archivedAt === null && repo.defaultBranch !== head.ref) {
          await tasks.saveConnectedRepo({ ...repo, defaultBranch: head.ref, updatedAt: nowIso() });
          diag.debug("environments.default_branch_refreshed", {
            connectedRepoId: repo.id,
            from: repo.defaultBranch,
            to: head.ref,
          });
        }
      } catch (err) {
        diag.warn("environments.reconcile_head_failed", {
          connectedRepoId: listed.id,
          err: String(err),
        });
      }
    }
    if (refusedReason === null) {
      for (const subject of await allSubjects()) {
        await refreshSubject(subject, "reconcile").catch((err) =>
          diag.warn("environments.reconcile_failed", {
            subject: subjectKey(subject.kind, subject.id),
            err: String(err),
          })
        );
      }
    }
    await sweepRetention();
  };

  const onBoot: EnvironmentService["onBoot"] = async () => {
    if (!envConfig.enabled || refusedReason !== null) return;
    const harness = envConfig.harnessImage ?? "";
    const base = envConfig.baseImage ?? "";
    // The default branch's images only. A branch image (a patch's `.ryph/` edit, a check's base)
    // mostly serves the one build that asked for it: a later run on the branch asks for its own
    // re-layer (environment_resolve.ts), and a check pod runs the baked image under the harness.
    const ready = (await store.listEnvironmentsByStatus(["ready"]))
      .filter((r) => r.defaultBranch)
      .sort(byNewestBuilt);
    const seen = new Set<string>();
    const relayers: Array<() => Promise<unknown>> = [];
    const rebuilds: Array<() => Promise<unknown>> = [];
    for (const row of ready) {
      const key = retentionGroup(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const subject = await loadSubject(row.subjectKind, row.subjectId);
      if (subject === null) continue;
      const warn = (err: unknown) =>
        diag.warn("environments.boot_enqueue_failed", { environmentId: row.id, err: String(err) });
      /** A full build of where the subject's default branch stands NOW — never of the row's own
       * commits, which a force-push may have taken off the branch. */
      const fresh = (trigger: "harness" | "base", known?: SubjectPlan) => async () => {
        const plan = known ?? await planFor(subject, subject.environmentRepo.ref);
        if (plan.definition === null) return;
        await enqueue({
          subject,
          ref: subject.environmentRepo.ref,
          defaultBranch: true,
          checkouts: plan.checkouts,
          definition: plan.definition,
          dockerfile: plan.dockerfile,
          machine: plan.machine,
          trigger,
        });
      };
      if (!sameImage(row.harnessDigest, harness)) {
        // The harness first: runs WAIT for a re-layer, and it is stage 4 only. One that already
        // failed on this harness is not asked for again; a full build of the head goes instead.
        const failedRelayer = row.bakedImage === null ||
          (await store.listEnvironmentsForSubject(row.subjectKind, row.subjectId, { ref: row.ref }))
            .some((r) =>
              r.status === "failed" && sameImage(r.harnessDigest, harness) &&
              r.plan.relayerOf?.environmentId === row.id
            );
        if (!failedRelayer) {
          relayers.push(async () => {
            // A default branch whose definition moved since this image was built gets a full
            // build of where it stands instead: a re-layer would carry the old definition onto
            // the new harness. A run that cannot wait for that still asks for the re-layer
            // itself (environment_resolve.ts), and the row it gets says which definition it is.
            const now = await planFor(subject, subject.environmentRepo.ref).catch(() => null);
            if (now !== null && now.definition !== row.definition) {
              return await fresh("harness", now)().catch(warn);
            }
            return await enqueue({
              subject,
              ref: row.ref,
              defaultBranch: true,
              checkouts: row.plan.checkouts,
              definition: row.definition,
              dockerfile: row.plan.dockerfileFrom !== null,
              machine: row.plan.machine ?? null,
              trigger: "harness",
              relayerOf: row,
            }).catch(warn);
          });
        } else {
          relayers.push(() => fresh("harness")().catch(warn));
        }
      }
      // Then the base, which never blocks a run: queued behind every re-layer, throttled by the
      // same concurrency, and the previous images serve until each lands.
      if (!sameImage(row.baseDigest, base)) {
        rebuilds.push(() => fresh("base")().catch(warn));
      }
    }
    for (const job of relayers) await job();
    for (const job of rebuilds) await job();
    if (relayers.length + rebuilds.length > 0) {
      diag.debug("environments.boot_enqueued", {
        relayers: relayers.length,
        rebuilds: rebuilds.length,
      });
    }
  };

  return {
    config,
    store,
    builderKind: builder.kind,
    enabled: envConfig.enabled,
    refusedReason,
    builderFault: () => fault,
    loadSubject,
    planFor,
    baseline: async (input) => {
      if (deps.forge === null) {
        return {
          own: true,
          mergeBase: null,
          reason: `${input.ref} has its own .ryph/ (there is no forge to read its merge base)`,
        };
      }
      return await compareWithBaseline({ ...input, forge: deps.forge });
    },
    enqueue,
    successorOf,
    async supersedeBranch(subject, ref, keep, why) {
      const history = await store.listEnvironmentsForSubject(subject.kind, subject.id, { ref });
      await supersedeLive(history, false, keep?.id ?? null, why);
    },
    release,
    refreshSubject,
    pump,
    tick,
    reconcile,
    onBoot,
    imageMissing,
    sweepRetention,
    onSettled(hook) {
      settledHooks.push(hook);
    },
    addWaiters(hook) {
      waiterHooks.push(hook);
    },
    addImageHolders(hook) {
      imageHolderHooks.push(hook);
    },
    onTick(hook) {
      tickHooks.push(hook);
    },
    async idle() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()].map((entry) => entry.done));
      }
      await removingImages;
    },
    async readLog(environment) {
      if (environment.logRef !== null) return await deps.logs.get(environment.logRef);
      // Still running: what the builder has so far, from wherever it keeps it, so a slow build
      // shows its progress instead of nothing until the end. The tail only — a cargo build prints
      // megabytes, and this is asked every few seconds by every page watching it.
      if (environment.status !== "building") return null;
      const live = await builder.liveLog({
        environmentId: environment.id,
        defaultBranch: environment.defaultBranch,
      }).catch(() => null);
      return live === null ? null : live.slice(-LIVE_LOG_CHARS);
    },
  };
}
