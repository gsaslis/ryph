// Schedule validation: the domain's own rules over croner — field count, timezone, the floor.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { nextOccurrence, validateSchedule } from "../src/helpers/cron.ts";

test("a five-field weekday expression in a real timezone validates", () => {
  assertEquals(validateSchedule("0 9 * * 1-5", "Europe/Athens"), null);
});

test("six fields, a fake timezone, and gibberish are each refused with their reason", () => {
  assertStringIncludes(validateSchedule("0 0 9 * * 1", "UTC")!, "exactly five fields");
  assertStringIncludes(validateSchedule("0 9 * * *", "Mars/Olympus")!, "not an IANA timezone");
  assertStringIncludes(validateSchedule("not cron", "UTC")!, "five fields");
});

test("the floor: every-minute is refused, every-five-minutes is the exact edge and passes", () => {
  assertStringIncludes(validateSchedule("* * * * *", "UTC")!, "more often than every 5 minutes");
  assertEquals(validateSchedule("*/5 * * * *", "UTC"), null);
});

test("nextOccurrence is strictly after the given instant, in the schedule's timezone", () => {
  const after = new Date("2026-01-01T00:00:00.000Z");
  const next = nextOccurrence("0 9 * * *", "UTC", after);
  assert(next !== null);
  assertEquals(next.toISOString(), "2026-01-01T09:00:00.000Z");
});
