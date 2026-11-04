// `ryph mcp`'s tool list, in the order tools/list shows it: who you are, tasks and their runs,
// what runs produced, checks, then configuration. Transport-free; stdio.ts serves it today, and
// an HTTP mount would serve the same list.

import type { ToolServer } from "./jsonrpc.ts";
import { checksTools } from "./tools/checks.ts";
import { configTools } from "./tools/config.ts";
import { reviewTools } from "./tools/review.ts";
import { runTools } from "./tools/runs.ts";
import { taskTools } from "./tools/tasks.ts";
import { whoamiTool } from "./tools/whoami.ts";
import type { Tool } from "./tool.ts";

const INSTRUCTIONS = "ryph runs coding agents on a team's repositories. These tools drive a " +
  "ryph deployment with your API token: start and steer tasks, watch their runs (transcript, " +
  "subagents, background commands, previews, activity), review the patches they submit, run " +
  "a repository's checks on your own commit, and configure agents, repos, workspaces, memory, " +
  "chat, MCP servers and automations. Ids are prefixed (t- task, r- run, p- patch, cs- check " +
  "suite) and every answer names the tool that reads further. Configuration tools take an " +
  "`action`; their `describe` action gives a body's JSON Schema. Start with whoami if a call " +
  "is refused.";

export interface ServeOptions {
  /** Serve only the tools annotated read-only: nothing the agent calls changes the deployment. */
  readOnly?: boolean;
}

export function ryphTools(opts: ServeOptions = {}): Tool[] {
  const readOnly = opts.readOnly === true;
  // whoami reads the list this server serves, so a read-only server names only what it serves.
  let served: Tool[] = [];
  const tools: Tool[] = [
    whoamiTool(() => served, { readOnly }),
    ...taskTools,
    ...runTools,
    ...reviewTools,
    ...checksTools,
    ...configTools,
  ];
  served = readOnly ? tools.filter((t) => t.annotations?.readOnlyHint === true) : tools;
  return served;
}

export function ryphServer(version = "0.0.1", opts: ServeOptions = {}): ToolServer {
  return {
    info: { name: "ryph", version },
    instructions: opts.readOnly
      ? `${INSTRUCTIONS} This server is read-only: it serves only the tools that read.`
      : INSTRUCTIONS,
    tools: ryphTools(opts),
  };
}
