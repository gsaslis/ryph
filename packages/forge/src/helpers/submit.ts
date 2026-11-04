// The submit move, exactly as the spikes proved it: seed a scratch repo with the base, fetch
// the bundle into it, push the one output branch to the upstream. Measured properties this
// code leans on: SHA continuity survives the round-trip (the pushed head IS the bundle's
// head, byte for byte); a base that moved upstream mid-run still pushes cleanly and the PR
// shows exactly the agent's commits; re-pushing an identical bundle answers "Everything
// up-to-date" with exit 0 — the GIT half of a retried submission is safe by construction
// (PR creation is not, and gets its own idempotency in the API adapter).
//
// Two destinations. By default the run's own run-namespaced branch is published, for a pull
// request to be opened from. With `onto`, the run's commits land on an EXISTING branch — a
// run working on a pull request pushes into that pull request — and that is the one case
// where the destination holds somebody else's work.
//
// Invariants:
// - the push credential rides the subprocess env (`http.<origin>.extraheader`), never a URL
// - the pushed head is verified against the caller's expected SHA BEFORE the push: the
//   provenance anchor is checked where the bytes leave, not assumed
// - never a force push: the output branch is run-namespaced, so a non-fast-forward means
//   something is genuinely wrong and the failure should be seen, not overwritten
// - onto an existing branch, fast-forward only, and only from the tip the caller last saw:
//   the tip must be in the bundle's history (checked locally), and the push carries a lease
//   on it, so a branch that moved or vanished between the look and the push refuses the
//   push rather than losing whatever landed there

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Git } from "./git_exec.ts";

export interface PushBundleArgs {
  /** The upstream to push to (and to fetch the base from when no cache can seed it). */
  upstreamUrl: string;
  /** A local per-repo cache dir to seed base objects from — fast path, no network. */
  cacheDir: string | null;
  /** The base branch whose history satisfies the bundle's prerequisites. Null only when the
   * cache entry's objects are borrowed (`shareCacheObjects`) and already hold them: the
   * prerequisites are then readable through the alternates, and no branch is fetched. */
  baseBranch: string | null;
  /** The ref `baseBranch` is fetched as from the upstream when no cache seeds it. Default
   * `refs/heads/<baseBranch>`; a fork's pull request is held in the base repo as
   * `refs/pull/<n>/head`, which the cache serves as the branch `pull/<n>/head`. */
  baseRemoteRef?: string;
  /** The one output branch the bundle carries. */
  branchName: string;
  /** The head the gateway recorded at intake — what the push must publish, exactly. */
  expectedHeadSha: string;
  bundlePath: string;
  /** Push onto this existing branch instead of publishing `branchName`. `expectedSha` is the
   * branch's tip as the caller just read it from the forge. */
  onto?: { branch: string; expectedSha: string };
  /** Where the push goes, when that is not `upstreamUrl`: a fork's own repository, for `onto`
   * a pull request whose branch lives there. The base is still read from `upstreamUrl`. */
  pushUrl?: string;
  /** Where the scratch repo is made (default: the system temp dir). A caller that keeps the
   * staged repo passes a dir on the filesystem it keeps it on, so a rename can move it there. */
  scratchParent?: string;
  /** Borrow the cache entry's objects (git alternates) instead of copying the base into the
   * scratch repo. For a staged repo that is kept and served: it then holds only the bundle's
   * objects, and reads the base out of the entry for as long as the entry lives. */
  shareCacheObjects?: boolean;
  /** A traced hermetic executor for local operations. */
  git: Git;
  /** The same, with the upstream push/fetch credential injected (extraheader env). */
  authedGit: Git;
}

/** Errors whose cause retrying cannot fix (a tampered bundle, a wrong head). */
export class TerminalSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSubmitError";
  }
}

/** The stored bundle's prerequisites are not in the base it was seeded with: the base no longer
 * holds the commits the run built on — for a fork's pull request, a force-push while it worked. */
export class BundleUnverifiableError extends TerminalSubmitError {
  constructor(message: string) {
    super(message);
    this.name = "BundleUnverifiableError";
  }
}

/** Makes `cacheDir`'s objects readable from `scratch` (git alternates), copying none. */
async function borrowObjects(scratch: string, cacheDir: string): Promise<void> {
  await mkdir(`${scratch}/objects/info`, { recursive: true });
  await writeFile(
    `${scratch}/objects/info/alternates`,
    `${await realpath(`${cacheDir}/objects`)}\n`,
  );
}

/** A verified bundle, staged in a scratch repo the caller must `dispose` of. */
export interface StagedBundle {
  /** The bare scratch repo holding the base and the bundle's branch. */
  dir: string;
  /** The bundle's head — already checked against the caller's expected SHA. */
  headSha: string;
  dispose(): Promise<void>;
}

/**
 * Everything a delivery does BEFORE it publishes: a scratch repo, the base seeded into it, the
 * bundle verified against real objects, its branch fetched, and its head checked against what
 * intake recorded.
 *
 * Split out of `pushBundle` because the two transports diverge only after this point — one
 * pushes, one uploads the bundle to a node's bridge — and the verification is the part that
 * must not diverge. The provenance anchor is checked where the bytes leave, in one place.
 */
export async function stageBundle(args: PushBundleArgs): Promise<StagedBundle> {
  const scratch = await mkdtemp(join(args.scratchParent ?? tmpdir(), "ryph-submit-"));
  const dispose = () => rm(scratch, { recursive: true }).catch(() => {});
  try {
    await args.git(scratch, "init", "--bare", "--quiet");

    // Seed the base: the bundle's prerequisites must exist locally before it can be fetched.
    // The cache is the fast path (local disk, hardlink-cheap); the upstream is the fallback
    // that makes submission self-sufficient — a wiped cache must not strand approved work.
    if (args.baseBranch === null) {
      if (args.cacheDir === null || !args.shareCacheObjects) {
        throw new Error("a bundle staged without its base branch must borrow the cache's objects");
      }
      await borrowObjects(scratch, args.cacheDir);
    } else if (args.cacheDir !== null) {
      const baseRefspec = `+refs/heads/${args.baseBranch}:refs/heads/${args.baseBranch}`;
      if (args.shareCacheObjects) {
        // With the entry's objects already reachable, the fetch below writes the ref and copies
        // nothing: git skips the transfer when every object the ref needs is present.
        await borrowObjects(scratch, args.cacheDir);
      }
      await args.git(scratch, "fetch", "--quiet", "--", args.cacheDir, baseRefspec);
    } else {
      const remote = args.baseRemoteRef ?? `refs/heads/${args.baseBranch}`;
      const baseRefspec = `+${remote}:refs/heads/${args.baseBranch}`;
      await args.authedGit(scratch, "fetch", "--quiet", "--", args.upstreamUrl, baseRefspec);
    }

    // The bundle's self-description, verified against real objects this time.
    try {
      await args.git(scratch, "bundle", "verify", "--quiet", args.bundlePath);
    } catch (err) {
      throw new BundleUnverifiableError(`the stored bundle no longer verifies: ${err}`);
    }
    await args.git(
      scratch,
      "fetch",
      "--quiet",
      "--",
      args.bundlePath,
      `+refs/heads/${args.branchName}:refs/heads/${args.branchName}`,
    );

    // The provenance check: what we are about to publish is exactly what intake recorded.
    const headSha = await args.git(scratch, "rev-parse", `refs/heads/${args.branchName}`);
    if (headSha !== args.expectedHeadSha) {
      throw new TerminalSubmitError(
        `the bundle's head ${headSha} is not the recorded ${args.expectedHeadSha}`,
      );
    }
    return { dir: scratch, headSha, dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}

export async function pushBundle(args: PushBundleArgs): Promise<{ headSha: string }> {
  const staged = await stageBundle(args);
  const scratch = staged.dir;
  const headSha = staged.headSha;
  try {
    if (args.onto !== undefined) {
      const { branch, expectedSha } = args.onto;
      // Fast-forward, proven before anything leaves: the branch's current tip must be part of
      // what the run built on. If somebody pushed while the run worked, it is not — and no
      // retry changes that, because the run's commits are fixed. A tip this scratch repo has
      // never seen fails the same way, for the same reason.
      try {
        await args.git(scratch, "merge-base", "--is-ancestor", expectedSha, headSha);
      } catch {
        throw new TerminalSubmitError(
          `${branch} is at ${expectedSha}, which the run's commits do not build on — ` +
            "it moved while the run worked",
        );
      }
      // The lease covers the gap between that check and this push: a branch that moves or is
      // deleted in between refuses the push instead of being overwritten or re-created. Not a
      // terminal failure — the next attempt looks again, and names the real reason.
      await args.authedGit(
        scratch,
        "push",
        "--quiet",
        `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
        "--",
        args.pushUrl ?? args.upstreamUrl,
        `refs/heads/${args.branchName}:refs/heads/${branch}`,
      );
      return { headSha };
    }

    // The one moment work reaches the forge. No force: see the invariants.
    await args.authedGit(
      scratch,
      "push",
      "--quiet",
      "--",
      args.upstreamUrl,
      `refs/heads/${args.branchName}:refs/heads/${args.branchName}`,
    );
    return { headSha };
  } finally {
    await staged.dispose();
  }
}
