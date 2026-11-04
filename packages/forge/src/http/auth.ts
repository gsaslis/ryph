// Authentication for both agent-facing doors: the run's virtual key is the ONLY credential,
// and resolving it is the whole gate. The credential, not the URL, selects the repo.
//
// Invariants:
// - failures answer uniformly: a missing credential, an unknown one, and a runId mismatch are
//   all the same 401 — a 404 (or a distinct message) would confirm which run ids exist
// - the tri-state survives to the client: definitive no → 401; "could not ask the
//   orchestrator" → 503, because the credential may be perfectly valid
// - a 401 carries a Basic challenge; harmless to our runner (its git can never prompt) and
//   correct HTTP for everyone else

import type { RunGrant, RunGrantRepo } from "../core/types.ts";
import type { KeyStore } from "../ports/key_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import { json } from "@ryph/shared/http";

/** The presented credential: HTTP Basic's password (what git sends under the extraheader
 * contract, username ignored) or a plain Bearer (what bundle intake's client sends). */
export function presentedToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    return token === "" ? null : token;
  }
  if (header.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(header.slice("Basic ".length).trim());
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    const password = decoded.slice(colon + 1);
    return password === "" ? null : password;
  }
  return null;
}

export function unauthorized(): Response {
  const res = json(401, { error: "unauthorized" });
  res.headers.set("www-authenticate", 'Basic realm="ryph-forge"');
  return res;
}

/**
 * The gate both doors run first: resolve the presented credential to its grant.
 * Returns the grant to proceed with, or the refusal to send.
 */
export async function resolveGrant(
  keys: KeyStore,
  req: Request,
  diag: Diagnostics,
): Promise<RunGrant | Response> {
  const token = presentedToken(req);
  if (token === null) return unauthorized();
  let grant: RunGrant | null;
  try {
    grant = await keys.resolve(token);
  } catch (err) {
    diag.warn("auth.resolve_unavailable", { err: String(err) });
    return json(503, { error: "credential resolution unavailable" });
  }
  if (grant === null) return unauthorized();
  return grant;
}

/**
 * The member of a grant a request's path names, or the refusal to send. The credential
 * selects the set and the URL selects the member; a member outside the set is exactly as
 * unauthorized as a run id that does not match — 401, never 404, so nothing about which
 * connected repos exist leaks to a caller holding some other run's key.
 */
export function memberOf(
  grant: RunGrant,
  connectedRepoId: string,
  diag: Diagnostics,
): RunGrantRepo | Response {
  const member = grant.repos.find((r) => r.connectedRepoId === connectedRepoId);
  if (member === undefined) {
    diag.warn("auth.repo_not_in_grant", { runId: grant.runId, requested: connectedRepoId });
    return unauthorized();
  }
  return member;
}
