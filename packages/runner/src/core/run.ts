// The run pipeline — the whole story of a run, top to bottom.
//
// This file names no concrete mechanism:
// how work arrives, how the caller talks to us, where transcripts and memories physically go —
// all of that lives behind the ports.
//
// Invariants:
// - reportResult is called EXACTLY ONCE per run, last — teardown is already done by then
// - cancellation is graceful: whatever the harness left in the tree is committed and pushed
// - the core honors ONE cancel input, the external cancelSignal (event-driven, aborts the instant
//   it fires); the orchestrator gateway is report-only and drives nothing. Whatever sources exist
//   (a local OS signal, an inbound control request) are funnelled into that one signal by the
//   composition root before it reaches here — so graceful cancel is the core's property, uniform
//   no matter who asked.
// - "failure" is the agent's outcome; a throw anywhere becomes an "error" — the machinery's
// - every reported `Result`, "error" included, exits normally;
//   abnormal exit = could not even report
// - transcript and memory calls can never fail or slow the run
// - a run's WORK is fixed at birth; what the outside may hand in afterwards is a message from
//   the run's inbox, and a message can only ever be read (core/conversation.ts). Every run
//   outlives the agent's settles on an idle clock, until the agent finishes, a person finishes
//   it from its page, the clock runs out or it is cancelled
// - work leaves the box the same way whenever it leaves: a patch the agent submits mid-run and
//   the leftovers finalize ships go through one shipper (core/patches.ts)
// - nothing the agent started in the background outlives the harness: every job and every
//   subagent is stopped before finalize commits, and the jobs' records are awaited, bounded,
//   before the run reports (core/background.ts, core/subagents.ts)

import type {
  BranchOutcome,
  ChecksDeclaration,
  InjectedContext,
  Phase,
  RepoEntry,
  Result,
  RunEnvironment,
  RunServices,
  RunSkills,
  SetupFailureReport,
  SkillReport,
  StaleBase,
  StaleMemory,
  TaskSpec,
  TranscriptChunk,
  WorkItem,
} from "./types.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { BrowserSession } from "../ports/browser.ts";
import type { OrchestratorGateway } from "../ports/orchestrator_gateway.ts";
import type { Checkout, GitTransport } from "../ports/git_transport.ts";
import type { Harness, HarnessSkill, HarnessTools } from "../ports/harness.ts";
import type { SkillBundles } from "../ports/skills.ts";
import type { Inbox } from "../ports/inbox.ts";
import type { Narrator } from "../ports/narrator.ts";
import type { MemoryStore } from "../ports/memory_store.ts";
import { ChangeRequestRefused, type PatchReporter } from "../ports/patch_reporter.ts";
import type { EnvironmentStatus } from "../ports/environment_status.ts";
import type { ArtifactPublisher } from "../ports/artifacts.ts";
import { fetchArtifactFile, publishArtifactFile } from "./artifacts.ts";
import {
  type CheckCommit,
  type ChecksChannel,
  ChecksRefusedError,
  ChecksUnansweredError,
  MAX_STATUS_COMMITS,
  type OwedVerdict,
} from "../ports/checks.ts";
import { CHECK_NAME, runCheckLogs, SUITE_ID } from "./check_logs.ts";
import type {
  CheckLogOutcome,
  CheckoutChangeRequestOutcome,
  CheckStatusOutcome,
  OutcomeReport,
  RunActions,
  RunChecksOutcome,
  SubmitPatchOutcome,
  UpdateFromBaseOutcome,
} from "../ports/run_actions.ts";
import { type Conversation, drainPatchCues, startConversation } from "./conversation.ts";
import { awaitPrompt, promptSpec } from "./prompt.ts";
import { type BackgroundJobs, startBackgroundJobs } from "./background.ts";
import type { BackgroundRecords, CommandsUplink } from "../ports/background.ts";
import { startSubagents, type Subagents } from "./subagents.ts";
import type { SubagentContext, SubagentHost } from "../ports/subagents.ts";
import { harnessImagesOf, neutraliseImageLines, runImages } from "./images.ts";
import type { Attachments } from "../ports/attachments.ts";
import { checkImageRefs, MAX_UNKEPT_REFS, type UnkeptReason } from "./image_refs.ts";
import {
  anyLineShipped,
  type CloneState,
  cloneState,
  defaultLine,
  holderOf,
  type LeftStopped,
  lineAtHead,
  makeShipper,
  resolveLine,
  retargetClone,
  stoppedLabel,
  underLock,
  unsubmittedBranches,
  unsubmittedList,
} from "./patches.ts";
import { DEFAULT_LINE, lineBranch } from "@ryph/shared/lines";
import {
  assertEnvironmentTotal,
  type DeclaredService,
  dirtyNote,
  discoverEnvironment,
  MAX_DIRTY_FILES,
  type RepoEnvironment,
  runSetup,
  type SetupStepFailure,
  stepLabel,
} from "../helpers/environment.ts";
import { composeEnvironment, waitForServices } from "../helpers/services.ts";
import { describeCheckout, isForkHead } from "../helpers/layout.ts";
import {
  type PreparedSkill,
  prepareFrozenSkill,
  removeSkills,
  reportableDrops,
  skillDrop,
  skillOrigin,
  writeSkills,
} from "../helpers/skills.ts";
import {
  type CheckoutOrigin,
  describeMachine,
  probeMachine,
  type RepoSetupFailure,
} from "../helpers/machine.ts";
import { clearStrays, isCheckout, resetDir } from "../helpers/adopt.ts";
import { makeCatFileBatch, makeGit, makeGitBounded } from "../helpers/git_exec.ts";
import { discoverRepoSkills } from "../helpers/repo_skills.ts";
import { REPO_CONFIG_DIR } from "./brand.ts";
import {
  changedPaths,
  changedSince,
  checkedOutBranch,
  type CheckoutStart,
  checkoutStart,
  commitsSince,
  configureIdentity,
  createBranch,
  hasChanges,
  headSha,
  installRunTrailer,
  mergeInProgress,
  putBack,
  rebaseInProgress,
} from "../helpers/checkout.ts";
import { errorMessage } from "../helpers/errors.ts";
import { inCode, isPlainRef } from "../helpers/commands.ts";

export interface RunCtx {
  orchestrator: OrchestratorGateway;
  harness: Harness;
  git: GitTransport;
  narrator: Narrator;
  memory: MemoryStore;
  /** The runner's operational voice. Total by contract: called unwrapped, never gates a run. */
  diag: Diagnostics;
  injectedCtx: InjectedContext;
  /** The run's tool access, as the composition root's credentials fetch delivered it; absent
   * for a run with no tool policy. Forwarded to the harness untouched — the core never dials
   * an MCP server, and the token stays in the environment, not here. */
  tools?: HarnessTools;
  /**
   * The service containers the platform launched beside this run. Absent for every ordinary
   * run. The core does not start them and cannot: it waits for each to answer before the
   * harness gets anything, and puts the true list in front of the agent.
   */
  services?: RunServices;
  /**
   * The machine the run was launched on, as the spec froze it. Absent for a CLI run. When it is
   * `baked`, `checkoutRoot` is the image's own `/ryph/work` and already holds each repo's warm
   * checkout, which the run adopts instead of cloning; either way the agent is told what it is on.
   */
  environment?: RunEnvironment;
  /**
   * The checkout root: an empty directory the clones land in, one subdirectory per repo of the
   * work item at `<root>/<entry.path>` — or, on a baked environment, the directory the image
   * baked those subdirectories into. The harness runs here, above every clone. The core creates
   * the subdirectories and never cleans up; the root is the composition root's.
   */
  checkoutRoot: string;
  /**
   * The run's sole cancel input. When it aborts — whatever the composition root funnelled in, a
   * local SIGINT or an inbound control request — the run cancels gracefully.
   * Omitted ⇒ the run has no cancel source and simply runs to completion.
   */
  cancelSignal?: AbortSignal;
  /** The run's inbox, pulled from the moment the harness starts until finalize begins. */
  inbox: Inbox;
  /** Where a patch shipped mid-run is reported. Omitted ⇒ the bundle ships unreported and the
   * result names the branch — a CLI run. */
  patchReporter?: PatchReporter;
  /** Where the agent's artifacts are published. Omitted ⇒ nowhere (a CLI run): the tool says
   * so. Offered to the agent only where the work item allows it. */
  artifacts?: ArtifactPublisher;
  /** Where the images the run is handed — with its task, on its messages — are fetched from.
   * Omitted ⇒ nothing to fetch them from (a CLI run): the agent is told each one is missing. */
  attachments?: Attachments;
  /** Where the agent's `environment_status` reads its patches' builds. Omitted ⇒ the tool says
   * there is no platform to build them — a CLI run. */
  environmentStatus?: EnvironmentStatus;
  /**
   * Where the agent's `run_checks` and `check_status` reach the platform's checks. Present only
   * when the platform runs checks for this run (the spec said so); omitted ⇒ the tools say
   * nothing runs them, nothing is uploaded, and the agent is not told about checks at all.
   */
  checks?: ChecksChannel;
  /** How long a settle is held for a check verdict, and how often it asks: tests shrink these. */
  checksHold?: { maxWaitMs: number; checkEveryMs: number };
  /**
   * The skills the control plane froze onto this run, whether the run may add the working repos'
   * own, and where the frozen ones' files come from. Absent for a run with none of either — a
   * CLI run, or a harness that reads no skills. The core fetches and checks every bundle while
   * the clone runs, reads the repos' own from git objects before setup, and writes them all to a
   * directory of its own only once setup is over, so no setup step runs while it exists. A
   * process a step left running still can, in the moment before the harness starts: a repo has
   * to plant such a daemon on purpose, and that gap is accepted.
   */
  skills?: { spec: RunSkills; bundles: SkillBundles };
  /**
   * Called once the clones exist with the agent's own actions over this run — the composition
   * root binds its loopback tool server to them (the harness's MCP client dials it). Before
   * the call the server has nothing to act on; after the harness returns the actions refuse.
   */
  onActions?: (actions: RunActions) => void;
  /**
   * Called once, just before the harness starts, with whether the agent is told about checks:
   * a repo declares some, or whether any does is unknown. False where none does. The loopback's
   * `submit_patch` follows it, so the tools say what the prompt says.
   */
  onChecksTold?: (told: boolean) => void;
  /**
   * The run's browser sidecar, already coming up — the composition root starts it at boot so its
   * wait overlaps the clone and setup. The core awaits its answer just before the harness starts
   * and hands the agent its tools, or tells it the browser failed. Absent: the run has no browser.
   */
  browser?: BrowserSession;
  /** Where the agent's background commands are recorded. Absent: nowhere (a CLI run). */
  backgroundRecords?: BackgroundRecords;
  /** Where people watch the agent's background commands live. Absent: nowhere. */
  commandsUplink?: CommandsUplink;
  /**
   * Called once the run's background jobs exist, with the stop that ends every one of them: the
   * composition root makes it a teardown disposer, so a forced exit leaves no process behind.
   * The core stops them itself before finalize either way.
   */
  onBackground?: (stopAll: () => Promise<void>) => void;
  /** Where the agent's subagents' processes come from. Absent: the run's harness has no child
   * of its own (echo), and the subagent tools say so. */
  subagents?: SubagentHost;
  /** Called once the run's subagents exist, with the stop that ends every one of them: a
   * teardown disposer, as `onBackground`'s is. */
  onSubagents?: (stopAll: () => Promise<void>) => void;
}

type ProgressFn = (
  phase: Phase,
  message?: string,
  idleDeadlineAt?: string | null,
  idleState?: "idle" | "waiting-for-user" | null,
) => void;

/**
 * A best-effort port call never gates the run:
 * a thrown error OR a rejected promise
 * (these ports return `void`, but an adapter may implement them async)
 * is swallowed to a warn, never propagated.
 * Fire-and-forget: not awaited, so it can neither fail nor slow the run.
 */
function bestEffort<T>(
  diag: Diagnostics,
  event: string,
  fields: Record<string, unknown>,
  call: () => T,
): T | undefined {
  try {
    const value = call();
    Promise.resolve(value).catch((err) => diag.warn(event, { ...fields, err }));
    return value;
  } catch (err) {
    diag.warn(event, { ...fields, err });
    return undefined;
  }
}

/**
 * Runs a single work item to completion and returns its `Result`.
 *
 *   cloning → preparing → setting-up → running → finalizing → reporting
 *
 * `run` is the envelope around that pipeline:
 * it drives the phased work in `execute`
 * (cloning through finalizing, where any leftover tree is committed and pushed)
 * and reports the verdict exactly once, last.
 *
 * The returned `Result` is a "success", the agent's own "failure",
 * a graceful "cancelled", or an "error" when the machinery itself breaks.
 */
export async function run(item: WorkItem, ctx: RunCtx): Promise<Result> {
  let phase: Phase = "cloning";
  const progress: ProgressFn = (next, message, idleDeadlineAt, idleState) => {
    phase = next;
    ctx.diag.debug("run.phase", { runId: item.id, phase, message, idleDeadlineAt });
    bestEffort(
      ctx.diag,
      "orchestrator.reportProgress.failed",
      { runId: item.id, phase },
      () =>
        ctx.orchestrator.reportProgress({
          workItemId: item.id,
          phase,
          message,
          ...(idleDeadlineAt === undefined ? {} : { idleDeadlineAt }),
          ...(idleState === undefined ? {} : { idleState }),
        }),
    );
  };

  // What has durably left the box so far — the latest branch shipped per repo, mid-run or at
  // finalize. Read through a holder `execute` binds once its shipper exists, so a throw between
  // two pushes still reports the first: a bundle the gateway already holds is real work,
  // whatever broke afterwards.
  const shipped = { list: (): BranchOutcome[] => [] };
  let result: Result;
  try {
    result = await execute(item, ctx, progress, shipped);
  } catch (err) {
    // the machinery broke;
    // the `Result` below carries only the message, so log the stack here
    ctx.diag.warn("run.errored", { runId: item.id, phase, err });
    result = {
      status: "error",
      reason: clipReason(errorMessage(err), REASON_MAX),
      during: phase,
      // only the pushes that landed are confirmed; the caller can still GC by the branch name
      branches: shipped.list(),
    };
  }

  ctx.diag.debug("run.outcome", { runId: item.id, status: result.status });

  // Terminal, and exactly-once by position.
  // Nothing past this line is caught: a failed report cannot be reported —
  // abnormal exit IS the signal that no verdict was delivered.
  await ctx.orchestrator.reportResult(result);
  ctx.diag.debug("run.reported", { runId: item.id, status: result.status });
  return result;
}

// The work itself, free to throw: run() turns any throw into a reported error.
// Kept separate so the envelope above stays the one place
// that guarantees exactly-once reporting.
// The one "failure" built here is the agent's own outcome — it is never produced by a throw.
async function execute(
  item: WorkItem,
  ctx: RunCtx,
  progress: ProgressFn,
  shipped: { list: () => BranchOutcome[] },
): Promise<Result> {
  // Ends what the run started in the background and no longer needs, however it ended: a run
  // that fails while cloning leaves no request for the declared checks outstanding.
  const over = new AbortController();
  // The agent's background jobs, once there are any: whatever ended the run, the records of
  // theirs still going up are awaited (bounded) before it reports.
  const background: { jobs: BackgroundJobs | null; subagents: Subagents | null } = {
    jobs: null,
    subagents: null,
  };
  try {
    return await executeRun(item, ctx, progress, shipped, over.signal, background);
  } finally {
    over.abort();
    await background.subagents?.close().catch((err) =>
      ctx.diag.warn("subagents.close_failed", { runId: item.id, err })
    );
    await background.jobs?.close().catch((err) =>
      ctx.diag.warn("background.close_failed", { runId: item.id, err })
    );
  }
}

async function executeRun(
  item: WorkItem,
  ctx: RunCtx,
  progress: ProgressFn,
  shipped: { list: () => BranchOutcome[] },
  over: AbortSignal,
  background: { jobs: BackgroundJobs | null; subagents: Subagents | null },
): Promise<Result> {
  const gitExec = makeGit(ctx.diag);

  // The single cancellation point, wired before any phase
  // so the external cancelSignal aborts the instant it fires.
  // Only one source feeds it: the external cancelSignal (forwarded straight in) — whatever
  // funnels into it upstream is the composition root's concern, never the core's.
  // The pre-`running` awaits (clone, snapshot) can't be interrupted mid-flight —
  // threading the signal into the git transport isn't worth it yet —
  // so the phases below check it between steps and bail early.
  // Setup steps are the exception: they can run long, so they take the signal
  // directly — an abort kills the one in flight and skips the rest.
  const runCancel = new AbortController();
  if (ctx.cancelSignal) {
    if (ctx.cancelSignal.aborted) runCancel.abort();
    else {
      ctx.cancelSignal.addEventListener("abort", () => runCancel.abort(), {
        once: true,
      });
    }
  }
  // What each repo's checks run, for the prompt. The platform reads it through the forge, which
  // can be slow, so it is asked for now and awaited only as the harness starts: the clone and
  // the setup steps go on meanwhile. No answer, or a wrong one, is null: not known for any
  // repo, never a failed run. A repo whose file the platform could not read is in `unread`, not
  // known either. Repos that declare no checks are dropped, so both lists empty means none has
  // any.
  const declaredStop = AbortSignal.any([runCancel.signal, over]);
  const checksDeclared: Promise<ChecksDeclaration | null> = ctx.checks === undefined
    ? Promise.resolve({ declared: [], unread: [] })
    : ctx.checks.declared(declaredStop).then(
      (answer) => ({
        declared: answer.declared.filter((repo) => repo.checks.length > 0),
        unread: answer.unread,
      }),
      (err) => {
        if (!declaredStop.aborted) {
          ctx.diag.warn("checks.declared_failed", { runId: item.id, err: String(err) });
        }
        return null;
      },
    );
  // The frozen skills' files, fetched now, beside the clone, and checked in memory. Written to
  // disk only once setup is over (below). A skill that cannot be fetched or does not check out is
  // dropped and said so; a run never fails for a skill.
  const skillsReady = prepareSkills(ctx, item.id, AbortSignal.any([runCancel.signal, over]));
  // cancelled before the harness ran: nothing to summarize, nothing to ship
  const cancelledEarly = (): Result => ({
    status: "cancelled",
    branches: [],
    summary: "",
  });

  // One clone per entry, in order, each into its own directory under the root. A clone that
  // fails fails the run here, naming the repo: a partial checkout never starts an agent, and
  // "which one" is the first thing whoever reads the error wants to know.
  //
  // On a baked environment the root is the image's, and a repo's directory may already hold
  // its warm checkout: that one is ADOPTED — fetched and moved to the run's ref in place — and
  // anything that goes wrong doing so falls back to a fresh clone in the same directory, said
  // out loud. A run is never worse off for having had an environment, only colder.
  progress("cloning");
  const baked = ctx.environment?.baked === true;
  if (baked) {
    // What the image holds beyond this run's repos — a member removed since the build, the
    // builder's own bookkeeping — is not the agent's to see.
    await clearStrays(ctx.checkoutRoot, item.repos.map((repo) => repo.path)).then(
      (removed) => {
        if (removed.length > 0) {
          ctx.diag.debug("environment.strays_removed", { runId: item.id, removed });
        }
      },
      (err) => ctx.diag.warn("environment.strays_failed", { runId: item.id, err }),
    );
  }
  const clones: CloneState[] = [];
  const origins: CheckoutOrigin[] = [];
  // Every repo whose base the origin could only serve from a copy it could not refresh: the
  // agent reads it under the repo's heading, the run's history records it once.
  const staleBases: StaleBase[] = [];
  for (const repo of item.repos) {
    const dir = `${ctx.checkoutRoot}/${repo.path}`;
    let checkout: Checkout | null = null;
    let how: CheckoutOrigin["how"] = "cloned";
    let baseSha: string;
    try {
      if (baked && await isCheckout(dir)) {
        try {
          checkout = await ctx.git.adopt(repo, dir);
          how = "adopted";
          ctx.diag.debug("environment.adopted", { runId: item.id, repo: repo.path });
        } catch (err) {
          how = "fallback";
          const reason = errorMessage(err);
          ctx.diag.warn("environment.adopt_failed", { runId: item.id, repo: repo.path, err });
          progress(
            "cloning",
            `${repo.path}: the environment image's checkout could not be used ` +
              `(${clipReason(reason, ADOPT_REASON_MAX)}); cloning fresh`,
          );
        }
      }
      if (checkout === null) {
        // Whatever the image left there — a half-adopted checkout, or a directory that never
        // was one — goes, so the clone lands in an empty directory as it always has.
        if (baked) await resetDir(dir);
        checkout = await ctx.git.clone(repo, dir);
      }
      if (runCancel.signal.aborted) return cancelledEarly();
      // Branching and reading the base belong to checking this repo out, so they are named the
      // same way. Left outside, a failure here threw a bare git error about a directory, while
      // the clone a line above produced "cloning web (test/web) failed: …".
      // The default line's branch: a run that never names another ships on it alone.
      await createBranch(gitExec, checkout.dir, workBranch(repo));
      baseSha = await headSha(gitExec, checkout.dir);
    } catch (err) {
      throw new Error(
        `cloning ${repo.path} (${repo.name}) failed: ${errorMessage(err)}`,
      );
    }
    ctx.diag.debug("run.branched", {
      runId: item.id,
      repo: repo.path,
      baseSha,
      branch: workBranch(repo),
    });
    clones.push(cloneState(repo, checkout, baseSha));
    origins.push({ path: repo.path, head: baseSha, how });
    if (checkout.freshness.kind === "stale") {
      staleBases.push({
        path: repo.path,
        name: repo.name,
        ref: repo.ref,
        commit: baseSha,
        since: checkout.freshness.since,
      });
    }
  }
  if (staleBases.length > 0) {
    ctx.diag.warn("run.base_stale", { runId: item.id, repos: staleBases.map((b) => b.path) });
    ctx.orchestrator.reportStaleBases(staleBases);
  }

  // The one way work leaves the box, mid-run or at finalize; the result reads what shipped
  // from it. Bound into the holder now, so an error from here on reports every branch that
  // already left.
  // The subject leftovers are committed under: the task's title, or — on a run awaiting its
  // prompt — the prompt's first line, once it has arrived (below).
  let subject = item.spec.title ?? "Task";
  const shipper = makeShipper({
    git: ctx.git,
    gitExec,
    diag: ctx.diag,
    patchReporter: ctx.patchReporter,
    runId: item.id,
    subject: () => subject,
    signal: runCancel.signal,
  });
  shipped.list = () => shipper.shipped();

  // The agent's own actions over this run, for the loopback tool server. What `finish` and
  // `reportOutcome` say — the outcome, the summary, the status comment — is the run's; ending is
  // the conversation's, once it has started.
  // `submitPatch` and `checkoutChangeRequest` refuse once the harness has returned — finalize is
  // shipping, and a late tool call must not cut a second bundle, or move a branch, under it.
  let conversation: Conversation | null = null;
  // How many times the run has asked for checks, whose verdicts a finish then waits for: through
  // run_checks, or, where it was told of checks, by submitting a patch, which starts a suite of
  // its own. Counted, since after a hold gives up only a later ask opens another.
  let checksAsks = 0;
  // Whether the agent is told about checks (and so sees ryph__run_checks): settled as the
  // harness starts, before any action can be called.
  let checksTold = false;
  // The check logs the agent saved: one directory outside every clone, removed with the images.
  const checkLogs = runCheckLogs();
  let reported: OutcomeReport | null = null;
  let harnessDone = false;
  // The agent called finish: the run ends at its settle, and a report after cannot reopen it.
  let agentFinished = false;
  // The env the agent's own shell was spawned with, as the harness said: what a background
  // command is given.
  let agentEnv: Readonly<Record<string, string>> | null = null;
  // Why a background tool is refused, or null when the run has jobs to run them.
  const noBackground = (): string | null =>
    background.jobs === null
      ? "the run has not started its agent yet"
      : harnessDone
      ? "the run is finalizing"
      : null;
  // The same for a subagent tool.
  const noSubagents = (): string | null =>
    background.subagents === null
      ? "the run has not started its agent yet"
      : harnessDone
      ? "the run is finalizing"
      : null;
  // What every subagent starts in: the parent's own checkout and description of it, once the
  // harness has been handed them.
  let subagentContext: SubagentContext | null = null;
  // Which repo an action names: the one at `path`, or the only one the run holds. Shared, so
  // whichever tool the agent reached for it is told the same thing about a name that does not
  // resolve; what each does about an entry that is no CONNECTED repo differs and stays with it.
  const pickClone = (path?: string): CloneState | { reason: string } => {
    const held = () => clones.map((c) => c.repo.path).join(", ");
    if (path === undefined) {
      if (clones.length !== 1) {
        return {
          reason: `the run holds ${clones.length} repos; name one with \`repo\`: ${held()}`,
        };
      }
      return clones[0];
    }
    const clone = clones.find((c) => c.repo.path === path);
    if (clone === undefined) {
      return { reason: `no repo of this run is at ${inCode(path)}; the run holds ${held()}` };
    }
    return clone;
  };
  // What the agent says about how the run went, from finish or report_outcome: a later say's
  // outcome replaces an earlier one's, and a summary or status comment it leaves out keeps the
  // earlier one's — a retry with only the outcome, or a finish after a report, loses nothing.
  const record = (args: OutcomeReport, finished: boolean): boolean => {
    if (harnessDone) return false;
    const prior = reported as OutcomeReport | null;
    // A summary said while the work was in progress describes that moment, not how it ended:
    // a final word that gives none falls back on the agent's last message instead.
    const carried = prior?.outcome === "in-progress" && args.outcome !== "in-progress"
      ? undefined
      : prior?.summary;
    const summary = args.summary === undefined || args.summary.trim() === ""
      ? carried
      : args.summary;
    const statusComment = args.statusComment ?? prior?.statusComment;
    reported = {
      outcome: args.outcome,
      ...(summary === undefined ? {} : { summary }),
      ...(statusComment === undefined ? {} : { statusComment }),
    };
    // Upstream too, on every beat from now on: the run page offers a person the run's finish
    // once the agent last said it was done, and the control plane refuses one before then and
    // once the agent finished by itself.
    sayOutcome(args.outcome, finished);
    return true;
  };
  // The outcome the run page last heard: the agent's last word until a message reaches it, and
  // null from then on until it says another (`onDelivered`). Only the page's: how the run
  // concludes is `reported`, which a message never takes back.
  let saidUpstream: OutcomeReport["outcome"] | null = null;
  // Reported as the "running" phase, which is the only one an agent's tool is called in, or a
  // message reaches it in.
  const sayOutcome = (outcome: OutcomeReport["outcome"] | null, finished = false) => {
    saidUpstream = outcome;
    bestEffort(
      ctx.diag,
      "orchestrator.reportProgress.failed",
      { runId: item.id, phase: "running" },
      () =>
        ctx.orchestrator.reportProgress({
          workItemId: item.id,
          phase: "running",
          declaredOutcome: outcome,
          ...(finished ? { finished: true as const } : {}),
        }),
    );
  };
  // The tool images still being uploaded, by the harness's queue: what a text naming image refs
  // waits on before they are checked (`checkImageRefs`).
  const keepingImages = new Set<Promise<unknown>>();
  // The tool images the harness did not keep, by ref, and why: what a text naming one is told.
  // Bounded, oldest out first; a ref kept later is found by the control plane before this map
  // is read.
  const unkeptImages = new Map<string, UnkeptReason>();
  // Intent for the next settle, not an idle signal while the tool itself is running.
  let awaitingUserTurn = false;
  let agentWasIdle = false;
  const actions: RunActions = {
    checkImageRefs(text) {
      return checkImageRefs(text, ctx.attachments, [...keepingImages], unkeptImages);
    },
    finish(args) {
      ctx.diag.debug("actions.finish", { runId: item.id, outcome: args.outcome });
      if (!record(args, true)) return false;
      agentFinished = true;
      conversation?.finish();
      // What the agent started in the background ends with its finish, not at the settle after:
      // a finish held for a check verdict would otherwise leave a job running, and hear of it.
      // Nothing new starts after. Its subagents too.
      void background.jobs?.stopAll();
      void background.subagents?.stopAll();
      return true;
    },
    reportOutcome(args) {
      ctx.diag.debug("actions.report_outcome", { runId: item.id, outcome: args.outcome });
      if (harnessDone) return false;
      if (agentFinished) return "finished";
      if (!record(args, false)) return false;
      awaitingUserTurn = args.awaitingUserTurn === true;
      return true;
    },
    async submitPatch(args): Promise<SubmitPatchOutcome> {
      if (!item.canOpenPatches) {
        return { kind: "refused", reason: "this agent may not open patches" };
      }
      if (harnessDone) return { kind: "refused", reason: "the run is finalizing" };
      const picked = pickClone(args.path);
      if ("reason" in picked) return { kind: "refused", reason: picked.reason };
      // The branch named, or the one the checkout is on: a line of its own (@ryph/shared/lines). An
      // empty or blank name is no name: a model fills an optional string with "" as often as it
      // leaves it out.
      const named = args.branch?.trim();
      // A fork pull request's head delivers onto that pull request or nowhere: only its default
      // line ships, never a line of its own (the control plane refuses one too). Refused before
      // any git work, so a refused submit leaves nothing behind.
      if (isForkHead(picked.repo)) {
        const own = defaultLine(picked).branch;
        const local = named === undefined || named === ""
          ? await checkedOutBranch(gitExec, picked.checkout.dir)
          : named;
        if (local !== null && local !== own) {
          return {
            kind: "refused",
            reason: `${picked.repo.path} is a pull request from a fork, so this run ships only ` +
              `its own branch ${inCode(own)}, onto that pull request — never ${
                inCode(local)
              } or any ` +
              `other branch as a change request of its own. Put the work on ${inCode(own)}` +
              `${switchTo(own)} and submit that`,
          };
        }
      }
      const resolved = await resolveLine(gitExec, picked, named === "" ? undefined : named);
      if ("refused" in resolved) return { kind: "refused", reason: resolved.refused };
      const line = resolved.line;
      ctx.diag.debug("actions.submit_patch", {
        runId: item.id,
        repo: picked.repo.path,
        line: line.line,
        created: resolved.created,
      });
      const submitted = await shipper.submit(line, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.description === undefined ? {} : { description: args.description }),
      });
      // A patch's birth asks for its checks whether or not the base declares any, and that ask
      // is owed until the forge's read of the base answers. Where the agent was told of none, a
      // flaky read would hold the run for nothing it could act on.
      if (submitted.kind === "submitted" && checksTold) checksAsks++;
      return submitted;
    },
    async checkoutChangeRequest(args): Promise<CheckoutChangeRequestOutcome> {
      const refused = (reason: string): CheckoutChangeRequestOutcome => ({
        kind: "refused",
        reason,
      });
      if (harnessDone) return refused("the run is finalizing");
      // The control plane refuses it too; said here before the cache is warmed for nothing.
      if (item.repos.some(isForkHead)) {
        return refused(
          "this run works a pull request from a fork, so its checkout cannot move onto another " +
            "change request",
        );
      }
      const picked = pickClone(args.path);
      if ("reason" in picked) return refused(picked.reason);
      // A change request is the default line's: the one a task that targets a change request
      // starts on, and what the claim re-targets the task's work onto.
      const clone = defaultLine(picked);
      const path = clone.repo.path;
      // The swap is only half the runner's: the checkout moves here, and the TASK is re-pointed
      // by the control plane, which is also what makes the later patches revisions of this
      // change request. With nobody to re-point it, moving the checkout would quietly ship the
      // next patch as an unrelated pull request.
      // A run assembled without one at all (the core's own callers — the composed binary always
      // installs the noop reporter, which refuses in these same words).
      const reporter = ctx.patchReporter;
      if (reporter === undefined) return refused(`${path}: this run has no platform behind it`);
      ctx.diag.debug("actions.checkout_change_request", {
        runId: item.id,
        repo: path,
        changeRequest: args.changeRequest,
      });
      // Under the clone's lock, like a submit: the two move the same branch, and a swap that
      // interleaved with a bundle being cut would ship commits from two different bases.
      return await underLock(picked, async (): Promise<CheckoutChangeRequestOutcome> => {
        if (anyLineShipped(picked)) {
          return refused(
            `${path} has already submitted a patch in this run, and that patch is what this ` +
              "run's work is attached to; a change request can only be checked out before a " +
              "repository's first patch",
          );
        }
        const dir = clone.checkout.dir;
        // Everything below is about the same fact: checking out a change request REPLACES this
        // repository's branch, so anything on it that has not shipped would be lost. The run
        // refuses rather than deciding for the agent what to do with its work.
        const stopped = await rebaseInProgress(dir)
          ? "rebase"
          : await mergeInProgress(dir)
          ? "merge"
          : null;
        if (stopped !== null) {
          return refused(
            `${path} has a ${stopped} in progress; finish or abort it first — checking out a ` +
              "change request replaces this repository's branch",
          );
        }
        if (await hasChanges(gitExec, dir)) {
          return refused(
            `${path} has uncommitted changes, and checking out a change request replaces this ` +
              (item.canOpenPatches
                ? "repository's branch: commit them and ship them with submit_patch, or " +
                  "discard them, first"
                : "repository's branch: discard them first"),
          );
        }
        const commits = await commitsSince(
          gitExec,
          dir,
          clone.baseSha,
          `refs/heads/${clone.branch}`,
        );
        if (commits.length > 0) {
          return refused(
            `${path} has ${commits.length} commit(s) of this run on its branch, and checking ` +
              "out a change request replaces that branch: " +
              (item.canOpenPatches
                ? "ship them with submit_patch, or discard them, first"
                : "discard them first"),
          );
        }
        // The head comes in BEFORE anything is claimed, so a change request the platform
        // cannot serve never re-targets the task; and the claim is answered before the branch
        // moves, so a refused claim leaves the checkout exactly as it was.
        let head: { ref: string; headSha: string; url: string };
        try {
          head = await ctx.git.fetchChangeRequest(clone.checkout, clone.repo, args.changeRequest);
        } catch (err) {
          return refused(`${path}: ${errorMessage(err)}`);
        }
        let claim;
        try {
          claim = await reporter.claimChangeRequest({ path, changeRequest: args.changeRequest });
        } catch (err) {
          const reason = errorMessage(err);
          // A refusal is a decision: nothing was recorded, and the reason is the platform's own
          // words. Anything else leaves the claim's fate unknown — the task may have been
          // re-targeted with only the answer lost — and saying "it did not happen" would be a
          // guess. The claim is idempotent, so calling again is what resolves it.
          if (err instanceof ChangeRequestRefused) return refused(`${path}: ${reason}`);
          return refused(
            `${path}: the platform did not confirm the claim (${reason}) — it may or may not ` +
              "have recorded it; call this again",
          );
        }
        // The two sides read the change request at their own moment. Either answer disagreeing
        // means it moved in between: nothing has moved on disk except objects, so the honest
        // answer is to say so and let the agent ask again.
        //
        // The ref matters as much as the head: what is persisted as this repo's base ref is
        // what every later fetch asks the gateway for, so it has to be the ref the gateway
        // itself said it serves — not a differently spelled name for the same branch.
        if (claim.ref !== head.ref) {
          return refused(
            `${args.changeRequest} is served as ${inCode(head.ref)} but the platform named ` +
              `${inCode(claim.ref)}; try again`,
          );
        }
        if (claim.headSha !== head.headSha) {
          return refused(
            `${args.changeRequest} moved while it was being checked out; try again`,
          );
        }
        await retargetClone(gitExec, clone, {
          ref: claim.ref,
          ...(claim.targetRef === undefined ? {} : { targetRef: claim.targetRef }),
          headSha: claim.headSha,
          changeRequest: claim.thread,
        });
        ctx.diag.debug("run.retargeted", {
          runId: item.id,
          repo: path,
          changeRequest: claim.thread,
          ref: claim.ref,
          headSha: claim.headSha,
        });
        return {
          kind: "checked-out",
          path,
          changeRequest: claim.thread,
          ref: claim.ref,
          headSha: claim.headSha,
          url: claim.url,
        };
      });
    },
    async updateFromBase(args): Promise<UpdateFromBaseOutcome> {
      if (!item.canOpenPatches) {
        return { kind: "refused", reason: "this agent may not open patches" };
      }
      if (harnessDone) return { kind: "refused", reason: "the run is finalizing" };
      const picked = pickClone(args.path);
      if ("reason" in picked) return { kind: "refused", reason: picked.reason };
      // The line the checkout is on: the merge lands on whatever is checked out. On a detached
      // HEAD the default line, which `update` refuses as not checked out, as it always did.
      const resolved = await lineAtHead(gitExec, picked);
      if ("refused" in resolved) return { kind: "refused", reason: resolved.refused };
      ctx.diag.debug("actions.update_from_base", {
        runId: item.id,
        repo: picked.repo.path,
        line: resolved.line.line,
      });
      return await shipper.update(resolved.line);
    },
    patches: () => shipper.patches(),
    async environmentStatus() {
      if (ctx.environmentStatus === undefined) {
        return "This run has no platform behind it, so nothing builds its patches' environments.";
      }
      return await ctx.environmentStatus.read();
    },
    async runChecks(args): Promise<RunChecksOutcome> {
      const refused = (reason: string): RunChecksOutcome => ({ kind: "refused", reason });
      // Checks gate patches: a run that may open none uploads nothing to be checked.
      if (!item.canOpenPatches) {
        return refused("this agent may not open patches, so it runs no checks");
      }
      if (harnessDone) return refused("the run is finalizing");
      if (ctx.checks === undefined) return refused(NO_CHECKS);
      const picked = pickClone(args.path);
      if ("reason" in picked) return refused(picked.reason);
      // The tip of the branch the checkout is on, uploaded as the branch that line ships as: what
      // the platform holds a candidate to (one of the run's own lines), and what a later submit
      // of the same line ships. On a detached HEAD the default line's tip, as before lines.
      const resolved = await lineAtHead(gitExec, picked);
      if ("refused" in resolved) return refused(resolved.refused);
      const path = picked.repo.path;
      // A fork pull request's head ships only its default line, so that is all a check may judge
      // there, as a submit is refused (and the control plane refuses the check too).
      if (isForkHead(picked.repo) && resolved.line.line !== DEFAULT_LINE) {
        const own = defaultLine(picked).branch;
        return refused(
          `${path} is a pull request from a fork, so this run ships only its own branch ` +
            `${inCode(own)} there, and only that is checked — never ${
              inCode(resolved.line.branch)
            }. ` +
            `Put the work on ${inCode(own)}${switchTo(own)} and check that`,
        );
      }
      ctx.diag.debug("actions.run_checks", {
        runId: item.id,
        repo: path,
        line: resolved.line.line,
      });
      let candidate;
      try {
        candidate = await shipper.pushCandidate(resolved.line);
      } catch (err) {
        return refused(
          `${path}: the commit could not be uploaded for checks (${
            err instanceof Error ? err.message : String(err)
          }); try again`,
        );
      }
      if ("refused" in candidate) return refused(candidate.refused);
      const at = `${path} at ${candidate.headSha.slice(0, 10)}`;
      let answer;
      try {
        answer = await ctx.checks.request({
          path,
          headSha: candidate.headSha,
          branch: candidate.branch,
          baseSha: candidate.baseSha,
          ...(args.checks === undefined || args.checks.length === 0 ? {} : { checks: args.checks }),
        });
      } catch (err) {
        if (err instanceof ChecksUnansweredError) {
          // It may well have started: waiting for a verdict that never comes costs a bound,
          // missing one that does costs the agent the failure it caused.
          checksAsks++;
          return {
            kind: "answered",
            text: `Checks for ${at} were asked for, and the platform did not answer in time. ` +
              "The request may still be going through: call ryph__check_status to see whether " +
              "they started, and call this again only if they did not.",
          };
        }
        return refused(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Nothing started: the platform's words are the whole answer.
      if (!answer.requested) return { kind: "answered", text: answer.text };
      checksAsks++;
      const dirty = candidate.dirty
        ? " Uncommitted changes in the tree are not part of it; commit them and call this " +
          "again to have them checked."
        : "";
      return {
        kind: "requested",
        text: `Checks requested for ${at}, the committed tip of ${inCode(candidate.branch)}.` +
          `${dirty}\n\n${answer.text}`,
      };
    },
    async checkStatus(args = {}): Promise<CheckStatusOutcome> {
      const refused = (reason: string): CheckStatusOutcome => ({ kind: "refused", reason });
      if (ctx.checks === undefined) return { kind: "answered", text: NO_CHECKS };
      if (args.path === undefined && args.commit === undefined) {
        // Each repo's checked-out head, beside the run's own asks: what a review is about. As
        // many as one status takes; a repo past them is asked about by naming it.
        const commits: CheckCommit[] = [];
        for (const clone of clones) {
          if (commits.length === MAX_STATUS_COMMITS) break;
          try {
            commits.push({
              path: clone.repo.path,
              commit: await headSha(gitExec, clone.checkout.dir),
            });
          } catch (err) {
            ctx.diag.warn("actions.check_status_head_failed", { repo: clone.repo.path, err });
          }
        }
        const text = await ctx.checks.status({ commits, named: false });
        return { kind: "answered", text };
      }
      const picked = pickClone(args.path);
      if ("reason" in picked) return refused(picked.reason);
      const path = picked.repo.path;
      const said = (args.commit ?? "HEAD").trim();
      // A SHA is a SHA in either case; a branch name keeps its own.
      const rev = /^[0-9a-f]+$/i.test(said) ? said.toLowerCase() : said;
      let commit: string;
      if (FULL_SHA.test(rev)) {
        // A change request's head the clone has not fetched is still asked about by its SHA.
        commit = rev;
      } else {
        if (rev === "" || rev.startsWith("-")) {
          return refused("commit: a revision, such as HEAD, a branch or a commit SHA");
        }
        try {
          commit = await gitExec(
            picked.checkout.dir,
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            `${rev}^{commit}`,
          );
        } catch {
          return refused(
            `${path} has no commit ${JSON.stringify(rev)}; name a commit by its full SHA to ` +
              "ask about one the checkout does not have",
          );
        }
      }
      ctx.diag.debug("actions.check_status", { runId: item.id, repo: path });
      return {
        kind: "answered",
        text: await ctx.checks.status({ commits: [{ path, commit }], named: true }),
      };
    },
    async checkLog(args): Promise<CheckLogOutcome> {
      const refused = (reason: string): CheckLogOutcome => ({ kind: "refused", reason });
      if (harnessDone) return refused("the run is finalizing");
      if (ctx.checks === undefined) return refused(NO_CHECKS);
      if (!SUITE_ID.test(args.suiteId)) {
        return refused(
          `suiteId: a check suite's id, like cs-01jb7k3m9x4q8zt2vw6hn5c0fe, exactly as ` +
            `check_status names it (got ${JSON.stringify(args.suiteId.slice(0, 80))})`,
        );
      }
      if (!CHECK_NAME.test(args.check)) {
        return refused("check: a check's name, as the suite lists it");
      }
      ctx.diag.debug("actions.check_log", { runId: item.id, suiteId: args.suiteId });
      let log;
      try {
        log = await ctx.checks.log(args);
      } catch (err) {
        if (err instanceof ChecksRefusedError) return refused(err.message);
        return refused(
          `the platform could not be asked just now (${errorMessage(err)}); try again shortly`,
        );
      }
      // The fetch may outlast the harness: the directory is gone by then.
      if (harnessDone) return refused("the run is finalizing");
      try {
        const saved = await checkLogs.save({
          suiteId: args.suiteId,
          check: args.check,
          generation: log.generation,
          bytes: log.bytes,
        });
        return {
          kind: "saved",
          path: saved.path,
          bytes: log.bytes.byteLength,
          lines: saved.lines,
          generation: log.generation,
        };
      } catch (err) {
        ctx.diag.warn("actions.check_log_save_failed", { runId: item.id, err });
        return refused(`the log could not be saved (${errorMessage(err)})`);
      }
    },
    async checksOwed() {
      if (ctx.checks === undefined || checksAsks === 0) return { owed: 0, waits: false };
      let owed: OwedVerdict[];
      try {
        owed = await ctx.checks.awaiting();
      } catch (err) {
        ctx.diag.warn("actions.checks_owed_failed", { runId: item.id, err });
        // Before the conversation starts nothing has given up yet.
        return { owed: null, waits: conversation?.holdsForChecks() ?? true };
      }
      // A stop waits only for verdicts no give-up named: with none of those, it does not wait.
      return {
        owed: owed.length,
        waits: conversation?.holdsFor(owed) ?? owed.length > 0,
      };
    },
    wake(args) {
      ctx.diag.debug("actions.wake", { runId: item.id, afterMinutes: args.afterMinutes });
      if (harnessDone) return { kind: "refused", reason: "the run is finalizing" };
      if (conversation === null) {
        return { kind: "refused", reason: "the run has not started its agent yet" };
      }
      return conversation.wake(args.afterMinutes, args.note);
    },
    async backgroundRun(args) {
      ctx.diag.debug("actions.background_run", { runId: item.id, label: args.label });
      const refused = noBackground();
      if (refused !== null) return { kind: "refused", reason: refused };
      return await background.jobs!.run(args);
    },
    backgroundOutput(args) {
      const refused = noBackground();
      if (refused !== null) return { kind: "refused", reason: refused };
      return background.jobs!.output(args);
    },
    async backgroundStop(args) {
      ctx.diag.debug("actions.background_stop", { runId: item.id, id: args.id });
      const refused = noBackground();
      if (refused !== null) return { kind: "refused", reason: refused };
      return await background.jobs!.stop(args.id);
    },
    async subagentStart(args) {
      ctx.diag.debug("actions.subagent_start", { runId: item.id, label: args.label });
      const refused = noSubagents();
      if (refused !== null) return { kind: "refused", reason: refused };
      return await background.subagents!.start(args);
    },
    async subagentMessage(args) {
      ctx.diag.debug("actions.subagent_message", { runId: item.id, id: args.id });
      const refused = noSubagents();
      if (refused !== null) return { kind: "refused", reason: refused };
      return await background.subagents!.message(args);
    },
    async subagentStop(args) {
      ctx.diag.debug("actions.subagent_stop", { runId: item.id, id: args.id });
      const refused = noSubagents();
      if (refused !== null) return { kind: "refused", reason: refused };
      return await background.subagents!.stop(args.id);
    },
    subagentsRunning() {
      return background.subagents?.running() ?? 0;
    },
    async unsubmittedBranches() {
      if (!item.canOpenPatches) return [];
      const found: Array<{ path: string; list: string }> = [];
      for (const clone of clones) {
        try {
          const branches = await unsubmittedBranches(gitExec, clone);
          if (branches.length > 0) {
            found.push({ path: clone.repo.path, list: unsubmittedList(branches) });
          }
        } catch (err) {
          ctx.diag.warn("actions.unsubmitted_failed", {
            runId: item.id,
            repo: clone.repo.path,
            err,
          });
        }
      }
      return found;
    },
    async publishArtifact(args) {
      ctx.diag.debug("actions.publish_artifact", { runId: item.id, path: args.path });
      if (item.canPublishArtifacts !== true) {
        return { kind: "refused", reason: "this agent may not publish artifacts" };
      }
      if (harnessDone) return { kind: "refused", reason: "the run is finalizing" };
      return await publishArtifactFile({
        publisher: ctx.artifacts,
        checkoutRoot: ctx.checkoutRoot,
        pending: [...keepingImages],
        unkept: unkeptImages,
      }, args);
    },
    async fetchArtifact(args) {
      ctx.diag.debug("actions.fetch_artifact", { runId: item.id, artifact: args.artifact });
      if (item.canPublishArtifacts !== true) {
        return { kind: "refused", reason: "this agent may not publish artifacts" };
      }
      if (harnessDone) return { kind: "refused", reason: "the run is finalizing" };
      return await fetchArtifactFile({
        publisher: ctx.artifacts,
        checkoutRoot: ctx.checkoutRoot,
      }, args);
    },
  };
  ctx.onActions?.(actions);

  progress("preparing");
  for (const { checkout } of clones) {
    await configureIdentity(gitExec, checkout.dir, item.agent);
    await installRunTrailer(checkout.dir, item.id);
  }
  // The checkout described, with each repo's context file — read HERE, before any repo's setup
  // steps have run anywhere in the checkout, so what is quoted under a repo's heading is what
  // that repository committed.
  //
  // It used to be read after setup, so that a context file a setup step generated was picked up
  // too. That also let one repo's setup plant a file in a SIBLING's clone and have it quoted as
  // the sibling's own words: the post-setup dirty check cannot catch that, because
  // `git status --porcelain` never reports a gitignored path by design, and a planted
  // `CLAUDE.md` the sibling happens to ignore leaves its tree perfectly clean. Reading first
  // gives up the generated file — which nothing depended on — and buys the invariant outright
  // instead of trying to police it.
  const layout = await describeCheckout(
    ctx.checkoutRoot,
    item.repos,
    item.workspace,
    staleBases,
    item.canOpenPatches,
  );
  // The repos' own skills, read here for the same reason and more strictly: from git objects at
  // each clone's base, so they are what each repository committed, whatever setup does next.
  // Held in memory with the frozen ones until setup is over.
  const repoSkills = await findRepoSkills(ctx, item.id, clones);
  // an unavailable brief degrades the run to memoryless; it never fails it
  const snapshot = await ctx.memory
    .loadSnapshot()
    .catch((err) => {
      ctx.diag.warn("memory.loadSnapshot.failed", { runId: item.id, err });
      return null;
    });
  ctx.diag.debug("memory.loaded", { runId: item.id, briefed: snapshot !== null });
  // The staleness check: for every briefed claim with evidence, did the paths it is evidence
  // for change since the commit it was observed at? The only place with a clone is here, so
  // this is where it runs. The findings go upstream (the orchestrator relays them to memory,
  // which re-anchors a claim this run goes on to confirm to the commit reported with it) and
  // into the prompt under "may be outdated" — the brief itself was frozen and rides as is.
  // Best-effort throughout: a check that cannot run is a check that found nothing.
  //
  // A claim is about one repository, and the orchestrator resolved that repository to its
  // directory in this checkout (`evidence.path`): the check runs in exactly that clone. Not in
  // "whichever clone has the commit" — two clones can share history (a fork beside its
  // upstream), and the first to answer would then speak for the other. A claim about a repo
  // this checkout does not hold arrives with no path and is skipped — not failed, and not
  // mistaken for stale.
  const stale: StaleMemory[] = [];
  const cloneAt = new Map(clones.map((clone) => [clone.repo.path, clone]));
  for (const evidence of snapshot?.evidence ?? []) {
    if (evidence.path === null) continue;
    const clone = cloneAt.get(evidence.path);
    if (clone === undefined) continue;
    const changed = await changedSince(
      gitExec,
      clone.checkout.dir,
      evidence.sha,
      evidence.paths,
    ).catch((err) => {
      ctx.diag.warn("memory.staleness.failed", {
        runId: item.id,
        memoryId: evidence.memoryId,
        repo: evidence.path,
        err,
      });
      return null;
    });
    if (changed !== null && changed.length > 0) {
      // The commit the diff resolved HEAD to: this clone's base, cut before the run has done
      // anything. A confirmation later in the run re-anchors the claim to it.
      stale.push({
        memoryId: evidence.memoryId,
        changedPaths: changed,
        headSha: clone.baseSha,
      });
    }
  }
  if (stale.length > 0) {
    ctx.diag.debug("memory.stale", { runId: item.id, memoryIds: stale.map((s) => s.memoryId) });
    ctx.orchestrator.reportStaleMemories(stale);
  }
  const brief = snapshot === null ? null : renderBrief(snapshot.text, stale);
  if (runCancel.signal.aborted) return cancelledEarly();

  progress("setting-up");
  // Each repo's config dir, read in its own clone. The declarations are checked as a UNION:
  // the platform provisions services once per run and the hostnames are shared, so a backend
  // and a frontend that both declare `db` mean the same database. A setup.yml that is invalid
  // is not an error here (`env.setupError`): it is warned about with the setup below.
  const environments: Array<{ repo: RepoEntry; dir: string; env: RepoEnvironment }> = [];
  for (const { repo, checkout } of clones) {
    // A fork's head declares nothing here: its setup.yml would be a contributor's shell
    // commands run with the run's egress, and its services.yml and environment.md are theirs
    // too. Even the repository's own setup steps are not run in it — `npm ci` in a tree
    // somebody else wrote runs their lifecycle scripts. The machine is the default branch's
    // (the control plane never builds a fork head), so it is already set up as far as anything
    // trusted can set it up.
    if (isForkHead(repo)) {
      environments.push({
        repo,
        dir: checkout.dir,
        env: { setup: [], setupError: null, environment: null, declaredServices: [] },
      });
      continue;
    }
    let env: RepoEnvironment;
    try {
      env = await discoverEnvironment(checkout.dir);
    } catch (err) {
      throw new Error(`${repo.path}: ${errorMessage(err)}`);
    }
    environments.push({ repo, dir: checkout.dir, env });
  }
  // Each environment.md is bounded on its own; together they are bounded again, because it is
  // the sum that lands in the prompt, and a checkout of many repos would otherwise grow it
  // without limit.
  assertEnvironmentTotal(
    environments.map((e) => ({ path: e.repo.path, environment: e.env.environment })),
  );
  const declared = unionDeclaredServices(environments.map((e) => e.env.declaredServices));
  const services = ctx.services?.list ?? [];
  ctx.diag.debug("environment.discovered", {
    runId: item.id,
    repos: environments.map((e) => ({
      repo: e.repo.path,
      steps: e.env.setup.length,
      described: e.env.environment !== null,
    })),
    declaredServices: declared.length,
    services: services.length,
  });
  // The checkout asks for services this run did not get. Every way that happens ends in the
  // same place — a suite that waits forever on a database nobody started — so it is refused
  // here, where the message can name the cause, rather than discovered by a test timeout.
  //
  // On the DECLARED NAMES and not on the file's existence: an empty or comments-only
  // `services.yml` is a placeholder the control plane reads as declaring nothing, and treating
  // it as an ask made a legitimate file fail every run with a message about an operator switch
  // that had nothing to do with it.
  //
  // Name by name, not all-or-nothing: the control plane resolved its declaration before this
  // clone existed, so a push landing in between can add `redis` beside a provisioned `db` — and
  // a run missing ONE hostname hangs exactly as well as a run missing all of them.
  const provisioned = new Map(services.map((service) => [service.name, service]));
  const missing = declared
    .filter((d) => !provisioned.has(d.name))
    .map((d) => d.name);
  if (missing.length > 0 && services.length === 0) {
    throw new Error(
      `${REPO_CONFIG_DIR}/services.yml declares ${missing.join(", ")}, but no service ` +
        "containers were provisioned for this run. Either this deployment does not run them " +
        "(the operator's RYPH_SERVICES is off), or the declaration was not on the ref the " +
        "control plane read. Running the suite from here would hang rather than fail.",
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `${REPO_CONFIG_DIR}/services.yml declares ${
        missing.join(", ")
      }, but this run was provisioned only ` +
        `${[...provisioned.keys()].join(", ")}. Services are resolved before the clone, so the ` +
        "declaration in this checkout is not the one the run was launched with — most likely " +
        "a push landed in between. Running the suite from here would hang rather than fail; " +
        "starting the run again resolves the declaration afresh.",
    );
  }
  // The same push-in-between under an unchanged name: the checkout moved `db` to another port,
  // and the suite would dial one nothing listens on. Env, command and image cannot be compared
  // from here — the spec carries none of the first two, and the third arrives resolved — so a
  // change to those alone is the drift this does not catch. Closing that means pinning the
  // clone and the declaration to one commit.
  const moved = declared.filter((d) => {
    const got = provisioned.get(d.name);
    return got !== undefined && d.port !== null && d.port !== got.port;
  });
  if (moved.length > 0) {
    const wanted = moved.map((d) => `${d.name}:${d.port}`).join(", ");
    const got = moved.map((d) => `${d.name}:${provisioned.get(d.name)?.port}`).join(", ");
    throw new Error(
      `${REPO_CONFIG_DIR}/services.yml declares ${wanted}, but this run was provisioned ${got}. ` +
        "Services are resolved before the clone, so the declaration in this checkout is not " +
        "the one the run was launched with — most likely a push landed in between. Running the " +
        "suite from here would fail against the wrong port; starting the run again resolves " +
        "the declaration afresh.",
    );
  }
  // Before setup, because a setup step is the first thing that would try to use them — and
  // before the harness, because the agent must never be the one to discover a dead database.
  await waitForServices(services, {
    signal: runCancel.signal,
    diag: ctx.diag,
    onWait: (service, waitedMs) =>
      progress(
        "setting-up",
        `waiting for ${service.name}:${service.port} (${Math.round(waitedMs / 1000)}s)`,
      ),
  });
  if (runCancel.signal.aborted) return cancelledEarly();
  // Setup runs per repo, in checkout order, each step in its own clone — like CI. A failing step
  // stops THAT repo's steps (the later ones usually build on it) and nothing else: setup is an
  // optimization, and an agent on a half-prepared machine can finish the job itself, where a
  // run refused over it does nothing at all. An invalid setup.yml is the same, with no step run.
  // So the next repo's setup still runs, the run goes on, and the failure is a warning in two
  // places — the run's history (reportSetupFailures), and the machine block, which tells the
  // agent what did not run. A step that could not be run at all (no bash) is the machinery's,
  // and still fails the run.
  const setupFailures: RepoSetupFailure[] = [];
  // Where each checkout stood before any setup ran: its base, its branch, the replace refs it
  // came with, where git found it, and which submodules were checked out (none, in a fresh
  // clone). What a tree goes back to when its setup fails — never wherever HEAD has moved,
  // since a step can commit, switch branch or stop mid-rebase, and finalize would ship that
  // commit as the agent's.
  const starts = new Map<string, CheckoutStart>();
  for (const c of clones) {
    starts.set(
      c.repo.path,
      await checkoutStart(gitExec, c.checkout.dir, { sha: c.baseSha, branch: workBranch(c.repo) }),
    );
  }
  const startOf = (path: string) => {
    const start = starts.get(path);
    if (start === undefined) throw new Error(`${path}: no checkout to set up`);
    return start;
  };
  // The warnings go upstream once, as the run's history — after the clean-tree check, or when
  // the run is cancelled part-way through setup, so the repos that had already warned are not
  // lost. Waited on, within the gateway's request timeout and never throwing: a run that ends
  // right after setup would otherwise land its result first, and the warning would be refused
  // as late.
  const reportSetup = async (): Promise<void> => {
    if (setupFailures.length === 0) return;
    // Checkout order, as the agent reads the repos.
    const order = environments.map((e) => e.repo.path);
    setupFailures.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
    await ctx.orchestrator.reportSetupFailures(
      setupFailures.map(({ path, failure, discarded }): SetupFailureReport =>
        failure.kind === "step"
          ? { ...failure, path, discarded: discarded ?? false }
          : { ...failure, path }
      ),
    ).catch((err) =>
      ctx.diag.warn("orchestrator.reportSetupFailures.failed", {
        runId: item.id,
        err: String(err),
      })
    );
  };
  for (const { repo, dir, env } of environments) {
    if (env.setupError !== null) {
      ctx.diag.warn("setup.invalid", { runId: item.id, repo: repo.path, error: env.setupError });
      progress(
        "setting-up",
        `${repo.path}: ${clipReason(env.setupError.split("\n")[0], SETUP_PROGRESS_MAX)} — ` +
          "continuing without its setup",
      );
      setupFailures.push({ path: repo.path, failure: { kind: "invalid", error: env.setupError } });
      continue;
    }
    if (env.setup.length === 0) continue;
    let failed: SetupStepFailure | null;
    try {
      failed = await runSetup(env.setup, {
        cwd: dir,
        phase: "run",
        signal: runCancel.signal,
        diag: ctx.diag,
        // Every repo's declared services, so a step that waits on one BY NAME is not sent to
        // the egress proxy, which refuses an in-network address and names a bundle variable
        // that could never have carried it.
        services: declared.map((service) => service.name),
        onStep: (step, index) =>
          progress(
            "setting-up",
            `${repo.path}: step ${index + 1}/${env.setup.length}: ${stepLabel(step, index)}`,
          ),
      });
    } catch (err) {
      // The run fails over a step that could not be run, but what earlier repos already warned
      // of is its history too.
      await reportSetup();
      throw new Error(`${repo.path}: ${errorMessage(err)}`);
    }
    if (runCancel.signal.aborted) {
      await reportSetup();
      return cancelledEarly();
    }
    if (failed !== null) {
      // What a failed step left in its tree (an `npm install` that rewrote the lockfile, then
      // failed; yarn's error log; a commit; a rebase it stopped in) is not work, and the run must
      // not ship it — nor be refused over it by the dirty-tree check below, which would turn the
      // warning back into an error. So THIS repo's checkout goes back to its base and branch,
      // now, before a later repo's setup runs. Ignored files stay. A tree that cannot be put
      // back is fatal: shipping it is the one thing worse than not running.
      let discarded: boolean;
      try {
        discarded = await putBack(gitExec, dir, startOf(repo.path), { failed: true });
      } catch (err) {
        // The run fails, but what setup already warned of — this step included — is its history.
        setupFailures.push({ path: repo.path, failure: failed, discarded: false });
        await reportSetup();
        throw new Error(
          `${repo.path}: setup step "${failed.step}" failed (exit ${failed.code}), and ` +
            errorMessage(err),
        );
      }
      ctx.diag.warn("setup.failed", {
        runId: item.id,
        repo: repo.path,
        step: failed.step,
        index: failed.index,
        total: failed.total,
        code: failed.code,
        discarded,
      });
      progress(
        "setting-up",
        `${repo.path}: step ${failed.index}/${failed.total} failed (exit ${failed.code}): ` +
          `${failed.step} — continuing without the rest of its setup`,
      );
      setupFailures.push({ path: repo.path, failure: failed, discarded });
    }
  }
  // Setup prepares the environment, it never authors work: anything it leaves in a tree would
  // be committed at finalize as the agent's. Every clone is checked once, after EVERY repo's
  // steps have run — a later repo's setup can reach into an earlier clone, and a check taken
  // between the two would have passed that clone already. A tree setup left changed (an
  // `npm install` rewriting the lockfile, codegen into a tracked file, a commit) is put back to
  // its start and warned about, naming the files — setup artifacts belong in .gitignore — never
  // refused: that would make an optimization a gate. Only a tree that cannot be put back fails
  // the run, since it would ship as the agent's work.
  //
  // Unless a step FAILED in another repo: a failing step may have written into this one
  // (`cd ../web && npm install`), and what it wrote cannot be told apart from this repo's own
  // setup's. Refusing would turn that repo's warning back into an error, and shipping it would
  // pass a failed step's writes off as the agent's work, so the tree goes back to its start too
  // (HEAD and branch included, as above) and the warning names both repos. A repo whose own
  // step failed was put back above; changes there since are a later repo's — certainly a
  // setup's that succeeded when no other repo failed (put back as above), maybe a failed one's
  // when another did.
  const stepFailed = setupFailures.filter((f) => f.failure.kind === "step").map((f) => f.path);
  // A repo whose own setup did not finish (a step failed, or setup.yml is invalid) is never told
  // its setup finished: changes there are a later repo's, put back without a `dirty` warning.
  const unfinished = new Set(
    setupFailures.filter((f) => f.failure.kind === "step" || f.failure.kind === "invalid")
      .map((f) => f.path),
  );
  const checkTrees = async (): Promise<void> => {
    for (const { repo, dir } of environments) {
      // Once any step failed, every repo goes back with the filter drivers it started with, as
      // above: a failed step may have written another repo's config too, and what is left there
      // cannot be told apart from its writes. With no failure, the config setup left stays
      // (`PutBackOptions`).
      const ownFailed = stepFailed.includes(repo.path);
      const after = stepFailed.filter((path) => path !== repo.path);
      if (after.length > 0) {
        let discarded: boolean;
        try {
          discarded = await putBack(gitExec, dir, startOf(repo.path), { failed: true });
        } catch (err) {
          throw new Error(
            `${repo.path}: after setup failed in ${after.join(", ")}, ${errorMessage(err)}`,
          );
        }
        // A repo whose own step failed already carries a warning that says its tree was put
        // back; this restore is part of that, and adds no second warning for the repo.
        if (!discarded || stepFailed.includes(repo.path)) continue;
        ctx.diag.warn("setup.discarded", { runId: item.id, repo: repo.path, after });
        progress(
          "setting-up",
          `${repo.path}: changes left after setup failed in ${after.join(", ")} were discarded`,
        );
        setupFailures.push({ path: repo.path, failure: { kind: "discarded", after } });
        continue;
      }
      const files = (await changedPaths(gitExec, dir)).slice(0, MAX_DIRTY_FILES);
      let discarded: boolean;
      try {
        discarded = await putBack(gitExec, dir, startOf(repo.path), { failed: ownFailed });
      } catch (err) {
        throw new Error(`${repo.path}: ${errorMessage(err)}`);
      }
      if (!discarded || unfinished.has(repo.path)) continue;
      ctx.diag.warn("setup.dirty", { runId: item.id, repo: repo.path, files });
      progress(
        "setting-up",
        clipReason(`${repo.path}: ${dirtyNote(files)}`, SETUP_PROGRESS_MAX),
      );
      setupFailures.push({ path: repo.path, failure: { kind: "dirty", files } });
    }
  };
  try {
    await checkTrees();
  } finally {
    // Reported even when the check refuses the run: the warnings are its history too.
    await reportSetup();
  }
  // The repos' own prose, each under its heading, so a description that says "the database"
  // is read as one repo's and not the checkout's.
  const prose = environments
    .filter((e) => e.env.environment !== null)
    .map((e) => `### ${inCode(`${e.repo.path}/`)}\n\n${e.env.environment}`);
  const repoProse = prose.length === 0 ? null : prose.join("\n\n");
  // The machine, in the platform's voice and ahead of everything the repos say about it. Its
  // own block, composed on EVERY run: what the image is comes from the spec and is known only
  // when the control plane resolved one, but what is on this box is measured here — once, now,
  // while nothing else is running — and is true whatever launched the run.
  const machineFacts = {
    environment: ctx.environment ?? null,
    checkouts: origins,
    probe: await probeMachine(),
    setupFailures,
  };
  const machine = describeMachine(machineFacts);
  // A subagent's: the same machine, without the run's standing facts (who speaks to it, when to
  // verify before finishing or shipping), none of which is true of it.
  const subagentMachine = describeMachine({ ...machineFacts, reader: "subagent" });

  // A run awaiting its prompt says it is running only once it is ready for one (below): until
  // then the run page shows it starting, and a message sent meanwhile waits in its inbox.
  const awaiting = item.spec.instructions === null;
  if (!awaiting) progress("running");
  // The run's images: the task's fetched and saved now, a message's when it arrives — into one
  // directory outside every clone, numbered across the run, removed when the harness is done.
  const images = runImages(
    ctx.attachments ?? {
      fetch: () => Promise.reject(new Error("this run has no control plane to fetch it from")),
    },
    ctx.diag,
  );
  const declaredChecks = await checksDeclared;
  checksTold = ctx.checks !== undefined &&
    (declaredChecks === null || declaredChecks.declared.length > 0 ||
      declaredChecks.unread.length > 0);
  bestEffort(
    ctx.diag,
    "checks.told.failed",
    { runId: item.id },
    () => ctx.onChecksTold?.(checksTold),
  );
  // The browser's answer, which is usually long in by now: its wait started at boot and is
  // bounded at a minute, and it never rejects (ports/browser.ts). Before the skills are written,
  // so a slow browser never stretches the moment they sit on disk before the harness starts —
  // and before a prompt is waited for, so a run that says it is ready has its browser.
  const browser = ctx.browser === undefined ? undefined : await ctx.browser.ready;
  const tools = browser?.kind === "ready"
    ? { ...(ctx.tools ?? { servers: [], tokenEnv: "" }), browser: browser.tools }
    : ctx.tools;

  // The task: the work item's, or — on a run whose task was started without instructions — the
  // first message, waited for here on the attended idle clock (core/prompt.ts). Its seq is
  // where the conversation's poll starts, so it reaches the agent once, as the task.
  //
  // A `[image N: …]` line is the runner's alone (core/images.ts): the instructions carry a
  // thread's text, and none written there may pose as the note under them. The bare `[image N]`
  // markers the control plane placed are left as they are.
  let spec: TaskSpec;
  let taskRefs = item.attachments ?? [];
  let after = -1;
  if (item.spec.instructions === null) {
    const waited = await awaitPrompt({
      inbox: ctx.inbox,
      idleMs: item.lifetime.attendedIdleMs,
      signal: runCancel.signal,
      diag: ctx.diag,
      onIdleDeadline: (deadlineAt) =>
        progress("running", undefined, deadlineAt, deadlineAt === null ? null : "waiting-for-user"),
    });
    if (waited.kind !== "prompt") {
      await images.remove();
      await checkLogs.remove();
      if (waited.kind === "cancelled") return cancelledEarly();
      ctx.diag.debug("prompt.idle", { runId: item.id });
      return {
        status: "cancelled",
        branches: [],
        summary: `No instructions arrived within ${
          Math.round(item.lifetime.attendedIdleMs / 60_000)
        } minutes of the run being ready, so it ended without starting the agent.`,
      };
    }
    spec = promptSpec(waited.message);
    subject = spec.title;
    taskRefs = waited.message.attachments;
    after = waited.message.seq;
    // The agent is at work now: no deadline until it settles.
    progress("running", undefined, null, null);
  } else {
    spec = { ...item.spec, instructions: neutraliseImageLines(item.spec.instructions) };
  }
  const taskImages = harnessImagesOf(await images.save(taskRefs), "task");
  // The conversation: the inbox is pulled from here until finalize, every message framed for the
  // agent, and the idle clock reported on every beat so the control plane's reaper can backstop
  // it. The agent's background commands live beside it: a notice goes through the
  // conversation's door, and a running job holds its clock.
  const checks = ctx.checks;
  const jobs = startBackgroundJobs({
    diag: ctx.diag,
    checkoutRoot: ctx.checkoutRoot,
    env: () => agentEnv,
    notice: (message) => conversation?.notify(message) ?? false,
    holdChanged: () => conversation?.holdChanged(),
    ...(ctx.backgroundRecords === undefined ? {} : { records: ctx.backgroundRecords }),
    ...(ctx.commandsUplink === undefined ? {} : { uplink: ctx.commandsUplink }),
  });
  background.jobs = jobs;
  bestEffort(
    ctx.diag,
    "background.bind.failed",
    { runId: item.id },
    () => ctx.onBackground?.(() => jobs.stopAll()),
  );
  // And its subagents: each a lane of the run's history of its own, an end it did not wait on
  // through the same door, a running one holding the same clock.
  const subagents = startSubagents({
    diag: ctx.diag,
    ...(ctx.subagents === undefined ? {} : { host: ctx.subagents }),
    context: () => subagentContext,
    narrate: (lane, chunk) => {
      bestEffort(
        ctx.diag,
        "narrator.emit.failed",
        { runId: item.id, kind: chunk.kind, lane },
        () => ctx.narrator.emit(item.id, chunk, lane),
      );
    },
    notice: (message) => conversation?.notify(message) ?? false,
    holdChanged: () => conversation?.holdChanged(),
  });
  background.subagents = subagents;
  bestEffort(
    ctx.diag,
    "subagents.bind.failed",
    { runId: item.id },
    () => ctx.onSubagents?.(() => subagents.stopAll()),
  );
  const talk = startConversation({
    inbox: ctx.inbox,
    lifetime: item.lifetime,
    diag: ctx.diag,
    onTranscript: narrate,
    onIdleDeadline: (deadlineAt) => {
      // Null also reports a steer to a working agent. Only a resume from idle clears the
      // previous turn's request; a mid-turn message must preserve this turn's pending intent.
      if (deadlineAt === null && agentWasIdle) awaitingUserTurn = false;
      agentWasIdle = deadlineAt !== null;
      progress(
        "running",
        undefined,
        deadlineAt,
        deadlineAt === null ? null : awaitingUserTurn ? "waiting-for-user" : "idle",
      );
    },
    onPatchCue: (payload) => shipper.onPatchCue(clones, payload),
    // A person's finish stops what the agent started in the background, its subagents too, as
    // the agent's own finish does — at the settle, where it cannot cut the agent's turn short.
    onPersonFinish: () => {
      void background.jobs?.stopAll();
      void background.subagents?.stopAll();
    },
    // The agent is about to act on something new: the outcome it declared is no longer what the
    // page offers a finish on, until it declares one again.
    onDelivered: () => {
      if (saidUpstream !== null) sayOutcome(null);
    },
    signal: runCancel.signal,
    after,
    ...(item.chat === undefined ? {} : { chat: item.chat }),
    interactive: item.interactive === true,
    images,
    holdUntil: () => {
      const holds = [jobs.holdUntil(), subagents.holdUntil()].filter((at) => at !== null);
      return holds.length === 0 ? null : Math.max(...holds);
    },
    // A settle or a finish while the verdict of checks the run caused is still owed waits for it.
    ...(checks === undefined ? {} : {
      verdicts: {
        asks: () => checksAsks,
        awaiting: () => checks.awaiting(),
        onWaiting: (waiting) =>
          progress("running", waiting ? "waiting for the checks' verdict" : undefined),
        ...ctx.checksHold,
      },
    }),
  });
  conversation = talk;
  // The seq comes back so a harness can point at what it already narrated (see the `final`
  // mark in the pi adapter); a narrator that failed or keeps no record answers undefined,
  // which is the harness's cue not to point at all.
  function narrate(chunk: TranscriptChunk): number | undefined {
    return bestEffort(
      ctx.diag,
      "narrator.emit.failed",
      { runId: item.id, kind: chunk.kind },
      () => ctx.narrator.emit(item.id, chunk),
    );
  }
  // The skills, written now and not a moment earlier: setup steps are repo-authored commands
  // running as this same user, and a directory that existed while they ran could have been
  // rewritten by any of them — a catalogue skill, an org skill, the very description counted
  // against the listing cap. Removed as soon as the harness is done with it.
  const skills = await materializeSkills(ctx, item.id, await skillsReady, repoSkills);
  subagentContext = {
    checkoutDir: ctx.checkoutRoot,
    layout,
    machine: subagentMachine,
    serviceHosts: declared.map((service) => service.name),
    ...(tools === undefined ? {} : { tools: { servers: tools.servers, tokenEnv: tools.tokenEnv } }),
  };
  let outcome;
  try {
    outcome = await ctx.harness.run(
      {
        spec,
        agent: item.agent,
        ...(item.chat === undefined ? {} : { chat: item.chat }),
        systemPrompt: ctx.injectedCtx.systemPrompt,
        layout,
        // The true list first, the repos' prose after — and no repo can drop the list.
        // `environment.md` comes from the checkout while services are resolved through the
        // forge, so left alone a repo's own description can confidently name a database that
        // is not there.
        machine,
        environment: composeEnvironment(services, ctx.services?.stale ?? false, repoProse),
        brief,
        checkoutDir: ctx.checkoutRoot,
        repos: item.repos,
        // The names that must stay OFF the egress proxy while the agent works, for the reason
        // a setup step's list exists: a declared service is on the run's own network, and the
        // proxy refuses an in-network address by design (helpers/environment.ts).
        serviceHosts: declared.map((service) => service.name),
        tools,
        checksEnabled: ctx.checks !== undefined,
        canOpenPatches: item.canOpenPatches,
        canPublishArtifacts: item.canPublishArtifacts,
        ...(item.unattended === true ? { unattended: true } : {}),
        ...(item.interactive === true ? { interactive: true } : {}),
        ...(ctx.checks === undefined ? {} : { checksDeclared: declaredChecks }),
        skills: skills.list,
        ...(taskImages === undefined ? {} : { taskImages }),
        ...(browser === undefined
          ? {}
          : { browser: browser.kind === "ready" ? "ready" : "failed" }),
      },
      {
        signal: runCancel.signal,
        onTranscript: (chunk) => {
          talk.activity();
          return narrate(chunk);
        },
        diagnostics: ctx.diag,
        onAgentEnv: (env) => {
          agentEnv = env;
        },
        // A tool's image kept as a run attachment before its result is narrated, so the
        // transcript names it rather than carrying it — where there is a control plane to keep it.
        ...(ctx.attachments === undefined ? {} : {
          keepImage: (bytes, imageRef, signal) => ctx.attachments!.upload(bytes, imageRef, signal),
          keepingImages: (settled) => {
            keepingImages.add(settled);
            settled.finally(() => keepingImages.delete(settled)).catch(() => {});
          },
          unkeptImage: (imageRef, reason) => {
            unkeptImages.delete(imageRef);
            unkeptImages.set(imageRef, reason);
            if (unkeptImages.size > MAX_UNKEPT_REFS) {
              unkeptImages.delete(unkeptImages.keys().next().value!);
            }
          },
        }),
        conversation: talk.harness,
      },
    );
  } finally {
    // The poll and the clock end with the harness, whatever ended it; a late tool call finds
    // the actions refusing.
    harnessDone = true;
    talk.stop();
    // Before finalize commits: nothing the agent started may write the tree mid-commit.
    await Promise.all([background.jobs?.stopAll(), background.subagents?.stopAll()]);
    // A merge between the end of the agent's work and now still moves the shipper, however
    // the run ended (never a throw).
    await drainPatchCues({
      inbox: ctx.inbox,
      after: talk.cursor,
      onPatchCue: (payload) => shipper.onPatchCue(clones, payload),
      diag: ctx.diag,
    });
    await skills.remove();
    await images.remove();
    await checkLogs.remove();
  }

  ctx.diag.debug("harness.finished", {
    runId: item.id,
    interrupted: outcome.interrupted,
    endedBy: talk.endedBy,
  });
  // How the run went is what the agent reported through its tools; its summary wins over the
  // harness's, which is the agent's last message. (The cast: `reported` is set in a callback,
  // which the compiler's narrowing does not see.)
  const agentSaid = reported as OutcomeReport | null;
  const declaredOutcome = agentSaid?.outcome ?? null;
  const summary = agentSaid?.summary ?? outcome.summary;
  // finish's summary winning RETRACTS the harness's `final` mark. That mark names the message
  // the harness took ITS summary from, and the result no longer shows that message's words — so
  // a reader folding the marked row would delete a message the result never repeats, which is
  // the one thing the mark exists to prevent. A later mark supersedes an earlier one and a null
  // seq names nothing, so the retraction is just the mark said again, emptier.
  if (agentSaid?.summary !== undefined) narrate({ kind: "final", raw: { seq: null } });
  // The agent's account, and how much of it the thread's status comment repeats.
  const statusComment = agentSaid?.statusComment;
  let said = statusComment === undefined ? { summary } : { summary, statusComment };

  progress("finalizing");
  // Per repo, in checkout order: ship whatever is still unshipped — the leftovers committed,
  // the commits since that repo's base bundled — exactly as a mid-run submit does. A repo with
  // nothing new contributes nothing here, but a branch it shipped mid-run still stands in the
  // result. On cancel too: the harness stops at a coherent point, and whatever is in each tree
  // ships.
  //
  // Each repo ships on its own: a push the gateway refuses, a clone the agent moved away, a
  // tree that will not commit — any of it fails THAT repo and the loop goes on, so the work in
  // every other repo still leaves the box. The run then reports an error naming each repo that
  // failed, with `branches` listing what did ship, and the control plane opens patches from
  // that list — each held for a person's approval whatever the repo's policy, since the run
  // did not succeed.
  const failed: Array<{ path: string; name: string; reason: string }> = [];
  // What finalize had to give up that the agent's own account cannot know about: said after it.
  const notes: string[] = [];
  for (const clone of clones) {
    // A run that may not open patches ships nothing: what the agent changed stays in the box,
    // and the record says so, so nobody goes looking for a patch. Commits count on the run's
    // own branch only: HEAD may sit on a release branch the agent checked out just to read.
    if (!item.canOpenPatches) {
      const dir = clone.checkout.dir;
      const work = defaultLine(clone);
      const changed = await hasChanges(gitExec, dir).catch(() => false) ||
        (await commitsSince(gitExec, dir, work.baseSha, `refs/heads/${work.branch}`)
            .catch(() => [])).length > 0;
      if (changed) {
        notes.push(
          `${clone.repo.path}: this agent may not open patches, so its changes there were ` +
            "not shipped.",
        );
      }
      continue;
    }
    const { repo } = clone;
    // Every line the clone holds — the default line, and each line a submit shipped — never
    // every local branch. The line the checkout is on first: its leftovers are committed before
    // any other line ships. A checkout on no line at all is
    // the default line's to answer for (`off-branch`), and its note says what did not ship.
    const holder = await holderOf(gitExec, clone).catch(() => undefined) ?? defaultLine(clone);
    // A fork pull request's head ships its default line only: it delivers onto that pull
    // request or nowhere (`submitPatch` never lets another line be born there).
    const lines = isForkHead(repo) ? [defaultLine(clone)] : [...clone.lines.values()];
    lines.sort((a, b) => Number(b === holder) - Number(a === holder));
    for (const line of lines) {
      // How the notes and failures name what shipped: the repo alone for the default line, as a
      // run that never named a branch always read; the branch beside it for any other.
      const label = line.line === DEFAULT_LINE ? repo.path : `${repo.path} (${line.branch})`;
      try {
        const shippedNow = await shipper.finalize(line);
        if (shippedNow.abandoned !== undefined) {
          notes.push(abandonedNote(label, shippedNow.abandoned));
        }
        if (shippedNow.withheld !== undefined) {
          notes.push(withheldNote(label, line.branch, shippedNow.withheld));
        }
        if (shippedNow.gone !== undefined) {
          notes.push(goneNote(label, line.branch, shippedNow.gone));
        }
        // Only about what went out: a branch with nothing new shipped nothing unrebased.
        // (`refused` at finalize is the report failing after the push landed: it shipped.)
        if (
          line.unrebased !== null &&
          (shippedNow.kind === "submitted" || shippedNow.kind === "refused")
        ) notes.push(unrebasedNote(repo.path, line.line, line.unrebased));
        // The branch is in the result as a fallback — nothing to fail the repo on.
        if (shippedNow.kind === "refused") {
          ctx.diag.warn("finalize.report_failed", {
            runId: item.id,
            repo: repo.path,
            line: line.line,
          });
        }
      } catch (err) {
        const reason = errorMessage(err);
        ctx.diag.warn("finalize.repo_failed", {
          runId: item.id,
          repo: repo.path,
          line: line.line,
          err: reason,
        });
        failed.push({ path: label, name: repo.name, reason });
      }
    }
    // Finalize ships lines, never every local branch: one the agent committed to and never
    // submitted is left behind, and the person reading the summary is told which.
    try {
      const left = await unsubmittedBranches(gitExec, clone);
      if (left.length > 0) notes.push(unsubmittedNote(repo.path, left));
    } catch (err) {
      ctx.diag.warn("finalize.unsubmitted_failed", { runId: item.id, repo: repo.path, err });
    }
  }
  if (notes.length > 0) {
    // The notes go after the agent's account and are never the part cut: the control plane
    // refuses a longer summary outright, and with it the branches the report names.
    const tail = clipReason(notes.join("\n\n"), SUMMARY_MAX / 2);
    said = {
      ...said,
      summary: summary === ""
        ? tail
        : `${clipReason(summary, SUMMARY_MAX - tail.length - 3)}\n\n${tail}`,
    };
  }
  if (failed.length > 0) {
    return {
      status: "error",
      during: "finalizing",
      // Each failure is cut on its own, so one repo's wall of git stderr cannot crowd out the
      // names of the others; the sum stays far under what the control plane accepts, which a
      // longer reason would exceed — refusing the report, and with it the branches that did ship.
      // An error result carries no summary, so the notes ride the reason after the failures.
      reason: clipReason(
        [
          ...failed.map((f) =>
            `shipping ${f.path} (${f.name}) failed: ${clipReason(f.reason, REASON_PER_REPO_MAX)}`
          ),
          ...notes,
        ].join("; "),
        REASON_MAX,
      ),
      branches: shipper.shipped(),
    };
  }

  // nothing to ship: an interrupted run never got the chance; a completed one succeeded if the
  // agent said it was done — `success` or `no-changes`, through `finish` or `report_outcome` — and
  // failed to deliver otherwise. Not every task is a code change: a question answered, an
  // alarm looked into and found benign, a review with nothing to fix all end with an empty
  // branch list, and the empty list already says no code changed. A declared "success" is
  // therefore not held against the agent as a contradiction; only silence (no outcome reported)
  // leaves the run's completion unclaimed, and a declared failure is taken at its word.
  const branches = shipper.shipped();
  if (branches.length === 0) {
    if (outcome.interrupted) {
      return { status: "cancelled", branches: [], ...said };
    }
    if (declaredOutcome === "success" || declaredOutcome === "no-changes") {
      return { status: "success", branches: [], ...said };
    }
    return {
      status: "failure",
      // A run its idle clock ended is the common silent one — the agent stopped talking and
      // nobody spoke to it — and says so, rather than reading as a run that broke.
      reason: declaredOutcome === "failed"
        ? "agent reported failure"
        : declaredOutcome === "in-progress"
        ? unfinishedReason(talk.endedBy)
        : talk.endedBy === "idle"
        ? "ended on its idle clock without reporting an outcome"
        : "run completed without producing any changes or declaring an outcome",
      ...said,
      branches: [],
    };
  }

  if (outcome.interrupted) {
    return { status: "cancelled", branches, ...said };
  }
  // commits ship either way: a self-declared failure still carries its branches, and the
  // patches are born pending approval instead of auto-queued
  if (declaredOutcome === "failed") {
    return { status: "failure", reason: "agent reported failure", ...said, branches };
  }
  // ...and so does work the agent last said was still in progress: it never claimed the
  // delivery, so the run is not a success and its patches wait for a person, as a failure's do.
  if (declaredOutcome === "in-progress") {
    return { status: "failure", reason: unfinishedReason(talk.endedBy), ...said, branches };
  }
  return { status: "success", branches, ...said };
}

/**
 * Why a run whose agent last reported "in-progress" did not succeed: it ended unfinished, which is
 * not the agent failing — healthy work the idle clock outlasted is the common case — and the
 * reason says so. There is no status for it: a run either delivered or it did not, and one whose
 * agent never claimed the delivery did not, so its patches wait for a person like a failure's.
 */
function unfinishedReason(endedBy: string | null): string {
  return endedBy === "idle"
    ? "ended on its idle clock while the agent's work was still in progress"
    : "ended while the agent's work was still in progress";
}

/** How many skill bundles are fetched at once. */
const SKILL_FETCH_CONCURRENCY = 4;

/**
 * Every frozen skill's bundle, fetched four at a time and checked in memory: the skills ready to
 * be written, and the ones that were not, with why. Total: it never rejects.
 */
async function prepareSkills(
  ctx: RunCtx,
  runId: string,
  signal: AbortSignal,
): Promise<{ prepared: PreparedSkill[]; dropped: SkillReport["dropped"] }> {
  const frozen = ctx.skills?.spec.skills ?? [];
  const results: Array<PreparedSkill | SkillReport["dropped"][number]> = new Array(frozen.length);
  let next = 0;
  const worker = async () => {
    while (next < frozen.length) {
      const index = next++;
      const skill = frozen[index];
      const drop = (reason: "invalid" | "unavailable", detail: string) =>
        skillDrop({ source: skill.source, name: skill.name, reason, detail });
      try {
        const bundle = await ctx.skills!.bundles.fetch(skill.digest, signal);
        if (bundle === null) {
          results[index] = drop("unavailable", "the platform holds no such version");
          continue;
        }
        const prepared = await prepareFrozenSkill(skill, bundle);
        results[index] = "refused" in prepared ? drop("invalid", prepared.refused) : prepared;
      } catch (err) {
        if (!signal.aborted) {
          ctx.diag.warn("skills.fetch_failed", { runId, skill: skill.name, err: String(err) });
        }
        results[index] = drop("unavailable", errorMessage(err).trim() || "the fetch failed");
      }
    }
  };
  await Promise.all(Array.from({ length: SKILL_FETCH_CONCURRENCY }, worker));
  return {
    prepared: results.filter((r): r is PreparedSkill => "files" in r),
    dropped: results.filter((r): r is SkillReport["dropped"][number] => !("files" in r)),
  };
}

/**
 * The working repos' own skills, when the run may add them: judged, put after the frozen ones in
 * precedence and held to the budget the run was frozen with (helpers/repo_skills.ts). A repo
 * that cannot be read costs its own skills and a warning, never the run.
 */
async function findRepoSkills(
  ctx: RunCtx,
  runId: string,
  clones: readonly CloneState[],
): Promise<{ prepared: PreparedSkill[]; dropped: SkillReport["dropped"] }> {
  const spec = ctx.skills?.spec;
  if (spec === undefined || !spec.workingRepos) return { prepared: [], dropped: [] };
  try {
    const found = await discoverRepoSkills({
      // Never a fork head's: a skill is instructions, and those files are a contributor's.
      repos: clones.filter((c) => !isForkHead(c.repo))
        .map((c) => ({ path: c.repo.path, dir: c.checkout.dir, commit: c.baseSha })),
      frozen: spec.skills,
      budget: spec.budget,
      git: makeGitBounded(ctx.diag),
      catFile: makeCatFileBatch(ctx.diag),
    });
    for (const unread of found.unread) {
      ctx.diag.warn("skills.repo_unread", { runId, repo: unread.repo, err: unread.error });
    }
    // A directory whose name is no skill name, or a submodule committed as `.agents/skills`
    // itself, cannot be named on the trail: the control plane refuses such a drop, and the rest
    // of the report with it.
    if (found.unnamed.length > 0) {
      ctx.diag.warn("skills.repo_unnamed", { runId, skipped: found.unnamed });
    }
    // An optional field a loaded skill got wrong is left out of it; nothing else would say so.
    if (found.warnings.length > 0) {
      ctx.diag.warn("skills.repo_fields_left_out", { runId, warnings: found.warnings });
    }
    return { prepared: found.prepared, dropped: found.dropped };
  } catch (err) {
    ctx.diag.warn("skills.repo_failed", { runId, err: String(err) });
    return { prepared: [], dropped: [] };
  }
}

/**
 * The prepared skills, frozen and the repos' own, written to a fresh directory of the core's
 * own, outside every clone, and the trail reported: the repo skills loaded and every skill
 * dropped, in one report. A skill that cannot be written costs only itself, and a directory that
 * cannot be made costs the run its skills, never the run.
 */
async function materializeSkills(
  ctx: RunCtx,
  runId: string,
  frozen: { prepared: PreparedSkill[]; dropped: SkillReport["dropped"] },
  repos: { prepared: PreparedSkill[]; dropped: SkillReport["dropped"] },
): Promise<{ list: HarnessSkill[]; remove: () => Promise<void> }> {
  const prepared = [...frozen.prepared, ...repos.prepared];
  const dropped = [...frozen.dropped, ...repos.dropped];
  const list: HarnessSkill[] = [];
  let root: string | null = null;
  const unwritten = (skill: PreparedSkill) =>
    dropped.push(skillDrop({
      ...skillOrigin(skill),
      name: skill.name,
      reason: "unavailable",
      detail: "it could not be written to disk",
    }));
  if (prepared.length > 0) {
    try {
      const written = await writeSkills(prepared);
      root = written.root;
      prepared.forEach((skill, i) => {
        const result = written.written[i];
        if ("error" in result) {
          ctx.diag.warn("skills.write_failed", { runId, skill: skill.name, err: result.error });
          unwritten(skill);
          return;
        }
        list.push({
          ...skillOrigin(skill),
          name: skill.name,
          description: skill.description,
          dir: result.dir,
        });
      });
    } catch (err) {
      ctx.diag.warn("skills.materialize_failed", { runId, err: String(err) });
      prepared.forEach(unwritten);
    }
  }
  const loaded = list.flatMap((s) => s.source === "repo" ? [{ path: s.path, name: s.name }] : []);
  ctx.diag.debug("skills.materialized", {
    runId,
    skills: list.map((s) => s.name),
    dropped: dropped.map((d) => d.name),
  });
  // Sent even when there is nothing to say: the run page waits on the report to tell "no repo
  // skills" from "none read yet", and the control plane takes one per run, so an empty one costs
  // a single request.
  if (ctx.skills?.spec !== undefined) {
    bestEffort(
      ctx.diag,
      "orchestrator.reportSkills.failed",
      { runId },
      () => ctx.orchestrator.reportSkills({ root, loaded, dropped: reportableDrops(dropped) }),
    );
  }
  const dir = root;
  return {
    list,
    remove: async () => {
      if (dir === null) return;
      await removeSkills(dir).catch((err) =>
        ctx.diag.warn("skills.cleanup_failed", { runId, err: String(err) })
      );
    },
  };
}

/**
 * Every service the checkout declares, by name, across its repos. The same name declared
 * twice is one service — hostnames are shared across the run — and the first declaration's
 * port stands; two repos disagreeing about a port were refused by the control plane before
 * this container existed, so here the first one is as good as any.
 */
export function unionDeclaredServices(
  perRepo: readonly (readonly DeclaredService[])[],
): DeclaredService[] {
  const byName = new Map<string, DeclaredService>();
  for (const declared of perRepo) {
    for (const service of declared) {
      if (!byName.has(service.name)) byName.set(service.name, service);
    }
  }
  return [...byName.values()];
}

/**
 * The brief as the agent reads it: the frozen text, plus — when the staleness check found
 * something — a section naming the claims whose evidence changed, so the agent verifies those
 * first rather than trusting them. The frozen text is never edited: the spec serves what the
 * run was told, and this only appends what the clone revealed.
 */
export function renderBrief(text: string, stale: StaleMemory[]): string {
  if (stale.length === 0) return text;
  const lines = stale.map((s) =>
    `- [${s.memoryId}] files it is evidence for changed since it was recorded: ${
      s.changedPaths.slice(0, 5).join(", ")
    }${s.changedPaths.length > 5 ? ", …" : ""}`
  );
  return [
    text,
    "",
    "### May be outdated",
    "The repository changed under these memories after they were recorded. Verify them before " +
    "relying on them, and refute or confirm them through the memory tools.",
    ...lines,
  ].join("\n");
}

/** A full commit SHA, SHA-1 or SHA-256. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What the checks tools answer on a run the platform runs no checks for. */
const NO_CHECKS = "The platform does not run checks for this run, so there is nothing to " +
  "request or read; verify with the repository's own commands instead.";

/** The most of an adoption failure a progress message carries; the trace has all of it. */
const ADOPT_REASON_MAX = 500;
/** The most of an invalid setup.yml's error a progress message quotes: its first line, which
 * names the file and the fault; the run's history and the agent get the whole (bounded) error. */
const SETUP_PROGRESS_MAX = 300;
/** The most one repo's shipping failure contributes to a run's error reason. */
const REASON_PER_REPO_MAX = 2_000;
/** The most any error reason carries — far under the control plane's limit on the field. */
const REASON_MAX = 16_000;
/** The longest summary the control plane accepts (its RunnerResultSchema). */
const SUMMARY_MAX = 100_000;

/** The default line's branch in a repo: the one the checkout starts on. */
function workBranch(repo: RepoEntry): string {
  return lineBranch(repo.branchNamespace, DEFAULT_LINE, 1);
}

function clipReason(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * What the run's summary says about a line finalize shipped as its next generation without it
 * being on what merged: the person approving it sees why its diff may repeat what already merged.
 * Worded to hold whether nobody rebased it or `onto` could not be found at the origin, so nobody
 * could.
 */
function unrebasedNote(path: string, line: string, unrebased: { onto: string }): string {
  const onto = inCode(unrebased.onto);
  return `Note: ${inCode(path)} (${inCode(line)}): its change request merged into ${onto}, and ` +
    `it was not rebased onto ${onto} (nobody did, or ${onto} could not be found at the origin ` +
    "any more); held for a person.";
}

/** ` (\`git switch <branch>\`)` where the name is plain (helpers/commands.ts), else nothing. */
function switchTo(branch: string): string {
  return isPlainRef(branch) ? ` (\`git switch ${branch}\`)` : "";
}

/** What the run's summary says about local branches that were never submitted, and so did not
 * ship: only the run's own branch and the branches a submit shipped do. */
function unsubmittedNote(
  path: string,
  left: ReadonlyArray<{ branch: string; commits: number }>,
): string {
  return `Note: ${inCode(path)} has ${left.length === 1 ? "a branch" : "branches"} with commits ` +
    `that ${left.length === 1 ? "was" : "were"} never submitted, so ${
      left.length === 1 ? "it was" : "they were"
    } not shipped: ${unsubmittedList(left)}. Only the run's own branch and the branches it ` +
    "submitted ship when it ends.";
}

/**
 * What the run's summary says about a line finalize did not ship at all (`withheld`): its commits
 * are still in the box, and the agent's account may claim them.
 */
function withheldNote(path: string, branch: string, why: string): string {
  return `Note: ${inCode(path)} was not shipped: ${clipReason(why, 300)}. Its commits stayed ` +
    `on ${inCode(branch)}, in the box.`;
}

/**
 * What the run's summary says about a line whose branch was gone at finalize (deleted or renamed
 * by the agent): nothing more of it shipped, and the agent's account may claim work that did.
 */
function goneNote(path: string, branch: string, gone: { shipped: boolean }): string {
  return `Note: ${inCode(path)}'s branch ${inCode(branch)} no longer existed when the run ended ` +
    (gone.shipped
      ? "(deleted or renamed), so nothing more of it shipped: its patch stands as last " +
        "submitted, and anything committed to it after that was not shipped."
      : "(deleted or renamed), so nothing of it shipped.");
}

/**
 * What the run's summary says about an operation finalize found stopped and left exactly as it
 * stood — said whatever the ship came to, since the agent's account was written before it and
 * would otherwise claim work that did not go out.
 */
export function abandonedNote(path: string, abandoned: LeftStopped): string {
  const conflicts = abandoned.conflicts.length === 0
    ? ""
    : ` (conflicts in ${
      abandoned.conflicts.slice(0, 5).map((p) => inCode(clipReason(p, 200))).join(", ")
    }${abandoned.conflicts.length > 5 ? ", …" : ""})`;
  const what = abandoned.step === "conflict"
    ? `resolving conflicts in ${inCode(path)}`
    : abandoned.step === "merge" && abandoned.target !== null
    ? `the merge of ${inCode(abandoned.target)} into ${inCode(path)}`
    : `the ${stoppedLabel(abandoned.step, abandoned.target)} in ${inCode(path)}`;
  const branch = {
    "shipped":
      `${inCode(path)} shipped its committed work as it stood; its uncommitted changes did ` +
      "not ship, the unfinished work included.",
    "nothing-new":
      `${inCode(path)} had no new commits of its own, so nothing more of it shipped, ` +
      "and its uncommitted changes, the unfinished work included, did not either.",
  }[abandoned.branch];
  const head = abandoned.headCommits
    ? " Commits that are not on the run's branch (on a detached HEAD or another branch) did " +
      "not ship either."
    : "";
  const opening = abandoned.step === "off-branch"
    ? `Note: ${
      inCode(path)
    } was not on its run's branch when the run ended, and was left as it stood.`
    : `Note: ${what} was not finished when the run ended${conflicts}, and was left as it stood.`;
  return `${opening} ${branch}${head}`;
}
