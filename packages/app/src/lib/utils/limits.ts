// What the two limit forms share: the unit a wall clock is typed in, and how a typed value is read.

export const HOUR_MS = 3_600_000;

/**
 * What a limit's value may be, as the orchestrator holds every tier to it: a wall clock of at
 * least a minute, and one to 64 calls in flight. Both forms check these so a refusal names the
 * row rather than a 400 naming a field.
 */
export const RUN_LIMIT_BOUNDS = {
  wallClockMs: { min: 60_000 },
  callsInFlight: { min: 1, max: 64 },
} as const;

/**
 * A `limit-reached` event's detail as a sentence reads it: `spend: $0.02` is "spend cap of $0.02",
 * `wall-clock: 2m` is "wall clock of 2m". A detail in a shape this does not know is shown as is.
 */
export function describeLimit(detail: string): string {
  const match = /^(wall-clock|spend): (.+)$/.exec(detail);
  if (match === null) return detail;
  return match[1] === "spend" ? `spend cap of ${match[2]}` : `wall clock of ${match[2]}`;
}

/**
 * A value as typed, or null when blank. Not clamped: the form's own problem check says what is
 * wrong. A number input's binding hands back a number (or nothing, cleared), whatever the field's
 * type says, so both are read as text first.
 */
export function parseTyped(
  typed: string | number | null | undefined,
): number | null {
  const text = String(typed ?? "").trim();
  return text === "" ? null : Number(text);
}
