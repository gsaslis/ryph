// Archiving an MCP server, fronted here rather than on the gateway: the gateway holds the server
// rows, but only this process holds the agents whose tool policies name them. An agent still
// naming an archived server boot-fails every run it gets (the gateway refuses to issue for it),
// so the archive is refused while any live agent does, and the refusal names those agents.
//
// The rest of server management stays on the gateway's own user surface; this is the one door
// moved, and it reaches the gateway through the ToolAccess port (its internal surface, or
// in-process in the single-process host).
//
// A live agent saved between the check and the archive is a race this does not close: agent save
// already refuses an archived server, so the window is the length of one gateway call.

import {
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_WEB_SERVER_ID,
} from "@ryph/mcp-gateway/platform";
import { refuseUnless } from "@ryph/auth/gates";
import { json, type Route, route } from "@ryph/shared/http";
import type { WiredDeps } from "../app.ts";

/** The marker on "an agent still uses this server". The value is the contract the app reads. */
export const SERVER_IN_USE = "server_in_use";

/** The gateway's markers, by value — the app reads them off this route as it did off the gateway's. */
const MCP_DISABLED = "mcp_disabled";
const PLATFORM_MANAGED = "platform_managed";

const PLATFORM_SERVER_IDS = new Set([
  PLATFORM_CHAT_SERVER_ID,
  PLATFORM_FORGE_SERVER_ID,
  PLATFORM_MEMORY_SERVER_ID,
  PLATFORM_WEB_SERVER_ID,
]);

const platformManaged = () =>
  json(409, {
    error: "this server is provided by the platform and is not managed here",
    code: PLATFORM_MANAGED,
  });

export function mcpServerRoutes(deps: WiredDeps): Route[] {
  const archive = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    // The gateway's own gate on managing a server: an admin's.
    const denied = refuseUnless(caller, "tools:manage");
    if (denied) return denied;
    const tools = deps.toolAccess;
    if (!tools) return json(503, { error: "MCP access not configured", code: MCP_DISABLED });
    // Before the agent check: a platform row sits in plenty of tool policies, and "provided by
    // the platform" is the true reason it cannot go. The gateway refuses it again regardless.
    if (PLATFORM_SERVER_IDS.has(params.id)) return platformManaged();

    const server = await tools.getServer(params.id);
    if (!server) return json(404, { error: "no such server" });
    // Already archived: answer it as it stands (the gateway's archive is idempotent, and stops a
    // container a first archive could not). Nothing an agent does now can make it worse.
    if (server.archivedAt === null) {
      const users = (await deps.store.listAgents()).filter((agent) =>
        agent.archivedAt === null &&
        (agent.toolPolicy?.servers.some((s) => s.serverId === server.id) ?? false)
      );
      if (users.length > 0) {
        const names = users.map((a) => a.name).join(", ");
        return json(409, {
          error: `"${server.name}" is still used by ${users.length === 1 ? "agent" : "agents"} ` +
            `${names} — remove it from ${
              users.length === 1 ? "its tool policy" : "their tool policies"
            } first`,
          code: SERVER_IN_USE,
          agents: users.map((a) => ({ id: a.id, name: a.name })),
        });
      }
    }

    const outcome = await tools.archiveServer(server.id);
    switch (outcome.kind) {
      case "missing":
        return json(404, { error: "no such server" });
      case "platform":
        return platformManaged();
      case "archived":
        return json(200, outcome.server);
    }
  };

  return [route("POST", "/v1/mcp-servers/:id/archive", archive)];
}
