// Whether a live run may still be spoken to on its owner's behalf. A run acts for the user its
// task names (`requestedByUserId`) — an automation's owner, a command room's, the linked user
// behind a `/ryph` command — and every door that hands a run new input for them (a fire
// joining a response, a chat mention, a forge follow-up) asks this first: an owner deactivated
// or deleted since the run started, or whose role no longer lets them start tasks, can no longer
// steer it, as they can no longer start one. The run page's own message box needs no such gate:
// its caller signed in, and their token's capabilities are asked there.

import type { IdentityDirectory } from "../ports/identity_directory.ts";
import type { TaskStore } from "../ports/task_store.ts";
import type { Run } from "../core/types.ts";

/**
 * True only when the run's task names an owner and the directory says they may still start
 * tasks (active, and their current role holds `tasks:create`). A run with no owner (break-glass)
 * has nobody these doors could act for, and no directory to ask is no answer — an unattended
 * door does not guess.
 */
export async function runOwnerMayAct(
  deps: {
    store: Pick<TaskStore, "getTask">;
    identityDirectory?: IdentityDirectory | null;
  },
  run: Pick<Run, "taskId">,
): Promise<boolean> {
  if (!deps.identityDirectory) return false;
  const task = await deps.store.getTask(run.taskId);
  if (task === null || task.requestedByUserId === null) return false;
  return await deps.identityDirectory.mayStartTasks(task.requestedByUserId);
}
