import { describe, expect, it } from "vitest";
import { taskRunSchema } from "$lib/api/types";
import { canFinish, finishButton, finishRequested } from "./run-finish";

const run = (over: Partial<Parameters<typeof canFinish>[0]> = {}) => ({
  phase: "running" as const,
  declaredOutcome: null,
  agentFinished: false,
  desiredState: null,
  ...over,
});

describe("canFinish", () => {
  it("waits for the agent to say it is done", () => {
    expect(canFinish(run())).toBe(false);
    expect(canFinish(run({ declaredOutcome: "failed" }))).toBe(false);
    expect(canFinish(run({ declaredOutcome: "in-progress" }))).toBe(false);
    expect(canFinish(run({ declaredOutcome: "success" }))).toBe(true);
    expect(canFinish(run({ declaredOutcome: "no-changes" }))).toBe(true);
  });

  it("is not offered once the run is being cancelled", () => {
    expect(canFinish(run({ declaredOutcome: "success", desiredState: "cancelled" }))).toBe(false);
  });

  it("is not offered once the agent finished by itself, or the run is finalizing", () => {
    expect(canFinish(run({ declaredOutcome: "success", agentFinished: true }))).toBe(false);
    expect(canFinish(run({ declaredOutcome: "success", phase: "finalizing" }))).toBe(false);
  });
});

describe("finishRequested", () => {
  it("reads the run's trail", () => {
    expect(finishRequested({ events: [] })).toBe(false);
    expect(
      finishRequested({
        events: [{ runId: "r-1", at: "2026-10-12T00:00:00.000Z", kind: "finish-requested" }],
      }),
    ).toBe(true);
  });
});

describe("finishButton", () => {
  const requested = [{ runId: "r-1", at: "2026-10-12T00:00:00.000Z", kind: "finish-requested" }];

  it("offers Finish once the agent said it is done", () => {
    expect(finishButton({ ...run(), events: [] })).toBe(null);
    expect(finishButton({ ...run({ declaredOutcome: "success" }), events: [] })).toBe("finish");
  });

  it("keeps Cancel on screen while the work is in progress, or once the agent failed", () => {
    expect(finishButton({ ...run({ declaredOutcome: "in-progress" }), events: [] })).toBe(null);
    expect(finishButton({ ...run({ declaredOutcome: "failed" }), events: [] })).toBe(null);
    expect(finishButton({ ...run({ declaredOutcome: "success" }), events: [] })).toBe("finish");
  });

  it("says Finishing once asked, even after a message cleared the agent's outcome", () => {
    expect(finishButton({ ...run({ declaredOutcome: "success" }), events: requested })).toBe(
      "finishing",
    );
    expect(finishButton({ ...run({ declaredOutcome: null }), events: requested })).toBe(
      "finishing",
    );
  });

  it("shows neither once the run is being cancelled", () => {
    expect(finishButton({ ...run({ desiredState: "cancelled" }), events: requested })).toBe(null);
  });
});

describe("the run's declared outcome", () => {
  const base = {
    id: "r-1",
    state: "running",
    phase: "running",
    branchNamespace: "ryph/r-1",
    image: null,
    result: null,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    events: [],
  };

  it("reads an outcome it does not know as none, rather than failing the page", () => {
    expect(taskRunSchema.parse({ ...base, declaredOutcome: "partial" }).declaredOutcome).toBe(
      null,
    );
    expect(taskRunSchema.parse({ ...base, declaredOutcome: "success" }).declaredOutcome).toBe(
      "success",
    );
    expect(taskRunSchema.parse({ ...base, declaredOutcome: "in-progress" }).declaredOutcome)
      .toBe("in-progress");
    expect(taskRunSchema.parse(base).declaredOutcome).toBe(null);
  });
});
