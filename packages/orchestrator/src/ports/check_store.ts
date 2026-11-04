// Persistence for checks, as the core sees it — the `EnvironmentStore`'s sibling, apart for the
// same reason: suites, their results, who asked and what the forge was told are one subject with
// a working set of their own. A dumb row-holder; every decision is core/checks.ts's.
//
// Invariants:
// - a suite is CLAIMED by its identity: `claimSuite` is an insert-if-absent on
//   (connectedRepoId, commit, checksBlob, environmentKey, inputsKey), so two askers of one identity agree on
//   one suite before anything is launched — the dedupe that makes "nothing runs twice" true
// - every transition of a suite is a compare-and-set (`saveSuiteIf`) on the stored state, the
//   generation and, where the caller holds one, the lease: a launch, a settle, a cancel and a
//   re-run racing on two replicas produce one winner and no overwritten verdict
// - a request is told ONCE per generation: `markRequestReported` is a compare-and-set on the
//   last generation it was told about
// - check git keys are hash-only, exactly like a run's and a build's

import type {
  CheckApproval,
  CheckApprovalState,
  CheckForgeReport,
  CheckGitKey,
  CheckLocalUpload,
  CheckRequest,
  CheckResult,
  CheckSuite,
  CheckSuiteState,
} from "../core/check_types.ts";
import type { Scope } from "../core/scope.ts";

/** What makes two suites the same suite. */
export interface CheckSuiteIdentity {
  connectedRepoId: string;
  commit: string;
  checksBlob: string;
  environmentKey: string;
  inputsKey: string;
}

/** The checks list's page: newest first (`createdAt`, then id), narrowed by every field given. */
export interface CheckSuiteListQuery {
  connectedRepoId?: string;
  states?: readonly CheckSuiteState[];
  /** Only suites a request of one of these kinds joined (active or superseded, as a view's
   * `requestedBy` counts them). */
  askedBy?: readonly CheckRequest["kind"][];
  /** Only suites whose declaration was read on this branch. */
  checksRef?: string;
  /** Leave out the suites that run only some of their checks. */
  full?: boolean;
  /** Only suites one of whose askers the scope reaches (`ChecksService.readable`): a request
   * whose run, source run or patch is a task inside it (`ChecksService.taskIdsOf`'s three
   * ways), a `local` request the scope's own user made (active or superseded), or a runless
   * request — a `push` or a `local` one — on a repo the scope may write. Absent reads as
   * everything. */
  scope?: Scope;
  /** `encodeListCursor` of the row the previous page stopped at. */
  cursor?: string;
  limit: number;
}

export interface CheckStore {
  /** Inserts the suite unless one with its identity exists, and answers the row that stands —
   * this one (`created: true`) or the one already there. */
  claimSuite(suite: CheckSuite): Promise<{ suite: CheckSuite; created: boolean }>;
  getSuite(id: string): Promise<CheckSuite | null>;
  findSuiteByIdentity(identity: CheckSuiteIdentity): Promise<CheckSuite | null>;
  /**
   * Writes the whole row only while the STORED one is in one of `expected.states`, at
   * `expected.generation`, and — when `leaseUntil` is given, null included — holds exactly that
   * lease, and — when `version` is given — holds exactly that version: nobody wrote it since the
   * caller read it. Every write bumps the stored version by one, whatever the caller's row says,
   * and keeps a stored `ryphChanged` over the row's null. Answers whether it landed.
   */
  saveSuiteIf(
    suite: CheckSuite,
    expected: {
      states: readonly CheckSuiteState[];
      generation: number;
      leaseUntil?: string | null;
      version?: number;
    },
  ): Promise<boolean>;
  /** Suites in one of `states`, least recently written first, at most `limit` (default 200).
   * With `afterId`, by id instead, those after it — a cursor for a pass that writes nothing to
   * the rows it reads, so least-recently-written would hand it the same page every time. */
  listSuitesByState(
    states: readonly CheckSuiteState[],
    limit?: number,
    afterId?: string,
  ): Promise<CheckSuite[]>;
  countSuitesByState(states: readonly CheckSuiteState[]): Promise<number>;
  /** Every suite on one head, newest first. */
  listSuitesForCommit(connectedRepoId: string, commit: string): Promise<CheckSuite[]>;
  /** The suites a build answers — who to move when it settles. */
  listSuitesWaitingOn(environmentId: string): Promise<CheckSuite[]>;
  /** Whether any suite not yet settled names this build — waiting on it, or about to run in or
   * running in its image. What keeps retention from removing that image. */
  hasUnsettledSuiteOn(environmentId: string): Promise<boolean>;
  listSuitesByIds(ids: readonly string[]): Promise<CheckSuite[]>;
  /** The checks list. Every filter is in the query, so a page is full whenever more rows match,
   * and `nextCursor` is null only on the last page. */
  listSuites(
    query: CheckSuiteListQuery,
  ): Promise<{ suites: CheckSuite[]; nextCursor: string | null }>;
  /** Stamps whether the change touched `.ryph/` while the stored answer is still null: a column
   * write, so a running suite learns it from its first early verdict without racing a settle.
   * The one suite write that leaves the version alone, so an unleased stamp never costs a lease
   * holder its compare-and-set; `saveSuiteIf` never writes the stamp back to null. */
  setSuiteRyphChanged(id: string, ryphChanged: boolean): Promise<void>;

  /** Upserts on (suiteId, generation, name). `forgeRef` is kept when the new row carries null:
   * a check run once posted keeps its id across the results' own updates. A stored row already
   * settled (`SETTLED_RESULT_STATES`) is left as it is: the first verdict of a generation
   * stands, whichever replica wrote it and whatever a slower one read. */
  upsertResults(results: readonly CheckResult[]): Promise<void>;
  /** One suite's results, by name; one generation's when given. */
  listResults(suiteId: string, generation?: number): Promise<CheckResult[]>;
  /** `listResults` for many suites at once, each at the generation given: a list page's reads
   * in one query. By suite, then name. */
  listResultsForGenerations(
    keys: readonly { suiteId: string; generation: number }[],
  ): Promise<CheckResult[]>;
  setResultForgeRef(
    suiteId: string,
    generation: number,
    name: string,
    forgeRef: string,
  ): Promise<void>;

  createRequest(request: CheckRequest): Promise<void>;
  getRequest(id: string): Promise<CheckRequest | null>;
  /** Writes the whole row only while the STORED one is in one of `states`, and answers whether
   * it landed: a resolve and a supersede racing on one request produce one winner. All but
   * `expiresAt`, which only `extendRequest` moves: a renewal landing mid-resolve stands. */
  saveRequestIf(
    request: CheckRequest,
    states: readonly CheckRequest["state"][],
    /** Optional note fencing: a remote withdrawal cannot be overwritten by an in-flight read. */
    expected?: { note?: string | null; noteNot?: string },
  ): Promise<boolean>;
  /**
   * Sets a request aside — `superseded`, its clock cleared — only while the STORED one is active
   * or pending, and answers the row as it now stands, the suite it resolved to meanwhile
   * included; null when it had already moved on. Touches no other field, so a withdraw that read
   * the request before a resolve never writes that stale copy back over it.
   */
  withdrawRequest(id: string): Promise<CheckRequest | null>;
  /** Pending requests due at `now` (no clock, or one that has run out), oldest first. */
  listPendingRequests(now: string, limit: number): Promise<CheckRequest[]>;
  listRequestsForSuite(suiteId: string): Promise<CheckRequest[]>;
  /** `listRequestsForSuite` for many suites at once, oldest first. */
  listRequestsForSuites(suiteIds: readonly string[]): Promise<CheckRequest[]>;
  listRequestsForRun(runId: string): Promise<CheckRequest[]>;
  listRequestsForPatches(patchIds: readonly string[]): Promise<CheckRequest[]>;
  /** One change request's `push` requests, every state, oldest first. */
  listPushRequests(connectedRepoId: string, changeRequest: string): Promise<CheckRequest[]>;
  /** One person's `local` requests still standing (pending or active), every repo, oldest
   * first: what a new ask supersedes on its branch, and what their quota counts. */
  listLiveLocalRequests(userId: string): Promise<CheckRequest[]>;
  /** `local` requests still standing whose `expiresAt` is at or before `now`, oldest first, at
   * most `limit`: what the minute sweep withdraws. */
  listExpiredLocalRequests(now: string, limit: number): Promise<CheckRequest[]>;
  /** `withdrawRequest`, only while the STORED request's end is still at or before `now`: the
   * expiry sweep's, so a renewal that landed after the sweep listed the request keeps it. */
  withdrawExpired(id: string, now: string): Promise<CheckRequest | null>;
  /** Moves a request's end to `expiresAt` while the STORED one still stands (pending or
   * active), touching no other field, and answers the row as it now stands; null when it had
   * already moved on. A column write, so a resolve landing meanwhile is never written back. */
  extendRequest(id: string, expiresAt: string): Promise<CheckRequest | null>;
  /** Records one upload attempt, before its bytes are streamed — and before it is counted, so
   * uploads side by side each see the others'. */
  recordLocalUpload(upload: CheckLocalUpload): Promise<void>;
  /** Drops one upload attempt: the one a refusal over the cap recorded, so a 429 costs nothing. */
  deleteLocalUpload(id: string): Promise<void>;
  /** How many upload attempts one person made at or after `since`: what the hourly cap counts. */
  countLocalUploadsSince(userId: string, since: string): Promise<number>;
  /** Drops the upload attempts made before `before`: the minute sweep's, past any cap's window. */
  pruneLocalUploads(before: string): Promise<void>;
  /** Every request for one head, oldest first — pending ones included, which name no suite. */
  listRequestsForCommit(connectedRepoId: string, commit: string): Promise<CheckRequest[]>;
  /** The suites a run asked for through its tool — what the per-run cap counts. */
  countToolRequestsForRun(runId: string): Promise<number>;
  /**
   * Active requests with a run whose suite has settled a generation the run was not told yet,
   * oldest first — the inbox delivery's work list.
   */
  listRequestsToTell(limit: number): Promise<CheckRequest[]>;
  /** Stamps `reportedGeneration` only while the stored one is null or below `generation`, and
   * answers whether this call did: the one delivery of a generation's result. */
  markRequestReported(id: string, generation: number): Promise<boolean>;

  /** Inserts the row, or — for an asker (its patch, or its push request) that has one — makes
   * that one due now (`touch`). */
  upsertForgeReport(row: CheckForgeReport): Promise<void>;
  getForgeReport(id: string): Promise<CheckForgeReport | null>;
  /** The one row of a patch, or of a push request. */
  findForgeReport(
    asker: { patchId: string } | { requestId: string },
  ): Promise<CheckForgeReport | null>;
  /** Every row reporting on one head: what the forge was told about that commit. */
  listForgeReportsForCommit(connectedRepoId: string, headSha: string): Promise<CheckForgeReport[]>;
  /** Rows whose clock has run out at `now`, oldest clock first. */
  listDueForgeReports(now: string, limit: number): Promise<CheckForgeReport[]>;
  /**
   * Makes every row reporting one suite — or waiting on any suite of its head (`suiteId` still
   * null) — due at `at`, and bumps its `revision`: a column write, never a whole row, so it
   * cannot put back what a report in flight is about to write.
   */
  touchForgeReports(
    suite: Pick<CheckSuite, "id" | "connectedRepoId" | "commit">,
    at: string,
  ): Promise<void>;
  /** Moves every row reporting `fromSuiteId` onto `to` (a re-run's new suite of the same head),
   * due at `at`, its `revision` bumped as a touch's is. */
  repointForgeReports(
    fromSuiteId: string,
    to: Pick<CheckSuite, "id">,
    at: string,
  ): Promise<void>;
  /**
   * What one report came to. `fields` land whatever happened meanwhile, but for two:
   * `nextAttemptAt` lands only while the stored `revision` is still `readRevision` — a touch
   * since the report was read keeps its clock, so a suite that moved during a slow forge call is
   * reported again — and `suiteId` only while the stored one is still `readSuiteId`, so a
   * report in flight never undoes a repoint.
   */
  settleForgeReport(
    id: string,
    fields: Partial<
      Pick<
        CheckForgeReport,
        | "suiteId"
        | "reportedFingerprint"
        | "attempts"
        | "lastError"
        | "disabledUntil"
        | "openGenerations"
        | "updatedAt"
      >
    >,
    next: { nextAttemptAt: string | null; readRevision: number; readSuiteId: string | null },
  ): Promise<void>;

  /** Inserts the approval unless one of its head (connectedRepoId, changeRequest, headSha)
   * exists, and answers the row that stands — this one (`created: true`) or the one there. */
  claimApproval(approval: CheckApproval): Promise<{ approval: CheckApproval; created: boolean }>;
  getApproval(id: string): Promise<CheckApproval | null>;
  /** One change request's approvals, every head and state, newest first. */
  listApprovals(connectedRepoId: string, changeRequest: string): Promise<CheckApproval[]>;
  /** Writes the whole row only while the STORED one is in one of `states`, and answers whether
   * it landed: two approvers, or an approver and a newer push, produce one winner. */
  saveApprovalIf(
    approval: CheckApproval,
    states: readonly CheckApprovalState[],
  ): Promise<boolean>;

  /** Takes the right to post a pending approval's comment: sets `commentClaimedAt` to `at` only
   * while the stored row is pending, its `commentId` is still `seen` (null, or one whose edit just
   * failed), and nobody holds the right or whoever does took it before `staleBefore`. Answers
   * whether it was taken. */
  claimApprovalComment(
    id: string,
    claim: { at: string; staleBefore: string; seen: string | null },
  ): Promise<boolean>;
  /** Gives the right back after a post that failed: clears `commentClaimedAt` while it is `at`. */
  releaseApprovalComment(id: string, at: string): Promise<void>;

  createCheckGitKey(key: CheckGitKey): Promise<void>;
  /** The gateway's lookup, after a run key and a build key missed: the presented token, hashed. */
  getCheckGitKeyByTokenHash(tokenHash: string): Promise<CheckGitKey | null>;
  /** Stamps `revokedAt` on every live key of one generation of a suite: a re-run's next
   * generation keeps its own. */
  revokeCheckGitKeys(suiteId: string, generation: number, at: string): Promise<void>;
  /** Stamps `revokedAt` on one key, if it is still live. */
  revokeCheckGitKey(id: string, at: string): Promise<void>;
}
