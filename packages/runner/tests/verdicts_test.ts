// A run held for its checks' verdicts, through `run`, against a scripted inbox and a hand-set list
// of verdicts still owed: a stop owed a verdict outlasts its idle clock for it; a finish owed one
// is held, handed it, then ends; a finish owed nothing ends at once; a cancel while held ends the
// run at once; a submit holds only where the agent was told of checks. And the hold's give-up by
// name: what `checksOwed` says a stop waits for is what the next settle holds for, so the finish
// reply never says a run ends when it waits, or the reverse.

import { test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { InboundMessage } from "../src/core/types.ts";
import type { Inbox } from "../src/ports/inbox.ts";
import type { ChecksChannel, OwedVerdict } from "../src/ports/checks.ts";
import type { RunActions } from "../src/ports/run_actions.ts";
import type { HarnessConversation } from "../src/ports/harness.ts";
import { run } from "../src/core/run.ts";
import { git } from "../src/helpers/git_exec.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string): Promise<void> {
  // Generous: what is waited for includes the run's setup, slow on a loaded machine.
  const deadline = Date.now() + 30_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const VERDICT = "Checks on repo at abc1234567: FAILED.\n- test: FAILED (exit 1)";

const verdict = (seq: number): InboundMessage => ({
  seq,
  kind: "system",
  sender: { kind: "platform" },
  text: VERDICT,
  payload: null,
  attachments: [],
  createdAt: "2026-09-30T00:00:00.000Z",
});

/** An inbox the test feeds: each poll answers what was queued past the cursor, or waits. */
function scriptedInbox() {
  const queued: InboundMessage[] = [];
  const polls: number[] = [];
  let wake: (() => void) | null = null;
  const inbox: Inbox = {
    async poll(after, { waitMs, signal }) {
      polls.push(after);
      const pending = () => queued.filter((m) => m.seq > after);
      if (pending().length === 0 && !signal.aborted && waitMs > 0) {
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
    polls,
    push(m: InboundMessage) {
      queued.push(m);
      wake?.();
    },
  };
}

/** A checks channel: every request owes one more suite, and the test settles them by name. */
function fakeChecks() {
  const state = { owed: [] as OwedVerdict[], counts: 0, requests: 0 };
  const channel: ChecksChannel = {
    request() {
      state.requests++;
      state.owed.push({ id: `cs-${state.requests}@1`, requests: [`cq-${state.requests}`] });
      return Promise.resolve({ requested: true, text: "Suite queued: test." });
    },
    status: () => Promise.resolve("Suite running."),
    log: () => Promise.reject(new Error("unused")),
    awaiting() {
      state.counts++;
      return Promise.resolve([...state.owed]);
    },
    declared: () => Promise.resolve({ declared: [], unread: [] }),
  };
  return { channel, state };
}

async function commit(dir: string, file: string) {
  await writeFile(`${dir}/${file}`, `${file}\n`);
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=ada", "-c", "user.email=ada@runner.local", "commit", "-m", file);
}

/**
 * A harness that plays the agent: commits, maybe asks for checks or submits, maybe finishes,
 * and stops; then answers every message with one more settle, keeping what it read.
 */
function agent(
  opts: { askChecks: boolean; submit?: boolean; finish?: boolean; actions: () => RunActions },
) {
  const turns: string[][] = [];
  let handed: HarnessConversation | undefined;
  const harness = {
    async run(
      input: { checkoutDir: string },
      io: { signal: AbortSignal; conversation?: HarnessConversation },
    ) {
      handed = io.conversation;
      await commit(`${input.checkoutDir}/repo`, "fix.txt");
      if (opts.askChecks) {
        assertEquals((await opts.actions().runChecks({})).kind, "requested");
      }
      if (opts.submit === true) {
        const submitted = await opts.actions().submitPatch({});
        assertEquals(submitted.kind, "submitted", JSON.stringify(submitted));
      }
      if (opts.finish === true) {
        assertEquals(opts.actions().finish({ outcome: "success", summary: "fixed it" }), true);
      }
      turns.push([]);
      const conversation = io.conversation!;
      conversation.onSettled();
      for await (const message of conversation.messages) {
        if (io.signal.aborted) break;
        turns.push([message.text]);
        conversation.onSettled();
      }
      if (io.signal.aborted) return { summary: "stopped", interrupted: true };
      return { summary: "done", interrupted: false };
    },
  };
  return { harness, turns, handed: () => handed };
}

async function fixture(
  opts: { askChecks: boolean; finish?: boolean; submit?: boolean; idleMs?: number },
) {
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  const idleMs = opts.idleMs ?? 50;
  fx.item = {
    ...fx.item,
    repos: fx.item.repos.map((r) => ({ ...r, connectedRepoId: "cr-1" })),
    lifetime: { idleMs, attendedIdleMs: idleMs },
  };
  fx.ctx.patchReporter = {
    reportPatch: () =>
      Promise.resolve({
        patchId: "p-1",
        state: "pending_approval",
        url: null,
      }),
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  const checks = fakeChecks();
  fx.ctx.checks = checks.channel;
  // Past any test's timeout: these holds end by a verdict or a cancel, never by giving up.
  fx.ctx.checksHold = { maxWaitMs: 10 * 60_000, checkEveryMs: 10 };
  const box = scriptedInbox();
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const played = agent({ ...opts, actions: () => actions! });
  fx.ctx.harness = played.harness as unknown as typeof fx.ctx.harness;
  return { fx, checks, box, played, actions: () => actions! };
}

test("run: a stop owed a verdict outlasts its idle clock for it", async () => {
  const { fx, checks, box, played } = await fixture({ askChecks: true });
  try {
    const running = run(fx.item, fx.ctx);
    await until(() => checks.state.counts > 0, "the settle to be held");
    await sleep(150); // three idle clocks
    assertEquals(played.turns.length, 1, "still held, not idled out");
    assert(played.handed() !== undefined);
    checks.state.owed = [];
    box.push(verdict(0));
    const result = await running; // then its ordinary idle clock ends it
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(played.turns.length, 2);
    assertStringIncludes(played.turns[1][0], VERDICT);
    assert(
      fx.narrator.chunks.some((c) =>
        c.chunk.kind === "inbound" && (c.chunk.text ?? "").includes(VERDICT)
      ),
      "the verdict is on the record",
    );
  } finally {
    await fx.cleanup();
  }
});

test("run: a finish owed a verdict is held, handed it, then ends", async () => {
  const { fx, checks, box, played } = await fixture({ askChecks: true, finish: true });
  try {
    const running = run(fx.item, fx.ctx);
    await until(() => checks.state.counts > 0, "the finish to be held");
    await sleep(100); // past the idle clock too
    assertEquals(played.turns.length, 1, "held after the finish");
    checks.state.owed = [];
    box.push(verdict(0));
    const result = await running;
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(played.turns.length, 2);
    assertStringIncludes(played.turns[1][0], VERDICT);
    // It read a verdict and stopped: what its finish said stands.
    assert(result.status === "success");
    assertEquals(result.summary, "fixed it");
  } finally {
    await fx.cleanup();
  }
});

test("run: a finish owed nothing ends at once", async () => {
  // A clock no test waits out: only the finish can end this run in time.
  const { fx, checks, played } = await fixture({ askChecks: false, finish: true, idleMs: 60_000 });
  try {
    const result = await run(fx.item, fx.ctx);
    assertEquals(result.status, "success", JSON.stringify(result));
    assert(result.status === "success");
    assertEquals(result.summary, "fixed it");
    assertEquals(played.turns.length, 1);
    assertEquals(checks.state.counts, 0, "nothing caused, nothing asked");
  } finally {
    await fx.cleanup();
  }
});

test("run: a cancel while a finish is held ends the run at once, cancelled", async () => {
  const { fx, checks, played } = await fixture({ askChecks: true, finish: true });
  const cancel = new AbortController();
  fx.ctx.cancelSignal = cancel.signal;
  try {
    const running = run(fx.item, fx.ctx);
    await until(() => checks.state.counts > 0, "the hold");
    // The hold outlasts the test's timeout: a run that returns at all was ended by the cancel.
    cancel.abort();
    const result = await running;
    assertEquals(result.status, "cancelled", JSON.stringify(result));
    assertEquals(played.turns.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("run: a submit holds only where the agent was told of checks", async () => {
  const declared = [{
    path: "repo",
    repoRef: "acme/repo",
    checksRef: "main",
    setup: [],
    checks: [{ name: "lint", run: "npm run lint", timeoutSeconds: 600, services: [] }],
  }];
  const patchSuite = { id: "cs-p@1", requests: ["cq-p"] };
  // No repo declares checks: the patch's own pending ask is no reason to hold the run.
  {
    const { fx, checks, played } = await fixture({
      askChecks: false,
      submit: true,
      finish: true,
      idleMs: 60_000,
    });
    checks.state.owed = [patchSuite];
    try {
      const result = await run(fx.item, fx.ctx);
      assertEquals(result.status, "success", JSON.stringify(result));
      assertEquals(played.turns.length, 1);
      assertEquals(checks.state.counts, 0, "never asked what is owed");
    } finally {
      await fx.cleanup();
    }
  }
  // Told of checks: the patch's suite is waited for, as a run_checks is.
  {
    const { fx, checks, box, played } = await fixture({
      askChecks: false,
      submit: true,
      finish: true,
      idleMs: 60_000,
    });
    checks.channel.declared = () => Promise.resolve({ declared, unread: [] });
    checks.state.owed = [patchSuite];
    try {
      const running = run(fx.item, fx.ctx);
      await until(() => checks.state.counts > 0, "the hold");
      checks.state.owed = [];
      box.push(verdict(0));
      const result = await running;
      assertEquals(result.status, "success", JSON.stringify(result));
      assertEquals(played.turns.length, 2);
      assertStringIncludes(played.turns[1][0], VERDICT);
    } finally {
      await fx.cleanup();
    }
  }
});

test("run: stuck suites that report late never hide a later ask's verdict", async () => {
  // The finish reply and the hold agree: `checksOwed` says the finish waits exactly when the
  // settle after it holds.
  const fx = await makeRunFixture(fakeOrchestratorGateway());
  fx.item = {
    ...fx.item,
    repos: fx.item.repos.map((r) => ({ ...r, connectedRepoId: "cr-1" })),
    lifetime: { idleMs: 60_000, attendedIdleMs: 60_000 },
  };
  fx.ctx.patchReporter = {
    reportPatch: () =>
      Promise.resolve({
        patchId: "p-1",
        state: "pending_approval",
        url: null,
      }),
    claimChangeRequest: () => Promise.reject(new Error("unused")),
  };
  const checks = fakeChecks();
  fx.ctx.checks = checks.channel;
  fx.ctx.checksHold = { maxWaitMs: 500, checkEveryMs: 10 };
  const box = scriptedInbox();
  fx.ctx.inbox = box.inbox;
  let actions: RunActions | null = null;
  fx.ctx.onActions = (a) => (actions = a);
  const heard: string[] = [];
  const owedSeen: unknown[] = [];
  const heldFinish = Promise.withResolvers<void>();
  fx.ctx.diag = {
    ...fx.ctx.diag,
    debug(event, fields) {
      if (event === "conversation.held_for_verdict" && fields?.finished === true) {
        heldFinish.resolve();
      }
    },
  };
  fx.ctx.harness = {
    async run(input, io) {
      const dir = `${input.checkoutDir}/repo`;
      const conversation = io.conversation!;
      await commit(dir, "a.txt");
      // Two suites, which will not report before the bound.
      assertEquals((await actions!.runChecks({})).kind, "requested");
      assertEquals((await actions!.runChecks({ checks: ["lint"] })).kind, "requested");
      owedSeen.push(await actions!.checksOwed());
      conversation.onSettled();
      for await (const message of conversation.messages) {
        heard.push(message.text);
        if (heard.length === 1) {
          // The late note. Then both stuck suites report, as a message.
          owedSeen.push(await actions!.checksOwed());
          checks.state.owed = [];
          box.push(verdict(0));
        } else if (heard.length === 2) {
          // The late verdicts. The agent fixes something and asks again.
          await commit(dir, "b.txt");
          assertEquals((await actions!.runChecks({})).kind, "requested");
          owedSeen.push(await actions!.checksOwed());
          actions!.finish({ outcome: "success", summary: "done" });
        }
        conversation.onSettled();
      }
      return { summary: "done", interrupted: false };
    },
  };
  try {
    const running = run(fx.item, fx.ctx);
    // Observe this finish's hold, not reads made for the earlier asks. Deliver its verdict
    // immediately, without racing a sleep against the hold's give-up deadline.
    await heldFinish.promise;
    assertEquals(heard.length, 2, "held for the new suite, not ended");
    // Its verdict arrives: handed over, and then the finish ends the run.
    checks.state.owed = [];
    box.push(verdict(1));
    const result = await running;
    assertEquals(result.status, "success", JSON.stringify(result));
    assertEquals(owedSeen, [
      { owed: 2, waits: true },
      { owed: 2, waits: false },
      { owed: 1, waits: true },
    ]);
    assertEquals(heard.length, 3);
    assertStringIncludes(heard[0], "did not report a verdict in time");
    assertStringIncludes(heard[2], VERDICT);
    assertEquals(
      heard.filter((h) => h.includes("did not report a verdict in time")).length,
      1,
      "one late note, for the one give-up",
    );
  } finally {
    await fx.cleanup();
  }
});
