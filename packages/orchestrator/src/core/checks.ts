// Checks: the verdict machine. A repo's `.ryph/checks.yml`, read at
// the change request's BASE, run against a commit the platform received through forge intake, in
// the base's environment image, in a check pod nothing from the run touched — and the verdict is
// the exit code the backend observed on each check's container.
//
//   a request (the agent's tool, a patch's birth, a push to any change request, a re-run, a
//   person's ask from their own machine) → the declaration read at the base, pinned to a commit
//   → a SUITE claimed on its identity → waiting on the base's environment build, queued for a
//   slot, running in a check pod → settled from the pod's own record → told to every run that
//   asked, and reported to the forge for every submitted patch and every change request on that
//   head
//
// A suite's identity is `(connectedRepoId, commit, checksBlob, environmentKey, inputsKey)`: the
// second ask for the same key joins the suite, running or finished, and that is the whole saving —
// the agent runs the checks on its final commit, sees green, submits, and the submit finds the
// finished suite instead of launching a pod. A join of a suite that was cancelled, or that the
// platform could not run, runs it again: neither is an answer about the commit. A run's or a
// person's ask of a failed one — a delegated ask too, when its sender's was one of those — runs
// it again as well, taking the passes the commit has since and running only what still fails;
// a patch's or a push's ask only reads the failure.
//
// A suite OUTLIVES the replica that launched it, as a build does (core/environments.ts): the
// launch is claimed by a compare-and-set, the backend's record is named deterministically
// (`ryph-check-<suite>-g<generation>`), and whichever replica ticks next polls THAT record — it
// adopts a pod already running rather than launching a second, and settles it from the pod's own
// state. Settling is itself leased, so two replicas reading one finished pod write one verdict.
//
// Invariants:
// - the declaration is read at the BASE (`checksRef`), never the head, and every later read of
//   the base — its services, its `.ryph/` tree — is at the one commit that read pinned. A read
//   that failed is retried, never answered as "no checks": `unavailable` does not collapse to
//   `absent`, and there is no stale fallback, because a stale base is a wrong judge
// - the verdict is an exit code the launcher observed. Nothing here accepts a result from a pod,
//   and the only credential a check pod holds — the clone's git key — resolves only while its
//   suite generation is running, and is revoked once the clone is done and again at settle
// - every suite transition is a compare-and-set on the stored state and generation (and the
//   lease where one is held); results are written before the transition that publishes them,
//   and the backend's record is discarded only after both
// - a run is told a generation's result once (`markRequestReported`, stamped once the message is
//   in), and only a live run is told; the rows are the record either way
// - a check's own verdict is written the moment its container exits, and kept: the suite's
//   settle, a relaunch of its pod and a slower replica's write never replace it
// - the platform's failures are never the head's: a pod evicted, an entrypoint that could not
//   start the command (exit 125), a setup step with no exit code — relaunched, then `error`,
//   never `failed`
// - nothing runs for nobody: a suite whose every asker is gone (a run that ended, a patch set
//   aside, a newer ask, a change request pushed again or closed, a local ask a day old) is
//   cancelled
// - what a check PRINTED is head-authored: fenced by a per-message nonce wherever it reaches the
//   agent or the forge, and never spoken in the platform's voice. The one exception is a whole
//   log the agent asks for (`logForRun`): it goes to a file of its own, never into a message,
//   and the tool that saves it says whose words are in it
// - a run reads its own task's suites, and others' only on a commit already on the forge of a
//   repo it holds (`readableByRun`); never another task's unshipped work, nor a person's own ask
// - a required check is never ABSENT once its names are known: a patch reaching the forge posts
//   every check `queued`, and a suite that cannot run posts `action_required` (with a details
//   page to act from) rather than nothing
// - never throws for the relays: `patchOpened`, `patchSubmitted` and the settle hook are
//   best-effort. The minute sweep files a recent patch's missing request or forge row
//   (`refilePatches`); the tick's passes pick up whatever else they dropped

import type {
  CheckAsker,
  CheckDeclaration,
  CheckForgeReport,
  CheckPodState,
  CheckRequest,
  CheckResult,
  CheckResultState,
  ChecksDeclaration,
  CheckSource,
  CheckSuite,
  CheckSuiteListItem,
  CheckSuiteState,
  CheckSuiteView,
  ForgeSource,
  RepoChecksFile,
} from "./check_types.ts";
import {
  bundleKeyOf,
  CHECK_RECORD_NAME,
  isForgeSource,
  isPartial,
  keepOf,
  localBundleKey,
  MAX_CHECK_LOG_BYTES,
  MAX_CHECK_RECORD_NAME,
  parseCheckExternalId,
  SETTLED_RESULT_STATES,
  TERMINAL_SUITE_STATES,
} from "./check_types.ts";
import {
  checksOffText,
  composeCheckNote,
  logTailOf,
  planForgeReport,
  remoteChecksNote,
  reportFingerprint,
  requestedText,
  resultWords,
  settledBad,
  short,
  stripAnsi,
  SUITE_WORDS,
} from "./check_feedback.ts";
import { type CheckPolicy, MAX_CHECK_CONCURRENCY } from "./check_policy.ts";
import { RemoteChecksError } from "../ports/remote_checks.ts";
import type {
  ConnectedRepo,
  Environment,
  ForgeProvider,
  Patch,
  RepoEntry,
  Run,
  RunNetworkScope,
  ServiceSpec,
  Task,
} from "./types.ts";
import { MAX_MESSAGE_CHARS } from "./types.ts";
import { legacyRefusal } from "./legacy.ts";
import { type Scope, taskInScope } from "./scope.ts";
import { resolveServices, type ServicePolicy, servicesRef } from "./services.ts";
import { type EgressPolicy, liveCeiling, mintEgressToken, resolveNetworkScope } from "./egress.ts";
import {
  byNewestBuilt,
  type EnvironmentService,
  newestForChecks,
  setupUnfinished,
} from "./environments.ts";
import { fenceNonce, scrub } from "./environment_messages.ts";
import { forgeIdOf, forgeName, forgeRepoRef, runFacingRepoName } from "./forge_repo.ts";
import { type InboxDeps, postMessage } from "./inbox.ts";
import type { InboxSignal } from "./inbox_signal.ts";
import { isTerminal } from "./lifecycle.ts";
import { defaultRunSize, findRunSize, type RunSize, type RunSizes } from "./run_sizes.ts";
import { changedPathsFromLog, parseChecksYaml, watchedChangedByCheck } from "../helpers/checks.ts";
import { parseServicesYaml } from "../helpers/services.ts";
import { changeRequestHeadRef, normalizeBaseRef } from "@ryph/shared/refs";
import { DEFAULT_LINE, parseLineBranch, runBundleKey } from "@ryph/shared/lines";
import { lineBase } from "./landing.ts";
import { gatewayGitEnv, proxyEnv, redactCredentials } from "../helpers/credentials.ts";
import { mintId, mintToken, sha256Hex } from "@ryph/sealed";
import type {
  CheckContainerState,
  CheckInspection,
  CheckLauncher,
  CheckSpec,
  ImagesAnswer,
} from "../ports/check_launcher.ts";
import { ImageGone } from "../ports/image_gone.ts";
import type { CheckStore, CheckSuiteListQuery } from "../ports/check_store.ts";
import type { ChecksFile, ForgeChecks, StageCheckBundleOutcome } from "../ports/forge.ts";
import type { BuildLogStore } from "../ports/build_log_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { ServiceCatalogue } from "../ports/service_catalogue.ts";
import type { TaskStore } from "../ports/task_store.ts";

/** A launch's lease: longer than the launcher's worst case (the kubernetes one makes up to six
 * API calls of a minute each, its cleanup included), so a slow launch is never taken over while
 * it is still going, and short enough that a replica that died mid-launch is taken over within
 * minutes. */
const LAUNCH_LEASE_MS = 10 * 60_000;
/** A settle's lease: the logs of every check read and stored, then the verdict written. */
const SETTLE_LEASE_MS = 2 * 60_000;
/** The first launch plus two retries; the third failure is `error`. */
const MAX_LAUNCH_ATTEMPTS = 3;
/** What the pod's deadline allows for the clone and every setup step together. */
const SETUP_BUDGET_S = 20 * 60;
/** Past the longest check's timeout: the entrypoint's own `--kill-after`, a slow log flush. */
const DEADLINE_GRACE_S = 300;
/** How long past its deadline, counted from the LAUNCH, a pod the backend has not ended is waited
 * for before the suite is settled from what it shows. The pod's own deadline counts from the
 * pod's start, which may come up to ten minutes after the launch (the kubernetes launcher's
 * unschedulable grace), so this covers that wait plus two minutes — and stays under the Job's
 * own backstop (that grace plus five minutes), which deletes the pod and its verdict with it. */
const DEADLINE_BACKSTOP_MS = 12 * 60_000;
/** A check's git key and egress token outlive its pod's deadline by this much, then die whatever
 * happened. The deadline counts from the pod's start, up to ten minutes after the launch they are
 * minted at (the unschedulable grace above), so that wait plus five minutes. */
const KEY_GRACE_MS = 15 * 60_000;
/** A checks-file read the forge could not answer: first retry, and the ceiling of the backoff. */
const READ_RETRY_MS = 30_000;
const READ_RETRY_MAX_MS = 30 * 60_000;
/** A request whose checks file could not be read for this long is given up on, with a note. */
const READ_GIVE_UP_MS = 24 * 60 * 60_000;
/** A suite waiting on its base's environment this long is `error`: the same day's patience a
 * checks-file read gets, and far past the longest build. */
const WAIT_GIVE_UP_MS = READ_GIVE_UP_MS;
/** How long the agent's tool waits for its request to be read at the base before it answers
 * "requested" and lets the tick finish — well inside the runner's own 30 s. */
const TOOL_ANSWER_MS = 10_000;
/** How long the read of a run's declared checks waits for its repos, for the prompt. A repo
 * whose file is not read by then is named in `unread`. */
const DECLARED_READ_MS = 15_000;

/** How many commits one `check_status` looks up — one per repo of a run, or the one named. */
export const MAX_STATUS_COMMITS = 8;
/** How many suites on one commit `check_status` lists, newest first. */
const MAX_COMMIT_SUITES = 5;
/** The least room a settled suite's full note is given in `check_status`: its verdict line by
 * line and a little of a failing check's output. Less, and it is pointed to instead. */
const MIN_NOTE_CHARS = 1_200;

/**
 * Sections joined into one message, cut only between them: a section cut part way could end
 * inside a fence, leaving the check's words running on unmarked. One that does not fit is named
 * by its first line. Only the first, on its own over the limit, is cut, as a note always was;
 * `statusForRun` sizes each note to its share, so none is.
 */
function withinMessage(parts: readonly string[]): string {
  let text = parts[0] ?? "";
  if (text.length > MAX_MESSAGE_CHARS) return text.slice(0, MAX_MESSAGE_CHARS);
  for (const part of parts.slice(1)) {
    const joined = `${text}\n\n${part}`;
    if (joined.length <= MAX_MESSAGE_CHARS) {
      text = joined;
      continue;
    }
    const left = `${text}\n\nLeft out for length: ${part.split("\n")[0]} Name its \`commit\` ` +
      "to see it alone.";
    if (left.length <= MAX_MESSAGE_CHARS) text = left;
  }
  return text;
}
/** How long one read of a repo's declared checks answers every run that asks for them. */
const DECLARED_CACHE_MS = 60_000;
/** How long one choice of a base's image answers every ask at that base commit, so asks that
 * land together join one suite even while a new image turns ready between them. */
const IMAGE_CHOICE_MS = 60_000;
/** A tool request is the tick's to resolve only after this: until then the call that made it is
 * resolving it, and the tick is the backstop for a replica that died mid-call. Past the forge's
 * own two minutes for a read, so the tick never reads the base a second time beside the call. */
const TOOL_BACKSTOP_MS = 3 * 60_000;
/** How long a person's ask from their own machine stands before the sweep withdraws it, and
 * cancels the suite it alone kept going. */
export const LOCAL_REQUEST_TTL_MS = 24 * 60 * 60_000;
/** When a refusal whose message could not be posted is tried again. */
const REFUSAL_RETRY_MS = 15_000;
/** An `unsupported` forge (the App lacks `Checks: write`) is not asked again before this. */
const UNSUPPORTED_BACKOFF_MS = 10 * 60_000;
/** A report the forge failed on transiently: first retry, and the ceiling. */
const REPORT_RETRY_MS = 30_000;
const REPORT_RETRY_MAX_MS = 30 * 60_000;
/** How often the orphan sweep asks the launcher what it holds, and the release sweep asks who
 * still wants each live suite. */
const ORPHAN_SWEEP_MS = 60_000;
/** The patch relays' backstop, on the same sweep: the newest patches, born at least a minute ago
 * (the birth's own relay goes first) and within a day. */
const PATCH_BACKSTOP_PAGE = 50;
const PATCH_RELAY_GRACE_MS = 60_000;
const PATCH_BACKSTOP_MS = 24 * 60 * 60_000;
/** How much of the clone step's log is read for its changed-paths list: all of it that is kept.
 * A list whose front was cut does not add up to its count, and reads as unknown. */
const CLONE_LOG_BYTES = MAX_CHECK_LOG_BYTES;
/** Work per tick, per pass — as many as the most check pods that may run at once, so every
 * running suite is polled every tick. */
const TICK_BATCH = MAX_CHECK_CONCURRENCY;
/** How long each of the tick's two forge passes (a waiting suite's read of its base; a request's
 * read and the reports) spends on the forge before it leaves the rest to the next tick: a forge
 * call may take two minutes, and the tick has pods to watch. */
const FORGE_BUDGET_MS = 90_000;
/** How many forge calls of one pass are in flight at once. */
const FORGE_CONCURRENCY = 4;
/** How many queued suites the launch pass looks at to share the slots out between repos. */
const QUEUED_PAGE = 1_000;
/** The states whose report finishes a forge's run with a verdict. A cancelled suite's leaves it
 * going: neither verdict is true of it. */
const SETTLED_VERDICT: ReadonlySet<CheckSuiteState> = new Set(["passed", "failed", "error"]);

/** The slice of the app config checks consume. */
export interface ChecksConfig {
  policy: CheckPolicy;
  /** RYPH_AGENT_IMAGE: what checks run in when no environment image fits. */
  agentImage: string | null;
  runSizes: RunSizes;
  /** The gateway as a check pod's clone dials it — where runs dial it. */
  gitGateway: { url: string; keyTtlMs: number } | null;
  services: ServicePolicy;
  egress: { policy: EgressPolicy; key: Uint8Array | null; tokenTtlMs: number };
  /** RYPH_APP_URL: the suite page is `details_url`; null, no page and no `action_required`. */
  appUrl: string | null;
}

export interface ChecksDeps {
  /** When configured, B alone resolves and executes checks. Transport failure never falls back. */
  remote?: import("../ports/remote_checks.ts").RemoteChecks | null;
  store: CheckStore;
  tasks:
    & InboxDeps["store"]
    & Pick<
      TaskStore,
      | "getTask"
      | "getPatch"
      | "listPatches"
      | "findPatchByRepoAndHead"
      | "listTasksByIds"
      | "listRunsByIds"
      | "listPatchesByIds"
      | "getConnectedRepo"
      | "getEgressAllowlist"
    >;
  /** Null: this provisioner has no check launcher (only kubernetes and docker do). */
  launcher: CheckLauncher | null;
  /** Null: no forge — no connected repo, nothing to read a declaration through. */
  forge: ForgeChecks | null;
  /** Null, off or refused: every base runs its checks in the default image. */
  environments: EnvironmentService | null;
  /** Where check logs are stored: beside build logs, under `checks/`. */
  logs: BuildLogStore;
  serviceCatalogue?: ServiceCatalogue | null;
  inbox?: InboxSignal | null;
  diag: Diagnostics;
  now(): Date;
  config: ChecksConfig;
  /** The fence token; tests pin it. */
  nonce?: () => string;
  /** How long the tool waits for its request to resolve (TOOL_ANSWER_MS); tests shorten it. */
  answerWithinMs?: number;
}

export interface RunChecksInput {
  path: string;
  headSha: string;
  branch: string;
  baseSha: string;
  /** Only these checks, by name; absent or empty, all of them. */
  checks?: string[];
}

/** One repo's declared checks as the agent is shown them at its run's start. */
export interface DeclaredChecks {
  path: string;
  /** Display only — the repository as the agent reads it (`runFacingRepoName`): its forge
   * address, or a local repository's folder name. Never a host path, and so always well under
   * the runner's 500-character bound, which a local repo's 4096-character address would not
   * be. */
  repoRef: string;
  /** The branch they were read on. */
  checksRef: string;
  setup: string[];
  checks: Array<{ name: string; run: string; timeoutSeconds: number; services: string[] }>;
}

/** `GET /v1/runs/:id/checks/declared`. `unread`: the paths of the repos whose read did not
 * answer, or `["*"]` (DECLARED_UNKNOWN) when the run's repos could not be listed. */
export interface DeclaredChecksAnswer {
  declared: DeclaredChecks[];
  unread: string[];
}

/** `unread` when the run's repos could not be listed: any of them may declare checks. */
export const DECLARED_UNKNOWN = "*";

export interface RunChecksAnswer {
  status: 200 | 202 | 400 | 409 | 429;
  suiteId: string | null;
  state: CheckSuiteState | null;
  reused: boolean;
  text: string;
}

/** Who a check git key resolves to at the gateway — a run grant whose "run" is the suite. */
export interface CheckGitGrant {
  runId: string;
  repos: Array<{
    connectedRepoId: string;
    url: string;
    ref: string;
    /** The base the declaration was read on, when it is not `ref`: served beside it, so the
     * clone step can find the merge base for its changed-paths list. */
    targetRef?: string;
    /** A namespace no run owns: a check grant never ships. */
    branchNamespace: string;
    provider: string;
    repoRef: string;
    tenantId: string | null;
    /** A GitLab project's id: where the gateway reaches it, whatever its path is now. */
    forgeId?: string;
    /** Where the gateway finds the head: the bundle intake filed, or — for a change request's
     * head — the forge itself, by id, else by `fetchRef`; and the branch it is served as. */
    candidate:
      | { headSha: string; branchName: string; bundleKey: string }
      | { headSha: string; branchName: string; fetchRef: string | null };
  }>;
}

/** A person's ask from their own machine (`POST /v1/check-suites` and `.../bundle`), past the
 * route's gates: the repo connected, the caller's write on it checked live. */
export interface LocalChecksInput {
  /** Stable identity scoped to the authenticated sender; absent for ordinary CLI asks. */
  delegationId?: string;
  /** A delegated ask whose sender's own ask retries a failed suite (`ForgeSource.retryFailed`);
   * a person's own ask always does, so it is read only with `delegationId`. */
  retryFailed?: boolean;
  user: { userId: string; name: string };
  repo: ConnectedRepo;
  commit: string;
  /** The person's branch, bare. */
  branch: string;
  /** The base whose checks judge; absent, the repo's default branch. Normalised as a push's
   * base is (`checksRef`). */
  base?: string;
  /** Only these checks; absent or empty, all of them. */
  checks?: string[];
  /** Where the commit is: on the forge as the head of `branch` (false, proven live before
   * anything is filed), or a bundle the forge staged under `localBundleKey` (true). */
  bundled: boolean;
}

export type LocalChecksAnswer =
  /** Filed, or the same ask found standing. `suite` is null while it is read at its base. */
  | { kind: "requested"; request: CheckRequest; suite: CheckSuite | null }
  /** The person already has `live` asks going on other branches, the most they may. */
  | { kind: "quota"; live: number; max: number }
  /** Not filed: a pushed commit that is not the branch's live head on the forge, or a forge
   * that cannot say which (409), or could not be asked (503). */
  | {
    kind: "refused";
    status: 409 | 503;
    error: string;
    /** `not-branch-head` on a pushed commit that is not provably its branch's head: what a
     * client falls back to a bundle on. */
    code?: "not-branch-head";
  }
  /** Checks, or local asks, are off here. */
  | { kind: "off" };

/** A commit of one of a run's repos, as the runner resolved it in the checkout. */
export interface RunCommit {
  /** The checkout directory, as the run's entry names it. */
  path: string;
  commit: string;
}

/** A push to a change request, as the forge's `change_request.pushed` names it. */
export interface ChangeRequestPush {
  connectedRepoId: string;
  /** `patches.forge_ref`'s spelling: a PR number, a Radicle patch id. */
  ref: string;
  headSha: string;
  /** The bare branch the change request targets. */
  baseRef: string;
  fetchRef: string | null;
  url: string | null;
}

export interface ChecksService {
  readonly remote: boolean;
  /** Receiver-only base declaration read; the HTTP boundary gates repo write access. */
  delegationFile(repo: ConnectedRepo, base: string): Promise<ChecksFile>;
  /** Withdraw only this user's delegated waiter, not another sender or ordinary CLI ask. */
  cancelDelegation(id: string, userId: string): Promise<boolean>;
  delegationSnapshot(
    id: string,
    userId: string,
  ): Promise<import("../ports/remote_checks.ts").RemoteCheckSnapshot | null>;
  readonly enabled: boolean;
  readonly refusedReason: string | null;
  /** Whether a push to a change request asks for checks here: checks run, and
   * `RYPH_CHECKS_CHANGE_REQUESTS` is not off. */
  readonly changeRequests: boolean;
  /** The agent's `ryph__run_checks`: a commit it uploaded through intake, as a suite. */
  requestForRun(run: Run, input: RunChecksInput): Promise<RunChecksAnswer>;
  /** A patch was born: a pending request for its head, resolved on the tick. Never throws. */
  patchOpened(patch: Patch): Promise<void>;
  /** A patch reached the forge: its head's checks are reported there, due now. Never throws. */
  patchSubmitted(patch: Patch): Promise<void>;
  /**
   * A change request's head or base moved (`change_request.pushed`), the caller having read it
   * live — this is its head and base — and trusted its author: a `push` request for the head,
   * read at its base on the tick, with a forge row that reports it, and every other live push
   * request of the change request superseded. The same head and base asked again is
   * `unchanged`, as is a call that finds a concurrent one's request standing (`keptPush`).
   * `confirm` reads the change request again once the request is filed and before anything
   * else is withdrawn, answering the base it is open at while this is still its head: `stale`,
   * or a base judged other than this push's (a retarget that kept the head), withdraws this
   * call's own request and answers `stale`; `unknown` leaves everything for a retry and answers
   * `unknown`. `off`: checks, or change-request checks, are off here. Idempotent, so a call that
   * failed half way is simply made again.
   */
  changeRequestPushed(
    push: ChangeRequestPush,
    confirm?: () => Promise<{ live: string } | "stale" | "unknown">,
  ): Promise<"checks-requested" | "unchanged" | "stale" | "unknown" | "off">;
  /**
   * Whether the repo declares checks where a change request into `baseRef` is judged: `no`
   * without a `.ryph/checks.yml` there, so an outside contribution has nothing to approve. An
   * invalid file counts as declaring them; its refusal is reported once they are asked for. A
   * base the forge refused before pinning any commit (not a branch it serves) is `no`: there is
   * nothing there to read a declaration from, so nothing would run either.
   */
  declaresChecks(connectedRepoId: string, baseRef: string): Promise<"yes" | "no" | "unknown">;
  /** A change request merged or closed — or, with `exceptHead`, moved onto a head one of ryph's
   * patches carries, or with `onlyHead`, moved off that head: its push requests (of every head,
   * of every other head, or of that one) are withdrawn, and suites nobody else wants cancelled.
   * One already settled stays settled. Idempotent. */
  changeRequestEnded(
    input: { connectedRepoId: string; ref: string; exceptHead?: string; onlyHead?: string },
  ): Promise<void>;
  /** Outside contributions' approvals, as the store keeps them (core/check_approvals.ts decides
   * what they mean). */
  readonly approvals: Pick<
    CheckStore,
    | "claimApproval"
    | "getApproval"
    | "listApprovals"
    | "saveApprovalIf"
    | "claimApprovalComment"
    | "releaseApprovalComment"
  >;
  /** Whether local asks are taken here: checks run, and `RYPH_CHECKS_LOCAL` is not off. */
  readonly local: boolean;
  /**
   * A person's ask from their own machine: a `local` request for the commit, read at the base on
   * the tick — or here, when the read answers within a few seconds. The same commit, base and
   * checks asked again on the branch answers the request standing, unless its suite failed or
   * was cancelled or could not run: the new ask runs that again. Any other of the person's
   * live asks on the branch is superseded, and its suite cancelled unless someone else wants it.
   * Past `RYPH_CHECKS_MAX_LOCAL_PER_USER` asks still going on other branches: `quota`.
   */
  requestLocal(input: LocalChecksInput): Promise<LocalChecksAnswer>;
  /** How many of a person's local asks are still going outside `repo` and `branch` — what a new
   * ask there would count against — and the most they may have. */
  localQuota(
    userId: string,
    connectedRepoId: string,
    branch: string,
    delegationId?: string,
  ): Promise<{ live: number; max: number }>;
  /** A person's bundle streamed to the forge to verify and keep, filed under them, its one ref
   * `refs/heads/<branch>`, verified against `base` (normalised as `requestLocal` normalises it).
   * The caller claims the upload under the hourly cap first (`claimLocalUpload`). A key the
   * forge answered other than `localBundleKey` is `unavailable`. */
  stageLocalBundle(
    input: { user: { userId: string }; repo: ConnectedRepo; branch: string; base?: string },
    body: ReadableStream<Uint8Array>,
  ): Promise<StageCheckBundleOutcome>;
  /** How many bundles a person tried to upload for local asks in the last hour, refused ones
   * included, and the most they may (`RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR`). */
  localUploads(userId: string): Promise<{ used: number; max: number }>;
  /**
   * Claims one upload under the hourly cap: the attempt recorded FIRST, then counted with it, so
   * uploads side by side, on any replica, each see the others' and at most the cap pass. Over
   * it, the attempt is taken back (a refusal costs nothing) and `ok` is false.
   */
  claimLocalUpload(
    userId: string,
    connectedRepoId: string,
  ): Promise<{ ok: boolean; used: number; max: number }>;
  /** One `local` request, by id; null for any other kind, or none. */
  localRequest(id: string): Promise<CheckRequest | null>;
  /**
   * Whether a reader under `scope` may read the suite: every suite under `all`; otherwise one
   * asked for by a task inside the scope (`taskIdsOf`), by the reader's own local ask (active,
   * or superseded since), or by a runless ask — a push, a local ask — on a repo the reader may
   * write. The list's scope query (`CheckSuiteListQuery.scope`) is the same rule in SQL.
   */
  readable(suiteId: string, scope: Scope): Promise<boolean>;
  /** A new generation of a settled suite. The forge's button on one check (`by.check`) runs that
   * check and the ones that did not pass, and takes the rest's passes; anything else runs every
   * check. */
  rerun(
    suiteId: string,
    by: { kind: "user"; userId: string } | { kind: "forge"; deliveryId: string; check?: string },
  ): Promise<
    { kind: "rerun"; suite: CheckSuite } | { kind: "refused"; status: 404 | 409; why: string }
  >;
  /** A check run's re-run button on the forge. `externalId` is untrusted until it names a suite
   * on this repo and head. */
  forgeRerequested(input: {
    connectedRepoId: string;
    headSha: string;
    externalId: string;
    deliveryId: string;
  }): Promise<"checks-rerun" | "no-such-suite">;
  /** "Re-run all checks" on the forge: every suite the forge's reports on this repo and head
   * stand on re-runs — never an older suite of the head a re-run moved them off, nor one the
   * forge was never told about. */
  forgeSuiteRerequested(input: {
    connectedRepoId: string;
    headSha: string;
    deliveryId: string;
  }): Promise<"checks-rerun" | "no-such-suite">;
  /**
   * The agent's `ryph__check_status`: the suites this run asked for, then the suites anyone else
   * got on `at.commits` (a change request's pushes, another run's asks) that this run may read
   * (`readableByRun`). With `at.named`, the agent named the commit: only that is answered.
   */
  statusForRun(run: Run, at?: { commits: RunCommit[]; named: boolean }): Promise<{ text: string }>;
  /** The agent's `ryph__check_log`: one check's stored log, of the suite's current generation
   * unless `generation` names another, when the run may read the suite (`readableByRun`). */
  logForRun(
    run: Run,
    input: { suiteId: string; check: string; generation?: number },
  ): Promise<
    | { kind: "log"; text: string; generation: number }
    | { kind: "refused"; status: 404 | 409; why: string }
  >;
  /**
   * What each of a run's connected repos declares in `.ryph/checks.yml` at its base, for the
   * prompt. Bounded by `withinMs` in all, and nothing here throws: a repo with no checks is in
   * neither list, and one whose read did not answer in time (unavailable, an error, the deadline)
   * is named by its path in `unread`. When the run's repos could not be listed at all, `unread`
   * is `["*"]`.
   */
  declaredForRun(run: Run, withinMs?: number): Promise<DeclaredChecksAnswer>;
  /** One suite with its log tails, `requestedBy` held to the tasks a reader under `scope` may
   * see, as `list` holds it. */
  view(suiteId: string, scope: Scope): Promise<CheckSuiteView | null>;
  /** The branch a suite's head was pushed on, as the list shows it beside the suite; null when
   * the suite knows none, or there is no such suite. */
  branchOf(suiteId: string): Promise<string | null>;
  /** The tasks whose runs or patches asked for a suite, and the task whose patch on its head it
   * judges: whose readers may read it. */
  taskIdsOf(suiteId: string): Promise<string[]>;
  /** The checks list: the store's page, each suite with the branch it ran on and the askers a
   * reader under `scope` may see. A task outside it is left out of `askedBy`, and its run and
   * patch out of `requestedBy`, so nothing of it reaches a reader who could not open it. A
   * listed view carries no log tails: only the suite page shows them. */
  list(
    query: CheckSuiteListQuery & { scope: Scope },
  ): Promise<{ items: CheckSuiteListItem[]; nextCursor: string | null }>;
  /** The newest full suite on `checksRef` a reader under `scope` may read, as `list` carries a
   * view; null when there is none. */
  latest(
    query: { connectedRepoId: string; checksRef: string; scope: Scope },
  ): Promise<CheckSuiteView | null>;
  /** The launch slots as `launchFairly` counts them: the check pods running (`slotsOf`), of the
   * policy's cap. No slots while checks cannot run here. */
  capacity(): Promise<{ inUse: number; total: number }>;
  /** Each repo's checks file on its default branch, read through `declaredForRun`'s cache and
   * held to one deadline for all. Never throws: a read that did not answer is `unread`. */
  declaredOnDefault(repos: readonly ConnectedRepo[], withinMs?: number): Promise<RepoChecksFile[]>;
  /** Every suite a task's runs asked for or its patches' heads got, oldest first, `requestedBy`
   * held to `scope` as `view` holds it. */
  viewsForTask(task: Task, runs: Run[], patches: Patch[], scope: Scope): Promise<CheckSuiteView[]>;
  /** The suite a patch is judged by, as its forge is told: its own, else its head's newest. */
  forPatch(
    patch: Pick<Patch, "id" | "connectedRepoId" | "headSha">,
  ): Promise<CheckSuiteView | null>;
  /** `forPatch`'s suite for each of these patches, by id: patch id → suite id, none for a
   * patch with no suite. */
  suiteIdsForPatches(
    patches: ReadonlyArray<Pick<Patch, "id" | "connectedRepoId" | "headSha">>,
  ): Promise<Record<string, string>>;
  /** One check's stored log, at most MAX_CHECK_LOG_BYTES; null when there is none. */
  log(suiteId: string, generation: number, name: string): Promise<string | null>;
  /** The gateway's lookup of a presented check git key (hashed); null resolves nothing. */
  gitGrant(tokenHash: string): Promise<CheckGitGrant | null>;
  /** The settle hook: suites waiting on this build move on. Never throws. */
  environmentSettled(env: Environment): Promise<void>;
  /** One pass: resolve pending requests, advance waiting suites, launch within the cap, poll
   * running ones, settle, tell runs, report to the forge, sweep orphans. */
  tick(): Promise<void>;
  /** Resolves when no resolve that outlived its asker's answer ("requested") is still going.
   * For tests. */
  idle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure planners — exported for tests, and the whole of what the reports say.
// ---------------------------------------------------------------------------

/**
 * Which branch the declaration is read on: the change request's target where the run has one
 * (a PR run's base), else the run's own base branch when it is a branch of the connected repo,
 * else the default branch. The judge is always a ref the head does not control.
 */
export function checksRef(
  repo: ConnectedRepo,
  entry: Pick<RepoEntry, "url" | "ref" | "targetRef" | "forkHead">,
): string {
  // A fork head's run is judged like its pull request's pushes are: by its base, a branch of
  // this repo only its writers move — never by the fork's own `checks.yml`.
  const ref = entry.targetRef ?? servicesRef(repo, entry);
  try {
    return normalizeBaseRef(ref).localBranch;
  } catch {
    return repo.defaultBranch;
  }
}

/** The suite's backend record name — the Job, the docker prefix — stable across replicas. */
export function checkRecordName(suite: Pick<CheckSuite, "id" | "generation">): string {
  return `ryph-check-${suite.id}-g${suite.generation}`;
}

/**
 * The backend record of a `pod: own` check: the suite's record name, `-o`, the check's place
 * among the declaration's own checks, then as much of the check's name as fits CHECK_RECORD_NAME
 * (none of it, from a six-digit generation). The place, closed by `-` or the end, keeps every own
 * record apart from every other, whatever the names: two own records differ in it, and so do all
 * of their docker objects (`<record>-<stage>`). And `-o` keeps them apart from the shared
 * record's objects, `<name>-<stage>`, as no stage begins with `o`. The name is only there for a
 * person reading the backend. Past seven digits not even the rest fits, and is never cut: the
 * launch fails the suite and says so (`launchOne`).
 */
export function ownRecordName(
  suite: Pick<CheckSuite, "id" | "generation" | "definition">,
  check: string,
): string {
  const place = suite.definition.checks.filter((c) => c.pod === "own")
    .findIndex((c) => c.name === check);
  const head = `${checkRecordName(suite)}-o${place < 0 ? "x" : place}`;
  const room = MAX_CHECK_RECORD_NAME - head.length - 1;
  const cut = room > 0 ? check.slice(0, room).replace(/-+$/, "") : "";
  return cut === "" ? head : `${head}-${cut}`;
}

/** One pod of a suite generation: its record, and the checks of the declaration it runs. */
export interface CheckPod {
  name: string;
  checks: CheckDeclaration[];
  /** A `pod: own` check's pod (its one check), rather than the shared one. */
  own: boolean;
}

/**
 * The pods a suite generation runs on: the shared pod, `checkRecordName`, with every check not
 * declared `pod: own`, when there is one; then a pod per `pod: own` check, `ownRecordName`. A
 * declaration with no `pod: own` is the one shared pod, as every suite had before the key. What a
 * check slot counts (`launchFairly`).
 */
export function checkPods(
  suite: Pick<CheckSuite, "id" | "generation" | "definition">,
): CheckPod[] {
  const shared = suite.definition.checks.filter((c) => c.pod !== "own");
  return [
    ...(shared.length === 0 ? [] : [{ name: checkRecordName(suite), checks: shared, own: false }]),
    ...suite.definition.checks.filter((c) => c.pod === "own").map((c) => ({
      name: ownRecordName(suite, c.name),
      checks: [c],
      own: true,
    })),
  ];
}

/** How many pods a suite of the declaration runs at once (`checkPods`), the slots it needs. */
export function podsNeededOf(definition: Pick<ChecksDeclaration, "checks">): number {
  const own = definition.checks.filter((c) => c.pod === "own").length;
  return own + (own < definition.checks.length ? 1 : 0);
}

/** Why a suite needing `need` pods can never launch here: the setting named, never its value,
 * as this is posted to the forge. */
const tooManyPods = (need: number) =>
  `it needs ${need} check pods at once, more than this deployment runs (RYPH_CHECKS_CONCURRENCY)`;

/** The record whose pod runs a check. */
function recordOf(suite: Pick<CheckSuite, "id" | "generation" | "definition">, check: string) {
  const own = suite.definition.checks.some((c) => c.name === check && c.pod === "own");
  return own ? ownRecordName(suite, check) : checkRecordName(suite);
}

/** Where a failed setup step's log is kept for the checks it failed, beside each check's own
 * (kept under its name): `_setup` for the shared pod, `_setup-<check>` for a `pod: own` check's,
 * whether or not the suite has other pods. `_` is in no check's name (CHECK_NAME), so no check
 * can take either. */
const setupLogOf = (pod: CheckPod): string => pod.own ? `_setup-${pod.checks[0].name}` : "_setup";

/** How a pod is named to a person, in a suite of several. */
const podLabel = (pod: CheckPod): string =>
  pod.own ? `${pod.checks[0].name}'s own pod` : "the shared check pod";

/** ` with size class <name>` when the pod's check named that class itself, else nothing: a
 * reason goes to the forge, and the class the operator picked is not the repo's to read. */
const askedSize = (pod: CheckPod): string =>
  pod.own && pod.checks[0].size !== undefined ? ` with size class ${pod.checks[0].size}` : "";

/** The exit code a check container's entrypoint answers when IT failed, not the check. */
export const CHECK_PLATFORM_EXIT = 125;

/**
 * Why a container ended when it was the POD that ended, not the command: evicted, preempted,
 * its node lost. The command's exit code (137, usually) says nothing about the head then.
 */
const POD_LEVEL_REASONS: ReadonlySet<string> = new Set([
  "Evicted",
  "Preempting",
  "DisruptionTarget",
  "NodeLost",
  "NodeShutdown",
  "Shutdown",
  "Terminated",
  "UnexpectedAdmissionError",
  "PodFailed",
]);

/** Whether an exited container's end was the platform's fault: the entrypoint's own exit, or
 * the pod ended under it. Never a verdict on the head: relaunched, or the suite's `error`. */
export function platformFault(container: CheckContainerState | undefined): boolean {
  return container?.state === "exited" &&
    (container.exitCode === CHECK_PLATFORM_EXIT ||
      (container.reason !== null && POD_LEVEL_REASONS.has(container.reason)));
}

/**
 * The setup step a `pending` pod is running, when the launcher says (`running`: `"clone"` or a
 * setup step's index, absent while the pod is still being scheduled or pulled). Null: not in
 * setup, or not known.
 */
export function setupStepRunning(
  seen: Extract<CheckInspection, { kind: "pending" }>,
): number | null {
  return typeof seen.running === "number" ? seen.running : null;
}

/** What one check container's observed end means. */
export function resultFromContainer(
  container: CheckContainerState | undefined,
): { state: CheckResultState; exitCode: number | null; oom: boolean } {
  if (container === undefined || container.state !== "exited") {
    return { state: "error", exitCode: null, oom: false };
  }
  const { exitCode, reason } = container;
  if (reason === "DeadlineExceeded") return { state: "timed_out", exitCode, oom: false };
  if (exitCode === 0) return { state: "passed", exitCode, oom: false };
  // 124 is the entrypoint's `timeout`: the check outlived its own declared limit.
  if (exitCode === 124) return { state: "timed_out", exitCode, oom: false };
  // 125 is the entrypoint's own failure before the command ran — the tree copy, a service that
  // never answered — and an eviction is the node's: the platform's, not the head's.
  if (platformFault(container)) return { state: "error", exitCode, oom: false };
  // 122 (CHECK_POOL_EXIT) is the pool watcher's stop: the check used the most over its share when
  // the suite's memory ran short. The head's own failure, as any other code; the launcher's
  // reason says so with the numbers, and the suite's reason carries it.
  return { state: "failed", exitCode, oom: reason === "OOMKilled" };
}

/**
 * Whether an exited container's verdict may be taken while its pod still runs. A kill by signal
 * (137 with reason "Error", say) is left for the pod's end: the node's reason for it may not
 * have landed yet, and the head is not blamed for a pod-level kill. Out of memory is the check's
 * own, whatever the exit code.
 */
export function settlesEarly(container: CheckContainerState | undefined): boolean {
  if (container?.state !== "exited" || platformFault(container)) return false;
  const { exitCode, reason } = container;
  if (reason === "DeadlineExceeded" || reason === "OOMKilled") return true;
  return exitCode !== null && exitCode >= 0 && exitCode <= 127;
}

/** A check that answered for itself: its verdict stands for the rest of its generation. */
export const ownVerdict = (state: CheckResultState): boolean =>
  state === "passed" || settledBad(state);

/** A check still without an answer. */
const liveResult = (state: CheckResultState): boolean => state === "queued" || state === "running";

/** A settled suite's state from its checks: passed only when every one passed, failed when one
 * failed on its own account — and `error`, never failed, when the rest is the platform's. */
export function suiteVerdict(results: ReadonlyArray<Pick<CheckResult, "state">>): CheckSuiteState {
  if (results.length > 0 && results.every((r) => r.state === "passed")) return "passed";
  const own = (state: CheckResultState) =>
    state === "failed" || state === "timed_out" || state === "setup_failed";
  return results.some((r) => own(r.state)) || results.length === 0 ? "failed" : "error";
}

/** The services a declaration's checks name, in first-named order. */
export function namedServices(definition: ChecksDeclaration): string[] {
  const out: string[] = [];
  for (const check of definition.checks) {
    for (const name of check.services) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** As the approval queue names a change request: `#12`, GitLab's `!7`, a Radicle patch's short id, or — on a
 * local repository, where the "change request" is the branch the patch landed as — that
 * branch's name. */
function changeRequestLabel(provider: ForgeProvider, ref: string): string {
  switch (provider) {
    case "github":
      return `#${ref}`;
    case "gitlab":
      // `mr-7` is the merge request GitLab's people call `!7`.
      return ref.startsWith("mr-") ? `!${ref.slice("mr-".length)}` : ref;
    case "radicle":
      return ref.slice(0, 7);
    case "local":
      return ref;
  }
}

/** The scratch branch a change request's head is served on, and the branch the checks list
 * shows for it: stable per change request, never a branch of the repo. Asked only for a push
 * the forge reported — which a local repository never sends, having no change requests. */
export function changeRequestBranch(provider: ForgeProvider, ref: string): string {
  switch (provider) {
    case "github":
      return `pull/${ref}/head`;
    case "gitlab": {
      const head = changeRequestHeadRef("gitlab", ref);
      if (head === null) throw new Error(`"${ref}" is not a GitLab merge request`);
      return head.slice("refs/".length);
    }
    case "radicle":
      return `patches/${ref}`;
    case "local":
      throw new Error("a local repository has no change requests to serve a head for");
  }
}

const backoff = (attempts: number, first: number, max: number) =>
  Math.min(max, first * 2 ** Math.max(0, attempts - 1));

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/** Why this deployment cannot run checks although they are on, or null. */
export function checksRefusal(deps: {
  remote?: import("../ports/remote_checks.ts").RemoteChecks | null;
  launcher: CheckLauncher | null;
  forge: ForgeChecks | null;
  config: Pick<ChecksConfig, "gitGateway" | "agentImage">;
}): string | null {
  if (deps.remote != null) return null;
  if (deps.launcher === null) {
    return "this provisioner cannot run check pods; only the kubernetes and docker ones can";
  }
  if (deps.forge === null) return "there is no forge to read .ryph/checks.yml through";
  if (deps.config.gitGateway === null) {
    return "RYPH_GIT_GATEWAY_URL is not set, so a check pod has nowhere to clone the commit from";
  }
  if (deps.config.agentImage === null) {
    return "RYPH_AGENT_IMAGE is not set, so checks have no image to fall back on";
  }
  return null;
}

/** A launch the egress policy refuses: the suite's error, never a retry. */
class ScopeRefused extends Error {}

/** A `pod: own` check's `size` the deployment does not define: the suite's error, never a
 * retry and never another class. */
class SizeRefused extends Error {}

export function makeChecksService(deps: ChecksDeps): ChecksService {
  const { store, tasks, diag, config } = deps;
  const { policy } = config;
  const enabled = policy.enabled;
  const refusedReason = enabled ? checksRefusal(deps) : null;
  const active = enabled && refusedReason === null;
  /** When this service came up: the patch backstop's horizon, unless a patch born earlier shows
   * checks were on then too (`refilePatches`). */
  const upSince = deps.now().getTime();
  const nonce = deps.nonce ?? fenceNonce;
  const nowIso = () => deps.now().toISOString();
  const errText = (err: unknown) => err instanceof Error ? err.message : String(err);
  const inboxDeps = () => ({ store: tasks, diag, inbox: deps.inbox ?? null, now: deps.now });
  let lastOrphanSweep = -Infinity;
  /** Where the waiting pass's next page starts; undefined, from the first. */
  let waitingCursor: string | undefined;
  let remoteCursor: string | undefined;
  const REMOTE_WITHDRAWAL = "remote delegation withdrawal pending";
  /**
   * The declared-checks reads, by repo and ref: one read shared by every boot that asks within
   * DECLARED_CACHE_MS, the one in flight included. The deadline stops a boot waiting, not the
   * read, which may take the forge's two minutes; without this a burst of boots would start one
   * each. A read that could not be answered is dropped once it lands.
   */
  const declaredReads = new Map<string, { at: number; read: Promise<ChecksFile> }>();
  const declaredRead = (repo: ConnectedRepo, ref: string): Promise<ChecksFile> => {
    const now = deps.now().getTime();
    for (const [key, entry] of declaredReads) {
      if (now - entry.at >= DECLARED_CACHE_MS) declaredReads.delete(key);
    }
    const key = `${repo.id}\u0000${ref}`;
    const cached = declaredReads.get(key);
    if (cached !== undefined) return cached.read;
    const read = deps.remote != null
      ? deps.remote.readChecksFile(repo, ref)
      : deps.forge!.readChecksFile(forgeRepoRef(repo), repo.url, ref);
    const entry = { at: now, read };
    declaredReads.set(key, entry);
    const drop = () => {
      if (declaredReads.get(key) === entry) declaredReads.delete(key);
    };
    read.then((file) => file.kind === "unavailable" && drop(), drop);
    return read;
  };

  const envUsable = () => {
    const env = deps.environments;
    return env !== null && env.enabled && env.refusedReason === null;
  };

  const offText = () => checksOffText(enabled ? refusedReason : null);

  // ---- suites ------------------------------------------------------------

  const queuedResults = (suite: CheckSuite, state: CheckResultState = "queued"): CheckResult[] =>
    suite.definition.checks.map((check) => ({
      suiteId: suite.id,
      generation: suite.generation,
      name: check.name,
      state,
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      logKey: null,
      logTail: null,
      watchedChanged: null,
      forgeRef: null,
      inheritedFrom: null,
    }));

  /** The forge rows reporting this suite (or waiting on its head) are due now. */
  const touchReports = (suite: CheckSuite): Promise<void> =>
    // A partial suite is never reported, so nothing waits on it.
    suite.remote != null || deps.remote != null || isPartial(suite)
      ? Promise.resolve()
      : store.touchForgeReports(suite, nowIso());

  /** A request's source as a suite keeps it: where the commit comes from, and nothing about
   * which checks were asked for, who asked, or what they want of a failure. */
  const podSource = (source: CheckSource): CheckSource => {
    const { checks: _asked, ...rest } = source;
    if ("askerName" in rest) delete rest.askerName;
    if ("retryFailed" in rest) delete rest.retryFailed;
    return rest as CheckSource;
  };

  /** Whether two sources name the same place to fetch the commit from: one bundle (a run's or a
   * person's), or one head on the forge (a change request's, or a person's pushed branch). */
  const sameSource = (a: CheckSource, b: CheckSource): boolean => {
    if (isForgeSource(a) || isForgeSource(b)) {
      return isForgeSource(a) && isForgeSource(b) && a.changeRequest === b.changeRequest &&
        a.fetchRef === b.fetchRef;
    }
    return bundleKeyOf(a) === bundleKeyOf(b);
  };

  /** A compare-and-set from the suite as read, its `version` included: a read older than
   * anyone's write since lands nothing. Answers the row written, its version the read one's plus
   * one, or null. */
  const transition = async (
    from: CheckSuite,
    patch: Partial<CheckSuite>,
    lease: string | null | undefined = from.leaseUntil,
  ): Promise<CheckSuite | null> => {
    const next: CheckSuite = { ...from, ...patch, version: from.version + 1, updatedAt: nowIso() };
    const landed = await store.saveSuiteIf(next, {
      states: [from.state],
      generation: from.generation,
      leaseUntil: lease,
      version: from.version,
    });
    if (!landed) return null;
    await touchReports(next).catch((err) =>
      diag.warn("checks.touch_failed", { suiteId: next.id, err: errText(err) })
    );
    return next;
  };

  /**
   * Every check of the generation: the answered ones keep their row, the rest are `error`.
   * `answered`: as read already.
   */
  const keptOrError = async (
    suite: CheckSuite,
    answered?: ReadonlyMap<string, CheckResult>,
  ): Promise<CheckResult[]> => {
    const kept = answered ?? answeredOf(await store.listResults(suite.id, suite.generation));
    const at = nowIso();
    return queuedResults(suite, "error").map((r) => kept.get(r.name) ?? { ...r, finishedAt: at });
  };

  /**
   * Settles a suite the platform could not finish: every check without its own verdict `error`,
   * and the suite's state from all of them, so a check that failed on its own account still
   * fails the suite.
   */
  const errorSuite = async (suite: CheckSuite, reason: string): Promise<CheckSuite | null> => {
    const at = nowIso();
    const results = await keptOrError(suite);
    const next = await transition(suite, {
      state: results.some((r) => r.state !== "error") ? suiteVerdict(results) : "error",
      reason,
      finishedAt: at,
      leaseUntil: null,
    });
    if (next === null) return null;
    // A kept row keeps its verdict: the store never overwrites a settled one.
    await store.upsertResults(results);
    await store.revokeCheckGitKeys(suite.id, suite.generation, at);
    diag.debug("checks.suite_error", { suiteId: suite.id, reason });
    return next;
  };

  /**
   * A launch that did not take: back to the queue for another try, or `error` past the last.
   *
   * `sourceFailed`: the clone could not fetch the commit from the suite's source. The source is
   * whichever request claimed the suite first, and nothing proves that run ever uploaded the
   * commit — so the retry takes another asker's source of the same commit when there is one (a
   * run's or a person's bundle, a head on the forge, any way round), and an asker that named a
   * commit it never shipped cannot hold the suite for those that did.
   *
   * `claimed`: the caller holds the suite's launch claim, and cleans up what its launch made
   * itself. Otherwise (a poll) the suite's lease comes first, by compare-and-set on the row as
   * read, and only then are its pods discarded and every key of it revoked: a stale read takes
   * nothing, so it never tears down another replica's relaunch.
   */
  const launchFailed = async (
    read: CheckSuite,
    why: string,
    opts: { sourceFailed?: boolean; claimed?: boolean } = {},
  ): Promise<void> => {
    let suite = read;
    if (!opts.claimed) {
      // A crash between the lease and the requeue holds the suite until the lease runs out (10
      // min); the next poll then fails the launch again, its pods reported disappeared.
      const held = await hold(read);
      if (held === null) return;
      suite = held;
      await store.revokeCheckGitKeys(suite.id, suite.generation, nowIso());
      await discardPods(suite);
    }
    // A check that already failed on its own account decides the suite: a relaunch would only
    // repeat it. The suite settles on the verdicts it has, and the rest are `error`. So does a
    // suite whose every check already answered: a relaunch would ask nothing new.
    const answered = answeredOf(await store.listResults(suite.id, suite.generation));
    const results = await keptOrError(suite, answered);
    const all = answered.size === suite.definition.checks.length;
    if (all || results.some((r) => settledBad(r.state))) {
      const state = suiteVerdict(results);
      await settle(suite, () =>
        Promise.resolve({
          results,
          state,
          // Every check answered: each pod's reason, and an `error` suite never without one.
          reason: all ? podReasons(suite) ?? (state === "error" ? why : null) : why,
          ryphChanged: suite.ryphChanged,
        }));
      return;
    }
    if (suite.attempts >= MAX_LAUNCH_ATTEMPTS) {
      await errorSuite(suite, `${why} (after ${suite.attempts} attempts)`);
      return;
    }
    const other = opts.sourceFailed
      ? (await store.listRequestsForSuite(suite.id)).reverse().find((r) =>
        r.state === "active" && !sameSource(r.source, suite.source)
      )
      : undefined;
    await transition(suite, {
      state: "queued",
      reason: `${why}; retrying`,
      leaseUntil: null,
      launchedAt: null,
      // Its open pods' lives were this attempt's; the next launch starts them again.
      pods: answeredLives(suite, answered),
      ...(other === undefined ? {} : { source: podSource(other.source) }),
    });
    diag.warn("checks.launch_retry", { suiteId: suite.id, attempts: suite.attempts, why });
  };

  // ---- environments --------------------------------------------------------

  /** A waiting suite follows its build: queued on its image, or `error` with its failure.
   * `readBase`: as `attachEnvironment`'s, for a build that was superseded. */
  const advanceWaiting = async (
    suite: CheckSuite,
    env: Environment,
    readBase = true,
  ): Promise<CheckSuite | null> => {
    if (env.status === "ready" && env.image !== null) {
      await transition(suite, {
        state: "queued",
        image: podImage(env),
        environmentId: env.id,
        reason: null,
      });
      return null;
    }
    if (env.status === "failed") {
      await errorSuite(
        { ...suite, environmentId: env.id },
        `the base's environment failed to build: ${env.failure ?? "see its log"} ` +
          `(environment ${env.id}); a re-run builds it again`,
      );
      return null;
    }
    if (env.status === "superseded") {
      // A newer build of the branch replaced it; look again.
      const released = await transition(suite, { environmentId: null });
      if (released !== null) return await attachEnvironment(released, readBase);
    }
    return null;
  };

  /** When this generation began waiting, if a person or the forge asked for it (`rerun`): what
   * a failed build of its base must have ended after to be its answer. Null otherwise. */
  const rerunWaitingSince = async (suite: CheckSuite): Promise<string | null> => {
    if (suite.waitingSince === null) return null;
    const asked = (await store.listRequestsForSuite(suite.id)).some((r) =>
      (r.kind === "rerun" || r.kind === "forge") && r.state === "active" &&
      r.reportedGeneration === suite.generation
    );
    return asked ? suite.waitingSince : null;
  };

  /**
   * What the note and the forge report say about the suite's image, read off its environment row
   * (`Environment.setupWarnings`): the repos whose setup.yml it did not finish, when the checks ran
   * on a half-set-up image (check_feedback.ts `setupUnfinishedSentence`); else, when the image is
   * a clean one taken over a NEWER build of the same definition whose setup.yml did not finish
   * (`newestForChecks`), its build time (`olderImageSentence`). Nulls with nothing to say, or
   * nothing to read.
   */
  const imageNotesOf = async (suite: CheckSuite): Promise<{
    setupUnfinished: string[] | null;
    olderImage: { builtAt: string | null } | null;
  }> => {
    const none = { setupUnfinished: null, olderImage: null };
    if (suite.environmentId === null || deps.environments === null) return none;
    const envStore = deps.environments.store;
    const row = await envStore.getEnvironment(suite.environmentId).catch(() => null);
    if (row === null) return none;
    // Only a repo whose own setup stopped: a step failed, or setup.yml is invalid. One whose
    // setup finished and only had what it left discarded (`dirty`, `discarded`) is not one, and
    // an `unreadable` record says nothing either way.
    const paths = [
      ...new Set(
        (row.setupWarnings ?? []).filter((w) => w.kind === "step" || w.kind === "invalid")
          .map((w) => w.path),
      ),
    ];
    if (paths.length > 0) return { setupUnfinished: paths, olderImage: null };
    // A newer unfinished build the suite could have taken: one that had finished by its launch.
    const by = suite.launchedAt ?? suite.updatedAt;
    const history = await envStore.listEnvironmentsForSubject(row.subjectKind, row.subjectId)
      .catch(() => []);
    const passedOver = history.some((e) =>
      e.id !== row.id && e.status === "ready" && e.definition === row.definition &&
      setupUnfinished(e) && byNewestBuilt(e, row) < 0 && (e.finishedAt ?? e.createdAt) <= by
    );
    return { setupUnfinished: null, olderImage: passedOver ? { builtAt: row.finishedAt } : null };
  };

  /** The image a check pod launches from a ready row: the baked image under the harness layer
   * when the row kept one. The pod's command replaces the entrypoint and runs none of the
   * harness, and a re-layer onto a new harness keeps the baked image, so the suite's image does
   * not move with every deploy. */
  const podImage = (e: Environment): string => e.bakedImage ?? e.image!;

  /** A row built from exactly this `.ryph/` tree, of the default branch or the base branch itself:
   * never another branch's, whose own setup ran as it baked. A check's subject is one repo, and
   * a repo's definition is its tree id as it is (`definitionKey`), so the row's
   * definition is compared with the tree directly. */
  const fitsTree = (e: Environment, tree: string, branch: string) =>
    e.definition === tree && (e.defaultBranch || e.ref === branch);

  /** The newest ready image of the tree, as `fitsTree` takes them — one whose setup.yml finished
   * before a newer one whose setup.yml did not (`newestForChecks`; every row here is of the same
   * definition): a check pod runs checks.yml's `setup`, never `.ryph/setup.yml`, so it would
   * inherit the half-done tree. */
  const readyOfTree = (history: Environment[], tree: string, branch: string) =>
    newestForChecks(
      history.filter((e) => e.status === "ready" && e.image !== null && fitsTree(e, tree, branch)),
    ) ?? undefined;

  /**
   * The base's environment for a waiting suite: the newest ready image of exactly its `.ryph/`
   * tree built from the default branch or from `checksRef` itself — never another branch's,
   * whose own setup ran as it baked — else a build of it already on its way, else one queued.
   *
   * Only the last asks the forge (it reads the base's `.ryph/`). `readBase` false stops short of
   * that read and answers the suite that needs it, for the caller to read on the forge's budget;
   * otherwise, and whenever nothing is left to read, null.
   */
  const attachEnvironment = async (
    suite: CheckSuite,
    readBase = true,
  ): Promise<CheckSuite | null> => {
    const service = deps.environments;
    if (service === null || !envUsable()) {
      // Environments went off since the suite was keyed on a tree: it cannot be judged as
      // declared, and running it in the default image would be a different claim.
      await errorSuite(suite, "environment builds are off here");
      return null;
    }
    const tree = suite.environmentKey.slice("tree:".length);
    const branch = suite.checksRef;
    const subject = await service.loadSubject("repo", suite.connectedRepoId);
    if (subject === null) {
      await errorSuite(suite, "its repo is no longer connected");
      return null;
    }
    const history = await service.store.listEnvironmentsForSubject("repo", subject.id);
    const fits = (e: Environment) => fitsTree(e, tree, branch);
    const ready = readyOfTree(history, tree, branch);
    if (ready !== undefined) {
      return await advanceWaiting(suite, ready, readBase);
    }
    const live = history.find((e) => (e.status === "queued" || e.status === "building") && fits(e));
    if (live !== undefined) {
      if (suite.environmentId !== live.id) {
        await transition(suite, {
          environmentId: live.id,
          reason: `waiting for the base's environment build (${live.id})`,
        });
      }
      return null;
    }
    // The same base commit already failed to build: that failure is the answer until the
    // base moves, rather than a rebuild per suite — but not to a re-run, which asks for a
    // build of its own: a failure that ended before this generation began waiting is not one.
    const failedAt = history.filter((e) =>
      e.status === "failed" && fits(e) && Object.values(e.commits).includes(suite.checksCommit)
    );
    const since = failedAt.length > 0 ? await rerunWaitingSince(suite) : null;
    const failed = failedAt.find((e) =>
      // A failure with no end time is an old one: a row touched since must not pass for new.
      since === null || (e.finishedAt !== null && Date.parse(e.finishedAt) > Date.parse(since))
    );
    if (failed !== undefined) {
      return await advanceWaiting(suite, failed, readBase);
    }
    if (!readBase) return suite;
    const plan = await service.planFor(subject, branch, undefined, suite.checksCommit);
    if (plan.definition !== tree) {
      await errorSuite(suite, "the base's .ryph/ read differently the second time");
      return null;
    }
    const env = await service.enqueue({
      subject,
      ref: branch,
      // Never a default-branch build, even of the default branch: it is the base at
      // `checksCommit`, which may be behind the branch, and a default-branch row that lands
      // after a newer one would be the image every run on the branch picks up. As a branch
      // build it reads the shared layer cache and writes none, and serves this suite and the
      // next one on the same tree (`fits` above).
      defaultBranch: false,
      checkouts: plan.checkouts,
      definition: plan.definition,
      dockerfile: plan.dockerfile,
      machine: plan.machine,
      trigger: "check",
      reason: `check suite ${suite.id} on ${branch} at ${
        suite.checksCommit.slice(0, 12)
      } needs an image of its .ryph/ (${tree.slice(0, 12)})`,
    });
    diag.debug("checks.environment_asked", { suiteId: suite.id, environmentId: env.id });
    if (env.status === "queued" || env.status === "building") {
      await transition(suite, {
        environmentId: env.id,
        reason: `waiting for the base's environment build (${env.id})`,
      });
      return null;
    }
    return await advanceWaiting(suite, env);
  };

  /** A build a suite left for a ready image: superseded when a check asked for it and nothing else
   * waits on it (`EnvironmentService.release`). Never throws. A cancelled suite releases nothing:
   * the next suite of its run may well want the same build. */
  const releaseBuild = async (env: Pick<Environment, "id" | "trigger">): Promise<void> => {
    if (env.trigger !== "check") return;
    const why = "Nothing waits for this build any more.";
    await deps.environments?.release(env.id, why).catch((err) =>
      diag.warn("checks.release_failed", { environmentId: env.id, err: errText(err) })
    );
  };

  /**
   * The tick's look at one waiting suite, from the database alone: along its build, or attached
   * to one already there. Given up on after a day — a build that never lands must not hold a
   * suite for ever — and a look that failed is said on the suite, not only in the log. Answers
   * the suite when it has no build to follow yet and its base's `.ryph/` is to be read to ask
   * for one (`readOne`, on the forge's budget) — unless a read of it failed lately, when it
   * waits out its backoff first.
   */
  const lookOne = async (suite: CheckSuite): Promise<CheckSuite | null> => {
    if (suite.remote != null) {
      await refreshRemote(suite);
      return null;
    }
    const since = Date.parse(suite.waitingSince ?? suite.updatedAt);
    if (deps.now().getTime() - since >= WAIT_GIVE_UP_MS) {
      await errorSuite(
        suite,
        `the base's environment was not ready within a day${
          suite.reason === null ? "" : ` (${suite.reason})`
        }`,
      );
      return null;
    }
    let toRead: CheckSuite | null;
    try {
      let env = suite.environmentId === null
        ? null
        : await deps.environments?.store.getEnvironment(suite.environmentId) ?? null;
      let left: Environment | null = null;
      if (env !== null && (env.status === "queued" || env.status === "building")) {
        // A ready image of the same tree landed while the suite's own build is still going (a
        // default-branch build that finished first): it is as good, and it is here now.
        const history = await deps.environments!.store.listEnvironmentsForSubject(
          "repo",
          suite.connectedRepoId,
        );
        const ready = readyOfTree(
          history,
          suite.environmentKey.slice("tree:".length),
          suite.checksRef,
        );
        if (ready !== undefined) [left, env] = [env, ready];
      }
      toRead = env === null
        ? await attachEnvironment(suite, false)
        : await advanceWaiting(suite, env, false);
      // The build it left: a check's own ask, called off once nothing else waits on it.
      if (left !== null) await releaseBuild(left);
    } catch (err) {
      const why = `could not look up the base's environment (${errText(err)}); retrying`;
      if (suite.reason !== why) await transition(suite, { reason: why });
      throw err;
    }
    const notBefore = toRead?.nextAttemptAt ?? null;
    return notBefore !== null && Date.parse(notBefore) > deps.now().getTime() ? null : toRead;
  };

  /** A waiting suite's read of its base, to ask for the build it waits on. One that failed —
   * a forge that answered with an error, or not before its timeout — is not tried again before
   * a backoff: as long as the suite has waited so far, from half a minute up to half an hour. */
  const readOne = async (suite: CheckSuite): Promise<void> => {
    try {
      await attachEnvironment(suite);
    } catch (err) {
      const now = deps.now().getTime();
      const waited = now - Date.parse(suite.waitingSince ?? suite.updatedAt);
      const delay = Math.min(READ_RETRY_MAX_MS, Math.max(READ_RETRY_MS, waited));
      await transition(suite, {
        reason: `could not look up the base's environment (${errText(err)}); retrying`,
        nextAttemptAt: new Date(now + delay).toISOString(),
      });
      throw err;
    }
  };

  /**
   * What a new suite runs in, decided once as it is claimed: the identity's environment key, and
   * the image unless the suite waits for one. The rule is the one runs follow
   * (core/environment_resolve.ts), "wait when the image would be wrong, never when it is old":
   *
   * - environments off: `default:<RYPH_AGENT_IMAGE>`
   * - the base is the default branch, or a branch whose `.ryph/` tree is the default branch
   *   head's, or a branch where neither side has a `.ryph/Dockerfile`: the default branch's
   *   machine. The newest ready default-branch image whatever tree it was built from, keyed
   *   `image:<its baked image>`, never a wait. Nothing ready: with no Dockerfile, the default
   *   image; with one, `tree:<the base's tree>`, waiting for a build of it (`attachEnvironment`)
   * - a branch whose tree differs and that has a Dockerfile: `tree:<its tree>`, waiting for an
   *   image of exactly that tree
   * - a branch whose tree differs and that dropped the Dockerfile the default branch has: the
   *   default image, no wait
   *
   * A `tree:` wait with nothing ready or on its way for that tree, and the builder not answering,
   * takes the fallback runs take instead: the newest ready default-branch image, else the
   * default one. So does a default branch head the forge could not read.
   *
   * Runs also ask for an image on the current harness layer; a check pod runs none of the
   * harness (its command replaces the entrypoint), so it launches the baked image under it and
   * the key names that. A re-layer onto a new harness keeps the baked image, so it keeps the key.
   * A choice answers every ask at the same base commit for IMAGE_CHOICE_MS, so asks that land
   * together join one suite; a suite never changes image once claimed, and a newer image is a
   * new suite for the next ask after that. The one exception is an image found gone from the
   * machine (`imageLeftMachine`): its choices are forgotten, and a `tree:` suite on it waits for
   * its tree again.
   */
  type EnvironmentChoice = { key: string; image: string | null; environmentId: string | null };
  const imageChoices = new Map<string, { at: number; choice: Promise<EnvironmentChoice> }>();
  const chooseEnvironment = (
    repo: ConnectedRepo,
    ref: string,
    base: { commit: string; ryphTree: string | null; dockerfile: boolean },
  ): Promise<EnvironmentChoice> => {
    const now = deps.now().getTime();
    for (const [key, entry] of imageChoices) {
      if (now - entry.at >= IMAGE_CHOICE_MS) imageChoices.delete(key);
    }
    const key = [repo.id, ref, base.commit, base.ryphTree ?? "", base.dockerfile].join("\u0000");
    const cached = imageChoices.get(key);
    if (cached !== undefined) return cached.choice;
    const choice = decideEnvironment(repo, ref, base);
    const entry = { at: now, choice };
    imageChoices.set(key, entry);
    choice.catch(() => {
      if (imageChoices.get(key) === entry) imageChoices.delete(key);
    });
    return choice;
  };

  /** The default branch head's `.ryph/`, by repo: one read answers every branch base that asks
   * within IMAGE_CHOICE_MS, the one in flight included. A read that failed is dropped. */
  type DefaultTree = { commit: string; tree: string | null; dockerfile: boolean };
  const defaultTrees = new Map<string, { at: number; read: Promise<DefaultTree> }>();
  const defaultTreeOf = (
    service: EnvironmentService,
    repo: ConnectedRepo,
  ): Promise<DefaultTree> => {
    const now = deps.now().getTime();
    for (const [key, entry] of defaultTrees) {
      if (now - entry.at >= IMAGE_CHOICE_MS) defaultTrees.delete(key);
    }
    const key = `${repo.id}\u0000${repo.defaultBranch}`;
    const cached = defaultTrees.get(key);
    if (cached !== undefined) return cached.read;
    const read = (async () => {
      const subject = await service.loadSubject("repo", repo.id);
      if (subject === null) throw new Error("its repo is no longer connected");
      const plan = await service.planFor(subject, repo.defaultBranch);
      const commit = plan.checkouts.find((c) => c.connectedRepoId === repo.id)?.commit;
      if (commit === undefined) throw new Error("the default branch's head was not read");
      return { commit, tree: plan.definition, dockerfile: plan.dockerfile };
    })();
    const entry = { at: now, read };
    defaultTrees.set(key, entry);
    read.catch(() => {
      if (defaultTrees.get(key) === entry) defaultTrees.delete(key);
    });
    return read;
  };

  const decideEnvironment = async (
    repo: ConnectedRepo,
    ref: string,
    base: { commit: string; ryphTree: string | null; dockerfile: boolean },
  ): Promise<EnvironmentChoice> => {
    const onDefault = (): EnvironmentChoice => ({
      key: `default:${config.agentImage}`,
      image: config.agentImage,
      environmentId: null,
    });
    const onRow = (row: Environment): EnvironmentChoice => ({
      key: `image:${podImage(row)}`,
      image: podImage(row),
      environmentId: row.id,
    });
    const service = deps.environments;
    if (service === null || !envUsable()) return onDefault();
    const history = await service.store.listEnvironmentsForSubject("repo", repo.id);
    // The newest whose setup.yml finished, before a newer one OF THE SAME DEFINITION whose
    // setup.yml did not (`newestForChecks`; an older definition's clean image is not the machine
    // the repo describes now): retention keeps that one until a clean successor settles
    // (`retainedOfGroup`).
    const newestDefault = newestForChecks(
      history.filter((e) => e.defaultBranch && e.status === "ready" && e.image !== null),
    ) ?? undefined;
    const fallback = (why: string): EnvironmentChoice => {
      diag.warn("checks.environment_fallback", { repo: repo.repoRef, ref, why });
      return newestDefault === undefined ? onDefault() : onRow(newestDefault);
    };
    /** Wait for an image of exactly `tree`, unless nothing of it is ready or on its way and the
     * builder is not answering. */
    const waitForTree = (tree: string): EnvironmentChoice => {
      const waitable = readyOfTree(history, tree, ref) !== undefined ||
        history.some((e) =>
          fitsTree(e, tree, ref) && (e.status === "queued" || e.status === "building" ||
            // A failed build of this tree at this commit is the suite's answer, as it is a run's.
            (e.status === "failed" && Object.values(e.commits).includes(base.commit)))
        );
      const fault = waitable ? null : service.builderFault();
      if (fault === null) return { key: `tree:${tree}`, image: null, environmentId: null };
      return fallback(`the builder is not answering (${fault})`);
    };

    if (ref !== repo.defaultBranch) {
      let onDefaultBranch: DefaultTree;
      try {
        onDefaultBranch = await defaultTreeOf(service, repo);
      } catch (err) {
        return fallback(`the default branch's .ryph/ could not be read (${errText(err)})`);
      }
      // A different tree the branch did not CHANGE since it forked is the default branch's
      // machine all the same: it merges into it (core/ryph_baseline.ts).
      const own = base.ryphTree !== onDefaultBranch.tree &&
        (base.dockerfile || onDefaultBranch.dockerfile) &&
        (await service.baseline({
          repo,
          ref,
          head: { commit: base.commit, tree: base.ryphTree },
          defaultRef: repo.defaultBranch,
          onDefault: onDefaultBranch,
          onError: (err) =>
            diag.warn("checks.baseline_unread", { repo: repo.repoRef, ref, err: errText(err) }),
        })).own;
      if (own) {
        // A machine of its own: built for it and waited for. None, where the default branch has
        // one: the universal image is its machine.
        if (base.ryphTree === null || !base.dockerfile) return onDefault();
        return waitForTree(base.ryphTree);
      }
      // The same `.ryph/` as the default branch, or no Dockerfile on either side: its machine.
    }
    if (newestDefault !== undefined) return onRow(newestDefault);
    if (!base.dockerfile || base.ryphTree === null) return onDefault();
    return waitForTree(base.ryphTree);
  };

  // ---- requests ------------------------------------------------------------

  const repoOf = async (id: string) => {
    const repo = await tasks.getConnectedRepo(id);
    return repo === null || repo.archivedAt !== null ? null : repo;
  };

  /** The request as it now stands, and the suite it joined when it did. `lost`: another
   * resolver (the tick, a supersede) moved the request first, and this one wrote nothing. */
  type Resolved = {
    request: CheckRequest;
    suite: CheckSuite | null;
    reused: boolean;
    lost?: boolean;
  };

  /**
   * What a resolve knows of its caller: whether the asker was already answered "requested", so a
   * refusal now is news it must be sent. The tick's resolves are all such. `refusing`: a refusal
   * the caller will answer itself is being written, so the tool waits for it rather than say
   * "requested" (`requestForRun`).
   */
  type ResolveContext = { answered: boolean; refusing?: boolean };
  const ON_THE_TICK: ResolveContext = { answered: true };

  /** A request write that lands only while the request is still pending. */
  const moveRequest = async (next: CheckRequest): Promise<boolean> => {
    const landed = await store.saveRequestIf(next, ["pending"], { noteNot: REMOTE_WITHDRAWAL });
    if (!landed) diag.debug("checks.request_moved_on", { requestId: next.id });
    return landed;
  };
  const lostRace = (request: CheckRequest): Resolved => ({
    request,
    suite: null,
    reused: false,
    lost: true,
  });

  const refuse = async (
    request: CheckRequest,
    note: string,
    ctx: ResolveContext,
  ): Promise<Resolved> => {
    const next: CheckRequest = { ...request, state: "refused", note, nextAttemptAt: null };
    const tellable = request.kind === "tool" && request.runId !== null;
    // Nobody was told "requested" yet: the caller answers with the refusal itself, and the tool
    // waits for this write rather than answer "requested" while it lands.
    if (!ctx.answered || !tellable) {
      if (!ctx.answered) ctx.refusing = true;
      if (!await moveRequest(next)) return lostRace(request);
      diag.debug("checks.request_refused", { requestId: request.id, note });
      return { request: next, suite: null, reused: false };
    }
    // The agent heard "requested" for this one: the refusal is its answer, so it is sent. Sent
    // BEFORE the request leaves `pending`: a run held for its checks stops waiting once nothing it
    // asked for is pending or unanswered (core/check_awaiting.ts), so the message must already be
    // in its inbox by then. Two replicas resolving the same request reach the same refusal, so the
    // cost of a lost race below is the same message twice.
    const now = (await store.listRequestsForRun(request.runId!)).find((r) => r.id === request.id);
    // Superseded or withdrawn meanwhile: nobody wants the answer any more.
    if (now !== undefined && now.state !== "pending") return lostRace(request);
    const run = await tasks.getRun(request.runId!);
    if (run !== null && !isTerminal(run)) {
      const repo = await tasks.getConnectedRepo(request.connectedRepoId);
      const text = requestedText({
        request: next,
        suite: null,
        reused: false,
        repoRef: repo === null ? request.connectedRepoId : runFacingRepoName(repo),
      });
      const posted = await postMessage(inboxDeps(), run, {
        kind: "system",
        sender: { kind: "platform" },
        // Cut to what the inbox takes, as the tool's own answer is: a note too long is never in.
        text: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
        payload: null,
      }).then((outcome) => {
        // The inbox's refusal is final (the run ended meanwhile): asking again changes nothing.
        if (outcome.kind === "refused") {
          diag.warn("checks.note_refused", {
            runId: run.id,
            requestId: request.id,
            err: outcome.error,
          });
        }
        return true;
      }, (err) => {
        diag.warn("checks.note_failed", { runId: run.id, requestId: request.id, err });
        return false;
      });
      if (!posted) {
        // Still pending, so the run keeps waiting for it: the tick tries again shortly.
        const retry: CheckRequest = {
          ...request,
          nextAttemptAt: new Date(deps.now().getTime() + REFUSAL_RETRY_MS).toISOString(),
        };
        if (!await moveRequest(retry)) return lostRace(request);
        return { request: retry, suite: null, reused: false };
      }
    }
    if (!await moveRequest(next)) return lostRace(request);
    diag.debug("checks.request_refused", { requestId: request.id, note });
    return { request: next, suite: null, reused: false };
  };

  /** A pod with no way out. */
  const noWayOut = (): RunNetworkScope => ({
    mode: config.egress.policy.mode,
    bundles: [],
    hosts: [],
  });

  /**
   * The egress scope a request's pod gets: its run's, frozen at that run's launch. A run that is
   * gone leaves a pod with no way out. A source with no run (a change request's head, a
   * person's ask from their machine) gets what an agent with no network policy gets — the
   * deployment's ceiling as it stands — and never anything per-event or per-person, so any
   * other asker with no run lands on the same identity: a local ask and the push request of the
   * pull request opened on its commit share one suite.
   */
  const networkScopeOf = async (source: CheckSource): Promise<RunNetworkScope> => {
    if (source.runId === null) {
      const resolved = resolveNetworkScope(null, await liveCeiling(tasks, config.egress.policy));
      return resolved.kind === "ok" ? resolved.scope : noWayOut();
    }
    const run = await tasks.getRun(source.runId);
    return run?.networkScope ?? noWayOut();
  };

  /** What besides the base and the commit makes two pods different pods. */
  const inputsKeyOf = async (
    scope: RunNetworkScope,
    services: ServiceSpec[] | string,
    only: string[] | null,
  ): Promise<string> =>
    (await sha256Hex(JSON.stringify({
      network: { mode: scope.mode, hosts: [...scope.hosts].sort() },
      services,
      // Only a partial suite carries the key, so every full suite keeps the identity it had.
      ...(only === null ? {} : { checks: [...only].sort() }),
    }))).slice(0, 32);

  /**
   * A new suite takes the passes its commit already has: a check that passed in another suite of
   * the same commit, read from the same checks file, in the same image, reaching the same hosts,
   * with the same services for what it names, has nothing more to say about the commit. The base
   * commit need not match: those are all a check takes from the base, so a merge that moved the
   * base between two asks takes nothing away. So an agent that
   * ran the checks it broke first and then all of them pays only for the rest. The row is copied,
   * its log key included, so the page and the forge show that run's output. Only passes: a
   * failure is asked again, since asking again is how a flaky one is retried. A re-run of the
   * whole suite, the page's or the forge's, takes none: running every check again is what it is
   * for. The forge's re-run of one check takes all but that one (`except`), and only from the
   * suite's own last generation, so the button on a flaky check runs it and whatever else
   * failed, not the passes beside it. A join of a cancelled or broken suite takes them too, and
   * so does a retry of a failed one (`asksAgain`), its own last generation's passes among them
   * (`previous`): a failure passed since, alone or in a partial suite, is then a pass here.
   * Every check passed already: the suite settles `passed` here, with no pod. Whether the commit
   * changed `.ryph/` comes along from the suites it took from at the same base, since no clone
   * of this suite's will say: against another base the answer may differ, and the first stamp
   * stands over this suite's own clone.
   */
  const reusePasses = async (
    suite: CheckSuite,
    previous?: CheckSuite,
    except?: string,
  ): Promise<CheckSuite> => {
    const servicesFor = (s: CheckSuite, names: readonly string[]) =>
      JSON.stringify(
        names.map((n) => s.services.find((service) => service.name === n) ?? null),
      );
    // As the inputs key reads the scope: its mode and hosts.
    const network = (s: CheckSuite) =>
      JSON.stringify({ mode: s.networkScope.mode, hosts: [...s.networkScope.hosts].sort() });
    const others = (await store.listSuitesForCommit(suite.connectedRepoId, suite.commit))
      .filter((s) =>
        s.id !== suite.id && s.checksBlob === suite.checksBlob &&
        s.environmentKey === suite.environmentKey && network(s) === network(suite)
      );
    // A re-run of one check answers for this suite's own failures: a sibling's pass would turn
    // one green that nobody pressed, without running it.
    const sources = except !== undefined && previous !== undefined
      ? [previous]
      : previous === undefined
      ? others
      : [previous, ...others];
    const reused = new Map<string, CheckResult>();
    let ryphChanged: boolean | null = null;
    for (const source of sources) {
      if (source.remote != null) continue;
      const passed = (await store.listResults(source.id, source.generation))
        .filter((r) => r.state === "passed");
      let took = false;
      for (const result of passed) {
        const check = suite.definition.checks.find((c) => c.name === result.name);
        if (check === undefined || check.name === except || reused.has(check.name)) continue;
        if (servicesFor(source, check.services) !== servicesFor(suite, check.services)) continue;
        reused.set(check.name, {
          ...result,
          suiteId: suite.id,
          generation: suite.generation,
          forgeRef: null,
          // The suite that ran it, through any that took it before.
          inheritedFrom: result.inheritedFrom ?? source.id,
        });
        took = true;
      }
      if (took && source.checksCommit === suite.checksCommit) ryphChanged ??= source.ryphChanged;
    }
    if (reused.size === 0) return suite;
    await store.upsertResults([...reused.values()]);
    diag.debug("checks.passes_reused", { suiteId: suite.id, checks: [...reused.keys()] });
    if (reused.size < suite.definition.checks.length) {
      if (ryphChanged === null || suite.ryphChanged !== null) return suite;
      await store.setSuiteRyphChanged(suite.id, ryphChanged);
      // The caller's next transition writes the whole row from what this returns.
      return { ...suite, ryphChanged };
    }
    return await transition(suite, {
      state: "passed",
      reason: null,
      waitingSince: null,
      finishedAt: nowIso(),
      ryphChanged: suite.ryphChanged ?? ryphChanged,
    }) ?? await store.getSuite(suite.id) ?? suite;
  };

  /** Its services could not be resolved at the base: an answer its identity carries, so joining
   * it again answers the same, and only a changed base or policy is a different suite. */
  const servicesRefused = (suite: CheckSuite) =>
    namedServices(suite.definition).some((n) => !suite.services.some((s) => s.name === n));

  /** Whether an ask of a failed suite retries its failures: an agent's, or a person's own, or a
   * delegated one whose sender's ask was one of those (`retryFailed`, absent read as no). A
   * patch's or a push's ask only wants the answer. */
  const retriesFailures = (request: CheckRequest): boolean =>
    request.kind === "tool" ||
    (request.kind === "local" && request.source.runId === null &&
      (request.source.delegationId === undefined || request.source.retryFailed === true));

  /** Whether a settled suite is no answer to a new ask, which runs it again: one cancelled, or
   * one the platform could not run, is no answer about the commit, and a failed one is none to
   * an ask that retries failures. */
  const asksAgain = (suite: CheckSuite, retry: boolean): boolean =>
    suite.state === "cancelled" || suite.state === "error" || (retry && suite.state === "failed");

  /**
   * A new generation of a settled suite: its checks queued again, or waiting again on its base's
   * environment when it never got an image — for a re-run, or for a join of one that is no
   * answer to the ask (`asksAgain`), a failed one's retry among them. `source`: whose bundle the
   * pod clones now. `reuse`: takes the passes the commit has, so only what has none runs.
   */
  const restart = async (
    suite: CheckSuite,
    source: CheckSource = suite.source,
    opts: { reuse?: boolean; except?: string } = {},
  ): Promise<CheckSuite | null> => {
    // Remote re-runs are new delegated requests, never a local generation or pod.
    if (suite.remote != null) return suite;
    const byTree = suite.environmentKey.startsWith("tree:");
    const waiting = suite.image === null && byTree;
    const next = await transition(suite, {
      generation: suite.generation + 1,
      state: waiting ? "waiting" : "queued",
      image: suite.image ?? (byTree ? null : config.agentImage),
      environmentId: waiting ? null : suite.environmentId,
      attempts: 0,
      reason: waiting ? "waiting for the base's environment" : null,
      leaseUntil: null,
      waitingSince: waiting ? nowIso() : null,
      nextAttemptAt: null,
      launchedAt: null,
      finishedAt: null,
      pods: null,
      source: podSource(source),
    });
    if (next === null) return null;
    await store.upsertResults(queuedResults(next));
    // A join takes the passes the commit has, the ones this suite's last generation recorded
    // before it was cancelled, broke or failed included, so a retry of a failed suite runs only
    // what still fails. A re-run takes none, or, of one check, all but that one (`reusePasses`).
    const current = opts.reuse === true ? await reusePasses(next, suite, opts.except) : next;
    if (waiting && current.state === "waiting") {
      await attachEnvironment(current).catch((err) =>
        diag.warn("checks.environment_failed", { suiteId: suite.id, err: errText(err) })
      );
    }
    diag.debug("checks.restarted", { suiteId: suite.id, generation: next.generation });
    return await store.getSuite(suite.id) ?? next;
  };

  /**
   * One request, read against the base and turned into a suite — claimed on its identity, or
   * joined. The checks file is read on every resolve, so a suite is keyed on what the base says
   * NOW; a read the forge could not answer is retried on a backoff, never read as "no checks".
   *
   * Every write of the request is a compare-and-set from `pending`: the call that made a tool
   * request and the tick's backstop may both resolve it, and a supersede may land between the
   * read and the write — one of them wins, and the others write nothing.
   */
  const resolve = async (
    request: CheckRequest,
    ctx: ResolveContext = ON_THE_TICK,
  ): Promise<Resolved> => {
    const forge = deps.forge!;
    if (request.note === REMOTE_WITHDRAWAL) {
      await cancelPendingRemote(request);
      return lostRace(request);
    }
    if (deps.remote != null && request.kind === "push") {
      await store.withdrawRequest(request.id);
      return lostRace(request);
    }
    if (deps.remote != null && (request.kind === "forge" || request.kind === "rerun")) {
      return await refuse(
        request,
        "re-run this suite on the checks deployment; remote re-runs are not supported here",
        ctx,
      );
    }
    // A run that ended wants nothing any more.
    if (request.kind === "tool" && request.runId !== null) {
      const run = await tasks.getRun(request.runId);
      if (run === null || isTerminal(run)) {
        if (deps.remote != null || request.remote != null) {
          await withdraw([request], "the run ended");
          return lostRace(request);
        }
        const next: CheckRequest = { ...request, state: "superseded", nextAttemptAt: null };
        return await moveRequest(next)
          ? { request: next, suite: null, reused: false }
          : lostRace(request);
      }
    }
    const repo = await repoOf(request.connectedRepoId);
    if (repo === null) return await refuse(request, "its repo is no longer connected", ctx);
    if (deps.remote != null || request.remote != null) {
      return await resolveRemote(request, repo, ctx);
    }
    const ref = request.checksRef;
    const file = await forge.readChecksFile(forgeRepoRef(repo), repo.url, ref);
    const now = deps.now();
    if (file.kind === "unavailable") {
      if (now.getTime() - Date.parse(request.createdAt) >= READ_GIVE_UP_MS) {
        return await refuse(
          request,
          `.ryph/checks.yml at ${ref} could not be read for a day (${file.detail})`,
          ctx,
        );
      }
      const attempts = request.attempts + 1;
      const next: CheckRequest = {
        ...request,
        attempts,
        note: `.ryph/checks.yml at ${ref} could not be read (${file.detail})`,
        nextAttemptAt: new Date(
          now.getTime() + backoff(attempts, READ_RETRY_MS, READ_RETRY_MAX_MS),
        ).toISOString(),
      };
      if (!await moveRequest(next)) return lostRace(request);
      diag.warn("checks.file_unavailable", { requestId: request.id, ref, detail: file.detail });
      return { request: next, suite: null, reused: false };
    }
    if (file.kind === "absent") {
      return await refuse(
        request,
        `${runFacingRepoName(repo)} declares no checks (no .ryph/checks.yml on ${ref})`,
        ctx,
      );
    }
    if (file.kind === "invalid") {
      const at = file.commit === null ? ref : `${ref}@${short(file.commit)}`;
      return await refuse(request, `.ryph/checks.yml on ${at}: ${file.detail}`, ctx);
    }
    let parsed: ChecksDeclaration;
    try {
      parsed = parseChecksYaml(file.text);
    } catch (err) {
      return await refuse(
        request,
        `${file.path} on ${ref}@${short(file.commit)} is not valid: ${errText(err)}`,
        ctx,
      );
    }
    if (parsed.checks.length === 0) {
      return await refuse(
        request,
        `${runFacingRepoName(repo)}'s ${file.path} on ${ref} declares no checks`,
        ctx,
      );
    }
    // Only the checks it named, when it named some. Naming every one is asking for all of
    // them: that suite is the full one, and a patch on the head reuses it.
    const asked = [...new Set(request.source.checks ?? [])];
    const unknown = asked.filter((name) => !parsed.checks.some((c) => c.name === name));
    if (unknown.length > 0) {
      return await refuse(
        request,
        `${unknown.join(", ")} ${unknown.length === 1 ? "is not a check" : "are not checks"} ` +
          `in ${file.path} on ${ref}. Its checks: ${parsed.checks.map((c) => c.name).join(", ")}`,
        ctx,
      );
    }
    const only = asked.length === 0 || asked.length === parsed.checks.length
      ? null
      : parsed.checks.filter((c) => asked.includes(c.name)).map((c) => c.name);
    // Frozen with the policy's numbers: a declared timeout is capped, an absent one defaulted.
    const definition: ChecksDeclaration = {
      setup: parsed.setup,
      checks: parsed.checks.filter((c) => only === null || only.includes(c.name)).map((c) => ({
        ...c,
        timeoutSeconds: Math.min(
          c.timeoutSeconds ?? policy.defaultTimeoutSeconds,
          policy.maxTimeoutSeconds,
        ),
      })),
      ...(parsed.keep === undefined ? {} : { keep: parsed.keep }),
      ...(only === null ? {} : { partial: true as const }),
    };

    // The base's services, at the same commit, for the ones the checks name.
    let services: ServiceSpec[] = [];
    let refusedServices: string | null = null;
    const named = namedServices(definition);
    if (named.length > 0) {
      const outcome = await resolveNamedServices(named, file.services);
      if (outcome.kind === "refused") refusedServices = outcome.error;
      else services = outcome.services;
    }

    // The image, or the build to wait for: decided now, before the identity, and never again.
    const choice = await chooseEnvironment(repo, ref, file);
    const byTree = choice.image === null;
    const environmentKey = choice.key;
    // Where the pod may reach is the REQUESTING run's, never the deployment's ceiling: a check
    // pod runs the head's code on behalf of the run that shipped it, and a run whose agent may
    // reach nothing must not get a pod that reaches everything. A head no run shipped gets what
    // an agent with no policy gets.
    const networkScope = await networkScopeOf(request.source);
    const identity = {
      connectedRepoId: repo.id,
      commit: request.commit,
      checksBlob: file.blob,
      environmentKey,
      // The services' refusal is part of it too: fixing services.yml, or the policy that
      // refused it, makes the next ask a new suite rather than a join of the refusal.
      inputsKey: await inputsKeyOf(networkScope, refusedServices ?? services, only),
    };
    let suite = await store.findSuiteByIdentity(identity);
    let created = false;
    if (suite === null) {
      const at = nowIso();
      const state: CheckSuiteState = refusedServices !== null
        ? "error"
        : byTree
        ? "waiting"
        : "queued";
      const claimed = await store.claimSuite({
        id: mintId("cs"),
        ...identity,
        checksRef: ref,
        checksCommit: file.commit,
        checksPath: file.path,
        definition,
        networkScope,
        environmentId: choice.environmentId,
        image: choice.image,
        services,
        source: podSource(request.source),
        state,
        generation: 1,
        reason: refusedServices ?? (byTree ? "waiting for the base's environment" : null),
        attempts: 0,
        ryphChanged: null,
        leaseUntil: null,
        pods: null,
        version: 0,
        waitingSince: state === "waiting" ? at : null,
        nextAttemptAt: null,
        launchedAt: null,
        finishedAt: state === "error" ? at : null,
        createdAt: at,
        updatedAt: at,
      });
      suite = claimed.suite;
      created = claimed.created;
      if (created) {
        await store.upsertResults(queuedResults(suite, state === "error" ? "error" : "queued"));
        diag.debug("checks.suite_claimed", {
          suiteId: suite.id,
          commit: suite.commit,
          state: suite.state,
          environmentKey,
        });
        // A re-run that landed on a new suite runs every check, as any re-run does.
        if (state !== "error" && request.kind !== "rerun" && request.kind !== "forge") {
          suite = await reusePasses(suite);
        }
      }
    }
    const next: CheckRequest = {
      ...request,
      suiteId: suite.id,
      state: "active",
      note: null,
      nextAttemptAt: null,
    };
    if (!await moveRequest(next)) {
      // Someone moved the request first. A suite claimed for it alone would run for nobody.
      if (created) await cancelUnwanted(suite.id, "the request that asked for it moved on");
      return lostRace(request);
    }
    if (created && suite.state === "waiting") {
      await attachEnvironment(suite).catch((err) =>
        diag.warn("checks.environment_failed", { suiteId: suite!.id, err: errText(err) })
      );
      suite = await store.getSuite(suite.id) ?? suite;
    }
    // A cancelled suite, or one the platform could not run, is no answer to a new ask: it runs
    // again, from the asker's own bundle — the one that failed may be why it could not. A
    // services refusal is in the identity, so the one joined is the base's answer still. An ask
    // that retries a failed suite takes the passes the commit has since — a check run alone and
    // passed included — and runs only what is still failing, so a flaky check passed by itself
    // turns the whole suite green.
    let restarted = false;
    if (
      !created && asksAgain(suite, retriesFailures(request)) &&
      !(suite.state === "error" && servicesRefused(suite))
    ) {
      suite = await restart(suite, request.source, {
        // A re-run runs every check, whichever suite it lands on.
        reuse: request.kind !== "rerun" && request.kind !== "forge",
      }) ?? await store.getSuite(suite.id) ?? suite;
      restarted = true;
    }
    // A re-run that read the base again and landed elsewhere — now, or on a later tick after a
    // read that failed: whoever asked for the old suite asks for this one.
    if (request.rerunOf !== null && request.rerunOf !== suite.id) {
      await follow(request.rerunOf, suite);
    }
    await touchReports(suite);
    // A suite run again is not one the commit already had: it runs.
    return { request: next, suite, reused: !created && !restarted };
  };

  const remoteClient = (remote: import("../ports/remote_checks.ts").RemoteCheckReference) => {
    if (deps.remote == null || deps.remote.endpoint !== remote.endpoint) {
      throw new Error("the checks delegation's remote endpoint is no longer configured");
    }
    return deps.remote;
  };

  const mirrorRemote = async (
    request: CheckRequest,
    snapshot: import("../ports/remote_checks.ts").RemoteCheckSnapshot,
    existing: CheckSuite | null = null,
  ): Promise<CheckSuite | null> => {
    const upstream = snapshot.suite;
    if (upstream === null) return null;
    if (upstream.commit !== request.commit || upstream.checksRef !== request.checksRef) {
      throw new Error("remote checks answered for a different commit or base");
    }
    if (upstream.remote != null) throw new Error("remote checks cannot delegate again");
    const asked = request.source.checks ?? [];
    if (asked.length === 0 && isPartial(upstream)) {
      throw new Error("remote checks returned a partial suite for a full request");
    }
    if (
      asked.length > 0 && (upstream.definition.checks.some((c) => !asked.includes(c.name)) ||
        asked.some((name) => !upstream.definition.checks.some((c) => c.name === name)))
    ) {
      throw new Error("remote checks returned a different check selection");
    }
    if (
      snapshot.results.some((r) =>
        r.suiteId !== upstream.id || r.generation !== upstream.generation
      )
    ) {
      throw new Error("remote checks returned results for a different suite generation");
    }
    if (
      upstream.state === "passed" &&
      upstream.definition.checks.some((c) =>
        !snapshot.results.some((r) => r.name === c.name && r.state === "passed")
      )
    ) throw new Error("remote checks returned an incomplete passing verdict");
    const remote = {
      endpoint: deps.remote!.endpoint,
      requestId: snapshot.requestId,
      suiteId: upstream.id,
    };
    const identity = {
      connectedRepoId: request.connectedRepoId,
      commit: request.commit,
      checksBlob: upstream.checksBlob,
      environmentKey: upstream.environmentKey,
      // One local waiter per delegation, even when B shares execution with another request.
      inputsKey: `remote:${remote.endpoint}:${request.id}:${upstream.id}`,
    };
    const before = existing ?? await store.findSuiteByIdentity(identity);
    if (before !== null && before.generation > upstream.generation) return before;
    const next: CheckSuite = {
      ...upstream,
      ...identity,
      id: before?.id ?? mintId("cs"),
      remote,
      source: podSource(request.source),
      environmentId: null,
      leaseUntil: null,
      pods: null,
      version: before?.version ?? 0,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: before?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    // Results first when updating: a terminal suite must never be visible without its results.
    if (before !== null) {
      await store.upsertResults(snapshot.results.map((r) => ({
        ...r,
        suiteId: next.id,
        logKey: null,
        forgeRef: null,
      })));
      return await transition(before, next) ?? await store.getSuite(before.id);
    }
    // A terminal claim must not be observable before its results have landed.
    const claimed = await store.claimSuite({ ...next, state: "queued", finishedAt: null });
    await store.upsertResults(snapshot.results.map((r) => ({
      ...r,
      suiteId: claimed.suite.id,
      logKey: null,
      forgeRef: null,
    })));
    return await transition(claimed.suite, { ...next, id: claimed.suite.id }) ??
      await store.getSuite(claimed.suite.id);
  };

  const resolveRemote = async (
    request: CheckRequest,
    repo: ConnectedRepo,
    ctx: ResolveContext,
  ): Promise<Resolved> => {
    if (repo.provider === "local") {
      return await refuse(
        request,
        "This ryph instance is configured to run checks on a remote Ryph instance, which " +
          "cannot access a local repository on this instance's machine. No checks were run, " +
          "and this request will not be retried. Tell the user that checks need to be run " +
          "locally, or the repository must be hosted on a forge and connected to the remote instance",
        ctx,
      );
    }
    try {
      const client = request.remote == null ? deps.remote! : remoteClient(request.remote);
      const snapshot = request.remote == null
        ? await client.submit({ request, repo })
        : await client.read(request.remote);
      if (snapshot.refused) {
        return await refuse(request, snapshot.note ?? "remote checks refused the request", ctx);
      }
      const suite = await mirrorRemote(request, snapshot);
      const next: CheckRequest = {
        ...request,
        remote: {
          endpoint: client.endpoint,
          requestId: snapshot.requestId,
          suiteId: snapshot.suite?.id ?? null,
        },
        suiteId: suite?.id ?? null,
        state: suite === null ? "pending" : "active",
        note: snapshot.note ?? null,
        nextAttemptAt: suite === null
          ? new Date(deps.now().getTime() + READ_RETRY_MS).toISOString()
          : null,
      };
      if (!await moveRequest(next)) return lostRace(request);
      if (suite !== null && request.rerunOf !== null && request.rerunOf !== suite.id) {
        await follow(request.rerunOf, suite);
      }
      return { request: next, suite, reused: false };
    } catch (err) {
      if (err instanceof RemoteChecksError && [403, 404, 409].includes(err.status)) {
        const reason = err.status === 403
          ? "denied access to this check request. Ask the user to have its operator check the remote checks token's permissions and repository access"
          : err.status === 404
          ? request.remote == null
            ? "reported that the repository or checks endpoint is unavailable. It may not have this repository connected, or checks may be disabled there. Ask the user to have its operator verify that checks are enabled and the repository is connected and accessible"
            : "could not find or access the previously accepted check request. Ask the user to have its operator check whether the request or repository was removed, and verify the remote checks token's identity and access"
          : "cannot accept this request in its current configuration. The repository may be disconnected, checks may be disabled, or that instance may itself delegate checks elsewhere (delegation chains are not supported). Ask the user to have its operator check the remote configuration";
        return await refuse(
          request,
          `This ryph instance is configured to run checks on a remote Ryph instance, which ${reason} ` +
            `(HTTP ${err.status}). No check results are available from this request, and it will ` +
            "not be retried automatically or block this run from finishing. Explain this " +
            "verification limitation to the user; request checks again after the configuration is corrected",
          ctx,
        );
      }
      if (deps.now().getTime() - Date.parse(request.createdAt) >= READ_GIVE_UP_MS) {
        await ensureRemoteCleanup(request);
        return await refuse(request, "remote checks remained unavailable for a day", ctx);
      }
      const attempts = request.attempts + 1;
      const next: CheckRequest = {
        ...request,
        attempts,
        note: remoteChecksNote(err instanceof RemoteChecksError ? err.status : 0),
        nextAttemptAt: new Date(
          deps.now().getTime() + backoff(attempts, READ_RETRY_MS, READ_RETRY_MAX_MS),
        ).toISOString(),
      };
      diag.warn("checks.remote_resolve_failed", { requestId: request.id, err: errText(err) });
      return await moveRequest(next)
        ? { request: next, suite: null, reused: false }
        : lostRace(request);
    }
  };

  const failRemote = async (
    suite: CheckSuite,
    request: CheckRequest,
    reason: string,
  ): Promise<void> => {
    await ensureRemoteCleanup(request);
    await store.upsertResults(await keptOrError(suite));
    // Per-check passes cannot prove B's terminal suite verdict. Never use errorSuite's local
    // early-settle verdict synthesis for a remote observation or protocol failure.
    await transition(suite, { state: "error", reason, finishedAt: nowIso(), leaseUntil: null });
  };

  /** One cleanup per receiver waiter, independent of mirror state and the original asker's
   * inbox. Its deterministic id makes racing poll/withdraw/failure paths converge. */
  const ensureRemoteCleanup = async (request: CheckRequest): Promise<void> => {
    const remote = request.remote;
    const submissionId = request.source.remoteCleanupSubmissionId ?? request.id;
    const identity = remote == null
      ? ["remote-cleanup-submission", deps.remote?.endpoint, submissionId]
      : ["remote-cleanup", remote.endpoint, remote.requestId];
    const id = `cq-${(await sha256Hex(JSON.stringify(identity))).slice(0, 26)}`;
    if (await store.getRequest(id) !== null) return;
    const cleanup: CheckRequest = {
      ...request,
      source: { ...request.source, remoteCleanupSubmissionId: submissionId },
      id,
      suiteId: null,
      rerunOf: null,
      kind: "rerun",
      state: "pending",
      runId: null,
      patchId: null,
      userId: null,
      changeRequest: null,
      note: REMOTE_WITHDRAWAL,
      reportedGeneration: null,
      attempts: 0,
      nextAttemptAt: nowIso(),
      createdAt: nowIso(),
      expiresAt: null,
    };
    try {
      await store.createRequest(cleanup);
    } catch (err) {
      // Another replica may have inserted the same cleanup after our read. Only that conflict
      // is success: an unrelated storage failure must prevent the original withdrawal.
      if (await store.getRequest(id) === null) throw err;
    }
  };

  const refreshRemote = async (suite: CheckSuite): Promise<void> => {
    if (suite.nextAttemptAt !== null && suite.nextAttemptAt > nowIso()) return;
    const remote = suite.remote!;
    const request = (await store.listRequestsForSuite(suite.id)).find((r) =>
      r.state === "active" && r.remote?.requestId === remote.requestId
    );
    if (request === undefined) return;
    try {
      const snapshot = await remoteClient(remote).read(remote);
      if ((await store.getRequest(request.id))?.state !== "active") return;
      if (snapshot.refused) {
        await failRemote(
          suite,
          request,
          snapshot.note ?? "the checks deployment refused the delegation",
        );
        return;
      }
      if (snapshot.suite?.id !== remote.suiteId) {
        throw new Error("remote delegation changed suite identity");
      }
      await mirrorRemote(request, snapshot, suite);
    } catch (err) {
      // updatedAt is the last successful observation. Failed polls never reset the horizon.
      if (deps.now().getTime() - Date.parse(suite.updatedAt) >= READ_GIVE_UP_MS) {
        await failRemote(
          suite,
          request,
          "remote checks remained unavailable for a day; no local fallback",
        );
        return;
      }
      // Preserve updatedAt: it measures the last successful remote observation, not retries.
      await store.saveSuiteIf({
        ...suite,
        attempts: suite.attempts + 1,
        nextAttemptAt: new Date(
          deps.now().getTime() + backoff(suite.attempts + 1, READ_RETRY_MS, READ_RETRY_MAX_MS),
        ).toISOString(),
      }, { states: [suite.state], generation: suite.generation, leaseUntil: suite.leaseUntil });
      throw err;
    }
  };

  /** The named services of the base's `services.yml`, resolved as a run's are. */
  const resolveNamedServices = async (
    named: string[],
    file: Extract<Awaited<ReturnType<ForgeChecks["readChecksFile"]>>, { kind: "file" }>["services"],
  ): Promise<{ kind: "ok"; services: ServiceSpec[] } | { kind: "refused"; error: string }> => {
    const list = named.join(", ");
    if (file.kind === "absent") {
      return {
        kind: "refused",
        error: `the checks name services (${list}) but the base has no .ryph/services.yml`,
      };
    }
    if (file.kind === "invalid") {
      return { kind: "refused", error: `the base's .ryph/services.yml: ${file.detail}` };
    }
    let declarations;
    try {
      declarations = parseServicesYaml(file.text);
    } catch (err) {
      return { kind: "refused", error: `the base's .ryph/services.yml: ${errText(err)}` };
    }
    const missing = named.filter((n) => !declarations.some((d) => d.name === n));
    if (missing.length > 0) {
      return {
        kind: "refused",
        error: `the base's .ryph/services.yml declares no ${
          missing.map((m) => `"${m}"`).join(", ")
        }`,
      };
    }
    const catalogue = (await deps.serviceCatalogue?.list()) ?? [];
    const resolved = resolveServices(
      declarations.filter((d) => named.includes(d.name)),
      catalogue,
      config.services,
      {
        RYPH_GIT_ORIGIN: config.gitGateway?.url ?? null,
        HTTPS_PROXY: config.egress.policy.proxyUrl,
      },
    );
    if (resolved.kind === "refused") {
      return { kind: "refused", error: `.ryph/services.yml: ${resolved.error}` };
    }
    return resolved;
  };

  /** Whether a request not yet read could resolve to this suite: the same checks asked for.
   * Asking for none, or for every one by name, is the full suite. */
  const asksFor = (request: CheckRequest, suite: CheckSuite): boolean => {
    const asked = new Set(request.source.checks ?? []);
    const names = suite.definition.checks.map((c) => c.name);
    if (asked.size === 0) return !isPartial(suite);
    return asked.size === names.length && names.every((n) => asked.has(n));
  };

  /**
   * Cancels a suite nobody wants any more — the tool's supersede, a superseded patch, a run that
   * ended. Only a suite whose every other asker has gone: a patch's ask, another run's, a re-run
   * keeps it running — and so does a request for the same head and the same checks not yet read
   * at its base, which may well resolve to this very suite. Written first, then the pod
   * discarded, so a settle racing it loses its compare-and-set.
   */
  const cancelUnwanted = async (suiteId: string, why: string): Promise<void> => {
    const suite = await store.getSuite(suiteId);
    if (suite === null || TERMINAL_SUITE_STATES.has(suite.state)) return;
    // Someone holds it: a launch in flight would create its pod after the discard below, and a
    // settle in flight has real verdicts to write. The release sweep looks at it again once the
    // lease is let go (`releaseAbandoned`).
    if (suite.leaseUntil !== null && suite.leaseUntil > nowIso()) return;
    // Pending first: a request resolved between the two reads is pending in the first or active
    // in the second, never neither.
    const pending = (await store.listRequestsForCommit(suite.connectedRepoId, suite.commit))
      .filter((r) => r.state === "pending" && r.note !== REMOTE_WITHDRAWAL && asksFor(r, suite));
    if (pending.length > 0) return;
    const askers = (await store.listRequestsForSuite(suiteId)).filter((r) => r.state === "active");
    if (askers.length > 0) return;
    // Cancel B's waiter first, so a failed call is retried by releaseAbandoned.
    if (suite.remote != null) await remoteClient(suite.remote).cancel(suite.remote);
    const at = nowIso();
    const cancelled = await transition(suite, {
      state: "cancelled",
      reason: why,
      finishedAt: at,
      leaseUntil: null,
    });
    if (cancelled === null) return;
    const results = await store.listResults(suite.id, suite.generation);
    await store.upsertResults(
      results.filter((r) => r.state === "queued" || r.state === "running")
        .map((r) => ({ ...r, state: "cancelled" as const, finishedAt: at })),
    );
    await store.revokeCheckGitKeys(suite.id, suite.generation, at);
    if (suite.remote == null && suite.state === "running") await discardPods(suite);
    diag.debug("checks.suite_cancelled", { suiteId, why });
  };

  /** A pending request may have reached B even when its response did not reach A. Resolve its
   * idempotency key before cancelling. The reserved note keeps cleanup on the pending queue
   * across crashes and transient transport failures, without a second execution ever starting. */
  const cancelPendingRemote = async (request: CheckRequest): Promise<boolean> => {
    const pending = {
      ...request,
      note: REMOTE_WITHDRAWAL,
      attempts: request.attempts + 1,
      nextAttemptAt: new Date(
        deps.now().getTime() + backoff(request.attempts + 1, READ_RETRY_MS, READ_RETRY_MAX_MS),
      ).toISOString(),
    };
    if (!await store.saveRequestIf(pending, ["pending"], { note: request.note })) return false;
    let remote = pending.remote;
    if (remote == null) {
      if (deps.remote == null) {
        throw new Error("the remote checks endpoint is no longer configured");
      }
      const repo = await repoOf(request.connectedRepoId);
      if (repo === null) throw new Error("the delegated repository is no longer connected");
      const submission = request.source.remoteCleanupSubmissionId === undefined ? request : {
        ...request,
        id: request.source.remoteCleanupSubmissionId,
      };
      const snapshot = await deps.remote.submit({ request: submission, repo });
      remote = {
        endpoint: deps.remote.endpoint,
        requestId: snapshot.requestId,
        suiteId: snapshot.suite?.id ?? null,
      };
      if (
        !await store.saveRequestIf({ ...pending, remote }, ["pending"], { note: REMOTE_WITHDRAWAL })
      ) return false;
    }
    await remoteClient(remote).cancel(remote);
    await store.withdrawRequest(request.id);
    return true;
  };

  /** Marks requests nobody stands behind any more, then cancels what they alone kept going. */
  const withdraw = async (requests: CheckRequest[], why: string): Promise<void> => {
    const suites = new Set<string>();
    for (const request of requests) {
      let current = await store.getRequest(request.id);
      while (
        current?.state === "pending" && current.suiteId === null &&
        (current.remote != null || deps.remote != null)
      ) {
        if (await cancelPendingRemote(current)) {
          current = null;
          break;
        }
        // Resolution won before our marker CAS. Re-read: if now active, persist independent
        // cleanup before withdrawing it; if still pending, fence its new note instead.
        current = await store.getRequest(request.id);
      }
      if (current === null) continue;
      if (current.remote != null) await ensureRemoteCleanup(current);
      // The suite the STORED row names: one read as pending may have resolved since.
      const stored = await store.withdrawRequest(request.id);
      if (stored !== null && stored.suiteId !== null) suites.add(stored.suiteId);
    }
    for (const suiteId of suites) await cancelUnwanted(suiteId, why);
  };

  /**
   * A new tool request replaces the run's earlier ones for that repo's LINE (@ryph/shared/lines) —
   * the same line's branch, whatever its generation: one suite in flight per line. Another
   * line's ask is another stream of work, and stands. Those still going are withdrawn, and their
   * suites cancelled unless someone else wants them. Those already settled are marked superseded
   * and left as they are: a re-run of that suite later must not tell this run about a commit it
   * moved on from. Their verdicts stay on the run's record (`viewOf`'s `requestedBy`,
   * `statusForRun`). A run that no longer resolves reads every ask as one line: the whole repo.
   */
  const supersedeEarlier = async (request: CheckRequest): Promise<void> => {
    const run = await tasks.getRun(request.runId!);
    const lineOf = (r: CheckRequest): string | null =>
      run === null ? null : parseLineBranch(r.source.branchName, run.branchNamespace)?.line ?? null;
    const line = lineOf(request);
    const earlier: CheckRequest[] = [];
    for (const r of await store.listRequestsForRun(request.runId!)) {
      if (
        r.id === request.id || r.kind !== "tool" || r.connectedRepoId !== request.connectedRepoId ||
        lineOf(r) !== line || (r.state !== "active" && r.state !== "pending") ||
        (r.suiteId !== null && r.suiteId === request.suiteId)
      ) continue;
      const suite = r.suiteId === null ? null : await store.getSuite(r.suiteId);
      if (suite !== null && TERMINAL_SUITE_STATES.has(suite.state)) {
        await store.withdrawRequest(r.id);
        continue;
      }
      earlier.push(r);
    }
    await withdraw(earlier, "a newer ryph__run_checks call replaced it");
  };

  /**
   * Whether a request's asker is gone: a tool request's run that ended, a patch's request once
   * the patch was superseded or rejected. A push request never is, by itself: only its change
   * request's next push or its close ends it (`changeRequestPushed`, `changeRequestEnded`). A
   * re-run's ask stands until its suite settles.
   */
  const abandoned = async (request: CheckRequest): Promise<boolean> => {
    if (request.kind === "tool" && request.runId !== null) {
      const run = await tasks.getRun(request.runId);
      return run === null || isTerminal(run);
    }
    if (request.kind === "patch" && request.patchId !== null) {
      const patch = await tasks.getPatch(request.patchId);
      return patch === null || patch.state === "superseded" || patch.state === "rejected";
    }
    return false;
  };

  /** A change request's push requests still standing: pending or active. */
  const livePushes = async (connectedRepoId: string, ref: string): Promise<CheckRequest[]> =>
    (await store.listPushRequests(connectedRepoId, ref))
      .filter((r) => r.state === "pending" || r.state === "active");

  /**
   * Which of a change request's live push requests stands, when deliveries handled side by side
   * filed more than one: the head of the newest-filed one, and of that head and base the
   * earliest-filed request. Every call that looks reaches the same answer, so the others are
   * withdrawn once whichever way the calls interleave.
   */
  const keptPush = (live: CheckRequest[]): CheckRequest | undefined => {
    const order = (a: CheckRequest, b: CheckRequest) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    const newest = [...live].sort(order).at(-1);
    if (newest === undefined) return undefined;
    return live.filter((r) => r.commit === newest.commit && r.checksRef === newest.checksRef)
      .sort(order)[0];
  };

  /** Far enough ahead that every pending request is due by it: the sweep's "all of them". */
  const EVERY_PENDING = "9999-12-31T23:59:59.999Z";

  /**
   * The release sweep: every live suite's askers, held to whether they still want it — withdrawn
   * when they do not, and a suite nobody else asked for is cancelled rather than run for nobody.
   * And every request still being read, whose asker went before it named a suite: withdrawn, so
   * it is neither read at the base for nobody nor counted as a pending ask of its head.
   */
  const releaseAbandoned = async (): Promise<void> => {
    for (const suite of await store.listSuitesByState(["waiting", "queued", "running"], 10_000)) {
      const gone: CheckRequest[] = [];
      const asked = await store.listRequestsForSuite(suite.id);
      const active = asked.filter((r) => r.state === "active");
      if (
        active.length === 0 && (suite.remote != null || asked.some((r) => r.state === "superseded"))
      ) {
        // Its askers went before, and the cancel then passed it by: a launch or a settle held
        // it, or a launch claimed it first. Looked at again every sweep until it ends.
        await cancelUnwanted(suite.id, "nothing that asked for it still wants it").catch((err) =>
          diag.warn("checks.release_failed", { suiteId: suite.id, err: errText(err) })
        );
        continue;
      }
      for (const request of active) if (await abandoned(request)) gone.push(request);
      if (gone.length > 0) {
        await withdraw(gone, "nothing that asked for it still wants it").catch((err) =>
          diag.warn("checks.release_failed", { suiteId: suite.id, err: errText(err) })
        );
      }
    }
    const pending: CheckRequest[] = [];
    for (const request of await store.listPendingRequests(EVERY_PENDING, 10_000)) {
      if (await abandoned(request)) pending.push(request);
    }
    if (pending.length > 0) {
      await withdraw(pending, "nothing that asked for it still wants it").catch((err) =>
        diag.warn("checks.release_failed", { err: errText(err) })
      );
    }
    // A person's ask from their machine stands for a day from its last asking, whatever its suite
    // did meanwhile: a settled suite keeps its verdict, one still going is cancelled unless
    // someone else wants it.
    // Each withdrawn only if its end is still past when the write lands: a re-ask that renewed
    // it after the list was read keeps it, and the person was told it stands.
    try {
      const now = nowIso();
      const suites = new Set<string>();
      for (const request of await store.listExpiredLocalRequests(now, 10_000)) {
        const stored = await store.withdrawExpired(request.id, now);
        if (stored !== null && stored.suiteId !== null) suites.add(stored.suiteId);
      }
      for (const suiteId of suites) {
        await cancelUnwanted(suiteId, "the local ask that wanted it ran out after a day");
      }
    } catch (err) {
      diag.warn("checks.release_failed", { err: errText(err) });
    }
    // Upload attempts older than the hourly cap's window are no use to anyone: a day's kept.
    await store.pruneLocalUploads(
      new Date(deps.now().getTime() - LOCAL_REQUEST_TTL_MS).toISOString(),
    ).catch((err) => diag.warn("checks.release_failed", { err: errText(err) }));
  };

  /** The base a local ask's checks are read at: the branch it names, else the default, by the
   * rules every other ask follows. */
  const localJudge = (repo: ConnectedRepo, base: string | undefined): string =>
    checksRef(repo, { url: repo.url, ref: base ?? repo.defaultBranch });

  /** Whether two asks name the same checks: none and every one by name are not the same here,
   * as they are not on a request's source. */
  const sameChecks = (a: string[] | undefined, b: string[] | undefined): boolean => {
    const x = new Set(a ?? []);
    const y = new Set(b ?? []);
    return x.size === y.size && [...x].every((n) => y.has(n));
  };

  /** A person's live local asks outside one branch that still cost something: being read at
   * the base, or on a suite that has not settled. One whose suite settled waits out its day for
   * nothing, so it is not counted. */
  const localInFlight = async (
    live: CheckRequest[],
    connectedRepoId: string,
    branch: string,
    delegationId?: string,
  ): Promise<number> => {
    let n = 0;
    for (const r of live) {
      if (
        r.connectedRepoId === connectedRepoId && r.source.branchName === branch &&
        (r.source.runId === null ? r.source.delegationId : undefined) === delegationId
      ) continue;
      if (r.state === "pending" || r.suiteId === null) {
        n++;
        continue;
      }
      const suite = await store.getSuite(r.suiteId);
      if (suite !== null && !TERMINAL_SUITE_STATES.has(suite.state)) n++;
    }
    return n;
  };

  /**
   * A re-run that read the base again and landed on another suite of the same head: whoever
   * asked for the old one — a run, a patch — now asks for the new one, is told its verdict when
   * it settles, and the forge rows that reported the old one report the new one.
   */
  const follow = async (fromId: string, to: Pick<CheckSuite, "id">): Promise<void> => {
    for (const request of await store.listRequestsForSuite(fromId)) {
      if (request.state !== "active" || request.kind === "rerun" || request.kind === "forge") {
        continue;
      }
      await store.saveRequestIf(
        { ...request, suiteId: to.id, reportedGeneration: null },
        ["active"],
      );
    }
    await store.repointForgeReports(fromId, to, nowIso());
    diag.debug("checks.followed", { from: fromId, to: to.id });
  };

  const newRequest = (fields: {
    kind: CheckRequest["kind"];
    repo: ConnectedRepo;
    commit: string;
    runId: string | null;
    patchId: string | null;
    source: CheckSource;
    checksRef: string;
    userId?: string;
  }): CheckRequest => {
    const at = nowIso();
    return {
      id: mintId("cq"),
      suiteId: null,
      rerunOf: null,
      connectedRepoId: fields.repo.id,
      commit: fields.commit,
      runId: fields.runId,
      patchId: fields.patchId,
      changeRequest: fields.kind === "push" && isForgeSource(fields.source)
        ? fields.source.changeRequest
        : null,
      userId: fields.kind === "local" ? fields.userId ?? null : null,
      expiresAt: fields.kind === "local"
        ? new Date(deps.now().getTime() + LOCAL_REQUEST_TTL_MS).toISOString()
        : null,
      kind: fields.kind,
      state: "pending",
      note: null,
      source: fields.source,
      checksRef: fields.checksRef,
      reportedGeneration: null,
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
    };
  };

  /**
   * A fresh request's resolve, waited for at most TOOL_ANSWER_MS: what the caller answers now.
   * Null when it is still being read — the tick finishes it, and its backstop clock (set by the
   * caller) keeps the tick off it meanwhile. A refusal already being written is waited for.
   */
  /** Resolves still going after `resolveWithin` answered without them (`idle`). */
  const outlived = new Set<Promise<Resolved>>();
  const resolveWithin = async (request: CheckRequest): Promise<Resolved | null> => {
    const ctx: ResolveContext = { answered: false };
    const resolving = resolve(request, ctx).catch((err): Resolved => {
      diag.warn("checks.resolve_failed", { requestId: request.id, err: errText(err) });
      return { request, suite: null, reused: false };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((done) => {
      timer = setTimeout(() => {
        // A refusal already being written is the answer: waited for, never "requested".
        if (ctx.refusing) return;
        ctx.answered = true;
        done(null);
      }, deps.answerWithinMs ?? TOOL_ANSWER_MS);
    });
    const first = await Promise.race([resolving, timedOut]);
    clearTimeout(timer);
    if (first === null) {
      outlived.add(resolving);
      void resolving.finally(() => outlived.delete(resolving));
    }
    return first;
  };

  // ---- the pod ---------------------------------------------------------------

  /**
   * The pod's way out: an egress claim minted like a run's, from the requesting run's scope —
   * held to the deployment's ceiling as it stands NOW, as a run's launch is, so an allowlist the
   * operator narrowed since binds the pod too. Empty where no boundary is claimed.
   */
  const proxyEnvFor = async (suite: CheckSuite, ttlMs: number): Promise<Record<string, string>> => {
    const { policy: egress, key, tokenTtlMs } = config.egress;
    if (egress.mode !== "proxy" || key === null || egress.proxyUrl === null) return {};
    const ceiling = await liveCeiling(tasks, egress);
    const asked = suite.networkScope.mode === "proxy"
      ? { bundles: suite.networkScope.bundles, hosts: suite.networkScope.hosts }
      : { bundles: [], hosts: [] };
    const scope = resolveNetworkScope(asked, ceiling);
    if (scope.kind === "refused") throw new ScopeRefused(scope.error);
    const token = await mintEgressToken(key, {
      runId: suite.id,
      expiresAt: Math.floor((deps.now().getTime() + Math.min(tokenTtlMs, ttlMs)) / 1000),
      hosts: scope.scope.hosts,
    });
    return proxyEnv(egress.proxyUrl, suite.id, token);
  };

  /** A pod's hard cap: the setup budget, its longest check's timeout, and the grace. The suite's
   * (`deadlineSecondsOf`) is its longest pod's. */
  const podDeadlineSeconds = (checks: readonly CheckDeclaration[]) =>
    SETUP_BUDGET_S + Math.max(0, ...checks.map((c) => c.timeoutSeconds ?? 0)) + DEADLINE_GRACE_S;
  const deadlineSecondsOf = (suite: CheckSuite) => podDeadlineSeconds(suite.definition.checks);

  /**
   * This repo's checkout in the suite's image, as the member path the environment build baked it
   * at: what lets every check start from a warm tree (ports/check_launcher.ts `bakedCheckout`).
   * Told to the pod rather than searched for in it: the row that built the image records each
   * checkout and whose repo it is. Null for the default image, a row no longer there, a row whose
   * image is not the suite's, or an environment this repo is not a member of: the pod then sets up
   * a cold tree of its own, which is slower and still right.
   */
  const bakedCheckoutOf = async (suite: CheckSuite): Promise<string | null> => {
    if (suite.environmentId === null || deps.environments === null) return null;
    const env = await deps.environments.store.getEnvironment(suite.environmentId);
    if (env === null || env.image === null || podImage(env) !== suite.image) return null;
    return env.plan.checkouts.find((c) => c.connectedRepoId === suite.connectedRepoId)?.path ??
      null;
  };

  /**
   * The size class a pod gets: a `pod: own` check's own `size` when it names one, else what the
   * shared pod gets — the policy's class, else the repo's, else the deployment's default. A `size`
   * is honoured only when the operator lets checks use it (`RYPH_CHECKS_OWN_SIZES`, every entry a
   * class this deployment defines); any other is the suite's error, never another class. The
   * reason reaches the forge's public check output, so it names no class the deployment has.
   */
  const podSize = (pod: CheckPod, repo: ConnectedRepo | null): RunSize => {
    const asked = pod.own ? pod.checks[0].size : undefined;
    if (asked === undefined) {
      return findRunSize(config.runSizes, policy.sizeClass ?? repo?.sizeClass ?? "") ??
        defaultRunSize(config.runSizes);
    }
    const size = policy.ownSizes.includes(asked) ? findRunSize(config.runSizes, asked) : null;
    if (size === null) {
      throw new SizeRefused(
        `checks.${pod.checks[0].name}.size: "${asked}" is not a size class checks may use on ` +
          "this deployment (its operator lists those in RYPH_CHECKS_OWN_SIZES)",
      );
    }
    return size;
  };

  /** The launcher's spec for one pod of a claimed suite: its frozen plan plus this launch's
   * credentials, a clone key of the pod's own. `minted` hears the id of the git key it made,
   * before anything after that can throw. The checks in `kept` already hold their verdict and are
   * left out of the pod. */
  const specFor = async (
    suite: CheckSuite,
    kept: ReadonlyMap<string, CheckResult>,
    pod: CheckPod,
    minted: (keyId: string) => void,
  ): Promise<CheckSpec> => {
    const repo = await repoOf(suite.connectedRepoId);
    if (repo === null) throw new Error("its repo is no longer connected");
    if (suite.image === null) throw new Error("it has no image to run in");
    const size = podSize(pod, repo);
    const gateway = config.gitGateway!.url;
    const deadlineSeconds = podDeadlineSeconds(pod.checks);
    const ttlMs = deadlineSeconds * 1000 + KEY_GRACE_MS;
    // The clone's key: the suite's own, resolving only to this one candidate commit and only
    // while this generation runs (http/forge_api.ts). The clone step alone is handed it.
    const token = mintToken();
    const at = nowIso();
    const keyId = mintId("ck");
    await store.createCheckGitKey({
      id: keyId,
      suiteId: suite.id,
      generation: suite.generation,
      tokenHash: await sha256Hex(token),
      expiresAt: new Date(deps.now().getTime() + ttlMs).toISOString(),
      revokedAt: null,
      createdAt: at,
    });
    minted(keyId);
    // A pod gets the services its own checks name; the one shared pod of a declaration without
    // `pod: own`, every service the suite resolved.
    const named = new Set(pod.checks.flatMap((c) => c.services));
    const own = suite.definition.checks.some((c) => c.pod === "own");
    return {
      suiteId: suite.id,
      generation: suite.generation,
      name: pod.name,
      image: suite.image,
      clone: {
        url: `${gateway}/v1/git/${suite.id}/${repo.id}/repo.git`,
        env: gatewayGitEnv(gateway, token),
        commit: suite.commit,
        baseCommit: suite.checksCommit,
      },
      bakedCheckout: await bakedCheckoutOf(suite),
      setup: suite.definition.setup,
      keep: keepOf(suite.definition),
      checks: pod.checks.filter((c) => !kept.has(c.name)).map((c) => ({
        name: c.name,
        run: c.run,
        timeoutSeconds: c.timeoutSeconds ?? policy.defaultTimeoutSeconds,
      })),
      services: own ? suite.services.filter((s) => named.has(s.name)) : suite.services,
      size,
      proxyEnv: await proxyEnvFor(suite, ttlMs),
      deadlineSeconds,
    };
  };

  /**
   * A suite whose image is gone from the machine, as the launcher found at launch (`why`): retention
   * removed it (a builder that removes its images), or something outside ryph did (a daemon
   * reset, `image prune -a`). A build still ready on it is retired (`imageMissing`), so nothing
   * resolves to it again. Keyed on its base's `.ryph/` tree, the suite waits for that environment
   * again, as a suite that never had an image does. Keyed on the image itself, that image is its
   * identity, so it ends and says so; a re-run of one reads the base again (`rerun`).
   */
  const imageLeftMachine = async (suite: CheckSuite, why: string): Promise<void> => {
    diag.warn("checks.image_gone", { suiteId: suite.id, image: suite.image, why });
    await imageMissing(suite);
    if (!suite.environmentKey.startsWith("tree:")) {
      await errorSuite(
        suite,
        "its environment image is no longer on this machine; ask for checks again",
      );
      return;
    }
    const waiting = await transition(suite, {
      state: "waiting",
      image: null,
      environmentId: null,
      attempts: 0,
      reason: "waiting for the base's environment",
      leaseUntil: null,
      pods: answeredLives(suite, answeredOf(await store.listResults(suite.id, suite.generation))),
      waitingSince: nowIso(),
    });
    if (waiting === null) return;
    await attachEnvironment(waiting).catch((err) =>
      diag.warn("checks.environment_failed", { suiteId: suite.id, err: errText(err) })
    );
  };

  /** Its build retired if still ready, and no cached choice answers with it any more. */
  const imageMissing = async (suite: CheckSuite) => {
    const { environmentId, image } = suite;
    if (environmentId === null || image === null) return;
    for (const [key, entry] of imageChoices) {
      const choice = await entry.choice.catch(() => null);
      if (choice?.image === image && imageChoices.get(key) === entry) {
        imageChoices.delete(key);
      }
    }
    await deps.environments?.imageMissing(environmentId, image).catch((err) =>
      diag.warn("checks.environment_failed", { suiteId: suite.id, err: errText(err) })
    );
  };

  /** Whether a suite keyed on its image would find that image gone: as the launcher answers, or
   * where it cannot, as retention says. A suite keyed on its base's tree waits for that
   * environment again on its own (`imageLeftMachine`). Asked through `prepare`, which starts
   * pulling an image that is not there but can be pulled: the launch would pull it anyway. */
  const imageGone = async (suite: CheckSuite): Promise<boolean> => {
    if (!suite.environmentKey.startsWith("image:") || suite.image === null) return false;
    const prepare = deps.launcher?.prepare?.bind(deps.launcher);
    if (prepare !== undefined) {
      return (await prepare([suite.image], suite.updatedAt)).kind === "gone";
    }
    return await removedByRetention(suite);
  };

  /**
   * Whether retention says it removed a suite's image, for a launcher that cannot tell
   * (kubernetes: the pod pulls, after the launch): its build stamped, and every other row naming
   * the image as its baked one (a re-layer's is its source's) stamped too, or it is still
   * someone's and still there. Whatever its key: a suite keyed on its base's tree, re-run long
   * after, would otherwise go back to the queue on an image a registry no longer has.
   */
  const removedByRetention = async (suite: CheckSuite): Promise<boolean> => {
    if (suite.environmentId === null || suite.image === null || deps.environments === null) {
      return false;
    }
    const builds = deps.environments.store;
    return await Promise.all([
      builds.getEnvironment(suite.environmentId),
      builds.listEnvironmentsByBakedImage(suite.image),
    ]).then(
      ([own, sharing]) => !!own?.imagesRemovedAt && sharing.every((r) => !!r.imagesRemovedAt),
      () => false,
    );
  };

  /** Claims one queued suite and launches its pod. False: another replica claimed it first. */
  /** `pullFailed`: its images could not be pulled — an attempt spent, and nothing launched.
   * True when the suite now runs and holds a slot; one that failed is back in the queue, or
   * settled, and holds none. */
  const launchOne = async (
    suite: CheckSuite,
    pullFailed?: string,
    gone?: string,
  ): Promise<boolean> => {
    const launcher = deps.launcher!;
    const lease = new Date(deps.now().getTime() + LAUNCH_LEASE_MS).toISOString();
    const claimed = await transition(suite, {
      state: "running",
      leaseUntil: lease,
      attempts: suite.attempts + 1,
      launchedAt: null,
      reason: null,
    });
    if (claimed === null) return false;
    if (pullFailed !== undefined) {
      await launchFailed(claimed, `its image could not be pulled: ${pullFailed}`, {
        claimed: true,
      });
      return false;
    }
    // Answered checks, passes taken from another suite of the commit or checks a pod this
    // generation launched before answered (`error` included), are not run again. With nothing
    // left to run, the suite settles from them here, each pod's reason its own.
    const kept = answeredOf(await store.listResults(claimed.id, claimed.generation));
    if (kept.size === claimed.definition.checks.length) {
      await settle(claimed, () => {
        const results = claimed.definition.checks.map((c) => kept.get(c.name)!);
        return Promise.resolve({
          results,
          state: suiteVerdict(results),
          reason: podReasons(claimed),
          ryphChanged: claimed.ryphChanged,
        });
      });
      return false;
    }
    if (gone !== undefined) {
      await imageLeftMachine(claimed, gone);
      return false;
    }
    // Only the pods with a check still to answer: a `pod: own` check whose pass was kept launches
    // nothing. Every name is checked and every spec made before any pod is launched, so a
    // refusal launches none.
    const pods = checkPods(claimed).filter((p) => p.checks.some((c) => !kept.has(c.name)));
    const unnamed = pods.find((p) => !CHECK_RECORD_NAME.test(p.name));
    if (unnamed !== undefined) {
      await errorSuite(
        claimed,
        `its check pod's name ${unnamed.name} is longer than the ${MAX_CHECK_RECORD_NAME} ` +
          `characters a check pod's name may be, at generation ${claimed.generation}`,
      );
      return false;
    }
    const keyIds = new Map<string, string>();
    /** Every pod this attempt began to launch, the one whose launch threw included. */
    const launched: string[] = [];
    try {
      const specs: CheckSpec[] = [];
      for (const pod of pods) {
        specs.push(await specFor(claimed, kept, pod, (id) => keyIds.set(pod.name, id)));
      }
      for (const spec of specs) {
        launched.push(spec.name);
        await launcher.launch(spec);
      }
    } catch (err) {
      for (const keyId of keyIds.values()) await store.revokeCheckGitKey(keyId, nowIso());
      // The pods this attempt launched go with it, and whatever the one that threw half-made (a
      // Secret, a network): the next attempt makes them again, each with a key of its own, and a
      // pod left standing would answer that launch with the revoked one. Only while the claim
      // still holds: a launch slower than its lease has a successor, whose pods have these names.
      const row = await store.getSuite(claimed.id);
      if (row?.version === claimed.version) {
        for (const name of launched) await launcher.discard(name).catch(() => {});
      }
      if (err instanceof SizeRefused) {
        await errorSuite(claimed, err.message);
        return false;
      }
      if (err instanceof ImageGone) {
        await imageLeftMachine(claimed, err.message);
        return false;
      }
      if (err instanceof ScopeRefused) {
        // Not a retry: the policy says the same thing on the next attempt.
        await errorSuite(
          claimed,
          `the requesting run's network policy no longer fits this deployment's: ${err.message}`,
        );
        return false;
      }
      await launchFailed(claimed, `the check pod could not be launched: ${errText(err)}`, {
        claimed: true,
      });
      return false;
    }
    const at = nowIso();
    const started = await transition(claimed, {
      launchedAt: at,
      leaseUntil: null,
      // Each pod launched starts its own life here, its first attempt this one and its clone key
      // named, so past its clone that key alone goes (`pollOne`, `pollPods`); a pod already done
      // keeps the life it ended with.
      pods: {
        ...answeredLives(claimed, kept),
        ...Object.fromEntries(
          pods.map((pod): [string, CheckPodState] => [pod.name, {
            attempts: 1,
            launchedAt: at,
            keyId: keyIds.get(pod.name) ?? null,
            reason: null,
          }]),
        ),
      },
    });
    // A launch slower than its lease: the suite is another's now, and this holds no slot. The
    // successor's poll or adoption, the orphan sweep and the keys' TTL clean up after it.
    if (started === null) return false;
    diag.debug("checks.launched", {
      suiteId: suite.id,
      generation: suite.generation,
      attempt: claimed.attempts,
    });
    return true;
  };

  /** Stores one container's log under the suite's prefix and answers its key and tail. */
  const keepLog = async (
    suite: CheckSuite,
    record: string,
    container: string,
    file: string,
  ): Promise<{ logKey: string | null; logTail: string | null }> => {
    const raw = await deps.launcher!.logs(record, container, MAX_CHECK_LOG_BYTES)
      .catch(() => null);
    if (raw === null || raw === "") return { logKey: null, logTail: null };
    // What the pod printed may carry its own credentials (`env`, a proxy error echoing its URL):
    // taken out before anyone — the inbox, the forge, the page — can read it. Escapes go first,
    // so a color code inside a credential cannot hide it from the redactor.
    const log = redactCredentials(stripAnsi(raw));
    const logKey = `checks/${suite.id}/${suite.generation}/${file}.log`;
    await deps.logs.put(logKey, log);
    return { logKey, logTail: logTailOf(log) };
  };

  /** Stops and removes every pod of the suite's generation, each on its own: one that will not
   * go starves none of the others, and the orphan sweep takes it later. */
  const discardPods = async (suite: CheckSuite): Promise<void> => {
    for (const pod of checkPods(suite)) {
      await deps.launcher?.discard(pod.name).catch((err) =>
        diag.warn("checks.discard_failed", { suiteId: suite.id, err: errText(err) })
      );
    }
  };

  /** A running suite's lease, taken by a compare-and-set on the row exactly as read, its
   * `version` included: null when anyone has written it since. */
  const hold = async (suite: CheckSuite): Promise<CheckSuite | null> => {
    const lease = new Date(deps.now().getTime() + LAUNCH_LEASE_MS).toISOString();
    const held = { ...suite, leaseUntil: lease, version: suite.version + 1, updatedAt: nowIso() };
    const took = await store.saveSuiteIf(held, {
      states: ["running"],
      generation: suite.generation,
      leaseUntil: suite.leaseUntil,
      version: suite.version,
    });
    return took ? held : null;
  };

  /**
   * Settles a running suite under a lease of its own: whatever `build` reads and stores (logs,
   * the changed paths) is written by one replica only, then the rows, then the verdict, and the
   * pod goes last. A settle that loses its lease writes nothing.
   */
  const settle = async (
    suite: CheckSuite,
    build: () => Promise<{
      results: CheckResult[];
      state: CheckSuiteState;
      reason: string | null;
      ryphChanged: boolean | null;
    }>,
  ): Promise<void> => {
    const lease = new Date(deps.now().getTime() + SETTLE_LEASE_MS).toISOString();
    const held = { ...suite, leaseUntil: lease, version: suite.version + 1, updatedAt: nowIso() };
    // The row as read, its version included: a stale read cannot settle over another replica's
    // write (a pod's reason, a relaunch).
    const took = await store.saveSuiteIf(held, {
      states: ["running"],
      generation: suite.generation,
      leaseUntil: suite.leaseUntil,
      version: suite.version,
    });
    if (!took) return;
    const outcome = await build();
    await store.upsertResults(outcome.results);
    const at = nowIso();
    const settled = await transition(held, {
      state: outcome.state,
      reason: outcome.reason,
      ryphChanged: outcome.ryphChanged,
      finishedAt: at,
      leaseUntil: null,
    }, lease);
    if (settled === null) return;
    await store.revokeCheckGitKeys(suite.id, suite.generation, at);
    await discardPods(suite);
    diag.debug("checks.settled", {
      suiteId: suite.id,
      generation: suite.generation,
      state: outcome.state,
    });
  };

  /** The checks of one generation that are answered, by name: any settled row, `error`
   * included. The one rule for the generation: an answered check is never launched again, holds
   * no slot and keeps its row (`launchOne`, `slotsOf`, `pollPods`); a re-run starts afresh. */
  const answeredOf = (rows: readonly CheckResult[]): Map<string, CheckResult> =>
    new Map(rows.filter((r) => SETTLED_RESULT_STATES.has(r.state)).map((r) => [r.name, r]));

  /** The lives of a suite's pods whose every check is answered: kept through a requeue, an
   * adoption and a relaunch of the rest, so the reason each ended with reaches the suite's. Null
   * when there are none. */
  const answeredLives = (
    suite: CheckSuite,
    answered: ReadonlyMap<string, unknown>,
  ): Record<string, CheckPodState> | null => {
    const done = checkPods(suite).filter((p) =>
      suite.pods?.[p.name] !== undefined && p.checks.every((c) => answered.has(c.name))
    );
    return done.length === 0
      ? null
      : Object.fromEntries(done.map((p) => [p.name, suite.pods![p.name]]));
  };

  /** A suite of several pods' reason: each pod's, in turn. */
  const podReasons = (suite: CheckSuite): string | null => {
    const reasons = checkPods(suite).flatMap((pod) => {
      const reason = suite.pods?.[pod.name]?.reason ?? null;
      return reason === null ? [] : [reason];
    });
    return reasons.length === 0 ? null : reasons.join("; ");
  };

  /** One exited check's row: its log kept, its times from the container. */
  const exitedResult = async (
    suite: CheckSuite,
    check: { name: string },
    container: CheckContainerState | undefined,
    mapped: { state: CheckResultState; exitCode: number | null },
    watchedChanged: boolean | null,
    at: string,
  ): Promise<CheckResult> => ({
    suiteId: suite.id,
    generation: suite.generation,
    name: check.name,
    state: mapped.state,
    exitCode: mapped.exitCode,
    startedAt: container?.state === "exited" || container?.state === "running"
      ? container.startedAt
      : null,
    finishedAt: container?.state === "exited" ? container.finishedAt ?? at : at,
    ...await keepLog(suite, recordOf(suite, check.name), `check-${check.name}`, check.name),
    watchedChanged,
    forgeRef: null,
    inheritedFrom: null,
  });

  /**
   * A running suite's progress, written as its pods stand: a check that started is `running`,
   * and one whose container exited with its own verdict is settled on the spot, its log kept, so
   * the page and the forge show it long before the slowest check ends. A platform fault, and a
   * kill by signal that is not out of memory (`settlesEarly`), is left for the suite's settle (or
   * a relaunch) to judge, and a check already holding a verdict keeps
   * it: a relaunched pod leaves it out. Unleased — the store keeps the first
   * verdict a racing replica wrote, and both read the same finished container. `clone`: the
   * record whose clone step listed the changed paths.
   */
  const recordProgress = async (
    suite: CheckSuite,
    seen: Extract<CheckInspection, { kind: "checks" }>,
    rows: readonly CheckResult[],
    clone: string,
  ): Promise<void> => {
    const at = nowIso();
    const kept = answeredOf(rows);
    const stored = new Map(rows.map((r) => [r.name, r]));
    let watched: Awaited<ReturnType<typeof watchedOf>> | null = null;
    const writes: CheckResult[] = [];
    for (const [i, check] of suite.definition.checks.entries()) {
      const row = stored.get(check.name);
      if (kept.has(check.name) || (row !== undefined && !liveResult(row.state))) continue;
      const container = seen.checks[check.name];
      if (container === undefined || container.state === "waiting") continue;
      if (settlesEarly(container)) {
        watched ??= await watchedOf(suite, clone);
        writes.push(
          await exitedResult(
            suite,
            check,
            container,
            resultFromContainer(container),
            watched.checks[i],
            at,
          ),
        );
        continue;
      }
      if (row !== undefined && row.state === "queued") {
        writes.push({ ...row, state: "running", startedAt: container.startedAt ?? at });
      }
    }
    if (writes.length === 0) return;
    await store.upsertResults(writes);
    // The list that answered the early verdicts answers `.ryph/` too: the page and the reports
    // need not wait for the slowest check to know it.
    if (suite.ryphChanged === null && watched !== null && watched.ryph !== null) {
      await store.setSuiteRyphChanged(suite.id, watched.ryph);
    }
    await touchReports(suite);
    const settledNow = writes.filter((r) => ownVerdict(r.state)).map((r) => r.name);
    if (settledNow.length > 0) {
      diag.debug("checks.check_settled", {
        suiteId: suite.id,
        generation: suite.generation,
        checks: settledNow,
      });
    }
  };

  /**
   * What a pod's containers say of its checks once it reported them done (or ran out its
   * deadline): each check's row, its log kept from `record` — a check that settled while the pod
   * ran keeps that row, and its log is not read again — and what the suite's reason should say of
   * them. `who` names the pod in that reason.
   */
  const checksOutcome = async (
    suite: CheckSuite,
    checks: readonly CheckDeclaration[],
    seen: Extract<CheckInspection, { kind: "checks" }>,
    pastDeadline: boolean,
    record: string,
    who: string,
  ): Promise<{ results: CheckResult[]; reasons: string[]; ryph: boolean | null }> => {
    const kept = answeredOf(await store.listResults(suite.id, suite.generation));
    const watched = await watchedOf(suite, record);
    const at = nowIso();
    const oom: string[] = [];
    const broken: string[] = [];
    /** A check that failed with a reason the backend gave (its disk share, say). */
    const said: string[] = [];
    const results: CheckResult[] = [];
    for (const check of checks) {
      const i = suite.definition.checks.findIndex((c) => c.name === check.name);
      const container = seen.checks[check.name];
      const mapped = pastDeadline && container?.state !== "exited"
        ? { state: "timed_out" as const, exitCode: null, oom: false }
        : resultFromContainer(container);
      const prior = kept.get(check.name);
      // What the pod says explains the verdict only when it is the pod that gave it: after a
      // relaunch, a kept check's container is a second run nobody reads.
      const explains = prior === undefined ||
        (prior.state === mapped.state && prior.exitCode === mapped.exitCode);
      if (explains) {
        if (mapped.oom) oom.push(check.name);
        if (
          mapped.state === "failed" && !mapped.oom && container?.state === "exited" &&
          container.reason !== null
        ) said.push(`${check.name} ${container.reason}`);
      }
      if (prior !== undefined) {
        results.push(prior);
        continue;
      }
      if (mapped.state === "error") broken.push(check.name);
      results.push(await exitedResult(suite, check, container, mapped, watched.checks[i], at));
    }
    return {
      results,
      reasons: [
        ...(oom.length > 0 ? [`out of memory: ${oom.join(", ")}`] : []),
        ...said,
        ...(broken.length > 0 ? [`the platform could not run ${broken.join(", ")}`] : []),
        ...(pastDeadline ? [`${who} ran past its deadline`] : []),
      ],
      ryph: watched.ryph,
    };
  };

  /** Every check of a suite whose one pod reported its checks done (or ran out the deadline). */
  const settleChecks = (
    suite: CheckSuite,
    seen: Extract<CheckInspection, { kind: "checks" }>,
    pastDeadline: boolean,
    record: string,
  ) =>
    settle(suite, async () => {
      const { results, reasons, ryph } = await checksOutcome(
        suite,
        suite.definition.checks,
        seen,
        pastDeadline,
        record,
        "the check pod",
      );
      return {
        results,
        state: suiteVerdict(results),
        reason: reasons.length === 0 ? null : reasons.join("; "),
        ryphChanged: ryph,
      };
    });

  /**
   * Why a pod whose checks are done goes again: a check the platform could not run, while a
   * relaunch could change the answer — an attempt left, and none of its checks failed on its own
   * account (its disk share, say), which a relaunch would only repeat. Null: it settles with
   * every check's own verdict, the faulted ones `error`. `kept`: the verdicts its checks hold.
   */
  const relaunchWhy = (
    seen: Extract<CheckInspection, { kind: "checks" }>,
    kept: ReadonlyMap<string, CheckResult>,
    attempts: number,
  ): string | null => {
    // A check that holds its verdict is not asked again: its container in a relaunched pod is a
    // second run nobody reads.
    const fresh = Object.entries(seen.checks).filter(([check]) => !kept.has(check));
    const faulted = fresh.filter(([, container]) => platformFault(container));
    const ownFailure = [...kept.values()].some((r) => settledBad(r.state)) ||
      fresh.some(([, container]) => settledBad(resultFromContainer(container).state));
    if (faulted.length === 0 || attempts >= MAX_LAUNCH_ATTEMPTS || ownFailure) return null;
    return `the platform could not run ${
      faulted.map(([check, c]) =>
        `${check} (${
          c.state === "exited" && c.reason !== null ? c.reason : `exit ${CHECK_PLATFORM_EXIT}`
        })`
      ).join(", ")
    }`;
  };

  /** What a record's clone step's changed-paths list says for each check and for `.ryph/`:
   * unknown when the list cannot be trusted. Every pod clones the same head on the same base, so
   * any pod that ran answers for all of them. */
  const watchedOf = async (suite: CheckSuite, clone: string) =>
    watchedChangedByCheck(
      changedPathsFromLog(
        await deps.launcher!.logs(clone, "clone", CLONE_LOG_BYTES).catch(() => null),
      ),
      suite.definition.checks.map((c) => c.watch),
    );

  /** A setup step failed: every check `setup_failed`, the step's log kept once for all. */
  const settleSetupFailed = (
    suite: CheckSuite,
    seen: Extract<CheckInspection, { kind: "setup_failed" }>,
    pod: CheckPod,
  ) =>
    settle(suite, async () => {
      const step = seen.step as number;
      const record = pod.name;
      const log = await keepLog(suite, record, `setup-${step}`, setupLogOf(pod));
      const watched = await watchedOf(suite, record);
      const at = nowIso();
      return {
        results: queuedResults(suite, "setup_failed").map((r, i) => ({
          ...r,
          finishedAt: at,
          ...log,
          watchedChanged: watched.checks[i],
        })),
        state: "failed" as const,
        reason: `setup step ${step + 1} failed${
          seen.exitCode === null ? "" : ` (exit ${seen.exitCode})`
        }: ${seen.why}`,
        ryphChanged: watched.ryph,
      };
    });

  /** Whether a suite's pods are past its deadline, and the backstop after it. */
  const pastDeadlineOf = (s: CheckSuite) =>
    deps.now().getTime() >
      Date.parse(s.launchedAt ?? s.leaseUntil ?? s.updatedAt) + deadlineSecondsOf(s) * 1000 +
        DEADLINE_BACKSTOP_MS;

  /** The clone step's failure, for a person: its reason and the end of its log. */
  const cloneFailure = async (
    record: string,
    seen: Extract<CheckInspection, { kind: "setup_failed" }>,
  ): Promise<string> => {
    const log = await deps.launcher!.logs(record, "clone", 4_000).catch(() => null);
    return `the clone step failed: ${seen.why}${
      log === null
        ? ""
        : `: ${scrub(redactCredentials(logTailOf(stripAnsi(log))), 600).replaceAll("\n", " | ")}`
    }`;
  };

  /**
   * A running suite whose one pod has reached its checks: progress written, or a relaunch, or the
   * settle once every check is done or the deadline has passed. A relaunch discards the pod and
   * puts the suite back in the queue (`launchFailed`).
   */
  const judgeChecks = async (
    current: CheckSuite,
    seen: Extract<CheckInspection, { kind: "checks" }>,
    rows: readonly CheckResult[],
    pastDeadline: boolean,
    record: string,
  ): Promise<void> => {
    if (seen.done && !pastDeadline) {
      const why = relaunchWhy(seen, answeredOf(rows), current.attempts);
      if (why !== null) {
        // The checks this pod did answer keep their verdict through the relaunch.
        await recordProgress(current, seen, rows, record);
        await launchFailed(current, why);
        return;
      }
    }
    if (seen.done || pastDeadline) {
      await settleChecks(current, seen, !seen.done, record);
      return;
    }
    await recordProgress(current, seen, rows, record);
  };

  /** What an unschedulable pod's reason says after the fact: the container's own words, never
   * the scheduler's, which name the cluster's nodes and taints and go to the operator's log. */
  const unschedulableWhy = (
    suite: CheckSuite,
    pod: string,
    seen: Extract<CheckInspection, { kind: "unschedulable" }>,
  ): string => {
    if (seen.detail !== undefined) {
      diag.warn("checks.unschedulable", { suiteId: suite.id, pod, detail: seen.detail });
    }
    return seen.why === null ? "" : `: ${seen.why}`;
  };

  /** One running suite, as its pod now stands; a suite of several pods is `pollPods`'s. */
  const pollOne = async (suite: CheckSuite): Promise<void> => {
    if (suite.remote != null) {
      await refreshRemote(suite);
      return;
    }
    const launcher = deps.launcher!;
    const at = nowIso();
    // Someone holds it: a launch in flight, or a settle.
    if (suite.leaseUntil !== null && suite.leaseUntil > at) return;
    const pods = checkPods(suite);
    if (pods.length > 1) {
      await pollPods(suite, pods);
      return;
    }
    const name = pods[0].name;
    const seen = await launcher.poll(name);
    if (seen.kind === "unknown") {
      // A backend that will not answer decides nothing — until the pod would be over anyway.
      // Then the slot it holds is given back, and the record discarded if it is still there.
      if (pastDeadlineOf(suite)) {
        const errored = await errorSuite(
          suite,
          `the check pod could not be read past its deadline (${seen.why})`,
        );
        if (errored !== null) await launcher.discard(name).catch(() => {});
      }
      return;
    }
    if (seen.kind === "gone") {
      await launchFailed(
        suite,
        suite.launchedAt === null
          ? "its launch was interrupted"
          : "its check pod disappeared before it finished",
      );
      return;
    }
    let current = suite;
    if (current.launchedAt === null) {
      // Launched by a replica that died before it could say so: adopted, never relaunched. That
      // launch wrote no life, so its key has no name (`revokeCloned`).
      const adopted = await transition(current, { launchedAt: at, leaseUntil: null, pods: null });
      if (adopted === null) return;
      current = adopted;
      diag.debug("checks.adopted", { suiteId: suite.id });
    }
    const pastDeadline = pastDeadlineOf(current);
    /** The pod failed the platform's way: its record goes, and the suite tries again. */
    const relaunch = (why: string) => launchFailed(current, why);
    /**
     * Its clone is done, so its key goes: the one its launch named, by id — a stale read takes
     * only that one, never a successor's — and the life cleared by compare-and-set, so once. A
     * launch adopted from a replica that died named none: every key of the generation goes
     * under the lease, so none a relaunch mints meanwhile, and a life is written to say so. The
     * suite as it now stands, or null when another replica wrote it since this read.
     */
    const revokeCloned = async (): Promise<CheckSuite | null> => {
      const life = current.pods?.[name];
      if (life?.keyId === null) return current;
      if (life !== undefined) {
        await store.revokeCheckGitKey(life.keyId, at);
        return await transition(current, { pods: { [name]: { ...life, keyId: null } } });
      }
      const held = await hold(current);
      if (held === null) return null;
      await store.revokeCheckGitKeys(held.id, held.generation, at);
      const wrote = await transition(held, {
        leaseUntil: null,
        pods: { [name]: { attempts: 1, launchedAt: held.launchedAt!, keyId: null, reason: null } },
      });
      if (wrote !== null) return wrote;
      // An unleased writer (a cancel, an asker joining) moved it: the lease, still ours, goes
      // back rather than idling the suite until it runs out. The next poll revokes again.
      const now = await store.getSuite(held.id);
      if (now?.leaseUntil === held.leaseUntil) await transition(now, { leaseUntil: null });
      return null;
    };
    switch (seen.kind) {
      case "pending": {
        if (seen.cloneDone) {
          const now = await revokeCloned();
          if (now === null) return;
          current = now;
        }
        if (!pastDeadline) return;
        const step = setupStepRunning(seen);
        if (step !== null) {
          // A setup step that never ends is the head's hang, as the kubernetes launcher reads it
          // when the pod's own deadline kills the step.
          await settleSetupFailed(current, {
            kind: "setup_failed",
            cloneDone: true,
            step,
            exitCode: 124,
            why: `setup step ${step + 1} ran past the suite's deadline`,
          }, pods[0]);
          return;
        }
        // Nothing of the head's ran: a pod stuck before its checks is the platform's.
        await settle(current, () => {
          const at = nowIso();
          return Promise.resolve({
            results: queuedResults(current, "error").map((r) => ({ ...r, finishedAt: at })),
            state: "error" as const,
            reason: `the check pod did not start its checks within its deadline${
              seen.why === null ? "" : ` (${seen.why})`
            }`,
            ryphChanged: null,
          });
        });
        return;
      }
      case "unschedulable":
        await relaunch(
          `the check pod could not be scheduled${askedSize(pods[0])}${
            unschedulableWhy(current, name, seen)
          }`,
        );
        return;
      case "setup_failed":
        if (seen.step === "clone") {
          // The clone is the platform's step, not the head's: a failure there is ours to retry.
          const why = await cloneFailure(name, seen);
          await launchFailed(current, why, { sourceFailed: true });
          return;
        }
        // No exit code: the pod ended under the step (evicted, its node gone). The platform's
        // exit: the entrypoint around the step failed. Neither is the step's own verdict.
        if (seen.exitCode === null || seen.exitCode === CHECK_PLATFORM_EXIT) {
          await relaunch(`setup step ${seen.step + 1} could not run: ${seen.why}`);
          return;
        }
        await settleSetupFailed(current, seen, pods[0]);
        return;
      case "checks": {
        const now = await revokeCloned();
        if (now === null) return;
        current = now;
        const rows = await store.listResults(current.id, current.generation);
        await judgeChecks(current, seen, rows, pastDeadline, name);
        return;
      }
    }
  };

  /**
   * A suite of several pods (`checkPods`: a shared pod and `pod: own` checks, or several of
   * those). Each pod lives its own life (docs/checks.md, "Pods of their own"); only an OPEN one,
   * a pod with a check still without its settled row, is read:
   *
   * - a pod's checks settle as soon as THAT pod is done — their rows written, their logs kept —
   *   and the pod is discarded and never read again, so it may vanish (a Job's TTL, a node scaled
   *   down) while another pod runs without costing its verdicts
   * - a pod the platform failed (gone, unschedulable, its clone failed, a setup step cut short
   *   with no exit code or the entrypoint's own, a check the platform could not run) relaunches
   *   ALONE, on attempts of its own (`CheckPodState`), while the others run on. On its last
   *   attempt, or once one of its checks failed on its own account (which a relaunch would only
   *   repeat), its checks without a verdict are `error`, the reason naming the pod — and the size
   *   class it asked for, when it could not be scheduled
   * - a setup step that failed on the head's account fails its own pod's checks (`setup_failed`,
   *   the step's log theirs); the other pods run on
   * - each pod is held to its own deadline, counted from its own launch. Past it, a pod the
   *   backend cannot read has its open checks `error`, one still in a setup step has that step's
   *   hang (`setup_failed`), one not yet at its checks has the platform's failure (`error`), and
   *   one at its checks settles from what they show. Before it, a pod the backend cannot read
   *   decides nothing — about itself only: what the others say is recorded on every poll, and a
   *   check that answered keeps its verdict and log whatever happens to the unreadable one
   * - a pod's clone key is revoked once THAT pod is past its clone, and its life says so under
   *   the lease, so once
   * - the suite settles once every check has its row: its verdict from all of them, its reason
   *   each pod's in turn
   *
   * Progress — a check started, a check's own early verdict, a key revoked — is written unleased,
   * as a single pod's is. Everything else (a pod settled, relaunched or discarded) happens under
   * the suite's lease, taken by a compare-and-set on the row exactly as this poll read it, its
   * `version` included: a replica whose read is older than another's act takes nothing, so no
   * pod is relaunched twice, nor discarded under another replica's launch of it while the lease
   * lasts (`LAUNCH_LEASE_MS`, far longer than a pass). A launch found interrupted is failed the
   * same way (`launchFailed`). So is revoking every key of the suite, which would otherwise take
   * a key another replica just minted. A relaunched pod's life is written as soon as it
   * launches; a pass that finds its lease lost revokes the keys it minted since its last write,
   * which nobody else knows of.
   */
  const pollPods = async (suite: CheckSuite, pods: readonly CheckPod[]): Promise<void> => {
    const launcher = deps.launcher!;
    const rows = await store.listResults(suite.id, suite.generation);
    const answered = answeredOf(rows);
    const open = pods.filter((p) => p.checks.some((c) => !answered.has(c.name)));
    const seen = new Map<string, CheckInspection>();
    for (const pod of open) seen.set(pod.name, await launcher.poll(pod.name));
    let current = suite;
    if (current.launchedAt === null) {
      if (open.some((p) => seen.get(p.name)!.kind === "gone")) {
        await launchFailed(current, "its launch was interrupted");
        return;
      }
      // Launched by a replica that died before it could say so: adopted, never relaunched. The
      // open pods' lives on the row are an earlier attempt's: that launch wrote none.
      const adopted = await transition(current, {
        launchedAt: nowIso(),
        leaseUntil: null,
        pods: answeredLives(current, answered),
      });
      if (adopted === null) return;
      current = adopted;
      diag.debug("checks.adopted", { suiteId: suite.id });
    }
    const launchedAt = current.launchedAt!;
    /** A pod's life; one adopted from a replica that died before it wrote any is its first. */
    const lifeOf = (pod: CheckPod, of: CheckSuite = current): CheckPodState =>
      of.pods?.[pod.name] ?? { attempts: 1, launchedAt, keyId: null, reason: null };
    const pastDeadline = (pod: CheckPod) =>
      deps.now().getTime() >
        Date.parse(lifeOf(pod).launchedAt) + podDeadlineSeconds(pod.checks) * 1000 +
          DEADLINE_BACKSTOP_MS;

    /** What a pod settled: its checks' rows, and what the suite's reason says of them. */
    type Outcome = { results: CheckResult[]; reason: string | null; ryph: boolean | null };
    /** What a pod comes to, worked out under the lease (its logs are read once). */
    type Act =
      | { kind: "settle"; pod: CheckPod; outcome: (held: CheckSuite) => Promise<Outcome> }
      | { kind: "relaunch"; pod: CheckPod; why: string; sourceFailed: boolean };
    /** The pod's checks without a settled row, as `state`. */
    const openRows = (held: CheckSuite, pod: CheckPod, state: CheckResultState) =>
      queuedResults(held, state).filter((r) =>
        !answered.has(r.name) && pod.checks.some((c) => c.name === r.name)
      );
    const errored = (pod: CheckPod, reason: string) => (held: CheckSuite) => {
      const finishedAt = nowIso();
      return Promise.resolve({
        results: openRows(held, pod, "error").map((r) => ({ ...r, finishedAt })),
        reason,
        ryph: null,
      });
    };
    /** Its checks `setup_failed`, the step's log theirs. */
    const setupFailed =
      (pod: CheckPod, step: number, exitCode: number, reason: string) =>
      async (held: CheckSuite): Promise<Outcome> => {
        const log = await keepLog(
          held,
          pod.name,
          `setup-${step}`,
          setupLogOf(pod),
        );
        const watched = await watchedOf(held, pod.name);
        const finishedAt = nowIso();
        return {
          results: openRows(held, pod, "setup_failed").map((r) => ({
            ...r,
            exitCode,
            finishedAt,
            ...log,
            watchedChanged:
              watched.checks[held.definition.checks.findIndex((c) => c.name === r.name)],
          })),
          reason,
          ryph: watched.ryph,
        };
      };

    const acts: Act[] = [];
    /** Whether every open pod is past its clone. */
    let cloned = true;
    /** The keys revoked here, by pod: written down under the lease, so it happens once. */
    const revoked = new Map<string, string>();
    for (const pod of open) {
      const one = seen.get(pod.name)!;
      const label = podLabel(pod);
      const life = lifeOf(pod);
      const past = pastDeadline(pod);
      const pastClone = one.kind === "checks" || (one.kind === "pending" && one.cloneDone) ||
        (one.kind === "setup_failed" && one.step !== "clone");
      if (pastClone && life.keyId !== null) {
        await store.revokeCheckGitKey(life.keyId, nowIso());
        revoked.set(pod.name, life.keyId);
      }
      if (!pastClone) cloned = false;
      switch (one.kind) {
        case "unknown":
          if (past) {
            acts.push({
              kind: "settle",
              pod,
              outcome: errored(pod, `${label} could not be read past its deadline (${one.why})`),
            });
          }
          break;
        case "gone":
          acts.push({
            kind: "relaunch",
            pod,
            why: life.reason ?? `${label} disappeared before it finished`,
            sourceFailed: false,
          });
          break;
        case "unschedulable":
          acts.push({
            kind: "relaunch",
            pod,
            why: `${label} could not be scheduled${askedSize(pod)}${
              unschedulableWhy(current, pod.name, one)
            }`,
            sourceFailed: false,
          });
          break;
        case "setup_failed":
          if (one.step === "clone") {
            // The clone is the platform's step, not the head's: a failure there is ours to retry.
            acts.push({
              kind: "relaunch",
              pod,
              why: `${label}: ${await cloneFailure(pod.name, one)}`,
              sourceFailed: true,
            });
          } else if (one.exitCode === null || one.exitCode === CHECK_PLATFORM_EXIT) {
            // No exit code: the pod ended under the step. The platform's exit: the entrypoint
            // around it failed. Neither is the step's own verdict.
            acts.push({
              kind: "relaunch",
              pod,
              why: `setup step ${one.step + 1} could not run in ${label}: ${one.why}`,
              sourceFailed: false,
            });
          } else {
            acts.push({
              kind: "settle",
              pod,
              outcome: setupFailed(
                pod,
                one.step,
                one.exitCode,
                `setup step ${one.step + 1} failed in ${label} (exit ${one.exitCode}): ${one.why}`,
              ),
            });
          }
          break;
        case "pending": {
          if (!past) break;
          // A setup step that never ends is the head's hang; nothing of the head's run yet is the
          // platform's failure to run it.
          const step = setupStepRunning(one);
          acts.push({
            kind: "settle",
            pod,
            outcome: step !== null
              ? setupFailed(pod, step, 124, `setup step ${step + 1} ran past ${label}'s deadline`)
              : errored(
                pod,
                `${label} did not start its checks within its deadline${
                  one.why === null ? "" : ` (${one.why})`
                }`,
              ),
          });
          break;
        }
        case "checks": {
          if (one.done && !past) {
            const kept = answeredOf(rows.filter((r) => pod.checks.some((c) => c.name === r.name)));
            const why = relaunchWhy(one, kept, life.attempts);
            if (why !== null) {
              // The checks this pod did answer keep their verdict through its relaunch.
              await recordProgress(current, one, rows, pod.name);
              acts.push({ kind: "relaunch", pod, why: `${why} in ${label}`, sourceFailed: false });
              break;
            }
          }
          if (one.done || past) {
            acts.push({
              kind: "settle",
              pod,
              outcome: async (held) => {
                const o = await checksOutcome(held, pod.checks, one, !one.done, pod.name, label);
                return {
                  results: o.results,
                  reason: o.reasons.length === 0 ? null : o.reasons.join("; "),
                  ryph: o.ryph,
                };
              },
            });
          } else {
            await recordProgress(current, one, rows, pod.name);
          }
          break;
        }
      }
    }
    if (open.length === 0) {
      await finishPods(current);
      return;
    }
    // A pod with no life written (a launch adopted from a replica that died) holds a key nobody
    // named: all of the suite's go once every open pod has cloned, under the lease, so a key a
    // relaunch minted meanwhile is not among them.
    const unnamedKey = cloned && open.some((p) => current.pods?.[p.name] === undefined);
    if (acts.length === 0 && !unnamedKey && revoked.size === 0) return;

    // The lease, from the row exactly as this poll read it: nobody has written it since.
    const base = await store.getSuite(current.id);
    if (base === null || base.version !== current.version) return;
    const lease = new Date(deps.now().getTime() + LAUNCH_LEASE_MS).toISOString();
    let held: CheckSuite = {
      ...base,
      leaseUntil: lease,
      version: base.version + 1,
      updatedAt: nowIso(),
    };
    const took = await store.saveSuiteIf(held, {
      states: ["running"],
      generation: base.generation,
      leaseUntil: base.leaseUntil,
      version: base.version,
    });
    if (!took) return;
    const lives: Record<string, CheckPodState> = { ...(held.pods ?? {}) };
    for (const [name, keyId] of revoked) {
      if (lives[name]?.keyId === keyId) lives[name] = { ...lives[name], keyId: null };
    }
    if (unnamedKey) {
      await store.revokeCheckGitKeys(held.id, held.generation, nowIso());
      // Written down, so no later poll revokes again.
      for (const pod of open) lives[pod.name] ??= lifeOf(pod, held);
    }

    /** Its rows written, its key revoked, then the pod discarded: done, and never read again. */
    const settlePod = async (pod: CheckPod, outcome: Outcome) => {
      await store.upsertResults(outcome.results);
      if (outcome.ryph !== null && held.ryphChanged === null) {
        held = { ...held, ryphChanged: outcome.ryph };
        await store.setSuiteRyphChanged(held.id, outcome.ryph);
      }
      const life = lifeOf(pod, held);
      lives[pod.name] = { ...life, reason: outcome.reason };
      if (life.keyId !== null) await store.revokeCheckGitKey(life.keyId, nowIso());
      await launcher.discard(pod.name).catch((err) =>
        diag.warn("checks.discard_failed", { suiteId: held.id, err: errText(err) })
      );
      diag.debug("checks.pod_settled", {
        suiteId: held.id,
        generation: held.generation,
        pod: pod.name,
        checks: outcome.results.map((r) => [r.name, r.state]),
      });
    };

    /** Set when a relaunch found the suite's image gone: no pod can go again on it. */
    let imageGoneWhy: string | null = null;
    /** The clone keys this pass's relaunches minted and has not yet written: revoked if the pass
     * loses its lease. */
    const minted: string[] = [];
    /** Set when a write under the lease did not land: the suite is another replica's now. */
    let lost = false;

    /** The lives as they stand, written now under the lease: a relaunched pod's new key and
     * attempt are on the row before anything else can fail. False when the lease was lost. */
    const writeLives = async (): Promise<boolean> => {
      const next = { ...held, pods: { ...lives }, version: held.version + 1, updatedAt: nowIso() };
      const landed = await store.saveSuiteIf(next, {
        states: ["running"],
        generation: held.generation,
        leaseUntil: lease,
        version: held.version,
      });
      if (landed) {
        held = next;
        // On the row now: the pods hold them, whoever holds the suite next.
        minted.length = 0;
      } else lost = true;
      return landed;
    };

    /** The pod alone goes again, on an attempt of its own; past its last, its checks `error`. */
    const relaunchPod = async (pod: CheckPod, why: string, sourceFailed: boolean) => {
      const life = lifeOf(pod, held);
      if (life.keyId !== null) await store.revokeCheckGitKey(life.keyId, nowIso());
      await launcher.discard(pod.name).catch(() => {});
      const kept = answeredOf(await store.listResults(held.id, held.generation));
      const ownFailure = pod.checks.some((c) => settledBad(kept.get(c.name)?.state ?? "queued"));
      if (ownFailure || life.attempts >= MAX_LAUNCH_ATTEMPTS) {
        await settlePod(
          pod,
          await errored(pod, ownFailure ? why : `${why} (after ${life.attempts} attempts)`)(held),
        );
        return;
      }
      if (sourceFailed) {
        // As `launchFailed`: the clone could not fetch the commit from the suite's source, so the
        // retry takes another asker's source of the same commit when there is one.
        const other = (await store.listRequestsForSuite(held.id)).reverse().find((r) =>
          r.state === "active" && !sameSource(r.source, held.source)
        );
        if (other !== undefined) held = { ...held, source: podSource(other.source) };
      }
      let keyId: string | null = null;
      try {
        await launcher.launch(
          await specFor(held, kept, pod, (id) => {
            keyId = id;
            minted.push(id);
          }),
        );
        lives[pod.name] = {
          attempts: life.attempts + 1,
          launchedAt: nowIso(),
          keyId,
          reason: null,
        };
        diag.warn("checks.pod_relaunched", {
          suiteId: held.id,
          pod: pod.name,
          attempts: life.attempts + 1,
          why,
        });
      } catch (err) {
        if (keyId !== null) await store.revokeCheckGitKey(keyId, nowIso());
        await launcher.discard(pod.name).catch(() => {});
        if (err instanceof ImageGone) {
          imageGoneWhy = err.message;
          return;
        }
        if (err instanceof SizeRefused || err instanceof ScopeRefused) {
          // The same answer on every attempt.
          await settlePod(
            pod,
            await errored(pod, `${podLabel(pod)} could not be launched again: ${err.message}`)(
              held,
            ),
          );
          return;
        }
        // An attempt spent: the next poll finds the pod gone, and says why from this.
        lives[pod.name] = {
          attempts: life.attempts + 1,
          launchedAt: nowIso(),
          keyId: null,
          reason: `${podLabel(pod)} could not be launched: ${errText(err)}`,
        };
        return;
      }
      await writeLives();
    };

    try {
      for (const act of acts) {
        if (act.kind === "settle") await settlePod(act.pod, await act.outcome(held));
        else await relaunchPod(act.pod, act.why, act.sourceFailed);
        if (imageGoneWhy !== null || lost) break;
      }
    } finally {
      held = { ...held, pods: lives };
      if (lost) {
        // Another replica holds the suite and knows nothing of these keys.
        for (const keyId of minted) await store.revokeCheckGitKey(keyId, nowIso());
      } else if (imageGoneWhy !== null) {
        // As a launch that found it gone: the suite goes back whole, every pod with it, and
        // waits for its environment's next image. What answered keeps its verdict for that one.
        await discardPods(held);
        await store.revokeCheckGitKeys(held.id, held.generation, nowIso());
        await imageLeftMachine(held, imageGoneWhy);
      } else {
        const settled = answeredOf(await store.listResults(held.id, held.generation));
        if (held.definition.checks.every((c) => settled.has(c.name))) await finishPods(held);
        else if (await transition(held, { leaseUntil: null }, lease) === null) {
          for (const keyId of minted) await store.revokeCheckGitKey(keyId, nowIso());
        }
      }
    }
  };

  /** A suite of several pods whose every check has its row: its verdict from all of them, its
   * reason each pod's in turn, then every record discarded. */
  const finishPods = (suite: CheckSuite) =>
    settle(suite, async () => {
      const rows = new Map(
        (await store.listResults(suite.id, suite.generation)).map((r) => [r.name, r]),
      );
      const results = queuedResults(suite, "error").map((r) => rows.get(r.name) ?? r);
      return {
        results,
        state: suiteVerdict(results),
        reason: podReasons(suite),
        ryphChanged: suite.ryphChanged,
      };
    });

  /**
   * Each suite's open pods, by id: of a suite of several, each with a check still unanswered
   * (`answeredOf`) — what `launchOne` launches, `pollPods` reads and the orphan sweep keeps; a pod
   * whose checks all have their row is done for the generation. A suite of one pod, its pod.
   */
  const openPodsOf = async (suites: readonly CheckSuite[]): Promise<Map<string, CheckPod[]>> => {
    const several = suites.filter((s) => checkPods(s).length > 1);
    const rows = several.length === 0 ? [] : await store.listResultsForGenerations(
      several.map((s) => ({ suiteId: s.id, generation: s.generation })),
    );
    const open = new Map<string, CheckPod[]>();
    for (const suite of suites) {
      const pods = checkPods(suite);
      if (pods.length === 1) {
        open.set(suite.id, pods);
        continue;
      }
      const done = answeredOf(
        rows.filter((r) => r.suiteId === suite.id && r.generation === suite.generation),
      );
      open.set(suite.id, pods.filter((p) => p.checks.some((c) => !done.has(c.name))));
    }
    return open;
  };

  /** The slots each suite holds, or needs to launch, by id (`launchFairly`, `capacity`): a slot
   * is an open pod (`openPodsOf`). A pass a suite reused spares its pod a slot. */
  const slotsOf = async (suites: readonly CheckSuite[]): Promise<Map<string, number>> =>
    new Map([...await openPodsOf(suites)].map(([id, pods]) => [id, pods.length]));

  /** Every image a suite's pods run: its own, and its services'. */
  const imagesOf = (suite: CheckSuite): string[] => [
    ...(suite.image === null ? [] : [suite.image]),
    ...suite.services.map((s) => s.image),
  ];

  /**
   * Fills the free slots, fairly: the repos with queued suites take turns (each repo's oldest
   * first), and while another repo has a suite queued, a repo launches a suite only if what it
   * holds and what the suite brings stay within half the slots — or, for a suite bigger than
   * that half, only while the repo holds none, or it could never run while anyone else waits.
   * With nobody else waiting, one repo may use them all.
   *
   * A slot is a check POD (`slotsOf`): a suite launches only when every pod it still has to
   * launch fits the free slots, and holds them until each of its pods is done. A suite next in
   * turn that does not fit yet stops the pass: nobody behind it, of any repo, takes the slots it
   * waits for, so a suite of several pods is never starved by suites of one. Its images start
   * pulling while it waits, so they are in when its slots are. One whose image is still pulling
   * when its turn comes holds nothing: those behind it may take the slots while it pulls, as
   * keeping them idle for a pull of minutes would cost every repo. A suite with more pods than
   * the deployment's whole cap can never fit, and is `error` with why.
   */
  const launchFairly = async (): Promise<void> => {
    if (deps.remote != null) return;
    const running = await store.listSuitesByState(["running"], QUEUED_PAGE);
    const runningSlots = await slotsOf(running);
    let free = policy.maxConcurrent -
      running.reduce((n, suite) => n + (runningSlots.get(suite.id) ?? 0), 0);
    if (free <= 0) return;
    const share = Math.max(1, Math.ceil(policy.maxConcurrent / 2));
    const held = new Map<string, number>();
    for (const suite of running) {
      held.set(
        suite.connectedRepoId,
        (held.get(suite.connectedRepoId) ?? 0) + (runningSlots.get(suite.id) ?? 0),
      );
    }
    // Oldest first, so each repo's queue is in order and the repos in order of who waited most.
    const queues = new Map<string, CheckSuite[]>();
    const queued: CheckSuite[] = [];
    for (const suite of await store.listSuitesByState(["queued"], QUEUED_PAGE)) {
      if (suite.remote != null) {
        await refreshRemote(suite);
        continue;
      }
      queued.push(suite);
      queues.set(suite.connectedRepoId, [...(queues.get(suite.connectedRepoId) ?? []), suite]);
    }
    const needs = await slotsOf(queued);
    let waiting = false;
    while (free > 0 && queues.size > 0 && !waiting) {
      let turned = false;
      for (const [repoId, queue] of queues) {
        if (free <= 0) break;
        const suite = queue[0];
        const need = needs.get(suite.id) ?? 1;
        if (need > policy.maxConcurrent) {
          queue.shift();
          if (queue.length === 0) queues.delete(repoId);
          turned = true;
          await errorSuite(suite, tooManyPods(need)).catch((err) =>
            diag.warn("checks.launch_failed", { id: suite.id, err: errText(err) })
          );
          continue;
        }
        const holds = held.get(repoId) ?? 0;
        if (queues.size > 1 && (need > share ? holds > 0 : holds + need > share)) continue;
        // Its turn, and its pods do not fit yet: it waits for them, and nobody jumps it. Its
        // images start pulling now, so they are in when its slots are, and nobody jumps it then.
        if (need > free) {
          await deps.launcher!.prepare?.(imagesOf(suite), suite.updatedAt).catch((err) =>
            diag.warn("checks.prepare_failed", { id: suite.id, err: errText(err) })
          );
          waiting = true;
          break;
        }
        queue.shift();
        if (queue.length === 0) queues.delete(repoId);
        turned = true;
        // Images first, where the launcher pulls them itself: one still pulling waits in the
        // queue, holding no slot, and the tick goes on to the next.
        // Where the launcher cannot tell, retention's word stands in for its `gone`, so a suite
        // re-queued on an image retention removed waits for its tree, or ends, as on docker.
        const images: ImagesAnswer = await deps.launcher!.prepare?.(
          imagesOf(suite),
          suite.updatedAt,
        ) ?? (await removedByRetention(suite)
          ? { kind: "gone", why: `retention removed ${suite.image} from the registry` }
          : { kind: "ready" });
        if (images.kind === "pulling") continue;
        const pullFailed = images.kind === "failed" ? images.why : undefined;
        const gone = images.kind === "gone" ? images.why : undefined;
        const launched = await launchOne(suite, pullFailed, gone).catch((err) => {
          diag.warn("checks.launch_failed", { id: suite.id, err: errText(err) });
          return false;
        });
        if (launched) {
          free -= need;
          held.set(repoId, holds + need);
        }
      }
      // Every repo left is at its share while another waits: the next tick, as slots free.
      if (!turned) break;
    }
  };

  // ---- telling -------------------------------------------------------------

  /**
   * Tells a run what a settled generation came to — once per run and suite generation. Marked
   * told only once the message is in (or there is no live run to tell): a post that threw is
   * tried again on the next tick. The note is informational, so the rare double a crash between
   * the two could cause is the cheap mistake.
   */
  const tell = async (request: CheckRequest): Promise<void> => {
    if (request.suiteId === null || request.runId === null || request.source.runId === null) return;
    const suite = await store.getSuite(request.suiteId);
    if (suite === null) return;
    const state = suite.state;
    if (state !== "passed" && state !== "failed" && state !== "error" && state !== "cancelled") {
      return;
    }
    const siblings = (await store.listRequestsForRun(request.runId)).filter((r) =>
      r.id !== request.id && r.suiteId === suite.id && r.state === "active"
    );
    const markTold = async () => {
      await store.markRequestReported(request.id, suite.generation);
      for (const sibling of siblings) await store.markRequestReported(sibling.id, suite.generation);
    };
    // A tool request and a patch request of one run on one head: one message, not two.
    if (siblings.some((s) => (s.reportedGeneration ?? 0) >= suite.generation)) {
      await markTold();
      return;
    }
    const run = await tasks.getRun(request.runId);
    if (run === null || isTerminal(run)) {
      await markTold();
      return;
    }
    const repo = await tasks.getConnectedRepo(suite.connectedRepoId);
    const results = await store.listResults(suite.id, suite.generation);
    const outcome = await postMessage(inboxDeps(), run, {
      kind: "system",
      sender: { kind: "platform" },
      text: composeCheckNote({
        suite,
        results,
        nonce: nonce(),
        repoRef: repo === null ? null : runFacingRepoName(repo),
        ...await imageNotesOf(suite),
      }),
      payload: {
        kind: "checks",
        suiteId: suite.id,
        state,
        path: request.source.path,
        commit: suite.commit,
        partial: isPartial(suite),
      },
    });
    // A refusal is the inbox's answer (the run ended meanwhile), and asking again changes nothing.
    if (outcome.kind === "refused") {
      diag.warn("checks.note_refused", { runId: run.id, suiteId: suite.id, err: outcome.error });
    }
    await markTold();
  };

  // ---- the forge -------------------------------------------------------------

  /** A patch's birth request, as `patchOpened` files it, read at the base its task's entry for
   * the repo names. Null when the task no longer carries that entry or the repo is gone. */
  const patchRequestOf = async (patch: Patch): Promise<CheckRequest | null> => {
    const task = await tasks.getTask(patch.taskId);
    const entry = task?.repos.find((r) =>
      r.connectedRepoId === patch.connectedRepoId && r.path === patch.path
    );
    const repo = await repoOf(patch.connectedRepoId);
    if (task === null || entry === undefined || repo === null) return null;
    return newRequest({
      kind: "patch",
      repo,
      commit: patch.headSha,
      runId: patch.runId,
      patchId: patch.id,
      source: {
        runId: patch.runId,
        path: entry.path,
        bundleKey: patch.bundleKey,
        branchName: patch.branchName,
        // Where the patch's own line is based: a line other than the default is not built on
        // the task's change request head (core/landing.ts `lineBase`).
        baseRef: lineBase(entry, task.landings, patch.line, patch.runId),
      },
      checksRef: checksRef(repo, entry),
    });
  };

  /** The base a patch's checks are read at: its newest request's, else as its birth would ask.
   * Null when even that cannot be told. */
  const patchChecksRef = async (
    patch: Pick<Patch, "id">,
    requests?: CheckRequest[],
  ): Promise<string | null> => {
    const asked = requests ?? await store.listRequestsForPatches([patch.id]);
    const recorded = asked.at(-1)?.checksRef;
    if (recorded !== undefined) return recorded;
    const whole = await tasks.getPatch(patch.id);
    return whole === null ? null : (await patchRequestOf(whole))?.checksRef ?? null;
  };

  /** A new forge row for one asker, due now. */
  const forgeRow = (fields: {
    patchId: string | null;
    requestId: string | null;
    connectedRepoId: string;
    headSha: string;
    checksRef: string;
  }): CheckForgeReport => {
    const at = nowIso();
    return {
      id: mintId("fr"),
      ...fields,
      suiteId: null,
      reportedFingerprint: null,
      attempts: 0,
      nextAttemptAt: at,
      lastError: null,
      disabledUntil: null,
      revision: 0,
      openGenerations: [],
      createdAt: at,
      updatedAt: at,
    };
  };

  /** A submitted patch's forge row, due now: inserted, or touched when it has one. A patch whose
   * base cannot be told gets none: no suite could be said to judge it. Nor does a patch on a
   * `local` repository: its forge has nowhere to post a check run, so its verdict lives in ryph
   * alone — the suite runs and settles off its request, and nothing reads a report row to wait
   * on. A row filed for one would only be refused, and refiled by the backstop, forever.
   * Whether a row was filed, so the backstop says so only when it did. */
  const queueReport = async (patch: Patch): Promise<boolean> => {
    const repo = await tasks.getConnectedRepo(patch.connectedRepoId);
    if (repo?.provider === "local") return false;
    const judge = await patchChecksRef(patch);
    if (judge === null) {
      diag.warn("checks.report_without_base", { patchId: patch.id });
      return false;
    }
    await store.upsertForgeReport(forgeRow({
      patchId: patch.id,
      requestId: null,
      connectedRepoId: patch.connectedRepoId,
      headSha: patch.headSha,
      checksRef: judge,
    }));
    return true;
  };

  /**
   * The backstop for the patch relays, which never throw: a recent patch whose birth request
   * never landed gets one, and a submitted one with no forge row gets its row. Bounded and cheap:
   * one page of the newest patches, those born a minute to a day ago while checks were on, one
   * read of their requests,
   * and a row lookup per submitted one.
   */
  const refilePatches = async (): Promise<void> => {
    const now = deps.now().getTime();
    const { patches } = await tasks.listPatches({ limit: PATCH_BACKSTOP_PAGE });
    const recent = patches.filter((p) => {
      const age = now - Date.parse(p.createdAt);
      return age >= PATCH_RELAY_GRACE_MS && age < PATCH_BACKSTOP_MS &&
        p.state !== "superseded" && p.state !== "rejected";
    });
    if (recent.length === 0) return;
    const asked = new Set(
      (await store.listRequestsForPatches(recent.map((p) => p.id))).map((r) => r.patchId),
    );
    // Only patches born while checks were on: since this service came up, or since the oldest of
    // these whose birth did file a request. A patch from before checks were turned on is never
    // filed, which would run, and report, checks on a change long merged; one whose relay a
    // restart cut short still is.
    const horizon = Math.min(
      upSince,
      ...recent.filter((p) => asked.has(p.id)).map((p) => Date.parse(p.createdAt)),
    );
    for (const patch of recent) {
      if (Date.parse(patch.createdAt) < horizon) continue;
      try {
        if (!asked.has(patch.id)) {
          const request = await patchRequestOf(patch);
          if (request !== null) {
            await store.createRequest(request);
            diag.warn("checks.patch_request_refiled", { patchId: patch.id });
          }
        }
        if (
          patch.state === "submitted" && await store.findForgeReport({ patchId: patch.id }) === null
        ) {
          if (await queueReport(patch)) diag.warn("checks.report_refiled", { patchId: patch.id });
        }
      } catch (err) {
        diag.warn("checks.refile_failed", { patchId: patch.id, err: errText(err) });
      }
    }
  };

  /** The requests behind one forge row: a patch's (its birth's, and any refiled), or the one
   * push request. */
  const askersOfRow = async (
    row: Pick<CheckForgeReport, "patchId" | "requestId">,
  ): Promise<CheckRequest[]> => {
    if (row.patchId !== null) return await store.listRequestsForPatches([row.patchId]);
    const request = row.requestId === null ? null : await store.getRequest(row.requestId);
    return request === null ? [] : [request];
  };

  /**
   * The suite a forge row's head is reported with: the one its asker asked for (`own`, and
   * remembered on the row) — a patch's birth request, or the push request — else, while that
   * request is still being read, or where there is none, the newest full suite on that head read
   * at the row's base, re-derived every time and never remembered: the asker's own suite, once
   * it has one, is the one its forge is told about.
   */
  const suiteForReport = async (
    row: Pick<
      CheckForgeReport,
      "suiteId" | "patchId" | "requestId" | "connectedRepoId" | "headSha" | "checksRef"
    >,
    read?: CheckRequest[],
  ): Promise<{ suite: CheckSuite; own: boolean } | null> => {
    if (row.suiteId !== null) {
      const suite = await store.getSuite(row.suiteId);
      return suite === null ? null : { suite, own: true };
    }
    const requests = read ?? await askersOfRow(row);
    const asked = requests.filter((r) => r.suiteId !== null).at(-1);
    if (asked !== undefined) {
      const suite = await store.getSuite(asked.suiteId!);
      if (suite !== null) return { suite, own: true };
    }
    // Only a suite judged by the base the asker's checks are read at: another base's verdict is
    // no answer about this change request. A partial suite says nothing about the whole head:
    // never an asker's, never reported.
    const newest = (await store.listSuitesForCommit(row.connectedRepoId, row.headSha))
      .find((suite) => !isPartial(suite) && suite.checksRef === row.checksRef);
    return newest === undefined ? null : { suite: newest, own: false };
  };

  const reportOne = async (row: CheckForgeReport): Promise<void> => {
    if (deps.remote != null) return;
    if (row.suiteId !== null && (await store.getSuite(row.suiteId))?.remote != null) return;
    const now = deps.now();
    const at = now.toISOString();
    /** What this report came to. The clock moves only if nothing touched the row since it was
     * read — a suite that moved during a slow forge call is reported again. */
    const save = (
      fields: Parameters<CheckStore["settleForgeReport"]>[1],
      nextAttemptAt: string | null,
    ) =>
      store.settleForgeReport(
        row.id,
        { ...fields, updatedAt: at },
        { nextAttemptAt, readRevision: row.revision, readSuiteId: row.suiteId },
      );
    if (row.disabledUntil !== null && row.disabledUntil > at) {
      await save({}, row.disabledUntil);
      return;
    }
    const requests = await askersOfRow(row);
    const found = await suiteForReport(row, requests);
    const reading = requests.some((r) => r.state === "pending");
    // A push request a newer push or the change request's close set aside: its head is no
    // longer the change request's. Its own suite is still reported as it moves — its settling,
    // a cancel usually, and a re-run's new generation — and the fingerprint below keeps a row
    // that already said that from saying it again. A row that only ever showed another suite of
    // the head stops with what it last posted.
    const setAside = row.requestId !== null && requests.length > 0 &&
      requests.every((r) => r.state === "superseded");
    if (setAside && (found === null || !found.own)) {
      await save({}, null);
      return;
    }
    if (found === null) {
      if (reading) {
        // Still being read at the base: nothing named yet to report.
        await save({}, new Date(now.getTime() + READ_RETRY_MS).toISOString());
        return;
      }
      // No checks here (or none could ever be read): nothing is posted, which leaves a
      // required check "expected" — the safe failure.
      await save({
        lastError: requests.find((r) => r.note !== null)?.note ?? "no checks for this head",
      }, null);
      return;
    }
    const { suite, own } = found;
    const suiteId = own ? suite.id : row.suiteId;
    const repo = await repoOf(suite.connectedRepoId);
    if (repo === null) {
      await save({ suiteId, lastError: "repo disconnected" }, null);
      return;
    }
    const results = await store.listResults(suite.id, suite.generation);
    // Which suite is part of what was said: a fallback that gives way to the patch's own is news.
    const fingerprint = `${suite.id}:${reportFingerprint(suite, results)}`;
    // A fallback is looked at again while the patch's own request is still being read.
    const recheck = own || !reading ? null : new Date(now.getTime() + READ_RETRY_MS).toISOString();
    if (fingerprint === row.reportedFingerprint) {
      await save({}, recheck);
      return;
    }
    const notes = await imageNotesOf(suite);
    const planned = planForgeReport(
      suite,
      results,
      config.appUrl,
      notes.setupUnfinished,
      notes.olderImage,
    );
    // Older generations of this suite the forge last heard of while they were going, or as
    // cancelled (which leaves a one-run-per-generation forge's run going): such a forge finishes
    // their runs now as failed, since no report of theirs will land. Only one known not to have
    // passed is named — its checks' results say so — for a pass whose settled report never
    // landed before a re-run would be called a failure; its run is better left going.
    const previous: number[] = [];
    const older = row.openGenerations.filter((o) =>
      o.suiteId === suite.id && o.generation < suite.generation
    );
    for (const generation of new Set(older.map((o) => o.generation))) {
      const own = await store.listResults(suite.id, generation);
      if (own.length > 0 && suiteVerdict(own) !== "passed") previous.push(generation);
    }
    previous.sort((a, b) => a - b);
    const report = previous.length === 0
      ? planned
      : { ...planned, suite: { ...planned.suite, previousGenerations: previous } };
    const outcome = await deps.forge!.reportChecks(forgeRepoRef(repo), report);
    if (outcome.kind === "reported") {
      for (const [name, ref] of Object.entries(outcome.refs)) {
        await store.setResultForgeRef(suite.id, suite.generation, name, ref);
      }
      // What this report leaves going, and nothing else: the older generations it named were
      // finished by it, and those it left out are left out for good. Only this suite's — a
      // report names generations of its own suite, never another's.
      const openGenerations = SETTLED_VERDICT.has(suite.state)
        ? []
        : [{ suiteId: suite.id, generation: suite.generation }];
      await save({
        suiteId,
        reportedFingerprint: fingerprint,
        attempts: 0,
        lastError: null,
        disabledUntil: null,
        openGenerations,
      }, recheck);
      diag.debug("checks.reported", { reportId: row.id, suiteId: suite.id, fingerprint });
      return;
    }
    if (outcome.kind === "unsupported") {
      const until = new Date(now.getTime() + UNSUPPORTED_BACKOFF_MS).toISOString();
      await save({ suiteId, disabledUntil: until, lastError: outcome.reason }, until);
      diag.warn("checks.report_unsupported", { reportId: row.id, reason: outcome.reason });
      return;
    }
    const attempts = row.attempts + 1;
    await save(
      { suiteId, attempts, lastError: outcome.message },
      outcome.terminal
        ? null
        : new Date(now.getTime() + backoff(attempts, REPORT_RETRY_MS, REPORT_RETRY_MAX_MS))
          .toISOString(),
    );
    diag.warn("checks.report_failed", {
      reportId: row.id,
      err: outcome.message,
      terminal: outcome.terminal,
    });
  };

  // ---- views -----------------------------------------------------------------

  /** The suite a patch is judged by, as its forge is told: its own, else its head's newest. */
  const judgedBy = async (
    patch: Pick<Patch, "id" | "connectedRepoId" | "headSha">,
  ): Promise<CheckSuite | null> => {
    const row = await store.findForgeReport({ patchId: patch.id });
    if (row !== null) return (await suiteForReport(row))?.suite ?? null;
    // Not submitted (or its row not filed yet): judged as its row would judge it.
    const requests = await store.listRequestsForPatches([patch.id]);
    const checksRef = await patchChecksRef(patch, requests);
    if (checksRef === null) return null;
    const found = await suiteForReport({
      suiteId: null,
      patchId: patch.id,
      requestId: null,
      connectedRepoId: patch.connectedRepoId,
      headSha: patch.headSha,
      checksRef,
    }, requests);
    return found?.suite ?? null;
  };

  /** `read`: what the caller has read already — the suite's requests, its generation's results
   * and its repo; whatever is missing is read here. */
  const viewOf = async (
    suite: CheckSuite,
    read: {
      requests?: CheckRequest[];
      results?: CheckResult[];
      repo?: ConnectedRepo | null;
    } = {},
  ): Promise<CheckSuiteView> => {
    const [results, asked, repo] = await Promise.all([
      read.results ?? store.listResults(suite.id, suite.generation),
      read.requests ?? store.listRequestsForSuite(suite.id),
      read.repo !== undefined ? read.repo : tasks.getConnectedRepo(suite.connectedRepoId),
    ]);
    const byName = new Map(results.map((r) => [r.name, r]));
    return {
      id: suite.id,
      connectedRepoId: suite.connectedRepoId,
      repoRef: repo?.repoRef ?? null,
      provider: repo?.provider ?? null,
      commit: suite.commit,
      checksRef: suite.checksRef,
      checksCommit: suite.checksCommit,
      checksBlob: suite.checksBlob,
      checksPath: suite.checksPath,
      environment: {
        key: suite.environmentKey,
        image: suite.image,
        environmentId: suite.environmentId,
      },
      state: suite.state,
      reason: suite.reason,
      generation: suite.generation,
      ryphChanged: suite.ryphChanged,
      createdAt: suite.createdAt,
      launchedAt: suite.launchedAt,
      finishedAt: suite.finishedAt,
      checks: suite.definition.checks.map((check) => {
        const result = byName.get(check.name);
        return {
          name: check.name,
          run: check.run,
          timeoutSeconds: check.timeoutSeconds ?? policy.defaultTimeoutSeconds,
          services: check.services,
          ...(check.pod === undefined ? {} : { pod: check.pod }),
          ...(check.size === undefined ? {} : { size: check.size }),
          state: result?.state ?? "queued",
          exitCode: result?.exitCode ?? null,
          startedAt: result?.startedAt ?? null,
          finishedAt: result?.finishedAt ?? null,
          logTail: result?.logTail ?? null,
          hasLog: suite.remote != null || (result?.logKey ?? null) !== null,
          watchedChanged: result?.watchedChanged ?? null,
          inherited: (result?.inheritedFrom ?? null) !== null,
        };
      }),
      // Superseded askers too: a run that moved on to a newer commit still lists what it asked.
      requestedBy: asked.filter((r) => r.state === "active" || r.state === "superseded")
        .map((r) => ({ kind: r.kind, runId: r.runId, patchId: r.patchId })),
      partial: isPartial(suite),
      detailsUrl: config.appUrl === null ? null : `${config.appUrl}/checks/${suite.id}`,
    };
  };

  /**
   * How the lists read suites for a reader under `scope`. Suites of one page share their askers,
   * so each run, task, patch and repo is read once, and a page's requests and results are two
   * reads, whatever its length; its runs, patches and tasks are three more (`preload`).
   */
  const listReader = (scope: Scope) => {
    const once = <T>(load: (id: string) => Promise<T>) => {
      const seen = new Map<string, Promise<T>>();
      const get = (id: string): Promise<T> => {
        let found = seen.get(id);
        if (found === undefined) seen.set(id, found = load(id));
        return found;
      };
      /** What a batch read already answered: that id is not read again. */
      const seed = (id: string, value: T) => {
        if (!seen.has(id)) seen.set(id, Promise.resolve(value));
      };
      return Object.assign(get, { seed });
    };
    const runOf = once((id) => tasks.getRun(id));
    const taskOf = once((id) => tasks.getTask(id, scope));
    const patchOf = once((id) => tasks.getPatch(id));
    const repoById = once((id) => tasks.getConnectedRepo(id));

    /** The runs, patches and tasks these requests name, in three reads rather than one per id.
     * The scope is applied here as `getTask` applies it in SQL, so a task outside it is a null
     * exactly as a single read would answer. */
    const preload = async (requests: CheckRequest[]): Promise<void> => {
      const named = requests.filter((r) => r.state === "active" || r.state === "superseded");
      const runIds = [...new Set(named.flatMap((r) => r.runId === null ? [] : [r.runId]))];
      const patchIds = [...new Set(named.flatMap((r) => r.patchId === null ? [] : [r.patchId]))];
      const [runs, patches] = await Promise.all([
        tasks.listRunsByIds(runIds),
        tasks.listPatchesByIds(patchIds),
      ]);
      const taskIds = [...new Set([...runs, ...patches].map((row) => row.taskId))];
      const rows = await tasks.listTasksByIds(taskIds);
      for (const run of runs) runOf.seed(run.id, run);
      for (const patch of patches) patchOf.seed(patch.id, patch);
      for (const { task } of rows) taskOf.seed(task.id, taskInScope(task, scope) ? task : null);
      for (const id of runIds) runOf.seed(id, null);
      for (const id of patchIds) patchOf.seed(id, null);
      for (const id of taskIds) taskOf.seed(id, null);
    };

    const runVisible = async (runId: string) => {
      const run = await runOf(runId);
      return run !== null && await taskOf(run.taskId) !== null;
    };
    const patchVisible = async (patchId: string) => {
      const patch = await patchOf(patchId);
      return patch !== null && await taskOf(patch.taskId) !== null;
    };

    /** `viewOf`, with `requestedBy` held to the tasks the reader may see: a re-run names
     * neither a run nor a patch, so it stays. */
    const held = async (
      suite: CheckSuite,
      read: { requests: CheckRequest[]; results?: CheckResult[] },
    ): Promise<CheckSuiteView> => {
      const full = await viewOf(suite, { ...read, repo: await repoById(suite.connectedRepoId) });
      const seen = await Promise.all(
        full.requestedBy.map(async (r) =>
          (r.runId === null || await runVisible(r.runId)) &&
          (r.patchId === null || await patchVisible(r.patchId))
        ),
      );
      return { ...full, requestedBy: full.requestedBy.filter((_, i) => seen[i]) };
    };

    /** `held`, less the log tails: only the suite page shows them. */
    const view = async (
      suite: CheckSuite,
      requests: CheckRequest[],
      results: CheckResult[],
    ): Promise<CheckSuiteView> => {
      const full = await held(suite, { requests, results });
      return { ...full, checks: full.checks.map((check) => ({ ...check, logTail: null })) };
    };

    const askersOf = async (suite: CheckSuite, requests: CheckRequest[]): Promise<CheckAsker[]> => {
      // Only a missing repo falls back, and only to how a label is spelled.
      const provider: ForgeProvider = (await repoById(suite.connectedRepoId))?.provider ?? "github";
      const out: CheckAsker[] = [];
      const add = (asker: CheckAsker) => {
        const known = out.some((o) =>
          o.kind === asker.kind && o.label === asker.label && o.href === asker.href
        );
        if (!known) out.push(asker);
      };
      // Who `viewOf`'s `requestedBy` names: superseded askers too.
      for (const r of requests) {
        if (r.state !== "active" && r.state !== "superseded") continue;
        if (r.kind === "tool" && r.runId !== null) {
          const run = await runOf(r.runId);
          const task = run === null ? null : await taskOf(run.taskId);
          if (task !== null) {
            // A run asking for checks was given its instructions, so its task has a title; the id
            // stands in only for a row that says otherwise.
            add({ kind: "tool", label: task.spec.title ?? task.id, href: `/tasks/${task.id}` });
          }
        } else if (r.kind === "patch" && r.patchId !== null) {
          const patch = await patchOf(r.patchId);
          const task = patch === null ? null : await taskOf(patch.taskId);
          if (patch === null || task === null) continue;
          const label = patch.forgeRef === null
            ? "Patch"
            : changeRequestLabel(provider, patch.forgeRef);
          add({ kind: "patch", label, href: patch.forgeUrl ?? `/tasks/${task.id}` });
        } else if (
          r.kind === "push" && isForgeSource(r.source) && r.source.changeRequest !== null
        ) {
          // Named as a patch's change request is, and linked to it on its forge.
          add({
            kind: "push",
            label: changeRequestLabel(provider, r.source.changeRequest),
            href: r.source.url,
          });
        } else if (r.kind === "local") {
          // The person, as they were named when they asked; their id when no name came.
          const who = r.source.runId === null ? r.source.askerName : undefined;
          add({ kind: "local", label: `${who ?? r.userId ?? "someone"} · local`, href: null });
        } else if (r.kind === "rerun") {
          add({ kind: "rerun", label: "Run again", href: null });
        } else if (r.kind === "forge") {
          // A re-run asked on the forge's own page — a local repository has none, so it never
          // files one; named all the same rather than miscalled GitHub.
          add({ kind: "forge", label: `Re-run on ${forgeName(provider)}`, href: null });
        }
      }
      return out;
    };

    /** A page of suites, as the list draws them. */
    const items = async (page: CheckSuite[]): Promise<CheckSuiteListItem[]> => {
      const [requests, results] = await Promise.all([
        store.listRequestsForSuites(page.map((suite) => suite.id)),
        store.listResultsForGenerations(
          page.map((suite) => ({ suiteId: suite.id, generation: suite.generation })),
        ),
      ]);
      const group = <T extends { suiteId: string | null }>(rows: T[]) => {
        const by = new Map<string, T[]>();
        for (const row of rows) {
          if (row.suiteId === null) continue;
          by.set(row.suiteId, [...by.get(row.suiteId) ?? [], row]);
        }
        return by;
      };
      const requestsOf = group(requests);
      const resultsOf = group(results);
      await preload(requests);
      return await Promise.all(page.map(async (suite) => {
        const asked = requestsOf.get(suite.id) ?? [];
        const [suiteView, askedBy] = await Promise.all([
          view(suite, asked, resultsOf.get(suite.id) ?? []),
          askersOf(suite, asked),
        ]);
        return {
          suite: suiteView,
          branch: suite.source.branchName === "" ? null : suite.source.branchName,
          askedBy,
        };
      }));
    };

    /** Suites with their log tails, as the suite page and the run page show them. */
    const views = async (suites: CheckSuite[]): Promise<CheckSuiteView[]> => {
      const requests = await store.listRequestsForSuites(suites.map((suite) => suite.id));
      await preload(requests);
      return await Promise.all(
        suites.map((suite) =>
          held(suite, { requests: requests.filter((r) => r.suiteId === suite.id) })
        ),
      );
    };

    return { items, views };
  };

  /**
   * The suite's requests a run may see, when it may read the suite; null when it may not. A
   * request is the run's to see when it is one of its own task's — a run of it asked, or a patch
   * of it — or, on a repo the task checks out, when it is about a commit already on the forge: a
   * change request's push, the forge's re-run, a patch that reached the forge. The run holds that
   * repo's code, so what checks printed on a commit everyone can fetch tells it nothing a clone
   * does not. Another task's `run_checks` or unpublished patch is that task's own unshipped
   * work, and a person's ask from their machine is theirs: neither is seen.
   */
  const readableByRun = async (
    suite: CheckSuite,
    run: Run,
    task: Task | null,
  ): Promise<CheckRequest[] | null> => {
    const held = task !== null &&
      task.repos.some((e) => e.connectedRepoId === suite.connectedRepoId);
    const visible: CheckRequest[] = [];
    for (const r of await store.listRequestsForSuite(suite.id)) {
      // Who asked, as `readable` and the list count them: active or superseded.
      if (r.state !== "active" && r.state !== "superseded") continue;
      if (r.runId === run.id || r.source.runId === run.id) {
        visible.push(r);
      } else if (r.kind === "push" || r.kind === "forge") {
        if (held) visible.push(r);
      } else if (r.kind === "patch" && r.patchId !== null) {
        const patch = await tasks.getPatch(r.patchId);
        if (
          patch !== null &&
          (patch.taskId === run.taskId || (held && patch.forgeRef !== null))
        ) visible.push(r);
      } else if (r.kind === "tool" && r.runId !== null) {
        const other = await tasks.getRun(r.runId);
        if (other !== null && other.taskId === run.taskId) visible.push(r);
      }
    }
    return visible.length === 0 ? null : visible;
  };

  /** One suite on one line: its state, then each check's. */
  const suiteSummary = async (suite: CheckSuite): Promise<string> => {
    const results = await store.listResults(suite.id, suite.generation);
    const byName = new Map(results.map((r) => [r.name, r]));
    return `suite ${suite.id} ${SUITE_WORDS[suite.state]}${
      suite.reason === null ? "" : ` (${suite.reason})`
    }: ${
      suite.definition.checks.map((c) =>
        `${c.name} ${resultWords(byName.get(c.name), c.timeoutSeconds ?? 0)}`
      ).join(", ")
    }`;
  };

  /** A settled suite as the inbox note says it, in at most `maxChars`; with less room than a
   * note needs, a line saying where to read it instead. */
  const settledNote = async (suite: CheckSuite, maxChars: number): Promise<string> => {
    if (maxChars < MIN_NOTE_CHARS) {
      return `Suite ${suite.id}'s full report did not fit here. Name its commit to see it ` +
        "alone, or save a check's log with ryph__check_log.";
    }
    const repo = await tasks.getConnectedRepo(suite.connectedRepoId);
    return composeCheckNote({
      suite,
      results: await store.listResults(suite.id, suite.generation),
      nonce: nonce(),
      repoRef: repo === null ? null : runFacingRepoName(repo),
      maxChars,
      ...await imageNotesOf(suite),
    });
  };

  /** The newest settled suite of these, newest first: a full one's verdict over a partial
   * one's, since only a full one stands for the commit, and a cancelled one only when nothing
   * else settled. */
  const newestVerdict = (suites: readonly CheckSuite[]): CheckSuite | undefined => {
    const settled = suites.filter((s) => TERMINAL_SUITE_STATES.has(s.state));
    const decided = settled.filter((s) => s.state !== "cancelled");
    return decided.find((s) => !isPartial(s)) ?? decided[0] ?? settled[0];
  };

  /** Who asked for a suite, as the agent reads it. */
  const askerWords = (requests: readonly CheckRequest[]): string => {
    const words = new Set<string>();
    for (const r of requests) {
      if (r.state === "refused") continue;
      if (r.kind === "push") words.add(`change request ${r.changeRequest ?? "?"}`);
      else if (r.kind === "patch") words.add("a patch");
      else if (r.kind === "tool") words.add("a run's ryph__run_checks");
      else if (r.kind === "forge") words.add("a re-run from the forge");
    }
    return words.size === 0 ? "" : ` (for ${[...words].join(", ")})`;
  };

  /**
   * The suites on each of `commits` a run may read, leaving out `shown`: a section per commit
   * that has any, its newest settled suite in full. A commit with none says so only when the
   * agent `named` it.
   */
  const commitSections = async (
    run: Run,
    commits: readonly RunCommit[],
    shown: ReadonlySet<string>,
    named: boolean,
    noteChars: number,
  ): Promise<string[]> => {
    const task = await tasks.getTask(run.taskId);
    const sections: string[] = [];
    for (const { path, commit } of commits.slice(0, MAX_STATUS_COMMITS)) {
      const entry = task?.repos.find((e) => e.path === path);
      if (entry === undefined || entry.connectedRepoId === null) {
        if (named) {
          sections.push(
            `${path} is not a connected repository of this run, so the platform runs no ` +
              "checks for it.",
          );
        }
        continue;
      }
      const where = `${path} at ${short(commit)}`;
      const found: Array<{ suite: CheckSuite; requests: CheckRequest[] }> = [];
      for (const suite of await store.listSuitesForCommit(entry.connectedRepoId, commit)) {
        if (shown.has(suite.id)) continue;
        const requests = await readableByRun(suite, run, task);
        if (requests !== null) found.push({ suite, requests });
        if (found.length === MAX_COMMIT_SUITES) break;
      }
      if (found.length === 0) {
        if (named) sections.push(`No checks have run on ${where}.`);
        continue;
      }
      const lines = [
        named
          ? `Checks on ${where}, newest first:`
          : `Checks on ${where}, the checked-out head, that this run did not ask for, newest ` +
            "first:",
        "",
      ];
      for (const { suite, requests } of found) {
        const only = isPartial(suite)
          ? ` (only ${suite.definition.checks.map((c) => c.name).join(", ")})`
          : "";
        lines.push(`- ${await suiteSummary(suite)}${only}${askerWords(requests)}.`);
      }
      const newest = newestVerdict(found.map((f) => f.suite));
      if (newest !== undefined) {
        const listed = lines.join("\n").length + 100;
        lines.push(
          "",
          "The newest settled suite there:",
          "",
          await settledNote(newest, noteChars - listed),
        );
      }
      sections.push(lines.join("\n"));
    }
    return sections;
  };

  /** What `statusForRun` says of the requests the run made itself, and the suites it named;
   * null when it made none. */
  const ownStatus = async (
    run: Run,
    noteChars: number,
  ): Promise<{ text: string; shown: Set<string> } | null> => {
    const requests = (await store.listRequestsForRun(run.id))
      .filter((r) => r.kind === "tool" || r.kind === "patch");
    if (requests.length === 0) return null;
    const lines = ["Checks this run asked for, newest first:", ""];
    const suites = new Map<string, CheckSuite>();
    const recent = [...requests].reverse().slice(0, 10);
    const fetched = new Map<string, CheckSuite | null>();
    for (const id of new Set(recent.map((r) => r.suiteId).filter((id) => id !== null))) {
      fetched.set(id, await store.getSuite(id));
    }
    // What a base declares, where a full suite of it shows: an ask not yet read (or refused)
    // that names every check is no subset either.
    const declaredAt = new Map<string, string[]>();
    for (const suite of fetched.values()) {
      if (suite !== null && !isPartial(suite)) {
        declaredAt.set(
          `${suite.connectedRepoId} ${suite.checksRef}`,
          suite.definition.checks.map((c) => c.name),
        );
      }
    }
    const everyCheck = (request: CheckRequest, names: string[] | undefined) =>
      names !== undefined && names.length === new Set(request.source.checks).size &&
      names.every((n) => request.source.checks!.includes(n));
    for (const request of recent) {
      const kind = request.kind === "tool" ? "ryph__run_checks" : "patch";
      const asked = request.suiteId === null ? null : fetched.get(request.suiteId) ?? null;
      // Naming every check is asking for all of them: the suite is the full one then.
      const subset = asked === null
        ? !everyCheck(
          request,
          declaredAt.get(`${request.connectedRepoId} ${request.checksRef}`),
        )
        : isPartial(asked);
      const only = request.source.checks?.length && subset
        ? `, only ${request.source.checks.join(", ")}`
        : "";
      const at = `${short(request.commit)} (${kind}${only})`;
      // One replaced after it settled keeps its verdict; one replaced while going was cancelled.
      const kept = asked !== null && asked.state !== "cancelled" &&
        TERMINAL_SUITE_STATES.has(asked.state);
      if (request.state === "superseded" && !kept) {
        lines.push(`- ${at}: replaced by a newer request.`);
      } else if (request.state === "refused") {
        lines.push(`- ${at}: no checks ran: ${request.note}.`);
      } else if (request.suiteId === null) {
        lines.push(
          `- ${at}: reading .ryph/checks.yml on ${request.checksRef}${
            request.note === null ? "" : ` (${request.note}; retrying)`
          }.`,
        );
      } else {
        const suite = asked;
        if (suite === null) continue;
        suites.set(suite.id, suite);
        lines.push(`- ${at}: ${await suiteSummary(suite)}.`);
      }
    }
    const newestSettled = [...requests].reverse()
      .map((r) => r.suiteId === null ? undefined : suites.get(r.suiteId))
      .find((s) => s !== undefined && TERMINAL_SUITE_STATES.has(s.state));
    if (newestSettled !== undefined) {
      const listed = lines.join("\n").length + 100;
      lines.push(
        "",
        "The newest settled suite:",
        "",
        await settledNote(newestSettled, noteChars - listed),
      );
    }
    // Every suite the run asked for, listed or not: none is shown again as someone else's.
    const shown = new Set(requests.flatMap((r) => r.suiteId === null ? [] : [r.suiteId]));
    return { text: lines.join("\n"), shown };
  };

  /** A re-run a forge's button asked for. The suite id came off the forge (or off what we told
   * it), so it re-runs only while it is a whole suite on the repo and head the delivery names. */
  const rerunForForge = async (
    suiteId: string,
    input: { connectedRepoId: string; headSha: string; deliveryId: string },
    check?: string,
  ): Promise<boolean> => {
    const suite = await store.getSuite(suiteId);
    if (
      suite === null || suite.connectedRepoId !== input.connectedRepoId ||
      suite.commit !== input.headSha || isPartial(suite)
    ) return false;
    const outcome = await service.rerun(suite.id, {
      kind: "forge",
      deliveryId: input.deliveryId,
      ...(check === undefined ? {} : { check }),
    });
    return outcome.kind === "rerun";
  };

  const service: ChecksService = {
    remote: deps.remote != null,
    async delegationFile(repo, base) {
      if (deps.remote != null || !active || deps.forge === null) {
        return { kind: "unavailable", detail: "this deployment cannot receive check delegations" };
      }
      return await deps.forge.readChecksFile(forgeRepoRef(repo), repo.url, localJudge(repo, base));
    },
    async delegationSnapshot(id, userId) {
      const request = await store.getRequest(id);
      if (
        request === null || request.kind !== "local" || request.userId !== userId ||
        request.source.runId !== null || request.source.delegationId === undefined
      ) return null;
      const suite = request.suiteId === null ? null : await store.getSuite(request.suiteId);
      return {
        requestId: request.id,
        suite,
        results: suite === null ? [] : await store.listResults(suite.id, suite.generation),
        ...(request.note === null ? {} : { note: request.note }),
        refused: request.state === "refused" || request.state === "superseded",
      };
    },
    async cancelDelegation(id, userId) {
      const request = await store.getRequest(id);
      if (
        request === null || request.kind !== "local" || request.userId !== userId ||
        request.source.runId !== null || request.source.delegationId === undefined
      ) return false;
      await withdraw([request], "the sending deployment withdrew its delegation");
      return true;
    },
    enabled,
    refusedReason,
    changeRequests: active && policy.changeRequests && deps.remote == null,
    local: active && policy.local,
    approvals: {
      claimApproval: (approval) => store.claimApproval(approval),
      getApproval: (id) => store.getApproval(id),
      listApprovals: (repoId, changeRequest) => store.listApprovals(repoId, changeRequest),
      saveApprovalIf: (approval, states) => store.saveApprovalIf(approval, states),
      claimApprovalComment: (id, claim) => store.claimApprovalComment(id, claim),
      releaseApprovalComment: (id, at) => store.releaseApprovalComment(id, at),
    },

    async requestForRun(run, input) {
      const answer = (status: RunChecksAnswer["status"], text: string): RunChecksAnswer => ({
        status,
        suiteId: null,
        state: null,
        reused: false,
        text,
      });
      if (!active) return answer(200, offText());
      if (isTerminal(run)) return answer(409, `run is terminal (${run.state})`);
      const task = await tasks.getTask(run.taskId);
      if (task === null) return answer(409, "the run's task no longer resolves");
      const entry = task.repos.find((r) => r.path === input.path);
      if (entry === undefined) return answer(400, `this run checks out no repo at ${input.path}`);
      if (entry.connectedRepoId === null) return answer(400, legacyRefusal(entry));
      const repo = await repoOf(entry.connectedRepoId);
      if (repo === null) return answer(400, `${input.path}'s repo is no longer connected to ryph`);
      const shipped = parseLineBranch(input.branch, run.branchNamespace);
      if (shipped === null) {
        return answer(
          400,
          `${input.branch} is not one of this run's branches in ${input.path} ` +
            `(${run.branchNamespace}/<line>)`,
        );
      }
      // A fork pull request's head ships its default line alone, onto that pull request
      // (core/open_patch.ts): another line's branch is not one a check may judge either.
      if (entry.forkHead === true && shipped.line !== DEFAULT_LINE) {
        return answer(
          400,
          `${input.path} is a pull request from a fork, so this run ships only its line ` +
            `"${DEFAULT_LINE}" there, never "${shipped.line}"`,
        );
      }
      const asked = await store.countToolRequestsForRun(run.id);
      if (asked >= policy.maxPerRun) {
        return answer(
          429,
          `this run has asked for checks ${asked} times, the most one run may ` +
            "(RYPH_CHECKS_MAX_PER_RUN); the patch's own checks still run when you submit",
        );
      }
      const branch = input.branch.replace(/^refs\/heads\//, "");
      const request = newRequest({
        kind: "tool",
        repo,
        commit: input.headSha,
        runId: run.id,
        patchId: null,
        source: {
          runId: run.id,
          path: entry.path,
          // Derived, never taken from the caller: intake files a bundle at exactly this key.
          bundleKey: runBundleKey(run.id, repo.id, shipped, input.headSha),
          branchName: branch,
          baseRef: lineBase(entry, task.landings, shipped.line, run.id),
          ...(input.checks === undefined || input.checks.length === 0
            ? {}
            : { checks: [...new Set(input.checks)] }),
        },
        checksRef: checksRef(repo, entry),
      });
      // The tick leaves it alone while this call resolves it, and picks it up if this replica
      // dies first.
      request.nextAttemptAt = new Date(deps.now().getTime() + TOOL_BACKSTOP_MS).toISOString();
      await store.createRequest(request);
      // The runner waits a bounded time for this answer, and the read at the base can take
      // minutes on a cold forge cache: past a few seconds the answer is "requested", and a
      // refusal found after that reaches the run as a message (`refuse`).
      const first = await resolveWithin(request);
      const supersede = (asked: CheckRequest) =>
        supersedeEarlier(asked).catch((err) =>
          diag.warn("checks.supersede_failed", { requestId: request.id, err: errText(err) })
        );
      if (first === null || first.lost === true) {
        // Still being read (or the tick got there first): requested, and the result is a
        // message. The earlier ask is replaced now — its suite survives if this one turns out
        // to be the same, since a pending ask of its head keeps it (`cancelUnwanted`).
        await supersede(request);
        return {
          status: 202,
          suiteId: null,
          state: null,
          reused: false,
          text: requestedText({
            request: { ...request, note: null },
            suite: null,
            reused: false,
            repoRef: runFacingRepoName(repo),
            reading: true,
          }),
        };
      }
      const resolved = first;
      await supersede(resolved.request);
      const suite = resolved.suite;
      let text = requestedText({ ...resolved, repoRef: runFacingRepoName(repo) });
      if (suite !== null && TERMINAL_SUITE_STATES.has(suite.state)) {
        // Already settled — a dedupe hit: the answer is here, and no message repeats it.
        await store.markRequestReported(resolved.request.id, suite.generation);
        const results = await store.listResults(suite.id, suite.generation);
        text = `${text}\n\n${
          composeCheckNote({
            suite,
            results,
            nonce: nonce(),
            repoRef: runFacingRepoName(repo),
            ...await imageNotesOf(suite),
          })
        }`;
      }
      return {
        status: resolved.request.state === "refused" ? 200 : 202,
        suiteId: suite?.id ?? null,
        state: suite?.state ?? null,
        reused: resolved.reused,
        text: text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text,
      };
    },

    async patchOpened(patch) {
      if (!active) return;
      try {
        const request = await patchRequestOf(patch);
        if (request !== null) await store.createRequest(request);
      } catch (err) {
        diag.warn("checks.patch_request_failed", { patchId: patch.id, err: errText(err) });
      }
    },

    async patchSubmitted(patch) {
      if (!active) return;
      await queueReport(patch).catch((err) =>
        diag.warn("checks.report_queue_failed", { patchId: patch.id, err: errText(err) })
      );
    },

    async changeRequestPushed(push, confirm = () => Promise.resolve({ live: push.baseRef })) {
      if (!service.changeRequests) return "off";
      const repo = await repoOf(push.connectedRepoId);
      if (repo === null) return "off";
      // The base as a branch of the repo, by the rules every other ask follows: anything else
      // is judged by the default branch.
      const judge = checksRef(repo, { url: repo.url, ref: push.baseRef });
      // The head still live, and at a base judged as this push's: a retarget that kept the head
      // between the two reads makes this ask one of a base the change request no longer has,
      // and the retarget's own delivery asks at the new one.
      const confirmed = async (): Promise<"live" | "stale" | "unknown"> => {
        const again = await confirm();
        if (again === "stale" || again === "unknown") return again;
        return checksRef(repo, { url: repo.url, ref: again.live }) === judge ? "live" : "stale";
      };
      // The caller read the change request live and this IS its head: every other live ask of it
      // is of a head it moved on from, or of a base it no longer has.
      const replaced = "a newer push to the change request replaced it";
      const live = await livePushes(repo.id, push.ref);
      const same = live.find((r) => r.commit === push.headSha && r.checksRef === judge);
      if (same !== undefined) {
        // A redelivery, a retry of a call that failed half way, or an edit that moved nothing:
        // the request stands. Its row is filed again in case the first one never landed — a
        // touch, when it did — and, once the head is confirmed still live, any other ask of the
        // change request still live goes.
        await store.upsertForgeReport(forgeRow({
          patchId: null,
          requestId: same.id,
          connectedRepoId: repo.id,
          headSha: same.commit,
          checksRef: same.checksRef,
        }));
        const still = await confirmed();
        if (still === "stale") {
          await withdraw([same], "the change request moved on before its checks were asked");
          return "stale";
        }
        if (still === "unknown") return "unknown";
        await withdraw(live.filter((r) => r.id !== same.id), replaced);
        return "unchanged";
      }
      const source: ForgeSource = {
        runId: null,
        changeRequest: push.ref,
        fetchRef: push.fetchRef,
        branchName: changeRequestBranch(repo.provider, push.ref),
        baseRef: judge,
        url: push.url,
      };
      const request = newRequest({
        kind: "push",
        repo,
        commit: push.headSha,
        runId: null,
        patchId: null,
        source,
        checksRef: judge,
      });
      // The new ask lands before the old ones go, so a suite they share is never cancelled
      // between the two (`cancelUnwanted` keeps a suite a pending ask may resolve to).
      await store.createRequest(request);
      // The head is on the forge already, so its checks are posted as soon as they are named.
      await store.upsertForgeReport(forgeRow({
        patchId: null,
        requestId: request.id,
        connectedRepoId: repo.id,
        headSha: push.headSha,
        checksRef: judge,
      }));
      // Is this still the live head? A slow delivery of an older head, handled after a newer
      // one, finds out here, before it has withdrawn anything: its own request goes, and what
      // stood stays. A read that did not answer leaves everything as it is for the retry.
      const still = await confirmed();
      if (still === "stale") {
        await withdraw([request], "the change request moved on before its checks were asked");
        return "stale";
      }
      if (still === "unknown") return "unknown";
      // What stood before this call is replaced. Then a look again, now that this one is in: a
      // delivery handled beside this one may have filed its own, and one rule, whichever call
      // applies it, decides which of the two stands.
      await withdraw(live, replaced);
      const after = await livePushes(repo.id, push.ref);
      const standing = keptPush(after);
      const losers = after.filter((r) => r.id !== standing?.id);
      await withdraw(losers, replaced);
      diag.debug("checks.push_requested", {
        requestId: request.id,
        changeRequest: push.ref,
        superseded: live.length + losers.length,
      });
      return standing?.id === request.id ? "checks-requested" : "unchanged";
    },

    async declaresChecks(connectedRepoId, baseRef) {
      const repo = await repoOf(connectedRepoId);
      if (repo === null || (deps.forge === null && deps.remote == null)) return "no";
      const judge = checksRef(repo, { url: repo.url, ref: baseRef });
      const file = deps.remote != null
        ? await deps.remote.readChecksFile(repo, judge)
        : await deps.forge!.readChecksFile(forgeRepoRef(repo), repo.url, judge);
      if (file.kind === "unavailable") return "unknown";
      if (file.kind === "invalid" && file.commit === null) return "no";
      return file.kind === "absent" ? "no" : "yes";
    },

    async changeRequestEnded({ connectedRepoId, ref, exceptHead, onlyHead }) {
      if (!active) return;
      const live = (await livePushes(connectedRepoId, ref))
        .filter((r) =>
          r.commit !== exceptHead && (onlyHead === undefined || r.commit === onlyHead)
        );
      await withdraw(
        live,
        exceptHead !== undefined
          ? "one of ryph's patches moved the change request on"
          : onlyHead !== undefined
          ? "its head is no longer the change request's"
          : "its change request was merged or closed",
      );
    },

    async requestLocal(input) {
      if (!service.local) return { kind: "off" };
      const { repo, user } = input;
      const judge = localJudge(repo, input.base);
      const checks = input.checks === undefined || input.checks.length === 0
        ? undefined
        : [...new Set(input.checks)];
      if (input.delegationId !== undefined) {
        // Delegation ids remain idempotent after cancellation, refusal and expiry. A sender
        // recovering an uncertain response a day later must discover the original waiter,
        // never create fresh execution under an expired idempotency key.
        const prior = (await store.listRequestsForCommit(repo.id, input.commit)).filter((r) =>
          r.kind === "local" && r.userId === user.userId && r.source.runId === null &&
          r.source.delegationId === input.delegationId && r.source.branchName === input.branch &&
          r.checksRef === judge && sameChecks(r.source.checks, checks)
        );
        const existing = prior.find((r) => r.state === "active" || r.state === "pending") ??
          prior[0];
        if (existing !== undefined) {
          return {
            kind: "requested",
            request: existing,
            suite: existing.suiteId === null ? null : await store.getSuite(existing.suiteId),
          };
        }
      }
      if (!input.bundled) {
        // A commit named by id is fetched by id, and the forge's cache holds every fork's: only
        // the branch's live head is the person's to ask about. Anything else — a stranger's
        // commit, one pushed over since — is refused before anything is filed.
        const head = await deps.forge!.readBranchHead(forgeRepoRef(repo), repo.url, input.branch);
        if (head.kind === "unavailable") {
          return {
            kind: "refused",
            status: 503,
            error: `the forge could not say what ${input.branch} points at (${head.error}); ` +
              "try again",
          };
        }
        if (head.kind === "unsupported") {
          return {
            kind: "refused",
            status: 409,
            code: "not-branch-head",
            error: `${repo.repoRef}'s forge cannot prove a pushed branch's head; upload a bundle`,
          };
        }
        if (head.kind === "absent" || head.sha !== input.commit) {
          return {
            kind: "refused",
            status: 409,
            code: "not-branch-head",
            error: `${input.commit} is not the head of ${input.branch} on the forge; push it, ` +
              "or upload a bundle",
          };
        }
      }
      const nowMs = deps.now().getTime();
      const live = await store.listLiveLocalRequests(user.userId);
      const sameDelegation = (r: CheckRequest) =>
        (r.source.runId === null ? r.source.delegationId : undefined) === input.delegationId;
      const onBranch = live.filter((r) =>
        r.connectedRepoId === repo.id && r.source.branchName === input.branch && sameDelegation(r)
      );
      // The same pushed ask again — a retry, a second terminal, a hook — answers the one standing
      // and gives it another day, unless its day is over or its suite is no answer to a new ask
      // (`asksAgain`: cancelled, could not run, or failed): a new ask runs that again. The same
      // delegation again is the same sender request, so it always answers the one standing; a
      // new sender ask has an id of its own. An upload is always a new ask: each is a new bundle.
      // Only the branch's NEWEST-filed ask is answered so: one filed after it is a newer ask,
      // which this call must neither undo nor withdraw, so it files its own and the rule below
      // decides. What it withdraws here is only ever older than what it answers.
      const order = (a: CheckRequest, b: CheckRequest) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      const newest = [...onBranch].sort(order).at(-1);
      const same = (input.bundled && input.delegationId === undefined) || newest === undefined
        ? undefined
        : newest;
      if (
        same !== undefined && same.commit === input.commit && same.checksRef === judge &&
        sameChecks(same.source.checks, checks) &&
        (input.delegationId !== undefined || isForgeSource(same.source)) &&
        (same.expiresAt === null || Date.parse(same.expiresAt) > nowMs)
      ) {
        const suite = same.suiteId === null ? null : await store.getSuite(same.suiteId);
        if (input.delegationId !== undefined || suite === null || !asksAgain(suite, true)) {
          const renewed = await store.extendRequest(
            same.id,
            new Date(nowMs + LOCAL_REQUEST_TTL_MS).toISOString(),
          );
          if (renewed !== null) {
            await withdraw(onBranch.filter((o) => o.id !== same.id), "a newer ask on its branch");
            return { kind: "requested", request: renewed, suite };
          }
        }
        // Not renewed: it moved on meanwhile (a newer ask on the branch withdrew it, and maybe
        // cancelled its suite with it), or its suite cannot answer. A live ask filed after it is
        // the branch's now, and the answer; with none, this ask is filed after all.
        const later = (await store.listLiveLocalRequests(user.userId))
          .filter((r) =>
            r.connectedRepoId === repo.id && r.source.branchName === input.branch &&
            sameDelegation(r) &&
            order(r, same) > 0
          ).sort(order).at(-1);
        if (later !== undefined) {
          const laterSuite = later.suiteId === null ? null : await store.getSuite(later.suiteId);
          return { kind: "requested", request: later, suite: laterSuite };
        }
      }
      // Counted as it will stand once the branch's other asks are replaced: re-asking on one
      // branch never trips it.
      const inFlight = await localInFlight(live, repo.id, input.branch, input.delegationId);
      if (inFlight >= policy.maxLocalPerUser) {
        return { kind: "quota", live: inFlight, max: policy.maxLocalPerUser };
      }
      const extras = {
        ...(checks === undefined ? {} : { checks }),
        askerName: user.name,
        ...(input.delegationId === undefined ? {} : {
          delegationId: input.delegationId,
          ...(input.retryFailed ? { retryFailed: true } : {}),
        }),
      };
      const source: CheckSource = input.bundled
        ? {
          runId: null,
          userId: user.userId,
          bundleKey: await localBundleKey(user.userId, input.branch, judge, repo.id, input.commit),
          branchName: input.branch,
          baseRef: judge,
          ...extras,
        }
        : {
          runId: null,
          changeRequest: null,
          fetchRef: `refs/heads/${input.branch}`,
          branchName: input.branch,
          baseRef: judge,
          url: null,
          ...extras,
        };
      const request = newRequest({
        kind: "local",
        repo,
        commit: input.commit,
        runId: null,
        patchId: null,
        source,
        checksRef: judge,
        userId: user.userId,
      });
      // The tick leaves it alone while this call resolves it, and picks it up if this replica
      // dies first.
      request.nextAttemptAt = new Date(nowMs + TOOL_BACKSTOP_MS).toISOString();
      // The new ask lands before the old ones go, so a suite they share is never cancelled
      // between the two.
      await store.createRequest(request);
      // The cap again, now that this ask is filed and counts: asks on two branches side by side
      // each see the other's, so they cannot both slip under it. Over it, this ask is taken back
      // before it replaces anything.
      const others = await localInFlight(
        await store.listLiveLocalRequests(user.userId),
        repo.id,
        input.branch,
        input.delegationId,
      );
      if (others >= policy.maxLocalPerUser) {
        await withdraw([request], "it was over the person's cap of local asks");
        return { kind: "quota", live: others, max: policy.maxLocalPerUser };
      }
      await withdraw(onBranch, "a newer ask on its branch replaced it");
      // Then a look again, now that this one is in: an ask on the branch made beside this one
      // may have filed its own unseen. The newest-filed stands (by time, then id), whichever
      // call applies the rule, so two calls side by side leave the same one.
      const after = (await store.listLiveLocalRequests(user.userId))
        .filter((r) =>
          r.connectedRepoId === repo.id && r.source.branchName === input.branch && sameDelegation(r)
        )
        .sort(order);
      const standing = after.at(-1);
      await withdraw(
        after.filter((r) => r.id !== standing?.id),
        "a newer ask on its branch replaced it",
      );
      diag.debug("checks.local_requested", {
        requestId: request.id,
        userId: user.userId,
        superseded: onBranch.length + after.length - 1,
      });
      if (standing !== undefined && standing.id !== request.id) {
        // Another call's ask is the branch's now: that one is the answer.
        const suite = standing.suiteId === null ? null : await store.getSuite(standing.suiteId);
        return { kind: "requested", request: standing, suite };
      }
      // Read at the base here when the forge answers in a few seconds; otherwise on the tick,
      // and the person's client polls the request.
      await resolveWithin(request);
      const stood = await store.getRequest(request.id) ?? request;
      const suite = stood.suiteId === null ? null : await store.getSuite(stood.suiteId);
      return { kind: "requested", request: stood, suite };
    },

    async localUploads(userId) {
      const since = new Date(deps.now().getTime() - 60 * 60_000).toISOString();
      return {
        used: await store.countLocalUploadsSince(userId, since),
        max: policy.maxUploadsPerHour,
      };
    },

    async claimLocalUpload(userId, connectedRepoId) {
      const id = mintId("lu");
      await store.recordLocalUpload({ id, userId, connectedRepoId, at: nowIso() });
      const { used, max } = await service.localUploads(userId);
      if (used <= max) return { ok: true, used, max };
      await store.deleteLocalUpload(id);
      return { ok: false, used: used - 1, max };
    },

    async localQuota(userId, connectedRepoId, branch, delegationId) {
      const live = await store.listLiveLocalRequests(userId);
      return {
        live: await localInFlight(live, connectedRepoId, branch, delegationId),
        max: policy.maxLocalPerUser,
      };
    },

    async stageLocalBundle({ user, repo, branch, base }, body) {
      // The base the ask will be judged by (`requestLocal`'s), which the key is filed under.
      const baseRef = localJudge(repo, base);
      const outcome = await deps.forge!.stageCheckBundle(forgeRepoRef(repo), repo.url, {
        connectedRepoId: repo.id,
        userId: user.userId,
        branchName: branch,
        baseRef,
      }, body);
      // The key is derived here, never taken from the answer: one the forge filed anywhere
      // else is a forge this does not understand.
      if (
        outcome.kind === "staged" &&
        outcome.bundleKey !==
          await localBundleKey(user.userId, branch, baseRef, repo.id, outcome.headSha)
      ) {
        diag.warn("checks.local_bundle_misfiled", { bundleKey: outcome.bundleKey });
        return { kind: "unavailable", error: "the forge filed the bundle somewhere unexpected" };
      }
      return outcome;
    },

    async localRequest(id) {
      const request = await store.getRequest(id);
      return request !== null && request.kind === "local" ? request : null;
    },

    async readable(suiteId, scope) {
      const suite = await store.getSuite(suiteId);
      if (suite === null) return false;
      if (scope.kind === "all") return true;
      const requests = await store.listRequestsForSuite(suiteId);
      // Who `requestedBy` and the list's `asked` filter count: active or superseded.
      const asked = requests.filter((r) => r.state === "active" || r.state === "superseded");
      if (asked.some((r) => r.kind === "local" && r.userId === scope.userId)) return true;
      if (
        scope.writableRepoIds.includes(suite.connectedRepoId) &&
        requests.some((r) => r.kind === "push" || r.kind === "local")
      ) return true;
      for (const taskId of await service.taskIdsOf(suiteId)) {
        if (await tasks.getTask(taskId, scope) !== null) return true;
      }
      return false;
    },

    async rerun(suiteId, by) {
      if (!active) return { kind: "refused", status: 409, why: offText() };
      const suite = await store.getSuite(suiteId);
      if (suite === null) return { kind: "refused", status: 404, why: "no such check suite" };
      // Any settled suite, passed included: the forge offers Re-run on a green check too.
      if (!TERMINAL_SUITE_STATES.has(suite.state)) {
        return {
          kind: "refused",
          status: 409,
          why: `the suite is ${suite.state}; only a settled suite re-runs`,
        };
      }
      const repo = await tasks.getConnectedRepo(suite.connectedRepoId);
      const asker = (fields: Partial<CheckRequest>): CheckRequest | null =>
        repo === null ? null : {
          ...newRequest({
            kind: by.kind === "user" ? "rerun" : "forge",
            repo,
            commit: suite.commit,
            runId: null,
            patchId: null,
            // A partial suite read again asks for the same checks.
            source: isPartial(suite)
              ? { ...suite.source, checks: suite.definition.checks.map((c) => c.name) }
              : suite.source,
            checksRef: suite.checksRef,
          }),
          note: by.kind === "user" ? `re-run by ${by.userId}` : `re-requested (${by.deliveryId})`,
          ...fields,
        };
      const retired = await imageGone(suite);
      if (retired) await imageMissing(suite);
      if (retired || servicesRefused(suite)) {
        // Its services are part of what it is, and so is an image keyed on itself: a re-run
        // reads the base again, as a new ask would, and is a different suite if what it
        // resolves to changed.
        const request = asker({ rerunOf: suite.id });
        if (request === null) {
          return { kind: "refused", status: 409, why: "its repo is no longer connected" };
        }
        await store.createRequest(request);
        // Where it lands on another suite, `resolve` moves the old one's askers onto it — here,
        // or on the tick once a read that failed succeeds.
        const resolved = await resolve(request, { answered: false });
        if (resolved.suite !== null && resolved.suite.id !== suite.id) {
          return { kind: "rerun", suite: resolved.suite };
        }
        if (resolved.suite === null && resolved.request.state === "refused") {
          return { kind: "refused", status: 409, why: resolved.request.note ?? "no checks" };
        }
        return {
          kind: "refused",
          status: 409,
          why: resolved.suite === null
            ? `${
              resolved.request.note ?? ".ryph/checks.yml could not be read yet"
            }. It is tried again on its own`
            : retired
            ? "its environment image is no longer on this machine, and nothing newer is ready to run it in yet"
            : `its services still cannot be resolved: ${suite.reason ?? "see the suite"}`,
        };
      }
      // The ask lands before the generation it asks for: a release sweep between the two would
      // otherwise find the new generation with nobody asking, and cancel it. It names that
      // generation (`reportedGeneration`), which is how a wait on a failed build knows a re-run
      // asked for a build of its own (`rerunWaitingSince`).
      const request = asker({
        suiteId: suite.id,
        state: "active",
        reportedGeneration: suite.generation + 1,
        nextAttemptAt: null,
      });
      if (request !== null) await store.createRequest(request);
      // One check the suite still declares: the rest keep their passes. A name it does not declare
      // came off the forge stale or forged, and runs everything, as "Re-run all" would.
      const one = by.kind === "forge" ? by.check : undefined;
      const next = one !== undefined && suite.definition.checks.some((c) => c.name === one)
        ? await restart(suite, suite.source, { reuse: true, except: one })
        : await restart(suite);
      if (next === null) {
        if (request !== null) {
          await store.saveRequestIf({ ...request, state: "superseded" }, ["active"]);
        }
        return { kind: "refused", status: 409, why: "the suite moved on meanwhile; reload it" };
      }
      diag.debug("checks.rerun", { suiteId, generation: next.generation, by: by.kind });
      return { kind: "rerun", suite: await store.getSuite(suiteId) ?? next };
    },

    async forgeRerequested(input) {
      if (!active) return "no-such-suite";
      const named = parseCheckExternalId(input.externalId);
      if (named === null) return "no-such-suite";
      return await rerunForForge(named.suiteId, input, named.check)
        ? "checks-rerun"
        : "no-such-suite";
    },

    async forgeSuiteRerequested(input) {
      if (!active) return "no-such-suite";
      const rows = await store.listForgeReportsForCommit(input.connectedRepoId, input.headSha);
      // A row's own suite, when it has one: a re-run that moved it onto a new suite repoints it
      // at once, while its fingerprint names the old one until the next report lands. A row
      // with none showed another asker's suite, which leads its fingerprint. Two askers on one
      // head (a patch and its pull request's push) can name the same one.
      const suiteIds = new Set(
        rows.flatMap((r) =>
          r.suiteId !== null
            ? [r.suiteId]
            : r.reportedFingerprint === null
            ? []
            : [r.reportedFingerprint.split(":")[0]]
        ),
      );
      let rerun = false;
      for (const suiteId of suiteIds) {
        if (await rerunForForge(suiteId, input)) rerun = true;
      }
      return rerun ? "checks-rerun" : "no-such-suite";
    },

    async statusForRun(run, at) {
      if (!active) return { text: offText() };
      const named = at?.named === true;
      const commits = at?.commits ?? [];
      // A share of the message for each section that may carry a note in full, so the answer is
      // never cut through a fence.
      const noteChars = Math.floor(
        MAX_MESSAGE_CHARS / Math.max(1, (named ? 0 : 1) + commits.length),
      ) - 200;
      const own = named ? null : await ownStatus(run, noteChars);
      const others = await commitSections(run, commits, own?.shown ?? new Set(), named, noteChars);
      let parts: string[];
      if (named) {
        parts = others;
      } else if (own !== null) {
        parts = [own.text, ...others];
      } else if (others.length > 0) {
        parts = ["This run has asked for no checks itself.", ...others];
      } else {
        parts = [
          "This run has asked for no checks yet, and none have run on what its " +
          "repositories have checked out. ryph__run_checks runs the checks a repo's " +
          ".ryph/checks.yml declares at its base against your committed head. A patch's checks " +
          "run on their own when it is submitted. Pass `commit` to look up the checks on " +
          "another commit, such as a change request's head.",
        ];
      }
      return { text: withinMessage(parts) };
    },

    async logForRun(run, input) {
      if (!active) return { kind: "refused", status: 409, why: offText() };
      const gone = {
        kind: "refused" as const,
        status: 404 as const,
        why: `there is no check suite ${input.suiteId} this run may read`,
      };
      const suite = await store.getSuite(input.suiteId);
      if (suite === null) return gone;
      if (await readableByRun(suite, run, await tasks.getTask(run.taskId)) === null) return gone;
      const generation = input.generation ?? suite.generation;
      if (generation < 1 || generation > suite.generation) {
        return {
          kind: "refused",
          status: 404,
          why: `suite ${suite.id} has ${
            suite.generation === 1 ? "only generation 1" : `generations 1 to ${suite.generation}`
          }`,
        };
      }
      const names = suite.definition.checks.map((c) => c.name);
      if (!names.includes(input.check)) {
        return {
          kind: "refused",
          status: 404,
          why: `suite ${suite.id} runs no check named ${JSON.stringify(input.check)}; it runs ${
            names.join(", ")
          }`,
        };
      }
      const text = await service.log(suite.id, generation, input.check);
      if (text === null) {
        return {
          kind: "refused",
          status: 404,
          why: `${input.check} has no log in generation ${generation} of suite ${suite.id} ` +
            "yet: a log is kept once the check has run",
        };
      }
      return { kind: "log", text, generation };
    },

    async declaredForRun(run, withinMs = DECLARED_READ_MS) {
      if (!active || isTerminal(run)) return { declared: [], unread: [] };
      // One deadline for all: each repo's read races it on its own, so a slow repo costs only
      // itself, and is named in `unread`.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((done) => {
        timer = setTimeout(() => done("late"), withinMs);
      });
      /** The repo's checks; null when it answered with none; "unread" when it did not answer. */
      const readRepo = async (entry: RepoEntry): Promise<DeclaredChecks | null | "unread"> => {
        if (entry.connectedRepoId === null) return null;
        const repo = await repoOf(entry.connectedRepoId);
        if (repo === null) return null;
        const ref = checksRef(repo, entry);
        const file = await declaredRead(repo, ref);
        if (file.kind === "unavailable") return "unread";
        if (file.kind !== "file") return null;
        let parsed: ChecksDeclaration;
        try {
          parsed = parseChecksYaml(file.text);
        } catch {
          // Read, and not valid: an ask is refused with the reason, so there is nothing to list.
          return null;
        }
        if (parsed.checks.length === 0) return null;
        return {
          path: entry.path,
          // Shown to the agent in its prompt (runner checksBlock): never a host path.
          repoRef: runFacingRepoName(repo),
          checksRef: ref,
          setup: parsed.setup.map((step) => step.run),
          checks: parsed.checks.map((c) => ({
            name: c.name,
            run: c.run,
            timeoutSeconds: Math.min(
              c.timeoutSeconds ?? policy.defaultTimeoutSeconds,
              policy.maxTimeoutSeconds,
            ),
            services: c.services,
          })),
        };
      };
      try {
        const task = await Promise.race([tasks.getTask(run.taskId), late]);
        if (task === null || task === "late") return { declared: [], unread: [DECLARED_UNKNOWN] };
        const found = await Promise.all(
          task.repos.map(async (entry) => {
            const answer = await Promise.race([readRepo(entry), late]).catch((err) => {
              diag.warn("checks.declared_read_failed", {
                runId: run.id,
                path: entry.path,
                err: errText(err),
              });
              return "unread" as const;
            });
            return { path: entry.path, answer: answer === "late" ? "unread" as const : answer };
          }),
        );
        return {
          declared: found.flatMap(({ answer }) =>
            answer === null || answer === "unread" ? [] : [answer]
          ),
          unread: found.flatMap(({ path, answer }) => answer === "unread" ? [path] : []),
        };
      } catch (err) {
        diag.warn("checks.declared_failed", { runId: run.id, err: errText(err) });
        return { declared: [], unread: [DECLARED_UNKNOWN] };
      } finally {
        clearTimeout(timer);
      }
    },

    async view(suiteId, scope) {
      const suite = await store.getSuite(suiteId);
      if (suite === null) return null;
      const [view] = await listReader(scope).views([suite]);
      return view;
    },

    async branchOf(suiteId) {
      const suite = await store.getSuite(suiteId);
      return suite === null || suite.source.branchName === "" ? null : suite.source.branchName;
    },

    async taskIdsOf(suiteId) {
      const requests = await store.listRequestsForSuite(suiteId);
      const runIds = new Set(
        requests.flatMap((r) =>
          [r.source.runId, r.runId].filter((id): id is string => id !== null)
        ),
      );
      const patchIds = new Set(requests.flatMap((r) => r.patchId === null ? [] : [r.patchId]));
      const taskIds = new Set<string>();
      for (const id of runIds) {
        const run = await tasks.getRun(id);
        if (run !== null) taskIds.add(run.taskId);
      }
      for (const id of patchIds) {
        const patch = await tasks.getPatch(id);
        if (patch !== null) taskIds.add(patch.taskId);
      }
      // The task whose patch on this head the suite judges, as `viewsForTask` shows it there.
      const suite = await store.getSuite(suiteId);
      const head = suite === null
        ? null
        : await tasks.findPatchByRepoAndHead(suite.connectedRepoId, suite.commit);
      if (head !== null && (await judgedBy(head))?.id === suiteId) taskIds.add(head.taskId);
      return [...taskIds];
    },

    async list(query) {
      const page = await store.listSuites(query);
      return {
        items: await listReader(query.scope).items(page.suites),
        nextCursor: page.nextCursor,
      };
    },

    async latest({ connectedRepoId, checksRef, scope }) {
      const page = await store.listSuites({
        connectedRepoId,
        checksRef,
        full: true,
        limit: 1,
        scope,
      });
      const [item] = await listReader(scope).items(page.suites);
      return item?.suite ?? null;
    },

    async capacity() {
      return {
        // Pods, as the launch pass counts its slots (`slotsOf`).
        inUse: [...(await slotsOf(await store.listSuitesByState(["running"], QUEUED_PAGE)))
          .values()].reduce((n, slots) => n + slots, 0),
        total: active ? policy.maxConcurrent : 0,
      };
    },

    async declaredOnDefault(repos, withinMs = DECLARED_READ_MS) {
      if (!active) {
        const error = refusedReason === null
          ? "Checks are off on this instance."
          : `Checks cannot run on this instance: ${refusedReason}.`;
        return repos.map(() => ({ state: "unread", error }));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((done) => {
        timer = setTimeout(() => done("late"), withinMs);
      });
      const readRepo = async (repo: ConnectedRepo): Promise<RepoChecksFile> => {
        const file = await declaredRead(repo, repo.defaultBranch);
        if (file.kind === "unavailable") return { state: "unread", error: file.detail };
        if (file.kind === "absent") return { state: "none" };
        if (file.kind === "invalid") {
          return { state: "invalid", path: null, commit: file.commit, error: file.detail };
        }
        let parsed: ChecksDeclaration;
        try {
          parsed = parseChecksYaml(file.text);
        } catch (err) {
          return { state: "invalid", path: file.path, commit: file.commit, error: errText(err) };
        }
        // An empty list is no checks, as an absent file is.
        if (parsed.checks.length === 0) return { state: "none" };
        const podsNeeded = podsNeededOf(parsed);
        return {
          state: "declared",
          path: file.path,
          commit: file.commit,
          setup: parsed.setup.map((step) => step.run),
          podsNeeded,
          // Before anything is pushed: a full suite of this file would fail at launch. Not where
          // another deployment runs the checks: its limit is its own.
          ...(deps.remote == null && podsNeeded > policy.maxConcurrent
            ? { warning: `A full suite fails here: ${tooManyPods(podsNeeded)}.` }
            : {}),
          checks: parsed.checks.map((c) => ({
            name: c.name,
            run: c.run,
            timeoutSeconds: Math.min(
              c.timeoutSeconds ?? policy.defaultTimeoutSeconds,
              policy.maxTimeoutSeconds,
            ),
            services: c.services,
            watch: c.watch,
            ...(c.pod === undefined ? {} : { pod: c.pod }),
            ...(c.size === undefined ? {} : { size: c.size }),
          })),
        };
      };
      try {
        return await Promise.all(repos.map(async (repo): Promise<RepoChecksFile> => {
          const answer = await Promise.race([readRepo(repo), late]).catch((err) => {
            diag.warn("checks.default_read_failed", { repo: repo.repoRef, err: errText(err) });
            return { state: "unread" as const, error: "The forge could not be asked." };
          });
          return answer === "late"
            ? { state: "unread", error: "The forge did not answer in time." }
            : answer;
        }));
      } finally {
        clearTimeout(timer);
      }
    },

    async viewsForTask(_task, runs, patches, scope) {
      const requests = [
        ...(await Promise.all(runs.map((run) => store.listRequestsForRun(run.id)))).flat(),
        ...await store.listRequestsForPatches(patches.map((p) => p.id)),
      ];
      const ids = new Set(requests.flatMap((r) => r.suiteId === null ? [] : [r.suiteId]));
      // And the suite each patch is judged by, asked for elsewhere on its head or not: the one
      // the approver sees, and the forge is told. `taskIdsOf` names this task for it in turn.
      for (const patch of patches) {
        const judge = await judgedBy(patch);
        if (judge !== null) ids.add(judge.id);
      }
      return await listReader(scope).views(await store.listSuitesByIds([...ids]));
    },

    async forPatch(patch) {
      const found = await judgedBy(patch);
      return found === null ? null : await viewOf(found);
    },

    async suiteIdsForPatches(patches) {
      const ids: Record<string, string> = {};
      for (const patch of patches) {
        const found = await judgedBy(patch);
        if (found !== null) ids[patch.id] = found.id;
      }
      return ids;
    },

    async log(suiteId, generation, name) {
      const suite = await store.getSuite(suiteId);
      if (suite?.remote != null) {
        if (!suite.definition.checks.some((c) => c.name === name)) return null;
        const text = await remoteClient(suite.remote).log(suite.remote, generation, name);
        return text === null ? null : text.slice(-MAX_CHECK_LOG_BYTES);
      }
      const [result] = (await store.listResults(suiteId, generation)).filter((r) =>
        r.name === name
      );
      if (result === undefined || result.logKey === null) return null;
      const text = await deps.logs.get(result.logKey);
      if (text === null) return null;
      return text.length > MAX_CHECK_LOG_BYTES ? text.slice(-MAX_CHECK_LOG_BYTES) : text;
    },

    async gitGrant(tokenHash) {
      const key = await store.getCheckGitKeyByTokenHash(tokenHash);
      if (key === null || key.revokedAt !== null) return null;
      if (Date.parse(key.expiresAt) <= deps.now().getTime()) return null;
      const suite = await store.getSuite(key.suiteId);
      if (suite === null || suite.state !== "running" || suite.generation !== key.generation) {
        return null;
      }
      const repo = await repoOf(suite.connectedRepoId);
      if (repo === null) return null;
      let baseBranch: string | null = null;
      try {
        baseBranch = normalizeBaseRef(suite.source.baseRef).localBranch;
      } catch {
        // A base no branch spells: the target is served, whatever it is.
      }
      return {
        runId: suite.id,
        repos: [{
          connectedRepoId: repo.id,
          url: repo.url,
          ref: suite.source.baseRef,
          ...(baseBranch === suite.checksRef ? {} : { targetRef: suite.checksRef }),
          // A namespace no run owns, as a build's grant has: a check grant reads one commit and
          // never ships, and intake refuses it before it would ever look at this.
          branchNamespace: `ryph-check/${suite.id}`,
          provider: repo.provider,
          repoRef: repo.repoRef,
          // The row's own tenant: GitHub's installation, null on the forges that have none.
          tenantId: repo.installationId,
          ...forgeIdOf(repo),
          // The one branch the head is served as in the candidate repo: the bundle's own ref, or
          // the change request's head as the suite names it.
          candidate: isForgeSource(suite.source)
            ? {
              headSha: suite.commit,
              branchName: suite.source.branchName,
              fetchRef: suite.source.fetchRef,
            }
            : {
              headSha: suite.commit,
              branchName: suite.source.branchName,
              bundleKey: suite.source.bundleKey,
            },
        }],
      };
    },

    async environmentSettled(env) {
      if (!active) return;
      for (const suite of await store.listSuitesWaitingOn(env.id).catch(() => [])) {
        await advanceWaiting(suite, env).catch((err) =>
          diag.warn("checks.environment_failed", { suiteId: suite.id, err: errText(err) })
        );
      }
    },

    async tick() {
      if (!active) return;
      if (deps.remote != null) {
        // B is the only executor and reporter. Still use A's normal request/inbox lifecycle.
        const attempt = async (work: () => Promise<unknown>) => {
          try {
            await work();
          } catch (err) {
            diag.warn("checks.remote_failed", { err: errText(err) });
          }
        };
        const deadline = deps.now().getTime() + FORGE_BUDGET_MS;
        const boundedPass = async <T>(items: T[], work: (item: T) => Promise<unknown>) => {
          let index = 0;
          const worker = async () => {
            while (index < items.length && deps.now().getTime() < deadline) {
              const item = items[index++];
              await attempt(() => work(item));
            }
          };
          await Promise.all(Array.from({ length: FORGE_CONCURRENCY }, worker));
          return index;
        };
        const suites = await store.listSuitesByState(
          ["waiting", "queued", "running"],
          TICK_BATCH,
          remoteCursor ?? "",
        );
        const poll = boundedPass(suites, async (suite) => {
          remoteCursor = suite.id;
          if (suite.remote != null) await refreshRemote(suite);
        });
        const requests = await store.listPendingRequests(nowIso(), TICK_BATCH);
        const resolveRequests = boundedPass(requests, (request) => resolve(request));
        const [visited] = await Promise.all([poll, resolveRequests]);
        if (visited === suites.length && suites.length < TICK_BATCH) remoteCursor = undefined;
        for (const request of await store.listRequestsToTell(TICK_BATCH)) {
          await attempt(() => tell(request));
        }
        if (deps.now().getTime() - lastOrphanSweep >= ORPHAN_SWEEP_MS) {
          lastOrphanSweep = deps.now().getTime();
          await attempt(releaseAbandoned);
          await attempt(refilePatches);
        }
        return;
      }
      const pass = async <T extends object>(
        what: string,
        items: T[],
        work: (item: T) => Promise<unknown>,
      ) => {
        for (const item of items) await one(what, item, work);
      };
      const one = async <T extends object>(
        what: string,
        item: T,
        work: (item: T) => Promise<unknown>,
      ) => {
        const id = "id" in item ? item.id : null;
        await work(item).catch((err) =>
          diag.warn(`checks.${what}_failed`, { id, err: errText(err) })
        );
      };
      /** A pass over the forge, held to a budget and run a few at a time: a forge that hangs
       * costs this tick the pass's remaining items, never the polls, settles and launches, which
       * ran first. The budget is looked at before each item, so a call already started runs to
       * its own timeout. Items of one `groupOf` key go to one worker, one after another. */
      const forgePass = async <T extends object>(
        what: string,
        items: T[],
        work: (item: T) => Promise<unknown>,
        forgeDeadline: number,
        groupOf: (item: T) => string,
      ): Promise<void> => {
        const groups = new Map<string, T[]>();
        for (const item of items) {
          const key = groupOf(item);
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        const queue = [...groups.values()];
        let left = 0;
        const worker = async () => {
          for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
            for (const [i, item] of group.entries()) {
              if (deps.now().getTime() >= forgeDeadline) {
                left += group.length - i;
                break;
              }
              await one(what, item, work);
            }
          }
        };
        await Promise.all(Array.from({ length: FORGE_CONCURRENCY }, worker));
        if (left > 0) diag.warn("checks.forge_budget_spent", { pass: what, left });
      };

      // First what needs no forge, so a slow one never holds it up: the free slots filled, every
      // running suite as its pod stands (settles write here), the runs told. That no forge call
      // comes before a poll is also what keeps a verdict from being lost: a finished Job is
      // deleted by the backend an hour after it ends (`ttlSecondsAfterFinished`), and every tick
      // reaches it long before. Launching before polling leaves a pod the poll discarded (to
      // relaunch it) a tick to go, since its record's name is the generation's, not the attempt's.
      await launchFairly();
      await pass("poll", await store.listSuitesByState(["running"], TICK_BATCH), pollOne);
      await pass("tell", await store.listRequestsToTell(TICK_BATCH), tell);

      // Waiting suites along their builds, from the database alone: a page at a time by id, the
      // next page on the next tick, so every one is looked at — and given up on — however many
      // wait. Those with no build to follow yet are left for the forge below.
      const pageFrom = waitingCursor ?? "";
      const waiting = await store.listSuitesByState(["waiting"], TICK_BATCH, pageFrom);
      waitingCursor = waiting.length < TICK_BATCH ? undefined : waiting.at(-1)!.id;
      const toRead: CheckSuite[] = [];
      await pass("waiting", waiting, async (suite) => {
        const next = await lookOne(suite);
        if (next !== null) toRead.push(next);
      });

      // Then the forge, in two passes side by side, each under a budget of its own, so a forge
      // that hangs on one never costs the other its tick. The waiting suites' reads of their
      // bases' `.ryph/` trees, one worker per base so two suites of one tree ask for one build;
      // a read cut short by the budget is asked again when the page comes round. Beside them,
      // requests read at the base, then forges told: one worker per head, so two patches of one
      // commit never post the same check runs side by side.
      const forgeDeadline = () => deps.now().getTime() + FORGE_BUDGET_MS;
      const reads = forgePass(
        "waiting",
        toRead,
        readOne,
        forgeDeadline(),
        (s) => `${s.connectedRepoId}\u0000${s.environmentKey}\u0000${s.checksRef}`,
      );
      const resolveAndReport = async () => {
        const deadline = forgeDeadline();
        await forgePass(
          "resolve",
          await store.listPendingRequests(nowIso(), TICK_BATCH),
          (r) => resolve(r),
          deadline,
          (r) => r.id,
        );
        await forgePass(
          "report",
          await store.listDueForgeReports(nowIso(), TICK_BATCH),
          reportOne,
          deadline,
          (r) => `${r.connectedRepoId}\u0000${r.headSha}`,
        );
      };
      // Both settle before the tick ends, so a failing pass never leaves the other running
      // outside the tick's lock.
      const settled = await Promise.allSettled([reads, resolveAndReport()]);
      for (const r of settled) if (r.status === "rejected") throw r.reason;

      // Records no running suite owns: a replica that died after a cancel, a discard that
      // failed. Listed BEFORE the suites are read, so a pod launched in between is never
      // mistaken for an orphan. And, as often, suites nobody wants any more, and the patch
      // relays' backstop.
      if (deps.now().getTime() - lastOrphanSweep >= ORPHAN_SWEEP_MS) {
        lastOrphanSweep = deps.now().getTime();
        await releaseAbandoned().catch((err) =>
          diag.warn("checks.release_sweep_failed", { err: errText(err) })
        );
        await refilePatches().catch((err) =>
          diag.warn("checks.refile_sweep_failed", { err: errText(err) })
        );
        try {
          const held = await deps.launcher!.list();
          // Only a running suite's open pods: one whose checks all answered was discarded as
          // it settled, and is swept here if that discard failed.
          const live = new Set(
            [...(await openPodsOf(await store.listSuitesByState(["running"], 10_000))).values()]
              .flatMap((pods) => pods.map((pod) => pod.name)),
          );
          for (const name of held) {
            if (live.has(name) || !name.startsWith("ryph-check-")) continue;
            await deps.launcher!.discard(name).catch((err) =>
              diag.warn("checks.orphan_discard_failed", { name, err: errText(err) })
            );
            diag.debug("checks.orphan_discarded", { name });
          }
        } catch (err) {
          diag.warn("checks.orphan_sweep_failed", { err: errText(err) });
        }
      }
    },

    async idle() {
      while (outlived.size > 0) await Promise.all(outlived);
    },
  };
  return service;
}
