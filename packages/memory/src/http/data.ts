// The DATA side: the MCP route agent runs reach through the gateway's `platform` server. One
// path, service-authed with the credential only the gateway holds (RYPH_MEMORY_GATEWAY_TOKEN),
// and the run id in a header the gateway sets and the container can never set — the gateway
// forwards request headers by allowlist, and this one is not on it.
//
// This route trusts the gateway's token for exactly one claim — which run is calling — and
// derives everything else from that: the run's agent and repo, from the row composeBrief wrote.
// A run this service never briefed has no scope, and its every tool call says so.

import { json, readCappedText } from "@ryph/shared/http";
import {
  handleBody,
  nonPostResponse,
  replyResponse,
  type ToolServer,
  toolText,
} from "@ryph/shared/mcp";
import type { MemoryService } from "../core/service.ts";
import type { RunScope } from "../core/subject.ts";
import { callTool, TOOLS } from "../mcp/tools.ts";

/** The header the gateway forwards the run id in. Its VALUE is the contract with the gateway. */
export const RUN_ID_HEADER = "x-ryph-run-id";

/** The path the gateway's platform entry dials. */
export const MCP_PATH = "/v1/memory-mcp";

const MAX_BODY_BYTES = 1024 * 1024;

export interface DataRouteDeps {
  service: MemoryService;
  /** The gateway's service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  now(): Date;
  diag: {
    debug(e: string, f?: Record<string, unknown>): void;
    warn(e: string, f?: Record<string, unknown>): void;
  };
}

const SERVER_INFO = { name: "ryph-memory", version: "0.0.1" };

const INSTRUCTIONS = "Memory of previous runs. Search before assuming; propose what you " +
  "learn; confirm or refute what you relied on.";

/** The tool server one run's calls are answered by. A run this service never briefed (null
 * scope) still lists the tools, but every call is the tool's own error, so the model reads why
 * rather than seeing a 4xx. */
function memoryToolServer(
  deps: DataRouteDeps,
  runId: string,
  scope: RunScope | null,
): ToolServer {
  return {
    info: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: {
      list: () => TOOLS,
      call: (name, args) =>
        scope === null
          ? toolText(
            "This run has no memory scope: it was started before memory was configured.",
            true,
          )
          : callTool({ service: deps.service, scope, runId, now: deps.now }, name, args),
    },
    failed: (tool, err) => {
      deps.diag.warn("memory.tool_failed", { runId, tool, err: String(err) });
      return "the memory service could not complete the call";
    },
  };
}

/** One handler for the MCP path, every method. Null for any other path. */
export function makeMemoryDataHandler(
  deps: DataRouteDeps,
): (req: Request) => Promise<Response | null> {
  const pattern = new URLPattern({ pathname: MCP_PATH });
  return async (req) => {
    if (!pattern.test(req.url)) return null;
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const other = nonPostResponse(req);
    if (other) return other;

    const runId = req.headers.get(RUN_ID_HEADER);
    if (runId === null || runId === "") return json(400, { error: `${RUN_ID_HEADER} is required` });
    // Counted as it streams: a chunked body announces no length to check first.
    const read = await readCappedText(req, MAX_BODY_BYTES);
    if (!read.ok) return json(413, { error: "request body too large" });

    // A run this service never briefed: it started before memory was configured, or the brief
    // failed to compose. The handshake and the tool list still work — the extension registers
    // tools before the first model turn and dies if it cannot.
    const scope = await deps.service.scopeOf(runId);
    if (scope === null) deps.diag.debug("memory.unknown_run", { runId });
    return replyResponse(await handleBody(memoryToolServer(deps, runId, scope), read.text));
  };
}
