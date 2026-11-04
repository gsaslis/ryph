// A test fixture, not a deployment option. It used to be both: `RYPH_DB=memory` ran this as
// a second implementation of every store port, free to drift from the drizzle one without any
// test noticing. `pglite:memory://` replaced that — it is the real driver over real PostgreSQL,
// so throwaway databases now exercise the production path.
//
// What is left here is a fast double for tests that care about behaviour ABOVE the store and
// want no database at all. Anything asserting on SQL belongs on makeTestDb() instead.
//
// Everything returned is a structuredClone so no caller can mutate a row behind its back.

import { gitlabProjectRef } from "@ryph/forge/gitlab-account";
import { type RepoAccess, type Scope, taskInScope } from "../src/core/scope.ts";
import { idleStateOf } from "../src/core/run_activity.ts";
import type {
  Agent,
  Attachment,
  AutomationEventRecord,
  ChangeRequestMerge,
  ChatMentionRecord,
  CommandRoom,
  ConnectedRepo,
  ForgeEventRecord,
  ForgeToolAction,
  GithubInstallation,
  GitlabProject,
  GitVirtualKey,
  Patch,
  ProgressComment,
  RepoCommandAllowlistEntry,
  Response,
  Run,
  RunEvent,
  RunMessage,
  Task,
  Workspace,
  WorkspaceRepo,
} from "../src/core/types.ts";
import { SWEEPABLE_PATCH_STATES, TERMINAL_STATES } from "../src/core/types.ts";
import {
  appendRefusal,
  type EgressAllowlist,
  type EgressRefusalOutcome,
} from "../src/core/egress.ts";
import type { ReservedCapacity } from "../src/core/reserved_capacity.ts";
import { AttachmentClaimConflict } from "../src/core/attachments.ts";
import { landMerge, releaseMergedTarget } from "../src/core/landing.ts";
import { owedReleaseCues, releaseCueMessage } from "../src/core/merge_release.ts";
import { retarget } from "../src/core/retarget.ts";
import { landedVerdict } from "../src/core/patch_lifecycle.ts";
import { grownHeads } from "../src/core/merge_record.ts";
import { hasLanding } from "../src/core/landing.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";
import {
  clampPageLimit,
  decodeListCursor,
  encodeListCursor,
  type MergePollClock,
  type MergePollDue,
  TASK_STATUS_BUCKETS,
  type TaskListQuery,
  type TaskListRow,
  type TaskStore,
} from "../src/ports/task_store.ts";

function sameLifecycle(a: Run, b: Run): boolean {
  return a.state === b.state && a.heartbeatSeq === b.heartbeatSeq &&
    a.lastHeartbeatAt === b.lastHeartbeatAt && a.desiredState === b.desiredState &&
    a.cancelRequestedAt === b.cancelRequestedAt && a.idleDeadlineAt === b.idleDeadlineAt &&
    a.handle === b.handle && a.launchedAt === b.launchedAt;
}

export function memoryTaskStore(): TaskStore {
  const agents = new Map<string, Agent>();
  const tasks = new Map<string, Task>();
  const runs = new Map<string, Run>();
  const bootstraps = new Map<string, { tokenHash: string; sealed: string; expiresAt: string }>();
  const events: RunEvent[] = [];
  /** Parallel to `events`, by index: the "seq" `reserveCredentialSlot`/`releaseCredentialSlot`
   * hand back, so a released reservation can be found again without renumbering the rest. */
  const eventSeqs: number[] = [];
  let nextEventSeq = 0;
  const gitKeys = new Map<string, GitVirtualKey>();
  const installations = new Map<string, GithubInstallation>();
  const connectedRepos = new Map<string, ConnectedRepo>();
  const commandAllowlist = new Map<string, RepoCommandAllowlistEntry>();
  const gitlabProjects = new Map<string, GitlabProject>();
  const withForgeId = (repo: ConnectedRepo): ConnectedRepo => {
    const held = repo.provider === "gitlab" ? gitlabProjects.get(repo.id) : undefined;
    return held === undefined
      ? repo
      : { ...repo, forgeId: gitlabProjectRef(held.instance, held.projectId) };
  };
  const patches = new Map<string, Patch>();
  /** The merge poll's clocks, keyed `${connectedRepoId}\0${forgeRef}`. */
  const mergePolls = new Map<string, MergePollClock>();
  /** Merge records, keyed the same way. */
  const merges = new Map<string, ChangeRequestMerge>();
  const isJudged = (p: Patch) => p.landed?.kind === "merged" || p.landed?.kind === "missed";
  /** Whether nothing more is owed to a patch's verdict: its merge record, if any, is settled
   * (the drizzle store's `verdictFinal`). */
  const verdictFinal = (p: Patch) =>
    p.forgeRef === null || merges.get(`${p.connectedRepoId}\0${p.forgeRef}`)?.settledAt !== null;
  /** Whether the merge poll still asks about a submitted patch's change request: no verdict yet,
   * or closed since `closedSince`. */
  const pollable = (p: Patch, closedSince: string) =>
    p.landed === null || (p.landed.kind === "closed" && p.landed.at >= closedSince);
  const forgeEvents = new Map<string, ForgeEventRecord>();
  const automationEvents = new Map<string, AutomationEventRecord>();
  const commandRooms = new Map<string, CommandRoom>();
  const chatMentions = new Map<string, ChatMentionRecord>();
  const progressComments = new Map<string, ProgressComment>();
  const workspaces = new Map<string, Workspace>();
  const workspaceRepos: WorkspaceRepo[] = [];
  const messages: RunMessage[] = [];
  const attachments = new Map<string, Attachment>();
  const responses = new Map<string, Response>();
  const repoAccess = new Map<string, RepoAccess[]>();
  const inScope = (taskId: string, scope: Scope): boolean => {
    const task = tasks.get(taskId);
    return task !== undefined && taskInScope(task, scope);
  };
  const forgeToolActions: ForgeToolAction[] = [];
  // Null, not an empty allowlist: "nobody has ever set one" is the state that leaves the
  // environment's seed standing, and it has to be expressible here too.
  let allowlist: EgressAllowlist | null = null;
  let reservedCapacity: ReservedCapacity | null = null;
  /** Each task's current attempt (`tasks.current_run_id` in the SQL store): the run it was born
   * with, which nothing moves. */
  const currentRuns = new Map<string, string>();
  const currentRunOf = (taskId: string) => {
    const id = currentRuns.get(taskId);
    return id === undefined ? undefined : runs.get(id);
  };
  /** A message appended at the run's next seq, as `appendMessageIn` does in the SQL store. */
  const appendMessage = (message: Omit<RunMessage, "seq">): RunMessage => {
    const last = messages.filter((m) => m.runId === message.runId)
      .reduce((max, m) => Math.max(max, m.seq), -1);
    const stored: RunMessage = { ...structuredClone(message), seq: last + 1 };
    messages.push(stored);
    return stored;
  };
  /** Whether a task whose current run is live works the change request (the SQL store's
   * `workedLive`). */
  const workedLive = (connectedRepoId: string, forgeRef: string) =>
    [...tasks.values()].some((t) => {
      const current = currentRunOf(t.id);
      return t.targetChangeRequest?.connectedRepoId === connectedRepoId &&
        t.targetChangeRequest.thread === forgeRef && current !== undefined &&
        !TERMINAL_STATES.has(current.state);
    });
  /** Whether the run has a patch on the change request: what a landing and a release ask. */
  const runHasPatchOn = (runId: string, connectedRepoId: string, forgeRef: string) =>
    [...patches.values()].some((p) =>
      p.runId === runId && p.connectedRepoId === connectedRepoId && p.forgeRef === forgeRef
    );

  /** Newest first on `(createdAt, id)` — the same total order the SQL store pages by. */
  const compareNewestFirst = (
    a: { createdAt: string; id: string },
    b: { createdAt: string; id: string },
  ): number => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

  const isOlder = (
    row: { createdAt: string; id: string },
    after: { createdAt: string; id: string },
  ): boolean => compareNewestFirst(row, after) > 0;

  /**
   * What the SQL store keeps in denormalized columns, computed here instead: each task with its
   * newest run. The double stays a double — there is nothing here to keep in step — and the rows
   * it answers with are the ones the real store would.
   */
  const sortedTasks = (): TaskListRow[] =>
    [...tasks.values()].sort(compareNewestFirst).map((task) => {
      const current = [...runs.values()]
        .filter((r) => r.taskId === task.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
      return {
        task,
        currentRun: {
          id: current?.id ?? "",
          state: current?.state ?? "starting",
          phase: current?.phase ?? null,
          declaredOutcome: current?.declaredOutcome ?? null,
          idleState: current?.state === "running" && current.phase === "running"
            ? current.idleState ?? null
            : null,
        },
        lastActivityAt: current?.updatedAt ?? task.createdAt,
      };
    });

  const matchesTaskQuery = (row: TaskListRow, query: TaskListQuery): boolean => {
    const { task } = row;
    if (
      !query.includeAbandonedDrafts && row.currentRun.state === "cancelled" &&
      task.spec.instructions === null
    ) return false;
    const after = decodeListCursor(query.cursor);
    if (after !== null && !isOlder(task, after)) return false;
    if (query.ids !== undefined && !query.ids.includes(task.id)) return false;
    if (query.statuses !== undefined && query.statuses.length > 0) {
      const states = new Set(query.statuses.flatMap((b) => [...TASK_STATUS_BUCKETS[b]]));
      if (!states.has(row.currentRun.state)) return false;
    }
    if (
      query.agentIds !== undefined && query.agentIds.length > 0 &&
      !query.agentIds.includes(task.agentId)
    ) return false;
    if (
      query.origins !== undefined && query.origins.length > 0 &&
      !query.origins.includes(task.origin)
    ) return false;
    if (query.workspaceId !== undefined && task.workspaceId !== query.workspaceId) return false;
    if (query.scope !== undefined && !taskInScope(task, query.scope)) return false;
    if (
      query.connectedRepoId !== undefined &&
      !task.repos.some((r) => r.connectedRepoId === query.connectedRepoId)
    ) return false;
    if (
      query.requestedByUserId !== undefined &&
      task.requestedByUserId !== query.requestedByUserId
    ) return false;
    if (query.createdFrom !== undefined && task.createdAt < query.createdFrom) return false;
    if (query.createdTo !== undefined && task.createdAt >= query.createdTo) return false;
    if (query.q !== undefined) {
      // Word-prefix matching, as the tsquery does — close enough that a test asserting on search
      // behaviour reads the same either side of the double.
      const words: string[] = query.q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const title: string[] = (task.spec.title ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const hit = words.every((word, i) =>
        i === words.length - 1 ? title.some((t) => t.startsWith(word)) : title.includes(word)
      );
      if (!hit) return false;
    }
    return true;
  };

  return {
    createWorkspace(workspace) {
      workspaces.set(workspace.id, structuredClone(workspace));
      return Promise.resolve();
    },
    getWorkspace(id) {
      const found = workspaces.get(id);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    listWorkspaces() {
      const all = [...workspaces.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Promise.resolve(structuredClone(all));
    },
    updateWorkspace(id, fields) {
      const found = workspaces.get(id);
      if (!found || found.archivedAt !== null) return Promise.resolve(false);
      workspaces.set(id, { ...found, ...structuredClone(fields) });
      return Promise.resolve(true);
    },
    touchWorkspace(id, at) {
      const found = workspaces.get(id);
      if (found) workspaces.set(id, { ...found, updatedAt: at });
      return Promise.resolve();
    },
    archiveWorkspace(id, at) {
      const found = workspaces.get(id);
      if (!found) return Promise.resolve(null);
      const archived = found.archivedAt === null
        ? { ...found, archivedAt: at, updatedAt: at }
        : found;
      workspaces.set(id, archived);
      for (let i = workspaceRepos.length - 1; i >= 0; i--) {
        if (workspaceRepos[i].workspaceId === id) workspaceRepos.splice(i, 1);
      }
      return Promise.resolve(structuredClone(archived));
    },
    listWorkspaceRepos(workspaceId) {
      const members = workspaceRepos.filter((r) => r.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(members));
    },
    findWorkspaceRepo(connectedRepoId) {
      const found = workspaceRepos.find((r) => r.connectedRepoId === connectedRepoId);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    addWorkspaceRepo(repo, maxMembers) {
      const workspace = workspaces.get(repo.workspaceId);
      if (!workspace || workspace.archivedAt !== null) return Promise.resolve("archived" as const);
      if (workspaceRepos.filter((r) => r.workspaceId === repo.workspaceId).length >= maxMembers) {
        return Promise.resolve("full" as const);
      }
      if (workspaceRepos.some((r) => r.connectedRepoId === repo.connectedRepoId)) {
        return Promise.resolve("taken" as const);
      }
      if (workspaceRepos.some((r) => r.workspaceId === repo.workspaceId && r.path === repo.path)) {
        return Promise.reject(Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint_name: "workspace_repos_by_path",
        }));
      }
      workspaceRepos.push(structuredClone(repo));
      workspaces.set(repo.workspaceId, { ...workspace, updatedAt: repo.createdAt });
      return Promise.resolve("added" as const);
    },
    saveWorkspaceRepo(repo) {
      const at = workspaceRepos.findIndex((r) =>
        r.workspaceId === repo.workspaceId && r.connectedRepoId === repo.connectedRepoId
      );
      if (at !== -1) workspaceRepos[at] = structuredClone(repo);
      return Promise.resolve();
    },
    removeWorkspaceRepo(workspaceId, connectedRepoId) {
      const at = workspaceRepos.findIndex((r) =>
        r.workspaceId === workspaceId && r.connectedRepoId === connectedRepoId
      );
      if (at !== -1) workspaceRepos.splice(at, 1);
      return Promise.resolve();
    },
    createAgent(agent) {
      agents.set(agent.id, structuredClone(agent));
      return Promise.resolve();
    },
    getAgent(id) {
      const agent = agents.get(id);
      return Promise.resolve(agent ? structuredClone(agent) : null);
    },
    getAgentByHandle(handle) {
      const agent = [...agents.values()].find((a) => a.handle === handle);
      return Promise.resolve(agent ? structuredClone(agent) : null);
    },
    listAgentsByIds(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(
        structuredClone([...agents.values()].filter((a) => wanted.has(a.id))),
      );
    },
    listAgents() {
      const all = [...agents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Promise.resolve(structuredClone(all));
    },
    saveAgent(agent) {
      // The two switches are not part of a full-row save on an existing row (the port says why).
      const existing = agents.get(agent.id);
      agents.set(
        agent.id,
        structuredClone(
          existing === undefined ? agent : {
            ...agent,
            canOpenPatches: existing.canOpenPatches,
            canPublishArtifacts: existing.canPublishArtifacts,
          },
        ),
      );
      return Promise.resolve();
    },
    setAgentCanOpenPatches(id, from, to) {
      const existing = agents.get(id);
      if (existing === undefined || existing.canOpenPatches !== from) return Promise.resolve(false);
      agents.set(id, { ...existing, canOpenPatches: to });
      return Promise.resolve(true);
    },
    setAgentCanPublishArtifacts(id, from, to) {
      const existing = agents.get(id);
      if (existing === undefined || existing.canPublishArtifacts !== from) {
        return Promise.resolve(false);
      }
      agents.set(id, { ...existing, canPublishArtifacts: to });
      return Promise.resolve(true);
    },
    createTask(task, run, gitKey, opts) {
      const maxLive = opts?.maxLive ?? null;
      if (maxLive !== null) {
        const live = [...runs.values()].filter((r) => !TERMINAL_STATES.has(r.state)).length;
        if (live >= maxLive) return Promise.resolve("full");
      }
      tasks.set(task.id, structuredClone(task));
      runs.set(run.id, structuredClone(run));
      currentRuns.set(task.id, run.id);
      if (gitKey) gitKeys.set(gitKey.id, structuredClone(gitKey));
      for (const a of opts?.attachments ?? []) attachments.set(a.id, structuredClone(a));
      return Promise.resolve("created");
    },
    getTask(id, scope) {
      const task = tasks.get(id);
      if (task === undefined || (scope !== undefined && !taskInScope(task, scope))) {
        return Promise.resolve(null);
      }
      return Promise.resolve(structuredClone(task));
    },
    applyRetarget({ taskId, runId, ...args }) {
      // As the drizzle store: the pure decision over the rows as they stand, and only the narrow
      // columns written, the run's only while it is live.
      const stored = tasks.get(taskId);
      const run = runs.get(runId);
      if (stored === undefined || run === undefined) return Promise.resolve(null);
      const targeted = stored.targetChangeRequest;
      if (targeted !== null && targeted.connectedRepoId !== args.connectedRepoId) {
        return Promise.resolve({ kind: "refused" as const, why: "other-change-request" as const });
      }
      if (
        [...patches.values()].some((p) =>
          p.runId === runId && p.connectedRepoId === args.connectedRepoId
        )
      ) {
        return Promise.resolve({ kind: "refused" as const, why: "shipped" as const });
      }
      const applied = retarget({
        ...args,
        task: structuredClone({ ...stored, landings: stored.landings ?? {} }),
        run: structuredClone(run),
      });
      tasks.set(taskId, {
        ...stored,
        repos: structuredClone(applied.task.repos),
        targetChangeRequest: structuredClone(applied.task.targetChangeRequest),
        landings: structuredClone(applied.task.landings),
      });
      if (!TERMINAL_STATES.has(run.state)) {
        runs.set(runId, {
          ...run,
          workItem: structuredClone(applied.run.workItem),
          forgeScope: structuredClone(applied.run.forgeScope),
          updatedAt: applied.run.updatedAt,
        });
      }
      return Promise.resolve(structuredClone(applied));
    },
    landMerge({ patch, mergedInto, defaultBranch, intoTip, at }) {
      // As the drizzle store: the decision is the core's, applied to the rows as they stand, and
      // everything it decides written at once — the task, the live run's spec, the event. The
      // list's activity clock needs no write of its own here: this store reads it off the current
      // run's `updatedAt`, which the run write moves.
      const asked = patches.get(patch.id);
      // Asked and answered, whatever the answer: as the drizzle store, in the same write.
      if (
        asked !== undefined && isJudged(asked) &&
        (asked.landingAskedAt ?? null) === null
      ) {
        patches.set(patch.id, { ...asked, landingAskedAt: at });
      }
      const stored = tasks.get(patch.taskId);
      if (stored === undefined) {
        return Promise.resolve({ outcome: { kind: "none" as const } });
      }
      const landings = stored.landings ?? {};
      const run = runs.get(patch.runId);
      const live = run !== undefined && !TERMINAL_STATES.has(run.state);
      const outcome = landMerge({
        task: structuredClone({ ...stored, landings }),
        run: live ? structuredClone(run) : null,
        patch,
        mergedInto,
        defaultBranch,
        intoTip,
        at,
        runNamespace: run?.branchNamespace,
      });
      if (outcome.kind === "released") {
        tasks.set(patch.taskId, { ...stored, targetChangeRequest: null });
        events.push(structuredClone(outcome.event));
        eventSeqs.push(nextEventSeq++);
        return Promise.resolve({ outcome: structuredClone(outcome) });
      }
      if (outcome.kind !== "landed") {
        return Promise.resolve({ outcome: structuredClone(outcome) });
      }
      tasks.set(patch.taskId, {
        ...stored,
        repos: structuredClone(outcome.task.repos),
        targetChangeRequest: structuredClone(outcome.task.targetChangeRequest),
        landings: structuredClone(outcome.task.landings),
      });
      if (outcome.run !== null && live) {
        runs.set(run.id, {
          ...run,
          workItem: structuredClone(outcome.run.workItem),
          updatedAt: outcome.run.updatedAt,
        });
      }
      if (outcome.event !== null) {
        events.push(structuredClone(outcome.event));
        eventSeqs.push(nextEventSeq++);
      }
      return Promise.resolve(structuredClone({ outcome }));
    },
    listTasks(query) {
      const limit = clampPageLimit(query?.limit);
      const matched = sortedTasks().filter((row) => matchesTaskQuery(row, query ?? {}));
      const page = matched.slice(0, limit);
      const last = page.at(-1);
      return Promise.resolve({
        tasks: structuredClone(page),
        nextCursor: matched.length > limit && last !== undefined
          ? encodeListCursor(last.task)
          : null,
      });
    },
    listTasksByIds(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(
        structuredClone(sortedTasks().filter((row) => wanted.has(row.task.id))),
      );
    },
    runsForTask(taskId) {
      const forTask = [...runs.values()]
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(forTask));
    },
    listRunsByIds(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(structuredClone([...runs.values()].filter((r) => wanted.has(r.id))));
    },
    getRun(id) {
      const run = runs.get(id);
      return Promise.resolve(run ? structuredClone(run) : null);
    },
    saveBootstrap(runId, tokenHash, sealed, expiresAt) {
      // As the drizzle store's primary key: a second bootstrap for one run is a bug.
      if (bootstraps.has(runId)) {
        return Promise.reject(new Error(`run ${runId} already has a bootstrap`));
      }
      bootstraps.set(runId, { tokenHash, sealed, expiresAt });
      return Promise.resolve();
    },
    readBootstrap(runId, tokenHash, now) {
      const row = bootstraps.get(runId);
      if (!row || row.tokenHash !== tokenHash || row.expiresAt <= now) return Promise.resolve(null);
      return Promise.resolve(row.sealed);
    },
    consumeBootstrap(runId, tokenHash, now) {
      const row = bootstraps.get(runId);
      if (!row || row.tokenHash !== tokenHash || row.expiresAt <= now) return Promise.resolve(null);
      bootstraps.delete(runId);
      return Promise.resolve(row.sealed);
    },
    deleteBootstrap(runId) {
      bootstraps.delete(runId);
      return Promise.resolve();
    },
    deleteExpiredBootstraps(now) {
      for (const [runId, row] of bootstraps) {
        if (row.expiresAt <= now) bootstraps.delete(runId);
      }
      return Promise.resolve();
    },
    saveRun(run) {
      if (runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
      runs.set(run.id, structuredClone(run));
      return Promise.resolve();
    },
    saveRunTransition(run, expected) {
      const stored = runs.get(run.id);
      if (!stored || TERMINAL_STATES.has(stored.state) || !sameLifecycle(stored, expected)) {
        return Promise.resolve(null);
      }
      const next: Run = {
        ...stored,
        state: run.state,
        environmentWait: structuredClone(run.environmentWait),
        updatedAt: run.updatedAt,
      };
      runs.set(run.id, next);
      return Promise.resolve(structuredClone(next));
    },
    saveRunResult(run) {
      const stored = runs.get(run.id);
      if (
        !stored || stored.result !== null ||
        (TERMINAL_STATES.has(stored.state) && stored.state !== "lost")
      ) return Promise.resolve(null);
      const next = {
        ...stored,
        state: run.state,
        result: structuredClone(run.result),
        updatedAt: run.updatedAt,
      };
      runs.set(run.id, next);
      return Promise.resolve(structuredClone(next));
    },
    requestRunCancel(runId, at, guard) {
      const stored = runs.get(runId);
      if (
        !stored || TERMINAL_STATES.has(stored.state) || stored.desiredState !== null ||
        (guard && stored.idleDeadlineAt !== guard.idleDeadlineAt)
      ) return Promise.resolve({ run: structuredClone(stored ?? null), applied: false });
      const next: Run = {
        ...stored,
        desiredState: "cancelled",
        cancelRequestedAt: at,
        updatedAt: at,
      };
      runs.set(runId, next);
      return Promise.resolve({ run: structuredClone(next), applied: true });
    },
    recordRunLaunch(runId, handle, launchedAt) {
      const stored = runs.get(runId);
      if (!stored) return Promise.resolve(null);
      // As the drizzle store: a live run's clock moves forward with the launch.
      const updatedAt = TERMINAL_STATES.has(stored.state) || stored.updatedAt > launchedAt
        ? stored.updatedAt
        : launchedAt;
      const next = stored.handle === null ? { ...stored, handle, launchedAt, updatedAt } : stored;
      runs.set(runId, next);
      return Promise.resolve(structuredClone(next));
    },
    saveHeartbeat(run) {
      // As the drizzle store: the beat's columns only, onto a run that is still live and has not
      // taken a newer beat since the caller read it.
      const stored = runs.get(run.id);
      if (
        stored === undefined || TERMINAL_STATES.has(stored.state) ||
        stored.heartbeatSeq >= run.heartbeatSeq
      ) {
        return Promise.resolve(null);
      }
      runs.set(run.id, {
        ...stored,
        state: run.state,
        phase: run.phase,
        heartbeatSeq: run.heartbeatSeq,
        lastHeartbeatAt: run.lastHeartbeatAt,
        idleDeadlineAt: run.idleDeadlineAt,
        idleState: idleStateOf(run),
        declaredOutcome: run.declaredOutcome ?? null,
        agentFinished: stored.agentFinished === true || run.agentFinished === true,
        updatedAt: run.updatedAt,
      });
      return Promise.resolve({ desiredState: stored.desiredState });
    },
    saveRunIfWaiting(run, environmentId) {
      const stored = runs.get(run.id);
      if (
        stored === undefined || stored.state !== "starting" || stored.handle !== null ||
        stored.environmentWait?.environmentId !== environmentId
      ) return Promise.resolve(false);
      runs.set(run.id, {
        ...structuredClone(run),
        desiredState: stored.desiredState ?? run.desiredState,
        cancelRequestedAt: stored.cancelRequestedAt ?? run.cancelRequestedAt,
        memoryOutcomeReportedAt: stored.memoryOutcomeReportedAt,
        egressRefusals: stored.egressRefusals,
        skillsReportedAt: stored.skillsReportedAt,
        declaredOutcome: stored.declaredOutcome,
        agentFinished: stored.agentFinished,
      });
      return Promise.resolve(true);
    },
    saveRunIfUnlaunched(run) {
      const stored = runs.get(run.id);
      if (
        stored === undefined || stored.state !== "starting" || stored.handle !== null ||
        stored.environmentWait !== null || stored.desiredState !== null
      ) return Promise.resolve(false);
      runs.set(run.id, {
        ...structuredClone(run),
        desiredState: stored.desiredState ?? run.desiredState,
        cancelRequestedAt: stored.cancelRequestedAt ?? run.cancelRequestedAt,
        memoryOutcomeReportedAt: stored.memoryOutcomeReportedAt,
        egressRefusals: stored.egressRefusals,
        skillsReportedAt: stored.skillsReportedAt,
        declaredOutcome: stored.declaredOutcome,
        agentFinished: stored.agentFinished,
      });
      return Promise.resolve(true);
    },
    markRunAttended(runId, at) {
      const found = runs.get(runId);
      if (!found) return Promise.resolve({ run: null, flipped: false });
      if (found.attended) return Promise.resolve({ run: structuredClone(found), flipped: false });
      const next = { ...found, attended: true, updatedAt: at };
      runs.set(runId, next);
      return Promise.resolve({ run: structuredClone(next), flipped: true });
    },
    recordRunEgressRefusal(runId, refusal) {
      const found = runs.get(runId);
      if (!found) return Promise.resolve<EgressRefusalOutcome>("ended");
      if (TERMINAL_STATES.has(found.state)) return Promise.resolve<EgressRefusalOutcome>("ended");
      const next = appendRefusal(found.egressRefusals, refusal);
      if (next === null) return Promise.resolve<EgressRefusalOutcome>("duplicate");
      runs.set(runId, { ...found, egressRefusals: next });
      return Promise.resolve<EgressRefusalOutcome>("recorded");
    },
    markRunMemoryOutcomeReported(runId, at) {
      const found = runs.get(runId);
      if (found && found.memoryOutcomeReportedAt === null) {
        runs.set(runId, { ...found, memoryOutcomeReportedAt: at });
      }
      return Promise.resolve();
    },
    listRunsAwaitingMemoryOutcome(before, limit) {
      const owed = [...runs.values()]
        .filter((r) =>
          r.memoryOutcomeReportedAt === null && TERMINAL_STATES.has(r.state) && r.updatedAt < before
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, limit);
      return Promise.resolve(structuredClone(owed));
    },
    listActiveRuns() {
      const active = [...runs.values()].filter((r) => !TERMINAL_STATES.has(r.state));
      return Promise.resolve(structuredClone(active));
    },
    countActiveRuns() {
      return Promise.resolve(
        [...runs.values()].filter((r) => !TERMINAL_STATES.has(r.state)).length,
      );
    },
    findLiveRunByOrigin(origin) {
      const held = [...runs.values()]
        .filter((r) =>
          !TERMINAL_STATES.has(r.state) &&
          (origin.kind === "forge"
            ? r.originThreadRepoId === origin.connectedRepoId &&
              r.originThreadKind === origin.threadKind &&
              r.originThreadRef === origin.ref
            : r.originChatroomId === origin.chatroomId &&
              r.originThreadKey === origin.threadKey)
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return Promise.resolve(held ? structuredClone(held) : null);
    },
    findLiveRunOnChangeRequest(connectedRepoId, thread) {
      const targets = (run: Run) => {
        const target = tasks.get(run.taskId)?.targetChangeRequest ?? null;
        return target !== null && target.connectedRepoId === connectedRepoId &&
          target.thread === thread;
      };
      const live = [...runs.values()]
        .filter((r) => !TERMINAL_STATES.has(r.state))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // The same three readings as the drizzle store, in its order: commanded, then targeting,
      // then the run that opened the change request with one of its patches.
      const held = live.find((r) =>
        r.originThreadRepoId === connectedRepoId &&
        r.originThreadKind === "change_request" && r.originThreadRef === thread
      ) ?? live.find(targets) ??
        live.find((r) =>
          [...patches.values()].some((p) =>
            p.runId === r.id && p.connectedRepoId === connectedRepoId && p.forgeRef === thread
          )
        );
      return Promise.resolve(held ? structuredClone(held) : null);
    },
    countRunsStartedFromChatroom(chatroomId, since) {
      return Promise.resolve(
        [...runs.values()].filter((r) => r.originChatroomId === chatroomId && r.createdAt >= since)
          .length,
      );
    },
    getCommandRoom(chatroomId) {
      return Promise.resolve(structuredClone(commandRooms.get(chatroomId) ?? null));
    },
    saveCommandRoom(room) {
      const existing = commandRooms.get(room.chatroomId);
      commandRooms.set(
        room.chatroomId,
        structuredClone(existing ? { ...room, createdAt: existing.createdAt } : room),
      );
      return Promise.resolve();
    },
    deleteCommandRoom(chatroomId) {
      return Promise.resolve(commandRooms.delete(chatroomId));
    },
    claimChatMention(record, reclaimProcessingBefore) {
      const key = `${record.chatroomId}\u0000${record.messageId}`;
      const existing = chatMentions.get(key);
      if (existing !== undefined) {
        const stale = reclaimProcessingBefore !== undefined &&
          existing.outcome === "processing" &&
          existing.claimedAt !== null &&
          existing.claimedAt < reclaimProcessingBefore;
        if (!stale) return Promise.resolve(false);
        chatMentions.set(key, structuredClone({ ...record, createdAt: existing.createdAt }));
        return Promise.resolve(true);
      }
      chatMentions.set(key, structuredClone(record));
      return Promise.resolve(true);
    },
    recordChatMention(record) {
      const key = `${record.chatroomId}\u0000${record.messageId}`;
      const existing = chatMentions.get(key);
      if (existing !== undefined && existing.outcome !== "processing") return Promise.resolve();
      chatMentions.set(
        key,
        structuredClone(
          existing === undefined
            ? record
            : { ...record, createdAt: existing.createdAt, claimedAt: existing.claimedAt },
        ),
      );
      return Promise.resolve();
    },
    appendEvent(event) {
      events.push(structuredClone(event));
      eventSeqs.push(nextEventSeq++);
      return Promise.resolve();
    },
    listEvents(runId) {
      return Promise.resolve(structuredClone(events.filter((e) => e.runId === runId)));
    },
    hasRunEvent(runId, kind) {
      return Promise.resolve(events.some((event) => event.runId === runId && event.kind === kind));
    },
    reserveCredentialSlot(runId, event, max) {
      const issued = events.filter((e) =>
        e.runId === runId && e.kind === "credentials-issued" &&
        !(e.detail ?? "").startsWith("mcp:")
      ).length;
      if (issued >= max) return Promise.resolve({ reserved: false, issued });
      const seq = nextEventSeq++;
      events.push(structuredClone({ runId, kind: "credentials-issued", ...event }));
      eventSeqs.push(seq);
      return Promise.resolve({ reserved: true, issued: issued + 1, seq });
    },
    recordSkillsReport(runId, at, reportEvents) {
      const found = runs.get(runId);
      if (!found || found.skillsReportedAt !== null) return Promise.resolve(false);
      runs.set(runId, { ...found, skillsReportedAt: at });
      for (const e of reportEvents) {
        events.push(structuredClone({ runId, at, ...e }));
        eventSeqs.push(nextEventSeq++);
      }
      return Promise.resolve(true);
    },
    releaseCredentialSlot(runId, seq) {
      const idx = eventSeqs.findIndex((s) => s === seq);
      if (idx !== -1 && events[idx]?.runId === runId) {
        events.splice(idx, 1);
        eventSeqs.splice(idx, 1);
      }
      return Promise.resolve();
    },
    retitleTask(taskId, from, to) {
      const stored = tasks.get(taskId);
      if (stored === undefined || stored.spec.title !== from) return Promise.resolve(false);
      tasks.set(taskId, { ...stored, spec: { ...stored.spec, title: to } });
      return Promise.resolve(true);
    },
    async claimTaskPrompt(prompt, message) {
      // Synchronous up to the append, as the drizzle store's lock makes it: the check and the
      // write cannot interleave with another claim's.
      const task = tasks.get(prompt.taskId);
      const run = runs.get(message.runId);
      if (run !== undefined && TERMINAL_STATES.has(run.state)) {
        return { kind: "terminal", state: run.state };
      }
      if (task === undefined || run === undefined || task.spec.instructions !== null) {
        return { kind: "taken" };
      }
      const claim = message.attachments.map((ref) => attachments.get(ref.id));
      if (
        claim.some((a) => a === undefined || a.runId !== message.runId || a.claimedBy !== null)
      ) {
        throw new AttachmentClaimConflict();
      }
      const spec = { title: prompt.title, instructions: prompt.instructions };
      tasks.set(task.id, { ...task, spec });
      runs.set(run.id, {
        ...run,
        workItem: { ...run.workItem, spec, attachments: structuredClone(message.attachments) },
      });
      const prompted = await this.appendRunMessage(message);
      // As the drizzle store: the release cues the run was owed while it waited, after it.
      const owed = owedReleaseCues(task.landings ?? {}, run.id, message.createdAt);
      if (owed !== null) {
        tasks.set(task.id, { ...tasks.get(task.id)!, landings: owed.landings });
        for (const cue of owed.cues) appendMessage(cue);
      }
      return { kind: "claimed", message: prompted };
    },
    appendRunMessage(message) {
      // The claim, as the transaction makes it: every image this run's and unclaimed, or no
      // append at all.
      const claim = message.attachments.map((ref) => attachments.get(ref.id));
      if (
        claim.some((a) => a === undefined || a.runId !== message.runId || a.claimedBy !== null)
      ) {
        return Promise.reject(new AttachmentClaimConflict());
      }
      for (const a of claim) a!.claimedBy = message.id;
      return Promise.resolve(structuredClone(appendMessage(message)));
    },
    createUnclaimedAttachment(attachment, maxUnclaimed) {
      // Synchronous from the count to the set, so concurrent callers cannot interleave: the
      // lock the drizzle store takes, for free.
      const held =
        [...attachments.values()].filter((a) =>
          a.runId === attachment.runId && a.claimedBy === null
        ).length;
      if (held >= maxUnclaimed) return Promise.resolve(false);
      attachments.set(attachment.id, structuredClone(attachment));
      return Promise.resolve(true);
    },
    createAgentAttachment(attachment, limits) {
      const existing = attachment.ref === null
        ? undefined
        : [...attachments.values()].find((a) =>
          a.runId === attachment.runId && a.ref === attachment.ref
        );
      if (existing !== undefined) {
        return Promise.resolve({ kind: "existing", attachment: structuredClone(existing) });
      }
      const held = [...attachments.values()].filter((a) =>
        a.runId === attachment.runId && a.source === "agent"
      );
      const bytes = held.reduce((sum, a) => sum + a.bytes, 0);
      if (held.length >= limits.maxCount || bytes + attachment.bytes > limits.maxBytes) {
        return Promise.resolve({ kind: "full" });
      }
      attachments.set(attachment.id, structuredClone(attachment));
      return Promise.resolve({ kind: "created" });
    },
    agentAttachmentsByRefs(runId, refs) {
      return Promise.resolve(
        [...attachments.values()]
          .filter((a) =>
            a.runId === runId && a.source === "agent" && a.ref !== null && refs.includes(a.ref)
          )
          .map((a) => structuredClone(a)),
      );
    },
    agentAttachmentUsage(runId) {
      const held = [...attachments.values()].filter((a) =>
        a.runId === runId && a.source === "agent"
      );
      return Promise.resolve({
        count: held.length,
        bytes: held.reduce((sum, a) => sum + a.bytes, 0),
      });
    },
    getAttachment(id) {
      const found = attachments.get(id);
      return Promise.resolve(found === undefined ? null : structuredClone(found));
    },
    listAttachmentsByIds(ids) {
      return Promise.resolve(
        ids.flatMap((id) => {
          const found = attachments.get(id);
          return found === undefined ? [] : [structuredClone(found)];
        }),
      );
    },
    countUnclaimedAttachments(runId) {
      return Promise.resolve(
        [...attachments.values()].filter((a) => a.runId === runId && a.claimedBy === null).length,
      );
    },
    deleteUnclaimedAttachment(runId, id) {
      const found = attachments.get(id);
      if (found === undefined || found.runId !== runId || found.claimedBy !== null) {
        return Promise.resolve(null);
      }
      attachments.delete(id);
      return Promise.resolve(found);
    },
    listUnclaimedAttachmentsBefore(before, limit) {
      return Promise.resolve(
        [...attachments.values()]
          .filter((a) => a.claimedBy === null && a.createdAt < before)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((a) => structuredClone(a)),
      );
    },
    listRunMessages(runId, afterSeq = -1, limit = 100) {
      const found = messages.filter((m) => m.runId === runId && m.seq > afterSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return Promise.resolve(structuredClone(found));
    },
    listRecentRunMessages(runId, limit) {
      const found = messages.filter((m) => m.runId === runId)
        .sort((a, b) => a.seq - b.seq)
        .slice(-limit);
      return Promise.resolve(structuredClone(found));
    },
    markRunMessagesDelivered(runId, uptoSeq, at) {
      for (const m of messages) {
        if (m.runId === runId && m.seq <= uptoSeq && m.deliveredAt === null) m.deliveredAt = at;
      }
      return Promise.resolve();
    },
    createResponse(response) {
      // As the partial unique index: one open response per (automation, key).
      const open = [...responses.values()].some((r) =>
        r.automationId === response.automationId && r.key === response.key &&
        r.state !== "closed"
      );
      if (open) return Promise.resolve(false);
      responses.set(response.id, structuredClone(response));
      return Promise.resolve(true);
    },
    getResponse(id) {
      const found = responses.get(id);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    markResponseActivity(responseId, at, spoken) {
      const found = responses.get(responseId);
      if (found !== undefined && found.state !== "closed") {
        responses.set(responseId, {
          ...found,
          state: spoken ? "attended" : found.state,
          lastActivityAt: at,
        });
      }
      return Promise.resolve();
    },
    recordResponseAlert(responseId, alerts, at) {
      const found = responses.get(responseId);
      if (found !== undefined && found.state !== "closed") {
        responses.set(responseId, { ...found, alerts, lastAlertAt: at, lastActivityAt: at });
      }
      return Promise.resolve();
    },
    closeResponse(responseId, at, reason) {
      const found = responses.get(responseId);
      if (found === undefined || found.state === "closed") return Promise.resolve(false);
      responses.set(responseId, {
        ...found,
        state: "closed",
        closedAt: at,
        closedReason: reason,
        lastActivityAt: at,
      });
      return Promise.resolve(true);
    },
    findOpenResponse(automationId, key) {
      const found = [...responses.values()]
        .filter((r) => r.automationId === automationId && r.key === key && r.state !== "closed")
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    findResponseByRun(runId) {
      const found = [...responses.values()].find((r) => r.runId === runId);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    listSharedResponses(automationId, exceptId, limit) {
      const found = [...responses.values()]
        .filter((r) =>
          r.automationId === automationId && r.conversation === "shared" && r.id !== exceptId
        )
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id))
        .slice(0, limit);
      return Promise.resolve(structuredClone(found));
    },
    listResponses(limit = 50, scope) {
      const all = [...responses.values()]
        .filter((r) => scope === undefined || inScope(r.taskId, scope))
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
        .slice(0, limit);
      return Promise.resolve(structuredClone(all));
    },
    listOpenResponses() {
      const open = [...responses.values()].filter((r) => r.state !== "closed")
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
      return Promise.resolve(structuredClone(open));
    },
    createGitKey(key) {
      gitKeys.set(key.id, structuredClone(key));
      return Promise.resolve();
    },
    getGitKeyByTokenHash(tokenHash) {
      const key = [...gitKeys.values()].find((k) => k.tokenHash === tokenHash);
      return Promise.resolve(key ? structuredClone(key) : null);
    },
    revokeGitKeysForRun(runId, at) {
      for (const key of gitKeys.values()) {
        if (key.runId === runId && key.revokedAt === null) key.revokedAt = at;
      }
      return Promise.resolve();
    },
    saveInstallation(installation) {
      // Keyed by the GitHub-side id: re-landing the install flow updates, never duplicates.
      const existing = [...installations.values()]
        .find((i) => i.installationId === installation.installationId);
      if (existing) installations.delete(existing.id);
      installations.set(installation.id, structuredClone(installation));
      return Promise.resolve();
    },
    getInstallationByInstallationId(installationId) {
      const found = [...installations.values()]
        .find((i) => i.installationId === installationId);
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    listInstallations() {
      const all = [...installations.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Promise.resolve(structuredClone(all));
    },
    createConnectedRepo({ forgeId: _, ...repo }) {
      connectedRepos.set(repo.id, structuredClone(repo));
      return Promise.resolve();
    },
    getConnectedRepo(id) {
      const repo = connectedRepos.get(id);
      return Promise.resolve(repo ? withForgeId(structuredClone(repo)) : null);
    },
    listConnectedRepos() {
      const all = [...connectedRepos.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return Promise.resolve(structuredClone(all).map(withForgeId));
    },
    // As the database store: `forgeId` is the GitLab project's, read with the row.
    saveConnectedRepo({ forgeId: _, ...repo }) {
      connectedRepos.set(repo.id, structuredClone(repo));
      return Promise.resolve();
    },
    createGitlabProject(connectedRepoId, projectId, instance, at) {
      const before = [...gitlabProjects.values()].filter((g) => g.projectId === projectId);
      const row: GitlabProject = {
        connectedRepoId,
        projectId,
        instance,
        hookGeneration: Math.max(0, ...before.map((g) => g.hookGeneration)) + 1,
        lastHookAt: null,
        lastMergeRequestHookAt: null,
        droppedCommentHookCount: 0,
        droppedOtherHookCount: 0,
        lastDroppedHookAt: null,
        createdAt: at,
        updatedAt: at,
      };
      gitlabProjects.set(connectedRepoId, row);
      return Promise.resolve(structuredClone(row));
    },
    getGitlabProject(connectedRepoId) {
      const row = gitlabProjects.get(connectedRepoId);
      return Promise.resolve(row ? structuredClone(row) : null);
    },
    listGitlabProjectsById(projectId) {
      return Promise.resolve(
        [...gitlabProjects.values()].filter((g) => g.projectId === projectId)
          .sort((a, b) => a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
          .map((g) => structuredClone(g)),
      );
    },
    rotateGitlabHook(connectedRepoId, at) {
      const row = gitlabProjects.get(connectedRepoId);
      if (!row) return Promise.resolve(null);
      row.hookGeneration += 1;
      row.lastHookAt = null;
      row.lastMergeRequestHookAt = null;
      row.droppedCommentHookCount = 0;
      row.droppedOtherHookCount = 0;
      row.lastDroppedHookAt = null;
      row.updatedAt = at;
      return Promise.resolve(structuredClone(row));
    },
    recordGitlabHookDelivery(connectedRepoId, at, notBefore, mergeRequest) {
      const row = gitlabProjects.get(connectedRepoId);
      if (row && (row.lastHookAt === null || row.lastHookAt < notBefore)) row.lastHookAt = at;
      if (
        row && mergeRequest &&
        (row.lastMergeRequestHookAt === null || row.lastMergeRequestHookAt < notBefore)
      ) {
        row.lastMergeRequestHookAt = at;
      }
      return Promise.resolve();
    },
    recordGitlabHookDrops(connectedRepoId, lane, count, at) {
      const row = gitlabProjects.get(connectedRepoId);
      if (row) {
        if (lane === "comments") row.droppedCommentHookCount += count;
        else row.droppedOtherHookCount += count;
        row.lastDroppedHookAt = at;
      }
      return Promise.resolve();
    },
    listRepoCommandAllowlist(connectedRepoId) {
      return Promise.resolve(
        [...commandAllowlist.values()].filter((e) => e.connectedRepoId === connectedRepoId),
      );
    },
    addRepoCommandAllowlistEntry(entry) {
      const key = `${entry.connectedRepoId}/${entry.provider}/${entry.subject}`;
      if (!commandAllowlist.has(key)) commandAllowlist.set(key, structuredClone(entry));
      return Promise.resolve();
    },
    removeRepoCommandAllowlistEntry(connectedRepoId, provider, subject) {
      commandAllowlist.delete(`${connectedRepoId}/${provider}/${subject}`);
      return Promise.resolve();
    },
    claimForgeEvent(record, reclaimProcessingBefore) {
      const existing = forgeEvents.get(record.deliveryId);
      if (existing !== undefined) {
        const stale = reclaimProcessingBefore !== undefined &&
          existing.outcome === "processing" &&
          existing.claimedAt !== null &&
          existing.claimedAt < reclaimProcessingBefore;
        if (!stale) return Promise.resolve(false);
        // Adoption moves the claim clock and leaves first-seen where it was, like the SQL store.
        forgeEvents.set(
          record.deliveryId,
          structuredClone({ ...record, createdAt: existing.createdAt }),
        );
        return Promise.resolve(true);
      }
      forgeEvents.set(record.deliveryId, structuredClone(record));
      return Promise.resolve(true);
    },
    getForgeEvent(deliveryId) {
      const record = forgeEvents.get(deliveryId);
      return Promise.resolve(record === undefined ? null : structuredClone(record));
    },
    recordForgeEvent(record) {
      // Both timestamps are somebody else's here too. A double that overwrites what the SQL
      // store keeps is a double that cannot fail on the bug it exists to catch.
      const existing = forgeEvents.get(record.deliveryId);
      forgeEvents.set(
        record.deliveryId,
        structuredClone(
          existing === undefined
            ? record
            : { ...record, createdAt: existing.createdAt, claimedAt: existing.claimedAt },
        ),
      );
      return Promise.resolve();
    },
    claimAutomationEvent(record, reclaimProcessingBefore) {
      const existing = automationEvents.get(record.eventId);
      if (existing !== undefined) {
        const stale = reclaimProcessingBefore !== undefined &&
          existing.outcome === "processing" &&
          existing.claimedAt !== null &&
          existing.claimedAt < reclaimProcessingBefore;
        if (!stale) return Promise.resolve(false);
        automationEvents.set(
          record.eventId,
          structuredClone({ ...record, createdAt: existing.createdAt }),
        );
        return Promise.resolve(true);
      }
      automationEvents.set(record.eventId, structuredClone(record));
      return Promise.resolve(true);
    },
    recordAutomationEvent(record) {
      const existing = automationEvents.get(record.eventId);
      // As the drizzle store: only a "processing" row is revisable — a verdict is final.
      if (existing !== undefined && existing.outcome !== "processing") return Promise.resolve();
      automationEvents.set(
        record.eventId,
        structuredClone(
          existing === undefined
            ? record
            : { ...record, createdAt: existing.createdAt, claimedAt: existing.claimedAt },
        ),
      );
      return Promise.resolve();
    },
    releaseAutomationEvent(eventId, claimedAt) {
      const existing = automationEvents.get(eventId);
      if (existing?.outcome === "processing" && existing.claimedAt === claimedAt) {
        automationEvents.delete(eventId);
      }
      return Promise.resolve();
    },
    getAutomationEvent(eventId) {
      return Promise.resolve(structuredClone(automationEvents.get(eventId) ?? null));
    },
    saveProgressComment(comment) {
      progressComments.set(comment.runId, structuredClone(comment));
      return Promise.resolve();
    },
    listOpenProgressComments() {
      const open = [...progressComments.values()].filter((c) => c.concludedAt === null);
      return Promise.resolve(structuredClone(open));
    },
    reserveForgeToolAction(action, max) {
      const held =
        forgeToolActions.filter((a) => a.runId === action.runId && a.tool === action.tool).length;
      if (held >= max) return Promise.resolve(false);
      forgeToolActions.push(structuredClone(action));
      return Promise.resolve(true);
    },
    completeForgeToolAction(id, runId, outcome) {
      const at = forgeToolActions.findIndex((a) =>
        a.id === id && a.runId === runId && a.state === "reserved"
      );
      if (at === -1) return Promise.resolve(false);
      forgeToolActions[at] = { ...forgeToolActions[at], ...structuredClone(outcome) };
      return Promise.resolve(true);
    },
    listForgeToolActions(runId) {
      return Promise.resolve(structuredClone(forgeToolActions.filter((a) => a.runId === runId)));
    },
    createPatch(patch, opts) {
      const cap = opts?.maxLinesPerRepo;
      if (cap !== undefined) {
        const lines = new Set(
          [...patches.values()].filter((p) =>
            p.runId === patch.runId && p.connectedRepoId === patch.connectedRepoId &&
            p.path === patch.path
          ).map((p) => p.line),
        );
        if (!lines.has(patch.line) && lines.size >= cap) return Promise.resolve(false);
      }
      patches.set(patch.id, { ...structuredClone(patch), version: 0 });
      return Promise.resolve(true);
    },
    getPatch(id) {
      const patch = patches.get(id);
      return Promise.resolve(patch ? structuredClone(patch) : null);
    },
    listPatchesByIds(ids) {
      const wanted = new Set(ids);
      return Promise.resolve(
        structuredClone([...patches.values()].filter((p) => wanted.has(p.id))),
      );
    },
    savePatch(patch) {
      const stored = patches.get(patch.id);
      patches.set(patch.id, {
        ...structuredClone(patch),
        version: stored === undefined ? 0 : (stored.version ?? 0) + 1,
      });
      return Promise.resolve();
    },
    settlePatchIf(patch, from, settleEvents, opts) {
      const stored = patches.get(patch.id);
      if (
        stored === undefined || stored.state !== "submitted" ||
        (stored.landed?.kind ?? null) !== from ||
        (opts?.unlessMergeRecorded === true &&
          merges.has(`${stored.connectedRepoId}\0${stored.forgeRef}`))
      ) return Promise.resolve(false);
      patches.set(patch.id, {
        ...stored,
        landed: structuredClone(patch.landed),
        memoryFateReportedAt: patch.memoryFateReportedAt,
        mergedCuedAt: patch.mergedCuedAt ?? null,
        mergedCueClaimedAt: patch.mergedCueClaimedAt ?? null,
        landingAskedAt: patch.landingAskedAt ?? null,
        updatedAt: patch.updatedAt,
        version: (stored.version ?? 0) + 1,
      });
      for (const event of settleEvents) {
        events.push(structuredClone(event));
        eventSeqs.push(nextEventSeq++);
      }
      return Promise.resolve(true);
    },
    markMissedProven(patchId, at) {
      const stored = patches.get(patchId);
      if (stored?.landed?.kind !== "missed" || stored.landed.unproven !== true) {
        return Promise.resolve(false);
      }
      const { unproven: _, ...landed } = stored.landed;
      patches.set(patchId, {
        ...stored,
        landed,
        updatedAt: at,
        version: (stored.version ?? 0) + 1,
      });
      return Promise.resolve(true);
    },
    listPatchesAwaitingMergedCue(limit, claimStaleBefore) {
      return Promise.resolve(structuredClone(
        [...patches.values()]
          .filter((p) => {
            const run = runs.get(p.runId);
            const task = tasks.get(p.taskId);
            const claim = p.mergedCueClaimedAt ?? null;
            return isJudged(p) && verdictFinal(p) && (p.mergedCuedAt ?? null) === null &&
              (claim === null || claim < claimStaleBefore) &&
              run !== undefined && !TERMINAL_STATES.has(run.state) &&
              task !== undefined &&
              hasLanding(task.landings ?? {}, p);
          })
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit),
      ));
    },
    recordChangeRequestMerge({ connectedRepoId, forgeRef, mergedInto, heads, at }) {
      const key = `${connectedRepoId}\0${forgeRef}`;
      const stored = merges.get(key) ?? {
        connectedRepoId,
        forgeRef,
        mergedInto: mergedInto ?? null,
        heads: [],
        mergedAt: at,
        version: 0,
        settledAt: null,
        attempts: 0,
        nextAskAt: null,
        releasedAt: null,
        releaseRetryAt: null,
      };
      const grown = grownHeads(stored.heads, heads);
      const next: ChangeRequestMerge = {
        ...stored,
        mergedInto: stored.mergedInto ?? mergedInto ?? null,
        ...(grown === null ? {} : {
          heads: grown,
          version: stored.version + 1,
          settledAt: null,
          attempts: 0,
          nextAskAt: null,
        }),
      };
      merges.set(key, next);
      return Promise.resolve(structuredClone(next));
    },
    getChangeRequestMerge(connectedRepoId, forgeRef) {
      const stored = merges.get(`${connectedRepoId}\0${forgeRef}`);
      return Promise.resolve(stored === undefined ? null : structuredClone(stored));
    },
    stampChangeRequestMerge(connectedRepoId, forgeRef, read, mark) {
      const key = `${connectedRepoId}\0${forgeRef}`;
      const stored = merges.get(key);
      if (
        stored === undefined || stored.version !== read.version ||
        stored.settledAt !== read.settledAt || stored.nextAskAt !== read.nextAskAt
      ) return Promise.resolve(false);
      const { asking, ...fields } = mark;
      merges.set(key, {
        ...stored,
        ...fields,
        version: asking === true ? stored.version + 1 : stored.version,
      });
      return Promise.resolve(true);
    },
    listTasksTargetingChangeRequest(connectedRepoId, thread) {
      return Promise.resolve(structuredClone(
        [...tasks.values()]
          .filter((t) =>
            t.targetChangeRequest?.connectedRepoId === connectedRepoId &&
            t.targetChangeRequest.thread === thread
          )
          .sort(compareNewestFirst)
          .map((t) => ({ ...t, landings: t.landings ?? {} })),
      ));
    },
    releaseMergedTarget({ taskId, connectedRepoId, thread, mergedInto, defaultBranch, at }) {
      // As the drizzle store: the core decides over the rows as they stand — the task's current
      // run by its id, as `tasks.current_run_id` names it — and everything it decides is written
      // at once, the release cue included.
      const stored = tasks.get(taskId);
      if (stored === undefined) {
        return Promise.resolve({ outcome: { kind: "none" as const }, cuedRunId: null });
      }
      const current = currentRunOf(taskId);
      const live = current !== undefined && !TERMINAL_STATES.has(current.state);
      const outcome = releaseMergedTarget({
        task: structuredClone({ ...stored, landings: stored.landings ?? {} }),
        run: live ? structuredClone(current) : null,
        runId: current?.id ?? "",
        hasPatch: current !== undefined && runHasPatchOn(current.id, connectedRepoId, thread),
        runPatches: [...patches.values()].filter((p) =>
          p.runId === current?.id && p.connectedRepoId === connectedRepoId
        ),
        connectedRepoId,
        thread,
        mergedInto,
        defaultBranch,
        at,
      });
      if (outcome.kind === "none") return Promise.resolve({ outcome, cuedRunId: null });
      // As the drizzle store: a run awaiting its prompt is owed its cue after the prompt.
      const deferred = outcome.kind === "moved" && live &&
        current.workItem.spec.instructions === null;
      tasks.set(taskId, {
        ...stored,
        repos: structuredClone(outcome.task.repos),
        targetChangeRequest: null,
        landings: structuredClone(
          deferred
            ? {
              ...outcome.task.landings,
              [outcome.path]: {
                ...outcome.task.landings[outcome.path],
                [DEFAULT_LINE]: {
                  ...outcome.task.landings[outcome.path]![DEFAULT_LINE]!,
                  releaseCueOwed: true as const,
                },
              },
            }
            : outcome.task.landings,
        ),
      });
      if (outcome.kind === "moved" && outcome.run !== null && current !== undefined) {
        runs.set(current.id, {
          ...current,
          workItem: structuredClone(outcome.run.workItem),
          updatedAt: outcome.run.updatedAt,
        });
      }
      events.push(structuredClone(outcome.event));
      eventSeqs.push(nextEventSeq++);
      let cuedRunId: string | null = null;
      if (outcome.kind === "moved" && live && !deferred) {
        appendMessage(releaseCueMessage({
          runId: current.id,
          path: outcome.path,
          onto: outcome.onto,
          generation: outcome.generation,
          thread,
          at,
        }));
        cuedRunId = current.id;
      }
      return Promise.resolve(structuredClone({ outcome, cuedRunId }));
    },
    listMergesOwingRelease(now, limit) {
      const retry = (m: ChangeRequestMerge) => m.releaseRetryAt ?? "";
      return Promise.resolve(structuredClone(
        [...merges.values()]
          .filter((m) =>
            m.releasedAt === null && (m.releaseRetryAt === null || m.releaseRetryAt <= now)
          )
          .sort((a, b) =>
            retry(a).localeCompare(retry(b)) ||
            a.mergedAt.localeCompare(b.mergedAt) ||
            a.connectedRepoId.localeCompare(b.connectedRepoId) ||
            a.forgeRef.localeCompare(b.forgeRef)
          )
          .slice(0, limit),
      ));
    },
    deferMergeRelease(connectedRepoId, forgeRef, until) {
      const key = `${connectedRepoId}\0${forgeRef}`;
      const stored = merges.get(key);
      if (stored !== undefined && stored.releasedAt === null) {
        merges.set(key, { ...stored, releaseRetryAt: until });
      }
      return Promise.resolve();
    },
    markMergeReleased(connectedRepoId, forgeRef, at) {
      const key = `${connectedRepoId}\0${forgeRef}`;
      const stored = merges.get(key);
      if (stored !== undefined && stored.releasedAt === null) {
        merges.set(key, { ...stored, releasedAt: at });
      }
      return Promise.resolve();
    },
    listChangeRequestMergesDue(now, limit) {
      // As the drizzle store's arms decide and order it: a record is due by any arm, each arm
      // naming the clock that made it due (none: never asked); never asked first, the freshest
      // merge first among them, then the earliest clock.
      const all = [...patches.values()];
      const clocks = (m: ChangeRequestMerge): Array<string | null> => {
        const free = m.nextAskAt === null || m.nextAskAt <= now;
        const out: Array<string | null> = [];
        if ((m.settledAt === null || m.nextAskAt !== null) && free) out.push(m.nextAskAt);
        if (
          m.settledAt !== null && free &&
          all.some((p) =>
            p.connectedRepoId === m.connectedRepoId && p.forgeRef === m.forgeRef &&
            p.state === "submitted" && p.landed === null
          )
        ) out.push(m.nextAskAt);
        return out;
      };
      const due = [...merges.values()].flatMap((m) => {
        const at = clocks(m);
        if (at.length === 0) return [];
        const set = at.filter((c) => c !== null).toSorted();
        return [{ m, unasked: at.includes(null), first: set[0] ?? null }];
      });
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      return Promise.resolve(structuredClone(
        due
          .sort((a, b) =>
            Number(b.unasked) - Number(a.unasked) ||
            (a.unasked ? cmp(b.m.mergedAt, a.m.mergedAt) : 0) ||
            (a.first === b.first
              ? 0
              : a.first === null
              ? 1
              : b.first === null
              ? -1
              : cmp(a.first, b.first)) ||
            cmp(a.m.connectedRepoId, b.m.connectedRepoId) || cmp(a.m.forgeRef, b.m.forgeRef)
          )
          .slice(0, limit)
          .map((d) => d.m),
      ));
    },
    listPatchesAwaitingLanding(limit, settledBefore) {
      return Promise.resolve(structuredClone(
        [...patches.values()]
          .filter((p) =>
            isJudged(p) && verdictFinal(p) && (p.landingAskedAt ?? null) === null &&
            p.landed!.at < settledBefore
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit),
      ));
    },
    listChangeRequestsDueMergePoll(now, closedSince, limit, polled, gitlab = null) {
      const isPolled = (repo: ConnectedRepo | undefined) =>
        repo !== undefined && repo.archivedAt === null && (
          (repo.provider === "github" && repo.installationId === null &&
            polled.includes("github")) ||
          (repo.provider === "gitlab" && gitlab !== null &&
            (polled.includes("gitlab") || gitlab.bot) &&
            gitlabProjects.get(repo.id)?.instance === gitlab.instance)
        );
      const seen = new Map<string, MergePollDue & { dueAt: string | null }>();
      for (const p of patches.values()) {
        const repo = connectedRepos.get(p.connectedRepoId);
        if (
          p.state !== "submitted" || p.forgeRef === null || !pollable(p, closedSince) ||
          !isPolled(repo)
        ) continue;
        const key = `${p.connectedRepoId}\0${p.forgeRef}`;
        const clock = mergePolls.get(key);
        if (clock !== undefined && clock.dueAt > now) continue;
        if (merges.has(key)) continue;
        const open = (seen.get(key)?.open ?? false) || p.landed === null;
        seen.set(key, {
          connectedRepoId: p.connectedRepoId,
          forgeRef: p.forgeRef,
          failures: clock?.failures ?? 0,
          gone: clock?.gone ?? 0,
          open,
          asked: clock !== undefined,
          dueAt: clock?.dueAt ?? null,
        });
      }
      // A poll asked for after a refused push, kept while a live task works the change request.
      for (const [key, clock] of mergePolls) {
        const [connectedRepoId, forgeRef] = key.split("\0");
        const repo = connectedRepos.get(connectedRepoId);
        if (
          clock.dueAt > now || merges.has(key) || !workedLive(connectedRepoId, forgeRef) ||
          !isPolled(repo)
        ) continue;
        seen.set(key, {
          connectedRepoId,
          forgeRef,
          failures: clock.failures,
          gone: clock.gone,
          open: true,
          asked: true,
          dueAt: clock.dueAt,
        });
      }
      const order = (a: string | null, b: string | null) =>
        a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
      return Promise.resolve(
        [...seen.values()]
          .sort((a, b) =>
            order(a.dueAt, b.dueAt) || order(a.connectedRepoId, b.connectedRepoId) ||
            order(a.forgeRef, b.forgeRef)
          )
          .slice(0, limit)
          .map(({ dueAt: _due, ...due }) => due),
      );
    },
    stampMergePoll(connectedRepoId, forgeRef, clock) {
      mergePolls.set(`${connectedRepoId}\0${forgeRef}`, { ...clock });
      return Promise.resolve();
    },
    pruneMergePolls(closedSince, limit) {
      let removed = 0;
      for (const key of [...mergePolls.keys()]) {
        if (removed >= limit) break;
        const [connectedRepoId, forgeRef] = key.split("\0");
        const held = [...patches.values()].some((p) =>
          p.connectedRepoId === connectedRepoId && p.forgeRef === forgeRef &&
          p.state === "submitted" && pollable(p, closedSince)
        );
        if (held || workedLive(connectedRepoId, forgeRef)) continue;
        mergePolls.delete(key);
        removed += 1;
      }
      return Promise.resolve(removed);
    },
    listPatchesDueLandingRule(limit) {
      const all = [...patches.values()];
      return Promise.resolve(structuredClone(
        all
          .filter((p) =>
            p.state !== "submitting" &&
            landedVerdict(
                p,
                all.filter((q) => q.taskId === p.taskId),
                tasks.get(p.taskId)?.landings ?? {},
              ).kind !== "none"
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit),
      ));
    },
    claimMergedCue(patchId, at, staleBefore) {
      const stored = patches.get(patchId);
      const held = stored?.mergedCueClaimedAt ?? null;
      if (
        stored === undefined || (stored.mergedCuedAt ?? null) !== null ||
        (held !== null && held >= staleBefore)
      ) return Promise.resolve(false);
      patches.set(patchId, { ...stored, mergedCueClaimedAt: at });
      return Promise.resolve(true);
    },
    markPatchMergedCued(patchId, at, read) {
      const stored = patches.get(patchId);
      if (
        stored === undefined || (stored.mergedCuedAt ?? null) !== null ||
        stored.landed?.kind !== read.kind ||
        (read.claimedAt !== undefined && (stored.mergedCueClaimedAt ?? null) !== read.claimedAt)
      ) {
        return Promise.resolve(false);
      }
      patches.set(patchId, { ...stored, mergedCuedAt: at });
      return Promise.resolve(true);
    },
    markMergedCuesOfEndedRuns(limit, at) {
      const due = [...patches.values()]
        .filter((p) => {
          const run = runs.get(p.runId);
          return isJudged(p) && (p.mergedCuedAt ?? null) === null &&
            (run === undefined || TERMINAL_STATES.has(run.state));
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
      for (const p of due) patches.set(p.id, { ...p, mergedCuedAt: at });
      return Promise.resolve(due.length);
    },
    markPatchFateReported(patch, at) {
      const stored = patches.get(patch.id);
      if (
        stored !== undefined && stored.state === patch.state &&
        (stored.landed?.kind ?? null) === (patch.landed?.kind ?? null)
      ) {
        patches.set(patch.id, { ...stored, memoryFateReportedAt: at });
      }
      return Promise.resolve();
    },
    savePatchIfState(patch, expected, lease, readVersion, written = []) {
      const stored = patches.get(patch.id);
      if (stored === undefined || !expected.includes(stored.state)) return Promise.resolve(null);
      if (lease !== undefined && stored.leaseExpiresAt !== lease) return Promise.resolve(null);
      if (readVersion !== undefined && (stored.version ?? 0) !== readVersion) {
        return Promise.resolve(null);
      }
      const version = (stored.version ?? 0) + 1;
      // As the drizzle store: the marks with writers of their own are left as they are.
      patches.set(patch.id, {
        ...structuredClone(patch),
        memoryFateReportedAt: stored.memoryFateReportedAt,
        mergedCuedAt: stored.mergedCuedAt ?? null,
        mergedCueClaimedAt: stored.mergedCueClaimedAt ?? null,
        landingAskedAt: stored.landingAskedAt ?? null,
        version,
      });
      for (const event of written) {
        events.push(structuredClone(event));
        eventSeqs.push(nextEventSeq++);
      }
      return Promise.resolve(version);
    },
    listPatches(query) {
      const limit = clampPageLimit(query?.limit);
      const after = decodeListCursor(query?.cursor);
      const matched = [...patches.values()]
        .filter((p) => query?.state === undefined || p.state === query.state)
        .filter((p) => query?.scope === undefined || inScope(p.taskId, query.scope))
        .filter((p) => after === null || isOlder(p, after))
        .sort(compareNewestFirst);
      const page = matched.slice(0, limit);
      const last = page.at(-1);
      return Promise.resolve({
        patches: structuredClone(page),
        nextCursor: matched.length > limit && last !== undefined ? encodeListCursor(last) : null,
      });
    },
    listPatchesAwaitingHookCheck() {
      const waiting = [...patches.values()].filter((p) =>
        (p.state === "pending_approval" || p.state === "queued") && p.hookCheck === null &&
        connectedRepos.get(p.connectedRepoId)?.provider === "local"
      );
      return Promise.resolve(structuredClone(waiting));
    },
    listActivePatches() {
      const active = [...patches.values()].filter((p) =>
        SWEEPABLE_PATCH_STATES.includes(p.state) &&
        (p.state !== "failed" || p.nextAttemptAt !== null)
      );
      return Promise.resolve(structuredClone(active));
    },
    patchesForTask(taskId) {
      const forTask = [...patches.values()]
        .filter((p) => p.taskId === taskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(forTask));
    },
    patchesForSet(setId) {
      const forSet = [...patches.values()]
        .filter((p) => p.setId === setId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(forSet));
    },
    findPatchByRepoAndHead(connectedRepoId, headSha) {
      const found = [...patches.values()]
        .filter((p) => p.connectedRepoId === connectedRepoId && p.headSha === headSha)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return Promise.resolve(found ? structuredClone(found) : null);
    },
    patchesByRepoAndForgeRef(connectedRepoId, forgeRef) {
      // No state filter, exactly as the drizzle store: a settled patch must still be found, so
      // a reopened pull request's merge webhook reaches the patches that opened it.
      const found = [...patches.values()]
        .filter((p) => p.connectedRepoId === connectedRepoId && p.forgeRef === forgeRef)
        // Stable: rows born at one instant (a fake clock) keep their birth order.
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(found));
    },
    listPatchesAwaitingMemoryFate() {
      const owed = [...patches.values()]
        .filter((p) =>
          p.memoryFateReportedAt === null &&
          (p.landed !== null || ["failed", "rejected", "superseded"].includes(p.state)) &&
          verdictFinal(p)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return Promise.resolve(structuredClone(owed));
    },
    listRepoAccess(userId) {
      return Promise.resolve(structuredClone(repoAccess.get(userId) ?? []));
    },
    saveRepoAccess(rows) {
      for (const row of rows) {
        const held = repoAccess.get(row.userId) ?? [];
        const kept = held.filter((r) => r.connectedRepoId !== row.connectedRepoId);
        repoAccess.set(row.userId, [...kept, structuredClone(row)]);
      }
      return Promise.resolve();
    },
    getEgressAllowlist() {
      return Promise.resolve(allowlist === null ? null : structuredClone(allowlist));
    },
    saveEgressAllowlist(next) {
      allowlist = structuredClone(next);
      return Promise.resolve();
    },
    getReservedCapacity() {
      return Promise.resolve(reservedCapacity === null ? null : structuredClone(reservedCapacity));
    },
    saveReservedCapacity(next) {
      reservedCapacity = structuredClone(next);
      return Promise.resolve();
    },
    async close() {},
  };
}
