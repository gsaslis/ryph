import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getAutomation } from "$lib/api/automations";
import { getChatrooms } from "$lib/api/chatrooms";
import { getConnectedRepos } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ parent, url, params, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname)}`);

  const [automation, agents, repos, workspaces, chatrooms] = await Promise.all([
    getAutomation(fetch, params.id),
    getAgents(fetch),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
    getChatrooms(fetch).catch(() => []),
  ]);
  return {
    automation,
    // Archived agents and repositories stay in: the fields offer only the live ones, but name
    // an archived one the automation still points at, so the operator sees why fires fail.
    agents,
    repos,
    workspaces: workspaces.filter((w) => w.workspace.archivedAt === null && w.repos.length > 0),
    chatrooms,
  };
};
