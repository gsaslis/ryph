import { describe, expect, it } from "vitest";
import { repoEntrySchema, runnerResultSchema } from "$lib/api/types";
import { isLegacyTask } from "./legacy-task";

const LEGACY_ENTRY = {
  connectedRepoId: null,
  name: "https://example.com/repo.git",
  url: "https://example.com/repo.git",
  ref: "main",
  path: "repo",
  branchNamespace: "ryph/ada/r-old",
  description: null,
};

describe("a task from before every task checked out a connected repo", () => {
  it("still parses, its entry and its run's branches alike", () => {
    expect(repoEntrySchema.parse(LEGACY_ENTRY).connectedRepoId).toBeNull();
    const result = runnerResultSchema.parse({
      status: "success",
      summary: "Done.",
      branches: [{
        connectedRepoId: null,
        path: "repo",
        name: "ryph/ada/r-old",
        headSha: "a".repeat(40),
        commits: [{ sha: "a".repeat(40), subject: "old work" }],
      }],
    });
    expect(result.branches[0].connectedRepoId).toBeNull();
  });

  it("is told apart by any entry with no connected repo", () => {
    expect(isLegacyTask({ repos: [LEGACY_ENTRY] })).toBe(true);
    expect(isLegacyTask({ repos: [{ ...LEGACY_ENTRY, connectedRepoId: "cr-1" }] })).toBe(false);
    expect(
      isLegacyTask({ repos: [{ connectedRepoId: "cr-1" }, { connectedRepoId: null }] }),
    ).toBe(true);
  });
});
