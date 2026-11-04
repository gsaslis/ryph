// The chat service, as a response policy's save touches it: which platform a named chatroom is
// on, and, for a room with channels, which of them it can open a response's conversation in. A
// response binds its run to one conversation. A Telegram room IS one, so naming the room is
// enough; a Zulip organization, a Slack workspace and a Discord server have none, so the policy
// also names a
// channel, and at open time the orchestrator has the chat service post the opening line there and
// binds the run to that post. That channel must be private:
// its members are the allowlist for steering the run and the audience for everything the agent
// posts there (patch and issue links, the run's summary), and only a private channel is a closed
// room — so the save refuses a public or web-public one, and the orchestrator's door separately
// refuses steering from a non-private channel, which covers a conversation that went public
// later. This service cannot see chatrooms itself; it asks, AS THE CALLER, so every answer is
// exactly what that user may read — including the chat service's "not yours" on the channel
// list, which names private channels.

/** A room's platform: `telegram` (one conversation — a response binds to it directly), or one
 * with channels (`zulip`, `slack`, `discord`), where the policy names a channel and each response
 * gets a conversation of its own in it. Null from `platformOf` means the chat service knows no such
 * room, or it is archived. */
export type ChatroomPlatform = "telegram" | "zulip" | "slack" | "discord";

/** Whether a room is a single conversation, so naming it is the whole policy. Every other
 * platform is channels, and a response needs one. */
export function isOneConversation(platform: ChatroomPlatform): boolean {
  return platform === "telegram";
}

/** One channel of a room, as the chat service lists it: the platform's id as a string (Zulip's
 * stream_id, Slack's `C…`, Discord's channel snowflake), which is what a policy's `channelId`
 * must equal, its name, and who can see it. */
export interface ChatroomChannel {
  id: string;
  name: string;
  visibility: "private" | "public" | "web-public";
}

/**
 * The channel list, or why there is none: `none` is the same "no such room" as a null platform;
 * `forbidden` is the chat service refusing the caller — it lets only the room's creator or an
 * admin read the list, because it names private channels the bot is in.
 */
export type ChatroomChannels =
  /** `truncated`: the chat service had more channels than it listed, so a channel missing from
   * `channels` may still exist — which is the difference between "no such channel" and "not in
   * the part of the workspace this read reached". */
  | { kind: "channels"; channels: ChatroomChannel[]; truncated: boolean }
  | { kind: "none" }
  | { kind: "forbidden" };

export interface ChatroomDirectory {
  /**
   * Looks the room up with the caller's own credential (`authorization`, the header as the
   * caller sent it; null under RYPH_AUTH=off). Throws when the chat service does not answer:
   * a save that cannot be checked is refused, never waved through.
   */
  platformOf(chatroomId: string, authorization: string | null): Promise<ChatroomPlatform | null>;
  /**
   * Lists the room's channels as the caller, with the same credential and the same rule about
   * not answering: a throw is the chat service (or, behind it, the platform) failing to answer.
   * Each channel's visibility is reported so the save can judge it: a response's channel must be
   * private, and the rule lives with the save (`chatroomRefusal`), not here.
   */
  channelsOf(chatroomId: string, authorization: string | null): Promise<ChatroomChannels>;
}
