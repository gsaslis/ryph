import { describe, expect, it } from "vitest";
import type { AutomationFire, ResponseListItem } from "$lib/api/types";
import { activityRows, lasted } from "./activity";

const fire = (id: string, firedAt: string, outcome: string, taskId: string | null = null) =>
  ({
    id,
    automationId: "am-1",
    outcome,
    taskId,
    runId: taskId === null ? null : `r-${taskId}`,
    detail: null,
    firedAt,
  }) satisfies AutomationFire;

const response = (taskId: string, alerts: number, title: string | null = null) =>
  ({
    id: `resp-${taskId}`,
    automationId: "am-1",
    taskId,
    runId: `r-${taskId}`,
    chatroomId: null,
    state: "closed",
    key: "",
    title,
    alerts,
    openedAt: "2026-09-23T10:00:00Z",
    lastAlertAt: "2026-09-23T10:20:00Z",
    lastActivityAt: "2026-09-23T10:30:00Z",
    closedAt: "2026-09-23T11:00:00Z",
    closedReason: "succeeded",
    taskTitle: null,
    agentName: "Responder",
    runState: "succeeded",
  }) satisfies ResponseListItem;

describe("activityRows", () => {
  it("folds every fire of one run into a row, a response when one names the task", () => {
    const rows = activityRows([
      fire("f3", "2026-09-23T10:20:00Z", "joined", "t-a"),
      fire("f2", "2026-09-23T10:05:00Z", "joined", "t-a"),
      fire("f1", "2026-09-23T10:00:00Z", "started", "t-a"),
    ], [response("t-a", 3, "HighErrorRate")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "response",
      response: { title: "HighErrorRate" },
      at: "2026-09-23T10:00:00Z",
      lastAt: "2026-09-23T10:20:00Z",
    });
  });

  it("keeps a plain run a run, and a fire that started nothing a row of its own", () => {
    const rows = activityRows([
      fire("f2", "2026-09-23T12:00:00Z", "rate-limited"),
      fire("f1", "2026-09-23T09:00:00Z", "started", "t-b"),
    ], []);
    expect(rows.map((r) => r.kind)).toEqual(["skipped", "run"]);
    expect(rows[0]).toMatchObject({ label: "Rate limited" });
    expect(rows[1]).toMatchObject({ fires: 1 });
  });

  it("puts the most recently active first, so a long response still taking fires stays on top", () => {
    const rows = activityRows([
      fire("f3", "2026-09-23T12:00:00Z", "joined", "t-old"),
      fire("f2", "2026-09-23T11:00:00Z", "started", "t-new"),
      fire("f1", "2026-09-23T08:00:00Z", "started", "t-old"),
    ], [response("t-old", 2)]);
    expect(rows.map((r) => r.key)).toEqual(["t-old", "t-new"]);
  });

  it("gives every hook that started nothing a row of its own", () => {
    const rows = activityRows([
      fire("f3", "2026-09-23T12:02:00Z", "resolved"),
      fire("f2", "2026-09-23T12:01:00Z", "resolved"),
      fire("f1", "2026-09-23T11:00:00Z", "started", "t-a"),
    ], []);
    expect(rows.map((r) => r.kind)).toEqual(["skipped", "skipped", "run"]);
  });

  it("says why a resolve or a status update started nothing", () => {
    const rows = activityRows([
      fire("f2", "2026-09-23T12:02:00Z", "ignored"),
      fire("f1", "2026-09-23T12:01:00Z", "resolved"),
    ], []);
    expect(rows.map((r) => r.kind === "skipped" && r.label)).toEqual([
      "Status update, nothing open",
      "Resolved, nothing open",
    ]);
  });
});

describe("lasted", () => {
  it("says a duration to the minute", () => {
    expect(lasted(20_000)).toBe("under a minute");
    expect(lasted(2_844_000)).toBe("47 min");
    expect(lasted(7_500_000)).toBe("2 h 5 min");
    expect(lasted(7_200_000)).toBe("2 h");
  });
});
