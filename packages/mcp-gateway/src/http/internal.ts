// The INTERNAL surface: what the control plane dials when it is a different process from this
// one. Four routes, one shared service credential (RYPH_MCP_GATEWAY_TOKEN), and between them
// exactly the four questions the orchestrator's `ToolAccess` port asks — the model-proxy's
// internal surface, one credential class over.
//
// Invariants:
// - MOUNTED ONLY WHEN A TOKEN IS SET. No token means no remote control plane, so the surface
//   does not exist rather than existing unauthenticated.
// - the server lookup answers metadata only — id, slug, name, archivedAt. Not the URL, not the
//   last4, and emphatically not the sealed credential: the control plane validates an agent's
//   tool policy against these fields and needs nothing else, so nothing else crosses.
// - issue's DEFINITIVE refusals (unknown/archived server, an empty or duplicated scope) answer
//   400; every could-not-ask failure answers 503. The caller must be able to tell "this run can
//   never have a credential" from "ask again" — see McpCredentialRefusedError.
// - revoke is idempotent and answers 204 for a run that never had a credential: the control
//   plane fires it on every conclusion, including runs with no tool scope at all.
// - archive is here, not on the user surface, because the control plane fronts it: it refuses
//   while an agent's tool policy still names the server, which only it can see. This route does
//   the archive and nothing else — a platform row is still refused (409), a repeat is idempotent.

import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { type McpCredentialIssuer, McpCredentialRefusedError } from "../core/service.ts";
import type { GatewayStore } from "../ports/gateway_store.ts";
import { type ArchiveOutcome, PLATFORM_MANAGED } from "./routes.ts";
import { IssueMcpCredentialsSchema } from "../schema.ts";

export interface InternalRoutesDeps {
  store: GatewayStore;
  /** Null when no gateway URL is configured: issue then refuses, and says why. */
  issuer: McpCredentialIssuer | null;
  /** The kill switch (`setup().archive`): the caller has already decided it may happen. */
  archive(id: string): Promise<ArchiveOutcome>;
  /** The service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  now(): Date;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

export function internalMcpRoutes(deps: InternalRoutesDeps): Route[] {
  const getServer = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const server = await deps.store.getServer(params.id);
    if (!server) return json(404, { error: "no such server" });
    return json(200, {
      id: server.id,
      slug: server.slug,
      name: server.name,
      archivedAt: server.archivedAt,
    });
  };

  const issue = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    if (deps.issuer === null) {
      return json(503, {
        error: "RYPH_MCP_GATEWAY_URL is not set — no gateway address for runs to dial",
      });
    }
    const body = await parseBody(req, IssueMcpCredentialsSchema);
    if (!body.ok) return body.res;
    try {
      const credentials = await deps.issuer.issue({
        runId: params.id,
        servers: body.data.servers,
      });
      // The raw virtual token rides this response and the agent container's memory, nowhere
      // else — the same rule the control plane applies to the run token that reached it.
      return json(200, credentials);
    } catch (err) {
      if (err instanceof McpCredentialRefusedError) {
        // Definitive: retrying cannot help, and the run will boot-fail. Not a fault of ours.
        return json(400, { error: err.message });
      }
      deps.diag.warn("internal.issue_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not issue run credentials" });
    }
  };

  const revoke = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    // No issuer still revokes: the store is what holds the rows, and a deployment that lost its
    // gateway URL must not thereby keep every live credential alive.
    await deps.store.revokeVirtualKeysForRun(params.id, deps.now().toISOString());
    return new Response(null, { status: 204 });
  };

  const archive = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const outcome = await deps.archive(params.id);
    switch (outcome.kind) {
      case "missing":
        return json(404, { error: "no such server" });
      case "platform":
        return json(409, {
          error: "this server is provided by the platform and is not managed here",
          code: PLATFORM_MANAGED,
        });
      case "archived":
        return json(200, outcome.server);
    }
  };

  return [
    route("GET", "/internal/v1/mcp-servers/:id", getServer),
    route("POST", "/internal/v1/mcp-servers/:id/archive", archive),
    route("POST", "/internal/v1/runs/:id/mcp-credentials", issue),
    route("DELETE", "/internal/v1/runs/:id/mcp-credentials", revoke),
  ];
}
