/**
 * What every door starts a task with: the shared path in core/start_task.ts, handed the ports
 * this process has. One builder, so a new start path cannot forget a port the others pass.
 */

import type { StartTaskDeps } from "../core/start_task.ts";
import type { WiredDeps } from "./app.ts";

export function startTaskDeps(deps: WiredDeps): StartTaskDeps {
  return {
    store: deps.store,
    provisioner: deps.provisioner,
    diag: deps.diag,
    forge: deps.forge ?? null,
    serviceCatalogue: deps.serviceCatalogue ?? null,
    skillCatalogue: deps.skillCatalogue ?? null,
    skills: deps.skills ?? null,
    memoryAccess: deps.memoryAccess ?? null,
    identityDirectory: deps.identityDirectory ?? null,
    environments: deps.environments ?? null,
    modelAccess: deps.modelAccess ?? null,
    attachmentStore: deps.attachmentStore ?? null,
    chatAccess: deps.chatAccess ?? null,
    platformModel: deps.platformModel ?? null,
    now: deps.now,
    config: deps.config,
  };
}
