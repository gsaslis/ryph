// The task form's limit fields: what a run of the chosen agent gets by default, what the person
// typed instead, and whether that is theirs to ask for.

import type { DeploymentLimits, RunLimits } from "$lib/api/types";
import { HOUR_MS, parseTyped, RUN_LIMIT_BOUNDS } from "$lib/utils/limits";
import { formatElapsed } from "$lib/utils/format";

/** The limits as typed, each blank for "the agent's own". */
export interface TaskLimitFields {
  wallClockHours: string;
  spendUsd: string;
  callsInFlight: string;
}

export const BLANK_TASK_LIMITS: TaskLimitFields = {
  wallClockHours: "",
  spendUsd: "",
  callsInFlight: "",
};

/** What a run of the agent gets with nothing typed: the agent's policy under the ceiling. */
export function effectiveLimits(
  limits: DeploymentLimits | null,
  agent: RunLimits | null,
): RunLimits {
  const ceiling = limits?.ceiling ?? {
    wallClockMs: null,
    spendUsd: null,
    callsInFlight: null,
  };
  return {
    wallClockMs: agent?.wallClockMs ?? ceiling.wallClockMs,
    spendUsd: agent?.spendUsd ?? ceiling.spendUsd,
    callsInFlight: agent?.callsInFlight ?? ceiling.callsInFlight,
  };
}

/** Only the fields typed, so an untouched form sends nothing and gets the agent's own. */
export function composeTaskLimits(fields: TaskLimitFields): Partial<RunLimits> {
  const hours = parseTyped(fields.wallClockHours);
  const usd = parseTyped(fields.spendUsd);
  const calls = parseTyped(fields.callsInFlight);
  return {
    ...(hours === null ? {} : { wallClockMs: Math.round(hours * HOUR_MS) }),
    ...(usd === null ? {} : { spendUsd: usd }),
    ...(calls === null ? {} : { callsInFlight: calls }),
  };
}

/**
 * Why the fields cannot be sent as they stand, in the person's words — or null. Anyone may lower
 * a limit; raising one above the agent's is an administrator's, and nobody goes past the ceiling.
 * Each of these is a refusal the orchestrator would make anyway; catching it here names the row.
 */
export function taskLimitsProblem(
  fields: TaskLimitFields,
  effective: RunLimits,
  isAdmin: boolean,
  limits: DeploymentLimits | null,
): string | null {
  const composed = composeTaskLimits(fields);
  const rows: Array<[keyof RunLimits, string]> = [
    ["wallClockMs", "wall clock"],
    ["spendUsd", "spend cap"],
    ["callsInFlight", "calls in flight"],
  ];
  for (const [field, name] of rows) {
    const value = composed[field];
    if (value == null) continue;
    if (!Number.isFinite(value) || value <= 0) {
      return `The ${name} must be a number above zero.`;
    }
    if (field === "wallClockMs" && value < RUN_LIMIT_BOUNDS.wallClockMs.min) {
      return "The wall clock is at least one minute.";
    }
    if (
      field === "callsInFlight" &&
      (!Number.isInteger(value) || value < RUN_LIMIT_BOUNDS.callsInFlight.min ||
        value > RUN_LIMIT_BOUNDS.callsInFlight.max)
    ) {
      return "Calls in flight is a whole number from 1 to 64.";
    }
    const cap = limits?.ceiling[field] ?? null;
    if (cap !== null && value > cap) {
      const shown = field === "wallClockMs"
        ? formatElapsed(cap)
        : field === "spendUsd"
        ? `$${cap}`
        : String(cap);
      return `The ${name} is at most ${shown} on this deployment.`;
    }
    const current = effective[field];
    if (!isAdmin && current !== null && value > current) {
      return `Raising the ${name} above the agent's needs an administrator.`;
    }
  }
  return null;
}
