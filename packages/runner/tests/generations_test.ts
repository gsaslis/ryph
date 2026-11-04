// Patches during the run, and generations, on the fake column with real git: a harness that
// submits mid-run through the actions, the patch reported and recorded, a landed cue fetching
// the merged tip and saying so, the agent's own rebase onto it shipping only the new commits as
// the next generation, and finalize listing the latest branch per repo — a branch nobody rebased
// shipped as it stands, held for a person, with the summary saying so.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import type { InboundMessage, SystemPayload } from "../src/core/types.ts";
import type { Inbox } from "../src/ports/inbox.ts";
import type { PatchReport, PatchReporter } from "../src/ports/patch_reporter.ts";
import type {
  RunActions,
  SubmitPatchOutcome,
  UpdateFromBaseOutcome,
} from "../src/ports/run_actions.ts";
import { git } from "../src/helpers/git_exec.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A reporter that records every report and mints ids in order. */
function recordingReporter(forgeUrl: string | null = null, forgeRef: string | null = null) {
  const reports: PatchReport[] = [];
  const reporter: PatchReporter = {
    reportPatch(report) {
      reports.push(structuredClone(report));
      return Promise.resolve({
        patchId: `p-${reports.length}`,
        state: "pending_approval",
        url: null,
        forgeUrl,
        forgeRef,
      });
    },
    claimChangeRequest() {
      return Promise.reject(new Error("no change request in this test"));
    },
  };
  return { reporter, reports };
}

/** An inbox the test feeds by hand. */
function feedableInbox() {
  const queued: InboundMessage[] = [];
  let seq = 0;
  let wake: (() => void) | null = null;
  const inbox: Inbox = {
    async poll(after, { waitMs, signal }) {
      const pending = () => queued.filter((m) => m.seq > after);
      if (pending().length === 0 && !signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, waitMs);
          signal.addEventListener("abort", done, { once: true });
          wake = done;
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = null;
            resolve();
          }
        });
      }
      return pending();
    },
  };
  return {
    inbox,
    system(text: string, payload: SystemPayload) {
      queued.push({
        seq: seq++,
        kind: "system",
        sender: { kind: "platform" },
        text,
        payload,
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      wake?.();
    },
    chat(name: string, text: string) {
      queued.push({
        seq: seq++,
        kind: "chat",
        sender: { kind: "chat", name, id: "42" },
        text,
        payload: null,
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      wake?.();
    },
  };
}

/** The agent's rebase onto what merged, as the cue says: plain git, its own identity. Answers
 * whether it stopped on a conflict. */
async function agentRebase(dir: string, landed: string): Promise<boolean> {
  return await git(
    dir,
    "-c",
    "user.name=ada",
    "-c",
    "user.email=ada@runner.local",
    "rebase",
    "--quiet",
    "--onto",
    "origin/main",
    landed,
  ).then(() => false, () => true);
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

/** Merges a branch of the origin into main, squashed — the merge style that hides the branch's
 * own commits from a plain rebase, which is why the cue names the landed head. */
async function squashMergeOnOrigin(originUrl: string, branch: string, subject: string) {
  const work = await mkdtemp(join(tmpdir(), "runner-merge-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await git(work, "checkout", "--quiet", "main");
    await git(
      work,
      "-c",
      "user.name=m",
      "-c",
      "user.email=m@test.local",
      "merge",
      "--squash",
      `origin/${branch}`,
    );
    await git(work, "-c", "user.name=m", "-c", "user.email=m@test.local", "commit", "-m", subject);
    await git(work, "push", "--quiet", "origin", "main");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** Commits a file on main at the origin, as somebody else landing work would. */
async function commitOnMain(originUrl: string, file: string, content: string, subject: string) {
  const work = await mkdtemp(join(tmpdir(), "runner-main-"));
  try {
    await git(work, "clone", "--quiet", "--", originUrl, ".");
    await writeFile(`${work}/${file}`, content);
    await git(work, "add", "-A");
    await git(work, "-c", "user.name=m", "-c", "user.email=m@test.local", "commit", "-m", subject);
    await git(work, "push", "--quiet", "origin", "main");
  } finally {
    await rm(work, { recursive: true });
  }
}

/** A connected fixture with a hand-fed inbox — the shape every landing needs. */
async function landingFixture(repoFiles?: Record<string, string>) {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles });
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const { reporter, reports } = recordingReporter();
  const box = feedableInbox();
  fx.ctx.patchReporter = reporter;
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  /** Lands generation 1 at `headSha` (squashed), waits for the cue to reach the run, and answers
   * the text the agent was handed. */
  const land = async (
    messages: AsyncIterable<{ text: string }>,
    headSha: string,
  ): Promise<string> => {
    await squashMergeOnOrigin(fx.originUrl, fx.branchName, "Add a (#1)");
    box.system("patch p-1 merged", {
      kind: "patch",
      line: "work",
      patchId: "p-1",
      path: "repo",
      headSha,
      generation: 1,
      state: "merged",
      landedHead: headSha,
      forgeUrl: "https://gh/x/pull/1",
      reason: null,
    });
    for await (const message of messages) return message.text;
    throw new Error("the conversation ended before the cue");
  };
  return { fx, reports, land, actions: () => actions! };
}

test("e2e: a patch submitted mid-run ships, is reported, and finalize lists it once", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const forgeUrl = "https://github.com/acme/app/pull/7";
  const { reporter, reports } = recordingReporter(forgeUrl, "7");
  fx.ctx.patchReporter = reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      assert(actions !== null, "the actions are bound before the harness runs");
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      outcomes.push(await actions.submitPatch({ title: "Add a", description: "because" }));
      assertEquals(actions.patches().length, 1);
      assertEquals(actions.patches()[0].forgeUrl, forgeUrl);
      // a second submit with nothing new is nothing to submit
      assertEquals((await actions.submitPatch({})).kind, "nothing-to-submit");
      return { summary: "shipped mid-run", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(result.status === "success");
    const submitted = outcomes[0];
    assert(submitted.kind === "submitted", JSON.stringify(submitted));
    assertEquals(submitted.patchId, "p-1");
    assertEquals(submitted.generation, 1);
    assertEquals(submitted.forgeUrl, forgeUrl);
    assertEquals(submitted.forgeRef, "7");
    // one report, carrying the base, the branch and the agent's words
    assertEquals(reports.length, 1);
    assertEquals(reports[0].title, "Add a");
    assertEquals(reports[0].description, "because");
    assertEquals(reports[0].branch.generation, 1);
    assertEquals(reports[0].branch.name, fx.branchName);
    assertEquals(reports[0].branch.commits.map((c) => c.subject), ["add a"]);
    // finalize shipped nothing new, and the result still names the branch once
    assertEquals(result.branches.length, 1);
    assertEquals(result.branches[0].headSha, submitted.headSha);
    assertEquals(result.branches[0].generation, 1);
    assertEquals(
      await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`),
      submitted.headSha,
    );
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a landed patch is fetched and said; the agent's rebase ships its new commits on the merged tip as generation 2", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const { reporter, reports } = recordingReporter();
  const box = feedableInbox();
  fx.ctx.patchReporter = reporter;
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions!.submitPatch({});
      outcomes.push(first);
      assert(first.kind === "submitted");
      // The pull request lands, squashed, and the platform says so through the inbox.
      await squashMergeOnOrigin(fx.originUrl, fx.branchName, "Add a (#1)");
      box.system("patch p-1 merged", {
        kind: "patch",
        line: "work",
        patchId: "p-1",
        path: "repo",
        headSha: first.headSha,
        generation: 1,
        state: "merged",
        landedHead: first.headSha,
        forgeUrl: "https://gh/x/pull/1",
        reason: null,
      });
      // wait for the cue to be delivered as a message: with what the fetch found
      for await (const message of io.conversation!.messages) {
        const tip = await git(fx.originUrl, "rev-parse", "refs/heads/main");
        assertStringIncludes(message.text, "patch p-1 merged");
        assertStringIncludes(
          message.text,
          `ryph fetched \`origin/main\` at \`${tip.slice(0, 12)}\`.`,
        );
        break;
      }
      assertEquals(actions!.patches()[0].state, "merged");
      // More work on the spent branch: refused until it is on what merged, then shipped.
      await agentCommit(dir, "b.txt", "b\n", "add b");
      outcomes.push(await actions!.submitPatch({}));
      assertEquals(await agentRebase(dir, first.headSha), false);
      outcomes.push(await actions!.submitPatch({}));
      actions!.finish({ outcome: "success", summary: "two patches" });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");
    assert(result.status === "success");
    assertEquals(result.summary, "two patches");
    const refused = outcomes[1];
    assert(refused.kind === "refused", JSON.stringify(refused));
    assertStringIncludes(refused.reason, "git rebase --onto origin/main");
    const second = outcomes[2];
    assert(second.kind === "submitted", JSON.stringify(second));
    assertEquals(second.generation, 2);
    assertEquals(reports.length, 2);
    assertEquals(reports[1].branch.name, `${fx.branchName}-2`);
    assertEquals(reports[1].branch.generation, 2);
    // only the NEW commit rides generation 2, on top of the merged tip
    assertEquals(reports[1].branch.commits.map((c) => c.subject), ["add b"]);
    const mainTip = await git(fx.originUrl, "rev-parse", "refs/heads/main");
    assertEquals(reports[1].baseSha, mainTip);
    const parent = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}-2^`);
    assertEquals(parent, mainTip);
    // the result names the latest branch of the repo: generation 2
    assertEquals(result.branches.map((b) => [b.name, b.generation]), [[`${fx.branchName}-2`, 2]]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a push the transport refuses mid-run is a refusal naming the branch; at finalize it fails the repo", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.patchReporter = recordingReporter().reporter;
  const real = fx.ctx.git;
  fx.ctx.git = {
    ...real,
    push: () => Promise.reject(new Error("the gateway did not accept the bundle: refused")),
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input) {
      await agentCommit(`${input.checkoutDir}/repo`, "a.txt", "a\n", "add a");
      outcomes.push(await actions!.submitPatch({}));
      return { summary: "tried to ship", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    // The agent is told what happened and where its work is, in words it can act on.
    assertEquals(outcomes, [{
      kind: "refused",
      reason: "repo: the commits could not be shipped (the gateway did not accept the bundle: " +
        `refused); your commits are still on \`${fx.branchName}\`; try again`,
    }]);
    assertEquals(await git(fx.checkoutDir, "log", "-1", "--format=%s", fx.branchName), "add a");
    // Finalize has nobody to retry: the same failure fails the repo, and nothing shipped.
    assert(result.status === "error", JSON.stringify(result));
    assertEquals(result.during, "finalizing");
    assertStringIncludes(
      result.reason,
      "shipping repo (test/repo) failed: the gateway did not accept the bundle: refused",
    );
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a merged base the transport cannot fetch is said with the cue, refuses a submit, and ships held at finalize", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const box = feedableInbox();
  fx.ctx.patchReporter = recordingReporter().reporter;
  fx.ctx.inbox = box.inbox;
  const real = fx.ctx.git;
  // Only a landing reads the base: the first submit never asks. It asks for the repo's own
  // base, the one the run's pull request merged into.
  const asked: Array<string | undefined> = [];
  fx.ctx.git = {
    ...real,
    fetchBase: (_from, _repo, ref) => {
      asked.push(ref);
      return Promise.reject(
        new Error(
          "`main` could not be refreshed from upstream: every attempt since " +
            "2026-09-29T10:00:00.000Z has failed, and ryph only holds an older copy",
        ),
      );
    },
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions!.submitPatch({});
      assert(first.kind === "submitted");
      await squashMergeOnOrigin(fx.originUrl, fx.branchName, "Add a (#1)");
      box.system("patch p-1 merged", {
        kind: "patch",
        line: "work",
        patchId: "p-1",
        path: "repo",
        headSha: first.headSha,
        generation: 1,
        state: "merged",
        landedHead: first.headSha,
        forgeUrl: "https://gh/x/pull/1",
        reason: null,
      });
      for await (const message of io.conversation!.messages) {
        assertStringIncludes(message.text, "ryph could not fetch `origin/main` (`main` could not");
        assertStringIncludes(message.text, "call ryph__update_from_base");
        break;
      }
      await agentCommit(dir, "b.txt", "b\n", "add b");
      outcomes.push(await actions!.submitPatch({}));
      actions!.finish({ outcome: "success", summary: "tried" });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(outcomes, [{
      kind: "refused",
      reason: "`repo`: `origin/main` could not be fetched (`main` could not be refreshed from " +
        "upstream: every attempt since 2026-09-29T10:00:00.000Z has failed, and ryph only holds " +
        "an older copy); try again",
    }]);
    // The cue's fetch was asked once more at the end of the window after the merge; the submit
    // and finalize each asked once. With nobody left to rebase, finalize ships the branch as it
    // stands, as the next generation, held for a person, rather than keep the work in the box.
    assertEquals(asked, ["main", "main", "main", "main"]);
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(result.status === "success");
    assertEquals(result.branches.map((b) => [b.name, b.generation]), [[`${fx.branchName}-2`, 2]]);
    assertStringIncludes(
      result.summary,
      "Note: `repo` (`work`): its change request merged into `main`, and it was not rebased " +
        "onto `main` (nobody did, or `main` could not be found at the origin any more); held " +
        "for a person.",
    );
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a landed patch with nothing after it reads no base at finalize: the run succeeds", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const box = feedableInbox();
  fx.ctx.patchReporter = recordingReporter().reporter;
  fx.ctx.inbox = box.inbox;
  const real = fx.ctx.git;
  // The base is gone, as a change request's branch is once it merges and is deleted: the cue's
  // fetch fails, and finalize does not try again.
  let fetched = 0;
  fx.ctx.git = {
    ...real,
    fetchBase: () => {
      fetched++;
      return Promise.reject(new Error("couldn't find remote ref refs/heads/main"));
    },
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  let shipped = "";
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions!.submitPatch({});
      assert(first.kind === "submitted");
      shipped = first.headSha;
      box.system("patch p-1 merged", {
        kind: "patch",
        line: "work",
        patchId: "p-1",
        path: "repo",
        headSha: first.headSha,
        generation: 1,
        state: "merged",
        landedHead: first.headSha,
        forgeUrl: "https://gh/x/pull/1",
        reason: null,
      });
      for await (const _ of io.conversation!.messages) break;
      // nothing new since the landing, and the run ends
      actions!.finish({ outcome: "success", summary: "landed" });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    // The cue's fetch and its one retry at the end of the window; nothing at finalize.
    assertEquals(fetched, 2);
    assertEquals(result.status, "success", JSON.stringify(result));
    // the result still names what shipped
    assertEquals(result.branches.map((b) => [b.name, b.headSha, b.generation]), [
      [fx.branchName, shipped, 1],
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: changes left uncommitted after a landing ship at finalize as generation 2, unrebased and held", async () => {
  const { fx, reports, land, actions } = await landingFixture();
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions().submitPatch({});
      assert(first.kind === "submitted");
      await land(io.conversation!.messages, first.headSha);
      // new work, never committed: finalize commits it, so there is something past the landing
      await writeFile(`${dir}/b.txt`, "b\n");
      actions().finish({ outcome: "success", summary: "done" });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(reports.length, 2);
    assertEquals(reports[1].requiresApproval, true);
    assertEquals(result.branches.map((b) => [b.name, b.generation]), [[`${fx.branchName}-2`, 2]]);
    // From where the branch meets main: after the squash, the base it started on.
    assertEquals(result.branches[0].baseSha, reports[0].baseSha);
    assertEquals(result.branches[0].commits.map((c) => c.subject), [
      "add a",
      "test: echo the task",
    ]);
    assert(result.status === "success");
    assertStringIncludes(result.summary, "it was not rebased onto `main` (nobody did, or `main`");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the agent's own rebase that conflicts is its to finish: a submit mid-rebase is refused, and ships once through", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles: { "shared.txt": "base\n" } });
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const { reporter, reports } = recordingReporter();
  const box = feedableInbox();
  fx.ctx.patchReporter = reporter;
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const outcomes: SubmitPatchOutcome[] = [];
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions!.submitPatch({});
      assert(first.kind === "submitted");
      // The first patch lands; meanwhile main ALSO changed shared.txt.
      await squashMergeOnOrigin(fx.originUrl, fx.branchName, "Add a (#1)");
      const other = await mkdtemp(join(tmpdir(), "runner-other-"));
      await git(other, "clone", "--quiet", "--", fx.originUrl, ".");
      await agentCommit(other, "shared.txt", "theirs\n", "shared: theirs");
      await git(other, "push", "--quiet", "origin", "main");
      await rm(other, { recursive: true });
      box.system("patch p-1 merged", {
        kind: "patch",
        line: "work",
        patchId: "p-1",
        path: "repo",
        headSha: first.headSha,
        generation: 1,
        state: "merged",
        landedHead: first.headSha,
        forgeUrl: null,
        reason: null,
      });
      for await (const _ of io.conversation!.messages) break;
      // The agent's next commit touches shared.txt too: its rebase conflicts.
      await agentCommit(dir, "shared.txt", "ours\n", "shared: ours");
      assertEquals(await agentRebase(dir, first.headSha), true);
      const midRebase = await actions!.submitPatch({});
      outcomes.push(midRebase);
      assert(midRebase.kind === "refused", JSON.stringify(midRebase));
      assertStringIncludes(midRebase.reason, "has a rebase in progress");
      // The agent resolves, stages and continues its rebase, and asks again.
      await writeFile(`${dir}/shared.txt`, "ours and theirs\n");
      await git(dir, "add", "shared.txt");
      await git(dir, "-c", "core.editor=true", "rebase", "--continue");
      const resolved = await actions!.submitPatch({});
      outcomes.push(resolved);
      actions!.finish({ outcome: "success" });
      io.conversation!.onSettled();
      return { summary: "resolved", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    const resolved = outcomes[1];
    assert(resolved.kind === "submitted", JSON.stringify(resolved));
    assertEquals(resolved.generation, 2);
    assertEquals(reports[1].branch.commits.map((c) => c.subject), ["shared: ours"]);
    const shipped = await git(fx.originUrl, "show", `refs/heads/${fx.branchName}-2:shared.txt`);
    assertEquals(shipped, "ours and theirs");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the actions refuse what they cannot honour, and a late submit once finalize began", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { moreRepos: [{ path: "web" }] });
  fx.ctx.patchReporter = recordingReporter().reporter;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  fx.ctx.harness = {
    async run() {
      const ambiguous = await actions!.submitPatch({});
      assert(ambiguous.kind === "refused");
      assertStringIncludes(ambiguous.reason, "name one with `repo`: repo, web");
      const unknown = await actions!.submitPatch({ path: "nope" });
      assert(unknown.kind === "refused");
      assertStringIncludes(unknown.reason, "no repo of this run is at `nope`");
      return { summary: "asked around", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "failure"); // nothing was ever committed
    const late = await actions!.submitPatch({ path: "repo" });
    assertEquals(late, { kind: "refused", reason: "the run is finalizing" });
  } finally {
    await fx.cleanup();
  }
});

test("e2e: the echo harness answers messages until the run is finished", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const box = feedableInbox();
  // The clock is far too long for a test, so a person's message and then finish end it —
  // through the actions, exactly as the loopback tool would.
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  try {
    const running = run(fx.item, fx.ctx);
    // wait until the echo harness has settled once (its "Done." chunk), then speak to it
    while (!fx.narrator.chunks.some((c) => c.chunk.text === "Done.")) await sleep(10);
    box.system("hello from the platform", {
      kind: "patch",
      line: "work",
      patchId: "p-x",
      path: "repo",
      headSha: "abc1234",
      generation: 1,
      state: "submitted",
      forgeUrl: null,
      reason: null,
    });
    while (!fx.narrator.chunks.some((c) => c.chunk.text?.startsWith("Re: "))) await sleep(10);
    actions!.finish({ outcome: "success", summary: "all good" });
    const result = await running;
    assertEquals(result.status, "success");
    assert(result.status === "success");
    assertEquals(result.summary, "all good");
    // the reply is in the notes the echo harness shipped, and the framing reached it
    const notes = await git(fx.checkoutDir, "show", `HEAD:AGENT_NOTES.md`);
    assertStringIncludes(notes, "Reply: A message arrived from the platform.");
    // the idle deadline was reported upstream while the agent sat settled, and cleared at the end
    const deadlines = orchestrator.progressReports.filter((p) => p.idleDeadlineAt !== undefined);
    assert(deadlines.some((p) => p.idleDeadlineAt !== null), "a deadline was reported");
    assertEquals(deadlines.at(-1)?.idleDeadlineAt, null);
    // the transcript carries the message as an inbound chunk
    assert(fx.narrator.chunks.some((c) => c.chunk.kind === "inbound"));
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run finished as no-changes without commits is a success", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.inbox = feedableInbox().inbox;
  // A harness that answers questions and never commits: it settles at once and waits for the
  // conversation to end — finish carries the agent's claim of completion.
  let settled: (() => void) | null = null;
  const settledOnce = new Promise<void>((resolve) => (settled = resolve));
  fx.ctx.harness = {
    async run(_input, io) {
      io.conversation!.onSettled();
      settled!();
      await new Promise<void>((resolve) =>
        io.conversation!.done.addEventListener("abort", () => resolve(), { once: true })
      );
      return { summary: "the incident was a false alarm", interrupted: false };
    },
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  try {
    const running = run(fx.item, fx.ctx);
    await settledOnce;
    actions!.finish({
      outcome: "no-changes",
      summary: "nothing to change: the alert was a false alarm",
      statusComment: "minimal",
    });
    const result = await running;
    assert(result.status === "success", `expected success, got ${JSON.stringify(result)}`);
    assertEquals(result.branches, []);
    assertEquals(result.summary, "nothing to change: the alert was a false alarm");
    // finish's say on the status comment rides the result beside its summary
    assertEquals(result.statusComment, "minimal");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run finished as failed is a failure, in its own words", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.inbox = feedableInbox().inbox;
  let settled: (() => void) | null = null;
  const settledOnce = new Promise<void>((resolve) => (settled = resolve));
  fx.ctx.harness = {
    async run(_input, io) {
      io.conversation!.onSettled();
      settled!();
      await new Promise<void>((resolve) =>
        io.conversation!.done.addEventListener("abort", () => resolve(), { once: true })
      );
      return { summary: "the last message", interrupted: false };
    },
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  try {
    const running = run(fx.item, fx.ctx);
    await settledOnce;
    // Finishing as failed ends the run like any finish — the failure is not a reason to wait.
    actions!.finish({ outcome: "failed", summary: "main is not reachable from this run" });
    const result = await running;
    assert(result.status === "failure", `expected failure, got ${JSON.stringify(result)}`);
    assertEquals(result.reason, "agent reported failure");
    assertEquals(result.summary, "main is not reachable from this run");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run the idle clock ends reports what the agent last reported", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 50, attendedIdleMs: 50 },
  };
  fx.ctx.inbox = feedableInbox().inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  // The incident shape: the agent posts its finding, says how things stand, and stays open for
  // follow-ups instead of finishing. Nobody comes back.
  fx.ctx.harness = {
    async run(_input, io) {
      assert(actions!.reportOutcome({ outcome: "failed", summary: "first look" }));
      assert(actions!.reportOutcome({
        outcome: "no-changes",
        summary: "the alert was a false alarm",
        statusComment: "minimal",
      }));
      // A conversational handoff still reports its intent, without rewriting the run record.
      assert(actions!.reportOutcome({ outcome: "no-changes", awaitingUserTurn: true }));
      io.conversation!.onSettled();
      await new Promise<void>((resolve) =>
        io.conversation!.done.addEventListener("abort", () => resolve(), { once: true })
      );
      return { summary: "posted the finding", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "success", `expected success, got ${JSON.stringify(result)}`);
    assertEquals(result.branches, []);
    assertEquals(result.summary, "the alert was a false alarm");
    assertEquals(result.statusComment, "minimal");
    // and once the run is over, a late report or finish is refused, not silently noted
    assertEquals(actions!.reportOutcome({ outcome: "failed" }), false);
    assertEquals(actions!.finish({ outcome: "failed" }), false);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a finish after a report keeps the report's summary and comment it leaves out", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.inbox = feedableInbox().inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  fx.ctx.harness = {
    run(_input, io) {
      actions!.reportOutcome({
        outcome: "no-changes",
        summary: "reviewed",
        statusComment: "minimal",
      });
      actions!.finish({ outcome: "failed" });
      // finish before the settle: the settle itself ends the run
      io.conversation!.onSettled();
      assert(io.conversation!.done.aborted);
      return Promise.resolve({ summary: "the last message", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure", `expected failure, got ${JSON.stringify(result)}`);
    assertEquals(result.reason, "agent reported failure");
    assertEquals(result.summary, "reviewed");
    assertEquals(result.statusComment, "minimal");
  } finally {
    await fx.cleanup();
  }
});

// The run hands its harness who the agent is and the room it is bound to, and frames that room's
// messages by its name.
test("e2e: the harness is handed the agent, and no chat when the run is bound to none", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const seen: Array<{ agent: string; chat: unknown }> = [];
  fx.ctx.harness = {
    run(input) {
      seen.push({ agent: input.agent.name, chat: input.chat });
      return Promise.resolve({ summary: "nothing", interrupted: false });
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(seen, [{ agent: fx.item.agent.name, chat: undefined }]);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a run bound to a chat frames its messages by the room's name", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const chat = { kind: "telegram" as const, roomTitle: "Ops war room", botHandle: "ryph_ada_bot" };
  fx.item = {
    ...fx.item,
    chat,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  const box = feedableInbox();
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const received: string[] = [];
  let handedChat: unknown = null;
  fx.ctx.harness = {
    async run(input, io) {
      handedChat = input.chat;
      io.conversation!.onSettled();
      for await (const message of io.conversation!.messages) {
        received.push(message.text);
        actions!.finish({ outcome: "success", summary: "heard" });
        io.conversation!.onSettled();
      }
      return { summary: "heard", interrupted: false };
    },
  };
  try {
    const running = run(fx.item, fx.ctx);
    while (actions === null) await sleep(10);
    box.chat("Grace", "is it the cache?");
    const result = await running;
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(handedChat, chat);
    assertEquals(received.length, 1);
    assertStringIncludes(received[0], 'from Grace in the Telegram group "Ops war room"');
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a new generation with nothing of its own yet moves to the tip rather than merging it", async () => {
  const { fx, reports, land, actions } = await landingFixture();
  const outcomes: Array<SubmitPatchOutcome | UpdateFromBaseOutcome> = [];
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions().submitPatch({});
      assert(first.kind === "submitted");
      await land(io.conversation!.messages, first.headSha);
      // On what merged, with nothing new to ship: generation 2 starts empty.
      assertEquals(await agentRebase(dir, first.headSha), false);
      outcomes.push(await actions().submitPatch({}));
      await commitOnMain(fx.originUrl, "x.txt", "x\n", "main moves");
      outcomes.push(await actions().updateFromBase({}));
      await agentCommit(dir, "b.txt", "b\n", "add b");
      outcomes.push(await actions().submitPatch({}));
      actions().finish({ outcome: "success", summary: "done" });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    // Moved, not merged: a merge here would be generation 2's only commit, a patch that
    // changes nothing.
    assertEquals(outcomes.map((o) => o.kind), ["nothing-to-submit", "moved", "submitted"]);
    assertEquals(reports[1].branch.commits.map((c) => c.subject), ["add b"]);
    assertEquals(reports[1].baseSha, await git(fx.originUrl, "rev-parse", "refs/heads/main"));
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a merge left unfinished over a landed patch is left as it stands, the branch ships unrebased, the summary says so within bounds", async () => {
  const { fx, reports, land, actions } = await landingFixture({ "shared.txt": "base\n" });
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions().submitPatch({});
      assert(first.kind === "submitted");
      // More work, then a catch-up that conflicts — and while it is open, the first patch lands.
      await agentCommit(dir, "shared.txt", "mine\n", "edit shared");
      await commitOnMain(fx.originUrl, "shared.txt", "main's\n", "main edits shared");
      assertEquals((await actions().updateFromBase({})).kind, "conflict");
      await land(io.conversation!.messages, first.headSha);
      // The longest summary finish takes: the note still has to fit behind it.
      actions().finish({ outcome: "success", summary: "x".repeat(100_000) });
      io.conversation!.onSettled();
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result).slice(0, 500));
    assert(result.status === "success");
    // The merge is left as it stands and the branch's commits leave as they stood, as the next
    // generation: held for a person, rather than they stay in the box.
    assertEquals(reports.length, 2);
    assertEquals(reports[1].requiresApproval, true);
    assertEquals(result.branches[0].commits.map((c) => c.subject), ["add a", "edit shared"]);
    assertEquals(result.branches.map((b) => b.generation), [2]);
    assert(result.summary.length <= 100_000, `${result.summary.length}`);
    assertStringIncludes(
      result.summary,
      "x…\n\nNote: the merge of `main` into `repo` was not finished",
    );
    assertStringIncludes(result.summary, "shipped its committed work as it stood");
    assertStringIncludes(result.summary, "did not ship");
    assertStringIncludes(result.summary, "it was not rebased onto `main` (nobody did, or `main`");
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a merge cue sent as the agent's work ends is read before it ships, and ships the next generation held", async () => {
  // Posted just before the harness returns: the conversation's poll or the finalize drain reads
  // it, and either way the work goes out as the next generation, which nobody rebased.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const { reporter, reports } = recordingReporter();
  const box = feedableInbox();
  fx.ctx.patchReporter = reporter;
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  fx.ctx.harness = {
    async run(input) {
      const dir = `${input.checkoutDir}/repo`;
      await agentCommit(dir, "a.txt", "a\n", "add a");
      const first = await actions!.submitPatch({});
      assert(first.kind === "submitted");
      await squashMergeOnOrigin(fx.originUrl, fx.branchName, "Add a (#1)");
      box.system("patch p-1 merged", {
        kind: "patch",
        line: "work",
        patchId: "p-1",
        path: "repo",
        headSha: first.headSha,
        generation: 1,
        state: "merged",
        landedHead: first.headSha,
        forgeUrl: "https://gh/x/pull/1",
        reason: null,
        onto: "main",
      });
      await agentCommit(dir, "b.txt", "b\n", "add b");
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(reports.length, 2);
    assertEquals(reports[1].requiresApproval, true);
    assertEquals(result.branches[0].generation, 2);
    assertEquals(result.branches[0].commits.map((c) => c.subject), ["add a", "add b"]);
    assertEquals(result.branches[0].baseSha, reports[0].baseSha);
  } finally {
    await fx.cleanup();
  }
});
