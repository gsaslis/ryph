// The history surface: the HTTP surface spoken only by a standalone historian, authenticated by
// the shared RYPH_HISTORY_TOKEN. It answers one question — "is this the run token for this run,
// and is the run still live?" — so a historian that owns no run rows can gate ingest. Its own
// file, not a route inside runner_api, because it is a distinct trust surface: service-authed and
// historian-facing, the mirror of forge_api's git-key resolve.
//
// The historian presents the runner's token in the body (service-authed in the header) and, on a
// match, receives the run's token hash back so it can verify that run's later batches locally
// without a round-trip per batch. The token itself is only ever compared by hash here.
//
// Invariants:
// - every failure to verify is the same 404, whatever the reason (unknown run, wrong token,
//   run concluded): a distinct answer would tell a probing caller which runs or tokens exist
// - a terminal run verifies like an unknown one — this is what stops a leaked token ingesting
//   into a finished run's record, alongside the conclude signal that drops the historian's cache

import { isTerminal } from "../core/lifecycle.ts";
import { makeServiceGate, sha256Hex, timingSafeEqual } from "@ryph/sealed";
import { HistoryTokenVerifySchema } from "../schema.ts";
import type { AppDeps } from "./app.ts";
import type { Run } from "../core/types.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";

/**
 * How long a terminal run keeps accepting ingest. The runner posts its result — which turns the
 * run terminal — and only then flushes its LAST history batch on the way out (its shutdown
 * deadline is a few seconds). Rejecting terminal runs outright would drop that final flush; this
 * window keeps it while still bounding a leaked token to seconds past conclusion.
 */
export const INGEST_GRACE_MS = 30_000;

/** Whether a run's transcript still takes ingest: live, or concluded within INGEST_GRACE_MS. The
 * one rule for both gates — this route's, for a standalone historian, and the mounted one's. */
export function runAcceptsIngest(run: Run, now: Date): boolean {
  return !isTerminal(run) || now.getTime() - Date.parse(run.updatedAt) <= INGEST_GRACE_MS;
}

export function historyVerifyRoutes(deps: AppDeps, historyToken: string): Route[] {
  const { store, diag } = deps;

  /** The service gate: the bearer must be the shared token. */
  const authenticated = makeServiceGate(historyToken);

  const verifyRunToken = async (
    req: Request,
    params: Record<string, string>,
  ): Promise<Response> => {
    const denied = await authenticated(req);
    if (denied) return denied;
    const body = await parseBody(req, HistoryTokenVerifySchema);
    if (!body.ok) return body.res;

    const notFound = () => json(404, { error: "unknown run" });

    const run = await store.getRun(params.id);
    if (!run) return notFound();
    // A terminal run answers like an unknown one only PAST the grace window — inside it, the
    // runner's final flush is still accepted (see INGEST_GRACE_MS). The historian re-asks after
    // conclusion because the conclude signal dropped its cache, so the window is enforced here.
    if (!runAcceptsIngest(run, deps.now())) return notFound();
    if (!timingSafeEqual(await sha256Hex(body.data.token), run.tokenHash)) return notFound();

    diag.debug("history.run_token_verified", { runId: run.id });
    // Returning the hash lets the historian verify this run's later batches locally.
    return json(200, { runId: run.id, tokenHash: run.tokenHash });
  };

  return [
    route("POST", "/v1/history/runs/:id/verify", verifyRunToken),
  ];
}
