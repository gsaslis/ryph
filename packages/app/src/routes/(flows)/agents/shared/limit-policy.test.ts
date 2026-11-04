import { describe, expect, it } from "vitest";
import type { DeploymentLimits } from "$lib/api/types";
import {
  ceilingHours,
  composeLimitPolicy,
  type LimitFields,
  limitPolicyProblem,
  limitPolicyToFields,
} from "./limit-policy";

const CEILING: DeploymentLimits = {
  ceiling: { wallClockMs: 12 * 3_600_000, spendUsd: 50, callsInFlight: 8 },
  concurrency: null,
};

/** A new agent's fields with `patch` on top. */
const fields = (patch: Partial<LimitFields> = {}): LimitFields => ({
  ...limitPolicyToFields(null),
  ...patch,
});

describe("compose and seed round-trip", () => {
  it("capping nothing is the ceiling's values", () => {
    expect(composeLimitPolicy(fields())).toBeNull();
    // A value on an unticked row caps nothing.
    expect(composeLimitPolicy(fields({ spendUsd: "5" }))).toBeNull();
  });

  it("composes hours into milliseconds and blanks into the ceiling's value", () => {
    expect(composeLimitPolicy(fields({ wallClock: true, wallClockHours: "1.5", spend: true })))
      .toEqual({ wallClockMs: 5_400_000, spendUsd: null, callsInFlight: null });
  });

  it("seeds every row from a policy, and round-trips", () => {
    const policy = { wallClockMs: 1_800_000, spendUsd: 20, callsInFlight: 4 };
    const seeded = limitPolicyToFields(policy);
    expect(seeded).toEqual({
      wallClock: true,
      wallClockHours: "0.5",
      spend: true,
      spendUsd: "20",
      calls: true,
      callsInFlight: "4",
    });
    expect(composeLimitPolicy(seeded)).toEqual(policy);
    expect(limitPolicyToFields({ wallClockMs: null, spendUsd: 20, callsInFlight: null }).wallClock)
      .toBe(false);
  });
});

describe("limitPolicyProblem", () => {
  it("passes fields that cap nothing, and fields under the ceiling", () => {
    expect(limitPolicyProblem(fields(), CEILING)).toBeNull();
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "50" }), CEILING)).toBeNull();
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "" }), CEILING)).toBeNull();
  });

  it("names the row above the ceiling", () => {
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "51" }), CEILING))
      .toBe("The spend cap is at most $50 on this deployment.");
    expect(limitPolicyProblem(fields({ wallClock: true, wallClockHours: "13" }), CEILING))
      .toBe("The wall clock is at most 12h on this deployment.");
    expect(limitPolicyProblem(fields({ calls: true, callsInFlight: "9" }), CEILING))
      .toBe("Calls in flight is at most 8 on this deployment.");
  });

  it("refuses a value that is not a number, and passes anything under an uncapped ceiling", () => {
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "-1" }), CEILING))
      .toBe("The spend cap is an amount in dollars above zero.");
    expect(limitPolicyProblem(fields({ calls: true, callsInFlight: "1.5" }), CEILING))
      .toBe("Calls in flight is a whole number from 1 to 64.");
    const open = {
      ceiling: { wallClockMs: null, spendUsd: null, callsInFlight: null },
      concurrency: null,
    };
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "1000" }), open)).toBeNull();
    expect(limitPolicyProblem(fields({ spend: true, spendUsd: "1000" }), null)).toBeNull();
  });

  it("reads the ceiling's wall clock in hours", () => {
    expect(ceilingHours(CEILING)).toBe(12);
    expect(ceilingHours(null)).toBeNull();
  });
});
