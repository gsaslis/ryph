import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { getActiveChecks, listCheckSuites } from "$lib/api/checks";
import { getConnectedRepos } from "$lib/api/repos";
import { ASKER_FILTERS, STATE_FILTERS } from "./filters";

const pick = <T extends string>(all: readonly T[], value: string | null): T =>
  all.includes(value as T) ? value as T : all[0];

/**
 * The overview this browser last showed, keyed by its address, as the page last had it.
 *
 * As on the task page: a first look that cannot be read is an error page, while a poll behind the
 * open page that misses a beat (an orchestrator restart answering 502) keeps what is on screen and
 * tries again on the next tick. Another filter is a first look. Browser only: module state on the
 * server is shared by every request it handles.
 */
let shown: { search: string; data: Overview } | null = null;

type Overview = Awaited<ReturnType<typeof read>>;

/**
 * The checks overview: the suites that ran, newest first, so whatever is running sits on top.
 * What each repository declares is on its own page under Repos.
 */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends("app:checks");
  const rerun = browser && shown?.search === url.search;
  try {
    const data = await read(fetch, url);
    if (browser) shown = { search: url.search, data };
    return data;
  } catch (e) {
    if (!rerun || shown === null || (e instanceof ApiError && e.status === 404)) throw e;
    return shown.data;
  }
};

async function read(fetch: typeof globalThis.fetch, url: URL) {
  const repo = url.searchParams.get("repo");
  const state = pick(STATE_FILTERS, url.searchParams.get("state"));
  const asker = pick(ASKER_FILTERS, url.searchParams.get("asked"));

  const [page, now, connected] = await Promise.all([
    listCheckSuites(fetch, { repo, state, asked: asker }),
    // Only for the pod count beside the filters, whatever the list is narrowed to.
    getActiveChecks(fetch),
    getConnectedRepos(fetch),
  ]);

  return {
    fullWidth: true,
    filters: { repo, state, asker },
    suites: page.suites,
    nextCursor: page.nextCursor,
    activeCount: now.active.length,
    capacity: now.capacity,
    repos: connected.filter((r) => r.archivedAt === null).map((r) => ({
      connectedRepoId: r.id,
      repoRef: r.repoRef,
      provider: r.provider,
    })),
  };
}
