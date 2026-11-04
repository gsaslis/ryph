import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getAutomations } from "$lib/api/automations";
import { getChatrooms } from "$lib/api/chatrooms";
import { getCommandRoom } from "$lib/api/command-rooms";
import type { Chatroom, CommandRoom } from "$lib/api/types";

export const load: PageLoad = async ({ fetch, depends, parent }) => {
  // Listing automations takes `automations:manage`; the nav hides the page from everyone else,
  // and a typed URL is sent home rather than shown a 403.
  const { user } = await parent();
  if (!can(user, "automations:manage")) redirect(302, "/agents");
  depends("app:automations");
  const [automations, chatrooms] = await Promise.all([
    getAutomations(fetch),
    // The chat service is its own process, and a deployment may run without one: then there are
    // simply no chat commands to list, and none to offer.
    getChatrooms(fetch).catch((): Chatroom[] => []),
  ]);
  const live = chatrooms.filter((room) => room.archivedAt === null);
  // A chat command is a chatroom's command-room policy; there is no list of them, so each live
  // room is asked. Rooms are a handful. One that will not answer is left out, not fatal.
  const commands = await Promise.all(
    live.map(async (room) => ({
      room,
      command: await getCommandRoom(fetch, room.id).catch((): CommandRoom | null => null),
    })),
  );
  return {
    automations,
    chatCommands: commands.flatMap(({ room, command }) => (command ? [{ room, command }] : [])),
    // Where a new chat command can go: a linked room that has none yet.
    chatroomsWithoutCommand: commands.flatMap(({ room, command }) =>
      command === null && room.linked ? [room] : []
    ),
    anyChatroom: live.length > 0,
  };
};
