// Which connected repos an inbound forge event is about, and whether a GitLab webhook delivery
// is one this deployment still takes.
//
// GitLab is matched by its numeric project id, never its path. The id is the scope the
// webhook's token was verified for (the forge forwards it as `repo.forgeId`), so a delivery can
// only ever name the project whose token it carried; and a project renamed, moved or deleted
// and its path reused by another keeps its id, where a path match would follow the name to a
// project nobody connected. The path the forge read for the event rides along and is written
// back onto the row when GitLab moved the project, for the pages and prompts that name it; the
// forge reaches the project by its id.
//
// And an id is GitLab's on ONE instance. The forge only ever forwards its own instance's ids, so
// a row connected on another — before `RYPH_GITLAB_URL` changed — names whatever project holds
// that id here, which nobody connected: it matches no event and admits no delivery.
//
// Every other forge is matched on (provider, address) as `namesRepo` says.

import type { ConnectedRepo, GitlabHookLane, GitlabProject, InboundForgeEvent } from "./types.ts";
import type { TaskStore } from "../ports/task_store.ts";
import { namesRepo } from "./forge_repo.ts";

/** How finely a GitLab webhook's arrival is recorded: one write a minute at most. */
export const HOOK_DELIVERY_RESOLUTION_MS = 60_000;

export interface EventRepoDeps {
  store: Pick<
    TaskStore,
    | "listConnectedRepos"
    | "getConnectedRepo"
    | "saveConnectedRepo"
    | "listGitlabProjectsById"
    | "recordGitlabHookDelivery"
    | "recordGitlabHookDrops"
  >;
  diag: { debug(event: string, data: Record<string, unknown>): void };
  now(): Date;
  /** The GitLab instance the forge acts on now (`GitlabMode.url`); null where it runs none or
   * has not said — and then no GitLab row is any event's. */
  gitlabUrl(): Promise<string | null>;
}

/** The rows of a GitLab project id that are THIS instance's, newest first. */
async function currentRows(deps: EventRepoDeps, projectId: string): Promise<GitlabProject[]> {
  const url = await deps.gitlabUrl();
  if (url === null) return [];
  return (await deps.store.listGitlabProjectsById(projectId)).filter((g) => g.instance === url);
}

/**
 * The connected repos `event` names, archived ones included, newest first. A GitLab event
 * names repos by `repo.forgeId` alone — one without it names none — and a live repo whose
 * stored path or URL is not what the forge read for it now is brought up to date first.
 */
export async function reposNamedBy(
  deps: EventRepoDeps,
  event: Pick<InboundForgeEvent, "repo">,
): Promise<ConnectedRepo[]> {
  if (event.repo.provider !== "gitlab") {
    return (await deps.store.listConnectedRepos()).filter((r) => namesRepo(r, event));
  }
  const projectId = event.repo.forgeId;
  if (projectId === undefined) return [];
  const out: ConnectedRepo[] = [];
  for (const row of await currentRows(deps, projectId)) {
    let repo = await deps.store.getConnectedRepo(row.connectedRepoId);
    if (repo === null || repo.provider !== "gitlab") continue;
    if (
      repo.archivedAt === null &&
      (repo.repoRef !== event.repo.repoRef || repo.url !== event.repo.url)
    ) {
      deps.diag.debug("forge_event.gitlab_project_moved", {
        connectedRepoId: repo.id,
        from: repo.repoRef,
        to: event.repo.repoRef,
      });
      repo = {
        ...repo,
        repoRef: event.repo.repoRef,
        url: event.repo.url,
        updatedAt: deps.now().toISOString(),
      };
      await deps.store.saveConnectedRepo(repo);
    }
    out.push(repo);
  }
  return out;
}

/** Which kind of GitLab delivery is admitted: a Merge Request Hook is the only one a merge
 * arrives as, so it is recorded on its own for the merge poll's silence check. */
export type GitlabHookHeard = "merge_request" | "other";

/**
 * What the forge is told about a verified GitLab webhook delivery (its `GitlabHookGate`).
 * `connectedAt` is when the project's current connection was made: a note written before it
 * was never meant for this deployment, and the forge drops it.
 */
export type GitlabHookAdmission =
  | { admission: "current"; connectedAt: string }
  | { admission: "stale" | "unconnected" };

/**
 * Whether a delivery whose token the forge's mailroom verified for `projectId` at `generation`
 * is one to act on: `unconnected` when no live connected repo is that project, `stale` when its
 * token was rotated past that generation, and `current` otherwise. The generation is compared as
 * the text the URL carried: the forge only ever mints `String(n)`, so `01` was minted by nobody.
 *
 * Asked twice per delivery. The forge's door asks with no `heard` before it stores a row — so a
 * stale or unwanted token costs no storage and no consumer — and nothing is recorded. Its
 * consumer asks again with `heard` when it takes the row (a rotation may have happened between),
 * and then a current arrival is recorded, for the repo page's "last delivery" and — a Merge
 * Request Hook's — the merge poll's silence check.
 */
export async function admitGitlabHook(
  deps: EventRepoDeps,
  projectId: string,
  generation: string,
  heard?: GitlabHookHeard,
): Promise<GitlabHookAdmission> {
  const live = await liveGitlabRow(deps, projectId);
  if (live === null) return { admission: "unconnected" };
  if (generation !== String(live.hookGeneration)) return { admission: "stale" };
  if (heard !== undefined) {
    const now = deps.now();
    await deps.store.recordGitlabHookDelivery(
      live.connectedRepoId,
      now.toISOString(),
      new Date(now.getTime() - HOOK_DELIVERY_RESOLUTION_MS).toISOString(),
      heard === "merge_request",
    );
  }
  return { admission: "current", connectedAt: live.createdAt };
}

/** The row of the live connected repo that is GitLab project `projectId`, if one is. */
async function liveGitlabRow(
  deps: EventRepoDeps,
  projectId: string,
): Promise<GitlabProject | null> {
  for (const row of await currentRows(deps, projectId)) {
    const repo = await deps.store.getConnectedRepo(row.connectedRepoId);
    if (repo !== null && repo.archivedAt === null && repo.provider === "gitlab") return row;
  }
  return null;
}

/**
 * Records `count` deliveries the forge's door dropped over `projectId`'s `lane` budget at
 * `generation` — acknowledged to GitLab so its hook is never disabled for them, and never stored
 * — for the repo page to say which were lost. Counted only at the current generation of a live
 * connection, like an arrival: a rotated token's drops were never this webhook's. Answers
 * whether they counted.
 */
export async function recordGitlabHookDrops(
  deps: EventRepoDeps,
  projectId: string,
  generation: string,
  lane: GitlabHookLane,
  count: number,
): Promise<boolean> {
  const live = await liveGitlabRow(deps, projectId);
  if (live === null || generation !== String(live.hookGeneration)) return false;
  await deps.store.recordGitlabHookDrops(
    live.connectedRepoId,
    lane,
    count,
    deps.now().toISOString(),
  );
  return true;
}
