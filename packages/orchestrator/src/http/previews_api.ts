// Hosted previews, both doors. Mounted only when the
// deployment runs a previews service (RYPH_PREVIEWS_URL and RYPH_PREVIEWS_TOKEN); otherwise the
// runner's probe hits the router's 404 and the agent is told previews are unavailable.
//
//   GET  /v1/runs/:id/runner/previews                  runner: the probe        → {enabled: true}
//   POST /v1/runs/:id/runner/previews                  runner: {port, label}    → 201 {id, port, label, url, tunnel, audience}
//   GET  /v1/runs/:id/previews                         user: the open previews  → {previews}
//   POST /v1/runs/:id/previews/:previewId/open?path=   user: a one-time entry   → {url}
//   POST /v1/previews/:previewId/open?path=            user: the same, by the preview alone → {url}
//
// Invariants:
// - the runner door takes the run's own bearer for the run in the path, nothing else; an unknown
//   run and a wrong token answer alike (401). A concluded run gets 410, checked before a body is
//   read
// - a registration's body is at most MAX_PREVIEW_BODY_BYTES, its port 1024–65535 and its label
//   1–80 characters once trimmed — the local binary's rule — and only then reaches the service
// - the preview's CSP is the run's egress: its allowlist when egress goes through the proxy,
//   null (no allowlist) when it is open. Decided here; the previews service holds no run rows
// - the user door is the run's read gate (background_api.ts, attachments_api.ts): `tasks:read`
//   and a task the caller may read; a run the caller cannot read is a 404, exactly as an unknown
//   one. A concluded run lists nothing without asking the service, and opens nothing (410)
// - an open by the preview alone (what a link to a preview opened without its cookie comes to) asks
//   the service which run it is, and then is exactly the open above: the same gate, the same
//   answers. The caller is authenticated before the service is asked anything, an id that is not
//   one is a 404 unasked, and the run's id never reaches the caller
// - `path` on an open is where the viewer lands, passed on when it is at most MAX_PREVIEW_PATH
//   long and otherwise dropped, never refused: the previews service decides what it accepts
// - the service's 400/429 on a registration reach the runner as sent; anything else that goes
//   wrong with the service is a 502, never taken for an answer

import { z } from "@zod/zod";
import { isTerminal } from "../core/lifecycle.ts";
import type { Run } from "../core/types.ts";
import { HOSTED_PREVIEW_ID, type PreviewsService } from "../ports/previews.ts";
import type { Principal, WiredDeps } from "./app.ts";
import { unauthorized } from "@ryph/sealed";
import { refuseUnless } from "@ryph/auth/gates";
import { runTokenMatches } from "./auth.ts";
import { describeIssues, json, readCappedBytes, type Route, route } from "@ryph/shared/http";
import { scopeFor } from "./scope.ts";

/** A registration is two small fields. */
export const MAX_PREVIEW_BODY_BYTES = 1024;
/** The longest landing path an open passes on; the previews service's own limit. */
export const MAX_PREVIEW_PATH = 2048;

const RegisterSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  label: z.string().transform((label) => label.trim()).pipe(z.string().min(1).max(80)),
});

const concluded = () => json(410, { error: "run concluded" });

export function previewsRoutes(deps: WiredDeps, previews: PreviewsService): Route[] {
  const { store } = deps;

  /** The run the runner speaks for, still live — or the refusal. */
  const runnerRun = async (req: Request, runId: string): Promise<Run | Response> => {
    const run = await store.getRun(runId);
    if (!run || !(await runTokenMatches(req, run))) return unauthorized();
    if (isTerminal(run)) return concluded();
    return run;
  };

  /** The run, when the caller may read it; otherwise the refusal, a 404 for a run they may not
   * see. The gate background_api.ts and attachments_api.ts take. */
  const readableRun = async (req: Request, runId: string): Promise<Run | Response> => {
    const caller = await reader(req);
    if (caller instanceof Response) return caller;
    return await readableBy(caller, runId);
  };

  /** Who is asking, when they may read tasks at all; otherwise the refusal. */
  const reader = async (req: Request): Promise<Principal | Response> => {
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) return caller;
    return refuseUnless(caller, "tasks:read") ?? caller;
  };

  const readableBy = async (caller: Principal, runId: string): Promise<Run | Response> => {
    const run = await store.getRun(runId);
    const task = run === null
      ? null
      : await store.getTask(run.taskId, await scopeFor(deps, caller, "tasks:read-all"));
    if (!run || task === null) return json(404, { error: "no such run" });
    return run;
  };

  const probe = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await runnerRun(req, params.id);
    if (run instanceof Response) return run;
    return json(200, { enabled: true });
  };

  const register = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await runnerRun(req, params.id);
    if (run instanceof Response) {
      await req.body?.cancel().catch(() => {});
      return run;
    }
    const read = await readCappedBytes(req, MAX_PREVIEW_BODY_BYTES).catch(() => null);
    if (read === null) return json(400, { error: "body could not be read" });
    if (!read.ok) return json(400, { error: "preview request too large" });
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return json(400, { error: "body is not valid JSON" });
    }
    const parsed = RegisterSchema.safeParse(raw);
    if (!parsed.success) return json(400, { error: describeIssues(parsed.error) });
    const { port, label } = parsed.data;

    const outcome = await previews.register({
      runId: run.id,
      port,
      label,
      hosts: run.networkScope.mode === "proxy" ? run.networkScope.hosts : null,
    });
    switch (outcome.kind) {
      case "registered":
        // Whoever can see the run opens it, wherever the service is (compose serves it on
        // `*.localhost` too); the runner tells the agent so.
        return json(201, {
          id: outcome.id,
          port,
          label,
          url: outcome.url,
          tunnel: outcome.tunnel,
          audience: "run",
        });
      case "refused":
        return json(outcome.status, outcome.body);
      case "failed":
        return json(502, { error: "the previews service did not answer" });
    }
  };

  const list = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await readableRun(req, params.id);
    if (run instanceof Response) return run;
    if (isTerminal(run)) return json(200, { previews: [] });
    const outcome = await previews.list(run.id);
    if (outcome.kind === "failed") {
      return json(502, { error: "the previews service did not answer" });
    }
    return json(200, { previews: outcome.previews });
  };

  const open = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const run = await readableRun(req, params.id);
    if (run instanceof Response) return run;
    return await openOf(req, run, params.previewId);
  };

  const openById = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const caller = await reader(req);
    if (caller instanceof Response) return caller;
    const unknown = () => json(404, { error: "no such preview" });
    if (!HOSTED_PREVIEW_ID.test(params.previewId)) return unknown();
    const owner = await previews.findRun(params.previewId);
    if (owner.kind === "failed") return json(502, { error: "the previews service did not answer" });
    if (owner.kind === "missing") return unknown();
    const run = await readableBy(caller, owner.runId);
    // A run this caller may not read is no preview they may know of: the same 404, never the
    // run's own "no such run".
    if (run instanceof Response) return run.status === 404 ? unknown() : run;
    return await openOf(req, run, params.previewId);
  };

  /** A viewer's one-time way into `previewId` of `run`, which the caller may read. */
  const openOf = async (req: Request, run: Run, previewId: string): Promise<Response> => {
    if (isTerminal(run)) return concluded();
    const path = new URL(req.url).searchParams.get("path");
    const outcome = await previews.openViewer(
      run.id,
      previewId,
      path && path.length <= MAX_PREVIEW_PATH ? path : undefined,
    );
    switch (outcome.kind) {
      case "url": {
        // The URL carries a one-time ticket: never kept by anything between here and the app.
        const res = json(200, { url: outcome.url });
        res.headers.set("cache-control", "no-store");
        return res;
      }
      case "missing":
        return json(404, { error: "no such preview" });
      case "failed":
        return json(502, { error: "the previews service did not answer" });
    }
  };

  return [
    route("GET", "/v1/runs/:id/runner/previews", probe),
    route("POST", "/v1/runs/:id/runner/previews", register),
    route("GET", "/v1/runs/:id/previews", list),
    route("POST", "/v1/runs/:id/previews/:previewId/open", open),
    route("POST", "/v1/previews/:previewId/open", openById),
  ];
}
