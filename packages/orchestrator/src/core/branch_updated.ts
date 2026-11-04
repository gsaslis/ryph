// A connected repo's default branch moved — `branch.updated`, from GitHub's `push` or the
// Radicle bridge watching the canonical ref. The forge event handler has already matched the
// repo and corrected its recorded default branch; what the move MEANS is decided here: it is
// the trigger environments hang their default-branch builds on.
//
// Two subjects can care: the repo's own environment, and the environment of the workspace it
// belongs to (whose image bakes every member's checkout). Each is refreshed the same way the
// hourly reconcile refreshes it — the definition changed → build now; only code moved →
// rebuild at most every RYPH_ENV_REBUILD_INTERVAL — so an event and the backstop cannot
// disagree about what is due. A workspace's definition is every member's `.ryph/`, so a push
// that changes the `.ryph/` of a member that is not the environment repo builds it now too.
//
// Invariants:
// - IDEMPOTENT: the handler records no dedupe row for this kind, so a redelivery calls it
//   again with the same commit — the service answers a build of the same inputs with the build
//   already queued, running or done
// - never throws for a decision: a throw is a 5xx and the mailroom redelivers, which is right
//   only for "could not ask" (the forge did not answer), never for "decided not to"
// - the event proves the branch moved and nothing else; `.ryph/` is asked of the forge
//   (`Forge.ryphTree`), never inferred from the event

import type { ConnectedRepo, InboundForgeEvent } from "./types.ts";
import type { EnvironmentService } from "./environments.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { TaskStore } from "../ports/task_store.ts";

/** A `branch.updated` event: always carries the branch that moved. */
export type BranchUpdatedEvent = InboundForgeEvent & {
  branch: NonNullable<InboundForgeEvent["branch"]>;
};

export interface BranchUpdatedDeps {
  diag: Diagnostics;
  store: Pick<TaskStore, "findWorkspaceRepo">;
  /** Null/absent, or off: environments are not built here, so a move means nothing. */
  environments?: EnvironmentService | null;
}

/**
 * Called once per `branch.updated` delivery, per connected repo it names, with the repo's row
 * as it stands after the handler corrected its default branch.
 */
export async function onBranchUpdated(
  deps: BranchUpdatedDeps,
  event: BranchUpdatedEvent,
  repo: ConnectedRepo,
): Promise<void> {
  deps.diag.debug("branch_updated.noted", {
    connectedRepoId: repo.id,
    ref: event.branch.ref,
    commit: event.branch.commit,
  });
  const service = deps.environments;
  if (!service || !service.enabled || service.refusedReason !== null) return;
  const subjects = [await service.loadSubject("repo", repo.id)];
  const membership = await deps.store.findWorkspaceRepo(repo.id);
  if (membership !== null) {
    subjects.push(await service.loadSubject("workspace", membership.workspaceId));
  }
  for (const subject of subjects) {
    if (subject === null) continue;
    // A forge that cannot answer throws out of here on purpose: that is "could not ask", and
    // the redelivery is how it gets asked again.
    await service.refreshSubject(subject, "push");
  }
}
