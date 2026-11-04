import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { ApiError } from "$lib/api/call";
import { streamRepoChecks } from "$lib/api/checks";
import { streamRepoServices } from "$lib/api/services";
import { getEnvironmentOrError, streamEnvironmentDefinition } from "$lib/api/environments";
import { getForges, githubUserLogin, radicleUserMode } from "$lib/api/forge";
import { getCommandAllowlist, getConnectedRepo, getRepoRadicleInfo } from "$lib/api/repos";
import { getRunSizesOrNull } from "$lib/api/run-sizes";
import type { CommandAllowlistEntry, RadicleRepoInfo } from "$lib/api/types";
import { localRepoName, shortenRid } from "$lib/utils/forge";

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:repo");
  // Not awaited: what the default branch describes is read off the forge, which fetches the
  // repository from upstream, and the Environment card streams it in rather than the page
  // waiting on it.
  const environmentDefinition = streamEnvironmentDefinition(fetch, { kind: "repo", id: params.id });
  // Streamed for the same reason, and in the browser only as that is: the checks file is read
  // off the forge too. Null is "still being read"; an empty list, that the repo has no entry.
  const checks = streamRepoChecks(fetch, params.id);
  const services = streamRepoServices(fetch, params.id);
  services.catch(() => {});
  // The panel reads its failure; this only keeps one from going unhandled when the page fails
  // to load first and nothing is left to read it.
  checks.catch(() => {});
  const [repo, sizes, environment] = await Promise.all([
    getConnectedRepo(fetch, params.id),
    getRunSizesOrNull(fetch),
    // Never fatal: a control plane that cannot answer this one route costs the page its card.
    getEnvironmentOrError(fetch, { kind: "repo", id: params.id }),
  ]);
  if (!repo) error(404, "no such connected repository");

  // Only a Radicle repo has a node to ask and a /ryph allowlist; GitHub, GitLab and local repos
  // have neither.
  if (repo.provider !== "radicle") {
    // A GitHub repo with no installation was connected in user mode, and the Connection section
    // names the person Ryph acts as. A forge that does not answer costs it the name only.
    // A GitLab repo's page names the account Ryph acts as there, and offers the webhook (bot
    // mode only: user mode takes none).
    const forges = (repo.provider === "github" && repo.installationId === null) ||
        repo.provider === "gitlab"
      ? await getForges(fetch).catch(() => null)
      : null;
    return {
      githubLogin: repo.provider === "github" ? githubUserLogin(forges) : null,
      gitlab: repo.provider === "gitlab" ? (forges?.gitlab ?? null) : null,
      radicleMine: false,
      repo,
      sizes,
      environment,
      environmentDefinition,
      services,
      checks,
      radicle: null,
      radicleError: null,
      allowlist: null,
      breadcrumb: repo.provider === "local" ? localRepoName(repo.repoRef) : repo.repoRef,
    };
  }

  // Both are read from ryph's node, which is a service that can be down, and from an admin-gated
  // route this user may not pass. Neither is a reason to fail the page: the parts that could be
  // read are shown, and the parts that could not say why.
  // The forge also says whether the node is the viewer's own (user mode), which the page words
  // itself for; one that does not answer leaves the deployment's wording.
  const [radicle, allowlist, forges] = await Promise.all([
    getRepoRadicleInfo(fetch, repo.id).catch((e: unknown): { error: string } => ({
      error: e instanceof Error ? e.message : "the Radicle node did not answer",
    })),
    // 403 is "not an administrator of this repository", which is an answer, not a failure.
    getCommandAllowlist(fetch, repo.id).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) return null;
      throw e;
    }),
    getForges(fetch).catch(() => null),
  ]);

  const info: RadicleRepoInfo | null = "error" in radicle ? null : radicle;
  const entries: CommandAllowlistEntry[] | null = allowlist;
  return {
    githubLogin: null,
    gitlab: null,
    radicleMine: radicleUserMode(forges),
    repo,
    sizes,
    environment,
    environmentDefinition,
    services,
    checks,
    radicle: info,
    radicleError: info === null && "error" in radicle ? radicle.error : null,
    allowlist: entries,
    // Its name when the node could say it; the RID is the only other thing that names it.
    breadcrumb: info?.name ?? shortenRid(repo.repoRef),
  };
};
