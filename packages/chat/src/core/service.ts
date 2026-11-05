// The chat service: every decision about rooms, bindings and how a mention reaches the control
// plane, in one place, over a store that only holds rows and transports that only move bytes.
// Four faces on one object:
//
// - the MANAGEMENT side (rooms: create, edit their settings, archive; list a room's channels and
//   groups), called by the app through the routes.
// - the CONTROL side (bindings: open, close; the commander check and the thread read), called
//   by the orchestrator's `ChatAccess` — over the internal surface standalone, in-process under
//   the binary.
// - the DATA side (`post`), called by the MCP tool a run holds through the gateway. A post may
//   carry images a tool returned in the run (`![alt](img-…)`): resolved at the control plane
//   BEFORE anything is sent, so an unknown ref fails the post whole. A platform that shows an
//   upload inside a message's words (Zulip) takes the images ahead of the text, and they ride in
//   it where the run wrote them; one that sends images between messages (Telegram) cuts the post
//   at them, the words after them riding as their caption; anywhere else they are sent after the
//   text. Either way one that does not make it costs only itself (core/agent_images.ts).
// - the POLLER (`pollOnce`), which turns a mention into a `ChatMention` at the control plane's
//   door and applies the verdict it answers.
//
// Invariants:
// - the platform secret is unsealed only to poll, read or post, and never returned, logged or
//   stored plain
// - this service DECIDES NOTHING about work: every mention of the bot, in every room, goes to the
//   door, and what the room hears back is the door's `reply`. The only things said here on the
//   service's own authority are the ones the door cannot say — "add me to this channel" (a
//   mention the bot cannot serve never reaches the door) and "couldn't take this" (the door
//   could not be asked).
// - one active binding per conversation: the store's unique index is the rule, this is its 409
// - a conversation is found by LOCATING a message in it, at the moment of asking — the mention
//   and each active binding's key — never by a remembered topic name, so a follow-up still
//   matches after a rename, a resolve or a move, and a post lands where the thread is now
// - "no response is running" is said at most once a minute per room; nothing else is limited
//   here (the door has its own rate limit)
// - nothing a message says widens anything: it becomes text at the door, and the control plane
//   frames it as untrusted

import {
  type ChatBinding,
  type ChatGroup,
  type ChatMention,
  type ChatMentionVerdict,
  type Chatroom,
  type ChatroomKind,
  type ChatThread,
  CLOSING_SUMMARY_CHARS,
  type CommanderVerdict,
  type ContinuedThreadFetch,
  isLinked,
  MAX_POST_TEXT,
  type PollCursor,
  type PublicChatroom,
  QUIET_OUTCOME,
  type RoomContext,
  type RunClosing,
  TELEGRAM_MAX_POST_CHARS,
  type ThreadFetch,
  toPublicChatroom,
} from "./types.ts";
import type { ChatStore } from "../ports/store.ts";
import { CredentialRefusedError } from "../ports/transport.ts";
import type {
  ChannelList,
  ChatCredential,
  ChatTransport,
  ConversationTarget,
  ImageDelivery,
  InboundMessage,
  InlineUpload,
  Located,
  OutboundImage,
  PlatformRoom,
  PollPosition,
} from "../ports/transport.ts";
import type { MentionDelivery, MentionSink } from "../ports/mention_sink.ts";
import type { ResolvedImage, RunImages } from "../ports/run_images.ts";
import {
  type ImageMention,
  MAX_POST_IMAGES,
  renderImageRefs,
  splitImageRefs,
} from "./agent_images.ts";
import { attachImages } from "./images.ts";

export interface ChatDiag {
  debug(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** What a room's sealed secret is bound to: the room, which of its two secrets, its platform,
 * and — for Zulip — the organization the secret is sent to, or — for Discord — the server the
 * room is. Changing any of them in the database makes the secret unopenable rather than sending
 * it somewhere else. */
export type TokenBinding = Readonly<Record<string, string | null>>;

export function tokenBinding(
  room: Pick<Chatroom, "id" | "kind" | "realmUrl" | "chatId">,
  field: "bot" | "app",
): TokenBinding {
  // Discord's server only: Telegram's `chatId` is learned AFTER the token is sealed, and every
  // room sealed before this line existed carries exactly the four fields.
  return {
    id: room.id,
    field,
    kind: room.kind,
    realmUrl: room.realmUrl,
    ...(room.kind === "discord" ? { guildId: room.chatId } : {}),
  };
}

/** Seals and unseals platform secrets — built by the composition root from the master key. */
export interface TokenSealer {
  seal(plaintext: string, binding: TokenBinding): Promise<string>;
  unseal(sealed: string, binding: TokenBinding): Promise<string>;
}

export interface ChatServiceDeps {
  store: ChatStore;
  /** One transport per platform; a room speaks through its kind's. */
  transports: Record<ChatroomKind, ChatTransport>;
  /** The control plane's mention door. */
  sink: MentionSink;
  /** The images a run's tools returned, at the control plane. Absent: a post naming one is
   * refused, and a closing line's are left as their labels. */
  images?: RunImages;
  sealer: TokenSealer;
  now(): Date;
  diag: ChatDiag;
  /** Mints ids; the composition root supplies @ryph/sealed's. */
  mintId(prefix: string): string;
  /** How long one long poll may hold, in seconds. Under every proxy's idle timeout. */
  pollTimeoutS?: number;
  /** The pause between retries of a door that could not decide; tests make it instant. Rejects
   * when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** A refusal about the caller's input — the routes' 400. */
export class ChatRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatRefusedError";
  }
}

/**
 * Which conversation a run binds to. `thread` names an existing one by its key — Telegram "",
 * Zulip the id of the mention that started the run, Slack `<channel>:<thread root>`, Discord
 * `<channel>:<thread>`. `new` opens one on a platform that has channels: the platform posts the
 * opening line where its transport says a conversation opens (a Zulip topic of that name; on
 * Slack the channel, whose reply thread under that post is the conversation; on Discord the
 * channel too, with a thread of that name started from the post) and the run is keyed by that
 * post, so everything downstream — locating, follow-up matching, the tool, the thread read, the
 * closing line — works exactly as for a mention-started run. A `new` conversation that already
 * holds an active binding (its key message located there now, topic compared without case) is
 * refused 409 before anything is posted, like a `thread` key already bound.
 *
 * `continue` is how an automation whose responses share ONE conversation reaches it: the run
 * binds to the key message the automation's last bound response had — the conversation it was
 * in, wherever it is now — as a `thread` binding on that same key, so the poller, the tool and
 * the closing line find it exactly as they found the last run. The key outlives every run that
 * used it: the first response's opening post keys them all. `previousRunIds` are the runs of the
 * automation's last few responses, newest first, and the newest of them with a binding in this
 * room is the one continued — a response whose open failed has none, and must not break the
 * chain for every response after it. Only a conversation that is still THERE is continued — its
 * key message located, and located in `channelId`, the channel the policy names now (a topic
 * renamed or resolved in place is still the conversation; one moved out of the channel, or a
 * policy moved to another channel, is not — the channel is the audience the policy was checked
 * against). Anything else falls back to `new` with `channelId` and `topic`: the run still gets a
 * conversation, and the next response continues that one. The previous run still bound there is
 * the 409 a bound key always was — one conversation holds one run; the control plane releases
 * the binding of a previous run that is over before it asks (`RunClosing.silent`).
 */
export type OpenBindingConversation =
  | { kind: "thread"; threadKey: string }
  | { kind: "new"; channelId: string; topic: string }
  | { kind: "continue"; previousRunIds: string[]; channelId: string; topic: string };

/**
 * The refusal every open answers for a conversation already holding a run: a 409 like the
 * archived room's, told apart from it by `reason` — machine-readable, so neither the internal
 * surface's caller nor the single-process host matches on the words.
 */
const conversationHeld409 = () => ({
  kind: "refused" as const,
  status: 409 as const,
  error: "that conversation already has a run bound",
  reason: "conversation_held" as const,
});

export type OpenBindingOutcome =
  | { kind: "opened"; binding: ChatBinding }
  /** The same run again: the binding it already has. */
  | { kind: "already"; binding: ChatBinding }
  /** 502: the platform refused the post that would have opened a `new` conversation; nothing
   * was bound. */
  | {
    kind: "refused";
    status: 400 | 404 | 409 | 502;
    error: string;
    /** Set on the 409 for a conversation that already holds a run — the one refusal a caller
     * acts on (a busy shared conversation is a fire to drop, not a chat service to warn about). */
    reason?: "conversation_held";
  };

export type PostOutcome =
  /** `images` is null for a post that named none. */
  | { kind: "posted"; parts: number; images: PostedImages | null }
  | { kind: "refused"; reason: string };

/** What became of a post's images once its text was out. */
export interface PostedImages {
  /** How many the platform carries as images. */
  uploaded: number;
  /** The labels of those that went as ryph links, because the platform would not take a file
   * from this bot. */
  linked: string[];
  /** Those that did not make it at all, and why. */
  failed: Array<{ ref: string; label: string; error: string }>;
}

/** A ref the text named, resolved: what the transport is handed. */
type NamedImage = ImageMention & ResolvedImage;

export interface PollStats {
  /** Updates the platform delivered, routable or not. */
  updates: number;
  /** Mentions the door answered with a verdict. */
  routed: number;
}

/** What a room's creation carries: the platform credential, and who owns the room. */
export type CreateChatroomRequest =
  & { name: string; ownerUserId: string; quiet?: boolean }
  & (
    | { kind: "telegram"; botToken: string }
    | { kind: "zulip"; realmUrl: string; botEmail: string; apiKey: string }
    | { kind: "slack"; botToken: string; appToken: string }
    | { kind: "discord"; botToken: string; guildId: string }
  );

/** The credential a creation request carries, as the transport takes it. */
function credentialFrom(input: CreateChatroomRequest): ChatCredential {
  switch (input.kind) {
    case "telegram":
      return { kind: "telegram", botToken: input.botToken };
    case "zulip":
      return {
        kind: "zulip",
        realmUrl: input.realmUrl,
        botEmail: input.botEmail,
        apiKey: input.apiKey,
      };
    case "slack":
      return { kind: "slack", botToken: input.botToken, appToken: input.appToken };
    case "discord":
      return { kind: "discord", botToken: input.botToken, guildId: input.guildId };
  }
}

/** The secrets a credential is sealed from: the one every platform has, and Slack's second. */
function secretsOf(credential: ChatCredential): { bot: string; app: string | null } {
  switch (credential.kind) {
    case "telegram":
      return { bot: credential.botToken, app: null };
    case "zulip":
      return { bot: credential.apiKey, app: null };
    case "slack":
      return { bot: credential.botToken, app: credential.appToken };
    case "discord":
      return { bot: credential.botToken, app: null };
  }
}

/** What a caller is told when the platform refuses the credential it pasted — the credential's
 * own parts, named, because that is what there is to fix. */
const CREDENTIAL_REFUSALS: Record<ChatroomKind, string> = {
  telegram: "the platform did not accept the bot token",
  zulip: "the Zulip server did not accept the bot's email and API key",
  slack: "Slack did not accept the bot token and the app-level token",
  discord: "Discord did not accept the bot token",
};

/** How often a room hears "no response is running" at most. */
const NO_BINDING_REPLY_GAP_MS = 60_000;

/** The platform's default long-poll hold. */
const DEFAULT_POLL_TIMEOUT_S = 25;

/** How long all of one mention's images may take to download, together. */
const IMAGES_DEADLINE_MS = 60_000;

/** A door that could not decide is asked again after each of these, then apologised for. */
const DOOR_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];

export const NOT_SUBSCRIBED_REPLY = "Add me to this channel to use me here.";
export const DOOR_DOWN_REPLY = "ryph couldn't take this right now — mention me again in a minute.";

export interface ChatService {
  createChatroom(input: CreateChatroomRequest): Promise<PublicChatroom>;
  getChatroom(id: string): Promise<PublicChatroom | null>;
  listChatrooms(): Promise<PublicChatroom[]>;
  /** Edits the room's own settings, each left as it stands when absent. */
  updateChatroom(
    id: string,
    edit: { name?: string; quiet?: boolean },
  ): Promise<PublicChatroom | null>;
  /** Idempotent. Closes the room's active bindings too: an archived room posts to nobody. */
  archiveChatroom(id: string): Promise<PublicChatroom | null>;
  /** The owner's id, for the routes' "owner or admin" rule. */
  ownerOf(id: string): Promise<string | null>;
  /** The channels a command room may name (contract §3). Null: no such room. Throws when the
   * platform does not answer. */
  listChannels(id: string): Promise<ChannelList | null>;
  /** The groups a commander policy may name. Null: no such room. Throws like `listChannels`. */
  listGroups(id: string): Promise<ChatGroup[] | null>;

  openBinding(req: {
    runId: string;
    chatroomId: string;
    agentName: string;
    taskTitle: string;
    runUrl: string | null;
    conversation: OpenBindingConversation;
    /** The fire that opened a response; set, the opening line shows it (`alertBlock`). */
    alert?: OpeningAlert;
  }): Promise<OpenBindingOutcome>;
  /** Idempotent: a run with no active binding is a 204's worth of nothing. */
  closeBinding(runId: string, closing: RunClosing): Promise<void>;
  /** Is this platform user in this group, asked live. Never throws. */
  checkCommander(
    req: { chatroomId: string; userId: string; groupId: string },
  ): Promise<CommanderVerdict>;
  /** The conversation, as evidence for the agent. Never throws. */
  fetchThread(req: { chatroomId: string; threadKey: string }): Promise<ThreadFetch>;
  /** The conversation a `continue` open with these `previousRunIds` and `channelId` would bind
   * to, as evidence for the run about to start there — read by the same rule
   * (`settleContinuation`), before the run exists. Never throws. */
  fetchContinuedThread(
    req: { chatroomId: string; previousRunIds: string[]; channelId: string },
  ): Promise<ContinuedThreadFetch>;
  /** The room as a bound run's agent is told about it. Null: no such room, or archived. */
  describeRoom(chatroomId: string): Promise<RoomContext | null>;

  /** The MCP tool: the run's words into its conversation, signed with the agent's name. */
  post(runId: string, text: string): Promise<PostOutcome>;

  /** One poll of one room and every mention it delivered, through the door. */
  pollOnce(chatroomId: string, signal: AbortSignal): Promise<PollStats>;
  /** The rooms the poller should be watching: every live one. */
  listPollable(): Promise<Chatroom[]>;
}

/** Two locations are one conversation: the same channel, and the same topic — which Zulip
 * compares without case. */
function sameConversation(a: Located, b: Located): boolean {
  if (a.channel.id !== b.channel.id) return false;
  if (a.topic === null || b.topic === null) return a.topic === b.topic;
  return a.topic.toLowerCase() === b.topic.toLowerCase();
}

function samePosition(a: PollPosition | null, b: PollPosition): boolean {
  return a !== null && a.offset === b.offset && a.queueId === b.queueId &&
    a.lastMessageId === b.lastMessageId;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function makeChatService(deps: ChatServiceDeps): ChatService {
  const { store, sink, sealer, diag } = deps;
  const nowIso = () => deps.now().toISOString();
  const pollTimeoutS = deps.pollTimeoutS ?? DEFAULT_POLL_TIMEOUT_S;
  const sleep = deps.sleep ?? defaultSleep;
  const lastNoBindingReply = new Map<string, number>();
  /** The rooms already logged for sending images as links — once per room, not per post. */
  const linkedRooms = new Set<string>();

  const transportOf = (room: { kind: ChatroomKind }): ChatTransport => deps.transports[room.kind];

  /** The room's credential, unsealed for one call. */
  const credentialOf = async (room: Chatroom): Promise<ChatCredential> => {
    const secret = await sealer.unseal(room.sealedBotToken, tokenBinding(room, "bot"));
    switch (room.kind) {
      case "telegram":
        return { kind: "telegram", botToken: secret };
      case "zulip":
        return {
          kind: "zulip",
          realmUrl: room.realmUrl ?? "",
          botEmail: room.botEmail ?? "",
          apiKey: secret,
        };
      case "slack": {
        // Both halves are sealed at creation, and the column is nullable only because the other
        // platforms have no second secret. A Slack row without one cannot be used for anything,
        // and saying so here beats sending Slack a credential this code invented.
        if (room.sealedAppToken === null) {
          throw new Error(`chatroom ${room.id}: a Slack room has no sealed app-level token`);
        }
        return {
          kind: "slack",
          botToken: secret,
          appToken: await sealer.unseal(room.sealedAppToken, tokenBinding(room, "app")),
        };
      }
      case "discord": {
        // Set at creation and never changed: a Discord room IS its server. Unreachable without
        // one, since the seal above is bound to it.
        if (room.chatId === null) {
          throw new Error(`chatroom ${room.id}: a Discord room names no server`);
        }
        return { kind: "discord", botToken: secret, guildId: room.chatId };
      }
    }
  };

  /** The room as its transport needs it: the secret unsealed, for this call only. */
  const platformOf = async (room: Chatroom): Promise<PlatformRoom> => {
    return {
      id: room.id,
      credential: await credentialOf(room),
      bot: { id: room.botId, name: room.botUsername },
      chatId: room.chatId,
      chatTitle: room.chatTitle,
    };
  };

  /** Sends into one conversation, split at the platform's ceiling: how many parts, and the id
   * of the FIRST — the message a conversation this post opens is keyed by. A post that OPENS one
   * (at the channel, `topic` null, on a platform with channels) sends the rest of its parts into
   * the conversation the first part opened, located from its key: an opening line cut in two
   * would otherwise leave its second half at the top of the channel, outside the thread it
   * opened — and on Discord, whose thread is started from the first part, try to start another.
   * Throws when the platform refuses. */
  const sendTo = async (
    room: Chatroom,
    platform: PlatformRoom,
    target: ConversationTarget,
    text: string,
    /** The attribution every part after the first must open with, when the text is an agent's:
     * a part is its own message in the room, and one without the name reads as nobody's. */
    continuation?: string,
    atomic: readonly string[] = [],
  ): Promise<{ parts: number; messageId: string }> => {
    const transport = transportOf(room);
    const ceiling = await transport.maxMessageLength(platform);
    const parts = splitPost(text, ceiling - (continuation?.length ?? 0), atomic).map((part, i) =>
      continuation === undefined || i === 0 || part.startsWith(continuation)
        ? part
        : continuation + part
    );
    let messageId: string | null = null;
    let at = target;
    const opens = target.topic === null && !transport.roomIsOneConversation;
    try {
      for (const part of parts) {
        const id = await transport.send(platform, at, part);
        if (messageId !== null) continue;
        messageId = id;
        if (parts.length > 1 && opens) {
          const opened = await transport.locate(platform, id);
          if (opened !== null) at = { channelId: opened.channel.id, topic: opened.topic };
        }
      }
    } catch (err) {
      // An opening line refused part-way binds nothing — so its first part, at the top of the
      // channel saying a run is on it, is taken back down, best-effort.
      if (opens && messageId !== null && transport.retract !== undefined) {
        await transport.retract(platform, messageId).catch((retractErr) =>
          diag.warn("chat.retract_failed", { chatroomId: room.id, err: String(retractErr) })
        );
      }
      throw err;
    }
    return { parts: parts.length, messageId: messageId ?? "" };
  };

  /** A line the PLATFORM posts into a conversation, best-effort: the room should hear it, the
   * caller must not fail on it. */
  const announce = async (
    room: Chatroom,
    platform: PlatformRoom,
    target: ConversationTarget,
    text: string,
    event: string,
  ): Promise<void> => {
    try {
      await sendTo(room, platform, target, text);
    } catch (err) {
      diag.warn(event, { chatroomId: room.id, err: String(err) });
    }
  };

  /** A line the platform posts into a BINDING's conversation, wherever it lives now. Answers
   * where it went, or null when it went nowhere. */
  const announceIn = async (
    room: Chatroom,
    threadKey: string,
    /** The line, or what composes it once the platform is known (a line its images ride in). */
    text:
      | string
      | ((
        platform: PlatformRoom,
      ) => Promise<
        | string
        | { text: string; atomic: string[] }
        | { send: (target: ConversationTarget) => Promise<void> }
      >),
    event: string,
  ): Promise<{ platform: PlatformRoom; target: ConversationTarget } | null> => {
    if (!isLinked(room)) {
      diag.warn("chat.room_unlinked", { chatroomId: room.id });
      return null;
    }
    try {
      const platform = await platformOf(room);
      const where = await transportOf(room).locate(platform, threadKey);
      if (where === null) {
        diag.warn(event, { chatroomId: room.id, threadKey, err: "the conversation is gone" });
        return null;
      }
      const target = { channelId: where.channel.id, topic: where.topic };
      const prepared = typeof text === "string" ? text : await text(platform);
      if (typeof prepared !== "string" && "send" in prepared) {
        await prepared.send(target);
        return { platform, target };
      }
      await sendTo(
        room,
        platform,
        target,
        typeof prepared === "string" ? prepared : prepared.text,
        undefined,
        typeof prepared === "string" ? [] : prepared.atomic,
      );
      return { platform, target };
    } catch (err) {
      diag.warn(event, { chatroomId: room.id, threadKey, err: String(err) });
      return null;
    }
  };

  /**
   * What each ref names in the run, all or nothing: `unknown` lists every ref the run has no
   * image under. Throws when the control plane could not answer, or there is none to ask.
   */
  const resolveImages = async (
    runId: string,
    named: ImageMention[],
  ): Promise<{ kind: "resolved"; images: NamedImage[] } | { kind: "unknown"; refs: string[] }> => {
    if (deps.images === undefined) throw new Error("this chat service cannot reach run images");
    const resolution = await deps.images.resolve(runId, named.map((image) => image.ref));
    const byRef = new Map(resolution.images.map((image) => [image.ref, image]));
    const unknown = named.filter((image) => !byRef.has(image.ref)).map((image) => image.ref);
    if (unknown.length > 0) return { kind: "unknown", refs: unknown };
    return {
      kind: "resolved",
      images: named.map((image) => ({ ...image, ...byRef.get(image.ref)! })),
    };
  };

  /** One resolved image as a transport takes it: captioned, its bytes fetched on demand. */
  const outboundOf = (
    runImages: RunImages,
    runId: string,
    agentName: string,
    image: NamedImage,
  ): OutboundImage => ({
    label: signLabel(agentName, image.label),
    mime: image.mime,
    url: image.url,
    load: () => runImages.fetch(runId, image.attachmentId),
  });

  const warnFailed = (room: Chatroom, runId: string, report: PostedImages): void => {
    if (report.failed.length > 0) {
      diag.warn("chat.images_failed", {
        chatroomId: room.id,
        runId,
        failed: report.failed.map((f) => `${f.ref}: ${f.error}`),
      });
    }
  };

  /**
   * The images uploaded AHEAD of the text, for a platform that shows them inside its words
   * (`ChatTransport.uploadImages`): the markup each went up as, by ref, and the report. Null
   * for a platform that cannot, whose images follow the text (`deliverImages`). Never throws.
   */
  const uploadAhead = async (
    room: Chatroom,
    platform: PlatformRoom,
    runId: string,
    agentName: string,
    images: NamedImage[],
  ): Promise<{ markups: Map<string, string>; report: PostedImages } | null> => {
    const transport = transportOf(room);
    const runImages = deps.images;
    if (transport.uploadImages === undefined || runImages === undefined) return null;
    let uploads: InlineUpload[];
    try {
      uploads = await transport.uploadImages(
        platform,
        images.map((image) => outboundOf(runImages, runId, agentName, image)),
      );
    } catch (err) {
      uploads = images.map(() => ({ kind: "failed", error: String(err) }));
    }
    const markups = new Map<string, string>();
    const report: PostedImages = { uploaded: 0, linked: [], failed: [] };
    images.forEach((image, i) => {
      const upload = uploads[i] ??
        { kind: "failed", error: "the platform adapter said nothing about it" };
      if (upload.kind === "inline") {
        markups.set(image.ref, upload.markup);
        report.uploaded += 1;
      } else {
        report.failed.push({ ref: image.ref, label: image.label, error: upload.error });
      }
    });
    warnFailed(room, runId, report);
    return { markups, report };
  };

  /** The images after the text, into the same conversation. Never throws: what did not make it
   * is in the answer. */
  const deliverImages = async (
    room: Chatroom,
    platform: PlatformRoom,
    target: ConversationTarget,
    runId: string,
    agentName: string,
    images: NamedImage[],
    /** The words that ride as the images' caption (a platform with a `captionLimit`). */
    caption: string | null = null,
  ): Promise<PostedImages> => {
    const runImages = deps.images;
    let deliveries: ImageDelivery[];
    try {
      if (runImages === undefined) throw new Error("this chat service cannot reach run images");
      const outbound = images.map((image) => outboundOf(runImages, runId, agentName, image));
      deliveries = caption === null
        ? await transportOf(room).sendImages(platform, target, outbound)
        : await transportOf(room).sendImages(platform, target, outbound, caption);
    } catch (err) {
      deliveries = images.map(() => ({ kind: "failed", error: String(err) }));
    }
    const report: PostedImages = { uploaded: 0, linked: [], failed: [] };
    images.forEach((image, i) => {
      const delivery = deliveries[i] ??
        { kind: "failed", error: "the platform adapter said nothing about it" };
      if (delivery.kind === "uploaded") report.uploaded += 1;
      else if (delivery.kind === "linked") {
        report.linked.push(image.label);
        // Said once per room: it is the room's setup (Slack without `files:write`), and every
        // post would otherwise repeat it.
        if (!linkedRooms.has(room.id)) {
          linkedRooms.add(room.id);
          diag.warn("chat.images_linked", { chatroomId: room.id, reason: delivery.reason });
        }
      } else {
        report.failed.push({ ref: image.ref, label: image.label, error: delivery.error });
      }
    });
    warnFailed(room, runId, report);
    return report;
  };

  /**
   * A text holding image slots (`withImageSlots`), sent the way a platform with a
   * `captionLimit` shows a post's images (Telegram): cut at each run of images, the words before
   * them as messages, then the images, with the words after them as their caption when they fit
   * — else as messages of their own. Every message after the first opens with `continuation`,
   * when there is one. An image whose slot was lost (a capped summary) goes last. Throws only
   * when the platform refuses the words; what the images came to is the answer.
   */
  const sendInPlace = async (
    room: Chatroom,
    platform: PlatformRoom,
    target: ConversationTarget,
    said: string,
    slots: readonly string[],
    images: NamedImage[],
    runId: string,
    agentName: string,
    continuation?: string,
  ): Promise<{ parts: number; report: PostedImages }> => {
    const byRef = new Map(images.map((image) => [image.ref, image]));
    const segments = segmentAtSlots(said, slots);
    const placed = new Set(segments.flatMap((seg) => seg.kind === "images" ? seg.refs : []));
    const unplaced = images.filter((image) => !placed.has(image.ref)).map((image) => image.ref);
    if (unplaced.length > 0) segments.push({ kind: "images", refs: unplaced });
    const limit = transportOf(room).captionLimit ?? 0;
    const report: PostedImages = { uploaded: 0, linked: [], failed: [] };
    let parts = 0;
    let sentAny = false;
    const signed = (text: string) =>
      !sentAny || continuation === undefined || text.startsWith(continuation)
        ? text
        : continuation + text;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.kind === "text") {
        // The attribution alone, before a post that opens with images, is no message.
        if (continuation !== undefined && seg.text.trim() === continuation.trim()) continue;
        parts += (await sendTo(room, platform, target, signed(seg.text), continuation)).parts;
        sentAny = true;
        continue;
      }
      const group = seg.refs.map((ref) => byRef.get(ref)).filter((image) => image !== undefined);
      if (group.length === 0) continue;
      const next = segments[i + 1];
      // The images are a message too, so the words under them are a later one and signed so.
      sentAny = true;
      const caption = next?.kind === "text" && signed(next.text).length <= limit
        ? signed(next.text)
        : null;
      const got = await deliverImages(room, platform, target, runId, agentName, group, caption);
      report.uploaded += got.uploaded;
      report.linked.push(...got.linked);
      report.failed.push(...got.failed);
      if (caption !== null) {
        i++;
        if (got.uploaded + got.linked.length === 0) {
          // Nothing carried the words: they go on their own, as they would have without images.
          parts += (await sendTo(room, platform, target, caption, continuation)).parts;
        } else parts += 1;
      }
    }
    return { parts, report };
  };

  const liveRoom = async (id: string): Promise<Chatroom | null> => {
    const room = await store.getChatroom(id);
    return room === null || room.archivedAt !== null ? null : room;
  };

  /** Whether this call closed it: false when another close got there first. */
  const closeActive = async (binding: ChatBinding): Promise<boolean> =>
    await store.closeBinding(binding.id, nowIso());

  /**
   * Whether a conversation already holds a run: one of the room's active bindings has its key
   * message located there now. The store's unique index cannot say it — two key messages in one
   * conversation are two distinct keys, and both rows would land — and every follow-up would
   * then steer the OLDER run (the poller takes the first). Throws when the platform cannot say.
   */
  const conversationHeld = async (
    room: Chatroom,
    platform: PlatformRoom,
    target: Located,
  ): Promise<boolean> => {
    const transport = transportOf(room);
    for (const active of await store.listActiveBindings(room.id)) {
      const there = await transport.locate(platform, active.threadKey);
      if (there !== null && sameConversation(target, there)) return true;
    }
    return false;
  };

  /**
   * The binding a `continue` would follow: the newest of `previousRunIds` (newest first) bound in
   * this room. One never bound (its open failed), or bound in a room the policy no longer names,
   * is passed over; null is none at all — a new conversation.
   */
  const previousBinding = async (
    room: Chatroom,
    previousRunIds: readonly string[],
  ): Promise<ChatBinding | null> => {
    for (const previousRunId of previousRunIds) {
      const bound = await store.getBindingByRun(previousRunId);
      if (bound !== null && bound.chatroomId === room.id) return bound;
    }
    return null;
  };

  /**
   * Where `previous`'s conversation is now, when it is still one a `continue` follows: its key
   * message located, in `channelId` — the channel the policy names now. Null when it is gone or
   * elsewhere. Throws when the platform cannot say. The one rule both the binding
   * (`settleContinuation`) and the run's read of the conversation (`fetchContinuedThread`) ask, so
   * a run is not shown a conversation other than the one it would bind to. The read comes first,
   * though, and the bind may still be refused (the previous run still holds it — the run's page
   * then says it was not bound, `chat.unbound`) or find the conversation gone since and open a
   * new one.
   */
  const locateContinuable = async (
    room: Chatroom,
    platform: PlatformRoom,
    previous: ChatBinding,
    channelId: string,
  ): Promise<Located | null> => {
    const there = await transportOf(room).locate(platform, previous.threadKey);
    return there === null || there.channel.id !== channelId ? null : there;
  };

  /**
   * A `continue` settled into what it binds (`OpenBindingConversation`): the previous run's key
   * as a `thread` when its conversation is still there, in the policy's channel and free, or a
   * `new` one otherwise. A previous run still bound is the 409 of a held conversation, and a
   * platform that cannot say where the key is now the 502 a `new` open's check answers — the
   * fallback is for a conversation that is GONE, never for one that could not be asked about,
   * which would open a second conversation beside a perfectly good one.
   */
  const settleContinuation = async (
    room: Chatroom,
    runId: string,
    asked: Extract<OpenBindingConversation, { kind: "continue" }>,
  ): Promise<
    | { kind: "settled"; conversation: Exclude<OpenBindingConversation, { kind: "continue" }> }
    | Extract<OpenBindingOutcome, { kind: "refused" }>
  > => {
    const fresh = {
      kind: "settled" as const,
      conversation: { kind: "new" as const, channelId: asked.channelId, topic: asked.topic },
    };
    const previous = await previousBinding(room, asked.previousRunIds);
    if (previous === null) return fresh;
    if (previous.state === "active") {
      return conversationHeld409();
    }
    try {
      const platform = await platformOf(room);
      const there = await locateContinuable(room, platform, previous, asked.channelId);
      if (there === null) {
        diag.debug("chat.continuation_gone", {
          chatroomId: room.id,
          runId,
          previousRunId: previous.runId,
        });
        return fresh;
      }
      if (await conversationHeld(room, platform, there)) {
        return conversationHeld409();
      }
    } catch (err) {
      diag.warn("chat.continuation_check_failed", {
        chatroomId: room.id,
        runId,
        previousRunId: previous.runId,
        err: String(err),
      });
      return {
        kind: "refused",
        status: 502,
        error: `the chat platform could not say where the conversation is: ${String(err)}`,
      };
    }
    return {
      kind: "settled",
      conversation: { kind: "thread", threadKey: previous.threadKey },
    };
  };

  /** The live Discord room a bot already serves, if any. */
  const discordTwin = async (botId: string): Promise<Chatroom | undefined> =>
    (await store.listChatrooms()).find((r) =>
      r.kind === "discord" && r.archivedAt === null && r.botId === botId
    );

  /** The refusal of a second live room on one Discord bot, naming the first when known. */
  const botTaken = (twinName: string | null): ChatRefusedError =>
    new ChatRefusedError(
      `This bot already serves ${twinName === null ? "another room" : `the room ${twinName}`}. ` +
        "Create a separate bot application for each server.",
    );

  /** The door, asked until it decides or the retries run out. */
  const deliver = async (mention: ChatMention, signal: AbortSignal): Promise<MentionDelivery> => {
    let delivery = await sink.deliver(mention);
    for (const pause of DOOR_RETRY_BACKOFF_MS) {
      if (delivery.kind !== "failed") break;
      diag.debug("chat.door_retry", { messageId: mention.messageId, err: delivery.error });
      await sleep(pause, signal);
      delivery = await sink.deliver(mention);
    }
    return delivery;
  };

  return {
    async createChatroom(input) {
      const credential = credentialFrom(input);
      let me: { id: string; name: string; title: string | null };
      try {
        me = await transportOf(input).whoAmI(credential);
      } catch (err) {
        diag.debug("chat.whoami_failed", { kind: input.kind, err: String(err) });
        // The adapter's own words when it took the credential and named the fix; the platform's
        // generic refusal otherwise, which says nothing a refused secret's error might.
        throw new ChatRefusedError(
          err instanceof CredentialRefusedError ? err.message : CREDENTIAL_REFUSALS[input.kind],
        );
      }
      if (input.kind === "discord") {
        // One bot, one room: a Gateway connection carries every server the bot is in, and the
        // day's identify budget is the TOKEN's — two rooms on one bot would each hear the
        // other's traffic and spend a budget each believes is its own. Asked first, to name the
        // twin before anything is sealed; two creations racing past this are decided by the
        // store's unique index below.
        const twin = await discordTwin(me.id);
        if (twin !== undefined) throw botTaken(twin.name);
      }
      const secrets = secretsOf(credential);
      const at = nowIso();
      const target = {
        id: deps.mintId("chr"),
        kind: input.kind,
        realmUrl: credential.kind === "zulip" ? credential.realmUrl : null,
        // Discord's server, which the token's seal is bound to. Telegram's group is learned later.
        chatId: credential.kind === "discord" ? credential.guildId : null,
      };
      const room: Chatroom = {
        id: target.id,
        name: input.name,
        kind: input.kind,
        botUsername: me.name,
        botId: me.id,
        sealedBotToken: await sealer.seal(secrets.bot, tokenBinding(target, "bot")),
        sealedAppToken: secrets.app === null
          ? null
          : await sealer.seal(secrets.app, tokenBinding(target, "app")),
        realmUrl: target.realmUrl,
        botEmail: credential.kind === "zulip" ? credential.botEmail : null,
        chatId: target.chatId,
        chatTitle: me.title,
        // Telegram's one-time code the linking mention must quote. Minted here because this is
        // the only moment an operator is present: it is shown on the management surface, they
        // put it in the group, and it dies the moment the room links. A Zulip bot belongs to one
        // organization, a Slack app to one workspace, and a Discord room names its server, so
        // there is nothing to link.
        linkCode: input.kind === "telegram" ? deps.mintId("link") : null,
        quiet: input.quiet ?? false,
        ownerUserId: input.ownerUserId,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      };
      if (!await store.createChatroom(room)) {
        // Lost the race to a creation on the same bot: named when it can still be read.
        throw botTaken((await discordTwin(me.id).catch(() => undefined))?.name ?? null);
      }
      diag.debug("chat.room_created", { chatroomId: room.id, kind: room.kind, bot: me.name });
      return toPublicChatroom(room);
    },

    async getChatroom(id) {
      const room = await store.getChatroom(id);
      return room === null ? null : toPublicChatroom(room);
    },

    async listChatrooms() {
      return (await store.listChatrooms()).map(toPublicChatroom);
    },

    async updateChatroom(id, edit) {
      const room = await store.getChatroom(id);
      if (room === null) return null;
      // Read when a run binds: a switch takes effect for the next run, while a run already going
      // keeps the setting it bound under (`ChatBinding.quiet`) — its prompt was told then.
      const edited = {
        ...room,
        name: edit.name ?? room.name,
        quiet: edit.quiet ?? room.quiet,
        updatedAt: nowIso(),
      };
      await store.saveChatroom(edited);
      return toPublicChatroom(edited);
    },

    async archiveChatroom(id) {
      const room = await store.getChatroom(id);
      if (room === null) return null;
      if (room.archivedAt !== null) return toPublicChatroom(room);
      const at = nowIso();
      const archived = { ...room, archivedAt: at, updatedAt: at };
      await store.saveChatroom(archived);
      for (const active of await store.listActiveBindings(id)) await closeActive(active);
      return toPublicChatroom(archived);
    },

    async ownerOf(id) {
      return (await store.getChatroom(id))?.ownerUserId ?? null;
    },

    async listChannels(id) {
      const room = await store.getChatroom(id);
      if (room === null) return null;
      return await transportOf(room).listChannels(await platformOf(room));
    },

    async listGroups(id) {
      const room = await store.getChatroom(id);
      if (room === null) return null;
      return await transportOf(room).listGroups(await platformOf(room));
    },

    async openBinding(req) {
      const room = await store.getChatroom(req.chatroomId);
      if (room === null) return { kind: "refused", status: 404, error: "no such chatroom" };
      if (room.archivedAt !== null) {
        return { kind: "refused", status: 409, error: "the chatroom is archived" };
      }
      const transport = transportOf(room);
      // What a binding may name is a property of the PLATFORM, and the transport is what knows
      // it. A room that IS one conversation (a Telegram group) has the key "" and nothing to
      // open, so a message key or a conversation to open there is the caller's mistake (400). A
      // room of channels has no room-wide conversation — a binding keyed "" would post somewhere
      // arbitrary — and that is a refusal about the room (409): the caller opens a conversation
      // instead, and the platform's own opening line becomes its key message.
      const asked = req.conversation;
      if (transport.roomIsOneConversation) {
        if (asked.kind !== "thread" || asked.threadKey !== "") {
          return {
            kind: "refused",
            status: 400,
            error: 'this room has one conversation, keyed ""',
          };
        }
      } else if (asked.kind === "thread" && asked.threadKey === "") {
        return {
          kind: "refused",
          status: 409,
          error: "this room has no room-wide conversation — a run binds to the one the mention " +
            "that started it was in, or opens one of its own",
        };
      }
      const existing = await store.getBindingByRun(req.runId);
      if (existing !== null && existing.state === "active") {
        return { kind: "already", binding: existing };
      }
      // A conversation to continue is settled first: what is left is a key to bind (a `thread`)
      // or a conversation to open (`new`), and everything below treats it as either.
      let conversation: Exclude<OpenBindingConversation, { kind: "continue" }>;
      if (asked.kind === "continue") {
        const settled = await settleContinuation(room, req.runId, asked);
        if (settled.kind === "refused") return settled;
        conversation = settled.conversation;
      } else {
        conversation = asked;
      }
      const opening = openingLine(
        room.kind,
        { ...req, botHandle: room.botUsername },
        conversation.kind,
      );
      const line = req.alert === undefined
        ? opening
        : `${opening}\n\n${alertBlock(room.kind, req.alert)}`;
      let threadKey: string;
      if (conversation.kind === "new") {
        // Where this platform puts the opening line of a conversation it opens: a Zulip topic of
        // the name asked for, or, on Slack, the channel itself — whose reply thread under that
        // post becomes the conversation, so the topic is not an address there at all — or, on
        // Discord, the channel too, the topic naming the thread started from the post.
        const opened = transport.openTarget(conversation.channelId, conversation.topic);
        if (opened === null) {
          // Only a room that IS one conversation opens none, and that is the 400 above; this is
          // what says so to the type system.
          return { kind: "refused", status: 400, error: "this room opens no conversation" };
        }
        // One active binding per conversation holds for an OPENED one too, but the store's
        // unique index cannot say it here: two opening posts into one conversation are two
        // distinct key messages, and both rows would land. Every follow-up there would then
        // match the OLDER binding (the poller takes the first), and one run received all the
        // steering meant for both. So the room's active bindings are located first, as the
        // poller locates them, and a conversation that already holds one is refused BEFORE
        // anything is posted — the 409 the index gives a `thread` open. A platform that opens
        // into the channel rather than a named conversation never collides, and never matches.
        let platform: PlatformRoom;
        try {
          platform = await platformOf(room);
          const target: Located = {
            channel: { id: opened.channelId, name: "" },
            topic: opened.topic,
          };
          if (await conversationHeld(room, platform, target)) {
            return conversationHeld409();
          }
        } catch (err) {
          diag.warn("chat.opening_check_failed", {
            chatroomId: room.id,
            runId: req.runId,
            channelId: conversation.channelId,
            err: String(err),
          });
          return {
            kind: "refused",
            status: 502,
            error: `the chat platform could not say whether the conversation is free: ${
              String(err)
            }`,
          };
        }
        // The post comes FIRST, and the binding keys on it: there is no conversation to bind
        // until the platform has said the line, and a refused post leaves no row behind.
        try {
          threadKey = (await sendTo(room, platform, opened, line)).messageId;
        } catch (err) {
          diag.warn("chat.opening_post_failed", {
            chatroomId: room.id,
            runId: req.runId,
            channelId: conversation.channelId,
            err: String(err),
          });
          return {
            kind: "refused",
            status: 502,
            error: `the chat platform refused the opening post: ${String(err)}`,
          };
        }
      } else {
        threadKey = conversation.threadKey;
      }
      const binding: ChatBinding = {
        id: deps.mintId("cb"),
        chatroomId: room.id,
        runId: req.runId,
        threadKey,
        agentName: req.agentName,
        taskTitle: req.taskTitle,
        runUrl: req.runUrl,
        state: "active",
        // Read here, while the run's prompt was told the room's setting a moment earlier, when its
        // task started (`describeRoom`, frozen onto the work item): a switch landing between the
        // two leaves the run told one setting and closed under the other. Left so — the window is
        // the task start's few round trips, and closing it would mean carrying the frozen value
        // through every door's bind; the cost is one closing line said or missed.
        quiet: room.quiet,
        createdAt: nowIso(),
        closedAt: null,
      };
      if (!await store.createBinding(binding)) {
        return conversationHeld409();
      }
      diag.debug("chat.binding_opened", {
        chatroomId: room.id,
        runId: req.runId,
        threadKey,
        opened: conversation.kind === "new",
        continued: asked.kind === "continue" && conversation.kind === "thread",
      });
      // An existing conversation hears the line after the binding, best-effort: the run is bound
      // whether or not the room heard it. A new one already has — the line IS its key message.
      // A quiet room is not told a run started in a conversation that already exists — the 👀 on
      // a mention said it was heard — only, for a response that carries one, what fired.
      if (conversation.kind === "thread") {
        const said = !room.quiet
          ? line
          : req.alert === undefined
          ? null
          : alertBlock(room.kind, req.alert);
        if (said !== null) await announceIn(room, threadKey, said, "chat.opening_line_failed");
      }
      return { kind: "opened", binding };
    },

    async closeBinding(runId, closing) {
      const binding = await store.getBindingByRun(runId);
      if (binding === null || binding.state !== "active") return;
      // Conditional: of two closes racing for one binding, only the one that closed it speaks.
      if (!await closeActive(binding)) return;
      diag.debug("chat.binding_closed", {
        runId,
        outcome: closing.outcome,
        ...(closing.silent ? { silent: true } : {}),
      });
      // A stale binding released (`RunClosing.silent`) is only freed: its line is long overdue.
      if (closing.silent) return;
      const room = await store.getChatroom(binding.chatroomId);
      if (room === null) return;
      // A quiet room hears how a run went only when it did not succeed: one that did has said
      // what it had to in its own posts, and the run page keeps the summary and the links. Quiet
      // as the room was when the run bound, which is what its agent was told.
      if (binding.quiet && closing.outcome === QUIET_OUTCOME) {
        diag.debug("chat.closing_line_quiet", { runId, chatroomId: room.id });
        return;
      }
      // The summary is the run's own words and may name its images. They are resolved before
      // the line, as a post's are, but the line is the platform's and is said whatever comes of
      // them: an unknown ref, or a control plane that cannot answer, leaves the label in the
      // words and no picture after them.
      const split = splitImageRefs(closing.summary);
      let images: NamedImage[] = [];
      if (split.images.length > 0 && deps.images !== undefined) {
        try {
          const resolved = await resolveImages(
            runId,
            split.images.slice(0, MAX_POST_IMAGES),
          );
          if (resolved.kind === "resolved") images = resolved.images;
          else diag.warn("chat.closing_images_unknown", { runId, refs: resolved.refs });
        } catch (err) {
          diag.warn("chat.closing_images_failed", { runId, err: String(err) });
        }
      }
      // Where the platform takes them ahead (Zulip), they go up first and ride in the line.
      let inlined = false;
      const said = await announceIn(
        room,
        binding.threadKey,
        async (platform) => {
          if (images.length > 0 && transportOf(room).captionLimit !== undefined) {
            // Where the platform shows images where they stand (Telegram), the line is cut at
            // them, as a post is.
            inlined = true;
            const placed = withImageSlots(
              closing.summary,
              new Map(images.map((image) => [image.ref, image.ref])),
            );
            const summary = capSummary(escapeReferences(room.kind, placed.text.trim()));
            const line = closingLine(room.kind, binding, closing, summary);
            return {
              send: async (target) => {
                await sendInPlace(
                  room,
                  platform,
                  target,
                  line,
                  placed.slots,
                  images,
                  runId,
                  binding.agentName,
                );
              },
            };
          }
          const ahead = images.length === 0
            ? null
            : await uploadAhead(room, platform, runId, binding.agentName, images);
          if (ahead === null) {
            return closingLine(room.kind, binding, { ...closing, summary: split.text });
          }
          inlined = true;
          const slotted = withImageSlots(closing.summary, ahead.markups);
          const atomic = [...ahead.markups.values()];
          const summary = capSummary(
            slotted.fill(escapeReferences(room.kind, slotted.text.trim())),
            atomic,
          );
          return { text: closingLine(room.kind, binding, closing, summary), atomic };
        },
        "chat.closing_line_failed",
      );
      if (said !== null && images.length > 0 && !inlined) {
        await deliverImages(
          room,
          said.platform,
          said.target,
          runId,
          binding.agentName,
          images,
        );
      }
    },

    async checkCommander({ chatroomId, userId, groupId }) {
      const room = await liveRoom(chatroomId);
      if (room === null) return "unknown";
      try {
        return await transportOf(room).checkMembership(await platformOf(room), groupId, userId);
      } catch (err) {
        diag.warn("chat.commander_check_failed", { chatroomId, err: String(err) });
        return "unknown";
      }
    },

    async fetchThread({ chatroomId, threadKey }) {
      const room = await liveRoom(chatroomId);
      if (room === null) return { kind: "gone" };
      try {
        const thread = await transportOf(room).fetchThread(await platformOf(room), threadKey);
        return thread === null
          ? { kind: "gone" }
          : { kind: "thread", thread: unsignThread(thread, room.botId) };
      } catch (err) {
        diag.warn("chat.thread_fetch_failed", { chatroomId, threadKey, err: String(err) });
        return { kind: "unavailable" };
      }
    },

    async fetchContinuedThread({ chatroomId, previousRunIds, channelId }) {
      const room = await liveRoom(chatroomId);
      // A room that IS one conversation continues nothing: a response there binds the room.
      if (room === null || transportOf(room).roomIsOneConversation) return { kind: "none" };
      const previous = await previousBinding(room, previousRunIds);
      if (previous === null) return { kind: "none" };
      try {
        const platform = await platformOf(room);
        if (await locateContinuable(room, platform, previous, channelId) === null) {
          return { kind: "none" };
        }
        const thread = await transportOf(room).fetchThread(platform, previous.threadKey);
        return thread === null
          ? { kind: "none" }
          : { kind: "thread", thread: unsignThread(thread, room.botId), botId: room.botId };
      } catch (err) {
        diag.warn("chat.continued_thread_fetch_failed", {
          chatroomId,
          previousRunId: previous.runId,
          err: String(err),
        });
        return { kind: "unavailable" };
      }
    },

    async describeRoom(chatroomId) {
      const room = await liveRoom(chatroomId);
      if (room === null) return null;
      // Telegram's title is null until a linking mention names the group; the operator's own
      // name for the room is the next best thing the agent can be told.
      return {
        kind: room.kind,
        roomTitle: room.chatTitle ?? room.name,
        botHandle: room.botUsername,
        ...(room.quiet ? { quiet: true as const } : {}),
      };
    },

    async post(runId, text) {
      if (text.length > MAX_POST_TEXT) {
        return { kind: "refused", reason: `a post is at most ${MAX_POST_TEXT} characters` };
      }
      const split = splitImageRefs(text);
      if (split.images.length > MAX_POST_IMAGES) {
        return {
          kind: "refused",
          reason: `a post carries at most ${MAX_POST_IMAGES} images, and this one names ` +
            `${split.images.length}; nothing was sent`,
        };
      }
      const binding = await store.getBindingByRun(runId);
      if (binding === null || binding.state !== "active") {
        return { kind: "refused", reason: "this run is not bound to a chatroom" };
      }
      const room = await liveRoom(binding.chatroomId);
      if (room === null) return { kind: "refused", reason: "the chatroom is archived" };
      if (!isLinked(room)) {
        return {
          kind: "refused",
          reason: "the chatroom is not linked to a group yet — nobody would hear this",
        };
      }
      // Every ref is resolved BEFORE anything is said: a post whose image cannot be found fails
      // whole, naming it, rather than going out with a picture missing that its words point at.
      let images: NamedImage[] = [];
      if (split.images.length > 0) {
        try {
          const resolved = await resolveImages(runId, split.images);
          if (resolved.kind === "unknown") {
            return {
              kind: "refused",
              reason: `no image this run kept has the ref ${resolved.refs.join(", ")}: a ` +
                "ref names an image a tool returned in this run, and one that could not be " +
                "saved must be taken again; nothing was sent",
            };
          }
          images = resolved.images;
        } catch (err) {
          diag.warn("chat.images_unresolved", { runId, err: String(err) });
          return {
            kind: "refused",
            reason: "the images could not be looked up right now; nothing was sent",
          };
        }
      }
      try {
        const platform = await platformOf(room);
        // Where the conversation is NOW. A remembered topic name would quietly recreate the old
        // topic after a resolve; the key message follows every rename and move.
        const where = await transportOf(room).locate(platform, binding.threadKey);
        if (where === null) {
          return {
            kind: "refused",
            reason: "the message that started this conversation is gone — deleted, or moved " +
              "somewhere the bot cannot read — so there is nowhere to post; nothing was sent",
          };
        }
        // The run's words are escaped BEFORE they are signed and split: the escapes are part of
        // the text the platform will carry, so they count against a part's ceiling.
        const target = { channelId: where.channel.id, topic: where.topic };
        // A platform that shows an upload inside the words takes the images first, and each
        // rides in the text where the run wrote it; one that did not go up reads as its label.
        if (images.length > 0 && transportOf(room).captionLimit !== undefined) {
          // Where the platform shows images where they stand (Telegram), the post is cut at them.
          const placed = withImageSlots(
            text,
            new Map(images.map((image) => [image.ref, image.ref])),
          );
          const sent = await sendInPlace(
            room,
            platform,
            target,
            signPost(binding.agentName, escapeReferences(room.kind, placed.text)),
            placed.slots,
            images,
            runId,
            binding.agentName,
            attributionPrefix(binding.agentName),
          );
          return { kind: "posted", parts: sent.parts, images: sent.report };
        }
        const ahead = images.length === 0
          ? null
          : await uploadAhead(room, platform, runId, binding.agentName, images);
        const slotted = ahead === null
          ? { text: split.text, fill: (said: string) => said }
          : withImageSlots(text, ahead.markups);
        const { parts } = await sendTo(
          room,
          platform,
          target,
          slotted.fill(signPost(binding.agentName, escapeReferences(room.kind, slotted.text))),
          attributionPrefix(binding.agentName),
          ahead === null ? [] : [...ahead.markups.values()],
        );
        // The text is out, so from here nothing fails the post: what the images came to is
        // reported beside it.
        return {
          kind: "posted",
          parts,
          images: images.length === 0 ? null : ahead?.report ??
            await deliverImages(room, platform, target, runId, binding.agentName, images),
        };
      } catch (err) {
        diag.warn("chat.post_failed", { runId, chatroomId: room.id, err: String(err) });
        return { kind: "refused", reason: "the chat platform did not accept the message" };
      }
    },

    async listPollable() {
      return (await store.listChatrooms()).filter((r) => r.archivedAt === null);
    },

    async pollOnce(chatroomId, signal) {
      const stats: PollStats = { updates: 0, routed: 0 };
      const found = await liveRoom(chatroomId);
      if (found === null) return stats;
      // Non-null from here, and declared so: the routing below is a closure, and TypeScript
      // widens a mutable `let` back to its declared type inside one — the room is reassigned
      // when it links, so the narrowing from the guard above would not survive.
      let room: Chatroom = found;
      let platform = await platformOf(room);
      const transport = transportOf(room);
      const cursor = await store.getCursor(room.id);
      let saved: PollPosition | null = cursor;
      const batch = await transport.poll(platform, {
        position: cursor === null
          ? null
          : { offset: cursor.offset, queueId: cursor.queueId, lastMessageId: cursor.lastMessageId },
        timeoutS: pollTimeoutS,
        signal,
      });
      stats.updates = batch.updates.length;

      const saveAt = async (position: PollPosition): Promise<void> => {
        const next: PollCursor = { chatroomId: room.id, ...position, updatedAt: nowIso() };
        await store.saveCursor(next);
        saved = position;
      };

      const route = async (msg: InboundMessage): Promise<void> => {
        // A private chat or DM with the bot is not a room conversation (DMs carry link codes
        // later, never commands), and a broadcast channel has no senders.
        if (msg.direct) return;
        if (msg.chatId !== null) {
          // Telegram: the group is learned from the first mention that QUOTES THE ROOM'S LINK
          // CODE.
          //
          // Trust-on-first-use cannot serve here. The bot's @username is not a secret — the
          // management API returns it and Telegram usernames are searchable — and this setup
          // requires BotFather privacy mode OFF, so anyone could create a group, add the bot
          // and say "@thebot hi" before the operator's first mention. That captured the room:
          // the real team's messages were then silently dropped as the wrong chatId, while the
          // attacker received the task title, the agent name, the run URL, every `chat__post`,
          // the run summary and every patch's pull request URL — and could STEER the run.
          // `allowed_updates` requests only "message", so being added to an unexpected group
          // is not even visible.
          //
          // The code is the authorization. It is minted with the room, shown to the operator
          // once, and cleared here — a room links exactly once.
          if (room.chatId === null) {
            if (!msg.mentionsBot) return;
            if (room.linkCode === null || !(msg.rawText ?? "").includes(room.linkCode)) {
              diag.warn("chat.link_refused", {
                chatroomId: room.id,
                chatId: msg.chatId,
                chatTitle: msg.channel.name,
              });
              return;
            }
            room = {
              ...room,
              chatId: msg.chatId,
              chatTitle: msg.channel.name,
              linkCode: null,
              updatedAt: nowIso(),
            };
            await store.saveChatroom(room);
            platform = { ...platform, chatId: room.chatId, chatTitle: room.chatTitle };
            diag.debug("chat.room_linked", {
              chatroomId: room.id,
              chatId: msg.chatId,
              chatTitle: msg.channel.name,
            });
          }
          if (msg.chatId !== room.chatId) return;
        }
        // Only a real mention of the bot is a mention: the platform's own judgement, never a
        // grammar of ours. Telegram delivers the whole group (privacy mode off), so this is also
        // what keeps the room's side talk out.
        if (!msg.mentionsBot) return;
        // Bots are dropped, ours and anyone else's: Zulip enforces that only for its
        // outgoing-webhook bots, and two bots mentioning each other would loop.
        if (msg.sender === null || msg.sender.isBot) return;

        if (!msg.servable) {
          // A private Zulip channel the bot is not subscribed to: it heard the mention, but it
          // cannot read the thread, react, or reliably reply. Never reaches the door, and the
          // only address left is the channel the mention named.
          await announce(
            room,
            platform,
            { channelId: msg.channel.id, topic: msg.topic },
            NOT_SUBSCRIBED_REPLY,
            "chat.unservable_reply",
          );
          return;
        }

        // The conversation this mention is IN, located at the moment of asking: both where a reply
        // belongs and what each active binding's key is compared against. Located rather than read
        // off the message, because a message names its CHANNEL and only the platform knows what a
        // conversation is inside one — on Slack the thread the mention sits in, which a reply
        // posted to the channel instead would talk right past.
        const here: Located = await transport.locate(platform, msg.messageId) ??
          { channel: { id: msg.channel.id, name: msg.channel.name }, topic: msg.topic };
        const target: ConversationTarget = { channelId: here.channel.id, topic: here.topic };

        // Follow-up matching: the binding whose key message sits in the same conversation as this
        // mention, both located at the moment of asking, is this mention's run.
        let bound: ChatBinding | null = null;
        for (const binding of await store.listActiveBindings(room.id)) {
          const there = await transport.locate(platform, binding.threadKey);
          if (there !== null && sameConversation(here, there)) {
            bound = binding;
            break;
          }
        }

        // The images, fetched only now — for a mention the door will hear, never for the side
        // talk a Telegram group delivers whole — and under one deadline for all of them, so a
        // slow file host holds the room's poll up for a bounded time. An image that cannot be
        // taken is a note in the text; the mention goes on.
        const imagesSignal = AbortSignal.any([signal, AbortSignal.timeout(IMAGES_DEADLINE_MS)]);
        const attached = await attachImages(
          msg.text,
          msg.images,
          (source, maxBytes) =>
            transport.downloadImage(platform, source, { maxBytes, signal: imagesSignal }),
        );
        if (msg.images.length > 0) {
          diag.debug("chat.mention_images", {
            chatroomId: room.id,
            messageId: msg.messageId,
            offered: msg.images.length,
            taken: attached.images.length,
          });
        }

        const mention: ChatMention = {
          chatroomId: room.id,
          messageId: msg.messageId,
          boundRunId: bound?.runId ?? null,
          threadKey: bound?.threadKey ?? msg.threadKey,
          channel: msg.channel,
          topic: msg.topic,
          sender: { id: msg.sender.id, name: msg.sender.name },
          text: attached.text,
          hasAttachment: msg.hasAttachment,
          images: attached.images,
          receivedAt: nowIso(),
        };
        const delivery = await deliver(mention, signal);
        if (delivery.kind === "failed") {
          diag.warn("chat.door_failed", { chatroomId: room.id, err: delivery.error });
          await announce(room, platform, target, DOOR_DOWN_REPLY, "chat.door_down_reply_failed");
          return;
        }
        if (delivery.kind === "malformed") {
          diag.warn("chat.door_refused_mention", {
            chatroomId: room.id,
            messageId: msg.messageId,
            status: delivery.status,
            error: delivery.error,
          });
          return;
        }
        stats.routed += 1;
        await apply(delivery.verdict, msg, target);
      };

      const apply = async (
        verdict: ChatMentionVerdict,
        msg: InboundMessage,
        target: ConversationTarget,
      ): Promise<void> => {
        diag.debug("chat.mention_verdict", {
          chatroomId: room.id,
          messageId: msg.messageId,
          outcome: verdict.outcome,
          runId: verdict.runId,
        });
        if (verdict.react) {
          try {
            await transport.react(platform, msg.messageId);
          } catch (err) {
            diag.warn("chat.react_failed", { chatroomId: room.id, err: String(err) });
          }
        }
        if (verdict.reply === null) return;
        if (verdict.outcome === "no-binding") {
          const last = lastNoBindingReply.get(room.id) ?? -Infinity;
          const nowMs = deps.now().getTime();
          if (nowMs - last < NO_BINDING_REPLY_GAP_MS) return;
          lastNoBindingReply.set(room.id, nowMs);
        }
        await announce(room, platform, target, verdict.reply, "chat.reply_failed");
      };

      for (const update of batch.updates) {
        if (update.message !== null) await route(update.message);
        // The cursor advances PER UPDATE, not per batch. Saved once after the whole batch, a
        // platform call that threw part-way left it where it started, so the next poll asked
        // for the same updates again and re-sent every one already delivered. The door dedupes
        // on (room, message id), but a redelivered mention it had already answered would still
        // replay its side effects here.
        await saveAt(update.position);
      }
      // A new queue, heartbeats, a backfill that found nothing: the position moved without an
      // update to carry it.
      if (!samePosition(saved, batch.position)) await saveAt(batch.position);
      return stats;
    },
  };
}

/** Where an inlined image stands while the words around it are escaped, signed and cut:
 * private-use characters, which no platform's markup reads, around the image's index. */
const SLOT_OPEN = "\uE000";
const SLOT_CLOSE = "\uE001";
const SLOT = /\uE000(\d+)\uE001/g;

/**
 * A run's text with each image that went up ahead (`markups`, by ref) held as a slot at its
 * first occurrence, and every other ref read as its label; `fill` puts the markup into the slots
 * once the words are escaped and signed — after, so neither touches markup the adapter already
 * made safe, and a link opening a line is not taken for a speaker. A slot that capping cut in
 * two is dropped. The run's own private-use sentinels are taken out first, so no slot is forged.
 */
export function withImageSlots(
  text: string,
  markups: ReadonlyMap<string, string>,
): { text: string; slots: string[]; fill: (said: string) => string } {
  const slots: string[] = [];
  const clean = text.replaceAll(SLOT_OPEN, "").replaceAll(SLOT_CLOSE, "");
  const rendered = renderImageRefs(clean, (image, first) => {
    const markup = first ? markups.get(image.ref) : undefined;
    if (markup === undefined) return image.label;
    slots.push(markup);
    return `${SLOT_OPEN}${slots.length - 1}${SLOT_CLOSE}`;
  });
  return {
    text: rendered.text,
    slots,
    fill: (said) =>
      said.replace(SLOT, (_whole, i: string) => slots[Number(i)] ?? "")
        .replace(/\uE000\d*/g, "").replaceAll(SLOT_CLOSE, ""),
  };
}

/** A piece of a text cut at its image slots: words, or a run of images (by what each slot
 * holds) with nothing but white space between them. */
export type SlotSegment = { kind: "text"; text: string } | { kind: "images"; refs: string[] };

/**
 * A text holding slots (`withImageSlots`) as the messages a platform that shows images where
 * they stand sends: the words between runs of images, trimmed of the blank lines around them
 * and never empty, and each run of images as one group — an album. A slot cut in two, or one
 * naming nothing, is dropped.
 */
export function segmentAtSlots(said: string, slots: readonly string[]): SlotSegment[] {
  const segments: SlotSegment[] = [];
  const pieces = said.split(/\uE000(\d+)\uE001/);
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 1) {
      const ref = slots[Number(pieces[i])];
      if (ref === undefined) continue;
      const last = segments.at(-1);
      if (last?.kind === "images") {
        if (!last.refs.includes(ref)) last.refs.push(ref);
      } else segments.push({ kind: "images", refs: [ref] });
      continue;
    }
    const text = pieces[i].replace(/\uE000\d*/g, "").replaceAll(SLOT_CLOSE, "")
      .replace(/^\s*\n/, "").trimEnd();
    if (text.trim() === "") continue;
    segments.push({ kind: "text", text });
  }
  return segments;
}

/** The attribution a post opens with: the room reads it as who is speaking. */
export function attributionPrefix(agentName: string): string {
  return `[${agentName}] `;
}

/**
 * The agent's text as the room hears it: the name on the first line, once — and on any later
 * line that would otherwise read as a speaker, which is one opening with a bracket the way the
 * attribution itself does. The prefix is presented to the room as who is speaking, and the
 * agent's text is free to contain newlines, so a single prefix on the first line alone let it
 * forge another speaker's line ("[Alice] Approved, ship it.") underneath one that looked like
 * attribution; re-attributing exactly those lines closes that. The name once rode EVERY line,
 * which closed it too, and live it read as a stutter: a paragraph break became a bare
 * `[Responder]` line and each paragraph re-introduced the speaker.
 */
export function signPost(agentName: string, text: string): string {
  const prefix = attributionPrefix(agentName);
  return text
    .split("\n")
    .map((line, i) =>
      i === 0
        ? prefix + withoutOwnPrefix(agentName, line)
        : SPEAKER_LOOKALIKE.test(line)
        ? prefix + line
        : line
    )
    .join("\n");
}

/**
 * A line with the agent's own attribution taken off its front, however many times it is there.
 * An agent that reads its earlier posts back sees them signed and starts its own text with the
 * name too; signing that again posted `[Drippy] [Drippy] …`.
 */
function withoutOwnPrefix(agentName: string, line: string): string {
  const prefix = attributionPrefix(agentName);
  let rest = line.trimStart();
  while (rest.startsWith(prefix)) rest = rest.slice(prefix.length).trimStart();
  return rest;
}

/** A signed post's leading attribution: the agent's name and the text after it. */
const SIGNED_LINE = /^\[([^\]\n]+)\] /;

/**
 * A thread as an agent reads it: the bot's own posts unsigned, the agent that wrote each named as
 * its sender instead. Shown signed, the agent took `[Name] ` for part of how it writes and
 * signed its next post itself, on top of the platform's signature. The re-attributed later lines
 * `signPost` writes lose their name the same way.
 */
export function unsignThread(thread: ChatThread, botId: string): ChatThread {
  return {
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.sender.id !== botId) return message;
      const signed = SIGNED_LINE.exec(message.text);
      if (signed === null) return message;
      const name = signed[1];
      const prefix = attributionPrefix(name);
      const text = message.text
        .split("\n")
        .map((line, i) =>
          i === 0
            ? withoutOwnPrefix(name, line)
            : line.startsWith(prefix) && SPEAKER_LOOKALIKE.test(line.slice(prefix.length))
            ? line.slice(prefix.length)
            : line
        )
        .join("\n");
      return { ...message, sender: { ...message.sender, name }, text };
    }),
  };
}

/** A line that opens like an attribution: `[Alice] …`, whatever the spacing before it. */
const SPEAKER_LOOKALIKE = /^\s*\[/;

/** The most characters of an image's label a room is shown. */
export const MAX_IMAGE_LABEL_CHARS = 200;

/**
 * An image's label as the room reads it: on one line, bounded, and signed by the rule a post's
 * lines are (`signPost`). A label stands in what the room shows (a link in Zulip's or Slack's
 * message of links, a Slack file's title, a Telegram caption) under the signed post it follows,
 * so it needs the agent's name only where it opens like an attribution of its own: an unsigned
 * `![[Alice] Approved, ship it.](img-…)` put a line in the room that read as Alice's.
 */
export function signLabel(agentName: string, label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  const bounded = flat.length > MAX_IMAGE_LABEL_CHARS
    ? `${flat.slice(0, MAX_IMAGE_LABEL_CHARS - 1)}…`
    : flat;
  return SPEAKER_LOOKALIKE.test(bounded) ? attributionPrefix(agentName) + bounded : bounded;
}

/** A post in the platform's units: whole, or cut at the ceiling, on a line break where one is
 * near enough. Adapter-produced image markup is indivisible; an oversized fragment refuses
 * the post rather than sending a broken link or exceeding the platform ceiling. */
export function splitPost(
  text: string,
  max = TELEGRAM_MAX_POST_CHARS,
  atomic: readonly string[] = [],
): string[] {
  if (max <= 0 || atomic.some((part) => part.length > max && text.includes(part))) {
    throw new Error("an atomic post fragment exceeds the message ceiling");
  }
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const breakAt = window.lastIndexOf("\n");
    const cut = atomicCut(rest, breakAt > max / 2 ? breakAt + 1 : max, atomic) ||
      atomicCut(rest, max, atomic);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") parts.push(rest);
  return parts;
}

/** Move a boundary before any adapter-produced markup it would bisect. */
function atomicCut(text: string, cut: number, atomic: readonly string[]): number {
  for (const fragment of atomic) {
    if (fragment === "") continue;
    let start = text.indexOf(fragment);
    while (start >= 0 && start < cut) {
      if (start + fragment.length > cut) cut = start;
      start = text.indexOf(fragment, start + fragment.length);
    }
  }
  return cut;
}

/** Cap the rendered summary at a nearby word or whole-image boundary, then append ` [...]`. */
export function capSummary(summary: string, atomic: readonly string[] = []): string {
  if (summary.length <= CLOSING_SUMMARY_CHARS) return summary;
  const cut = summary.slice(0, CLOSING_SUMMARY_CHARS);
  const space = cut.lastIndexOf(" ");
  const end = atomicCut(
    summary,
    space > CLOSING_SUMMARY_CHARS * 0.8 ? space : CLOSING_SUMMARY_CHARS,
    atomic,
  );
  return `${summary.slice(0, end).trimEnd()} [...]`;
}

/** The badge a run's outcome is announced with — the forge progress comment's, so the two
 * surfaces read alike. */
const OUTCOME_BADGES: Record<string, string> = {
  succeeded: "✅",
  failed: "❌",
  errored: "💥",
  cancelled: "🛑",
  lost: "❓",
};

/**
 * The platform's opening line. A conversation a mention started already IS the context — the
 * Zulip topic or Slack thread the mention was made in — so there it names the agent and the run,
 * not the task's title (which repeats the channel back at the reader). A conversation the
 * platform OPENS has no prior message giving it context, so that line carries the title.
 * Telegram's one conversation carries responses to different alerts, so there the title always
 * stays. Zulip renders markdown, Discord its own Markdown (links masked, `<…>` around the URL so
 * no preview unfurls under the line), Slack its own mrkdwn, and Telegram the Markdown its adapter
 * turns into HTML — so the platform's own markup is left out there, and only the run's words
 * carry any.
 *
 * Every line ends by saying how to reach the run, because only a mention (or, on Telegram, a
 * reply to the bot) is ever read — plain chatter in the room never reaches the agent, and people
 * in a room a response opened have not necessarily talked to the bot before. Every Zulip, Slack
 * and Discord binding is a conversation inside a channel (a room-wide one is refused), so "this
 * topic" and "this thread" are always true there.
 */
export function openingLine(
  kind: ChatroomKind,
  req: { agentName: string; taskTitle: string; runUrl: string | null; botHandle: string },
  conversation: OpenBindingConversation["kind"] = "thread",
): string {
  const titled = conversation === "new";
  // The title is an automation's name or the words a mention started the run with, neither of
  // them this service's markup.
  const taskTitle = escapeReferences(kind, req.taskTitle);
  const agentName = escapeReferences(kind, req.agentName);
  if (kind === "zulip") {
    return `🚀 ${titled ? `**${taskTitle}** — ` : ""}` +
      `**${agentName}** is on it.` +
      (req.runUrl === null ? "" : ` [Follow the run](${req.runUrl})`) +
      " Mention me in this topic to talk to me.";
  }
  if (kind === "slack") {
    return `🚀 ${titled ? `*${taskTitle}* — ` : ""}` +
      `*${agentName}* is on it.` +
      (req.runUrl === null ? "" : ` <${req.runUrl}|Follow the run>`) +
      " Mention me in this thread to talk to me.";
  }
  if (kind === "discord") {
    return `🚀 ${titled ? `**${taskTitle}** — ` : ""}` +
      `**${agentName}** is on it.` +
      (req.runUrl === null ? "" : ` [Follow the run](<${req.runUrl}>)`) +
      " Mention me in this thread to talk to me.";
  }
  return `🚀 ${taskTitle} — ${agentName} is on it.` +
    (req.runUrl === null ? "" : ` ${req.runUrl}`) +
    ` Mention @${req.botHandle} or reply to me to talk to me.`;
}

/** The fire an opening line shows: its title as the payload format read it, and the payload. */
export interface OpeningAlert {
  title: string | null;
  payload: string;
}

/** How much of an alert's payload an opening line shows — well inside every platform's message
 * ceiling, so the line stays one post and its code block is never split. */
export const ALERT_EXCERPT_MAX = 2_500;

/** Discord's share of it: a message there is at most 2 000 characters, which the excerpt above
 * alone would pass. This leaves the opening line and an alert's title (500 at most) beside it. */
export const DISCORD_ALERT_EXCERPT_MAX = 1_000;

/**
 * The alert under an opening line: its title, then the payload in a code block — pretty-printed
 * when it is JSON, as sent when it is not, and cut at ALERT_EXCERPT_MAX (DISCORD_ALERT_EXCERPT_MAX
 * on Discord) with a note that it was.
 * The payload is whatever the sender wrote, so a run of three
 * backticks in it, which would close the block on every platform, is broken up with zero-width
 * spaces. Slack reads `&`, `<` and `>` as markup even inside a code block, so its escapes apply
 * there; Zulip, Discord and Telegram render a code block's contents as written, mentions
 * included — and a mention in a Discord code block is not one.
 */
export function alertBlock(kind: ChatroomKind, alert: OpeningAlert): string {
  let body = alert.payload.trim();
  try {
    body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON (or cut short of whole by the control plane): shown as sent.
  }
  const max = kind === "discord" ? DISCORD_ALERT_EXCERPT_MAX : ALERT_EXCERPT_MAX;
  const cut = body.length > max;
  // A cut between the halves of a surrogate pair would leave half a character.
  if (cut) body = body.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
  body = body.replace(/`{3,}/g, (run) => run.split("").join("\u200b"));
  if (kind === "slack") body = escapeReferences(kind, body);
  const title = escapeReferences(kind, (alert.title ?? "").replace(/\s+/g, " ").trim());
  const heading = title === ""
    ? ""
    : kind === "zulip" || kind === "discord"
    ? `**${title}**\n`
    : kind === "slack"
    ? `*${title}*\n`
    : `${title}\n`;
  const more = cut ? "\n…cut short." : "";
  return `${heading}\`\`\`\n${body}\n\`\`\`${more}`;
}

/**
 * Text this service did not compose, made safe to put in a line it did: whatever the platform
 * would read as a REFERENCE rather than as writing is neutralised, so a run's words, an alert's
 * title or a branch name cannot address the room. Slack escapes `&`, `<` and `>` — `<!channel>`
 * then reaches the room as those characters instead of paging everyone, and it is Slack that
 * decodes them on the way in, which is how something quoted out of a thread would otherwise come
 * back live.
 *
 * Zulip's own is `@**Name**`, `@*group*` and the wildcards `@**all**`, `@**everyone**` and
 * `@**stream**`, which page a whole channel. Each becomes Zulip's SILENT form, `@_**…**`, which
 * renders the name and notifies nobody. On Telegram a mention is only ever the characters it is
 * written with: its adapter writes the HTML a message carries, every character of the words
 * escaped, and makes a link of an http(s) address only — never `tg://user`.
 *
 * Discord's are `@everyone`, `@here`, `<@user>`, `<@!user>`, `<@&role>` and `<#channel>`. Every
 * post its adapter makes already carries `allowed_mentions: { parse: [] }`, so none of them can
 * ping anyone; this is the second lock, for text that would still RENDER as a mention: a
 * zero-width space after the `@` or the `<` keeps the characters and breaks the reference.
 *
 * Formatting is untouched. A run is told which markup its room renders and writes it on purpose,
 * and the markup AROUND these values is this service's own and is never passed through here.
 */
export function escapeReferences(kind: ChatroomKind, text: string): string {
  if (kind === "telegram") return text;
  if (kind === "zulip") {
    // Already silent (`@_**…**`) does not match, so this is safe to apply to text that has been
    // through it before.
    return text.replace(/@(\*{1,2})/g, "@_$1");
  }
  if (kind === "discord") {
    // Broken already (`@\u200beveryone`, `<\u200b@…>`) does not match again, so this too is safe
    // to apply twice.
    return text.replace(/@(everyone|here)/g, "@\u200b$1").replace(/<([@#])/g, "<\u200b$1");
  }
  // The ampersand first, or the escapes this adds would be escaped again.
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The platform's closing line: the outcome, the agent's summary, the patches, the issues the run
 * opened, the run link — so the conversation always ends with where the work went. Zulip gets it
 * as markdown with a heading per part, Discord as its own Markdown the same way (its link masked
 * with the URL in `<…>`, so no preview unfurls), Slack as mrkdwn with a bold line per part (it has
 * no headings), Telegram as plain lines. Everything the run or a forge put in it goes through
 * `escapeReferences` first; the markup around those values is this service's own.
 *
 * @example
 * ```ts
 * const line = closingLine("slack", binding, closing);
 * // 💥 *ada* finished with status `errored`. <https://…|View the full task transcript>
 * ```
 */
export function closingLine(
  kind: ChatroomKind,
  binding: ChatBinding,
  closing: RunClosing,
  /** Already escaped and capped, with adapter-produced image markup kept whole. */
  preparedSummary?: string,
): string {
  const badge = OUTCOME_BADGES[closing.outcome] ?? "❌";
  const safe = (text: string) => escapeReferences(kind, text);
  const quoted = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");
  // The summary is the run's own words and can quote the thread it was given as evidence; a
  // patch path and an issue reference come from a forge. None of them are this service's markup.
  const agentName = safe(binding.agentName);
  const summary = preparedSummary ?? safe(capSummary(closing.summary.trim()));
  const patches = closing.patches.map((patch) => ({
    path: safe(patch.path),
    state: patch.state,
    forgeUrl: patch.forgeUrl === null ? null : safe(patch.forgeUrl),
  }));
  const issues = closing.issues.map((issue) => ({
    ref: safe(
      `${issue.repo}${typeof issue.number === "number" ? `#${issue.number}` : ` ${issue.number}`}`,
    ),
    url: issue.url === null ? null : safe(issue.url),
  }));

  if (kind === "slack") {
    const sections = [
      `${badge} *${agentName}* finished with status \`${closing.outcome}\`.` +
      (closing.runUrl === null ? "" : ` <${closing.runUrl}|View the full task transcript>`),
    ];
    if (summary !== "") sections.push(`*Run summary*\n${quoted(summary)}`);
    if (patches.length > 0) {
      sections.push(
        "*Patches*\n" +
          patches.map((patch) => `• \`${patch.path}\`: ${patch.forgeUrl ?? patch.state}`)
            .join("\n"),
      );
    }
    if (issues.length > 0) {
      sections.push(
        "*Issues*\n" +
          issues.map((issue) => `• \`${issue.ref}\`${issue.url === null ? "" : `: ${issue.url}`}`)
            .join("\n"),
      );
    }
    return sections.join("\n\n");
  }

  if (kind === "zulip" || kind === "discord") {
    const url = (u: string) => kind === "discord" ? `<${u}>` : u;
    const sections = [
      `${badge} **${agentName}** finished with status \`${closing.outcome}\`.` +
      (closing.runUrl === null ? "" : ` [View the full task transcript](${url(closing.runUrl)})`),
    ];
    if (summary !== "") sections.push(`### Run summary\n${quoted(summary)}`);
    if (patches.length > 0) {
      sections.push(
        "### Patches\n" +
          patches.map((patch) => `- \`${patch.path}\`: ${patch.forgeUrl ?? patch.state}`)
            .join("\n"),
      );
    }
    if (issues.length > 0) {
      sections.push(
        "### Issues\n" +
          issues.map((issue) => `- \`${issue.ref}\`${issue.url === null ? "" : `: ${issue.url}`}`)
            .join("\n"),
      );
    }
    return sections.join("\n\n");
  }

  const lines = [`${badge} ${agentName} finished: ${closing.outcome}.`];
  if (summary !== "") lines.push(summary);
  for (const patch of patches) {
    lines.push(
      `• ${patch.path}: ${patch.state}${patch.forgeUrl === null ? "" : ` ${patch.forgeUrl}`}`,
    );
  }
  for (const issue of issues) {
    lines.push(`• issue ${issue.ref}${issue.url === null ? "" : ` ${issue.url}`}`);
  }
  if (closing.runUrl !== null) lines.push(closing.runUrl);
  return lines.join("\n");
}
