import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  LIVE_STATES,
  SWEEPABLE_PATCH_STATES,
  TERMINAL_PATCH_STATES,
  TERMINAL_STATES,
} from "../src/core/types.ts";

// The store asks "still going?" as `state IN (LIVE_STATES)` so an index can answer it. That is
// only the same question as "not terminal" while the two split the states with no overlap; both
// are read off one record, and this pins what that record says.
test("LIVE_STATES and TERMINAL_STATES split the run states", () => {
  assertEquals([...LIVE_STATES].filter((s) => TERMINAL_STATES.has(s)), []);
  assertEquals([...LIVE_STATES].sort(), ["running", "starting"]);
  assertEquals([...TERMINAL_STATES].sort(), [
    "cancelled",
    "errored",
    "failed",
    "lost",
    "succeeded",
  ]);
});

test("TERMINAL_PATCH_STATES and SWEEPABLE_PATCH_STATES", () => {
  assertEquals([...TERMINAL_PATCH_STATES].sort(), ["rejected", "submitted", "superseded"]);
  assertEquals([...SWEEPABLE_PATCH_STATES].sort(), ["failed", "queued", "submitting"]);
});
