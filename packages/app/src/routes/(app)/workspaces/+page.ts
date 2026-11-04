import type { PageLoad } from "./$types";
import { getConnectedRepos } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ fetch, depends }) => {
  depends("app:workspaces");
  const [workspaces, repos] = await Promise.all([getWorkspaces(fetch), getConnectedRepos(fetch)]);
  // Archived workspaces are history — a task that named one still resolves it, but nothing new
  // targets it, so the page shows the live ones only. Their environments are the settings
  // page's to read: the grid only names what is in each.
  return { workspaces: workspaces.filter((w) => w.workspace.archivedAt === null), repos };
};
