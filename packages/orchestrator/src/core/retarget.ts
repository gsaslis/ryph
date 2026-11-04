// Re-targeting a live run: the agent checked a change request out mid-run (the runner's
// `checkout_change_request` tool), and from here this repo's commits belong ON that change
// request rather than on one it will open for itself.
//
// Pure. The route above decides WHETHER — the path is a connected repo of the run, nothing has
// shipped for it yet, the forge still calls the change request workable, no other live run holds
// it — and this decides WHAT MOVES. One fact, written in the places that read it:
//
// - `task.repos[i].ref`, because the submit sweep anchors the pull request on it
//   (core/reaper.ts `baseBranch`) and the gateway serves the base under it — and its
//   `targetRef`, the branch the change request merges into, which the gateway refreshes beside;
// - `task.targetChangeRequest`, because that is what makes the sweep push onto the change
//   request instead of opening a second one (`ontoChange`);
// - `run.workItem.repos[i].ref`, so the frozen spec and the task agree about where this repo
//   stands — a runner that re-fetches its spec must not be told to clone the old base;
// - `run.forgeScope.origin`, but only when the scope holds none: a run started from a chat
//   thread gains the change request its writes are now scoped to, while a run that already
//   came from a thread keeps the thread it came from;
// - `run.forgeScope.workedChangeRequests`, independently of origin, so the run can comment on
//   every change request it checked out, without granting reviews or issue closure there.
//
// And one record goes: `task.landings[path][<default line>]` when it is THIS run's release
// (`releasedRun`; a release only ever lands the default line, the one a target binds) — a
// change request the task worked merged with nothing of the run on it. The runner drops its own
// landing when it moves its clone onto the change request and keeps the generation it was in, so
// a release landing kept would end that generation again and hold every patch the run sends onto
// the change request it now works. A landing a merge of the run's own patch recorded never meets
// a re-target: the route refuses one once the run has a patch on the repo.
//
// `targetChangeRequest` is ONE per task and this overwrites it, which is why the route refuses a
// swap while the task already targets a change request in a DIFFERENT repo: the abandoned one
// would lose its `ontoChange` and its next patch would silently open a pull request of its own.
//
// What deliberately does NOT move is the run's denormalized origin columns. They say where the
// run was COMMANDED from — a chat conversation stays a chat conversation, and rewriting them
// would take the follow-up messages of that conversation away from the run they belong to. The
// exclusion the columns used to carry (one run per change request) is carried instead by the
// claim the route makes through `findLiveRunOnChangeRequest`, which reads both.

import { movedAt, rebased } from "./repo_entries.ts";
import type { Run, RunEvent, Task } from "./types.ts";
import { DEFAULT_LINE } from "@ryph/shared/lines";

export interface RetargetArgs {
  task: Task;
  run: Run;
  /** The checkout directory of the repo being moved — the key into both repo lists. */
  path: string;
  connectedRepoId: string;
  /** The forge's address for the change request, as the caller named it and the task records it. */
  thread: string;
  /** The change request's head branch, bare, as `changeRequestTarget` resolved it. */
  headRef: string;
  headSha: string;
  /** The branch the change request merges into, bare — the repo's `targetRef` from here on.
   * Undefined when there is none a run could fetch (`mergeTargetOf`). */
  targetRef: string | undefined;
  at: string;
}

export interface Retargeted {
  task: Task;
  run: Run;
  /** Appended after both writes land: the history says which repo moved onto what. */
  event: RunEvent;
}

/** `landings` with the path's lines replaced by `kept`, and the path gone when none is left. */
function withoutLine(
  landings: Task["landings"],
  path: string,
  kept: Task["landings"][string],
): Task["landings"] {
  const { [path]: _gone, ...rest } = landings;
  return Object.keys(kept).length === 0 ? rest : { ...rest, [path]: kept };
}

export function retarget(args: RetargetArgs): Retargeted {
  const { task, run, path, connectedRepoId, thread, headRef, headSha, targetRef, at } = args;
  // The target is replaced with the change request's, or dropped: the one this repo had was
  // the base it started from, which is not what the change request merges into.
  const onPath = <T extends { path: string; ref: string; targetRef?: string }>(entries: T[]): T[] =>
    movedAt(entries, path, (entry) => rebased(entry, headRef, targetRef));

  const scope = run.forgeScope;
  // Only a scope that already NAMES the repo: `origin` is a thread the forge lets the run write
  // to, and a thread in a repo the scope never listed would be a widening, not a re-target.
  const inScope = scope?.repos.some((r) => r.connectedRepoId === connectedRepoId) ?? false;
  const gainsOrigin = scope !== null && scope.origin === null && inScope;
  const worked = [...(scope?.workedChangeRequests ?? [])];
  if (inScope && !worked.some((r) => r.connectedRepoId === connectedRepoId && r.ref === thread)) {
    worked.push({ connectedRepoId, ref: thread });
  }

  const { [DEFAULT_LINE]: dropped, ...keptLines } = task.landings[path] ?? {};
  return {
    task: {
      ...task,
      repos: onPath(task.repos),
      targetChangeRequest: { connectedRepoId, thread },
      landings: dropped?.releasedRun === run.id
        ? withoutLine(task.landings, path, keptLines)
        : task.landings,
    },
    run: {
      ...run,
      workItem: { ...run.workItem, repos: onPath(run.workItem.repos) },
      forgeScope: scope === null ? null : {
        ...scope,
        ...(worked.length > 0 ? { workedChangeRequests: worked } : {}),
        origin: gainsOrigin
          ? { connectedRepoId, kind: "change_request", ref: thread }
          : scope.origin,
      },
      updatedAt: at,
    },
    event: {
      runId: run.id,
      at,
      kind: "retargeted",
      detail: `${path} → #${thread} (${headRef} at ${headSha.slice(0, 12)})`,
    },
  };
}
