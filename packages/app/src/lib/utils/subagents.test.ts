import { describe, expect, it } from "vitest";
import type { LaneSummary } from "$lib/api/history";
import type { ToolCall } from "$lib/api/tools";
import type { HistoryEvent } from "$lib/api/types";
import {
  laneMarkOf,
  laneRunning,
  pickSubagent,
  subagentCallOf,
  subagentNoticeOf,
  subagentsOf,
  subagentStatus,
  withLane,
} from "./subagents";

// How a subagent reads in the tab and the transcript: its standing off the historian's listing,
// the marks in its lane, the agent's calls that name it, and when the page reads the list again.

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1_000).toISOString();

function laneEvent(
  lane: string,
  seq: number,
  kind: string,
  payload: unknown,
  s = seq,
): HistoryEvent {
  return {
    runId: "run-1",
    lane,
    seq,
    at: at(s),
    voice: "transcript",
    kind,
    level: null,
    text: null,
    payload,
  };
}

const start = (lane: string, label = "Find callers", mode = "explore") =>
  laneEvent(lane, 1, "subagent.start", { id: lane, label, mode, task: "Find every caller." }, 0);
const resume = (lane: string, seq: number, s: number) =>
  laneEvent(lane, seq, "subagent.resume", { id: lane, message: "Now the tests." }, s);
const end = (lane: string, seq: number, s: number, reason = "answered", durationMs = 30_000) =>
  laneEvent(lane, seq, "subagent.end", { id: lane, reason, answerChars: 10, durationMs }, s);

const summary = (
  lane: string,
  r: HistoryEvent | null,
  e: HistoryEvent | null,
  ranMs = 0,
): LaneSummary => ({ lane, start: start(lane), resume: r, end: e, ranMs });

describe("a lane's standing", () => {
  it("runs until it ends, and again once continued past that end", () => {
    expect(laneRunning(summary("sa-1", null, null))).toBe(true);
    expect(laneRunning(summary("sa-1", null, end("sa-1", 9, 30)))).toBe(false);
    expect(laneRunning(summary("sa-1", resume("sa-1", 10, 60), end("sa-1", 9, 30)))).toBe(true);
    expect(laneRunning(summary("sa-1", resume("sa-1", 10, 60), end("sa-1", 20, 90)))).toBe(false);
  });

  it("lists running, answered and continued subagents as such", () => {
    const [running, answered, continued] = subagentsOf([
      summary("sa-1", null, null),
      summary("sa-2", null, end("sa-2", 9, 30), 30_000),
      summary("sa-3", resume("sa-3", 10, 60), end("sa-3", 9, 30, "timeout", 20_000), 20_000),
    ]);
    expect(running).toMatchObject({ id: "sa-1", runningSince: T0, end: null, ranMs: 0 });
    expect(subagentStatus(running, T0 + 12_000)).toEqual({
      label: "Running",
      duration: "12s",
      tone: "running",
    });
    expect(answered).toMatchObject({ runningSince: null, continued: false, ranMs: 30_000 });
    expect(subagentStatus(answered, T0 + 99_000)).toEqual({
      label: "Answered",
      duration: "30s",
      tone: "ok",
    });
    // Running again since the continue, with the stretch before it counted.
    expect(continued).toMatchObject({ runningSince: T0 + 60_000, continued: true, end: null });
    expect(subagentStatus(continued, T0 + 70_000).duration).toBe("30s");
  });

  it("counts every stretch it worked, not only the latest", () => {
    const [ended] = subagentsOf([
      summary("sa-1", resume("sa-1", 20, 300), end("sa-1", 30, 320, "answered", 20_000), 90_000),
    ]);
    expect(subagentStatus(ended, T0 + 999_000).duration).toBe("1m 30s");
    const [running] = subagentsOf([
      summary("sa-1", resume("sa-1", 20, 300), end("sa-1", 10, 100), 90_000),
    ]);
    expect(subagentStatus(running, T0 + 310_000).duration).toBe("1m 40s");
  });

  it("says how the last stretch ended", () => {
    const reasons = ["timeout", "stopped", "failed", "run_ended"] as const;
    const labels = subagentsOf(
      reasons.map((reason, i) => summary(`sa-${i + 1}`, null, end(`sa-${i + 1}`, 9, 30, reason))),
    ).map((s) => subagentStatus(s, T0));
    expect(labels.map((s) => [s.label, s.tone])).toEqual([
      ["Timed out", "failed"],
      ["Stopped", "quiet"],
      ["Failed", "failed"],
      ["Ended with the run", "quiet"],
    ]);
  });

  it("once the run is over, one still running ended with it", () => {
    const [settled] = subagentsOf([summary("sa-1", null, null)], T0 + 45_000);
    expect(settled.runningSince).toBeNull();
    expect(settled.end).toMatchObject({ reason: "run_ended", durationMs: 45_000 });
    expect(subagentStatus(settled, T0 + 99_000).duration).toBe("45s");
  });

  it("leaves out a lane whose opening does not read", () => {
    const broken = { ...summary("sa-1", null, null), start: laneEvent("sa-1", 1, "x", null) };
    expect(subagentsOf([broken, summary("sa-2", null, null)]).map((s) => s.id)).toEqual(["sa-2"]);
  });

  it("shows the one asked for, else the newest running one, else the newest", () => {
    const list = subagentsOf([
      summary("sa-1", null, null),
      summary("sa-2", null, end("sa-2", 9, 30)),
    ]);
    expect(pickSubagent(list, "sa-2")?.id).toBe("sa-2");
    expect(pickSubagent(list, "sa-9")).toBeNull();
    expect(pickSubagent(list, null)?.id).toBe("sa-1");
    expect(pickSubagent(list.slice(1), null)?.id).toBe("sa-2");
    expect(pickSubagent([], null)).toBeNull();
  });
});

describe("laneMarkOf", () => {
  it("reads each mark, and nothing else", () => {
    expect(laneMarkOf(start("sa-1"))).toEqual({
      kind: "start",
      label: "Find callers",
      mode: "explore",
      task: "Find every caller.",
    });
    expect(laneMarkOf(resume("sa-1", 2, 1))).toEqual({ kind: "resume", message: "Now the tests." });
    expect(
      laneMarkOf(laneEvent("sa-1", 3, "subagent.message", { id: "sa-1", message: "Skip docs." })),
    ).toEqual({ kind: "message", message: "Skip docs." });
    expect(laneMarkOf(end("sa-1", 4, 2))).toEqual({
      kind: "end",
      reason: "answered",
      durationMs: 30_000,
    });
    expect(laneMarkOf(laneEvent("sa-1", 5, "assistant", null))).toBeNull();
    expect(laneMarkOf(laneEvent("sa-1", 6, "subagent.end", { reason: "bored" }))).toBeNull();
  });
});

function call(tool: string, args: unknown, output: string | null, over: Partial<ToolCall> = {}) {
  return {
    seq: 4,
    runId: "run-1",
    at: at(0),
    name: `ryph__${tool}`,
    resultText: output,
    useText: null,
    isError: false,
    done: output !== null,
    view: { kind: "mcp", server: "ryph", tool, args, output },
    images: { kept: [], notKept: 0 },
    ...over,
  } as ToolCall;
}

describe("subagentCallOf", () => {
  it("reads the id a start answered with, and what it was called", () => {
    expect(
      subagentCallOf(
        call("subagent_start", { label: "Find callers" }, "sa-2\nStarted. Wait for it."),
      ),
    ).toEqual({ tool: "start", id: "sa-2", label: "Find callers" });
    expect(subagentCallOf(call("subagent_start", { label: "x" }, null))?.id).toBeNull();
    expect(
      subagentCallOf(call("subagent_start", {}, "sa-1 limit reached", { isError: true }))?.id,
    ).toBeNull();
    // Only the id that opens the reply is the one it made.
    expect(subagentCallOf(call("subagent_start", {}, "Refused: sa-1 to sa-4 run"))?.id)
      .toBeNull();
  });

  it("reads the subagent a message or a stop named", () => {
    expect(subagentCallOf(call("subagent_message", { id: "sa-2", text: "hi" }, "ok")))
      .toEqual({ tool: "message", id: "sa-2", label: null });
    expect(subagentCallOf(call("subagent_stop", { id: "../sa-2" }, "no"))?.id).toBeNull();
    // Waiting is ending the turn: there is no wait tool to read.
    expect(subagentCallOf(call("subagent_wait", { ids: ["sa-1"] }, null))).toBeNull();
  });

  it("ignores every other call", () => {
    expect(subagentCallOf(call("background_run", {}, "bg-1"))).toBeNull();
    expect(
      subagentCallOf(call("subagent_start", {}, "sa-1", {
        view: { kind: "mcp", server: "other", tool: "subagent_start", args: {}, output: "sa-1" },
      })),
    ).toBeNull();
  });
});

describe("subagentNoticeOf", () => {
  it("reads the notice beside a platform message, and nothing else", () => {
    const notice = { id: "sa-2", label: "Find callers", reason: "answered", durationMs: 41_000 };
    expect(
      subagentNoticeOf({
        kind: "system",
        sender: { kind: "platform" },
        text: "…",
        subagent: notice,
      }),
    ).toEqual(notice);
    expect(subagentNoticeOf({ kind: "system", text: "hi" })).toBeNull();
    expect(subagentNoticeOf({ subagent: { ...notice, reason: "bored" } })).toBeNull();
    expect(subagentNoticeOf(null)).toBeNull();
  });
});

describe("the live list", () => {
  it("replaces a lane's row, and keeps the rest in start order", () => {
    const one = summary("sa-1", null, null);
    const ten = summary("sa-10", null, null);
    const two = summary("sa-2", null, null);
    let lanes = withLane([], ten);
    lanes = withLane(lanes, two);
    lanes = withLane(lanes, one);
    expect(lanes.map((l) => l.lane)).toEqual(["sa-1", "sa-2", "sa-10"]);
    const ended = summary("sa-2", null, end("sa-2", 9, 30));
    lanes = withLane(lanes, ended);
    expect(lanes.map((l) => l.lane)).toEqual(["sa-1", "sa-2", "sa-10"]);
    expect(lanes[1]).toBe(ended);
    expect(withLane(lanes, ended)).toHaveLength(3);
  });
});
