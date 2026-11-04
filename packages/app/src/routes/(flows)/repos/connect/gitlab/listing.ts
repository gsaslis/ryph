import { ApiError } from "$lib/api/call";
import type { GitlabProject } from "$lib/api/repos";
import type { GitlabMode } from "$lib/api/types";

/** How many rows the list draws at once; a search narrows the rest down. */
export const SHOWN = 50;

/** The projects a search matches, as many as the list draws, and how many it left out. */
export interface GitlabProjectMatches {
  shown: GitlabProject[];
  hidden: number;
}

/**
 * The projects whose `group/…/project` path holds every word of the query, in GitLab's order.
 * Case is ignored, as GitLab ignores it in paths, and an empty query matches everything.
 */
export function filterGitlabProjects(
  projects: GitlabProject[],
  query: string,
  limit = SHOWN,
): GitlabProjectMatches {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const matches = projects.filter((project) => {
    const path = project.pathWithNamespace.toLowerCase();
    return words.every((word) => path.includes(word));
  });
  return { shown: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit) };
}

/**
 * Why a project cannot be picked, or null when it can. An empty project has no default branch to
 * work from. In user mode the token's own access is what connecting needs, so it must be
 * Maintainer; in bot mode the bot is a Developer by design, and the control plane checks the
 * person's access instead, so nothing is known here.
 */
export function unpickable(project: GitlabProject, mode: GitlabMode["mode"]): string | null {
  if (project.defaultBranch === null) return "Empty project";
  if (mode === "user" && !project.admin) return "Needs Maintainer access";
  return null;
}

/** A fetch that rejected with a TypeError never arrived. */
function unreachable(e: unknown): string | null {
  if (e instanceof ApiError) return null;
  return e instanceof TypeError || !(e instanceof Error)
    ? "Ryph could not be reached. Try again."
    : e.message;
}

/** What to say when the list of projects could not be read. */
export function gitlabListFailure(e: unknown): string {
  const away = unreachable(e);
  if (away !== null) return away;
  if (e instanceof ApiError && e.status === 502) return "GitLab did not answer. Try again.";
  return "Ryph could not load the projects. Try again.";
}

/** What to say when a project could not be connected. `gitlab` is how Ryph is on GitLab. */
export function gitlabConnectFailure(e: unknown, gitlab: GitlabMode): string {
  const away = unreachable(e);
  if (away !== null) return away;
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 403) {
    if (gitlab.mode === "user") return "Only admins can connect repositories here.";
    return gitlab.signIn
      ? "Connecting needs Maintainer access to the project, through a GitLab account linked to yours."
      : "Connecting needs a linked GitLab account, and GitLab sign-in isn't set up here.";
  }
  if (status === 404) return `@${gitlab.login} cannot see that project on GitLab.`;
  if (status === 409) return "That project is already connected.";
  if (status === 502) return "GitLab did not answer. Try again.";
  return e instanceof Error ? e.message : "Failed to connect the project.";
}
