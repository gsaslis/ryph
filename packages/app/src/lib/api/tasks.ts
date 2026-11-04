import { z } from "zod";
import {
  ensureFreshSessionResult,
  renewSessionResult,
  type SessionReadiness,
} from "$lib/utils/auth/auth";
import { apiCall } from "./call";
import { whileVisible } from "./visible-stream";
import {
  type CreateTaskResponse,
  createTaskResponseSchema,
  type RunLimits,
  type TaskDetail,
  taskDetailSchema,
  type TaskOrigin,
  type TaskPage,
  taskPageSchema,
  type TaskStatusBucket,
  type TaskSummary,
  taskSummarySchema,
  type ThinkingLevel,
} from "./types";

export type CreateTaskInput =
  & {
    agentId: string;
    /** No instructions starts the task waiting for them: the first message sent to its run
     * becomes them. No title has one generated. */
    spec: { title?: string; instructions?: string };
    /** Pick one of the agent's allowed models for this run; absent uses the policy default. */
    model?: string;
    /** Pick how hard the model thinks for this run; absent uses the policy default. Refused for
     * an agent with no model policy, as `model` is. */
    thinking?: ThinkingLevel;
    /** This run's limits, each at most the agent's effective value unless an admin raises it up
     * to the ceiling; absent fields fall through to the agent's policy. */
    limits?: Partial<RunLimits>;
    /** The task this one re-runs: the images it started with come along, so the `[image N]`
     * markers in its instructions still point at them. */
    rerunOf?: string;
  }
  & (
    // Exactly one source: a connected repo (with an optional base ref defaulting to the repo's
    // default branch), or a workspace at its saved refs.
    | { connectedRepoId: string; ref?: string; workspaceId?: never }
    | { workspaceId: string; connectedRepoId?: never; ref?: never }
  )
  & {
    /** The change request the task works on — a GitHub pull request, a Radicle patch: its repo
     * checks out that change request's head and the commits are pushed onto it. Only with a
     * connected repo or a workspace, and never together with `ref` — the head IS the ref. */
    targetChangeRequest?: { connectedRepoId: string; thread: string };
  };

/**
 * How a list is narrowed. Every field is optional and they AND together; a list within a field
 * means OR. This is the whole of what the server accepts, and the same object drives the paged
 * read and the live tail — a tail watching a different list than the page it feeds would show
 * rows that the page would never have loaded.
 *
 * NOTHING SETS ANY OF THIS YET. The API has the filters and they are tested; the surface that
 * offers them to a person is a deliberate follow-up, so every list here is currently the whole
 * one. This is the seam that work attaches to.
 */
export interface TaskFilters {
  /** Full-text over the title, server-side. The last word matches as a prefix, so it is usable
   * while someone is still typing it. */
  q?: string;
  statuses?: TaskStatusBucket[];
  agentIds?: string[];
  origins?: TaskOrigin[];
  workspaceId?: string;
  connectedRepoId?: string;
  /** Only the signed-in user's own tasks. There is deliberately no filter for anyone else's. */
  mine?: boolean;
  /** ISO-8601 bounds on `createdAt`, inclusive. */
  from?: string;
  to?: string;
}

/** How many rows a page asks for. The server caps this at 100 and defaults to 50. */
export const TASK_PAGE_SIZE = 50;

/** The filters as the API takes them. Empty filters make an empty query string. */
export function taskFiltersToParams(filters: TaskFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.statuses?.length) params.set("status", filters.statuses.join(","));
  if (filters.origins?.length) params.set("origin", filters.origins.join(","));
  if (filters.agentIds?.length) params.set("agent", filters.agentIds.join(","));
  if (filters.workspaceId) params.set("workspace", filters.workspaceId);
  if (filters.connectedRepoId) params.set("repo", filters.connectedRepoId);
  if (filters.mine) params.set("mine", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params;
}

/**
 * One page of tasks, newest first. Rows beyond `nextCursor` are a second call — the list is
 * unbounded and a page that read the whole table is what this replaced.
 */
export async function getTasks(
  f = fetch,
  filters: TaskFilters = {},
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<TaskPage> {
  const params = taskFiltersToParams(filters);
  params.set("limit", String(opts.limit ?? TASK_PAGE_SIZE));
  if (opts.cursor) params.set("cursor", opts.cursor);
  return taskPageSchema.parse(await apiCall(f, `/v1/tasks?${params}`));
}

/**
 * Only the tasks named, in one read. A page holding a handful of ids — a usage report's top
 * tasks, say — wants their titles, not a page of the list it would then throw away.
 */
export async function getTasksByIds(f = fetch, ids: readonly string[]): Promise<TaskSummary[]> {
  if (ids.length === 0) return [];
  const res = await apiCall(f, `/v1/tasks?ids=${encodeURIComponent(ids.join(","))}`);
  return z.object({ tasks: z.array(taskSummarySchema) }).parse(res).tasks;
}

export type TaskStreamState =
  | "connecting"
  | "live"
  | "retrying"
  | "failed"
  | "auth-required"
  | "suspended";

export interface TaskStreamSubscription {
  close(): void;
  /** Starts a fresh recovery budget. Does nothing while suspended or after close. */
  retry(): void;
}

const TASK_STREAM_SYNC_TIMEOUT_MS = 15_000;
const TASK_STREAM_IDLE_TIMEOUT_MS = 75_000;
const TASK_STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Live-tails the task list over SSE through the same-origin proxy (cookies ride along;
 * EventSource cannot carry a bearer). The filters are the ones the page was built with, so a
 * row the server sends is a row the page would have loaded.
 *
 * - `onSync` the newest page under these filters, on open AND on every reconnect. It is the
 *   repair: a row the client holds that is inside that range and absent from it went away while
 *   nobody was listening, so a caller replaces its head with this rather than merging it.
 * - `onTask` one row that moved — insert or replace it at its sort position.
 * - `onLeave` this row no longer matches; drop it.
 *
 * Recovery is bounded and session-aware. Only a valid `sync`, not an open socket, establishes
 * health. Hidden tabs suspend the tail; becoming visible starts a fresh snapshot.
 */
export function subscribeTasks(
  filters: TaskFilters,
  opts: {
    onSync(page: TaskPage): void;
    onTask(task: TaskSummary): void;
    onLeave(id: string): void;
    /** The tail is not delivering. It may come back by itself — the next `onSync` says it did. */
    onInterrupted?(): void;
    /** Immediate transport state; consumers may delay displaying a reconnecting indicator. */
    onState?(state: TaskStreamState): void;
  },
): TaskStreamSubscription {
  const params = taskFiltersToParams(filters);
  params.set("limit", String(TASK_PAGE_SIZE));
  let stopped = false;
  let restart: (() => void) | undefined;
  let state: TaskStreamState | undefined;
  const setState = (next: TaskStreamState) => {
    if (stopped || state === next) return;
    state = next;
    opts.onState?.(next);
  };
  const closeVisible = whileVisible(() => {
    let active = true;
    let generation = 0;
    let retries = 0;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      generation++;
      clearTimeout(timer);
      timer = undefined;
      source?.close();
      source = undefined;
    };
    const current = (id: number) => active && !stopped && generation === id;
    const interrupted = () => {
      if (!stopped) opts.onInterrupted?.();
    };
    const recover = (renew: boolean) => {
      cancel();
      interrupted();
      if (!active || stopped) return;
      const delay = TASK_STREAM_RETRY_DELAYS_MS[retries++];
      if (delay === undefined) {
        setState("failed");
        return;
      }
      setState("retrying");
      timer = setTimeout(() => void open(renew), delay);
    };
    const watchIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => recover(false), TASK_STREAM_IDLE_TIMEOUT_MS);
    };
    const sessionFailed = (status: SessionReadiness) => {
      if (status === "ready") return false;
      if (status === "auth-required") {
        cancel();
        interrupted();
        setState("auth-required");
      } else {
        recover(true);
      }
      return true;
    };
    const open = async (renew = false) => {
      cancel();
      const id = generation;
      // Also bounds a stalled auth request. It cannot be aborted (refresh is shared), but its
      // completion is fenced out after timeout, suspension, manual retry or teardown.
      timer = setTimeout(() => recover(false), TASK_STREAM_SYNC_TIMEOUT_MS);
      try {
        const ready = renew ? await renewSessionResult() : await ensureFreshSessionResult();
        if (!current(id) || sessionFailed(ready)) return;
        // Renewals update the shared expiry clock; check it before every EventSource open.
        if (renew) {
          const fresh = await ensureFreshSessionResult();
          if (!current(id) || sessionFailed(fresh)) return;
        }
        const connection = new EventSource(`/api/v1/tasks/stream?${params}`);
        source = connection;
        const on = <T>(event: string, schema: z.ZodType<T>, handle: (value: T) => void) =>
          connection.addEventListener(event, (e) => {
            if (!current(id)) return;
            let value: T;
            try {
              value = schema.parse(JSON.parse((e as MessageEvent).data));
            } catch {
              // Malformed sync does not establish health or disarm the watchdog.
              return;
            }
            if (state === "live") watchIdle();
            handle(value);
          });
        on("sync", taskPageSchema, (page) => {
          opts.onSync(page);
          if (!current(id)) return;
          watchIdle();
          retries = 0;
          setState("live");
        });
        on("task", taskSummarySchema, opts.onTask);
        on("leave", z.object({ id: z.string() }), ({ id }) => opts.onLeave(id));
        connection.addEventListener("heartbeat", () => {
          if (current(id) && state === "live") watchIdle();
        });
        connection.addEventListener("error", () => {
          if (!current(id)) return;
          // EventSource hides the status. CLOSED may be an expired cookie, so explicitly renew
          // using the shared/deduplicated auth helper. Own transient retries too, to bound them.
          recover(connection.readyState === EventSource.CLOSED);
        });
      } catch {
        if (current(id)) recover(true);
      }
    };
    restart = () => {
      cancel();
      retries = 0;
      interrupted();
      setState("connecting");
      void open();
    };
    restart();
    return () => {
      active = false;
      restart = undefined;
      cancel();
      interrupted();
      setState("suspended");
    };
  });
  return {
    close() {
      stopped = true;
      closeVisible();
    },
    retry() {
      if (!stopped) restart?.();
    },
  };
}

export async function createTask(f = fetch, input: CreateTaskInput): Promise<CreateTaskResponse> {
  return createTaskResponseSchema.parse(
    await apiCall(f, "/v1/tasks", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function getTask(f = fetch, id: string): Promise<TaskDetail> {
  return taskDetailSchema.parse(await apiCall(f, `/v1/tasks/${encodeURIComponent(id)}`));
}

export async function cancelTask(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/** Ends the task's live run as its agent would: offered once the agent said it was done. */
export async function finishTask(f = fetch, id: string): Promise<void> {
  await apiCall(f, `/v1/tasks/${encodeURIComponent(id)}/finish`, { method: "POST" });
}
