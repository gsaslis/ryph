// `KeyStore` against the orchestrator: the presented run credential is resolved by the one
// process that owns run rows (POST /v1/forge/git-keys/resolve, service-authenticated with the
// shared RYPH_FORGE_TOKEN). The gateway itself stores no keys — it is mostly stateless by
// design, which is exactly what lets it scale out later.
//
// Invariants:
// - the port's tri-state is preserved faithfully: a definitive no from the orchestrator
//   (unknown/expired/revoked key, terminal run) resolves null → the caller's 401; an
//   unreachable orchestrator THROWS → the caller's 503 — never conflated, because "we could
//   not ask" must not read as "the credential is bad"
// - answers are cached briefly (positive only): one git clone is several HTTP requests in
//   quick succession, and each should not cost an orchestrator round-trip. The TTL bounds how
//   long a just-revoked key keeps answering — keep it small
// - concurrent misses on one token share a single in-flight request: a clone's requests arrive
//   together, so without this the cache misses exactly when it is needed most
// - the cache is bounded: expired entries are swept once it grows past PRUNE_AT, so a
//   long-lived process does not accumulate an entry per run token it has ever seen
// - the presented token is never logged; cache keys are the token, held in memory only

import type { RunGrant } from "../../core/types.ts";
import type { KeyStore } from "../../ports/key_store.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { describeIssues } from "@ryph/shared/http";
import { RunGrantSchema } from "../../schema.ts";

export interface HttpKeyStoreOptions {
  /** The orchestrator's base URL; a trailing slash is tolerated. */
  orchestratorUrl: string;
  /** The shared service credential this gateway presents. */
  forgeToken: string;
  diag: Diagnostics;
  /** How long a positive resolve is reused. Default 10s. */
  cacheTtlMs?: number;
  /** Per-request deadline. Default 5s. */
  requestTimeoutMs?: number;
}

// COUPLED to the runner's `GRANT_SETTLE_MS` (packages/runner/src/core/patches.ts): after a merge
// moves a run's base, the runner waits out this TTL once before it gives up on fetching the new
// base. Raise that when this is raised.
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** Cache size that triggers a sweep of expired entries. Well above any real clone burst. */
const PRUNE_AT = 1_000;

export function httpKeyStore(opts: HttpKeyStoreOptions): KeyStore {
  const { diag } = opts;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const url = `${opts.orchestratorUrl.replace(/\/+$/, "")}/v1/forge/git-keys/resolve`;

  const cache = new Map<string, { grant: RunGrant; expiresAtMs: number }>();
  const inFlight = new Map<string, Promise<RunGrant | null>>();

  /** Drops entries the TTL has already retired. Called only when the map has actually grown. */
  const prune = (nowMs: number) => {
    for (const [key, entry] of cache) {
      if (entry.expiresAtMs <= nowMs) cache.delete(key);
    }
  };

  const ask = async (token: string): Promise<RunGrant | null> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.forgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
      await res.body?.cancel();
      return null; // the definitive no — unknown, expired, revoked, or the run concluded
    }
    if (!res.ok) {
      await res.body?.cancel();
      // 401 here means OUR service credential was refused — deployment misconfiguration,
      // not a bad run credential. Both this and a 5xx are "could not ask": throw → 503.
      diag.warn("key_store.resolve_failed", { status: res.status });
      throw new Error(`key resolve answered ${res.status}`);
    }

    const parsed = RunGrantSchema.safeParse(await res.json());
    if (!parsed.success) {
      // The orchestrator answered garbage — a wiring bug, never a client problem.
      diag.warn("key_store.resolve_malformed", { issues: describeIssues(parsed.error) });
      throw new Error("key resolve answered a malformed grant");
    }

    const nowMs = Date.now();
    if (cache.size >= PRUNE_AT) prune(nowMs);
    cache.set(token, { grant: parsed.data, expiresAtMs: nowMs + ttlMs });
    diag.debug("key_store.resolved", { runId: parsed.data.runId });
    return parsed.data;
  };

  return {
    async resolve(token: string): Promise<RunGrant | null> {
      const hit = cache.get(token);
      if (hit && hit.expiresAtMs > Date.now()) return structuredClone(hit.grant);
      cache.delete(token);

      // Share whatever is already asking for this token — a clone's requests arrive together,
      // and each one paying its own round-trip defeats the cache at the one moment it matters.
      const pending = inFlight.get(token);
      if (pending) return structuredClone(await pending);

      const attempt = ask(token).finally(() => inFlight.delete(token));
      inFlight.set(token, attempt);
      return structuredClone(await attempt);
    },
  };
}
