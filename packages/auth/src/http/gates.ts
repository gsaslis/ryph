// The user-surface gates every service puts in front of its public API, over the VERIFIER half of
// this package. Each service used to carry its own copy — three of the yes/no capability gate,
// three of the principal gate — and the copies drifted: one principal gate let an unverified
// address through that the others refused.
//
// Invariants:
// - a bearer is verified against the same JWKS everywhere, which is what lets the app forward one
//   user bearer to whichever service owns the path
// - an address that is still unproven is refused with a 403 by every gate here, not only by the
//   web app: until the address is theirs, nothing on any surface is
// - `disabled` (RYPH_AUTH=off) is the total bypass for local development; the principal gate
//   records it positively as break-glass rather than inventing a nobody
//
// A gate that reads an Authorization header and returns a Response is an HTTP concern, hence
// src/http; services import it as `@ryph/auth/gates`.

import { bearerToken, type RunGrantBearer, unauthorized } from "@ryph/sealed";
import { json } from "@ryph/shared/http";
import { can, type Capability, type CapabilityClaim, forbidden } from "../core/capabilities.ts";
import type { Claims } from "../core/types.ts";
import type { Verifier } from "../core/verify.ts";

export interface GateOptions {
  verifier: Verifier;
  /** RYPH_AUTH=off: every gate here lets the request through. */
  disabled?: boolean;
}

/**
 * Who a user-surface request speaks for. "break-glass" is RYPH_AUTH=off, recorded as a positive
 * fact everywhere it acts (task origin, patch approvals, who wrote a memory). A surface that needs
 * less than the whole user ignores the rest.
 */
export type Principal =
  | {
    kind: "user";
    userId: string;
    email: string;
    name: string;
    /** Every capability the user holds, or `["*"]` for an owner. */
    caps: readonly CapabilityClaim[];
    emailVerified: boolean;
    /** The credential behind the token, as auth names it: a session's id or an API token's. */
    sid: string;
    /** How the bearer was minted: a sign-in session or an API token. */
    via: "session" | "token";
  }
  | { kind: "break-glass" };

/** A Principal means proceed (and says who for), a Response is the refusal to send. */
export type Authenticate = (req: Request) => Promise<Principal | Response>;

/** A signed-in user whose address is still unproven: nothing on this surface is theirs yet. */
export function unverified(): Response {
  return json(403, { error: "verify your email address first" });
}

/**
 * The bearer's verified claims, or the refusal: 401 for no bearer or one that does not verify,
 * 403 for an unproven address. Every gate below is this plus what it hands back.
 */
export async function verifiedClaims(verifier: Verifier, req: Request): Promise<Claims | Response> {
  const presented = bearerToken(req);
  if (presented === null) return unauthorized();
  const claims = await verifier.verify(presented);
  if (claims === null) return unauthorized();
  return claims.emailVerified ? claims : unverified();
}

/**
 * The gate that yields a PRINCIPAL, not just permission, for a surface that needs to know WHO is
 * calling (who requested a task, who approved a patch, who wrote a memory).
 *
 * @example
 * const authenticate = makeAuthenticate({ verifier, disabled: authDisabled });
 */
export function makeAuthenticate(opts: GateOptions): Authenticate {
  return async (req) => {
    if (opts.disabled) return { kind: "break-glass" };
    const claims = await verifiedClaims(opts.verifier, req);
    if (claims instanceof Response) return claims;
    return {
      kind: "user",
      userId: claims.sub,
      email: claims.email,
      name: claims.name,
      caps: claims.caps,
      emailVerified: claims.emailVerified,
      sid: claims.sid,
      via: claims.via,
    };
  };
}

/**
 * The one authorization check on a principal: null to proceed, the 403 to send. Break-glass
 * passes every check, since it is already a total bypass; a user passes when the capability is in
 * their token. `what` names the act in the refusal, for a reader.
 *
 * @example
 * const denied = refuseUnless(caller, "egress:manage", "changing the allowlist");
 * if (denied) return denied;
 */
export function refuseUnless(
  principal: Principal,
  capability: Capability,
  what?: string,
): Response | null {
  if (principal.kind === "break-glass" || can(principal, capability)) return null;
  return json(403, forbidden(capability, what));
}

/** The id a write is attributed to: the user's, or the literal "break-glass". */
export function actorOf(principal: Principal): string {
  return principal.kind === "user" ? principal.userId : "break-glass";
}

/**
 * The user gate, narrowed to one capability, for a surface that records no principal: null means
 * proceed, a Response is the refusal to send. A verified user who lacks the capability is told so
 * with a 403 that names it: they are who they claim, and may not. With no capability at all, this
 * is JUST the verified-bearer check.
 *
 * @example
 * const authenticate = makeCapabilityGate(gateOpts, "models:read");
 * const authenticateManage = makeCapabilityGate(gateOpts, "models:manage");
 */
export function makeCapabilityGate(
  opts: GateOptions,
  capability?: Capability,
): (req: Request) => Promise<Response | null> {
  return async (req) => {
    if (opts.disabled) return null;
    const claims = await verifiedClaims(opts.verifier, req);
    if (claims instanceof Response) return claims;
    if (capability === undefined || can(claims, capability)) return null;
    return json(403, forbidden(capability));
  };
}

/**
 * The verified bearer behind a run grant, for a gate that already has its own proof of scope
 * (the grant) and needs to know WHO is behind the request and what they hold: the subject and
 * caps (makeRunReadGate checks both), a Response to refuse, or null when RYPH_AUTH=off and
 * nobody signs in.
 *
 * @example
 * const bearer = makeGrantBearer(gateOpts);
 */
export function makeGrantBearer(
  opts: GateOptions,
): (req: Request) => Promise<Response | RunGrantBearer | null> {
  return async (req) => {
    if (opts.disabled) return null;
    const claims = await verifiedClaims(opts.verifier, req);
    if (claims instanceof Response) return claims;
    return { sub: claims.sub, caps: claims.caps };
  };
}
