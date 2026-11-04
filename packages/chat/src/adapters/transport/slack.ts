// `ChatTransport` over Slack: the Web API with a bot token (`xoxb-…`) for everything the service
// reads and says, and SOCKET MODE with an app-level token (`xapp-…`) for everything it hears.
//
// Hearing: `apps.connections.open` answers a single-use WebSocket URL, and the app's events
// arrive down that socket as envelopes. Socket Mode rather than the Events API because this
// service has no public ingress by design — the same reason Telegram is long-polled and Zulip
// works off an events queue — so a Slack room works on a laptop and on the homelab with nothing
// published. The cost is stated plainly, because it is the one place Slack is weaker than the
// other two: AN ENVELOPE IS ACKNOWLEDGED THE MOMENT IT ARRIVES, and Slack never offers it again.
// There is no cursor to resume from, so a process killed between the socket and the mention door
// loses that mention, and the person mentions again. The alternative — holding the
// acknowledgement until the door has answered — trips Slack's three-second deadline and floods
// the room with its retries, which is worse.
//
// Conversations: a Slack conversation is a THREAD, and a thread never leaves the channel it was
// made in, so a key locates itself: `<channel>:<ts>`, parsed, with no call at all. An inbound
// message carries a third part, its thread's root, because a reply's own timestamp does not name
// the thread it sits in and Slack offers no way to ask afterwards.
//
// Invariants:
// - only an `app_mention` is a mention. Slack delivers one only from a conversation the app is a
//   member of, so the bot must be invited to every channel it serves, public or private — and
//   nothing else said in those channels ever reaches this process.
// - a channel's visibility is read LIVE on every mention and never guessed: it decides what the
//   control plane may start from there, so a `conversations.info` Slack could not answer fails the
//   poll and the mention keeps its place. A channel that is GONE, or that the bot has been removed
//   from, answers a mention nothing can serve, and that one is dropped.
// - the socket is the one piece of state an adapter keeps, keyed by `PlatformRoom.id` and closed
//   when the caller's signal aborts or `releaseAllBut` says the room is no longer polled. A socket
//   left open would go on acknowledging events nobody in this process answers. It is also replaced
//   once it is MAX_CONNECTION_AGE_MS old, because a connection can stop delivering without ever
//   closing, and a room must not be able to go deaf for longer than that. The credential is not
//   kept.
// - text is Slack's own markup restored to what the author typed: the bot's mention removed, the
//   entity escapes decoded, references named. Nothing here renders mrkdwn, and nothing here
//   escapes: what the service hands `send` is already the text it means to post, escaped by the
//   service where it was not the service's own markup.
// - the credential rides a header, never a URL, and no error names it
//
// Images: a message's `files` that Slack says are images are fetched from their
// `url_private_download` with the bot token — which takes the `files:read` scope — for a mention
// that reaches the door. The token is only ever sent to Slack's own file host.
//
// A run's images go OUT through Slack's external upload: `files.getUploadURLExternal` per file,
// the bytes POSTed to the URL it answers (no token rides that request: the URL is the grant),
// then ONE `files.completeUploadExternal` sharing them all into the thread, in order, each
// titled with its label. That takes the `files:write` scope; an app installed without it is
// answered `missing_scope`, and the images go as ryph links in a message of their own instead —
// the one place this adapter composes markup, so it escapes the labels itself.

import type { ChatChannel, ChatGroup, ChatThread, CommanderVerdict } from "../../core/types.ts";
import { SLACK_MAX_POST_CHARS, THREAD_MAX_CHARS, THREAD_MAX_MESSAGES } from "../../core/types.ts";
import { imageFileName } from "../../core/agent_images.ts";
import { escapeReferences } from "../../core/service.ts";
import { downloadCapped, redactSecrets } from "../../helpers/download.ts";
import type {
  BotIdentity,
  ChannelList,
  ChatCredential,
  ChatTransport,
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

/**
 * A Socket Mode connection, as this adapter drives it: text frames out (the acknowledgements),
 * text frames in through the handlers it was opened with. A fake stands in for a real WebSocket
 * in tests, which is the only reason this is a seam.
 */
export interface SlackSocket {
  send(text: string): void;
  close(): void;
}

/** Opens one Socket Mode connection and reports what arrives on it. `closed` fires once, for a
 * socket the server ended, one that failed to open, and one this side closed. */
export type SlackDialer = (
  url: string,
  handlers: { message(text: string): void; closed(): void },
) => SlackSocket;

export interface SlackTransportOptions {
  /** The Web API origin; overridable for tests. */
  apiUrl?: string;
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request deadline. Nothing here long-polls: the socket does the waiting. */
  requestTimeoutMs?: number;
  /** Deadline for one image's download. */
  downloadTimeoutMs?: number;
  /** How long a user's display name and bot flag are trusted before they are asked again. */
  userTtlMs?: number;
  /** Opens the Socket Mode socket; a fake in tests. */
  dial?: SlackDialer;
  /** The clock, so a test can age the user cache or a connection. */
  now?: () => number;
}

const DEFAULT_API_URL = "https://slack.com/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;

/** The one host the bot token is sent to for a file: Slack's own. A `url_private_download`
 * naming anything else is not fetched. */
const FILES_HOST = "files.slack.com";
const DEFAULT_USER_TTL_MS = 10 * 60_000;

/**
 * How long one Socket Mode connection is used before it is replaced. A connection can stop
 * delivering without ever closing — a laptop that slept, a NAT that dropped the flow, a peer that
 * went away without a FIN — and the socket then sits ESTABLISHED and silent, taking no events and
 * firing no `close` for the adapter to react to. Slack rotates connections far sooner than this on
 * its own, so in a healthy process this bound is never what ends one; it exists so that a room
 * cannot go deaf for longer than this no matter what the network did.
 */
const MAX_CONNECTION_AGE_MS = 15 * 60_000;

/**
 * How many envelopes may wait to be drained. Past it the adapter stops ACKNOWLEDGING, which is
 * Slack's own back-pressure: an unacknowledged envelope is redelivered, so a burst outlives a
 * full queue instead of being dropped by it.
 */
const MAX_QUEUED = 1_000;

/** A 429 is the one refusal worth waiting out in place: Slack's method tiers are tight and its
 * `retry-after` is usually a second or two. One wait, and never a long one. */
const MAX_RETRY_AFTER_MS = 5_000;

/** Channels are listed a page at a time, at most this many pages. */
const LIST_PAGE = 200;
const LIST_MAX_PAGES = 10;

/** A thread is read forward a page at a time, at most this many pages; the newest
 * THREAD_MAX_MESSAGES of what they hold are kept. */
const REPLIES_PAGE = 200;
const REPLIES_MAX_PAGES = 10;

/** How many distinct people one message's `<@U…>` references are named for. Past it the ids
 * stand, which is worse to read and better than an unbounded fan-out of calls. */
const MAX_NAMED_MENTIONS = 20;

/** Slack has no position to resume from: the socket delivered what it delivered. */
const NO_POSITION: PollPosition = { offset: 0, queueId: null, lastMessageId: null };

/** Message subtypes that are Slack talking about the channel rather than anyone talking in it. */
const CHANNEL_NOTICES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
]);

/** Slack's word for "there is no such thing, or it is not yours to see" — the port's null. */
const MISSING_CODES = new Set([
  "channel_not_found",
  "message_not_found",
  "thread_not_found",
  "not_in_channel",
]);

/** Slack's own bound on a file's alt text (`alt_txt_too_large` past it). */
const MAX_ALT_TEXT = 1_000;

/** Slack's answer to a method the token lacks the scope for: `files:write`, for the images. */
const scopeMissing = (err: unknown): boolean =>
  err instanceof SlackError && err.code === "missing_scope";

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Slack's word for a user the workspace will not describe. An unknowable sender is not a
 * commander, so it is read as a bot — Zulip's rule, for Zulip's reason. */
const UNKNOWN_USER_CODES = new Set(["user_not_found", "users_not_found"]);

type SlackCred = Extract<ChatCredential, { kind: "slack" }>;

/** A refusal from Slack, with the `error` string it names. Slack answers most business refusals
 * as a 200 with `ok: false`, so the code is what matters and the status rarely does. */
export class SlackError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** A file on a message, as far as this adapter reads one. */
interface SlackFile {
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

/** Whether a file URL is on Slack's own file host, over https — where the token may go. */
function onFilesHost(url: string): boolean {
  try {
    const u = new URL(url);
    // `host`, not `hostname`: no other port. And no userinfo, which would only be there to make
    // the URL read as something it is not.
    return u.protocol === "https:" && u.host === FILES_HOST && u.username === "" &&
      u.password === "";
  } catch {
    return false;
  }
}

/**
 * The files of a message that Slack says are images, as sources, in order. The `mimetype` is
 * Slack's claim and only picks what to fetch; a file without a download URL on Slack's host — a
 * tombstone, one hidden by the plan's limits, an external link — is not one.
 */
export function imageFiles(files: unknown): ImageSource[] {
  if (!Array.isArray(files)) return [];
  const found: ImageSource[] = [];
  for (const file of files as SlackFile[]) {
    if (typeof file?.mimetype !== "string" || !file.mimetype.startsWith("image/")) continue;
    const url = file.url_private_download;
    if (typeof url !== "string" || !onFilesHost(url)) continue;
    found.push({
      at: null,
      label: null,
      size: typeof file.size === "number" ? file.size : null,
      ref: { kind: "slack", url },
    });
  }
  return found;
}

interface SlackEvent extends SlackMessage {
  channel: string;
  channel_type?: string;
}

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  /** Shared with another organization through Slack Connect, or invited to be. */
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
}

/** One envelope off the socket. `hello` and the acknowledgement-only frames carry no payload. */
interface SocketFrame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackEvent };
}

/** A live Socket Mode connection and what it has delivered but nobody has taken yet. */
interface Connection {
  socket: SlackSocket | null;
  queue: SlackEvent[];
  /** When it was dialed, against which its age is bound. */
  openedAt: number;
  /** Ends the poll that is holding for the next envelope. */
  wake: (() => void) | null;
  closed: boolean;
  /** The drain listener on the caller's signal, removed when the connection closes so a room
   * reconnecting for days does not pile them up. */
  onDrain: (() => void) | null;
  drainSignal: AbortSignal | null;
}

/** A Slack address: the channel, one message in it, and the conversation (thread) it belongs to.
 * A message that starts a thread is its own conversation and is written with two parts, which is
 * the form a BINDING's key takes; an inbound message adds its thread's root. */
export interface SlackAddress {
  channelId: string;
  ts: string;
  threadTs: string;
}

const ID = /^[A-Za-z0-9]+$/;
const TS = /^\d+\.\d+$/;

/** A key, parsed; null for anything that is not one — which is how a Telegram or Zulip key
 * reaching a Slack room becomes a refusal rather than a wrong post. */
export function parseAddress(key: string): SlackAddress | null {
  const parts = key.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const [channelId, ts, threadTs = ts] = parts;
  if (!ID.test(channelId) || !TS.test(ts) || !TS.test(threadTs)) return null;
  return { channelId, ts, threadTs };
}

/** The two-part form: a conversation's key. */
export function conversationKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text with every mention of the bot removed — `<@U…>`, and the legacy `<@U…|name>` some
 * older clients still send. Nobody else's mention is touched. */
export function stripBotMention(text: string, botId: string): string {
  const pattern = new RegExp(`<@${escapeRegExp(botId)}(?:\\|[^>]*)?>[ \\t]*`, "g");
  return text.replace(pattern, "").trim();
}

/** Every distinct person a message references, in the order they appear. */
function mentionedUsers(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/<@([A-Za-z0-9]+)(?:\|[^>]*)?>/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/**
 * Slack's markup as the author typed it: references named, escapes decoded. Slack rewrites what
 * someone types — `@alice` becomes `<@U012>`, a pasted link becomes `<https://…|label>` — so
 * leaving the wire form in place would hand the agent identifiers where there were words. The
 * mrkdwn around them is not touched: `*bold*` is what was typed.
 *
 * The escapes are decoded LAST, so a `&lt;` in the text cannot become a reference the pass above
 * would have unwrapped.
 */
export function renderSlackText(text: string, names: Map<string, string>): string {
  const unwrapped = text.replace(/<([^<>]*)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf("|");
    const head = bar === -1 ? inner : inner.slice(0, bar);
    const label = bar === -1 ? null : inner.slice(bar + 1);
    if (head.startsWith("@")) {
      const id = head.slice(1);
      return `@${label ?? names.get(id) ?? id}`;
    }
    if (head.startsWith("#")) return `#${label ?? head.slice(1)}`;
    if (head.startsWith("!")) {
      // `!subteam^S012`, `!date^…^fallback`, and the room-wide `!here`, `!channel`, `!everyone`.
      const word = head.slice(1).split("^")[0];
      return label ?? `@${word}`;
    }
    // A link: `url`, or `url|label`, where the label is what the author saw.
    return label === null || label === head ? head : `${label} (${head})`;
  });
  return unwrapped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The default dialer: a real WebSocket, with its events funnelled into the handlers. */
const webSocketDialer: SlackDialer = (url, handlers) => {
  const socket = new WebSocket(url);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    handlers.closed();
  };
  socket.onmessage = (event) => handlers.message(String(event.data));
  socket.onclose = end;
  socket.onerror = end;
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => {
      // A socket still connecting, or already closed, refuses the call in some runtimes; either
      // way it is on its way out and `closed` has fired or will.
      try {
        socket.close();
      } catch {
        end();
      }
    },
  };
};

/**
 * The Slack adapter, ready to serve any number of rooms: the credential rides in every call, and
 * the only thing kept between them is one Socket Mode connection per room. Build one per process
 * and hand it to the chat service.
 *
 * @example
 * ```ts
 * const chat = setup({ transports: { telegram, zulip, slack: slackTransport() }, … });
 * ```
 *
 * @throws {SlackError} from any call Slack refused, naming the method and Slack's own error code
 * — never the token. `whoAmI` throws a plain `Error` when the credential is not a bot's, or when
 * the app-level token cannot open a socket, so a room that could never hear anything is refused
 * at creation rather than at the first mention.
 */
export function slackTransport(opts: SlackTransportOptions = {}): ChatTransport {
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const fetcher = opts.fetch ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const userTtlMs = opts.userTtlMs ?? DEFAULT_USER_TTL_MS;
  const dial = opts.dial ?? webSocketDialer;
  const clock = opts.now ?? (() => Date.now());
  /** One socket per room. The credential is not in here — the room's id is the key. */
  const connections = new Map<string, Connection>();
  /** What the workspace said a person is called, and whether they are a bot. Not a secret, and
   * slow to change; keyed by the bot's id so two workspaces never share an entry. */
  const users = new Map<string, { name: string; isBot: boolean; at: number }>();

  const credOf = (credential: ChatCredential): SlackCred => {
    if (credential.kind !== "slack") throw new Error("slack: not a Slack credential");
    return credential;
  };

  /**
   * One Web API call, its parameters FORM-ENCODED. Slack takes JSON on some methods and only
   * `application/x-www-form-urlencoded` on others, and it does not refuse a body it cannot read:
   * it runs the method with no arguments at all. `users.info` then answers `user_not_found` for a
   * person who exists, which this adapter reads as a sender it cannot describe — and a mention
   * from an undescribable sender is dropped in silence. Form encoding is what every method
   * accepts, so it is what every call sends.
   *
   * A refusal is a `SlackError` naming the method and its `error` code — never the token, which
   * rides the authorization header. A 429 is waited out once, for as long as Slack asked and no
   * longer than MAX_RETRY_AFTER_MS.
   */
  const call = async <T>(
    token: string,
    method: string,
    params: Record<string, unknown> = {},
    signal: AbortSignal = AbortSignal.timeout(timeoutMs),
  ): Promise<T> => {
    const label = `slack ${method}`;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    for (let attempt = 0;; attempt++) {
      let res: Response;
      try {
        res = await fetcher(`${apiUrl}/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: form.toString(),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw signal.reason ?? err;
        // A header fetch refuses is quoted in its message, the token in it: never passed on.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${label}: ${redactSecrets(message, [token])}`);
      }
      if (res.status === 429 && attempt === 0) {
        await res.body?.cancel();
        const after = Number(res.headers.get("retry-after") ?? "1") * 1000;
        if (Number.isFinite(after) && after > 0 && after <= MAX_RETRY_AFTER_MS) {
          await new Promise((resolve) => setTimeout(resolve, after));
          continue;
        }
        throw new SlackError(429, "ratelimited", `${label} answered 429`);
      }
      const body = await res.json().catch(() => null) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || body === null || body.ok !== true) {
        throw new SlackError(
          res.status,
          body?.error ?? null,
          `${label} answered ${res.status}${body?.error ? `: ${body.error}` : ""}`,
        );
      }
      return body as T;
    }
  };

  /** True for a refusal that means "no such thing, or not yours to see". */
  const missing = (err: unknown): boolean =>
    err instanceof SlackError && err.code !== null && MISSING_CODES.has(err.code);

  /** The channel as the bot may see it. Throws when Slack would not say: visibility decides what
   * may be started from a channel, so it is never guessed. */
  const channelOf = async (cred: SlackCred, channelId: string): Promise<SlackChannel> => {
    const res = await call<{ channel: SlackChannel }>(cred.botToken, "conversations.info", {
      channel: channelId,
    });
    return res.channel;
  };

  /**
   * A channel is private only when it is a closed room of THIS workspace's own people. Slack
   * Connect shares a channel with another organization, which manages its own membership: people
   * can be added over there without anyone here doing anything, so the channel's members stop
   * being this workspace's allowlist — and four gates rest on that bit, the response bind,
   * room-scoped commanders, the public-repo rule at start, and steering. An externally shared
   * channel is therefore not private. `is_org_shared` is a share across workspaces of the SAME
   * Enterprise Grid organization, whose members are still this company's, and stays private.
   *
   * "Public" is the nearest thing the port can say about it, and it errs the safe way: public
   * repositories only, no response bound there, no steering from it.
   */
  const visibilityOf = (channel: SlackChannel): ChatChannel["visibility"] =>
    channel.is_private === true && channel.is_ext_shared !== true &&
      channel.is_pending_ext_shared !== true
      ? "private"
      : "public";

  const toChannel = (channel: SlackChannel): ChatChannel => ({
    id: channel.id,
    name: channel.name ?? channel.id,
    visibility: visibilityOf(channel),
  });

  /** What a person is called, and whether they are one. A user the workspace will not describe
   * is read as a bot; anything else Slack refuses throws. */
  const userOf = async (
    cred: SlackCred,
    room: PlatformRoom,
    userId: string,
  ): Promise<{ name: string; isBot: boolean }> => {
    const key = `${room.bot.id}:${userId}`;
    const known = users.get(key);
    if (known !== undefined && clock() - known.at < userTtlMs) {
      return { name: known.name, isBot: known.isBot };
    }
    let described: { name: string; isBot: boolean };
    try {
      const res = await call<{
        user: {
          name?: string;
          real_name?: string;
          is_bot?: boolean;
          profile?: { display_name?: string; real_name?: string };
        };
      }>(cred.botToken, "users.info", { user: userId });
      const user = res.user;
      described = {
        name: user.profile?.display_name || user.profile?.real_name || user.real_name ||
          user.name || userId,
        isBot: user.is_bot === true,
      };
    } catch (err) {
      if (err instanceof SlackError && err.code !== null && UNKNOWN_USER_CODES.has(err.code)) {
        return { name: userId, isBot: true };
      }
      throw err;
    }
    users.set(key, { ...described, at: clock() });
    return described;
  };

  /** The people a message references, named — at most MAX_NAMED_MENTIONS of them. */
  const namesIn = async (
    cred: SlackCred,
    room: PlatformRoom,
    raw: string,
  ): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    for (const id of mentionedUsers(raw).slice(0, MAX_NAMED_MENTIONS)) {
      names.set(id, (await userOf(cred, room, id)).name);
    }
    return names;
  };

  /** A mention's text as its author typed it: the bot's own mention gone, everyone else named.
   * A thread read keeps the bot's mentions — the bot's own posts are part of the evidence. */
  const readable = async (
    cred: SlackCred,
    room: PlatformRoom,
    raw: string,
  ): Promise<string> => {
    const stripped = stripBotMention(raw, room.bot.id);
    return renderSlackText(stripped, await namesIn(cred, room, stripped)).trim();
  };

  /** One delivered `app_mention` in the port's shape. */
  const normalize = async (
    cred: SlackCred,
    room: PlatformRoom,
    event: SlackEvent,
  ): Promise<InboundMessage | null> => {
    if (event.type !== "app_mention" || typeof event.ts !== "string") return null;
    const direct = event.channel_type === "im" || event.channel_type === "mpim";
    const threadTs = event.thread_ts ?? event.ts;
    const raw = typeof event.text === "string" ? event.text : null;
    const sender = event.user === undefined
      ? null
      : { id: event.user, ...(await userOf(cred, room, event.user)) };
    const isBot = event.bot_id !== undefined || sender === null || sender.isBot;
    // A DM is not a room conversation and a bot's mention is dropped, so neither is worth a call
    // to Slack; everything else has its channel read live, because its visibility decides what
    // the control plane may start from there.
    let channel: SlackChannel | null = null;
    if (!direct && !isBot) {
      try {
        channel = await channelOf(cred, event.channel);
      } catch (err) {
        // The channel is gone, or the bot is no longer in it. This mention can never be served —
        // not read, not answered — and no later poll would change that, so it is dropped rather
        // than left at the head of the queue holding back every mention behind it.
        if (missing(err)) return null;
        throw err;
      }
    }
    return {
      messageId: `${event.channel}:${event.ts}:${threadTs}`,
      threadKey: conversationKey(event.channel, threadTs),
      chatId: null,
      direct,
      channel: channel === null
        ? { id: event.channel, name: event.channel, visibility: "private" }
        : toChannel(channel),
      topic: null,
      sender: sender === null ? null : { id: sender.id, name: sender.name, isBot },
      rawText: raw,
      text: raw === null ? "" : await readable(cred, room, raw),
      hasAttachment: Array.isArray(event.files) && event.files.length > 0,
      images: imageFiles(event.files),
      // Slack delivers an `app_mention` only from a conversation the app is in, so anything that
      // arrives here is one the bot can read, react in and reply to.
      mentionsBot: true,
      servable: true,
    };
  };

  /** Closes a connection and forgets it: the next poll of that room opens a fresh one. */
  const drop = (roomId: string): void => {
    const conn = connections.get(roomId);
    if (conn === undefined) return;
    connections.delete(roomId);
    conn.closed = true;
    if (conn.onDrain !== null) conn.drainSignal?.removeEventListener("abort", conn.onDrain);
    conn.socket?.close();
    conn.wake?.();
  };

  /** One frame off the socket: acknowledged, then kept if it is a mention. */
  const receive = (conn: Connection, text: string): void => {
    let frame: SocketFrame;
    try {
      frame = JSON.parse(text) as SocketFrame;
    } catch {
      return;
    }
    if (frame.type === "disconnect") {
      // Slack rotates connections and says so before it closes one. The next poll reconnects.
      conn.closed = true;
      conn.socket?.close();
      conn.wake?.();
      return;
    }
    if (frame.type !== "events_api" || frame.envelope_id === undefined) return;
    // Back-pressure: past the cap the envelope is left UNACKNOWLEDGED on purpose, and Slack
    // offers it again once the queue has drained.
    if (conn.queue.length >= MAX_QUEUED) return;
    conn.socket?.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    const event = frame.payload?.event;
    if (event === undefined || event.type !== "app_mention") return;
    conn.queue.push(event);
    conn.wake?.();
  };

  /** The room's connection, opened if it has none or lost the one it had. */
  const connect = async (
    room: PlatformRoom,
    cred: SlackCred,
    signal: AbortSignal,
  ): Promise<Connection> => {
    const live = connections.get(room.id);
    if (live !== undefined && !live.closed && clock() - live.openedAt < MAX_CONNECTION_AGE_MS) {
      return live;
    }
    // The new socket is asked for BEFORE the old connection is let go of, because this call is
    // refusable: a 429 here with the old connection already dropped would take its queue with it,
    // and whatever that queue holds was ACKNOWLEDGED on arrival, so it is Slack's only copy of
    // those mentions. A throw leaves the old connection where the next poll will find it.
    const opened = await call<{ url?: unknown }>(cred.appToken, "apps.connections.open");
    if (typeof opened.url !== "string") {
      throw new Error("slack apps.connections.open: the reply names no socket URL");
    }
    // Read after the call, so anything the old socket took while it was in flight comes too.
    const carried = live?.queue ?? [];
    drop(room.id);
    const conn: Connection = {
      socket: null,
      queue: carried,
      openedAt: clock(),
      wake: null,
      closed: false,
      onDrain: null,
      drainSignal: null,
    };
    conn.socket = dial(opened.url, {
      message: (text) => receive(conn, text),
      closed: () => {
        conn.closed = true;
        conn.wake?.();
      },
    });
    connections.set(room.id, conn);
    // The drain aborts every hold, and a socket left open afterwards would hold the process up.
    if (!signal.aborted) {
      const onDrain = () => drop(room.id);
      conn.onDrain = onDrain;
      conn.drainSignal = signal;
      signal.addEventListener("abort", onDrain, { once: true });
    }
    return conn;
  };

  /** Holds until an envelope arrives, the socket ends, the hold runs out, or the caller aborts. */
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
   * A thread, oldest first, read FORWARD from its root through Slack's pages. Forward because the
   * root is the message the run was asked from, and the one page the evidence cannot do without;
   * past the page budget the NEWEST replies are the ones missing, and `truncated` says so. The
   * budget is REPLIES_MAX_PAGES × REPLIES_PAGE, which no real thread reaches. Null when the key's
   * message is gone or unreadable.
   */
  const replies = async (
    cred: SlackCred,
    at: SlackAddress,
  ): Promise<{ messages: SlackMessage[]; truncated: boolean } | null> => {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < REPLIES_MAX_PAGES; page++) {
      let res: {
        messages?: SlackMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      try {
        res = await call(cred.botToken, "conversations.replies", {
          channel: at.channelId,
          ts: at.threadTs,
          limit: REPLIES_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
      messages.push(...(res.messages ?? []));
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) return { messages, truncated };
      truncated = page === REPLIES_MAX_PAGES - 1;
    }
    return { messages, truncated };
  };

  /** The bytes to the URL `files.getUploadURLExternal` answered, raw. */
  const uploadTo = async (url: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> => {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(downloadTimeoutMs),
      });
    } catch (err) {
      throw new Error(`slack file upload: ${errorText(err)}`);
    }
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`slack file upload answered ${res.status}`);
  };

  /** The images as ryph links, in one message to the thread, when Slack will not take files. */
  const linkAll = async (
    room: PlatformRoom,
    target: { channelId: string; topic: string | null },
    images: OutboundImage[],
    reason: string,
  ): Promise<ImageDelivery[]> => {
    const lines = images.map((image) =>
      image.url === null ? null : `<${image.url}|${escapeReferences("slack", image.label)}>`
    );
    const noLink: ImageDelivery = {
      kind: "failed",
      error: "Slack takes no files from this app, and there is no ryph link to send instead",
    };
    const said = lines.filter((line): line is string => line !== null);
    if (said.length === 0) return images.map(() => noLink);
    try {
      await transport.send(room, target, said.join("\n"));
    } catch (err) {
      return images.map(() => ({ kind: "failed", error: errorText(err) }));
    }
    return lines.map((line) => line === null ? noLink : { kind: "linked", reason });
  };

  const transport: ChatTransport = {
    kind: "slack",
    // A Slack workspace is channels and threads; nothing about the room itself is a conversation.
    roomIsOneConversation: false,
    openTarget(channelId, _topic) {
      // A Slack thread has no name, so the topic a response policy asked for is not an address
      // here: the opening line goes to the channel, and the thread under it is the conversation.
      return { channelId, topic: null };
    },

    async whoAmI(credential): Promise<BotIdentity> {
      const cred = credOf(credential);
      const me = await call<{
        user_id?: unknown;
        user?: unknown;
        team?: unknown;
        bot_id?: unknown;
      }>(cred.botToken, "auth.test");
      if (typeof me.user_id !== "string" || typeof me.user !== "string") {
        throw new Error("slack auth.test: the reply names no bot user");
      }
      // A person's own user token would pass the call above; a room is an APP, whose bot token
      // the workspace can see and revoke as an app's.
      if (typeof me.bot_id !== "string") {
        throw new Error("slack auth.test: the credential is not a bot token");
      }
      // The app-level token is the poller's own half. A room created without checking it would
      // look healthy and hear nothing, so it is spent once here; the socket URL is discarded.
      await call(cred.appToken, "apps.connections.open");
      return {
        id: me.user_id,
        name: me.user,
        title: typeof me.team === "string" ? me.team : null,
      };
    },

    async poll(room, { timeoutS, signal }): Promise<PollBatch> {
      const cred = credOf(room.credential);
      const conn = await connect(room, cred, signal);
      if (conn.queue.length === 0 && timeoutS > 0 && !conn.closed && !signal.aborted) {
        await hold(conn, timeoutS, signal);
      }
      // An event leaves the queue only once it has been normalized, and normalizing calls Slack:
      // its channel is read live. There is no cursor to replay from — the envelope was
      // acknowledged the moment it arrived — so a refused call must not take the queue with it.
      // What was read is returned, the rest keeps its place, and the next poll starts where this
      // one stopped: a mention is answered late rather than never.
      const updates: PollUpdate[] = [];
      while (conn.queue.length > 0) {
        let message: InboundMessage | null;
        try {
          message = await normalize(cred, room, conn.queue[0]);
        } catch (err) {
          if (updates.length === 0) throw err;
          break;
        }
        conn.queue.shift();
        updates.push({ position: NO_POSITION, message });
      }
      return { updates, position: NO_POSITION };
    },

    releaseAllBut(polling) {
      for (const id of connections.keys()) {
        if (!polling.has(id)) drop(id);
      }
    },

    locate(_room, messageId): Promise<Located | null> {
      const at = parseAddress(messageId);
      // The channel's name costs a call and matching needs only ids, as on Zulip.
      return Promise.resolve(
        at === null ? null : { channel: { id: at.channelId, name: "" }, topic: at.threadTs },
      );
    },

    async fetchThread(room, threadKey): Promise<ChatThread | null> {
      const cred = credOf(room.credential);
      const at = parseAddress(threadKey);
      if (at === null) return null;
      let channel: SlackChannel;
      try {
        channel = await channelOf(cred, at.channelId);
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
      const read = await replies(cred, at);
      if (read === null) return null;
      let truncated = read.truncated;
      const kept: ChatThread["messages"] = [];
      let chars = 0;
      // Newest first, so the bounds drop the OLDEST.
      for (const message of [...read.messages].reverse()) {
        if (message.subtype !== undefined && CHANNEL_NOTICES.has(message.subtype)) continue;
        if (kept.length >= THREAD_MAX_MESSAGES) {
          truncated = true;
          break;
        }
        const raw = typeof message.text === "string" ? message.text : "";
        chars += raw.length;
        if (chars > THREAD_MAX_CHARS) {
          truncated = true;
          break;
        }
        const sender = message.user === undefined
          ? { id: message.bot_id ?? "app", name: message.bot_id ?? "an app" }
          : { id: message.user, name: (await userOf(cred, room, message.user)).name };
        kept.push({
          id: `${at.channelId}:${message.ts}`,
          sender,
          text: renderSlackText(raw, await namesIn(cred, room, raw)),
          sentAt: new Date(Number(message.ts) * 1000).toISOString(),
          hasAttachment: Array.isArray(message.files) && message.files.length > 0,
        });
      }
      return {
        channel: toChannel(channel),
        // A Slack conversation is a thread, which has no name of its own.
        topic: null,
        messages: kept.reverse(),
        truncated,
        // A member of a channel sees its whole history, so nothing is hidden from the bot that
        // is not hidden from everyone: a workspace plan that ages messages out has removed them.
        historyLimited: false,
      };
    },

    async send(room, target, text) {
      const res = await call<{ ts?: unknown; channel?: unknown }>(
        credOf(room.credential).botToken,
        "chat.postMessage",
        {
          channel: target.channelId,
          text,
          ...(target.topic === null ? {} : { thread_ts: target.topic }),
          // A run's posts carry patch and run links, and an unfurled preview of each would bury
          // the words; the app's own URLs need a session Slack does not have anyway.
          unfurl_links: false,
          unfurl_media: false,
        },
      );
      if (typeof res.ts !== "string") {
        throw new Error("slack chat.postMessage: the reply names no timestamp");
      }
      const channelId = typeof res.channel === "string" ? res.channel : target.channelId;
      return conversationKey(channelId, res.ts);
    },

    async retract(room, key) {
      const at = parseAddress(key);
      if (at === null) return;
      // The bot's own message, which `chat:write` may delete. Replies under it stay, shown
      // under "This message was deleted".
      await call(credOf(room.credential).botToken, "chat.delete", {
        channel: at.channelId,
        ts: at.ts,
      });
    },

    async sendImages(room, target, images): Promise<ImageDelivery[]> {
      const cred = credOf(room.credential);
      const answers: ImageDelivery[] = images.map(() => ({ kind: "failed", error: "not sent" }));
      const uploaded: Array<{ index: number; id: string; title: string }> = [];
      try {
        for (const [index, image] of images.entries()) {
          try {
            const bytes = await image.load();
            const ticket = await call<{ upload_url?: unknown; file_id?: unknown }>(
              cred.botToken,
              "files.getUploadURLExternal",
              {
                filename: imageFileName(index + 1, image.mime),
                length: bytes.byteLength,
                alt_txt: image.label.slice(0, MAX_ALT_TEXT),
              },
            );
            if (typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string") {
              throw new Error("slack files.getUploadURLExternal: the reply names no upload url");
            }
            await uploadTo(ticket.upload_url, bytes);
            uploaded.push({ index, id: ticket.file_id, title: image.label });
          } catch (err) {
            if (scopeMissing(err)) throw err;
            answers[index] = { kind: "failed", error: errorText(err) };
          }
        }
        if (uploaded.length > 0) {
          try {
            await call(cred.botToken, "files.completeUploadExternal", {
              files: uploaded.map(({ id, title }) => ({ id, title })),
              channel_id: target.channelId,
              ...(target.topic === null ? {} : { thread_ts: target.topic }),
            });
            for (const { index } of uploaded) answers[index] = { kind: "uploaded" };
          } catch (err) {
            if (scopeMissing(err)) throw err;
            for (const { index } of uploaded) {
              answers[index] = { kind: "failed", error: errorText(err) };
            }
          }
        }
        return answers;
      } catch (err) {
        // No `files:write`: nothing went up, so every image goes as its link.
        if (!scopeMissing(err)) throw err;
        return await linkAll(room, target, images, "missing_scope");
      }
    },

    async react(room, messageId) {
      const at = parseAddress(messageId);
      if (at === null) return;
      try {
        await call(credOf(room.credential).botToken, "reactions.add", {
          channel: at.channelId,
          timestamp: at.ts,
          name: "eyes",
        });
      } catch (err) {
        // The same message acknowledged twice — a redelivered envelope — is not a failure.
        if (err instanceof SlackError && err.code === "already_reacted") return;
        throw err;
      }
    },

    async checkMembership(room, groupId, userId): Promise<CommanderVerdict> {
      if (!ID.test(groupId) || !ID.test(userId)) return "unknown";
      try {
        const res = await call<{ users?: unknown }>(
          credOf(room.credential).botToken,
          "usergroups.users.list",
          { usergroup: groupId, include_disabled: false },
        );
        if (!Array.isArray(res.users)) return "unknown";
        return res.users.includes(userId) ? "allowed" : "denied";
      } catch {
        // Down, a revoked token, a group that no longer exists: never read as a yes.
        return "unknown";
      }
    },

    /**
     * The conversations the BOT is in, which is the only kind it can serve: Slack delivers an
     * `app_mention` only from a conversation the app is a member of, so a channel it has not been
     * invited to is an offer that could never work. `users.conversations` answers exactly those,
     * where `conversations.list` would walk every public channel in the workspace and bury them —
     * far enough, in a big workspace, that a private channel the bot IS in falls past the page
     * budget and a response policy naming it is refused.
     */
    async listChannels(room): Promise<ChannelList> {
      const cred = credOf(room.credential);
      const channels: ChatChannel[] = [];
      let cursor: string | undefined;
      let truncated = false;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const res = await call<{
          channels?: SlackChannel[];
          response_metadata?: { next_cursor?: string };
        }>(cred.botToken, "users.conversations", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: LIST_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const channel of res.channels ?? []) {
          if (channel.is_archived !== true) channels.push(toChannel(channel));
        }
        cursor = res.response_metadata?.next_cursor;
        if (!cursor) break;
        // A bot in more than the budget reads is a real bot, and the caller is told rather than
        // handed a list that looks complete.
        truncated = page === LIST_MAX_PAGES - 1;
      }
      return { channels: channels.sort((a, b) => a.name.localeCompare(b.name)), truncated };
    },

    async listGroups(room): Promise<ChatGroup[]> {
      try {
        const res = await call<{
          usergroups?: Array<{
            id: string;
            name?: string;
            handle?: string;
            description?: string;
            date_delete?: number;
          }>;
        }>(credOf(room.credential).botToken, "usergroups.list", { include_disabled: false });
        return (res.usergroups ?? [])
          .filter((group) => !group.date_delete)
          .map((group) => ({
            id: group.id,
            name: group.handle ? `@${group.handle}` : group.name ?? group.id,
            description: group.description ?? "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        // Usergroups are a paid-plan feature. A workspace without them has none, which is an
        // empty list and not a platform that failed to answer.
        if (err instanceof SlackError && err.code === "plan_upgrade_required") return [];
        throw err;
      }
    },

    maxMessageLength() {
      return Promise.resolve(SLACK_MAX_POST_CHARS);
    },

    async downloadImage(room, source, { maxBytes, signal }) {
      if (source.ref.kind !== "slack" || !onFilesHost(source.ref.url)) {
        return { kind: "failed", error: "slack: not a Slack file" };
      }
      return await downloadCapped(
        fetcher,
        source.ref.url,
        // A redirect off Slack's host drops the header, as fetch does across origins.
        { method: "GET", headers: { authorization: `Bearer ${credOf(room.credential).botToken}` } },
        { label: "slack file download", maxBytes, timeoutMs: downloadTimeoutMs, signal },
      );
    },
  };
  return transport;
}
