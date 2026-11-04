import { z } from "zod";
import { apiCall } from "./call";
import {
  type ChatChannel,
  chatChannelSchema,
  type ChatGroup,
  chatGroupSchema,
  type Chatroom,
  chatroomSchema,
} from "./types";

/**
 * The platform secrets cross this surface exactly once, inward, at creation — a Telegram bot
 * token, a Zulip bot's API key, Slack's bot and app-level token pair, or a Discord bot token. They
 * are sealed by the chat service and never read back: the public chatroom carries the bot's
 * username (and, for Zulip, the organization and bot email) instead. A Zulip room is an admin's to
 * create — the server then dials the URL it names — while Telegram, Slack and Discord are reached
 * at one fixed address and stay any verified user's.
 */
export type CreateChatroomInput =
  & { quiet?: boolean }
  & (
    | { kind: "telegram"; name: string; botToken: string }
    | { kind: "zulip"; name: string; realmUrl: string; botEmail: string; apiKey: string }
    | { kind: "slack"; name: string; botToken: string; appToken: string }
    /** `guildId` is the Discord server's id: a snowflake, kept a string (it outgrows a JS number). */
    | { kind: "discord"; name: string; botToken: string; guildId: string }
  );

/** A room's own settings, each left as it stands when absent. `quiet` drops the bot's
 * bookkeeping posts (the "is on it" line in an existing conversation, the closing post of a run
 * that succeeded). */
export type UpdateChatroomInput = { name?: string; quiet?: boolean };

const oneSchema = z.object({ chatroom: chatroomSchema });

export async function getChatrooms(f = fetch): Promise<Chatroom[]> {
  const res = await apiCall(f, "/v1/chatrooms");
  return z.object({ chatrooms: z.array(chatroomSchema) }).parse(res).chatrooms;
}

export async function getChatroom(f = fetch, id: string): Promise<Chatroom> {
  return oneSchema.parse(await apiCall(f, `/v1/chatrooms/${encodeURIComponent(id)}`)).chatroom;
}

export async function createChatroom(f = fetch, input: CreateChatroomInput): Promise<Chatroom> {
  return oneSchema.parse(
    await apiCall(f, "/v1/chatrooms", { method: "POST", body: JSON.stringify(input) }),
  ).chatroom;
}

export async function updateChatroom(
  f = fetch,
  id: string,
  edit: UpdateChatroomInput,
): Promise<Chatroom> {
  return oneSchema.parse(
    await apiCall(f, `/v1/chatrooms/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(edit),
    }),
  ).chatroom;
}

export async function renameChatroom(f = fetch, id: string, name: string): Promise<Chatroom> {
  return await updateChatroom(f, id, { name });
}

export async function archiveChatroom(f = fetch, id: string): Promise<Chatroom> {
  return oneSchema.parse(
    await apiCall(f, `/v1/chatrooms/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  ).chatroom;
}

/** The room's channels as the platform lists them now, each with who may read it, and whether the
 * platform had more than this read reached — a workspace can hold more channels than one read
 * should pull. Asked live: a platform that does not answer is a 502 the caller decides what to do
 * with. */
export async function getChatroomChannels(
  f = fetch,
  id: string,
): Promise<{ channels: ChatChannel[]; truncated: boolean }> {
  const res = await apiCall(f, `/v1/chatrooms/${encodeURIComponent(id)}/channels`);
  return z.object({ channels: z.array(chatChannelSchema), truncated: z.boolean().default(false) })
    .parse(res);
}

/** The room's user groups (Zulip's, system groups excluded; Slack's usergroups; Discord's roles;
 * Telegram has none). Asked live. */
export async function getChatroomGroups(f = fetch, id: string): Promise<ChatGroup[]> {
  const res = await apiCall(f, `/v1/chatrooms/${encodeURIComponent(id)}/groups`);
  return z.object({ groups: z.array(chatGroupSchema) }).parse(res).groups;
}
