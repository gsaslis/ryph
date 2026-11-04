// Persistence for environments, as the core sees it — the `TaskStore`'s sibling, kept apart
// because the build queue and its credentials are one subject with its own working set.
//
// The table is the queue AND the record: a build is queued as a row, any replica with a free
// slot claims it, and a ready row is the image runs freeze. The store is a dumb row-holder like
// its sibling; every decision is core/environments.ts's.
//
// Invariants:
// - `claimNextBuild` is the one place the deployment-wide concurrency cap is decided, and it is
//   decided at the write: two replicas claiming together never put more than `maxInFlight` rows
//   in `building`
// - a settle is conditional on the stored status (`saveEnvironmentIfStatus`), so a build that
//   was superseded or reclaimed while it ran can never write `ready` over the verdict
// - `updatedAt` on a `building` row is a LEASE, not a decoration: the replica running the build
//   stamps it every tick (`touchBuild`), and a row that stops being stamped is one whose owner
//   went away. `claimStrandedBuild` is the compare-and-set that hands such a row to exactly one
//   replica, which then asks the builder what became of the build itself
// - build git keys are hash-only, exactly like a run's git keys
// - a patch is checked for a build ONCE: the check is claimed by an insert-if-absent
//   (`createPatchBuild`) BEFORE anything is read or built, only the lease holder resolves it
//   (`updatePatchBuildIfClaimed`, a compare-and-set on `claimedUntil`), and its run is told the
//   result once (`markPatchBuildReported` is a compare-and-set on `reportedAt`)

import type { EgressRefusal, EgressRefusalOutcome } from "../core/egress.ts";
import type {
  Environment,
  EnvironmentStatus,
  EnvironmentSubjectKind,
  Patch,
  PatchBuild,
} from "../core/types.ts";

/** A build's git credential toward the gateway, hash-only (see db/schema.ts `build_git_keys`). */
export interface BuildGitKey {
  id: string;
  environmentId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

/** What the builds list narrows to. An empty `statuses` or `subjectKinds` matches nothing. */
export interface EnvironmentListQuery {
  statuses?: readonly EnvironmentStatus[];
  subject?: { kind: EnvironmentSubjectKind; id: string };
  subjectKinds?: readonly EnvironmentSubjectKind[];
  /**
   * Who may see a BRANCH build: the repos the caller may write. A default-branch build is
   * anyone's, as on the subject's card; a branch build is a task's, so it shows only when every
   * repo it checked out (`plan.checkouts`, frozen with the build, as a task's repos are) is one
   * of these. Absent: every build.
   */
  branchBuildsFor?: readonly string[];
  cursor?: string;
  limit: number;
}

export interface EnvironmentPage {
  environments: Environment[];
  nextCursor: string | null;
}

export interface EnvironmentStore {
  createEnvironment(environment: Environment): Promise<void>;
  getEnvironment(id: string): Promise<Environment | null>;
  /** Full-row write keyed by id. */
  saveEnvironment(environment: Environment): Promise<void>;
  /**
   * Writes the row only while the STORED status is one of `expected`, and answers whether it
   * landed — the settle's compare-and-set: a build that was superseded while it ran must not
   * write `ready` over that.
   */
  saveEnvironmentIfStatus(
    environment: Environment,
    expected: readonly EnvironmentStatus[],
  ): Promise<boolean>;
  /**
   * One subject's builds, newest first, at most `limit` (default 200). `ref` narrows to one
   * branch. The resolution, the card and the triggers all read the subject's recent history.
   */
  listEnvironmentsForSubject(
    subjectKind: EnvironmentSubjectKind,
    subjectId: string,
    opts?: { ref?: string; limit?: number },
  ): Promise<Environment[]>;
  /**
   * Narrow write: appends one host the egress proxy refused this BUILD, and says what happened.
   *
   * The sibling of `TaskStore.recordRunEgressRefusal`, and narrow for the sharper version of
   * its reason: the row this touches is being written by a builder that may settle at any
   * moment, and a whole-row save would be a `building` row put back over a `ready` one — the
   * exact overwrite `saveEnvironmentIfStatus` exists to prevent. `ended` is a build that has
   * settled (or is not here), which is when the proxy should stop reporting for that claim.
   */
  recordEnvironmentEgressRefusal(
    environmentId: string,
    refusal: EgressRefusal,
  ): Promise<EgressRefusalOutcome>;
  /**
   * Every build on this deployment, newest first, a page at a time — the builds list. `statuses`
   * and `subject` narrow it; `cursor` is the last page's `nextCursor` (`encodeListCursor`).
   */
  listEnvironments(query: EnvironmentListQuery): Promise<EnvironmentPage>;
  /** Every row in one of `statuses`, oldest first — the queue, the stranded check, retention. */
  listEnvironmentsByStatus(statuses: readonly EnvironmentStatus[]): Promise<Environment[]>;
  /** `superseded` and `failed` rows whose images the builder has not removed yet — a failed or
   * interrupted build may have pushed some before it ended — settled or retired (`updatedAt`)
   * before `before`, oldest first (then by id), at most `limit`, and only past `after`: the last
   * row of the page before. */
  listImagesToRemove(
    before: string,
    limit: number,
    after?: Pick<Environment, "updatedAt" | "id">,
  ): Promise<Environment[]>;
  /** Every row whose baked image is `image`, whatever its status: a re-layer answers its
   * source's, so one baked image can be several rows'. */
  listEnvironmentsByBakedImage(image: string): Promise<Environment[]>;
  /** Every row naming one of `digests` (`sha256:…`) as its image, its baked image or its machine
   * image, in any registry, whatever its status or stamp, compared exactly: whether anything still
   * names a digest — the registry reconcile's question about an untagged version, and the
   * removal pass's before it hands a row's digests over to delete. */
  listEnvironmentsNamingDigests(digests: readonly string[]): Promise<Environment[]>;
  /**
   * Stamps `imagesRemovedAt` on a row still `superseded` or `failed`, once its images are gone,
   * or takes the stamp back (`null`) when the row turns out to owe its baked image after all.
   * Narrow, like the egress append: the column is written here and nowhere else, so no whole-row
   * save puts a null back over it.
   */
  markEnvironmentImagesRemoved(id: string, at: string | null): Promise<void>;
  /**
   * Moves the next `queued` row — by BUILD_PRIORITY, then oldest — to `building` (stamping
   * `startedAt`) — unless `maxInFlight`
   * rows are already building, deployment-wide, in which case nothing moves and the answer is
   * null. Serialized across replicas, so the cap holds under concurrent claims.
   */
  claimNextBuild(at: string, maxInFlight: number): Promise<Environment | null>;
  /**
   * Stamps `updatedAt` on a row that is STILL `building` — the heartbeat of the replica running
   * it. That is the whole of the signal: a `building` row whose `updatedAt` has gone cold has no
   * live owner, whatever its build's timeout happens to be. Guarded on the status so a heartbeat
   * arriving a moment after a settle cannot put a finished row back in motion.
   */
  touchBuild(id: string, at: string): Promise<void>;
  /**
   * Takes over a cold `building` row: stamps `updatedAt` only while the STORED one is still
   * exactly `untouchedSince`, and answers with the row it claimed, or null.
   *
   * A compare-and-set, like `updatePatchBuildIfClaimed`, and for the same reason: every replica's
   * tick finds the same stranded row at the same moment, and exactly one of them must be the one
   * that goes and asks the builder about it. The loser reads null and leaves it alone.
   */
  claimStrandedBuild(
    id: string,
    untouchedSince: string,
    at: string,
  ): Promise<Environment | null>;

  createBuildGitKey(key: BuildGitKey): Promise<void>;
  /** The gateway's lookup, after a run key missed: the presented token, hashed. */
  getBuildGitKeyByTokenHash(tokenHash: string): Promise<BuildGitKey | null>;
  /** Stamps revokedAt on every live key of a build — it ended, its credential dies. */
  revokeBuildGitKeys(environmentId: string, at: string): Promise<void>;

  /**
   * The claim on a patch's check: inserts the row unless one already exists, and answers whether
   * this one landed. Two checkers of one patch (the submitter, the run's status read, the tick's
   * backstop) therefore agree on one checker before either reads the forge or queues a build.
   */
  createPatchBuild(row: PatchBuild): Promise<boolean>;
  /**
   * Writes the row only while the STORED one is unresolved (no `environmentId`, no `note`) and
   * still holds exactly `claimedUntil` — the lease holder's retake, release and resolution.
   * Answers whether it landed.
   */
  updatePatchBuildIfClaimed(row: PatchBuild, claimedUntil: string): Promise<boolean>;
  getPatchBuild(patchId: string): Promise<PatchBuild | null>;
  /** One run's patch builds, oldest first — the tool's and the run page's reading. */
  listPatchBuildsForRun(runId: string): Promise<PatchBuild[]>;
  /** The patch builds one environment answers — who to tell when it settles. */
  listPatchBuildsForEnvironment(environmentId: string): Promise<PatchBuild[]>;
  /** Every row whose run was not told yet, oldest first — unresolved checks included: the
   * tick's backstop. */
  listUnreportedPatchBuilds(): Promise<PatchBuild[]>;
  /**
   * Submitted patches last written at or after `since` that have no row at all, oldest first,
   * at most `limit` — a checker that died before its claim landed.
   */
  listUncheckedPatches(since: string, limit: number): Promise<Patch[]>;
  /** Stamps `reportedAt` only while it is null, and answers whether this call did: the one
   * delivery of a result. */
  markPatchBuildReported(patchId: string, at: string): Promise<boolean>;
}
