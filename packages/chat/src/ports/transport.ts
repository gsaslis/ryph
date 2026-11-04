// The chat platform's wire, hidden behind a port: one adapter per `ChatroomKind` (Telegram,
// Zulip, Slack, Discord), the service picking by the room's kind. The calls are what the service
// needs to hear mentions, find where a conversation lives NOW, read it, speak into it, and answer
// the control plane's questions — and nothing that decides anything.
//
// The port also carries the two facts about a platform's SHAPE that decide what a binding may
// name — `roomIsOneConversation` and `openTarget` — so the service asks the adapter rather than
// switching on the kind: a Telegram room is one conversation, a Zulip room opens named topics in
// a channel, a Slack room opens a thread under its own post, and a Discord room does too, naming
// the thread it starts from that post.
//
// Invariants:
// - the credential is an argument to every call (inside `PlatformRoom`), never state the adapter
//   keeps. An adapter may cache what the SERVER said (a limit, a display name) and may hold a
//   live connection a credential opened, keyed by `PlatformRoom.id`, but never the secret.
// - a conversation is addressed by a message in it (`locate`), never by a remembered topic name:
//   Zulip topics are renamed, resolved, split and moved, and only a message id survives all four.
// - the questions the control plane asks never throw: `checkMembership` answers "unknown", the
//   service maps a throwing `fetchThread` to "unavailable". Everything else throws on a platform
//   refusal, naming the call and never the credential.

import type {
  ChannelVisibility,
  ChatChannel,
  ChatGroup,
  ChatroomKind,
  ChatThread,
  CommanderVerdict,
} from "../core/types.ts";

/** A room's credential, unsealed. Slack's is a pair: the bot token every Web API call takes, and
 * the app-level token Socket Mode opens a connection with. Discord's names the one server (guild)
 * the room is: a Discord bot can be in many, and only the token is secret. */
export type ChatCredential =
  | { kind: "telegram"; botToken: string }
  | { kind: "zulip"; realmUrl: string; botEmail: string; apiKey: string }
  | { kind: "slack"; botToken: string; appToken: string }
  | { kind: "discord"; botToken: string; guildId: string };

/** Everything an adapter needs to act for one room. */
export interface PlatformRoom {
  /** The chatroom's own id — what an adapter holding a per-room connection keys it by. */
  id: string;
  credential: ChatCredential;
  /** The bot, as the room was created with it — what a mention names. */
  bot: { id: string; name: string };
  /** Telegram's learned group, Discord's server; null on a platform whose room is its
   * credential's workspace, and for an unlinked Telegram room. */
  chatId: string | null;
  chatTitle: string | null;
}

/**
 * `whoAmI`'s refusal of a credential the platform ACCEPTED but that cannot serve a room — a
 * person's token, an intent switched off, a bot anyone may add — its message written for the
 * person adding the room: what is wrong and where to fix it, never the secret. The service passes
 * it on as the 400; any other `whoAmI` failure is the platform's generic refusal.
 */
export class CredentialRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRefusedError";
  }
}

/** Who a credential belongs to: the bot's id, the name people mention, and the room's title
 * when the platform has one (Zulip's organization name, Slack's workspace name, Discord's server
 * name). */
export interface BotIdentity {
  id: string;
  name: string;
  title: string | null;
}

/** Where a conversation lives now. `channel.visibility` is not filled by `locate` (it costs a
 * call, and matching needs only ids) — see `ChannelRef`. */
export interface ChannelRef {
  id: string;
  name: string;
}

export interface Located {
  channel: ChannelRef;
  topic: string | null;
}

/** Where a post goes: the channel, and the conversation within it — a Zulip topic's name, a
 * Slack thread's root timestamp, a Discord thread's id, or null for the channel itself
 * (Telegram's group, and the channel-level post whose own thread a Slack or Discord conversation
 * becomes). */
export interface ConversationTarget {
  channelId: string;
  topic: string | null;
  /**
   * Discord only, with a null `topic`: start a thread of this name from the post at once. A
   * Discord thread has a name, unlike Slack's, and the topic a response asked for is that name —
   * so the conversation the platform opens is the post AND its thread, made together. Everything
   * else ignores it.
   */
  threadName?: string;
}

/** The poll position the service persists (see `PollCursor`), without its bookkeeping. */
export interface PollPosition {
  offset: number;
  queueId: string | null;
  lastMessageId: number | null;
}

/** A message the platform delivered, normalized. */
export interface InboundMessage {
  /** Zulip: the numeric id. Telegram: `<chatId>:<message_id>`. Slack:
   * `<channel>:<ts>:<thread root>` — a reply's own timestamp does not name the thread it sits
   * in, and `locate` has no other way to ask. Discord: `<channel>:<thread>:<message>`, the
   * channel being the thread's PARENT — a thread's id names neither its parent nor, from a
   * message in it, itself. The message sits in the parent when it is the thread's starter (its
   * id IS the thread's), and in the thread otherwise. */
  messageId: string;
  /** The key a NEW run from this message would bind: Zulip the message id, Telegram "", Slack
   * `<channel>:<thread root>` (the message's own timestamp when it starts one), Discord
   * `<channel>:<thread>` (the message's own id when it starts one — the id the thread will
   * take). */
  threadKey: string;
  /** Telegram only: the chat this arrived in, which a room links to. Null on a platform whose
   * room is the credential's workspace. */
  chatId: string | null;
  /** Not a room conversation: a private chat or DM with the bot, or a broadcast channel. */
  direct: boolean;
  channel: { id: string; name: string; visibility: ChannelVisibility };
  topic: string | null;
  /** Null when the platform names no sender (a Telegram channel post). */
  sender: { id: string; name: string; isBot: boolean } | null;
  /** The text as sent, for the Telegram link code; null for a message with none. */
  rawText: string | null;
  /** The text with every mention of the bot removed, trimmed. */
  text: string;
  hasAttachment: boolean;
  /** The images the message carries, as the platform names them — not yet downloaded: only a
   * mention that reaches the door is worth the fetch (`downloadImage`). In the order they sit. */
  images: ImageSource[];
  /** The platform's own judgement: Zulip's `mentioned` flag; Slack's `app_mention` event;
   * Telegram's @username or a reply to the bot; Discord's `mentions` naming the bot, or a reply
   * to one of its messages. */
  mentionsBot: boolean;
  /** False for a Zulip private channel the bot is not subscribed to: it hears the mention but
   * cannot read, react or reliably reply there. Always true on Slack, which delivers nothing
   * from a conversation the app is not in, and on Discord, which delivers nothing from a channel
   * the bot cannot see. */
  servable: boolean;
}

/**
 * One image a message carries, as its platform names it. What it is decides nothing — the bytes
 * do, once fetched (core/images.ts) — so the platform's own claims (a Slack `mimetype`, a
 * Telegram `mime_type`, a Discord `content_type`, a Zulip link's extension) only pick which
 * files are worth fetching.
 *
 * `at` is where the image sits in the message's `text`: the exact substring a marker replaces (a
 * Zulip upload's markdown link), or null for an image the platform shows apart from the words
 * (Telegram's photo, Slack's and Discord's files), whose marker goes on a line after them. `label`
 * says where an image came from when that is not the message itself — Telegram's reply to a photo.
 */
export interface ImageSource {
  at: string | null;
  label: string | null;
  /** What the platform said its size is, when it said: one over the cap is never fetched. */
  size: number | null;
  /** The platform's handle on the file, read only by the adapter that made it. */
  ref:
    | { kind: "telegram"; fileId: string }
    | { kind: "zulip"; path: string }
    | { kind: "slack"; url: string }
    /** A signed CDN URL: it is the grant, and no credential rides the fetch. */
    | { kind: "discord"; url: string };
}

/** What fetching one image came to: its bytes (sniffed by the caller), or why there are none. */
export type ImageDownload =
  | { kind: "bytes"; bytes: Uint8Array }
  /** More than the cap arrived, or was announced: the rest was not read. */
  | { kind: "too_large" }
  /** The platform would not serve it, or did not answer in time. */
  | { kind: "failed"; error: string };

/**
 * One image a run's words named, on its way into a conversation (core/agent_images.ts). The
 * bytes are fetched only when the platform will take them: a fallback to links never asks.
 */
export interface OutboundImage {
  /** The caption: the run's label signed with its agent's name (`signLabel`), on one line —
   * never empty, and not escaped: an adapter that puts it into a message's markup escapes it for
   * that markup, and a file's title or a photo's caption takes it as it is. */
  label: string;
  mime: string;
  /** The image behind a ryph login, or null when the deployment has none to give. */
  url: string | null;
  /** The bytes, from the control plane. Throws when it could not serve them. */
  load(): Promise<Uint8Array<ArrayBuffer>>;
}

/** What became of one image. */
export type ImageDelivery =
  /** The platform carries the image itself. */
  | { kind: "uploaded" }
  /** The platform would not take files from this bot, so the ryph link went instead. `reason`
   * is the platform's own word (`missing_scope`), for the service's log. */
  | { kind: "linked"; reason: string }
  | { kind: "failed"; error: string };

/** What became of one image uploaded to ride inside a message's own words (`uploadImages`). */
export type InlineUpload =
  /** The markup that shows it where it stands in the text: the caption, escaped for the
   * platform's markup and unable to read as a speaker, linking the upload. */
  | { kind: "inline"; markup: string }
  | { kind: "failed"; error: string };

/** What `listChannels` answers: the channels read, and whether the platform had more. */
export interface ChannelList {
  channels: ChatChannel[];
  truncated: boolean;
}

export interface PollUpdate {
  /** Where the cursor stands once this update is handled. */
  position: PollPosition;
  /** Null: nothing to route, the cursor moves past it. */
  message: InboundMessage | null;
}

export interface PollBatch {
  updates: PollUpdate[];
  /** Where the cursor stands after the whole batch — a new queue, heartbeats. */
  position: PollPosition;
}

export interface ChatTransport {
  readonly kind: ChatroomKind;
  /**
   * Whether the ROOM is one conversation, keyed "" — a Telegram group is, and a response run
   * binds to it directly. A platform with channels has none: a run there binds to the thread it
   * was asked from, or opens one of its own.
   */
  readonly roomIsOneConversation: boolean;
  /**
   * Where the opening line of a conversation the PLATFORM opens goes, from the channel a
   * response policy named and the topic it asked for — a Zulip topic of that name in the
   * channel; on Slack, the channel itself, whose reply thread under that post becomes the
   * conversation and where the topic is not an address at all; on Discord, the channel too, with
   * the topic as the name of the thread started from that post (`threadName`). Null: this
   * platform opens none, and a caller asking for one is refused.
   */
  openTarget(channelId: string, topic: string): ConversationTarget | null;
  /** The bot the credential belongs to. Throws on a credential the platform refuses — a
   * `CredentialRefusedError` when the platform took it but a room cannot be made of it. */
  whoAmI(credential: ChatCredential): Promise<BotIdentity>;
  /**
   * What arrived past `position`, holding the request up to `timeoutS` (a long poll) or until
   * `signal` aborts. Zulip: registers a queue when there is none or it was lost, and backfills
   * missed mentions from `lastMessageId`. Slack: holds a Socket Mode connection open across
   * calls and drains what it delivered — acknowledged on arrival, so there is no position to
   * resume from and nothing is offered twice. Discord: holds a Gateway connection the same way,
   * its position the session and sequence a RESUME replays from. Throws when the platform could not
   * be asked; the caller keeps its cursor and asks again.
   */
  poll(
    room: PlatformRoom,
    opts: { position: PollPosition | null; timeoutS: number; signal: AbortSignal },
  ): Promise<PollBatch>;
  /**
   * Lets go of whatever the adapter is still holding for a room OUTSIDE `polling` — one that was
   * archived, or that this poller never took the lock on. Slack and Discord close that room's
   * socket, which stops it consuming (and on Slack acknowledging) events nobody here will
   * answer; Telegram and Zulip hold
   * nothing between polls and do nothing. Idempotent, and a room polled again opens whatever it
   * needs again. The poller calls this after every pass, so `polling` is the whole truth about
   * what it watches — a set this method may not keep.
   */
  releaseAllBut(polling: ReadonlySet<string>): void;
  /** The conversation a message belongs to now; null when the message is gone or the bot cannot
   * read it. Slack and Discord answer from the key alone — a thread never leaves the channel it
   * was made in, so there is nothing to ask — and a key whose message has since been deleted is
   * found gone by the post or the thread read that needs it. */
  locate(room: PlatformRoom, messageId: string): Promise<Located | null>;
  /** The conversation holding `threadKey`, bounded; null when the key message is gone. */
  fetchThread(room: PlatformRoom, threadKey: string): Promise<ChatThread | null>;
  /**
   * One message into one conversation. Answers the posted message's id as a CONVERSATION key —
   * Zulip the numeric id, Telegram `<chatId>:<message_id>`, Slack `<channel>:<ts>`, Discord
   * `<channel>:<thread>` (the post's own id at the top of a channel, the thread it went into
   * otherwise) — which is what a run binds to when the platform's own post opens the
   * conversation. Throws when the platform refuses.
   */
  send(room: PlatformRoom, target: ConversationTarget, text: string): Promise<string>;
  /**
   * Takes back a post this bot made, by the key `send` answered for it — for an opening line
   * whose later parts the platform refused: a post at the top of a channel saying a run is on
   * it, with no run bound, would mislead. Only a platform whose post AT the channel opens a
   * conversation (Slack, Discord) has one. Throws on a refusal; the caller treats it as
   * best-effort.
   */
  retract?(room: PlatformRoom, key: string): Promise<void>;
  /**
   * Images into one conversation, after the text that names them (or, with a `captionLimit`,
   * the part of it before them): in order, each captioned by its label unless `caption` is
   * given — Slack's external upload shared in the thread, Discord's files on one message in the
   * thread, Telegram's photo or album, Zulip's uploads linked in one message to the topic. A
   * platform that will not take a file from this bot posts the ryph links instead (`linked`). Never
   * throws: one answer per image, in order, and an image that did not make it costs only itself.
   */
  sendImages(
    room: PlatformRoom,
    target: ConversationTarget,
    images: OutboundImage[],
    /** The words that follow these images, to ride as their caption — given only to a
     * platform with a `captionLimit`, and never longer than it. Absent or null: each image is
     * captioned with its label. */
    caption?: string | null,
  ): Promise<ImageDelivery[]>;
  /**
   * A platform that sends a post's images where its words put them (Telegram): the service cuts
   * the post at each run of images, sends the words before them, then the images, with the
   * words after them as their caption when those fit in this many characters (else as the next
   * message). Left out, the images follow the whole text, or ride inside it (`uploadImages`).
   */
  readonly captionLimit?: number;
  /**
   * Images uploaded ahead of the text that names them, for a platform that shows an upload
   * where a message links it (Zulip): the service puts each answer's markup into the words in
   * place of the image's label, so the post is ONE message with its pictures where the run put
   * them, rather than the words and then a second message of pictures. Left out, the images
   * follow the text (`sendImages`). Never throws: one answer per image, in order.
   */
  uploadImages?(room: PlatformRoom, images: OutboundImage[]): Promise<InlineUpload[]>;
  /** Acknowledges a message (👀). A platform without reactions does nothing. */
  react(room: PlatformRoom, messageId: string): Promise<void>;
  /** Is this user in this group, asked live. Never throws — a platform that cannot answer is
   * "unknown", never a yes. */
  checkMembership(room: PlatformRoom, groupId: string, userId: string): Promise<CommanderVerdict>;
  /**
   * The channels a policy may name, and whether the platform had more than this read took. A
   * workspace can hold more channels than any one read should pull, so the bound is real and the
   * caller is told when it was hit: a person who cannot find their channel in a picker needs to
   * know the list is partial rather than that the channel is missing.
   */
  listChannels(room: PlatformRoom): Promise<ChannelList>;
  listGroups(room: PlatformRoom): Promise<ChatGroup[]>;
  /** The platform's ceiling on one message, in characters. */
  maxMessageLength(room: PlatformRoom): Promise<number>;
  /**
   * One image's bytes, fetched with the room's credential, reading at most `maxBytes` and giving
   * up at the adapter's deadline or when `signal` aborts. Never throws: a file the platform will
   * not serve is a `failed`, and costs only itself.
   */
  downloadImage(
    room: PlatformRoom,
    source: ImageSource,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<ImageDownload>;
}
