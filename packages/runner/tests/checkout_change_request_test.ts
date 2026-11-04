// Checking a change request out mid-run, on the fake column with real git: the run's branch is
// moved to the change request's head and the repo's base moves with it, so the next patch is cut
// from there and becomes a revision of that change request rather than a new one.
//
// The refusals are the substance of the rest: the swap REPLACES the branch, so anything on it
// that has not shipped stops it; a repo that already shipped stops it; and the two calls it
// makes — the transport's fetch and the control plane's claim — are ordered so that a refusal
// from either leaves the checkout exactly as it was.

import { test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import type { GitTransport } from "../src/ports/git_transport.ts";
import {
  type ChangeRequestClaim,
  ChangeRequestRefused,
  type PatchReport,
  type PatchReporter,
} from "../src/ports/patch_reporter.ts";
import type { CheckoutChangeRequestOutcome, RunActions } from "../src/ports/run_actions.ts";
import { git } from "../src/helpers/git_exec.ts";
import { fetchBranch } from "../src/helpers/fetch.ts";
import { noopPatchReporter } from "../src/adapters/orchestrator/noop.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

const CR_REF = "feature/x";
const CR_URL = "https://forge/test/repo/pull/42";

/** A change request on the origin: a branch with one commit of its own, as the gateway's cache
 * would be serving it once warmed. Answers its head. */
async function seedChangeRequest(originUrl: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "runner-cr-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await git(work, "checkout", "--quiet", "-b", CR_REF);
    await writeFile(`${work}/cr.txt`, "the change request's work\n");
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
      "the change request's commit",
    );
    await git(work, "push", "--quiet", "origin", CR_REF);
    return await git(work, "rev-parse", "HEAD");
  } finally {
    await rm(work, { recursive: true });
  }
}

/**
 * The cli transport with the gateway's one extra move stubbed in: the change request's branch
 * really is on the origin, so this fetches it for real, by URL into `origin/<ref>` — exactly what
 * the gateway adapter ends up with, without a gateway.
 */
function transportWithChangeRequest(base: GitTransport, headSha: string) {
  const fetched: string[] = [];
  const transport: GitTransport = {
    ...base,
    async fetchChangeRequest(from, repo, changeRequest) {
      fetched.push(changeRequest);
      await fetchBranch(git, from.dir, repo.url, CR_REF);
      return { ref: CR_REF, headSha, url: CR_URL };
    },
  };
  return { transport, fetched };
}

/** A reporter that records both calls and answers what the test tells it to. */
function reporterDouble(claim: () => ChangeRequestClaim | Error) {
  const claims: Array<{ path: string; changeRequest: string }> = [];
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
    claimChangeRequest(args) {
      claims.push(args);
      const answer = claim();
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { reporter, claims, reports };
}

const claimOf = (headSha: string, ref = CR_REF): ChangeRequestClaim => ({
  connectedRepoId: "cr-1",
  thread: "42",
  ref,
  headSha,
  url: CR_URL,
});

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

const branchTip = (dir: string, branch: string) => git(dir, "rev-parse", `refs/heads/${branch}`);

test("e2e: a checked-out change request moves the run's branch to its head, and the next patch is cut from there", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  const { reporter, claims, reports } = reporterDouble(() => claimOf(crHead));
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      assert(actions !== null, "the actions are bound before the harness runs");
      const dir = `${input.checkoutDir}/repo`;
      outcomes.push(await actions.checkoutChangeRequest({ changeRequest: "42" }));
      // The run's own branch is what moved — the swap re-targets this run, it does not put the
      // checkout on some other ref.
      assertEquals(await git(dir, "rev-parse", "--abbrev-ref", "HEAD"), fx.branchName);
      assertEquals(await git(dir, "rev-parse", "HEAD"), crHead);
      assertEquals(await readFile(`${dir}/cr.txt`, "utf8"), "the change request's work\n");
      await agentCommit(dir, "fix.txt", "fixed\n", "address the review");
      assertEquals((await actions.submitPatch({})).kind, "submitted");
      return { summary: "worked on the change request", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(outcomes[0], {
      kind: "checked-out",
      path: "repo",
      changeRequest: "42",
      ref: CR_REF,
      headSha: crHead,
      url: CR_URL,
    });
    assertEquals(warmed.fetched, ["42"]);
    assertEquals(claims, [{ path: "repo", changeRequest: "42" }]);
    // The patch is cut from the change request's head: its base is that head, and it carries
    // only what the run added on top — not the change request's own commit again.
    assertEquals(reports.length, 1);
    assertEquals(reports[0].baseSha, crHead);
    assertEquals(reports[0].branch.generation, 1);
    assertEquals(reports[0].branch.commits.map((c) => c.subject), ["address the review"]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: unshipped work stops the swap — an uncommitted tree, then commits on the branch", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  const { reporter, claims } = reporterDouble(() => claimOf(crHead));
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await writeFile(`${dir}/wip.txt`, "half a thought\n");
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      await agentCommit(dir, "wip.txt", "half a thought\n", "wip");
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      return { summary: "nothing swapped", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(outcomes.map((o) => o.kind), ["refused", "refused"]);
    assert(outcomes[0].kind === "refused" && outcomes[1].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "uncommitted changes");
    assertStringIncludes(outcomes[0].reason, "submit_patch");
    assertStringIncludes(outcomes[1].reason, "1 commit(s) of this run on its branch");
    // Neither refusal reached the platform: the local preconditions are checked first, so a run
    // that cannot swap never re-targets its task.
    assertEquals(warmed.fetched, []);
    assertEquals(claims, []);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: once a repository has shipped a patch, its checkout can no longer be swapped", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  const { reporter, claims } = reporterDouble(() => claimOf(crHead));
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      assertEquals((await actions!.submitPatch({})).kind, "submitted");
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      return { summary: "shipped, then asked to swap", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(outcomes[0].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "already submitted a patch in this run");
    assertEquals(claims, []);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: another line of the repository that shipped stops the swap too", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  const { reporter, claims } = reporterDouble(() => claimOf(crHead));
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      // A line of its own ships; the default line, clean and unmoved, is what the swap moves —
      // and the control plane refuses a re-target of a repo with any patch of the run.
      await git(dir, "checkout", "--quiet", "-b", "fix");
      await agentCommit(dir, "f.txt", "f\n", "fix f");
      assertEquals((await actions!.submitPatch({})).kind, "submitted");
      await git(dir, "checkout", "--quiet", fx.branchName);
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      return { summary: "shipped a line, then asked to swap", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(outcomes[0].kind === "refused", JSON.stringify(outcomes[0]));
    assertStringIncludes(outcomes[0].reason, "already submitted a patch in this run");
    assertEquals(warmed.fetched, []);
    assertEquals(claims, []);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a rebase left in the repository stops the swap, and so does a run that is finalizing", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  const { reporter, claims } = reporterDouble(() => claimOf(crHead));
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      const baseSha = await git(dir, "rev-parse", "HEAD");
      // A rebase the agent started and is in the middle of: the tree is git's right now, and
      // moving the branch out from under it would strand the rebase.
      await agentCommit(dir, "a.txt", "ours\n", "ours");
      await git(dir, "checkout", "--quiet", "-b", "theirs", baseSha);
      await agentCommit(dir, "a.txt", "theirs\n", "theirs");
      await git(dir, "checkout", "--quiet", fx.branchName);
      await git(dir, "-c", "core.editor=true", "rebase", "theirs").catch(() => {});
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      await git(dir, "rebase", "--abort");
      return { summary: "left it where it was", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(outcomes[0].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "rebase in progress");
    assertEquals(claims, []);
    // Once the harness has returned, finalize owns the clones: a late call must not move a
    // branch out from under the bundle being cut.
    const late = await actions!.checkoutChangeRequest({ changeRequest: "42" });
    assert(late.kind === "refused");
    assertEquals(late.reason, "the run is finalizing");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: with several repos the swap needs a name, and with no platform behind the run it is refused", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { moreRepos: [{ path: "web" }] });
  const crHead = await seedChangeRequest(fx.originUrl);
  fx.ctx.git = transportWithChangeRequest(fx.ctx.git, crHead).transport;
  // The reporter a run with no control plane gets — what the composed binary always installs
  // (main.ts), and what has nothing to re-target a task with. Its refusal is the one the agent
  // actually reads, so this is the spelling the test pins.
  fx.ctx.patchReporter = noopPatchReporter();
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run() {
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      outcomes.push(await actions!.checkoutChangeRequest({ path: "repo", changeRequest: "42" }));
      return { summary: "it could not be swapped", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(outcomes[0].kind === "refused" && outcomes[1].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "the run holds 2 repos; name one with `repo`");
    assertStringIncludes(outcomes[0].reason, "repo, web");
    assertEquals(outcomes[1].reason, "repo: this run has no platform behind it");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a transport with no forge gateway behind it is refused", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const { reporter, claims } = reporterDouble(() => claimOf("unused"));
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  fx.ctx.harness = {
    async run() {
      // The fixture's transport is the plain cli one, which cannot be asked about a change
      // request at all — the run is told so rather than guessing at a ref.
      outcomes.push(await actions!.checkoutChangeRequest({ path: "repo", changeRequest: "42" }));
      return { summary: "neither could be swapped", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assert(outcomes[0].kind === "refused");
    assertStringIncludes(outcomes[0].reason, "no forge gateway behind it");
    assertEquals(claims, []);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a claim that does not take — refused, unconfirmed, or disagreeing — leaves the branch where it was", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const crHead = await seedChangeRequest(fx.originUrl);
  const warmed = transportWithChangeRequest(fx.ctx.git, crHead);
  // Four answers in turn: an outright refusal, a failure that confirms nothing, a ref that is
  // not the one the gateway serves, and a head that moved between the fetch and the claim.
  let answer: () => ChangeRequestClaim | Error = () =>
    new ChangeRequestRefused("run wi-other-0002 is already working #42", 409);
  const { reporter, claims } = reporterDouble(() => answer());
  fx.ctx.git = warmed.transport;
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: CheckoutChangeRequestOutcome[] = [];
  let baseSha = "";
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      baseSha = await git(dir, "rev-parse", "HEAD");
      for (
        const next of [
          () => new Error("the orchestrator answered 503"),
          () => claimOf(crHead, `refs/heads/${CR_REF}`),
          () => claimOf("1".repeat(40)),
        ]
      ) {
        outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
        assertEquals(await branchTip(dir, fx.branchName), baseSha);
        answer = next as () => ChangeRequestClaim | Error;
      }
      outcomes.push(await actions!.checkoutChangeRequest({ changeRequest: "42" }));
      assertEquals(await branchTip(dir, fx.branchName), baseSha);
      // The objects came in either way; only the branch did not move.
      await git(dir, "cat-file", "-e", `${crHead}^{commit}`);
      return { summary: "not swapped", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
    const reasons = outcomes.map((o) => o.kind === "refused" ? o.reason : `!${o.kind}`);
    assertStringIncludes(reasons[0], "run wi-other-0002 is already working #42");
    // Not confirmed is not the same as not done: the claim is idempotent, and the agent is told
    // to ask again rather than told it did not happen.
    assertStringIncludes(reasons[1], "did not confirm the claim");
    assertStringIncludes(reasons[1], "may or may not have recorded it");
    // The ref is what every later fetch asks the gateway for, so a differently spelled one is
    // refused rather than persisted.
    assertStringIncludes(reasons[2], "is served as `feature/x` but the platform named");
    assertStringIncludes(reasons[3], "moved while it was being checked out");
    assertEquals(claims.length, 4);
  } finally {
    await fx.cleanup();
  }
});
