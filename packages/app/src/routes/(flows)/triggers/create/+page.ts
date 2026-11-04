import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getChatrooms } from "$lib/api/chatrooms";
import { getConnectedRepos } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ parent, url, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname)}`);

  const [agents, repos, workspaces, chatrooms] = await Promise.all([
    getAgents(fetch),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
    // A deployment without the chat service has no rooms to bind, and the form must still
    // open: a response without a room is one the run page alone talks to.
    getChatrooms(fetch).catch(() => []),
  ]);
  return {
    // The fields offer only the live ones; a new automation can name nothing else.
    agents: agents.filter((a) => a.archivedAt === null),
    repos: repos.filter((r) => r.archivedAt === null),
    workspaces: workspaces.filter((w) => w.workspace.archivedAt === null && w.repos.length > 0),
    chatrooms: chatrooms.filter((room) => room.archivedAt === null),
  };
};
