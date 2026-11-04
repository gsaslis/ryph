// Cancellation is graceful by design (§7.6): when the run is told to stop, committed work still
// ships — the branch is pushed and the result reports "cancelled" with the branch attached.
// Nothing an agent did evaporates. The core honors a single cancelSignal; whoever tripped it (a
// local SIGINT, the inbound control endpoint) converges upstream and never reaches the core, so
// one test of the signal path covers every source. The control API's own wiring — auth and its
// abort of that signal — lives in control_api_test.ts.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { run } from "../src/core/run.ts";
import type { Narrator } from "../src/ports/narrator.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { git } from "../src/helpers/git_exec.ts";
import { makeRunFixture } from "./util.ts";

test("cancel mid-run via cancelSignal: committed work survives, result reports cancelled", async () => {
  // The single cancel input: a stop arrives through run()'s cancelSignal. A "cancelled" result
  // with the branch attached proves graceful cancel is the core's property, uniform no matter who
  // asked. We trip the signal mid-run — on the harness's tool_use chunk, after its file is written
  // but before it finishes — reproducing a kill that lands between transcript chunks.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const external = new AbortController();
  const abortOnWrite: Narrator = {
    emit(_runId, chunk) {
      if (chunk.kind === "tool_use") external.abort();
    },
  };
  try {
    const result = await run(fx.item, {
      ...fx.ctx,
      narrator: abortOnWrite,
      cancelSignal: external.signal,
    });

    assertEquals(result.status, "cancelled");
    assert(result.status === "cancelled");
    assertEquals(result.branches.length, 1, "committed work must still be pushed on cancel");

    // the partial work really landed on the origin
    const originSha = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`);
    assertEquals(originSha, result.branches[0].headSha);

    // exactly one result reported, no retry
    assertEquals(orchestrator.results.length, 1);
  } finally {
    await fx.cleanup();
  }
});
