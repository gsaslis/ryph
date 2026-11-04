// Door ⑤: the tool surface the mcp-gateway reaches as the `forge` platform server. One path,
// service-authed with the credential only the gateway holds (RYPH_FORGE_GATEWAY_TOKEN), and the
// run id in a header the gateway sets and a container never can — the gateway forwards request
// headers by allowlist, and this one is not on it.
//
// This route trusts the gateway's token for exactly one claim — which run is calling — and
// derives everything else from the grant the orchestrator resolves that run to. The token is
// NOT the forge token: the gateway is a different trust domain from the control plane, and a
// leaked gateway credential must not reach the service surface that submits patches.

import { makeServiceGate } from "@ryph/sealed";
import { json, readCappedText, type Route, route } from "@ryph/shared/http";
import { handleBody, nonPostResponse, replyResponse } from "@ryph/shared/mcp";
import { forgeToolServer } from "../mcp/tools.ts";
import type { ToolService } from "../core/tool_service.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";

/** The header the gateway forwards the run id in. Its VALUE is the contract with the gateway
 * (`PLATFORM_RUN_ID_HEADER` in @ryph/mcp-gateway); keep the two in step. */
export const RUN_ID_HEADER = "x-ryph-run-id";

/** The path the gateway's platform entry dials. */
export const TOOLS_MCP_PATH = "/v1/forge-mcp";

/** The most request this surface will read. Exported because it is half of a contract the
 * schema keeps: the largest review `schema.ts` calls legal must fit under it, or the model meets
 * an opaque 413 instead of an answer it can act on. */
export const MAX_BODY_BYTES = 256 * 1024;

export function toolRoutes(
  deps: { service: ToolService; diag: Diagnostics },
  gatewayToken: string,
): Route[] {
  const authenticated = makeServiceGate(gatewayToken);

  const handle = async (req: Request): Promise<Response> => {
    const refused = await authenticated(req);
    if (refused) return refused;
    // No server→client stream and no sessions: a GET is "nothing to stream", a DELETE is
    // "nothing to end". A streamable-HTTP client treats both as fine.
    const bodiless = nonPostResponse(req);
    if (bodiless) return bodiless;

    const runId = req.headers.get(RUN_ID_HEADER);
    if (runId === null || runId === "" || runId.length > 200) {
      return json(400, { error: `${RUN_ID_HEADER} is required` });
    }
    const read = await readCappedText(req, MAX_BODY_BYTES);
    if (!read.ok) return json(413, { error: "request body too large" });
    const server = forgeToolServer({ service: deps.service, runId }, deps.diag);
    return replyResponse(await handleBody(server, read.text));
  };

  return [
    route("POST", TOOLS_MCP_PATH, handle),
    route("GET", TOOLS_MCP_PATH, handle),
    route("DELETE", TOOLS_MCP_PATH, handle),
  ];
}
