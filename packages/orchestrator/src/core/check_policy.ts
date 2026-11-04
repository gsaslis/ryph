// The operator's knobs for checks. Pure, like
// `servicePolicyFromEnv`: both composition roots read the same variables the same way.
//
// `RYPH_CHECKS` defaults OFF: turning it on means this deployment runs head code from any
// connected repo in pods of its own, on the operator's machines and the operator's money.

import type { RunSizes } from "./run_sizes.ts";

export interface CheckPolicy {
  /** `RYPH_CHECKS=on|off`, default off. */
  enabled: boolean;
  /** A check that names no `timeout`. */
  defaultTimeoutSeconds: number;
  /** `RYPH_CHECKS_TIMEOUT_MAX`: the ceiling any declared `timeout` is capped at. */
  maxTimeoutSeconds: number;
  /** `RYPH_CHECKS_CONCURRENCY`: check pods running at once, deployment-wide (a suite's shared pod
   * and one per `pod: own` check), at most MAX_CHECK_CONCURRENCY. */
  maxConcurrent: number;
  /** `RYPH_CHECKS_MAX_PER_RUN`: suites one run may request through `ryph__run_checks`. */
  maxPerRun: number;
  /** `RYPH_CHECKS_SIZE`: the size class check pods get; null = the repo's class, else the
   * default class. A `pod: own` check's own `size` wins for its pod, when `ownSizes` lets it. */
  sizeClass: string | null;
  /** `RYPH_CHECKS_OWN_SIZES`: the size classes a `pod: own` check may name in `size`,
   * comma-separated; every one must be a class the deployment defines. Empty (the default): a
   * check may name none, and every `size` fails its suite. An own pod without `size` gets
   * `sizeClass`'s, which is the operator's choice and always allowed. */
  ownSizes: string[];
  /** `RYPH_CHECKS_CHANGE_REQUESTS=on|off`, default on: a push to any change request of a
   * connected repo asks for its checks. Off leaves only runs, patches and re-runs asking. */
  changeRequests: boolean;
  /** `RYPH_CHECKS_LOCAL=on|off`, default on: a person may ask for checks on a commit of their own
   * from their machine (`ryph checks`, `POST /v1/check-suites`). Off answers those routes 404. */
  local: boolean;
  /** `RYPH_CHECKS_MAX_LOCAL_PER_USER`: a person's local asks still going at once, across repos. */
  maxLocalPerUser: number;
  /** `RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR`: bundles one person may upload for local asks in an
   * hour. A pushed ask uploads nothing and is not counted. */
  maxUploadsPerHour: number;
}

/** The most check pods one deployment runs at once: what one tick polls in a single pass. */
export const MAX_CHECK_CONCURRENCY = 50;

export const DEFAULT_CHECK_POLICY: CheckPolicy = {
  enabled: false,
  defaultTimeoutSeconds: 900,
  maxTimeoutSeconds: 3600,
  maxConcurrent: 4,
  maxPerRun: 60,
  sizeClass: null,
  ownSizes: [],
  changeRequests: true,
  local: true,
  maxLocalPerUser: 4,
  maxUploadsPerHour: 30,
};

/**
 * The policy, from the deployment's environment. `runSizes`: the deployment's classes, which
 * `RYPH_CHECKS_OWN_SIZES` must name only from — fatal otherwise, as `RYPH_RUN_SIZE_DEFAULT` is.
 * Null only for a reader that wants the switch alone (the docker launcher).
 */
export function checkPolicyFromEnv(
  env: (name: string) => string | undefined,
  fail: (message: string) => never,
  runSizes: RunSizes | null,
): CheckPolicy {
  const raw = env("RYPH_CHECKS")?.trim().toLowerCase() ?? "off";
  if (raw !== "on" && raw !== "off") {
    fail(`RYPH_CHECKS must be "on" or "off", got ${JSON.stringify(raw)}`);
  }
  const positive = (name: string, fallback: number): number => {
    const value = env(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      fail(`${name} must be a whole number of at least 1, got ${JSON.stringify(value)}`);
    }
    return n;
  };
  const concurrency = () => {
    const n = positive("RYPH_CHECKS_CONCURRENCY", DEFAULT_CHECK_POLICY.maxConcurrent);
    if (n > MAX_CHECK_CONCURRENCY) {
      fail(`RYPH_CHECKS_CONCURRENCY must be at most ${MAX_CHECK_CONCURRENCY}, got ${n}`);
    }
    return n;
  };
  const maxTimeoutSeconds = positive(
    "RYPH_CHECKS_TIMEOUT_MAX",
    DEFAULT_CHECK_POLICY.maxTimeoutSeconds,
  );
  const sizeClass = env("RYPH_CHECKS_SIZE")?.trim() || null;
  const ownSizes = (env("RYPH_CHECKS_OWN_SIZES") ?? "").split(",").map((s) => s.trim())
    .filter((s) => s !== "");
  if (new Set(ownSizes).size !== ownSizes.length) fail("RYPH_CHECKS_OWN_SIZES names a class twice");
  if (runSizes !== null) {
    for (const name of ownSizes) {
      if (!runSizes.classes.some((c) => c.name === name)) {
        fail(
          `RYPH_CHECKS_OWN_SIZES names "${name}", which RYPH_RUN_SIZES does not define ` +
            `(it defines ${runSizes.classes.map((c) => c.name).join(", ")})`,
        );
      }
    }
  }
  const onOff = (name: string): boolean => {
    const value = env(name)?.trim().toLowerCase() ?? "on";
    if (value !== "on" && value !== "off") {
      fail(`${name} must be "on" or "off", got ${JSON.stringify(value)}`);
    }
    return value === "on";
  };
  return {
    enabled: raw === "on",
    // The default never exceeds the ceiling: an operator who lowers the ceiling below 15 minutes
    // lowers every undeclared timeout with it.
    defaultTimeoutSeconds: Math.min(DEFAULT_CHECK_POLICY.defaultTimeoutSeconds, maxTimeoutSeconds),
    maxTimeoutSeconds,
    maxConcurrent: concurrency(),
    maxPerRun: positive("RYPH_CHECKS_MAX_PER_RUN", DEFAULT_CHECK_POLICY.maxPerRun),
    sizeClass,
    ownSizes,
    changeRequests: onOff("RYPH_CHECKS_CHANGE_REQUESTS"),
    local: onOff("RYPH_CHECKS_LOCAL"),
    maxLocalPerUser: positive(
      "RYPH_CHECKS_MAX_LOCAL_PER_USER",
      DEFAULT_CHECK_POLICY.maxLocalPerUser,
    ),
    maxUploadsPerHour: positive(
      "RYPH_CHECKS_LOCAL_UPLOADS_PER_HOUR",
      DEFAULT_CHECK_POLICY.maxUploadsPerHour,
    ),
  };
}
