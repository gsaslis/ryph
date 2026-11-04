// The failed-attempt budget behind login and the anonymous flows: it limits per key, and it
// stays bounded when many distinct keys fail and are never seen again.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { failureWindow } from "../src/http/failure_window.ts";

function makeClock() {
  let nowMs = 0;
  return { now: () => new Date(nowMs), advance: (ms: number) => nowMs += ms };
}

test("a key is limited after its attempts and forgiven once its window passes", () => {
  const clock = makeClock();
  const window = failureWindow({ attempts: 3, windowMs: 1000, now: clock.now });
  for (let i = 0; i < 3; i++) window.recordFailure("ada@example.com");
  assert(window.isLimited("ada@example.com"));
  assert(!window.isLimited("bob@example.com"));
  clock.advance(1001);
  assert(!window.isLimited("ada@example.com"));
});

test("expired keys are dropped on a later failure even if they never come back", () => {
  const clock = makeClock();
  const window = failureWindow({ attempts: 10, windowMs: 1000, now: clock.now });
  for (let i = 0; i < 500; i++) window.recordFailure(`spray-${i}@example.com`);
  assertEquals(window.size, 500);

  clock.advance(500);
  window.recordFailure("still-live@example.com"); // nothing has expired yet
  assertEquals(window.size, 501);

  clock.advance(600); // the spray's windows are over; still-live's is not
  window.recordFailure("ada@example.com");
  assertEquals(window.size, 2);
  window.recordFailure("still-live@example.com");
  assert(!window.isLimited("still-live@example.com"));
  assertEquals(window.size, 2);
});

test("past the cap the oldest windows are forgotten first", () => {
  const clock = makeClock();
  const window = failureWindow({ attempts: 2, windowMs: 1000, now: clock.now, maxEntries: 3 });
  for (const key of ["a", "b", "c", "d"]) {
    window.recordFailure(key);
    window.recordFailure(key);
    clock.advance(1);
  }
  assertEquals(window.size, 3);
  assert(!window.isLimited("a"));
  assert(window.isLimited("b") && window.isLimited("c") && window.isLimited("d"));
});
