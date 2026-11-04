// Building a subject's environment image, as the core sees it: hand over a spec, get back a
// digest-pinned image or a failure. Shaped like the provisioner port: the adapter owns HOW (buildx
// on the host, a rootless BuildKit Job, Cloud Build), the core owns WHEN and FROM WHAT.
//
// A build OUTLIVES the process that started it, where the backend has a durable record of one (a
// kubernetes Job is one; a child process on the host is not). `adopt` is how the next control
// plane asks for that record instead of guessing: a replaced pod, a crash or a rollout mid-build
// then costs nothing, because whoever comes next attaches to the build already running and settles
// it. That is what `build` and `adopt` are to each other — the same watch, entered from either end.
//
// Which is why ending a build and DISCARDING the record of it are two calls, not one. Reading a
// build's result does not preserve it; writing the row does. An adapter that deleted its Job the
// moment it had read the log would leave a control plane that died in between with an image in
// the registry, a row still `building`, and no record for the next control plane to read — which
// would then be told, truthfully and uselessly, that there is no such build. So the record
// outlives the watch and dies on `discard`, which the core calls once the row is written.
//
// Invariants:
// - the spec carries only trusted, resolved inputs: commit ids, a tree hash, digests. The control
//   plane never parses a Dockerfile; BuildKit does, inside the builder's sandbox
// - a result's `image` is always digest-pinned (`…@sha256:…`), or a local image id on docker,
//   because a run freezes it and a tag can be moved
// - `cacheScope` is the only thing that decides which layer cache a build may WRITE. The core
//   passes the default-branch scope only for default-branch builds; a branch build writes none
// - `defaultBranch` picks the identity a build pushes as, where the backend has identities: a
//   branch build's cannot write the default branch's images or cache, so a RUN step that reaches
//   the credential (kubernetes, docs/environment-builders.md) still cannot poison them

import type { SetupWarning } from "../core/setup_warnings.ts";

/** One repository baked into the image, at `/ryph/work/<path>`. */
export interface BuildCheckout {
  /** The directory name under /ryph/work — the same name the runner's layout uses. */
  path: string;
  /** The connected repo this checkout is of. */
  connectedRepoId: string;
  /** The ref built (a branch name) and the exact commit. */
  ref: string;
  commit: string;
}

export interface BuildSpec {
  environmentId: string;
  /** e.g. `repo-<id>` or `workspace-<id>`; the adapter derives the pushed image name from it. */
  subjectKey: string;
  /**
   * Whose `.ryph/Dockerfile` defines the machine: the path (under /ryph/work) of the environment
   * repo's checkout, or null for the universal image.
   */
  dockerfileFrom: string | null;
  /** In member order. setup.yml runs in each, in this order. */
  checkouts: BuildCheckout[];
  /** The deployment's pinned universal image (RYPH_ENV_BASE_IMAGE), by digest. */
  baseImage: string;
  /** The image stage 4 copies /opt/ryph from (RYPH_HARNESS_IMAGE), by digest. */
  harnessImage: string;
  /** Whether this builds the subject's default branch: the trusted ref, and the trusted push. */
  defaultBranch: boolean;
  /**
   * The layer-cache scopes: `read` in order of preference, `write` the one this build may
   * populate, or null for none. A default-branch build reads and writes its subject's default
   * scope; a branch build reads the default scope and writes nothing, so no branch can seed
   * layers another build picks up.
   */
  cacheScope: { read: string[]; write: string | null };
  /**
   * A RE-LAYER: the baked image (stages 1–3, `BuildSuccess.bakedImage`) of the environment being
   * moved onto the current harness. Set, the build is stage 4 alone, `FROM` this image — no
   * clone, no bake, no cache — so it neither costs a warm build nor depends on the built commit
   * still being on its branch. Null: a full build.
   */
  relayerFrom: string | null;
  /**
   * An INCREMENTAL build: the baked image of an earlier build of the same machine, which stages
   * 2–3 run on instead of the machine — each checkout is moved to its commit in place and
   * setup.yml reruns on the warm tree. No machine build and no layer cache. Null: a cold build.
   * Never set together with `relayerFrom`.
   */
  warmFrom: string | null;
  /** Proxy settings for build steps: HTTPS_PROXY / NO_PROXY and the build's egress claim. */
  proxyEnv: Record<string, string>;
  /**
   * What the adapter needs to clone `checkouts` OUTSIDE the build (the clone is a named build
   * context, never a RUN step, so no credential reaches repo-authored code): a clone URL per
   * checkout path, and a build-scoped, short-lived git credential as env for the cloning git.
   */
  clone: { urls: Record<string, string>; env: Record<string, string> };
  /** Wall-clock cap (RYPH_ENV_BUILD_TIMEOUT). The adapter kills the build past it. */
  timeoutMs: number;
}

export interface BuildSuccess {
  ok: true;
  /** Digest-pinned image ref, the only form a run freezes. */
  image: string;
  /**
   * The same build without the harness layer (stages 1–3): what a later re-layer builds FROM,
   * so a harness upgrade never re-runs the bake. Digest-pinned, or on docker a local tag unique
   * to this environment that nothing re-points. A re-layer answers the image it was given.
   */
  bakedImage: string;
  /**
   * The machine image (the repo's `.ryph/Dockerfile`) where the build pushed one, digest-pinned:
   * retention deletes it by this digest once no build names it. Absent or null where it pushed
   * none — the universal image as the machine, a re-layer, or docker, whose machine tag dies with
   * the build.
   */
  machineImage?: string | null;
  sizeBytes: number | null;
  /** Toolchain versions `ryph-bake` recorded (e.g. {"rustc": "1.97.1", "node": "24.3.0"}). */
  toolchains: Record<string, string>;
  /**
   * The repos whose setup.yml did not finish when `ryph-bake` ran it (a failing step, or an
   * invalid file), read from the warnings file it writes beside the toolchain record, cleaned
   * (`setupWarningsFrom`). A setup warning never fails a build. Absent or empty: none.
   */
  setupWarnings?: SetupWarning[];
  /** The full build log, for the object store (`environments/` prefix). */
  log: string;
  /**
   * For a build asked to be incremental (`warmFrom`): whether it was. A builder builds cold
   * instead when the machine changed under the image it would start from, and says so here, so
   * the row's record of what it is made of stays true. Absent: as asked.
   */
  warm?: boolean;
}

export interface BuildFailure {
  ok: false;
  /** `refused`: this backend cannot build at all (manual), and the environment page says why. */
  kind: "failed" | "timeout" | "refused";
  message: string;
  /** Tail of the build log, shown to a run that was waiting on this build. */
  logTail: string;
  log: string;
}

export type BuildResult = BuildSuccess | BuildFailure;

/**
 * What `adopt` needs, and deliberately nothing more: enough to name the backend's record of a
 * build and to read its answer back. A subset of `BuildSpec`, so a spec is one — but an adoption
 * is assembled from the stored row ALONE, with no forge read and no freshly minted credential.
 * The build it takes over already holds whatever it needed; a repo disconnected since it started
 * must not stop the control plane from learning that it succeeded.
 */
export type AdoptSpec = Pick<
  BuildSpec,
  "environmentId" | "subjectKey" | "defaultBranch" | "relayerFrom" | "timeoutMs"
>;

/** What the backend knows about a build the asking process did not start. */
export type AdoptResult =
  /**
   * There was a record, and this is how the build ended: a running one was watched to its end
   * first, so this arrives whenever the build does. The core settles the row on it exactly as it
   * settles one of its own.
   */
  | { kind: "settled"; result: BuildResult }
  /**
   * No record at all: nobody is building this and nobody will. The core fails the row NOW rather
   * than wait out a timeout — the answer an adapter with no durable record of its own always
   * gives, and the honest one.
   */
  | { kind: "gone" }
  /**
   * The backend could not be asked (its API refused, or did not answer). Nothing is known, so
   * nothing is decided: the row stays as it is and a later tick asks again.
   */
  | { kind: "unknown"; why: string };

export interface EnvironmentBuilder {
  /** Which backend this is, for the environment page and for refusals. */
  readonly kind: "docker" | "kubernetes" | "cloud-build" | "manual";
  /**
   * Builds one environment. Resolves on success or failure; rejects only on a bug. The signal
   * aborts a build (cancelled or superseded); the adapter must leave nothing running.
   */
  build(spec: BuildSpec, opts: { signal: AbortSignal }): Promise<BuildResult>;
  /**
   * Takes over a build THIS PROCESS DID NOT START: finds the backend's record of it, watches it
   * to its end if it is still running, and answers with the result — or says the record is gone,
   * or that the backend could not be asked. Rejects only on a bug.
   *
   * The signal means what it means on `build`: stop, and leave nothing running. An adapter whose
   * builds die with the process that started them answers `gone`, once it has removed what such
   * a build left that no row will record (docker: its tags).
   */
  adopt(spec: AdoptSpec, opts: { signal: AbortSignal }): Promise<AdoptResult>;
  /**
   * Drops the backend's record of one build: a Job still running stops, and a finished one stops
   * holding its pod and the work volume the namespace's quota counts.
   *
   * The core calls this once the build's row has been WRITTEN — never merely read (see the top of
   * this file) — and for a build superseded while the process running it was gone, which is the
   * other way a record ends up with nobody left to read it. Called more than once for the same
   * build, and for builds that were never started: idempotent, and a record that is not there is
   * not an error. Rejects only where the backend could not be asked, which the core logs.
   */
  discard(environmentId: string): Promise<void>;
  /**
   * The log of a build still RUNNING, as far as it has got, from wherever the backend keeps it —
   * so a person watching a slow build sees what it is doing rather than a spinner. Asked by any
   * replica, not only the one running the build, so an adapter answers from the backend's own
   * record (a pod log, a log object) where it has one. Null when there is nothing to show yet or
   * nothing can be asked; never rejects.
   */
  liveLog(spec: LiveLogSpec): Promise<string | null>;
  /**
   * Removes a retired build's images from where this backend keeps them — the local image store
   * on docker, the environments registries on kubernetes and Cloud Build when they are Artifact
   * Registry — so neither a machine's disk nor a registry bill is where every superseded build
   * ends up. Absent where the backend cannot delete what it pushed (a registry it has no API for),
   * and there the registry's own cleanup, if any, is the operator's.
   *
   * The core asks for a `superseded` row nothing still needs — no live run on it, no unsettled
   * check suite, no queued or running build that starts from its baked image — and, `recorded`
   * false and with no digest to delete, for a build no row records: one that succeeded after its
   * row moved on (at once), and one that ended without a result (`failed`, or superseded
   * mid-build) but may have pushed some of its images first, once it can no longer be pushing.
   * Such a build's own names go; its digests are the reconcile's, since what it reported is only
   * its own word. Answers true once the images are
   * gone (or were never there, or are now only another build's) and false when they may not be: the
   * backend kept them because something it can see still uses them (a container), or a deletion
   * gave no verdict yet. The core asks again on a later pass, so a removal must be safe to repeat.
   * Rejects only where the backend could not be asked, which the core logs.
   *
   * WHAT is deleted is the digests the spec names, which the core recorded from the build's own
   * result. A name the adapter derives from the build's id (a tag) is only ever untagged: a tag is
   * mutable, and anything that may push to the registry may point one anywhere.
   *
   * A registry refuses nothing a pod is pulling or a node may pull again, so what keeps a removal
   * from pulling an image out from under a run there is the core alone: its holds, and the grace
   * after retirement that outlasts anything that resolved the row while it was still ready.
   */
  removeImages?(spec: RemoveImagesSpec): Promise<boolean>;
  /**
   * Deletes layer-cache entries no build can still be reading, where the cache lives in a
   * registry: an export that a newer one replaced more than `retiredForMs` ago. A build reads its
   * cache lazily for as long as it runs, so `retiredForMs` must outlast a build. The core calls it
   * on the removal pass; the docker builder prunes its cache directories at each build instead,
   * and leaves this absent. Answers what it did, for the pass's one line in the log. Rejects only
   * where the backend could not be asked.
   */
  pruneCache?(opts: { retiredForMs: number }): Promise<PassSummary>;
  /**
   * Deletes environment images the registry holds UNTAGGED that nothing names — what a failed
   * build pushed, what a removal untagged and could not delete, what builds left before removal
   * existed. Only in this deployment's own path of each registry, never a bare repository, which
   * another deployment could share. `inUse` is the core's answer, from its rows and runs, to which
   * of a batch of digests something still names; the adapter only lists and deletes, and only what
   * has been untagged for `untaggedForMs`. Rejects only where the backend could not be asked.
   */
  reconcileImages?(opts: {
    untaggedForMs: number;
    inUse: (digests: string[]) => Promise<Set<string>>;
  }): Promise<PassSummary>;
  /**
   * How many deletions this backend has asked of its registry since it started, cumulative —
   * accepted by the registry, not necessarily finished — so the removal pass can say how many it
   * caused. Absent where there is no registry.
   */
  removalStats?(): { versionsDeleteRequested: number };
}

/** What one prune or reconcile did: the versions it weighed, the deletions the registry accepted,
 * the deletions that failed, the packages that could not be read at all (a reconcile's), and the
 * first failure's words. A refusal of the backend's own identity (401, 403) is no item's failure:
 * it ends the call, which rejects. */
export interface PassSummary {
  candidates: number;
  deleteRequested: number;
  failures: number;
  packageFailures?: number;
  firstError?: string;
}

/** What `liveLog` needs to find a build's log. */
export type LiveLogSpec = Pick<BuildSpec, "environmentId" | "defaultBranch">;

/** What `removeImages` needs to name a build's images. */
export type RemoveImagesSpec =
  & Pick<BuildSpec, "environmentId" | "subjectKey" | "defaultBranch">
  & {
    /**
     * Whether a row records this build's result: false for a build that failed, was superseded
     * mid-build, or succeeded after its row moved on — whose images, if it pushed any, only its
     * own names can find. Such a removal passes no digest.
     */
    recorded: boolean;
    /**
     * The build's environment image as the row recorded it, to delete — or null to leave it:
     * never recorded, or
     * named by another row not yet done with or a live run, which the core asks first. The same
     * for `machineImage` and `bakedImage`: a digest passed is one nothing else names.
     */
    image: string | null;
    /** The machine image the build pushed (`BuildSuccess.machineImage`), or null. Builds of one
     * unchanged machine share it, so the core passes it only from the last row naming it. */
    machineImage: string | null;
    /**
     * The row's baked image, or null to keep it. A re-layer answers the baked image it was given
     * (`BuildSuccess.bakedImage`), so one baked image can be several rows'; the core passes null
     * while any row it is not removing still names it.
     */
    bakedImage: string | null;
  };
