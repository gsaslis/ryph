// A task as `GET /v1/tasks/:id` answers it, restated with only the fields the tools read, and the
// one way they find a run: by its task, the latest run unless an earlier one is named. The task
// detail is also where a run's grants come from, the proof the historian and the tool-call trail
// ask for on every per-run read (packages/orchestrator/src/http/scope.ts `runGrantsFor`).

import { type RyphClient, UsageError } from "../../api/client.ts";
import { type Args, optString, seg } from "../args.ts";
import type { ToolContext } from "../tool.ts";

export interface RunView {
  id: string;
  state: string;
  phase: string | null;
  result:
    | {
      status: string;
      summary?: string;
      reason?: string;
      branches?: Array<{ path: string; name: string; headSha: string; commits: unknown[] }>;
    }
    | null;
  egressNote?: string | null;
  idleState?: string | null;
  declaredOutcome?: string | null;
  agentFinished?: boolean;
  desiredState?: string | null;
  idleDeadlineAt?: string | null;
  launchedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  browser?: boolean;
  events?: Array<{ at: string; kind: string; detail?: string }>;
  messages?: Array<{
    id: string;
    seq: number;
    kind: string;
    sender: { kind: string; name?: string | null; login?: string; userId?: string };
    text: string;
    createdAt: string;
    deliveredAt: string | null;
  }>;
  forgeActions?: Array<{
    id: string;
    tool: string;
    repoRef: string;
    threadRef: string | null;
    state: string;
    url: string | null;
    createdThreadRef: string | null;
    detail: string | null;
    createdAt: string;
  }>;
  grants?: { history: string | null; models: string | null; tools: string | null } | null;
  injectedContext?: {
    systemPrompt?: string;
    brief?: { text: string; memoryIds: string[] };
  } | null;
  environment?: { id: string; image: string; ref: string | null } | null;
  environmentWait?: { environmentId: string; status: string } | null;
  limits?: Record<string, unknown> | null;
  skills?: { skills: Array<{ name: string; source: string }> } | null;
  toolScope?: unknown;
}

export interface PatchView {
  id: string;
  state: string;
  runId: string;
  connectedRepoId: string;
  path: string;
  line?: string;
  branchName: string;
  headSha: string;
  forgeUrl: string | null;
  lastError: string | null;
  heldReason?: string | null;
  title?: string | null;
  landed?: { kind: string } | null;
  provider?: string | null;
  checksSuiteId?: string | null;
  createdAt: string;
}

export interface TaskDetail {
  task: {
    id: string;
    agentId: string;
    spec: { title: string | null; instructions: string | null };
    awaitingPrompt?: boolean;
    repos: Array<{ connectedRepoId: string | null; name: string; ref: string; path: string }>;
    workspaceId: string | null;
    origin: string;
    purpose?: string | null;
    createdAt: string;
    targetChangeRequest?: { connectedRepoId: string; thread: string } | null;
  };
  agent: { id: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  runs: RunView[];
  patches: PatchView[];
  response: { id: string; state: string } | null;
  environmentBuilds?: Array<{ patchId: string; runId: string; note: string | null }>;
  checkSuites?: Array<{
    id: string;
    state: string;
    repoRef: string | null;
    commit: string;
    requestedBy: Array<{ runId: string | null }>;
  }>;
  artifacts?: Array<{
    id: string;
    title: string;
    currentVersion: number;
    versions: Array<{ version: number; runId: string }>;
  }>;
}

export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "errored",
  "cancelled",
  "lost",
]);

export function getTask(
  api: RyphClient,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  return api.json<TaskDetail>("GET", `/v1/tasks/${seg(taskId)}`, undefined, signal);
}

export interface ResolvedRun {
  api: RyphClient;
  detail: TaskDetail;
  run: RunView;
  /** Whether `run` is the task's latest. */
  latest: boolean;
}

/** The run `taskId` (and `runId`, for an earlier one) names. */
export async function resolveRun(
  args: Args,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ResolvedRun> {
  const taskId = optString(args, "taskId");
  if (taskId === undefined) throw new UsageError("taskId: the task (t-…) whose run to read");
  const runId = optString(args, "runId");
  const api = await ctx.api();
  const detail = await getTask(api, taskId, signal);
  const run = runId === undefined ? detail.runs.at(-1) : detail.runs.find((r) => r.id === runId);
  if (run === undefined) {
    throw new UsageError(
      runId === undefined
        ? `task ${taskId} has no run yet`
        : `run ${runId} is not one of task ${taskId}'s runs (${
          detail.runs.map((r) => r.id).join(", ") || "none"
        })`,
    );
  }
  return { api, detail, run, latest: run === detail.runs.at(-1) };
}

/** A per-run read's query: the grant, when the deployment issues one. */
export function withGrant(path: string, grant: string | null | undefined): string {
  if (!grant) return path;
  return `${path}${path.includes("?") ? "&" : "?"}grant=${encodeURIComponent(grant)}`;
}

/** The run's state in a few words. */
export function runState(run: RunView): string {
  const parts = [run.state];
  if (run.phase && run.phase !== run.state && !TERMINAL_STATES.has(run.state)) {
    parts.push(run.phase);
  }
  if (run.idleState) parts.push(run.idleState);
  if (run.declaredOutcome) parts.push(`outcome ${run.declaredOutcome}`);
  if (run.desiredState === "cancelled" && !TERMINAL_STATES.has(run.state)) {
    parts.push("cancelling");
  }
  if (run.agentFinished && !TERMINAL_STATES.has(run.state)) parts.push("finishing");
  if (run.environmentWait) parts.push(`waiting for environment ${run.environmentWait.status}`);
  return parts.join(" · ");
}

/** Shared argument schemas of the per-run tools. */
export const RUN_ARGS = {
  taskId: { type: "string", description: "The task (t-…)." },
  runId: {
    type: "string",
    description: "One of the task's runs; default its latest.",
  },
} as const;
