// What the registry-backed builders (kubernetes, Cloud Build) push, taken back out of Artifact
// Registry once the core says nothing needs it — the registry half of retention, which on docker
// is `docker image rm` (ports/environment_builder.ts: `removeImages`, `pruneCache`,
// `reconcileImages`). Spoken to through Artifact Registry's own REST API, as the control plane's
// Google identity, with nothing but fetch: the Docker Registry API can delete a manifest, but not
// a tag on its own.
//
// What one build leaves in `<registry>/<subject>` (buildkit_script.ts), every one a plain OCI image
// manifest — BuildKit pushes no index and no attestation here (measured on a GKE deployment:
// all 453 versions in `ryph-envs` single manifests), so there are no child manifests to orphan:
//   - `:<id>`, the environment, its digest recorded as the row's `image`
//   - `:baked-<id>`, its baked stage, recorded as the row's `bakedImage` — and as the baked image
//     of every re-layer of it, which is why the core decides when that digest goes
//   - `:machine-<id>`, the repo's `.ryph/Dockerfile`, when there is one, recorded as
//     `machineImage`. A machine built again unchanged is the same image, digest and all, so ONE
//     version carries the machine tag of every build of it (measured: 14 tags on one digest)
// and in `<registry>/cache`, one tag per scope and stage, re-pointed by every export: the version
// it left is untagged then, and Artifact Registry stamps its `updateTime` with that moment
// (measured: all 44 untagged cache versions in a live registry carry their successor's `createTime` as
// their `updateTime`). That stamp is the time `pruneCache` and `reconcileImages` age a version by.
//
// A removal untags by NAME and deletes by DIGEST. The three tags are computed from the build's id,
// exactly, and only ever deleted; a tag is mutable — every build identity may write the
// repository, so any tag can be pointed anywhere — and is never read to decide what to delete.
// What is deleted is the digests the core recorded from the build's own result, each without
// `force`: Artifact Registry refuses to delete a version that is still tagged, so a digest another
// build still tags (a shared machine, or one somebody re-tagged) stays, and goes when the last row
// naming it is removed and its tag with it. Every step is safe to repeat: a crash between the untag
// and the delete, or two replicas removing the two builds of one machine at once, ends with the
// next attempt deleting by the recorded digest.
//
// Invariants:
// - no `force`, anywhere: only an untagged version is ever deleted
// - only digests in the row's own package are deleted by a removal, and only untagged versions
//   in this deployment's own path of each registry by a reconcile — never a bare repository,
//   which another deployment could share, and never another cell's path
// - a reconcile deletes only what the core says nothing names, and only once it has been
//   untagged for longer than a build no row recorded may still be pushing
// - nothing tagged in the cache is ever deleted, and nothing untagged until it has been retired
//   for longer than a build may run: an import reads blobs for as long as its build does
// - an answer is only taken from Google's own JSON error: a 404 without one (a malformed path, a
//   front end) is not "already gone"

import type { Diagnostics } from "../../ports/diagnostics.ts";
import type { PassSummary, RemoveImagesSpec } from "../../ports/environment_builder.ts";
import { safeName } from "./dockerfile.ts";
import { GoogleApiError, googleRequest } from "./google_api.ts";
import { isDigest } from "../../helpers/digest.ts";

const API = "https://artifactregistry.googleapis.com/v1";

/** One registry as Artifact Registry names it: a repository, and the path inside it. */
export interface ArtifactRepository {
  project: string;
  location: string;
  repository: string;
  /** The path every package of this registry starts with, slash included: `ryph/` for
   * `…/ryph-envs/ryph` (a cell's), empty for the bare repository. */
  prefix: string;
}

/** A path segment that names nothing of its own: `.` and `..` are refused wherever they appear. */
const dotSegment = (segment: string) => segment === "." || segment === "..";

/**
 * `<location>-docker.pkg.dev/<project>/<repository>[/<path>]` as Artifact Registry's API names it,
 * or null for any other registry — gcr.io and a laptop's registry among them, which this does not
 * remove from — and for a path with a `.` or `..` segment.
 */
export function parseArtifactRegistry(registry: string): ArtifactRepository | null {
  const match = registry.replace(/\/+$/, "").match(
    /^([a-z0-9-]+)-docker\.pkg\.dev\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z0-9][a-z0-9._-]*)((?:\/[a-z0-9._-]+)*)$/,
  );
  if (match === null) return null;
  const path = match[4] === "" ? [] : match[4].slice(1).split("/");
  if (path.some(dotSegment)) return null;
  return {
    location: match[1],
    project: match[2],
    repository: match[3],
    prefix: path.length === 0 ? "" : `${path.join("/")}/`,
  };
}

/** A digest-pinned image in Artifact Registry: its repository, package and digest, or null. */
export function parseArtifactImage(
  image: string,
): { repo: ArtifactRepository; pkg: string; digest: string } | null {
  const at = image.lastIndexOf("@");
  const digest = image.slice(at + 1);
  if (at < 0 || !isDigest(digest)) return null;
  // `host/project/repository/package…`, the last segment maybe carrying a tag as well.
  const parts = image.slice(0, at).split("/");
  parts[parts.length - 1] = parts[parts.length - 1].split(":")[0];
  const repo = parseArtifactRegistry(parts.slice(0, 3).join("/"));
  if (repo === null || parts.length < 4) return null;
  if (parts.some((part) => part === "" || dotSegment(part))) return null;
  return { repo, pkg: parts.slice(3).join("/"), digest };
}

/** Whether `a` and `b` are one Artifact Registry repository, whatever path inside it. */
function sameRepository(a: ArtifactRepository, b: ArtifactRepository): boolean {
  return a.project === b.project && a.location === b.location && a.repository === b.repository;
}

export interface ArtifactRegistryCleanerOptions {
  /** `RYPH_ENV_REGISTRY`: default-branch images and every layer cache. */
  registry: string;
  /** `RYPH_ENV_BRANCH_REGISTRY`: branch images. */
  branchRegistry: string;
  /** A cap on each API request. */
  requestTimeoutMs?: number;
  /** How long a version's deletion is watched for its verdict before the removal says "ask
   * again". */
  operationWaitMs?: number;
  operationPollMs?: number;
}

export interface ArtifactRegistryCleanerDeps {
  fetch: typeof fetch;
  /** An OAuth access token for the Google APIs: the control plane's own identity. */
  token: () => Promise<string>;
  now?: () => number;
}

export interface ArtifactRegistryCleaner {
  /** `EnvironmentBuilder.removeImages` for a build that pushed here. */
  removeBuild(spec: RemoveImagesSpec): Promise<boolean>;
  /** `EnvironmentBuilder.pruneCache`: untagged cache versions retired for `retiredForMs`. */
  pruneCache(retiredForMs: number): Promise<PassSummary>;
  /** `EnvironmentBuilder.reconcileImages`. */
  reconcileImages(opts: {
    untaggedForMs: number;
    inUse: (digests: string[]) => Promise<Set<string>>;
  }): Promise<PassSummary>;
  /** `EnvironmentBuilder.removalStats`. */
  removalStats(): { versionsDeleteRequested: number };
}

interface Version {
  name: string;
  createTime?: string;
  updateTime?: string;
  relatedTags?: Array<{ name: string }>;
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
}

/** What a deletion came to: the version is gone, it is still tagged and so kept, or no verdict
 * arrived in time — which a removal answers as "ask again". */
type Verdict = "gone" | "kept" | "unknown";

/** google.rpc.Code NOT_FOUND, in an operation's error. */
const NOT_FOUND = 5;

/** The registry refused this deployment's own identity: every other request would be refused too,
 * so a pass stops at the first one rather than ask again for every candidate. */
const deniedUs = (err: unknown) =>
  err instanceof GoogleApiError && (err.status === 401 || err.status === 403);

/** A deletion the API turned down for something about the version, not about the asking: a 4xx
 * other than not-signed-in, not-allowed and not-found. */
const refused = (err: unknown) =>
  err instanceof GoogleApiError && err.status >= 400 && err.status < 500 &&
  ![401, 403, 404].includes(err.status);

/** When a version last changed: the later of its creation and its `updateTime` (a tag added,
 * moved or — unmeasured — deleted). */
function changedAt(v: { createTime?: string; updateTime?: string }): number {
  return Math.max(Date.parse(v.createTime ?? ""), Date.parse(v.updateTime ?? v.createTime ?? ""));
}

/** How many digests one `inUse` question carries. */
const IN_USE_BATCH = 50;

/** How many untagged versions one reconcile pass tries to delete, in all and in one package. */
const RECONCILE_PER_PASS = 500;
const RECONCILE_PER_PACKAGE = 200;

/**
 * The cleaner for a builder's two registries, or null when either is not Artifact Registry —
 * the builder then has no `removeImages`, and says nothing it cannot do.
 */
export function artifactRegistryCleaner(
  opts: ArtifactRegistryCleanerOptions,
  diag: Diagnostics,
  deps: ArtifactRegistryCleanerDeps,
): ArtifactRegistryCleaner | null {
  const registry = parseArtifactRegistry(opts.registry);
  const branchRegistry = parseArtifactRegistry(opts.branchRegistry);
  if (registry === null || branchRegistry === null) return null;
  const request = {
    fetch: deps.fetch,
    token: deps.token,
    timeoutMs: opts.requestTimeoutMs ?? 60_000,
  };
  const operationWaitMs = opts.operationWaitMs ?? 30_000;
  const operationPollMs = opts.operationPollMs ?? 1_000;
  const now = deps.now ?? Date.now;
  /** The package the next reconcile starts at, where the last one ran out of budget. */
  let resumeAt: string | null = null;
  /** Deletions the registry accepted since this cleaner was made (`removalStats`). */
  let deleteRequested = 0;

  const repoPath = (repo: ArtifactRepository) =>
    `projects/${repo.project}/locations/${repo.location}/repositories/${repo.repository}`;
  // A package id holds the registry's path, slashes and all: one path segment, encoded.
  const pkgPath = (repo: ArtifactRepository, pkg: string) =>
    `${repoPath(repo)}/packages/${encodeURIComponent(pkg)}`;
  const tagPath = (repo: ArtifactRepository, pkg: string, tag: string) =>
    `${pkgPath(repo, pkg)}/tags/${encodeURIComponent(tag)}`;
  const versionPath = (repo: ArtifactRepository, pkg: string, digest: string) =>
    `${pkgPath(repo, pkg)}/versions/${encodeURIComponent(digest)}`;

  /**
   * One request: the answer's body, or null where Google said NOT_FOUND — a thing already gone
   * is an answer. A 404 that is not Google's JSON error throws: it says nothing about the thing.
   */
  async function call(method: "GET" | "DELETE", path: string): Promise<unknown> {
    try {
      return await googleRequest(request, method, `${API}/${path}`) ?? {};
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404 && err.reason === "NOT_FOUND") {
        return null;
      }
      throw err;
    }
  }

  /** Every page of a list, collected before anything is deleted: deleting while paging moves
   * what the next page holds. */
  async function listAll<T>(path: string, key: string): Promise<T[] | null> {
    const all: T[] = [];
    let pageToken: string | undefined;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await call(
        "GET",
        `${path}${sep}pageSize=1000${
          pageToken === undefined ? "" : `&pageToken=${encodeURIComponent(pageToken)}`
        }`,
      ) as Record<string, unknown> | null;
      if (page === null) return null;
      all.push(...(page[key] as T[] | undefined ?? []));
      pageToken = (page.nextPageToken as string | undefined) || undefined;
    } while (pageToken !== undefined);
    return all;
  }

  /** Takes one tag off, whatever it points at; one that is not there is already off. */
  async function untag(repo: ArtifactRepository, pkg: string, tag: string): Promise<void> {
    await call("DELETE", tagPath(repo, pkg, tag));
  }

  /**
   * Deletes one version, never forced, so only an untagged one goes. `watch`: waits up to
   * `operationWaitMs` for the operation's verdict, and answers `unknown` without one.
   */
  async function deleteVersion(path: string, watch: boolean): Promise<Verdict> {
    let op: Operation | null;
    try {
      op = await call("DELETE", `${path}?force=false`) as Operation | null;
    } catch (err) {
      if (refused(err)) return await afterRefusal(path, err as GoogleApiError);
      throw err;
    }
    if (op === null) return "gone";
    // Accepted: the registry has the deletion now, finished or not. What the pass's summary counts.
    deleteRequested++;
    if (!watch) return op.done === true && op.error === undefined ? "gone" : "unknown";
    const until = now() + operationWaitMs;
    while (op.done !== true) {
      if (op.name === undefined || now() >= until) return "unknown";
      await new Promise((resolve) => setTimeout(resolve, operationPollMs));
      try {
        // An operation gone from under its name has nothing more to say about the version.
        op = await call("GET", op.name) as Operation | null;
        if (op === null) return "unknown";
      } catch (err) {
        // Accepted, but its verdict unread: the next pass deletes by the same digest again,
        // and reads its answer as a 404 or a refusal.
        diag.debug("environment_builder.registry.operation_unread", {
          version: path,
          err: String(err),
        });
        return "unknown";
      }
    }
    if (op.error === undefined || op.error.code === NOT_FOUND) return "gone";
    return await afterRefusal(
      path,
      new GoogleApiError(500, `deleting ${path} failed: ${op.error.message ?? op.error.code}`),
    );
  }

  /**
   * A refusal of an unforced deletion, read for what it means rather than by its code — which no
   * documentation states for a version that is still tagged (gcloud refuses one before asking):
   * the version is read back, and still there with a tag is KEPT, gone is gone, and anything else
   * is the refusal itself.
   */
  async function afterRefusal(path: string, err: GoogleApiError): Promise<Verdict> {
    const version = await call("GET", `${path}?view=FULL`) as Version | null;
    if (version === null) return "gone";
    if ((version.relatedTags ?? []).length > 0) {
      diag.debug("environment_builder.registry.version_kept", { version: path });
      return "kept";
    }
    throw err;
  }

  return {
    async removeBuild(spec) {
      const repo = spec.defaultBranch ? registry : branchRegistry;
      const pkg = `${repo.prefix}${spec.subjectKey}`;
      const own = safeName(spec.environmentId, 100);
      // 1. This build's names, exactly as it gave them out — never matched, never read back.
      for (const tag of [own, `baked-${own}`, `machine-${own}`]) await untag(repo, pkg, tag);
      // 2. What it recorded, by digest, in its own package alone.
      let answered = true;
      for (const image of [spec.image, spec.machineImage, spec.bakedImage]) {
        if (image === null) continue;
        const at = parseArtifactImage(image);
        if (at === null || !sameRepository(at.repo, repo) || at.pkg !== pkg) {
          // A digest the row recorded somewhere this removal will never delete: a leak, said
          // once, with the reference, and the row done with — asking again on every pass, on
          // every replica, would answer nothing more. An operator can delete it by hand.
          diag.warn("environment_builder.registry.leak", { image, package: pkg });
          continue;
        }
        const verdict = await deleteVersion(versionPath(repo, pkg, at.digest), true);
        // Kept: another build still tags it, and its row names the digest too, so it goes when
        // that one is removed. Unknown: asked again on the next pass.
        if (verdict === "unknown") answered = false;
      }
      diag.debug("environment_builder.registry.removed", {
        environmentId: spec.environmentId,
        package: pkg,
        answered,
      });
      return answered;
    },

    async pruneCache(retiredForMs) {
      const summary: PassSummary = { candidates: 0, deleteRequested: 0, failures: 0 };
      // A bare repository's `cache` may be another deployment's as well, as with the reconcile.
      if (registry.prefix === "") {
        diag.warn("environment_builder.registry.prune_refused", {
          repository: repoPath(registry),
          why: "the registry has no path of this deployment's own",
        });
        return summary;
      }
      const pkg = `${registry.prefix}cache`;
      const cutoff = now() - retiredForMs;
      const versions = await listAll<Version>(
        `${pkgPath(registry, pkg)}/versions?view=FULL`,
        "versions",
      );
      const before = deleteRequested;
      for (const version of versions ?? []) {
        if ((version.relatedTags ?? []).length > 0) continue;
        // Retired when its tag moved on to the next export: that moment is its `updateTime`
        // (measured on a live registry, every untagged cache version), read as the reconcile reads it.
        if (!(changedAt(version) < cutoff)) continue;
        summary.candidates++;
        try {
          // Without `force`: a tag re-pointed at it since the listing keeps it.
          await deleteVersion(version.name, false);
        } catch (err) {
          if (deniedUs(err)) throw err;
          summary.failures++;
          summary.firstError ??= String(err);
          diag.debug("environment_builder.registry.prune_failed", {
            version: version.name,
            err: String(err),
          });
        }
      }
      summary.deleteRequested = deleteRequested - before;
      return summary;
    },

    async reconcileImages({ untaggedForMs, inUse }) {
      const summary: PassSummary = {
        candidates: 0,
        deleteRequested: 0,
        failures: 0,
        packageFailures: 0,
      };
      const before = deleteRequested;
      const cutoff = now() - untaggedForMs;
      // Every subject package under this deployment's own path of each registry, in one order.
      const targets: Array<{ repo: ArtifactRepository; pkg: string; key: string }> = [];
      const seen = new Set<string>();
      for (const repo of [registry, branchRegistry]) {
        const key = `${repoPath(repo)}/${repo.prefix}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // A bare repository may be another deployment's as well as this one's; what is untagged
        // there is not this deployment's to judge.
        if (repo.prefix === "") {
          diag.warn("environment_builder.registry.reconcile_refused", {
            repository: repoPath(repo),
            why: "the registry has no path of this deployment's own",
          });
          continue;
        }
        const packages = await listAll<{ name: string }>(`${repoPath(repo)}/packages`, "packages");
        for (const { name } of packages ?? []) {
          const pkg = decodeURIComponent(name.slice(name.lastIndexOf("/packages/") + 10));
          const subject = pkg.slice(repo.prefix.length);
          // A subject's package right under this path: not the cache, which `pruneCache` ages
          // by its own rule, and not anything deeper or beside it (another cell's).
          if (!pkg.startsWith(repo.prefix) || subject === "cache") continue;
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(subject)) continue;
          targets.push({ repo, pkg, key: `${repoPath(repo)}/${pkg}` });
        }
      }
      targets.sort((a, b) => a.key.localeCompare(b.key));
      // Where the last pass ran out, so a package that always fills the budget does not keep
      // every package after it waiting.
      const from = resumeAt === null
        ? 0
        : Math.max(0, targets.findIndex((t) => t.key >= resumeAt!));
      const order = [...targets.slice(from), ...targets.slice(0, from)];
      resumeAt = null;
      let budget = RECONCILE_PER_PASS;
      /**
       * The age gate, on the LATER of a version's `createTime` and `updateTime`. That Artifact
       * Registry moves `updateTime` when a version's last tag is DELETED is not measured (only
       * when a tag moves on to another version is), and nothing here depends on it: what keeps a
       * version a row recorded is `inUse`, whatever its age, and a version no row records yet —
       * pushed by a build still in flight — is as new as its push, so its `createTime` alone holds
       * it past the gate, which outlasts any build.
       */
      const untaggedAt = changedAt;
      for (const { repo, pkg, key } of order) {
        if (budget <= 0) break;
        try {
          const versions = await listAll<Version>(
            `${pkgPath(repo, pkg)}/versions?view=FULL`,
            "versions",
          );
          const candidates = (versions ?? [])
            .filter((v) => (v.relatedTags ?? []).length === 0 && untaggedAt(v) < cutoff)
            .sort((a, b) => untaggedAt(a) - untaggedAt(b))
            .map((v) => decodeURIComponent(v.name.slice(v.name.lastIndexOf("/versions/") + 10)))
            .filter(isDigest);
          // Oldest first, and only so many DELETIONS a package and a pass — what is still in use
          // counts for nothing, so a package of versions somebody still runs never uses the
          // budget up. One that fails is counted and passed over: it cannot stall the rest.
          let attempts = 0;
          for (let at = 0; at < candidates.length; at += IN_USE_BATCH) {
            if (attempts >= RECONCILE_PER_PACKAGE || budget <= 0) break;
            const batch = candidates.slice(at, at + IN_USE_BATCH);
            const named = await inUse(batch);
            for (const digest of batch) {
              if (named.has(digest)) continue;
              if (attempts >= RECONCILE_PER_PACKAGE || budget <= 0) break;
              attempts++;
              budget--;
              summary.candidates++;
              try {
                await deleteVersion(versionPath(repo, pkg, digest), false);
              } catch (err) {
                if (deniedUs(err)) throw err;
                summary.failures++;
                summary.firstError ??= String(err);
                diag.debug("environment_builder.registry.reconcile_failed", {
                  version: versionPath(repo, pkg, digest),
                  err: String(err),
                });
              }
            }
          }
        } catch (err) {
          // A package that cannot be listed (or asked about) is passed over, so the packages
          // sorted after it are reconciled all the same — unless it was this identity that was
          // refused, which every package after it would be too.
          if (deniedUs(err)) throw err;
          summary.packageFailures = (summary.packageFailures ?? 0) + 1;
          summary.firstError ??= String(err);
          diag.warn("environment_builder.registry.reconcile_package_failed", {
            package: pkg,
            err: String(err),
          });
        }
        // Stopped by the pass's budget inside this package: the next pass starts here.
        if (budget <= 0) resumeAt = key;
      }
      summary.deleteRequested = deleteRequested - before;
      return summary;
    },

    removalStats: () => ({ versionsDeleteRequested: deleteRequested }),
  };
}
