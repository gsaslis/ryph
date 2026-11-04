import { ApiError } from "$lib/api/call";
import type { GithubRepo } from "$lib/api/types";

/** How many rows the list draws at once; a search narrows the rest down. */
export const SHOWN = 50;

/** The repos a search matches, as many as the list draws, and how many it left out. */
export interface GithubRepoMatches {
  shown: GithubRepo[];
  hidden: number;
}

/**
 * The repos whose `owner/name` holds every word of the query, in GitHub's order. Case is ignored,
 * and an empty query matches everything.
 */
export function filterGithubRepos(
  repos: GithubRepo[],
  query: string,
  limit = SHOWN,
): GithubRepoMatches {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const matches = repos.filter((repo) => {
    const name = repo.fullName.toLowerCase();
    return words.every((word) => name.includes(word));
  });
  return { shown: matches.slice(0, limit), hidden: Math.max(0, matches.length - limit) };
}

/** A fetch that rejected with a TypeError never arrived. */
function unreachable(e: unknown): string | null {
  if (e instanceof ApiError) return null;
  return e instanceof TypeError || !(e instanceof Error)
    ? "Ryph could not be reached. Try again."
    : e.message;
}

/** What to say when the list of the account's repos could not be read. */
export function githubListFailure(e: unknown): string {
  const away = unreachable(e);
  if (away !== null) return away;
  if (e instanceof ApiError && e.status === 502) return "GitHub did not answer. Try again.";
  return "Ryph could not load your repositories. Try again.";
}

/** What to say when a repo could not be connected. `login` is the account Ryph acts as. */
export function githubConnectFailure(e: unknown, login: string): string {
  const away = unreachable(e);
  if (away !== null) return away;
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 404) return `@${login} cannot see that repository on GitHub.`;
  if (status === 409) return "That repository is already connected.";
  if (status === 502) return "GitHub did not answer. Try again.";
  return e instanceof Error ? e.message : "Failed to connect the repository.";
}
