// THE GATE THAT MATTERS: a WorkItem driven end-to-end on the fake
// column to a pushed, SSH-signed, trailer-carrying branch and a reported result — with zero
// orchestrator, zero containers, zero network. This is the independence thesis as an executable fact.

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { RUN_TRAILER } from "../src/core/brand.ts";
import { run } from "../src/core/run.ts";
import type { RunActions } from "../src/ports/run_actions.ts";
import type { InboundMessage } from "../src/core/types.ts";
import type { HarnessConversation, HarnessInput } from "../src/ports/harness.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { throwingNarrator } from "./doubles/narrator.ts";
import { git } from "../src/helpers/git_exec.ts";
import { bindActions, makeRunFixture } from "./util.ts";
import { specMemoryStore } from "../src/adapters/memory/spec.ts";

test("idle marks follow settles, conversational handoffs, and resume", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  let pending: InboundMessage[] = [];
  let wake: (() => void) | null = null;
  const deliver = (seq: number) => {
    pending.push({
      seq,
      kind: "user",
      sender: { kind: "user", userId: "u-1" },
      text: "Continue",
      payload: null,
      attachments: [],
      createdAt: new Date().toISOString(),
    });
    wake?.();
  };
  fx.ctx.inbox = {
    poll: (_after, { signal }) =>
      new Promise((resolve) => {
        const flush = () => {
          wake = null;
          signal.removeEventListener("abort", flush);
          const messages = pending;
          pending = [];
          resolve(messages);
        };
        wake = flush;
        signal.addEventListener("abort", flush, { once: true });
        if (pending.length > 0 || signal.aborted) flush();
      }),
  };
  fx.ctx.harness = {
    async run(_input, opts) {
      const conversation = opts.conversation!;
      const latest = () => orchestrator.progressReports.at(-1)?.idleState;
      actions().reportOutcome({ outcome: "success", awaitingUserTurn: true });
      assertEquals(latest(), undefined, "the report tool itself is not a settle");
      const messages = conversation.messages[Symbol.asyncIterator]();
      deliver(1);
      await messages.next();
      assertEquals(latest(), null, "a mid-turn steer is not an idle agent resuming");
      conversation.onSettled();
      assertEquals(latest(), "waiting-for-user");
      // Background notices use the same delivery path as inbound user messages and wake-ups.
      // A message from the inbox starts the next turn and clears its predecessor's intent.
      deliver(2);
      await messages.next();
      assertEquals(latest(), null);
      conversation.onSettled();
      assertEquals(latest(), "idle", "the previous handoff must not leak into a new turn");
      actions().reportOutcome({ outcome: "success", awaitingUserTurn: true });
      actions().reportOutcome({ outcome: "success" });
      conversation.onSettled();
      assertEquals(latest(), "idle", "omitting the flag defaults to false");
      actions().finish({ outcome: "success" });
      return { summary: "done", interrupted: false };
    },
  };
  try {
    await run(fx.item, fx.ctx);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: WorkItem → pushed signed branch + reported result, zero orchestrator", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    brief: "## What previous runs learned\n\n- [mem-1] repo prefers small commits (preference)",
  });
  try {
    const result = await run(fx.item, fx.ctx);

    // the outcome
    assertEquals(result.status, "success");
    assert(result.status === "success");
    assertEquals(result.branches.length, 1);
    const [branch] = result.branches;
    assertEquals(branch.name, fx.branchName);
    assertEquals(branch.path, fx.item.repos[0].path);
    assertEquals(branch.commits.length, 1);

    // the branch actually landed on the origin, at the reported sha
    const originSha = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`);
    assertEquals(originSha, branch.headSha);

    // the commit carries the run-traceability trailer (D7)
    const trailer = await git(
      fx.checkoutDir,
      "log",
      "-1",
      `--format=%(trailers:key=${RUN_TRAILER},valueonly)`,
    );
    assertEquals(trailer, fx.item.id);

    // the commit is authored as the agent, and unsigned: the runner signs nothing
    assertEquals(
      await git(fx.checkoutDir, "log", "-1", "--format=%an <%ae>"),
      `${fx.item.agent.name} <${fx.item.agent.email}>`,
    );
    assertEquals(await git(fx.checkoutDir, "log", "-1", "--format=%G?"), "N");

    // the agent's work is in the commit, and it saw the brief
    const notes = await git(fx.checkoutDir, "show", "HEAD:AGENT_NOTES.md");
    assert(notes.includes(fx.item.spec.title!));
    assert(notes.includes("Brief seen: yes"));
    assert(notes.includes(`Repos in the checkout: ${fx.item.repos[0].path}`));

    // narration reached the narrator; result reported once
    assert(fx.narrator.chunks.length >= 3);
    assertEquals(orchestrator.results.length, 1);
    const phases = orchestrator.progressReports.map((p) => p.phase);
    for (const phase of ["cloning", "preparing", "setting-up", "running", "finalizing"]) {
      assert(phases.includes(phase as (typeof phases)[number]), `missing phase: ${phase}`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("an unattended work item reaches the harness as unattended, and only then", async () => {
  for (const unattended of [true, false]) {
    const fx = await makeRunFixture(fakeOrchestratorGateway());
    let seen: boolean | undefined;
    fx.ctx.harness = {
      run(input) {
        seen = input.unattended;
        return Promise.resolve({ summary: "done", interrupted: false });
      },
    };
    try {
      await run(unattended ? { ...fx.item, unattended: true } : fx.item, fx.ctx);
      assertEquals(seen, unattended ? true : undefined);
    } finally {
      await fx.cleanup();
    }
  }
});

test("a run that may not open patches ships nothing, and its record says so", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  let actions: RunActions | undefined;
  try {
    const result = await run(
      { ...fx.item, canOpenPatches: false },
      { ...fx.ctx, onActions: (a) => (actions = a) },
    );

    // The agent changed the tree, and none of it left the box.
    // The echo agent declares no outcome, so with nothing shipped the run is a failure, and its
    // record names what was not shipped.
    assertEquals(result.branches, []);
    assert(result.status === "failure", result.status);
    assert(result.summary?.includes("may not open patches"), result.summary);
    let pushed = true;
    await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`).catch(() => {
      pushed = false;
    });
    assertEquals(pushed, false);

    // And a submit is refused outright.
    assertEquals(await actions!.submitPatch({}), {
      kind: "refused",
      reason: "this agent may not open patches",
    });
  } finally {
    await fx.cleanup();
  }
});

test("the browser's answer reaches the harness: its tools when ready, a note when it failed", async () => {
  for (
    const [state, expect] of [
      [
        {
          kind: "ready",
          tools: { url: "http://127.0.0.1:7490/mcp", tokenEnv: "RYPH_BROWSER_TOKEN" },
        },
        "ready",
      ],
      [{ kind: "failed", reason: "never answered" }, "failed"],
    ] as const
  ) {
    const orchestrator = fakeOrchestratorGateway();
    const fx = await makeRunFixture(orchestrator);
    const actions = bindActions(fx);
    let seen: HarnessInput | undefined;
    fx.ctx.harness = {
      run(input) {
        seen = input;
        actions().reportOutcome({ outcome: "no-changes" });
        return Promise.resolve({ summary: "looked", interrupted: false });
      },
    };
    try {
      const result = await run(
        { ...fx.item, browser: { port: 7490 } },
        { ...fx.ctx, browser: { ready: Promise.resolve(state) } },
      );
      // Never the run's outcome, either way.
      assertEquals(result.status, "success");
      assertEquals(seen!.browser, expect);
      assertEquals(
        seen!.tools?.browser,
        state.kind === "ready" ? state.tools : undefined,
      );
    } finally {
      await fx.cleanup();
    }
  }

  // No browser on the run: the harness hears nothing about one.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  let seen: HarnessInput | undefined;
  fx.ctx.harness = {
    run(input) {
      seen = input;
      return Promise.resolve({ summary: "looked", interrupted: false });
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(seen!.browser, undefined);
    assertEquals(seen!.tools?.browser, undefined);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a declared no-changes run succeeds without a branch", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    run() {
      actions().reportOutcome({ outcome: "no-changes" });
      return Promise.resolve({
        summary: "Triaged the issues; the code needed nothing.",
        interrupted: false,
      });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "success");
    assertEquals(result.branches, []);
    // nothing reached the origin
    const heads = await git(
      fx.originUrl,
      "for-each-ref",
      "refs/heads",
      "--format=%(refname:short)",
    );
    assert(!heads.includes(fx.branchName), `unexpectedly pushed: ${heads}`);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: a declared failure still ships its commits, as a failure", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    async run(input) {
      await writeFile(
        `${input.checkoutDir}/${input.repos[0].path}/HALF_DONE.md`,
        "got partway\n",
      );
      actions().reportOutcome({ outcome: "failed" });
      return { summary: "could not finish", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(result.reason, "agent reported failure");
    assertEquals(result.branches.length, 1, "the half-done work must still report its branch");
    // and the branch genuinely landed on the origin
    const originSha = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`);
    assertEquals(originSha, result.branches[0].headSha);
  } finally {
    await fx.cleanup();
  }
});

test("e2e: commits win over a no-changes claim — the work ships as a success", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    async run(input) {
      await writeFile(
        `${input.checkoutDir}/${input.repos[0].path}/NOTES.md`,
        "changed after all\n",
      );
      actions().reportOutcome({ outcome: "no-changes" });
      return { summary: "nothing needed... mostly", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "success");
    assertEquals(result.branches.length, 1, "shipped commits must report their branch");
    const originSha = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`);
    assertEquals(originSha, result.branches[0].headSha);
  } finally {
    await fx.cleanup();
  }
});

test("an interrupted run stays cancelled no matter what it declared", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    run() {
      actions().reportOutcome({ outcome: "no-changes" });
      return Promise.resolve({ summary: "was told to stop", interrupted: true });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "cancelled");
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("a declared success with nothing to ship is a success: not every task changes code", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    run() {
      actions().reportOutcome({ outcome: "success" });
      return Promise.resolve({ summary: "all done", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "success");
    assertEquals(result.branches, []);
    assertEquals(result.summary, "all done");
  } finally {
    await fx.cleanup();
  }
});

test("a person's finish ends the run as a success with its branch, after the turn settles", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  // A clock long enough that only the finish can end the run.
  fx.item.lifetime = { idleMs: 60_000, attendedIdleMs: 60_000 };
  const actions = bindActions(fx);
  let queued: InboundMessage[] = [];
  let wake: (() => void) | null = null;
  fx.ctx.inbox = {
    poll: (after, { signal }) =>
      new Promise((resolve) => {
        const flush = () => {
          wake = null;
          signal.removeEventListener("abort", flush);
          const due = queued.filter((m) => m.seq > after);
          queued = [];
          resolve(due);
        };
        wake = flush;
        signal.addEventListener("abort", flush, { once: true });
        if (queued.length > 0 || signal.aborted) flush();
      }),
  };
  let doneBeforeSettle: boolean | null = null;
  fx.ctx.harness = {
    async run(_input, io) {
      await writeFile(join(fx.checkoutDir, "fix.txt"), "fixed\n");
      actions().reportOutcome({ outcome: "success", summary: "fixed it", awaitingUserTurn: true });
      // The person finishes while the agent is still in its turn.
      queued.push({
        seq: 0,
        kind: "system",
        sender: { kind: "user", userId: "u-1" },
        text: "Finished the run.",
        payload: { kind: "finish" },
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      wake?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      doneBeforeSettle = io.conversation.done.aborted;
      io.conversation.onSettled();
      await new Promise<void>((resolve) => {
        if (io.conversation.done.aborted) return resolve();
        io.conversation.done.addEventListener("abort", () => resolve(), { once: true });
      });
      return { summary: "the harness's word", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(doneBeforeSettle, false, "the turn was not cut off");
    assert(result.status === "success");
    assertEquals(result.branches.length, 1);
    assertEquals(result.summary, "fixed it");
    // The outcome the agent declared rode its beats, which is what the run page offered on.
    assert(orchestrator.progressReports.some((p) => p.declaredOutcome === "success"));
    // A person's finish is not the agent's: no beat says the agent finished.
    assert(!orchestrator.progressReports.some((p) => p.finished === true));
    // And the history says a person ended the run.
    assert(
      fx.narrator.chunks.some((c) =>
        c.chunk.kind === "system" && c.chunk.text === "finished" &&
        (c.chunk.raw as { by?: string } | undefined)?.by === "person"
      ),
    );
  } finally {
    await fx.cleanup();
  }
});

test("a message after the agent's outcome clears it on the beats, and the run still concludes on it", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  // Short, so the clock ends the run once the agent settles the second time.
  fx.item.lifetime = { idleMs: 200, attendedIdleMs: 200 };
  const actions = bindActions(fx);
  let queued: InboundMessage[] = [];
  let wake: (() => void) | null = null;
  fx.ctx.inbox = {
    poll: (after, { signal }) =>
      new Promise((resolve) => {
        const flush = () => {
          wake = null;
          signal.removeEventListener("abort", flush);
          const due = queued.filter((m) => m.seq > after);
          queued = [];
          resolve(due);
        };
        wake = flush;
        signal.addEventListener("abort", flush, { once: true });
        if (queued.length > 0 || signal.aborted) flush();
      }),
  };
  fx.ctx.harness = {
    async run(_input, io) {
      await writeFile(join(fx.checkoutDir, "fix.txt"), "fixed\n");
      actions().reportOutcome({ outcome: "success", summary: "fixed it", awaitingUserTurn: true });
      io.conversation.onSettled();
      // A person asks for more: a new turn, in which the agent says nothing about the outcome.
      queued.push({
        seq: 0,
        kind: "user",
        sender: { kind: "user", userId: "u-1" },
        text: "also do X",
        payload: null,
        attachments: [],
        createdAt: new Date().toISOString(),
      });
      wake?.();
      await io.conversation.messages[Symbol.asyncIterator]().next();
      io.conversation.onSettled();
      await new Promise<void>((resolve) => {
        if (io.conversation.done.aborted) return resolve();
        io.conversation.done.addEventListener("abort", () => resolve(), { once: true });
      });
      return { summary: "the harness's word", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    // How the run concludes is the agent's last word, which no message takes back.
    assert(result.status === "success");
    assertEquals(result.summary, "fixed it");
    // What the page offers a finish on is cleared once the agent acts on something new.
    assertEquals(
      orchestrator.progressReports.filter((p) => p.declaredOutcome !== undefined)
        .map((p) => p.declaredOutcome),
      ["success", null],
    );
  } finally {
    await fx.cleanup();
  }
});

test("no outcome and nothing to ship is a failure: the run's completion went unclaimed", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.harness = {
    run() {
      return Promise.resolve({ summary: "looked around", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(
      result.reason,
      "run completed without producing any changes or declaring an outcome",
    );
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("a run its idle clock ended, unreported and empty, fails saying so", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.harness = {
    async run(_input, io) {
      io.conversation.onSettled();
      // The fixture's clock is zero: the settle lapses it at once.
      await new Promise<void>((resolve) => {
        if (io.conversation.done.aborted) return resolve();
        io.conversation.done.addEventListener("abort", () => resolve(), { once: true });
      });
      return { summary: "looked around", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(result.reason, "ended on its idle clock without reporting an outcome");
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("a declared failure with nothing to ship fails in the agent's own words", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    run() {
      actions().reportOutcome({ outcome: "failed" });
      return Promise.resolve({ summary: "gave up", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(result.reason, "agent reported failure");
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

/** Settles once and waits out the fixture's zero idle clock: the run ends on it, as an agent's
 * that stopped to wait and heard nothing. */
async function settleIntoIdle(conversation: HarnessConversation): Promise<void> {
  conversation.onSettled();
  await new Promise<void>((resolve) => {
    if (conversation.done.aborted) return resolve();
    conversation.done.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("an idle end after an in-progress report fails as unfinished, not as the agent failing", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    async run(_input, io) {
      assertEquals(
        actions().reportOutcome({ outcome: "in-progress", summary: "waiting on checks" }),
        true,
      );
      await settleIntoIdle(io.conversation);
      return { summary: "waiting on checks", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(
      result.reason,
      "ended on its idle clock while the agent's work was still in progress",
    );
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("an idle end after an in-progress report still ships its commits, as a failure", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    async run(input, io) {
      await writeFile(
        `${input.checkoutDir}/${input.repos[0].path}/HALF_DONE.md`,
        "still fixing a check\n",
      );
      assertEquals(actions().reportOutcome({ outcome: "in-progress" }), true);
      await settleIntoIdle(io.conversation);
      return { summary: "still fixing a check", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    // Never a success: the agent never claimed the delivery, commits or not.
    assert(result.status === "failure");
    assertEquals(
      result.reason,
      "ended on its idle clock while the agent's work was still in progress",
    );
    assertEquals(result.branches.length, 1, "the unfinished work must still report its branch");
    const originSha = await git(fx.originUrl, "rev-parse", `refs/heads/${fx.branchName}`);
    assertEquals(originSha, result.branches[0].headSha);
  } finally {
    await fx.cleanup();
  }
});

test("a run that ends otherwise while in progress says so, without the idle clock", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    run() {
      actions().reportOutcome({ outcome: "in-progress" });
      return Promise.resolve({ summary: "partway", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(result.reason, "ended while the agent's work was still in progress");
    assertEquals(result.branches, []);
  } finally {
    await fx.cleanup();
  }
});

test("the latest report wins: in-progress then success ends a success, and back again a failure", async () => {
  for (
    const [reports, expected] of [
      [["in-progress", "success"], "success"],
      [["in-progress", "no-changes"], "success"],
      [["success", "in-progress"], "failure"],
    ] as const
  ) {
    const orchestrator = fakeOrchestratorGateway();
    const fx = await makeRunFixture(orchestrator);
    const actions = bindActions(fx);
    fx.ctx.harness = {
      async run(_input, io) {
        for (const outcome of reports) assertEquals(actions().reportOutcome({ outcome }), true);
        await settleIntoIdle(io.conversation);
        return { summary: "reported", interrupted: false };
      },
    };
    try {
      const result = await run(fx.item, fx.ctx);
      assertEquals(result.status, expected, reports.join(" → "));
      if (result.status === "failure") {
        assertEquals(
          result.reason,
          "ended on its idle clock while the agent's work was still in progress",
        );
      }
      assertEquals(result.branches, []);
    } finally {
      await fx.cleanup();
    }
  }
});

test("an in-progress report rides the run's beats as declaredOutcome in-progress", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  let carried: boolean | null = null;
  fx.ctx.harness = {
    run() {
      assertEquals(actions().reportOutcome({ outcome: "in-progress" }), true);
      carried = orchestrator.progressReports.some((p) =>
        p.phase === "running" && p.declaredOutcome === "in-progress"
      );
      return Promise.resolve({ summary: "partway", interrupted: false });
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(carried, true, "the report reached the control plane while the run went on");
    // A report is no finish: no beat says the agent finished.
    assert(!orchestrator.progressReports.some((p) => p.finished === true));
  } finally {
    await fx.cleanup();
  }
});

test("a run cancelled while its work was in progress is cancelled, not failed", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  const external = new AbortController();
  fx.ctx.harness = {
    async run(input, io) {
      await writeFile(`${input.checkoutDir}/${input.repos[0].path}/PARTWAY.md`, "partway\n");
      assertEquals(actions().reportOutcome({ outcome: "in-progress" }), true);
      external.abort();
      await new Promise<void>((resolve) => {
        if (io.signal.aborted) return resolve();
        io.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { summary: "was told to stop", interrupted: true };
    },
  };
  try {
    const result = await run(fx.item, { ...fx.ctx, cancelSignal: external.signal });
    assert(result.status === "cancelled", JSON.stringify(result));
    // Committed work still ships on a cancel.
    assertEquals(result.branches.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("a report after the agent's own finish is refused, and the run ends on the finish", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  const answers: Array<boolean | "finished"> = [];
  fx.ctx.harness = {
    async run(_input, io) {
      assert(actions().finish({ outcome: "no-changes", summary: "nothing needed" }));
      for (const outcome of ["in-progress", "failed"] as const) {
        answers.push(actions().reportOutcome({ outcome, summary: "changed my mind" }));
      }
      await settleIntoIdle(io.conversation);
      return { summary: "the harness's word", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(answers, ["finished", "finished"]);
    assert(result.status === "success", JSON.stringify(result));
    assertEquals(result.branches, []);
    assertEquals(result.summary, "nothing needed");
    // Nothing the refused reports said reached the control plane.
    assert(!orchestrator.progressReports.some((p) => p.declaredOutcome === "in-progress"));
    assert(!orchestrator.progressReports.some((p) => p.declaredOutcome === "failed"));
  } finally {
    await fx.cleanup();
  }
});

test("a final word without a summary never keeps the one said while work was in progress", async () => {
  for (const final of ["finish", "report"] as const) {
    const orchestrator = fakeOrchestratorGateway();
    const fx = await makeRunFixture(orchestrator);
    const actions = bindActions(fx);
    fx.ctx.harness = {
      async run(_input, io) {
        assertEquals(
          actions().reportOutcome({ outcome: "in-progress", summary: "waiting on checks" }),
          true,
        );
        if (final === "finish") assert(actions().finish({ outcome: "success" }));
        else assertEquals(actions().reportOutcome({ outcome: "success" }), true);
        await settleIntoIdle(io.conversation);
        return { summary: "Fixed it; the checks pass.", interrupted: false };
      },
    };
    try {
      const result = await run(fx.item, fx.ctx);
      assert(result.status === "success", `${final}: ${JSON.stringify(result)}`);
      // The in-progress summary described that moment; the agent's last message stands instead.
      assert(result.summary !== "waiting on checks", `${final}: ${result.summary}`);
      assertEquals(result.summary, "Fixed it; the checks pass.", final);
    } finally {
      await fx.cleanup();
    }
  }
  // ...while one in-progress report after another keeps it.
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const actions = bindActions(fx);
  fx.ctx.harness = {
    async run(_input, io) {
      assertEquals(
        actions().reportOutcome({ outcome: "in-progress", summary: "waiting on checks" }),
        true,
      );
      assertEquals(actions().reportOutcome({ outcome: "in-progress" }), true);
      await settleIntoIdle(io.conversation);
      return { summary: "the harness's word", interrupted: false };
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assert(result.status === "failure");
    assertEquals(result.summary, "waiting on checks");
  } finally {
    await fx.cleanup();
  }
});

test("a brief that will not load degrades the run to briefless, never failed", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.memory = { loadSnapshot: () => Promise.reject(new Error("memory backend is down")) };
  let seen: string | null = "never called";
  fx.ctx.harness = {
    run(input) {
      seen = input.brief;
      return Promise.resolve({ summary: "looked", interrupted: false });
    },
  };
  try {
    await run(fx.item, fx.ctx);
    assertEquals(seen, null);
    assertEquals(orchestrator.results.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("a broken narrator never gates the run (§3.4)", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.narrator = throwingNarrator();
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");
  } finally {
    await fx.cleanup();
  }
});

// The `final` mark names the message the HARNESS took its summary from — and the core can
// overrule that summary with finish's. The mark would then point at a message
// the result never repeats, and a reader folding it would delete the agent's actual last word.
test("finish's summary retracts the harness's final mark, so no message is folded away", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.item = {
    ...fx.item,
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  fx.ctx.harness = {
    run(_input, io) {
      // The pi adapter's shape: narrate the closing message, then mark it by the seq it landed at.
      const seq = io.onTranscript({ kind: "assistant", text: "the agent's own last word" });
      io.onTranscript({ kind: "final", raw: { seq } });
      actions!.finish({ outcome: "success", summary: "what finish said" });
      io.conversation.onSettled();
      return Promise.resolve({ summary: "what the closing message said", interrupted: false });
    },
  };
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success");
    assert(result.status === "success");
    // finish's words are the result's, so the closing message is NOT what the result repeats.
    assertEquals(result.summary, "what finish said");
    // The beats say the agent finished, beside the outcome it declared: the run page stops
    // offering a person the run's finish from there on.
    assert(
      orchestrator.progressReports.some((p) => p.declaredOutcome === "success" && p.finished),
    );

    const [mark, retraction, ...rest] = fx.narrator.chunks.filter((c) => c.chunk.kind === "final");
    assertEquals(rest, [], "the harness's mark, then the core's retraction, and no more");
    // The harness marked a real event, by the seq the narration came back with.
    const marked = (mark.chunk.raw as { seq: number | null }).seq;
    assertEquals(typeof marked, "number");
    assertEquals(
      fx.narrator.chunks.find((c) => c.seq === marked)?.chunk.text,
      "the agent's own last word",
    );
    // ...and the retraction names nothing. A reader resolves the two by seq and nothing else,
    // so the retraction landing LATER in the record is the whole of "the last mark wins".
    assertEquals(retraction.chunk.raw, { seq: null });
    assert(
      retraction.seq > mark.seq,
      `the retraction must be recorded after the mark it supersedes (${retraction.seq} vs ${mark.seq})`,
    );
    assert(
      fx.narrator.chunks.some((c) => c.chunk.text === "the agent's own last word"),
      "the message the retracted mark pointed at is still in the record",
    );
  } finally {
    await fx.cleanup();
  }
});

test("the run's tool access reaches the harness untouched; the core never touches it", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  const tools = {
    servers: [{ slug: "linear", name: "Linear", url: "http://gw.test/v1/mcp/run-1/linear" }],
    tokenEnv: "RYPH_MCP_TOKEN",
  };
  let seen: unknown = "never called";
  fx.ctx.harness = {
    run(input) {
      seen = input.tools;
      return Promise.resolve({ summary: "looked", interrupted: false });
    },
  };
  fx.ctx.tools = tools;
  try {
    await run(fx.item, fx.ctx);
    assertEquals(seen, tools);
  } finally {
    await fx.cleanup();
  }
});

test("preparing runs the staleness check: changed evidence is reported upstream and named in the prompt", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, {
    repoFiles: { "src/build.ts": "export const flag = '--no-lock';\n", "docs/notes.md": "notes\n" },
  });
  try {
    // The commit the claims were observed at, then a change to one claim's paths and not the other's.
    const observedAt = await git(fx.originUrl, "rev-parse", "HEAD");
    const scratch = await mkdtemp(join(tmpdir(), "runner-stale-"));
    let pushedHead = "";
    try {
      await git(scratch, "clone", "--quiet", "--", fx.originUrl, ".");
      await git(scratch, "config", "user.email", "someone@example.com");
      await git(scratch, "config", "user.name", "someone");
      await writeFile(`${scratch}/src/build.ts`, "export const flag = '--lock';\n");
      await git(scratch, "commit", "-am", "change the flag");
      await git(scratch, "push", "--quiet", "origin", "HEAD");
      pushedHead = await git(scratch, "rev-parse", "HEAD");
    } finally {
      await rm(scratch, { recursive: true });
    }
    fx.ctx.memory = specMemoryStore({
      text:
        "## What previous runs learned\n\n- [mem-flag] The build needs --no-lock (fact)\n- [mem-docs] Docs live in docs/ (fact)",
      memoryIds: ["mem-flag", "mem-docs", "mem-gone"],
      evidence: [
        { memoryId: "mem-flag", sha: observedAt, paths: ["src/build.ts"], path: "repo" },
        { memoryId: "mem-docs", sha: observedAt, paths: ["docs/"], path: "repo" },
        // A commit this clone does not have: "cannot tell", never stale.
        {
          memoryId: "mem-gone",
          sha: "0123456789abcdef0123456789abcdef01234567",
          paths: ["src/"],
          path: "repo",
        },
        // A repo this checkout does not hold: skipped, never stale.
        { memoryId: "mem-elsewhere", sha: observedAt, paths: ["src/build.ts"], path: null },
      ],
    });
    let seen: string | null = null;
    fx.ctx.harness = {
      run(input) {
        seen = input.brief;
        return Promise.resolve({ summary: "looked", interrupted: false });
      },
    };
    await run(fx.item, fx.ctx);
    // With the commit the check diffed TO: what memory re-anchors the claim to if this run
    // confirms it.
    assertEquals(orchestrator.staleReports, [[{
      memoryId: "mem-flag",
      changedPaths: ["src/build.ts"],
      headSha: pushedHead,
    }]]);
    assert(seen !== null);
    const prompt: string = seen!;
    assert(prompt.startsWith("## What previous runs learned"));
    assert(prompt.includes("### May be outdated"));
    assert(
      prompt.includes(
        "[mem-flag] files it is evidence for changed since it was recorded: src/build.ts",
      ),
    );
    assert(!prompt.includes("[mem-docs] files"));
  } finally {
    await fx.cleanup();
  }
});

test("a brief without changed evidence rides the prompt untouched and reports nothing", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator, { repoFiles: { "a.txt": "a\n" } });
  try {
    const observedAt = await git(fx.originUrl, "rev-parse", "HEAD");
    const text = "## What previous runs learned\n\n- [mem-a] a is a (fact)";
    fx.ctx.memory = specMemoryStore({
      text,
      memoryIds: ["mem-a"],
      evidence: [{ memoryId: "mem-a", sha: observedAt, paths: ["a.txt"], path: "repo" }],
    });
    let seen: string | null = null;
    fx.ctx.harness = {
      run(input) {
        seen = input.brief;
        return Promise.resolve({ summary: "looked", interrupted: false });
      },
    };
    await run(fx.item, fx.ctx);
    assertEquals(seen, text);
    assertEquals(orchestrator.staleReports, []);
  } finally {
    await fx.cleanup();
  }
});
