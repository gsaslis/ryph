// The bridge between the form's limit fields and the API's RunLimits, shared by the create and
// edit flows so both compose, seed and validate identically — the forge-policy bridge, for three
// numbers under the operator's ceiling.

import type { DeploymentLimits, RunLimits } from "$lib/api/types";
import { HOUR_MS, parseTyped, RUN_LIMIT_BOUNDS } from "$lib/utils/limits";
import { formatElapsed } from "$lib/utils/format";

/** The form's working shape: each limit's tick and its value as typed. */
export interface LimitFields {
  wallClock: boolean;
  /** Hours, as typed; blank means the ceiling's value. */
  wallClockHours: string;
  spend: boolean;
  /** US dollars, as typed; blank means the ceiling's value. */
  spendUsd: string;
  calls: boolean;
  /** Calls in flight, as typed; blank means the ceiling's value. */
  callsInFlight: string;
}

/** Whether the fields cap anything at all. */
function capsAnything(fields: LimitFields): boolean {
  return fields.wallClock || fields.spend || fields.calls;
}

/** Builds the policy from the fields; capping nothing is the ceiling's values (null), which is
 * also what an unticked row means for its own field. */
export function composeLimitPolicy(fields: LimitFields): RunLimits | null {
  if (!capsAnything(fields)) return null;
  const hours = fields.wallClock ? parseTyped(fields.wallClockHours) : null;
  return {
    wallClockMs: hours === null ? null : Math.round(hours * HOUR_MS),
    spendUsd: fields.spend ? parseTyped(fields.spendUsd) : null,
    callsInFlight: fields.calls ? parseTyped(fields.callsInFlight) : null,
  };
}

/** Seeds the fields from an existing policy (the edit flow). */
export function limitPolicyToFields(policy: RunLimits | null): LimitFields {
  return {
    wallClock: (policy?.wallClockMs ?? null) !== null,
    wallClockHours: policy?.wallClockMs == null ? "" : String(policy.wallClockMs / HOUR_MS),
    spend: (policy?.spendUsd ?? null) !== null,
    spendUsd: policy?.spendUsd == null ? "" : String(policy.spendUsd),
    calls: (policy?.callsInFlight ?? null) !== null,
    callsInFlight: policy?.callsInFlight == null ? "" : String(policy.callsInFlight),
  };
}

/** The ceiling's value for a row, in the row's own unit, for a placeholder and a bound. */
export function ceilingHours(limits: DeploymentLimits | null): number | null {
  const ms = limits?.ceiling.wallClockMs ?? null;
  return ms === null ? null : ms / HOUR_MS;
}

/**
 * Why the fields cannot be saved as they stand, in the operator's words — or null when they can.
 * Each of these is a refusal the orchestrator would make anyway; catching it here means the form
 * names the row, instead of a 400 naming a field. Fields capping nothing always pass.
 */
export function limitPolicyProblem(
  fields: LimitFields,
  limits: DeploymentLimits | null,
): string | null {
  if (!capsAnything(fields)) return null;
  const ceiling = limits?.ceiling ?? null;

  if (fields.wallClock) {
    const hours = parseTyped(fields.wallClockHours);
    if (hours !== null) {
      if (!Number.isFinite(hours) || hours * HOUR_MS < RUN_LIMIT_BOUNDS.wallClockMs.min) {
        return "The wall clock is a number of hours, at least one minute.";
      }
      const cap = limits?.ceiling.wallClockMs ?? null;
      if (cap !== null && hours * HOUR_MS > cap) {
        return `The wall clock is at most ${formatElapsed(cap)} on this deployment.`;
      }
    }
  }
  if (fields.spend) {
    const usd = parseTyped(fields.spendUsd);
    if (usd !== null) {
      if (!Number.isFinite(usd) || usd <= 0) {
        return "The spend cap is an amount in dollars above zero.";
      }
      const cap = ceiling?.spendUsd ?? null;
      if (cap !== null && usd > cap) {
        return `The spend cap is at most $${cap} on this deployment.`;
      }
    }
  }
  if (fields.calls) {
    const calls = parseTyped(fields.callsInFlight);
    if (calls !== null) {
      if (
        !Number.isInteger(calls) || calls < RUN_LIMIT_BOUNDS.callsInFlight.min ||
        calls > RUN_LIMIT_BOUNDS.callsInFlight.max
      ) {
        return "Calls in flight is a whole number from 1 to 64.";
      }
      const cap = ceiling?.callsInFlight ?? null;
      if (cap !== null && calls > cap) {
        return `Calls in flight is at most ${cap} on this deployment.`;
      }
    }
  }
  return null;
}
