// Tasks and talking to their runs: list, read, start, cancel, finish, and send a run a message.

import { CreateTaskSchema } from "@ryph/orchestrator/api-schema";
import { z } from "@zod/zod";
import { UsageError } from "../../api/client.ts";
import { needString, optBool, optInt, optObject, optString, optStrings, seg } from "../args.ts";
import { ago, clip, cut, lines } from "../format.ts";
import { body, bool, DESTRUCTIVE, int, object, READ, str, type Tool, WRITE } from "../tool.ts";
import {
  getTask,
  resolveRun,
  RUN_ARGS,
  runState,
  type TaskDetail,
  TERMINAL_STATES,
} from "./task_detail.ts";

const STATUS_BUCKETS = ["live", "succeeded", "failed", "broken", "cancelled"] as const;
const ORIGINS = ["user", "break-glass", "forge", "automation", "chat", "token"] as const;

interface TaskRow {
  id: string;
  title: string | null;
  awaitingPrompt?: boolean;
  agentId: string;
  agentName: string | null;
  origin: string;
  workspaceId: string | null;
  connectedRepoIds: string[];
  lastActivityAt: string;
  state: string;
  phase: string | null;
  idleState?: string | null;
  declaredOutcome?: string | null;
}

function taskLine(t: TaskRow): string {
  const state = [t.state, t.idleState, t.declaredOutcome && `outcome ${t.declaredOutcome}`]
    .filter(Boolean).join("/");
  const where = t.workspaceId
    ? `workspace ${t.workspaceId}`
    : t.connectedRepoIds.length > 0
    ? `repo ${t.connectedRepoIds.join(",")}`
    : "";
  return `- ${t.id} "${clip(t.title ?? (t.awaitingPrompt ? "(awaiting its prompt)" : "?"), 90)}"` +
    ` · ${state} · ${t.agentName ?? "agent"} (${t.agentId}) · ${t.origin}${
      where ? ` · ${where}` : ""
    } · ${ago(t.lastActivityAt)}`;
}

const tasksList: Tool = {
  name: "tasks_list",
  description: "List tasks, the newest first (by when each was created). Each line has the " +
    "task id, title, its " +
    "latest run's state, agent, origin and checkout.",
  inputSchema: object({
    status: {
      type: "array",
      items: { type: "string", enum: [...STATUS_BUCKETS] },
      description: "Only these: live (starting/running), succeeded, failed, broken, cancelled.",
    },
    q: str("Search titles and instructions."),
    agentId: str("Only this agent's tasks."),
    repoId: str("Only tasks checking out this connected repo."),
    workspaceId: str("Only tasks on this workspace."),
    origin: { type: "array", items: { type: "string", enum: [...ORIGINS] } },
    mine: bool("Only tasks you started."),
    from: str("Created at or after (ISO-8601)."),
    to: str("Created before (ISO-8601)."),
    limit: int("Default 25.", 1, 100),
    cursor: str("From the previous page's hint."),
  }),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks"]],
  run: async (args, ctx) => {
    const params = new URLSearchParams();
    const status = optStrings(args, "status");
    if (status?.length) params.set("status", status.join(","));
    const origin = optStrings(args, "origin");
    if (origin?.length) params.set("origin", origin.join(","));
    for (
      const [arg, param] of [
        ["q", "q"],
        ["agentId", "agent"],
        ["repoId", "repo"],
        [
          "workspaceId",
          "workspace",
        ],
        ["from", "from"],
        ["to", "to"],
        ["cursor", "cursor"],
      ] as const
    ) {
      const value = optString(args, arg);
      if (value !== undefined) params.set(param, value);
    }
    if (optBool(args, "mine")) params.set("mine", "true");
    params.set("limit", String(optInt(args, "limit", 1, 100) ?? 25));
    const page = await (await ctx.api()).json<
      { tasks: TaskRow[]; nextCursor: string | null; hasMore: boolean }
    >("GET", `/v1/tasks?${params}`);
    return lines(
      page.tasks.length === 0 ? "No tasks match." : page.tasks.map(taskLine),
      page.hasMore && page.nextCursor && `More: tasks_list {cursor: "${page.nextCursor}"}`,
    );
  },
};

/** A task in words: what it is, where its latest run stands, and what came of it. */
export function describeTask(detail: TaskDetail, appUrl: string): string {
  const { task, agent, runs, patches } = detail;
  const run = runs.at(-1);
  const out: string[] = [
    `Task ${task.id}: "${task.spec.title ?? "(awaiting its prompt)"}" · origin ${task.origin}` +
    ` · created ${ago(task.createdAt)}${task.purpose ? ` · ${task.purpose}` : ""}`,
    `Page: ${appUrl}`,
    `Agent: ${agent ? `${agent.name} (${agent.id})` : task.agentId}`,
    `Checkout: ${
      detail.workspace ? `workspace ${detail.workspace.name} (${detail.workspace.id}): ` : ""
    }${task.repos.map((r) => `${r.name}@${r.ref} at ${r.path}`).join(", ")}`,
  ];
  if (task.targetChangeRequest) {
    out.push(`Works on change request #${task.targetChangeRequest.thread}`);
  }
  if (task.spec.instructions) out.push(`Instructions: ${cut(task.spec.instructions, 1500)}`);
  if (run) {
    out.push(
      "",
      `Run ${run.id} (${runs.length > 1 ? `latest of ${runs.length}` : "only run"}): ${
        runState(run)
      }${run.launchedAt ? ` · launched ${ago(run.launchedAt)}` : ""} · updated ${
        ago(run.updatedAt)
      }`,
    );
    if (run.result) {
      const r = run.result;
      out.push(
        `Result: ${r.status}${r.reason ? ` (${clip(r.reason, 200)})` : ""}${
          r.summary ? `: ${cut(r.summary, 2000)}` : ""
        }`,
      );
      for (const b of r.branches ?? []) {
        out.push(
          `  branch ${b.name} @${b.headSha.slice(0, 12)} in ${b.path}, ${b.commits.length} commits`,
        );
      }
    }
    if (run.egressNote) out.push(`Egress: ${run.egressNote}`);
    const messages = run.messages ?? [];
    // A message an ended run never read is not on its way: the run is gone.
    const undelivered = TERMINAL_STATES.has(run.state)
      ? " (never delivered)"
      : " (not delivered yet)";
    if (messages.length > 0) {
      out.push(`Recent messages (${Math.min(messages.length, 5)} of the inbox's tail):`);
      for (const m of messages.slice(-5)) {
        const who = m.sender.name ?? m.sender.login ?? m.sender.kind;
        out.push(
          `  - ${m.kind} from ${who}, ${ago(m.createdAt)}${m.deliveredAt ? "" : undelivered}: ${
            clip(m.text, 200)
          }`,
        );
      }
    }
  }
  if (patches.length > 0) {
    out.push("Patches:");
    for (const p of patches) {
      out.push(
        `  - ${p.id} ${p.state}${p.heldReason ? " (held)" : ""} · ${p.branchName}${
          p.forgeUrl ? ` · ${p.forgeUrl}` : ""
        }${p.lastError ? ` · error: ${clip(p.lastError, 120)}` : ""}`,
      );
    }
  }
  for (const s of detail.checkSuites ?? []) {
    out.push(`Check suite ${s.id}: ${s.state} on ${s.repoRef ?? "?"} @${s.commit.slice(0, 12)}`);
  }
  for (const a of detail.artifacts ?? []) {
    out.push(`Artifact ${a.id}: "${clip(a.title, 80)}" v${a.currentVersion}`);
  }
  if (detail.response) out.push(`Response ${detail.response.id}: ${detail.response.state}`);
  if (runs.length > 1) {
    out.push(`Earlier runs: ${runs.slice(0, -1).map((r) => `${r.id} ${r.state}`).join(", ")}`);
  }
  out.push(
    "",
    "More: run_transcript, run_activity, run_subagents, run_background, run_previews {taskId}; " +
      "run_message to talk to the run.",
  );
  return out.join("\n");
}

const taskGet: Tool = {
  name: "task_get",
  description: "Read one task: instructions, checkout, its latest run's state and result, " +
    "recent messages, patches, check suites, artifacts and earlier runs.",
  inputSchema: object({ taskId: str("The task (t-…).") }, ["taskId"]),
  annotations: READ,
  needs: ["tasks:read"],
  routes: [["GET", "/v1/tasks/{taskId}"]],
  run: async (args, ctx) => {
    const taskId = needString(args, "taskId");
    const api = await ctx.api();
    return describeTask(await getTask(api, taskId), api.appUrl(`/tasks/${seg(taskId)}`));
  },
};

const taskStart: Tool = {
  name: "task_start",
  description: "Start a task: an agent working on a connected repo (repoId) or a workspace " +
    "(workspaceId). Without instructions the run waits for its first message. Returns the " +
    "task and run ids.",
  inputSchema: object({
    agentId: str("The agent (blueprint) to run; see agents {action: list}."),
    instructions: str("What to do."),
    title: str("A title; made from the instructions when left out."),
    repoId: str("A connected repo to check out; or workspaceId."),
    ref: str("With repoId: the branch to start from; default the repo's default branch."),
    workspaceId: str("A workspace to check out (its repos at their saved refs)."),
    changeRequest: str(
      "With repoId: the pull request / patch to work on, by its number or id. The run checks " +
        "out its head branch and pushes onto it.",
    ),
    model: str("One of the agent's allowed models; default its policy's."),
    limits: body(
      "This run's limits, each at most the agent's: wallClockMs, spendUsd, " +
        "callsInFlight.",
    ),
  }, ["agentId"]),
  annotations: WRITE,
  needs: ["tasks:create"],
  routes: [["POST", "/v1/tasks"]],
  run: async (args, ctx) => {
    const repoId = optString(args, "repoId");
    const workspaceId = optString(args, "workspaceId");
    const instructions = optString(args, "instructions");
    const title = optString(args, "title");
    const thread = optString(args, "changeRequest");
    if ((repoId === undefined) === (workspaceId === undefined)) {
      throw new UsageError("give exactly one of repoId and workspaceId");
    }
    if (thread !== undefined && repoId === undefined) {
      throw new UsageError("changeRequest goes with repoId");
    }
    const request = {
      agentId: needString(args, "agentId"),
      spec: {
        ...(title !== undefined ? { title } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
      },
      ...(repoId !== undefined ? { connectedRepoId: repoId } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(optString(args, "ref") !== undefined ? { ref: optString(args, "ref") } : {}),
      ...(optString(args, "model") !== undefined ? { model: optString(args, "model") } : {}),
      ...(thread !== undefined
        ? { targetChangeRequest: { connectedRepoId: repoId!, thread } }
        : {}),
      ...(optObject(args, "limits") !== undefined ? { limits: optObject(args, "limits") } : {}),
    };
    // The control plane's own schema, so a malformed start is refused here in its words.
    const checked = CreateTaskSchema.safeParse(request);
    if (!checked.success) throw new UsageError(z.prettifyError(checked.error).replace(/\n/g, "; "));
    const api = await ctx.api();
    const made = await api.json<{ taskId: string; runId: string; state: string }>(
      "POST",
      "/v1/tasks",
      request,
    );
    return lines(
      `Started task ${made.taskId}, run ${made.runId} (${made.state}).`,
      `Page: ${api.appUrl(`/tasks/${seg(made.taskId)}`)}`,
      instructions === undefined
        ? `It waits for its first message: run_message {taskId: "${made.taskId}", text}.`
        : `Follow it with run_wait or task_get {taskId: "${made.taskId}"}.`,
    );
  },
};

const taskCancel: Tool = {
  name: "task_cancel",
  description: "Cancel a task's latest run. It stops at the runner's next heartbeat.",
  inputSchema: object({ taskId: str("The task (t-…).") }, ["taskId"]),
  annotations: { ...DESTRUCTIVE, idempotentHint: true },
  needs: ["tasks:steer"],
  routes: [["POST", "/v1/tasks/{taskId}/cancel"]],
  run: async (args, ctx) => {
    const taskId = needString(args, "taskId");
    const answer = await (await ctx.api()).json<{ runId: string }>(
      "POST",
      `/v1/tasks/${seg(taskId)}/cancel`,
    );
    return `Asked run ${answer.runId} to stop.`;
  },
};

const taskFinish: Tool = {
  name: "task_finish",
  description: "Finish a task's latest run on the outcome its agent declared (success or " +
    "no-changes), as the run page's Finish does: it ends at the agent's next settle.",
  inputSchema: object({ taskId: str("The task (t-…).") }, ["taskId"]),
  annotations: WRITE,
  needs: ["tasks:steer"],
  routes: [["POST", "/v1/tasks/{taskId}/finish"]],
  run: async (args, ctx) => {
    const taskId = needString(args, "taskId");
    const answer = await (await ctx.api()).json<{ runId: string }>(
      "POST",
      `/v1/tasks/${seg(taskId)}/finish`,
    );
    return `Run ${answer.runId} finishes at its agent's next settle.`;
  },
};

const runMessage: Tool = {
  name: "run_message",
  description: "Send a message to a task's run, as a person on the run page would: a " +
    "follow-up, a correction, or the first prompt of a task waiting for one. The agent reads " +
    "it at its next turn.",
  inputSchema: object({ ...RUN_ARGS, text: str("The message.") }, ["taskId", "text"]),
  annotations: WRITE,
  needs: ["tasks:steer"],
  routes: [["GET", "/v1/tasks/{taskId}"], ["POST", "/v1/runs/{runId}/messages"]],
  run: async (args, ctx) => {
    // Sent as written: leading indentation or a trailing newline can be the point of a message.
    const text = args.text;
    if (typeof text !== "string" || text.trim() === "") throw new UsageError("text: required");
    const { api, run } = await resolveRun(args, ctx);
    const answer = await api.json<{ message: { id: string; seq: number } }>(
      "POST",
      `/v1/runs/${seg(run.id)}/messages`,
      { text },
    );
    return `Sent as message ${answer.message.id} to run ${run.id} (${runState(run)}).`;
  },
};

export const taskTools: Tool[] = [
  tasksList,
  taskGet,
  taskStart,
  taskCancel,
  taskFinish,
  runMessage,
];
