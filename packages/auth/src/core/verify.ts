// The verifier: the half of this package every ryph service imports.
// Stateless by construction — verification needs only the public JWKS, so the orchestrator,
// historian, memory service, and keystore each verify locally, no call to auth on any request.
//
// Three constructors for the two deployments:
// - verifierFromJwks: a FIXED document — a test, or a caller that genuinely holds a static set
// - verifierFromJwksSource: the mounted (in-process) case, where the document is a table that
//   other replicas also write to, so it has to be re-readable rather than captured once
// - verifierFromUrl: the standalone case — fetch and cache from /.well-known/jwks.json,
//   which is also what makes key rotation invisible to consumers

import { createLocalJWKSet, createRemoteJWKSet, importJWK, jwtVerify } from "jose";
import { isCapabilityClaim } from "./capabilities.ts";
import type { Claims } from "./types.ts";

export interface Verifier {
  /** Returns the claims, or null for anything invalid: bad signature, expired, wrong iss/aud. */
  verify(token: string): Promise<Claims | null>;
}

export interface VerifyOptions {
  issuer?: string;
  audience?: string;
}

type KeySource = Parameters<typeof jwtVerify>[1];

function makeVerifier(keys: KeySource, opts?: VerifyOptions): Verifier {
  const issuer = opts?.issuer ?? "ryph";
  const audience = opts?.audience ?? "ryph";
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, keys, { issuer, audience });
        if (
          typeof payload.sub !== "string" ||
          typeof payload.email !== "string" ||
          typeof payload.name !== "string" ||
          // A token without a capability list, or without a session id, predates one of them:
          // rather than pass as an unproven caller for the minutes it has left, it is refused
          // outright, and the front's refresh mints one that says everything.
          !Array.isArray(payload.caps) || !payload.caps.every(isCapabilityClaim) ||
          typeof payload.sid !== "string" || payload.sid === "" ||
          (payload.via !== "session" && payload.via !== "token") ||
          typeof payload.email_verified !== "boolean"
        ) {
          return null;
        }
        return {
          sub: payload.sub,
          email: payload.email,
          name: payload.name,
          caps: payload.caps,
          emailVerified: payload.email_verified,
          sid: payload.sid,
          via: payload.via,
        };
      } catch {
        return null;
      }
    },
  };
}

export function verifierFromJwks(
  jwks: { keys: Record<string, unknown>[] },
  opts?: VerifyOptions,
): Verifier {
  return makeVerifier(
    createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
    opts,
  );
}

export function verifierFromUrl(url: string, opts?: VerifyOptions): Verifier {
  return makeVerifier(createRemoteJWKSet(new URL(url)), opts);
}

/** How long a fruitless reload suppresses the next one. */
const DEFAULT_MIN_RELOAD_MS = 5_000;

export interface JwksSourceOptions extends VerifyOptions {
  /**
   * The floor between reloads triggered by an unknown `kid`. It exists because the trigger is
   * attacker-controlled: a stream of tokens carrying invented kids would otherwise be a stream
   * of database reads.
   */
  minReloadMs?: number;
}

/**
 * A verifier over a JWKS that can CHANGE — the mounted case, where the document is a table.
 *
 * `verifierFromJwks` snapshots, and a snapshot is wrong the moment there are replicas: a second
 * one booting into an empty database mints its own signing key, and this process, holding a
 * document captured at its own boot, rejects every token that peer issues. Since a wrong answer
 * here reads as "your session expired", it is the kind of wrong that gets diagnosed as flakiness.
 *
 * So the document is loaded lazily and re-read exactly when it might be stale: on a `kid` this
 * process has not seen. A known kid costs nothing, which is every request in the steady state.
 */
export function verifierFromJwksSource(
  load: () => Promise<{ keys: Record<string, unknown>[] }>,
  opts?: JwksSourceOptions,
): Verifier {
  const minReloadMs = opts?.minReloadMs ?? DEFAULT_MIN_RELOAD_MS;
  let cache = new Map<string, CryptoKey | Uint8Array>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const reload = async (): Promise<void> => {
    // One reload at a time: a burst of requests carrying the same new kid is one read, not one
    // per request.
    if (inFlight !== null) return await inFlight;
    const task = (async () => {
      const next = new Map<string, CryptoKey | Uint8Array>();
      for (const jwk of (await load()).keys) {
        const kid = jwk.kid;
        if (typeof kid !== "string") continue;
        // One unimportable key must not cost the whole set — the others still verify.
        try {
          next.set(kid, await importJWK(jwk as Parameters<typeof importJWK>[0], "EdDSA"));
        } catch {
          continue;
        }
      }
      cache = next;
      loadedAt = Date.now();
    })();
    inFlight = task;
    try {
      await task;
    } finally {
      inFlight = null;
    }
  };

  const resolve = async (header: { kid?: string }): Promise<CryptoKey | Uint8Array> => {
    const kid = header.kid;
    if (typeof kid !== "string") throw new Error("token carries no kid");
    const hit = cache.get(kid);
    if (hit) return hit;
    if (Date.now() - loadedAt >= minReloadMs) await reload();
    const found = cache.get(kid);
    if (!found) throw new Error(`no signing key for kid ${JSON.stringify(kid)}`);
    return found;
  };

  return makeVerifier(resolve as unknown as KeySource, opts);
}
