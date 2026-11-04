import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getLimitsOrNull } from "$lib/api/limits";
import { getModelAccess } from "$lib/api/provider-keys";
import { getProvidersOrEmpty } from "$lib/api/providers";
import { getConnectedRepos, getRepoRadicleInfo } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ fetch }) => {
  const [agents, repos, workspaces, limits, providers, providerKeys] = await Promise.all([
    getAgents(fetch),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
    getLimitsOrNull(fetch),
    getProvidersOrEmpty(fetch),
    // The agent's key, for the models its own account serves. Model access off leaves none,
    // as it leaves no provider list; any other failure fails the page, as the providers' does.
    getModelAccess(fetch).then((access) => access.providerKeys),
  ]);
  const connectedRepos = repos.filter((repo) => !repo.archivedAt);
  // A Radicle repo's name is read off ryph's node, one repo at a time, so it is streamed: the
  // cards draw at once with the RID and take the name as it comes. Null keeps the RID.
  const radicleNames: Record<string, Promise<string | null>> = Object.fromEntries(
    connectedRepos
      .filter((repo) => repo.provider === "radicle")
      .map((repo) => [
        repo.id,
        getRepoRadicleInfo(fetch, repo.id).then((info) => info.name, () => null),
      ]),
  );
  return {
    limits,
    providers,
    providerKeys,
    agents: agents.filter((agent) => !agent.archivedAt),
    connectedRepos,
    radicleNames,
    workspaces: workspaces.filter((w) => w.workspace.archivedAt === null && w.repos.length > 0),
    breadcrumb: "New task",
  };
};
