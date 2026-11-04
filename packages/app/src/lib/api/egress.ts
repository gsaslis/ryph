import { apiCall } from "./call";
import { type EgressCeiling, egressCeilingSchema } from "./types";

/**
 * What this deployment's runs may reach, and therefore what an agent's policy may narrow.
 *
 * Unreadable is NOT "no boundary" — the same rule the tool surface follows. A deployment whose
 * control plane did not answer still has whatever ceiling it has, and a form that read silence
 * as "open" would offer an allowlist nobody is enforcing. So the failure is its own state and
 * the form says it cannot show this rather than showing something wrong.
 */
export type EgressState = "on" | "unknown";

export interface EgressAccess {
  egressState: EgressState;
  /** Null exactly when `egressState` is "unknown". */
  egressCeiling: EgressCeiling | null;
}

export async function getEgress(f = fetch): Promise<EgressAccess> {
  try {
    const ceiling = egressCeilingSchema.parse(await apiCall(f, "/v1/egress"));
    return { egressState: "on", egressCeiling: ceiling };
  } catch {
    return { egressState: "unknown", egressCeiling: null };
  }
}

/**
 * Moves this deployment's allowlist. Takes `egress:manage` — the API refuses anyone else with a
 * 403 naming that capability, and the form is hidden rather than offered-then-refused.
 *
 * Only the two lists: whether the boundary is enforced at all and where the proxy answers stay
 * in the deployment's environment, because an admin turning the control off from inside the
 * product it controls is a bypass and not a setting.
 */
export async function putEgressAllowlist(
  allowlist: { bundles: string[]; hosts: string[] },
  f = fetch,
): Promise<void> {
  await apiCall(f, "/v1/egress", { method: "PUT", body: JSON.stringify(allowlist) });
}
