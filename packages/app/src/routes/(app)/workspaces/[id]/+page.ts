import type { PageLoad } from "./$types";
import { getEnvironmentOrError, streamEnvironmentDefinition } from "$lib/api/environments";
import { getConnectedRepos } from "$lib/api/repos";
import { getRunSizesOrNull } from "$lib/api/run-sizes";
import { getWorkspace, getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ fetch, params, depends }) => {
  depends("app:workspace");
  const subject = { kind: "workspace", id: params.id } as const;
  // Not awaited: what the environment repository describes is read off the forge, which fetches
  // it from upstream, and the Environment section streams it in rather than the page waiting.
  const environmentDefinition = streamEnvironmentDefinition(fetch, subject);
  const [workspace, all, repos, sizes, environment] = await Promise.all([
    getWorkspace(fetch, params.id),
    // Only for which repositories are already taken: a repo belongs to one workspace at a time,
    // so the add dialog offers the ones no live workspace holds.
    getWorkspaces(fetch),
    getConnectedRepos(fetch),
    getRunSizesOrNull(fetch),
    // Never fatal: a control plane that cannot answer this one route costs the page a section.
    getEnvironmentOrError(fetch, subject),
  ]);
  const held = all
    .filter((w) => w.workspace.archivedAt === null)
    .flatMap((w) => w.repos.map((r) => r.connectedRepoId));
  return {
    workspace,
    repos,
    held,
    sizes,
    environment,
    environmentDefinition,
    breadcrumb: workspace.workspace.name,
  };
};
