// Serving a CHECK CANDIDATE: the one commit a check pod's grant names, out of a repo of its own.
// The gateway otherwise serves only the upstream cache; this is the single place it serves
// anything else. A candidate is one of two things (`CheckCandidate`):
// - the head of a run's bundle, which no upstream has yet, staged out of the patch store
// - a change request's head the forge already has — somebody's push to a pull request or a
//   patch — fetched by id into the cache entry and named by a ref only in the candidate's repo
//   (see `stageFromForge` for what that means for a fork's objects)
//
// Why not publish the candidate into the cache entry: that entry is SHARED by every run of the
// upstream, and every clone advertises every ref in it — one run's unsubmitted work would become
// readable by every other run of the repo. A scratch repo per candidate keeps the head where only
// its grant reaches it.
//
// Invariants:
// - a bundle candidate's bytes are the ones intake stored, staged by `stageBundle` — the same
//   function a submission publishes through — so the provenance anchor is re-checked here: the
//   staged head must equal the grant's `headSha`, or nothing is served
// - the bundle key must be the one intake would have filed THIS repo's head under
//   (`…/<connectedRepoId>/<headSha>.bundle`, @ryph/shared/lines `runBundleKey`): a grant naming some
//   other repo's bundle, or some other commit's, is refused before the patch store is asked
// - a forge candidate's head is re-checked in its own repo before a ref names it: a head the
//   forge does not have is a terminal 409, never a candidate missing its commit
// - a staged repo appears under its final name atomically, or not at all: a clone never reads
//   a half-made one, and two concurrent first requests converge on one
// - small: a candidate holds only the bundle's objects (a forge candidate, none) and borrows
//   the rest from the cache entry (git alternates, one way — no ref of the candidate's is
//   written into the entry). It is staged beside the other candidates, so it arrives by rename,
//   never by a copy
// - a candidate is served only while the entry it borrows from is still there: one whose entry
//   is gone or was rebuilt elsewhere is staged again
// - disposable, like the cache: a candidate dir is rebuilt on demand from the durable bundle or
//   the forge, and anything untouched for `CANDIDATE_TTL_MS` is swept

import type { Dirent } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { RepoCoords, RunGrantRepo } from "../core/types.ts";
import { normalizeBaseRef } from "@ryph/shared/refs";
import { sha256Hex } from "@ryph/sealed";
import { type Git, makeGit } from "../helpers/git_exec.ts";
import { stageBundle, TerminalSubmitError } from "../helpers/submit.ts";
import { type Credential, UpstreamRefused } from "../ports/repo_cache.ts";
import { stageStream } from "./bundle_intake.ts";
import { json } from "@ryph/shared/http";
import { upstreamFor } from "./fetch_auth.ts";
import type { AppDeps } from "./app.ts";

/** How long a staged candidate outlives its last use. A check pod clones within minutes of its
 * launch, and a candidate swept too early is only staged again from its bundle. */
export const CANDIDATE_TTL_MS = 30 * 60_000;

/** The candidate dirs' parent, under the staging dir the composition root wipes on boot. */
export const candidatesDir = (stagingDir: string): string => `${stagingDir}/candidates`;

/**
 * Where one candidate lives. The head and the repo name it; the branch and the refs it was
 * seeded from are hashed in too, so two grants that happen to share a head but not a branch
 * never reuse each other's repo — reuse is decided by a ref this name must therefore imply.
 */
async function candidatePath(
  stagingDir: string,
  repo: RunGrantRepo,
  branchName: string,
  headSha: string,
) {
  const salt = await sha256Hex(
    [branchName, repo.ref, repo.targetRef ?? ""].join("\0"),
  );
  return `${candidatesDir(stagingDir)}/${repo.connectedRepoId}-${headSha}-${salt.slice(0, 12)}`;
}

/** Whether `dir` is a finished candidate for this head: its output branch resolves to it. */
async function holds(dir: string, branchName: string, headSha: string, git: Git) {
  try {
    const at = await git(
      dir,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${branchName}^{commit}`,
    );
    return at === headSha;
  } catch {
    return false;
  }
}

/** The objects dir `dir` borrows from, or null when it borrows from none (or is not a repo). */
async function borrowsFrom(dir: string): Promise<string | null> {
  try {
    return (await readFile(`${dir}/objects/info/alternates`, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether `dir` can be served as this head's candidate: it holds the head, and the entry it
 * borrows the base from is `cacheDir` and still there. A candidate whose entry was removed has
 * lost its base, and one pointing elsewhere came from an entry that is no longer the one in use.
 */
async function usable(
  dir: string,
  branchName: string,
  headSha: string,
  cacheDir: string,
  git: Git,
): Promise<boolean> {
  if (!(await holds(dir, branchName, headSha, git))) return false;
  try {
    return (await borrowsFrom(dir)) === (await realpath(`${cacheDir}/objects`));
  } catch {
    return false;
  }
}

/**
 * Best-effort: removes candidate dirs (and leftover half-made ones) nobody touched in the TTL.
 * A request touches a candidate before it looks at it, and what goes is first renamed away, then
 * its age read again: the first read and the rename are two steps, and a request that touched it
 * in between gets it back under its name before anything is removed. A request that comes after
 * the rename no longer finds it and stages it again — and when that one already put a new copy
 * under the name, the renamed one is left for a later sweep, since a request may be serving from
 * it. Exported for its test, which steps between the look and the rename through `move`.
 */
export async function sweepCandidates(
  parent: string,
  nowMs: number,
  diag: AppDeps["diag"],
  move: typeof rename = rename,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const ageOf = async (path: string) => (await stat(path)).mtime.getTime();
  for (const entry of entries) {
    const path = `${parent}/${entry.name}`;
    try {
      const mtime = await ageOf(path);
      if (nowMs - mtime < CANDIDATE_TTL_MS) continue;
      const doomed = `${parent}/.swept-${crypto.randomUUID()}`;
      await move(path, doomed);
      if (await ageOf(doomed) !== mtime) {
        await move(doomed, path).catch(() => {});
        diag.debug("candidate.sweep_spared", { name: entry.name });
        continue;
      }
      await rm(doomed, { recursive: true });
      diag.debug("candidate.swept", { name: entry.name });
    } catch {
      // Gone already, or another request is sweeping it: either way not ours to report.
    }
  }
}

/** Options for `ensureCandidate`. */
export interface EnsureCandidateOptions {
  /** Bring a reused candidate's base and target branches up to the cache entry's. Asked by the
   * start of a conversation (the ref advertisement) only, so the refs a client has just been
   * shown do not move under the pack request that follows. */
  refresh?: boolean;
}

/**
 * The directory to serve a check grant's candidate from — staged on first use, reused after —
 * or the refusal to send. `grantRunId` is the suite's id, for the log.
 *
 * A missing bundle is a 404 with a sentence, because the one reader is a check pod's clone step,
 * which prints what it was told: "the bundle is gone" is an answer, "could not prepare" is not.
 */
export async function ensureCandidate(
  deps: AppDeps,
  grantRunId: string,
  repo: RunGrantRepo,
  opts: EnsureCandidateOptions = {},
): Promise<{ dir: string } | Response> {
  const { cache, diag, config } = deps;
  const candidate = repo.candidate;
  if (candidate === undefined) throw new Error("ensureCandidate needs a candidate grant");
  const { headSha } = candidate;
  const bundleKey = "bundleKey" in candidate ? candidate.bundleKey : null;
  const git = makeGit(diag);
  const about = { runId: grantRunId, repo: repo.connectedRepoId, headSha };

  if (bundleKey !== null && !bundleKey.endsWith(`/${repo.connectedRepoId}/${headSha}.bundle`)) {
    // The orchestrator derives this key; one that names another repo's or another commit's
    // bundle is a bug upstream of us, and serving it would serve the wrong code under a verdict.
    diag.warn("candidate.bundle_key_mismatch", { ...about, bundleKey });
    return json(403, { error: "the grant's bundle is not this repo's candidate" });
  }

  let baseBranch: string;
  let targetBranch: string | null = null;
  try {
    baseBranch = normalizeBaseRef(repo.ref).localBranch;
    if (repo.targetRef !== undefined && repo.targetRef !== repo.ref) {
      targetBranch = normalizeBaseRef(repo.targetRef).localBranch;
    }
  } catch (err) {
    diag.warn("candidate.bad_base", { ...about, err: String(err) });
    return json(400, { error: `the candidate's base cannot be served: ${err}` });
  }
  const branchRefspec = (branch: string) => `+refs/heads/${branch}:refs/heads/${branch}`;

  const parent = candidatesDir(config.stagingDir);
  await mkdir(parent, { recursive: true });
  const nowMs = Date.now();
  await sweepCandidates(parent, nowMs, diag);

  // Free: the credential is minted only when the cache fetches.
  const upstream = await upstreamFor(grantRunId, repo, deps, "candidate");
  if (upstream instanceof Response) return upstream;
  const { url, coords } = upstream;
  const dir = await candidatePath(config.stagingDir, repo, candidate.branchName, headSha);

  // The base, from the cache as it stands when it can serve it — the bundle's prerequisites are
  // there for any run that cloned through this gateway — and warmed otherwise.
  let cacheDir: string;
  try {
    const found = await cache.find(coords, repo.ref);
    if (found !== null) {
      // Touched before it is looked at, so a concurrent sweep leaves it be (see `sweep`).
      await utimes(dir, new Date(nowMs), new Date(nowMs)).catch(() => {});
      if (await usable(dir, candidate.branchName, headSha, found.dir, git)) {
        if (opts.refresh) {
          // Borrowing the entry's objects, this only moves refs: a base or target that moved
          // on since staging (a newer checks commit among them) is served as the entry has it.
          for (const branch of [baseBranch, ...(targetBranch === null ? [] : [targetBranch])]) {
            await git(dir, "fetch", "--quiet", "--", found.dir, branchRefspec(branch))
              .catch((err) => diag.debug("candidate.refresh_failed", { ...about, branch, err }));
          }
        }
        return { dir };
      }
      cacheDir = found.dir;
    } else {
      cacheDir = (await cache.serveBase(coords, repo.ref, upstream.credential)).dir;
    }
  } catch (err) {
    diag.warn("candidate.base_unavailable", { ...about, err: String(err) });
    return json(502, { error: "could not prepare the candidate's base repo" });
  }

  const building = `${parent}/.building-${crypto.randomUUID()}`;
  const staging = bundleKey === null
    ? await stageFromForge(deps, about, {
      url,
      coords,
      credential: upstream.credential,
      cacheDir,
      baseBranch,
      branchName: candidate.branchName,
      headSha,
      fetchRef: "fetchRef" in candidate ? candidate.fetchRef : null,
      parent,
      git,
    })
    : await stageFromBundle(deps, about, {
      url,
      coords,
      cacheDir,
      baseBranch,
      branchName: candidate.branchName,
      headSha,
      bundleKey,
      parent,
      git,
    });
  if (staging instanceof Response) return staging;
  try {
    try {
      // Staged beside the candidates, so this rename stays on one filesystem.
      await rename(staging.dir, building);
    } finally {
      await staging.dispose();
    }

    // What a merge base is computed against: the branch the change goes into, where that is not
    // the base itself. Best-effort — a clone that cannot see it still has the head it checks.
    if (targetBranch !== null && repo.targetRef !== undefined) {
      try {
        try {
          await git(building, "fetch", "--quiet", "--", cacheDir, branchRefspec(targetBranch));
        } catch {
          // The entry never held it: the checks read that pinned this suite normally warmed
          // it, but a cache is disposable. Warming it into the same entry keeps the objects
          // where this candidate borrows from.
          const warmed = await cache.serveBase(coords, repo.targetRef, upstream.credential);
          await git(building, "fetch", "--quiet", "--", warmed.dir, branchRefspec(targetBranch));
        }
      } catch (err) {
        diag.warn("candidate.target_unavailable", { ...about, err: String(err) });
      }
    }
    // A plain clone checks out the head, not whatever `init` named HEAD.
    await git(building, "symbolic-ref", "HEAD", `refs/heads/${candidate.branchName}`);
    await git(building, "config", "uploadpack.allowFilter", "true");

    try {
      await rename(building, dir);
    } catch {
      // Somebody else finished first. Theirs is as good as ours, provided it can be served.
      // One that cannot is a leftover no request can use — every dir arrives here whole, by
      // rename — so it is replaced rather than left to refuse this candidate until the sweep.
      if (!(await usable(dir, candidate.branchName, headSha, cacheDir, git))) {
        await rm(dir, { recursive: true }).catch(() => {});
        try {
          await rename(building, dir);
        } catch (err) {
          diag.warn("candidate.install_failed", { ...about, err: String(err) });
          return json(502, { error: "could not stage the candidate" });
        }
      }
    }
    diag.debug("candidate.staged", about);
    return { dir };
  } catch (err) {
    diag.warn("candidate.stage_failed", { ...about, terminal: false, err: String(err) });
    return json(502, { error: "could not stage the candidate" });
  } finally {
    await rm(building, { recursive: true }).catch(() => {});
  }
}

/** A scratch repo holding the base and the candidate's branch, for `ensureCandidate` to finish
 * and install. Disposing of it after the rename away is harmless. */
interface Staged {
  dir: string;
  dispose(): Promise<void>;
}

/** What both ways of staging a candidate are told. */
interface StageArgs {
  url: string;
  /** The cache entry `url` is kept under (`RepoCoords.key`). */
  coords: RepoCoords;
  cacheDir: string;
  baseBranch: string;
  branchName: string;
  headSha: string;
  parent: string;
  git: Git;
}

/**
 * A run's bundle, staged by `stageBundle` — the function a submission publishes through, so the
 * provenance anchor is checked the same way: the bundle must verify, and its head must be the
 * grant's.
 */
async function stageFromBundle(
  deps: AppDeps,
  about: Record<string, string>,
  args: StageArgs & { bundleKey: string },
): Promise<Staged | Response> {
  const { patches, diag, config } = deps;
  const { bundleKey } = args;
  let bundle;
  try {
    bundle = await patches.get(bundleKey);
  } catch (err) {
    diag.warn("candidate.bundle_unreadable", { ...about, bundleKey, err: String(err) });
    return json(502, { error: "could not read the candidate's bundle" });
  }
  if (bundle === null) {
    diag.warn("candidate.bundle_missing", { ...about, bundleKey });
    return json(404, { error: `the candidate's bundle is gone (${bundleKey})` });
  }
  const bundlePath = `${config.stagingDir}/${crypto.randomUUID()}.bundle`;
  try {
    await stageStream(bundle, bundlePath);
    return await stageBundle({
      upstreamUrl: args.url,
      cacheDir: args.cacheDir,
      baseBranch: args.baseBranch,
      branchName: args.branchName,
      expectedHeadSha: args.headSha,
      bundlePath,
      scratchParent: args.parent,
      shareCacheObjects: true,
      git: args.git,
      // Never reached: the cache seeds the base, so the upstream fallback is not taken.
      authedGit: args.git,
    });
  } catch (err) {
    // A bundle that no longer verifies, or whose head is not the grant's: the provenance
    // anchor failing, loudly. Anything else is our disk or our cache.
    const terminal = err instanceof TerminalSubmitError;
    diag.warn("candidate.stage_failed", { ...about, terminal, err: String(err) });
    return json(terminal ? 409 : 502, {
      error: terminal
        ? `the candidate does not verify: ${err instanceof Error ? err.message : String(err)}`
        : "could not stage the candidate",
    });
  } finally {
    await rm(bundlePath).catch(() => {});
  }
}

/**
 * A change request's head the forge already has — a push to a pull request or a patch, which
 * no run produced and no bundle holds.
 *
 * The commit is fetched by id into the SHARED cache entry, where it lands with no ref: nothing
 * new is advertised to the runs of the upstream, and the candidate borrows it from there like
 * the base. A forge that will not serve the head by id is asked for `fetchRef` instead (a pull
 * request's `refs/pull/<n>/head`), fetched the same way — objects only, no ref and no HEAD
 * moved in the entry. Either way the head is re-checked in the scratch repo itself: a head
 * the forge ANSWERED it does not have (a force-push since, a deleted fork) is a terminal 409,
 * since asking again fetches the same nothing; one missing because the forge could not be
 * asked is a 502, which the pod's clone retries.
 *
 * A fork's head lands in the entry as unreferenced objects. Protocol v2 serves any object an
 * entry holds to whoever names its id, so a run of the upstream could read it — acceptable,
 * because `refs/pull/*` makes every pull request head public on the forge already.
 */
async function stageFromForge(
  deps: AppDeps,
  about: Record<string, string>,
  args: StageArgs & { credential: Credential; fetchRef: string | null },
): Promise<Staged | Response> {
  const { cache, diag } = deps;
  const { coords, credential, headSha, fetchRef, git } = args;
  // Whether the forge ANSWERED that it has no such commit (nor under `fetchRef`). Only then is
  // a missing head terminal; an unreachable forge, a 5xx or a refused credential is a platform
  // fault the pod's clone retries.
  let answeredNo = false;
  try {
    await cache.ensureCommit(coords, headSha, credential, {
      fallbackRef: fetchRef ?? undefined,
    });
  } catch (err) {
    answeredNo = err instanceof UpstreamRefused && err.reason === "missing-commit";
    diag.warn("candidate.head_fetch_failed", { ...about, fetchRef, err: String(err) });
  }

  let scratch: string;
  try {
    scratch = await mkdtemp(join(args.parent, "ryph-candidate-"));
  } catch (err) {
    diag.warn("candidate.stage_failed", { ...about, terminal: false, err: String(err) });
    return json(502, { error: "could not stage the candidate" });
  }
  const dispose = () => rm(scratch, { recursive: true }).catch(() => {});
  try {
    // The bundle path's scratch repo, built the same way: the entry's objects borrowed through
    // alternates, the base branch written from it — and then the head named by a ref, where the
    // bundle path fetches one.
    await git(scratch, "init", "--bare", "--quiet");
    await mkdir(`${scratch}/objects/info`, { recursive: true });
    await writeFile(
      `${scratch}/objects/info/alternates`,
      `${await realpath(`${args.cacheDir}/objects`)}\n`,
    );
    const base = args.baseBranch;
    await git(
      scratch,
      "fetch",
      "--quiet",
      "--",
      args.cacheDir,
      `+refs/heads/${base}:refs/heads/${base}`,
    );
  } catch (err) {
    await dispose();
    diag.warn("candidate.stage_failed", { ...about, terminal: false, err: String(err) });
    return json(502, { error: "could not stage the candidate" });
  }
  try {
    await git(scratch, "cat-file", "-e", `${headSha}^{commit}`);
  } catch {
    await dispose();
    diag.warn("candidate.head_missing", { ...about, fetchRef, terminal: answeredNo });
    return answeredNo
      ? json(409, {
        error: `the change request's head ${headSha} is not on the forge (pushed over since?)`,
      })
      : json(502, {
        error: `the change request's head ${headSha} could not be fetched from the forge; ` +
          "retry once it is back",
      });
  }
  try {
    await git(scratch, "update-ref", `refs/heads/${args.branchName}`, headSha);
  } catch (err) {
    await dispose();
    diag.warn("candidate.stage_failed", { ...about, terminal: false, err: String(err) });
    return json(502, { error: "could not stage the candidate" });
  }
  return { dir: scratch, dispose };
}
