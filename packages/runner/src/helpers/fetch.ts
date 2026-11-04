// The runner's mid-run fetches of a run's repos: by explicit URL into an explicit ref, never
// through `origin`. The checkout's config is the agent's to write, and a fetch through `origin`
// reads `remote.origin.url`, `.uploadpack` and `.fetch` from it; one by URL reads none of them, so
// ryph's fetches work whatever the agent did to its remote. This is hermeticity, not a defence:
// the agent shares the runner's uid and can read the run's credential anyway.
//
// Invariants:
// - the fetched branch lands in `refs/remotes/origin/<branch>`, the ref a clone's `origin/<branch>`
//   is, and the answer is read from THAT ref, never `FETCH_HEAD`: two fetches in flight (a landing
//   cue's and an update's) each read what they fetched
// - the proxy settings the URL matches are pinned empty on the command line: `http.proxy`, the
//   URL's own `http.<url>.proxy` (the most specific match there is, so it wins) and the
//   `remote.<url>.proxy` git reads for a remote named by its URL
// - what `-c` cannot undo is left as is: a `url.<x>.insteadOf` or a `remote.<url>.url` the
//   checkout configures still rewrites where the fetch goes. The gateway transport holds what it
//   fetched to the gateway's own answer, so a rewritten fetch is refused there, not believed

import type { Git } from "./git_exec.ts";

/** The remote-tracking ref a branch of the run's origin is fetched into. */
export function trackingRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

/**
 * Fetches `branch` of the repository at `url` into `refs/remotes/origin/<branch>` and answers the
 * commit it landed on. `git` is the transport's executor, credential and all. The branch is a
 * name under `refs/heads/` and rides inside the refspec after `--`, so no spelling of it reads as
 * an option.
 */
export async function fetchBranch(
  git: Git,
  dir: string,
  url: string,
  branch: string,
): Promise<string> {
  const tracking = trackingRef(branch);
  await git(
    dir,
    ...pinnedConfig(url),
    "fetch",
    "--quiet",
    "--",
    url,
    `+refs/heads/${branch}:${tracking}`,
  );
  return await git(dir, "rev-parse", "--verify", "--end-of-options", `${tracking}^{commit}`);
}

/** The `-c` pins a fetch of `url` leads with (see the invariants above). */
function pinnedConfig(url: string): string[] {
  const pins = ["http.proxy="];
  // Only a URL a proxy applies to: a path is a remote name to git's config, and none is wanted.
  if (/^https?:\/\//i.test(url)) pins.push(`http.${url}.proxy=`, `remote.${url}.proxy=`);
  return pins.flatMap((pin) => ["-c", pin]);
}
