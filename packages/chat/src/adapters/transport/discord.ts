// `ChatTransport` over Discord: the REST API (v10) with a bot token for everything the service
// reads and says, and the GATEWAY — a WebSocket the bot holds open — for everything it hears.
//
// A room is ONE server (guild), and ONE bot serves one room: the service refuses a second room on
// a bot that already has one. A Gateway connection receives every server the bot is in, Discord
// allows one IDENTIFY per five seconds per token and a thousand a day — so two rooms on one token
// would each carry the other's traffic, collide on identify, and spend one budget each believing
// it was theirs. A bot can still sit in other servers, so the credential names the one it
// answers for, and every event and channel from any other server is ignored here. A PUBLIC bot
// (anyone may add it) is refused at creation: a stranger adding it streams their server into
// this socket.
//
// Hearing: `GET /gateway/bot` answers the Gateway's address (so a stand-in of the REST API names
// its own socket), and the socket speaks Discord's protocol: HELLO, then IDENTIFY with the
// `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT` intents, a heartbeat at the interval HELLO named
// (the first one jittered, as Discord asks), and every MESSAGE_CREATE in every channel the bot
// can see. Only a message that mentions the bot is kept — the rest is the room's own talk and is
// dropped on arrival. A Gateway event is not acknowledged, but a SESSION can be resumed: the
// socket drops, the next poll RESUMEs with the session id and the last sequence number, and
// Discord replays what was missed. The session is the poll position (`PollPosition`: the session
// as `queueId`, the sequence as `offset`), persisted per handled event, so a process restarted
// inside the session's resume window replays the mentions it had not yet handed the door rather
// than losing them. Past that window Discord answers INVALID_SESSION and the adapter identifies
// afresh — what arrived in between is lost, as on Slack, and the person mentions again.
//
// Conversations: a Discord conversation is a THREAD, and a thread started from a message takes
// that message's id as its own. So a mention at the top of a text channel keys the thread it
// would start (`<channel>:<its own id>`), and the thread is started — named after the mention —
// by the first post that needs it; a mention inside a thread keys that thread
// (`<parent channel>:<thread>`). A thread never leaves its parent, so a key locates itself with
// no call at all. A response opens one by posting at the channel and starting a thread of the
// asked-for name from that post at once (`ConversationTarget.threadName`): a Discord thread has a
// name, unlike Slack's.
//
// Invariants:
// - every message this adapter posts carries `allowed_mentions: { parse: [] }`: nothing ryph says
//   — a run's words, a quoted thread, an alert — can ping a person, a role, `@here` or
//   `@everyone`. The service also breaks such references in text it did not compose
//   (`escapeReferences`), so they do not even render as mentions.
// - a channel's visibility is read LIVE on every mention and never guessed: a mention whose
//   channel the bot cannot describe fails the poll and keeps its place; one whose channel is gone
//   or out of the bot's sight is dropped, like Slack's.
// - only text and announcement channels, and threads under them, are served. A forum, a voice
//   channel's chat or a stage is not a channel `listChannels` offers, so nothing could ever be
//   started there, and a mention from one is dropped on arrival.
// - the socket is the one piece of state kept, keyed by `PlatformRoom.id` and closed when the
//   caller's signal aborts or `releaseAllBut` says the room is no longer polled. Unlike a Slack
//   connection there is no age bound: the heartbeat IS the liveness check — a heartbeat Discord
//   did not acknowledge before the next is due is a zombie connection, closed and resumed.
// - a close Discord means as final — a refused token (4004), intents the app may not ask for
//   (4013, 4014), a bad version or shard (4010–4012) — is FATAL for the room: every poll throws a
//   readable error naming the fix and how to recover, and the room is not dialled again until it
//   stops being polled (archived, re-added) or the process restarts, so a misconfigured bot does
//   not spend its daily identify budget on a reconnect storm. The one exception is 4014, the
//   Message Content intent switched off — a toggle in the developer portal that touches nothing
//   ryph holds: while held, the application's flags are read every INTENT_RECHECK_MS (a REST
//   call, no IDENTIFY), and the hold lifts once the intent is on, so the room keeps its id, its
//   policy and its automations. Neither is an IDENTIFY sent while `GET /gateway/bot` says fewer
//   than IDENTIFY_FLOOR of the day's remain: the room waits out Discord's own reset, loudly.
// - a connection that never finishes its handshake is not trusted: no HELLO within
//   HANDSHAKE_TIMEOUT_MS of the dial, or no READY/RESUMED within it of the IDENTIFY/RESUME, and
//   it is closed. A session whose resumes keep ending that way (MAX_RESUME_TRIES) is forgotten
//   and the room identifies afresh — a resume URL that went stale is never retried forever — and
//   past MAX_SILENT_CONNECTS such dials in a row the poll throws, so the poller says so.
// - every channel read, and every channel or thread posted into, is checked to be THIS server's
//   (`guild_id`), once per channel per process: a key or a policy naming another server's
//   channel — the bot may sit there too — reads as missing rather than crossing over.
// - snowflakes are strings everywhere: past 2^53, a number rounds one into another id.
// - the credential rides a header (and the socket's IDENTIFY), never a URL, and no error names
//   it. The Gateway is dialled only on Discord's own `discord.gg` (or the stand-in's host): a
//   resume URL is read back from the cursor table, and a row edited to name another host must
//   not be where the token goes.
//
// Images: a mention's attachments that Discord says are images are fetched from their CDN URL —
// signed, so no credential rides the fetch. A run's images go OUT as files on one message
// (`files[n]` beside `payload_json`), in the thread, captioned by their labels; a bot without
// Attach Files is answered Missing Permissions, and the images go as ryph links instead.

import type { ChatChannel, ChatGroup, ChatThread, CommanderVerdict } from "../../core/types.ts";
import { DISCORD_MAX_POST_CHARS, THREAD_MAX_CHARS, THREAD_MAX_MESSAGES } from "../../core/types.ts";
import { imageFileName } from "../../core/agent_images.ts";
import { escapeReferences } from "../../core/service.ts";
import { downloadCapped, redactSecrets } from "../../helpers/download.ts";
import { CredentialRefusedError } from "../../ports/transport.ts";
import type {
  BotIdentity,
  ChannelList,
  ChatCredential,
  ChatTransport,
  ConversationTarget,
  ImageDelivery,
  ImageSource,
  InboundMessage,
  Located,
  OutboundImage,
  PlatformRoom,
  PollBatch,
  PollPosition,
  PollUpdate,
} from "../../ports/transport.ts";

/** A Gateway connection, as this adapter drives it: text frames out, text frames in through the
 * handlers it was opened with. A fake stands in for a real WebSocket in tests, which is the only
 * reason this is a seam. `close` takes the close code, which decides whether Discord keeps the
 * session resumable (anything but 1000 and 1001 does). */
export interface DiscordSocket {
  send(text: string): void;
  close(code: number): void;
}

/** Opens one Gateway connection and reports what arrives on it. `closed` fires once — for a
 * socket the server ended (with its close code), one that failed to open, and one this side
 * closed. */
export type DiscordDialer = (
  url: string,
  handlers: { message(text: string): void; closed(code: number, reason: string): void },
) => DiscordSocket;

export interface DiscordTransportOptions {
  /** The REST API base; overridable for tests and the playground's stand-in. */
  apiUrl?: string;
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request deadline. Nothing here long-polls: the socket does the waiting. */
  requestTimeoutMs?: number;
  /** Deadline for one image's download or upload. */
  downloadTimeoutMs?: number;
  /** Opens the Gateway socket; a fake in tests. */
  dial?: DiscordDialer;
  /** The clock, for the identify spacing and the identify-budget hold. */
  now?: () => number;
  /** How long a dialled socket may stay silent before HELLO, and an identified or resuming one
   * before READY/RESUMED. */
  handshakeTimeoutMs?: number;
  /** The fraction of the first heartbeat interval waited before the first beat; random. */
  jitter?: () => number;
  /** The longest one 429 is waited out in place before the call gives up. */
  maxRetryAfterMs?: number;
}

const DEFAULT_API_URL = "https://discord.com/api/v10";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;

/** GUILDS (channels and threads), GUILD_MESSAGES, and MESSAGE_CONTENT — privileged, and what
 * lets the bot read a message that does not mention it: a reply to it with the ping turned off,
 * and every message of a thread it is handed as evidence (REST reads are gated the same way). */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/** The application flags that say the Message Content intent is on: the verified app's and the
 * one an unverified app (under 100 servers) gets by toggling it in the developer portal. */
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

/** The permission bit that decides who sees a channel. Permissions are big integers as strings. */
const VIEW_CHANNEL = 1n << 10n;

/** A message's flag that keeps link previews off it: a run's posts carry patch and run links, and
 * a preview under each would bury the words (Slack's `unfurl_links: false`). */
const SUPPRESS_EMBEDS = 1 << 2;

/** What every post may ping: nothing. */
const NO_MENTIONS = { parse: [] as string[] };

/** Text (0) and announcement (5) channels: the ones `listChannels` offers and a mention is served
 * from. */
const TEXT_TYPES = new Set([0, 5]);
/** Announcement thread (10), public thread (11), private thread (12). */
const THREAD_TYPES = new Set([10, 11, 12]);
/** A user's own words (0) and a reply (19); everything else in a channel is Discord talking about
 * it — a pin, a join, a thread created — and is not evidence. */
const SPOKEN_TYPES = new Set([0, 19]);

/** Discord's own bound on a thread's name. */
const THREAD_NAME_MAX = 100;
/** Discord's own bound on an attachment's description (its alt text). */
const MAX_ALT_TEXT = 1_024;
/** Files on one message. */
const MAX_FILES_PER_MESSAGE = 10;

/** A thread is read backwards a page at a time, at most this many pages: enough to know whether
 * THREAD_MAX_MESSAGES was all of it. */
const HISTORY_PAGE = 100;
const HISTORY_MAX_PAGES = Math.ceil(THREAD_MAX_MESSAGES / HISTORY_PAGE) + 1;

/** How many mentions may wait to be drained. Past it a mention is dropped: a Gateway event is
 * not redelivered, and a room mentioning the bot a thousand times between two polls is not a
 * room anyone is talking in. */
const MAX_QUEUED = 1_000;

/** A 429 is waited out in place up to this long, at most this many times per call. */
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;
const MAX_RATE_LIMIT_RETRIES = 2;

/** How long a socket may stay silent at each step of its handshake. Discord's HELLO comes at
 * once; a socket that opened and says nothing is a dead edge, reused forever if not timed. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

/** Dials in a row that never reached READY/RESUMED after which a session is no longer resumed:
 * its resume URL, or the session itself, is gone in a way Discord did not say. */
const MAX_RESUME_TRIES = 3;
/** Dials in a row that never reached READY/RESUMED after which every poll that sees another one
 * fail throws, so the poller logs it rather than the room going quietly deaf. */
const MAX_SILENT_CONNECTS = 5;

/** The fewest of the day's IDENTIFYs (`session_start_limit.remaining`) this adapter will spend
 * one from. Past the budget Discord resets the TOKEN, and the operator has to make a new room. */
const IDENTIFY_FLOOR = 50;

/**
 * The least time between two IDENTIFYs of one room. Discord allows a bot 1 000 a day and RESETS
 * ITS TOKEN past that, so a socket that keeps opening and closing — a close code nobody foresaw, a
 * session invalidated over and over — must not be allowed to identify on every two-second tick.
 * At this spacing a day holds under a thousand; a RESUME costs none and is never held back.
 */
const IDENTIFY_GAP_MS = 90_000;

/** What this side closes a socket with: anything but 1000/1001 keeps the session resumable,
 * which is what a reconnect — or the next process, from the persisted cursor — resumes. */
const RESUMABLE_CLOSE = 4000;

/** The way back from a close only a new room or a new process clears. */
const RECOVER = "then archive this room and add it again, or restart ryph";

/** Close codes no reconnect fixes, and what each tells the operator to do — ending with how the
 * room comes back. A room's token is never edited in place, and the service refuses a second
 * room on a bot until the first is archived, so a new token means archive first, then add. */
const FATAL_CLOSES: Record<number, string> = {
  4004: "the bot token was refused — reset it under Bot in the developer portal, then archive " +
    "this room and add it again with the new token",
  4010: `Discord refused the shard this connection asked for; ${RECOVER}`,
  4011: "the bot is in too many servers for one connection, and ryph does not shard — remove " +
    `it from the servers it should not be in, ${RECOVER}`,
  4012: `Discord refused the Gateway version this connection asked for; ${RECOVER}`,
  4013: `Discord refused the intents this connection asked for; ${RECOVER}`,
  4014: "the bot may not use the Message Content intent — turn on Message Content Intent " +
    "under Bot → Privileged Gateway Intents in the developer portal; ryph checks again every " +
    "5 minutes and the room listens again once it is on",
};

/** The close that says the Message Content intent is off — the one fatal close ryph can see
 * fixed from outside, through the application's flags. */
const DISALLOWED_INTENTS = 4014;

/** How often a room held by DISALLOWED_INTENTS reads the application's flags again. A REST call,
 * not an IDENTIFY: it spends nothing of the day's budget. Keep the "5 minutes" in FATAL_CLOSES in
 * step. */
const INTENT_RECHECK_MS = 5 * 60_000;

/** The least time between two lazy reads of the server's roles after one failed: a mention of
 * the bot's role waits for it, everything else does not. */
const ROLE_RETRY_MS = 60_000;

/** Close codes after which the session is gone, and the next connection identifies afresh. */
const SESSION_ENDING_CLOSES = new Set([4007, 4009]);

/** Discord's JSON error codes this adapter acts on. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const ARCHIVED_THREAD = 50083;
const THREAD_ALREADY_CREATED = 160004;

/** The fallback name of a thread whose starter says nothing a name could be made of — or that
 * the bot may not read (no Read Message History). */
const FALLBACK_THREAD_NAME = "ryph";

/** How many redirects an attachment download follows, each one's host checked again. */
const MAX_FILE_REDIRECTS = 3;

/** Channels and threads known to be this server's, per room, at most this many: past it the set
 * starts over, and the next post into each is checked again. */
const MAX_KNOWN_CHANNELS = 10_000;

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** `text` cut to at most `max` UTF-16 units, never between the halves of a surrogate pair —
 * Discord refuses half a character in a name, and shows it as garbage in a message. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
}

type DiscordCred = Extract<ChatCredential, { kind: "discord" }>;

/** A refusal from Discord: the HTTP status and Discord's own JSON error code, when it named
 * one. */
export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

/** A post refused because its thread is archived and locked: only a moderator can reopen it, and
 * nothing this bot says will land there until one does. (An archived thread that is NOT locked
 * reopens on its own when posted to.) */
export class DiscordThreadLockedError extends DiscordError {
  constructor(message: string) {
    super(400, ARCHIVED_THREAD, message);
    this.name = "DiscordThreadLockedError";
  }
}

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
  member?: { nick?: string | null };
}

interface DiscordAttachment {
  filename?: string;
  size?: number;
  url?: string;
  content_type?: string;
}

interface DiscordMessage {
  id: string;
  type?: number;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  member?: { nick?: string | null };
  webhook_id?: string;
  content?: string;
  timestamp?: string;
  mentions?: DiscordUser[];
  /** The roles the message mentions, by id. */
  mention_roles?: string[];
  attachments?: DiscordAttachment[];
  /** What a reply replies to: the message, and the channel it sits in. */
  message_reference?: { message_id?: string; channel_id?: string } | null;
  referenced_message?: { author?: { id?: string } } | null;
}

interface DiscordChannel {
  id: string;
  type: number;
  /** The server it belongs to; absent for a DM. */
  guild_id?: string;
  name?: string | null;
  parent_id?: string | null;
  permission_overwrites?: Array<{ id: string; type: number; allow?: string; deny?: string }>;
}

/** One frame off the Gateway. */
interface GatewayFrame {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

/** A mention waiting to be drained, with the position it arrived at: its session AND sequence,
 * taken together then. A mention carried over to a connection that identified afresh belongs to
 * the old session, and a new session's id beside an old session's sequence would be a cursor a
 * RESUME replays the wrong events from. */
interface Queued {
  message: DiscordMessage;
  position: PollPosition;
}

/** A live Gateway connection, the session it carries, and what it has delivered but nobody has
 * taken yet. */
interface Connection {
  socket: DiscordSocket | null;
  queue: Queued[];
  /** Messages that mention a ROLE and nothing else of the bot's, heard while the bot's own role
   * was unknown (its read failed): kept apart until a read says whether the role is the bot's,
   * so the mentions behind them are not held up. */
  unsure: Queued[];
  /** The last sequence number Discord sent: what a heartbeat carries and a RESUME replays from. */
  seq: number | null;
  sessionId: string | null;
  resumeUrl: string | null;
  heartbeat: ReturnType<typeof setTimeout> | null;
  /** Closes the socket unless the next step of the handshake arrives in time. */
  handshake: ReturnType<typeof setTimeout> | null;
  /** READY or RESUMED arrived: the connection is serving. */
  handshook: boolean;
  /** How the socket ended, for the error that says the Gateway keeps failing. */
  lastClose: string | null;
  /** A heartbeat was sent and Discord has not acknowledged it. */
  awaitingAck: boolean;
  closed: boolean;
  /** Set when Discord closed the socket for good (FATAL_CLOSES). */
  fatal: Error | null;
  /** Ends the poll that is holding for the next mention. */
  wake: (() => void) | null;
  onDrain: (() => void) | null;
  drainSignal: AbortSignal | null;
}

/**
 * A Discord address: the PARENT channel, the thread (the id of the message it was or will be
 * started from), and one message. A conversation's key is the first two (`<channel>:<thread>`);
 * an inbound message adds itself (`<channel>:<thread>:<message>`). The message sits in the
 * parent when it IS the thread's starter — its id is the thread's — and inside the thread
 * otherwise.
 */
export interface DiscordAddress {
  channelId: string;
  threadId: string;
  messageId: string;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** A key, parsed; null for anything that is not one — which is how another platform's key
 * reaching a Discord room becomes a refusal rather than a wrong post. */
export function parseDiscordAddress(key: string): DiscordAddress | null {
  const parts = key.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [channelId, threadId, messageId = threadId] = parts;
  if (![channelId, threadId, messageId].every((part) => SNOWFLAKE.test(part))) return null;
  return { channelId, threadId, messageId };
}

/** The channel a message of an address sits in. */
function homeOf(at: DiscordAddress): string {
  return at.messageId === at.threadId ? at.channelId : at.threadId;
}

/** What a person is called where they spoke: their server nickname, their display name, or
 * their username. */
function displayName(user: DiscordUser, member?: { nick?: string | null }): string {
  return member?.nick || user.member?.nick || user.global_name || user.username || user.id;
}

/** The text with every mention of the bot removed — `<@id>`, the legacy `<@!id>`, and its
 * managed role's `<@&role>` when it has one (Discord's @-autocomplete offers the role beside the
 * bot, and people pick either). Nobody else's is touched. */
export function stripBotMention(text: string, botId: string, roleId: string | null = null): string {
  const role = roleId === null ? "" : `|<@&${roleId}>`;
  return text.replace(new RegExp(`(?:<@!?${botId}>${role})[ \\t]*`, "g"), "").trim();
}

/**
 * Discord's markup as the author saw it: a person's reference named, a custom emoji its
 * `:name:`. Discord stores what an author typed with ids where the client showed names, and
 * leaving the wire form would hand the agent identifiers where there were words. Role and
 * channel references keep their ids — naming them costs a call per mention for no gain in
 * meaning. The Markdown around them is the author's and is not touched.
 */
export function renderDiscordText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@!?(\d+)>/g, (_whole, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<a?:(\w+):\d+>/g, (_whole, name: string) => `:${name}:`);
}

/** The people a message references, by id — Discord sends them with it. */
function namesOf(message: DiscordMessage): Map<string, string> {
  return new Map((message.mentions ?? []).map((user) => [user.id, displayName(user)]));
}

/** Whether a message is for the bot: it names it or its managed role, or replies to one of its
 * messages (Telegram's rule — a reply with the ping turned off names nobody, and is still
 * plainly addressed). An `@everyone` is not a mention of the bot, as a Zulip wildcard is not. */
function addressesBot(message: DiscordMessage, botId: string, roleId: string | null): boolean {
  return (message.mentions ?? []).some((user) => user.id === botId) ||
    (roleId !== null && (message.mention_roles ?? []).includes(roleId)) ||
    message.referenced_message?.author?.id === botId;
}

/** A thread's name from words: on one line, bounded, never half a character; Discord refuses an
 * empty name, so nothing becomes FALLBACK_THREAD_NAME. */
export function threadName(words: string): string {
  const line = words.replace(/\s+/g, " ").trim();
  if (line === "") return FALLBACK_THREAD_NAME;
  return line.length > THREAD_NAME_MAX ? `${cut(line, THREAD_NAME_MAX - 1)}…` : line;
}

/** A thread's name from the message it starts from: its words, the bot's mention gone. */
function threadNameFrom(message: DiscordMessage, botId: string, roleId: string | null): string {
  return threadName(
    renderDiscordText(stripBotMention(message.content ?? "", botId, roleId), namesOf(message)),
  );
}

/**
 * A channel is private when the server's `@everyone` role (whose id is the server's) is denied
 * View Channel there. A channel synced to its category carries the category's overwrites as its
 * own, so a private category's channels read private too. Deliberately not a permission engine:
 * a server whose `@everyone` cannot see ANY channel, and whose roles grant it, reads every channel
 * as public — which errs the safe way: public repositories only, no response bound there, no
 * steering from it. "Private" here is what Discord's own Private Channel switch sets.
 */
function visibilityOf(channel: DiscordChannel, guildId: string): ChatChannel["visibility"] {
  const everyone = (channel.permission_overwrites ?? []).find((o) =>
    o.id === guildId && o.type === 0
  );
  if (everyone === undefined) return "public";
  try {
    return (BigInt(everyone.deny ?? "0") & VIEW_CHANNEL) !== 0n ? "private" : "public";
  } catch {
    return "public";
  }
}

const toChannel = (channel: DiscordChannel, guildId: string): ChatChannel => ({
  id: channel.id,
  name: channel.name ?? channel.id,
  visibility: visibilityOf(channel, guildId),
});

/** Discord's own media hosts, where a message's attachments live. */
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** The default dialer: a real WebSocket, its events funnelled into the handlers. */
const webSocketDialer: DiscordDialer = (url, handlers) => {
  const socket = new WebSocket(url);
  let ended = false;
  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    handlers.closed(code, reason);
  };
  socket.onmessage = (event) => handlers.message(String(event.data));
  socket.onclose = (event) => end(event.code, event.reason);
  socket.onerror = () => end(1006, "the socket failed");
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: (code) => {
      try {
        socket.close(code);
      } catch {
        end(code, "closed");
      }
    },
  };
};

/**
 * The Discord adapter, ready to serve any number of rooms: the credential rides in every call,
 * and the only thing kept between them is one Gateway connection per room, with its session.
 * Build one per process and hand it to the chat service.
 *
 * @example
 * ```ts
 * const chat = setup({ transports: { telegram, zulip, slack, discord: discordTransport() }, … });
 * ```
 *
 * @throws {DiscordError} from any call Discord refused, naming the call and Discord's own error
 * code — never the token. `whoAmI` throws a `CredentialRefusedError` naming the fix when the
 * credential is not a bot's, the bot is not in the server, its Message Content intent is off, or
 * it is public, so a room that could never hear anything — or would hear strangers — is refused
 * at creation rather than at the first mention.
 */
export function discordTransport(opts: DiscordTransportOptions = {}): ChatTransport {
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const fetcher = opts.fetch ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const dial = opts.dial ?? webSocketDialer;
  const clock = opts.now ?? (() => Date.now());
  const jitter = opts.jitter ?? Math.random;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  /** A stand-in API (the playground's, a test's) serves its socket and its files from its own
   * host; Discord's own serves them from `discord.gg` and its CDN. */
  const standIn = opts.apiUrl === undefined ? null : new URL(apiUrl);
  /** One socket per room. The credential is not in here — the room's id is the key. */
  const connections = new Map<string, Connection>();
  /** Rooms not dialled, and why: a close no reconnect fixes (held until the room stops being
   * polled or the process restarts — `until` null — or, for DISALLOWED_INTENTS, until the next
   * read of the application's flags at `recheckAt` finds the intent on), or an identify budget run
   * low (held until Discord's own reset). Every poll of a held room throws its error. */
  const holds = new Map<
    string,
    { error: Error; until: number | null; recheckAt: number | null }
  >();
  /** When each BOT last sent an IDENTIFY (IDENTIFY_GAP_MS). By bot, not by room: the budget is
   * the token's, and a room archived and added again is a new room id on the same bot. */
  const identified = new Map<string, number>();
  /** Each room's dials in a row that have not reached READY/RESUMED (MAX_RESUME_TRIES,
   * MAX_SILENT_CONNECTS). Per room, not per connection: each dial is a new connection. */
  const unanswered = new Map<string, number>();
  /** Each room's bot's managed role — the one Discord made when the bot joined, which the
   * @-autocomplete offers beside the bot — or null for none. Read once per room; absent while
   * no read has succeeded. */
  const botRoles = new Map<string, string | null>();
  /** When each room last asked for its roles (ROLE_RETRY_MS). */
  const rolesAsked = new Map<string, number>();
  /** Channels and threads seen to be each room's own server's (`ours`). */
  const known = new Map<string, Set<string>>();

  const credOf = (credential: ChatCredential): DiscordCred => {
    if (credential.kind !== "discord") throw new Error("discord: not a Discord credential");
    return credential;
  };

  /** Whether the bot token may go to this Gateway address: Discord's own, over TLS — or the
   * stand-in's host, when there is one. */
  const gatewayAllowed = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.username !== "" || u.password !== "") return false;
      if (
        standIn !== null && (u.protocol === "ws:" || u.protocol === "wss:") &&
        u.hostname === standIn.hostname
      ) return true;
      return u.protocol === "wss:" &&
        (u.hostname === "discord.gg" || u.hostname.endsWith(".discord.gg"));
    } catch {
      return false;
    }
  };

  /** Whether an attachment URL is one this adapter fetches: Discord's CDN over https, or the
   * stand-in's own host. No credential rides it either way — the URL is signed. */
  const fileAllowed = (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.username !== "" || u.password !== "") return false;
      if (standIn !== null && u.host === standIn.host) return true;
      return u.protocol === "https:" && u.port === "" && CDN_HOSTS.has(u.hostname);
    } catch {
      return false;
    }
  };

  /** A message's image attachments as sources, in order. The `content_type` is Discord's claim
   * and only picks what to fetch. */
  const imageAttachments = (attachments: DiscordAttachment[] | undefined): ImageSource[] => {
    const found: ImageSource[] = [];
    for (const file of attachments ?? []) {
      if (typeof file?.content_type !== "string" || !file.content_type.startsWith("image/")) {
        continue;
      }
      if (typeof file.url !== "string" || !fileAllowed(file.url)) continue;
      found.push({
        at: null,
        label: null,
        size: typeof file.size === "number" ? file.size : null,
        ref: { kind: "discord", url: file.url },
      });
    }
    return found;
  };

  /**
   * One REST call. A JSON body or a multipart form; a 204 answers null. A refusal is a
   * `DiscordError` naming the call and Discord's JSON error code — never the token, which rides
   * the `Authorization` header. A 429 is waited out in place, as long as Discord asked
   * (`retry_after`, in seconds, per route or — `global` — for the whole bot) and no longer than
   * `maxRetryAfterMs`, at most MAX_RATE_LIMIT_RETRIES times: a long post split into parts is the
   * one thing here that bumps a channel's posting limit, and it should land late, not fail.
   */
  const call = async <T>(
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: { json: unknown } | { form: FormData },
  ): Promise<T> => {
    const label = `discord ${method} ${path.split("?")[0]}`;
    for (let attempt = 0;; attempt++) {
      const signal = AbortSignal.timeout(
        body !== undefined && "form" in body ? downloadTimeoutMs : timeoutMs,
      );
      let res: Response;
      try {
        res = await fetcher(`${apiUrl}${path}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            ...(body !== undefined && "json" in body ? { "content-type": "application/json" } : {}),
          },
          ...(body === undefined
            ? {}
            : { body: "json" in body ? JSON.stringify(body.json) : body.form }),
          signal,
        });
      } catch (err) {
        throw new Error(`${label}: ${redactSecrets(errorText(err), [token])}`);
      }
      if (res.status === 204) {
        await res.body?.cancel().catch(() => {});
        return null as T;
      }
      const answer = await res.json().catch(() => null) as
        | { code?: unknown; message?: unknown; retry_after?: unknown; global?: unknown }
        | null;
      if (res.status === 429) {
        const after = Number(answer?.retry_after ?? res.headers.get("retry-after") ?? 1) * 1000;
        const scope = answer?.global === true ? " globally" : "";
        if (
          attempt < MAX_RATE_LIMIT_RETRIES && Number.isFinite(after) && after >= 0 &&
          after <= maxRetryAfterMs
        ) {
          await new Promise((resolve) => setTimeout(resolve, after));
          continue;
        }
        throw new DiscordError(429, null, `${label} answered 429: rate limited${scope}`);
      }
      if (!res.ok || answer === null) {
        const code = typeof answer?.code === "number" ? answer.code : null;
        const said = typeof answer?.message === "string" ? `: ${answer.message}` : "";
        throw new DiscordError(
          res.status,
          code,
          `${label} answered ${res.status}${said}${code === null ? "" : ` (${code})`}`,
        );
      }
      return answer as T;
    }
  };

  /** True for a refusal that means "no such thing, or not yours to see". */
  const missing = (err: unknown): boolean =>
    err instanceof DiscordError &&
    (err.status === 404 || err.status === 403 ||
      err.code === UNKNOWN_CHANNEL || err.code === UNKNOWN_MESSAGE ||
      err.code === MISSING_ACCESS);

  /** True for a refusal that means the thing is not there — NOT one that means the bot may not
   * read it (403), which a message read without Read Message History answers. */
  const gone = (err: unknown): boolean =>
    err instanceof DiscordError &&
    (err.status === 404 || err.code === UNKNOWN_CHANNEL || err.code === UNKNOWN_MESSAGE);

  /** True for a refusal that means the bot may not read the thing. */
  const forbidden = (err: unknown): boolean =>
    err instanceof DiscordError && (err.status === 403 || err.code === MISSING_ACCESS);

  /** The channel, or null when it is gone, out of the bot's sight, or ANOTHER server's: the bot
   * may sit in other servers, and nothing a key or a policy names may reach into one. */
  const channelOrNull = async (cred: DiscordCred, id: string): Promise<DiscordChannel | null> => {
    try {
      const channel = await call<DiscordChannel>(cred.botToken, "GET", `/channels/${id}`);
      return channel?.guild_id === cred.guildId ? channel : null;
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  };

  /** Whether a channel or thread is this room's server's: read once, then remembered — a channel
   * never moves between servers. */
  const ours = async (cred: DiscordCred, room: PlatformRoom, id: string): Promise<boolean> => {
    if (known.get(room.id)?.has(id)) return true;
    if (await channelOrNull(cred, id) === null) return false;
    remember(room, id);
    return true;
  };

  const remember = (room: PlatformRoom, id: string): void => {
    let set = known.get(room.id);
    if (set === undefined || set.size >= MAX_KNOWN_CHANNELS) known.set(room.id, set = new Set());
    set.add(id);
  };

  /** The message, or null when it is gone. A message the bot may not read throws: a 403 is not
   * "gone", and the caller says what it means. */
  const messageOrNull = async (
    cred: DiscordCred,
    channelId: string,
    messageId: string,
  ): Promise<DiscordMessage | null> => {
    try {
      return await call<DiscordMessage>(
        cred.botToken,
        "GET",
        `/channels/${channelId}/messages/${messageId}`,
      );
    } catch (err) {
      if (gone(err)) return null;
      throw err;
    }
  };

  /** One delivered mention in the port's shape; null for one nothing can serve. */
  const normalize = async (
    cred: DiscordCred,
    room: PlatformRoom,
    message: DiscordMessage,
  ): Promise<InboundMessage | null> => {
    const author = message.author;
    if (author === undefined || typeof message.id !== "string") return null;
    const raw = typeof message.content === "string" ? message.content : null;
    const sender = {
      id: author.id,
      name: displayName(author, message.member),
      isBot: author.bot === true || message.webhook_id !== undefined,
    };
    const common = {
      chatId: null,
      sender,
      rawText: raw,
      text: raw === null ? "" : renderDiscordText(
        stripBotMention(raw, room.bot.id, botRoles.get(room.id) ?? null),
        namesOf(message),
      ).trim(),
      hasAttachment: (message.attachments ?? []).length > 0,
      images: imageAttachments(message.attachments),
      mentionsBot: true,
      // Discord delivers nothing from a channel the bot cannot see.
      servable: true,
    };
    // A DM (none arrive without the DIRECT_MESSAGES intent, which is not asked for), or a bot —
    // which the service drops — is not worth a call to Discord.
    if (message.guild_id === undefined || sender.isBot) {
      return {
        ...common,
        messageId: `${message.channel_id}:${message.id}:${message.id}`,
        threadKey: `${message.channel_id}:${message.id}`,
        direct: message.guild_id === undefined,
        channel: { id: message.channel_id, name: message.channel_id, visibility: "private" },
        topic: null,
      };
    }
    // The channel is read live: its visibility decides what may be started from there. One that
    // is gone, or out of the bot's sight, is a mention nothing can serve, dropped rather than
    // left at the head of the queue holding back every mention behind it.
    const here = await channelOrNull(cred, message.channel_id);
    if (here === null) return null;
    let parent: DiscordChannel | null = here;
    let threadId = message.id;
    let topic: string | null = null;
    if (THREAD_TYPES.has(here.type)) {
      // Inside a thread: the conversation is the thread, its channel the parent — whose
      // visibility is the thread's, whatever kind of thread it is. A private thread in a public
      // channel is one anyone there could have made and filled, so it is not a closed room.
      parent = typeof here.parent_id === "string"
        ? await channelOrNull(cred, here.parent_id)
        : null;
      threadId = here.id;
      topic = here.name ?? null;
    } else {
      // A Discord Reply at the top of the channel to one of the bot's own posts there — a
      // response's opening line, which its thread hangs from — is about THAT conversation, not
      // the start of a new one: keyed as its thread, it reaches the run bound there rather than
      // hearing that none is running. (Its 👀 goes where it sits: `react` falls back to the
      // parent.)
      const ref = message.message_reference;
      if (
        typeof ref?.message_id === "string" && SNOWFLAKE.test(ref.message_id) &&
        (ref.channel_id === undefined || ref.channel_id === message.channel_id) &&
        message.referenced_message?.author?.id === room.bot.id
      ) threadId = ref.message_id;
    }
    if (parent === null || !TEXT_TYPES.has(parent.type)) return null;
    // Both were just read as this server's: the reply that follows need not ask again.
    remember(room, parent.id);
    remember(room, here.id);
    return {
      ...common,
      messageId: `${parent.id}:${threadId}:${message.id}`,
      threadKey: `${parent.id}:${threadId}`,
      direct: false,
      channel: toChannel(parent, cred.guildId),
      topic,
    };
  };

  const stopTimers = (conn: Connection): void => {
    if (conn.heartbeat !== null) clearTimeout(conn.heartbeat);
    conn.heartbeat = null;
    if (conn.handshake !== null) clearTimeout(conn.handshake);
    conn.handshake = null;
  };

  /** Closes the connection unless the handshake's next step arrives in time: a socket that
   * opened and went silent would otherwise be held — and polled — forever. */
  const expectWithin = (conn: Connection): void => {
    if (conn.handshake !== null) clearTimeout(conn.handshake);
    conn.handshake = setTimeout(() => {
      conn.handshake = null;
      conn.lastClose = "no answer in the handshake";
      shut(conn);
    }, handshakeTimeoutMs);
  };

  /** Stops a connection's heartbeat and closes its socket, resumably. */
  const shut = (conn: Connection): void => {
    stopTimers(conn);
    conn.closed = true;
    conn.socket?.close(RESUMABLE_CLOSE);
    conn.wake?.();
  };

  /** Closes a connection and forgets it: the next poll of that room opens a fresh one. */
  const drop = (roomId: string): void => {
    const conn = connections.get(roomId);
    if (conn === undefined) return;
    connections.delete(roomId);
    if (conn.onDrain !== null) conn.drainSignal?.removeEventListener("abort", conn.onDrain);
    shut(conn);
  };

  /** The session forgotten: the next connection identifies afresh. */
  const forgetSession = (conn: Connection): void => {
    conn.sessionId = null;
    conn.resumeUrl = null;
    conn.seq = null;
  };

  const sendFrame = (conn: Connection, frame: Record<string, unknown>): void => {
    conn.socket?.send(JSON.stringify(frame));
  };

  /** One heartbeat, and the next one scheduled — unless the last went unacknowledged, which is a
   * connection that stopped delivering without closing: closed resumably, and the next poll
   * resumes. */
  const beat = (conn: Connection, intervalMs: number): void => {
    if (conn.closed) return;
    if (conn.awaitingAck) {
      shut(conn);
      return;
    }
    conn.awaitingAck = true;
    sendFrame(conn, { op: 1, d: conn.seq });
    conn.heartbeat = setTimeout(() => beat(conn, intervalMs), intervalMs);
  };

  /** One frame off the socket. */
  const receive = (
    conn: Connection,
    room: PlatformRoom,
    cred: DiscordCred,
    text: string,
  ): void => {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (typeof frame.s === "number") conn.seq = frame.s;
    switch (frame.op) {
      case 10: {
        // HELLO: start the heartbeat, the first one jittered as Discord asks, and say who this
        // is — resuming the session when there is one to resume.
        const interval = Number((frame.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
        if (Number.isFinite(interval) && interval > 0) {
          if (conn.heartbeat !== null) clearTimeout(conn.heartbeat);
          conn.heartbeat = setTimeout(() => beat(conn, interval), interval * jitter());
        }
        // And READY or RESUMED must follow in time.
        expectWithin(conn);
        if (conn.sessionId !== null && conn.seq !== null) {
          sendFrame(conn, {
            op: 6,
            d: { token: cred.botToken, session_id: conn.sessionId, seq: conn.seq },
          });
        } else {
          identified.set(room.bot.id, clock());
          sendFrame(conn, {
            op: 2,
            d: {
              token: cred.botToken,
              intents: DISCORD_INTENTS,
              properties: { os: "linux", browser: "ryph", device: "ryph" },
            },
          });
        }
        return;
      }
      case 11:
        conn.awaitingAck = false;
        return;
      case 1:
        // Discord asks for a beat now.
        sendFrame(conn, { op: 1, d: conn.seq });
        return;
      case 7:
        // RECONNECT: Discord is moving this connection; the next poll resumes.
        shut(conn);
        return;
      case 9:
        // INVALID_SESSION: `d` says whether it can still be resumed. When it cannot, the next
        // connection identifies afresh — and what arrived in between is lost.
        if (frame.d !== true) forgetSession(conn);
        shut(conn);
        return;
      case 0:
        break;
      default:
        return;
    }
    if (frame.t === "READY" || frame.t === "RESUMED") {
      if (frame.t === "READY") {
        const ready = frame.d as { session_id?: unknown; resume_gateway_url?: unknown };
        conn.sessionId = typeof ready?.session_id === "string" ? ready.session_id : null;
        conn.resumeUrl = typeof ready?.resume_gateway_url === "string" &&
            gatewayAllowed(ready.resume_gateway_url)
          ? ready.resume_gateway_url
          : null;
      }
      // Serving: the handshake is over, and the run of dials that never got here with it.
      if (conn.handshake !== null) clearTimeout(conn.handshake);
      conn.handshake = null;
      conn.handshook = true;
      unanswered.delete(room.id);
      return;
    }
    if (frame.t !== "MESSAGE_CREATE") return;
    const message = frame.d as DiscordMessage;
    if (typeof message?.id !== "string" || typeof message.channel_id !== "string") return;
    // Another server the bot sits in is nobody's here.
    if (message.guild_id !== undefined && message.guild_id !== cred.guildId) return;
    if (message.author?.id === room.bot.id) return;
    // A pin, a join, a thread created: Discord talking about the channel, as `fetchThread`
    // reads them — never a person addressing the bot, even when it carries a reference to it.
    if (!SPOKEN_TYPES.has(message.type ?? 0)) return;
    if (conn.queue.length + conn.unsure.length >= MAX_QUEUED) return;
    const position = positionOf(conn.sessionId, conn.resumeUrl, conn.seq);
    if (!addressesBot(message, room.bot.id, botRoles.get(room.id) ?? null)) {
      // The bot's role is not known yet — its read failed — and this mentions SOME role: it may
      // be the bot's, and a Gateway event is never delivered twice, so it is kept aside until a
      // read says (`settleUnsure`). Nobody is woken for it: the read waits out its cooldown.
      if (!botRoles.has(room.id) && (message.mention_roles ?? []).length > 0) {
        conn.unsure.push({ message, position });
      }
      return;
    }
    conn.queue.push({ message, position });
    conn.wake?.();
  };

  /** A closed socket: the session kept for a resume, ended, or — for a close no reconnect fixes —
   * the room held until it changes. */
  const closed = (conn: Connection, roomId: string, code: number, reason: string): void => {
    stopTimers(conn);
    conn.closed = true;
    conn.lastClose ??= `closed ${code}${reason ? ` (${reason})` : ""}`;
    const fix = FATAL_CLOSES[code];
    if (fix !== undefined) {
      forgetSession(conn);
      conn.fatal = new DiscordError(
        0,
        code,
        `discord gateway closed ${code}${reason ? ` (${reason})` : ""}: ${fix}`,
      );
      // Only while this socket is still the room's: one already let go of (an archived room's)
      // must not hold the room's next life. The intent switched off is looked at again
      // (INTENT_RECHECK_MS); every other fatal close waits for the room to change.
      if (connections.get(roomId) === conn) {
        holds.set(roomId, {
          error: conn.fatal,
          until: null,
          recheckAt: code === DISALLOWED_INTENTS ? clock() + INTENT_RECHECK_MS : null,
        });
      }
    } else if (SESSION_ENDING_CLOSES.has(code)) {
      forgetSession(conn);
    }
    conn.wake?.();
  };

  /** The session a persisted position names: `<session id> <resume URL>`, at `offset`. */
  const sessionFrom = (
    position: PollPosition | null,
  ): { id: string; url: string; seq: number } | null => {
    const saved = position?.queueId ?? null;
    if (saved === null || position === null || position.offset <= 0) return null;
    const space = saved.indexOf(" ");
    if (space <= 0) return null;
    const url = saved.slice(space + 1);
    return gatewayAllowed(url) ? { id: saved.slice(0, space), url, seq: position.offset } : null;
  };

  const positionOf = (sessionId: string | null, resumeUrl: string | null, seq: number | null) =>
    sessionId === null || resumeUrl === null || seq === null
      ? { offset: 0, queueId: null, lastMessageId: null }
      : { offset: seq, queueId: `${sessionId} ${resumeUrl}`, lastMessageId: null };

  /** Whether the application's flags say the Message Content intent is on — `whoAmI`'s own test.
   * A failed read is a no: the room stays held, and asks again next time. */
  const messageContentOn = async (cred: DiscordCred): Promise<boolean> => {
    try {
      const app = await call<{ flags?: unknown }>(cred.botToken, "GET", "/applications/@me");
      return typeof app?.flags === "number" && (app.flags & MESSAGE_CONTENT_FLAGS) !== 0;
    } catch {
      return false;
    }
  };

  /**
   * The bot's managed role in the room's server, read — at most once per ROLE_RETRY_MS while the
   * reads keep failing — unless it is already known. Best-effort: a failed read leaves it
   * unknown, and what waits on it (`unsure`) keeps waiting; a read that finds no managed role is
   * as good an answer as one that finds it.
   */
  const learnRole = async (cred: DiscordCred, room: PlatformRoom): Promise<void> => {
    if (botRoles.has(room.id)) return;
    const asked = rolesAsked.get(room.id);
    if (asked !== undefined && clock() - asked < ROLE_RETRY_MS) return;
    rolesAsked.set(room.id, clock());
    try {
      const roles = await call<Array<{ id?: unknown; tags?: { bot_id?: unknown } }>>(
        cred.botToken,
        "GET",
        `/guilds/${cred.guildId}/roles`,
      ) ?? [];
      const role = roles.find((r) => r?.tags?.bot_id === room.bot.id);
      botRoles.set(room.id, typeof role?.id === "string" ? role.id : null);
    } catch {
      // Asked again after the cooldown, by the next dial or the next poll holding a mention of
      // some role.
    }
  };

  /**
   * The role mentions kept aside while the bot's role was unknown, decided once it is: the ones
   * of the bot's role join what this poll hands back — at `at`, the position the batch settles
   * at, never an earlier one: the cursor may already stand past where they arrived, and moving
   * it back would replay what was handled. The rest were someone else's role, and go. Still
   * unknown, they wait for the next read; a restart before then loses them, as it loses any
   * Gateway event past the resume window.
   */
  const settleUnsure = async (
    cred: DiscordCred,
    room: PlatformRoom,
    conn: Connection,
    at: PollPosition,
    updates: PollUpdate[],
  ): Promise<void> => {
    if (conn.unsure.length === 0 || !botRoles.has(room.id)) return;
    const role = botRoles.get(room.id) ?? null;
    while (conn.unsure.length > 0) {
      const next = conn.unsure[0];
      if (!addressesBot(next.message, room.bot.id, role)) {
        conn.unsure.shift();
        continue;
      }
      let message: InboundMessage | null;
      try {
        message = await normalize(cred, room, next.message);
      } catch (err) {
        if (updates.length === 0) throw err;
        return;
      }
      conn.unsure.shift();
      updates.push({ position: at, message });
    }
  };

  /** The room's connection, opened — resuming its session where there is one — if it has none or
   * lost the one it had. */
  const connect = async (
    room: PlatformRoom,
    cred: DiscordCred,
    position: PollPosition | null,
    signal: AbortSignal,
  ): Promise<Connection> => {
    const live = connections.get(room.id);
    if (live !== undefined && !live.closed) return live;
    if (signal.aborted) throw signal.reason;
    let session = live !== undefined
      ? (live.sessionId !== null && live.resumeUrl !== null && live.seq !== null
        ? { id: live.sessionId, url: live.resumeUrl, seq: live.seq }
        : null)
      : sessionFrom(position);
    if (session !== null && (unanswered.get(room.id) ?? 0) >= MAX_RESUME_TRIES) {
      // Resumed this many times in a row without Discord ever saying RESUMED: the resume URL
      // went stale or the session ended in a way no close code said. Forgotten — the connection
      // below identifies afresh, and the position it answers drops the session from the cursor.
      session = null;
    }
    let url: string;
    if (session !== null) {
      url = session.url;
    } else {
      const last = identified.get(room.bot.id);
      if (last !== undefined && clock() - last < IDENTIFY_GAP_MS) {
        throw new Error(
          "discord: this bot's Gateway identified moments ago and lost its session since; the " +
            "next identify waits (Discord resets a token that identifies 1 000 times a day)",
        );
      }
      const gateway = await call<{
        url?: unknown;
        session_start_limit?: { remaining?: unknown; reset_after?: unknown };
      }>(cred.botToken, "GET", "/gateway/bot");
      if (typeof gateway?.url !== "string" || !gatewayAllowed(gateway.url)) {
        throw new Error("discord GET /gateway/bot: the reply names no Gateway this may dial");
      }
      // Discord's own count of the day's identifies left, for the TOKEN — which is the room's
      // alone, one bot per room. Run low, the room waits for the reset rather than spend the
      // last of them and have Discord reset the token out from under it.
      const limit = gateway.session_start_limit;
      if (typeof limit?.remaining === "number" && limit.remaining < IDENTIFY_FLOOR) {
        const resetMs = typeof limit.reset_after === "number" && limit.reset_after > 0
          ? limit.reset_after
          : 60_000;
        const error = new Error(
          `discord: the bot has ${limit.remaining} Gateway identifies left today, and ryph ` +
            `keeps the last ${IDENTIFY_FLOOR} (Discord resets a token that spends them all); ` +
            `the room listens again when Discord's count resets, in ${
              Math.ceil(resetMs / 60_000)
            } min. Something is reconnecting this bot far too often — another process using ` +
            "the same token?",
        );
        holds.set(room.id, { error, until: clock() + resetMs, recheckAt: null });
        throw error;
      }
      url = gateway.url;
    }
    // Read before the socket hears anything, so a mention of the bot's role is known for one.
    // A read that fails leaves such mentions aside until a later one says (`settleUnsure`).
    await learnRole(cred, room);
    // Aborted while asking: nothing is dialled, so nothing is left open to leak.
    if (signal.aborted) throw signal.reason;
    // What the old connection delivered and nobody took yet comes along, each mention with the
    // position it arrived at.
    const carried = live?.queue ?? [];
    const carriedUnsure = live?.unsure ?? [];
    drop(room.id);
    const conn: Connection = {
      socket: null,
      queue: carried,
      unsure: carriedUnsure,
      seq: session?.seq ?? null,
      sessionId: session?.id ?? null,
      resumeUrl: session?.url ?? null,
      heartbeat: null,
      handshake: null,
      handshook: false,
      lastClose: null,
      awaitingAck: false,
      closed: false,
      fatal: null,
      wake: null,
      onDrain: null,
      drainSignal: null,
    };
    const dialled = new URL(url);
    dialled.searchParams.set("v", "10");
    dialled.searchParams.set("encoding", "json");
    unanswered.set(room.id, (unanswered.get(room.id) ?? 0) + 1);
    connections.set(room.id, conn);
    try {
      conn.socket = dial(dialled.href, {
        message: (text) => receive(conn, room, cred, text),
        closed: (code, reason) => closed(conn, room.id, code, reason),
      });
    } catch (err) {
      // A dial that threw left no socket: marked closed, so the next poll dials again — kept as
      // the room's, open, it would be waited on forever. What it carried stays queued on it.
      stopTimers(conn);
      conn.closed = true;
      conn.lastClose = `the dial failed: ${redactSecrets(errorText(err), [cred.botToken])}`;
      throw err;
    }
    // HELLO must come in time — unless the socket already ended, or (a dialer answering at once)
    // already finished its handshake, which no timer may close again.
    if (!conn.closed && !conn.handshook) expectWithin(conn);
    // The drain aborts every hold, and a socket left open afterwards would hold the process up.
    // It is closed resumably, so the next process picks the session up from the cursor.
    const onDrain = () => drop(room.id);
    conn.onDrain = onDrain;
    conn.drainSignal = signal;
    signal.addEventListener("abort", onDrain, { once: true });
    return conn;
  };

  /** Holds until a mention arrives, the socket ends, the hold runs out, or the caller aborts. */
  const hold = (conn: Connection, timeoutS: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        conn.wake = null;
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutS * 1000);
      conn.wake = done;
      signal.addEventListener("abort", done, { once: true });
    });

  /**
   * The thread a conversation key names, started from its message when it does not exist yet —
   * a mention at the top of a channel keys the thread its message would start, and nothing
   * starts it until the bot has something to say there. Named after the message's words — or
   * FALLBACK_THREAD_NAME when the bot may not read them (no Read Message History: the starting
   * itself does not need it). A thread someone else started from it in the meantime
   * (THREAD_ALREADY_CREATED) is simply used. Throws when the channel is not this server's, or the
   * message is gone: the conversation has nothing left to hang from.
   */
  const startThreadFrom = async (
    cred: DiscordCred,
    room: PlatformRoom,
    channelId: string,
    messageId: string,
  ): Promise<void> => {
    if (!await ours(cred, room, channelId)) {
      throw new DiscordError(404, UNKNOWN_CHANNEL, `discord: no channel ${channelId} here`);
    }
    let name = FALLBACK_THREAD_NAME;
    try {
      const starter = await messageOrNull(cred, channelId, messageId);
      if (starter === null) {
        throw new DiscordError(
          404,
          UNKNOWN_MESSAGE,
          "discord: the message this conversation starts from is gone",
        );
      }
      name = threadNameFrom(starter, room.bot.id, botRoles.get(room.id) ?? null);
    } catch (err) {
      if (!forbidden(err)) throw err;
    }
    try {
      await call(cred.botToken, "POST", `/channels/${channelId}/messages/${messageId}/threads`, {
        json: { name },
      });
    } catch (err) {
      if (!(err instanceof DiscordError) || err.code !== THREAD_ALREADY_CREATED) throw err;
    }
    // Started from a message in this server's channel: the thread is this server's.
    remember(room, messageId);
  };

  /** A message's body as a factory, so a retry after the thread was started sends a fresh one —
   * a multipart form is single-use. */
  type Body = () => { json: unknown } | { form: FormData };

  /**
   * One message into a conversation: at the channel (`topic` null), or into the thread — started
   * first when it does not exist yet (no such channel: a thread id that is still only a
   * message's). Never into a channel or thread of another server. A locked thread is a
   * `DiscordThreadLockedError`; an archived one that is not locked reopens on its own. Answers
   * the message Discord made.
   */
  const deliver = async (
    cred: DiscordCred,
    room: PlatformRoom,
    target: ConversationTarget,
    body: Body,
  ): Promise<DiscordMessage> => {
    const into = target.topic ?? target.channelId;
    const post = () =>
      call<DiscordMessage>(cred.botToken, "POST", `/channels/${into}/messages`, body());
    try {
      if (!await ours(cred, room, into)) {
        if (target.topic === null) {
          throw new DiscordError(404, UNKNOWN_CHANNEL, `discord: no channel ${into} here`);
        }
        // Not a thread yet — or another server's, whose id names no message in this parent, so
        // starting it fails rather than posting there.
        await startThreadFrom(cred, room, target.channelId, target.topic);
        return await post();
      }
      try {
        return await post();
      } catch (err) {
        if (
          target.topic === null || !(err instanceof DiscordError) ||
          err.code !== UNKNOWN_CHANNEL
        ) throw err;
      }
      await startThreadFrom(cred, room, target.channelId, target.topic);
      return await post();
    } catch (err) {
      if (err instanceof DiscordError && err.code === ARCHIVED_THREAD) {
        throw new DiscordThreadLockedError(
          `discord: the thread ${into} is archived and locked — a moderator must unlock it`,
        );
      }
      throw err;
    }
  };

  const jsonBody = (content: string): Body => () => ({
    json: { content, allowed_mentions: NO_MENTIONS, flags: SUPPRESS_EMBEDS },
  });

  /** The images as ryph links, in one message, when Discord will not take files from this bot. */
  const linkAll = async (
    room: PlatformRoom,
    target: ConversationTarget,
    images: OutboundImage[],
    reason: string,
  ): Promise<ImageDelivery[]> => {
    const lines = images.map((image) =>
      image.url === null
        ? null
        : `[${escapeReferences("discord", image.label.replace(/[[\]]/g, ""))}](<${image.url}>)`
    );
    const noLink: ImageDelivery = {
      kind: "failed",
      error: "Discord takes no files from this bot, and there is no ryph link to send instead",
    };
    const said = lines.filter((line): line is string => line !== null);
    if (said.length === 0) return images.map(() => noLink);
    try {
      await transport.send(room, target, cut(said.join("\n"), DISCORD_MAX_POST_CHARS));
    } catch (err) {
      return images.map(() => ({ kind: "failed", error: errorText(err) }));
    }
    return lines.map((line) => line === null ? noLink : { kind: "linked", reason });
  };

  /**
   * A thread's own messages, oldest first, read BACKWARDS from its newest through Discord's
   * pages: the bounds keep the newest, so the newest are what is read. Past the page budget the
   * oldest are the ones missing, and `truncated` says so.
   */
  const history = async (
    cred: DiscordCred,
    threadId: string,
  ): Promise<{ messages: DiscordMessage[]; truncated: boolean }> => {
    const newestFirst: DiscordMessage[] = [];
    let before: string | null = null;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const got: DiscordMessage[] = await call<DiscordMessage[]>(
        cred.botToken,
        "GET",
        `/channels/${threadId}/messages?limit=${HISTORY_PAGE}` +
          (before === null ? "" : `&before=${before}`),
      ) ?? [];
      newestFirst.push(...got);
      if (got.length < HISTORY_PAGE) return { messages: newestFirst.reverse(), truncated: false };
      before = got[got.length - 1].id;
    }
    return { messages: newestFirst.reverse(), truncated: true };
  };

  const transport: ChatTransport = {
    kind: "discord",
    // A Discord server is channels and threads; nothing about the room itself is a conversation.
    roomIsOneConversation: false,
    openTarget(channelId, topic) {
      // The opening line goes to the channel, and the thread started from it carries the name
      // the response asked for.
      return { channelId, topic: null, threadName: topic };
    },

    async whoAmI(credential): Promise<BotIdentity> {
      const cred = credOf(credential);
      const me = await call<{ id?: unknown; username?: unknown; bot?: unknown }>(
        cred.botToken,
        "GET",
        "/users/@me",
      );
      if (typeof me?.id !== "string" || typeof me.username !== "string") {
        throw new Error("discord GET /users/@me: the reply names no user");
      }
      // A person's own token would pass the call above; a room is a BOT, which the server can
      // see, restrict and kick as one.
      if (me.bot !== true) {
        throw new CredentialRefusedError(
          "That token is not a bot's. Copy the token under Bot in the Discord developer portal.",
        );
      }
      // The privileged intent the Gateway asks for: without it the Gateway closes 4014 and the
      // room hears nothing, so it is asked here, while someone is there to switch it on.
      const app = await call<{ flags?: unknown; bot_public?: unknown }>(
        cred.botToken,
        "GET",
        "/applications/@me",
      );
      if (typeof app?.flags !== "number" || (app.flags & MESSAGE_CONTENT_FLAGS) === 0) {
        throw new CredentialRefusedError(
          "The bot's Message Content intent is off. Turn it on under Bot → Privileged Gateway " +
            "Intents in the Discord developer portal.",
        );
      }
      // A public bot is one anyone may add to their own server — and every server it is in
      // streams its messages into this room's socket, pushing it toward the size where Discord
      // closes an unsharded connection (4011). Only the operator should ever invite it.
      if (app.bot_public === true) {
        throw new CredentialRefusedError(
          "The bot is public, so anyone could add it to their server. Turn Public Bot off under " +
            "Bot in the Discord developer portal.",
        );
      }
      let guild: { name?: unknown };
      try {
        guild = await call(cred.botToken, "GET", `/guilds/${cred.guildId}`);
      } catch (err) {
        if (missing(err)) {
          throw new CredentialRefusedError(
            `The bot is not in the server ${cred.guildId}. Invite it with the OAuth2 URL first.`,
          );
        }
        throw err;
      }
      return {
        id: me.id,
        name: me.username,
        title: typeof guild?.name === "string" ? guild.name : null,
      };
    },

    async poll(room, { position, timeoutS, signal }): Promise<PollBatch> {
      const cred = credOf(room.credential);
      const held = holds.get(room.id);
      if (held !== undefined) {
        if (held.recheckAt !== null) {
          // The intent switched off: still held until a read of the application's flags — due
          // every INTENT_RECHECK_MS, failed or not — finds it on. Lifted, the room dials as any
          // that lost its session: an IDENTIFY, behind the identify gap and the budget's floor.
          if (clock() < held.recheckAt) throw held.error;
          held.recheckAt = clock() + INTENT_RECHECK_MS;
          if (!await messageContentOn(cred)) throw held.error;
        } else if (held.until === null || clock() < held.until) throw held.error;
        holds.delete(room.id);
      }
      const conn = await connect(room, cred, position, signal);
      // A role mention kept aside waits for a read of the roles, at most once per cooldown.
      if (conn.unsure.length > 0) await learnRole(cred, room);
      const decidable = conn.unsure.length > 0 && botRoles.has(room.id);
      if (
        conn.queue.length === 0 && !decidable && timeoutS > 0 && !conn.closed && !signal.aborted
      ) {
        await hold(conn, timeoutS, signal);
      }
      // A mention leaves the queue only once it has been normalized, and normalizing calls
      // Discord: its channel is read live. A refused call must not take the queue with it — what
      // was read is returned, the rest keeps its place, and the next poll starts where this one
      // stopped. Each carries the session and sequence it arrived under, so the cursor saved
      // after it is where a resume would replay from.
      const updates: PollUpdate[] = [];
      while (conn.queue.length > 0) {
        const next = conn.queue[0];
        let message: InboundMessage | null;
        try {
          message = await normalize(cred, room, next.message);
        } catch (err) {
          if (updates.length === 0) throw err;
          break;
        }
        conn.queue.shift();
        updates.push({ position: next.position, message });
      }
      // Drained, the whole session is handled up to its latest sequence; stopped part-way, only
      // up to the last update handed back.
      const settled = conn.queue.length === 0
        ? positionOf(conn.sessionId, conn.resumeUrl, conn.seq)
        : updates.at(-1)?.position ?? position ?? positionOf(null, null, null);
      await settleUnsure(cred, room, conn, settled, updates);
      if (updates.length === 0 && conn.fatal !== null) throw conn.fatal;
      // A dial that ended without a handshake, after a run of them: said, so the poller logs it.
      // The next poll dials again — the poller's backoff spaces the tries. The words stay the
      // same from one failure to the next, so the poller warns once rather than on every retry;
      // how the last one ended rides along as the cause.
      const failing = unanswered.get(room.id) ?? 0;
      if (
        updates.length === 0 && conn.closed && !conn.handshook && failing >= MAX_SILENT_CONNECTS
      ) {
        throw new Error(
          `discord: the Gateway has not completed a handshake in ${MAX_SILENT_CONNECTS} or more ` +
            "dials in a row",
          { cause: conn.lastClose ?? "closed" },
        );
      }
      return { updates, position: settled };
    },

    releaseAllBut(polling) {
      for (const id of connections.keys()) {
        if (polling.has(id)) continue;
        drop(id);
        // The channels it learned go with the connection. Only then: a replica that merely
        // posts for a room another one polls never held its connection, and keeps what it
        // learned rather than reading every channel again on each pass.
        known.delete(id);
      }
      // A room no longer polled — archived, or another poller's — leaves its holds and what its
      // Gateway learned behind; taken back, it starts clean.
      for (const map of [holds, unanswered, botRoles, rolesAsked]) {
        for (const id of map.keys()) {
          if (!polling.has(id)) map.delete(id);
        }
      }
      // `identified` is by bot, so a room archived and added again on the same bot still waits
      // out the gap; an entry past the gap says nothing any more, and goes.
      for (const [bot, at] of identified) {
        if (clock() - at >= IDENTIFY_GAP_MS) identified.delete(bot);
      }
    },

    locate(_room, messageId): Promise<Located | null> {
      const at = parseDiscordAddress(messageId);
      // A thread never leaves its parent, so the key is the whole answer; the channel's name
      // costs a call and matching needs only ids.
      return Promise.resolve(
        at === null ? null : { channel: { id: at.channelId, name: "" }, topic: at.threadId },
      );
    },

    async fetchThread(room, threadKey): Promise<ChatThread | null> {
      const cred = credOf(room.credential);
      const at = parseDiscordAddress(threadKey);
      if (at === null) return null;
      const parent = await channelOrNull(cred, at.channelId);
      if (parent === null) return null;
      // The thread, when it exists: a mention at the top of a channel keys one that may not yet,
      // and a thread under some other channel is not this key's.
      let thread = await channelOrNull(cred, at.threadId);
      if (thread !== null && (!THREAD_TYPES.has(thread.type) || thread.parent_id !== parent.id)) {
        thread = null;
      }
      // The message it starts from sits in the parent. A thread started without one (the
      // client's "Create Thread" button) has none, and is its own messages alone. A bot without
      // Read Message History is refused that read (403) — and handed an EMPTY page for the
      // thread's, not a refusal — so the conversation is there, its past hidden from the bot.
      let starter: DiscordMessage | null = null;
      let hidden = false;
      try {
        starter = await messageOrNull(cred, parent.id, at.threadId);
      } catch (err) {
        if (!forbidden(err)) throw err;
        hidden = true;
      }
      if (thread === null && starter === null && !hidden) return null;
      const read = thread === null ? { messages: [], truncated: false } : await history(
        cred,
        thread.id,
      );
      const all = [...(starter === null ? [] : [starter]), ...read.messages];
      let truncated = read.truncated;
      const kept: ChatThread["messages"] = [];
      let chars = 0;
      // Newest first, so the bounds drop the OLDEST.
      for (const message of all.reverse()) {
        if (message.type !== undefined && !SPOKEN_TYPES.has(message.type)) continue;
        if (kept.length >= THREAD_MAX_MESSAGES) {
          truncated = true;
          break;
        }
        const raw = message.content ?? "";
        chars += raw.length;
        if (chars > THREAD_MAX_CHARS) {
          truncated = true;
          break;
        }
        const author = message.author ?? { id: "unknown", username: "someone" };
        kept.push({
          id: `${parent.id}:${at.threadId}:${message.id}`,
          sender: { id: author.id, name: displayName(author, message.member) },
          text: renderDiscordText(raw, namesOf(message)),
          sentAt: message.timestamp ?? new Date(0).toISOString(),
          hasAttachment: (message.attachments ?? []).length > 0,
        });
      }
      return {
        channel: toChannel(parent, cred.guildId),
        topic: thread?.name ?? null,
        messages: kept.reverse(),
        truncated,
        // Read Message History shows a channel's whole past to whoever holds it. A bot without
        // it reads nothing of it — Discord answers its thread pages empty — so the agent is told
        // the beginning may be missing, rather than handed silence as the whole conversation.
        historyLimited: hidden,
      };
    },

    async send(room, target, text) {
      const cred = credOf(room.credential);
      const posted = await deliver(cred, room, target, jsonBody(text));
      if (typeof posted?.id !== "string") {
        throw new Error("discord POST /channels/messages: the reply names no message");
      }
      if (target.topic !== null) return `${target.channelId}:${target.topic}`;
      // At the channel: the post is a conversation's root, and keys it — its thread, when one is
      // started from it, takes its id.
      if (target.threadName !== undefined) {
        try {
          await call(
            cred.botToken,
            "POST",
            `/channels/${target.channelId}/messages/${posted.id}/threads`,
            { json: { name: threadName(target.threadName) } },
          );
          remember(room, posted.id);
        } catch (err) {
          // A conversation the platform opens is the post AND its thread: a post left at the top
          // of the channel saying a run is on it, with no run bound to it, would mislead.
          await call(
            cred.botToken,
            "DELETE",
            `/channels/${target.channelId}/messages/${posted.id}`,
          ).catch(() => {});
          throw err;
        }
      }
      return `${target.channelId}:${posted.id}`;
    },

    async sendImages(room, target, images): Promise<ImageDelivery[]> {
      const cred = credOf(room.credential);
      const answers: ImageDelivery[] = images.map(() => ({ kind: "failed", error: "not sent" }));
      for (let start = 0; start < images.length; start += MAX_FILES_PER_MESSAGE) {
        const batch = images.slice(start, start + MAX_FILES_PER_MESSAGE);
        const loaded: Array<
          { index: number; image: OutboundImage; bytes: Uint8Array<ArrayBuffer> }
        > = [];
        for (const [offset, image] of batch.entries()) {
          try {
            loaded.push({ index: start + offset, image, bytes: await image.load() });
          } catch (err) {
            answers[start + offset] = { kind: "failed", error: errorText(err) };
          }
        }
        if (loaded.length === 0) continue;
        const caption = cut(
          escapeReferences("discord", loaded.map(({ image }) => image.label).join("\n")),
          DISCORD_MAX_POST_CHARS,
        );
        const body: Body = () => {
          const form = new FormData();
          form.set(
            "payload_json",
            JSON.stringify({
              content: caption,
              allowed_mentions: NO_MENTIONS,
              attachments: loaded.map(({ image, index }, n) => ({
                id: n,
                filename: imageFileName(index + 1, image.mime),
                description: cut(image.label, MAX_ALT_TEXT),
              })),
            }),
          );
          loaded.forEach(({ image, index, bytes }, n) => {
            form.set(
              `files[${n}]`,
              new Blob([bytes], { type: image.mime }),
              imageFileName(index + 1, image.mime),
            );
          });
          return { form };
        };
        try {
          await deliver(cred, room, target, body);
          for (const { index } of loaded) answers[index] = { kind: "uploaded" };
        } catch (err) {
          // No Attach Files: nothing of this post went up, nor will any after it, so every image
          // from here on goes as its link. The posts before it did land, and keep their answers.
          if (err instanceof DiscordError && err.code === MISSING_PERMISSIONS) {
            const linked = await linkAll(room, target, images.slice(start), "missing_permissions");
            linked.forEach((answer, n) => answers[start + n] = answer);
            return answers;
          }
          for (const { index } of loaded) {
            answers[index] = { kind: "failed", error: errorText(err) };
          }
        }
      }
      return answers;
    },

    async react(room, messageId) {
      const at = parseDiscordAddress(messageId);
      if (at === null) return;
      const token = credOf(room.credential).botToken;
      // 👀, URL-encoded; putting the same reaction twice is a 204 both times.
      const put = (channelId: string) =>
        call(
          token,
          "PUT",
          `/channels/${channelId}/messages/${at.messageId}/reactions/%F0%9F%91%80/@me`,
        );
      try {
        await put(homeOf(at));
      } catch (err) {
        // A Reply at the top of the channel keyed to the thread of the bot post it answers sits
        // in the PARENT, not in that thread.
        if (at.messageId === at.threadId || !gone(err)) throw err;
        await put(at.channelId);
      }
    },

    async retract(room, key) {
      const at = parseDiscordAddress(key);
      if (at === null) return;
      // The bot's own post, so Manage Messages is not needed. A thread started from it stays —
      // removing one takes Manage Threads, which the bot is not asked for — holding at most the
      // parts that landed before the one that failed.
      await call(
        credOf(room.credential).botToken,
        "DELETE",
        `/channels/${homeOf(at)}/messages/${at.messageId}`,
      );
    },

    async checkMembership(room, groupId, userId): Promise<CommanderVerdict> {
      if (!SNOWFLAKE.test(groupId) || !SNOWFLAKE.test(userId)) return "unknown";
      try {
        const cred = credOf(room.credential);
        const member = await call<{ roles?: unknown }>(
          cred.botToken,
          "GET",
          `/guilds/${cred.guildId}/members/${userId}`,
        );
        if (!Array.isArray(member?.roles)) return "unknown";
        return member.roles.includes(groupId) ? "allowed" : "denied";
      } catch {
        // Down, a revoked token, a person who left the server: never read as a yes.
        return "unknown";
      }
    },

    /**
     * The server's text and announcement channels — every one, including those the bot cannot
     * see: Discord describes a server's channels to any member, and working out what THIS bot
     * may see is a permission engine this adapter does not carry. A channel the bot cannot see
     * delivers it nothing, and a response bound there is refused when its opening post is.
     * Discord answers the whole list in one call, so it is never partial.
     */
    async listChannels(room): Promise<ChannelList> {
      const cred = credOf(room.credential);
      const channels = await call<DiscordChannel[]>(
        cred.botToken,
        "GET",
        `/guilds/${cred.guildId}/channels`,
      ) ?? [];
      return {
        channels: channels
          .filter((channel) => TEXT_TYPES.has(channel.type))
          .map((channel) => toChannel(channel, cred.guildId))
          .sort((a, b) => a.name.localeCompare(b.name)),
        truncated: false,
      };
    },

    /** The server's roles, as the groups a commander policy names: all but `@everyone` (whose
     * id is the server's, and which everyone holds) and the roles an integration manages — a
     * bot's own role is no team. */
    async listGroups(room): Promise<ChatGroup[]> {
      const cred = credOf(room.credential);
      const roles = await call<Array<{ id: string; name?: string; managed?: boolean }>>(
        cred.botToken,
        "GET",
        `/guilds/${cred.guildId}/roles`,
      ) ?? [];
      return roles
        .filter((role) => role.id !== cred.guildId && role.managed !== true)
        .map((role) => ({ id: role.id, name: `@${role.name ?? role.id}`, description: "" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    maxMessageLength() {
      return Promise.resolve(DISCORD_MAX_POST_CHARS);
    },

    async downloadImage(_room, source, { maxBytes, signal }) {
      if (source.ref.kind !== "discord" || !fileAllowed(source.ref.url)) {
        return { kind: "failed", error: "discord: not a Discord attachment" };
      }
      // No credential: the CDN URL is signed, and the token must not travel there. Redirects
      // are followed by hand, each hop's host checked as the first was: fetch's own following
      // would take a CDN answer pointing anywhere — the control plane's network included.
      const hop: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        let url = String(input);
        for (let hops = 0;; hops++) {
          const res = await fetcher(url, { ...init, redirect: "manual" });
          const location = res.headers.get("location");
          if (res.status < 300 || res.status >= 400 || location === null) return res;
          await res.body?.cancel().catch(() => {});
          const next = new URL(location, url).href;
          if (hops >= MAX_FILE_REDIRECTS || !fileAllowed(next)) {
            throw new Error("redirected off Discord's CDN");
          }
          url = next;
        }
      }) as typeof fetch;
      return await downloadCapped(
        hop,
        source.ref.url,
        { method: "GET" },
        { label: "discord file download", maxBytes, timeoutMs: downloadTimeoutMs, signal },
      );
    },
  };
  return transport;
}
