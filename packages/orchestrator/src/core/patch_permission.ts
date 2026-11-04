// Whether an agent may open patches, read LIVE: the one rule every door a patch moves through
// asks — birth, approval, retry and the submit sweep — so switching an agent's patches off stops
// what is already in flight, not only runs started after. A run's frozen copy (the work item's
// `canOpenPatches`) is what its runner was told and acts on; it is never the authority here.

import type { TaskStore } from "../ports/task_store.ts";
import type { Patch } from "./types.ts";

/** False when the agent no longer resolves, too: a patch nobody can attribute ships nowhere. */
export async function agentMayOpenPatches(
  store: Pick<TaskStore, "getAgent">,
  agentId: string,
): Promise<boolean> {
  const agent = await store.getAgent(agentId);
  return agent !== null && agent.canOpenPatches;
}

/**
 * Whether a waiting patch may move on toward the forge: `locked` while its agent may not open
 * patches, `unresolved` when its run is gone — a dangling reference, which each door answers in
 * its own words rather than mistaking it for a locked agent.
 */
export async function patchMayShip(
  store: Pick<TaskStore, "getAgent" | "getRun">,
  patch: Pick<Patch, "runId">,
): Promise<"ok" | "locked" | "unresolved"> {
  const run = await store.getRun(patch.runId);
  if (run === null) return "unresolved";
  return await agentMayOpenPatches(store, run.agentId) ? "ok" : "locked";
}
