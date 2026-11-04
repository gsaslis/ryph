// The INTERNAL surface: what the orchestrator dials when it is a different process from this
// one. Six routes, one shared service credential (RYPH_CHAT_TOKEN), and between them exactly
// what the orchestrator's `ChatAccess` port says: bind a run to a conversation when it starts,
// close the binding when the run ends, ask whether a sender is a commander, read a thread — or
// the one a shared response is about to continue — and describe a room to the agent a run bound
// to it is about to start.
//
// Invariants:
// - MOUNTED ONLY WHEN A TOKEN IS SET: no token means no remote control plane
// - opening is a 201 (or a 200 for the same run again) and refuses with the reason; closing is
//   idempotent and answers 204 for a run this service never bound
// - the questions never fail as HTTP: the commander check answers "unknown" and the thread
//   reads "unavailable" when the platform does not — the port promises they never throw
// - a room's description is a stored read, no platform call: 200, or 404 for a room that is
//   missing or archived

import type { ChatService } from "../core/service.ts";
import {
  CloseBindingSchema,
  CommanderCheckSchema,
  ContinuedThreadFetchSchema,
  OpenBindingSchema,
  ThreadFetchSchema,
} from "../schema.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

const MAX_BODY_BYTES = 256 * 1024;

export interface InternalRoutesDeps {
  service: ChatService;
  /** The service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

export function internalChatRoutes(deps: InternalRoutesDeps): Route[] {
  const open = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, OpenBindingSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    try {
      const outcome = await deps.service.openBinding(body.data);
      if (outcome.kind === "refused") {
        return json(outcome.status, {
          error: outcome.error,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      }
      return json(outcome.kind === "opened" ? 201 : 200, { binding: outcome.binding });
    } catch (err) {
      deps.diag.warn("internal.open_binding_failed", { runId: body.data.runId, err: String(err) });
      return json(503, { error: "could not open the binding" });
    }
  };

  const close = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, CloseBindingSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    try {
      await deps.service.closeBinding(params.id, body.data);
      return new Response(null, { status: 204 });
    } catch (err) {
      deps.diag.warn("internal.close_binding_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not close the binding" });
    }
  };

  const checkCommander = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, CommanderCheckSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    return json(200, { verdict: await deps.service.checkCommander(body.data) });
  };

  const fetchThread = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ThreadFetchSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    return json(200, await deps.service.fetchThread(body.data));
  };

  const fetchContinuedThread = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ContinuedThreadFetchSchema, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.res;
    return json(200, await deps.service.fetchContinuedThread(body.data));
  };

  const describeRoom = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const context = await deps.service.describeRoom(params.id);
    return context === null ? json(404, { error: "no such chatroom" }) : json(200, context);
  };

  return [
    route("POST", "/internal/v1/bindings", open),
    route("POST", "/internal/v1/runs/:id/close", close),
    route("POST", "/internal/v1/commanders/check", checkCommander),
    route("POST", "/internal/v1/threads/fetch", fetchThread),
    route("POST", "/internal/v1/threads/continued", fetchContinuedThread),
    route("GET", "/internal/v1/chatrooms/:id/context", describeRoom),
  ];
}
