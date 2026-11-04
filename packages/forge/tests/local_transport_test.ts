// The `local` ChangeTransport against real repositories on disk: a branch lands where nobody
// has it checked out, a branch ryph did not make is left alone, a revision fast-forwards only
// the branch ryph delivered, and NOTHING the target repository configures — its hooks, its
// alternate-refs command — runs on the way in. Each hook test pairs with a control push that
// shows the same hook DOES run for a plain git push, so a passing test means "disabled", not
// "never installed right".

import { test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  isPermanentPushFailure,
  localChangeTransport,
} from "../src/adapters/change_transport/local.ts";
import { localFsRepoCache } from "../src/adapters/repo_cache/local_fs.ts";
import type { ChangeDelivery, ChangeDeliveryOutcome } from "../src/ports/change_transport.ts";
import { anonymous } from "../src/ports/repo_cache.ts";
import { git } from "../src/helpers/git_exec.ts";
import { commit, makeUpstream, silentDiagnostics } from "./util.ts";

const BRANCH = "ryph/ada/r-1/work";

/** A root with a repository in it (`main` checked out), a primed cache, and a workspace clone
 * the "run" commits in. */
async function world() {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "ryph-")));
  const root = `${tmp}/root`;
  const repo = `${root}/repo`;
  const baseSha = await makeUpstream(repo);
  const diag = silentDiagnostics();
  const cache = localFsRepoCache({ root: `${tmp}/cache`, diag });
  await cache.refreshBase({ url: repo }, "main", anonymous);
  const ws = `${tmp}/ws`;
  await mkdir(ws);
  await git(ws, "clone", "--quiet", "--", repo, ".");
  await git(ws, "checkout", "--quiet", "-b", BRANCH);
  const transport = localChangeTransport({ root, cache, diag });
  let n = 0;

  /** One more commit on the run's branch in the workspace (on top of `from` when given), bundled
   * from `base`; answers the delivery for it. */
  const work = async (
    opts: { from?: string; base?: string; existingRef?: string | null; branch?: string } = {},
  ): Promise<ChangeDelivery> => {
    const branch = opts.branch ?? BRANCH;
    if (opts.from !== undefined) {
      await git(ws, "checkout", "--quiet", "-B", branch, opts.from);
    } else if (branch !== BRANCH) {
      await git(ws, "checkout", "--quiet", "-B", branch);
    }
    n += 1;
    await writeFile(`${ws}/work-${n}.txt`, `work ${n}\n`);
    await git(ws, "add", ".");
    await commit(ws, `work ${n}`);
    const headSha = await git(ws, "rev-parse", "HEAD");
    const bundlePath = `${tmp}/work-${n}.bundle`;
    await git(ws, "bundle", "create", bundlePath, `${opts.base ?? baseSha}..refs/heads/${branch}`);
    return {
      repo: { repoRef: repo, tenantId: null },
      repoUrl: repo,
      bundlePath,
      branchName: branch,
      baseBranch: "main",
      headSha,
      title: "the work",
      description: "",
      embeds: [],
      draft: false,
      existingRef: opts.existingRef ?? null,
    };
  };

  return {
    tmp,
    root,
    repo,
    baseSha,
    ws,
    work,
    deliver: (change: ChangeDelivery) => transport.deliver(change),
    cleanup: () => rm(tmp, { recursive: true }),
  };
}

function assertRefused(outcome: ChangeDeliveryOutcome, includes: string) {
  assertEquals(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert(outcome.terminal, `a refusal is terminal: ${outcome.message}`);
  assertStringIncludes(outcome.message, includes);
}

/** A failure the control plane will store and hand on to the run: no host path in it, and none
 * of git's own words. */
function assertPathFree(outcome: ChangeDeliveryOutcome, tmp: string) {
  assert(outcome.kind === "failed");
  assertFalse(outcome.message.includes(tmp), `names a host path: ${outcome.message}`);
  assertFalse(/fatal:|error:|remote:|git push|receive-pack/.test(outcome.message), outcome.message);
}

const tipOf = (repo: string, branch: string) =>
  git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => null);

test("a new branch lands in the repository, url null, and a retry converges", async () => {
  const w = await world();
  try {
    const change = await w.work();
    const outcome = await w.deliver(change);
    assertEquals(outcome, { kind: "delivered", ref: BRANCH, url: null });
    assertEquals(await tipOf(w.repo, BRANCH), change.headSha);
    // The owner's checkout is untouched.
    assertEquals(await git(w.repo, "symbolic-ref", "--short", "HEAD"), "main");
    assertEquals(await git(w.repo, "status", "--porcelain"), "");

    // The answer was lost and the delivery comes again: same branch, nothing written.
    assertEquals(await w.deliver(change), { kind: "delivered", ref: BRANCH, url: null });
    // ...even once the owner has checked the delivered branch out to look at it.
    await git(w.repo, "checkout", "--quiet", BRANCH);
    assertEquals(await w.deliver(change), { kind: "delivered", ref: BRANCH, url: null });
  } finally {
    await w.cleanup();
  }
});

test("the checked-out branch is never moved, in the main worktree or a linked one", async () => {
  const w = await world();
  try {
    const first = await w.work();
    assertEquals((await w.deliver(first)).kind, "delivered");
    const second = await w.work({ existingRef: BRANCH });

    await git(w.repo, "checkout", "--quiet", BRANCH);
    assertRefused(await w.deliver(second), "checked out");
    assertEquals(await tipOf(w.repo, BRANCH), first.headSha);

    await git(w.repo, "checkout", "--quiet", "main");
    await git(w.repo, "worktree", "add", "--quiet", `${w.tmp}/wt`, BRANCH);
    assertRefused(await w.deliver(second), "checked out");
    assertEquals(await tipOf(w.repo, BRANCH), first.headSha);

    // Off every worktree, the same revision goes through.
    await git(w.repo, "worktree", "remove", `${w.tmp}/wt`);
    assertEquals(await w.deliver(second), { kind: "delivered", ref: BRANCH, url: null });
    assertEquals(await tipOf(w.repo, BRANCH), second.headSha);
  } finally {
    await w.cleanup();
  }
});

test("a branch ryph did not deliver is not ryph's to move", async () => {
  const w = await world();
  try {
    // The owner already has a branch by that name, at their own commit.
    await git(w.repo, "branch", BRANCH, "main");
    const change = await w.work();
    assertRefused(await w.deliver(change), "did not deliver");
    assertEquals(await tipOf(w.repo, BRANCH), w.baseSha);

    // Naming a different branch as the one delivered before does not unlock it either: that
    // one is gone, so this is a first delivery onto the run's branch — which the owner has.
    assertRefused(
      await w.deliver({ ...change, existingRef: "ryph/ada/r-9/other" }),
      "did not deliver",
    );
    assertEquals(await tipOf(w.repo, BRANCH), w.baseSha);
  } finally {
    await w.cleanup();
  }
});

test("a revision fast-forwards the delivered branch, and never anything that is not one", async () => {
  const w = await world();
  try {
    const first = await w.work();
    assertEquals((await w.deliver(first)).kind, "delivered");

    // Built on the first delivery: a fast-forward, allowed with the branch named as delivered.
    const second = await w.work({ existingRef: BRANCH });
    assertEquals(await w.deliver(second), { kind: "delivered", ref: BRANCH, url: null });
    assertEquals(await tipOf(w.repo, BRANCH), second.headSha);

    // Built on main instead: not a fast-forward of what is there, and refused, not forced.
    const diverged = await w.work({ from: w.baseSha, existingRef: BRANCH });
    assertRefused(await w.deliver(diverged), "do not build on");
    assertEquals(await tipOf(w.repo, BRANCH), second.headSha);

    // A later run revising the same patch from its own branch lands on the delivered one.
    const other = await w.work({
      from: second.headSha,
      branch: "ryph/bob/r-2/work",
      existingRef: BRANCH,
    });
    assertEquals(await w.deliver(other), { kind: "delivered", ref: BRANCH, url: null });
    assertEquals(await tipOf(w.repo, BRANCH), other.headSha);
    assertEquals(await tipOf(w.repo, "ryph/bob/r-2/work"), null);
  } finally {
    await w.cleanup();
  }
});

test("a branch name git refuses is refused before anything is written", async () => {
  const w = await world();
  try {
    const change = await w.work();
    assertRefused(
      await w.deliver({ ...change, existingRef: "ryph/ada/r..1/work" }),
      "not a branch name",
    );
    assertRefused(
      await w.deliver({ ...change, existingRef: "ryph/ada/r-1.lock/work" }),
      "not a branch name",
    );
    // Outside ryph's namespace, refused before git is asked at all.
    assertRefused(
      await w.deliver({ ...change, existingRef: "@{-1}" }),
      "not a branch ryph delivers",
    );
  } finally {
    await w.cleanup();
  }
});

test("a repository swapped for a symlink since it was connected is refused", async () => {
  const w = await world();
  try {
    const change = await w.work();
    await makeUpstream(`${w.tmp}/elsewhere`);
    await rename(w.repo, `${w.tmp}/moved`);
    await symlink(`${w.tmp}/elsewhere`, w.repo);
    const outcome = await w.deliver(change);
    assertRefused(outcome, "no longer inside the allowed root");
    assertPathFree(outcome, w.tmp);
    assertEquals(await tipOf(`${w.tmp}/elsewhere`, BRANCH), null);
  } finally {
    await w.cleanup();
  }
});

/** A hook script that records it ran by creating `marker`. */
async function installHook(dir: string, name: string, marker: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${name}`, `#!/bin/sh\ntouch '${marker}'\ncat >/dev/null\n`);
  await chmod(`${dir}/${name}`, 0o755);
}

const HOOKS = ["pre-receive", "update", "post-receive", "post-update", "reference-transaction"];

const exists = (path: string) => stat(path).then(() => true, () => false);

test("the target's hooks do not run — in .git/hooks or wherever core.hooksPath points", async () => {
  const w = await world();
  try {
    const marks = `${w.tmp}/marks`;
    await mkdir(marks);
    for (const hook of HOOKS) {
      await installHook(`${w.repo}/.git/hooks`, hook, `${marks}/default-${hook}`);
      await installHook(`${w.tmp}/husky`, hook, `${marks}/hookspath-${hook}`);
    }

    // Delivered through .git/hooks, then with the repository pointing its hooks elsewhere (the
    // way husky does).
    assertEquals((await w.deliver(await w.work({ branch: "ryph/ada/r-1/a" }))).kind, "delivered");
    await git(w.repo, "config", "core.hooksPath", `${w.tmp}/husky`);
    assertEquals((await w.deliver(await w.work({ branch: "ryph/ada/r-1/b" }))).kind, "delivered");
    for (const hook of HOOKS) {
      assertFalse(await exists(`${marks}/default-${hook}`), `${hook} in .git/hooks ran`);
      assertFalse(await exists(`${marks}/hookspath-${hook}`), `${hook} in core.hooksPath ran`);
    }

    // The control: a plain push into the same repository runs them. Without this, a hook that
    // could never have run would pass the assertions above.
    await git(w.ws, "push", "--quiet", "--", w.repo, "HEAD:refs/heads/control");
    for (const hook of HOOKS) {
      assert(await exists(`${marks}/hookspath-${hook}`), `${hook} is installed and runnable`);
    }
  } finally {
    await w.cleanup();
  }
});

test("a repository borrowing objects through alternates is refused, and its alternateRefsCommand never runs", async () => {
  const w = await world();
  try {
    // receive-pack runs core.alternateRefsCommand, a SHELL COMMAND, to advertise an alternate's
    // refs; and the alternates file itself lends another repository's objects to every fetch.
    // The re-check refuses the repository before any push (RECEIVE_PACK's pin stays as the
    // second fence).
    const lender = `${w.tmp}/lender`;
    await makeUpstream(lender, "lender");
    await writeFile(
      `${w.repo}/.git/objects/info/alternates`,
      `${lender}/.git/objects\n`,
    );
    const marker = `${w.tmp}/alternate-refs-ran`;
    await git(w.repo, "config", "core.alternateRefsCommand", `touch '${marker}'; true`);

    const change = await w.work();
    const outcome = await w.deliver(change);
    assertRefused(outcome, "no longer a plain git repository");
    assertPathFree(outcome, w.tmp);
    assertFalse(await exists(marker), "the repository's alternateRefsCommand ran");
    assertEquals(await tipOf(w.repo, BRANCH), null);

    // The control: a plain push into the same repository runs it, so the fixture is live.
    await git(w.ws, "push", "--quiet", "--", w.repo, "HEAD:refs/heads/control");
    assert(await exists(marker), "the control push runs it, so the fixture is live");
  } finally {
    await w.cleanup();
  }
});

test("a repository set to updateInstead still never has its working tree touched", async () => {
  const w = await world();
  try {
    await git(w.repo, "config", "receive.denyCurrentBranch", "updateInstead");
    const first = await w.work();
    assertEquals((await w.deliver(first)).kind, "delivered");
    await git(w.repo, "checkout", "--quiet", BRANCH);
    const before = await git(w.repo, "rev-parse", "HEAD");
    assertRefused(await w.deliver(await w.work({ existingRef: BRANCH })), "checked out");
    assertEquals(await git(w.repo, "rev-parse", "HEAD"), before);
    assertEquals(await git(w.repo, "status", "--porcelain"), "");
  } finally {
    await w.cleanup();
  }
});

test("a branch outside ryph's namespace is never adopted as delivered, nor moved", async () => {
  const w = await world();
  try {
    // The owner works on another branch, so `main` is not checked out anywhere.
    await git(w.repo, "checkout", "--quiet", "-b", "dev");
    // A run whose branch is named `main`, with no commits: its head IS the owner's main. Without
    // the namespace rule that read as "already delivered", and the next revision — with
    // `existingRef: "main"` — fast-forwarded the owner's main.
    await git(w.ws, "checkout", "--quiet", "-B", "main", "origin/main");
    await git(w.ws, "bundle", "create", `${w.tmp}/main.bundle`, "refs/heads/main");
    const same = {
      repo: { repoRef: w.repo, tenantId: null },
      repoUrl: w.repo,
      bundlePath: `${w.tmp}/main.bundle`,
      branchName: "main",
      baseBranch: "main",
      headSha: w.baseSha,
      title: "t",
      description: "",
      embeds: [],
      draft: false,
      existingRef: null,
    };
    assertRefused(await w.deliver(same), "not a branch ryph delivers");

    await writeFile(`${w.ws}/evil.txt`, "x\n");
    await git(w.ws, "add", ".");
    await commit(w.ws, "evil");
    const head = await git(w.ws, "rev-parse", "HEAD");
    await git(w.ws, "bundle", "create", `${w.tmp}/evil.bundle`, `${w.baseSha}..refs/heads/main`);
    const revision = { ...same, bundlePath: `${w.tmp}/evil.bundle`, headSha: head };
    assertRefused(await w.deliver({ ...revision, existingRef: "main" }), "not a branch ryph");
    // A run branch revising onto the owner's branch is refused just the same.
    await git(w.ws, "checkout", "--quiet", BRANCH);
    assertRefused(
      await w.deliver({ ...(await w.work()), existingRef: "main" }),
      "not a branch ryph delivers",
    );
    assertEquals(await tipOf(w.repo, "main"), w.baseSha);
  } finally {
    await w.cleanup();
  }
});

test("a delivered branch the owner deleted: the revision lands on the run's branch as a new one", async () => {
  const w = await world();
  try {
    const first = await w.work();
    assertEquals((await w.deliver(first)).kind, "delivered");
    // Merged and deleted by the owner.
    await git(w.repo, "branch", "-D", BRANCH);

    // The same run's next revision, naming the branch it delivered before: delivered afresh.
    const second = await w.work({ existingRef: BRANCH });
    assertEquals(await w.deliver(second), { kind: "delivered", ref: BRANCH, url: null });
    assertEquals(await tipOf(w.repo, BRANCH), second.headSha);

    // A later run revising a patch whose branch (another run's) is gone: onto ITS OWN branch.
    await git(w.repo, "branch", "-D", BRANCH);
    const other = await w.work({
      from: second.headSha,
      branch: "ryph/bob/r-2/work",
      existingRef: BRANCH,
    });
    assertEquals(await w.deliver(other), {
      kind: "delivered",
      ref: "ryph/bob/r-2/work",
      url: null,
    });
    assertEquals(await tipOf(w.repo, "ryph/bob/r-2/work"), other.headSha);
    assertEquals(await tipOf(w.repo, BRANCH), null);
    // Retried: converges on what landed.
    assertEquals(await w.deliver(other), {
      kind: "delivered",
      ref: "ryph/bob/r-2/work",
      url: null,
    });

    // Under every first-delivery rule: the run's branch checked out by the owner is not moved...
    await git(w.repo, "branch", "-D", "ryph/bob/r-2/work");
    await git(w.repo, "checkout", "--quiet", "-b", "ryph/bob/r-2/work", "main");
    const third = await w.work({
      from: other.headSha,
      branch: "ryph/bob/r-2/work",
      existingRef: BRANCH,
    });
    assertRefused(await w.deliver(third), "checked out");
    // ...and a run branch the owner made is not ryph's to move.
    await git(w.repo, "checkout", "--quiet", "main");
    assertRefused(await w.deliver(third), "did not deliver");
    assertEquals(await tipOf(w.repo, "ryph/bob/r-2/work"), w.baseSha);
  } finally {
    await w.cleanup();
  }
});

test("a push the repository refuses is terminal; a lock or a lost lease is not", async () => {
  const w = await world();
  try {
    // receive.procReceiveRefs routes the refs to a proc-receive hook, which cannot run: every
    // attempt is refused the same way, and must not be retried forever.
    await git(w.repo, "config", "receive.procReceiveRefs", "refs/heads");
    const change = await w.work();
    const outcome = await w.deliver(change);
    assertRefused(outcome, "refused the branch");
    assertPathFree(outcome, w.tmp);
    assertEquals(await tipOf(w.repo, BRANCH), null);

    await git(w.repo, "config", "--unset", "receive.procReceiveRefs");
    assertEquals(await w.deliver(change), { kind: "delivered", ref: BRANCH, url: null });
  } finally {
    await w.cleanup();
  }

  const said = (reason: string) =>
    `To /x\n ! [remote rejected] ryph/a/r-1 -> ryph/a/r-1 (${reason})\nerror: failed to push`;
  assert(isPermanentPushFailure(said("fail to run proc-receive hook")));
  assert(isPermanentPushFailure(said("deny updating a hidden ref")));
  assert(isPermanentPushFailure(said("refname conflict")));
  assert(isPermanentPushFailure(said("deletion prohibited")));
  assert(isPermanentPushFailure(" ! [rejected]        x -> x (non-fast-forward)"));
  // Only the KNOWN reasons: whatever git words a transient refusal as is looked at again.
  assertFalse(isPermanentPushFailure(said("reference already exists")));
  assertFalse(isPermanentPushFailure(said("unpacker error")));
  assertFalse(isPermanentPushFailure(said("some reason a later git invents")));
  assertFalse(isPermanentPushFailure(said("cannot lock ref 'refs/heads/ryph/a/r-1'")));
  assertFalse(isPermanentPushFailure(" ! [rejected]        x -> x (stale info)"));
  assertFalse(
    isPermanentPushFailure(
      "fatal: Unable to create '/x/.git/refs/heads/ryph/a/r-1.lock': File exists.",
    ),
  );
  assertFalse(isPermanentPushFailure("fatal: could not read from remote repository"));
});

test("a symlinked directory on the way to the branch's ref is never written through", async () => {
  const w = await world();
  try {
    const elsewhere = `${w.tmp}/elsewhere-refs`;
    await mkdir(elsewhere);
    await mkdir(`${w.repo}/.git/refs/heads/ryph`, { recursive: true });
    await symlink(elsewhere, `${w.repo}/.git/refs/heads/ryph/ada`);
    const outcome = await w.deliver(await w.work());
    // The re-check's walk of the ref store refuses it before anything is staged.
    assertRefused(outcome, "no longer a plain git repository");
    assertPathFree(outcome, w.tmp);
    assertEquals(readdirSync(elsewhere, { withFileTypes: true }), []);
  } finally {
    await w.cleanup();
  }
});

test("failures a run reads carry no host path and none of git's words", async () => {
  const w = await world();
  try {
    const first = await w.work();
    assertEquals((await w.deliver(first)).kind, "delivered");
    await git(w.repo, "checkout", "--quiet", BRANCH);
    const checkedOut = await w.deliver(await w.work({ existingRef: BRANCH }));
    assertRefused(checkedOut, "checked out in the repository");
    assertPathFree(checkedOut, w.tmp);

    await git(w.repo, "checkout", "--quiet", "main");
    const diverged = await w.deliver(await w.work({ from: w.baseSha, existingRef: BRANCH }));
    assertRefused(diverged, "do not build on");
    assertPathFree(diverged, w.tmp);

    // A bundle whose head is not the recorded one.
    const lying = await w.deliver({ ...(await w.work()), headSha: "f".repeat(40) });
    assertRefused(lying, "does not verify");
    assertPathFree(lying, w.tmp);
  } finally {
    await w.cleanup();
  }
});

test("real git: a held ref lock and an object store that cannot be written are retried; a hidden ref and a refname conflict are final", async () => {
  // Real refusals from the git on this machine, not strings written to look like them: since git
  // 2.52 a held lock answers "(reference already exists)", which a rule reading every
  // `[remote rejected]` as final would have made a patch's permanent failure.
  const w = await world();
  const retried = (outcome: ChangeDeliveryOutcome) => {
    assertEquals(outcome.kind, "failed");
    if (outcome.kind === "failed") assertFalse(outcome.terminal, outcome.message);
  };
  try {
    const change = await w.work();

    // Somebody else's git holds the branch's lock.
    const lock = `${w.repo}/.git/refs/heads/ryph/ada/r-1/work.lock`;
    await mkdir(`${w.repo}/.git/refs/heads/ryph/ada/r-1`, { recursive: true });
    await writeFile(lock, "");
    retried(await w.deliver(change));
    assertEquals(await tipOf(w.repo, BRANCH), null);
    await rm(lock);

    // The object store cannot take the pack (a full or read-only disk answers the same way).
    // Root writes through any mode, so where the probe write lands the fixture proves nothing
    // and is skipped.
    await chmod(`${w.repo}/.git/objects`, 0o555);
    try {
      const writable = await writeFile(`${w.repo}/.git/objects/probe`, "").then(
        () => true,
        () => false,
      );
      if (writable) await rm(`${w.repo}/.git/objects/probe`);
      else retried(await w.deliver(change));
    } finally {
      await chmod(`${w.repo}/.git/objects`, 0o755);
    }
    assertEquals(await tipOf(w.repo, BRANCH), null);

    // Both healed: the same delivery goes through.
    assertEquals(await w.deliver(change), { kind: "delivered", ref: BRANCH, url: null });
  } finally {
    await w.cleanup();
  }

  const v = await world();
  try {
    const change = await v.work();
    await git(v.repo, "config", "receive.hideRefs", "refs/heads/ryph");
    assertRefused(await v.deliver(change), "refused the branch");
    await git(v.repo, "config", "--unset", "receive.hideRefs");

    // `ryph/ada` is a branch, so `ryph/ada/r-1/work` cannot be one.
    await git(v.repo, "branch", "ryph/ada", "main");
    assertRefused(await v.deliver(change), "refused the branch");
    assertEquals(await tipOf(v.repo, BRANCH), null);
  } finally {
    await v.cleanup();
  }
});

test("a symlinked logs/refs never carries the reflog out of the repository", async () => {
  const w = await world();
  try {
    const elsewhere = `${w.tmp}/elsewhere-logs`;
    await mkdir(elsewhere);
    await rm(`${w.repo}/.git/logs/refs`, { recursive: true });
    await symlink(elsewhere, `${w.repo}/.git/logs/refs`);
    const outcome = await w.deliver(await w.work());
    assertRefused(outcome, "no longer a plain git repository");
    assertPathFree(outcome, w.tmp);
    assertEquals(readdirSync(elsewhere, { withFileTypes: true }), []);
    assertEquals(await tipOf(w.repo, BRANCH), null);
  } finally {
    await w.cleanup();
  }
});
