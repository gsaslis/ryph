// Several lines in one repo (@ryph/shared/lines, core/patches.ts), on real git against a throwaway
// origin: two branches ship as two branches under the run's namespace, each its own patch; a
// merge of one line lands that line alone; and a submit is refused for a branch that would
// ship as a line another branch already does, for a ninth line, for a branch stacked on another
// line's commits — none of which spends a slot — and for a branch git would not name one, which
// never reaches git as an option. Finalize withholds a line on another line's head, and ships a
// landed line the checkout is not on as its next generation, moving nothing. A line that caught up with its target
// after another line merged there is no stack; a line whose branch the agent deleted or renamed
// fails nothing at finalize, and a rename is refused under its new name. A new line targets where
// the default line's merge moved the repo, and on a detached HEAD a check or a catch-up acts on
// the default line. End to end, finalize ships the default line and the lines a submit shipped,
// never a branch nobody submitted, and an empty branch name is the checked-out branch.

import { test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  lineAtHead,
  type LineState,
  resolveLine,
  unsubmittedBranches,
  unsubmittedList,
} from "../src/core/patches.ts";
import { run } from "../src/core/run.ts";
import type { PatchReport, PatchReporter } from "../src/ports/patch_reporter.ts";
import type { RunActions, RunChecksOutcome, SubmitPatchOutcome } from "../src/ports/run_actions.ts";
import type { ChecksChannel } from "../src/ports/checks.ts";
import { localBranchExists } from "../src/helpers/checkout.ts";
import { type Git, git } from "../src/helpers/git_exec.ts";
import { commitFile, merged, shipFirst, upstream, type World, world } from "./fixtures/landing.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

/** The line a branch resolves to, asserted to be one the clone does not hold yet. */
async function newLine(w: World, branch?: string): Promise<LineState> {
  const resolved = await resolveLine(git, w.clone.owner, branch);
  assert("line" in resolved, JSON.stringify("refused" in resolved ? resolved.refused : ""));
  assertEquals(resolved.created, true);
  return resolved.line;
}

/** A branch off the base with one commit of its own, checked out. */
async function branchOffBase(w: World, name: string, file: string) {
  await git(w.dir, "switch", "--quiet", "-c", name, "origin/main");
  await commitFile(w.dir, file, `${name}\n`, `${name}: ${file}`);
}

test("lines: two branches of one repo ship as two branches, each its own patch", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    const work = await w.shipper.submit(w.clone);
    assert(work.kind === "submitted", JSON.stringify(work));
    assertEquals(work.branch, `${ns}/work`);

    await branchOffBase(w, "Fix_Login", "f.txt");
    const fixLine = await newLine(w);
    assertEquals(fixLine.line, "fix-login");
    const fix = await w.shipper.submit(fixLine);
    assert(fix.kind === "submitted", JSON.stringify(fix));
    assertEquals(fix.branch, `${ns}/fix-login`);

    // Both at the origin under the namespace, each with its own commits only.
    const fixHead = await git(w.dir, "rev-parse", "refs/heads/Fix_Login");
    assertEquals(await git(w.origin.url, "rev-parse", `refs/heads/${ns}/fix-login`), fixHead);
    assertEquals(await git(w.origin.url, "rev-parse", `refs/heads/${ns}/work`), work.headSha);
    assertEquals(w.reports.map((r) => [r.branch.line, r.branch.name]), [
      ["work", `${ns}/work`],
      ["fix-login", `${ns}/fix-login`],
    ]);
    assertEquals(w.reports[1].branch.commits.map((c) => c.subject), ["Fix_Login: f.txt"]);
    assertEquals(w.reports[1].baseSha, await git(w.dir, "rev-parse", "origin/main"));
    assertEquals(w.shipper.shipped().map((b) => b.line), ["work", "fix-login"]);
    assertEquals([...w.clone.owner.lines.keys()], ["work", "fix-login"]);
    // The agent's branch keeps its name, and the ref made to ship it is gone again.
    assertEquals(fixLine.branch, "Fix_Login");
    assertEquals(await git(w.dir, "branch", "--list", `${ns}/fix-login`), "");
    // Submitting the same branch again finds the line it already is.
    const again = await resolveLine(git, w.clone.owner, "Fix_Login");
    assert("line" in again && again.line === fixLine && !again.created);
  } finally {
    await w.cleanup();
  }
});

test("lines: a merge of one line lands that line alone", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    const work = await w.shipper.submit(w.clone);
    assert(work.kind === "submitted");
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    const fix = await w.shipper.submit(fixLine);
    assert(fix.kind === "submitted");

    // The fix's change request merges (squashed) and its branch goes.
    await upstream(w.origin.url, async (up) => {
      await git(up, "merge", "--squash", `origin/${ns}/fix`);
      await git(up, "commit", "--quiet", "-m", "Merge fix (squashed)");
      await git(up, "push", "--quiet", "origin", "main", `:${ns}/fix`);
    });
    // A cue for a line the clone does not hold changes nothing.
    await w.shipper.onPatchCue([w.clone.owner], { ...merged(work.headSha, "main"), line: "nope" });
    assertEquals(w.clone.landedHead, null);
    await w.shipper.onPatchCue([w.clone.owner], {
      ...merged(fix.headSha, "main"),
      line: "fix",
      patchId: "p-2",
    });
    assertEquals(fixLine.landedHead, fix.headSha);
    assertEquals(w.clone.landedHead, null, "the work line heard nothing");

    // Not on what merged yet: refused, wherever the checkout is, with the rebase to run.
    await git(w.dir, "switch", "--quiet", "fix");
    await commitFile(w.dir, "g.txt", "g\n", "fix: g");
    await git(w.dir, "switch", "--quiet", `${ns}/work`);
    const away = await w.shipper.submit(fixLine);
    assert(away.kind === "refused", JSON.stringify(away));
    assertStringIncludes(away.reason, `git rebase --onto origin/main ${fix.headSha.slice(0, 12)}`);
    assertEquals(fixLine.generation, 1);

    await git(w.dir, "switch", "--quiet", "fix");
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", fix.headSha);
    const next = await w.shipper.submit(fixLine);
    assert(next.kind === "submitted", JSON.stringify(next));
    assertEquals([next.branch, next.generation], [`${ns}/fix-2`, 2]);
    assertEquals(fixLine.branch, "fix", "the agent's branch is never renamed");
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["fix: g"]);

    // The work line is where it was: its own generation, its own branch.
    await git(w.dir, "switch", "--quiet", `${ns}/work`);
    await commitFile(w.dir, "b.txt", "b\n", "work b");
    const more = await w.shipper.submit(w.clone);
    assert(more.kind === "submitted", JSON.stringify(more));
    assertEquals([more.branch, more.generation], [`${ns}/work`, 1]);
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["work a", "work b"]);
  } finally {
    await w.cleanup();
  }
});

test("lines: two branches that would ship as one line are refused, naming both", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    await branchOffBase(w, "Fix_It", "f.txt");
    const first = await w.shipper.submit(await newLine(w));
    assert(first.kind === "submitted", JSON.stringify(first));
    await branchOffBase(w, "fix-it", "g.txt");
    const second = await resolveLine(git, w.clone.owner);
    assert("refused" in second, JSON.stringify(second));
    assertStringIncludes(second.refused, "`fix-it` and `Fix_It` would both ship");
    // The shipped line's branch deleted: the name is still that line's, and the refusal says so
    // rather than asking to rename a branch that is gone.
    await git(w.dir, "branch", "--quiet", "-D", "Fix_It");
    const gone = await resolveLine(git, w.clone.owner);
    assert("refused" in gone, JSON.stringify(gone));
    assertStringIncludes(
      gone.refused,
      "already shipped from `Fix_It`, which has since been deleted",
    );
    await git(w.dir, "branch", "--quiet", "Fix_It", first.headSha);
    // Nor can a branch under the run's own namespace stand beside one that maps to it.
    await git(w.dir, "branch", "--", `${w.clone.repo.branchNamespace}/other`, "HEAD");
    await git(w.dir, "branch", "--", "other", "HEAD");
    const beside = await resolveLine(git, w.clone.owner, "other");
    assert("refused" in beside, JSON.stringify(beside));
    assertStringIncludes(beside.refused, "would both ship");
  } finally {
    await w.cleanup();
  }
});

test("lines: a ninth line is refused, and a refused submit spends no slot", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    // The default line never shipped, so it takes no slot: eight others ship, as the control
    // plane counts them.
    for (let i = 1; i <= 8; i++) {
      await branchOffBase(w, `l${String.fromCharCode(96 + i)}`, `${i}.txt`);
      const shipped = await w.shipper.submit(await newLine(w));
      assert(shipped.kind === "submitted", JSON.stringify(shipped));
    }
    assertEquals(w.clone.owner.lines.size, 9);
    await branchOffBase(w, "ninth", "9.txt");
    const ninth = await w.shipper.submit(await newLine(w));
    assert(ninth.kind === "refused", JSON.stringify(ninth));
    assertStringIncludes(ninth.reason, "already ships 8 branches");
    assertEquals(w.clone.owner.lines.size, 9);
    // Nor does the default line ship as a ninth once it has work.
    await git(w.dir, "switch", "--quiet", w.clone.branch);
    await commitFile(w.dir, "w.txt", "w\n", "work w");
    const work = await w.shipper.submit(w.clone);
    assert(work.kind === "refused", JSON.stringify(work));
    assertStringIncludes(work.reason, "already ships 8 branches");
    assertEquals(w.reports.length, 8);
  } finally {
    await w.cleanup();
  }
});

test("lines: branches committed to but never submitted are named, and nothing else is", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    assert((await w.shipper.submit(w.clone)).kind === "submitted");
    await branchOffBase(w, "fix", "f.txt");
    assert((await w.shipper.submit(await newLine(w))).kind === "submitted");
    // Left behind: one off the base, one stacked on a submitted line (its own commit only).
    await branchOffBase(w, "at-finish", "finish.txt");
    await git(w.dir, "switch", "--quiet", "-c", "stacked", "fix");
    await commitFile(w.dir, "s.txt", "s\n", "stacked s");
    // Not left behind: a branch read from the remote, and one holding only a line's commits.
    await git(w.dir, "switch", "--quiet", "-c", "reading", "origin/main");
    await git(w.dir, "branch", "--quiet", "fix-copy", "fix");

    const left = await unsubmittedBranches(git, w.clone.owner);
    assertEquals(left, [{ branch: "at-finish", commits: 1 }, { branch: "stacked", commits: 1 }]);
    assertEquals(unsubmittedList(left), "`at-finish` (1 commit), `stacked` (1 commit)");
  } finally {
    await w.cleanup();
  }
});

test("lines: a branch stacked on another line's commits is refused, and leaves no line", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    const work = await w.shipper.submit(w.clone);
    assert(work.kind === "submitted");
    // Started from the work line, not the base.
    await git(w.dir, "switch", "--quiet", "-c", "stacked");
    await commitFile(w.dir, "s.txt", "s\n", "stacked s");
    const stacked = await w.shipper.submit(await newLine(w));
    assert(stacked.kind === "refused", JSON.stringify(stacked));
    assertStringIncludes(stacked.reason, "stacked on each other are not supported yet");
    assertStringIncludes(stacked.reason, "git switch -c <name> origin/main");
    assertEquals([...w.clone.owner.lines.keys()], ["work"]);
    assertEquals(w.reports.length, 1);
    // Moved onto the base, it ships.
    await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", w.clone.branch, "stacked");
    const moved = await w.shipper.submit(await newLine(w));
    assert(moved.kind === "submitted", JSON.stringify(moved));
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["stacked s"]);
  } finally {
    await w.cleanup();
  }
});

test("lines: checks on a new branch upload it as its line, and leave no line behind", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await branchOffBase(w, "fix", "f.txt");
    const candidate = await w.shipper.pushCandidate(await newLine(w));
    assert("headSha" in candidate, JSON.stringify(candidate));
    assertEquals(candidate.branch, `${ns}/fix`);
    assertEquals(
      await git(w.origin.url, "rev-parse", `refs/heads/${ns}/fix`),
      await git(w.dir, "rev-parse", "refs/heads/fix"),
    );
    assertEquals([...w.clone.owner.lines.keys()], ["work"]);
    assertEquals(await git(w.dir, "branch", "--list", `${ns}/fix`), "");
    // A detached checkout names no branch to act on.
    await git(w.dir, "switch", "--quiet", "--detach");
    const detached = await resolveLine(git, w.clone.owner);
    assert("refused" in detached);
    assertStringIncludes(detached.refused, "HEAD is detached");
  } finally {
    await w.cleanup();
  }
});

/** `git`, with every argument list it was handed. */
function recordingGit(): { exec: Git; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (cwd, ...args) => {
      calls.push(args);
      return git(cwd, ...args);
    },
  };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

test("lines: a branch git would not name one is refused, and never reaches git", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    // Refs made by hand: `git branch` refuses these names, `update-ref` does not.
    for (const name of ["--strategy=x", "-x"]) {
      await git(w.dir, "update-ref", `refs/heads/${name}`, "HEAD");
    }
    const { exec, calls } = recordingGit();
    for (const name of ["--strategy=x", "-x"]) {
      const named = await resolveLine(exec, w.clone.owner, name);
      assert("refused" in named, JSON.stringify(named));
      assertStringIncludes(named.refused, "is not a name git accepts for a branch");
      assertEquals(await localBranchExists(exec, w.dir, name), false);
    }
    // Nor when HEAD is on it, unnamed.
    await git(w.dir, "symbolic-ref", "HEAD", "refs/heads/--strategy=x");
    const onIt = await resolveLine(exec, w.clone.owner);
    assert("refused" in onIt, JSON.stringify(onIt));
    assertStringIncludes(onIt.refused, "`--strategy=x` is not a name git accepts");
    for (const name of ["--strategy=x", "-x"]) {
      assertEquals(calls.find((args) => args.includes(name)), undefined, name);
    }
    assertEquals([...w.clone.owner.lines.keys()], ["work"]);
  } finally {
    await w.cleanup();
  }
});

test("lines: finalize withholds a line on another line's head, and ships the rest", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    const fix = await w.shipper.submit(fixLine);
    assert(fix.kind === "submitted", JSON.stringify(fix));
    // The default line fast-forwarded onto the fix: the same head, which the control plane
    // would refuse as the fix's twin at birth.
    await git(w.dir, "switch", "--quiet", `${ns}/work`);
    await git(w.dir, "merge", "--quiet", "--ff-only", "fix");
    const same = await w.shipper.finalize(w.clone);
    assertEquals(same.kind, "nothing-to-submit", JSON.stringify(same));
    assertStringIncludes(same.withheld ?? "", "is the same commit as `fix`'s");
    // Built on it, it holds the fix's head: withheld too.
    await commitFile(w.dir, "w.txt", "w\n", "work w");
    const holds = await w.shipper.finalize(w.clone);
    assertEquals(holds.kind, "nothing-to-submit", JSON.stringify(holds));
    assertStringIncludes(holds.withheld ?? "", "holds `fix`'s");
    assertEquals(w.reports.length, 1);
    assertEquals(w.shipper.shipped().map((b) => b.line), ["fix"]);
    // A line that only shares the base with another ships as ever.
    await git(w.dir, "reset", "--quiet", "--hard", "origin/main");
    await commitFile(w.dir, "w.txt", "w\n", "work w");
    const own = await w.shipper.finalize(w.clone);
    assert(own.kind === "submitted", JSON.stringify(own));
    assertEquals(own.withheld, undefined);
  } finally {
    await w.cleanup();
  }
});

test("lines: finalize ships same-head lines once, whichever comes first", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    // Shipped once mid-run, so finalize holds it; then both branches end on one new head.
    assert((await w.shipper.submit(fixLine)).kind === "submitted");
    await commitFile(w.dir, "g.txt", "g\n", "fix g");
    await git(w.dir, "branch", "--force", `${ns}/work`, "fix");
    const first = await w.shipper.finalize(fixLine);
    assert(first.kind === "submitted", JSON.stringify(first));
    const second = await w.shipper.finalize(w.clone);
    assertEquals(second.kind, "nothing-to-submit", JSON.stringify(second));
    assertStringIncludes(second.withheld ?? "", "is the same commit as `fix`'s");
  } finally {
    await w.cleanup();
  }
});

test("lines: finalize withholds a line that merged another line in, whichever comes first", async () => {
  for (const fixFirst of [false, true]) {
    const w = await world({ onChangeRequest: false });
    const ns = w.clone.repo.branchNamespace;
    try {
      // The fix ships off the base; the default line then commits c1, which the fix merges in
      // without submitting again; the default line goes on to c2.
      await branchOffBase(w, "fix", "f.txt");
      const fixLine = await newLine(w);
      assert((await w.shipper.submit(fixLine)).kind === "submitted");
      await git(w.dir, "switch", "--quiet", `${ns}/work`);
      await commitFile(w.dir, "c1.txt", "c1\n", "work c1");
      await git(w.dir, "switch", "--quiet", "fix");
      await git(w.dir, "merge", "--quiet", "--no-edit", `${ns}/work`);
      await git(w.dir, "switch", "--quiet", `${ns}/work`);
      await commitFile(w.dir, "c2.txt", "c2\n", "work c2");

      const fixAt = async () => {
        const out = await w.shipper.finalize(fixLine);
        assertEquals(out.kind, "nothing-to-submit", `fixFirst=${fixFirst} ${JSON.stringify(out)}`);
        assertStringIncludes(out.withheld ?? "", `holds commits of \`${ns}/work\``);
      };
      if (fixFirst) await fixAt();
      const work = await w.shipper.finalize(w.clone);
      assert(work.kind === "submitted", JSON.stringify(work));
      if (!fixFirst) await fixAt();
      // c1 is up for review once, on the default line's change request.
      const reviewed = w.reports.flatMap((r) => r.branch.commits.map((c) => c.subject));
      assertEquals(reviewed.filter((s) => s === "work c1").length, 1);
    } finally {
      await w.cleanup();
    }
  }
});

/** A world whose `fix` line shipped and merged (squashed, its branch deleted), with a commit of
 * its own past what merged, and the checkout back on the default line. */
async function mergedFixLine(w: World): Promise<LineState> {
  const ns = w.clone.repo.branchNamespace;
  await commitFile(w.dir, "a.txt", "a\n", "work a");
  assert((await w.shipper.submit(w.clone)).kind === "submitted");
  await branchOffBase(w, "fix", "f.txt");
  const fixLine = await newLine(w);
  const fix = await w.shipper.submit(fixLine);
  assert(fix.kind === "submitted", JSON.stringify(fix));
  await upstream(w.origin.url, async (up) => {
    await git(up, "merge", "--squash", `origin/${ns}/fix`);
    await git(up, "commit", "--quiet", "-m", "Merge fix (squashed)");
    await git(up, "push", "--quiet", "origin", "main", `:${ns}/fix`);
  });
  await w.shipper.onPatchCue([w.clone.owner], {
    ...merged(fix.headSha, "main"),
    line: "fix",
    patchId: "p-2",
  });
  assertEquals(fixLine.landedHead, fix.headSha);
  return fixLine;
}

/** Leaves a merge stopped on the default line, conflicted in `c.txt`. */
async function stoppedMergeOnWork(w: World): Promise<void> {
  const ns = w.clone.repo.branchNamespace;
  await git(w.dir, "switch", "--quiet", "-c", "theirs", "origin/main");
  await commitFile(w.dir, "c.txt", "theirs\n", "theirs c");
  await git(w.dir, "switch", "--quiet", `${ns}/work`);
  await commitFile(w.dir, "c.txt", "ours\n", "ours c");
  await git(w.dir, "merge", "--quiet", "theirs").catch(() => {});
  assert(await exists(`${w.dir}/.git/MERGE_HEAD`));
}

test("lines: finalize ships a landed line the checkout is not on as its next generation, moving nothing", async () => {
  for (const rebased of [true, false]) {
    const w = await world({ onChangeRequest: false });
    const ns = w.clone.repo.branchNamespace;
    try {
      const fixLine = await mergedFixLine(w);
      const landed = fixLine.landedHead!;
      await git(w.dir, "switch", "--quiet", "fix");
      await commitFile(w.dir, "g.txt", "g\n", "fix g");
      if (rebased) await git(w.dir, "rebase", "--quiet", "--onto", "origin/main", landed);
      const fixHead = await git(w.dir, "rev-parse", "refs/heads/fix");
      await stoppedMergeOnWork(w);
      const before = await git(w.dir, "status", "--porcelain");

      const shipped = await w.shipper.finalize(fixLine);
      assert(shipped.kind === "submitted", JSON.stringify(shipped));
      assertEquals([shipped.branch, shipped.generation, shipped.headSha], [
        `${ns}/fix-2`,
        2,
        fixHead,
      ]);
      assertEquals(w.reports.at(-1)!.requiresApproval, true);
      assertEquals(fixLine.unrebased, rebased ? null : { onto: "main" });
      if (rebased) {
        assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["fix g"]);
      }
      // The checkout is as the agent left it: on its line, the merge stopped, nothing moved.
      assertEquals(await git(w.dir, "rev-parse", "refs/heads/fix"), fixHead);
      assertEquals(await git(w.dir, "symbolic-ref", "HEAD"), `refs/heads/${ns}/work`);
      assert(await exists(`${w.dir}/.git/MERGE_HEAD`));
      assertEquals(await git(w.dir, "status", "--porcelain"), before);
    } finally {
      await w.cleanup();
    }
  }
});

function recordingReporter() {
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({ patchId: `p-${reports.length}`, state: "queued", url: null });
    },
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  return { reporter, reports };
}

test("e2e: finalize ships the default line and every submitted line, never other branches", async () => {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  const { reporter, reports } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const ns = fx.item.repos[0].branchNamespace;
  const submits: SubmitPatchOutcome[] = [];
  const commit = async (dir: string, file: string, subject: string) => {
    await writeFile(`${dir}/${file}`, `${subject}\n`);
    await git(dir, "add", "-A");
    await git(
      dir,
      "-c",
      "user.name=ada",
      "-c",
      "user.email=ada@runner.local",
      "commit",
      "-m",
      subject,
    );
  };
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await commit(dir, "w.txt", "work w");
      await git(dir, "switch", "--quiet", "-c", "fix", "origin/main");
      await commit(dir, "f.txt", "fix f");
      submits.push(await actions!.submitPatch({}));
      await commit(dir, "g.txt", "fix g");
      // Never submitted: it stays in the box.
      await git(dir, "switch", "--quiet", "-c", "scratch", "origin/main");
      await commit(dir, "s.txt", "scratch s");
      // Back on the work line, with leftovers to commit.
      await git(dir, "switch", "--quiet", `${ns}/work`);
      await writeFile(`${dir}/left.txt`, "left\n");
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(submits.map((s) => s.kind), ["submitted"]);
    assertEquals(result.status, "success", JSON.stringify(result));
    assert("branches" in result);
    assertEquals(
      result.branches.map((b) => [b.line, b.name, b.commits.map((c) => c.subject)]),
      [
        ["fix", `${ns}/fix`, ["fix f", "fix g"]],
        ["work", `${ns}/work`, ["work w", "test: echo the task"]],
      ],
    );
    // Finalize's two, each held for approval; the scratch branch is nowhere.
    assertEquals(
      reports.map((r) => [r.branch.line, r.requiresApproval ?? false]),
      [["fix", false], ["work", true], ["fix", true]],
    );
    assertEquals(
      await git(fx.originUrl, "for-each-ref", "--format=%(refname:short)", `refs/heads/${ns}/`),
      [`${ns}/fix`, `${ns}/work`].join("\n"),
    );
  } finally {
    await fx.cleanup();
  }
});

test("lines: a line that caught up after another line merged is not stacked on it", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await branchOffBase(w, "fix", "f.txt");
    const fix = await w.shipper.submit(await newLine(w));
    assert(fix.kind === "submitted", JSON.stringify(fix));
    await branchOffBase(w, "feat", "g.txt");
    const featLine = await newLine(w);
    assert((await w.shipper.submit(featLine)).kind === "submitted");
    // The fix's pull request merges with a merge commit; no cue has come yet.
    await upstream(w.origin.url, async (up) => {
      await git(up, "fetch", "--quiet", "origin", `${ns}/fix`);
      await git(up, "merge", "--quiet", "--no-ff", "-m", "Merge fix", "FETCH_HEAD");
      await git(up, "push", "--quiet", "origin", "main");
    });
    // Catching up merges main, and with it the fix's commit through its second parent.
    const caught = await w.shipper.update(featLine);
    assertEquals(caught.kind, "merged", JSON.stringify(caught));
    assert(await git(w.dir, "merge-base", "--is-ancestor", fix.headSha, "feat").then(() => true));
    await commitFile(w.dir, "h.txt", "h\n", "feat h");
    const again = await w.shipper.submit(featLine);
    assert(again.kind === "submitted", JSON.stringify(again));
    await commitFile(w.dir, "i.txt", "i\n", "feat i");
    const last = await w.shipper.finalize(featLine);
    assert(last.kind === "submitted", JSON.stringify(last));
    assertEquals(last.withheld, undefined);
  } finally {
    await w.cleanup();
  }
});

test("lines: a shipped line whose branch is gone ships nothing more, and fails nothing", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    assert((await w.shipper.submit(fixLine)).kind === "submitted");
    await git(w.dir, "switch", "--quiet", `${ns}/work`);
    await git(w.dir, "branch", "-D", "fix");
    const out = await w.shipper.finalize(fixLine);
    assertEquals(out, { kind: "nothing-to-submit", path: "repo", gone: { shipped: true } });
    assertEquals(w.reports.length, 1);
  } finally {
    await w.cleanup();
  }
});

test("lines: a renamed line is refused under its new name, and is the line again under its own", async () => {
  const w = await world({ onChangeRequest: false });
  try {
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    assert((await w.shipper.submit(fixLine)).kind === "submitted");
    await git(w.dir, "branch", "-m", "fix", "fix-auth");
    await commitFile(w.dir, "g.txt", "g\n", "fix g");
    const renamed = await resolveLine(git, w.clone.owner);
    assert("refused" in renamed, JSON.stringify(renamed));
    assertStringIncludes(renamed.refused, "`fix-auth` continues `fix`");
    assertStringIncludes(renamed.refused, "`git branch -m fix-auth fix`");
    assertEquals([...w.clone.owner.lines.keys()], ["work", "fix"]);
    // The line's branch gone at finalize: its patch stands.
    assertEquals((await w.shipper.finalize(fixLine)).gone, { shipped: true });
    // Back under its own name, it is the line, and ships its new commit.
    await git(w.dir, "branch", "-m", "fix-auth", "fix");
    const back = await resolveLine(git, w.clone.owner);
    assert("line" in back && back.line === fixLine && !back.created);
    const shipped = await w.shipper.submit(fixLine);
    assert(shipped.kind === "submitted", JSON.stringify(shipped));
    assertEquals(w.reports.at(-1)!.branch.commits.map((c) => c.subject), ["fix: f.txt", "fix g"]);
    // A branch started from the target after the line merged holds its heads, and is no rename.
    await upstream(w.origin.url, async (up) => {
      await git(up, "fetch", "--quiet", "origin", `${w.clone.repo.branchNamespace}/fix`);
      await git(up, "merge", "--quiet", "--ff-only", "FETCH_HEAD");
      await git(up, "push", "--quiet", "origin", "main");
    });
    await git(w.dir, "fetch", "--quiet", "origin", "main");
    await git(w.dir, "switch", "--quiet", "-c", "later", "origin/main");
    await git(w.dir, "branch", "-D", "fix");
    const later = await resolveLine(git, w.clone.owner);
    assert("line" in later && later.created, JSON.stringify(later));
  } finally {
    await w.cleanup();
  }
});

test("lines: a new line targets where the default line's merge moved the repo", async () => {
  const w = await world();
  try {
    const head = await shipFirst(w);
    await upstream(w.origin.url, async (work) => {
      await git(work, "push", "--quiet", "origin", "origin/main:refs/heads/release");
    });
    await w.shipper.onPatchCue([w.clone.owner], merged(head, "release"));
    assertEquals(w.clone.repo.targetRef, "main");
    await branchOffBase(w, "fix", "f.txt");
    const fixLine = await newLine(w);
    assertEquals([fixLine.repo.ref, fixLine.repo.targetRef], ["release", undefined]);
  } finally {
    await w.cleanup();
  }
});

test("lines: on a detached HEAD a check or a catch-up acts on the default line", async () => {
  const w = await world({ onChangeRequest: false });
  const ns = w.clone.repo.branchNamespace;
  try {
    await commitFile(w.dir, "a.txt", "a\n", "work a");
    const tip = await git(w.dir, "rev-parse", "HEAD");
    await git(w.dir, "switch", "--quiet", "--detach", "HEAD");
    await commitFile(w.dir, "d.txt", "d\n", "detached d");
    // A submit has nothing to ship from here; a check uploads the default line's tip.
    assert("refused" in await resolveLine(git, w.clone.owner));
    const at = await lineAtHead(git, w.clone.owner);
    assert("line" in at && at.line === w.clone, JSON.stringify(at));
    const candidate = await w.shipper.pushCandidate(at.line);
    assert("headSha" in candidate, JSON.stringify(candidate));
    assertEquals([candidate.headSha, candidate.branch], [tip, `${ns}/work`]);
    const caught = await w.shipper.update(at.line);
    assert(caught.kind === "refused", JSON.stringify(caught));
    assertStringIncludes(caught.reason, "HEAD is detached");
  } finally {
    await w.cleanup();
  }
});

test("e2e: an empty branch name is the checked-out branch, and a deleted line's branch fails nothing", async () => {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  const { reporter } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const ns = fx.item.repos[0].branchNamespace;
  const submits: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await git(dir, "switch", "--quiet", "-c", "fix", "origin/main");
      await writeFile(`${dir}/f.txt`, "f\n");
      await git(dir, "add", "-A");
      await git(
        dir,
        "-c",
        "user.name=ada",
        "-c",
        "user.email=ada@runner.local",
        "commit",
        "-m",
        "fix f",
      );
      submits.push(await actions!.submitPatch({ branch: "" }));
      submits.push(await actions!.submitPatch({ branch: "  " }));
      await git(dir, "switch", "--quiet", `${ns}/work`);
      await git(dir, "branch", "-D", "fix");
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(submits.map((s) => s.kind), ["submitted", "nothing-to-submit"]);
    assert(submits[0].kind === "submitted" && submits[0].branch === `${ns}/fix`);
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(result.status === "success");
    assertStringIncludes(result.summary, "branch `fix` no longer existed when the run ended");
    assertEquals(result.branches.map((b) => b.line), ["fix"]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a branch never submitted does not ship, and both the finish and the summary say so", async () => {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  const { reporter } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  let told: Array<{ path: string; list: string }> = [];
  const ns = fx.item.repos[0].branchNamespace;
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await git(dir, "switch", "--quiet", "-c", "at-finish", "origin/main");
      await writeFile(`${dir}/finish.txt`, "f\n");
      await git(dir, "add", "-A");
      await git(
        dir,
        "-c",
        "user.name=ada",
        "-c",
        "user.email=ada@runner.local",
        "commit",
        "-m",
        "finish f",
      );
      told = await actions!.unsubmittedBranches();
      await git(dir, "switch", "--quiet", `${ns}/work`);
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(told, [{ path: "repo", list: "`at-finish` (1 commit)" }]);
    assert("summary" in result && result.branches.length === 0, JSON.stringify(result));
    assert(!result.summary.includes("was not on its run's branch"), result.summary);
    assertStringIncludes(
      result.summary,
      "Note: `repo` has a branch with commits that was never submitted, so it was not " +
        "shipped: `at-finish` (1 commit).",
    );
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a fork pull request's head ships its default line only, and a submit of any other branch is refused before git", async () => {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  fx.item = { ...fx.item, repos: fx.item.repos.map((r) => ({ ...r, forkHead: true })) };
  const { reporter, reports } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const ns = fx.item.repos[0].branchNamespace;
  const submits: SubmitPatchOutcome[] = [];
  const checked: RunChecksOutcome[] = [];
  const asked: unknown[] = [];
  fx.ctx.checks = {
    request: (req) => {
      asked.push(req);
      return Promise.resolve({ requested: true, text: "Suite queued." });
    },
    status: () => Promise.resolve(""),
    log: () => Promise.reject(new Error("unused")),
    awaiting: () => Promise.resolve([]),
    declared: () => Promise.resolve({ declared: [], unread: [] }),
  } satisfies ChecksChannel;
  let layout = "";
  const commit = async (dir: string, file: string, subject: string) => {
    await writeFile(`${dir}/${file}`, `${subject}\n`);
    await git(dir, "add", "-A");
    await git(
      dir,
      "-c",
      "user.name=ada",
      "-c",
      "user.email=ada@runner.local",
      "commit",
      "-m",
      subject,
    );
  };
  fx.ctx.harness = {
    async run(input) {
      layout = input.layout;
      const dir = `${input.checkoutDir}/repo`;
      await commit(dir, "w.txt", "work w");
      await git(dir, "switch", "--quiet", "-c", "fix", "origin/main");
      await commit(dir, "f.txt", "fix f");
      // A check of it is refused too, before anything is uploaded.
      checked.push(await actions!.runChecks({}));
      // The branch the checkout is on, and one named: both another line, both refused.
      submits.push(await actions!.submitPatch({}));
      await git(dir, "switch", "--quiet", `${ns}/work`);
      submits.push(await actions!.submitPatch({ branch: "fix" }));
      // The default line, named or not, ships as ever.
      submits.push(await actions!.submitPatch({ branch: `${ns}/work` }));
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(submits.map((s) => s.kind), ["refused", "refused", "submitted"]);
    assert(checked[0]?.kind === "refused", JSON.stringify(checked));
    assertStringIncludes(checked[0].reason, "is a pull request from a fork");
    assertStringIncludes(checked[0].reason, "never `fix`");
    assertEquals(asked, []);
    for (const refused of submits.slice(0, 2)) {
      assert(refused.kind === "refused");
      assertStringIncludes(refused.reason, "is a pull request from a fork");
      assertStringIncludes(refused.reason, `its own branch \`${ns}/work\``);
      assertStringIncludes(refused.reason, "`fix`");
    }
    assertEquals(result.status, "success", JSON.stringify(result));
    assert("branches" in result);
    assertEquals(result.branches.map((b) => [b.line, b.name]), [["work", `${ns}/work`]]);
    // Every report was of the default line, and nothing else reached the origin.
    assertEquals([...new Set(reports.map((r) => r.branch.line))], ["work"]);
    assertEquals(
      await git(fx.originUrl, "for-each-ref", "--format=%(refname:short)", `refs/heads/${ns}/`),
      `${ns}/work`,
    );
    // And the run was never told it could ship one.
    assert(!layout.includes("Unrelated changes"), layout);
  } finally {
    await fx.cleanup();
  }
});
