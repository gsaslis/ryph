// Prepares the local inputs the `debug` task hands to the runner: a throwaway bare git origin,
// a work item that points at it, and the injected context. All are disposable and regenerated on
// every run, so a debug session always starts from a clean, self-contained repository with a
// single seed commit — no network, credentials, or personal git config involved.
//
// The origin lives at debug/.origin.git, the work item at debug/workitem.json, and the context at
// debug/context.json; all are ignored by git. The work item carries the origin's absolute path as
// its repo url, because the runner clones with the checkout as git's working directory and a
// relative path would resolve against the wrong place.
//
// The origin is bare (that's what a push target must be), so it has no working tree to browse;
// debug/inspect is a plain clone of it kept alongside for that — open it in an IDE or a git GUI,
// and after a run `git -C debug/inspect fetch --prune origin` shows the branch the runner pushed.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/helpers/git_exec.ts";
import type { InjectedContext, WorkItem } from "../src/core/types.ts";

const debugDir = new URL("../debug/", import.meta.url).pathname;
const originDir = `${debugDir}.origin.git`;
const inspectDir = `${debugDir}inspect`;
const workItemPath = `${debugDir}workitem.json`;
const contextPath = `${debugDir}context.json`;

// debug/ holds only generated artifacts (all git-ignored), so a fresh checkout won't have it and
// `debug:clean` removes it outright — mint it before anything runs with it as its working dir.
await mkdir(debugDir, { recursive: true });

// Start from a clean origin each run so branches pushed by earlier runs don't accumulate.
await rm(originDir, { recursive: true }).catch(() => {});
await git(debugDir, "init", "--bare", "-b", "main", originDir);

// Seed the origin with one commit through a throwaway checkout; only the bare origin is kept.
const seed = await mkdtemp(join(tmpdir(), "runner-debug-seed-"));
try {
  await git(seed, "init", "-b", "main");
  await writeFile(`${seed}/README.md`, "# demo repo\n");
  await git(seed, "add", "-A");
  await git(
    seed,
    "-c",
    "user.name=seed",
    "-c",
    "user.email=seed@runner.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "seed: initial commit",
  );
  await git(seed, "remote", "add", "origin", originDir);
  await git(seed, "push", "origin", "main");
} finally {
  await rm(seed, { recursive: true });
}

// The inspection clone: a plain working copy of the (bare, unbrowsable) origin.
// Recreated together with the origin so it never points at a vanished history.
await rm(inspectDir, { recursive: true }).catch(() => {});
await git(debugDir, "clone", originDir, inspectDir);

const workItem: WorkItem = {
  id: "debug-0001",
  agent: { name: "debug", email: "debug@runner.local" },
  spec: {
    title: "echo the task",
    instructions: "Write the task into AGENT_NOTES.md.",
  },
  repos: [{
    connectedRepoId: "cr-debug",
    name: "debug/origin",
    url: originDir,
    ref: "main",
    path: "origin",
    branchNamespace: "runner/debug/debug-0001",
    description: "the throwaway origin seed_debug.ts created",
  }],
  workspace: null,
  harness: { kind: "echo" },
  lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  canOpenPatches: true,
  canPublishArtifacts: false,
};

await writeFile(
  workItemPath,
  `${JSON.stringify(workItem, null, 2)}\n`,
);

const context: InjectedContext = {
  systemPrompt:
    "You are a coding agent working in a fresh clone. Make the smallest change that satisfies the task and leave the tree clean.",
  brief: {
    text: "## What previous runs learned\n\nThese are observations recorded by earlier runs and " +
      "by people. They may be outdated; verify before relying on one.\n\n" +
      "- [mem-debug] This repository is a throwaway seeded by scripts/seed_debug.ts. (fact · today)",
    memoryIds: ["mem-debug"],
    evidence: [],
  },
};

await writeFile(
  contextPath,
  `${JSON.stringify(context, null, 2)}\n`,
);

console.log(`seeded debug origin at ${originDir}`);
console.log(`cloned inspection copy to ${inspectDir}`);
console.log(`wrote work item to ${workItemPath}`);
console.log(`wrote context to ${contextPath}`);
