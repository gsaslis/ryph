// The drizzle `TaskStore` on Postgres — embedded via PGlite or a real server, chosen by URL.
//
// Conventions:
// - reads go through the relational `db.query.*` API, not the select builder,
//   so a change of database backend stays a schema-and-driver edit
// - the schema (db/schema.ts) is the source of truth for the database; applying it is
//   drizzle-kit's job (push for local dev/tests, generated migrations for deployments —
//   see db/db.ts), never this adapter's
// - agents and runs columns mirror their core types field-for-field, so rows need no mapping
//   (bar `agentFrom`, which fills a key older agent JSON lacks);
//   tasks flatten the nested spec/repo objects into columns a UI can sort and filter on

import { rowsOf } from "@ryph/db";
import { gitlabProjectRef } from "@ryph/forge/gitlab-account";
import { idleStateOf } from "../../core/run_activity.ts";
import {
  and,
  type AnyColumn,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { ReleaseOutcome } from "../../core/landing.ts";
import { owedReleaseCues, releaseCueMessage } from "../../core/merge_release.ts";
import type {
  Agent,
  ChangeRequestMerge,
  GithubInstallation,
  GitVirtualKey,
  OriginConversation,
  Run,
  RunEvent,
  RunMessage,
  RunState,
  Task,
  WorkspaceRepo,
} from "../../core/types.ts";
import { LIVE_STATES, SWEEPABLE_PATCH_STATES, TERMINAL_STATES } from "../../core/types.ts";
import { appendRefusal, type EgressRefusal } from "../../core/egress.ts";
import { AttachmentClaimConflict } from "../../core/attachments.ts";
import type { Scope } from "../../core/scope.ts";
import { landMerge, releaseMergedTarget } from "../../core/landing.ts";
import { grownHeads } from "../../core/merge_record.ts";
import { LANDING_HOLD_REASONS } from "../../core/patch_lifecycle.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";
import { retarget } from "../../core/retarget.ts";
import {
  clampPageLimit,
  decodeListCursor,
  encodeListCursor,
  TASK_STATUS_BUCKETS,
  type TaskListQuery,
  type TaskListRow,
  type TaskStore,
} from "../../ports/task_store.ts";
import type { OrchestratorDbHandle } from "./db/db.ts";
import * as schema from "./db/schema.ts";

/** The allowlist's one row. A constant, because "the deployment's allowlist" is a singleton and
 * addressing it by id beats a `LIMIT 1` that would pick arbitrarily if a second ever appeared. */
const EGRESS_ALLOWLIST_ROW = "default";

/** Reserved capacity's one row, for the same reason. */
const RESERVED_CAPACITY_ROW = "default";

/** How many inbox messages one poll answers with. The runner's cursor pages the rest. */
const DEFAULT_MESSAGE_PAGE = 100;

/** How many responses a listing answers with, newest first. */
const DEFAULT_RESPONSE_PAGE = 50;

/** The advisory lock key task creation takes to count live runs under `RYPH_RUN_CONCURRENCY`:
 * the orchestrator's number space, listed with the sweeps' keys in `main.ts`. */
const CREATE_TASK_LOCK = 8_100_005;

/**
 * The search box's text as a tsquery: lowercase word characters only — nothing a caller types
 * reaches the tsquery parser — AND'd, with the LAST term a prefix. Words AND because a list is
 * being narrowed rather than recalled (typing a second word should show fewer rows, not more),
 * and the last one a prefix because the box searches while it is still being typed.
 *
 * Null when there is nothing to search for, which is not the same as "match nothing": a query of
 * punctuation alone narrows by nothing and the caller's other filters still decide the page.
 */
export function taskSearchQuery(query: string): string | null {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].slice(0, 16);
  if (words.length === 0) return null;
  return words.map((word, i) => (i === words.length - 1 ? `${word}:*` : word)).join(" & ");
}

/**
 * The scope as a predicate over the tasks table: the requester's own rows, or rows whose every
 * checked-out repo is one the caller may write. An entry with no connected repo — a row from
 * before tasks could only check out connected repos — is one nobody may write, so a `NOT IN`
 * that would read it as NULL cannot let it through. Null for "everything", so a caller with no
 * scope adds nothing to its query.
 */
export function scopeFilter(scope: Scope | undefined): SQL | null {
  if (scope === undefined || scope.kind === "all") return null;
  const t = schema.tasks;
  const own = eq(t.requestedByUserId, scope.userId);
  if (scope.writableRepoIds.length === 0) return own;
  const writable = sql.join(scope.writableRepoIds.map((id) => sql`${id}`), sql`, `);
  const outsider = sql`SELECT 1 FROM jsonb_array_elements(${t.repos}) AS entry
    WHERE entry ->> 'connectedRepoId' IS NULL OR entry ->> 'connectedRepoId' NOT IN (${writable})`;
  return sql`(${own} OR (jsonb_array_length(${t.repos}) > 0 AND NOT EXISTS (${outsider})))`;
}

/**
 * The scope over a row that names its task: the task must exist and fall inside it. Built as a
 * subquery object rather than an inlined `EXISTS`, because a relational query rewrites every
 * bare column in its `where` onto its own table, and `tasks.requested_by_user_id` would come
 * out as a column of `patches`. A subquery is opaque to that rewrite.
 */
function taskScopeExists(
  db: OrchestratorDbHandle["db"],
  scope: Scope | undefined,
  taskId: AnyColumn,
): SQL | null {
  const inner = scopeFilter(scope);
  if (inner === null) return null;
  const t = schema.tasks;
  return inArray(taskId, db.select({ id: t.id }).from(t).where(inner));
}

/**
 * A patch's verdict is final unless its change request's merge record is unsettled: a settle
 * whose record grew while it asked keeps the verdicts it wrote, and the settle that judges every
 * head lands, rules and cues them. The backstops leave such a patch to it. A lookup by the
 * record's unique key.
 */
function verdictFinal(p: typeof schema.patches): SQL {
  const m = schema.changeRequestMerges;
  return sql`not exists (select 1 from ${m} where ${m.connectedRepoId} = ${p.connectedRepoId}
    and ${m.forgeRef} = ${p.forgeRef} and ${m.settledAt} is null)`;
}

/** `landingKey` (core/landing.ts) in SQL: the key a patch's line's landing is kept under in
 * `tasks.landings -> path` — the default line's name, any other line as `<runId>/<line>`. */
function landingKeySql(line: AnyColumn, runId: AnyColumn): SQL {
  return sql`(case when ${line} = ${DEFAULT_LINE} then ${line} else ${runId} || '/' || ${line} end)`;
}

/**
 * Every filter a task list carries, as one AND'd predicate — the keyset cursor included, since
 * "older than where the last page stopped" is a filter like any other.
 *
 * The cursor is a ROW comparison, `(created_at, id) < (…, …)`, not a pair of OR'd inequalities:
 * Postgres turns that into a single index range scan over `(created_at, id)`, which is why a
 * deep page costs what a shallow one costs. The sort direction is DESC on BOTH columns for the
 * same reason — a mixed direction cannot be served by one scan of a plain btree.
 */
function taskFilters(query: TaskListQuery): SQL[] {
  const t = schema.tasks;
  // Abandoned drafts never became work for the agent. Hide them from every history query
  // (including live-tail membership), but keep direct reads for diagnostics and restarting.
  const filters: SQL[] = [];
  if (!query.includeAbandonedDrafts) {
    filters.push(
      sql`(${t.currentRunState} IS DISTINCT FROM 'cancelled' OR ${t.specInstructions} IS NOT NULL)`,
    );
  }
  const scoped = scopeFilter(query.scope);
  if (scoped !== null) filters.push(scoped);

  const after = decodeListCursor(query.cursor);
  if (after !== null) {
    filters.push(sql`(${t.createdAt}, ${t.id}) < (${after.createdAt}, ${after.id})`);
  }
  if (query.ids !== undefined) {
    if (query.ids.length === 0) return [sql`false`];
    filters.push(inArray(t.id, [...query.ids]));
  }
  if (query.statuses !== undefined && query.statuses.length > 0) {
    const states = [...new Set(query.statuses.flatMap((b) => [...TASK_STATUS_BUCKETS[b]]))];
    filters.push(inArray(t.currentRunState, states));
  }
  if (query.agentIds !== undefined && query.agentIds.length > 0) {
    filters.push(inArray(t.agentId, [...query.agentIds]));
  }
  if (query.origins !== undefined && query.origins.length > 0) {
    filters.push(inArray(t.origin, [...query.origins]));
  }
  if (query.workspaceId !== undefined) filters.push(eq(t.workspaceId, query.workspaceId));
  if (query.connectedRepoId !== undefined) {
    // Containment into the frozen repo list, which the GIN index on `repos` answers. The
    // parameter is bound as jsonb, never spliced — a repo id is a minted id, but a query that
    // builds JSON by concatenation is one edit away from not being.
    const probe = JSON.stringify([{ connectedRepoId: query.connectedRepoId }]);
    filters.push(sql`${t.repos} @> ${probe}::jsonb`);
  }
  if (query.requestedByUserId !== undefined) {
    filters.push(eq(t.requestedByUserId, query.requestedByUserId));
  }
  if (query.createdFrom !== undefined) filters.push(gte(t.createdAt, query.createdFrom));
  if (query.createdTo !== undefined) filters.push(lt(t.createdAt, query.createdTo));
  const terms = query.q === undefined ? null : taskSearchQuery(query.q);
  if (terms !== null) {
    filters.push(
      sql`to_tsvector('english', ${t.specTitle}) @@ to_tsquery('english', ${terms})`,
    );
  }
  return filters;
}

/** What `releaseMergedTarget` (core/landing.ts) reads of a patch row. */
const releaseColumns = {
  path: schema.patches.path,
  line: schema.patches.line,
  generation: schema.patches.generation,
  forgeRef: schema.patches.forgeRef,
};

/** How many times a transaction the database chose as a deadlock victim is run again. */
const DEADLOCK_ATTEMPTS = 3;

/**
 * Runs `fn` again when Postgres broke a deadlock by aborting it (SQLSTATE 40P01): a transaction
 * that locks a run row can meet a heartbeat's write and a run_events insert (whose foreign key
 * takes a share lock on the run) in the other order. The aborted attempt wrote nothing, so the
 * retry is the whole of it. Bounded; any other failure is thrown at once.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1;; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= DEADLOCK_ATTEMPTS || !isDeadlock(err)) throw err;
    }
  }
}

function isDeadlock(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === "object" && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === "40P01") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * An agent row as the core type, the one place a read deviates from "rows need no mapping": a
 * `model_policy` written before `defaultThinking` existed lacks the key, and the type promises a
 * null. Filled here, so a policy compared against a resent one does not read as moved.
 */
function agentFrom<T extends Agent>(row: T): T {
  const policy = row.modelPolicy;
  if (policy === null || policy.defaultThinking !== undefined) return row;
  return { ...row, modelPolicy: { ...policy, defaultThinking: null } };
}

/**
 * Appends one message inside `tx`. The next seq is read and taken under a row lock on the run:
 * two appends racing for one run serialize on it, so the unique (run_id, seq) index is a
 * guarantee and not a hope. A transaction rather than an insert-select, because the lock is what
 * orders the two reads — an insert-select's subquery reads the same snapshot as its racer.
 */
async function appendMessageIn(
  tx: Parameters<Parameters<OrchestratorDbHandle["db"]["transaction"]>[0]>[0],
  message: Omit<RunMessage, "seq">,
): Promise<RunMessage> {
  await tx.execute(sql`select "id" from "runs" where "id" = ${message.runId} for update`);
  const last = rowsOf<{ last: number }>(
    await tx.execute(
      sql`select coalesce(max("seq"), -1)::int as "last" from "run_messages" where "run_id" = ${message.runId}`,
    ),
  );
  const seq = last[0].last + 1;
  const stored: RunMessage = { ...message, seq };
  // The claim and the append are one transaction, and the WHERE is the claim: of two messages
  // racing for one image exactly one updates it, and the loser's whole append rolls back with
  // the throw.
  if (message.attachments.length > 0) {
    const ids = message.attachments.map((a) => a.id);
    const claimed = await tx.update(schema.runAttachments)
      .set({ claimedBy: message.id })
      .where(and(
        inArray(schema.runAttachments.id, ids),
        eq(schema.runAttachments.runId, message.runId),
        isNull(schema.runAttachments.claimedBy),
      ))
      .returning({ id: schema.runAttachments.id });
    if (claimed.length !== ids.length) throw new AttachmentClaimConflict();
  }
  await tx.insert(schema.runMessages).values(stored);
  return stored;
}

export function drizzleTaskStore(handle: OrchestratorDbHandle): TaskStore {
  const { db } = handle;

  /** The run's agent images, counted and their bytes summed, on `db` or inside a transaction. */
  const agentUsage = async (
    on: Pick<typeof db, "select">,
    runId: string,
  ): Promise<{ count: number; bytes: number }> => {
    const [row] = await on.select({
      count: count(),
      bytes: sql<number>`coalesce(sum(${schema.runAttachments.bytes}), 0)::int`,
    }).from(schema.runAttachments).where(and(
      eq(schema.runAttachments.runId, runId),
      eq(schema.runAttachments.source, "agent"),
    ));
    return { count: Number(row.count), bytes: Number(row.bytes) };
  };

  const toTaskRow = (task: Task, run: Run): typeof schema.tasks.$inferInsert => ({
    id: task.id,
    agentId: task.agentId,
    specTitle: task.spec.title,
    specInstructions: task.spec.instructions,
    repos: task.repos,
    workspaceId: task.workspaceId,
    origin: task.origin,
    requestedByUserId: task.requestedByUserId,
    requestedVia: task.requestedVia,
    chatConversation: task.chatConversation,
    targetChangeRequest: task.targetChangeRequest,
    landings: task.landings,
    lifetime: task.lifetime,
    purpose: task.purpose,
    // The current attempt, denormalized (see db/schema.ts): set here from the run the task is
    // born with, and followed by `saveRun` from then on.
    currentRunId: run.id,
    currentRunState: run.state,
    currentRunPhase: run.phase,
    currentRunIdleState: idleStateOf(run),
    lastActivityAt: run.updatedAt,
    createdAt: task.createdAt,
  });

  const toTask = (row: typeof schema.tasks.$inferSelect): Task => ({
    id: row.id,
    agentId: row.agentId,
    spec: { title: row.specTitle, instructions: row.specInstructions },
    repos: row.repos,
    workspaceId: row.workspaceId,
    origin: row.origin,
    requestedByUserId: row.requestedByUserId,
    requestedVia: row.requestedVia ?? null,
    chatConversation: row.chatConversation,
    targetChangeRequest: row.targetChangeRequest,
    landings: row.landings ?? {},
    lifetime: row.lifetime,
    purpose: row.purpose,
    createdAt: row.createdAt,
  });

  // Read the heartbeat-owned fact directly, in the same statement as the task page. The
  // primary-key probe avoids a second denormalized copy that stale saveRun writes could erase.
  const listExtras = {
    declaredOutcome: sql<Run["declaredOutcome"]>`(select declared_outcome from runs
      where runs.id = ${schema.tasks.currentRunId})`.as("current_declared_outcome"),
  };
  /** A task row plus its current run's heartbeat-owned declaration. */
  const toListRow = (
    row: typeof schema.tasks.$inferSelect & { declaredOutcome: Run["declaredOutcome"] },
  ): TaskListRow => ({
    task: toTask(row),
    currentRun: {
      id: row.currentRunId,
      state: row.currentRunState,
      phase: row.currentRunPhase,
      idleState: row.currentRunIdleState,
      declaredOutcome: row.declaredOutcome ?? null,
    },
    lastActivityAt: row.lastActivityAt,
  });

  // An events row only needs `detail: null` normalized back to an absent field.
  const toEvent = (row: typeof schema.runEvents.$inferSelect): RunEvent => ({
    runId: row.runId,
    at: row.at,
    kind: row.kind,
    ...(row.detail === null ? {} : { detail: row.detail }),
  });

  // "Still going", asked as the states that are rather than the ones that are not: `IN` is an
  // index range on `runs_by_state` / `tasks_by_state`, `NOT IN` a scan of every row ever made.
  const liveStates = [...LIVE_STATES];
  /** Whether a task whose current run is live works the change request (`targetChangeRequest`),
   * through `tasks_by_target_change_request`: a poll the sweep asked for after a push onto it
   * was refused as merged (core/merge_poll.ts `pollChangeRequestSoon`) is kept, and listed, for as
   * long as one does, though no patch of ours is on it. A scalar probe with a limit rather than
   * an EXISTS, which the planner may turn into an anti join over every task: this one stays a
   * lookup of the index per poll row, by its key (EXPLAIN shows the Index Cond). */
  const workedLive = (connectedRepoId: SQL, forgeRef: SQL) =>
    sql`coalesce((select true from tasks t where t.target_change_request is not null
      and (t.target_change_request ->> 'connectedRepoId') = ${connectedRepoId}
      and (t.target_change_request ->> 'thread') = ${forgeRef}
      and t.current_run_state in (${sql.join(liveStates.map((st) => sql`${st}`), sql`, `)})
      limit 1), false)`;

  /** Lifted out of the port method because the change-request lookup below is this question
   * asked first, before it falls back to the tasks that TARGET the thread. */
  const liveRunByOrigin = async (origin: OriginConversation): Promise<Run | null> => {
    const row = await db.query.runs.findFirst({
      where: (r, { and, eq, inArray }) =>
        origin.kind === "forge"
          ? and(
            inArray(r.state, liveStates),
            eq(r.originThreadRepoId, origin.connectedRepoId),
            eq(r.originThreadKind, origin.threadKind),
            eq(r.originThreadRef, origin.ref),
          )
          : and(
            inArray(r.state, liveStates),
            eq(r.originChatroomId, origin.chatroomId),
            eq(r.originThreadKey, origin.threadKey),
          ),
      // Newest first: a thread that somehow holds two live runs answers with the one a
      // follow-up should reach, rather than an older straggler.
      orderBy: (r, { desc }) => [desc(r.createdAt)],
    });
    return row ?? null;
  };

  /**
   * The change-request lookup's third reading: the live run that OPENED this change request with
   * `submit_patch`. Neither its origin (still the thread it was summoned from, or a chat) nor its
   * task (which targets nothing) names the change request; only its patches do, through
   * `forge_ref`, and `patches_by_repo_and_forge_ref` keeps this to an indexed probe. Landed or
   * not: a follow-up on a just-merged pull request still belongs to the run that wrote it.
   * Newest run first, like the other two readings.
   */
  const liveRunThatOpened = async (
    connectedRepoId: string,
    thread: string,
  ): Promise<Run | null> => {
    const opened = await db.query.patches.findMany({
      columns: { runId: true },
      where: (p, { and, eq }) =>
        and(eq(p.connectedRepoId, connectedRepoId), eq(p.forgeRef, thread)),
    });
    if (opened.length === 0) return null;
    const row = await db.query.runs.findFirst({
      where: (r, { and, inArray }) =>
        and(
          inArray(r.id, [...new Set(opened.map((p) => p.runId))]),
          inArray(r.state, liveStates),
        ),
      orderBy: (r, { desc }) => [desc(r.createdAt), desc(r.id)],
    });
    return row ?? null;
  };

  /**
   * A starting run's compare-and-set: writes `run` only while the stored row is still `starting`
   * with no container and also matches `also`, and answers whether it landed. The claim is one
   * statement: the WHERE is the claim, so two callers holding the same run cannot both land. The
   * acknowledgement, the refusals and what the agent said stay their writers', as in saveRun.
   */
  const saveRunWhere = async (run: Run, also: SQL): Promise<boolean> => {
    const {
      memoryOutcomeReportedAt: _ack,
      egressRefusals: _refusals,
      skillsReportedAt: _skills,
      declaredOutcome: _declared,
      agentFinished: _finished,
      ...revisable
    } = run;
    // This write changes `state`/`phase` (starting → refused/lost/launching), so the task's
    // copy of the current attempt has to move with it, exactly as in saveRun — and in the
    // same transaction, so a list can never show a state the run no longer holds. Only if
    // the claim landed: a caller that lost the race says nothing about the row.
    return await db.transaction(async (tx) => {
      const landed = await tx.update(schema.runs).set({
        ...revisable,
        desiredState: sql`coalesce(${schema.runs.desiredState}, ${run.desiredState})`,
        cancelRequestedAt:
          sql`coalesce(${schema.runs.cancelRequestedAt}, ${run.cancelRequestedAt})`,
      })
        .where(and(
          eq(schema.runs.id, run.id),
          eq(schema.runs.state, "starting"),
          isNull(schema.runs.handle),
          also,
        ))
        .returning({ id: schema.runs.id });
      if (landed.length !== 1) return false;
      await tx.update(schema.tasks)
        .set({
          currentRunState: run.state,
          currentRunPhase: run.phase,
          currentRunIdleState: idleStateOf(run),
          lastActivityAt: run.updatedAt,
        })
        // Conditioned on the run still being the task's CURRENT attempt, as in saveRun.
        .where(and(
          eq(schema.tasks.id, run.taskId),
          eq(schema.tasks.currentRunId, run.id),
        ));
      return true;
    });
  };

  // Compare the facts on which a lifecycle decision was based, not just a timestamp (two
  // writes can share one). Narrow writes below preserve every field outside their ownership.
  const lifecycleSnapshot = (run: Run): SQL =>
    sql`
    ${schema.runs.state} = ${run.state}
    and ${schema.runs.heartbeatSeq} = ${run.heartbeatSeq}
    and ${schema.runs.lastHeartbeatAt} is not distinct from ${run.lastHeartbeatAt}
    and ${schema.runs.desiredState} is not distinct from ${run.desiredState}
    and ${schema.runs.cancelRequestedAt} is not distinct from ${run.cancelRequestedAt}
    and ${schema.runs.idleDeadlineAt} is not distinct from ${run.idleDeadlineAt}
    and ${schema.runs.handle} is not distinct from ${run.handle}
    and ${schema.runs.launchedAt} is not distinct from ${run.launchedAt}`;

  const updateRunWhere = async (
    runId: string,
    changes: PgUpdateSetSource<typeof schema.runs>,
    condition: SQL,
  ): Promise<Run | null> => {
    return await db.transaction(async (tx) => {
      const [row] = await tx.update(schema.runs).set(changes)
        .where(and(eq(schema.runs.id, runId), condition)).returning();
      if (!row) return null;
      // Derive the denormalized copy from the row actually written, never the caller's copy.
      await tx.update(schema.tasks).set({
        currentRunState: row.state,
        currentRunPhase: row.phase,
        currentRunIdleState: idleStateOf(row),
        lastActivityAt: row.updatedAt,
      }).where(and(eq(schema.tasks.id, row.taskId), eq(schema.tasks.currentRunId, row.id)));
      return row;
    });
  };

  return {
    async createAgent(agent) {
      await db.insert(schema.agents).values(agent);
    },
    async getAgent(id) {
      const row = await db.query.agents.findFirst({
        where: (a, { eq }) => eq(a.id, id),
      });
      return row === undefined ? null : agentFrom(row);
    },
    async getAgentByHandle(handle) {
      const row = await db.query.agents.findFirst({
        where: (a, { eq }) => eq(a.handle, handle),
      });
      return row === undefined ? null : agentFrom(row);
    },
    async listAgents() {
      const rows = await db.query.agents.findMany({
        orderBy: (a, { asc, desc }) => [desc(a.createdAt), asc(a.id)],
      });
      return rows.map(agentFrom);
    },
    async listAgentsByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.query.agents.findMany({
        where: (a, { inArray }) => inArray(a.id, [...ids]),
      });
      return rows.map(agentFrom);
    },
    async saveAgent(agent) {
      const { canOpenPatches: _patches, canPublishArtifacts: _artifacts, ...rest } = agent;
      await db.insert(schema.agents).values(agent)
        .onConflictDoUpdate({ target: schema.agents.id, set: rest });
    },
    async setAgentCanOpenPatches(id, from, to) {
      const moved = await db.update(schema.agents)
        .set({ canOpenPatches: to })
        .where(and(eq(schema.agents.id, id), eq(schema.agents.canOpenPatches, from)))
        .returning({ id: schema.agents.id });
      return moved.length > 0;
    },
    async setAgentCanPublishArtifacts(id, from, to) {
      const moved = await db.update(schema.agents)
        .set({ canPublishArtifacts: to })
        .where(and(eq(schema.agents.id, id), eq(schema.agents.canPublishArtifacts, from)))
        .returning({ id: schema.agents.id });
      return moved.length > 0;
    },
    async createTask(task, run, gitKey?: GitVirtualKey, opts?) {
      // A task, its first run and (for a connected-repo task) that run's git key land together
      // or not at all. This was `db.batch` under libsql, whose interactive-transaction API could
      // hop connections and so silently target a different, empty database; Postgres has no such
      // hazard, so the real transaction is both correct and simpler than the two batch shapes.
      return await db.transaction(async (tx) => {
        const maxLive = opts?.maxLive ?? null;
        if (maxLive !== null) {
          // The cap is a COUNT, and no row lock can hold a count — `claimNextBuild`'s reason. An
          // advisory lock rather than its table lock: `runs` is the table every heartbeat
          // updates, and any table lock strong enough to exclude a second creator excludes those
          // updates too. The advisory lock serializes creators, briefly, and nothing else.
          await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_TASK_LOCK})`);
          const [{ live }] = await tx.select({ live: count() }).from(schema.runs)
            .where(inArray(schema.runs.state, liveStates));
          if (live >= maxLive) return "full";
        }
        await tx.insert(schema.tasks).values(toTaskRow(task, run));
        await tx.insert(schema.runs).values(run);
        if (gitKey) await tx.insert(schema.gitVirtualKeys).values(gitKey);
        // The run's start images, with the run: its work item names them, and a crash between
        // two statements must not leave a run whose runner is refused every image it was handed.
        const attachments = opts?.attachments ?? [];
        if (attachments.length > 0) {
          await tx.insert(schema.runAttachments).values([...attachments]);
        }
        return "created";
      });
    },
    async getTask(id, scope) {
      const scoped = scopeFilter(scope);
      const row = await db.query.tasks.findFirst({
        where: (t, { eq, and }) => scoped === null ? eq(t.id, id) : and(eq(t.id, id), scoped),
      });
      return row ? toTask(row) : null;
    },
    async applyRetarget({ taskId, runId, ...args }) {
      return await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
          // The run's row, then the task's: `landMerge`'s order, so the two never deadlock.
          const [runRow] = await tx.select().from(schema.runs)
            .where(eq(schema.runs.id, runId)).for("update");
          const [taskRow] = await tx.select().from(schema.tasks)
            .where(eq(schema.tasks.id, taskId)).for("update");
          if (runRow === undefined || taskRow === undefined) return null;
          const targeted = taskRow.targetChangeRequest;
          if (targeted !== null && targeted.connectedRepoId !== args.connectedRepoId) {
            return { kind: "refused" as const, why: "other-change-request" as const };
          }
          const [shipped] = await tx.select({ id: schema.patches.id }).from(schema.patches)
            .where(and(
              eq(schema.patches.runId, runId),
              eq(schema.patches.connectedRepoId, args.connectedRepoId),
            ))
            .limit(1);
          if (shipped !== undefined) return { kind: "refused" as const, why: "shipped" as const };
          const applied = retarget({ ...args, task: toTask(taskRow), run: runRow });
          // Exactly the columns a re-target moves on the task: the current attempt's state sits
          // on this row too and is `saveRun`'s alone.
          await tx.update(schema.tasks)
            .set({
              repos: applied.task.repos,
              targetChangeRequest: applied.task.targetChangeRequest,
              landings: applied.task.landings,
            })
            .where(eq(schema.tasks.id, taskId));
          if (!TERMINAL_STATES.has(runRow.state)) {
            await tx.update(schema.runs)
              .set({
                workItem: applied.run.workItem,
                forgeScope: applied.run.forgeScope,
                updatedAt: applied.run.updatedAt,
              })
              .where(eq(schema.runs.id, runId));
            if (taskRow.currentRunId === runId) {
              await tx.update(schema.tasks)
                .set({ lastActivityAt: applied.run.updatedAt })
                .where(eq(schema.tasks.id, taskId));
            }
          }
          return applied;
        })
      );
    },
    async landMerge({ patch, mergedInto, defaultBranch, intoTip, at }) {
      return await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
          // The run's row first, then the task's: the order `saveRun`, `applyRetarget` and
          // `releaseMergedTarget` take them in, so a heartbeat landing meanwhile waits rather
          // than deadlocks. Held to the end, they are what makes the decision below true when it
          // is written.
          const [runRow] = await tx.select().from(schema.runs)
            .where(eq(schema.runs.id, patch.runId)).for("update");
          const [taskRow] = await tx.select().from(schema.tasks)
            .where(eq(schema.tasks.id, patch.taskId)).for("update");
          // Asked and answered, whatever the answer, with the landing it answered: the landing
          // reconcile never asks again. Only while merged (or missed) and unasked, so a repeat
          // writes nothing.
          await tx.update(schema.patches).set({ landingAskedAt: at })
            .where(and(
              eq(schema.patches.id, patch.id),
              isNull(schema.patches.landingAskedAt),
              sql`${schema.patches.landed} ->> 'kind' in ('merged', 'missed')`,
            ));
          if (taskRow === undefined) return { outcome: { kind: "none" as const } };
          const live = runRow !== undefined && !TERMINAL_STATES.has(runRow.state);
          const outcome = landMerge({
            task: toTask(taskRow),
            run: live ? runRow : null,
            patch,
            mergedInto,
            defaultBranch,
            intoTip,
            at,
            runNamespace: runRow?.branchNamespace,
          });
          if (outcome.kind === "released") {
            await tx.update(schema.tasks)
              .set({ targetChangeRequest: null })
              .where(eq(schema.tasks.id, patch.taskId));
            await tx.insert(schema.runEvents).values({
              runId: outcome.event.runId,
              at: outcome.event.at,
              kind: outcome.event.kind,
              detail: outcome.event.detail ?? null,
            });
            return { outcome };
          }
          if (outcome.kind !== "landed") return { outcome };
          await tx.update(schema.tasks)
            .set({
              repos: outcome.task.repos,
              targetChangeRequest: outcome.task.targetChangeRequest,
              landings: outcome.task.landings,
              // The list's clock moves with the task's current attempt, as in saveRun.
              ...(outcome.run !== null && taskRow.currentRunId === outcome.run.id
                ? { lastActivityAt: outcome.run.updatedAt }
                : {}),
            })
            .where(eq(schema.tasks.id, patch.taskId));
          if (outcome.run !== null) {
            await tx.update(schema.runs)
              .set({ workItem: outcome.run.workItem, updatedAt: outcome.run.updatedAt })
              .where(
                and(eq(schema.runs.id, outcome.run.id), inArray(schema.runs.state, liveStates)),
              );
          }
          if (outcome.event !== null) {
            await tx.insert(schema.runEvents).values({
              runId: outcome.event.runId,
              at: outcome.event.at,
              kind: outcome.event.kind,
              detail: outcome.event.detail ?? null,
            });
          }
          return { outcome };
        })
      );
    },
    async retitleTask(taskId, from, to) {
      // The compare-and-set is the WHERE: a title anyone wrote since the fallback stands.
      const moved = await db.update(schema.tasks)
        .set({ specTitle: to })
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.specTitle, from)))
        .returning({ id: schema.tasks.id });
      return moved.length > 0;
    },
    async listTasks(query) {
      const limit = clampPageLimit(query?.limit);
      const where = taskFilters(query ?? {});
      // One row further than asked: that extra row is how the page knows an older one exists
      // without a count over everything the filters match.
      const rows = await db.query.tasks.findMany({
        where: where.length === 0 ? undefined : and(...where),
        extras: listExtras,
        orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        tasks: page.map(toListRow),
        nextCursor: rows.length > limit && last !== undefined ? encodeListCursor(last) : null,
      };
    },
    async listTasksByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db.query.tasks.findMany({
        where: (t, { inArray }) => inArray(t.id, [...ids]),
        extras: listExtras,
        orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
      });
      return rows.map(toListRow);
    },
    async runsForTask(taskId) {
      return await db.query.runs.findMany({
        where: (r, { eq }) => eq(r.taskId, taskId),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.id)],
      });
    },
    async listRunsByIds(ids) {
      if (ids.length === 0) return [];
      return await db.query.runs.findMany({
        where: (r, { inArray }) => inArray(r.id, [...ids]),
      });
    },
    async getRun(id) {
      const row = await db.query.runs.findFirst({
        where: (r, { eq }) => eq(r.id, id),
      });
      return row ?? null;
    },
    async saveBootstrap(runId, tokenHash, sealed, expiresAt) {
      await db.insert(schema.runBootstraps).values({ runId, tokenHash, sealed, expiresAt });
    },

    async readBootstrap(runId, tokenHash, now) {
      const [row] = await db.select({ sealed: schema.runBootstraps.sealed })
        .from(schema.runBootstraps)
        .where(and(
          eq(schema.runBootstraps.runId, runId),
          eq(schema.runBootstraps.tokenHash, tokenHash),
          gt(schema.runBootstraps.expiresAt, now),
        ));
      return row?.sealed ?? null;
    },

    async consumeBootstrap(runId, tokenHash, now) {
      const [row] = await db.delete(schema.runBootstraps).where(and(
        eq(schema.runBootstraps.runId, runId),
        eq(schema.runBootstraps.tokenHash, tokenHash),
        gt(schema.runBootstraps.expiresAt, now),
      )).returning({ sealed: schema.runBootstraps.sealed });
      return row?.sealed ?? null;
    },

    async deleteBootstrap(runId) {
      await db.delete(schema.runBootstraps).where(eq(schema.runBootstraps.runId, runId));
    },

    async deleteExpiredBootstraps(now) {
      await db.delete(schema.runBootstraps).where(lte(schema.runBootstraps.expiresAt, now));
    },

    async saveRun(run: Run) {
      await db.transaction(async (tx) => {
        await tx.insert(schema.runs).values(run);
        await tx.update(schema.tasks)
          .set({
            currentRunState: run.state,
            currentRunPhase: run.phase,
            currentRunIdleState: idleStateOf(run),
            lastActivityAt: run.updatedAt,
          })
          // Conditioned on the run being the task's CURRENT attempt: a write about an older run
          // (a retry's predecessor) must not roll the row back to a state that is over.
          .where(and(
            eq(schema.tasks.id, run.taskId),
            eq(schema.tasks.currentRunId, run.id),
          ));
      });
    },
    async saveRunTransition(run, expected) {
      return await updateRunWhere(run.id, {
        state: run.state,
        environmentWait: run.environmentWait,
        updatedAt: run.updatedAt,
      }, and(inArray(schema.runs.state, [...LIVE_STATES]), lifecycleSnapshot(expected))!);
    },
    async saveRunResult(run) {
      return await updateRunWhere(
        run.id,
        {
          state: run.state,
          result: run.result,
          updatedAt: run.updatedAt,
        },
        and(
          inArray(schema.runs.state, [...LIVE_STATES, "lost"]),
          isNull(schema.runs.result),
        )!,
      );
    },
    async requestRunCancel(runId, at, guard) {
      const row = await updateRunWhere(
        runId,
        {
          desiredState: "cancelled",
          cancelRequestedAt: at,
          updatedAt: at,
        },
        and(
          inArray(schema.runs.state, [...LIVE_STATES]),
          isNull(schema.runs.desiredState),
          guard
            ? sql`${schema.runs.idleDeadlineAt} is not distinct from ${guard.idleDeadlineAt}`
            : undefined,
        )!,
      );
      if (row) return { run: row, applied: true };
      const current = await db.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      return { run: current ?? null, applied: false };
    },
    async recordRunLaunch(runId, handle, launchedAt) {
      // No lifecycle fields. A live run's clock moves forward with the launch, so the task list
      // sorts it as active; a terminal row's stays put, or a late handle would make its result
      // appear to have happened again.
      const live = inArray(schema.runs.state, [...LIVE_STATES]);
      const row = await updateRunWhere(runId, {
        handle,
        launchedAt,
        updatedAt: sql`case when ${live}
          then greatest(${schema.runs.updatedAt}, ${launchedAt})
          else ${schema.runs.updatedAt} end`,
      }, isNull(schema.runs.handle));
      return row ?? await db.query.runs.findFirst({ where: eq(schema.runs.id, runId) }) ?? null;
    },
    async saveRunIfWaiting(run, environmentId) {
      return await saveRunWhere(
        run,
        sql`${schema.runs.environmentWait}->>'environmentId' = ${environmentId}`,
      );
    },
    async saveRunIfUnlaunched(run) {
      return await saveRunWhere(
        run,
        and(isNull(schema.runs.environmentWait), isNull(schema.runs.desiredState))!,
      );
    },
    async saveHeartbeat(run) {
      // One statement: the run's beat columns and the task's copy, both conditioned. The run
      // side on the stored row still being live and the beat being newer — so a conclusion or a
      // later beat that landed since the handler's read wins — and the task side on the run
      // being its current attempt, as in saveRun. Addressed by the task's primary key off the
      // row just written, for markRunAttended's reason. Data-modifying CTEs run whether or not
      // the outer query reads them, so the count below is only the answer, not the trigger.
      const rows = rowsOf<{ desired_state: Run["desiredState"] }>(
        await db.execute(sql`
          with beat as (
            update runs set
              state = ${run.state},
              phase = ${run.phase},
              heartbeat_seq = ${run.heartbeatSeq},
              last_heartbeat_at = ${run.lastHeartbeatAt},
              idle_deadline_at = ${run.idleDeadlineAt},
              idle_state = ${idleStateOf(run)},
              -- As applyHeartbeat left it: kept by a beat that says none, cleared by one that
              -- says null. Beats can overlap here (a runner that gave up on one sends the next
              -- while the first is still being written), yet a kept value is never stale: from
              -- the first outcome the agent says, every beat carries it or the null that clears
              -- it, so a beat says none only while the stored value is null. The seq guard below
              -- orders overlapping and late beats, the live-state guard drops one after the run
              -- ended, and saveRun never overwrites it.
              declared_outcome = ${run.declaredOutcome ?? null},
              -- And a finish, once said, for good: OR'd, so no beat can unsay it.
              agent_finished = agent_finished or ${run.agentFinished === true},
              updated_at = ${run.updatedAt}
            where id = ${run.id}
              and state in (${sql.join(liveStates.map((s) => sql`${s}`), sql`, `)})
              and heartbeat_seq < ${run.heartbeatSeq}
            returning id, task_id, desired_state
          ), task as (
            update tasks set
              current_run_state = ${run.state},
              current_run_phase = ${run.phase},
              current_run_idle_state = ${idleStateOf(run)},
              last_activity_at = ${run.updatedAt}
            from beat
            where tasks.id = beat.task_id and tasks.current_run_id = beat.id
          )
          select desired_state from beat`),
      );
      return rows.length === 0 ? null : { desiredState: rows[0].desired_state };
    },
    async markRunAttended(runId, at) {
      // Two columns, conditioned on the stored `attended` — never the whole row: the caller's
      // copy predates whatever the runner wrote in between, and a terminal result put back as
      // `running`/`result: null` is a run that can never receive one (applyResult would call
      // the re-POST a duplicate).
      const outcome = await db.transaction(async (tx) => {
        const [flipped] = await tx.update(schema.runs).set({ attended: true, updatedAt: at })
          .where(and(eq(schema.runs.id, runId), eq(schema.runs.attended, false)))
          .returning();
        if (flipped === undefined) return null;
        // Someone speaking to a run is activity, and the list sorts and streams on it — in the
        // SAME transaction as the flip, as in saveRun, so a list can never show a row whose
        // activity clock disagrees with the run it names.
        //
        // Addressed by the task's PRIMARY KEY, taken off the row we just wrote: there is no
        // index on `current_run_id`, so a WHERE on it alone is a sequential scan of the tasks
        // table on every first message of every run. `current_run_id` stays in the predicate as
        // the guard it is — a message to a superseded attempt must not move the row.
        await tx.update(schema.tasks).set({ lastActivityAt: at })
          .where(and(
            eq(schema.tasks.id, flipped.taskId),
            eq(schema.tasks.currentRunId, runId),
          ));
        return flipped as Run;
      });
      if (outcome !== null) return { run: outcome, flipped: true };
      const current = await db.query.runs.findFirst({ where: (r, { eq }) => eq(r.id, runId) });
      return { run: current ?? null, flipped: false };
    },
    async recordRunEgressRefusal(runId, refusal) {
      // A read-modify-write under a row lock, because two reports of one run can race and a
      // JSON array has no `insert` a statement could express. The lock is the same one
      // `appendRunMessage` takes for the same reason.
      return await db.transaction(async (tx) => {
        const rows = rowsOf<{ state: string; egress_refusals: EgressRefusal[] | null }>(
          await tx.execute(
            sql`select "state", "egress_refusals" from "runs" where "id" = ${runId} for update`,
          ),
        );
        const row = rows[0];
        if (row === undefined) return "ended";
        if (TERMINAL_STATES.has(row.state as Run["state"])) return "ended";
        const next = appendRefusal(row.egress_refusals, refusal);
        if (next === null) return "duplicate";
        await tx.update(schema.runs).set({ egressRefusals: next })
          .where(eq(schema.runs.id, runId));
        return "recorded";
      });
    },
    async markRunMemoryOutcomeReported(runId, at) {
      await db.update(schema.runs).set({ memoryOutcomeReportedAt: at })
        .where(and(eq(schema.runs.id, runId), isNull(schema.runs.memoryOutcomeReportedAt)));
    },
    async listRunsAwaitingMemoryOutcome(before, limit) {
      return await db.query.runs.findMany({
        where: (r, { and, inArray, isNull, lt }) =>
          and(
            isNull(r.memoryOutcomeReportedAt),
            inArray(r.state, [...TERMINAL_STATES]),
            lt(r.updatedAt, before),
          ),
        orderBy: (r, { asc }) => [asc(r.updatedAt), asc(r.id)],
        limit,
      });
    },
    async listActiveRuns() {
      return await db.query.runs.findMany({
        where: (r, { inArray }) => inArray(r.state, liveStates),
      });
    },
    async countActiveRuns() {
      const [{ live }] = await db.select({ live: count() }).from(schema.runs)
        .where(inArray(schema.runs.state, liveStates));
      return live;
    },
    findLiveRunByOrigin: liveRunByOrigin,
    async findLiveRunOnChangeRequest(connectedRepoId, thread) {
      // The commanded reading first — one indexed filter, no join, and the common case.
      const commanded = await liveRunByOrigin({
        kind: "forge",
        connectedRepoId,
        threadKind: "change_request",
        ref: thread,
      });
      if (commanded !== null) return commanded;
      // Then the targeting reading, off the TASK. Answered through the task's denormalized
      // current attempt rather than a join onto runs: it is the same row the change request is
      // recorded on, and `current_run_state` is what keeps the read to the live ones — a change
      // request worked a hundred times must not be a hundred-row scan.
      //
      // EVERY live-targeting task, not the newest: that column is a denormalization, so a row
      // whose run has since ended is possible, and stopping at the first would answer "nobody
      // holds this" while an older run still does. Newest first all the same, so a follow-up
      // reaches the run it should.
      const rows = await db.query.tasks.findMany({
        where: (t) =>
          and(
            inArray(t.currentRunState, liveStates),
            sql`${t.targetChangeRequest} ->> 'connectedRepoId' = ${connectedRepoId}`,
            sql`${t.targetChangeRequest} ->> 'thread' = ${thread}`,
          ),
        orderBy: (t, { desc }) => [desc(t.createdAt), desc(t.id)],
      });
      if (rows.length === 0) return await liveRunThatOpened(connectedRepoId, thread);
      const liveRuns = await db.query.runs.findMany({
        where: (r) =>
          and(
            inArray(r.id, rows.map((t) => t.currentRunId)),
            inArray(r.state, liveStates),
          ),
      });
      const byId = new Map(liveRuns.map((r) => [r.id, r]));
      for (const row of rows) {
        const run = byId.get(row.currentRunId);
        if (run !== undefined) return run;
      }
      return await liveRunThatOpened(connectedRepoId, thread);
    },
    async countRunsStartedFromChatroom(chatroomId, since) {
      const [row] = await db.select({ n: count() }).from(schema.runs).where(and(
        eq(schema.runs.originChatroomId, chatroomId),
        gte(schema.runs.createdAt, since),
      ));
      return row.n;
    },
    async appendEvent(event) {
      await db.insert(schema.runEvents).values({
        runId: event.runId,
        at: event.at,
        kind: event.kind,
        detail: event.detail ?? null,
      });
    },
    async listEvents(runId) {
      const rows = await db.query.runEvents.findMany({
        where: (e, { eq }) => eq(e.runId, runId),
        orderBy: (e, { asc }) => [asc(e.seq)],
      });
      return rows.map(toEvent);
    },
    async hasRunEvent(runId, kind) {
      const row = await db.query.runEvents.findFirst({
        columns: { seq: true },
        where: (e, { and, eq }) => and(eq(e.runId, runId), eq(e.kind, kind)),
      });
      return row !== undefined;
    },
    async reserveCredentialSlot(runId, event, max) {
      // The count and the append have to land in one lock, the same reason `appendRunMessage`
      // takes it: two boot-credential requests racing for one run must not both read the count
      // before either's insert lands, or both pass a cap that only has room for one.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select "id" from "runs" where "id" = ${runId} for update`);
        const rows = rowsOf<{ n: number }>(
          await tx.execute(
            sql`select count(*)::int as "n" from "run_events"
                where "run_id" = ${runId} and "kind" = 'credentials-issued'
                  and coalesce("detail", '') not like 'mcp:%'`,
          ),
        );
        const issued = rows[0].n;
        if (issued >= max) return { reserved: false as const, issued };
        const [inserted] = await tx.insert(schema.runEvents).values({
          runId,
          at: event.at,
          kind: "credentials-issued",
          detail: event.detail ?? null,
        }).returning({ seq: schema.runEvents.seq });
        return { reserved: true as const, issued: issued + 1, seq: inserted.seq };
      });
    },
    async recordSkillsReport(runId, at, events) {
      // The claim and the appends are one transaction: the WHERE is the claim, so of two
      // reports racing for one run exactly one lands, and the loser appends nothing.
      return await db.transaction(async (tx) => {
        const claimed = await tx.update(schema.runs).set({ skillsReportedAt: at })
          .where(and(eq(schema.runs.id, runId), isNull(schema.runs.skillsReportedAt)))
          .returning({ id: schema.runs.id });
        if (claimed.length === 0) return false;
        if (events.length > 0) {
          await tx.insert(schema.runEvents).values(
            events.map((e) => ({ runId, at, kind: e.kind, detail: e.detail ?? null })),
          );
        }
        return true;
      });
    },
    async releaseCredentialSlot(runId, seq) {
      await db.delete(schema.runEvents).where(
        and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.seq, seq)),
      );
    },
    async appendRunMessage(message) {
      return await db.transaction(async (tx) => await appendMessageIn(tx, message));
    },
    async claimTaskPrompt(prompt, message) {
      return await db.transaction(async (tx) => {
        // The run's lock first, as every append takes it, so two first messages serialize here
        // and the second finds the instructions already set. Its state is read under the same
        // lock: a run that ended after the caller read it takes no prompt nobody will read.
        const [locked] = rowsOf<{ state: RunState }>(
          await tx.execute(
            sql`select "state" from "runs" where "id" = ${message.runId} for update`,
          ),
        );
        if (locked === undefined) return { kind: "taken" as const };
        if (TERMINAL_STATES.has(locked.state)) {
          return { kind: "terminal" as const, state: locked.state };
        }
        const claimed = await tx.update(schema.tasks)
          .set({ specInstructions: prompt.instructions, specTitle: prompt.title })
          .where(and(eq(schema.tasks.id, prompt.taskId), isNull(schema.tasks.specInstructions)))
          .returning({ id: schema.tasks.id });
        if (claimed.length === 0) return { kind: "taken" as const };
        // The work item takes the spec and the images too, narrowly: a re-run reads its images
        // off the work item (core/attachments.ts `readTaskStartImages`), and the spec read serves
        // what the run was asked.
        const spec = JSON.stringify({ title: prompt.title, instructions: prompt.instructions });
        const refs = JSON.stringify(message.attachments);
        await tx.execute(
          sql`update "runs" set "work_item" = jsonb_set(jsonb_set("work_item", '{spec}', ${spec}::jsonb), '{attachments}', ${refs}::jsonb) where "id" = ${message.runId}`,
        );
        const prompted = await appendMessageIn(tx, message);
        // A release made while the run waited owes its cue (`RepoLanding.releaseCueOwed`): right
        // after the prompt, in the same transaction, so the runner reads the prompt first and the
        // cue is never lost between the two. The task's row is this transaction's already.
        const [taskRow] = await tx.select({ landings: schema.tasks.landings })
          .from(schema.tasks).where(eq(schema.tasks.id, prompt.taskId));
        const owed = owedReleaseCues(
          taskRow?.landings ?? {},
          message.runId,
          message.createdAt,
        );
        if (owed !== null) {
          await tx.update(schema.tasks).set({ landings: owed.landings })
            .where(eq(schema.tasks.id, prompt.taskId));
          for (const cue of owed.cues) await appendMessageIn(tx, cue);
        }
        return { kind: "claimed" as const, message: prompted };
      });
    },
    async createUnclaimedAttachment(attachment, maxUnclaimed) {
      // The count and the insert under the run's row lock, as appendRunMessage takes its seq:
      // uploads to one run serialize on it, so the cap is a guarantee and not a hope. The lock
      // is the run's row, not a table lock: uploads to different runs never wait on each other.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select "id" from "runs" where "id" = ${attachment.runId} for update`);
        const [{ n }] = await tx.select({ n: count() }).from(schema.runAttachments).where(and(
          eq(schema.runAttachments.runId, attachment.runId),
          isNull(schema.runAttachments.claimedBy),
        ));
        if (n >= maxUnclaimed) return false;
        await tx.insert(schema.runAttachments).values(attachment);
        return true;
      });
    },
    async createAgentAttachment(attachment, limits) {
      // createUnclaimedAttachment's shape, counting and summing the agent's own rows instead: a
      // run's screenshots racing each other (the runner keeps at most two in flight) still
      // cannot overfill it, by count or by bytes.
      // The same ref is looked for under the same lock, so two uploads of one screenshot racing
      // each other write one row (the unique index is the backstop).
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select "id" from "runs" where "id" = ${attachment.runId} for update`);
        if (attachment.ref !== null) {
          const [existing] = await tx.select().from(schema.runAttachments).where(and(
            eq(schema.runAttachments.runId, attachment.runId),
            eq(schema.runAttachments.ref, attachment.ref),
          ));
          if (existing !== undefined) return { kind: "existing" as const, attachment: existing };
        }
        const { count: n, bytes } = await agentUsage(tx, attachment.runId);
        if (n >= limits.maxCount || bytes + attachment.bytes > limits.maxBytes) {
          return { kind: "full" as const };
        }
        await tx.insert(schema.runAttachments).values(attachment);
        return { kind: "created" as const };
      });
    },
    async agentAttachmentUsage(runId) {
      return await agentUsage(db, runId);
    },
    async agentAttachmentsByRefs(runId, refs) {
      if (refs.length === 0) return [];
      return await db.query.runAttachments.findMany({
        where: (a, { and, eq, inArray }) =>
          and(eq(a.runId, runId), eq(a.source, "agent"), inArray(a.ref, [...refs])),
      });
    },
    async getAttachment(id) {
      return await db.query.runAttachments.findFirst({ where: (a, { eq }) => eq(a.id, id) }) ??
        null;
    },
    async listAttachmentsByIds(ids) {
      if (ids.length === 0) return [];
      return await db.query.runAttachments.findMany({
        where: (a, { inArray }) => inArray(a.id, [...ids]),
      });
    },
    async countUnclaimedAttachments(runId) {
      const [{ n }] = await db.select({ n: count() }).from(schema.runAttachments).where(and(
        eq(schema.runAttachments.runId, runId),
        isNull(schema.runAttachments.claimedBy),
      ));
      return n;
    },
    async deleteUnclaimedAttachment(runId, id) {
      const [removed] = await db.delete(schema.runAttachments).where(and(
        eq(schema.runAttachments.id, id),
        eq(schema.runAttachments.runId, runId),
        isNull(schema.runAttachments.claimedBy),
      )).returning();
      return removed ?? null;
    },
    async listUnclaimedAttachmentsBefore(before, limit) {
      return await db.query.runAttachments.findMany({
        where: (a, { and, isNull, lt }) => and(isNull(a.claimedBy), lt(a.createdAt, before)),
        orderBy: (a, { asc }) => [asc(a.createdAt), asc(a.id)],
        limit,
      });
    },
    async listRunMessages(runId, afterSeq = -1, limit = DEFAULT_MESSAGE_PAGE) {
      const rows = await db.query.runMessages.findMany({
        where: (m, { and, eq, gt }) => and(eq(m.runId, runId), gt(m.seq, afterSeq)),
        orderBy: (m, { asc }) => [asc(m.seq)],
        limit,
      });
      return rows.map((row) => ({ ...row, payload: row.payload ?? null }));
    },
    async listRecentRunMessages(runId, limit) {
      // Newest first in SQL so the LIMIT takes the right end, then back into seq order: what a
      // reader wants is the tail of the conversation, not its first page.
      const rows = await db.query.runMessages.findMany({
        where: (m, { eq }) => eq(m.runId, runId),
        orderBy: (m, { desc }) => [desc(m.seq)],
        limit,
      });
      return rows.reverse().map((row) => ({ ...row, payload: row.payload ?? null }));
    },
    async markRunMessagesDelivered(runId, uptoSeq, at) {
      await db.update(schema.runMessages)
        .set({ deliveredAt: at })
        .where(and(
          eq(schema.runMessages.runId, runId),
          lte(schema.runMessages.seq, uptoSeq),
          isNull(schema.runMessages.deliveredAt),
        ));
    },
    async createResponse(response) {
      // Conditioned on the index: a second open response for one automation and key loses here,
      // and says so, rather than becoming a duplicate response nobody notices.
      // The predicate rides the conflict target: Postgres matches ON CONFLICT against a
      // PARTIAL index only when the specification carries the same WHERE, and refuses the
      // statement outright otherwise.
      const rows = await db.insert(schema.responses).values(response)
        .onConflictDoNothing({
          target: [schema.responses.automationId, schema.responses.key],
          where: sql`${schema.responses.state} <> 'closed'`,
        })
        .returning({ id: schema.responses.id });
      return rows.length === 1;
    },
    async getResponse(id) {
      const row = await db.query.responses.findFirst({ where: (r, { eq }) => eq(r.id, id) });
      return row ?? null;
    },
    async markResponseActivity(responseId, at, spoken) {
      const r = schema.responses;
      await db.update(r)
        .set(spoken ? { state: "attended", lastActivityAt: at } : { lastActivityAt: at })
        .where(and(eq(r.id, responseId), ne(r.state, "closed")));
    },
    async recordResponseAlert(responseId, alerts, at) {
      const r = schema.responses;
      await db.update(r).set({ alerts, lastAlertAt: at, lastActivityAt: at })
        .where(and(eq(r.id, responseId), ne(r.state, "closed")));
    },
    async closeResponse(responseId, at, reason) {
      const r = schema.responses;
      // `state <> 'closed'` is what keeps a person's reason: theirs landed first, and this
      // write — the run's conclusion — finds nothing to close.
      const rows = await db.update(r)
        .set({ state: "closed", closedAt: at, closedReason: reason, lastActivityAt: at })
        .where(and(eq(r.id, responseId), ne(r.state, "closed")))
        .returning({ id: r.id });
      return rows.length === 1;
    },
    async findOpenResponse(automationId, key) {
      const row = await db.query.responses.findFirst({
        where: (r, { and, eq, ne }) =>
          and(eq(r.automationId, automationId), eq(r.key, key), ne(r.state, "closed")),
        orderBy: (r, { desc }) => [desc(r.openedAt)],
      });
      return row ?? null;
    },
    async findResponseByRun(runId) {
      const row = await db.query.responses.findFirst({ where: (r, { eq }) => eq(r.runId, runId) });
      return row ?? null;
    },
    async listSharedResponses(automationId, exceptId, limit) {
      return await db.query.responses.findMany({
        where: (r, { and, eq, ne }) =>
          and(eq(r.automationId, automationId), eq(r.conversation, "shared"), ne(r.id, exceptId)),
        orderBy: (r, { desc }) => [desc(r.openedAt), desc(r.id)],
        limit,
      });
    },
    async listResponses(limit = DEFAULT_RESPONSE_PAGE, scope) {
      const scoped = taskScopeExists(db, scope, schema.responses.taskId);
      return await db.query.responses.findMany({
        where: scoped ?? undefined,
        orderBy: (r, { asc, desc }) => [desc(r.openedAt), asc(r.id)],
        limit,
      });
    },
    async listOpenResponses() {
      return await db.query.responses.findMany({
        where: (r, { ne }) => ne(r.state, "closed"),
        orderBy: (r, { asc }) => [asc(r.openedAt), asc(r.id)],
      });
    },
    async createGitKey(key) {
      await db.insert(schema.gitVirtualKeys).values(key);
    },
    async getGitKeyByTokenHash(tokenHash) {
      const row = await db.query.gitVirtualKeys.findFirst({
        where: (k, { eq }) => eq(k.tokenHash, tokenHash),
      });
      return row ?? null;
    },
    async revokeGitKeysForRun(runId, at) {
      await db.update(schema.gitVirtualKeys)
        .set({ revokedAt: at })
        .where(and(
          eq(schema.gitVirtualKeys.runId, runId),
          isNull(schema.gitVirtualKeys.revokedAt),
        ));
    },
    async saveInstallation(installation: GithubInstallation) {
      // Conflict target is the GitHub-side id: re-landing the install flow updates in place.
      await db.insert(schema.githubInstallations).values(installation)
        .onConflictDoUpdate({
          target: schema.githubInstallations.installationId,
          set: { accountLogin: installation.accountLogin },
        });
    },
    async getInstallationByInstallationId(installationId) {
      const row = await db.query.githubInstallations.findFirst({
        where: (i, { eq }) => eq(i.installationId, installationId),
      });
      return row ?? null;
    },
    async listInstallations() {
      return await db.query.githubInstallations.findMany({
        orderBy: (i, { asc, desc }) => [desc(i.createdAt), asc(i.id)],
      });
    },
    async createConnectedRepo({ forgeId: _, ...repo }) {
      await db.insert(schema.connectedRepos).values(repo);
    },
    async getConnectedRepo(id) {
      const row = await db.query.connectedRepos.findFirst({
        where: (r, { eq }) => eq(r.id, id),
      });
      if (row === undefined) return null;
      if (row.provider !== "gitlab") return row;
      const held = await db.query.gitlabProjects.findFirst({
        where: (g, { eq }) => eq(g.connectedRepoId, id),
      });
      return held === undefined
        ? row
        : { ...row, forgeId: gitlabProjectRef(held.instance, held.projectId) };
    },
    async listConnectedRepos() {
      const [rows, held] = await Promise.all([
        db.query.connectedRepos.findMany({
          orderBy: (r, { asc, desc }) => [desc(r.createdAt), asc(r.id)],
        }),
        db.query.gitlabProjects.findMany({
          columns: { connectedRepoId: true, projectId: true, instance: true },
        }),
      ]);
      const ids = new Map(
        held.map((g) => [g.connectedRepoId, gitlabProjectRef(g.instance, g.projectId)]),
      );
      return rows.map((r) => {
        const forgeId = r.provider === "gitlab" ? ids.get(r.id) : undefined;
        return forgeId === undefined ? r : { ...r, forgeId };
      });
    },
    // `forgeId` is gitlab_projects', read alongside; never written through the repo's row.
    async saveConnectedRepo({ forgeId: _, ...repo }) {
      await db.insert(schema.connectedRepos).values(repo)
        .onConflictDoUpdate({ target: schema.connectedRepos.id, set: repo });
    },
    async createWorkspace(workspace) {
      await db.insert(schema.workspaces).values(workspace);
    },
    async getWorkspace(id) {
      const row = await db.query.workspaces.findFirst({ where: (w, { eq }) => eq(w.id, id) });
      return row ?? null;
    },
    async listWorkspaces() {
      return await db.query.workspaces.findMany({
        orderBy: (w, { asc, desc }) => [desc(w.createdAt), asc(w.id)],
      });
    },
    async updateWorkspace(id, fields) {
      const updated = await db.update(schema.workspaces).set(fields)
        .where(and(eq(schema.workspaces.id, id), isNull(schema.workspaces.archivedAt)))
        .returning({ id: schema.workspaces.id });
      return updated.length > 0;
    },
    async touchWorkspace(id, at) {
      await db.update(schema.workspaces).set({ updatedAt: at })
        .where(eq(schema.workspaces.id, id));
    },
    async archiveWorkspace(id, at) {
      // The select builder, not db.query, for the one thing the relational API cannot say: FOR
      // UPDATE. The row lock is what serializes this against a concurrent addWorkspaceRepo, so
      // an add either lands before the archive (and is released by it) or sees it archived.
      return await db.transaction(async (tx) => {
        const [row] = await tx.select().from(schema.workspaces)
          .where(eq(schema.workspaces.id, id)).for("update");
        if (row === undefined) return null;
        let workspace = row;
        if (row.archivedAt === null) {
          workspace = { ...row, archivedAt: at, updatedAt: at };
          await tx.update(schema.workspaces).set({ archivedAt: at, updatedAt: at })
            .where(eq(schema.workspaces.id, id));
        }
        await tx.delete(schema.workspaceRepos).where(eq(schema.workspaceRepos.workspaceId, id));
        return workspace;
      });
    },
    async listWorkspaceRepos(workspaceId) {
      return await db.query.workspaceRepos.findMany({
        where: (r, { eq }) => eq(r.workspaceId, workspaceId),
        orderBy: (r, { asc }) => [asc(r.createdAt), asc(r.connectedRepoId)],
      });
    },
    async findWorkspaceRepo(connectedRepoId) {
      const row = await db.query.workspaceRepos.findFirst({
        where: (r, { eq }) => eq(r.connectedRepoId, connectedRepoId),
      });
      return row ?? null;
    },
    async addWorkspaceRepo(repo: WorkspaceRepo, maxMembers: number) {
      // Under the workspace's row lock, so the archived check and the count are true at the
      // insert: two adds racing for the last slot, or an add racing an archive, take turns.
      return await db.transaction(async (tx) => {
        const [workspace] = await tx.select({ archivedAt: schema.workspaces.archivedAt })
          .from(schema.workspaces).where(eq(schema.workspaces.id, repo.workspaceId))
          .for("update");
        if (workspace === undefined || workspace.archivedAt !== null) return "archived" as const;
        const [{ members }] = await tx.select({ members: count() }).from(schema.workspaceRepos)
          .where(eq(schema.workspaceRepos.workspaceId, repo.workspaceId));
        if (members >= maxMembers) return "full" as const;
        // The unique index on the connected repo is the "at most one workspace" rule, and
        // `returning` reports whether this insert was the one that landed — a repo joining
        // ANOTHER workspace holds a different row lock. The conflict target is THAT index and
        // no other: a raced duplicate path hits the (workspace, path) index and must throw, so
        // the caller can name the path rather than misreport it as "already in a workspace".
        const added = await tx.insert(schema.workspaceRepos).values(repo)
          .onConflictDoNothing({ target: schema.workspaceRepos.connectedRepoId })
          .returning({ connectedRepoId: schema.workspaceRepos.connectedRepoId });
        if (added.length === 0) return "taken" as const;
        await tx.update(schema.workspaces).set({ updatedAt: repo.createdAt })
          .where(eq(schema.workspaces.id, repo.workspaceId));
        return "added" as const;
      });
    },
    async saveWorkspaceRepo(repo) {
      const { workspaceId: _w, connectedRepoId: _c, createdAt: _born, ...revisable } = repo;
      await db.update(schema.workspaceRepos).set(revisable)
        .where(and(
          eq(schema.workspaceRepos.workspaceId, repo.workspaceId),
          eq(schema.workspaceRepos.connectedRepoId, repo.connectedRepoId),
        ));
    },
    async removeWorkspaceRepo(workspaceId, connectedRepoId) {
      await db.delete(schema.workspaceRepos).where(and(
        eq(schema.workspaceRepos.workspaceId, workspaceId),
        eq(schema.workspaceRepos.connectedRepoId, connectedRepoId),
      ));
    },
    async createGitlabProject(connectedRepoId, projectId, instance, at) {
      // One statement, so two connections of the same project at once still draw distinct
      // generations from the ones before them — and never one an old token was derived for, on
      // this instance or another (the token names no instance).
      const [row] = rowsOf<{ hook_generation: number }>(
        await db.execute(sql`
        insert into gitlab_projects
          (connected_repo_id, project_id, instance, hook_generation, last_hook_at, created_at,
            updated_at)
        select ${connectedRepoId}, ${projectId}, ${instance},
          coalesce((select max(hook_generation) from gitlab_projects
            where project_id = ${projectId}), 0) + 1,
          null, ${at}, ${at}
        returning hook_generation`),
      );
      return {
        connectedRepoId,
        projectId,
        instance,
        hookGeneration: Number(row!.hook_generation),
        lastHookAt: null,
        lastMergeRequestHookAt: null,
        droppedCommentHookCount: 0,
        droppedOtherHookCount: 0,
        lastDroppedHookAt: null,
        createdAt: at,
        updatedAt: at,
      };
    },
    async getGitlabProject(connectedRepoId) {
      const row = await db.query.gitlabProjects.findFirst({
        where: (g, { eq }) => eq(g.connectedRepoId, connectedRepoId),
      });
      return row ?? null;
    },
    async listGitlabProjectsById(projectId) {
      return await db.query.gitlabProjects.findMany({
        where: (g, { eq }) => eq(g.projectId, projectId),
        orderBy: (g, { desc }) => [desc(g.createdAt)],
      });
    },
    async rotateGitlabHook(connectedRepoId, at) {
      const g = schema.gitlabProjects;
      const [row] = await db.update(g)
        .set({
          hookGeneration: sql`${g.hookGeneration} + 1`,
          lastHookAt: null,
          lastMergeRequestHookAt: null,
          droppedCommentHookCount: 0,
          droppedOtherHookCount: 0,
          lastDroppedHookAt: null,
          updatedAt: at,
        })
        .where(eq(g.connectedRepoId, connectedRepoId))
        .returning();
      return row ?? null;
    },
    async recordGitlabHookDelivery(connectedRepoId, at, notBefore, mergeRequest) {
      const g = schema.gitlabProjects;
      await db.update(g).set({ lastHookAt: at })
        .where(and(
          eq(g.connectedRepoId, connectedRepoId),
          or(isNull(g.lastHookAt), lt(g.lastHookAt, notBefore)),
        ));
      if (!mergeRequest) return;
      await db.update(g).set({ lastMergeRequestHookAt: at })
        .where(and(
          eq(g.connectedRepoId, connectedRepoId),
          or(isNull(g.lastMergeRequestHookAt), lt(g.lastMergeRequestHookAt, notBefore)),
        ));
    },
    async recordGitlabHookDrops(connectedRepoId, lane, count, at) {
      const g = schema.gitlabProjects;
      await db.update(g)
        .set(
          lane === "comments"
            ? {
              droppedCommentHookCount: sql`${g.droppedCommentHookCount} + ${count}`,
              lastDroppedHookAt: at,
            }
            : {
              droppedOtherHookCount: sql`${g.droppedOtherHookCount} + ${count}`,
              lastDroppedHookAt: at,
            },
        )
        .where(eq(g.connectedRepoId, connectedRepoId));
    },
    async listRepoCommandAllowlist(connectedRepoId) {
      return await db.query.repoCommandAllowlist.findMany({
        where: (a, { eq }) => eq(a.connectedRepoId, connectedRepoId),
        orderBy: (a, { asc }) => [asc(a.createdAt), asc(a.subject)],
      });
    },
    async addRepoCommandAllowlistEntry(entry) {
      await db.insert(schema.repoCommandAllowlist).values(entry).onConflictDoNothing();
    },
    async removeRepoCommandAllowlistEntry(connectedRepoId, provider, subject) {
      await db.delete(schema.repoCommandAllowlist).where(and(
        eq(schema.repoCommandAllowlist.connectedRepoId, connectedRepoId),
        eq(schema.repoCommandAllowlist.provider, provider),
        eq(schema.repoCommandAllowlist.subject, subject),
      ));
    },
    async claimForgeEvent(record, reclaimProcessingBefore) {
      // One statement: the primary key IS the dedupe, and `returning` reports the winner.
      const claimed = await db.insert(schema.forgeEvents).values(record)
        .onConflictDoNothing()
        .returning({ deliveryId: schema.forgeEvents.deliveryId });
      if (claimed.length === 1) return true;
      if (reclaimProcessingBefore === undefined) return false;
      // The crash escape: adopt a "processing" claim whose handler evidently died — again
      // conditionally, so of two adopting redeliveries exactly one wins. `claimedAt` is both
      // the clock this fences on and the one adoption moves forward, so the adopted row is not
      // instantly stale again; `createdAt` stays where it was, at first sight of the delivery.
      const { deliveryId: _key, createdAt: _born, ...revisable } = record;
      const adopted = await db.update(schema.forgeEvents).set(revisable)
        .where(and(
          eq(schema.forgeEvents.deliveryId, record.deliveryId),
          eq(schema.forgeEvents.outcome, "processing"),
          lt(schema.forgeEvents.claimedAt, reclaimProcessingBefore),
        ))
        .returning({ deliveryId: schema.forgeEvents.deliveryId });
      return adopted.length === 1;
    },
    async getForgeEvent(deliveryId) {
      const row = await db.query.forgeEvents.findFirst({
        where: (e, { eq }) => eq(e.deliveryId, deliveryId),
      });
      return row ?? null;
    },
    async recordForgeEvent(record) {
      // A redelivery revises the verdict and nothing else: `createdAt` is first-seen, and
      // `claimedAt` belongs to whichever handler holds the claim.
      const { deliveryId: _key, createdAt: _born, claimedAt: _held, ...revisable } = record;
      await db.insert(schema.forgeEvents).values(record)
        .onConflictDoUpdate({ target: schema.forgeEvents.deliveryId, set: revisable });
    },
    async claimAutomationEvent(record, reclaimProcessingBefore) {
      // Mirrors claimForgeEvent one-for-one: insert as the dedupe, conditional adoption of a
      // stale "processing" claim as the crash escape.
      const claimed = await db.insert(schema.automationEvents).values(record)
        .onConflictDoNothing()
        .returning({ eventId: schema.automationEvents.eventId });
      if (claimed.length === 1) return true;
      if (reclaimProcessingBefore === undefined) return false;
      const { eventId: _key, createdAt: _born, ...revisable } = record;
      const adopted = await db.update(schema.automationEvents).set(revisable)
        .where(and(
          eq(schema.automationEvents.eventId, record.eventId),
          eq(schema.automationEvents.outcome, "processing"),
          lt(schema.automationEvents.claimedAt, reclaimProcessingBefore),
        ))
        .returning({ eventId: schema.automationEvents.eventId });
      return adopted.length === 1;
    },
    async recordAutomationEvent(record) {
      // The conflict update fires only while the stored row is still "processing": a verdict,
      // once recorded, is final, and a delivery that outlived its lease must not overwrite the
      // answer the winning delivery already wrote — least of all a "started" row's taskId.
      const { eventId: _key, createdAt: _born, claimedAt: _held, ...revisable } = record;
      await db.insert(schema.automationEvents).values(record)
        .onConflictDoUpdate({
          target: schema.automationEvents.eventId,
          set: revisable,
          setWhere: eq(schema.automationEvents.outcome, "processing"),
        });
    },
    async releaseAutomationEvent(eventId, claimedAt) {
      await db.delete(schema.automationEvents).where(and(
        eq(schema.automationEvents.eventId, eventId),
        eq(schema.automationEvents.outcome, "processing"),
        eq(schema.automationEvents.claimedAt, claimedAt),
      ));
    },
    async getAutomationEvent(eventId) {
      const row = await db.query.automationEvents.findFirst({
        where: (e, { eq }) => eq(e.eventId, eventId),
      });
      return row ?? null;
    },
    async getCommandRoom(chatroomId) {
      const row = await db.query.commandRooms.findFirst({
        where: (c, { eq }) => eq(c.chatroomId, chatroomId),
      });
      if (row === undefined) return null;
      const channels = await db.query.commandRoomChannels.findMany({
        where: (c, { eq }) => eq(c.chatroomId, chatroomId),
        orderBy: (c, { asc }) => [asc(c.channelName), asc(c.channelId)],
      });
      return {
        ...row,
        channels: channels.map(({ chatroomId: _room, ...channel }) => channel),
      };
    },
    async saveCommandRoom(room) {
      const { channels, ...policy } = room;
      const { chatroomId: _key, createdAt: _born, ...revisable } = policy;
      await db.transaction(async (tx) => {
        await tx.insert(schema.commandRooms).values(policy)
          .onConflictDoUpdate({ target: schema.commandRooms.chatroomId, set: revisable });
        await tx.delete(schema.commandRoomChannels)
          .where(eq(schema.commandRoomChannels.chatroomId, room.chatroomId));
        if (channels.length > 0) {
          await tx.insert(schema.commandRoomChannels)
            .values(channels.map((c) => ({ ...c, chatroomId: room.chatroomId })));
        }
      });
    },
    async deleteCommandRoom(chatroomId) {
      // The channel rows go with it — the foreign key cascades — so no reader can find a
      // channel row whose policy is gone.
      const deleted = await db.delete(schema.commandRooms)
        .where(eq(schema.commandRooms.chatroomId, chatroomId))
        .returning({ chatroomId: schema.commandRooms.chatroomId });
      return deleted.length === 1;
    },
    async claimChatMention(record, reclaimProcessingBefore) {
      // Mirrors claimForgeEvent: the unique pair is the dedupe, conditional adoption of a stale
      // "processing" claim the crash escape.
      const m = schema.chatMentions;
      const claimed = await db.insert(m).values(record)
        .onConflictDoNothing({ target: [m.chatroomId, m.messageId] })
        .returning({ messageId: m.messageId });
      if (claimed.length === 1) return true;
      if (reclaimProcessingBefore === undefined) return false;
      const { chatroomId: _room, messageId: _key, createdAt: _born, ...revisable } = record;
      const adopted = await db.update(m).set(revisable)
        .where(and(
          eq(m.chatroomId, record.chatroomId),
          eq(m.messageId, record.messageId),
          eq(m.outcome, "processing"),
          lt(m.claimedAt, reclaimProcessingBefore),
        ))
        .returning({ messageId: m.messageId });
      return adopted.length === 1;
    },
    async recordChatMention(record) {
      const m = schema.chatMentions;
      const {
        chatroomId: _room,
        messageId: _key,
        createdAt: _born,
        claimedAt: _held,
        ...revisable
      } = record;
      await db.insert(m).values(record)
        .onConflictDoUpdate({
          target: [m.chatroomId, m.messageId],
          set: revisable,
          setWhere: eq(m.outcome, "processing"),
        });
    },
    async saveProgressComment(comment) {
      const { runId: _key, createdAt: _born, ...revisable } = comment;
      await db.insert(schema.progressComments).values(comment)
        .onConflictDoUpdate({ target: schema.progressComments.runId, set: revisable });
    },
    async listOpenProgressComments() {
      return await db.query.progressComments.findMany({
        where: (c, { isNull }) => isNull(c.concludedAt),
      });
    },
    async reserveForgeToolAction(action, max) {
      // Counted and inserted under a row lock on the run, for appendRunMessage's reason: a
      // count-then-insert without it lets two writes racing for the last slot both see room.
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select "id" from "runs" where "id" = ${action.runId} for update`);
        const [held] = await tx.select({ n: count() }).from(schema.forgeToolActions).where(and(
          eq(schema.forgeToolActions.runId, action.runId),
          eq(schema.forgeToolActions.tool, action.tool),
        ));
        if (held.n >= max) return false;
        await tx.insert(schema.forgeToolActions).values(action);
        return true;
      });
    },
    async completeForgeToolAction(id, runId, outcome) {
      const settled = await db.update(schema.forgeToolActions).set(outcome)
        .where(and(
          eq(schema.forgeToolActions.id, id),
          eq(schema.forgeToolActions.runId, runId),
          eq(schema.forgeToolActions.state, "reserved"),
        ))
        .returning({ id: schema.forgeToolActions.id });
      return settled.length === 1;
    },
    async listForgeToolActions(runId) {
      return await db.query.forgeToolActions.findMany({
        where: (a, { eq }) => eq(a.runId, runId),
        orderBy: (a, { asc }) => [asc(a.createdAt), asc(a.id)],
      });
    },
    async createPatch(patch, opts) {
      const cap = opts?.maxLinesPerRepo;
      return await db.transaction(async (tx) => {
        // Exclusive under a cap: two births of new lines of one run then count one after the
        // other, and never both see room for one more.
        await tx.select({ id: schema.runs.id }).from(schema.runs)
          .where(eq(schema.runs.id, patch.runId)).for(cap === undefined ? "share" : "update");
        if (cap !== undefined) {
          const p = schema.patches;
          const rows = await tx.selectDistinct({ line: p.line }).from(p).where(and(
            eq(p.runId, patch.runId),
            eq(p.connectedRepoId, patch.connectedRepoId),
            eq(p.path, patch.path),
          ));
          const lines = rows.map((r) => r.line);
          if (!lines.includes(patch.line) && lines.length >= cap) return false;
        }
        await tx.insert(schema.patches).values({ ...patch, version: 0 });
        return true;
      });
    },
    async getPatch(id) {
      const row = await db.query.patches.findFirst({ where: (p, { eq }) => eq(p.id, id) });
      return row ?? null;
    },
    async listPatchesByIds(ids) {
      if (ids.length === 0) return [];
      return await db.query.patches.findMany({
        where: (p, { inArray }) => inArray(p.id, [...ids]),
      });
    },
    async savePatch(patch) {
      const { version: _read, ...fields } = patch;
      await db.insert(schema.patches).values({ ...patch, version: 0 })
        .onConflictDoUpdate({
          target: schema.patches.id,
          set: { ...fields, version: sql`${schema.patches.version} + 1` },
        });
    },
    async settlePatchIf(patch, from, events, opts) {
      // The WHERE is the verdict the caller read, so of two deliveries of the same verdict only
      // one writes it — and its events with it, or neither.
      return await db.transaction(async (tx) => {
        const settled = await tx.update(schema.patches)
          .set({
            landed: patch.landed,
            memoryFateReportedAt: patch.memoryFateReportedAt,
            mergedCuedAt: patch.mergedCuedAt,
            mergedCueClaimedAt: patch.mergedCueClaimedAt,
            landingAskedAt: patch.landingAskedAt,
            updatedAt: patch.updatedAt,
            version: sql`${schema.patches.version} + 1`,
          })
          .where(and(
            eq(schema.patches.id, patch.id),
            eq(schema.patches.state, "submitted"),
            from === null
              ? isNull(schema.patches.landed)
              : sql`${schema.patches.landed} ->> 'kind' = ${from}`,
            opts?.unlessMergeRecorded === true
              ? sql`not exists (select 1 from change_request_merges m
                where m.connected_repo_id = ${schema.patches.connectedRepoId}
                and m.forge_ref = ${schema.patches.forgeRef})`
              : undefined,
          ))
          .returning({ id: schema.patches.id });
        if (settled.length !== 1) return false;
        for (const event of events) {
          await tx.insert(schema.runEvents).values({
            runId: event.runId,
            at: event.at,
            kind: event.kind,
            detail: event.detail ?? null,
          });
        }
        return true;
      });
    },
    async markMissedProven(patchId, at) {
      const p = schema.patches;
      const written = await db.update(p)
        .set({
          landed: sql`${p.landed} - 'unproven'`,
          updatedAt: at,
          version: sql`${p.version} + 1`,
        })
        .where(and(
          eq(p.id, patchId),
          sql`${p.landed} ->> 'kind' = 'missed'`,
          sql`${p.landed} ->> 'unproven' = 'true'`,
        ))
        .returning({ id: p.id });
      return written.length === 1;
    },
    async claimMergedCue(patchId, at, staleBefore) {
      const claimed = await db.update(schema.patches).set({ mergedCueClaimedAt: at })
        .where(and(
          eq(schema.patches.id, patchId),
          isNull(schema.patches.mergedCuedAt),
          sql`(${schema.patches.mergedCueClaimedAt} is null or ${schema.patches.mergedCueClaimedAt} < ${staleBefore})`,
        ))
        .returning({ id: schema.patches.id });
      return claimed.length === 1;
    },
    async markPatchMergedCued(patchId, at, read) {
      // The WHERE is the verdict the caller cued, and its claim: a revision clears both.
      const marked = await db.update(schema.patches).set({ mergedCuedAt: at })
        .where(and(
          eq(schema.patches.id, patchId),
          isNull(schema.patches.mergedCuedAt),
          sql`${schema.patches.landed} ->> 'kind' = ${read.kind}`,
          ...(read.claimedAt === undefined
            ? []
            : [eq(schema.patches.mergedCueClaimedAt, read.claimedAt)]),
        ))
        .returning({ id: schema.patches.id });
      return marked.length === 1;
    },
    async markMergedCuesOfEndedRuns(limit, at) {
      const p = schema.patches;
      // The subselect walks `patches_awaiting_merged_cue` (its predicate, its order) and skips a
      // row whose run is live by `runs`' primary key; the outer condition is asked again on the
      // row, so a cue marked meanwhile is left as it is.
      const due = db.select({ id: p.id }).from(p)
        .where(and(
          isNull(p.mergedCuedAt),
          sql`${p.landed} ->> 'kind' in ('merged', 'missed')`,
          notExists(
            db.select({ one: sql`1` }).from(schema.runs)
              .where(and(eq(schema.runs.id, p.runId), inArray(schema.runs.state, liveStates))),
          ),
        ))
        .orderBy(p.createdAt)
        .limit(limit);
      const marked = await db.update(p).set({ mergedCuedAt: at })
        .where(and(inArray(p.id, due), isNull(p.mergedCuedAt)))
        .returning({ id: p.id });
      return marked.length;
    },
    async markPatchFateReported(patch, at) {
      await db.update(schema.patches).set({ memoryFateReportedAt: at })
        .where(and(
          eq(schema.patches.id, patch.id),
          eq(schema.patches.state, patch.state),
          patch.landed === null
            ? isNull(schema.patches.landed)
            : sql`${schema.patches.landed} ->> 'kind' = ${patch.landed.kind}`,
        ));
    },
    async savePatchIfState(patch, expected, lease, readVersion, events = []) {
      // One statement, so the read and the write cannot be separated by another submitter:
      // the WHERE is the claim. `returning` reports whether this caller won it.
      const {
        version: _read,
        memoryFateReportedAt: _ack,
        mergedCuedAt: _cued,
        mergedCueClaimedAt: _claim,
        landingAskedAt: _asked,
        ...fields
      } = patch;
      return await db.transaction(async (tx) => {
        const claimed = await tx.update(schema.patches)
          .set({ ...fields, version: sql`${schema.patches.version} + 1` })
          .where(and(
            eq(schema.patches.id, patch.id),
            inArray(schema.patches.state, [...expected]),
            ...(lease === undefined ? [] : [eq(schema.patches.leaseExpiresAt, lease)]),
            ...(readVersion === undefined ? [] : [eq(schema.patches.version, readVersion)]),
          ))
          .returning({ version: schema.patches.version });
        const version = claimed[0]?.version ?? null;
        if (version === null) return null;
        // With the write or not at all: a transition whose trail a crash lost is one a
        // redelivery, seeing the row already moved, would never write again.
        for (const event of events) {
          await tx.insert(schema.runEvents).values({
            runId: event.runId,
            at: event.at,
            kind: event.kind,
            detail: event.detail ?? null,
          });
        }
        return version;
      });
    },
    async listPatchesAwaitingMergedCue(limit, claimStaleBefore) {
      const rows = await db.select({ patch: schema.patches }).from(schema.patches)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.patches.runId))
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.patches.taskId))
        .where(and(
          isNull(schema.patches.mergedCuedAt),
          sql`${schema.patches.landed} ->> 'kind' in ('merged', 'missed')`,
          sql`(${schema.patches.mergedCueClaimedAt} is null or ${schema.patches.mergedCueClaimedAt} < ${claimStaleBefore})`,
          inArray(schema.runs.state, liveStates),
          verdictFinal(schema.patches),
          // `hasLanding`: the cue carries the recorded landing of its line, so it waits for one —
          // under the line's key (`landingKey`: another line's landing is its own run's alone).
          sql`(${schema.tasks.landings} -> ${schema.patches.path} -> ${
            landingKeySql(schema.patches.line, schema.patches.runId)
          } ->> 'generation')::int >= ${schema.patches.generation}`,
          sql`(${schema.tasks.landings} -> ${schema.patches.path} -> ${
            landingKeySql(schema.patches.line, schema.patches.runId)
          } ->> 'connectedRepoId') = ${schema.patches.connectedRepoId}`,
        ))
        .orderBy(schema.patches.createdAt, schema.patches.id)
        .limit(limit);
      return rows.map((r) => r.patch);
    },
    async recordChangeRequestMerge({ connectedRepoId, forgeRef, mergedInto, heads, at }) {
      const m = schema.changeRequestMerges;
      const key = and(eq(m.connectedRepoId, connectedRepoId), eq(m.forgeRef, forgeRef));
      return await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
          // A first merge's insert, or nothing when one is there; then the row, locked, so two
          // deliveries growing its heads at once never lose each other's.
          await tx.insert(m).values({
            connectedRepoId,
            forgeRef,
            mergedInto: mergedInto ?? null,
            heads: [],
            mergedAt: at,
          }).onConflictDoNothing();
          const [row] = await tx.select().from(m).where(key).for("update");
          if (row === undefined) throw new Error(`merge record ${forgeRef} vanished`);
          const grown = grownHeads(row.heads, heads);
          const next = {
            ...row,
            mergedInto: row.mergedInto ?? mergedInto ?? null,
            ...(grown === null ? {} : {
              heads: grown,
              version: row.version + 1,
              settledAt: null,
              attempts: 0,
              nextAskAt: null,
            }),
          };
          if (grown !== null || next.mergedInto !== row.mergedInto) {
            await tx.update(m).set({
              mergedInto: next.mergedInto,
              heads: next.heads,
              version: next.version,
              settledAt: next.settledAt,
              attempts: next.attempts,
              nextAskAt: next.nextAskAt,
            }).where(key);
          }
          return next;
        })
      );
    },
    async getChangeRequestMerge(connectedRepoId, forgeRef) {
      const m = schema.changeRequestMerges;
      const [row] = await db.select().from(m)
        .where(and(eq(m.connectedRepoId, connectedRepoId), eq(m.forgeRef, forgeRef)));
      return row ?? null;
    },
    async stampChangeRequestMerge(connectedRepoId, forgeRef, read, mark) {
      const m = schema.changeRequestMerges;
      const stamped = await db.update(m)
        .set({
          settledAt: mark.settledAt,
          attempts: mark.attempts,
          nextAskAt: mark.nextAskAt,
          ...(mark.asking === true ? { version: sql`${m.version} + 1` } : {}),
        })
        .where(and(
          eq(m.connectedRepoId, connectedRepoId),
          eq(m.forgeRef, forgeRef),
          eq(m.version, read.version),
          read.settledAt === null ? isNull(m.settledAt) : eq(m.settledAt, read.settledAt),
          read.nextAskAt === null ? isNull(m.nextAskAt) : eq(m.nextAskAt, read.nextAskAt),
        ))
        .returning({ forgeRef: m.forgeRef });
      return stamped.length === 1;
    },
    async listTasksTargetingChangeRequest(connectedRepoId, thread) {
      // Served by `tasks_by_target_change_request` (partial: tasks that target one).
      const rows = await db.select().from(schema.tasks)
        .where(and(
          isNotNull(schema.tasks.targetChangeRequest),
          sql`(${schema.tasks.targetChangeRequest} ->> 'connectedRepoId') = ${connectedRepoId}`,
          sql`(${schema.tasks.targetChangeRequest} ->> 'thread') = ${thread}`,
        ))
        .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id));
      return rows.map(toTask);
    },
    async releaseMergedTarget({ taskId, connectedRepoId, thread, mergedInto, defaultBranch, at }) {
      // A new attempt started between the peek and the locks is asked again, a few times.
      for (let attempt = 0; attempt < 3; attempt++) {
        const released = await releaseOnce();
        if (released !== null) return released;
      }
      throw new Error(
        `task ${taskId} kept moving on to new runs; its release is asked again later`,
      );

      function releaseOnce(): Promise<
        { outcome: ReleaseOutcome; cuedRunId: string | null } | null
      > {
        return retryOnDeadlock(() =>
          db.transaction(async (tx) => {
            // The current run's row, then the task's: `landMerge`'s order, so the two never
            // deadlock. The current run is read first unlocked to know which row to lock, and the
            // task's, once locked, must still name it: a new attempt in between is asked again.
            const [peek] = await tx.select({ currentRunId: schema.tasks.currentRunId })
              .from(schema.tasks).where(eq(schema.tasks.id, taskId));
            if (peek === undefined) return { outcome: { kind: "none" as const }, cuedRunId: null };
            const [runRow] = await tx.select().from(schema.runs)
              .where(eq(schema.runs.id, peek.currentRunId)).for("update");
            const [taskRow] = await tx.select().from(schema.tasks)
              .where(eq(schema.tasks.id, taskId)).for("update");
            if (taskRow === undefined) {
              return { outcome: { kind: "none" as const }, cuedRunId: null };
            }
            if (taskRow.currentRunId !== peek.currentRunId) return null;
            const live = runRow !== undefined && !TERMINAL_STATES.has(runRow.state);
            // Read under the run's lock: a patch of the run's reaching the change request is its
            // landing's to let go, and the release stands aside.
            const runPatches = await tx.select(releaseColumns).from(schema.patches)
              .where(and(
                eq(schema.patches.runId, taskRow.currentRunId),
                eq(schema.patches.connectedRepoId, connectedRepoId),
              ));
            const outcome = releaseMergedTarget({
              task: toTask(taskRow),
              run: live ? runRow : null,
              runId: taskRow.currentRunId,
              hasPatch: runPatches.some((p) => p.forgeRef === thread),
              runPatches,
              connectedRepoId,
              thread,
              mergedInto,
              defaultBranch,
              at,
            });
            if (outcome.kind === "none") return { outcome, cuedRunId: null };
            // A live run awaiting its prompt takes no message before it (core/inbox.ts): its cue
            // is owed on the landing, and the prompt's transaction appends it after the prompt
            // (`claimTaskPrompt`). Read under the run's lock, which the prompt takes first too.
            const deferred = outcome.kind === "moved" && live &&
              runRow.workItem.spec.instructions === null;
            // A release lands the default line only (core/landing.ts `releaseMergedTarget`).
            const released = outcome.kind === "moved"
              ? outcome.task.landings[outcome.path]?.[DEFAULT_LINE]
              : undefined;
            const landings = deferred && released !== undefined
              ? {
                ...outcome.task.landings,
                [outcome.path]: {
                  ...outcome.task.landings[outcome.path],
                  [DEFAULT_LINE]: { ...released, releaseCueOwed: true as const },
                },
              }
              : outcome.task.landings;
            await tx.update(schema.tasks)
              .set({
                repos: outcome.task.repos,
                targetChangeRequest: outcome.task.targetChangeRequest,
                landings,
                ...(outcome.kind === "moved" && outcome.run !== null
                  ? { lastActivityAt: outcome.run.updatedAt }
                  : {}),
              })
              .where(eq(schema.tasks.id, taskId));
            if (outcome.kind === "moved" && outcome.run !== null) {
              await tx.update(schema.runs)
                .set({ workItem: outcome.run.workItem, updatedAt: outcome.run.updatedAt })
                .where(
                  and(eq(schema.runs.id, outcome.run.id), inArray(schema.runs.state, liveStates)),
                );
            }
            await tx.insert(schema.runEvents).values({
              runId: outcome.event.runId,
              at: outcome.event.at,
              kind: outcome.event.kind,
              detail: outcome.event.detail ?? null,
            });
            // The release cue, with the release: never lost to a crash after the commit.
            if (outcome.kind !== "moved" || !live || deferred) return { outcome, cuedRunId: null };
            await appendMessageIn(
              tx,
              releaseCueMessage({
                runId: runRow.id,
                path: outcome.path,
                onto: outcome.onto,
                generation: outcome.generation,
                thread,
                at,
              }),
            );
            return { outcome, cuedRunId: runRow.id };
          })
        );
      }
    },
    async listMergesOwingRelease(now, limit) {
      // Served by `change_request_merges_owing_release` (partial: releases not yet made), in its
      // order: never retried first, then the earliest retry, each by merge.
      const m = schema.changeRequestMerges;
      return await db.select().from(m)
        .where(and(
          isNull(m.releasedAt),
          or(isNull(m.releaseRetryAt), lte(m.releaseRetryAt, now)),
        ))
        .orderBy(
          sql`${m.releaseRetryAt} asc nulls first`,
          m.mergedAt,
          m.connectedRepoId,
          m.forgeRef,
        )
        .limit(limit);
    },
    async deferMergeRelease(connectedRepoId, forgeRef, until) {
      const m = schema.changeRequestMerges;
      await db.update(m).set({ releaseRetryAt: until })
        .where(and(
          eq(m.connectedRepoId, connectedRepoId),
          eq(m.forgeRef, forgeRef),
          isNull(m.releasedAt),
        ));
    },
    async markMergeReleased(connectedRepoId, forgeRef, at) {
      const m = schema.changeRequestMerges;
      await db.update(m).set({ releasedAt: at })
        .where(
          and(
            eq(m.connectedRepoId, connectedRepoId),
            eq(m.forgeRef, forgeRef),
            isNull(m.releasedAt),
          ),
        );
    },
    async listChangeRequestMergesDue(now, limit) {
      // Two arms, each index-driven. The clock's: `change_request_merges_due` (partial: unsettled,
      // or a clock set), ranged on the clock. The late push's: `patches_unsettled` (submitted, no
      // verdict) walked, and each patch's record looked up by the record's unique key — a nested
      // loop of index probes, never a scan of every record ever merged.
      // Never asked (no clock) first, the freshest merge first among them, so a backlog never
      // keeps a merge just heard waiting; then the earliest clock that made one due.
      const rows = rowsOf<{ connected_repo_id: string; forge_ref: string }>(
        await db.execute(sql`
        with due as (
          select connected_repo_id, forge_ref, next_ask_at as due_at, merged_at
          from change_request_merges
          where (settled_at is null or next_ask_at is not null)
            and (next_ask_at is null or next_ask_at <= ${now})
          union all
          select m.connected_repo_id, m.forge_ref, m.next_ask_at, m.merged_at from patches p
          cross join lateral (
            select connected_repo_id, forge_ref, next_ask_at, settled_at, merged_at
            from change_request_merges
            where connected_repo_id = p.connected_repo_id and forge_ref = p.forge_ref
            limit 1
          ) m
          where p.state = 'submitted' and p.landed is null and p.forge_ref is not null
            and m.settled_at is not null and (m.next_ask_at is null or m.next_ask_at <= ${now})
        )
        select connected_repo_id, forge_ref from due
        group by connected_repo_id, forge_ref
        order by bool_or(due_at is null) desc,
          max(merged_at) filter (where due_at is null) desc nulls last,
          min(due_at) asc, connected_repo_id, forge_ref
        limit ${limit}`),
      );
      // Each row read whole through the table's own mapping, by its unique key: a handful a tick.
      // Its clock is checked again in the read: another sweep's ask may have claimed the record
      // since the keys were picked, and a row read after that claim is not due.
      const m = schema.changeRequestMerges;
      const out: ChangeRequestMerge[] = [];
      for (const row of rows) {
        const [merge] = await db.select().from(m).where(and(
          eq(m.connectedRepoId, row.connected_repo_id),
          eq(m.forgeRef, row.forge_ref),
          or(isNull(m.nextAskAt), lte(m.nextAskAt, now)),
        ));
        if (merge !== undefined) out.push(merge);
      }
      return out;
    },
    async listPatchesAwaitingLanding(limit, settledBefore) {
      const p = schema.patches;
      // Served by `patches_awaiting_landing` (partial: merged or missed, landing owed), which
      // holds only what a failure left behind.
      return await db.select().from(p)
        .where(and(
          isNull(p.landingAskedAt),
          sql`${p.landed} ->> 'kind' in ('merged', 'missed')`,
          sql`(${p.landed} ->> 'at') < ${settledBefore}`,
          verdictFinal(p),
        ))
        .orderBy(p.createdAt, p.id)
        .limit(limit);
    },
    async listChangeRequestsDueMergePoll(now, closedSince, limit, polled, gitlab = null) {
      // Two arms, so each one's predicate is a partial index's: `patches_unsettled` (submitted,
      // no verdict) and `patches_closed_by_time` (submitted, closed, ranged on when) — never a
      // walk over every submitted patch ever. The joins on the keys of `connected_repos` and
      // `merge_polls`; a change request whose merge is recorded is the settle's, never asked
      // again (its unique key). Only the polled providers' repos: a GitHub one with user mode's
      // tenant (none), and a GitLab one whose project is on the instance the forge runs now
      // (`gitlab_projects` by its key) — one stranded on another is never asked, so listed it
      // would hold the head of the queue.
      const gitlabPolled = gitlab !== null && (polled.includes("gitlab") || gitlab.bot);
      const rows = rowsOf<{
        connected_repo_id: string;
        forge_ref: string;
        failures: number | null;
        gone: number | null;
        open: boolean;
        asked: boolean;
      }>(
        await db.execute(sql`
        with cr as (
          select connected_repo_id, forge_ref, true as open from patches
          where state = 'submitted' and landed is null and forge_ref is not null
          union all
          select connected_repo_id, forge_ref, false as open from patches
          where state = 'submitted' and landed ->> 'kind' = 'closed'
            and (landed ->> 'at') >= ${closedSince} and forge_ref is not null
          union all
          select m.connected_repo_id, m.forge_ref, true as open from merge_polls m
          where ${workedLive(sql`m.connected_repo_id`, sql`m.forge_ref`)}
        )
        select cr.connected_repo_id, cr.forge_ref, m.failures, m.gone, bool_or(cr.open) as open,
          m.due_at is not null as asked
        from cr
        join connected_repos r on r.id = cr.connected_repo_id
        left join merge_polls m
          on m.connected_repo_id = cr.connected_repo_id and m.forge_ref = cr.forge_ref
        where ((r.provider = 'github' and r.installation_id is null
            and ${polled.includes("github")}::boolean)
          or (r.provider = 'gitlab' and ${gitlabPolled}::boolean
            and exists (select 1 from gitlab_projects g
              where g.connected_repo_id = r.id and g.instance = ${gitlab?.instance ?? ""})))
          and r.archived_at is null
          and (m.due_at is null or m.due_at <= ${now})
          and not exists (select 1 from change_request_merges cm
            where cm.connected_repo_id = cr.connected_repo_id and cm.forge_ref = cr.forge_ref)
        group by cr.connected_repo_id, cr.forge_ref, m.due_at, m.failures, m.gone
        order by m.due_at asc nulls first, cr.connected_repo_id, cr.forge_ref
        limit ${limit}`),
      );
      return rows.map((row) => ({
        connectedRepoId: row.connected_repo_id,
        forgeRef: row.forge_ref,
        failures: row.failures ?? 0,
        gone: row.gone ?? 0,
        open: row.open === true,
        asked: row.asked === true,
      }));
    },
    async stampMergePoll(connectedRepoId, forgeRef, { dueAt, failures, gone }) {
      await db.insert(schema.mergePolls)
        .values({ connectedRepoId, forgeRef, dueAt, failures, gone })
        .onConflictDoUpdate({
          target: [schema.mergePolls.connectedRepoId, schema.mergePolls.forgeRef],
          set: { dueAt, failures, gone },
        });
    },
    async pruneMergePolls(closedSince, limit) {
      // The patches through `patches_by_repo_and_forge_ref`.
      const removed = await db.execute(sql`
        delete from merge_polls where (connected_repo_id, forge_ref) in (
          select m.connected_repo_id, m.forge_ref from merge_polls m
          where not exists (select 1 from patches p where p.connected_repo_id = m.connected_repo_id
            and p.forge_ref = m.forge_ref and p.state = 'submitted'
            and (p.landed is null or (p.landed ->> 'kind' = 'closed'
              and (p.landed ->> 'at') >= ${closedSince})))
            and not ${workedLive(sql`m.connected_repo_id`, sql`m.forge_ref`)}
          limit ${limit})
        returning connected_repo_id`);
      return rowsOf(removed).length;
    },
    async listPatchesDueLandingRule(limit) {
      const p = schema.patches;
      // `landedVerdict` in SQL, for the patches the reconcile rules (`isRuledByLanding`, less
      // `submitting`, which the sweep holding it rules). Inside the subqueries `patches` names
      // the OUTER row: the inner ones are aliased. The merged sibling is found through
      // `patches_merged_by_branch` (partial, merged rows only), the newer one through
      // `patches_by_run`. A missed sibling counts as a merged one: its change request merged.
      const rows = await db.select().from(p)
        .where(and(
          or(
            inArray(p.state, ["pending_approval", "queued"]),
            and(eq(p.state, "failed"), isNotNull(p.nextAttemptAt)),
          ),
          // A sibling's verdict ended the generation of its line, or a landing recorded at it or
          // later did (`hasLanding`: the task's landing at the path and the line's key,
          // `landingKey`, by its primary key) — a release's among them.
          sql`(exists (select 1 from patches m where m.run_id = ${p.runId}
            and m.connected_repo_id = ${p.connectedRepoId} and m.path = ${p.path}
            and m.line = ${p.line} and m.generation = ${p.generation} and m.id <> ${p.id}
            and m.landed ->> 'kind' in ('merged', 'missed'))
            or exists (select 1 from tasks t where t.id = ${p.taskId}
            and t.landings -> ${p.path} -> ${
            landingKeySql(p.line, p.runId)
          } ->> 'connectedRepoId' = ${p.connectedRepoId}
            and (t.landings -> ${p.path} -> ${
            landingKeySql(p.line, p.runId)
          } ->> 'generation')::int >= ${p.generation}))`,
          sql`(${p.heldReason} is null or not ${inArray(p.heldReason, [...LANDING_HOLD_REASONS])}
            or exists (select 1 from patches n
            where n.run_id = ${p.runId} and n.connected_repo_id = ${p.connectedRepoId}
            and n.path = ${p.path} and n.line = ${p.line} and n.id <> ${p.id}
            and n.state not in ('rejected', 'superseded')
            and (n.landed is null or n.landed ->> 'kind' not in ('closed', 'missed'))
            and not (n.state = 'failed' and n.next_attempt_at is null)
            and (n.generation > ${p.generation} or (n.generation = ${p.generation}
              and n.created_at > ${p.createdAt}
              and (n.state in ('pending_approval', 'queued', 'failed')
                or n.landed ->> 'kind' = 'merged')))))`,
        ))
        .orderBy(p.createdAt, p.id)
        .limit(limit);
      return rows;
    },
    async listPatches(query) {
      const limit = clampPageLimit(query?.limit);
      const filters: SQL[] = [];
      const after = decodeListCursor(query?.cursor);
      if (after !== null) {
        filters.push(
          sql`(${schema.patches.createdAt}, ${schema.patches.id}) < (${after.createdAt}, ${after.id})`,
        );
      }
      if (query?.state !== undefined) filters.push(eq(schema.patches.state, query.state));
      const scoped = taskScopeExists(db, query?.scope, schema.patches.taskId);
      if (scoped !== null) filters.push(scoped);
      const rows = await db.query.patches.findMany({
        where: filters.length === 0 ? undefined : and(...filters),
        orderBy: (p, { desc }) => [desc(p.createdAt), desc(p.id)],
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        patches: page,
        nextCursor: rows.length > limit && last !== undefined ? encodeListCursor(last) : null,
      };
    },
    async listPatchesAwaitingHookCheck() {
      const local = db.select({ id: schema.connectedRepos.id }).from(schema.connectedRepos)
        .where(eq(schema.connectedRepos.provider, "local"));
      return await db.query.patches.findMany({
        where: (p, { and, inArray, isNull }) =>
          and(
            inArray(p.state, ["pending_approval", "queued"]),
            isNull(p.hookCheck),
            inArray(p.connectedRepoId, local),
          ),
      });
    },
    async listActivePatches() {
      return await db.query.patches.findMany({
        // A failure with no clock waits on a person's retry, like an approval: not the sweep's.
        where: (p, { and, inArray, isNotNull, ne, or }) =>
          and(
            inArray(p.state, [...SWEEPABLE_PATCH_STATES]),
            or(ne(p.state, "failed"), isNotNull(p.nextAttemptAt)),
          ),
      });
    },
    async patchesForTask(taskId) {
      return await db.query.patches.findMany({
        where: (p, { eq }) => eq(p.taskId, taskId),
        orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
      });
    },
    async patchesForSet(setId) {
      return await db.query.patches.findMany({
        where: (p, { eq }) => eq(p.setId, setId),
        orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
      });
    },
    async findPatchByRepoAndHead(connectedRepoId, headSha) {
      const row = await db.query.patches.findFirst({
        where: (p, { and, eq }) =>
          and(eq(p.connectedRepoId, connectedRepoId), eq(p.headSha, headSha)),
        orderBy: (p, { desc }) => [desc(p.createdAt)],
      });
      return row ?? null;
    },
    async patchesByRepoAndForgeRef(connectedRepoId, forgeRef) {
      // No state filter: `forgeRef` is set only on submission, and a patch that already settled
      // must still be findable — a reopened pull request's merge is a second webhook for it.
      return await db.query.patches.findMany({
        where: (p, { and, eq }) =>
          and(eq(p.connectedRepoId, connectedRepoId), eq(p.forgeRef, forgeRef)),
        orderBy: (p, { asc }) => [asc(p.createdAt), asc(p.id)],
      });
    },
    async listPatchesAwaitingMemoryFate() {
      const p = schema.patches;
      // A verdict its merge's settle has yet to finish is that settle's to report, after the cue.
      return await db.select().from(p)
        .where(and(
          isNull(p.memoryFateReportedAt),
          or(isNotNull(p.landed), inArray(p.state, ["failed", "rejected", "superseded"])),
          verdictFinal(p),
        ))
        .orderBy(p.createdAt);
    },
    async listRepoAccess(userId) {
      return await db.query.repoAccess.findMany({
        where: (r, { eq }) => eq(r.userId, userId),
      });
    },
    async saveRepoAccess(rows) {
      if (rows.length === 0) return;
      // An upsert on the user-and-repo key, so two requests refreshing the same user at once
      // both land instead of the second failing on the row the first just wrote.
      await db.insert(schema.repoAccess).values([...rows]).onConflictDoUpdate({
        target: [schema.repoAccess.userId, schema.repoAccess.connectedRepoId],
        set: {
          writable: sql`excluded.writable`,
          checkedAt: sql`excluded.checked_at`,
        },
      });
    },
    // The one row, by its constant id. `null` means no admin has ever saved one, which is what
    // leaves the environment's seed standing — an empty allowlist is a different, sayable thing.
    async getEgressAllowlist() {
      const row = await db.query.egressAllowlist.findFirst({
        where: (a, { eq }) => eq(a.id, EGRESS_ALLOWLIST_ROW),
      });
      return row === undefined ? null : {
        bundles: row.bundles,
        hosts: row.hosts,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    },
    async saveEgressAllowlist(allowlist) {
      const row = { id: EGRESS_ALLOWLIST_ROW, ...allowlist };
      await db.insert(schema.egressAllowlist).values(row)
        .onConflictDoUpdate({ target: schema.egressAllowlist.id, set: row });
    },
    async getReservedCapacity() {
      const row = await db.query.reservedCapacity.findFirst({
        where: (r, { eq }) => eq(r.id, RESERVED_CAPACITY_ROW),
      });
      return row === undefined
        ? null
        : { slots: row.slots, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    },
    async saveReservedCapacity(capacity) {
      const row = { id: RESERVED_CAPACITY_ROW, ...capacity };
      await db.insert(schema.reservedCapacity).values(row)
        .onConflictDoUpdate({ target: schema.reservedCapacity.id, set: row });
    },
    close: handle.close,
  };
}
