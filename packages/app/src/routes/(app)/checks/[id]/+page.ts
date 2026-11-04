import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { getCheckSuite } from "$lib/api/checks";
import type { CheckSuiteView } from "$lib/api/types";
import { shortCommit } from "$lib/utils/environments";

/**
 * The suite this browser last showed, as the page last had it.
 *
 * A load may fall back on it only for the suite already on screen: a first look that cannot read
 * the suite is an error page, while a poll that misses a beat (an orchestrator restart answering
 * 502) keeps the page as it was and tries again on the next tick. The load has no memory of its
 * own, so the memory is here. Browser only, as on the task page: module state on the server is
 * shared by every request it handles.
 */
let shown: { id: string; read: { suite: CheckSuiteView; branch: string | null } } | null = null;

/**
 * One check suite: where a check run on the forge and a Radicle job point. The page polls this
 * load while the suite has no verdict yet.
 *
 * A Radicle job's link names the run it was for (`?generation=N`, one job run per run of the
 * suite). The suite reads back only its latest run, so an older link says it is showing that one.
 */
export const load: PageLoad = async ({ fetch, params, url, depends }) => {
  depends("app:check-suite");
  const asked = Number(url.searchParams.get("generation"));
  const rerun = browser && shown?.id === params.id;
  let read: { suite: CheckSuiteView; branch: string | null };
  try {
    read = await getCheckSuite(fetch, params.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "no such check suite");
    if (!rerun || shown === null) throw e;
    read = shown.read;
  }
  if (browser) shown = { id: params.id, read };
  const { suite, branch } = read;
  return {
    suite,
    branch,
    linkedGeneration: Number.isInteger(asked) && asked > 0 ? asked : null,
    // The commit names the suite: the list above it is already the checks.
    breadcrumb: shortCommit(suite.commit),
  };
};
