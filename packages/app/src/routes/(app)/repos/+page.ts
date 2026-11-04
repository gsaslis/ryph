import type { PageLoad } from "./$types";
import { getForges, githubUserLogin, radicleUserMode } from "$lib/api/forge";
import { getConnectedRepos, getRepoRadicleInfo } from "$lib/api/repos";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:repos");
  // The provider list decides how much this page says about forges at all: with GitHub alone,
  // naming it on every row would be noise.
  // A forge that does not answer costs the page its wording, not the list: the providers of the
  // repos already connected stand in.
  const [all, answered] = await Promise.all([
    getConnectedRepos(fetch),
    getForges(fetch).catch(() => null),
  ]);
  const repos = all.filter((repo) => !repo.archivedAt);
  const providers = answered?.providers ?? [...new Set(repos.map((repo) => repo.provider))];
  // In user mode every GitHub action is taken as one person, whoever asked for it; the page says
  // whose name that is.
  const githubLogin = githubUserLogin(answered);
  // The same for GitLab: one person in user mode, and the bot everyone's work goes through
  // otherwise. Either way the page names the account.
  const gitlab = answered?.gitlab ?? null;
  // A Radicle repo's name lives in its identity document, which only ryph's node can read — one
  // round trip to it per repo. STREAMED, so the grid draws at once with the RID and each card
  // takes its name as the node answers; a node that is down costs the cards their names, not
  // the page. Null is "could not be read", and the card keeps the RID as its title.
  const radicleNames: Record<string, Promise<string | null>> = Object.fromEntries(
    repos
      .filter((repo) => repo.provider === "radicle")
      .map((repo) => [
        repo.id,
        getRepoRadicleInfo(fetch, repo.id).then((info) => info.name, () => null),
      ]),
  );
  return {
    repos,
    providers,
    githubLogin,
    gitlab,
    radicleMine: radicleUserMode(answered),
    radicleNames,
  };
};
