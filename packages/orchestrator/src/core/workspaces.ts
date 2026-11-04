// Workspaces, as the doors resolve them: a saved list of connected repos becomes the list a
// task checks out. Every door that can start work from a workspace — the user surface, a
// `/ryph` command expanded to the workspace holding its repo, an automation targeting one —
// lands here, so "what does checking out this workspace mean" has one answer.
//
// Invariants:
// - a refusal names the repo: a partial checkout would be a surprise, so an archived member,
//   or one whose row no longer resolves, refuses the whole task and says which
// - the list is resolved at the moment of the ask and frozen onto the task by startTask;
//   editing the workspace afterwards changes nothing for a run already started
// - the default path is the repo's name in slug form — the directory a person would expect
//   under the checkout root — and the override is a per-member choice made when it was added

import type { ConnectedRepo, Workspace, WorkspaceRepo } from "./types.ts";
import type { StartTaskRepo } from "./start_task.ts";
import type { TaskStore } from "../ports/task_store.ts";
import { slugify } from "../helpers/ids.ts";

/**
 * The most repos one run checks out — the runner, the forge grant and memory all cap a run at
 * this many, so a task past it would start a container only to have every clone refused. One
 * number, enforced where a list grows (adding to a workspace) and where one is frozen onto a
 * task (startTask), so nothing downstream ever sees more.
 */
export const MAX_REPOS = 20;

/** A member with its connected repo row resolved. */
export interface ResolvedMember {
  membership: WorkspaceRepo;
  repo: ConnectedRepo;
}

export type WorkspaceCheckout =
  | { kind: "ok"; workspace: Workspace; members: ResolvedMember[] }
  | {
    kind: "refused";
    status: number;
    /** For a signed-in caller: names the member that refused it. */
    error: string;
    /** For a forge thread, which may be public while the member is private: names the
     * workspace and never a member. */
    publicError: string;
  };

/**
 * The directory name a repo gets under the checkout root when nobody chose one: the last
 * segment of its forge address, reduced to a label. "Acme/Web_App" → "web-app". Bounded to what
 * the path rule admits, and never empty.
 */
export function defaultPathFor(repoRef: string): string {
  const name = repoRef.includes("/") ? repoRef.slice(repoRef.lastIndexOf("/") + 1) : repoRef;
  const slug = slugify(name).slice(0, 63).replace(/-+$/, "");
  return slug === "" ? "repo" : slug;
}

/**
 * The workspace and every member, each with its connected repo row — or the refusal to start
 * with. Members come back in the order they were added, which is checkout order.
 */
export async function resolveWorkspace(
  store: Pick<TaskStore, "getWorkspace" | "listWorkspaceRepos" | "getConnectedRepo">,
  workspaceId: string,
): Promise<WorkspaceCheckout> {
  const workspace = await store.getWorkspace(workspaceId);
  if (workspace === null) {
    return {
      kind: "refused",
      status: 404,
      error: "no such workspace",
      publicError: "no such workspace",
    };
  }
  const refused = (error: string, publicError = error): WorkspaceCheckout => ({
    kind: "refused",
    status: 409,
    error,
    publicError,
  });
  if (workspace.archivedAt !== null) {
    return refused(`workspace "${workspace.name}" is archived`);
  }
  const memberships = await store.listWorkspaceRepos(workspace.id);
  if (memberships.length === 0) {
    return refused(`workspace "${workspace.name}" holds no repos yet`);
  }
  const unusable = `workspace "${workspace.name}": one of its repos is disconnected or no ` +
    "longer resolves — see the workspace in ryph";
  const members: ResolvedMember[] = [];
  for (const membership of memberships) {
    const repo = await store.getConnectedRepo(membership.connectedRepoId);
    if (repo === null) {
      return refused(
        `workspace "${workspace.name}": member ${membership.path} no longer resolves ` +
          "to a connected repo — remove it from the workspace",
        unusable,
      );
    }
    if (repo.archivedAt !== null) {
      return refused(
        `workspace "${workspace.name}": ${repo.repoRef} is disconnected — remove it ` +
          "from the workspace, or reconnect it",
        unusable,
      );
    }
    members.push({ membership, repo });
  }
  return { kind: "ok", workspace, members };
}

/**
 * The members as startTask takes them: each at its saved ref (or the repo's default), under
 * its saved path, with its description. `override` swaps one member's ref — the `/ryph`
 * expansion checks the commanded repo out at the pull request's head while the rest keep the
 * workspace's refs.
 */
export function workspaceStartRepos(
  members: readonly ResolvedMember[],
  override: { connectedRepoId: string; ref: string } | null = null,
): StartTaskRepo[] {
  return members.map(({ membership, repo }) => ({
    connectedRepo: repo,
    url: repo.url,
    ref: override !== null && override.connectedRepoId === repo.id
      ? override.ref
      : membership.ref ?? repo.defaultBranch,
    path: membership.path,
    name: repo.repoRef,
    description: membership.description,
  }));
}

/** One connected repo as a checkout of one — the shape every single-repo door starts. */
export function singleRepoStart(repo: ConnectedRepo, ref: string): StartTaskRepo[] {
  return [{
    connectedRepo: repo,
    url: repo.url,
    ref,
    path: defaultPathFor(repo.repoRef),
    name: repo.repoRef,
    description: null,
  }];
}
