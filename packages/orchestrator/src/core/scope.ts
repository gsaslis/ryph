// What a caller may see of the tasks: the scope, decided once per request and handed to the
// store as a value, so a list is filtered in the query and a single read that falls outside it
// answers 404 exactly as a task that never existed would. A task is in scope when the caller
// asked for it, or when the caller holds write on every repo it checks out. `all` is what a
// `-all` capability and a break-glass principal get.

import type { Task } from "./types.ts";

export type Scope =
  | { kind: "all" }
  | { kind: "principal"; userId: string; writableRepoIds: readonly string[] };

export const SCOPE_ALL: Scope = { kind: "all" };

/**
 * Whether one task falls inside a scope: the predicate the store's queries express in SQL, for
 * a row already in hand.
 *
 * @example
 * if (!taskInScope(task, scope)) return json(404, { error: "no such task" });
 */
export function taskInScope(
  task: Pick<Task, "requestedByUserId" | "repos">,
  scope: Scope,
): boolean {
  if (scope.kind === "all") return true;
  if (task.requestedByUserId === scope.userId) return true;
  const ids = task.repos.map((repo) => repo.connectedRepoId);
  // A legacy entry (core/legacy.ts) has no repo anyone may write: such a task is its
  // requester's alone, as the store's `IS NULL` guard keeps it.
  return ids.length > 0 && ids.every((id) => id !== null && scope.writableRepoIds.includes(id));
}

/**
 * The forge's answer for one user on one repo, as the cache keeps it. Only `writable` is read;
 * a refusal is cached too, so a repo the forge said no to is not asked about again before the
 * cache turns over. A question the forge could not answer leaves no row, and is asked again.
 */
export interface RepoAccess {
  id: string;
  userId: string;
  connectedRepoId: string;
  writable: boolean;
  checkedAt: string;
}

/** How long a cached forge answer serves reads before the next scoped request refreshes it. */
export const REPO_ACCESS_TTL_MS = 10 * 60 * 1000;
