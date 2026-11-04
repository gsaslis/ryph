// The agent's own capabilities over its own run — a DRIVING port, like RunControl: the outside
// (the loopback tool server the harness's MCP client dials) calls in through it, and the core
// implements it once the clones exist.
//
// Nothing here widens the run. `submitPatch` is what finalize already does, done earlier and on
// the agent's say-so; `finish` ends a run that would otherwise wait for its next message on its
// idle clock; `reportOutcome` says how the run stands without ending it; `patches` reads back what the run itself reported;
// `environmentStatus` reads what the platform's builds of those patches came to;
// `checkoutChangeRequest` moves a repo the run ALREADY holds onto a change request of that same
// repo, which the platform grants or refuses — no new repo, no new credential, no new scope.
// `updateFromBase` merges a branch the run's grant already serves (the repo's target) into the
// run's own branch — the same read a clone makes, and nothing leaves the box.
// `runChecks` uploads the committed tip the way a patch ships it — intake, not a push — and asks
// the platform to judge it; it can request a verdict, never report one. `checkStatus` reads it.
// `wake` asks the conversation to hand the agent a message of its own later, which holds the run
// no longer than its idle clock plus the hour the wake-up is capped at.
// `backgroundRun` starts a command the agent's own bash could run, with the same uid, env and
// network, and only watches it: it adds visibility, not capability. A running one holds the run
// no longer than its timeout, capped at two hours.
// `subagentStart` hands a piece of work to a second agent in the same container, as the same uid,
// with the run's own model and a subset of the agent's own tools (none of the runner's): it adds
// context, not capability. A running one holds the run no longer than its wall clock, capped at an
// hour per stretch of its work.
// `publishArtifact` hands the platform a file the agent wrote in its checkout, as a page every
// member of the instance can open — only where the agent may publish them, which the platform
// re-reads on every publish. `fetchArtifact` writes into the checkout an artifact of the agent's
// that this run may update (the platform decides which), refusing any path outside the checkout
// or a link out of it, as the agent's own bash could.
// A stolen loopback token therefore adds nothing a persuaded agent could not already do.

import type { StatusComment } from "../core/types.ts";
import type { DeclaredOutcome, TerminalOutcome } from "./harness.ts";

export interface RunActions {
  /**
   * Marks the run done and says how it went: it finalizes after the agent's current settle, once
   * no check verdict the run caused is still owed. Records the report as `reportOutcome` does.
   * False, and nothing recorded or ended, once the run is finalizing. Only a terminal outcome:
   * a run still in progress is not finished.
   */
  finish(args: OutcomeReport & { outcome: TerminalOutcome }): boolean;
  /**
   * Says how the run stands now without ending it — "in-progress" while required work or
   * verification remains — and so what the run concludes on if it ends without a finish, on its
   * idle clock (a run still in progress then ends unfinished). `summary`, when given, is the run's reported summary in place of that message;
   * `statusComment`, when given, is how much of it the thread's status comment repeats. A later
   * report's outcome replaces an earlier one's; a summary or status comment it leaves out keeps
   * the earlier one's. False, and nothing recorded, once the run is finalizing; "finished", and
   * nothing recorded, once the agent called `finish`: the run ends at its settle whatever a report
   * said after, so a report would only claim it stays open (a second `finish` changes the
   * outcome).
   */
  reportOutcome(args: OutcomeReport & { awaitingUserTurn?: boolean }): boolean | "finished";
  /**
   * Ships one branch of a repo — its current commits — as a patch, a pull request, while the run
   * goes on. `path` picks the repo; it may be omitted when the run holds exactly one. `branch`
   * picks the local branch, the one the checkout is on when omitted: each branch is a line of
   * its own (@ryph/shared/lines), and becomes its own change request.
   */
  submitPatch(
    args: { path?: string; branch?: string; title?: string; description?: string },
  ): Promise<SubmitPatchOutcome>;
  /**
   * Moves one repo's checkout onto an existing change request of that repo — the run's default
   * branch line (`work`) restarts at its head — and re-targets the run onto it, so the patches submitted afterwards
   * become revisions of THAT change request instead of opening a new one. `path` picks the
   * repo; it may be omitted when the run holds exactly one.
   *
   * Only before that repo has shipped anything in this run, and only with its tree clean and
   * its branch unmoved: the swap REPLACES the branch, so work that is not shipped would be
   * lost. Refused with a reason for the agent otherwise.
   */
  checkoutChangeRequest(
    args: { path?: string; changeRequest: string },
  ): Promise<CheckoutChangeRequestOutcome>;
  /**
   * Brings the branch one repo's checkout is on up to date with the branch its work merges
   * into — a change request's base, or the run's own base — by merging that branch as it stands
   * now. A
   * conflict is left in progress for the agent; the next `submitPatch` concludes it. `path`
   * picks the repo; it may be omitted when the run holds exactly one.
   */
  updateFromBase(args: { path?: string }): Promise<UpdateFromBaseOutcome>;
  /** Every patch this run submitted, with what the run has heard about it since. */
  patches(): PatchStatus[];
  /** Where the environment builds this run's patches asked for stand, as the control plane
   * words it (the build's own output fenced). Throws when it could not be asked. */
  environmentStatus(): Promise<string>;
  /**
   * Asks the platform to run a repo's declared checks (`.ryph/checks.yml`, as the base defines
   * it) against its committed tip: the tip is uploaded as a bundle — the same one a patch would
   * ship, without becoming one — and a suite is requested on it: the tip of the branch the
   * checkout is on, under the name that branch ships as. Uncommitted changes are not
   * checked and never committed here. `path` picks the repo; it may be omitted when the run
   * holds exactly one. `checks` names the ones to run; absent or empty, all of them.
   */
  runChecks(args: { path?: string; checks?: string[] }): Promise<RunChecksOutcome>;
  /**
   * Where this run's check suites stand, as the control plane words it (each check's own output
   * fenced), and the checks anyone else ran on each repo's checked-out head. With `commit` —
   * any revision the repo at `path` resolves — only that commit's checks. Throws when it could
   * not be asked.
   */
  checkStatus(args?: { path?: string; commit?: string }): Promise<CheckStatusOutcome>;
  /** Saves one check's whole log to a file outside every clone, for the agent to read with its
   * own tools. */
  checkLog(
    args: { suiteId: string; check: string; generation?: number },
  ): Promise<CheckLogOutcome>;
  /**
   * How many check verdicts the run is still owed for checks it caused (its `runChecks`, or a
   * patch it submitted), and whether stopping now waits for them: what a finish waits for.
   */
  checksOwed(): Promise<ChecksOwed>;
  /**
   * Asks for a message from the platform after `afterMinutes` — the way to look at something
   * again later without blocking in a command, during which nothing reaches the agent.
   * `afterMinutes` is a whole number within the bounds the conversation sets. One per run: a new wake-up replaces the pending one.
   */
  wake(args: { afterMinutes: number; note?: string }): WakeOutcome;
  /**
   * Whether a text the agent is about to have recorded or shipped (a summary, a patch
   * description) may show the images it names as `![alt](img-…)`: null when every ref is one of
   * the run's kept images, or it names none; else why not, for the agent. Waits on the run's own
   * image uploads still in flight first (core/image_refs.ts).
   */
  checkImageRefs(text: string): Promise<string | null>;
  /**
   * Starts a shell command in the background and answers at once; a platform message tells the
   * agent when it ends (core/background.ts).
   */
  backgroundRun(args: BackgroundRunArgs): Promise<BackgroundRunOutcome>;
  /** One background job's status and the end of its output, or every job's status. */
  backgroundOutput(args: { id?: string; tailLines?: number }): BackgroundOutputOutcome;
  /** Stops a background job and answers once it has ended. An ended job is just reported. */
  backgroundStop(args: { id: string }): Promise<BackgroundStopOutcome>;
  /**
   * Starts a subagent on `task` and answers at once with its id; the end of each stretch of its
   * work reaches the agent as a platform message, unless the agent's own stop ended it
   * (core/subagents.ts).
   */
  subagentStart(args: SubagentStartArgs): Promise<SubagentStartOutcome>;
  /** Speaks to a subagent: a steer while it works, a continuation of it once it has ended. */
  subagentMessage(args: { id: string; text: string }): Promise<SubagentMessageOutcome>;
  /** Stops a subagent and answers once it has; no message follows. An ended one is just
   * reported, with its answer when no message has told of it. */
  subagentStop(args: { id: string }): Promise<SubagentStopOutcome>;
  /** How many subagents are running now: what a finish stops. */
  subagentsRunning(): number;
  /**
   * Per repo, the local branches with commits that were never submitted, which the run's end
   * does not ship: what a finish warns about while the agent can still submit them. Empty where
   * the run may not open patches, and when it could not be read.
   */
  unsubmittedBranches(): Promise<Array<{ path: string; list: string }>>;
  /**
   * Publishes an HTML file under the checkout root as an artifact: a new one, or the next
   * version of `artifact` (its id, or its page's URL). The file must be a regular file inside
   * the checkout root once every symlink is resolved, valid UTF-8, and at most
   * ARTIFACT_MAX_BYTES.
   */
  publishArtifact(
    args: { path: string; title: string; artifact?: string },
  ): Promise<PublishArtifactOutcome>;
  /**
   * Writes the current version of `artifact` (its id, or its page's URL), as published, to
   * `path` under the checkout root (default `artifact-<id>.html` there): a new file, or a
   * regular file already inside the root, never through a symlink.
   */
  fetchArtifact(args: { artifact: string; path?: string }): Promise<FetchArtifactOutcome>;
}

export type CheckStatusOutcome =
  | { kind: "answered"; text: string }
  | { kind: "refused"; reason: string };

export type CheckLogOutcome =
  | { kind: "saved"; path: string; bytes: number; lines: number; generation: number }
  | { kind: "refused"; reason: string };

/** The largest document an artifact may be: the platform's own cap, checked here first so the
 * agent hears it before 2 MiB crosses the network. */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export type PublishArtifactOutcome =
  | {
    kind: "published";
    id: string;
    version: number;
    url: string | null;
    created: boolean;
    unchanged: boolean;
  }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type FetchArtifactOutcome =
  | { kind: "fetched"; id: string; title: string; version: number; path: string }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export interface OutcomeReport {
  outcome: DeclaredOutcome;
  summary?: string;
  statusComment?: StatusComment;
}

/**
 * The bounds on a wake-up, in minutes. The upper one is the point: a pending wake-up keeps the
 * run — and its pod — alive past its idle clock on nothing but the agent's say-so, and an hour
 * is the most that is worth without a person asking for it. A longer wait is a new run.
 */
export const WAKE_MIN_MINUTES = 1;
export const WAKE_MAX_MINUTES = 60;

export type WakeOutcome =
  /** The wake-up is pending; `replaced` is when the one it replaced would have fired. */
  | { kind: "set"; at: string; afterMinutes: number; replaced: string | null }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

/** The bounds on background commands: how many at once, how many in a run, and how long one
 * may run. Each running one keeps the run's pod; the timeout is what bounds that. */
export const BACKGROUND_MAX_RUNNING = 8;
export const BACKGROUND_MAX_STARTED = 64;
export const BACKGROUND_TIMEOUT_MIN_MINUTES = 1;
export const BACKGROUND_TIMEOUT_MAX_MINUTES = 120;
export const BACKGROUND_TIMEOUT_DEFAULT_MINUTES = 30;
/** The longest command, in UTF-8 bytes, and the longest label, in characters. */
export const BACKGROUND_COMMAND_MAX_BYTES = 16 * 1024;
export const BACKGROUND_LABEL_MAX = 80;
/** How many lines of output `backgroundOutput` answers by default, and at most. */
export const BACKGROUND_TAIL_DEFAULT = 200;
export const BACKGROUND_TAIL_MAX = 2000;

export interface BackgroundRunArgs {
  command: string;
  /** Shown to people watching the run. */
  label: string;
  /** Where it runs: absolute, or relative to the checkout root. Default: the checkout root. */
  cwd?: string;
  timeoutMinutes?: number;
  /** Expected to keep running (a dev server): its end is news only if it comes before the run's. */
  service?: boolean;
  /** Service only: notify once this literal text appears in cleaned stdout/stderr. */
  readyWhen?: string;
}

/** How a background job ended: on its own, at its timeout, stopped by the agent, or with the run. */
export type BackgroundEndReason = "exited" | "timeout" | "stopped" | "run_ended";

/** One background job, as the agent is told of it. Times are ISO. */
export interface BackgroundJobView {
  /** `bg-<n>`, n from 1, per run. */
  id: string;
  label: string;
  command: string;
  cwd: string;
  service: boolean;
  /** The file its output goes to, stdout and stderr in arrival order. */
  logPath: string;
  startedAt: string;
  timeoutAt: string;
  /** Present when readiness was requested; null until the output marker was seen. */
  readyAt?: string | null;
  /** Null while it runs. */
  ended: {
    at: string;
    reason: BackgroundEndReason;
    /** Null when a signal ended it. */
    exitCode: number | null;
    signal: string | null;
  } | null;
  /** From start to end, or to now while it runs. */
  durationMs: number;
}

export type BackgroundRunOutcome =
  | { kind: "started"; job: BackgroundJobView }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type BackgroundOutputOutcome =
  /** One job, and its last `lines` lines of output (ANSI stripped, bounded). */
  | { kind: "job"; job: BackgroundJobView; tail: string; lines: number }
  /** Every job of the run, oldest first. */
  | { kind: "list"; jobs: BackgroundJobView[] }
  | { kind: "refused"; reason: string };

export type BackgroundStopOutcome =
  /** `already`: it had ended before the stop. */
  | { kind: "stopped"; job: BackgroundJobView; already: boolean }
  | { kind: "refused"; reason: string };

/** The bounds on subagents: how many run at once, how many a run starts, how long one stretch
 * of a subagent's work may run, and how much of its answer the agent is handed. Each running
 * one is a second agent process in the run's container; the wall clock is what bounds that. A
 * continuation counts toward the running cap, never toward the started one. */
export const SUBAGENT_MAX_RUNNING = 4;
/** Each start is a lane `sa-<n>`, and the historian takes no lane past its MAX_SUBAGENT_LANES:
 * raising this past that is raising both (pinned by tests/history_limits_test.ts). */
export const SUBAGENT_MAX_STARTED = 16;
export const SUBAGENT_TIMEOUT_MIN_MINUTES = 1;
export const SUBAGENT_TIMEOUT_MAX_MINUTES = 60;
export const SUBAGENT_TIMEOUT_DEFAULT_MINUTES = 15;
/** The most of an answer handed back, in UTF-8 bytes; the subagent's lane keeps all of it. */
export const SUBAGENT_ANSWER_MAX_BYTES = 32 * 1024;
/** The longest label, in characters, and the longest task or message, in UTF-8 bytes. */
export const SUBAGENT_LABEL_MAX = 80;
export const SUBAGENT_TEXT_MAX_BYTES = 64 * 1024;

/** What a subagent's tools are: pi's read-only built-ins, or the run's own. */
export type SubagentMode = "explore" | "work";

export interface SubagentStartArgs {
  /** The whole brief: the subagent sees nothing else of the agent's conversation. */
  task: string;
  /** Shown to the people watching the run. */
  label: string;
  mode: SubagentMode;
  /** Each stretch's wall clock. Default SUBAGENT_TIMEOUT_DEFAULT_MINUTES. */
  timeoutMinutes?: number;
}

/** How one stretch of a subagent's work ended: it answered (its turn settled), hit its wall
 * clock, was stopped by the agent, its process failed, or the run ended. */
export type SubagentEndReason = "answered" | "timeout" | "stopped" | "failed" | "run_ended";

/** One subagent, as the agent is told of it. Times are ISO. */
export interface SubagentView {
  /** `sa-<n>`, n from 1, per run. */
  id: string;
  label: string;
  mode: SubagentMode;
  /** How many stretches of work it has had: 1, plus one per continuation. */
  stretches: number;
  /** The current stretch's start, or the last one's. */
  startedAt: string;
  /** Null while it runs. */
  ended: {
    at: string;
    reason: SubagentEndReason;
    /** The tool that was running when it was stopped or timed out, if one was. */
    tool: string | null;
    /** Why its process failed, for `failed`. */
    error: string | null;
  } | null;
  /** The current or last stretch's wall clock, in minutes. */
  timeoutMinutes: number;
  /** From the stretch's start to its end, or to now while it runs. */
  durationMs: number;
}

/** A subagent's answer as handed back: its last message, clipped to SUBAGENT_ANSWER_MAX_BYTES. */
export interface SubagentAnswer {
  text: string;
  /** The whole answer's length in characters, and whether `text` is less of it. */
  chars: number;
  truncated: boolean;
}

export type SubagentStartOutcome =
  | { kind: "started"; subagent: SubagentView }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type SubagentMessageOutcome =
  /** `steered`: handed to it as it works. `continued`: it had ended, and a new stretch of its
   * work starts from this message. */
  | { kind: "steered" | "continued"; subagent: SubagentView }
  | { kind: "refused"; reason: string };

export type SubagentStopOutcome =
  /** `already`: it had ended before the stop. `answer`: what that stretch said, when it ended on
   * its own as the stop was asked for — the stop's answer is the one the agent hears of it.
   * Null when the stop ended it, or a message has told of its end already. */
  | { kind: "stopped"; subagent: SubagentView; already: boolean; answer: SubagentAnswer | null }
  | { kind: "refused"; reason: string };

export type SubmitPatchOutcome =
  | {
    kind: "submitted";
    patchId: string;
    state: string;
    path: string;
    /** The branch it shipped as: `<namespace>/<line>`, or `…-<n>` in a later generation. */
    branch: string;
    headSha: string;
    generation: number;
    /** The patch's page in Ryph, where a person approves it; null where none is known. */
    url: string | null;
    /** Existing change request identity, even when its forge has no web URL. */
    forgeRef?: string | null;
    /** Existing change request this patch targets; not confirmation the update has landed. */
    forgeUrl?: string | null;
  }
  /** The repo has no commits since its base: nothing to ship. */
  | { kind: "nothing-to-submit"; path: string }
  /** A merge of the target `updateFromBase` left for the agent is still conflicted. Left in
   * place. */
  | { kind: "conflict"; step: "merge"; path: string; files: string[] }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type RunChecksOutcome =
  /** The platform took the ask; `text` says what it did with it, in its own words. */
  | { kind: "requested"; text: string }
  /** The platform started nothing (checks are off, or there is nothing to run), or did not
   * answer in time; `text` says which. Not a refusal of the agent's ask. */
  | { kind: "answered"; text: string }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type UpdateFromBaseOutcome =
  /** The target's tip was merged; `headSha` is the merge commit. Not shipped yet. */
  | { kind: "merged"; path: string; target: string; tip: string; headSha: string }
  /** The branch held nothing of the run's own, so it and its base simply moved to the tip. */
  | { kind: "moved"; path: string; target: string; tip: string }
  /** The branch already contains the target's tip. */
  | { kind: "up-to-date"; path: string; target: string; tip: string }
  /** The merge stopped on conflicts, left in progress for the agent. */
  | { kind: "conflict"; path: string; target: string; files: string[] }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export type CheckoutChangeRequestOutcome =
  /** The repo's branch now starts at the change request's head, and the run is on it. */
  | {
    kind: "checked-out";
    path: string;
    /** The change request, as the control plane resolved the agent's reference to it. */
    changeRequest: string;
    /** The branch the head sits on — this repo's base ref from now on. */
    ref: string;
    headSha: string;
    url: string;
  }
  /** The ask cannot be honoured as made; the reason is written for the agent. */
  | { kind: "refused"; reason: string };

export interface PatchStatus {
  patchId: string;
  path: string;
  /** The branch it shipped as (@ryph/shared/lines). */
  branch: string;
  generation: number;
  headSha: string;
  /** As last heard: the birth state, then whatever the inbox's patch cues said since. */
  state: string;
  forgeUrl: string | null;
  /** The patch's page in Ryph, where a person approves it; null where none is known. */
  url: string | null;
}

/** What a finish is owed by the platform's checks. */
export interface ChecksOwed {
  /** Verdicts still owed: zero when the run caused none or the platform runs none, null when
   * the platform could not be asked. */
  owed: number | null;
  /** Whether a stop now is held for them: true while one is owed that no hold gave up on.
   * Those a hold gave up on are never waited for again, though they are still counted above. */
  waits: boolean;
}
