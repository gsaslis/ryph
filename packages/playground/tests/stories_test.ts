// The scripts edit the fixture repos by exact text. Playing every edit against freshly made repos
// here catches a drifted line before a seed does.
import { test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assert } from "@std/assert";
import { join } from "@std/path";
import { createRepo, REPOS } from "../src/repos.ts";
import type { Step } from "../src/runner.ts";
import { DELEGATING, STORIES } from "../src/stories.ts";
import { removeTree } from "./remove_tree.ts";

test("every script's reads and edits apply to its repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    for (const story of STORIES) {
      const fixture = REPOS.find((r) => r.name === story.repo);
      assert(fixture, `${story.key}: no repo ${story.repo}`);
      const dir = await createRepo(join(root, story.key), fixture);
      for (const step of story.steps) {
        if ("read" in step) await stat(join(dir, step.read));
        if ("edit" in step) {
          const file = join(dir, step.edit);
          const text = await readFile(file, "utf8");
          assert(
            text.includes(step.find),
            `${story.key}: ${step.edit} lacks ${JSON.stringify(step.find)}`,
          );
          await writeFile(file, text.replace(step.find, step.replace));
        }
      }
    }
  } finally {
    await removeTree(root);
  }
});

test("a script with a patch fate submits one", () => {
  for (const story of STORIES) {
    if (story.patch) assert(story.steps.some((s) => "submit" in s), `${story.key} submits nothing`);
  }
});

test("the delegating opening's subagents read real files and are started before they are named", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const dir = await createRepo(join(root, "acme-api"), REPOS.find((r) => r.name === "acme-api")!);
    const started = new Set<string>();
    const reads = (steps: Step[]) => steps.flatMap((s) => ("read" in s ? [s.read] : []));
    for (const step of DELEGATING) {
      if ("subagent" in step) {
        started.add(step.subagent.label);
        for (const path of reads(step.subagent.steps)) await stat(join(dir, path));
      }
      if ("ends" in step) assert(started.has(step.ends), step.ends);
      if ("tell" in step) {
        assert(started.has(step.tell.label), step.tell.label);
        for (const path of reads(step.tell.steps ?? [])) await stat(join(dir, path));
      }
    }
  } finally {
    await removeTree(root);
  }
});
