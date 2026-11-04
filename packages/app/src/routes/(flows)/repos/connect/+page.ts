import { redirect } from "@sveltejs/kit";
import { ApiError } from "$lib/api/call";
import type { PageLoad } from "./$types";
import { getForges, githubUserLogin, radicleUserMode } from "$lib/api/forge";
import { getInstallationRepos, getInstallations } from "$lib/api/repos";
import { safeBackTo, withBackTo } from "$lib/utils/safe-path";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname + url.search)}`);

  // Where the flow returns to when another flow (the welcome) opened it; every step carries it.
  const backTo = safeBackTo(url.searchParams.get("backTo"));

  // With an installation picked (or freshly registered by the callback), show its repo
  // listing; without one, show the entry paths — install the App or reuse an installation.
  const installationId = url.searchParams.get("installationId");
  if (installationId) {
    // A 501 is a deployment that acts on GitHub as one person's token: it has no installations,
    // and its way in is that account's repo list.
    const listing = await getInstallationRepos(fetch, installationId).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 501) {
        redirect(307, withBackTo("/repos/connect/github", backTo));
      }
      throw e;
    });
    return {
      installationId,
      listing,
      installations: null,
      providers: ["github"],
      githubLogin: null,
      gitlab: null,
      radicleMine: false,
      choose: false,
      unavailable: false,
      backTo,
    };
  }

  // Which forge, asked only where there is more than one — a GitHub-only deployment never sees
  // this question, and its connect flow is what it always was. One without a GitHub App and with
  // a single other way in goes straight to that provider's own flow: the App screen would be a
  // dead end.
  // An unreachable forge answers 502; the page says so in the flow's own frame and offers a retry.
  const forges = await getForges(fetch).catch(() => null);
  if (forges === null) {
    return {
      installationId: null,
      listing: null,
      installations: null,
      providers: [],
      githubLogin: null,
      gitlab: null,
      radicleMine: false,
      choose: false,
      unavailable: true,
      backTo,
    };
  }
  const { providers } = forges;
  // In user mode GitHub is one person's account and there is no App to install: its way in is
  // the list of that account's repos.
  const githubLogin = githubUserLogin(forges);
  // In Radicle user mode the node is the person's own, and so is every signature on a patch.
  const radicleMine = radicleUserMode(forges);
  if (!providers.includes("github")) {
    // No forge listed at all keeps the old answer, Radicle's flow, which explains what is missing.
    if (providers.length <= 1) {
      redirect(307, withBackTo(`/repos/connect/${providers[0] ?? "radicle"}`, backTo));
    }
    return {
      installationId: null,
      listing: null,
      installations: null,
      providers,
      githubLogin,
      gitlab: forges.gitlab,
      radicleMine,
      choose: true,
      unavailable: false,
      backTo,
    };
  }
  const picked = url.searchParams.get("provider");
  if (githubLogin !== null && (providers.length === 1 || picked === "github")) {
    redirect(307, withBackTo("/repos/connect/github", backTo));
  }
  if (providers.length > 1 && picked !== "github") {
    return {
      installationId: null,
      listing: null,
      installations: null,
      providers,
      githubLogin,
      gitlab: forges.gitlab,
      radicleMine,
      choose: true,
      unavailable: false,
      backTo,
    };
  }

  return {
    installationId: null,
    listing: null,
    installations: await getInstallations(fetch),
    providers,
    githubLogin,
    gitlab: forges.gitlab,
    radicleMine,
    choose: false,
    unavailable: false,
    backTo,
  };
};
