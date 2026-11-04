// The gate for a deployment with no RYPH_RADICLE_TOKEN. With one, the gate is @ryph/sealed's
// `makeServiceGate` over it: a single shared bearer presented by the forge. There is no user
// surface here and no second tier — the bridge signs with the deployment's Radicle key, so
// anything that can reach it can write as ryph, and the only correct posture is "the network
// reaches nobody but the forge".

import type { ServiceGate } from "@ryph/sealed";
import { json } from "@ryph/shared/http";

/** The gate for a deployment with no token configured: everything is refused, loudly enough
 * that an operator can tell it from a routing mistake. */
export const CLOSED_GATE: ServiceGate = () =>
  Promise.resolve(
    json(503, { error: "RYPH_RADICLE_TOKEN is not set — this bridge accepts nothing" }),
  );
