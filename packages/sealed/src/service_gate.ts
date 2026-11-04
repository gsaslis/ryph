// The service-to-service gate: one shared bearer, compared without leaking anything through
// timing. Every service that takes a single shared credential (a forge token, a memory token, the
// launcher's) used to carry this as a copy of its own; the copies agreed on the shape and drifted
// on the details — one compared raw strings, one pre-hashed nothing, one trimmed the header.
//
// Invariants:
// - a token is compared as SHA-256 digests, never raw: `timingSafeEqual` answers early on a length
//   mismatch, so comparing the presented token directly would leak the real one's length
// - the bearer is the header after an exact `Bearer ` — no trimming, no other scheme, and an empty
//   token is no token
// - a refusal is always the same 401 body, so a caller learns nothing from which check failed

import { sha256Hex, timingSafeEqual } from "./tokens.ts";

/** The token an `Authorization: Bearer <token>` header carries; null for none, another scheme, or
 * an empty one. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token === "" ? null : token;
}

/** The one refusal: 401 `{"error":"unauthorized"}`. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }, null, 2), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** Whether `presented` is `expected`, compared as SHA-256 digests in constant time, so neither
 * the content nor the length of `expected` leaks. */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  return timingSafeEqual(a, b);
}

/** Null to proceed, a Response to refuse — the shape route lists want. */
export type ServiceGate = (req: Request) => Promise<Response | null>;

/**
 * A gate passing exactly the requests that present `token` as their bearer. The expected digest
 * is computed once, not per request.
 *
 * @example
 * const authenticateForge = makeServiceGate(env.RYPH_FORGE_TOKEN);
 * const refused = await authenticateForge(req);
 * if (refused) return refused;
 */
export function makeServiceGate(token: string): ServiceGate {
  const expected = sha256Hex(token);
  return async (req) => {
    const presented = bearerToken(req);
    if (presented === null) return unauthorized();
    const [a, b] = await Promise.all([sha256Hex(presented), expected]);
    return timingSafeEqual(a, b) ? null : unauthorized();
  };
}
