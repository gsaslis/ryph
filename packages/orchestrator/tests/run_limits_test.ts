// The three tiers of a run's limits, as plain numbers: what resolves, what is over, what raises.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import {
  deadlineSecondsFor,
  deploymentLimitsFromEnv,
  describeLimit,
  formatWallClock,
  overCeiling,
  raisesAbove,
  resolveRunLimits,
} from "../src/core/run_limits.ts";
import { NO_RUN_LIMITS } from "../src/core/types.ts";

const CEILING = { wallClockMs: 3_600_000, spendUsd: 50, callsInFlight: 8 };

test("resolveRunLimits takes the task's value, else the agent's, else the ceiling's, per field", () => {
  assertEquals(resolveRunLimits(CEILING, null), CEILING);
  const agent = { wallClockMs: 1_800_000, spendUsd: null, callsInFlight: 4 };
  assertEquals(resolveRunLimits(CEILING, agent), { ...agent, spendUsd: 50 });
  assertEquals(resolveRunLimits(CEILING, agent, { spendUsd: 5 }), {
    wallClockMs: 1_800_000,
    spendUsd: 5,
    callsInFlight: 4,
  });
  // A null in the override falls through exactly as an absent field does.
  assertEquals(resolveRunLimits(CEILING, agent, { wallClockMs: null }).wallClockMs, 1_800_000);
  // An uncapped ceiling stays uncapped unless a lower tier caps it.
  assertEquals(resolveRunLimits(NO_RUN_LIMITS, agent), { ...agent });
  // A policy saved under a higher ceiling is clamped to the current one, field by field.
  const stale = { wallClockMs: 7_200_000, spendUsd: 100, callsInFlight: 4 };
  assertEquals(resolveRunLimits(CEILING, stale, { spendUsd: 60 }), {
    wallClockMs: 3_600_000,
    spendUsd: 50,
    callsInFlight: 4,
  });
});

test("overCeiling names the first field above a capped ceiling and nothing under an uncapped one", () => {
  assertEquals(overCeiling({ spendUsd: 50 }, CEILING), null);
  assertEquals(overCeiling({ spendUsd: 51 }, CEILING), "spendUsd");
  assertEquals(overCeiling({ wallClockMs: 7_200_000, spendUsd: 51 }, CEILING), "wallClockMs");
  assertEquals(overCeiling({ wallClockMs: null, spendUsd: null }, CEILING), null);
  assertEquals(overCeiling({ spendUsd: 1_000_000 }, NO_RUN_LIMITS), null);
});

test("raisesAbove names a field the override lifts above the effective value; lowering is free", () => {
  assertEquals(raisesAbove({ spendUsd: 10 }, CEILING), null);
  assertEquals(raisesAbove({ spendUsd: 60 }, CEILING), "spendUsd");
  assertEquals(raisesAbove({ callsInFlight: 9 }, CEILING), "callsInFlight");
  // Capping an uncapped field is lowering, never raising.
  assertEquals(raisesAbove({ spendUsd: 60 }, NO_RUN_LIMITS), null);
  assertEquals(raisesAbove({ spendUsd: null }, CEILING), null);
});

test("describeLimit and formatWallClock read the way the event trail shows them", () => {
  assertEquals(formatWallClock(12 * 3_600_000), "12h");
  assertEquals(formatWallClock(90 * 60_000), "1h 30m");
  assertEquals(formatWallClock(5 * 60_000), "5m");
  assertEquals(formatWallClock(90_000), "1m 30s");
  assertEquals(formatWallClock(45_000), "45s");
  assertEquals(describeLimit("wall-clock", 12 * 3_600_000), "wall-clock: 12h");
  assertEquals(describeLimit("spend", 20), "spend: $20.00");
  assertEquals(describeLimit("spend", 0.005), "spend: $0.01");
});

test("deadlineSecondsFor adds the graces and rounds up; no wall clock is no deadline", () => {
  assertEquals(deadlineSecondsFor({ ...NO_RUN_LIMITS, wallClockMs: 60_000 }, 720_000), 780);
  assertEquals(deadlineSecondsFor({ ...NO_RUN_LIMITS, wallClockMs: 1_500 }, 0), 2);
  assertEquals(deadlineSecondsFor(NO_RUN_LIMITS, 720_000), null);
});

test("deploymentLimitsFromEnv holds the ceiling to the bounds the wire schemas enforce", () => {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const graces = { startupGraceMs: 600_000, cancelGraceMs: 120_000 };
  const read = (vars: Record<string, string>) =>
    deploymentLimitsFromEnv((name) => vars[name], fail, graces);

  assertEquals(read({}).ceiling, { wallClockMs: 43_200_000, spendUsd: null, callsInFlight: 8 });
  assertEquals(read({ RYPH_RUN_MAX_CALLS_IN_FLIGHT: "64" }).ceiling.callsInFlight, 64);
  assertEquals(read({ RYPH_RUN_MAX_WALL_CLOCK_MS: "0" }).ceiling.wallClockMs, null);
  // A ceiling the credential schema would refuse never resolves onto a run: it fails at boot.
  assertThrows(
    () => read({ RYPH_RUN_MAX_CALLS_IN_FLIGHT: "100" }),
    Error,
    "RYPH_RUN_MAX_CALLS_IN_FLIGHT must be at most 64",
  );
  assertThrows(
    () => read({ RYPH_RUN_MAX_WALL_CLOCK_MS: "1000" }),
    Error,
    "RYPH_RUN_MAX_WALL_CLOCK_MS must be at least 60000",
  );
});
