// The platform's checks, as the run reaches them — the channel behind the agent's `run_checks`,
// `check_status` and `check_log` tools. A repo's `.ryph/checks.yml` names commands the platform runs against
// a commit in a container the run never touches, and the verdict it reports is the one a patch
// is judged by; the agent's own test runs in its shell are for its speed only.
//
// `request` asks for a suite on a commit this run has ALREADY uploaded through forge intake (the
// same bundle a patch ships as, cut from the committed tip); the platform finds the commit by its
// head, branch and base, derives the bundle's key itself, and trusts nothing else in the ask.
//
// `request` and `status` answer TEXT, composed by the control plane with each check's output
// already fenced and marked as the check's; the runner hands it to the agent as a tool result and
// parses nothing in it — the same contract as `environment_status`. `log` answers a check's whole
// log as bytes, which the runner writes to a file for the agent and never reads.

import type { ChecksDeclaration } from "../core/types.ts";

export interface ChecksRequest {
  /** The checkout directory of the repo, as the run's entry names it. */
  path: string;
  /** The committed tip the bundle carried. */
  headSha: string;
  /** The branch the bundle carried: the run's branch in that repo, in its current generation. */
  branch: string;
  /** The commit the bundle was cut from. */
  baseSha: string;
  /** Only these checks, by name; absent, all of them. */
  checks?: string[];
}

/** The most commits one status asks about: the control plane's own limit, which refuses more. */
export const MAX_STATUS_COMMITS = 8;

/** A commit of one of the run's repos: its checkout directory and the SHA. */
export interface CheckCommit {
  path: string;
  commit: string;
}

/** One check's log, as the platform keeps it: the check's own output, never the platform's.
 * UTF-8 bytes, handed on to a file as they came. */
export interface CheckLog {
  bytes: Uint8Array;
  generation: number;
}

/** The platform answered, and the answer was no: its reason is the message. */
export class ChecksRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksRefusedError";
  }
}

/** What the platform said to a checks request. */
export interface ChecksAnswer {
  /** True when it queued or joined a suite (202); false when it answered without starting
   * anything, because checks are off here or there is nothing to run (200). */
  requested: boolean;
  text: string;
}

/**
 * The request went out and no answer came back in time. The platform may still be working on
 * it, so this is neither a refusal nor a failure to ask: `check_status` tells which.
 */
export class ChecksUnansweredError extends Error {
  constructor(message = "the platform did not answer in time") {
    super(message);
    this.name = "ChecksUnansweredError";
  }
}

/** One verdict a run is still owed, as the platform names it. */
export interface OwedVerdict {
  /** Which verdict: a suite's generation, or a request still being read. Opaque; only compared. */
  id: string;
  /** The run's requests owed it. A request keeps its name from the ask to the verdict, so a
   * verdict whose every request was given up on was given up on, whatever it is called now. */
  requests: readonly string[];
}

export interface ChecksChannel {
  /** Asks for a suite on an uploaded commit. Throws with the platform's own reason when it
   * refuses, `ChecksUnansweredError` when it did not answer in time, and a plain error when it
   * could not be asked. */
  request(args: ChecksRequest): Promise<ChecksAnswer>;
  /** Where this run's latest suites stand, and with `at`, the suites anyone ran on those
   * commits (only those when `at.named`). Throws when it could not be asked. */
  status(at?: { commits: CheckCommit[]; named: boolean }): Promise<string>;
  /** One check's whole stored log, of the suite's current generation unless `generation` names
   * another. Throws `ChecksRefusedError` with the platform's reason when it has none to give,
   * and a plain error when it could not be asked. */
  log(args: { suiteId: string; check: string; generation?: number }): Promise<CheckLog>;
  /**
   * Which verdicts this run is still owed: suites its `run_checks` or its patches asked for
   * whose result is not in the run's inbox yet. Empty means every verdict is there to be read.
   * The runner's own question, never the agent's: neither a finish nor the idle clock ends the
   * run while one is owed that it has not given up on (within a bound). Throws when it could
   * not be asked.
   */
  awaiting(): Promise<OwedVerdict[]>;
  /**
   * What each repo's `.ryph/checks.yml` declares at its base, for the prompt, and which repos'
   * files could not be read. Asked for once, while the run clones; slow, since the platform
   * reads each file through the forge. Throws when it could not be asked or did not answer in
   * time.
   */
  declared(signal?: AbortSignal): Promise<ChecksDeclaration>;
}
