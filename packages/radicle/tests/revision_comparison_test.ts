import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { cliRadExec } from "../src/adapters/rad/cli.ts";
import { compareRevisions } from "../src/core/revision_comparison.ts";
import { RefusedError, type RevisionView } from "../src/core/types.ts";

// Real git, no Radicle installation required: revisions are recorded data, and the comparison
// must still work after the old head has disappeared from every advertised branch.
test("revision comparisons survive a rewritten head and distinguish rebasing from edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  const exec = cliRadExec({ home: dir, passphrase: "", binDir: null });
  const git = async (...args: string[]) => {
    const result = await exec.git(dir, args);
    assertEquals(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = async (file: string, text: string, message: string) => {
    await writeFile(`${dir}/${file}`, text);
    await git("add", file);
    await git("commit", "-qm", message);
    return await git("rev-parse", "HEAD");
  };
  const revision = (id: string, base: string, head: string): RevisionView => ({
    id: id.repeat(40),
    base,
    head,
    description: "",
    timestamp: "",
    author: { did: "did:key:test" },
  });
  try {
    await git("init", "-q", "-b", "main");
    const base = await commit("base.txt", "initial\n", "base");
    const oldHead = await commit("feature.txt", "one\n", "feature");
    await git("reset", "--hard", base);
    const newBase = await commit("upstream.txt", "unrelated\n", "upstream");
    const rebasedHead = await commit("feature.txt", "one\n", "feature");
    const revisions = [revision("1", base, oldHead), revision("2", newBase, rebasedHead)];
    const diff = await compareRevisions(
      revisions,
      { from: revisions[0].id, mode: "diff" },
      exec.git,
      dir,
    );
    assertStringIncludes(diff.text, "upstream.txt");
    assertEquals(diff.to.id, revisions[1].id);
    const range = await compareRevisions(
      revisions,
      { from: revisions[0].id, mode: "range-diff" },
      exec.git,
      dir,
    );
    assertStringIncludes(range.text, " = ");
    assert(!range.text.includes("upstream.txt"));
    assertEquals(range.truncated, false);
    const editedHead = await commit("feature.txt", "one\ntwo\n", "fix review");
    revisions.push(revision("3", newBase, editedHead));
    const edited = await compareRevisions(
      revisions,
      { from: revisions[1].id, mode: "diff" },
      exec.git,
      dir,
    );
    assertStringIncludes(edited.text, "+two");
    const same = await compareRevisions(
      revisions,
      { from: revisions[0].id, to: revisions[0].id, mode: "diff" },
      exec.git,
      dir,
    );
    assertEquals(same.text, "");
    await assertRejects(
      () => compareRevisions(revisions, { from: oldHead, mode: "diff" }, exec.git, dir),
      RefusedError,
      "revision not found",
    );
    await assertRejects(
      () =>
        compareRevisions(
          [revision("4", base, "f".repeat(40))],
          { from: "4".repeat(40), mode: "diff" },
          exec.git,
          dir,
        ),
      RefusedError,
      "not an empty comparison",
    );
    await assertRejects(
      () =>
        compareRevisions(
          [revision("4", "--help", oldHead)],
          { from: "4".repeat(40), mode: "range-diff" },
          exec.git,
          dir,
        ),
      RefusedError,
      "valid recorded base/head",
    );
    const largeHead = await commit("large.txt", "a".repeat(70_000), "large file");
    revisions.push(revision("4", newBase, largeHead));
    const large = await compareRevisions(
      revisions,
      { from: revisions[2].id, mode: "diff" },
      exec.git,
      dir,
    );
    assertEquals(large.truncated, true);
    assert(large.text.length <= 60_000);
  } finally {
    await rm(dir, { recursive: true });
  }
});
