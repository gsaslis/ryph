// The shared shapes of the chat service: chatrooms, their bindings to runs, and the
// per-conversation bindings Zulip and the threaded platforms need, as the core sees them.
//
// Invariants:
// - a chatroom's SECRETS (Telegram's bot token, Zulip's bot API key, Slack's bot and app-level
//   tokens, Discord's bot token) exist in exactly two forms: sealed at rest (`sealedBotToken`,
// `sealedAppToken`,   AES-GCM under this package's own master key, RYPH_CHAT_KEY) and in this
// process's memory   while it polls, reads or posts. They never appear in an API response —
// `toPublicChatroom` is   the one redaction point — never in a log, and never in a container: the
// agent posts through   a platform tool the gateway fronts, and the secret stays here.
// - a room has AT MOST ONE active binding PER CONVERSATION (`threadKey`). Telegram has one
//   conversation per group (key ""), so a response room keeps its one-run-at-a-time rule; a
//   Zulip conversation is keyed by the id of the mention that started its run, and follows that
//   message wherever moderators move it; a Slack conversation is a thread, keyed by its root, and
//   so is a Discord one, whose thread takes the id of the message it was started from.
// - this service DECIDES NOTHING about work. Every mention goes to the control plane's mention
//   door as a `ChatMention`, and the `ChatMentionVerdict` it answers says what to post and
//   whether to acknowledge — the chat service applies it and nothing more.
// - the service keeps no transcript of its own: every post is a gateway tool call in the run's
//   trail, and every inbound message is a row in the run's inbox on the control plane.

/** The chat platforms this service speaks, each behind its own `ChatTransport`. */
export type ChatroomKind = "telegram" | "zulip" | "slack" | "discord";

/** Who may read a channel: Zulip's `invite_only` / `is_web_public`, Slack's `is_private` (which
 * has no web-public tier), Discord's `@everyone` overwrite (neither has one); Telegram is always
 * private. */
export type ChannelVisibility = "private" | "public" | "web-public";

/** A channel as the control plane sees it. `id` is the platform's STABLE id (Zulip's
 * `stream_id`, Slack's `C…`, Discord's channel snowflake, Telegram's chat id); `name` is display
 * only. */
export interface ChatChannel {
  id: string;
  name: string;
  visibility: ChannelVisibility;
}

/** A platform user group — Zulip's user groups, Slack's usergroups, Discord's roles — the
 * commander policy's unit. */
export interface ChatGroup {
  id: string;
  name: string;
  description: string;
}

/**
 * A bot on a platform, as the operator set it up.
 *
 * Telegram: paste the token, add the bot to the group, and mention it once QUOTING THE ROOM'S
 * LINK CODE. `chatId` is learned from that mention — null until then, which the management
 * surface shows as "not linked yet". The code is what makes the link an authorization rather
 * than a race: the bot's @username is not a secret and the setup needs BotFather privacy mode
 * OFF, so a bare first mention proved nothing about who sent it.
 *
 * Zulip: the realm IS the room — a Zulip bot belongs to exactly one organization, so there is
 * nothing to link. `chatId` and `linkCode` stay null; `realmUrl` and `botEmail` are set.
 *
 * Slack: the workspace the app is installed in IS the room, so there is nothing to link either.
 * It is the one platform with TWO secrets — the bot token the Web API takes and the app-level
 * token Socket Mode opens a connection with — so `sealedAppToken` is set beside
 * `sealedBotToken`, and both are sealed under the same key.
 *
 * Discord: a bot can be in many servers, so a room is ONE of them, named at creation by its id.
 * That id is not a secret, and it rides `chatId` — set from birth, never learned — with the
 * server's name in `chatTitle`; the bot token is the one secret. The id is bound into the token's
 * seal (`tokenBinding`), so pointing a row at another server makes its token unopenable.
 */
export interface Chatroom {
  id: string;
  name: string;
  kind: ChatroomKind;
  /** What people mention: Telegram's @username, Zulip's bot full name, Slack's bot handle,
   * Discord's bot username. */
  botUsername: string;
  /** The bot's platform user id — a reply to the bot, the bot's own messages, `@**name|id**`,
   * Slack's `<@U…>`, Discord's `<@snowflake>`. */
  botId: string;
  /** The platform secret, sealed: Telegram's bot token, Zulip's bot API key, Slack's and
   * Discord's bot token.
   * Never leaves this service. */
  sealedBotToken: string;
  /** Slack's second secret, sealed: the app-level token (`xapp-…`) Socket Mode opens a
   * connection with. Null on every other platform, which has one secret. */
  sealedAppToken: string | null;
  /** Zulip: the organization's URL, e.g. `https://radicle.zulipchat.com`. Null for Telegram. */
  realmUrl: string | null;
  /** Zulip: the bot's email, the user half of its basic-auth credential. Null for Telegram. */
  botEmail: string | null;
  /** Telegram: the group's platform id, once the poller has seen a linking mention there.
   * Discord: the server's id, from creation. */
  chatId: string | null;
  /** Telegram: the group's title. Zulip: the organization's name. Slack: the workspace's.
   * Discord: the server's. */
  chatTitle: string | null;
  /**
   * The one-time code a Telegram linking mention must carry, minted with the room and cleared
   * the moment it links. Null once linked, and always null on a platform whose room is its
   * credential's workspace.
   */
  linkCode: string | null;
  /**
   * A quiet room hears only what the run itself says, and how a run went only when it did not
   * succeed. The platform's own lines are what it drops: the "is on it" line in a conversation
   * that already exists (a mention's, or a shared response conversation it continues — the 👀
   * on the mention already said the bot heard), and the closing line of a run that succeeded,
   * whose answer the agent has posted itself. A conversation the platform OPENS still gets its
   * opening line, because that post is the conversation's key message and nothing exists to
   * bind to without it; a response's alert is still shown; a run that failed, errored, was
   * cancelled or lost still says so, with its summary and links, because nobody would otherwise
   * learn it never answered. For rooms where the bot's bookkeeping is louder than the work —
   * a busy channel, a daily digest.
   */
  quiet: boolean;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Whether a room can hear and speak. Only Telegram has a group to learn — every other
 * platform's room is the workspace its credential belongs to, and is linked from birth. */
export function isLinked(room: Chatroom): boolean {
  return room.kind !== "telegram" || room.chatId !== null;
}

/** A chatroom as the API answers it: everything but the secret. */
export interface PublicChatroom {
  id: string;
  name: string;
  kind: ChatroomKind;
  botUsername: string;
  /** Whether the room can hear and speak yet (see `isLinked`). */
  linked: boolean;
  chatTitle: string | null;
  /** The code the linking mention must quote; null once linked, and on a platform with no group
   * to learn. The operator needs to read it exactly once, and it is useless afterwards. */
  linkCode: string | null;
  /** Zulip only; null elsewhere. Never the key. */
  realmUrl: string | null;
  botEmail: string | null;
  /** The room drops the platform's own bookkeeping lines (`Chatroom.quiet`). */
  quiet: boolean;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toPublicChatroom(room: Chatroom): PublicChatroom {
  return {
    id: room.id,
    name: room.name,
    kind: room.kind,
    botUsername: room.botUsername,
    linked: isLinked(room),
    chatTitle: room.chatTitle,
    linkCode: room.linkCode,
    realmUrl: room.realmUrl,
    botEmail: room.botEmail,
    quiet: room.quiet,
    ownerUserId: room.ownerUserId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    archivedAt: room.archivedAt,
  };
}

/**
 * A run linked to one conversation of a room for its lifetime: where the run's `chat__post`
 * lands, and what a follow-up mention in the same conversation is matched against. Opened by
 * the control plane when a run starts, closed when it ends; the name and title ride along so
 * the platform's own lines can say who is speaking without asking the control plane back.
 */
export interface ChatBinding {
  id: string;
  chatroomId: string;
  runId: string;
  /** The conversation: Telegram "", Zulip the id of the mention that started the run, Slack
   * `<channel>:<thread root>`, Discord `<channel>:<thread>`. */
  threadKey: string;
  agentName: string;
  taskTitle: string;
  runUrl: string | null;
  state: "active" | "closed";
  /**
   * The room was quiet (`Chatroom.quiet`) when the run bound, and so this run's closing line
   * follows that, not the room's switch now: the agent's prompt was told at its start whether it
   * must post its own answer, and a room switched to quiet mid-run must not silence a run that was
   * never told. Switched the other way it is merely one closing line short.
   */
  quiet: boolean;
  createdAt: string;
  closedAt: string | null;
}

/**
 * Where the poller is in a room's stream, persisted so a restart resumes, not replays.
 *
 * Telegram: `offset` is the next update id to ask for; the rest stay null.
 * Zulip: `queueId` is the registered events queue, `offset` its last event id, and
 * `lastMessageId` the newest message handled — the anchor a backfill resumes from when the
 * queue is gone. Message ids are monotonic, so one integer is the whole replay guard.
 * Slack: every field stays zero or null. Socket Mode has no position to resume from — an
 * envelope is acknowledged on arrival and never offered again — so the row says only that the
 * room has been heard from (adapters/transport/slack.ts).
 * Discord: `queueId` is the Gateway session (`<session id> <resume URL>`) and `offset` the
 * sequence number of the last event handled, which is what a RESUME replays from — so a restart
 * inside the session's resume window loses nothing; past it the session is gone and the adapter
 * identifies afresh (adapters/transport/discord.ts).
 */
export interface PollCursor {
  chatroomId: string;
  offset: number;
  queueId: string | null;
  lastMessageId: number | null;
  updatedAt: string;
}

// ── The mention door (contract §1) ─────────────────────────────────────────────────────────

/** A mention of the bot, normalized, as the chat service hands it to the control plane. */
export interface ChatMention {
  chatroomId: string;
  /** Zulip: the numeric message id. Telegram: `<chatId>:<message_id>`. Slack:
   * `<channel>:<ts>:<thread root>`. Discord: `<channel>:<thread>:<message>`. */
  messageId: string;
  /** The run whose binding this mention's conversation matched, or null. */
  boundRunId: string | null;
  /** The bound binding's key when bound; else the key a new run would get. */
  threadKey: string;
  channel: ChatChannel;
  /** The conversation's name where the platform has one — a Zulip topic, a Discord thread's
   * name; display only. Null on Telegram, on Slack, whose threads have no name, and for a Discord
   * mention at the top of a channel, whose thread does not exist yet. */
  topic: string | null;
  sender: { id: string; name: string };
  /** The text with every mention of the bot removed, trimmed. May be "". Carries an
   * `imageMarker(n)` where the nth of `images` sat, and a short note where an image the message
   * carried could not be taken (core/images.ts). Every `[image n]` in it is one of those: what
   * the sender typed in that shape was rewritten first. At most MAX_MENTION_TEXT_CHARS. */
  text: string;
  /** Whether the message carries a file at all — an image handed over below or not. */
  hasAttachment: boolean;
  /** The images the mention carried, downloaded by this service with the bot's credential and
   * checked against the platform's rules (sniffed, capped) — in the order the text's markers
   * count them. At most MAX_MENTION_IMAGES, MAX_MENTION_IMAGE_TOTAL_BYTES together. The control
   * plane checks them again: this side's check is so a bad image is dropped with a note rather
   * than refusing the whole mention there. */
  images: MentionImage[];
  /** ISO-8601, when this service received it. */
  receivedAt: string;
}

/** One image a mention carries: its bytes, as the platform served them. Over HTTP they travel
 * base64-encoded (adapters/mention_sink/http.ts); in-process, as they are. */
export interface MentionImage {
  bytes: Uint8Array;
}

/**
 * The placeholder written into a mention's text where its nth image (1-based, in the order of
 * `ChatMention.images`) sat. The control plane's own `imageMarker` writes the same form, and the
 * runner tells the agent beside the text which file each `[image N]` is. Restated here because
 * this package imports nothing of the control plane: the form is a wire contract, and each
 * side's tests pin it.
 */
export function imageMarker(n: number): string {
  return `[image ${n}]`;
}

/** The largest image a mention hands over: the control plane's MAX_ATTACHMENT_BYTES, 5 MiB. */
export const MAX_MENTION_IMAGE_BYTES = 5 * 1024 * 1024;

/** How many images one mention hands over: the control plane's MAX_ATTACHMENTS. */
export const MAX_MENTION_IMAGES = 10;

/**
 * All of one mention's images together. Below 10 × 5 MiB on purpose: a mention travels to the
 * control plane as ONE JSON body (base64, a third larger), retried whole when the door could
 * not decide, and this keeps that body to a size a request reasonably carries. A phone's photo
 * is a few MiB at most, and Telegram's are compressed far below that.
 */
export const MAX_MENTION_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * The longest a mention's text may be: the control plane's MAX_MESSAGE_CHARS, which its door
 * holds `ChatMention.text` to (in UTF-16 code units, JavaScript's `length`). A mention past it is
 * refused there as malformed and lost, so this side cuts the user's words to fit — never a marker
 * or a note (core/images.ts).
 */
export const MAX_MENTION_TEXT_CHARS = 16 * 1024;

export type ChatMentionOutcome =
  | "started"
  | "joined"
  | "denied"
  | "refused"
  | "not-served"
  | "rate-limited"
  | "unverifiable"
  | "no-binding"
  | "deduped";

/** What the door decided. The chat service posts `reply` into the mention's conversation and
 * reacts when `react` — nothing else. */
export interface ChatMentionVerdict {
  outcome: ChatMentionOutcome;
  reply: string | null;
  react: boolean;
  runId?: string;
  taskId?: string;
}

// ── What the control plane asks (contract §2) ──────────────────────────────────────────────

export type CommanderVerdict = "allowed" | "denied" | "unknown";

/** A conversation, as evidence for the agent. */
export interface ChatThread {
  channel: ChatChannel;
  topic: string | null;
  /** Oldest first; platform notices removed; the raw markdown the author typed. */
  messages: Array<{
    id: string;
    sender: { id: string; name: string };
    text: string;
    sentAt: string;
    hasAttachment: boolean;
  }>;
  /** Older messages were dropped to fit the size bound. */
  truncated: boolean;
  /** The platform hides history from before the bot joined. */
  historyLimited: boolean;
}

export type ThreadFetch =
  | { kind: "thread"; thread: ChatThread }
  /** The key message no longer exists, or the bot cannot read it. */
  | { kind: "gone" }
  /** The platform did not answer. */
  | { kind: "unavailable" };

/**
 * The conversation a shared response would continue, read for the run about to start in it — the
 * earlier responses' own posts and what people answered them. `botId` is the room's bot as the
 * platform names it, so the reader can tell those posts (`sender.id`) from people's: a display
 * name is anyone's to choose, an id is not.
 */
export type ContinuedThreadFetch =
  | { kind: "thread"; thread: ChatThread; botId: string }
  /** Nothing this response would continue: no previous response bound in the room, or its
   * conversation is gone or out of the channel — the binding opens a new one. */
  | { kind: "none" }
  /** The platform did not answer. */
  | { kind: "unavailable" };

/** The room as a bound run's agent is told about it — the orchestrator's `ChatContext`. */
export interface RoomContext {
  kind: ChatroomKind;
  /** The Telegram group's title (the room's own name until the group links), the Zulip
   * organization's name, the Slack workspace's, or the Discord server's. */
  roomTitle: string;
  /** What people type to reach the bot: Telegram's @username without the @, Zulip's bot full
   * name, Slack's bot handle, Discord's bot username. */
  botHandle: string;
  /** The room is quiet (`Chatroom.quiet`): a run that succeeds gets no closing line, so the
   * agent is told its own posts are the only answer anyone there will see. Absent: it is not. */
  quiet?: true;
}

/** What the control plane says about a run that ended, for the conversation's closing line. */
export interface RunClosing {
  outcome: string;
  summary: string;
  patches: Array<{ path: string; state: string; forgeUrl: string | null }>;
  /** Issues the run opened on the forge, so the conversation ends with where the work went. */
  /** `number` is GitHub's issue number, or a Radicle issue's short id. */
  issues: Array<{ repo: string; number: number | string; url: string | null }>;
  runUrl: string | null;
  /**
   * Close without a word. A binding the control plane finds still active on a run that ended a
   * while ago — its conclusion's close failed, or a sweep closed the response behind it — is
   * stale: a closing line now would arrive out of order in a conversation that may have moved
   * on, so it is only released, and the conversation is free for the next run.
   */
  silent?: boolean;
}

/** The one outcome a quiet room is not told about: the run did what it was asked, and its own
 * posts are the answer. Every other outcome — failed, errored, cancelled, lost, or one this
 * service does not know yet — still gets its closing line. */
export const QUIET_OUTCOME = "succeeded";

/** Telegram's ceiling on one message; Zulip's comes from the server. */
export const TELEGRAM_MAX_POST_CHARS = 4096;

/** Slack's ceiling on one message, the figure its own formatting guide and its SDKs use. The API
 * accepts more and truncates in silence, which is the failure this number exists to avoid. */
export const SLACK_MAX_POST_CHARS = 4000;

/** Discord's ceiling on one message's `content`, which it refuses past rather than cuts. */
export const DISCORD_MAX_POST_CHARS = 2000;

/** The most a `post` call may carry — the same bound the control plane puts on an inbox row. */
export const MAX_POST_TEXT = 16 * 1024;

/** How much of a run's summary the closing line quotes — a short paragraph; the run page has
 * the rest. */
export const CLOSING_SUMMARY_CHARS = 400;

/** A fetched thread's bounds: at most this many messages, and this many characters of text,
 * newest kept. */
export const THREAD_MAX_MESSAGES = 200;
export const THREAD_MAX_CHARS = 60_000;
