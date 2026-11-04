// Checks: the commands a repo's `.ryph/checks.yml` declares, and what the platform observed when
// it ran them. The types only — the engine is core/checks.ts, the
// parser helpers/checks.ts, the pod a CheckLauncher (ports/check_launcher.ts).
//
// The claim every row here exists to back: the commands `.ryph/checks.yml` declares at the base
// commit exited 0 against the head commit, in the base's environment image, in a container
// nothing from the run touched.
//
// Invariants:
// - the declaration is read at the BASE, never the head: a patch can change the code under test,
//   not the definition of the test. A suite freezes what it read (`definition`, `checksBlob`)
// - a suite's identity is `(connectedRepoId, commit, checksBlob, environmentKey, inputsKey)` — a
//   second request for the same key joins the suite, running or finished. The image digest is NOT
//   part of it: it is unknown while the suite waits on a build, so it is recorded (`image`)
//   instead. `inputsKey` is everything else the pod is given that a request can differ in: the
//   requesting run's egress scope and the services resolved for it, so a run with a narrow
//   network policy never joins a suite that reaches more
// - a verdict is an exit code the backend observed on the check's container, never anything the
//   container says about itself. No route accepts a result from a pod
// - logs and log tails are head-authored text: escaped or fenced wherever they are rendered

import { ID_BODY, sha256Hex } from "@ryph/sealed";
import type { ForgeProvider, RunNetworkScope, ServiceSpec } from "./types.ts";

/** Lowercase letters, digits and dashes, starting and ending with a letter or digit, ≤ 40
 * chars (the container name `check-<name>` must fit 63). */
export const CHECK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const MAX_CHECKS = 32;
/** The most checks one declaration may run in a pod of their own (`pod: own`): each is a pod, a
 * slot and a setup run of its own, and with the shared pod they fit the default four slots
 * (`RYPH_CHECKS_CONCURRENCY`). */
export const MAX_OWN_PODS = 3;
/** The longest check pod record name, CHECK_RECORD_NAME's limit. */
export const MAX_CHECK_RECORD_NAME = 52;
/**
 * A check pod's record name, as every launcher takes it (adapters/check_launcher/shared.ts
 * `assertLaunchable`): a DNS label with room left for the Secret's suffix (`-` + 8 hex) inside
 * 63 — the Job, its pod and the docker objects are all named from it. At most
 * MAX_CHECK_RECORD_NAME characters.
 */
export const CHECK_RECORD_NAME = new RegExp(
  `^[a-z0-9](?:[a-z0-9-]{0,${MAX_CHECK_RECORD_NAME - 2}}[a-z0-9])?$`,
);
export const MAX_SETUP_STEPS = 16;
export const MAX_RUN_CHARS = 4_000;

/**
 * The exit code a check container's entrypoint answers when the suite's memory pool ran short and
 * this check, the one furthest over its share, was stopped to save the rest (scripts.ts, the pool
 * watcher). The check's own failure, not the platform's: it used more than its share while its
 * siblings needed theirs. A command that exits 122 by itself is reported as 1, as 124 and 125 are.
 */
export const CHECK_POOL_EXIT = 122;
export const MAX_WATCH = 32;
export const MAX_KEEP = 32;
/** What a baked check keeps of the image's ignored files when `keep` is not declared: the
 * dependency and build caches most repos have. */
export const DEFAULT_KEEP: readonly string[] = ["node_modules", "target", ".venv"];
/** Where the declaration lives, in the order a read tries them: `.yml` wins. */
export const CHECKS_FILE_PATHS = [".ryph/checks.yml", ".ryph/checks.yaml"] as const;
/** Per check, per generation — what is stored and what the log route answers at most. */
export const MAX_CHECK_LOG_BYTES = 4 * 1024 * 1024;
/** How much of a check's log rides along in the inbox note and the forge report. */
export const CHECK_LOG_TAIL_LINES = 64;

/** One named check, as the base declared it. */
export interface CheckDeclaration {
  name: string;
  /** One shell string, run as `sh -c` by the check container's platform-authored entrypoint.
   * Never interpreted by the control plane. */
  run: string;
  /** Parsed from "20m" | "90s" | "1h"; null = policy default. Capped by policy at resolve time. */
  timeoutSeconds: number | null;
  /** Names from the base's services.yml. */
  services: string[];
  /** Globs beyond the code under test. `.ryph/**` is always watched, implicitly. */
  watch: string[];
  /** `own`: the check runs in a pod of its own, alone, with only the services it names and its
   * own clone, setup, deadline and memory pool (core/checks.ts `checkPods`). Absent: the suite's
   * shared pod. */
  pod?: "own";
  /** Only with `pod: own`: the name of a size class the deployment defines AND lets checks use
   * (`RYPH_CHECKS_OWN_SIZES`), checked at launch, where any other fails the suite. Absent: the
   * size the shared pod gets. */
  size?: string;
}

/** A whole `checks.yml`, parsed. */
export interface ChecksDeclaration {
  /** Run in order before the checks: once, as init containers without services, or in each check's
   * container when the image baked the repo's checkout (ports/check_launcher.ts `bakedCheckout`). */
  setup: Array<{ run: string }>;
  /** An empty list is "no checks", the same as an absent file. */
  checks: CheckDeclaration[];
  /**
   * Gitignore-style patterns for the image's ignored files a baked check keeps; every other
   * ignored file is removed before setup runs. Absent: DEFAULT_KEEP (`keepOf`).
   */
  keep?: string[];
  /**
   * Set on a suite that runs only some of the declared checks (`checks` then holds just those,
   * in declared order): asked for by name through `ryph__run_checks`. Never reported to the
   * forge, and never the suite a patch is judged by.
   */
  partial?: true;
}

/** The keep list a declaration asks for, the default when it names none. */
export const keepOf = (definition: Pick<ChecksDeclaration, "keep">): string[] => [
  ...(definition.keep ?? DEFAULT_KEEP),
];

/** Whether a suite runs only some of its declared checks. */
export const isPartial = (suite: { definition: Pick<ChecksDeclaration, "partial"> }): boolean =>
  suite.definition.partial === true;

export type CheckSuiteState =
  /** Blocked on the base's environment build (`environmentId` set). */
  | "waiting"
  /** Resolved; waiting for a launch slot. */
  | "queued"
  /** Launched, or being launched under lease. */
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

export const TERMINAL_SUITE_STATES: ReadonlySet<CheckSuiteState> = new Set<CheckSuiteState>([
  "passed",
  "failed",
  "error",
  "cancelled",
]);

export type CheckResultState =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "setup_failed"
  | "error"
  | "cancelled";

/** A check's states once it has its answer for the generation: a results write never replaces
 * one (`CheckStore.upsertResults`). */
export const SETTLED_RESULT_STATES: ReadonlySet<CheckResultState> = new Set<CheckResultState>([
  "passed",
  "failed",
  "timed_out",
  "setup_failed",
  "error",
  "cancelled",
]);

/**
 * Where the commit under check came from: a run's bundle, as forge intake stored it; a head on
 * the forge itself (a change request's, or a branch a person pushed); or a bundle a person
 * uploaded from their own machine. What the forge serves the check pod's clone from — it
 * re-verifies the head against `commit` before serving it, so nothing here is trusted beyond
 * naming where to look. A run's arm has a `runId`; of the two runless arms, only a person's
 * upload carries a `bundleKey` (`isLocalBundleSource`). The jsonb rows standing from before the
 * third arm read as one of the first two unchanged.
 */
export type CheckSource = (BundleSource | ForgeSource | LocalBundleSource) & {
  /** Internal cleanup-only original submission identity. An uncertain submit must be retried
   * with this id, never the independently persisted cleanup request's id. */
  remoteCleanupSubmissionId?: string;
};

/** A commit a run uploaded through intake. */
export interface BundleSource {
  /** The request's checkout path. */
  path: string;
  /** The run whose bundle this commit came from. */
  runId: string;
  /** `runBundleKey` (@ryph/shared/lines) — derived, never taken from a caller. */
  bundleKey: string;
  /** The bundle's one ref (generation-suffixed). */
  branchName: string;
  /** `entry.ref`: what the forge seeds the scratch repo from. */
  baseRef: string;
  /**
   * A tool request's subset: the check names it asked for, when not all. Carried on the
   * REQUEST's source only (so it needs no column of its own) and never on a suite's, whose
   * `definition` says what it runs.
   */
  checks?: string[];
}

/** A head already on the forge, so no run's network scope applies: a push to a pull request or
 * a Radicle patch (`change_request.pushed`), or a branch a person pushed and asked about from
 * their own machine (a `local` request, `changeRequest` null). */
export interface ForgeSource {
  /** A sender's stable request identity; absent for ordinary local CLI requests. */
  delegationId?: string;
  runId: null;
  /** The change request, as `patches.forge_ref` names one: a PR number, a Radicle patch id.
   * Null for a person's pushed branch, which no change request carries yet. */
  changeRequest: string | null;
  /** Where the forge fetches the head when a fetch by id fails: `refs/pull/42/head`, or a
   * person's `refs/heads/<branch>` on either forge. Null for a Radicle patch's push, whose every
   * revision's head is fetched by id. */
  fetchRef: string | null;
  /** The scratch ref the gateway serves, and the branch the checks list shows: synthetic and
   * stable per change request — `pull/<n>/head` on GitHub, `patches/<id>` on Radicle — or the
   * person's own branch. */
  branchName: string;
  /** The base branch, bare: what the forge seeds the scratch repo from. */
  baseRef: string;
  /** The change request on its forge, for a person; null when the forge gave none, and on a
   * person's pushed branch. */
  url: string | null;
  /** As `BundleSource.checks`; a push never names any, a person's ask may. */
  checks?: string[];
  /** A local request's asker, by name, for the checks list: REQUEST-only, as `checks` is. */
  askerName?: string;
  /** A delegated ask's sender asked as a run's tool or a person does, so a failed suite it
   * joins retries its failures (`retriesFailures`); absent, it only reads the answer, as a
   * patch's or a push's ask does. REQUEST-only, as `checks` is. */
  retryFailed?: boolean;
}

/** A commit a person uploaded as a bundle from their own machine (`POST
 * /v1/check-suites/bundle`): verified by the forge like a patch and stored under the user. */
export interface LocalBundleSource {
  /** A sender's stable request identity; absent for ordinary local CLI requests. */
  delegationId?: string;
  runId: null;
  /** The person who uploaded it. */
  userId: string;
  /** `localBundleKey` — derived here, and held equal to what the forge answered. */
  bundleKey: string;
  /** The person's branch: the bundle's one ref, `refs/heads/<branchName>`. */
  branchName: string;
  /** The base branch, bare: what the forge seeds the scratch repo from. */
  baseRef: string;
  /** As `BundleSource.checks`. */
  checks?: string[];
  /** As `ForgeSource.askerName`. */
  askerName?: string;
  /** As `ForgeSource.retryFailed`. */
  retryFailed?: boolean;
}

/**
 * Where the forge files a person's check bundle: under the user, then the branch, then the base
 * (each the first 16 hex of the sha256 of its name, so a key is a path whatever either is
 * called), then the repo. The same commit asked about on two branches is two bundles, each its
 * branch's; and against two bases it is two bundles too, since a bundle's prerequisites are only
 * ever proven against the base it was uploaded for, and one key for both would let the second
 * upload replace the first under the first suite's clone. Ends `/<connectedRepoId>/<headSha>.bundle`,
 * the one shape the gateway accepts. The forge derives the same key (`checkBundleKey`).
 */
export async function localBundleKey(
  userId: string,
  branchName: string,
  baseRef: string,
  connectedRepoId: string,
  headSha: string,
): Promise<string> {
  const short = async (name: string): Promise<string> => (await sha256Hex(name)).slice(0, 16);
  return `users/${userId}/${await short(branchName)}/${await short(
    baseRef,
  )}/${connectedRepoId}/${headSha}.bundle`;
}

/** A person's uploaded bundle: runless, with a bundle key. */
export const isLocalBundleSource = (source: CheckSource): source is LocalBundleSource =>
  source.runId === null && "bundleKey" in source;

/** A head on the forge: runless, with no bundle. */
export const isForgeSource = (source: CheckSource): source is ForgeSource =>
  source.runId === null && !("bundleKey" in source);

/** Where the gateway finds a bundled commit: a run's bundle or a person's; null for a head on
 * the forge. */
export const bundleKeyOf = (source: CheckSource): string | null =>
  isForgeSource(source) ? null : source.bundleKey;

/** One suite: every check of one declaration against one commit, in one image. */
export interface CheckSuite {
  /** Execution and forge reports belong to this remote deployment, never the local launcher. */
  remote?: import("../ports/remote_checks.ts").RemoteCheckReference | null;
  /** `mintId("cs")`. */
  id: string;
  connectedRepoId: string;
  /** The head sha (40 or 64 hex). */
  commit: string;
  /** The branch the declaration was read on, bare. */
  checksRef: string;
  /** The base commit `checksRef` was pinned to; every read of the base used it. */
  checksCommit: string;
  /** Blob id of the checks file at `checksCommit`. */
  checksBlob: string;
  checksPath: string;
  /** Frozen at resolve time. */
  definition: ChecksDeclaration;
  /** `tree:<base .ryph tree id>` (waits for that tree's image) | `image:<reference>` (a ready
   * environment image) | `default:<image>` — the identity part, chosen once at the claim. */
  environmentKey: string;
  /** A hash of `networkScope` and the resolved services (or their refusal) — the identity
   * part that keeps suites with different pods apart. */
  inputsKey: string;
  /** The requesting run's egress scope, as it was resolved at the run's launch: what the pod's
   * claim is minted from, held to the deployment's ceiling again at every launch. */
  networkScope: RunNetworkScope;
  /** The environment row used, or waited on. */
  environmentId: string | null;
  /** The digest-pinned image launched; null until resolved. */
  image: string | null;
  /** Resolved and frozen: the union of what the checks name. */
  services: ServiceSpec[];
  source: CheckSource;
  state: CheckSuiteState;
  /** 1, then +1 per re-run. */
  generation: number;
  /** Why error, cancelled or waiting, as a sentence for a human. */
  reason: string | null;
  /** Launch attempts in this generation; the third failure is `error`. */
  attempts: number;
  /** Whether the change touched `.ryph/**` (base → head), from the clone step's changed-paths
   * list; null until a clone reported one, or when it could not be computed. */
  ryphChanged: boolean | null;
  /** The launch/settle lease (CAS). */
  leaseUntil: string | null;
  /** Each launched pod's own life in this generation, by record name (core/checks.ts
   * `checkPods`), written with every launch. Of a suite of one pod only the clone key is read.
   * Null until the first launch. */
  pods: Record<string, CheckPodState> | null;
  /** One more on every write of the row (`CheckStore.saveSuiteIf`, in SQL): a write that names
   * the version it read lands only if nobody wrote the row since, whatever the clock says. */
  version: number;
  /** When the suite last started waiting on the base's environment; read only while waiting. */
  waitingSince: string | null;
  /** A waiting suite's next read of its base, after one that failed; read only while waiting. */
  nextAttemptAt: string | null;
  launchedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One pod of a suite, as the control plane keeps it while the suite runs. In a suite of several,
 * each pod lives its own life (core/checks.ts `pollPods`) — relaunched alone, held to its own deadline,
 * settled and discarded as soon as its own checks are.
 */
export interface CheckPodState {
  /** Its launches in this generation: the suite's launch is the first, each relaunch of it alone
   * one more. The MAX_LAUNCH_ATTEMPTS-th platform failure ends its checks `error`. */
  attempts: number;
  /** When its current launch went out: what its deadline counts from. */
  launchedAt: string;
  /** The clone key its current launch holds, revoked once it is past its clone. Null when not
   * known: a launch that did not take, or one adopted from a replica that died. */
  keyId: string | null;
  /** Why its last launch did not take, while it runs; why its checks ended without their own
   * verdict (or how they failed), once they have — carried into the suite's reason. */
  reason: string | null;
}

/** One check of one suite generation. */
export interface CheckResult {
  suiteId: string;
  generation: number;
  name: string;
  state: CheckResultState;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** `checks/<suiteId>/<generation>/<name>.log`. */
  logKey: string | null;
  /** The raw last 64 lines; escaped or fenced at every render. */
  logTail: string | null;
  /** Null: unknown (the changed-paths list could not be computed). */
  watchedChanged: boolean | null;
  /** The GitHub check-run id, once one was posted for this check. */
  forgeRef: string | null;
  /** The suite whose pod ran this pass, when it was taken rather than run in this generation
   * (`reusePasses` in core/checks.ts): another suite of the commit, or this one when the pass is
   * from its own earlier generation. Null for a check this generation ran. */
  inheritedFrom: string | null;
}

/**
 * Who asked for a suite, and what they were last told. Suites are shared across runs and
 * patches by dedupe, so the asker is a row of its own rather than a column on the suite.
 */
export interface CheckRequest {
  /** Durable receiver request, including while B has not resolved a suite yet. */
  remote?: import("../ports/remote_checks.ts").RemoteCheckReference | null;
  /** `mintId("cq")`. */
  id: string;
  /** Null until resolved (patch-birth requests resolve on the tick). */
  suiteId: string | null;
  /** A re-run's: the suite it re-runs, when that one is read at the base again and may resolve
   * to another suite of the same head — whoever asked for the old one then follows. */
  rerunOf: string | null;
  connectedRepoId: string;
  commit: string;
  runId: string | null;
  patchId: string | null;
  /** A push request's change request (`ForgeSource.changeRequest`), as a column so its earlier
   * pushes are found by an index; null for every other kind. */
  changeRequest: string | null;
  /** A `local` request's asker: the person who asked from their own machine (`POST
   * /v1/check-suites`), as a column so their live asks are found by an index; null for every
   * other kind. */
  userId: string | null;
  /** `push`: a change request's head moved on the forge (`ForgeSource`; no run, no patch).
   * `local`: a person asked from their own machine, about a branch they pushed (`ForgeSource`)
   * or a bundle they uploaded (`LocalBundleSource`); never reported to the forge by itself. */
  kind: "tool" | "patch" | "rerun" | "forge" | "push" | "local";
  state: "pending" | "active" | "superseded" | "refused";
  /** Why refused, "no checks", or unavailable. */
  note: string | null;
  source: CheckSource;
  checksRef: string;
  /** The last generation the run's inbox was told about. */
  reportedGeneration: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  /** A `local` request's end: past it the minute sweep withdraws the request. Set a day out when
   * it is filed, and again whenever the same ask is made; null for every other kind. */
  expiresAt: string | null;
}

/** Per asker the forge hears about — a submitted patch, or a push request — what the forge was
 * last told (a GitHub check run per check; one Radicle job run per suite). Exactly one of
 * `patchId` and `requestId` is set. */
export interface CheckForgeReport {
  /** `mintId("fr")`. */
  id: string;
  patchId: string | null;
  /** A `push` request's: the change request whose head it reports. */
  requestId: string | null;
  connectedRepoId: string;
  headSha: string;
  /** The base the asker's checks are read at: what a fallback suite must have been read on. */
  checksRef: string;
  suiteId: string | null;
  /** `${suite.id}:${generation}:${suiteState}:${resultsHash}` of the last report that landed. */
  reportedFingerprint: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** "unsupported": the App cannot post checks here; stop asking until this passes. */
  disabledUntil: string | null;
  /** Bumped by every touch: what a report compares against to know it read a stale clock. */
  revision: number;
  /** The generation of the reported suite whose last landed report left its run going — still
   * running, or cancelled — so a newer generation's report can name it, and a
   * one-run-per-generation forge (Radicle) finish it. At most one, and only the row's suite's. */
  openGenerations: Array<{ suiteId: string; generation: number }>;
  createdAt: string;
  updatedAt: string;
}

/** Where an outside contribution's approval stands. `superseded`: the change request moved on to
 * another head before anyone approved this one. `closed`: it was merged or closed first. */
export type CheckApprovalState = "pending" | "approved" | "superseded" | "closed";

/**
 * A head of a change request whose author may not make this deployment run code — a fork's pull
 * request, a non-delegate's Radicle patch — waiting for someone who may to approve its checks
 * once (core/check_approvals.ts). One row per head: a push of a new head needs a new approval.
 * The comment that links the approval page is the change request's one, edited per head.
 */
export interface CheckApproval {
  /** `mintId("ca")`: what the approval page's address names. */
  id: string;
  connectedRepoId: string;
  /** `patches.forge_ref`'s spelling: a PR number, a Radicle patch id. */
  changeRequest: string;
  headSha: string;
  fetchRef: string | null;
  /** The change request's web address, from the forge's event — where approving sends back to. */
  url: string | null;
  /** The change request's author, as their forge names them (a login, a DID). */
  author: string;
  state: CheckApprovalState;
  /** The forge's id of the comment that links the approval page; null until it is posted. */
  commentId: string | null;
  /** When a delivery took the right to POST that comment (`claimApprovalComment`), so two
   * deliveries of one head racing post one comment; null when nobody holds it. */
  commentClaimedAt: string | null;
  approvedByUserId: string | null;
  /** The approver's identity on the repo's forge, as the comment names them. */
  approvedByLogin: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One bundle a person streamed to the forge for a local ask — an ATTEMPT, written before the
 * upload whatever the forge then answers: what the hourly upload cap counts. */
export interface CheckLocalUpload {
  /** `mintId("lu")`. */
  id: string;
  userId: string;
  connectedRepoId: string;
  at: string;
}

/**
 * The one-shot read credential a check pod's clone step uses: hash only, resolving only while
 * its suite generation is running, revoked once the clone is done and again at settle.
 */
export interface CheckGitKey {
  id: string;
  suiteId: string;
  generation: number;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/**
 * A check run's idempotency key on the forge: `<suite>:<generation>:<check>`. The forge's
 * webhook door holds a re-request to the same shape with a regex of its own (@ryph/forge
 * `github_webhooks.ts`, `RYPH_CHECK_EXTERNAL_ID`) — it cannot import this; the two must match.
 */
export function checkExternalId(
  suite: Pick<CheckSuite, "id" | "generation">,
  check: string,
): string {
  return `${suite.id}:${suite.generation}:${check}`;
}

const EXTERNAL_ID = new RegExp(`^(cs-${ID_BODY}):(\\d{1,6}):([a-z0-9-]{1,40})$`);

/** `checkExternalId`, read back — null for anything ryph did not post. */
export function parseCheckExternalId(
  externalId: string,
): { suiteId: string; generation: number; check: string } | null {
  const match = EXTERNAL_ID.exec(externalId);
  if (match === null) return null;
  return { suiteId: match[1], generation: Number(match[2]), check: match[3] };
}

/** What the app, the tools and the reports render. */
export interface CheckSuiteView {
  id: string;
  connectedRepoId: string;
  repoRef: string | null;
  provider: ForgeProvider | null;
  commit: string;
  checksRef: string;
  checksCommit: string;
  checksBlob: string;
  checksPath: string;
  environment: { key: string; image: string | null; environmentId: string | null };
  state: CheckSuiteState;
  reason: string | null;
  generation: number;
  /** `.ryph/**` touched by the change; null when unknown. */
  ryphChanged: boolean | null;
  createdAt: string;
  launchedAt: string | null;
  finishedAt: string | null;
  checks: Array<{
    name: string;
    run: string;
    timeoutSeconds: number;
    services: string[];
    /** As declared: `own` runs in a pod of its own, with `size` when it names one. */
    pod?: "own";
    size?: string;
    state: CheckResultState;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    logTail: string | null;
    hasLog: boolean;
    watchedChanged: boolean | null;
    /** A pass taken from an earlier suite of the same commit rather than run here. Which suite
     * is not said: it may be a task's the viewer cannot see. */
    inherited: boolean;
  }>;
  requestedBy: Array<{ kind: CheckRequest["kind"]; runId: string | null; patchId: string | null }>;
  /** Runs only some of the declared checks (`checks` lists those). */
  partial: boolean;
  /** `${RYPH_APP_URL}/checks/<id>`. */
  detailsUrl: string | null;
}

/** Who asked for a suite, as the checks list links it: a task's run (`tool`), a patch's change
 * request, a push to any change request (`push`), a person's Run again (`rerun`), the forge's
 * re-run button (`forge`), a person asking from their own machine (`local`). */
export interface CheckAsker {
  kind: CheckRequest["kind"];
  label: string;
  /** Where it opens: an app path, or the change request on its forge. Null: nowhere. */
  href: string | null;
}

/** One row of the checks list. */
export interface CheckSuiteListItem {
  suite: CheckSuiteView;
  /** The branch the head was pushed on, when the suite knows it. */
  branch: string | null;
  /** Only the askers the reader may see, oldest first, each once. */
  askedBy: CheckAsker[];
}

/** One check a repo's checks file declares, with the policy's timeout applied. */
export interface DeclaredCheck {
  name: string;
  run: string;
  timeoutSeconds: number;
  services: string[];
  watch: string[];
  /** As declared: `own` runs in a pod of its own, with `size` when it names one. */
  pod?: "own";
  size?: string;
}

/** A repo's checks file on its default branch, as the checks page shows it. */
export type RepoChecksFile =
  | {
    state: "declared";
    path: string;
    commit: string;
    setup: string[];
    checks: DeclaredCheck[];
    /** The pods a full suite of the file runs at once: the shared pod, and one per `pod: own`. */
    podsNeeded: number;
    /** Set when `podsNeeded` is more than the deployment runs at once: such a suite fails. */
    warning?: string;
  }
  /** No file, or one that declares no checks. */
  | { state: "none" }
  /** Read, and not usable: the parse error, or why the forge refused it. The forge may refuse
   * before it pins a commit or picks a path. */
  | { state: "invalid"; path: string | null; commit: string | null; error: string }
  /** Not read: the forge did not answer in time, or checks cannot run here. */
  | { state: "unread"; error: string };
