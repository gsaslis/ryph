import { describe, expect, it } from "vitest";
import {
  BLANK_TASK_LIMITS,
  composeTaskLimits,
  effectiveLimits,
  taskLimitsProblem,
} from "./task-limits";

const LIMITS = {
  ceiling: { wallClockMs: 12 * 3_600_000, spendUsd: 50, callsInFlight: 8 },
  concurrency: null,
};
const AGENT = { wallClockMs: null, spendUsd: 10, callsInFlight: 4 };

describe("effectiveLimits", () => {
  it("is the agent's policy under the ceiling, field by field", () => {
    expect(effectiveLimits(LIMITS, AGENT)).toEqual({
      wallClockMs: 12 * 3_600_000,
      spendUsd: 10,
      callsInFlight: 4,
    });
    expect(effectiveLimits(null, null)).toEqual({
      wallClockMs: null,
      spendUsd: null,
      callsInFlight: null,
    });
  });
});

describe("composeTaskLimits", () => {
  it("sends only what was typed", () => {
    expect(composeTaskLimits(BLANK_TASK_LIMITS)).toEqual({});
    expect(composeTaskLimits({ ...BLANK_TASK_LIMITS, wallClockHours: "0.5", spendUsd: "5" }))
      .toEqual({ wallClockMs: 1_800_000, spendUsd: 5 });
  });
});

describe("taskLimitsProblem", () => {
  const effective = effectiveLimits(LIMITS, AGENT);

  it("lets anyone lower, and only an admin raise up to the ceiling", () => {
    expect(taskLimitsProblem(BLANK_TASK_LIMITS, effective, false, LIMITS)).toBeNull();
    expect(taskLimitsProblem({ ...BLANK_TASK_LIMITS, spendUsd: "5" }, effective, false, LIMITS))
      .toBeNull();
    expect(taskLimitsProblem({ ...BLANK_TASK_LIMITS, spendUsd: "20" }, effective, false, LIMITS))
      .toBe("Raising the spend cap above the agent's needs an administrator.");
    expect(taskLimitsProblem({ ...BLANK_TASK_LIMITS, spendUsd: "20" }, effective, true, LIMITS))
      .toBeNull();
    expect(taskLimitsProblem({ ...BLANK_TASK_LIMITS, spendUsd: "51" }, effective, true, LIMITS))
      .toBe("The spend cap is at most $50 on this deployment.");
    expect(
      taskLimitsProblem({ ...BLANK_TASK_LIMITS, wallClockHours: "13" }, effective, true, LIMITS),
    ).toBe("The wall clock is at most 12h on this deployment.");
  });

  it("refuses a value that is not a number, or outside the bounds every tier is held to", () => {
    expect(taskLimitsProblem({ ...BLANK_TASK_LIMITS, spendUsd: "abc" }, effective, true, LIMITS))
      .toBe("The spend cap must be a number above zero.");
    expect(
      taskLimitsProblem({ ...BLANK_TASK_LIMITS, callsInFlight: "1.5" }, effective, true, LIMITS),
    ).toBe("Calls in flight is a whole number from 1 to 64.");
    expect(
      taskLimitsProblem({ ...BLANK_TASK_LIMITS, callsInFlight: "65" }, effective, true, LIMITS),
    ).toBe("Calls in flight is a whole number from 1 to 64.");
    expect(
      taskLimitsProblem({ ...BLANK_TASK_LIMITS, wallClockHours: "0.01" }, effective, true, LIMITS),
    ).toBe("The wall clock is at least one minute.");
  });
});
