// The core of the agent's subagents (core/subagents.ts) against a scripted child host: the caps,
// a message being either a steer or a continuation and never lost between the two, what a
// continuation is told, a stop and a timeout reaching the child's process, the run's end, the
// answer's cap, and which ends the agent is told of.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { capped, continuePrompt, startSubagents, type Subagents } from "../src/core/subagents.ts";
import { noopDiagnostics } from "../src/adapters/diagnostics/noop.ts";
import type {
  SubagentContext,
  SubagentHost,
  SubagentStretch,
  SubagentStretchEnd,
  SubagentStretchEvents,
  SubagentStretchRequest,
} from "../src/ports/subagents.ts";
import type { SubagentNoticeMessage, TranscriptChunk } from "../src/core/types.ts";
import {
  SUBAGENT_ANSWER_MAX_BYTES,
  SUBAGENT_MAX_RUNNING,
  SUBAGENT_MAX_STARTED,
} from "../src/ports/run_actions.ts";

const CONTEXT: SubagentContext = {
  checkoutDir: "/tmp/checkout",
  layout: "## Layout",
  machine: "## Machine",
  serviceHosts: [],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One scripted stretch: steers land while it works, `settle` ends its turn, `stop` its process. */
class FakeStretch implements SubagentStretch {
  readonly steers: string[] = [];
  settled = false;
  stopping = false;
  stops = 0;
  tool: string | null = null;
  answer = "";
  readonly ended: Promise<SubagentStretchEnd>;
  #end!: (end: SubagentStretchEnd) => void;

  constructor(readonly request: SubagentStretchRequest, readonly events: SubagentStretchEvents) {
    this.ended = new Promise((resolve) => (this.#end = resolve));
  }

  steer(prompt: string): boolean {
    if (this.settled || this.stopping) return false;
    this.steers.push(prompt);
    return true;
  }

  runningTool(): string | null {
    return this.tool;
  }

  /** The child's turn is over, with `answer` as its last message. */
  settle(answer: string) {
    this.answer = answer;
    this.settled = true;
    this.events.onSettled();
  }

  /** Its process died on its own. */
  crash(error: string) {
    this.#end({ answer: this.answer, settled: false, error });
  }

  stop(): Promise<void> {
    this.stops++;
    if (!this.stopping) {
      this.stopping = true;
      // The process tree goes a moment later, as a real one's does.
      setTimeout(() => this.#end({ answer: this.answer, settled: this.settled, error: null }), 1);
    }
    return this.ended.then(() => {});
  }
}

function fakeHost() {
  const stretches: FakeStretch[] = [];
  const sessions = new Set<string>();
  const host = {
    stretches,
    sessions,
    failNext: null as string | null,
    async start(request: SubagentStretchRequest, events: SubagentStretchEvents) {
      await tick();
      if (host.failNext !== null) {
        const why = host.failNext;
        host.failNext = null;
        throw new Error(why);
      }
      sessions.add(request.id);
      const stretch = new FakeStretch(request, events);
      stretches.push(stretch);
      return stretch;
    },
    hasSession: (id: string) => Promise.resolve(sessions.has(id)),
    closed: 0,
    close() {
      host.closed++;
      return Promise.resolve();
    },
  };
  return host satisfies SubagentHost;
}

function setup(opts: { minuteMs?: number; withHost?: boolean } = {}) {
  const host = fakeHost();
  const lanes: Array<{ lane: string; chunk: TranscriptChunk }> = [];
  const notices: SubagentNoticeMessage[] = [];
  let holds = 0;
  let context: SubagentContext | null = CONTEXT;
  const subs: Subagents = startSubagents({
    diag: noopDiagnostics(),
    ...(opts.withHost === false ? {} : { host }),
    context: () => context,
    narrate: (lane, chunk) => lanes.push({ lane, chunk }),
    notice: (message) => {
      notices.push(message);
      return true;
    },
    holdChanged: () => holds++,
    minuteMs: opts.minuteMs ?? 60_000,
    stopAllBoundMs: 2_000,
  });
  return {
    host,
    subs,
    lanes,
    notices,
    holds: () => holds,
    setContext: (c: SubagentContext | null) => (context = c),
    kinds: (lane: string) => lanes.filter((l) => l.lane === lane).map((l) => l.chunk.kind),
  };
}

const start = (subs: Subagents, label = "look around", task = "find the retry logic") =>
  subs.start({ task, label, mode: "explore" });

test("subagents: start answers at once with sa-1; its settle is its answer, told once, in its lane", async () => {
  const { host, subs, lanes, notices, kinds } = setup();
  const started = await start(subs);
  assert(started.kind === "started");
  assertEquals(started.subagent.id, "sa-1");
  assertEquals(started.subagent.ended, null);
  assertEquals(subs.running(), 1);
  // The child got the task as is, on the run's checkout, in its mode.
  const [stretch] = host.stretches;
  assertEquals(stretch.request.prompt, "find the retry logic");
  assertEquals(stretch.request.mode, "explore");
  assertEquals(stretch.request.context, CONTEXT);
  // The lane opens with its start, carrying what the tab lists.
  assertEquals(lanes[0].lane, "sa-1");
  assertEquals(lanes[0].chunk.kind, "subagent.start");
  assertEquals(lanes[0].chunk.text, "look around");
  assertEquals(lanes[0].chunk.raw, {
    id: "sa-1",
    label: "look around",
    mode: "explore",
    task: "find the retry logic",
  });

  // Its transcript goes to its lane, never the run's own.
  stretch.events.onTranscript({ kind: "assistant", text: "looking" });
  stretch.settle("It is in retry.ts, line 12.");
  // A settle is an end: the process is stopped.
  assertEquals(stretch.stops, 1);
  await stretch.ended;
  await tick();
  assertEquals(subs.running(), 0);
  assertEquals(kinds("sa-1"), ["subagent.start", "assistant", "subagent.end"]);
  const end = lanes.at(-1)!.chunk.raw as Record<string, unknown>;
  assertEquals(end.id, "sa-1");
  assertEquals(end.reason, "answered");
  assertEquals(end.answerChars, "It is in retry.ts, line 12.".length);
  assert(typeof end.durationMs === "number");
  assertEquals(lanes.at(-1)!.chunk.text, undefined);
  // One notice, with its answer: that is how the agent waits.
  assertEquals(notices.length, 1);
  assertEquals(notices[0].subagent.id, "sa-1");
  assertEquals(notices[0].subagent.reason, "answered");
  assertStringIncludes(notices[0].text, 'Subagent sa-1 ("look around") answered after');
  assertStringIncludes(notices[0].text, "It is in retry.ts, line 12.");
});

test("subagents: at most 4 run at once and 16 start in a run; a continuation counts toward the 4 only", async () => {
  const { host, subs } = setup();
  for (let i = 0; i < SUBAGENT_MAX_RUNNING; i++) assert((await start(subs)).kind === "started");
  const fifth = await start(subs);
  assert(fifth.kind === "refused");
  assertStringIncludes(fifth.reason, "4 subagents are already running");

  // One ends: room for one more.
  host.stretches[0].settle("one");
  await host.stretches[0].ended;
  await tick();
  assert((await start(subs)).kind === "started");
  // The ended one cannot be continued while four run: refused like a start.
  const full = await subs.message({ id: "sa-1", text: "more" });
  assert(full.kind === "refused");
  assertStringIncludes(full.reason, "already running");

  // Another ends: now the continuation fits, and is no new start.
  host.stretches[1].settle("two");
  await host.stretches[1].ended;
  await tick();
  const continued = await subs.message({ id: "sa-1", text: "more" });
  assertEquals(continued.kind, "continued");
  assertEquals(subs.running(), SUBAGENT_MAX_RUNNING);

  // Fill the run's 16 starts, ending each as it goes.
  for (const stretch of host.stretches) if (!stretch.settled) stretch.settle("done");
  await sleep(5);
  let started = 5;
  while (started < SUBAGENT_MAX_STARTED) {
    const next = await start(subs);
    assert(next.kind === "started", `start ${started + 1}`);
    host.stretches.at(-1)!.settle("done");
    await host.stretches.at(-1)!.ended;
    await tick();
    started++;
  }
  const seventeenth = await start(subs);
  assert(seventeenth.kind === "refused");
  assertStringIncludes(seventeenth.reason, "the most a run may start");
  // ...while a continuation still works.
  assertEquals((await subs.message({ id: "sa-16", text: "again" })).kind, "continued");
});

test("subagents: a message is a steer while it works, a continuation after its settle — never lost, never two processes", async () => {
  const { host, subs, lanes, kinds } = setup();
  await start(subs);
  const first = host.stretches[0];

  // While it works: a steer, written into its lane when the child hands it over.
  const steered = await subs.message({ id: "sa-1", text: "check utils too" });
  assertEquals(steered.kind, "steered");
  assertEquals(first.steers.length, 1);
  assertStringIncludes(first.steers[0], "A message from the agent that handed you your task:");
  assertStringIncludes(first.steers[0], "check utils too");
  assertEquals(kinds("sa-1"), ["subagent.start"]);
  first.events.onSteerDelivered(first.steers[0]);
  assertEquals(lanes.at(-1)!.chunk.kind, "subagent.message");
  assertEquals(lanes.at(-1)!.chunk.text, "check utils too");
  assertEquals(lanes.at(-1)!.chunk.raw, { id: "sa-1", message: "check utils too" });

  // A message sent as it settles, on the same tick: the settle wins the lock, so it continues.
  const late = subs.message({ id: "sa-1", text: "and the tests" });
  first.settle("found it");
  const outcome = await late;
  assertEquals(outcome.kind, "continued");
  // The new process started only once the old one had exited, on the same session.
  assertEquals(host.stretches.length, 2);
  assert(first.stopping);
  const second = host.stretches[1];
  assertEquals(second.request.id, "sa-1");
  assertStringIncludes(second.request.prompt, "and the tests");
  // An answered stretch needs no word on why it ended.
  assert(second.request.prompt.startsWith("A message from the agent"));
  assertEquals(kinds("sa-1"), [
    "subagent.start",
    "subagent.message",
    "subagent.end",
    "subagent.resume",
  ]);
  const resume = lanes.at(-1)!.chunk;
  assertEquals(resume.text, "and the tests");
  assertEquals(resume.raw, { id: "sa-1", message: "and the tests" });

  // Two at once to an ended subagent: the first continues it, the second steers the new stretch.
  second.settle("done");
  await second.ended;
  await tick();
  const [a, b] = await Promise.all([
    subs.message({ id: "sa-1", text: "one" }),
    subs.message({ id: "sa-1", text: "two" }),
  ]);
  assertEquals([a.kind, b.kind], ["continued", "steered"]);
  assertEquals(host.stretches.length, 3);
  assertEquals(host.stretches[2].steers.length, 1);
  assertStringIncludes(host.stretches[2].steers[0], "two");
});

test("subagents: the task, a steer and a continuation reach the lane with escapes and \\r cleaned", async () => {
  const { host, subs, lanes } = setup();
  await start(subs, "look around", "find \x1b[31mit\x1b[0m\r");
  assertEquals((lanes.at(-1)!.chunk.raw as Record<string, unknown>).task, "find it\n");
  const first = host.stretches[0];
  await subs.message({ id: "sa-1", text: "\x1b]0;title\x07check utils" });
  first.events.onSteerDelivered(first.steers[0]);
  assertEquals(lanes.at(-1)!.chunk.kind, "subagent.message");
  assertEquals(lanes.at(-1)!.chunk.raw, { id: "sa-1", message: "check utils" });
  first.settle("found it");
  await first.ended;
  await tick();
  await subs.message({ id: "sa-1", text: "and \x1b[1mthe tests\x1b[0m" });
  assertEquals(lanes.at(-1)!.chunk.kind, "subagent.resume");
  assertEquals(lanes.at(-1)!.chunk.raw, { id: "sa-1", message: "and the tests" });
});

test("subagents: a stop aborts the child's process; a continuation after it says why it ended", async () => {
  const { host, subs, notices } = setup();
  await start(subs);
  const stretch = host.stretches[0];
  stretch.tool = "bash";
  const stopped = await subs.stop("sa-1");
  assert(stopped.kind === "stopped");
  assertEquals(stopped.already, false);
  assertEquals(stretch.stops, 1);
  assertEquals(stopped.subagent.ended?.reason, "stopped");
  assertEquals(stopped.subagent.ended?.tool, "bash");
  // The agent asked for it: no notice follows.
  assertEquals(notices.length, 0);
  // Stopping it again only reports.
  const again = await subs.stop("sa-1");
  assert(again.kind === "stopped" && again.already);

  assertEquals((await subs.message({ id: "sa-1", text: "go on" })).kind, "continued");
  const prompt = host.stretches[1].request.prompt;
  assert(prompt.startsWith(
    "You were stopped by the agent that handed you your task while running `bash`.",
  ));
  assertStringIncludes(prompt, "A message from the agent that handed you your task:\n\ngo on");
});

test("subagents: a stretch past its wall clock is stopped (`timeout`), told, and continued with why", async () => {
  // A minute of 40 ms: the one-minute timeout fires fast.
  const { host, subs, notices, lanes } = setup({ minuteMs: 40 });
  await subs.start({ task: "t", label: "slow", mode: "work", timeoutMinutes: 1 });
  const stretch = host.stretches[0];
  stretch.tool = "bash";
  stretch.answer = "halfway there";
  await stretch.ended;
  await tick();
  assertEquals(stretch.stops, 1);
  assertEquals((lanes.at(-1)!.chunk.raw as { reason: string }).reason, "timeout");
  assertEquals(notices.length, 1);
  assertEquals(notices[0].subagent.reason, "timeout");
  assertStringIncludes(notices[0].text, "was stopped at its 1-minute limit while running `bash`");
  assertStringIncludes(notices[0].text, "Its last message:\n\nhalfway there");

  await subs.message({ id: "sa-1", text: "skip the slow part" });
  assert(host.stretches[1].request.prompt.startsWith(
    "You were stopped at the 1-minute limit while running `bash`.",
  ));
  await subs.stopAll();
});

test("subagents: the continue prompt says why the last stretch ended, only when it did not answer", () => {
  assertEquals(
    continuePrompt({ reason: "timeout", tool: "bash" }, 15, "hi"),
    "You were stopped at the 15-minute limit while running `bash`.\n\n" +
      "A message from the agent that handed you your task:\n\nhi",
  );
  assertEquals(
    continuePrompt({ reason: "timeout", tool: null }, 15, "hi").split("\n")[0],
    "You were stopped at the 15-minute limit.",
  );
  assertEquals(
    continuePrompt({ reason: "answered", tool: null }, 15, "hi"),
    "A message from the agent that handed you your task:\n\nhi",
  );
  assert(
    continuePrompt({ reason: "failed", tool: null }, 15, "hi").startsWith("Your last stretch"),
  );
});

test("subagents: the run's end stops every one (`run_ended`), tells nobody, and nothing new starts", async () => {
  const { host, subs, lanes, notices } = setup();
  await start(subs);
  await start(subs);
  assert(subs.holdUntil() !== null);
  await subs.stopAll();
  assertEquals(subs.running(), 0);
  assertEquals(subs.holdUntil(), null);
  assert(host.stretches.every((s) => s.stops === 1));
  const ends = lanes.filter((l) => l.chunk.kind === "subagent.end");
  assertEquals(ends.map((e) => [e.lane, (e.chunk.raw as { reason: string }).reason]), [
    ["sa-1", "run_ended"],
    ["sa-2", "run_ended"],
  ]);
  assertEquals(notices.length, 0);
  const late = await start(subs);
  assert(late.kind === "refused");
  assertStringIncludes(late.reason, "The run is ending");
  const cont = await subs.message({ id: "sa-1", text: "x" });
  assert(cont.kind === "refused");
  await subs.close();
  assertEquals(host.closed, 1);
});

test("subagents: an answer past 32 KiB is cut for the agent with a note; the lane counts all of it", async () => {
  const { host, subs, lanes, notices } = setup();
  await start(subs);
  const long = "é".repeat(30_000); // 60 000 bytes
  host.stretches[0].settle(long);
  await host.stretches[0].ended;
  await tick();
  const answer = capped(long);
  assert(answer.truncated);
  assertEquals(answer.chars, 30_000);
  assert(new TextEncoder().encode(answer.text).byteLength <= SUBAGENT_ANSWER_MAX_BYTES);
  assertStringIncludes(answer.text, "[ryph: answer truncated to its first 32 KiB of 59 KiB.");
  assertEquals((lanes.at(-1)!.chunk.raw as { answerChars: number }).answerChars, 30_000);
  // The notice carries the capped answer, not the whole.
  assertStringIncludes(notices[0].text, "[ryph: answer truncated to its first 32 KiB");
  assert(new TextEncoder().encode(notices[0].text).byteLength < 34 * 1024);
  // Under the cap, untouched.
  assertEquals(capped("short"), { text: "short", chars: 5, truncated: false });
});

test("subagents: refusals the agent reads — bad args, unknown ids, no host, no context", async () => {
  const { host, subs, setContext } = setup();
  const bad = [
    await subs.start({ task: "", label: "x", mode: "explore" }),
    await subs.start({ task: "t", label: "  ", mode: "explore" }),
    await subs.start({ task: "t", label: "x", mode: "nope" as "explore" }),
    await subs.start({ task: "t", label: "x", mode: "explore", timeoutMinutes: 61 }),
    await subs.message({ id: "sa-9", text: "x" }),
    await subs.message({ id: "../etc", text: "x" }),
    await subs.stop("sa-1"),
  ];
  assert(bad.every((b) => b.kind === "refused"));
  // An id this runner never started (one from before a restart, say) is no subagent of its.
  assertStringIncludes((bad[4] as { reason: string }).reason, "none has been started");

  setContext(null);
  const early = await start(subs);
  assert(early.kind === "refused");
  assertStringIncludes(early.reason, "not started its agent");
  setContext(CONTEXT);

  // A start the host cannot make: refused, its lane opened and closed, no notice.
  host.failNext = "no pi at /opt/ryph/bin/pi";
  const failed = await start(subs);
  assert(failed.kind === "refused");
  assertStringIncludes(failed.reason, "sa-1 could not be started: no pi at /opt/ryph/bin/pi");
  assertEquals(subs.running(), 0);

  const none = setup({ withHost: false });
  const refused = await start(none.subs);
  assert(refused.kind === "refused");
  assertStringIncludes(refused.reason, "cannot start subagents");
});

test("subagents: a running one holds the idle deadline to its wall clock, and says when that changes", async () => {
  const { host, subs, holds } = setup();
  assertEquals(subs.holdUntil(), null);
  const before = Date.now();
  await start(subs);
  const until = subs.holdUntil()!;
  assert(until >= before + 15 * 60_000);
  assert(holds() > 0);
  const seen = holds();
  host.stretches[0].settle("x");
  await host.stretches[0].ended;
  await tick();
  assertEquals(subs.holdUntil(), null);
  assert(holds() > seen);
});

test("subagents: every end the agent did not stop is one notice — answered and failed", async () => {
  const { host, subs, notices } = setup();
  await start(subs);
  await start(subs);
  host.stretches[0].settle("first");
  host.stretches[1].crash("pi exited (code 1) before answering");
  await sleep(5);
  assertEquals(notices.map((n) => [n.subagent.id, n.subagent.reason]).sort(), [
    ["sa-1", "answered"],
    ["sa-2", "failed"],
  ]);
  const failed = notices.find((n) => n.subagent.id === "sa-2")!;
  assertStringIncludes(failed.text, "failed after");
  assertStringIncludes(failed.text, "pi exited (code 1) before answering");
  // A continuation's end is told the same way.
  await subs.message({ id: "sa-1", text: "more" });
  host.stretches[2].settle("later");
  await sleep(5);
  assertEquals(notices.length, 3);
  assertStringIncludes(notices[2].text, "later");
});

test("subagents: a stop as it settles is one answer — the stop's, with what it said, and no notice", async () => {
  const { host, subs, notices } = setup();
  await start(subs);
  const stretch = host.stretches[0];
  // Settled on the same tick the stop is asked for: the settle's ending stands.
  stretch.settle("found it in retry.ts");
  const stopped = await subs.stop("sa-1");
  assert(stopped.kind === "stopped");
  assertEquals(stopped.already, true);
  assertEquals(stopped.subagent.ended?.reason, "answered");
  assertEquals(stopped.answer?.text, "found it in retry.ts");
  await sleep(5);
  assertEquals(notices.length, 0, "the stop's answer told it");

  // Stopped while it works: no answer to carry, no notice either.
  await subs.message({ id: "sa-1", text: "again" });
  const working = await subs.stop("sa-1");
  assert(working.kind === "stopped");
  assertEquals([working.already, working.answer], [false, null]);
  // Stopping one that ended earlier (and was told of): just reported.
  const again = await subs.stop("sa-1");
  assert(again.kind === "stopped" && again.already && again.answer === null);
  await sleep(5);
  assertEquals(notices.length, 0);
});

test("subagents: a start and a continuation racing for the last slot cannot make five", async () => {
  const { host, subs } = setup();
  for (let i = 0; i < SUBAGENT_MAX_RUNNING; i++) await start(subs);
  host.stretches[0].settle("one");
  await host.stretches[0].ended;
  await tick();
  // One slot free; both ask on the same tick.
  const [started, continued] = await Promise.all([
    start(subs),
    subs.message({ id: "sa-1", text: "more" }),
  ]);
  assertEquals([started.kind, continued.kind].filter((k) => k !== "refused").length, 1);
  assertEquals(subs.running(), SUBAGENT_MAX_RUNNING);
  assert(host.stretches.length <= SUBAGENT_MAX_RUNNING + 1);
  // ...and the other way round.
  host.stretches.find((st) => !st.settled && !st.stopping)!.settle("x");
  await sleep(5);
  const [c2, s2] = await Promise.all([
    subs.message({ id: "sa-2", text: "more" }),
    start(subs),
  ]);
  assertEquals([c2.kind, s2.kind].filter((k) => k !== "refused").length, 1);
  assertEquals(subs.running(), SUBAGENT_MAX_RUNNING);
});

test("subagents: a continuation with no session on disk starts a fresh one from the task", async () => {
  const { host, subs } = setup();
  await subs.start({
    task: "find the retry logic",
    label: "find",
    mode: "explore",
    timeoutMinutes: 2,
  });
  // Its first process died before pi took the task, so pi wrote no session.
  host.stretches[0].crash("pi exited (code 1) before answering");
  host.sessions.delete("sa-1");
  await sleep(5);
  const continued = await subs.message({ id: "sa-1", text: "try again" });
  assertEquals(continued.kind, "continued");
  const prompt = host.stretches[1].request.prompt;
  assert(prompt.startsWith("find the retry logic\n\nYou were working on this task before"));
  assertStringIncludes(prompt, "Your last stretch of work ended when your process failed.");
  assert(prompt.endsWith("A message from the agent that handed you your task:\n\ntry again"));
  // With its session there, the continuation is only its own.
  host.stretches[1].settle("ok");
  await sleep(5);
  await subs.message({ id: "sa-1", text: "and now" });
  assert(host.stretches[2].request.prompt.startsWith("A message from the agent"));
});
