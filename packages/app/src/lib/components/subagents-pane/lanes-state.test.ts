import { describe, expect, it } from "vitest";
import type { LaneSummary } from "$lib/api/history";
import type { HistoryEvent } from "$lib/api/types";
import { LanesState } from "./lanes-state.svelte";

// The tab's list as the live feed moves it: a lane's later summary replaces its earlier one, and
// what the tab reads off the list (how many run) follows.

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

function laneEvent(lane: string, seq: number, kind: string, payload: unknown): HistoryEvent {
  return {
    runId: "run-1",
    lane,
    seq,
    at: new Date(T0 + seq * 1_000).toISOString(),
    voice: "transcript",
    kind,
    level: null,
    text: null,
    payload,
  };
}

const started = (lane: string): LaneSummary => ({
  lane,
  start: laneEvent(lane, 1, "subagent.start", {
    id: lane,
    label: `Look at ${lane}`,
    mode: "explore",
    task: "Look.",
  }),
  resume: null,
  end: null,
  ranMs: 0,
});

const ended = (lane: string): LaneSummary => ({
  ...started(lane),
  end: laneEvent(lane, 9, "subagent.end", {
    id: lane,
    reason: "answered",
    answerChars: 3,
    durationMs: 8_000,
  }),
  ranMs: 8_000,
});

describe("the lanes feed", () => {
  it("drops the running count as each lane ends", () => {
    const lanes = new LanesState();
    expect(lanes.loaded).toBe(false);
    lanes.apply(started("sa-1"));
    lanes.apply(started("sa-2"));
    expect(lanes.running).toBe(2);
    expect(lanes.loaded).toBe(true);

    lanes.apply(ended("sa-1"));
    expect(lanes.running).toBe(1);
    expect(lanes.subagents.map((s) => s.id)).toEqual(["sa-1", "sa-2"]);
    expect(lanes.subagents[0].end?.reason).toBe("answered");

    lanes.apply(ended("sa-2"));
    expect(lanes.running).toBe(0);
  });

  it("a reopened feed saying every lane again changes nothing", () => {
    const lanes = new LanesState();
    lanes.apply(ended("sa-1"));
    lanes.apply(started("sa-2"));
    lanes.apply(ended("sa-1"));
    lanes.apply(started("sa-2"));
    expect(lanes.subagents).toHaveLength(2);
    expect(lanes.running).toBe(1);
  });

  it("settles what still runs once the run has ended", () => {
    let runEndedAt: number | null = null;
    const lanes = new LanesState(() => runEndedAt);
    lanes.replace([started("sa-1")]);
    expect(lanes.running).toBe(1);
    runEndedAt = T0 + 30_000;
    // The run's end is read by the derived; a new listing is what reads it again here.
    lanes.replace([started("sa-1")]);
    expect(lanes.running).toBe(0);
    expect(lanes.subagents[0].end?.reason).toBe("run_ended");
  });
});
