import { browser } from "$app/environment";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getForges, githubUserLogin } from "$lib/api/forge";
import { getGithubRepos } from "$lib/api/repos";
import type { GithubRepo } from "$lib/api/types";
import { can } from "$lib/utils/auth/capabilities";
import { safeBackTo, withBackTo } from "$lib/utils/safe-path";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);

  // Where the flow returns to when another flow (the welcome) opened it.
  const backTo = safeBackTo(url.searchParams.get("backTo"));

  // An unreachable forge answers 502; the page offers a retry instead of the generic error page.
  const forges = await getForges(fetch).catch(() => null);
  if (forges === null) {
    return {
      login: null,
      multiForge: false,
      repos: Promise.resolve(null),
      unavailable: true,
      allowed: true,
      backTo,
    };
  }
  // Only a deployment that acts as one person on GitHub has this list; with an App the way in is
  // the installation screen.
  const login = githubUserLogin(forges);
  if (login === null) redirect(307, withBackTo("/repos/connect", backTo));
  const multiForge = forges.providers.length > 1;

  // Everyone acts on GitHub as one account here, so connecting a repo is an admin's call; the
  // control plane refuses anyone else. Say so before they pick.
  if (!can(user, "repos:manage-all")) {
    return {
      login,
      multiForge,
      repos: Promise.resolve(null),
      unavailable: false,
      allowed: false,
      backTo,
    };
  }

  // Not awaited, and asked in the browser only: the list is every page of the account's repos on
  // GitHub, which can take a while, and the step draws its frame first. Null on the server is
  // "still being read".
  const repos: Promise<GithubRepo[] | null> = browser
    ? getGithubRepos(fetch)
    : Promise.resolve(null);
  // The page reads its failure; this only keeps one from going unhandled when nothing is left to.
  repos.catch(() => {});
  return { login, multiForge, repos, unavailable: false, allowed: true, backTo };
};
