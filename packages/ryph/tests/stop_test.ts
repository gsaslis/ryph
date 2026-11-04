// What `ryph up` says and asks on its way down, with the terminal scripted and the host's side
// of the stop faked. The host's cancel-and-wait is its own; asserted here is who gets asked, what
// they are shown, and what each answer — including a second Ctrl-C — turns into.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { StopContext } from "@ryph/host";
import type { Prompter } from "../src/prompt.ts";
import { age, onStop } from "../src/stop.ts";

const NOW = new Date("2026-09-11T12:00:00Z");

/** A scripted selection, or a question nobody answers. */
function prompter(
  answer: boolean | "keep-running" | "never",
): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const unused = () => Promise.reject(new Error("only select is asked"));
  return {
    asked,
    say: () => {},
    heading: () => {},
    ask: unused,
    secret: unused,
    confirm: unused,
    select(question, choices, defaultIndex) {
      asked.push([question, ...choices.map((c) => c.label)].join("\n"));
      assert(choices[defaultIndex ?? 0].value === "keep-running");
      if (answer === "never") return new Promise(() => {});
      const value = answer === true ? "cancel-runs" : answer === false ? "leave-runs" : answer;
      const choice = choices.find((c) => c.value === value);
      assert(choice);
      return Promise.resolve(choice.value);
    },
  };
}

function context(overrides: Partial<StopContext> = {}) {
  const cancelled: number[] = [];
  const interrupt = new AbortController();
  const ctx: StopContext = {
    signal: "SIGINT",
    runs: [
      { id: "r1", title: "fix flaky test", agent: "pi", createdAt: "2026-09-11T11:56:00Z" },
      { id: "r2", title: "bump deps", agent: "pi", createdAt: "2026-09-11T11:59:20Z" },
    ],
    hostedServers: ["Grafana"],
    heartbeatTimeoutMs: 60_000,
    cancelRuns: (onProgress) => {
      cancelled.push(1);
      onProgress?.(2);
      onProgress?.(0);
      return Promise.resolve(0);
    },
    interrupted: interrupt.signal,
    ...overrides,
  };
  return { ctx, cancelled, interrupt };
}

async function run(ctx: StopContext, p: Prompter | null) {
  const said: string[] = [];
  await onStop(ctx, { prompter: p, say: (t) => said.push(t), now: () => NOW });
  return said.join("\n");
}

test("Ctrl-C with runs going lists them, asks, and cancels when selected", async () => {
  const { ctx, cancelled } = context();
  const p = prompter(true);
  const out = await run(ctx, p);
  assert(out.includes("2 runs still going:"));
  assert(out.includes("fix flaky test · pi · 4 min"));
  assert(out.includes("bump deps · pi · 40 s"));
  assertEquals(p.asked.length, 1);
  assert(p.asked[0].includes("Cancel them, then exit"));
  assertEquals(cancelled.length, 1);
  assert(out.includes("waiting for 2 runs to wrap up"));
  assert(out.includes("✓ cancelled 2 runs"));
  // Hosted servers are told about, never asked about.
  assert(out.includes("stopping 1 hosted tool server: Grafana"));
});

test("exit without cancelling leaves the runs, and says how long they can survive", async () => {
  const { ctx, cancelled } = context();
  const out = await run(ctx, prompter(false));
  assertEquals(cancelled.length, 0);
  assert(out.includes("leaving 2 runs running"));
  assert(out.includes("within 60 s"));
});

test("a second Ctrl-C at the question leaves the runs and lets the stop go on", async () => {
  const { ctx, cancelled, interrupt } = context();
  const stopping = run(ctx, prompter("never"));
  await new Promise((r) => setTimeout(r, 5));
  interrupt.abort();
  const out = await stopping;
  assertEquals(cancelled.length, 0);
  assert(out.includes("leaving 2 runs running"));
});

test("a second Ctrl-C while waiting says what was left behind", async () => {
  const { ctx } = context({ cancelRuns: () => Promise.resolve(1) });
  const out = await run(ctx, prompter(true));
  assert(out.includes("stopped waiting — 1 run still going"));
});

test("nobody at the terminal, or a SIGTERM: nothing is asked, the runs are left", async () => {
  for (const [p, signal] of [[null, "SIGINT"], [prompter(true), "SIGTERM"]] as const) {
    const { ctx, cancelled } = context({ signal });
    const out = await run(ctx, p);
    assertEquals(cancelled.length, 0);
    assert(out.includes("leaving 2 runs running"), signal);
    if (p !== null) assertEquals(p.asked, []);
  }
});

test("no runs: nothing is asked, and only the hosted servers are mentioned", async () => {
  const p = prompter(true);
  const out = await run(context({ runs: [] }).ctx, p);
  assertEquals(p.asked, []);
  assertEquals(out, "  stopping 1 hosted tool server: Grafana");
  assertEquals(await run(context({ runs: [], hostedServers: [] }).ctx, p), "");
});

test("one run is 'it', not 'them'", async () => {
  const { ctx } = context();
  const p = prompter(true);
  await run({ ...ctx, runs: ctx.runs.slice(0, 1) }, p);
  assert(p.asked[0].includes("Cancel it, then exit"));
});

test("keep running cancels shutdown without cancelling runs or stopping hosted servers", async () => {
  const { ctx, cancelled } = context();
  const said: string[] = [];
  const result = await onStop(ctx, {
    prompter: prompter("keep-running"),
    say: (t) => said.push(t),
    now: () => NOW,
  });
  assertEquals(result, "keep-running");
  assertEquals(cancelled, []);
  assert(said.some((t) => t.includes("Shutdown cancelled")));
  assert(!said.some((t) => t.includes("stopping") || t.includes("leaving")));
});

test("age reads in the unit a person would use", () => {
  assertEquals(age(NOW, "2026-09-11T11:59:58Z"), "2 s");
  assertEquals(age(NOW, "2026-09-11T11:15:00Z"), "45 min");
  assertEquals(age(NOW, "2026-09-11T09:55:00Z"), "2 h 5 min");
});
