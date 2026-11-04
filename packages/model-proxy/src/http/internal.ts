// The INTERNAL surface: what the control plane dials when it is a different process from this
// one. Five routes, one shared service credential (RYPH_MODEL_PROXY_TOKEN), and between them
// exactly the questions the orchestrator's `ModelAccess` port asks — no more: an authenticated
// route nothing dials is a surface with no caller to keep it honest, and this one listed every
// registered endpoint's base URL.
//
// This is the seam that replaces `modelAccess: null`. In the single process the orchestrator
// calls the issuer and the key store directly; over the network it calls these, and the port on
// its side does not know which it got.
//
// Invariants:
// - MOUNTED ONLY WHEN A TOKEN IS SET. No token means no remote control plane, so the surface
//   does not exist rather than existing unauthenticated.
// - the key lookup answers metadata only — id, provider, dialect, and the archived state of BOTH
//   the key and the endpoint behind it. Not the label, not the last4, and emphatically not the
//   sealed secret: the control plane validates an agent's policy against these fields and needs
//   nothing else, so nothing else crosses. The dialect is there because a provider id no longer
//   implies a wire shape — it may be a slug an admin typed — and "can this harness drive this
//   key" is a question about the shape. `providerArchivedAt` is there because archiving an
//   ENDPOINT is as final as archiving a key: both are kill switches the issuer enforces at a
//   run's boot, and a policy set against either should die at the form instead.
// - issue's DEFINITIVE refusals (unknown provider, unknown/archived/mismatched key) answer 400;
//   every could-not-ask failure answers 503. The caller must be able to tell "this run can never
//   have a credential" from "ask again" — see CredentialRefusedError.
// - revoke is idempotent and answers 204 for a run that never had a credential: the control
//   plane fires it on every conclusion, including runs with no model scope at all.
// - the two spend reads answer the sweep's and the door's questions — a run's priced total, and
//   whether the deployment's ceiling is reached — priced here, where the catalogue lives, so the
//   control plane never holds a price.

import { json, parseBody, type Route, route } from "@ryph/shared/http";
import {
  type CredentialIssuer,
  CredentialRefusedError,
  type PlatformCredentialIssuer,
  resolveProvider,
} from "../core/service.ts";
import type { RunSpend } from "../core/spend.ts";
import type { KeyStore } from "../ports/key_store.ts";
import { IssueCredentialsSchema, IssuePlatformCredentialSchema } from "../schema.ts";

export interface InternalRoutesDeps {
  store: KeyStore;
  /** Null when no proxy URL is configured: issue then refuses, and says why. */
  issuer: CredentialIssuer | null;
  /** The spend questions, answered by the same bookkeeping the data plane judges with. */
  spend: {
    ofRun(runId: string): Promise<RunSpend>;
    ceilingReached(): Promise<boolean>;
    ceiling: { usd: number; windowDays: number } | null;
  };
  /** The service gate: null means proceed, a Response is the refusal to send. */
  authenticate(req: Request): Promise<Response | null>;
  now(): Date;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

export function internalCredentialRoutes(deps: InternalRoutesDeps): Route[] {
  const getKey = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const key = await deps.store.getProviderKey(params.id);
    if (!key) return json(404, { error: "no such provider key" });
    const provider = await resolveProvider(deps.store, key.provider);
    if (provider === null) {
      // A key for a provider this deployment no longer knows. Not 404 — the key is right there —
      // and not a 200 with a made-up dialect: config drift is an operator's problem, reported
      // the same way the data plane reports it.
      deps.diag.warn("internal.unknown_provider", { provider: key.provider });
      return json(502, { error: "unknown upstream provider" });
    }
    return json(200, {
      id: key.id,
      provider: key.provider,
      dialect: provider.dialect,
      providerArchivedAt: provider.archivedAt,
      archivedAt: key.archivedAt,
    });
  };

  const issue = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    if (deps.issuer === null) {
      return json(503, {
        error: "RYPH_MODEL_PROXY_URL is not set — no proxy address for runs to dial",
      });
    }
    const body = await parseBody(req, IssueCredentialsSchema);
    if (!body.ok) return body.res;
    try {
      const env = await deps.issuer.issue({
        runId: params.id,
        agentId: body.data.agentId,
        taskId: body.data.taskId,
        providerKeyId: body.data.providerKeyId,
        provider: body.data.provider,
        allowedModels: body.data.allowedModels,
        spendUsd: body.data.spendUsd ?? null,
        callsInFlight: body.data.callsInFlight ?? null,
      });
      // The raw virtual token rides this response and the agent container's memory, nowhere
      // else — the same rule the control plane applies to the run token that reached it.
      return json(200, { env });
    } catch (err) {
      if (err instanceof CredentialRefusedError) {
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
    // proxy URL must not thereby keep every live credential alive.
    await deps.store.revokeVirtualKeysForRun(params.id, deps.now().toISOString());
    return new Response(null, { status: 204 });
  };

  const spendOfRun = async (req: Request, params: Record<string, string>): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(200, { runId: params.id, ...(await deps.spend.ofRun(params.id)) });
  };

  const spendCeiling = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    return json(200, { reached: await deps.spend.ceilingReached(), ceiling: deps.spend.ceiling });
  };

  return [
    route("GET", "/internal/v1/provider-keys/:id", getKey),
    route("POST", "/internal/v1/runs/:id/credentials", issue),
    route("DELETE", "/internal/v1/runs/:id/credentials", revoke),
    route("GET", "/internal/v1/runs/:id/spend", spendOfRun),
    route("GET", "/internal/v1/spend-ceiling", spendCeiling),
  ];
}

export interface PlatformRoutesDeps {
  issuer: PlatformCredentialIssuer;
  /** The PLATFORM gate: a credential of its own (RYPH_PLATFORM_TOKEN), never the control
   * plane's — a consumer holding it can mint platform credentials and nothing else. */
  authenticate(req: Request): Promise<Response | null>;
  diag: { warn(event: string, fields?: Record<string, unknown>): void };
}

/**
 * The route a PLATFORM CONSUMER dials to get a credential for its own model calls — the memory
 * service's consolidator and extractor, from a different process. One route, its own token.
 * Definitive refusals (no policy, an archived key) answer 400 so the consumer reports "set the
 * platform policy" rather than retrying; everything else answers 503.
 */
export function platformCredentialRoutes(deps: PlatformRoutesDeps): Route[] {
  const issue = async (req: Request): Promise<Response> => {
    const denied = await deps.authenticate(req);
    if (denied) return denied;
    const body = await parseBody(req, IssuePlatformCredentialSchema);
    if (!body.ok) return body.res;
    try {
      // The raw token rides this response and the consumer's memory, nowhere else.
      return json(200, await deps.issuer.issue(body.data.consumer));
    } catch (err) {
      if (err instanceof CredentialRefusedError) return json(400, { error: err.message });
      deps.diag.warn("internal.platform_issue_failed", {
        consumer: body.data.consumer,
        err: String(err),
      });
      return json(503, { error: "could not issue a platform credential" });
    }
  };
  return [route("POST", "/internal/v1/platform/credentials", issue)];
}
