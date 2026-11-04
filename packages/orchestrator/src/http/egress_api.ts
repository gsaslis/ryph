// The egress surface: one route, spoken only by the egress proxy, carrying one fact — a host it
// refused, and the port it refused it on.
//
// WHY THE PROXY PRESENTS THE RUN'S OWN TOKEN. The proxy holds no credential; that is the whole
// reason it is a thin target (images/egress-proxy/main.ts, deploy/helm/ryph/templates/egress-proxy.yaml).
// Minting it a service credential of its own — a `RYPH_EGRESS_TOKEN` beside the forge's and the
// chat service's — would have undone that for a write worth a line of JSON: the one process in
// the deployment whose job is to reach the open internet would have started holding a key to
// something of ours.
//
// So it presents the CLAIM IT JUST VERIFIED, back at the control plane that minted it. The
// authority for the report is the subject's own token, which the proxy already had in its hand
// and gains nothing new by forwarding. Two properties follow, and both are the point:
//
// - the SUBJECT IS READ OFF THE SIGNATURE, never off the body. A caller cannot report a refusal
//   against a run that is not the one its token names, because the id is the claim's.
// - a run holds its own token, so a run can call this about itself. It can record hosts it was
//   never refused, against itself, up to `MAX_EGRESS_REFUSALS`. That is the whole prize, and it
//   is a run writing prose into its own record — the same thing it can already do with every
//   line it prints. Anything stronger would need a credential the proxy must not hold.
//
// Mounted only when this deployment has an egress key, because without one there is nothing to
// verify a report with and no proxy to send one.
//
// Invariants:
// - every refusal to accept is the same 401, whatever went wrong with the token: forged,
//   expired and malformed must not be distinguishable to something shaping its next attempt
// - the answer says whether to keep reporting and nothing else. `204` for recorded and for a
//   duplicate alike — a caller must not learn from this route which hosts a subject was already
//   refused — and `410` for a subject that has ended, which is the proxy's signal to forget it
// - the body is two fields. Whatever else a proxy might know about a request, this surface has
//   no column for it and asks for none

import { verifyEgressToken } from "../core/egress.ts";
import { makeEgressRefusalRecorder } from "../core/egress_refusals.ts";
import { EgressRefusalReportSchema } from "../schema.ts";
import type { WiredDeps } from "./app.ts";
import { json, parseBody, type Route, route } from "@ryph/shared/http";
import { bearerToken, unauthorized } from "@ryph/sealed";

export function egressRoutes(deps: WiredDeps, key: Uint8Array): Route[] {
  const { diag } = deps;
  const recorder = makeEgressRefusalRecorder({
    store: deps.store,
    environments: deps.environments?.store ?? null,
    diag,
    now: deps.now,
  });

  return [
    route("POST", "/v1/egress/refusals", async (req) => {
      const presented = bearerToken(req);
      if (presented === null) return unauthorized();
      const claim = await verifyEgressToken(
        presented,
        key,
        Math.floor(deps.now().getTime() / 1000),
      );
      if (claim === null) return unauthorized();
      const parsed = await parseBody(req, EgressRefusalReportSchema);
      if (!parsed.ok) return parsed.res;
      const outcome = await recorder.record(claim.runId, parsed.data);
      if (outcome === "ended") {
        // Gone, not 404: the caller is being told this subject is over, so stop — which is a
        // different instruction from "this route is not here".
        return json(410, { error: "that run or build has ended", code: "subject_ended" });
      }
      return new Response(null, { status: 204 });
    }),
  ];
}
