// The operator's checks knobs (core/check_policy.ts): what each RYPH_CHECKS_* variable reads as,
// and what a composition root refuses to boot on.

import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { checkPolicyFromEnv, DEFAULT_CHECK_POLICY } from "../src/core/check_policy.ts";
import { parseRunSizes, type RunSizes } from "../src/core/run_sizes.ts";

const SIZES: RunSizes = (() => {
  const parsed = parseRunSizes("standard:cpu=4,memory=8Gi;large:cpu=8,memory=16Gi", "standard");
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
})();

const read = (vars: Record<string, string>, sizes: RunSizes | null = SIZES) =>
  checkPolicyFromEnv((name) => vars[name], (message) => {
    throw new Error(message);
  }, sizes);

test("checks default off, with the documented numbers", () => {
  assertEquals(read({}), DEFAULT_CHECK_POLICY);
  assertEquals(read({ RYPH_CHECKS: " ON " }).enabled, true);
  assertEquals(read({ RYPH_CHECKS: "off" }).enabled, false);
});

test("each knob reads a whole number of at least one", () => {
  const policy = read({
    RYPH_CHECKS: "on",
    RYPH_CHECKS_TIMEOUT_MAX: "7200",
    RYPH_CHECKS_CONCURRENCY: "8",
    RYPH_CHECKS_MAX_PER_RUN: "3",
    RYPH_CHECKS_SIZE: " large ",
    RYPH_CHECKS_CHANGE_REQUESTS: "Off",
    RYPH_CHECKS_LOCAL: "off",
    RYPH_CHECKS_MAX_LOCAL_PER_USER: "2",
    RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR: "5",
  });
  assertEquals(policy, {
    enabled: true,
    defaultTimeoutSeconds: 900,
    maxTimeoutSeconds: 7200,
    maxConcurrent: 8,
    maxPerRun: 3,
    sizeClass: "large",
    ownSizes: [],
    changeRequests: false,
    local: false,
    maxLocalPerUser: 2,
    maxUploadsPerHour: 5,
  });
  assertEquals(read({ RYPH_CHECKS_SIZE: "  " }).sizeClass, null);
});

test("the default timeout never exceeds the ceiling", () => {
  const policy = read({ RYPH_CHECKS_TIMEOUT_MAX: "300" });
  assertEquals([policy.defaultTimeoutSeconds, policy.maxTimeoutSeconds], [300, 300]);
});

test("a knob the deployment cannot run on refuses the boot, naming it", () => {
  assertThrows(() => read({ RYPH_CHECKS: "yes" }), Error, "RYPH_CHECKS must be");
  assertThrows(
    () => read({ RYPH_CHECKS_CHANGE_REQUESTS: "maybe" }),
    Error,
    "RYPH_CHECKS_CHANGE_REQUESTS must be",
  );
  assertThrows(() => read({ RYPH_CHECKS_LOCAL: "1" }), Error, "RYPH_CHECKS_LOCAL must be");
  assertThrows(
    () => read({ RYPH_CHECKS_MAX_LOCAL_PER_USER: "0" }),
    Error,
    "RYPH_CHECKS_MAX_LOCAL_PER_USER",
  );
  for (const bad of ["0", "-1", "1.5", "four", ""]) {
    assertThrows(
      () => read({ RYPH_CHECKS_TIMEOUT_MAX: bad }),
      Error,
      "RYPH_CHECKS_TIMEOUT_MAX must be a whole number",
    );
  }
  assertThrows(() => read({ RYPH_CHECKS_MAX_PER_RUN: "0" }), Error, "RYPH_CHECKS_MAX_PER_RUN");
  // One tick polls every running suite: the cap is what it can poll.
  assertEquals(read({ RYPH_CHECKS_CONCURRENCY: "50" }).maxConcurrent, 50);
  assertThrows(() => read({ RYPH_CHECKS_CONCURRENCY: "51" }), Error, "at most 50");
});

test("the classes a check's own pod may ask for are the operator's list, none by default", () => {
  assertEquals(read({}).ownSizes, []);
  assertEquals(read({ RYPH_CHECKS_OWN_SIZES: " " }).ownSizes, []);
  assertEquals(read({ RYPH_CHECKS_OWN_SIZES: " large, standard ," }).ownSizes, [
    "large",
    "standard",
  ]);
  // A class named twice is a typo somewhere, as RYPH_HARNESS_KINDS treats one.
  assertThrows(
    () => read({ RYPH_CHECKS_OWN_SIZES: "large,standard,large" }),
    Error,
    "RYPH_CHECKS_OWN_SIZES names a class twice",
  );
});

test("a class the deployment does not define in RYPH_CHECKS_OWN_SIZES refuses the boot", () => {
  assertThrows(
    () => read({ RYPH_CHECKS_OWN_SIZES: "large,huge" }),
    Error,
    'RYPH_CHECKS_OWN_SIZES names "huge", which RYPH_RUN_SIZES does not define (it defines ' +
      "standard, large)",
  );
  // A reader that wants only the switch does not hold the list to the classes.
  assertEquals(read({ RYPH_CHECKS_OWN_SIZES: "huge" }, null).ownSizes, ["huge"]);
});
