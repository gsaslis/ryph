// Authentication for the three HTTP surfaces.
//
// User surface: an `Authenticate` gate injected via AppDeps — @ryph/auth/gates' makeAuthenticate,
// built by the composition root (verified @ryph/auth access tokens, plus an explicit off switch
// for local hacking). The gate yields a PRINCIPAL, not just permission: the control plane needs
// to know WHO is calling (who requested a task, who approved a patch, whose GitHub identity gates
// a launch).
// Runner surface: a per-run bearer, minted at provision time and stored only as a SHA-256 —
// a compromised container can speak for its own run and nothing else, and the credential
// dies with the run.
// Forge surface: the shared RYPH_FORGE_TOKEN service credential (http/forge_api.ts).

import type { Run } from "../core/types.ts";
import { bearerToken, sha256Hex, timingSafeEqual } from "@ryph/sealed";

export async function runTokenMatches(req: Request, run: Run): Promise<boolean> {
  const presented = bearerToken(req);
  if (presented === null) return false;
  return timingSafeEqual(await sha256Hex(presented), run.tokenHash);
}
