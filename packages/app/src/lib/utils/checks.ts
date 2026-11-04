// Check suites as the pages show them: the words for each state, what a suite counts to, which
// suites belong to a run or a patch, and the one sentence that says what a pass means.

import type {
  CheckResultState,
  CheckSuiteState,
  CheckSuiteView,
  CheckView,
  Patch,
} from "$lib/api/types";
import { shortCommit, shortImage } from "./environments";
import { branchName } from "./format";

/** A suite in one of these has a verdict, and nothing about it moves on its own any more. */
const SETTLED: ReadonlySet<CheckSuiteState> = new Set(["passed", "failed", "error", "cancelled"]);

export function isSuiteSettled(state: CheckSuiteState): boolean {
  return SETTLED.has(state);
}

/** Any settled suite can be run again, a passed one included (the forge offers the same); a live
 * one has no verdict to run again yet. */
export function canRerunSuite(state: CheckSuiteState): boolean {
  return isSuiteSettled(state);
}

const LABELS: Record<CheckSuiteState | CheckResultState, string> = {
  waiting: "Waiting for build",
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  timed_out: "Timed out",
  setup_failed: "Setup failed",
  error: "Error",
  cancelled: "Cancelled",
};

/** A suite's or a check's state in words. The two share most of theirs. */
export function checkStateLabel(state: CheckSuiteState | CheckResultState): string {
  return LABELS[state] ?? state;
}

/** How a state reads at a glance: good, bad, still going, or neither. */
export type CheckTone = "passed" | "failed" | "active" | "idle";

export function checkTone(state: CheckSuiteState | CheckResultState): CheckTone {
  switch (state) {
    case "passed":
      return "passed";
    case "failed":
    case "timed_out":
    case "setup_failed":
    case "error":
      return "failed";
    case "running":
      return "active";
    default:
      return "idle";
  }
}

/** A suite's checks, counted. */
export function suiteCounts(suite: Pick<CheckSuiteView, "checks">): {
  passed: number;
  failed: number;
  total: number;
} {
  let passed = 0;
  let failed = 0;
  for (const check of suite.checks) {
    const tone = checkTone(check.state);
    if (tone === "passed") passed += 1;
    else if (tone === "failed") failed += 1;
  }
  return { passed, failed, total: suite.checks.length };
}

/** "3 of 4 passed", or "No checks" for a suite that never got as far as naming any. */
export function countsLabel(counts: { passed: number; failed: number; total: number }): string {
  if (counts.total === 0) return "No checks";
  if (counts.failed > 0) return `${counts.failed} of ${counts.total} failed`;
  return `${counts.passed} of ${counts.total} passed`;
}

/** A check that got as far as running its command, so what the change touched was known or
 * should have been. */
function ran(state: CheckResultState): boolean {
  return state === "passed" || state === "failed" || state === "timed_out";
}

/**
 * Whether a check's watched files changed, as a badge: "changed", "unknown" when the check ran
 * and the platform could not tell which files the change touched, or null for nothing to show.
 * Unknown is never shown as unchanged.
 */
export function watchedChange(
  check: Pick<CheckView, "state" | "watchedChanged">,
): "changed" | "unknown" | null {
  if (check.watchedChanged === true) return "changed";
  if (check.watchedChanged === null && ran(check.state)) return "unknown";
  return null;
}

/** Whether the change edits `.ryph/`, on the same terms as `watchedChange`. */
export function ryphChange(
  suite: Pick<CheckSuiteView, "ryphChanged" | "checks">,
): "changed" | "unknown" | null {
  if (suite.ryphChanged === true) return "changed";
  if (suite.ryphChanged === null && suite.checks.some((check) => ran(check.state))) {
    return "unknown";
  }
  return null;
}

/** Running checks tick against `now`; finished checks always use their recorded end. */
export function checkDurationMs(
  check: Pick<CheckView, "startedAt" | "finishedAt" | "state">,
  now: number = Date.now(),
): number | null {
  if (check.startedAt === null) return null;
  const end = check.finishedAt === null
    ? (check.state === "running" ? now : NaN)
    : Date.parse(check.finishedAt);
  const ms = end - Date.parse(check.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The suites that belong to one run: the ones it asked for itself, and the ones on the heads of
 * the patches it produced. Oldest first, as the detail lists them.
 */
export function suitesForRun(
  suites: CheckSuiteView[],
  runId: string | null,
  patchIds: ReadonlySet<string>,
): CheckSuiteView[] {
  if (runId === null) return [];
  return suites.filter((suite) =>
    suite.requestedBy.some((r) =>
      r.runId === runId || (r.patchId !== null && patchIds.has(r.patchId))
    )
  );
}

/**
 * The suites a run's list shows with their checks open: the newest full suite of each line of work
 * — a repo's path and line, read off the run's patch the suite belongs to — and any suite that did
 * not pass or is still going. One a patch's head asked for, or the patch names, is that patch's
 * line; a suite the run asked for at a head no patch has is listed apart, by its repo alone. A run
 * of only some checks is never the verdict, and a suite run again is as new as its latest launch.
 */
export function listedSuiteIds(
  suites: CheckSuiteView[],
  patches: ReadonlyArray<
    Pick<Patch, "id" | "connectedRepoId" | "path" | "line" | "headSha" | "checksSuiteId">
  >,
): Set<string> {
  const lineOf = (suite: CheckSuiteView): string => {
    const patch = patches.find((p) => p.checksSuiteId === suite.id) ??
      patches.find((p) => suite.requestedBy.some((r) => r.patchId === p.id)) ??
      patches.find((p) =>
        p.connectedRepoId === suite.connectedRepoId && p.headSha === suite.commit
      );
    return patch === undefined
      ? `${suite.connectedRepoId}\0`
      : `${patch.connectedRepoId}\0${patch.path}\0${patch.line}`;
  };
  const at = (suite: CheckSuiteView) => Date.parse(suite.launchedAt ?? suite.createdAt);
  const newest = new Map<string, CheckSuiteView>();
  for (const suite of suites) {
    if (suite.partial) continue;
    const key = lineOf(suite);
    const prev = newest.get(key);
    if (prev === undefined || at(suite) > at(prev)) newest.set(key, suite);
  }
  const verdicts = new Set([...newest.values()].map((suite) => suite.id));
  return new Set(
    suites
      .filter((suite) =>
        verdicts.has(suite.id) || (suite.state !== "passed" && suite.state !== "cancelled")
      )
      .map((suite) => suite.id),
  );
}

/** "Only lint, test" for a run of some of the checks; null for a run of all of them. */
export function partialLabel(suite: Pick<CheckSuiteView, "partial" | "checks">): string | null {
  if (!suite.partial) return null;
  return `Only ${suite.checks.map((check) => check.name).join(", ")}`;
}

/** Where the checks came from: `.ryph/checks.yml` at `main@1a2b3c4`. */
export function definedAtLabel(
  suite: Pick<CheckSuiteView, "checksRef" | "checksCommit">,
): string {
  return `${branchName(suite.checksRef)}@${shortCommit(suite.checksCommit)}`;
}

/** The image the suite ran in, short; the environment key while no image was chosen yet. */
export function suiteImageLabel(suite: Pick<CheckSuiteView, "environment">): string {
  const { image, key } = suite.environment;
  if (image !== null) return shortImage(image);
  return key.startsWith("default:") ? "the default image" : "the repository's environment";
}

/** How long a timeout is, in the units a checks file writes it in. */
export function timeoutLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The most matches a search of a log counts: past it, the count says "+". */
export const MAX_LOG_MATCHES = 10_000;

/**
 * The lines of a log that hold `query`, one-based and each once, ignoring case: what a find bar
 * steps through. An empty query matches nothing.
 */
export function logMatchLines(log: string, query: string): number[] {
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const hay = log.toLowerCase();
  const lines: number[] = [];
  let line = 1;
  let counted = 0;
  let at = hay.indexOf(needle);
  while (at !== -1 && lines.length < MAX_LOG_MATCHES) {
    // The line a match is on: the newlines between the last one counted and it.
    for (let i = hay.indexOf("\n", counted); i !== -1 && i < at; i = hay.indexOf("\n", i + 1)) {
      line += 1;
      counted = i + 1;
    }
    if (lines.at(-1) !== line) lines.push(line);
    // On to the next line: a line is a match once, however often it holds the query.
    const next = hay.indexOf("\n", at + needle.length);
    if (next === -1) break;
    at = hay.indexOf(needle, next + 1);
  }
  return lines;
}

/** How long a whole suite took, from its pod starting to its last check settling. */
export function suiteDurationMs(
  suite: Pick<CheckSuiteView, "launchedAt" | "createdAt" | "finishedAt" | "state">,
  now: number = Date.now(),
): number | null {
  const end = suite.finishedAt === null
    ? (suite.state === "running" && suite.launchedAt !== null ? now : NaN)
    : Date.parse(suite.finishedAt);
  const ms = end - Date.parse(suite.launchedAt ?? suite.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** "2 of 4 done" for a suite still going: how far it has got. */
export function progressLabel(suite: Pick<CheckSuiteView, "checks">): string {
  const done = suite.checks.filter((check) => !["queued", "running"].includes(check.state)).length;
  return `${done} of ${suite.checks.length} done`;
}
