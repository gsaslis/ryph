// A run whose task was started without instructions (core/prompt.ts): it boots, waits for its
// first message, and that message is its task.

import { test } from "bun:test";
import { stat } from "node:fs/promises";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { run } from "../src/core/run.ts";
import { awaitPrompt, promptSpec, promptSubject } from "../src/core/prompt.ts";
import type { InboundMessage } from "../src/core/types.ts";
import type { Inbox } from "../src/ports/inbox.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import { fakeOrchestratorGateway } from "./doubles/orchestrator_gateway.ts";
import { makeRunFixture } from "./util.ts";
import { git } from "../src/helpers/git_exec.ts";

function message(seq: number, text: string): InboundMessage {
  return {
    seq,
    kind: "user",
    sender: { kind: "user", userId: "u-1" },
    text,
    payload: null,
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}

/** An inbox holding `held` from the start — sent while the run was still booting — answering
 * each read with what lies past its cursor, or waiting out the read. */
function heldInbox(held: InboundMessage[], opts: { failFirst?: number } = {}) {
  const polls: number[] = [];
  let failing = opts.failFirst ?? 0;
  const inbox: Inbox = {
    poll(after, { waitMs, signal }) {
      polls.push(after);
      if (failing > 0) {
        failing--;
        return Promise.reject(new Error("the orchestrator answered 503"));
      }
      const pending = held.filter((m) => m.seq > after);
      if (pending.length > 0 || signal.aborted) return Promise.resolve(pending);
      return new Promise((resolve) => {
        const timer = setTimeout(done, waitMs);
        signal.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve([]);
        }
      });
    },
  };
  return { inbox, polls };
}

test("awaitPrompt: the first message the inbox holds is the prompt, and the deadline is reported", async () => {
  const { inbox } = heldInbox([message(1, "second"), message(0, "first")]);
  const deadlines: string[] = [];
  const waited = await awaitPrompt({
    inbox,
    idleMs: 60_000,
    signal: new AbortController().signal,
    diag: noopDiagnostics(),
    onIdleDeadline: (at) => deadlines.push(at),
    now: () => 1_000,
  });
  assertEquals(waited.kind, "prompt");
  if (waited.kind === "prompt") assertEquals(waited.message.text, "first");
  assertEquals(deadlines, [new Date(61_000).toISOString()]);
});

test("awaitPrompt: nothing arrives — idle at the deadline", async () => {
  const { inbox } = heldInbox([]);
  const waited = await awaitPrompt({
    inbox,
    idleMs: 50,
    signal: new AbortController().signal,
    diag: noopDiagnostics(),
    onIdleDeadline: () => {},
    pollWaitMs: 10,
  });
  assertEquals(waited.kind, "idle");
});

test("awaitPrompt: a cancel ends the wait", async () => {
  const { inbox } = heldInbox([]);
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 20);
  const waited = await awaitPrompt({
    inbox,
    idleMs: 60_000,
    signal: cancel.signal,
    diag: noopDiagnostics(),
    onIdleDeadline: () => {},
    pollWaitMs: 5_000,
  });
  assertEquals(waited.kind, "cancelled");
});

test("awaitPrompt: a poll that fails is asked again", async () => {
  const { inbox, polls } = heldInbox([message(0, "go")], { failFirst: 2 });
  const waited = await awaitPrompt({
    inbox,
    idleMs: 60_000,
    signal: new AbortController().signal,
    diag: noopDiagnostics(),
    onIdleDeadline: () => {},
    retryPauseMs: 1,
  });
  assertEquals(waited.kind, "prompt");
  assertEquals(polls.length, 3);
});

test("promptSpec: images the text does not mark are named after it; the subject is the first line", () => {
  const spec = promptSpec({
    text: "## Fix the login page\nit 500s on submit",
    attachments: [{ id: "att-1", mime: "image/png" }],
  });
  assertEquals(spec.title, "Fix the login page");
  assertEquals(
    spec.instructions,
    "## Fix the login page\nit 500s on submit\n\n(attached: [image 1])",
  );
  assertEquals(
    promptSpec({ text: "", attachments: [{ id: "a", mime: "image/png" }] }),
    { title: "Task", instructions: "(attached: [image 1])" },
  );
  const long = promptSubject("word ".repeat(40));
  assert(long.length <= 72 && !long.endsWith(" "), long);
});

test("run: a task without instructions boots, says it is ready, and takes its first message as the task", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  // Both were sent while the run was still booting; the first is the prompt, the second an
  // ordinary message after it.
  const { inbox, polls } = heldInbox([
    message(0, "Fix the flaky login test\nIt times out on CI."),
    message(1, "also check the signup test"),
  ]);
  fx.ctx.inbox = inbox;
  try {
    const result = await run({
      ...fx.item,
      spec: { title: null, instructions: null },
      lifetime: { idleMs: 2_000, attendedIdleMs: 300 },
    }, fx.ctx);
    assertEquals(result.status, "success");

    const notes = await git(fx.checkoutDir, "show", "HEAD:AGENT_NOTES.md");
    assertStringIncludes(
      notes,
      "# Fix the flaky login test\n\nFix the flaky login test\nIt times out on CI.",
    );
    // The prompt reached the agent as its task and only as its task; the next one as a message.
    assertEquals(notes.split("Reply: ").length - 1, 1, notes);
    assertStringIncludes(notes.slice(notes.indexOf("Reply: ")), "also check the signup test");
    assertEquals(polls.filter((after) => after === 0).length > 0, true, "the poll starts past it");
    // Leftovers are committed under the prompt's first line.
    const subject = await git(fx.checkoutDir, "log", "-1", "--format=%s", fx.branchName);
    assertEquals(subject.trim(), "Fix the flaky login test");

    // "running" is said only once the run is ready for its prompt, with the wait's deadline.
    const running = orchestrator.progressReports.filter((p) => p.phase === "running");
    assert(running.length > 0);
    assert(typeof running[0].idleDeadlineAt === "string", "ready = running with a deadline");
    assertEquals(running[1]?.idleDeadlineAt, null, "the deadline clears when the agent starts");
    assertEquals(running[0].idleState, "waiting-for-user");
    assertEquals(running[1]?.idleState, null);
  } finally {
    await fx.cleanup();
  }
});

test("run: a task nobody prompts ends at its idle deadline without starting the agent", async () => {
  const orchestrator = fakeOrchestratorGateway();
  const fx = await makeRunFixture(orchestrator);
  fx.ctx.inbox = heldInbox([]).inbox;
  try {
    const result = await run({
      ...fx.item,
      spec: { title: null, instructions: null },
      // The wait is on the attended clock: the unattended one would outlast the test.
      lifetime: { idleMs: 60 * 60_000, attendedIdleMs: 100 },
    }, fx.ctx);
    assertEquals(result.status, "cancelled");
    assertEquals(result.branches, []);
    if (result.status === "cancelled") {
      assertStringIncludes(result.summary, "No instructions arrived");
    }
    assertEquals(orchestrator.results.length, 1);
    // The agent never ran: nothing it would have written is there.
    const wrote = await stat(`${fx.checkoutDir}/AGENT_NOTES.md`).then(() => true, () => false);
    assertFalse(wrote);
  } finally {
    await fx.cleanup();
  }
});
