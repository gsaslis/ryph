// Adopting a baked checkout: an environment image already holds
// each repo at `/ryph/work/<path>`, cloned at the commit the image was built from and with its
// setup run, so its build outputs and installed dependencies are warm. A run moves that checkout
// to its own commit instead of cloning a cold one.
//
// The git transports run `adoptInPlace` with their own executor — the fetch is the one step that
// crosses to the origin, and it has to carry the transport's credential — so the sequence lives
// here once and each transport only supplies how it reaches the origin.
//
// Invariants:
// - the working tree is moved with `git checkout`, never re-cloned or cleaned: git rewrites only
//   the files that differ between the two commits, so every other file keeps its mtime, and that
//   is what keeps an incremental build (cargo, tsc) incremental. No `git clean -x`, no `reset
//   --hard` — the gitignored build outputs ARE the point of the image
// - a checkout that is not clean is not adopted: the bake left it clean, so dirt means something
//   else touched it, and a run's work must never start on top of changes it did not make
// - what the image's `.git` knew is not what the run may know: every ref but the run's own is
//   deleted, the remote is replaced by the run's URL, and the reflogs are expired — the agent
//   sees one branch, as it would after a clone
// - any failure throws; the caller falls back to a fresh clone in the same directory, so a run
//   is never worse off for having had an environment

import { lstat, readdir, rm } from "node:fs/promises";
import type { Git } from "./git_exec.ts";

/** Whether `dir` is a directory holding a `.git` — a checkout the image baked. */
export async function isCheckout(dir: string): Promise<boolean> {
  try {
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory()) return false;
    await lstat(`${dir}/.git`);
    return true;
  } catch (err) {
    if (((err as NodeJS.ErrnoException)?.code === "ENOENT")) return false;
    throw err;
  }
}

/**
 * Moves the checkout at `dir` to `ref` as it stands at `url`, in place, and answers the commit
 * it landed on. `git` is the transport's executor, credential and all.
 *
 * The run's ref is checked out the way a clone would leave it: a branch becomes a local branch
 * of that name tracking `origin/<ref>`, anything else (a tag, a commit) a detached HEAD.
 */
export async function adoptInPlace(
  git: Git,
  dir: string,
  url: string,
  ref: string,
  targetRef?: string,
): Promise<string> {
  const dirt = await git(dir, "status", "--porcelain");
  if (dirt !== "") {
    const paths = dirt.split("\n").map((line) => line.slice(3));
    throw new Error(
      `the baked checkout is not clean (${paths.slice(0, 5).join(", ")}${
        paths.length > 5 ? ", …" : ""
      })`,
    );
  }

  // The remote is replaced, not re-pointed: removing it takes every remote-tracking ref the
  // build's clone left with it, and the one added back is the run's, with the default refspec,
  // so the fetch below records `origin/<ref>` as a clone would have.
  for (const remote of (await git(dir, "remote")).split("\n").filter((r) => r !== "")) {
    await git(dir, "remote", "remove", remote);
  }
  // `--` because the URL is caller input; git reads both names after it as positionals.
  await git(dir, "remote", "add", "--", "origin", url);
  // Through `origin`, unlike the transports' mid-run fetches (helpers/fetch.ts): it is the remote
  // just added, before the agent has run, and the ref may be a tag or a commit, which only a
  // fetch by name resolves. The ref is schema-checked against a leading dash and rides after the
  // remote name, where git reads it as a refspec.
  await git(dir, "fetch", "--quiet", "--no-tags", "origin", ref);
  const sha = await git(dir, "rev-parse", "--verify", "FETCH_HEAD^{commit}");

  // The target as a clone would have it too, `origin/<target>` — best-effort, as the gateway
  // serves it: a run that cannot see its target can still work, and `update_from_base` asks
  // again. After the base's fetch has been read, since this one moves FETCH_HEAD.
  const targetTracking = targetRef === undefined || targetRef === ref
    ? null
    : `refs/remotes/origin/${targetRef}`;
  if (targetTracking !== null) {
    await git(dir, "fetch", "--quiet", "--no-tags", "origin", "--", targetRef!).catch(() => {});
  }

  const tracking = `refs/remotes/origin/${ref}`;
  const isBranch = await refExists(git, dir, tracking);
  if (isBranch) {
    // -B resets the branch if the image already has one of that name (it usually does: the
    // build checked out the default branch) and moves the tree with it, in place.
    await git(dir, "checkout", "--quiet", "-B", ref, "--track", `origin/${ref}`);
  } else {
    await git(dir, "checkout", "--quiet", "--detach", sha);
  }

  // Everything else goes: branches, tags, notes, stashes, the build's own leftovers.
  const keep = new Set(isBranch ? [`refs/heads/${ref}`, tracking] : []);
  if (targetTracking !== null) keep.add(targetTracking);
  const refs = (await git(dir, "for-each-ref", "--format=%(refname)"))
    .split("\n")
    .filter((name) => name !== "" && !keep.has(name));
  for (const name of refs) await git(dir, "update-ref", "-d", name);
  await git(dir, "reflog", "expire", "--expire=now", "--all");
  return sha;
}

/** Whether `ref` names something in the clone. */
export async function refExists(git: Git, dir: string, ref: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes everything directly under `root` that is not one of `keep` — a checkout the image
 * baked for a repo this run does not hold (a member removed since the build), and the builder's
 * own bookkeeping. The run's root is what the agent works in, and it holds this run's repos only.
 * Answers what it removed.
 */
export async function clearStrays(root: string, keep: readonly string[]): Promise<string[]> {
  const wanted = new Set(keep);
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (wanted.has(entry.name)) continue;
    await rm(`${root}/${entry.name}`, { recursive: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

/** Empties `dir` (removes it; the clone recreates it), so a fresh clone can land where an
 * adoption failed. Absent is already empty. */
export async function resetDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true });
  } catch (err) {
    if (!((err as NodeJS.ErrnoException)?.code === "ENOENT")) throw err;
  }
}
