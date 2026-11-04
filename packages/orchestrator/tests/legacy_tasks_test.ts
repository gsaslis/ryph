// Tasks stored before every task had to check out a connected repo: an entry with a raw git URL
// and a null `connectedRepoId`. They stay readable and private to their requester, and nothing
// acts on them again (core/legacy.ts). The store-backed half is in task_list_test.ts.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { legacyRefusal } from "../src/core/legacy.ts";
import { taskInScope } from "../src/core/scope.ts";
import { openPatchForRun } from "../src/core/open_patch.ts";
import type { RepoEntry, Run, Task } from "../src/core/types.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import { silentDiagnostics } from "./doubles.ts";

const LEGACY: RepoEntry = {
  connectedRepoId: null,
  name: "https://example.com/repo.git",
  url: "https://example.com/repo.git",
  ref: "main",
  path: "repo",
  branchNamespace: "ryph/ada/r-old",
  description: null,
};

const legacyTask = { requestedByUserId: "u-1", repos: [LEGACY] };

test("a legacy entry's refusal names it", () => {
  assertStringIncludes(legacyRefusal(LEGACY), "repo is not a connected repository");
});

test("a legacy task is its requester's alone, whatever repos the caller may write", () => {
  assert(taskInScope(legacyTask, { kind: "principal", userId: "u-1", writableRepoIds: [] }));
  assert(
    !taskInScope(legacyTask, { kind: "principal", userId: "u-2", writableRepoIds: ["cr-1"] }),
  );
  assert(taskInScope(legacyTask, { kind: "all" }));
});

test("a legacy branch never becomes a patch", async () => {
  const store = {
    getAgent: () => Promise.resolve({ canOpenPatches: true }),
  } as unknown as TaskStore;
  const outcome = await openPatchForRun(
    { store, diag: silentDiagnostics(), now: () => new Date("2026-01-01T00:00:00.000Z") },
    { id: "r-old", agentId: "a-1" } as Run,
    { id: "t-old", repos: [LEGACY] } as unknown as Task,
    {
      branch: {
        connectedRepoId: null,
        path: "repo",
        line: "work",
        name: "ryph/ada/r-old/work",
        headSha: "a".repeat(40),
        commits: [{ sha: "a".repeat(40), subject: "old work" }],
        carries: [],
        generation: 1,
      },
      baseSha: null,
      title: null,
      description: null,
    },
    "ps-1",
    true,
    "2026-01-01T00:00:00.000Z",
  );
  assertEquals(outcome, { kind: "refused", reason: legacyRefusal(LEGACY) });
});
