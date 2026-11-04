// Persistence, as the core sees it.
//
// The store is a dumb row-holder: every transition is decided in core/lifecycle.ts and handed
// here fully formed. Heartbeats update the Run row in place (a gauge); only transitions are
// appended as events — an adapter that persisted every heartbeat would be doing it wrong.

import type { RetargetArgs, Retargeted } from "../core/retarget.ts";
import type {
  Agent,
  Attachment,
  AutomationEventRecord,
  ChangeRequestMerge,
  ChatMentionRecord,
  CommandRoom,
  ConnectedRepo,
  ForgeEventRecord,
  ForgeProvider,
  ForgeToolAction,
  GithubInstallation,
  GitlabHookLane,
  GitlabProject,
  GitVirtualKey,
  OriginConversation,
  Patch,
  PatchFate,
  Phase,
  ProgressComment,
  RepoCommandAllowlistEntry,
  Response,
  Run,
  RunEvent,
  RunMessage,
  RunState,
  Task,
  Workspace,
  WorkspaceRepo,
} from "../core/types.ts";
import type { EgressAllowlist, EgressRefusal, EgressRefusalOutcome } from "../core/egress.ts";
import type { RepoAccess, Scope } from "../core/scope.ts";
import type { ReservedCapacity } from "../core/reserved_capacity.ts";
import type { LandOutcome, ReleaseOutcome } from "../core/landing.ts";

/**
 * How deep one page may go, whatever it asks for. A list is read by a browser drawing rows; a
 * caller that wants more pages for more.
 */
export const MAX_TASK_PAGE = 100;

/** The page size a caller gets for not asking. */
export const DEFAULT_TASK_PAGE = 50;

/**
 * The status buckets the task list filters on — the seven run states grouped the way a person
 * asks about them ("what's running", "what broke"), not the way the lifecycle spells them.
 * `errored` and `lost` are both "the system failed you", which is a different question from
 * "the agent failed the work" (`failed`), so they are kept apart.
 */
export const TASK_STATUS_BUCKETS = {
  live: ["starting", "running"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  broken: ["errored", "lost"],
  cancelled: ["cancelled"],
} as const satisfies Record<string, readonly RunState[]>;

export type TaskStatusBucket = keyof typeof TASK_STATUS_BUCKETS;

/**
 * The filters a task list may carry. Every one of them is an indexed column on `tasks` — which
 * is what the denormalized `current_run_*` columns bought — so a filtered page costs a range
 * scan that stops at `limit`, not a sort over everything that matched.
 *
 * Several filters AND together; several values WITHIN one filter OR together, which is what a
 * multi-select control means by picking two agents.
 */
export interface TaskListQuery {
  /** Rows to return, counted from the newest. Clamped to 1…`MAX_TASK_PAGE`. */
  limit?: number;
  /** The previous page's `nextCursor`: keep walking into older tasks from where it stopped. */
  cursor?: string;
  /** Free text over the task's TITLE, matched as whole words with the last one a prefix. */
  q?: string;
  /**
   * Only these tasks. Not a page of a list but a question about a handful of rows: "which of
   * these still match?" — which is what a live tail asks about the ids it just heard changed,
   * and it must ask it with the same predicate the page was built from, or the two can drift.
   */
  ids?: readonly string[];
  /** Include cancelled unprompted tasks for metadata resolution, never history membership. */
  includeAbandonedDrafts?: boolean;
  statuses?: readonly TaskStatusBucket[];
  agentIds?: readonly string[];
  origins?: readonly Task["origin"][];
  workspaceId?: string;
  /** Tasks whose frozen repo list holds this connected repo. */
  connectedRepoId?: string;
  /** Tasks this user asked for — the "mine" toggle. */
  requestedByUserId?: string;
  /** What the caller may see at all; absent reads as everything. See `core/scope.ts`. */
  scope?: Scope;
  /** ISO bounds on `createdAt`: `from` inclusive, `to` exclusive. */
  createdFrom?: string;
  createdTo?: string;
}

/**
 * A task with the attempt the list draws beside it. State/phase/activity are denormalized on
 * the task; the heartbeat-owned declaration is read from the current run in the same query.
 */
export interface TaskListRow {
  task: Task;
  currentRun: {
    id: string;
    state: RunState;
    phase: Phase | null;
    idleState?: "idle" | "waiting-for-user" | null;
    declaredOutcome?: Run["declaredOutcome"];
  };
  /** The run's `updatedAt` — when the task last moved, as opposed to when it was asked for. */
  lastActivityAt: string;
}

export interface TaskPage {
  /** Newest first. */
  tasks: TaskListRow[];
  /**
   * Opaque to every caller — pass it back as `cursor` for the next, older page. Null when this
   * page reached the oldest task the filters match.
   */
  nextCursor: string | null;
}

export interface PatchListQuery {
  limit?: number;
  cursor?: string;
  state?: Patch["state"];
  /** The patch's task must fall inside it; absent reads as everything. */
  scope?: Scope;
}

export interface PatchPage {
  patches: Patch[];
  nextCursor: string | null;
}

/**
 * A page size an adapter will honour: whole, at least one row, never past the cap.
 * (The same shape as the gateway's `clampUsageLimit` — a list's bound is not a suggestion.)
 */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_TASK_PAGE;
  return Math.min(MAX_TASK_PAGE, Math.max(1, Math.floor(limit)));
}

/**
 * A list cursor, as every adapter spells it: the `(createdAt, id)` of the row the previous page
 * stopped at, which is exactly the sort key. Keyset and not an offset, so page 200 costs what
 * page 1 costs, and a task created while someone is paging shifts nothing below it.
 *
 * Null for anything that is not one — a client's invention, a cursor from another deployment —
 * which reads as "start at the newest". Callers that care refuse a malformed cursor before this.
 */
export function decodeListCursor(
  cursor: string | undefined,
): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  // `<createdAt>|<id>`: ISO timestamps hold no pipe and ids are `<prefix>-<hex>`, so the first
  // separator is the only one.
  const cut = cursor.indexOf("|");
  if (cut <= 0 || cut === cursor.length - 1) return null;
  const createdAt = cursor.slice(0, cut);
  const id = cursor.slice(cut + 1);
  // A timestamp this did not issue would still be compared as text, which is harmless but
  // meaningless; refusing it is what lets a route answer 400 rather than a confusing page.
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

export function encodeListCursor(row: { createdAt: string; id: string }): string {
  return `${row.createdAt}|${row.id}`;
}

/** The forges whose change requests the merge poll can ask about: the two with a user mode,
 * which takes no webhooks (core/merge_poll.ts `polledProviders`). */
export type PolledProvider = "github" | "gitlab";

/** A change request the merge poll should ask about: its repo and ref, how many polls of it in
 * a row failed (0 when never asked) and how many of those found it gone, and whether any of its
 * patches still has no verdict (`open`) — false when all it has is a recent close. */
export interface MergePollDue {
  connectedRepoId: string;
  forgeRef: string;
  failures: number;
  gone: number;
  open: boolean;
  /** Whether it has a poll clock at all — false for one the poll never stamped. */
  asked: boolean;
}

/** The GitLab the merge poll asks about (`listChangeRequestsDueMergePoll`): the instance the
 * forge runs now, which a GitLab row must have been connected on, and whether it is in bot
 * mode. */
export interface MergePollGitlab {
  /** `RYPH_GITLAB_URL` as the forge normalized it (`GitlabMode.url`). */
  instance: string;
  bot: boolean;
}

/** When a change request is next polled, and its failure counts (`MergePollDue`). */
export interface MergePollClock {
  dueAt: string;
  failures: number;
  gone: number;
}

/** What `claimTaskPrompt` did. */
export type PromptClaim =
  | { kind: "claimed"; message: RunMessage }
  | { kind: "taken" }
  | { kind: "terminal"; state: RunState };

export interface TaskStore {
  createAgent(agent: Agent): Promise<void>;
  getAgent(id: string): Promise<Agent | null>;
  /** The command address's lookup (`/ryph <handle>`). Archived rows still resolve — the
   * caller decides what an archived agent means for its door. */
  getAgentByHandle(handle: string): Promise<Agent | null>;
  /** Newest first, archived included (they still anchor historical tasks). */
  listAgents(): Promise<Agent[]>;
  /** Exactly these agents — what a page of rows needs to show names, instead of the roster. */
  listAgentsByIds(ids: readonly string[]): Promise<Agent[]>;
  /** Full-row write keyed by agent.id — updates and archiving both land here. Every column but
   * `canOpenPatches` and `canPublishArtifacts` on an existing row: those move only through the
   * conditional writes below, so an edit saved from a stale read can never put a switched-off
   * agent back. */
  saveAgent(agent: Agent): Promise<void>;
  /** Moves the patch switch from `from` to `to`, only if it still reads `from`. False: it had
   * already moved (or the agent is gone), and nothing was written. */
  setAgentCanOpenPatches(id: string, from: boolean, to: boolean): Promise<boolean>;
  /** The artifact switch, the same way. */
  setAgentCanPublishArtifacts(id: string, from: boolean, to: boolean): Promise<boolean>;

  /**
   * Persists a task and its first run atomically — plus, when the run clones through the
   * forge gateway, the run's git virtual key (hash-only), so a run can never exist whose
   * credential the gateway would not recognize.
   *
   * With `maxLive`, the insert is refused as `"full"` once that many runs are live across the
   * deployment. The count is taken under a lock that serializes creators, for `claimNextBuild`'s
   * reason: no row lock can hold a count.
   *
   * With `attachments`, the images the run starts with (core/attachments.ts
   * `planRunAttachments`) are inserted in the same transaction: a run whose work item names an
   * image never exists without that image's row. Refused as `"full"`, nothing is written.
   */
  createTask(
    task: Task,
    run: Run,
    gitKey?: GitVirtualKey,
    opts?: { maxLive: number | null; attachments?: readonly Attachment[] },
  ): Promise<"created" | "full">;
  /** Null for an unknown id and for a task outside `scope` alike. */
  getTask(id: string, scope?: Scope): Promise<Task | null>;
  /**
   * A run checks a change request out mid-flight (core/retarget.ts): the pure `retarget` applied
   * to the run's and the task's rows as they stand, locked — the run's first, then the task's,
   * the order `landMerge` takes them in — and its narrow writes made in the same transaction.
   * The task's repos and target; the run's work item, forge scope and clock while it is live
   * (a run that ended during the forge round trip keeps the spec it ended with), and the list's
   * clock with it.
   *
   * Narrow, and over the locked rows rather than copies read before the forge round trip: the
   * task row also carries the current attempt's state, which is `saveRun`'s; the run may have
   * been cancelled, spoken to or concluded meanwhile; and a landing may have moved ANOTHER repo
   * of the task, which a list computed from an earlier read would put back. Answers what was
   * decided, or null when the task or the run is gone.
   *
   * The route's two refusals are asked again over the locked rows, and refuse with nothing
   * written: the task already works a change request in ANOTHER repo (one per run), or the run
   * already has a patch for this repo (its checkout can no longer move). A patch's birth takes
   * the run's row in share mode (`createPatch`), so the second answer cannot go stale before the
   * commit.
   */
  applyRetarget(
    args: Omit<RetargetArgs, "task" | "run"> & { taskId: string; runId: string },
  ): Promise<Retargeted | { kind: "refused"; why: "other-change-request" | "shipped" } | null>;
  /**
   * A patch of this task merged: land it (core/landing.ts). Answers what was decided; the merged
   * cue's `onto` is read from the task's landings afterwards, whoever wrote them.
   *
   * One transaction, under the run's row lock and then the task's (the order `saveRun` takes
   * them in), so of two deliveries of one merge the second reads what the first wrote. The
   * decision is the core's pure function, applied to the locked rows. What it writes, all or
   * nothing: the task's repos, target and landings; the run's work item and clock while the run
   * is live (a terminal run's task moves alone); the task list's activity clock; and the run
   * event. A redelivery, a concurrent delivery, or a late merge of an older generation writes
   * nothing.
   *
   * Whatever it decides, the patch's `landingAskedAt` is set in the same transaction (while it is
   * merged or missed and unset): its landing was asked and answered, and the landing reconcile
   * (`listPatchesAwaitingLanding`) never asks it again. A landing that throws leaves it unset.
   */
  landMerge(args: {
    patch: Pick<
      Patch,
      "id" | "taskId" | "runId" | "connectedRepoId" | "path" | "line" | "forgeRef" | "generation"
    >;
    /** `LandArgs.mergedInto`. */
    mergedInto: string | undefined;
    defaultBranch: string;
    /** `LandArgs.intoTip`. */
    intoTip?: string;
    at: string;
  }): Promise<{ outcome: LandOutcome }>;
  /**
   * Narrow write, and a compare-and-set: the task's title becomes `to` only while it is still
   * `from` — the fallback a generated title replaces (core/titles.ts), so a title anyone wrote
   * in between is never overwritten. Answers whether it moved.
   */
  retitleTask(taskId: string, from: string, to: string): Promise<boolean>;
  /**
   * The first message to a run whose task awaits its prompt (core/prompt.ts), as ONE step: the
   * task's instructions and title are set — only while it still has no instructions, which is
   * what makes two first messages race safely — the run's work item takes the same spec and the
   * message's images (so a re-run and the spec read see them), and the message is appended,
   * claiming its images, exactly as `appendRunMessage` does — followed by any release cue the run
   * was owed while it waited (`RepoLanding.releaseCueOwed`, cleared). `taken`: the task was not
   * awaiting its prompt (another message got there first) — the caller posts the message as an
   * ordinary one. `terminal`: the run ended before the claim (it idled out after the caller read it), so
   * nobody would ever read the prompt. On either, NOTHING was written.
   */
  claimTaskPrompt(
    prompt: { taskId: string; instructions: string; title: string },
    message: Omit<RunMessage, "seq">,
  ): Promise<PromptClaim>;
  /**
   * One page of the task list: newest first, filtered, with each task's current run already on
   * it. BOUNDED — there is no "every task" read, by design. The list grows for as long as the
   * deployment is used, and the handler that reads it whole is the one that gets slower every
   * day it works.
   *
   * Cancelled tasks that never received instructions are excluded, even by ids or status,
   * unless includeAbandonedDrafts is set for metadata resolution. Scope still applies.
   * Direct task/run reads and listTasksByIds retain them for diagnostics and internal callers.
   */
  listTasks(query?: TaskListQuery): Promise<TaskPage>;
  /**
   * Exactly these tasks, in the order the list would show them — what a page holding a handful
   * of ids (a usage report's top tasks) asks instead of reading the table to title twenty rows.
   * Ids that resolve to nothing are simply absent.
   */
  listTasksByIds(ids: readonly string[]): Promise<TaskListRow[]>;
  /** Oldest first — the last element is the current attempt. */
  runsForTask(taskId: string): Promise<Run[]>;
  /** Exactly these runs; ids that resolve to nothing are absent. A page's worth, not a scan. */
  listRunsByIds(ids: readonly string[]): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  /** One per run: a second save for the same run throws, since a run launches once. */
  saveBootstrap(runId: string, tokenHash: string, sealed: string, expiresAt: string): Promise<void>;
  /** A matching, unexpired bootstrap's sealed bundle, left in place; null when nothing matched.
   * Read so the bundle is opened before `consumeBootstrap` spends it. */
  readBootstrap(runId: string, tokenHash: string, now: string): Promise<string | null>;
  /** Atomically consumes a matching, unexpired bootstrap: its sealed bundle, or null when
   * nothing matched. Never accepts a run bearer. */
  consumeBootstrap(runId: string, tokenHash: string, now: string): Promise<string | null>;
  /** A launch that failed: its bootstrap can never be redeemed, so nothing should keep it. */
  deleteBootstrap(runId: string): Promise<void>;
  /** The reaper's: drops every unredeemed bootstrap past its expiry. */
  deleteExpiredBootstraps(now: string): Promise<void>;
  /** Creates a run. An existing id is an error: lifecycle updates must use conditional writes. */
  saveRun(run: Run): Promise<void>;
  /** Writes only state/environmentWait/updatedAt, while the live row still matches the
   * lifecycle snapshot (state, heartbeat, cancellation, launch and idle clock). Returns the
   * stored row, or null when refused: then the caller must not emit events or conclude the run. */
  saveRunTransition(run: Run, expected: Run): Promise<Run | null>;
  /** First report wins, on a live or lost run with no result. Writes only state/result/time,
   * preserving concurrent beats, cancellation and other writers' fields. Returns the stored
   * row, or null when refused. A late report may recover lost, but no other terminal state. */
  saveRunResult(run: Run): Promise<Run | null>;
  /** Narrow, monotonic cancellation intent on a live run. The optional guard is the reaper's
   * idle backstop: refused once a beat has moved the idle deadline. Heartbeats alone never
   * refuse it — wall-clock and spend do not depend on them. Refusal writes nothing. */
  requestRunCancel(runId: string, at: string, guard?: { idleDeadlineAt: string | null }): Promise<{
    run: Run | null;
    applied: boolean;
  }>;
  /** Records a successfully provisioned container without restoring any lifecycle snapshot.
   * A live run's activity clock moves with it; a terminal row's does not. Also allowed on a
   * terminal row so runtime cleanup can find the late container. */
  recordRunLaunch(runId: string, handle: Run["handle"], launchedAt: string): Promise<Run | null>;
  /**
   * A heartbeat's write: ONLY the columns a beat moves (state, phase, heartbeat_seq,
   * last_heartbeat_at, idle_deadline_at, updated_at) and the task's copy of the
   * current attempt, in one statement — and only while the stored run is still live and the beat
   * is newer than the last one applied. Null when that condition failed and nothing was written;
   * otherwise the stored `desiredState`, so a cancel requested since the caller's read rides the
   * answer to this very beat.
   *
   * Not `saveRun`, for three reasons measured or found under load: a full-row upsert rewrites
   * every jsonb snapshot on every beat, it costs a transaction of round trips on a two-connection
   * pool that every live run beats through, and it writes back whatever the handler READ — so a
   * cancel requested, or a conclusion reached, between the read and the write was undone.
   */
  saveHeartbeat(run: Run): Promise<{ desiredState: Run["desiredState"] } | null>;
  /**
   * The waiting run's compare-and-set: writes `run` only while the STORED row is still a
   * `starting` run with no container, waiting on `environmentId`, and answers whether it landed.
   * Everything that moves a waiting run — the build's settle hook, the reaper's backstop,
   * startTask's catch-up, a cancel — writes through this, so of two that read the same waiting
   * run only one launches it, and a cancel is never written back to `starting`.
   */
  saveRunIfWaiting(run: Run, environmentId: string): Promise<boolean>;
  /**
   * The launching run's compare-and-set: writes `run` only while the STORED row is still a
   * `starting` run with no container, waiting on no build, and with no cancel asked for, and
   * answers whether it landed. A launch takes seconds; what it writes afterwards goes through
   * this, so a cancel that landed meanwhile is never written back over.
   */
  saveRunIfUnlaunched(run: Run): Promise<boolean>;
  /**
   * Narrow write: flips a live run to attended and nothing else. A full-row write cannot serve
   * here — the caller's copy was read before the runner's terminal result (or its latest
   * heartbeat) landed, and putting it back would restore `state`/`result`/`idleDeadlineAt` from
   * a run that is already over. `flipped` says whether THIS caller's write is the one that
   * flipped it, so the event is appended once; `run` is the row AS STORED after.
   */
  markRunAttended(runId: string, at: string): Promise<{ run: Run | null; flipped: boolean }>;
  /**
   * Narrow write: appends one host the egress proxy refused this run, and says what happened.
   *
   * Narrow for `markRunAttended`'s reason and one more. The reason it shares: a report lands
   * while the run is mid-setup, so a full-row write would put back a run read before the
   * heartbeat, the phase change or the terminal result that arrived in between. The reason of
   * its own: two reports can race, and the append has to be a read-modify-write under a lock on
   * the run or one of them is lost.
   *
   * `duplicate` is a host already recorded, or a run already holding `MAX_EGRESS_REFUSALS` —
   * either way there is nothing to write and no event to append. `ended` is a run that is
   * terminal or is not here at all, which is the answer that tells the proxy to stop reporting
   * for that claim. The rule itself is core's (`appendRefusal`); this is only where it is
   * applied atomically.
   */
  recordRunEgressRefusal(
    runId: string,
    refusal: EgressRefusal,
  ): Promise<EgressRefusalOutcome>;
  /** Every non-terminal run — the reaper's working set. */
  listActiveRuns(): Promise<Run[]>;
  /** How many runs are non-terminal, the door's read of `RYPH_RUN_CONCURRENCY`. */
  countActiveRuns(): Promise<number>;
  /**
   * The non-terminal run started from this conversation — a forge thread or a chat thread — if
   * one is still going; newest first, so a conversation that somehow holds two answers with the
   * live one the follow-up should reach. This is what makes a second command in a thread a
   * decision rather than a race: the same agent joins the run, another agent is refused, and
   * nobody else pushes onto its branch.
   */
  findLiveRunByOrigin(origin: OriginConversation): Promise<Run | null>;
  /**
   * The non-terminal run working this change request, however it came to work it: one commanded
   * from the thread (the origin columns, as above), one whose TASK targets it — which now
   * includes a run that checked the change request out mid-flight, whose origin is still the
   * conversation it was commanded from — or one that OPENED it, a patch of that run carrying
   * the change request as its `forgeRef` (landed or not). Asked in that order.
   *
   * All three readings, because the thing being protected is the BRANCH: two runs pushing onto one
   * change request race at the submit sweep, and the loser's push is rejected terminally while
   * its thread still reads as a success. Newest first, like `findLiveRunByOrigin`.
   */
  findLiveRunOnChangeRequest(connectedRepoId: string, thread: string): Promise<Run | null>;
  /** How many runs were started from this chatroom's mentions at or after `since` — whatever
   * became of them. The command room's rate limit. */
  countRunsStartedFromChatroom(chatroomId: string, since: string): Promise<number>;
  appendEvent(event: RunEvent): Promise<void>;
  /** In insertion order. */
  listEvents(runId: string): Promise<RunEvent[]>;
  /** Tests for one event kind without loading the run's transcript. */
  hasRunEvent(runId: string, kind: RunEvent["kind"]): Promise<boolean>;
  /**
   * Reserves one of a run's model-credential slots atomically: counts the model-credential
   * events already on the trail (the mcp half is its own, uncapped, kind of event and is not
   * counted) and, under a lock on the run, appends this one only if that count is still under
   * `max` — closing the window two concurrent boot-credential requests would otherwise race in,
   * both reading the same count before either's append lands. Mints nothing itself: the caller
   * reserves first, mints only once reserved, and undoes the reservation with
   * `releaseCredentialSlot` if the mint that was supposed to follow it fails.
   */
  reserveCredentialSlot(
    runId: string,
    event: Pick<RunEvent, "at" | "detail">,
    max: number,
  ): Promise<
    { reserved: true; issued: number; seq: number } | { reserved: false; issued: number }
  >;
  /** Undoes a reservation `reserveCredentialSlot` made whose mint then failed: the slot is
   * given back rather than charged against a credential the run was never issued. */
  releaseCredentialSlot(runId: string, seq: number): Promise<void>;

  /**
   * Records the runner's skills report, once per run: claims the run's `skillsReportedAt` (only
   * while it is still null) and appends `events` in the same step, all at `at`. Answers whether
   * this report was the one that landed — false when the run already has a report, and then
   * nothing is appended. Atomic, so two reports racing for one run cannot both land.
   */
  recordSkillsReport(
    runId: string,
    at: string,
    events: Pick<RunEvent, "kind" | "detail">[],
  ): Promise<boolean>;

  /**
   * Appends to a run's inbox, taking the next `seq` for that run atomically — the unique
   * `(run_id, seq)` index is the rule, and the implementation must read the last seq and insert
   * under a lock on the run (or retry the insert), never in two unrelated statements. Answers
   * the message as stored, seq included.
   *
   * The message's `attachments` are CLAIMED in the same transaction: each must be this run's
   * and unclaimed, and becomes claimed by this message's id. If any is not, nothing is written
   * and `AttachmentClaimConflict` (core/attachments.ts) is thrown — two messages racing for one
   * image cannot both carry it.
   */
  appendRunMessage(message: Omit<RunMessage, "seq">): Promise<RunMessage>;
  /**
   * Records one stored image (core/attachments.ts) — its bytes are already in the store — but
   * only while the run holds fewer than `maxUnclaimed` unclaimed rows, and answers whether it
   * did. The count and the insert are ONE step under a lock on the run, never two statements:
   * uploads racing for the last free slots must not all read the same count and all be written.
   */
  createUnclaimedAttachment(attachment: Attachment, maxUnclaimed: number): Promise<boolean>;
  /**
   * Records one image the run's own agent got back from a tool, ALREADY claimed (its bytes are
   * already in the store) — but only while the run holds fewer than `limits.maxCount` rows of
   * source `agent` AND those rows' bytes plus this one's stay within `limits.maxBytes`, and
   * answers whether it did. Count, sum and insert are one step under a lock on the run, as
   * `createUnclaimedAttachment`'s are. A row of the run with the same `ref` already there is the
   * answer instead (`existing`), nothing written and no limit counted: the same image twice is
   * one image.
   */
  createAgentAttachment(
    attachment: Attachment,
    limits: { maxCount: number; maxBytes: number },
  ): Promise<{ kind: "created" } | { kind: "full" } | { kind: "existing"; attachment: Attachment }>;
  /** How many images of source `agent` the run keeps, and their bytes summed — what the agent
   * door's budget counts. A read without the lock: the door's cheap first look, never the rule. */
  agentAttachmentUsage(runId: string): Promise<{ count: number; bytes: number }>;
  /** The run's own tool images (`source: "agent"`) among `refs`, in no particular order. */
  agentAttachmentsByRefs(runId: string, refs: readonly string[]): Promise<Attachment[]>;
  getAttachment(id: string): Promise<Attachment | null>;
  /** The attachments among `ids` that exist, in no particular order. */
  listAttachmentsByIds(ids: readonly string[]): Promise<Attachment[]>;
  /** How many of the run's uploads no message has carried yet — what the per-run cap counts. */
  countUnclaimedAttachments(runId: string): Promise<number>;
  /**
   * Deletes the row of `id` only if it is `runId`'s and still unclaimed, in ONE conditional
   * statement — the WHERE is the rule, so a message claiming it in the same instant either wins
   * (nothing deleted) or loses its claim. Answers the deleted row, or null when nothing matched.
   */
  deleteUnclaimedAttachment(runId: string, id: string): Promise<Attachment | null>;
  /** Unclaimed attachments created before `before`, oldest first, at most `limit` — the
   * reaper's retention read. BOUNDED, and served by a partial index over unclaimed rows. */
  listUnclaimedAttachmentsBefore(before: string, limit: number): Promise<Attachment[]>;
  /**
   * A run's messages past `afterSeq`, seq ascending, at most `limit` (default 100) — the
   * runner's poll. BOUNDED: a long-lived run's backlog grows without end and every message
   * may be 16 KB, so an unbounded answer is one the runner has to swallow whole. The `after`
   * cursor already makes paging natural — a short batch is simply the next poll's problem.
   */
  listRunMessages(runId: string, afterSeq?: number, limit?: number): Promise<RunMessage[]>;
  /**
   * The NEWEST `limit` messages of a run, seq ascending — what a detail view embeds. A task's
   * JSON body must not grow with the whole conversation of every run of that task.
   */
  listRecentRunMessages(runId: string, limit: number): Promise<RunMessage[]>;
  /** Stamps `deliveredAt` on every message of the run up to `uptoSeq` that has none — the
   * runner's next poll is the acknowledgement of the batch before it. */
  markRunMessagesDelivered(runId: string, uptoSeq: number, at: string): Promise<void>;

  /**
   * Opens a response, or answers false when this automation already has one that is not closed
   * for the same `key` — the partial unique index decides, because the door's read-then-write
   * cannot: two fires for one slot arriving together both find none open. The loser must not go
   * on as if it opened one.
   */
  createResponse(response: Response): Promise<boolean>;
  getResponse(id: string): Promise<Response | null>;
  /**
   * Narrow write: stamps activity on a response that is NOT closed, and — when a person spoke —
   * moves it to "attended". Conditioned on the stored state rather than written whole from a
   * caller's copy, because a message in flight while someone clicks Close would otherwise
   * resurrect a closed response to open with `closedAt: null`.
   */
  markResponseActivity(responseId: string, at: string, spoken: boolean): Promise<void>;
  /** Narrow write: records a fire that joined a response still open — the counter and the
   * two clocks, never the state a racing close just settled. */
  recordResponseAlert(responseId: string, alerts: number, at: string): Promise<void>;
  /**
   * Narrow write: closes a response that is not closed yet, with the reason. Answers whether
   * this caller's write is the one that closed it — false means it was closed already, and the
   * reason standing is whoever got there first (a person's beats the run's state).
   */
  closeResponse(responseId: string, at: string, reason: string): Promise<boolean>;
  /** The automation's response for the slot `key` that is not yet closed, if any — the door's
   * join/open fork. */
  findOpenResponse(automationId: string, key: string): Promise<Response | null>;
  /** The response a run is the attempt at, if any. */
  findResponseByRun(runId: string): Promise<Response | null>;
  /** The automation's newest `limit` responses opened SHARED (`Response.conversation`), other
   * than `exceptId`, in any state, newest first — the ones a response sharing its automation's
   * conversation continues from. */
  listSharedResponses(automationId: string, exceptId: string, limit: number): Promise<Response[]>;
  /** Newest first, at most `limit` (default 50) — every response ever opened is not a page. */
  /** Newest first, only those whose task falls inside `scope`. */
  listResponses(limit?: number, scope?: Scope): Promise<Response[]>;
  /** Every response not yet closed — the reaper's working set for responses stranded on a
   * terminal run (the conclusion's close is best-effort and can be lost to a crash). */
  listOpenResponses(): Promise<Response[]>;

  /** A run's git key minted after the run was created — a run that waited for its environment
   * is given its credential only when it launches. */
  createGitKey(key: GitVirtualKey): Promise<void>;
  /** The forge gateway's per-request lookup: the presented token, hashed. */
  getGitKeyByTokenHash(tokenHash: string): Promise<GitVirtualKey | null>;
  /** Stamps revokedAt on every live git key of a run — the run concluded, its credential dies. */
  revokeGitKeysForRun(runId: string, at: string): Promise<void>;

  /** Idempotent on installationId: re-landing the install flow updates, never duplicates. */
  saveInstallation(installation: GithubInstallation): Promise<void>;
  getInstallationByInstallationId(installationId: string): Promise<GithubInstallation | null>;
  /** Newest first. */
  listInstallations(): Promise<GithubInstallation[]>;

  createConnectedRepo(repo: ConnectedRepo): Promise<void>;
  getConnectedRepo(id: string): Promise<ConnectedRepo | null>;
  /** Newest first, archived included (they still anchor historical tasks and patches). */
  listConnectedRepos(): Promise<ConnectedRepo[]>;
  /** Full-row write keyed by repo.id — policy edits and archiving both land here. */
  saveConnectedRepo(repo: ConnectedRepo): Promise<void>;

  /** Records memory's acknowledgement of a run's outcome — the only write of that column. */
  markRunMemoryOutcomeReported(runId: string, at: string): Promise<void>;
  /**
   * Terminal runs whose outcome memory never acknowledged, last updated before `before` — the
   * margin keeps the sweep off a run whose result is still being handled — oldest first, at
   * most `limit`.
   */
  listRunsAwaitingMemoryOutcome(before: string, limit: number): Promise<Run[]>;

  createWorkspace(workspace: Workspace): Promise<void>;
  getWorkspace(id: string): Promise<Workspace | null>;
  /** Newest first, archived included (they still anchor historical tasks). */
  listWorkspaces(): Promise<Workspace[]>;
  /**
   * Writes a live workspace's name, description, size class and environment repo, and nothing
   * else — never a whole row read earlier, which would put back whatever changed in between (an
   * archive, a scrubbed description). False when the workspace is archived or gone, and then
   * nothing is written.
   */
  updateWorkspace(
    id: string,
    fields: Pick<
      Workspace,
      "name" | "description" | "sizeClass" | "environmentRepoId" | "updatedAt"
    >,
  ): Promise<boolean>;
  /** Bumps `updatedAt` alone — what a member change says about its workspace. */
  touchWorkspace(id: string, at: string): Promise<void>;
  /**
   * Archives the workspace and releases every member, as one unit: a repo left bound to an
   * archived workspace could neither run alone nor join another. Idempotent, and it FINISHES
   * the job on a repeat — an already-archived workspace keeps its `archivedAt`, and any member
   * still bound is released. Null when there is no such workspace.
   */
  archiveWorkspace(id: string, at: string): Promise<Workspace | null>;
  /** The members of one workspace, in the order they were added. */
  listWorkspaceRepos(workspaceId: string): Promise<WorkspaceRepo[]>;
  /** The one workspace holding this connected repo, if any — a repo belongs to at most one,
   * which is what makes the forge's expansion of a command a question with one answer. */
  findWorkspaceRepo(connectedRepoId: string): Promise<WorkspaceRepo | null>;
  /**
   * Adds a member, deciding every rule against the workspace as it stands at the write, not as
   * the caller read it: `archived` (it was archived meanwhile), `full` (it already holds
   * `maxMembers`), `taken` (the repo belongs to a workspace — the unique index on
   * `connected_repo_id`). Concurrent adds and archives are serialized on the workspace, so no
   * interleaving lands a member on an archived workspace or a member past the cap. A raced
   * duplicate PATH throws, as the (workspace, path) index does, so the caller can name it.
   */
  addWorkspaceRepo(
    repo: WorkspaceRepo,
    maxMembers: number,
  ): Promise<"added" | "archived" | "full" | "taken">;
  /** Full-row write keyed by (workspaceId, connectedRepoId) — ref, path and description edits. */
  saveWorkspaceRepo(repo: WorkspaceRepo): Promise<void>;
  removeWorkspaceRepo(workspaceId: string, connectedRepoId: string): Promise<void>;

  /**
   * Records a connected GitLab project's id on `instance`, its webhook at a generation above
   * every one any earlier connection of the same project id held — on any instance, since the
   * token derivation names no instance — (so an old token never verifies again), and no delivery
   * yet. Answers the row written.
   */
  createGitlabProject(
    connectedRepoId: string,
    projectId: string,
    instance: string,
    at: string,
  ): Promise<GitlabProject>;
  getGitlabProject(connectedRepoId: string): Promise<GitlabProject | null>;
  /** Every connected repo's row for that GitLab project id, archived ones' included, on EVERY
   * instance: the caller keeps only the current instance's (`GitlabProject.instance`). */
  listGitlabProjectsById(projectId: string): Promise<GitlabProject[]>;
  /** Moves the webhook to its next generation, in one statement — the old token is refused
   * from then on — and forgets the last delivery and the drops, which were the old token's.
   * Null when the repo has no row. */
  rotateGitlabHook(connectedRepoId: string, at: string): Promise<GitlabProject | null>;
  /** Stamps `lastHookAt` — and, for a Merge Request Hook (`mergeRequest`),
   * `lastMergeRequestHookAt` — with `at` unless it is already at or after `notBefore` — the arrival
   * write is at most one per window, not one per delivery. */
  recordGitlabHookDelivery(
    connectedRepoId: string,
    at: string,
    notBefore: string,
    mergeRequest: boolean,
  ): Promise<void>;
  /** Adds `count` to the deliveries dropped over the `lane` budget (`droppedCommentHookCount`
   * for comments, `droppedOtherHookCount` for every other event) and stamps `lastDroppedHookAt` with
   * `at`, in one statement. */
  recordGitlabHookDrops(
    connectedRepoId: string,
    lane: GitlabHookLane,
    count: number,
    at: string,
  ): Promise<void>;

  /** Who, beside the forge's own write holders, may command agents in this repo. Admin-gated
   * at the HTTP surface, and read on the `/ryph` path where the forge has no write tier. */
  listRepoCommandAllowlist(connectedRepoId: string): Promise<RepoCommandAllowlistEntry[]>;
  /** Upsert keyed by (connectedRepoId, provider, subject) — adding twice is adding once. */
  addRepoCommandAllowlistEntry(entry: RepoCommandAllowlistEntry): Promise<void>;
  removeRepoCommandAllowlistEntry(
    connectedRepoId: string,
    provider: ForgeProvider,
    subject: string,
  ): Promise<void>;

  /**
   * The side-effect gate for one inbound delivery: inserts the record, or answers false if
   * this delivery id already has one — in one statement, so two concurrent handlers cannot
   * both win. The caller that loses must not act.
   *
   * `reclaimProcessingBefore` is the crash escape: a handler that died after claiming leaves
   * its row stuck at "processing", and a plain dedupe would then swallow every redelivery of
   * a command nothing ever acted on. When given, a redelivery may ADOPT a "processing" claim
   * older than this cutoff (conditionally, so two adopters cannot both win). Completed
   * outcomes are never adopted — done is done.
   */
  claimForgeEvent(record: ForgeEventRecord, reclaimProcessingBefore?: string): Promise<boolean>;
  /** Upsert keyed by deliveryId — records (or finalizes) how a delivery's handling ended. */
  recordForgeEvent(record: ForgeEventRecord): Promise<void>;
  /** The delivery's record, or null when none was written — the read a handler asks before it
   * spends a forge call on a delivery that may be decided already. */
  getForgeEvent(deliveryId: string): Promise<ForgeEventRecord | null>;

  /** As `claimForgeEvent`, for automation fires — keyed by eventId, same crash escape. */
  claimAutomationEvent(
    record: AutomationEventRecord,
    reclaimProcessingBefore?: string,
  ): Promise<boolean>;
  /** As `recordForgeEvent`, keyed by eventId — but a settled verdict is FINAL: the conflict
   * update applies only while the stored row is still "processing". */
  recordAutomationEvent(record: AutomationEventRecord): Promise<void>;
  /** Drops a "processing" claim this handler still holds (matched on `claimedAt`), so the next
   * redelivery runs the ladder at once instead of waiting out the reclaim window. A row that
   * settled, or a claim another handler adopted since, is left alone. */
  releaseAutomationEvent(eventId: string, claimedAt: string): Promise<void>;
  /** The recorded handling of one fire, or null for an eventId never seen. */
  getAutomationEvent(eventId: string): Promise<AutomationEventRecord | null>;

  /** A chatroom's command policy with its channel rows, or null — a response room. */
  getCommandRoom(chatroomId: string): Promise<CommandRoom | null>;
  /** Upsert keyed by chatroomId, the channel rows REPLACED with the room's own, as one unit:
   * a reader never sees a policy beside another version's channels. `createdAt` survives. */
  saveCommandRoom(room: CommandRoom): Promise<void>;
  /** Removes the policy and its channels; false when there was none. */
  deleteCommandRoom(chatroomId: string): Promise<boolean>;

  /** As `claimForgeEvent`, for chat mentions — keyed by (chatroomId, messageId), same crash
   * escape. */
  claimChatMention(record: ChatMentionRecord, reclaimProcessingBefore?: string): Promise<boolean>;
  /** Finalizes a claimed mention's verdict — only while the stored row is still "processing",
   * as `recordAutomationEvent` does: a verdict, once recorded, is final. */
  recordChatMention(record: ChatMentionRecord): Promise<void>;

  /** Upsert keyed by runId. */
  saveProgressComment(comment: ProgressComment): Promise<void>;
  /** The progress sweep's working set: rows not yet concluded. */
  listOpenProgressComments(): Promise<ProgressComment[]>;

  /**
   * Records a forge write about to be made — unless the run already holds `max` actions of the
   * same tool, in which case nothing is written and the answer is false. Counted and inserted
   * under a lock on the run, so two writes racing for the last slot cannot both take it: a cap
   * that holds only without concurrency is exactly the one the model loop defeats.
   */
  reserveForgeToolAction(action: ForgeToolAction, max: number): Promise<boolean>;
  /**
   * Settles a reserved action — false when there is no such action for that run still
   * `reserved` (unknown, another run's, or already settled), so a completion can never rewrite
   * a verdict or reach across runs.
   */
  completeForgeToolAction(
    id: string,
    runId: string,
    outcome: Pick<
      ForgeToolAction,
      "state" | "url" | "createdThreadRef" | "detail" | "completedAt"
    >,
  ): Promise<boolean>;
  /** A run's forge actions, oldest first — the trail, and the issues the run opened. */
  listForgeToolActions(runId: string): Promise<ForgeToolAction[]>;

  /** Inserts a patch, holding its run's row in share mode meanwhile: a re-target deciding over
   * the locked run (`applyRetarget`) sees every patch born before it, or none born after.
   * With `maxLinesPerRepo`, the run's row is held exclusively instead, and a patch of a line the
   * run has no patch of yet in that repo and path is written only while the run has fewer lines
   * there than that: the line cap's race-free half (core/open_patch.ts). Answers whether the row
   * was written. */
  createPatch(patch: Patch, opts?: { maxLinesPerRepo?: number }): Promise<boolean>;
  getPatch(id: string): Promise<Patch | null>;
  /** Exactly these patches; ids that resolve to nothing are absent. A page's worth, not a scan. */
  listPatchesByIds(ids: readonly string[]): Promise<Patch[]>;
  /** Full-row write keyed by patch.id, unconditional — marks included. Nothing in the control
   * plane writes a patch this way any more: every write there can race a settle, a retirement, a
   * hold or a person, and goes through `savePatchIfState` or one of the narrow writes below.
   * Kept for fixtures and repairs that set a row exactly. */
  savePatch(patch: Patch): Promise<void>;
  /**
   * A forge's verdict on a submitted patch, written only over the verdict the caller read:
   * `landed` (and the memory acknowledgement and merge cue it clears, whether its landing is
   * owed — `landingAskedAt` — and the clock) set from `patch`, while the stored row is still
   * `submitted` and its `landed` is still `from` (null, or a verdict being revised: see
   * `settlePatch`), together with `events` in the same transaction. Answers whether it landed:
   * of two deliveries of one verdict, only one writes it, and a caller that lost reads the row
   * again (a merge may still revise the verdict that won). With `unlessMergeRecorded`, written
   * only while no merge record exists for the patch's change request at the write: a close never
   * settles a patch a merge recorded meanwhile still owes its verdict.
   */
  settlePatchIf(
    patch: Patch,
    from: PatchFate["kind"] | null,
    events: RunEvent[],
    opts?: { unlessMergeRecorded?: boolean },
  ): Promise<boolean>;
  /**
   * A `missed` verdict nobody could prove (`PatchFate.unproven`), proven since by a merge that
   * judged it again: the flag is dropped, and nothing else of the row moves — its landing, cue
   * and memory report already went by the verdict, which is the same. Answers whether it wrote.
   */
  markMissedProven(patchId: string, at: string): Promise<boolean>;
  /**
   * Claims the right to post a merged patch's cue: answers true for exactly one caller while the
   * cue is unposted and nobody holds a claim newer than `staleBefore`. Writes nothing else, and
   * does not bump the version.
   */
  claimMergedCue(patchId: string, at: string, staleBefore: string): Promise<boolean>;
  /**
   * Marks a merged (or missed) patch's cue as done — posted, or nobody left to tell — once, and
   * only while the patch still holds the verdict the caller cued (`read.kind`) and, when the
   * caller claimed the cue, still that claim (`read.claimedAt`): a revision (missed → merged)
   * clears both, and the late mark of the note it replaced must not swallow the cue it owes.
   * False when it was not written.
   */
  markPatchMergedCued(
    patchId: string,
    at: string,
    read: { kind: "merged" | "missed"; claimedAt?: string },
  ): Promise<boolean>;
  /**
   * Marks up to `limit` unmarked merge cues (merged or missed) whose run is no longer live (or is gone), oldest
   * first, in one statement: a terminal run never comes back to hear one. The outbox's backstop
   * for a run that ended after its merge, so the partial index holds only what live runs are owed.
   * A live run's cue is never touched. Answers how many it marked.
   */
  markMergedCuesOfEndedRuns(limit: number, at: string): Promise<number>;
  /**
   * Memory acknowledged `fate` for this patch: sets `memory_fate_reported_at` and nothing else,
   * and only while the row is still in the state and verdict the report was about — a whole-row
   * write here would put back a copy read before a concurrent retirement, link or settle.
   */
  markPatchFateReported(
    patch: Pick<Patch, "id" | "state" | "landed">,
    at: string,
  ): Promise<void>;
  /**
   * The submit lease's compare-and-set: writes `patch` only while the STORED row is still in one
   * of `expected`, and answers the row's new version when it landed, null when it did not. Null
   * means another writer got there first and this caller must NOT go on to deliver.
   *
   * It writes what the patch IS, never the marks that have their own narrow writers: memory's
   * acknowledgement and the merged cue's claim and mark are left as they are.
   *
   * `savePatch` cannot serve here. The sweep iterates a snapshot taken at the top of the tick and
   * `markSubmitting` checks THAT COPY's state, so two submitters can both read a patch as
   * `queued`, both get "applied" from the pure transition, and both open a PR. Only a write
   * conditioned on the stored state can decide between them — which is what makes the lease the
   * lifecycle docs describe actually hold.
   *
   * `lease`, when given, narrows the claim further to the one submitter holding that exact lease:
   * a sweep handing a patch back must not write over a claim another sweep took since.
   *
   * `readVersion`, when given, narrows it to the row exactly as the caller read it
   * (`Patch.version`): a person's decision, or the landing rule's, must not write over a hold, a
   * supersession, a hook check or an approval that landed between the read and the write — the
   * state alone can be the same before and after. Every write but the cue's and memory's
   * acknowledgements bumps the version.
   *
   * `events` are written in the same transaction, only when the patch is: a transition and its
   * trail land together or not at all.
   */
  savePatchIfState(
    patch: Patch,
    expected: readonly Patch["state"][],
    lease?: string,
    readVersion?: number,
    events?: readonly RunEvent[],
  ): Promise<number | null>;
  /**
   * Merged or missed patches whose run was never told (`mergedCuedAt` null) and is still live to hear it,
   * whose cue nobody holds a claim on newer than `claimStaleBefore`, and whose task already holds
   * the landing the cue carries (`hasLanding`: one for the path at the patch's generation or
   * later), and whose change request's merge record (if any) is settled — an unsettled one's
   * settle cues its patches: the cue outbox the submit sweep drains. Bounded, oldest first.
   */
  listPatchesAwaitingMergedCue(limit: number, claimStaleBefore: string): Promise<Patch[]>;
  /**
   * A change request merged (core/merge_settle.ts `settleChangeRequestEnd`): its merge record is
   * written, or grown — `heads` put before the recorded ones (core/merge_record.ts `grownHeads`),
   * and, when that named a new one, its `version` moved on and the record made due again
   * (unsettled, its asks and clock cleared). The branch is kept as first named (`mergedInto`
   * fills in only where none was). In one transaction under the record's row lock, so two
   * deliveries never lose each other's heads. Answers the record as it now stands.
   */
  recordChangeRequestMerge(args: {
    connectedRepoId: string;
    forgeRef: string;
    mergedInto: string | undefined;
    heads: readonly string[];
    at: string;
  }): Promise<ChangeRequestMerge>;
  /** The change request's merge record, or null when no merge of it was heard. */
  getChangeRequestMerge(
    connectedRepoId: string,
    forgeRef: string,
  ): Promise<ChangeRequestMerge | null>;
  /**
   * The settle's mark on a merge record: settled (or not), its asks and its clocks. Written only
   * while the record is still as `read` left it — its `version`, its `settledAt` and its
   * `nextAskAt` — so a settle that read fewer heads never marks it settled (a merge naming a new
   * head made it due again), a retry's clock never reopens a record another settle closed
   * meanwhile, and of two processes that read the same record only one starts an ask (the first
   * stamps the ask's deadline over the clock both read, and moves the version on with it).
   * Answers whether it was written.
   */
  stampChangeRequestMerge(
    connectedRepoId: string,
    forgeRef: string,
    read: Pick<ChangeRequestMerge, "version" | "settledAt" | "nextAskAt">,
    mark:
      & Pick<ChangeRequestMerge, "settledAt" | "attempts" | "nextAskAt">
      & {
        /** An ask starts with this stamp: the record's `version` moves on with it, so a read
         * from before it never matches the record again, even once its clock is back where that
         * read saw it. */
        asking?: boolean;
      },
  ): Promise<boolean>;
  /** Every task that targets the change request (`Task.targetChangeRequest`), live or not, newest
   * first: who a merge of it lets go (core/merge_settle.ts). */
  listTasksTargetingChangeRequest(connectedRepoId: string, thread: string): Promise<Task[]>;
  /**
   * A merged change request lets go of a task that targets it whose current run has no patch on
   * it (core/landing.ts `releaseMergedTarget`; whether it has one is read under the locks),
   * applied under the task's current run's row lock and the task's, in that order, with its
   * `merge-landed` event in one transaction: the target cleared, the repo and the live run's spec
   * moved, and — when the repo moved and the run is live — the release cue appended to its inbox
   * (core/merge_release.ts `releaseCueMessage`), or, for a run still awaiting its prompt, owed on
   * the landing (`RepoLanding.releaseCueOwed`) for `claimTaskPrompt` to append. Answers what it
   * decided and the run it cued; `none` writes nothing.
   */
  releaseMergedTarget(args: {
    taskId: string;
    connectedRepoId: string;
    thread: string;
    mergedInto: string | undefined;
    defaultBranch: string;
    at: string;
  }): Promise<{ outcome: ReleaseOutcome; cuedRunId: string | null }>;
  /**
   * The release reconcile's working set (core/merge_release.ts `reconcileMergeReleases`): merge
   * records whose releases are not made yet (`releasedAt` null) — the outbox a merge's releases
   * are owed from — and not waiting out a retry (`releaseRetryAt` after `now`). Served by a
   * partial index, so it holds only those; never retried first, oldest merge first, at most
   * `limit`.
   */
  listMergesOwingRelease(now: string, limit: number): Promise<ChangeRequestMerge[]>;
  /** A release that threw is asked again only from `until`, so it never holds the rest back. */
  deferMergeRelease(connectedRepoId: string, forgeRef: string, until: string): Promise<void>;
  /** Every task the merge owed a release was let go (or its own landing's to let go): the record
   * leaves the release reconcile's working set. */
  markMergeReleased(connectedRepoId: string, forgeRef: string, at: string): Promise<void>;
  /**
   * The settle reconcile's working set (core/merge_settle.ts `reconcileMergeSettles`): merge
   * records whose clock (`nextAskAt`) allows an ask at `now` and that are still unsettled, or
   * settled with a clock (an ask past its deadline, a retry); or settled and reached since by a
   * submitted patch with no verdict — a push the merge did not see. Each arm index-driven: the
   * clock's partial index, and the late push's per-patch lookup of the record by its unique key.
   * Bounded: never asked before, then the earliest clock first.
   */
  listChangeRequestMergesDue(now: string, limit: number): Promise<ChangeRequestMerge[]>;
  /**
   * Merged or missed patches whose landing is still owed (`landingAskedAt` null), that were settled
   * before `settledBefore`, and whose change request's merge record (if any) is settled — an
   * unsettled one's settle lands its patches: the landing reconcile's working set (core/merge_settle.ts
   * `reconcileMergedLandings`). Bounded, oldest first.
   */
  listPatchesAwaitingLanding(limit: number, settledBefore: string): Promise<Patch[]>;
  /**
   * The merge poll's working set (core/merge_poll.ts): change requests (repo and `forgeRef`)
   * on a live repo of one of the `polled` providers — a GitHub one connected without an
   * installation (user mode's tenant), a GitLab one connected on `gitlab.instance` — with a
   * submitted patch that has no verdict yet, or one settled `closed` at or after `closedSince`
   * (a reopen and merge revises it), or a poll the sweep asked for after a push onto it was
   * refused as merged while a task whose current run is live works it
   * (`pollChangeRequestSoon`), whose poll is due at `now` — never asked, or its
   * `merge_polls.due_at` passed — and whose merge is not recorded yet (`ChangeRequestMerge`: the
   * settle's from then on). Never asked first, then earliest due; at most `limit`.
   *
   * `gitlab.bot` adds, in GitLab's bot mode, every GitLab repo: one whose webhook went unheard
   * tells nothing of merges, and one whose webhook is heard can still lose one merge's event —
   * the poll asks about both, at cadences of its own (core/merge_poll.ts).
   *
   * No GitLab row is listed without `gitlab`, nor one connected on another instance (or with no
   * project recorded): the forge refuses every question about it (core/forge_repo.ts
   * `gitlabInstanceFits`), so it is never asked, and listed it would sit at the head of the queue
   * every tick, ahead of every change request that can be.
   */
  listChangeRequestsDueMergePoll(
    now: string,
    closedSince: string,
    limit: number,
    polled: readonly PolledProvider[],
    gitlab?: MergePollGitlab | null,
  ): Promise<MergePollDue[]>;
  /** Sets when a change request is next polled, and its failure counts. */
  stampMergePoll(connectedRepoId: string, forgeRef: string, clock: MergePollClock): Promise<void>;
  /** Removes up to `limit` poll clocks whose change request the listing would no longer hold —
   * no unsettled submitted patch, none closed at or after `closedSince`, and no task whose current
   * run is live working it. Answers how many. */
  pruneMergePolls(closedSince: string, limit: number): Promise<number>;
  /**
   * Waiting patches (pending_approval, queued, failed) the landed-generation rule still has an
   * answer for (`landedVerdict` is not "none"): its generation ended — either a merged (or
   * missed) sibling of the same run, repo, path and generation exists, or the task records a
   * landing for its repo and path at its generation or later (a sibling's landing, or a
   * release's) — and either the patch is not held for a landing yet (no held reason) or a newer
   * patch of its branch replaces it. The reconcile's working set — empty
   * once every interleaving of a merge with a birth or a claim has been ruled. Bounded, oldest
   * first.
   */
  listPatchesDueLandingRule(limit: number): Promise<Patch[]>;
  /**
   * One page of patches: newest first, `state` narrowing when given (the approval queue asks for
   * pending_approval). Bounded and cursored like `listTasks`, and for the same reason — a patch
   * per push per run is a table that only grows.
   */
  listPatches(query?: PatchListQuery): Promise<PatchPage>;
  /** Every patch the submit sweep can move — its working set: a state in
   * `SWEEPABLE_PATCH_STATES`, and for `failed` a retry clock (`nextAttemptAt`), which is what
   * `planPatchSweep` requeues on. Not `pending_approval` nor a clockless failure: only a person
   * moves those. */
  listActivePatches(): Promise<Patch[]>;
  /** Every patch on a `local` repository still waiting to be delivered — `pending_approval` or
   * `queued` — whose git hook files nobody has asked the forge about yet (`hookCheck` null): the
   * hook-check sweep's working set (core/reaper.ts). Narrowed by provider in the query, since
   * every other forge's patch keeps a null `hookCheck` forever. */
  listPatchesAwaitingHookCheck(): Promise<Patch[]>;
  /** Oldest first. */
  patchesForTask(taskId: string): Promise<Patch[]>;
  /** Every patch born together, oldest first — what a set view and a thread reply list. */
  patchesForSet(setId: string): Promise<Patch[]>;
  /** The idempotency/adoption lookup: newest patch for this exact head, if any. */
  findPatchByRepoAndHead(connectedRepoId: string, headSha: string): Promise<Patch | null>;
  /**
   * The webhook's lookup: every patch that reached this pull request, oldest first — several
   * do, when a run pushed more onto an open pull request within one generation, and each one
   * relays its own fate.
   *
   * Keyed on the forge ref alone — `forgeRef` is written only by `markSubmitted`, so a row
   * carrying one reached the forge by definition — and deliberately NOT narrowed to patches
   * still unsettled: a closed pull request someone reopens and merges arrives here as a second
   * webhook for patches that already learned "closed", and that merge is the one verdict a
   * settled patch may still be told (see settlePatch).
   */
  patchesByRepoAndForgeRef(connectedRepoId: string, forgeRef: string): Promise<Patch[]>;
  /**
   * The memory reconciliation's working set: patches whose fate memory has not acknowledged
   * (`memoryFateReportedAt === null`) and which have a fate to report at all — landed, rejected,
   * superseded, or failed. A cheap superset: `failed` here may still have a retry clock, and
   * `patchFateForMemory` is what decides per row.
   */
  listPatchesAwaitingMemoryFate(): Promise<Patch[]>;
  /** The cached forge answers for one user, every repo asked about. */
  listRepoAccess(userId: string): Promise<RepoAccess[]>;
  /**
   * Writes forge answers into the cache, one row per user and repo: a repo answered before
   * takes the new verdict and time, one never answered gets its row. Rows for other repos stay.
   */
  saveRepoAccess(rows: readonly RepoAccess[]): Promise<void>;
  /**
   * The deployment's egress allowlist, or null when nobody has ever set one — which is not the
   * same as an empty one, and is what says the environment's seed still stands.
   */
  getEgressAllowlist(): Promise<EgressAllowlist | null>;
  /** Writes the one row, whether or not it was there. */
  saveEgressAllowlist(allowlist: EgressAllowlist): Promise<void>;
  /** The slots reserved per size class, or null when nobody has ever saved any. */
  getReservedCapacity(): Promise<ReservedCapacity | null>;
  /** Writes the one row, whether or not it was there. */
  saveReservedCapacity(capacity: ReservedCapacity): Promise<void>;
  close(): Promise<void>;
}
