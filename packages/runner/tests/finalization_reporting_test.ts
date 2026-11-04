// Automatic shipping reports immediately, but requires approval regardless of the outcome.
import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { assert, assertEquals } from "@std/assert";
import { run } from "../src/core/run.ts";
import { git } from "../src/helpers/git_exec.ts";
import type { PatchReport } from "../src/ports/patch_reporter.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { bindActions, makeRunFixture } from "./util.ts";

for (const ending of ["success", "failure", "unfinished", "cancelled"] as const) {
  for (const work of ["leftovers", "empty-commit", "no-commits"] as const) {
    for (const reportFails of [false, true]) {
      test(`finalize ${ending} with ${work}, report fails=${reportFails}: reports approval and retains result fallback`, async () => {
        const orchestrator = fakeOrchestratorGateway();
        const fx = await makeRunFixture(orchestrator);
        const actions = bindActions(fx);
        const cancel = new AbortController();
        const reports: PatchReport[] = [];
        fx.ctx.cancelSignal = cancel.signal;
        fx.ctx.patchReporter = {
          reportPatch(report) {
            reports.push(report);
            assertEquals(orchestrator.results.length, 0, "report precedes terminal result");
            if (reportFails) throw new Error("report unavailable");
            return Promise.resolve({
              patchId: "final-patch",
              state: "pending_approval",
              url: null,
            });
          },
          claimChangeRequest() {
            throw new Error("unused");
          },
        };
        fx.ctx.harness = {
          async run(_input, io) {
            if (work === "leftovers") await writeFile(`${fx.checkoutDir}/work.txt`, "work\n");
            if (work === "empty-commit") {
              await git(
                fx.checkoutDir,
                "-c",
                "user.name=ada",
                "-c",
                "user.email=ada@test.local",
                "commit",
                "--allow-empty",
                "-m",
                "empty work",
              );
            }
            if (ending === "cancelled") cancel.abort();
            else if (ending === "unfinished") actions().reportOutcome({ outcome: "in-progress" });
            else {actions().finish({
                outcome: ending === "failure" ? "failed" : ending,
                summary: ending,
              });}
            io.conversation.onSettled();
            for await (const _message of io.conversation.messages) { /* wait for run end */ }
            return { summary: ending, interrupted: io.signal.aborted };
          },
        };
        try {
          const result = await run(fx.item, fx.ctx);
          assertEquals(reports.length, work === "no-commits" ? 0 : 1);
          if (work !== "no-commits") {
            assertEquals(reports[0].requiresApproval, true);
            assertEquals(reports[0].branch, result.branches[0]);
          }
          assertEquals(result.status, ending === "unfinished" ? "failure" : ending);
          assertEquals(result.branches.length, work === "no-commits" ? 0 : 1);
          if (work !== "no-commits") {
            const branch = result.branches[0];
            assertEquals(branch.commits.length, 1);
            assertEquals(
              await git(fx.originUrl, "rev-parse", `refs/heads/${branch.name}`),
              branch.headSha,
            );
          }
          assertEquals(orchestrator.results.length, 1);
          assertEquals(orchestrator.results[0], result);
        } finally {
          await fx.cleanup();
        }
      });
    }
  }
}

test("explicit submit report failure refuses with approval fallback; unchanged finalize retains branch without re-reporting", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  const reports: PatchReport[] = [];
  fx.ctx.patchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      assertEquals(orchestrator.results.length, 0, "report precedes terminal result");
      throw new Error("report unavailable");
    },
    claimChangeRequest() {
      throw new Error("unused");
    },
  };
  fx.ctx.harness = {
    async run(_input, io) {
      await writeFile(`${fx.checkoutDir}/work.txt`, "work\n");
      const submitted = await actions().submitPatch({ title: "Explicit title" });
      assert(submitted.kind === "refused");
      assert(submitted.reason.includes("report unavailable"));
      assert(submitted.reason.includes(
        "when the run ends, any patch not already recorded will be opened awaiting approval",
      ));
      assertEquals(reports.length, 1);
      actions().finish({ outcome: "success", summary: "done" });
      io.conversation.onSettled();
      for await (const _message of io.conversation.messages) { /* wait for run end */ }
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");
    assertEquals(reports.length, 1, "unchanged finalization must not re-report the shipped tip");
    assertEquals(reports[0].requiresApproval, undefined);
    assertEquals(result.branches.length, 1, "retain the branch for conservative terminal fallback");
    assertEquals(result.branches[0], reports[0].branch);
    assertEquals(result.branches[0].commits.length, 1);
    assertEquals(
      await git(fx.originUrl, "rev-parse", `refs/heads/${result.branches[0].name}`),
      result.branches[0].headSha,
    );
    assertEquals(orchestrator.results.length, 1);
    assertEquals(orchestrator.results[0], result);
  } finally {
    await fx.cleanup();
  }
});

for (const moreWork of [false, "leftovers", "empty-commit"] as const) {
  test(`explicit submit reports immediately; finalize ${moreWork ? `reports ${moreWork} requiring approval` : "retains submitted tip"}`, async () => {
    const orchestrator = fakeOrchestratorGateway();
    const fx = await makeRunFixture(orchestrator);
    const actions = bindActions(fx);
    const reports: PatchReport[] = [];
    let pushes = 0;
    const push = fx.ctx.git.push.bind(fx.ctx.git);
    fx.ctx.git.push = (...args) => {
      pushes++;
      return push(...args);
    };
    fx.ctx.patchReporter = {
      reportPatch(report) {
        reports.push(structuredClone(report));
        return Promise.resolve({ patchId: "explicit-patch", state: "pending_approval", url: null });
      },
      claimChangeRequest() {
        throw new Error("unused");
      },
    };
    fx.ctx.harness = {
      async run(_input, io) {
        await writeFile(`${fx.checkoutDir}/first.txt`, "first\n");
        const submitted = await actions().submitPatch({ title: "Explicit title" });
        assert(submitted.kind === "submitted");
        assertEquals(submitted.patchId, "explicit-patch");
        assertEquals(reports.length, 1);
        if (moreWork === "leftovers") await writeFile(`${fx.checkoutDir}/second.txt`, "second\n");
        if (moreWork === "empty-commit") {
          await git(
            fx.checkoutDir,
            "-c",
            "user.name=ada",
            "-c",
            "user.email=ada@test.local",
            "commit",
            "--allow-empty",
            "-m",
            "empty follow-up",
          );
        }
        actions().finish({ outcome: "failed", summary: "not finished" });
        io.conversation.onSettled();
        for await (const _message of io.conversation.messages) { /* wait for run end */ }
        return { summary: "not finished", interrupted: false };
      },
    };
    try {
      const result = await run(fx.item, fx.ctx);
      assertEquals(result.status, "failure");
      assertEquals(reports.length, moreWork ? 2 : 1);
      assertEquals(reports[0].requiresApproval, undefined);
      if (moreWork) {
        assertEquals(reports[1].requiresApproval, true);
        assertEquals(reports[1].branch, result.branches[0]);
      }
      assertEquals(reports[0].title, "Explicit title");
      assertEquals(pushes, moreWork ? 2 : 1);
      assertEquals(result.branches.length, 1);
      assertEquals(result.branches[0].commits.length, moreWork ? 2 : 1);
      assertEquals(result.branches[0].headSha === reports[0].branch.headSha, !moreWork);
    } finally {
      await fx.cleanup();
    }
  });
}
