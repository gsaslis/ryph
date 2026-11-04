import { apiCall } from "./call";
import { type DeploymentLimits, deploymentLimitsSchema } from "./types";

/**
 * The operator's run limits (RYPH_RUN_MAX_* and RYPH_RUN_CONCURRENCY) — the ceiling the agent
 * form validates a policy against and the task form bounds an override with. Readable by anyone;
 * set only in the environment.
 */
export async function getLimits(f = fetch): Promise<DeploymentLimits> {
  return deploymentLimitsSchema.parse(await apiCall(f, "/v1/limits"));
}

/**
 * The same, or null when it could not be read. A form must still open when the control plane
 * does not answer this one route; the limits section then says it is unavailable.
 */
export async function getLimitsOrNull(f = fetch): Promise<DeploymentLimits | null> {
  try {
    return await getLimits(f);
  } catch {
    return null;
  }
}
