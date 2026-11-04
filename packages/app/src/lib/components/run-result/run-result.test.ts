import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import type { BranchOutcome } from "$lib/api/types";
import RunResult from "./run-result.svelte";

function branch(line: string, name: string): BranchOutcome {
  return {
    connectedRepoId: "repo-1",
    path: "app",
    line,
    name,
    headSha: `${line}-head`,
    commits: [{ sha: `${line}-c1`, subject: `${line} change` }],
  };
}

function rendered(branches: BranchOutcome[]): string {
  return render(RunResult, {
    props: {
      runId: null,
      result: { status: "success", summary: "", images: [], branches },
      egressNote: null,
      limit: null,
      expanded: false,
      ontoggle: () => {},
    },
  }).body;
}

describe("RunResult", () => {
  it("lists every line a run pushed in one repo", () => {
    const body = rendered([
      branch("work", "ryph/agent/run-1/work"),
      branch("fix", "ryph/agent/run-1/fix"),
    ]);
    expect(body).toContain("ryph/agent/run-1/work");
    expect(body).toContain("ryph/agent/run-1/fix");
  });

  it("names a line other than the default one", () => {
    const body = rendered([
      branch("work", "ryph/agent/run-1/work"),
      branch("fix", "ryph/agent/run-1/fix"),
    ]);
    expect(body).toContain("line <span");
    expect(body.match(/line <span/g)?.length).toBe(1);
  });
});
