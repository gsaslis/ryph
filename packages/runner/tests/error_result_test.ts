// "failure" is the agent's outcome; "error" is the machinery's. A run that breaks before the
// agent ever works — here: cloning a repo that does not exist — reports an error naming the
// phase, and blames the agent for nothing.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { run } from "../src/core/run.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

test("machinery breakage reports an error naming the phase, not an agent failure", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  try {
    fx.item.repos = [{ ...fx.item.repos[0], url: `${fx.checkoutRoot}/no-such-origin` }];
    const result = await run(fx.item, fx.ctx);

    assertEquals(result.status, "error");
    assert(result.status === "error");
    assertEquals(result.during, "cloning");
    assertEquals(result.branches, []);
    // the error names the repo: a checkout of several is what "which one" is for
    assert(result.reason.startsWith(`cloning ${fx.item.repos[0].path} (`), result.reason);

    // still a normal exit: reported exactly once, like any other outcome
    assertEquals(orchestrator.results.length, 1);
  } finally {
    await fx.cleanup();
  }
});
