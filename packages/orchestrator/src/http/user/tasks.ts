import type { ForgeProvider, Patch, Run, Task } from "../../core/types.ts";
import { cancelRun } from "../../core/cancel_run.ts";
import { finishRun } from "../../core/finish_run.ts";
import { awaitsPrompt } from "../../core/titles.ts";
import { ENVIRONMENT_SETUP } from "../../core/environment_setup.ts";
import { toEnvironmentView } from "../environments_api.ts";
import {
  clampPageLimit,
  decodeListCursor,
  MAX_TASK_PAGE,
  TASK_STATUS_BUCKETS,
  type TaskListQuery,
  type TaskListRow,
  type TaskStatusBucket,
} from "../../ports/task_store.ts";
import type { Principal, WiredDeps } from "../app.ts";
import { refuseUnless } from "@ryph/auth/gates";
import { json, type Route, route } from "@ryph/shared/http";
import { runGrantsFor, scopeFor } from "../scope.ts";
import { endAtBearerExpiry } from "@ryph/sealed";
import { EMBEDDED_MESSAGES, toPublicPatch, toPublicRun } from "./public_views.ts";
import { nameSenders } from "./message_senders.ts";
import { artifactsOfRuns, mayReadArtifacts } from "../artifacts_api.ts";

/**
 * How long a live task tail gathers changes before reading them. A run heartbeating, a patch
 * landing and a message arriving within the same moment are one read and one frame each, not
 * three rounds of both — and the window is short enough that nobody sees it.
 */
const STREAM_COALESCE_MS = 150;

/**
 * The comment that keeps a task tail's connection from being reaped by an idle proxy. A settled
 * list sends nothing for hours, which to anything in the middle looks exactly like a dead socket.
 */
const STREAM_KEEPALIVE_MS = 25_000;

// A heartbeat proves transport liveness, not that reads are progressing. Bound the whole
// snapshot or delta (including agent names and every chunk) so a stuck read forces repair.
const STREAM_READ_DEADLINE_MS = 30_000;

/**
 * The origins a task may have, as the query parser validates them.
 *
 * Spelled as a record over the union rather than an array of it, so the compiler is what keeps
 * the two in step: a new origin added to `Task["origin"]` and forgotten here stops the build
 * instead of turning `?origin=<the new one>` into a 400 nobody notices. It was `chat` that went
 * missing the first time, for exactly the length of time it took to write this comment.
 */
const TASK_ORIGINS = Object.keys(
  {
    user: true,
    "break-glass": true,
    forge: true,
    automation: true,
    chat: true,
    token: true,
  } satisfies Record<Task["origin"], true>,
) as readonly Task["origin"][];

/**
 * A task list's filters, off the query string, for both the paged route and the live one — one
 * parser so a tail can never watch a different list than the page it is attached to.
 *
 * Every filter takes a comma-separated list and means OR within itself; the filters AND together.
 * An unknown value is a 400 rather than a silently empty page: a client asking for a status that
 * does not exist has a bug, and answering "no tasks" hides it.
 *
 * `mine=true` resolves to the CALLER, never to a user id from the query — "whose tasks" is not
 * a thing one person may ask about another through a filter.
 */
function parseTaskListQuery(
  params: URLSearchParams,
  caller: Principal,
): TaskListQuery | Response {
  const list = (name: string): string[] => {
    const raw = params.get(name);
    if (raw === null) return [];
    return [...new Set(raw.split(",").map((v) => v.trim()).filter((v) => v !== ""))];
  };

  const query: TaskListQuery = {};

  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1) {
      return json(400, { error: "limit must be a whole number of rows" });
    }
    query.limit = Number(limit);
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    // Opaque on the wire, but not unchecked: a cursor we did not issue is a client error, not a
    // silent read of the newest page under a caller that thinks it is paging.
    if (decodeListCursor(cursor) === null) {
      return json(400, { error: "cursor is not a cursor this surface issued" });
    }
    query.cursor = cursor;
  }

  const q = params.get("q");
  if (q !== null && q.trim() !== "") {
    if (q.length > 200) return json(400, { error: "q is too long" });
    query.q = q;
  }

  const statuses = list("status");
  const buckets = Object.keys(TASK_STATUS_BUCKETS) as TaskStatusBucket[];
  const unknown = statuses.find((v) => !buckets.includes(v as TaskStatusBucket));
  if (unknown !== undefined) {
    return json(400, { error: `unknown status "${unknown}"`, statuses: buckets });
  }
  if (statuses.length > 0) query.statuses = statuses as TaskStatusBucket[];

  const origins = list("origin");
  const badOrigin = origins.find((v) => !TASK_ORIGINS.includes(v as Task["origin"]));
  if (badOrigin !== undefined) {
    return json(400, { error: `unknown origin "${badOrigin}"`, origins: TASK_ORIGINS });
  }
  if (origins.length > 0) query.origins = origins as Task["origin"][];

  const agentIds = list("agent");
  if (agentIds.length > 0) query.agentIds = agentIds;

  const workspaceId = params.get("workspace");
  if (workspaceId !== null && workspaceId !== "") query.workspaceId = workspaceId;

  const connectedRepoId = params.get("repo");
  if (connectedRepoId !== null && connectedRepoId !== "") query.connectedRepoId = connectedRepoId;

  if (params.get("mine") === "true") {
    // Break-glass is not a person and has no tasks of its own to narrow to; saying so is better
    // than answering with the empty list a null user id would produce.
    if (caller.kind !== "user") {
      return json(400, { error: "mine=true needs a user; break-glass has no tasks of its own" });
    }
    query.requestedByUserId = caller.userId;
  }

  for (const [name, field] of [["from", "createdFrom"], ["to", "createdTo"]] as const) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
      return json(400, { error: `${name} must be an ISO-8601 timestamp` });
    }
    // NORMALIZED, not passed through. `created_at` is text — every writer produces it with
    // `toISOString()` — and the store compares the bound value to it as text, so a bound
    // "Sep 5 2026" parses fine here and then sorts before every row in the table: a 400 would
    // have been honest, an empty 200 is not. Round-tripping through Date is what makes the
    // comparison mean what the caller asked.
    query[field] = new Date(at).toISOString();
  }

  return query;
}

export function taskRoutes(deps: WiredDeps): Route[] {
  const { store, runnerControl, diag } = deps;

  /**
   * A page of task rows as the list draws them. Two reads for the whole page — the tasks, then
   * the agents they name — with run state denormalized on the task and the heartbeat-owned
   * declaration fetched by an indexed subquery in that same task-page statement.
   */
  const describeTasks = async (rows: TaskListRow[]) => {
    const agents = await store.listAgentsByIds([...new Set(rows.map((r) => r.task.agentId))]);
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    return rows.map(({ task, currentRun, lastActivityAt }) => ({
      id: task.id,
      // Null exactly while the task awaits its prompt, which `awaitingPrompt` says outright.
      title: task.spec.title,
      awaitingPrompt: awaitsPrompt(task),
      agentId: task.agentId,
      agentName: agentName.get(task.agentId) ?? null,
      origin: task.origin,
      workspaceId: task.workspaceId,
      connectedRepoIds: task.repos.flatMap((r) =>
        r.connectedRepoId === null ? [] : [r.connectedRepoId]
      ),
      requestedByUserId: task.requestedByUserId,
      createdAt: task.createdAt,
      lastActivityAt,
      state: currentRun.state,
      phase: currentRun.phase,
      idleState: currentRun.idleState ?? null,
      declaredOutcome: currentRun.declaredOutcome ?? null,
    }));
  };

  const listTasks = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const params = new URL(req.url).searchParams;
    // `?ids=` resolves only the tasks named. That is what a page holding a report's task ids
    // wants — paging the list to turn twenty ids into twenty titles would read rows it then
    // throws away.
    const asked = params.get("ids");
    if (asked !== null) {
      const ids = [
        ...new Set(asked.split(",").map((id) => id.trim()).filter((id) => id !== "")),
        // At most a screenful; a longer list is a caller doing something this is not for.
      ].slice(0, MAX_TASK_PAGE);
      const scope = await scopeFor(deps, caller, "tasks:read-all");
      // Metadata resolution (for example usage labels), not history membership: retain
      // abandoned drafts here, still scoped to the caller. Live tails do not opt into this.
      const named = await store.listTasks({
        ids,
        limit: MAX_TASK_PAGE,
        scope,
        includeAbandonedDrafts: true,
      });
      return json(200, {
        tasks: await describeTasks(named.tasks),
        nextCursor: null,
        hasMore: false,
      });
    }
    const query = parseTaskListQuery(params, caller);
    if (query instanceof Response) return query;
    query.scope = await scopeFor(deps, caller, "tasks:read-all");
    const page = await store.listTasks(query);
    return json(200, {
      tasks: await describeTasks(page.tasks),
      nextCursor: page.nextCursor,
      hasMore: page.nextCursor !== null,
    });
  };

  /**
   * The task list, live. The list page loads a page over the route above and then holds this
   * open; every row that changes arrives here instead of the page asking again on a timer —
   * which is what a list of ten thousand tasks cannot afford, and what made a settled list poll
   * anyway just in case.
   *
   * The frames, all JSON:
   * - `sync`   the newest page matching these filters, sent on open AND on every reconnect. It
   *            is the client's repair: anything it holds within that range and absent from it
   *            has left the filters while it was not listening.
   * - `task`   one row, inserted or replaced at its sort position.
   * - `leave`  `{ id }` — this row no longer matches the filters, drop it.
   * - `heartbeat` `{}` — transport liveness, even when no tasks change.
   *
   * Reconnection is EventSource's own (the browser retries), and because `sync` repeats on every
   * connection there is no cursor to resume from and nothing to miss. There is no `done`: a task
   * list is never finished.
   */
  const streamTasks = async (req: Request): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const query = parseTaskListQuery(new URL(req.url).searchParams, caller);
    if (query instanceof Response) return query;
    query.scope = await scopeFor(deps, caller, "tasks:read-all");

    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let readDeadline: ReturnType<typeof setTimeout> | undefined;
    // One flag for "this tail is over", read by everything that would otherwise arm a timer or
    // write a frame. A client that hangs up DURING the snapshot read is the case that needs it:
    // `cancel` runs while `start` is still awaiting, and without this the keepalive it arms
    // afterwards would outlive the connection until its first tick.
    let stopped = false;
    const stop = () => {
      stopped = true;
      unsubscribe();
      if (keepalive !== undefined) clearInterval(keepalive);
      if (flush !== undefined) clearTimeout(flush);
      if (readDeadline !== undefined) clearTimeout(readDeadline);
    };

    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enqueue = (frame: string) => {
          if (stopped) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // The client went away mid-frame. `cancel` is the cleanup that normally runs, but a
            // tail that never writes again would never learn it had gone: stop here too, so the
            // subscription and the keepalive die with the connection rather than on the next
            // change to a list nobody is reading.
            stop();
          }
        };
        const send = (event: string, data: unknown) =>
          enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // A failed read must not leave a healthy-looking stream missing data. Reopening sends
        // a fresh snapshot, repairing both a failed initial read and any lost delta.
        const disconnect = () => {
          if (stopped) return;
          stop();
          controller.close();
        };
        const beginRead = (phase: "snapshot" | "read") => {
          readDeadline = setTimeout(() => {
            diag.warn(`task_stream.${phase}_failed`, { err: "read deadline exceeded" });
            disconnect();
          }, STREAM_READ_DEADLINE_MS);
        };
        const endRead = () => {
          clearTimeout(readDeadline);
          readDeadline = undefined;
        };
        // A comment straight away, before the snapshot is read: a server (Bun's among them) holds
        // a response's headers back until its first chunk, and every hop in front of it does too,
        // so without one an EventSource sits in "connecting" until the snapshot or a keepalive.
        // A comment is not a frame, so the snapshot is still the first thing a client reads.
        enqueue(": open\n\n");

        // Ids heard about but not yet read: a run heartbeating and a patch landing in the same
        // second are one read, not two, and a storm across many tasks is one read for all of them.
        const pending = new Set<string>();
        // The snapshot has to be the FIRST frame: a `task` that overtook it would reach a client
        // holding nothing, which appends it as the whole list — and the `sync` that follows then
        // reads it as a row below its own range, so the list keeps one stale row and a null
        // cursor forever. Subscribing still happens first, so nothing published in between is
        // lost; it waits in `pending` and the first drain carries it.
        let synced = false;
        // At most one read in flight per tail. Two overlapping drains can finish out of order,
        // and a `task` frame carrying the older row would then land after the newer one — the
        // list would show a state the run has already left, with nothing to correct it until
        // the next change to that same row.
        let draining: Promise<void> = Promise.resolve();

        const drain = async () => {
          const ids = [...pending];
          pending.clear();
          if (ids.length === 0 || stopped) return;
          beginRead("read");
          try {
            // Asked with THIS tail's own filters, so what a row gets — a frame or a goodbye —
            // is decided by the same predicate the page was built from and the two can never
            // drift. Rows that come back still belong; ids that do not come back have left the
            // filters (or the run they showed has moved out of the status the viewer picked),
            // which is a `leave`.
            //
            // CHUNKED, because `pending` has no bound — a deploy that touches every task, or a
            // storm across a big list, puts more ids in one window than a page can answer — and
            // a read that silently truncated to `MAX_TASK_PAGE` would call every id past the
            // hundredth a `leave` and wipe the rest of the client's list.
            for (let at = 0; at < ids.length; at += MAX_TASK_PAGE) {
              if (stopped) return;
              const chunk = ids.slice(at, at + MAX_TASK_PAGE);
              const matching = await store.listTasks({
                ...query,
                cursor: undefined,
                // The whole chunk fits by construction: the store asks for `limit + 1` and keeps
                // `limit`, and a chunk is never longer than the clamp allows.
                limit: clampPageLimit(chunk.length),
                ids: chunk,
              });
              if (stopped) return;
              const seen = new Set(matching.tasks.map((r) => r.task.id));
              for (const row of await describeTasks(matching.tasks)) send("task", row);
              for (const id of chunk) if (!seen.has(id)) send("leave", { id });
            }
          } catch (err) {
            diag.warn("task_stream.read_failed", { err: String(err) });
            disconnect();
          } finally {
            endRead();
          }
        };

        /** Opens the coalescing window, once, and queues the read behind whatever is running. */
        const schedule = () => {
          if (stopped || !synced || pending.size === 0 || flush !== undefined) return;
          flush = setTimeout(() => {
            flush = undefined;
            // `then(drain, drain)` and not `finally`: a drain that rejected must not poison the
            // chain for every drain after it. Nothing in `drain` throws today — it catches its
            // own read — and this is what keeps that from becoming load-bearing.
            draining = draining.then(drain, drain);
          }, STREAM_COALESCE_MS);
        };

        // Subscribe FIRST, so nothing published while the snapshot is being read is lost — it
        // lands in `pending` and the first drain carries it.
        unsubscribe = deps.taskFeed.subscribe((taskId) => {
          if (stopped) return;
          pending.add(taskId);
          schedule();
        });
        beginRead("snapshot");
        try {
          const snapshot = await store.listTasks(query);
          if (stopped) return;
          send("sync", {
            tasks: await describeTasks(snapshot.tasks),
            nextCursor: snapshot.nextCursor,
            hasMore: snapshot.nextCursor !== null,
          });
        } catch (err) {
          diag.warn("task_stream.snapshot_failed", { err: String(err) });
          disconnect();
          return;
        } finally {
          endRead();
        }
        if (stopped) return;
        synced = true;
        // Whatever arrived while the snapshot was being read goes now.
        schedule();

        if (stopped) return;
        keepalive = setInterval(() => send("heartbeat", {}), STREAM_KEEPALIVE_MS);
      },
      cancel: stop,
    });

    const res = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
    // Gated once, at open: an API token's stream ends when its bearer does, and the client
    // reconnects with a fresh one, which the gate checks again. A session's stream is left
    // alone: its EventSource would reconnect with the same expired cookie and be refused.
    return caller.kind === "user" && caller.via === "token" ? endAtBearerExpiry(req, res) : res;
  };

  const getTask = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:read");
    if (denied) return denied;
    const scope = await scopeFor(deps, caller, "tasks:read-all");
    const task = await store.getTask(params.id, scope);
    if (!task) return json(404, { error: "no such task" });
    const [agent, runs, patches, workspace, connected] = await Promise.all([
      store.getAgent(task.agentId),
      store.runsForTask(task.id),
      store.patchesForTask(task.id),
      task.workspaceId === null ? null : store.getWorkspace(task.workspaceId),
      store.listConnectedRepos(),
    ]);
    const providers = new Map(connected.map((repo) => [repo.id, repo.provider]));
    const withEvents = await Promise.all(runs.map(async (run) => ({
      ...toPublicRun(run),
      // Proof, for the services holding the run's records, that this reader passed the scope.
      grants: await runGrantsFor(deps, caller, run.id),
      events: await store.listEvents(run.id),
      // The TAIL of each run's inbox, not all of it: this body already carries every run of the
      // task, and a long-lived run's messages are unbounded at 16 KB each.
      messages: await store.listRecentRunMessages(run.id, EMBEDDED_MESSAGES),
      // The forge writes the run's agent asked for, oldest first — each linking to what it made.
      forgeActions: await store.listForgeToolActions(run.id),
    })));
    // Who said each thing, by name: every run's people at once, so one who spoke to three runs
    // of the task is read once (message_senders.ts).
    const named = await nameSenders(
      deps.identityDirectory,
      caller,
      withEvents.map((run) => run.messages),
    );
    const runsOut = withEvents.map((run, i) => ({ ...run, messages: named[i] }));
    // The response the latest run is the attempt at, when it is one — the page links to it.
    const current = runs.at(-1);
    const response = current === undefined ? null : await store.findResponseByRun(current.id);
    return json(200, {
      task: {
        ...task,
        // Each repo's forge, which names its threads: `mr-7` is `!7` on GitLab, and a repo's
        // address cannot tell GitLab from GitHub.
        repos: task.repos.map((repo) => ({
          ...repo,
          provider: repo.connectedRepoId === null
            ? null
            : providers.get(repo.connectedRepoId) ?? null,
        })),
        awaitingPrompt: awaitsPrompt(task),
      },
      agent,
      workspace,
      runs: runsOut,
      // Each with the suite it is judged by (`checksSuiteId`), the one its forge is told about.
      patches: patchesWithChecks(
        patches,
        providers,
        deps.checks ? await deps.checks.suiteIdsForPatches(patches) : {},
      ),
      response,
      environmentBuilds: await environmentBuildsOf(task, runs),
      // The check suites its runs asked for and its patches' heads got, oldest first — what the
      // run card and the patch rows show. Empty where checks do not run.
      checkSuites: deps.checks ? await deps.checks.viewsForTask(task, runs, patches, scope) : [],
      // The artifacts its runs published, each with the versions they did — instance-wide by
      // design, so only to a caller who may read artifacts at all.
      artifacts: deps.artifacts && mayReadArtifacts(caller)
        ? await artifactsOfRuns(deps.artifacts, runs.map((r) => r.id))
        : [],
    });
  };

  const patchesWithChecks = (
    patches: Patch[],
    providers: Map<string, ForgeProvider>,
    ids: Record<string, string>,
  ) => {
    return patches.map((patch) => {
      const provider = providers.get(patch.connectedRepoId) ?? null;
      return {
        ...toPublicPatch(patch, provider),
        // Which forge, as the approval queue's rows say it: a local patch's hook warning keys
        // on it.
        provider,
        checksSuiteId: ids[patch.id] ?? null,
      };
    });
  };

  /**
   * The environment builds a task's patches asked for (core/environment_feedback.ts), with each
   * build as the Environment card shows one — what the run page renders beside the messages
   * that told the run. Empty where environments are not built. Every submitted patch is checked,
   * and nearly every check ends in "no build: .ryph/ unchanged"; only a setup task, whose run is
   * told every note, lists them — any other task lists the builds its patches really asked for,
   * and the few notes its run was told are in its transcript.
   */
  const environmentBuildsOf = async (task: Pick<Task, "purpose">, runs: Run[]) => {
    const service = deps.environments ?? null;
    if (service === null) return [];
    const setup = task.purpose === ENVIRONMENT_SETUP;
    const rows = (await Promise.all(runs.map((run) => service.store.listPatchBuildsForRun(run.id))))
      .flat()
      .filter((row) => setup || row.environmentId !== null);
    return await Promise.all(rows.map(async (row) => {
      const environment = row.environmentId === null
        ? null
        : await service.store.getEnvironment(row.environmentId);
      return { ...row, environment: environment === null ? null : toEnvironmentView(environment) };
    }));
  };

  const cancelTask = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const task = await store.getTask(params.id, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!task) return json(404, { error: "no such task" });
    const run = (await store.runsForTask(task.id)).at(-1);
    if (!run) return json(409, { error: "task has no run" });

    const outcome = await cancelRun({
      store,
      runnerControl,
      environments: deps.environments,
      now: deps.now,
    }, run);
    if (outcome.kind === "terminal") {
      return json(409, { error: `run is already terminal (${run.state})` });
    }
    return json(202, { runId: run.id, desiredState: "cancelled" });
  };

  /**
   * A person finishing the task's run from its page, once its agent said it was done: the run
   * ends at the agent's next settle as if the agent had called its finish, so it concludes on the
   * outcome the agent declared rather than as cancelled (core/finish_run.ts). Gated like cancel;
   * a run that is not running, whose agent has not said it is done, or that is already finishing
   * is refused with why.
   */
  const finishTask = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const task = await store.getTask(params.id, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!task) return json(404, { error: "This task doesn't exist" });
    const run = (await store.runsForTask(task.id)).at(-1);
    if (!run) return json(409, { error: "This task hasn't started a run yet" });
    const outcome = await finishRun(deps, run, {
      kind: "user",
      userId: caller.kind === "user" ? caller.userId : "break-glass",
    });
    if (outcome.kind === "refused") return json(outcome.status, { error: outcome.error });
    return json(202, { runId: run.id });
  };

  /**
   * "Start it anyway": the task's run, waiting on an environment build, launches now on what is
   * ready — the newest ready default-branch image, or the default one. Anyone who may cancel the
   * run may do this; the build goes on for the runs after it.
   */
  const startWithoutEnvironment = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    const denied = refuseUnless(caller, "tasks:steer");
    if (denied) return denied;
    const task = await store.getTask(params.id, await scopeFor(deps, caller, "tasks:steer-all"));
    if (!task) return json(404, { error: "no such task" });
    const run = (await store.runsForTask(task.id)).at(-1);
    if (!run) return json(409, { error: "task has no run" });
    const started = deps.startWithoutEnvironment
      ? await deps.startWithoutEnvironment(
        run.id,
        caller.kind === "user" ? caller.name || caller.email : "an operator",
      )
      : false;
    if (!started) return json(409, { error: "the run is not waiting for an environment" });
    return json(202, { runId: run.id });
  };

  return [
    route("GET", "/v1/tasks", listTasks),
    // The literal stream path must precede :id in the router's first-match list.
    route("GET", "/v1/tasks/stream", streamTasks),
    route("GET", "/v1/tasks/:id", getTask),
    route("POST", "/v1/tasks/:id/cancel", cancelTask),
    route("POST", "/v1/tasks/:id/finish", finishTask),
    route("POST", "/v1/tasks/:id/start-without-environment", startWithoutEnvironment),
  ];
}
