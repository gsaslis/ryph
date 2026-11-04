// A run's limits: how long it may run, how much it may spend, how many model calls it may hold
// open — and the three tiers the values come from, each only able to narrow the one above it.
//
// Invariants:
// - the OPERATOR's ceiling is the most any run may be given; it comes from the environment and
//   nothing inside the product raises it
// - an AGENT's policy sets defaults under the ceiling, and a null field there means "the
//   ceiling's value" — never "uncapped", which the ceiling alone may say
// - a TASK's override lowers the agent's effective values; raising one is a privilege question
//   the door answers, not this file
// - the resolved limits are frozen onto the run at creation, like every other snapshot: editing
//   the agent afterwards moves nothing for a run already started

import type { RunLimits } from "./types.ts";

/** What the operator set: the ceiling every run is under, and the deployment-wide caps. */
export interface DeploymentLimits {
  /** The most any run may be given — an agent's policy and a task's override stay under it. */
  ceiling: RunLimits;
  /** How many runs may be live across the deployment at once; null for no cap. */
  concurrency: number | null;
  /** How many model credentials one run may be issued over its life. */
  maxCredentials: number;
  /** What the provisioner's wall-clock backstop adds past the run's own limit: the startup
   * grace and the cancel grace, so the orchestrator's cancel always lands first. */
  deadlineGraceMs: number;
  /** How long a launched run may stay silent before the reaper gives up on it; a launch's
   * bootstrap token outlives it, so a slow boot is the reaper's call, never the token's. */
  startupGraceMs: number;
}

/** What the sweep asks of the proxy: a run's priced spend so far, in USD. */
export interface RunSpendReader {
  spendOf(runId: string): Promise<number>;
}

/** What the door asks of the proxy: whether the deployment's spend ceiling is reached. */
export interface SpendGate {
  ceilingReached(): Promise<boolean>;
}

/**
 * The providers whose usage a subscription pays for — a ChatGPT plan. The proxy prices them as
 * included, at $0, and no spend cap refuses them, the deployment's ceiling included; the door
 * must not either. The id is @ryph/model-proxy's `CHATGPT_PLAN`, spelled here rather than
 * imported so this core stays free of the proxy package (tests/http_api_test.ts pins the two
 * together).
 */
const INCLUDED_PROVIDERS: ReadonlySet<string> = new Set(["chatgpt-plan"]);

/** Whether a provider's usage is outside every spend cap. */
export function spendIncluded(provider: string): boolean {
  return INCLUDED_PROVIDERS.has(provider);
}

export const LIMIT_FIELDS = ["wallClockMs", "spendUsd", "callsInFlight"] as const;

/**
 * A run's limits, per field: the task's value, else the agent's, else the ceiling's, and never
 * above the ceiling. The clamp is what keeps an agent policy saved under an earlier, higher
 * ceiling from minting runs the operator's current one would refuse.
 */
export function resolveRunLimits(
  ceiling: RunLimits,
  agent: RunLimits | null,
  task: Partial<RunLimits> = {},
): RunLimits {
  const pick = (field: keyof RunLimits): number | null => {
    const value = task[field] ?? agent?.[field] ?? ceiling[field];
    const cap = ceiling[field];
    return value !== null && cap !== null ? Math.min(value, cap) : value;
  };
  return {
    wallClockMs: pick("wallClockMs"),
    spendUsd: pick("spendUsd"),
    callsInFlight: pick("callsInFlight"),
  };
}

/** The first field set above the ceiling, or null when every value fits under it. */
export function overCeiling(
  limits: Partial<RunLimits>,
  ceiling: RunLimits,
): keyof RunLimits | null {
  for (const field of LIMIT_FIELDS) {
    const value = limits[field];
    const cap = ceiling[field];
    if (value != null && cap !== null && value > cap) return field;
  }
  return null;
}

/** The first field an override raises above the effective value, or null when it only lowers. */
export function raisesAbove(
  override: Partial<RunLimits>,
  effective: RunLimits,
): keyof RunLimits | null {
  for (const field of LIMIT_FIELDS) {
    const value = override[field];
    const current = effective[field];
    if (value != null && current !== null && value > current) return field;
  }
  return null;
}

/** A wall-clock span as a person reads it: `12h`, `1h 30m`, `1m 30s`, `45s`. */
export function formatWallClock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    rest > 0 || seconds === 0 ? `${rest}s` : null,
  ].filter((part) => part !== null);
  return parts.join(" ");
}

/** The `detail` of a `limit-reached` event: which limit, and its value. */
export function describeLimit(kind: "wall-clock", ms: number): string;
export function describeLimit(kind: "spend", usd: number): string;
export function describeLimit(kind: "wall-clock" | "spend", value: number): string {
  return kind === "wall-clock"
    ? `wall-clock: ${formatWallClock(value)}`
    : `spend: $${value.toFixed(2)}`;
}

const DEFAULT_WALL_CLOCK_MS = 12 * 60 * 60 * 1000;
const DEFAULT_CALLS_IN_FLIGHT = 8;
const DEFAULT_MAX_CREDENTIALS = 3;

/**
 * What a limit's value may be, the same for the operator's ceiling, an agent's policy and a
 * task's override: a wall clock of at least a minute, and one to 64 calls in flight, the most
 * the model proxy issues a credential for. The ceiling is held to these at boot, so a value the
 * wire schemas would refuse never resolves onto a run.
 */
export const RUN_LIMIT_BOUNDS = {
  wallClockMs: { min: 60_000 },
  callsInFlight: { min: 1, max: 64 },
} as const;

/**
 * The operator's limits off the environment, the one reader both composition roots share:
 * `RYPH_RUN_MAX_WALL_CLOCK_MS` (12 h, the virtual key's own lifetime, so the two clocks agree),
 * `RYPH_RUN_MAX_SPEND_USD` (unset: no cap — money is the operator's to cap),
 * `RYPH_RUN_MAX_CALLS_IN_FLIGHT` (8), `RYPH_RUN_CONCURRENCY` (unset: no cap) and
 * `RYPH_RUN_MAX_CREDENTIALS` (3). A cap set to `0` is no cap, the stance `msEnv` takes on
 * "no deadline"; a set cap is held to `RUN_LIMIT_BOUNDS`. The graces come from the sweep's own
 * variables, so the provisioner's backstop always lands after the cancel it backs.
 */
export function deploymentLimitsFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  graces: { startupGraceMs: number; cancelGraceMs: number },
): DeploymentLimits {
  const cap = (name: string, fallback: number | null): number | null => {
    const raw = env(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      fail(`${name} must be a non-negative integer (0 for no cap), got ${JSON.stringify(raw)}`);
    }
    return value === 0 ? null : value;
  };
  const usd = (name: string): number | null => {
    const raw = env(name);
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      fail(`${name} must be a positive amount in USD, got ${JSON.stringify(raw)}`);
    }
    return value;
  };
  const maxCredentials = cap("RYPH_RUN_MAX_CREDENTIALS", DEFAULT_MAX_CREDENTIALS);
  if (maxCredentials === null) fail("RYPH_RUN_MAX_CREDENTIALS must be at least 1");
  const wallClockMs = cap("RYPH_RUN_MAX_WALL_CLOCK_MS", DEFAULT_WALL_CLOCK_MS);
  if (wallClockMs !== null && wallClockMs < RUN_LIMIT_BOUNDS.wallClockMs.min) {
    fail(
      `RYPH_RUN_MAX_WALL_CLOCK_MS must be at least ${RUN_LIMIT_BOUNDS.wallClockMs.min} ` +
        `(a minute), or 0 for no cap, got ${wallClockMs}`,
    );
  }
  const callsInFlight = cap("RYPH_RUN_MAX_CALLS_IN_FLIGHT", DEFAULT_CALLS_IN_FLIGHT);
  if (callsInFlight !== null && callsInFlight > RUN_LIMIT_BOUNDS.callsInFlight.max) {
    fail(
      `RYPH_RUN_MAX_CALLS_IN_FLIGHT must be at most ${RUN_LIMIT_BOUNDS.callsInFlight.max}, ` +
        `or 0 for no cap, got ${callsInFlight}`,
    );
  }
  return {
    ceiling: {
      wallClockMs,
      spendUsd: usd("RYPH_RUN_MAX_SPEND_USD"),
      callsInFlight,
    },
    concurrency: cap("RYPH_RUN_CONCURRENCY", null),
    maxCredentials,
    deadlineGraceMs: graces.startupGraceMs + graces.cancelGraceMs,
    startupGraceMs: graces.startupGraceMs,
  };
}

/** The provisioner's deadline for a run: its wall clock plus the graces, or null when it has
 * no wall clock. Rounded up so the backstop never lands before the limit it backs. */
export function deadlineSecondsFor(limits: RunLimits, deadlineGraceMs: number): number | null {
  if (limits.wallClockMs === null) return null;
  return Math.ceil((limits.wallClockMs + deadlineGraceMs) / 1000);
}
