// `ChatroomDirectory` over HTTP: the chat service's own management reads, GET /v1/chatrooms/:id
// and GET /v1/chatrooms/:id/channels, presented with the caller's bearer — the same routes the
// app reads the room list and the command-room form from, so no new credential exists for this.
// A room on a platform this version has not heard of is refused, not guessed at: whether a
// response needs a channel is a property of the platform's shape.
// 404 is "no such room"; 403 on the channel list is the chat service's creator-or-admin gate;
// anything else that is not a 200 is the chat service failing to answer, which the save turns
// into a refusal.

import type {
  ChatroomChannel,
  ChatroomChannels,
  ChatroomDirectory,
  ChatroomPlatform,
} from "../../ports/chatroom_directory.ts";

export interface HttpChatroomDirectoryOptions {
  /** The chat service's management origin (RYPH_CHAT_URL). */
  chatUrl: string;
  requestTimeoutMs?: number;
}

const VISIBILITIES = new Set(["private", "public", "web-public"]);

/** The platforms this version knows how to bind a response on; anything else is a chat service
 * newer than this one, and the save refuses rather than guessing at a room's shape. */
const PLATFORMS: ReadonlySet<ChatroomPlatform> = new Set<ChatroomPlatform>([
  "telegram",
  "zulip",
  "slack",
  "discord",
]);

function isChannel(item: unknown): item is ChatroomChannel {
  if (typeof item !== "object" || item === null) return false;
  const c = item as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.name === "string" &&
    typeof c.visibility === "string" && VISIBILITIES.has(c.visibility);
}

export function httpChatroomDirectory(opts: HttpChatroomDirectoryOptions): ChatroomDirectory {
  const base = opts.chatUrl.replace(/\/+$/, "");
  const timeoutMs = opts.requestTimeoutMs ?? 10_000;
  const read = (path: string, authorization: string | null) =>
    fetch(`${base}${path}`, {
      headers: authorization === null ? {} : { authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
  return {
    async platformOf(chatroomId, authorization) {
      const res = await read(`/v1/chatrooms/${encodeURIComponent(chatroomId)}`, authorization);
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`the chat service answered ${res.status}`);
      }
      const body = await res.json() as {
        chatroom?: { kind?: unknown; archivedAt?: unknown };
      };
      const room = body.chatroom;
      if (
        room === undefined || typeof room.kind !== "string" ||
        !PLATFORMS.has(room.kind as ChatroomPlatform)
      ) {
        throw new Error("the chat service answered a room this version cannot read");
      }
      return room.archivedAt === null ? room.kind as ChatroomPlatform : null;
    },

    async channelsOf(chatroomId, authorization): Promise<ChatroomChannels> {
      const res = await read(
        `/v1/chatrooms/${encodeURIComponent(chatroomId)}/channels`,
        authorization,
      );
      if (res.status === 404) {
        await res.body?.cancel();
        return { kind: "none" };
      }
      if (res.status === 403) {
        await res.body?.cancel();
        return { kind: "forbidden" };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`the chat service answered ${res.status}`);
      }
      const body = await res.json() as { channels?: unknown; truncated?: unknown };
      if (!Array.isArray(body.channels) || !body.channels.every(isChannel)) {
        throw new Error("the chat service answered a channel list this version cannot read");
      }
      return { kind: "channels", channels: body.channels, truncated: body.truncated === true };
    },
  };
}
