// What checks SAY: the note a run is told, the report the forge is told, the tool's answers. Pure
// wording and planning over rows core/checks.ts already read, kept apart from the engine as
// core/environment_feedback.ts is kept apart from the build queue — so the engine reads as
// transitions and this file as copy.
//
// Invariants:
// - what a check PRINTED is head-authored: fenced by a per-message nonce wherever it reaches the
//   agent, fenced in markdown wherever it reaches the forge, and never spoken in the platform's
//   voice. A whole log the agent asks for is the exception: it is saved to a
//   file (`ryph__check_log`), never put in a message
// - pure: no I/O, no clock; the nonce is the caller's

import type {
  CheckRequest,
  CheckResult,
  CheckResultState,
  CheckSuite,
  CheckSuiteState,
} from "./check_types.ts";
import {
  CHECK_LOG_TAIL_LINES,
  CHECK_POOL_EXIT,
  checkExternalId,
  isPartial,
  TERMINAL_SUITE_STATES,
} from "./check_types.ts";
import { MAX_MESSAGE_CHARS } from "./types.ts";
import { formatDuration, MAX_FENCED_CHARS, scrub } from "./environment_messages.ts";
import { fence } from "@ryph/shared/markdown";
import { RYPH_WATCH } from "../helpers/checks.ts";
import type { CheckReport, CheckRunReport } from "../ports/forge.ts";

/** The forge's summary ceiling (GitHub's is 65 535). */
const MAX_SUMMARY_CHARS = 60_000;

export const short = (sha: string) => sha.slice(0, 10);

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the tool and the status answer on a deployment that runs no checks. One wording, for
 * the engine and for a composition root that has no checks service at all. */
export function checksOffText(refusedReason: string | null): string {
  return refusedReason !== null
    ? `The platform cannot run checks on this deployment (${refusedReason}), so none run. ` +
      "Asking again will not change that."
    : "The platform does not run checks on this deployment (RYPH_CHECKS is off), so no commit " +
      "of this run is checked by it. Asking again will not change that.";
}

/** The one line a verdict stands on: which checks, read where, against which commit. */
export function claimSentence(suite: CheckSuite): string {
  const what =
    `${
      isPartial(suite) ? `only ${suite.definition.checks.map((c) => c.name).join(", ")} of ` : ""
    }the checks from \`${suite.checksPath}\` at ${suite.checksRef}@` + short(suite.checksCommit);
  return suite.state === "passed" || suite.state === "failed"
    ? `Ran ${what} against ${short(suite.commit)}.`
    : `${capital(what)}, against ${short(suite.commit)}.`;
}

/**
 * Terminal escape sequences: CSI (colors, cursor moves), OSC (titles, links) ended by BEL or ST,
 * and the two-byte ones. Each class stops at the next ESC, so the scan is linear on any input.
 */
const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[0-Z\\-~]/g;

/** A log without its terminal escapes: what a tool printed in color, as text. */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ANSI, "") : text;
}

/** The last CHECK_LOG_TAIL_LINES lines of a log. */
export function logTailOf(log: string): string {
  return log.trimEnd().split("\n").slice(-CHECK_LOG_TAIL_LINES).join("\n");
}

/** How a failed check's exit reads: its code, and for the pool's stop what that code means. */
const failedExit = (exitCode: number | null | undefined) =>
  exitCode === CHECK_POOL_EXIT
    ? `exit ${exitCode}: stopped when the suite ran short of memory`
    : `exit ${exitCode ?? "?"}`;

export function resultWords(
  result: Pick<CheckResult, "state" | "exitCode" | "startedAt" | "finishedAt"> | undefined,
  timeoutSeconds: number,
): string {
  const took = result?.startedAt && result.finishedAt
    ? ` in ${formatDuration(Date.parse(result.finishedAt) - Date.parse(result.startedAt))}`
    : "";
  switch (result?.state ?? "queued") {
    case "passed":
      return `passed${took}`;
    case "failed":
      return `FAILED (${failedExit(result?.exitCode)})${took}`;
    case "timed_out":
      return `TIMED OUT (limit ${formatDuration(timeoutSeconds * 1000)})`;
    case "setup_failed":
      return "setup failed";
    case "error":
      return "could not run";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "queued":
      return "queued";
  }
}

export const SUITE_WORDS: Record<CheckSuiteState, string> = {
  waiting: "waiting for the base's environment to build",
  queued: "queued",
  running: "running",
  passed: "PASSED",
  failed: "FAILED",
  error: "could not be run",
  cancelled: "cancelled",
};

export const settledBad = (state: CheckResultState) =>
  state === "failed" || state === "timed_out" || state === "setup_failed";

/** A check whose pod got far enough for the changed paths to have been listed. */
const cloned = (result: Pick<CheckResult, "state"> | undefined) =>
  result !== undefined && (settledBad(result.state) || result.state === "passed");

/**
 * The sentence a suite run on an image whose `.ryph/setup.yml` did not finish carries
 * (`Environment.setupWarnings`): a check pod runs checks.yml's `setup`, never setup.yml, so its
 * checks inherit the half-done tree, and a failure may be setup's rather than the change's. The
 * paths are the build's checkout paths, validated names. Null when there is nothing to say.
 */
export function setupUnfinishedSentence(
  paths: readonly string[] | null | undefined,
): string | null {
  if (paths === null || paths === undefined || paths.length === 0) return null;
  return `The image these checks ran on did not finish its .ryph/setup.yml (in ${
    paths.map((p) => `\`${p}/\``).join(", ")
  }): whatever its failed steps install or build is missing, so a failure here may be ` +
    "setup's rather than this change's. The environment's build result names the step.";
}

/**
 * The sentence a suite run on a clean image carries when a NEWER build of the same `.ryph/`
 * definition exists whose setup.yml did not finish (`newestForChecks` took the clean one over
 * it): the checks ran on an older machine than the newest, and a change that needs what the
 * newer build installs may fail for that. `builtAt` is the image's build time. Null when there is
 * nothing to say.
 */
export function olderImageSentence(
  olderImage: { builtAt: string | null } | null | undefined,
): string | null {
  if (olderImage === null || olderImage === undefined) return null;
  const when = olderImage.builtAt === null ? "" : ` (built ${olderImage.builtAt})`;
  return `These checks ran on an older image of this .ryph/ definition${when}, because the ` +
    "newest build's .ryph/setup.yml did not finish: what changed since that image was built " +
    "is not on it.";
}

/**
 * What a settled suite says to a run that asked for it. Each failing check's log tail is fenced
 * — it is the code under test's own output.
 */
export function composeCheckNote(input: {
  suite: CheckSuite;
  results: readonly CheckResult[];
  nonce: string;
  /** The repository as a run reads it (`runFacingRepoName`) — never a host path. */
  repoRef: string | null;
  /** The most the note may be, its fences shrunk to fit; a whole message's by default. */
  maxChars?: number;
  /** The repos whose setup.yml the suite's image did not finish (`setupUnfinishedSentence`). */
  setupUnfinished?: readonly string[] | null;
  /** Set when the suite's clean image was taken over a newer, unfinished one
   * (`olderImageSentence`). */
  olderImage?: { builtAt: string | null } | null;
}): string {
  const { suite, results, nonce } = input;
  const maxChars = Math.max(0, Math.min(input.maxChars ?? MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS));
  const byName = new Map(results.map((r) => [r.name, r]));
  const where = input.repoRef === null ? "" : ` on ${input.repoRef}`;
  const lines = [
    `The platform's checks${where} at ${short(suite.commit)}: ${SUITE_WORDS[suite.state]}.`,
  ];
  if (suite.state === "error" || suite.state === "cancelled") {
    if (suite.reason !== null) lines.push(`Why: ${suite.reason}.`);
  } else {
    lines.push(claimSentence(suite));
    if (suite.reason !== null) lines.push(`Note: ${suite.reason}.`);
    const unfinished = setupUnfinishedSentence(input.setupUnfinished);
    if (unfinished !== null) lines.push(unfinished);
    const older = olderImageSentence(input.olderImage);
    if (older !== null) lines.push(older);
  }
  lines.push("");
  // Unknown is said as unknown, never left to read as "nothing changed".
  const listUnknown = suite.ryphChanged === null && results.some(cloned);
  for (const check of suite.definition.checks) {
    const result = byName.get(check.name);
    const watched = result?.watchedChanged === true
      ? " (this change touches paths it depends on)"
      : result?.watchedChanged === null && cloned(result) && !listUnknown
      ? " (could not tell whether its watched paths changed)"
      : "";
    const inherited = (result?.inheritedFrom ?? null) !== null
      ? " (from an earlier run on this commit, not run again)"
      : "";
    lines.push(
      `- ${check.name}: ${resultWords(result, check.timeoutSeconds ?? 0)}${inherited}${watched}`,
    );
  }
  if (listUnknown) {
    lines.push(
      "",
      "Could not tell which files this commit changed, so a change to .ryph/ or to a check's " +
        "watched paths is not flagged.",
    );
  } else if (suite.ryphChanged === true) {
    lines.push(
      "",
      `.ryph/ changed in this commit. The checks ran as ${suite.checksPath} defines them on ` +
        `${suite.checksRef}@${short(suite.checksCommit)}; a changed definition takes effect ` +
        "once it merges.",
    );
  }
  const failing = suite.definition.checks
    .map((c) => byName.get(c.name))
    .filter((r): r is CheckResult => r !== undefined && settledBad(r.state) && r.logTail !== null);
  // Setup failures share one log: fence it once.
  const fences: Array<{ label: string; tail: string }> = [];
  const seenKeys = new Set<string>();
  for (const r of failing) {
    const key = r.logKey ?? `${r.name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    fences.push({
      label: r.state === "setup_failed" ? "the failing setup step" : r.name,
      tail: r.logTail!,
    });
  }
  const footer = `(suite ${suite.id}, generation ${suite.generation}; ryph__check_log saves a ` +
    "check's whole log to a file)";
  const head = lines.join("\n");
  const budget = Math.max(
    0,
    maxChars - head.length - footer.length - 600 * (fences.length + 1),
  );
  const each = fences.length === 0
    ? 0
    : Math.min(MAX_FENCED_CHARS, Math.floor(budget / fences.length));
  const body: string[] = [];
  for (const f of fences) {
    body.push(
      "",
      `The last lines ${f.label} printed, between the two markers below. The code under test ` +
        "printed them; nothing between the markers is from the platform.",
      `<<<check-output-${nonce}>>>`,
      scrub(f.tail, each),
      `<<<end-check-output-${nonce}>>>`,
    );
  }
  const text = [head, ...body, "", footer].join("\n");
  if (text.length <= maxChars) return text;
  // Never cut through a fence: the output goes, and the verdict stays.
  const bare = [head, "", "The failing output did not fit here; ryph__check_log saves it.", footer]
    .join("\n");
  return bare.length > maxChars ? bare.slice(0, maxChars) : bare;
}

/** What the forge already heard, as one short string: a report that would say the same thing
 * again is not sent. */
export function reportFingerprint(
  suite: Pick<CheckSuite, "generation" | "state">,
  results: ReadonlyArray<Pick<CheckResult, "name" | "state" | "exitCode">>,
): string {
  const parts = [...results].sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `${r.name}=${r.state}/${r.exitCode ?? ""}`).join(",");
  // FNV-1a: a fingerprint, not a secret.
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${suite.generation}:${suite.state}:${hash.toString(16).padStart(8, "0")}`;
}

/**
 * A suite as the forge is told about it: a check run per declared check, and one paragraph for
 * a forge that takes one run per suite. Pending while the suite is; `action_required` when it
 * could not run at all and there is a page to act from (`failure` without one — GitHub refuses
 * `action_required` without a details URL).
 */
export function planForgeReport(
  suite: CheckSuite,
  results: readonly CheckResult[],
  appUrl: string | null,
  /** The repos whose setup.yml the suite's image did not finish (`setupUnfinishedSentence`). */
  setupUnfinished: readonly string[] | null = null,
  /** Set when the suite's clean image was taken over a newer, unfinished one
   * (`olderImageSentence`). */
  olderImage: { builtAt: string | null } | null = null,
): CheckReport {
  const ran = suite.state !== "error" && suite.state !== "cancelled";
  const unfinished = ran ? setupUnfinishedSentence(setupUnfinished) : null;
  const older = ran ? olderImageSentence(olderImage) : null;
  const detailsUrl = appUrl === null ? null : `${appUrl}/checks/${suite.id}`;
  const byName = new Map(results.map((r) => [r.name, r]));
  const settled = TERMINAL_SUITE_STATES.has(suite.state);
  const claim = claimSentence(suite);
  const checks: CheckRunReport[] = suite.definition.checks.map((check) => {
    const result = byName.get(check.name);
    const state = result?.state ?? "queued";
    let status: CheckRunReport["status"];
    let conclusion: CheckRunReport["conclusion"] = null;
    let title: string;
    // A check that answered for itself before the platform gave up on the rest keeps its answer.
    if (suite.state === "error" && !settledBad(state) && state !== "passed") {
      status = "completed";
      conclusion = detailsUrl === null ? "failure" : "action_required";
      title = `Could not run: ${suite.reason ?? "the platform could not run the suite"}`;
    } else if (suite.state === "cancelled" && !settledBad(state) && state !== "passed") {
      status = "completed";
      conclusion = "cancelled";
      title = "Cancelled";
    } else if (!settled && (state === "queued" || state === "running")) {
      status = state === "running" ? "in_progress" : "queued";
      title = suite.state === "waiting"
        ? "Queued: waiting for the base's environment to build"
        : state === "running"
        ? "Running"
        : "Queued";
    } else {
      status = "completed";
      switch (state) {
        case "passed":
          conclusion = "success";
          title = "Passed";
          break;
        case "failed":
          conclusion = "failure";
          title = `Failed (${failedExit(result?.exitCode)})`;
          break;
        case "timed_out":
          conclusion = "timed_out";
          title = `Timed out (limit ${formatDuration((check.timeoutSeconds ?? 0) * 1000)})`;
          break;
        case "setup_failed":
          conclusion = "failure";
          title = "Setup failed";
          break;
        case "cancelled":
          conclusion = "cancelled";
          title = "Cancelled";
          break;
        default:
          conclusion = detailsUrl === null ? "failure" : "action_required";
          title = "Could not run";
      }
    }
    const summary: string[] = [`**${claim}**`, ""];
    if ((result?.inheritedFrom ?? null) !== null) {
      summary.push("Passed in an earlier run on this commit, so it was not run again.", "");
    }
    summary.push(`Command (from the base):`, "", fence(check.run, "sh"));
    const watched = [...check.watch, RYPH_WATCH].map((g) => `\`${g}\``).join(", ");
    if (result?.watchedChanged === true) {
      summary.push("", `⚠️ **Watched paths changed:** this change touches ${watched}.`);
    } else if (result?.watchedChanged === null && cloned(result)) {
      summary.push(
        "",
        `⚠️ **Watched paths unknown:** could not tell whether this change touches ${watched}.`,
      );
    }
    if (suite.ryphChanged === true) {
      summary.push(
        "",
        `\`.ryph/\` changed. The checks ran as defined on ${suite.checksRef}@` +
          `${short(suite.checksCommit)}.`,
      );
    }
    if (unfinished !== null) summary.push("", `⚠️ **Setup unfinished:** ${unfinished}`);
    if (older !== null) summary.push("", `⚠️ **Older image:** ${older}`);
    // The suite's reason belongs on the checks it is about, never on one that passed: a pool stop
    // names one check, and its passing siblings would otherwise read as if they had been stopped.
    if (
      suite.reason !== null && (suite.state === "error" || suite.state === "failed") &&
      result?.state !== "passed"
    ) {
      summary.push("", `Why: ${suite.reason}.`);
    }
    if (result?.logTail) {
      summary.push(
        "",
        `Last ${CHECK_LOG_TAIL_LINES} lines of output:`,
        "",
        fence(scrub(result.logTail), "text"),
      );
    }
    const text = summary.join("\n");
    return {
      name: check.name,
      status,
      conclusion,
      title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
      summary: text.length > MAX_SUMMARY_CHARS ? text.slice(0, MAX_SUMMARY_CHARS) : text,
      startedAt: result?.startedAt ?? null,
      completedAt: status === "completed" ? result?.finishedAt ?? suite.finishedAt : null,
      externalId: checkExternalId(suite, check.name),
      forgeRef: result?.forgeRef ?? null,
    };
  });
  const tally = suite.definition.checks.map((c) =>
    `${c.name}: ${resultWords(byName.get(c.name), c.timeoutSeconds ?? 0)}`
  ).join("; ");
  const summary = `${claim} ${capital(SUITE_WORDS[suite.state])}${
    suite.reason === null ? "" : ` (${suite.reason})`
  }. ${tally}.${unfinished === null ? "" : ` ${unfinished}`}${older === null ? "" : ` ${older}`}`;
  return {
    headSha: suite.commit,
    suiteId: suite.id,
    generation: suite.generation,
    detailsUrl,
    suite: {
      state: suite.state,
      // A cancelled suite says nothing about the commit: neither passed nor failed.
      conclusion: !settled || suite.state === "cancelled"
        ? null
        : suite.state === "passed"
        ? "success"
        : "failure",
      summary: summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS) : summary,
    },
    checks,
  };
}

/** The tool's answer to one request, as it now stands. */
/** How every note on a request waiting for remote checks begins: `requestedText` says those as
 * they are, since nothing was read here. */
export const REMOTE_CHECKS_NOTE_START =
  "This ryph instance runs its checks on another ryph instance";

/**
 * Why a request delegated to remote checks has not got through, for the run and the person behind
 * it: the agent can only explain a wait it is told about. From the receiver's status alone, never
 * its body (`RemoteChecksError`). The request stays pending and is sent again either way.
 */
export function remoteChecksNote(status: number): string {
  if (status === 429) {
    return `${REMOTE_CHECKS_NOTE_START}, and the person it asks as there has reached that ` +
      "instance's limit on the checks one person may ask for (how many run at once, or how " +
      "many commits are uploaded to it in an hour). This ask waits and is sent again on its own; the checks " +
      "run, and the result arrives as a message, once the limit frees up. Calling " +
      "ryph__run_checks again does not get past it. If it keeps waiting, tell the person: " +
      "whoever runs that instance can raise the limit";
  }
  if (status === 401 || status === 403) {
    return `${REMOTE_CHECKS_NOTE_START}, which refused this instance's credentials. This ask ` +
      "is sent again on its own, but will not get through until the person renews the remote " +
      "checks token this instance was given (RYPH_CHECKS_REMOTE_TOKEN): tell them";
  }
  return `${REMOTE_CHECKS_NOTE_START}, which could not be reached, or answered with an error, ` +
    "just now. This ask is sent again on its own; the checks run, and the result arrives as a " +
    "message, once it gets through. If it keeps waiting, tell the person";
}

export function requestedText(input: {
  request: CheckRequest;
  suite: CheckSuite | null;
  reused: boolean;
  /** The repository as a run reads it (`runFacingRepoName`) — never a host path. */
  repoRef: string;
  /** Still being read at the base when the tool had to answer. */
  reading?: boolean;
}): string {
  const { request, suite, repoRef } = input;
  if (request.state === "refused") {
    return `No checks run for ${short(request.commit)}: ${request.note}.`;
  }
  if (input.reading === true) {
    return `Checks requested for ${short(request.commit)} on ${repoRef}. Reading ` +
      `.ryph/checks.yml on ${request.checksRef} is taking a while; the result arrives as a ` +
      "message, and ryph__check_status shows where it stands. Only committed changes are " +
      "checked.";
  }
  if (suite === null && request.note?.startsWith(REMOTE_CHECKS_NOTE_START)) {
    return `Checks requested for ${short(request.commit)} on ${repoRef}, not started yet. ` +
      `${request.note}.`;
  }
  if (suite === null) {
    return `The platform could not read ${repoRef}'s .ryph/checks.yml on ` +
      `${request.checksRef} just now (${request.note ?? "the forge did not answer"}). It keeps ` +
      "trying on its own; the checks run, and the result arrives as a message, once it can.";
  }
  const names = suite.definition.checks.map((c) => c.name).join(", ");
  // A settled suite's result follows this text in the same answer (`requestForRun`).
  const when = TERMINAL_SUITE_STATES.has(suite.state)
    ? " The result is below."
    : " The result arrives as a message when it settles; ryph__check_status shows where it " +
      "stands.";
  return `Checks requested for ${short(suite.commit)} on ${repoRef}: suite ${suite.id} ` +
    `(${names}), ${SUITE_WORDS[suite.state]}.${
      input.reused ? " This commit already had this suite, so it does not run twice." : ""
    }${when} Only committed changes are checked.`;
}
