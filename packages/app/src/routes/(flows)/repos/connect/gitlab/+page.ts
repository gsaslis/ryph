import { browser } from "$app/environment";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getForges } from "$lib/api/forge";
import { listIdentities } from "$lib/api/identities";
import { getGitlabProjects, type GitlabProject } from "$lib/api/repos";
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
      gitlab: null,
      multiForge: false,
      projects: Promise.resolve(null),
      unavailable: true,
      allowed: true,
      needsLink: false,
      backTo,
    };
  }
  // A deployment with no GitLab has nothing here; the chooser knows what it does have.
  if (forges.gitlab === null) redirect(307, withBackTo("/repos/connect", backTo));
  const gitlab = forges.gitlab;
  const multiForge = forges.providers.length > 1;

  // In user mode everyone acts on GitLab as one person, so connecting is an admin's call, as in
  // GitHub user mode. In bot mode the control plane checks the person's own Maintainer access on
  // the project, live, through their linked GitLab account; nothing to say before they pick.
  if (gitlab.mode === "user" && !can(user, "repos:manage-all")) {
    return {
      gitlab,
      multiForge,
      projects: Promise.resolve(null),
      unavailable: false,
      allowed: false,
      needsLink: false,
      backTo,
    };
  }

  // In bot mode connecting checks the person's Maintainer access through their linked GitLab
  // account, so without one there is nothing to pick yet: say so up front. An identity list
  // that cannot be read says nothing; the connect itself still answers.
  const needsLink = gitlab.mode === "bot" &&
    !(await listIdentities(fetch).then(
      (identities) => identities.some((i) => i.provider === "gitlab"),
      () => true,
    ));

  // Not awaited, and asked in the browser only: the list is every page of the token's projects,
  // which can take a while, and the step draws its frame first. Null on the server is "still
  // being read".
  const projects: Promise<GitlabProject[] | null> = browser
    ? getGitlabProjects(fetch)
    : Promise.resolve(null);
  // The page reads its failure; this only keeps one from going unhandled when nothing is left to.
  projects.catch(() => {});
  return { gitlab, multiForge, projects, unavailable: false, allowed: true, needsLink, backTo };
};
