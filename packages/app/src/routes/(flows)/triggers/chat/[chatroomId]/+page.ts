import { can } from "$lib/utils/auth/capabilities";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { getAgents } from "$lib/api/agents";
import { getChatroom, getChatroomChannels, getChatroomGroups } from "$lib/api/chatrooms";
import { getCommandRoom } from "$lib/api/command-rooms";
import { getConnectedRepos } from "$lib/api/repos";
import { getWorkspaces } from "$lib/api/workspaces";

export const load: PageLoad = async ({ parent, url, params, fetch }) => {
  const { user } = await parent();
  if (!user) redirect(302, `/login?backTo=${encodeURIComponent(url.pathname)}`);
  // Every verb on a command room takes chat:manage: it decides who on a chat server may spend
  // the owner's budget and steer an agent holding a checkout.
  if (!can(user, "chat:manage")) redirect(302, "/triggers");

  const [chatroom, commandRoom, agents, repos, workspaces, channels, groups] = await Promise.all([
    getChatroom(fetch, params.chatroomId),
    getCommandRoom(fetch, params.chatroomId),
    getAgents(fetch),
    getConnectedRepos(fetch),
    getWorkspaces(fetch),
    // Both are asked of the platform live. A platform that does not answer costs the form its
    // pickers (null), not the saved policy: what is saved still shows, and still saves.
    getChatroomChannels(fetch, params.chatroomId).catch(() => null),
    getChatroomGroups(fetch, params.chatroomId).catch(() => null),
  ]);
  return {
    chatroom,
    commandRoom,
    agents: agents.filter((a) => !a.archivedAt),
    repos: repos.filter((r) => !r.archivedAt),
    workspaces: workspaces.filter((w) => w.workspace.archivedAt === null && w.repos.length > 0),
    channels: channels?.channels ?? null,
    // A workspace can hold more channels than one read reaches; the form says so rather than
    // letting a missing channel read as one that does not exist.
    channelsTruncated: channels?.truncated ?? false,
    groups,
  };
};
