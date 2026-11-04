// The staleness check against REAL git, because the thing at stake is how git reads a string.
//
// A memory's evidence paths arrive from outside this process and are handed to `git diff` as
// pathspecs. A pathspec is not a path: `:/` alone means "the whole repository" and `:(exclude)x`
// means "everything but x", so one crafted entry could make every run on a repo look stale — or
// look clean — with nothing malformed anywhere. The spec schema refuses those strings; this is
// the other half, which holds even if one ever gets through.

import { test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { git } from "../src/helpers/git_exec.ts";
import {
  changedPaths,
  changedSince,
  checkoutStart,
  commitAll,
  departures,
  hasChanges,
  putBack,
} from "../src/helpers/checkout.ts";

/** Identity on the command line: the hermetic env has no user config to read one from. */
const commit = (dir: string, message: string) =>
  git(
    dir,
    "-c",
    "user.name=tester",
    "-c",
    "user.email=tester@test.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  );

/** A repo with two commits: `base.txt` at the first, `changed.txt` added at the second. */
async function twoCommitRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-checkout-"));
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(`${dir}/base.txt`, "base\n");
  await git(dir, "add", "-A");
  await commit(dir, "base");
  const baseSha = await git(dir, "rev-parse", "HEAD");
  await writeFile(`${dir}/changed.txt`, "changed\n");
  await git(dir, "add", "-A");
  await commit(dir, "change");
  return { dir, baseSha };
}

test("changedSince names the paths that changed, and only those", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    assertEquals(await changedSince(git, dir, baseSha, ["changed.txt"]), ["changed.txt"]);
    assertEquals(await changedSince(git, dir, baseSha, ["base.txt"]), []);
    // A commit this clone does not have is "cannot tell", never "stale".
    assertEquals(await changedSince(git, dir, "0".repeat(40), ["changed.txt"]), null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a pathspec-magic evidence path broadens nothing: the diff is literal", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    // Without --literal-pathspecs this is "the whole repository" and answers ["changed.txt"],
    // which is one memory declaring itself stale on every run of every repo it is briefed into.
    assertEquals(await changedSince(git, dir, baseSha, [":/"]), []);
    assertEquals(await changedSince(git, dir, baseSha, [":(exclude)base.txt"]), []);
    // It does not narrow anything either: the real path beside it still answers for itself.
    assertEquals(await changedSince(git, dir, baseSha, [":/", "changed.txt"]), ["changed.txt"]);
    // Proof that the flag is what does it, not the repo being empty of changes: the same
    // invocation WITHOUT it reads the magic and matches everything.
    const magic = await git(dir, "diff", "--name-only", `${baseSha}..HEAD`, "--", ":/");
    assertEquals(magic, "changed.txt");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a leading-dash evidence path is a path, never an option", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    // After `--` git never re-parses a token as an option; with a literal pathspec on top, a
    // name like this is simply a file that does not exist here.
    assertEquals(await changedSince(git, dir, baseSha, ["--output=/tmp/pwned"]), []);
    assert(await changedSince(git, dir, baseSha, ["-x"]) !== null);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// putBack: what a failed setup step left, undone to where the checkout started — against real
// git, because what is at stake is which state git keeps where.

/** Put-back of a checkout whose own setup step failed (`PutBackOptions`). */
const FAILED = { failed: true };
/** Put-back of a checkout a successful setup (or another repo's failed one) left changed. */
const KEPT = { failed: false };

const conflicting = async (dir: string) => {
  // `main` and `side` both change base.txt from the base, so applying one onto the other stops.
  await git(dir, "checkout", "-q", "-b", "side");
  await writeFile(`${dir}/base.txt`, "side\n");
  await git(dir, "add", "-A");
  await commit(dir, "side");
  await git(dir, "checkout", "-q", "main");
  await writeFile(`${dir}/base.txt`, "main\n");
  await git(dir, "add", "-A");
  await commit(dir, "main");
};

// With an identity, as `commit` has: `git merge` refuses before it starts without one, which a
// container (no account name or mail to guess one from) never has.
const ident = ["-c", "user.name=tester", "-c", "user.email=tester@test.local"];
const startedOps: Array<[string, (dir: string) => Promise<unknown>, string]> = [
  ["merge", (dir) => git(dir, ...ident, "merge", "-q", "side"), "a merge in progress"],
  ["cherry-pick", (dir) => git(dir, ...ident, "cherry-pick", "side"), "a cherry-pick in progress"],
  ["rebase", (dir) => git(dir, ...ident, "rebase", "-q", "side"), "a rebase in progress"],
];

for (const [name, op, said] of startedOps) {
  test(`putBack: a ${name} stopped half-way is abandoned, and the branch is back on its start`, async () => {
    const { dir } = await twoCommitRepo();
    try {
      await conflicting(dir);
      const start = await checkoutStart(git, dir);
      assertEquals(start.branch, "main");
      await op(dir).then(() => assert(false, `${name} should have stopped`), () => {});
      assert((await departures(git, dir, start)).includes(said));
      assertEquals(await putBack(git, dir, start, FAILED), true);
      assertEquals(await departures(git, dir, start), []);
      assertEquals(await git(dir, "rev-parse", "HEAD"), start.sha);
      assertEquals(await git(dir, "symbolic-ref", "--short", "HEAD"), "main");
      assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "main\n");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
}

test("putBack: a commit, a branch switch and a nested repository are all undone; ignored files stay", async () => {
  const { dir } = await twoCommitRepo();
  try {
    await writeFile(`${dir}/.gitignore`, "build/\n");
    await git(dir, "add", "-A");
    await commit(dir, "ignore build");
    const start = await checkoutStart(git, dir);
    assertEquals(await putBack(git, dir, start, FAILED), false, "nothing to put back");

    await writeFile(`${dir}/setup.txt`, "s\n");
    await git(dir, "add", "-A");
    await commit(dir, "setup commit");
    await git(dir, "checkout", "-q", "-b", "elsewhere");
    await mkdir(`${dir}/vendored`);
    await git(`${dir}/vendored`, "init", "-q");
    await writeFile(`${dir}/vendored/v.txt`, "v\n");
    await mkdir(`${dir}/build`);
    await writeFile(`${dir}/build/out`, "o\n");
    const before = await departures(git, dir, start);
    assert(before.some((d) => d.startsWith("HEAD at ")), before.join("; "));
    assert(before.includes("branch elsewhere checked out"), before.join("; "));
    assert(before.some((d) => d.includes("vendored")), before.join("; "));

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await git(dir, "symbolic-ref", "--short", "HEAD"), "main");
    await assertRejects(() => stat(`${dir}/vendored`));
    await assertRejects(() => stat(`${dir}/setup.txt`));
    assertEquals(await readFile(`${dir}/build/out`, "utf8"), "o\n");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack: a detached start stays detached", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    await git(dir, "checkout", "-q", "--detach", baseSha);
    const start = await checkoutStart(git, dir);
    assertEquals(
      { sha: start.sha, branch: start.branch, replaceRefs: start.replaceRefs },
      { sha: baseSha, branch: null, replaceRefs: [] },
    );
    assertEquals(start.submodules, []);
    await git(dir, "checkout", "-q", "main");
    assertEquals(await departures(git, dir, start), [
      `HEAD at ${(await git(dir, "rev-parse", "HEAD")).slice(0, 10)}, not ${baseSha.slice(0, 10)}`,
      "branch main checked out",
    ]);
    assertEquals(await putBack(git, dir, start, FAILED), true);
    await assertRejects(() => git(dir, "symbolic-ref", "-q", "HEAD"));
    assertEquals(await git(dir, "rev-parse", "HEAD"), baseSha);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack: a tree it cannot put back is an error naming what is left", async () => {
  // root writes through a read-only directory, so there is nothing left to name
  if (process.getuid?.() === 0) return;
  const { dir } = await twoCommitRepo();
  try {
    await mkdir(`${dir}/locked`);
    await writeFile(`${dir}/locked/stuck.txt`, "x\n");
    await git(dir, "add", "-A");
    await commit(dir, "locked");
    const start = await checkoutStart(git, dir);
    // a tracked file changed in a TRACKED directory git may not write to: the checkout cannot
    // replace it (an untracked read-only directory is made removable, so it would not do)
    await writeFile(`${dir}/locked/stuck.txt`, "y\n");
    await chmod(`${dir}/locked`, 0o555);
    await assertRejects(() => putBack(git, dir, start, FAILED), Error, "locked/stuck.txt");
  } finally {
    await chmod(`${dir}/locked`, 0o755).catch(() => {});
    await rm(dir, { recursive: true });
  }
});

test("changedPaths: the first path is whole, though the executor trims its output", async () => {
  const { dir } = await twoCommitRepo();
  try {
    // ` M base.txt` first: trimmed, its path would start a column early
    await writeFile(`${dir}/base.txt`, "edited\n");
    await writeFile(`${dir}/new.txt`, "x\n");
    assertEquals(await changedPaths(git, dir), ["base.txt", "new.txt"]);
    // a staged change keeps both columns: `M  changed.txt`
    await git(dir, "add", "base.txt");
    assertEquals(await changedPaths(git, dir), ["base.txt", "new.txt"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack: git refusing to restore (a ref lock) names what was left, and git's reason", async () => {
  const { dir } = await twoCommitRepo();
  try {
    const start = await checkoutStart(git, dir);
    await writeFile(`${dir}/base.txt`, "edited\n");
    await writeFile(`${dir}/.git/refs/heads/main.lock`, "");
    const err = await assertRejects(() => putBack(git, dir, start, FAILED), Error);
    const message = (err as Error).message;
    assert(message.includes("changes to base.txt"), message);
    assert(message.includes("main.lock"), message);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack: a step that hides untracked files in the repo's config hides nothing", async () => {
  const { dir } = await twoCommitRepo();
  try {
    const start = await checkoutStart(git, dir);
    // Repo code a step runs can write .git/config: the check must not follow it.
    await git(dir, "config", "status.showUntrackedFiles", "no");
    await mkdir(`${dir}/gen`);
    await writeFile(`${dir}/gen/planted.ts`, "x\n");
    assertEquals(await git(dir, "status", "--porcelain"), "", "the repo's config hides it");
    assertEquals(await changedPaths(git, dir), ["gen/"]);
    assert((await departures(git, dir, start)).some((d) => d.includes("gen/")));
    assertEquals(await putBack(git, dir, start, FAILED), true);
    await assertRejects(() => stat(`${dir}/gen/planted.ts`));
  } finally {
    await rm(dir, { recursive: true });
  }
});

/** `twoCommitRepo` with a submodule at `sub/` (its own repo, one commit holding `s.txt`),
 * initialised and committed. `ignore` is written to `.gitmodules` when given. */
async function repoWithSubmodule(ignore?: string): Promise<{ dir: string; subSrc: string }> {
  const { dir } = await twoCommitRepo();
  const subSrc = await mkdtemp(join(tmpdir(), "runner-checkout-sub-"));
  await git(subSrc, "init", "-q", "-b", "main");
  await writeFile(`${subSrc}/s.txt`, "sub\n");
  await git(subSrc, "add", "-A");
  await commit(subSrc, "sub base");
  await git(dir, "submodule", "add", "-q", subSrc, "sub");
  if (ignore !== undefined) {
    await git(dir, "config", "-f", ".gitmodules", "submodule.sub.ignore", ignore);
  }
  await git(dir, "add", "-A");
  await commit(dir, "add sub");
  return { dir, subSrc };
}

test("hasChanges: a submodule's own ignore = dirty is honoured, and the commit path still works", async () => {
  const { dir, subSrc } = await repoWithSubmodule("dirty");
  try {
    // Build output inside the submodule, which the repo says to ignore.
    await writeFile(`${dir}/sub/s.txt`, "rebuilt\n");
    await writeFile(`${dir}/sub/out.bin`, "o\n");
    assertEquals(await hasChanges(git, dir), false);
    assertEquals(await changedPaths(git, dir), []);
    // Real work beside it commits, and leaves nothing that reads as more to commit.
    await writeFile(`${dir}/work.txt`, "w\n");
    assertEquals(await hasChanges(git, dir), true);
    await git(dir, "config", "user.name", "tester");
    await git(dir, "config", "user.email", "tester@test.local");
    await git(dir, "config", "commit.gpgsign", "false");
    await commitAll(git, dir, "work");
    assertEquals(await hasChanges(git, dir), false);
    assertEquals(await git(dir, "show", "--name-only", "--format=", "HEAD"), "work.txt");
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: what a step left inside an initialised submodule is put back", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    const start = await checkoutStart(git, dir);
    const subHead = await git(`${dir}/sub`, "rev-parse", "HEAD");
    // A step that builds in the submodule: a tracked file rewritten, an untracked one, a commit.
    await writeFile(`${dir}/sub/s.txt`, "rewritten\n");
    await writeFile(`${dir}/sub/gen.txt`, "g\n");
    await git(`${dir}/sub`, "add", "-A");
    await commit(`${dir}/sub`, "setup commit in sub");
    await writeFile(`${dir}/sub/s.txt`, "dirty again\n");
    await writeFile(`${dir}/sub/untracked.txt`, "u\n");
    assert((await departures(git, dir, start)).some((d) => d.includes("sub")));
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await git(`${dir}/sub`, "rev-parse", "HEAD"), subHead);
    assertEquals(await readFile(`${dir}/sub/s.txt`, "utf8"), "sub\n");
    await assertRejects(() => stat(`${dir}/sub/gen.txt`));
    await assertRejects(() => stat(`${dir}/sub/untracked.txt`));
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a replace ref or a graft cannot stand in for the start commit", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    const start = await checkoutStart(git, dir);
    // A commit with injected content, swapped in for the start commit by a replace ref.
    await git(dir, "checkout", "-q", "-b", "evil");
    await writeFile(`${dir}/changed.txt`, "injected\n");
    await git(dir, "add", "-A");
    await commit(dir, "evil");
    const evil = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "main");
    await git(dir, "branch", "-q", "-D", "evil");
    await git(dir, "replace", start.sha, evil);
    await writeFile(`${dir}/.git/info/grafts`, `${start.sha}\n`);
    // The runner's git reads the commit the repository holds, whatever the replace ref says.
    assertEquals(await git(dir, "show", `${start.sha}:changed.txt`), "changed");
    const found = await departures(git, dir, start);
    assert(found.includes("replace refs under refs/replace/"), found.join("; "));
    assert(found.includes("a grafts file"), found.join("; "));
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await git(dir, "for-each-ref", "refs/replace/"), "");
    await assertRejects(() => stat(`${dir}/.git/info/grafts`));
    assertEquals(await readFile(`${dir}/changed.txt`, "utf8"), "changed\n");
    assertEquals(await git(dir, "rev-parse", "HEAD^"), baseSha);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack: replace refs the clone started with are no departure; only new ones go", async () => {
  const { dir, baseSha } = await twoCommitRepo();
  try {
    const head = await git(dir, "rev-parse", "HEAD");
    // One the clone came with, which the runner's git ignores anyway.
    await git(dir, "replace", baseSha, head);
    const start = await checkoutStart(git, dir);
    assertEquals(start.replaceRefs, [`refs/replace/${baseSha}`]);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await putBack(git, dir, start, FAILED), false);
    // One a step writes is, and goes; the one from before stays.
    await git(dir, "replace", head, baseSha);
    assertEquals(await departures(git, dir, start), ["replace refs under refs/replace/"]);
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(
      await git(dir, "for-each-ref", "--format=%(refname)", "refs/replace/"),
      `refs/replace/${baseSha}`,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test(
  "putBack: a submodule registered but never checked out is not cloned, however far its remote",
  async () => {
    const { dir, subSrc } = await repoWithSubmodule();
    try {
      // Registered in .git/config but not checked out, its clone gone: `submodule update` would
      // clone it — from a remote nothing answers for, waiting as long as the network lets it.
      await git(dir, "submodule", "deinit", "-q", "-f", "sub");
      await rm(`${dir}/.git/modules/sub`, { recursive: true, force: true });
      await git(dir, "submodule", "init", "-q", "sub");
      await git(dir, "config", "submodule.sub.url", "https://10.255.255.1/unreachable.git");
      const start = await checkoutStart(git, dir);
      await writeFile(`${dir}/left.txt`, "l\n");
      const began = performance.now();
      assertEquals(await putBack(git, dir, start, FAILED), true);
      assert(performance.now() - began < 10_000, "no network wait");
      await assertRejects(() => stat(`${dir}/.git/modules/sub`));
      await assertRejects(() => stat(`${dir}/sub/.git`));
      assertEquals(await departures(git, dir, start), []);
    } finally {
      await rm(dir, { recursive: true });
      await rm(subSrc, { recursive: true });
    }
  },
  30_000,
);

test("putBack: a submodule update command a step configured never runs", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const marker = join(await mkdtemp(join(tmpdir(), "runner-checkout-marker-")), "ran");
  try {
    const start = await checkoutStart(git, dir);
    const subHead = await git(`${dir}/sub`, "rev-parse", "HEAD");
    await git(dir, "config", "submodule.sub.update", `!touch ${marker}`);
    await writeFile(`${dir}/sub/gen.txt`, "g\n");
    await git(`${dir}/sub`, "add", "-A");
    await commit(`${dir}/sub`, "setup commit in sub");
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await git(`${dir}/sub`, "rev-parse", "HEAD"), subHead);
    await assertRejects(() => stat(marker));
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
    await rm(join(marker, ".."), { recursive: true });
  }
});

test("putBack: output a submodule's ignore = untracked hides stays, even when its HEAD went back", async () => {
  const { dir, subSrc } = await repoWithSubmodule("untracked");
  try {
    const start = await checkoutStart(git, dir);
    const subHead = await git(`${dir}/sub`, "rev-parse", "HEAD");
    await writeFile(`${dir}/sub/out.bin`, "o\n");
    // Something else departs: the submodule is not touched at all.
    await writeFile(`${dir}/left.txt`, "l\n");
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await readFile(`${dir}/sub/out.bin`, "utf8"), "o\n");
    // Its HEAD moved too: back on its commit, the output it hides still kept.
    await writeFile(`${dir}/sub/s.txt`, "moved\n");
    await git(`${dir}/sub`, "add", "s.txt");
    await commit(`${dir}/sub`, "setup commit in sub");
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await git(`${dir}/sub`, "rev-parse", "HEAD"), subHead);
    assertEquals(await readFile(`${dir}/sub/s.txt`, "utf8"), "sub\n");
    assertEquals(await readFile(`${dir}/sub/out.bin`, "utf8"), "o\n");
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a submodule commit its clone does not hold is never fetched, and the tree is refused", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    // The tree records a submodule commit, then the submodule's clone loses it.
    await writeFile(`${dir}/sub/s.txt`, "recorded\n");
    await git(`${dir}/sub`, "add", "-A");
    await commit(`${dir}/sub`, "recorded");
    const recorded = await git(`${dir}/sub`, "rev-parse", "HEAD");
    await git(dir, "add", "sub");
    await commit(dir, "record sub");
    const start = await checkoutStart(git, dir);
    await git(`${dir}/sub`, "reset", "-q", "--hard", "HEAD~1");
    await git(`${dir}/sub`, "reflog", "expire", "--expire=now", "--all");
    await git(`${dir}/sub`, "gc", "-q", "--prune=now");
    await assertRejects(() => git(`${dir}/sub`, "cat-file", "-e", recorded));
    const err = await assertRejects(() => putBack(git, dir, start, FAILED), Error);
    assert(err.message.includes(`records commit ${recorded.slice(0, 10)}`), err.message);
    assert(err.message.includes("does not hold"), err.message);
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a submodule inside a submodule is put back when it is what changed", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const innerSrc = await mkdtemp(join(tmpdir(), "runner-checkout-inner-"));
  const allow = ["-c", "protocol.file.allow=always"];
  try {
    await git(innerSrc, "init", "-q", "-b", "main");
    await writeFile(`${innerSrc}/i.txt`, "inner\n");
    await git(innerSrc, "add", "-A");
    await commit(innerSrc, "inner base");
    await git(`${dir}/sub`, ...allow, "submodule", "add", "-q", innerSrc, "inner");
    await commit(`${dir}/sub`, "add inner");
    await git(dir, "add", "sub");
    await commit(dir, "record sub with inner");
    const start = await checkoutStart(git, dir);
    const innerHead = await git(`${dir}/sub/inner`, "rev-parse", "HEAD");
    await writeFile(`${dir}/sub/inner/i.txt`, "moved\n");
    await git(`${dir}/sub/inner`, "add", "-A");
    await commit(`${dir}/sub/inner`, "setup commit in inner");
    await writeFile(`${dir}/sub/inner/gen.txt`, "g\n");
    assert((await departures(git, dir, start)).some((d) => d.includes("sub")));
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await git(`${dir}/sub/inner`, "rev-parse", "HEAD"), innerHead);
    await assertRejects(() => stat(`${dir}/sub/inner/gen.txt`));
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
    await rm(innerSrc, { recursive: true });
  }
});

/** `repoWithSubmodule`, its submodule then recording a commit only its checked-out clone holds,
 * and returned to never checked out — as every clone the runner makes leaves a submodule. */
async function repoWithUnfetchableSubmodule(): Promise<{ dir: string; subSrc: string }> {
  const { dir, subSrc } = await repoWithSubmodule();
  await writeFile(`${dir}/sub/s.txt`, "never pushed\n");
  await git(`${dir}/sub`, "add", "-A");
  await commit(`${dir}/sub`, "never pushed");
  await git(dir, "add", "sub");
  await commit(dir, "record an unpushed sub commit");
  await git(dir, "submodule", "deinit", "-q", "-f", "sub");
  await rm(`${dir}/.git/modules/sub`, { recursive: true, force: true });
  return { dir, subSrc };
}

const allowFile = ["-c", "protocol.file.allow=always"];

test("putBack: a submodule setup cloned but could not check out goes back to never checked out", async () => {
  const { dir, subSrc } = await repoWithUnfetchableSubmodule();
  try {
    const start = await checkoutStart(git, dir);
    assertEquals(start.submodules.map((s) => [s.path, s.name, s.where]), [["sub", "sub", null]]);
    // The step: clones the submodule, then cannot check out the commit the tree records.
    await assertRejects(() => git(dir, ...allowFile, "submodule", "update", "--init", "-q"));
    await stat(`${dir}/sub/.git`);
    await stat(`${dir}/.git/modules/sub`);
    assert((await departures(git, dir, start)).some((d) => d.includes("sub")));
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await git(dir, "status", "--porcelain", "--ignore-submodules=none"), "");
    assertEquals((await stat(`${dir}/sub`)).isDirectory(), true);
    assertEquals(await readdir(`${dir}/sub`), []);
    // The clone the step made for it goes with it: nothing a later `submodule update` takes up.
    await assertRejects(() => stat(`${dir}/.git/modules/sub`));
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a submodule setup checked out cleanly on its commit stays", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    await git(dir, "submodule", "deinit", "-q", "-f", "sub");
    const start = await checkoutStart(git, dir);
    assertEquals(start.submodules[0].where, null);
    await git(dir, ...allowFile, "submodule", "update", "--init", "-q");
    // Something else departs, so the tree is put back.
    await writeFile(`${dir}/left.txt`, "l\n");
    assertEquals(await putBack(git, dir, start, KEPT), true);
    assertEquals(await readFile(`${dir}/sub/s.txt`, "utf8"), "sub\n");
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack (failed): a submodule the step checked out stays, with the drivers it configured there gone and never run", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    await git(dir, "submodule", "deinit", "-q", "-f", "sub");
    const start = await checkoutStart(git, dir);
    await git(dir, ...allowFile, "submodule", "update", "--init", "-q");
    await git(`${dir}/sub`, "config", "filter.planted.clean", `touch ${marks}/clean; cat`);
    await git(`${dir}/sub`, "config", "filter.planted.smudge", `touch ${marks}/smudge; cat`);
    await writeFile(`${dir}/.git/modules/sub/info/attributes`, "s.txt filter=planted\n");
    // Stat info the index no longer trusts, so a status in it would run the clean filter.
    const later = new Date(Date.now() + 60_000);
    await utimes(`${dir}/sub/s.txt`, later, later);
    await writeFile(`${dir}/left.txt`, "l\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await readFile(`${dir}/sub/s.txt`, "utf8"), "sub\n");
    assertEquals(await filterKeys(`${dir}/sub`), "");
    await assertRejects(() => stat(`${dir}/.git/modules/sub/info/attributes`));
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test(
  "putBack: a submodule a step made a partial clone never fetches, nor runs its uploadpack",
  async () => {
    const { dir, subSrc } = await repoWithSubmodule();
    const marker = join(await mkdtemp(join(tmpdir(), "runner-checkout-marker-")), "ran");
    try {
      await writeFile(`${dir}/sub/s.txt`, "recorded\n");
      await git(`${dir}/sub`, "add", "-A");
      await commit(`${dir}/sub`, "recorded");
      await git(dir, "add", "sub");
      await commit(dir, "record sub");
      const start = await checkoutStart(git, dir);
      // The step: the recorded commit gone from the clone, which is now a promisor whose fetch
      // runs a command of the step's choosing (and would hang on it).
      const sub = `${dir}/sub`;
      await git(sub, "reset", "-q", "--hard", "HEAD~1");
      await git(sub, "reflog", "expire", "--expire=now", "--all");
      await git(sub, "gc", "-q", "--prune=now");
      await git(sub, "config", "core.repositoryformatversion", "1");
      await git(sub, "config", "extensions.partialClone", "origin");
      await git(sub, "config", "remote.origin.promisor", "true");
      await git(
        sub,
        "config",
        "remote.origin.uploadpack",
        `touch ${marker}; sleep 60; git-upload-pack`,
      );
      const began = performance.now();
      const err = await assertRejects(() => putBack(git, dir, start, FAILED), Error);
      assert(performance.now() - began < 10_000, "no fetch waited on");
      assert(err.message.includes("does not hold"), err.message);
      await assertRejects(() => stat(marker));
    } finally {
      await rm(dir, { recursive: true });
      await rm(subSrc, { recursive: true });
      await rm(join(marker, ".."), { recursive: true });
    }
  },
  30_000,
);

test("putBack: a submodule's ignore = all does not hide its moved commit, which goes back", async () => {
  const { dir, subSrc } = await repoWithSubmodule("all");
  try {
    const start = await checkoutStart(git, dir);
    const subHead = await git(`${dir}/sub`, "rev-parse", "HEAD");
    await writeFile(`${dir}/sub/s.txt`, "moved\n");
    await git(`${dir}/sub`, "add", "-A");
    await commit(`${dir}/sub`, "setup commit in sub");
    // The repo's status hides it, yet `add -A` would stage the bump.
    assertEquals(await git(dir, "status", "--porcelain"), "");
    assertEquals(await hasChanges(git, dir), true);
    assertEquals(await changedPaths(git, dir), ["sub"]);
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await git(`${dir}/sub`, "rev-parse", "HEAD"), subHead);
    assertEquals(await hasChanges(git, dir), false);
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a checkout a step pointed at another work tree (core.worktree) is refused, the other untouched", async () => {
  const { dir } = await twoCommitRepo();
  const other = await mkdtemp(join(tmpdir(), "runner-checkout-other-"));
  try {
    const start = await checkoutStart(git, dir);
    await writeFile(`${other}/keep.txt`, "k\n");
    await writeFile(`${dir}/base.txt`, "edited\n");
    await git(dir, "config", "core.worktree", other);
    await assertRejects(() => putBack(git, dir, start, FAILED), Error, "no longer the repository");
    assertEquals(await readFile(`${other}/keep.txt`, "utf8"), "k\n");
  } finally {
    await rm(dir, { recursive: true });
    await rm(other, { recursive: true });
  }
});

test("putBack: a checkout whose .git a step pointed at another repository is refused, the other untouched", async () => {
  const { dir } = await twoCommitRepo();
  const other = await twoCommitRepo();
  try {
    const start = await checkoutStart(git, dir);
    const otherHead = await git(other.dir, "rev-parse", "HEAD");
    await writeFile(`${other.dir}/mine.txt`, "m\n");
    await writeFile(`${other.dir}/base.txt`, "theirs\n");
    await rm(`${dir}/.git`, { recursive: true });
    await writeFile(`${dir}/.git`, `gitdir: ${other.dir}/.git\n`);
    await writeFile(`${dir}/left.txt`, "l\n");
    await assertRejects(() => putBack(git, dir, start, FAILED), Error, "no longer the repository");
    assertEquals(await readFile(`${other.dir}/mine.txt`, "utf8"), "m\n");
    assertEquals(await readFile(`${other.dir}/base.txt`, "utf8"), "theirs\n");
    assertEquals(await git(other.dir, "rev-parse", "HEAD"), otherHead);
  } finally {
    await rm(dir, { recursive: true });
    await rm(other.dir, { recursive: true });
  }
});

test("putBack: the index locks a killed step left are removed, and the tree put back", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    const start = await checkoutStart(git, dir);
    const subHead = await git(`${dir}/sub`, "rev-parse", "HEAD");
    await writeFile(`${dir}/sub/s.txt`, "moved\n");
    await git(`${dir}/sub`, "add", "-A");
    await commit(`${dir}/sub`, "setup commit in sub");
    await writeFile(`${dir}/base.txt`, "edited\n");
    await writeFile(`${dir}/.git/index.lock`, "");
    await writeFile(`${dir}/.git/modules/sub/index.lock`, "");
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "base\n");
    assertEquals(await git(`${dir}/sub`, "rev-parse", "HEAD"), subHead);
    await assertRejects(() => stat(`${dir}/.git/index.lock`));
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: read-only directories a step left untracked are removed, here and in a submodule", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const outside = await mkdtemp(join(tmpdir(), "runner-checkout-outside-"));
  try {
    const start = await checkoutStart(git, dir);
    // `GOMODCACHE=$PWD/.gomodcache go mod download` leaves 0555 directories, all the way down.
    for (const root of [dir, `${dir}/sub`]) {
      await mkdir(`${root}/.gomodcache/mod/pkg@v1`, { recursive: true });
      await writeFile(`${root}/.gomodcache/mod/pkg@v1/go.mod`, "module pkg\n");
      await chmod(`${root}/.gomodcache/mod/pkg@v1/go.mod`, 0o444);
      for (const d of ["mod/pkg@v1", "mod", ""]) await chmod(`${root}/.gomodcache/${d}`, 0o555);
    }
    // A link to a read-only directory outside the checkout is removed, and what it points at
    // keeps its mode.
    await chmod(outside, 0o555);
    await symlink(outside, `${dir}/outside-link`);
    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    await assertRejects(() => stat(`${dir}/.gomodcache`));
    await assertRejects(() => stat(`${dir}/sub/.gomodcache`));
    await assertRejects(() => lstat(`${dir}/outside-link`));
    assertEquals((await stat(outside)).mode & 0o777, 0o555);
  } finally {
    await chmod(outside, 0o755);
    await rm(outside, { recursive: true });
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("departures: a repository's own clean/smudge filter reads as no change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-checkout-"));
  try {
    await git(dir, "init", "-q", "-b", "main");
    // Stored upper case, checked out lower case: a filterless status would read the work tree
    // as modified once its stat info changes.
    await git(dir, "config", "filter.case.clean", "tr a-z A-Z");
    await git(dir, "config", "filter.case.smudge", "tr A-Z a-z");
    await writeFile(`${dir}/.gitattributes`, "f.txt filter=case\n");
    await writeFile(`${dir}/f.txt`, "hello\n");
    await git(dir, "add", "-A");
    await commit(dir, "base");
    assertEquals(await git(dir, "show", "HEAD:f.txt"), "HELLO");
    const start = await checkoutStart(git, dir);
    const later = new Date(Date.now() + 60_000);
    await utimes(`${dir}/f.txt`, later, later);

    assertEquals(await departures(git, dir, start), []);
    assertEquals(await putBack(git, dir, start, FAILED), false);
    assertEquals(await readFile(`${dir}/f.txt`, "utf8"), "hello\n");
  } finally {
    await rm(dir, { recursive: true });
  }
});

/** Stored rot13, checked out rot13: not idempotent, as git-crypt is not — a reset that writes the
 * stored blob raw leaves a file the plain status reads as modified. */
const ROT13 = "tr A-Za-z N-ZA-Mn-za-m";

/** Configures `ROT13` as the filter driver `rot` for `r.txt` in `repo`, and commits `r.txt`
 * through it. */
async function commitRot13(repo: string): Promise<void> {
  await git(repo, "config", "filter.rot.clean", ROT13);
  await git(repo, "config", "filter.rot.smudge", ROT13);
  await git(repo, "config", "filter.rot.required", "true");
  await writeFile(`${repo}/.gitattributes`, "r.txt filter=rot\n");
  await writeFile(`${repo}/r.txt`, "hello\n");
  await git(repo, "add", ".gitattributes", "r.txt");
  await commit(repo, "rot13 file");
  assertEquals(await git(repo, "show", "HEAD:r.txt"), "uryyb");
}

test("putBack: the repository's own filter drivers run, so a filtered file a step rewrote comes back as checked out, here and in a submodule", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    await commitRot13(`${dir}/sub`);
    await commitRot13(dir);
    await git(dir, "add", "sub");
    await commit(dir, "record sub");
    const start = await checkoutStart(git, dir);
    // A failed step rewrites the filtered files, and dirties something else.
    for (const repo of [dir, `${dir}/sub`]) await writeFile(`${repo}/r.txt`, "garbage\n");
    await writeFile(`${dir}/base.txt`, "edited\n");
    await writeFile(`${dir}/junk.txt`, "junk\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    for (const repo of [dir, `${dir}/sub`]) {
      assertEquals(await readFile(`${repo}/r.txt`, "utf8"), "hello\n");
      assertEquals(await git(repo, "status", "--porcelain"), "");
    }
    assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "base\n");
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack: a racily clean file the repository's own filter stores comes back as checked out", async () => {
  const { dir } = await twoCommitRepo();
  try {
    await commitRot13(dir);
    const start = await checkoutStart(git, dir);
    // An index no newer than the file makes the entry racily clean: the reset compares content.
    const past = new Date(Date.now() - 60_000);
    await utimes(`${dir}/.git/index`, past, past);
    await writeFile(`${dir}/junk.txt`, "junk\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readFile(`${dir}/r.txt`, "utf8"), "hello\n");
    assertEquals(await git(dir, "status", "--porcelain"), "");
  } finally {
    await rm(dir, { recursive: true });
  }
});

/** Commits `r.txt` stored as rot13 (`uryyb`) under `r.txt filter=rot` in `.gitattributes`, and
 * `lock.json` beside it, with no driver configured: as a git-crypt repository arrives in a fresh
 * clone, whose runner git reads no global config. */
async function commitRot13Raw(repo: string): Promise<void> {
  await writeFile(`${repo}/.gitattributes`, "r.txt filter=rot\n");
  await writeFile(`${repo}/r.txt`, "uryyb\n");
  await writeFile(`${repo}/lock.json`, "{}\n");
  await git(repo, "add", ".gitattributes", "r.txt", "lock.json");
  await commit(repo, "rot13 file, no driver");
}

/** What a setup step's `git-crypt unlock` does, with rot13 for the cipher: configures the driver
 * `rot` — its smudge also touching `marks/smudge` — and checks `r.txt` out through it. The marker
 * it leaves is removed, so a later one is put-back's. The file is then given a time two minutes
 * back and the index refreshed, so the index trusts its stat info: not racily clean. */
async function unlockRot13(repo: string, marks: string): Promise<void> {
  await git(repo, "config", "filter.rot.smudge", `touch ${marks}/smudge; ${ROT13}`);
  await git(repo, "config", "filter.rot.clean", ROT13);
  await git(repo, "config", "filter.rot.required", "true");
  await rm(`${repo}/r.txt`);
  await git(repo, "checkout", "--", "r.txt");
  assertEquals(await readFile(`${repo}/r.txt`, "utf8"), "hello\n");
  const past = new Date(Date.now() - 120_000);
  await utimes(`${repo}/r.txt`, past, past);
  await git(repo, "update-index", "-q", "--refresh");
  await rm(`${marks}/smudge`, { force: true });
}

const filterKeys = (repo: string) =>
  git(repo, "config", "--get-regexp", "^filter\\.").catch(() => "");
/** `filterKeys` in no particular order: a key put-back rewrote comes back at its section's end. */
const filterKeySet = async (repo: string) => (await filterKeys(repo)).split("\n").sort();

for (
  const [variant, racy, edit] of [
    ["the lockfile", false, false],
    ["the lockfile, racily", true, false],
    ["the lockfile and the filtered file", false, true],
    ["the lockfile and the filtered file, racily", true, true],
  ] as const
) {
  test(`putBack (failed): a non-idempotent driver the step added is removed before anything runs, and the file is the stored blob — ${variant}`, async () => {
    const { dir } = await twoCommitRepo();
    const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
    try {
      await commitRot13Raw(dir);
      const start = await checkoutStart(git, dir);
      await unlockRot13(dir, marks);
      await writeFile(`${dir}/lock.json`, '{"rewritten":true}\n');
      if (edit) await writeFile(`${dir}/r.txt`, "garbage\n");
      if (racy) {
        // Older than the file: the entry is racily clean.
        const past = new Date(Date.now() - 180_000);
        await utimes(`${dir}/.git/index`, past, past);
      }

      assertEquals(await putBack(git, dir, start, FAILED), true);
      assertEquals(await filterKeys(dir), "");
      assertEquals(await readFile(`${dir}/r.txt`, "utf8"), "uryyb\n");
      assertEquals(await readFile(`${dir}/lock.json`, "utf8"), "{}\n");
      assertEquals(await git(dir, "status", "--porcelain"), "");
      assertEquals(await departures(git, dir, start), []);
      assertEquals(await readdir(marks), []);
    } finally {
      await rm(marks, { recursive: true });
      await rm(dir, { recursive: true });
    }
  });
}

test("putBack (failed): the repository's own driver whose smudge a step changed is restored, and the changed command never runs", async () => {
  const { dir } = await twoCommitRepo();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    await commitRot13(dir);
    const start = await checkoutStart(git, dir);
    const before = await filterKeySet(dir);
    await git(dir, "config", "filter.rot.smudge", `touch ${marks}/changed; ${ROT13}`);
    await writeFile(`${dir}/r.txt`, "garbage\n");
    await writeFile(`${dir}/base.txt`, "edited\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await filterKeySet(dir), before);
    assertEquals(await readFile(`${dir}/r.txt`, "utf8"), "hello\n");
    assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "base\n");
    assertEquals(await git(dir, "status", "--porcelain"), "");
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
  }
});

test("putBack (failed): a driver name changed in a submodule only leaves the superproject's own same-named driver running", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    await commitRot13(`${dir}/sub`);
    await commitRot13(dir);
    await git(dir, "add", "sub");
    await commit(dir, "record sub");
    const start = await checkoutStart(git, dir);
    const before = [await filterKeySet(dir), await filterKeySet(`${dir}/sub`)];
    await git(`${dir}/sub`, "config", "filter.rot.smudge", `touch ${marks}/sub; ${ROT13}`);
    for (const repo of [dir, `${dir}/sub`]) await writeFile(`${repo}/r.txt`, "garbage\n");
    await writeFile(`${dir}/base.txt`, "edited\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals([await filterKeySet(dir), await filterKeySet(`${dir}/sub`)], before);
    for (const repo of [dir, `${dir}/sub`]) {
      assertEquals(await readFile(`${repo}/r.txt`, "utf8"), "hello\n");
      assertEquals(await git(repo, "status", "--porcelain"), "");
    }
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack (failed): attributes a step planted in info/ go back to the start, here and in a submodule, and their drivers never run", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    // The checkout starts with an info/attributes of its own; the submodule's clone with none.
    await writeFile(`${dir}/.git/info/attributes`, "# the repository's own\n");
    const start = await checkoutStart(git, dir);
    const plant = async (repo: string, gitDir: string, file: string) => {
      // One named so that a `-c` override would have split it wrongly.
      for (const name of ["planted", "a=b"]) {
        await git(repo, "config", `filter.${name}.smudge`, `touch '${marks}/${name}'; cat`);
        await git(repo, "config", `filter.${name}.clean`, "cat");
        await git(repo, "config", `filter.${name}.required`, "true");
      }
      await mkdir(`${gitDir}/info`, { recursive: true });
      await writeFile(`${gitDir}/info/attributes`, `*.txt filter=a=b\n${file} filter=planted\n`);
    };
    await plant(dir, `${dir}/.git`, "base.txt");
    await plant(`${dir}/sub`, `${dir}/.git/modules/sub`, "s.txt");
    await writeFile(`${dir}/base.txt`, "edited\n");
    await writeFile(`${dir}/changed.txt`, "edited\n");
    await writeFile(`${dir}/sub/s.txt`, "edited\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readFile(`${dir}/.git/info/attributes`, "utf8"), "# the repository's own\n");
    await assertRejects(() => stat(`${dir}/.git/modules/sub/info/attributes`));
    for (const repo of [dir, `${dir}/sub`]) assertEquals(await filterKeys(repo), "");
    assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "base\n");
    assertEquals(await readFile(`${dir}/changed.txt`, "utf8"), "changed\n");
    assertEquals(await readFile(`${dir}/sub/s.txt`, "utf8"), "sub\n");
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

test("putBack (failed): a driver a step configured where put-back restores nothing is an error, and never runs", async () => {
  const { dir } = await twoCommitRepo();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  const elsewhere = join(marks, "..", `${marks.split("/").pop()}.config`);
  try {
    // An include the repository started with, whose file a step then fills with a driver.
    await writeFile(elsewhere, "");
    await git(dir, "config", "include.path", elsewhere);
    const start = await checkoutStart(git, dir);
    await writeFile(
      elsewhere,
      `[filter "planted"]\n\tsmudge = touch ${marks}/planted; cat\n\tclean = cat\n`,
    );
    await writeFile(`${dir}/.gitattributes`, "*.txt filter=planted\n");
    await writeFile(`${dir}/base.txt`, "edited\n");

    await assertRejects(() => putBack(git, dir, start, FAILED), Error, "filter drivers");
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(elsewhere, { force: true });
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
  }
});

test("putBack (not failed): a driver a successful setup added stays, and its file stays smudged", async () => {
  const { dir } = await twoCommitRepo();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    await commitRot13Raw(dir);
    const start = await checkoutStart(git, dir);
    await unlockRot13(dir, marks);
    const unlocked = await filterKeys(dir);
    await writeFile(`${dir}/lock.json`, '{"rewritten":true}\n');

    assertEquals(await putBack(git, dir, start, KEPT), true);
    assertEquals(await filterKeys(dir), unlocked);
    assertEquals(await readFile(`${dir}/r.txt`, "utf8"), "hello\n");
    assertEquals(await readFile(`${dir}/lock.json`, "utf8"), "{}\n");
    assertEquals(await git(dir, "status", "--porcelain"), "");
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
  }
});

test("putBack: a checkout nothing changed is not put back, and its config is never written", async () => {
  const { dir, subSrc } = await repoWithSubmodule();
  try {
    await commitRot13(dir);
    await writeFile(`${dir}/.git/info/attributes`, "# own\n");
    const start = await checkoutStart(git, dir);
    const config = await readFile(`${dir}/.git/config`, "utf8");
    const index = (await stat(`${dir}/.git/index`)).mtimeMs;
    const seen: string[][] = [];
    const watched = (cwd: string, ...args: string[]) => {
      seen.push(args);
      return git(cwd, ...args);
    };
    for (const opts of [FAILED, KEPT]) {
      assertEquals(await putBack(watched, dir, start, opts), false);
    }
    assertEquals(await readFile(`${dir}/.git/config`, "utf8"), config);
    // A status may refresh the index; nothing sets its time back (`distrustIndex`).
    assert((await stat(`${dir}/.git/index`)).mtimeMs >= index);
    assert(!seen.flat().some((arg) => arg === "--add" || arg === "--unset-all"));
  } finally {
    await rm(dir, { recursive: true });
    await rm(subSrc, { recursive: true });
  }
});

for (const variant of ["its own .git", "a .git file"] as const) {
  test(`putBack (failed): a bare gitlink checked out at the start keeps its config and untracked work — ${variant}`, async () => {
    const { dir } = await twoCommitRepo();
    const outside = await mkdtemp(join(tmpdir(), "runner-checkout-vendor-git-"));
    try {
      // A nested repository committed as a gitlink `.gitmodules` does not name, checked out as a
      // warm image would hold it, with a driver of its own and work nobody committed.
      const vendor = `${dir}/vendor`;
      await mkdir(vendor);
      const init = variant === "a .git file" ? ["--separate-git-dir", `${outside}/git`] : [];
      await git(vendor, "init", "-q", "-b", "main", ...init);
      await writeFile(`${vendor}/v.txt`, "v\n");
      await git(vendor, "add", "-A");
      await commit(vendor, "vendor");
      await git(vendor, "config", "filter.lfs.clean", "git-lfs clean -- %f");
      await git(vendor, "config", "filter.lfs.required", "true");
      await git(dir, "add", "vendor");
      await commit(dir, "vendor as a bare gitlink");
      await writeFile(`${vendor}/untracked.txt`, "work\n");
      // The superproject reads no untracked file inside a submodule as a change.
      await git(dir, "config", "diff.ignoreSubmodules", "untracked");
      const start = await checkoutStart(git, dir);
      const vendorConfig = await filterKeys(vendor);

      // The failed step touches only the superproject.
      await git(dir, "config", "filter.evil.smudge", "cat");
      await git(dir, "config", "filter.evil.clean", "cat");
      await writeFile(`${dir}/base.txt`, "edited\n");

      assertEquals(await putBack(git, dir, start, FAILED), true);
      assertEquals(await filterKeys(dir), "");
      assertEquals(await filterKeys(vendor), vendorConfig);
      assertEquals(await readFile(`${vendor}/untracked.txt`, "utf8"), "work\n");
      assertEquals(await readFile(`${vendor}/v.txt`, "utf8"), "v\n");
      assertEquals(await readFile(`${dir}/base.txt`, "utf8"), "base\n");
      assertEquals(await departures(git, dir, start), []);
    } finally {
      await rm(dir, { recursive: true });
      await rm(outside, { recursive: true });
    }
  });
}

test("putBack (failed): a driver the step added goes, and an include at the top stays there, so the settings after it still win", async () => {
  const { dir } = await twoCommitRepo();
  try {
    await writeFile(
      `${dir}/.git/extra.cfg`,
      "[user]\n\tname = included\n[core]\n\tautocrlf = true\n",
    );
    const own = await readFile(`${dir}/.git/config`, "utf8");
    await writeFile(
      `${dir}/.git/config`,
      `[include]\n\tpath = extra.cfg\n${own}[user]\n\tname = local\n[core]\n\tautocrlf = input\n`,
    );
    const start = await checkoutStart(git, dir);
    await git(dir, "config", "filter.evil.smudge", "cat");
    await git(dir, "config", "filter.evil.clean", "cat");
    await writeFile(`${dir}/base.txt`, "edited\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(await filterKeys(dir), "");
    assert(
      (await readFile(`${dir}/.git/config`, "utf8")).startsWith("[include]\n\tpath = extra.cfg\n"),
    );
    assertEquals(await git(dir, "config", "user.name"), "local");
    assertEquals(await git(dir, "config", "core.autocrlf"), "input");
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack (failed): a key the repository's driver has with no value stays so, and put-back goes through", async () => {
  const { dir } = await twoCommitRepo();
  try {
    await commitRot13(dir);
    await git(dir, "config", "--unset", "filter.rot.required").catch(() => "");
    const config = await readFile(`${dir}/.git/config`, "utf8");
    await writeFile(
      `${dir}/.git/config`,
      config.replace('[filter "rot"]\n', '[filter "rot"]\n\trequired\n'),
    );
    const start = await checkoutStart(git, dir);
    await git(dir, "config", "filter.evil.smudge", "cat");
    await git(dir, "config", "filter.evil.clean", "cat");
    await writeFile(`${dir}/r.txt`, "garbage\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assert((await readFile(`${dir}/.git/config`, "utf8")).includes('[filter "rot"]\n\trequired\n'));
    assertEquals(await git(dir, "config", "--get-regexp", "^filter\\.evil\\.").catch(() => ""), "");
    assertEquals(await readFile(`${dir}/r.txt`, "utf8"), "hello\n");
    assertEquals(await departures(git, dir, start), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("putBack (failed): an include path the step changed comes back (at the end of the file, where git re-adds it)", async () => {
  const { dir } = await twoCommitRepo();
  const marks = await mkdtemp(join(tmpdir(), "runner-checkout-marker-"));
  try {
    await writeFile(`${dir}/.git/own.cfg`, "[user]\n\tname = own\n");
    await writeFile(
      `${dir}/.git/planted.cfg`,
      `[filter "planted"]\n\tsmudge = touch ${marks}/planted; cat\n\tclean = cat\n`,
    );
    await git(dir, "config", "include.path", "own.cfg");
    const start = await checkoutStart(git, dir);
    await git(dir, "config", "include.path", "planted.cfg");
    await writeFile(`${dir}/.gitattributes`, "*.txt filter=planted\n");
    await writeFile(`${dir}/base.txt`, "edited\n");

    assertEquals(await putBack(git, dir, start, FAILED), true);
    assertEquals(
      await git(dir, "config", "--file", `${dir}/.git/config`, "--get-all", "include.path"),
      "own.cfg",
    );
    assertEquals(await git(dir, "config", "user.name"), "own");
    assertEquals(await departures(git, dir, start), []);
    assertEquals(await readdir(marks), []);
  } finally {
    await rm(marks, { recursive: true });
    await rm(dir, { recursive: true });
  }
});
