import type { PageLoad } from "./$types";
import { browser } from "$app/environment";
import { ApiError } from "$lib/api/call";
import { listBuilds } from "$lib/api/environments";
import { getConnectedRepos } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";
import { STATE_FILTERS, type StateFilter } from "./filters";

/**
 * The list this browser last showed, keyed by its address. As on the checks list: a first look
 * that cannot be read is an error page, while a poll that misses a beat keeps what is on screen.
 * Browser only: module state on the server is shared by every request it handles.
 */
let shown: { search: string; data: Overview } | null = null;

type Overview = Awaited<ReturnType<typeof read>>;

/** Every environment build on this deployment, newest first, so whatever builds sits on top. */
export const load: PageLoad = async ({ fetch, url, depends }) => {
  depends("app:builds");
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
  const asked = url.searchParams.get("state");
  const state: StateFilter = STATE_FILTERS.includes(asked as StateFilter)
    ? asked as StateFilter
    : "any";
  // A subject the list cannot be narrowed to is no filter, as an unknown state is.
  const asSubject = url.searchParams.get("subject");
  const subject = asSubject !== null && /^(repo|workspace):.+$/.test(asSubject) ? asSubject : null;

  const [page, repos, workspaces] = await Promise.all([
    listBuilds(fetch, { state, subject }),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
  ]);

  return {
    fullWidth: true,
    filters: { state, subject },
    builds: page.builds,
    nextCursor: page.nextCursor,
    subjects: [
      ...repos.filter((r) => r.archivedAt === null).map((r) => ({
        value: `repo:${r.id}`,
        name: r.repoRef,
        provider: r.provider,
      })),
      ...workspaces.filter(({ workspace: w }) => w.archivedAt === null).map(({ workspace: w }) => ({
        value: `workspace:${w.id}`,
        name: w.name,
        provider: null,
      })),
    ],
  };
}
