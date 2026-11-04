// `authenticateRun` over the orchestrator's history-verify surface. The standalone historian owns
// no run rows, so it asks the one process that does — POST /v1/history/runs/:id/verify,
// service-authed with the shared RYPH_HISTORY_TOKEN — whether a presented run token is that
// run's token, then caches the run's token hash so its firehose of later batches verifies
// locally. The mirror of the forge's httpKeyStore.
//
// Invariants:
// - positive-only cache keyed by runId → tokenHash, short TTL; the conclude signal calls
//   invalidate(runId), so a finished run's ingest stops passing at once — introspection's
//   immediate revocation, which is the whole reason this beats local self-contained tokens here
// - a definitive no from the orchestrator (404: unknown run, wrong token, past the ingest grace)
//   → false → the route's 401, which the runner's emitter drops as final
// - could-not-ask (unreachable, timeout, our service token refused, a 5xx) → THROWS, so the route
//   answers a retryable 5xx: the emitter retries 5xx but DROPS 4xx, so a transient control-plane
//   outage must never answer false. Same stance as the forge's key-resolve link.
// - concurrent batches for one (run, token) share a single in-flight verify — keyed by BOTH, so
//   one run's positive answer can never be shared with another run presenting the same token
// - the presented run token is never logged

import { bearerToken, sha256Hex, timingSafeEqual } from "@ryph/sealed";

export interface RunAuthDiag {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface HttpRunAuthOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  orchestratorUrl: string;
  /** The shared service credential this historian presents. */
  historyToken: string;
  diag: RunAuthDiag;
  /** How long a positive verify is reused. Default 10s — keep small; it bounds revoke latency. */
  cacheTtlMs?: number;
  /** Per-request deadline. Default 5s. */
  requestTimeoutMs?: number;
}

export interface RunAuth {
  /** The ingest gate: true iff the request's bearer is this run's live token. */
  authenticateRun(req: Request, runId: string): Promise<boolean>;
  /** Drops a run's cached token — called on the conclude signal so ingest stops at once. */
  invalidate(runId: string): void;
}

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Cache size that triggers a sweep of expired entries. Well above any real concurrency. */
const PRUNE_AT = 1_000;

export function httpRunAuth(opts: HttpRunAuthOptions): RunAuth {
  const { diag } = opts;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const base = opts.orchestratorUrl.replace(/\/+$/, "");

  const cache = new Map<string, { tokenHash: string; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const prune = (nowMs: number) => {
    for (const [key, entry] of cache) {
      if (entry.expiresAtMs <= nowMs) cache.delete(key);
    }
  };

  /** Resolves a run's token hash from the orchestrator. Returns null ONLY on 404 (the definitive
   * no); every could-not-ask condition throws, so the route answers a retryable 5xx rather than a
   * batch-dropping 401. */
  const ask = async (runId: string, token: string): Promise<string | null> => {
    const url = `${base}/v1/history/runs/${encodeURIComponent(runId)}/verify`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.historyToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Unreachable or timed out — NOT a definitive no. Throw so the route surfaces a retryable
      // 5xx; answering false here would 401 and the emitter drops 4xx for good.
      diag.warn("run_auth.verify_unreachable", { err: String(err) });
      throw new Error("history run-token verify unreachable");
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null; // the ONLY definitive no — unknown run, wrong token, or past the ingest grace
    }
    if (!res.ok) {
      await res.body?.cancel();
      // 401 → OUR service token was refused (misconfig); 5xx → orchestrator erroring. Neither is a
      // bad run token, so throw for a retryable 5xx rather than drop the batch with a false.
      diag.warn("run_auth.verify_failed", { status: res.status });
      throw new Error(`history run-token verify answered ${res.status}`);
    }
    const body = await res.json().catch(() => null) as { tokenHash?: unknown } | null;
    const tokenHash = body?.tokenHash;
    if (typeof tokenHash !== "string") {
      diag.warn("run_auth.verify_malformed", {});
      throw new Error("history run-token verify answered a malformed body");
    }
    const nowMs = Date.now();
    if (cache.size >= PRUNE_AT) prune(nowMs);
    cache.set(runId, { tokenHash, expiresAtMs: nowMs + ttlMs });
    diag.debug("run_auth.verified", { runId });
    return tokenHash;
  };

  return {
    async authenticateRun(req, runId) {
      const presented = bearerToken(req);
      if (presented === null) return false;
      const presentedHash = await sha256Hex(presented);

      const hit = cache.get(runId);
      if (hit && hit.expiresAtMs > Date.now()) {
        return timingSafeEqual(presentedHash, hit.tokenHash);
      }
      cache.delete(runId);

      // Share an in-flight verify — a run's batches arrive together — but key it by (runId, token)
      // TOGETHER. Keying by token alone would let run A's valid token, presented to run B's ingest
      // while A's verify is in flight, share A's positive answer and pass, poisoning B's transcript.
      const key = `${runId}\x00${presented}`;
      const pending = inFlight.get(key);
      const resolved = pending ?? ask(runId, presented).finally(() => inFlight.delete(key));
      if (!pending) inFlight.set(key, resolved);
      const tokenHash = await resolved;
      return tokenHash !== null && timingSafeEqual(presentedHash, tokenHash);
    },
    invalidate(runId) {
      cache.delete(runId);
    },
  };
}
