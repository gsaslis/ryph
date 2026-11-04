// `ModelAccess` over a standalone model-proxy's internal surface — the adapter that replaces
// `modelAccess: null` in the networked deployment. The port is the orchestrator's and does not
// change: the single-process host builds the same three methods over an in-process issuer and key
// store (see @ryph/host's composition root), and the HTTP layer above cannot tell which it got.
//
// Service-authed with the shared RYPH_MODEL_PROXY_TOKEN, both legs, exactly like the forge and
// history tokens. Note what still never crosses: `issueRunCredentials` returns the env map with a
// run-scoped VIRTUAL token in it, minted on the proxy side. The provider's real secret stays
// sealed in the proxy's database under a master key this process does not hold.
//
// Invariants, all of them about telling a definitive answer from a could-not-ask:
// - getKey: 404 is "no such key" → null. Every other failure THROWS, so a proxy that is down
//   surfaces as a 500 on agent creation rather than as "that key does not exist" — a user must
//   never be told their key vanished because a service blinked. That deliberately includes the
//   proxy's 502, which it answers when the key's provider resolves to nothing: the ROW is fine
//   and the deployment's provider table has drifted out from under it, which is an operator's
//   problem to fix and not a verdict on the key. Reporting it as null would delete a working
//   key from the user's form; reporting it as a could-not-ask keeps the drift visible.
// - issueRunCredentials: throws either way (the runner's boot fetch turns any throw into a 503 it
//   retries), but a 400 is logged as definitive — an archived or mismatched key means the run can
//   never boot, and the retries are only delaying that verdict.
// - revokeRunCredentials: best-effort by contract; call sites already `.catch()`. A failed revoke
//   leaves credentials alive until their TTL lapses, which is the backstop's whole purpose.
// - spendOf and ceilingReached THROW on anything but a 200: the sweep holds a run's spend against
//   its cap, and a proxy that is down must read as "could not ask" — never as a run that has
//   spent nothing, which would let it run on uncapped exactly when nobody is counting.
// - the virtual token is never logged, and the run's env map is never logged.

import type { Dialect } from "@ryph/model-proxy";
import type { ModelAccess } from "../../http/app.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";

/**
 * Every dialect there is, so the JSON coming off the wire can be NARROWED to the union rather
 * than cast into it. Written as a total map over `Dialect` on purpose: it is not a table that
 * has to be remembered, because adding a dialect in @ryph/model-proxy makes this object stop
 * satisfying its own type and the build says so here.
 */
const DIALECTS: Record<Dialect, true> = {
  "anthropic-messages": true,
  "openai-responses": true,
  "openai-completions": true,
};

export interface HttpModelAccessOptions {
  /** The proxy's CONTROL listener, as this process dials it; a trailing slash is tolerated. */
  modelProxyUrl: string;
  /** The shared service credential this process presents. */
  modelProxyToken: string;
  diag: Diagnostics;
  /** Per-request deadline. Default 10s — minting is one insert, but it is on a run's boot path. */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The proxy's error body, when it sent one. Best-effort: a message, never a control decision. */
async function reason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
}

export function httpModelAccess(opts: HttpModelAccessOptions): ModelAccess {
  const base = opts.modelProxyUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const headers = { authorization: `Bearer ${opts.modelProxyToken}` };

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    try {
      return await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Unreachable or timed out. Never a definitive no — the callers below all rethrow.
      throw new Error(`model proxy unreachable: ${err instanceof Error ? err.message : err}`);
    }
  };

  return {
    async getKey(id) {
      const res = await call("GET", `/internal/v1/provider-keys/${encodeURIComponent(id)}`);
      if (res.status === 404) {
        await res.body?.cancel();
        return null; // the ONLY definitive no
      }
      if (!res.ok) {
        // 502 lands here with everything else, and that is the point: it means the key's
        // provider resolved to nothing, which is config drift rather than an answer about
        // the key. See this file's invariants.
        const why = await reason(res);
        opts.diag.warn("model_access.get_key_failed", { id, status: res.status });
        throw new Error(`model proxy refused a key lookup: ${why}`);
      }
      const body = await res.json().catch(() => null) as
        | {
          id?: unknown;
          provider?: unknown;
          dialect?: unknown;
          providerArchivedAt?: unknown;
          archivedAt?: unknown;
        }
        | null;
      if (
        typeof body?.id !== "string" || typeof body.provider !== "string" ||
        typeof body.dialect !== "string" || !Object.hasOwn(DIALECTS, body.dialect)
      ) {
        // A dialect this build does not know is malformed and not a maybe: the caller decides
        // whether a harness can drive the key from it, and a string nothing can match would
        // refuse every harness with a message naming a shape the operator never chose.
        throw new Error("model proxy answered a malformed key lookup");
      }
      return {
        id: body.id,
        provider: body.provider,
        dialect: body.dialect as Dialect,
        // Both timestamps are read the same way: anything that is not a string is "not
        // archived", which is what a proxy that omits the field means.
        providerArchivedAt: typeof body.providerArchivedAt === "string"
          ? body.providerArchivedAt
          : null,
        archivedAt: typeof body.archivedAt === "string" ? body.archivedAt : null,
      };
    },

    async issueRunCredentials(scope) {
      const res = await call(
        "POST",
        `/internal/v1/runs/${encodeURIComponent(scope.runId)}/credentials`,
        {
          agentId: scope.agentId,
          taskId: scope.taskId,
          providerKeyId: scope.providerKeyId,
          provider: scope.provider,
          allowedModels: scope.allowedModels,
          spendUsd: scope.spendUsd,
          callsInFlight: scope.callsInFlight,
        },
      );
      if (!res.ok) {
        const why = await reason(res);
        // 400 is the proxy's definitive refusal: unknown provider, unknown/archived/mismatched
        // key. Retrying will not change it, so say so plainly in the log — the run boot-fails
        // either way, and this is the line that explains why.
        opts.diag.warn(
          res.status === 400 ? "model_access.issue_refused" : "model_access.issue_failed",
          { runId: scope.runId, status: res.status, reason: why },
        );
        throw new Error(`model proxy refused to issue credentials: ${why}`);
      }
      const body = await res.json().catch(() => null) as { env?: unknown } | null;
      const env = body?.env;
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new Error("model proxy answered a malformed credentials body");
      }
      for (const value of Object.values(env)) {
        if (typeof value !== "string") {
          throw new Error("model proxy answered a credentials env that is not all strings");
        }
      }
      return env as Record<string, string>;
    },

    async revokeRunCredentials(runId) {
      const res = await call(
        "DELETE",
        `/internal/v1/runs/${encodeURIComponent(runId)}/credentials`,
      );
      await res.body?.cancel();
      if (!res.ok) {
        opts.diag.warn("model_access.revoke_failed", { runId, status: res.status });
        throw new Error(`model proxy refused to revoke run credentials (HTTP ${res.status})`);
      }
    },

    async spendOf(runId) {
      const res = await call("GET", `/internal/v1/runs/${encodeURIComponent(runId)}/spend`);
      if (!res.ok) {
        const why = await reason(res);
        opts.diag.warn("model_access.spend_read_failed", { runId, status: res.status });
        throw new Error(`model proxy refused a spend lookup: ${why}`);
      }
      const body = await res.json().catch(() => null) as { spentUsd?: unknown } | null;
      if (typeof body?.spentUsd !== "number" || !Number.isFinite(body.spentUsd)) {
        throw new Error("model proxy answered a malformed spend lookup");
      }
      return body.spentUsd;
    },

    async ceilingReached() {
      const res = await call("GET", "/internal/v1/spend-ceiling");
      if (!res.ok) {
        const why = await reason(res);
        opts.diag.warn("model_access.ceiling_read_failed", { status: res.status });
        throw new Error(`model proxy refused a ceiling lookup: ${why}`);
      }
      const body = await res.json().catch(() => null) as { reached?: unknown } | null;
      if (typeof body?.reached !== "boolean") {
        throw new Error("model proxy answered a malformed ceiling lookup");
      }
      return body.reached;
    },
  };
}
