// `ToolGrants` against the orchestrator: a calling run resolved to its forge tool grant
// (POST /v1/forge/tool-grants/resolve), and every write reserved and settled in the orchestrator's
// ledger (POST /v1/forge/tool-actions, POST /v1/forge/tool-actions/:id) — all service-authed with
// the shared RYPH_FORGE_TOKEN, the key store's link in the same direction.
//
// Invariants:
// - the port's tri-state survives: a 404 resolve is null (the run is over), anything else that is
//   not a grant THROWS — "could not ask" never reads as "the run may do nothing"
// - a reserve's 403/404/409 is a definitive refusal carrying the orchestrator's sentence; every
//   other 4xx is `rejected` with its sentence (the orchestrator was reached and refused the
//   request itself — no outage to retry); only a network failure or a 5xx throws, and a write
//   that could not be reserved is never made either way
// - grants are cached briefly (positive only) with in-flight sharing: an agent's burst of calls is
//   several requests in quick succession, and the TTL bounds how long a concluded run keeps
//   answering — keep it small. `forget` drops an entry the moment a write changes the grant

import type { ToolGrant } from "../../core/types.ts";
import {
  type ActionOutcome,
  ControlPlaneRefusal,
  refusalReason,
  type ReserveOutcome,
  type ToolGrants,
} from "../../ports/tool_grants.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { describeIssues } from "@ryph/shared/http";
import { RefusalSchema, ReserveAnswerSchema, ToolGrantSchema } from "../../schema.ts";

export interface HttpToolGrantsOptions {
  orchestratorUrl: string;
  forgeToken: string;
  diag: Diagnostics;
  /** How long a resolved grant is reused. Default 10s. */
  cacheTtlMs?: number;
  /** Per-request deadline. Default 5s. */
  requestTimeoutMs?: number;
}

const PRUNE_AT = 1_000;

export function httpToolGrants(opts: HttpToolGrantsOptions): ToolGrants {
  const { diag } = opts;
  const ttlMs = opts.cacheTtlMs ?? 10_000;
  const timeoutMs = opts.requestTimeoutMs ?? 5_000;
  const base = `${opts.orchestratorUrl.replace(/\/+$/, "")}/v1/forge`;
  const cache = new Map<string, { grant: ToolGrant; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<ToolGrant | null>>();

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.forgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const ask = async (runId: string): Promise<ToolGrant | null> => {
    const res = await post("/tool-grants/resolve", { runId });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      diag.warn("tool_grants.resolve_failed", { status: res.status });
      if (res.status >= 400 && res.status < 500) {
        const body = await res.json().catch(() => null);
        throw new ControlPlaneRefusal(res.status, refusalReason(res.status, body));
      }
      await res.body?.cancel();
      throw new Error(`tool grant resolve answered ${res.status}`);
    }
    const parsed = ToolGrantSchema.safeParse(await res.json());
    if (!parsed.success) {
      diag.warn("tool_grants.resolve_malformed", { issues: describeIssues(parsed.error) });
      throw new Error("tool grant resolve answered a malformed grant");
    }
    const nowMs = Date.now();
    if (cache.size >= PRUNE_AT) {
      for (const [key, entry] of cache) if (entry.expiresAtMs <= nowMs) cache.delete(key);
    }
    cache.set(runId, { grant: parsed.data, expiresAtMs: nowMs + ttlMs });
    return parsed.data;
  };

  return {
    async resolve(runId) {
      const hit = cache.get(runId);
      if (hit && hit.expiresAtMs > Date.now()) return structuredClone(hit.grant);
      cache.delete(runId);
      const pending = inFlight.get(runId);
      if (pending) return structuredClone(await pending);
      const attempt = ask(runId).finally(() => inFlight.delete(runId));
      inFlight.set(runId, attempt);
      return structuredClone(await attempt);
    },

    async reserve(req): Promise<ReserveOutcome> {
      const res = await post("/tool-actions", req);
      const body = await res.json().catch(() => null);
      if (res.status === 201) {
        const parsed = ReserveAnswerSchema.safeParse(body);
        if (!parsed.success) throw new Error("tool action reserve answered a malformed id");
        return { kind: "reserved", actionId: parsed.data.actionId };
      }
      if (res.status === 403 || res.status === 404 || res.status === 409) {
        const refusal = RefusalSchema.safeParse(body);
        if (res.status === 404) cache.delete(req.runId);
        return {
          kind: "refused",
          reason: refusal.success ? refusal.data.error : "the orchestrator refused the write",
        };
      }
      diag.warn("tool_grants.reserve_failed", { status: res.status });
      if (res.status >= 400 && res.status < 500) {
        return { kind: "rejected", reason: refusalReason(res.status, body) };
      }
      throw new Error(`tool action reserve answered ${res.status}`);
    },

    async complete(actionId, runId, outcome: ActionOutcome) {
      const res = await post(`/tool-actions/${encodeURIComponent(actionId)}`, {
        runId,
        ...outcome,
      });
      await res.body?.cancel();
      if (!res.ok) {
        diag.warn("tool_grants.complete_failed", { status: res.status, actionId });
        throw new Error(`tool action complete answered ${res.status}`);
      }
    },

    forget(runId) {
      cache.delete(runId);
    },
  };
}
