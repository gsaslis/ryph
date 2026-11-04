// Tasks stored before every task had to check out a connected repo: their entries may name a raw
// git URL, with a null `connectedRepoId`. They stay readable (lists, task pages, run history),
// and nothing acts on them again. Every door that needs a repo asks here and refuses plainly.

import type { RepoEntry } from "./types.ts";

/** The refusal for an action on a legacy entry, in the words a person or an agent reads. */
export function legacyRefusal(entry: Pick<RepoEntry, "path">): string {
  return `${entry.path} is not a connected repository, so ryph cannot do this for it`;
}
