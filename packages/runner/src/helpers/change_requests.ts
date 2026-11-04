// What the agent calls the change requests its run's repositories take, so its instructions name
// the forges it is actually on: a pull request on GitHub, a merge request on GitLab, a patch on
// Radicle. Read off each entry's `provider`; an entry that does not say (a control plane older
// than the field) counts as every forge, which is what the text said before it could tell.

import type { RepoEntry } from "../core/types.ts";

type Forge = "github" | "gitlab" | "radicle";

const FORGES: readonly Forge[] = ["github", "gitlab", "radicle"];
const KIND: Record<Forge, string> = {
  github: "a pull request on GitHub",
  gitlab: "a merge request on GitLab",
  radicle: "a patch on Radicle",
};

/** The forges the repositories are on, in a fixed order. A local repository is on none. */
function forgesOf(repos: ReadonlyArray<Pick<RepoEntry, "provider">>): Forge[] {
  const on = new Set<Forge>();
  for (const repo of repos) {
    if (repo.provider === undefined) return [...FORGES];
    if (repo.provider !== "local") on.add(repo.provider);
  }
  return FORGES.filter((f) => on.has(f));
}

/**
 * `a pull request on GitHub, a merge request on GitLab` — one phrase per forge the repositories
 * are on. `radicle: false` leaves Radicle's out where the sentence already says "patch", ryph's
 * own word for what it ships. Empty when none is left.
 */
export function changeRequestKinds(
  repos: ReadonlyArray<Pick<RepoEntry, "provider">>,
  opts: { radicle?: boolean } = {},
): string {
  return forgesOf(repos)
    .filter((f) => opts.radicle !== false || f !== "radicle")
    .map((f) => KIND[f])
    .join(", ");
}

/** One word for them: `pull request` where every repository is on GitHub, `merge request` where
 * every one is on GitLab, else `change request`. */
export function changeRequestNoun(repos: ReadonlyArray<Pick<RepoEntry, "provider">>): string {
  const forges = forgesOf(repos);
  if (forges.length === 1 && forges[0] === "github") return "pull request";
  if (forges.length === 1 && forges[0] === "gitlab") return "merge request";
  return "change request";
}
