// When a tab's heap is collected by hand, and what the next decision is measured against.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { floorAfter, HEAP_TIDY_MIN, shouldCollect } from "../src/core/heap.ts";

const MiB = 1024 * 1024;

test("nothing is collected under the minimum, whatever the floor", () => {
  assert(!shouldCollect(HEAP_TIDY_MIN - 1, 0));
  assert(shouldCollect(HEAP_TIDY_MIN, 0));
  assert(!shouldCollect(10 * MiB, 0, 16 * MiB));
});

test("past the minimum, the heap must also reach twice what the last collection left", () => {
  assert(!shouldCollect(150 * MiB, 80 * MiB));
  assert(shouldCollect(160 * MiB, 80 * MiB));
});

test("a navigation's reset floor makes the minimum the only bar again", () => {
  // A heavy page left 200 MiB live; the light page after it must not pile up to 400 MiB.
  assert(!shouldCollect(100 * MiB, 200 * MiB));
  assert(shouldCollect(100 * MiB, 0));
});

test("a collection that timed out still records a floor, so the next report does not ask again", () => {
  assertEquals(floorAfter(120 * MiB, 9 * MiB), 9 * MiB);
  const floor = floorAfter(120 * MiB, null);
  assertEquals(floor, 120 * MiB);
  assert(!shouldCollect(130 * MiB, floor));
  assert(shouldCollect(240 * MiB, floor));
});
