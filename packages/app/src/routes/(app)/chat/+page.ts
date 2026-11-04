import { redirect } from "@sveltejs/kit";
import { can } from "$lib/utils/auth/capabilities";
import type { PageLoad } from "./$types";
import { getChatrooms } from "$lib/api/chatrooms";

export const load: PageLoad = async ({ fetch, depends, parent }) => {
  // Listing chatrooms takes `chat:read`; the nav hides the page from everyone else, and a typed
  // URL is sent home rather than shown a 403.
  const { user } = await parent();
  if (!can(user, "chat:read")) redirect(302, "/agents");
  depends("app:chatrooms");
  const chatrooms = await getChatrooms(fetch);
  // An archived room is history — a response that named it still resolves it, but nothing new
  // binds to it — so the page shows the live ones only.
  return { chatrooms: chatrooms.filter((room) => room.archivedAt === null) };
};
