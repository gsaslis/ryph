// Schedule math over croner: validation at creation, next-occurrence at tick time. All the
// timezone/DST reasoning lives in the library; this wrapper enforces the domain's own rules —
// five fields exactly, a real IANA timezone, and the minimum gap between fires.

import { Cron } from "croner";
import { MIN_SCHEDULE_GAP_MS } from "../core/types.ts";

/** How many consecutive occurrences the gap check samples. Wide enough to cross a week of a
 * weekday-patterned expression; a gap violation that only appears beyond it would need a
 * pattern no five-field cron can express under the floor. */
const GAP_SAMPLE = 40;

/** Checks an expression + timezone pair, returning the refusal or null when valid. */
export function validateSchedule(cron: string, timezone: string): string | null {
  if (cron.trim().split(/\s+/).length !== 5) {
    return "the cron expression must have exactly five fields (minute hour day month weekday)";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return `${JSON.stringify(timezone)} is not an IANA timezone`;
  }
  let job: Cron;
  try {
    job = new Cron(cron, { timezone });
  } catch (err) {
    return `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  let prev = job.nextRun();
  for (let i = 0; prev !== null && i < GAP_SAMPLE; i++) {
    const next = job.nextRun(prev);
    if (next === null) break;
    if (next.getTime() - prev.getTime() < MIN_SCHEDULE_GAP_MS) {
      return `the schedule fires more often than every ${MIN_SCHEDULE_GAP_MS / 60_000} minutes`;
    }
    prev = next;
  }
  return null;
}

/** The first occurrence strictly after `after`, or null for an expression with no future. */
export function nextOccurrence(cron: string, timezone: string, after: Date): Date | null {
  return new Cron(cron, { timezone }).nextRun(after);
}
