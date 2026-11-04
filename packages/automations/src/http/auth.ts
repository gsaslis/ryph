// The user gate for automation CRUD. A downstream service depends on the auth VERIFIER
// (@ryph/auth), never on the control plane's package.
//
// Unlike the model-proxy's gate this one returns the CALLER, not just permission: every
// automation is owned, so a handler needs `sub` to scope reads and writes. That is also why
// there is no break-glass bypass here — a token with no user behind it cannot own an
// automation, so it has nothing to do on this surface. `disabled` (RYPH_AUTH=off) maps to
// a fixed development identity instead of to "anyone", for the same reason.

import type { Claims } from "@ryph/auth";
import { type GateOptions, verifiedClaims } from "@ryph/auth/gates";

const DEV_CLAIMS: Claims = {
  sub: "dev",
  email: "dev@localhost",
  name: "dev",
  caps: ["*"],
  emailVerified: true,
  sid: "dev",
  via: "session",
};

/** Resolves the calling user, or the refusal to send. */
export function makeUserAuth(opts: GateOptions): (req: Request) => Promise<Claims | Response> {
  return (req) => opts.disabled ? Promise.resolve(DEV_CLAIMS) : verifiedClaims(opts.verifier, req);
}
