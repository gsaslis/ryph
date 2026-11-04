// The DATA side: the MCP route agent runs reach through the gateway's `platform` server. One
// path, service-authed with the credential only the gateway holds (RYPH_CHAT_GATEWAY_TOKEN),
// and the run id in a header the gateway sets and the container can never set — the gateway
// forwards request headers by allowlist, and this one is not on it.
//
// This route trusts the gateway's token for exactly one claim — which run is calling — and
// derives everything else from that: the run's binding, and through it the room. A run with no
// binding has no room, and its every post says so as the tool's own error, so the model reads
// why rather than seeing a 4xx.

import { json, readCappedText } from "@ryph/shared/http";
import { handleBody, nonPostResponse, replyResponse, type ToolServer } from "@ryph/shared/mcp";
import type { ChatService } from "../core/service.ts";
import { callTool, TOOLS } from "../mcp/tools.ts";

/** The header the gateway forwards the run id in. Its VALUE is the contract with the gateway. */
export const RUN_ID_HEADER = "x-ryph-run-id";

/** The path the gateway's platform entry dials. */
export const MCP_PATH = "/v1/chat-mcp";

const MAX_BODY_BYTES = 256 * 1024;

export interface DataRouteDeps {
  service: ChatService;
  /** The gateway's service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  diag: {
    debug(e: string, f?: Record<string, unknown>): void;
    warn(e: string, f?: Record<string, unknown>): void;
  };
}

const SERVER_INFO = { name: "ryph-chat", version: "0.0.1" };

const INSTRUCTIONS = "The chat conversation this run is bound to — a team's room, or a topic " +
  "on a community server that may be public. Post what you found, what you are doing and when " +
  "a patch or an issue is ready; keep it short — it is a conversation, not a document, and " +
  "anyone who can read it will read what you post.";

/** The tool server one run's calls are answered by. */
function chatToolServer(deps: DataRouteDeps, runId: string): ToolServer {
  return {
    info: SERVER_INFO,
    instructions: INSTRUCTIONS,
    tools: {
      list: () => TOOLS,
      call: (name, args) => callTool({ service: deps.service, runId }, name, args),
    },
    failed: (tool, err) => {
      deps.diag.warn("chat.tool_failed", { runId, tool, err: String(err) });
      return "the chat service could not complete the call";
    },
  };
}

/** One handler for the MCP path, every method. Null for any other path. */
export function makeChatDataHandler(
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

    return replyResponse(await handleBody(chatToolServer(deps, runId), read.text));
  };
}
