// What a patch reports it carries (`BranchOutcome.carries`): the earlier heads of the clone whose
// own work it holds in full, by content. Memory follows a claim along those edges, from the patch
// it was made on to the one that landed it, so an edge must stand for work that really rides on:
// on real git against a throwaway origin, carried through a clean rebase, a fast-forward that
// left the head as it was, and a squash or reordering of its own commits; not carried once the
// agent dropped a commit of it, amended it, or resolved a conflict over its lines, nor by a
// look-alike that lacks the change, nor for work that came from the target; cumulative within a
// generation, every earlier head named.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { cloneState, defaultLine, type LineState, makeShipper } from "../src/core/patches.ts";
import type { PatchPayload, RepoEntry } from "../src/core/types.ts";
import type { PatchReport, PatchReporter } from "../src/ports/patch_reporter.ts";
import { cliGitTransport } from "../src/adapters/git/cli.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { git } from "../src/helpers/git_exec.ts";
import { carriesWork, createBranch, headSha } from "../src/helpers/checkout.ts";
import { makeThrowawayOrigin, type ThrowawayOrigin } from "./fixtures/origin.ts";
import { repoEntry } from "./util.ts";

const IDENTITY = ["-c", "user.name=ada", "-c", "user.email=ada@runner.local"];

interface World {
  origin: ThrowawayOrigin;
  clone: LineState;
  dir: string;
  reports: PatchReport[];
  shipper: ReturnType<typeof makeShipper>;
  cleanup(): Promise<void>;
}

async function world(files?: Record<string, string>): Promise<World> {
  const origin = await makeThrowawayOrigin({ files });
  const root = await mkdtemp(join(tmpdir(), "runner-carries-"));
  const transport = cliGitTransport(noopDiagnostics());
  const repo: RepoEntry = repoEntry({ url: origin.url });
  const checkout = await transport.clone(repo, `${root}/repo`);
  const dir = checkout.dir;
  await git(dir, "config", "user.name", "ada");
  await git(dir, "config", "user.email", "ada@runner.local");
  await createBranch(git, dir, `${repo.branchNamespace}/work`);
  const clone = defaultLine(cloneState(repo, checkout, await headSha(git, dir)));
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({ patchId: `p-${reports.length}`, state: "queued", url: null });
    },
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  const shipper = makeShipper({
    git: transport,
    gitExec: git,
    diag: noopDiagnostics(),
    patchReporter: reporter,
    runId: "wi-test",
    subject: () => "leftovers",
  });
  return {
    origin,
    clone,
    dir,
    reports,
    shipper,
    async cleanup() {
      await origin.cleanup();
      await rm(root, { recursive: true });
    },
  };
}

async function commitFile(dir: string, file: string, content: string, subject: string) {
  await writeFile(`${dir}/${file}`, content);
  await git(dir, "add", "-A");
  await git(dir, ...IDENTITY, "commit", "--quiet", "-m", subject);
}

async function submit(w: World): Promise<{ headSha: string; carries: string[] }> {
  const outcome = await w.shipper.submit(w.clone);
  assert(outcome.kind === "submitted", JSON.stringify(outcome));
  return { headSha: outcome.headSha, carries: w.reports.at(-1)!.branch.carries };
}

/** The forge squash-merging the run's branch as it stood at `head`, and main moving on with
 * `then` (a file and its content) when given. */
async function squashMerge(w: World, head: string, then?: [string, string]) {
  const work = await mkdtemp(join(tmpdir(), "runner-upstream-"));
  try {
    await git(work, "clone", "--quiet", "--", w.origin.url, ".");
    await git(work, "fetch", "--quiet", "origin", w.clone.branch);
    await git(work, "merge", "--squash", head);
    await git(work, ...IDENTITY, "commit", "--quiet", "-m", "Merge #7 (squashed)");
    if (then !== undefined) await commitFile(work, then[0], then[1], "main moves");
    await git(work, "push", "--quiet", "origin", "main");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** Someone else's commit landing on main. */
async function upstreamCommit(w: World, file: string, content: string) {
  const work = await mkdtemp(join(tmpdir(), "runner-upstream-"));
  try {
    await git(work, "clone", "--quiet", "--", w.origin.url, ".");
    await commitFile(work, file, content, "upstream moves");
    await git(work, "push", "--quiet", "origin", "main");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** The agent moving its branch onto what merged after the cue fetched it, as the cue says:
 * `git rebase --onto origin/main <landed>`. Answers whether it stopped on a conflict. */
async function rebaseOntoMain(w: World, landed: string): Promise<boolean> {
  return await git(w.dir, ...IDENTITY, "rebase", "--quiet", "--onto", "origin/main", landed)
    .then(() => false, () => true);
}

function merged(headSha: string, generation = 1): PatchPayload {
  return {
    kind: "patch",
    line: "work",
    patchId: "p-1",
    path: "repo",
    headSha,
    generation,
    state: "merged",
    landedHead: headSha,
    forgeUrl: "https://github.com/acme/app/pull/7",
    reason: null,
    onto: "main",
  };
}

test("a generation's patches are cumulative: each names every one before it, newest first", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    assertEquals(first.carries, []);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    assertEquals(second.carries, [first.headSha]);
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    await w.shipper.finalize(w.clone);
    assertEquals(w.reports.at(-1)!.branch.carries, [second.headSha, first.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("an empty commit made in a patch's name carries nothing of it", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    // The same author, date and message, with none of the change.
    await git(w.dir, "reset", "--quiet", "--hard", w.clone.baseSha);
    await git(w.dir, ...IDENTITY, "commit", "--quiet", "--allow-empty", "-C", first.headSha);
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const forged = await submit(w);
    assertEquals(forged.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("an amend that moved the change to other paths does not carry the patch it replaced", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    await submit(w);
    await git(w.dir, "rm", "--quiet", "a.txt");
    await writeFile(`${w.dir}/elsewhere.txt`, "something else\n");
    await git(w.dir, "add", "-A");
    await git(w.dir, ...IDENTITY, "commit", "--quiet", "--amend", "--no-edit");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const amended = await submit(w);
    assertEquals(amended.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("the agent squashing its own commits between submits still carries them, by content", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    await git(w.dir, "reset", "--quiet", "--soft", w.clone.baseSha);
    await git(w.dir, ...IDENTITY, "commit", "--quiet", "-m", "add a and b");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const squashed = await submit(w);
    assertEquals(squashed.carries, [second.headSha, first.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("a side branch of the agent's own work, merged in and then dropped, is not carried", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const own = await headSha(git, w.dir);
    await git(w.dir, "checkout", "--quiet", "-b", "side", w.clone.baseSha);
    await commitFile(w.dir, "s.txt", "s\n", "side work");
    await git(w.dir, "checkout", "--quiet", w.clone.branch);
    await git(w.dir, ...IDENTITY, "merge", "--quiet", "--no-ff", "--no-edit", "side");
    const first = await submit(w);
    // The merge, and the side work with it, thrown away; the main line kept.
    await git(w.dir, "reset", "--quiet", "--hard", own);
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const next = await submit(w);
    assertEquals(first.carries, []);
    assertEquals(next.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("what a merge of the target brought in is not the agent's work to carry", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const own = await headSha(git, w.dir);
    await upstreamCommit(w, "u.txt", "upstream\n");
    await git(w.dir, "fetch", "--quiet", "origin", "main");
    await git(w.dir, ...IDENTITY, "merge", "--quiet", "--no-ff", "--no-edit", "origin/main");
    const first = await submit(w);
    // The target merge dropped again: the agent's own commit is all still there.
    await git(w.dir, "reset", "--quiet", "--hard", own);
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const next = await submit(w);
    assertEquals(next.carries, [first.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("an amend carries nothing of the patch it replaced: the same author, date and message, more work", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    await submit(w);
    // Amended with a line more: the same author, date, message and paths.
    await writeFile(`${w.dir}/a.txt`, "a\nmore\n");
    await git(w.dir, "add", "-A");
    await git(w.dir, ...IDENTITY, "commit", "--quiet", "--amend", "--no-edit");
    // A plain origin refuses a rewritten branch the gateway takes as a new bundle.
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const amended = await submit(w);
    assertEquals(amended.carries, []);
    // Thrown away for something else entirely: neither is carried.
    await git(w.dir, "reset", "--quiet", "--hard", w.clone.baseSha);
    await commitFile(w.dir, "z.txt", "z\n", "something else");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const other = await submit(w);
    assertEquals(other.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("the agent reordering its own commits between submits still carries them, commit by commit", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const first = await submit(w);
    await git(w.dir, "reset", "--quiet", "--hard", w.clone.baseSha);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const next = await submit(w);
    assertEquals(next.carries, [first.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("commits alike in author, date and message carry nothing of each other", async () => {
  const w = await world();
  try {
    const at = ["--date=1700000000 +0000"];
    const fix = async (content: string) => {
      await writeFile(`${w.dir}/a.txt`, content);
      await git(w.dir, "add", "-A");
      await git(w.dir, ...IDENTITY, "commit", "--quiet", ...at, "-m", "fix");
    };
    // Two commits with one author, date, message and set of paths.
    await fix("one\n");
    await fix("two\n");
    const first = await submit(w);
    // Rewritten as one such commit, with a change neither of them made.
    await git(w.dir, "reset", "--quiet", "--hard", w.clone.baseSha);
    await fix("three\n");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const next = await submit(w);
    assertEquals(first.carries, []);
    assertEquals(next.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("a patch whose own work is a merge's resolution alone is carried by content, and not once dropped", async () => {
  const w = await world();
  try {
    await upstreamCommit(w, "u.txt", "upstream\n");
    await git(w.dir, "fetch", "--quiet", "origin", "main");
    // The target merged in, with an edit of the agent's staged into the merge commit itself.
    await git(w.dir, ...IDENTITY, "merge", "--quiet", "--no-ff", "--no-commit", "origin/main");
    await writeFile(`${w.dir}/e.txt`, "the agent's, in the merge\n");
    await git(w.dir, "add", "-A");
    await git(w.dir, ...IDENTITY, "commit", "--quiet", "--no-edit");
    const first = await submit(w);
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    const second = await submit(w);
    assertEquals(second.carries, [first.headSha]);
    // Thrown away for something else: the merge and what it held are gone.
    await git(w.dir, "reset", "--quiet", "--hard", w.clone.baseSha);
    await commitFile(w.dir, "z.txt", "z\n", "something else");
    await git(w.dir, "push", "--quiet", "origin", `:${w.clone.branch}`);
    const third = await submit(w);
    assertEquals(third.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("a patch the merge passed over is carried by the next generation's rebase, and the landed one is not", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    // The merge took the first revision only; the second rides the next generation.
    await squashMerge(w, first.headSha);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    assertEquals(await rebaseOntoMain(w, first.headSha), false);
    const next = await submit(w);
    assertEquals(w.clone.generation, 2);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["add b", "add c"]);
    assertEquals(next.carries, [second.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("a rebase whose conflict the agent resolved over the patch's own lines does not carry it", async () => {
  const w = await world({ "shared.txt": "base\n" });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "shared.txt", "ours\n", "ours");
    const second = await submit(w);
    await squashMerge(w, first.headSha, ["shared.txt", "theirs\n"]);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    assertEquals(await rebaseOntoMain(w, first.headSha), true);
    // Resolved: the patch now holds "both", not the "ours" the earlier patch shipped, so that
    // patch's change is not in it. A claim bound to it waits for that patch's own fate.
    await writeFile(`${w.dir}/shared.txt`, "both\n");
    await git(w.dir, "add", "shared.txt");
    await git(w.dir, ...IDENTITY, "-c", "core.editor=true", "rebase", "--continue");
    const next = await submit(w);
    assertEquals(w.clone.generation, 2);
    assert(next.headSha !== second.headSha);
    assertEquals(next.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("a rebase that resolved nothing of the patch's own carries it, though its commits moved", async () => {
  const w = await world({ "shared.txt": "base\n" });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    // Main moves on beside it: the rebase is clean, every commit gets a new id.
    await squashMerge(w, first.headSha, ["shared.txt", "theirs\n"]);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    assertEquals(await rebaseOntoMain(w, first.headSha), false);
    const next = await submit(w);
    assertEquals(w.clone.generation, 2);
    assertEquals(next.carries, [second.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("a merge that fast-forwarded to an earlier head: the next generation's head is the passed-over one, and carries it", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    // main fast-forwards to the first head: the second's commit sits on the merged tip as is.
    await git(w.origin.url, "update-ref", "refs/heads/main", first.headSha);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    const next = await w.shipper.submit(w.clone);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals(w.clone.generation, 2);
    assertEquals(next.headSha, second.headSha);
    assertEquals(w.reports.at(-1)!.branch.carries, [second.headSha]);
  } finally {
    await w.cleanup();
  }
});

test("a rebase the agent dropped a commit from carries nothing of that patch", async () => {
  const w = await world({ "shared.txt": "base\n" });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    await commitFile(w.dir, "shared.txt", "ours\n", "ours");
    const second = await submit(w);
    assertEquals(second.carries, [first.headSha]);
    await squashMerge(w, first.headSha, ["shared.txt", "theirs\n"]);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    assertEquals(await rebaseOntoMain(w, first.headSha), true);
    // The agent skips the conflicting commit: `add b` moves, `ours` never does.
    await git(w.dir, ...IDENTITY, "rebase", "--skip");
    await commitFile(w.dir, "c.txt", "c\n", "add c");
    const next = await submit(w);
    assertEquals(w.clone.generation, 2);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["add b", "add c"]);
    assertEquals(next.carries, []);
  } finally {
    await w.cleanup();
  }
});

test("a patch the merge passed over is not carried by a rebase that dropped its undo of landed work", async () => {
  const lines = (...ls: string[]) => ls.join("\n") + "\n";
  const w = await world({ "f.txt": lines("1", "2", "3", "4", "5", "6", "7", "8") });
  try {
    await commitFile(w.dir, "f.txt", lines("1", "feature", "3", "4", "5", "6", "debug", "8"), "f");
    const first = await submit(w);
    // The second patch drops the debug line again; the merge takes the first one only, and
    // main moves on next to that line.
    await commitFile(w.dir, "f.txt", lines("1", "feature", "3", "4", "5", "6", "7", "8"), "undo");
    const second = await submit(w);
    await squashMerge(w, first.headSha, [
      "f.txt",
      lines("1", "feature", "3", "4", "5", "6", "debug", "eight"),
    ]);
    await w.shipper.onPatchCue([w.clone.owner], merged(first.headSha));
    assertEquals(await rebaseOntoMain(w, first.headSha), true);
    // The agent skips the undo and does other work: the debug line is still there.
    await git(w.dir, ...IDENTITY, "rebase", "--skip");
    await commitFile(w.dir, "g.txt", "g\n", "other work");
    const next = await submit(w);
    assertEquals(w.clone.generation, 2);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["other work"]);
    // From the base, the second patch's net change (the feature) is in the next one; past what
    // landed, it is the undo, which is not.
    assertEquals(next.carries, []);
    // Nor by the helper itself, asked directly.
    assertEquals(
      await carriesWork(
        git,
        w.dir,
        { head: second.headSha, past: [w.reports[0].baseSha, first.headSha] },
        { head: next.headSha, base: w.reports.at(-1)!.baseSha },
      ),
      false,
    );
  } finally {
    await w.cleanup();
  }
});

test("a git that cannot answer a carry is warned about, never read in silence", async () => {
  const w = await world();
  try {
    await commitFile(w.dir, "a.txt", "a\n", "add a");
    const first = await submit(w);
    await commitFile(w.dir, "b.txt", "b\n", "add b");
    const second = await submit(w);
    // A git older than 2.40 has no `merge-tree --merge-base`: a usage error, exit 129.
    const old: typeof git = (cwd, ...args) =>
      args[0] === "merge-tree"
        ? Promise.reject(new Error(`git ${args.join(" ")} failed (exit 129): unknown option`))
        : git(cwd, ...args);
    const warned: string[] = [];
    const diag = { warn: (event: string) => warned.push(event) };
    // A patch on the base alone, rewritten: no history in common with the second past the base.
    await git(w.dir, "checkout", "--quiet", "-b", "rewrite", w.reports[0].baseSha);
    await commitFile(w.dir, "b.txt", "b\n", "add b again");
    const rewrite = await git(w.dir, "rev-parse", "HEAD");
    assertEquals(
      await carriesWork(
        old,
        w.dir,
        { head: second.headSha, past: [w.reports[0].baseSha] },
        { head: rewrite, base: w.reports[0].baseSha },
        [],
        diag,
      ),
      false,
    );
    assert(warned.length > 0 && warned.every((e) => e === "git.merge_tree_unanswered"));
    // A conflict is an answer: nothing to warn about.
    warned.length = 0;
    await commitFile(w.dir, "a.txt", "not a\n", "another a");
    assertEquals(
      await carriesWork(
        git,
        w.dir,
        { head: first.headSha, past: [w.reports[0].baseSha] },
        { head: await git(w.dir, "rev-parse", "HEAD"), base: w.reports[0].baseSha },
        [],
        diag,
      ),
      false,
    );
    assertEquals(warned, []);
  } finally {
    await w.cleanup();
  }
});
