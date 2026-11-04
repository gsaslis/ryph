// The host's sweep tick: no overlap, and a kick during a pass is never lost.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { coalescingTick } from "../src/helpers/tick.ts";

test("kicks during a pass make exactly one follow-up pass, and none is dropped", async () => {
  const releases: Array<() => void> = [];
  let passes = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const tick = coalescingTick(async () => {
    passes++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise<void>((resolve) => releases.push(resolve));
    concurrent--;
  }, () => {});
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  tick();
  await settle();
  assertEquals(passes, 1);
  // Three kicks land while the pass runs — an ingest it may have looked past already.
  tick();
  tick();
  tick();
  releases.shift()!();
  await settle();
  assertEquals(passes, 2); // one follow-up, not three
  releases.shift()!();
  await settle();
  assertEquals(passes, 2);
  assertEquals(maxConcurrent, 1);

  // Idle again: the next kick starts a pass of its own.
  tick();
  await settle();
  assertEquals(passes, 3);
  releases.shift()!();
  await settle();
});

test("a pass that throws is reported and the tick keeps working", async () => {
  const errors: unknown[] = [];
  let passes = 0;
  const tick = coalescingTick(() => {
    passes++;
    return Promise.reject(new Error("store down"));
  }, (err) => errors.push(err));
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(passes, 2);
  assertEquals(errors.length, 2);
});
