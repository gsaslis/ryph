import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import { type TaskSummary, taskSummarySchema } from "$lib/api/types";
import TaskRow from "./task-row.svelte";

const task: TaskSummary = {
  id: "t-1",
  title: "Example task",
  awaitingPrompt: false,
  agentId: "a-1",
  agentName: "Ada",
  origin: "user",
  workspaceId: null,
  connectedRepoIds: [],
  requestedByUserId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  lastActivityAt: "2026-10-01T00:00:00.000Z",
  state: "running",
  phase: "running",
};

function draw(over: Partial<TaskSummary>) {
  return render(TaskRow, { props: { task: { ...task, ...over } } }).body;
}

describe("task row idle mark", () => {
  it("distinguishes idle from the person's turn", () => {
    expect(draw({ idleState: "idle" })).toContain("Idle");
    expect(draw({ idleState: "idle" })).not.toContain("Your turn");
    expect(draw({ idleState: "waiting-for-user" })).toContain("Your turn");
    expect(draw({ idleState: "waiting-for-user" })).not.toContain(">Idle<");
  });

  it("shows a green Done badge for successfully completed work while idle", () => {
    for (const declaredOutcome of ["success", "no-changes"] as const) {
      const html = draw({ idleState: "idle", declaredOutcome });
      expect(html).toContain("Done");
      expect(html).toContain("bg-success");
      expect(html).not.toContain(">Idle<");
      expect(html).not.toContain("Your turn");
    }
  });

  it("does not call unfinished, failed, or unreported work done", () => {
    for (const declaredOutcome of ["in-progress", "failed", null, undefined] as const) {
      const html = draw({ idleState: "idle", declaredOutcome });
      expect(html).toContain("Idle");
      expect(html).not.toContain("Done");
    }
  });

  it("keeps conversational handoff visible even with a successful outcome", () => {
    const html = draw({ idleState: "waiting-for-user", declaredOutcome: "success" });
    expect(html).toContain("Your turn");
    expect(html).not.toContain("Done");
  });

  it("hides Done while working, finalizing, or ended", () => {
    for (
      const over of [
        { idleState: null },
        { idleState: undefined },
        { phase: "finalizing" },
        ...(["starting", "succeeded", "failed", "cancelled", "lost", "errored"] as const)
          .map((state) => ({ state })),
      ] satisfies Partial<TaskSummary>[]
    ) {
      expect(draw({ idleState: "idle", declaredOutcome: "success", ...over })).not.toContain(
        "Done",
      );
    }
  });

  it("accepts outcomes and tolerates missing or unknown server values", () => {
    expect(taskSummarySchema.parse({ ...task, declaredOutcome: "success" }).declaredOutcome)
      .toBe("success");
    expect(taskSummarySchema.parse(task).declaredOutcome).toBeUndefined();
    expect(taskSummarySchema.parse({ ...task, declaredOutcome: "future-outcome" }).declaredOutcome)
      .toBeNull();
  });

  it("shows neither mark when working or talking to an older server", () => {
    for (const idleState of [null, undefined]) {
      expect(draw({ idleState })).not.toContain("Your turn");
      expect(draw({ idleState })).not.toContain(">Idle<");
    }
  });

  it("hides stale idle state outside the live running phase", () => {
    for (
      const state of ["succeeded", "failed", "cancelled", "lost", "errored", "starting"] as const
    ) {
      expect(draw({ state, idleState: "waiting-for-user" })).not.toContain("Your turn");
    }
    expect(draw({ phase: "finalizing", idleState: "idle" })).not.toContain(">Idle<");
  });
});
