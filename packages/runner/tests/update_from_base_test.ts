// Catching a branch up with the branch its work merges into, on the fake column with real git:
// a run on a change request merges the change request's target (usually main), a run on its own
// base merges that base — and a merge that conflicts is left for the agent and concluded by the
// next submit. What ships is the merge commit on top of the run's own work, never the target's
// commits listed as the run's.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import type { PatchReport, PatchReporter } from "../src/ports/patch_reporter.ts";
import type {
  RunActions,
  SubmitPatchOutcome,
  UpdateFromBaseOutcome,
} from "../src/ports/run_actions.ts";
import { git } from "../src/helpers/git_exec.ts";
import { gatewayGitTransport } from "../src/adapters/git/gateway.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";
import { plantRemoteConfig } from "./fixtures/remote_config.ts";

const CR_REF = "feature/x";

/** Commits `file` on `branch` of the origin (creating the branch from `from` when it is new),
 * as somebody else pushing would. Answers the new tip. */
async function pushCommit(
  originUrl: string,
  branch: string,
  file: string,
  content: string,
  subject: string,
  from = "main",
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "runner-push-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    const exists = (await git(work, "branch", "-r", "--list", `origin/${branch}`)) !== "";
    await git(work, "checkout", "--quiet", "-B", branch, `origin/${exists ? branch : from}`);
    await writeFile(`${work}/${file}`, content);
    await git(work, "add", "-A");
    await git(
      work,
      "-c",
      "user.name=Con",
      "-c",
      "user.email=con@test.local",
      "commit",
      "--quiet",
      "-m",
      subject,
    );
    await git(work, "push", "--quiet", "origin", branch);
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** Commits a file in a clone as the agent would: plain git, its own identity. */
async function agentCommit(dir: string, file: string, content: string, subject: string) {
  await writeFile(`${dir}/${file}`, content);
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
}

function recordingReporter() {
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({
        patchId: `p-${reports.length}`,
        state: "queued",
        url: null,
      });
    },
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  return { reporter, reports };
}

/** A fixture whose one repo is CONNECTED (so its work becomes a patch), optionally checked out
 * on a change request's branch that merges into main. */
async function fixture(opts: { onChangeRequest: boolean; files?: Record<string, string> }) {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles: opts.files });
  const crHead = opts.onChangeRequest
    ? await pushCommit(fx.originUrl, CR_REF, "cr.txt", "the change request\n", "cr work")
    : null;
  fx.item = {
    ...fx.item,
    repos: fx.item.repos.map((r) => ({
      ...r,
      connectedRepoId: "cr-1",
      ...(opts.onChangeRequest ? { ref: CR_REF, targetRef: "main" } : {}),
    })),
  };
  const { reporter, reports } = recordingReporter();
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  return { fx, crHead, reports, actions: () => actions! };
}

const done = { summary: "done", interrupted: false };

test("e2e: a change request's run merges its target, and ships the merge on top of its own work", async () => {
  const { fx, crHead, reports, actions } = await fixture({ onChangeRequest: true });
  let update: UpdateFromBaseOutcome | null = null;
  let submit: SubmitPatchOutcome | null = null;
  let mainTip = "";
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      // Main moves on while the change request is being worked.
      mainTip = await pushCommit(fx.originUrl, "main", "main.txt", "main moved\n", "main work");
      await agentCommit(dir, "fix.txt", "fixed\n", "address the review");
      update = await actions().updateFromBase({});
      // The target came in as a clone would name it, so the agent can read what changed.
      assertEquals(await git(dir, "rev-parse", "refs/remotes/origin/main"), mainTip);
      assertEquals(await readFile(`${dir}/main.txt`, "utf8"), "main moved\n");
      submit = await actions().submitPatch({});
      return done;
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    const merged = update! as UpdateFromBaseOutcome;
    assert(merged.kind === "merged", JSON.stringify(merged));
    assertEquals([merged.target, merged.tip], ["main", mainTip]);
    assertEquals((submit! as SubmitPatchOutcome).kind, "submitted");
    // Cut from the change request's head, and carrying the run's two commits — its own and the
    // merge. Main's commit came in through the merge and is not the run's to list.
    assertEquals(reports.length, 1);
    assertEquals(reports[0].baseSha, crHead);
    assertEquals(reports[0].branch.commits.map((c) => c.subject), [
      "address the review",
      "Merge branch 'main'",
    ]);
    assertEquals(reports[0].branch.headSha, merged.headSha);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the remote config the agent writes does not steer the update's fetch", async () => {
  const { fx, actions } = await fixture({ onChangeRequest: true });
  let update: UpdateFromBaseOutcome | null = null;
  let mainTip = "";
  let ran = true;
  let decoyRefs = "unread";
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      mainTip = await pushCommit(fx.originUrl, "main", "main.txt", "main moved\n", "main work");
      const planted = await plantRemoteConfig(dir, fx.originUrl);
      try {
        update = await actions().updateFromBase({});
        ran = await planted.uploadPackRan();
        decoyRefs = await planted.decoyRefs();
      } finally {
        await planted.cleanup();
      }
      return done;
    },
  };
  try {
    await run(fx.item, fx.ctx);
    const merged = update! as UpdateFromBaseOutcome;
    assert(merged.kind === "merged", JSON.stringify(merged));
    assertEquals([merged.target, merged.tip], ["main", mainTip]);
    assertEquals(ran, false, "the planted upload-pack ran");
    assertEquals(decoyRefs, "", "the planted fetch refspec was used");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a conflicting merge is left for the agent, and the next submit concludes it", async () => {
  const { fx, reports, actions } = await fixture({
    onChangeRequest: true,
    files: { "shared.txt": "original\n" },
  });
  const outcomes: Array<UpdateFromBaseOutcome | SubmitPatchOutcome> = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await pushCommit(fx.originUrl, "main", "shared.txt", "main's line\n", "main edits it");
      await agentCommit(dir, "shared.txt", "the change request's line\n", "cr edits it");
      outcomes.push(await actions().updateFromBase({}));
      // Still conflicted: a submit says so, and ships nothing.
      outcomes.push(await actions().submitPatch({}));
      // Anything else that moves the branch waits for the merge too.
      outcomes.push(await actions().updateFromBase({}));
      await writeFile(`${dir}/shared.txt`, "both lines, reconciled\n");
      await git(dir, "add", "shared.txt");
      outcomes.push(await actions().submitPatch({}));
      assert(!(await stat(`${dir}/.git/MERGE_HEAD`).then(() => true, () => false)));
      return done;
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(outcomes.map((o) => o.kind), ["conflict", "conflict", "refused", "submitted"]);
    assertEquals(outcomes[0], {
      kind: "conflict",
      path: "repo",
      target: "main",
      files: ["shared.txt"],
    });
    assertEquals(outcomes[1], {
      kind: "conflict",
      step: "merge",
      path: "repo",
      files: ["shared.txt"],
    });
    assert(outcomes[2].kind === "refused");
    assertStringIncludes(outcomes[2].reason, "merge in progress");
    assertEquals(reports.length, 1);
    assertEquals(reports[0].branch.commits.map((c) => c.subject), [
      "cr edits it",
      "Merge branch 'main'",
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run with nothing of its own yet simply moves to its base's new tip", async () => {
  const { fx, reports, actions } = await fixture({ onChangeRequest: false });
  const outcomes: UpdateFromBaseOutcome[] = [];
  let mainTip = "";
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      // Nothing has moved yet: there is nothing to merge.
      outcomes.push(await actions().updateFromBase({}));
      mainTip = await pushCommit(fx.originUrl, "main", "main.txt", "main moved\n", "main work");
      outcomes.push(await actions().updateFromBase({}));
      assertEquals(await git(dir, "rev-parse", "HEAD"), mainTip);
      assertEquals(await git(dir, "rev-parse", "--abbrev-ref", "HEAD"), fx.branchName);
      await agentCommit(dir, "fix.txt", "fixed\n", "the run's work");
      assertEquals((await actions().submitPatch({})).kind, "submitted");
      return done;
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(outcomes.map((o) => o.kind), ["up-to-date", "moved"]);
    // No merge commit: the run's patch is its one commit, based on the new tip.
    assertEquals(reports[0].baseSha, mainTip);
    assertEquals(reports[0].branch.commits.map((c) => c.subject), ["the run's work"]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a base the forge could only serve stale is refused, never answered up-to-date", async () => {
  const { fx, actions } = await fixture({ onChangeRequest: false });
  // The gateway's answer about the base: its upstream has been unreachable for a while, and the
  // clone came from the copy it held. The fetch itself still lands, on that same old tip.
  const held = await git(fx.originUrl, "rev-parse", "main");
  const gateway = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () => Response.json({ ref: "main", commit: held, staleSince: "2026-09-29T10:00:00.000Z" }),
  );
  fx.ctx.git = gatewayGitTransport(noopDiagnostics(), {
    origin: `http://127.0.0.1:${gateway.addr.port}`,
    token: "ryph-git-virtual-key",
    runId: fx.item.id,
  });
  const outcomes: UpdateFromBaseOutcome[] = [];
  fx.ctx.harness = {
    async run() {
      outcomes.push(await actions().updateFromBase({}));
      return done;
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(outcomes, [{
      kind: "refused",
      reason: "`repo`: `main` could not be fetched (`main` could not be refreshed from upstream: " +
        "every attempt since 2026-09-29T10:00:00.000Z has failed, and ryph only holds an older " +
        "copy); try again",
    }]);
  } finally {
    await gateway.shutdown();
    await fx.cleanup();
  }
});

test("e2e: uncommitted changes stop the update, and so does a run that is finalizing", async () => {
  const { fx, actions } = await fixture({ onChangeRequest: true });
  const outcomes: UpdateFromBaseOutcome[] = [];
  let bound: RunActions | null = null;
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      bound = actions();
      await pushCommit(fx.originUrl, "main", "main.txt", "main moved\n", "main work");
      await writeFile(`${dir}/wip.txt`, "half a thought\n");
      outcomes.push(await bound.updateFromBase({}));
      outcomes.push(await bound.updateFromBase({ path: "elsewhere" }));
      return done;
    },
  };
  try {
    await run(fx.item, fx.ctx);
    outcomes.push(await bound!.updateFromBase({}));
    assertEquals(outcomes.map((o) => o.kind), ["refused", "refused", "refused"]);
    assert(outcomes.every((o) => o.kind === "refused"));
    const reasons = outcomes.map((o) => (o as { reason: string }).reason);
    assertStringIncludes(reasons[0], "uncommitted changes");
    assertStringIncludes(reasons[1], "no repo of this run is at `elsewhere`");
    assertEquals(reasons[2], "the run is finalizing");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a merge still conflicted when the run ends is left alone: the branch's commits ship, nothing uncommitted does, and the summary says so", async () => {
  // A conflicted path outside ASCII, so the files named come back as themselves.
  const { fx, reports, actions } = await fixture({
    onChangeRequest: true,
    files: { "ünï.txt": "original\n" },
  });
  let update: UpdateFromBaseOutcome | null = null;
  let dir = "";
  fx.ctx.harness = {
    async run(input) {
      dir = `${input.checkoutDir}/repo`;
      await pushCommit(fx.originUrl, "main", "ünï.txt", "main's line\n", "main edits it");
      await agentCommit(dir, "ünï.txt", "the change request's line\n", "cr edits it");
      update = await actions().updateFromBase({});
      // Work done with the merge open, staged and not.
      await writeFile(`${dir}/staged.txt`, "staged\n");
      await git(dir, "add", "staged.txt");
      await writeFile(`${dir}/loose.txt`, "loose\n");
      // ...and the agent stops, the conflict unresolved.
      return done;
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    const conflict = update! as UpdateFromBaseOutcome;
    assert(conflict.kind === "conflict");
    assertEquals(conflict.files, ["ünï.txt"]);
    // The repo is not lost to the optional merge: the commits on its branch ship as they are.
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(result.status === "success");
    assertEquals(reports.length, 1);
    assertEquals(reports[0].requiresApproval, true);
    assertEquals(reports[0].branch, result.branches[0]);
    assertEquals(result.branches.length, 1);
    const branch = result.branches[0];
    assertEquals(branch.commits.map((c) => c.subject), ["cr edits it"]);
    assertEquals(await git(fx.originUrl, "rev-parse", `refs/heads/${branch.name}`), branch.headSha);
    // Nothing on disk was touched to get there: the merge is still open, the work still there.
    assert(await stat(`${dir}/.git/MERGE_HEAD`).then(() => true, () => false));
    assertEquals(await readFile(`${dir}/staged.txt`, "utf8"), "staged\n");
    assertEquals(await readFile(`${dir}/loose.txt`, "utf8"), "loose\n");
    // Said after the agent's own account, which was written believing the merge would go out.
    assertStringIncludes(result.summary, "done\n\nNote: the merge of `main` into `repo`");
    assertStringIncludes(result.summary, "conflicts in `ünï.txt`");
    assertStringIncludes(result.summary, "its uncommitted changes did not ship");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the update refuses a detached checkout, and acts on the branch it is on", async () => {
  const { fx, actions } = await fixture({ onChangeRequest: true });
  const updates: UpdateFromBaseOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await git(dir, "checkout", "--quiet", "--detach");
      updates.push(await actions().updateFromBase({}));
      await git(dir, "checkout", "--quiet", "-b", "elsewhere");
      updates.push(await actions().updateFromBase({}));
      await git(dir, "checkout", "--quiet", fx.branchName);
      return done;
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(updates[0].kind === "refused");
    assertStringIncludes(updates[0].reason, "HEAD is detached");
    // A branch of the agent's own is a line of its own (@ryph/shared/lines), started from the
    // repo's target: main, which it already holds.
    assertEquals(updates[1].kind, "up-to-date");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: an unfinished merge on a branch with nothing new says nothing more shipped", async () => {
  const { fx, reports, actions } = await fixture({ onChangeRequest: true });
  let update: UpdateFromBaseOutcome | null = null;
  fx.ctx.harness = {
    async run() {
      // Main adds the file the change request added: the merge conflicts with no commit of
      // the run's own on the branch.
      await pushCommit(fx.originUrl, "main", "cr.txt", "main's own\n", "main adds it too");
      update = await actions().updateFromBase({});
      return done;
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals((update! as UpdateFromBaseOutcome).kind, "conflict");
    assertEquals(reports.length, 0);
    assert("summary" in result);
    assertStringIncludes(result.summary, "`repo` had no new commits of its own");
    assert(!result.summary.includes("shipped its commits"));
  } finally {
    await fx.cleanup();
  }
});
