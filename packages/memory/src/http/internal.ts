// The INTERNAL surface: what the orchestrator dials when it is a different process from this
// one. Five routes, one shared service credential (RYPH_MEMORY_TOKEN), and between them
// exactly the things the orchestrator's `MemoryAccess` port says — the gateway's internal
// surface, one concern over.
//
// Invariants:
// - MOUNTED ONLY WHEN A TOKEN IS SET: no token means no remote control plane
// - composeBrief answers the brief or `null` as JSON; a store failure is a 503 the orchestrator
//   turns into a memoryless run, never a failed one
// - outcome, patches, change and stale are idempotent and answer 204 for a run this service
//   never briefed

import type { MemoryService } from "../core/service.ts";
import {
  ComposeBriefSchema,
  ReportChangeSchema,
  ReportOutcomeSchema,
  ReportPatchSchema,
  ReportStaleSchema,
} from "../schema.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

export interface InternalRoutesDeps {
  service: MemoryService;
  /** The service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

export function internalMemoryRoutes(deps: InternalRoutesDeps): Route[] {
  const brief = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ComposeBriefSchema);
    if (!body.ok) return body.res;
    try {
      const composed = await deps.service.composeBrief({ runId: params.id, ...body.data });
      return json(200, { brief: composed });
    } catch (err) {
      deps.diag.warn("internal.brief_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not compose the brief" });
    }
  };

  const outcome = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ReportOutcomeSchema);
    if (!body.ok) return body.res;
    try {
      await deps.service.reportOutcome(params.id, body.data.status);
      return new Response(null, { status: 204 });
    } catch (err) {
      deps.diag.warn("internal.outcome_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not record the outcome" });
    }
  };

  const patch = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ReportPatchSchema);
    if (!body.ok) return body.res;
    try {
      await deps.service.reportPatch(params.id, body.data);
      return new Response(null, { status: 204 });
    } catch (err) {
      deps.diag.warn("internal.patch_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not record the patch" });
    }
  };

  const change = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ReportChangeSchema);
    if (!body.ok) return body.res;
    try {
      const { patchId, fate, carries } = body.data;
      await deps.service.reportChange(params.id, patchId, fate, carries);
      return new Response(null, { status: 204 });
    } catch (err) {
      deps.diag.warn("internal.change_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not record the change's fate" });
    }
  };

  const stale = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, ReportStaleSchema);
    if (!body.ok) return body.res;
    try {
      await deps.service.reportStale(params.id, body.data.stale);
      return new Response(null, { status: 204 });
    } catch (err) {
      deps.diag.warn("internal.stale_failed", { runId: params.id, err: String(err) });
      return json(503, { error: "could not record the staleness report" });
    }
  };

  return [
    route("POST", "/internal/v1/runs/:id/brief", brief),
    route("POST", "/internal/v1/runs/:id/outcome", outcome),
    route("POST", "/internal/v1/runs/:id/patches", patch),
    route("POST", "/internal/v1/runs/:id/change", change),
    route("POST", "/internal/v1/runs/:id/stale", stale),
  ];
}
