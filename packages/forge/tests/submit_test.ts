// The submit move against real git: cache-seeded and upstream-seeded, idempotent on
// re-push, and refusing a head that is not the recorded one.

import { test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { pushBundle, TerminalSubmitError } from "../src/helpers/submit.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import { git } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

/** Upstream + cache + a run's bundle, the way phase 1 leaves the world. */
async function makeWorld(root: string) {
  const upstream = `${root}/upstream`;
  const baseSha = await makeUpstream(upstream);
  const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
  const { dir: cacheDir } = await cache.refreshBase({ url: upstream }, "main", anonymous);

  const ws = `${root}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--", upstream, ".");
  await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1");
  await writeFile(`${ws}/work.txt`, "the work\n");
  await git(ws, "add", ".");
  await commit(ws, "do the work");
  const headSha = await git(ws, "rev-parse", "HEAD");
  const bundlePath = `${root}/patch.bundle`;
  await git(ws, "bundle", "create", bundlePath, `${baseSha}..refs/heads/ryph/ada/r-1`);
  return { upstream, cacheDir, headSha, bundlePath };
}

test("pushes the bundle's branch to the upstream — cache-seeded, exact head, idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { upstream, cacheDir, headSha, bundlePath } = await makeWorld(root);
    const args = {
      upstreamUrl: upstream,
      cacheDir,
      baseBranch: "main",
      branchName: "ryph/ada/r-1",
      expectedHeadSha: headSha,
      bundlePath,
      git,
      authedGit: git, // a path upstream needs no credential; the seam is exercised, inert
    };
    const pushed = await pushBundle(args);
    assertEquals(pushed.headSha, headSha);
    assertEquals(await git(upstream, "rev-parse", "refs/heads/ryph/ada/r-1"), headSha);

    // Re-submitting the same bundle is the measured no-op: same head, no error.
    const again = await pushBundle(args);
    assertEquals(again.headSha, headSha);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("with no cache, the base is fetched from the upstream itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { upstream, headSha, bundlePath } = await makeWorld(root);
    const pushed = await pushBundle({
      upstreamUrl: upstream,
      cacheDir: null,
      baseBranch: "main",
      branchName: "ryph/ada/r-1",
      expectedHeadSha: headSha,
      bundlePath,
      git,
      authedGit: git,
    });
    assertEquals(pushed.headSha, headSha);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a head that is not the recorded one is refused, terminally, before any push", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { upstream, cacheDir, bundlePath } = await makeWorld(root);
    const err = await assertRejects(
      () =>
        pushBundle({
          upstreamUrl: upstream,
          cacheDir,
          baseBranch: "main",
          branchName: "ryph/ada/r-1",
          expectedHeadSha: "0".repeat(40),
          bundlePath,
          git,
          authedGit: git,
        }),
      TerminalSubmitError,
    );
    assertStringIncludes(err.message, "not the recorded");
    // Nothing left the box.
    let pushed = true;
    try {
      await git(upstream, "rev-parse", "--verify", "refs/heads/ryph/ada/r-1");
    } catch {
      pushed = false;
    }
    assert(!pushed, "the branch must not reach the upstream");
  } finally {
    await rm(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Onto an existing branch — a run working on a pull request pushes into that pull request.
// ---------------------------------------------------------------------------

const hasRef = async (repo: string, ref: string) => {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

/** A pull request's branch on the upstream (pushed by its author), a cache primed at its tip,
 * and a run that built on that tip. */
async function makePullWorld(root: string) {
  const upstream = `${root}/upstream`;
  await makeUpstream(upstream);
  const author = `${root}/author`;
  await mkdir(author);
  await git(author, "clone", "--quiet", "--", upstream, ".");
  await git(author, "checkout", "--quiet", "-b", "feat/x");
  await writeFile(`${author}/feature.txt`, "the feature\n");
  await git(author, "add", ".");
  await commit(author, "start the feature");
  await git(author, "push", "--quiet", "origin", "feat/x");
  const tipSha = await git(author, "rev-parse", "HEAD");

  const cache = localFsRepoCache({ root: `${root}/cache`, diag: silentDiagnostics() });
  const { dir: cacheDir } = await cache.refreshBase({ url: upstream }, "feat/x", anonymous);

  const ws = `${root}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--branch", "feat/x", "--", upstream, ".");
  await git(ws, "checkout", "--quiet", "-b", "ryph/ada/r-1");
  await writeFile(`${ws}/review.txt`, "addressed\n");
  await git(ws, "add", ".");
  await commit(ws, "address the review");
  const headSha = await git(ws, "rev-parse", "HEAD");
  const bundlePath = `${root}/patch.bundle`;
  await git(ws, "bundle", "create", bundlePath, `${tipSha}..refs/heads/ryph/ada/r-1`);

  /** Somebody else pushes to the pull request while the run works. */
  const moveBranch = async () => {
    await writeFile(`${author}/feature.txt`, "the feature, revised\n");
    await git(author, "add", ".");
    await commit(author, "revise the feature");
    await git(author, "push", "--quiet", "origin", "feat/x");
    return await git(author, "rev-parse", "HEAD");
  };

  const args = {
    upstreamUrl: upstream,
    cacheDir,
    baseBranch: "feat/x",
    branchName: "ryph/ada/r-1",
    expectedHeadSha: headSha,
    bundlePath,
    onto: { branch: "feat/x", expectedSha: tipSha },
    git,
    authedGit: git,
  };
  return { upstream, tipSha, headSha, moveBranch, args };
}

test("onto a pull request's branch: the run's commits fast-forward it, and nothing else appears", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { upstream, headSha, args } = await makePullWorld(root);
    const pushed = await pushBundle(args);
    assertEquals(pushed.headSha, headSha);
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
    // The run's own branch is the vehicle, not the destination.
    assert(!await hasRef(upstream, "refs/heads/ryph/ada/r-1"));

    // A retry reads the branch as it now stands — at the run's head — and converges.
    await pushBundle({ ...args, onto: { branch: "feat/x", expectedSha: headSha } });
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), headSha);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("onto a branch that moved while the run worked: refused terminally, what landed stays", async () => {
  // Both ways a moved tip can present: absent from the scratch repo (seeded from a cache that
  // never saw it) and present but not an ancestor (seeded from the upstream, which has it).
  for (const seed of ["cache", "upstream"] as const) {
    const root = await mkdtemp(join(tmpdir(), "ryph-"));
    try {
      const { upstream, moveBranch, args } = await makePullWorld(root);
      const movedSha = await moveBranch();
      const err = await assertRejects(
        () =>
          pushBundle({
            ...args,
            cacheDir: seed === "cache" ? args.cacheDir : null,
            onto: { branch: "feat/x", expectedSha: movedSha },
          }),
        TerminalSubmitError,
      );
      assertStringIncludes(err.message, "moved while the run worked");
      assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), movedSha, seed);
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test("onto a branch that changed after the look: the lease refuses, and retrying is allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { upstream, moveBranch, args } = await makePullWorld(root);
    // The caller looked while the tip was `tipSha` (args.onto); somebody pushed right after.
    const movedSha = await moveBranch();
    const moved = await assertRejects(() => pushBundle(args));
    assert(!(moved instanceof TerminalSubmitError), "the next attempt looks again");
    assertEquals(await git(upstream, "rev-parse", "refs/heads/feat/x"), movedSha);

    // A branch deleted after the look is not quietly re-created by the push.
    await git(upstream, "branch", "--quiet", "-D", "feat/x");
    const deleted = await assertRejects(() => pushBundle(args));
    assert(!(deleted instanceof TerminalSubmitError));
    assert(!await hasRef(upstream, "refs/heads/feat/x"));
  } finally {
    await rm(root, { recursive: true });
  }
});
