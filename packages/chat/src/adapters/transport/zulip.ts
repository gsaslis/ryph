// `ChatTransport` over Zulip's REST API — the bot's email and API key as HTTP basic auth, against
// the organization's own server. It leans on Zulip's behaviour as measured on Zulip 12.2
// (feature level 500).
//
// Hearing: an EVENTS QUEUE for `message` events, registered with the longest idle timeout the
// server allows (seven days) and long-polled. A generic bot subscribed to nothing still receives
// every message that mentions it in a public channel — Zulip adds directly mentioned bots to the
// recipients — so the privacy stance is a property of delivery: the rest of the conversation
// never reaches us. A queue can still vanish (a server restart, a deploy): it answers
// `BAD_EVENT_QUEUE_ID`, and the poller registers a new one and BACKFILLS from the last message
// it handled through the `is:mentioned` narrow. Message ids are monotonic, so that one integer
// is the whole replay guard, for the backfill and the new queue alike.
//
// Invariants:
// - only a message whose `flags` include `mentioned` is a mention: a silent mention, a wildcard
//   and a mention in a code block never carry it — the server's renderer judges, not us
// - text is raw markdown (`apply_markdown: false`) everywhere; nothing here renders or parses it
//   beyond removing the bot's own mention
// - a conversation is located by a message id on every read and post — a remembered topic name
//   would quietly recreate the old topic after a resolve
// - Zulip's system bots (the notification bot's "moved this topic", "marked as resolved") are
//   senders from the cross-realm `zulipinternal` realm; they are dropped from thread reads and
//   never count as mentions
// - the credential rides a header, never a URL, and no error names it
//
// Images: an upload is a link into the realm's upload store in the raw markdown,
// `[name.png](/user_uploads/<realm>/<path>)`. A link whose name says it is an image is fetched
// for a mention that reaches the door — through the temporary URL the API hands out for it
// (`GET /api/v1/user_uploads/{realm_id}/{path}`, Zulip 3.0), because `/user_uploads/` itself
// takes a browser session and not the bot's key — and the link is replaced by its marker where
// it sat. Any other upload stays the link it was. Only a link of Zulip's own upload shape is asked
// for, judged after decoding (`uploadPath`). The bot asks with its OWN access, which can be wider
// than the sender's — Zulip exposes nothing that ties an upload to who may read it; the README's
// Images section has the residual risk.
//
// A run's images go out as uploads into the realm (`POST /api/v1/user_uploads`, multipart) BEFORE
// the text that names them (`uploadImages`): each answers `[label](/user_uploads/…)`, which the
// service puts into the words where the run wrote the image, so the post is one message with its
// pictures in place — Zulip renders an image link to its own upload as the picture. An upload
// that fails leaves the label in the words and nothing that points at it. `sendImages`, the
// pictures as a message of their own after the text, is what is left for a text already out.

import type {
  ChannelVisibility,
  ChatGroup,
  ChatThread,
  CommanderVerdict,
} from "../../core/types.ts";
import { THREAD_MAX_CHARS, THREAD_MAX_MESSAGES } from "../../core/types.ts";
import { MAX_MENTION_IMAGES } from "../../core/types.ts";
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
  InlineUpload,
  Located,
  OutboundImage,
  PlatformRoom,
  PollBatch,
  PollPosition,
  PollUpdate,
} from "../../ports/transport.ts";

export interface ZulipTransportOptions {
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request deadline for the calls that do not long-poll. */
  requestTimeoutMs?: number;
  /** How long a server's limits are trusted before they are asked again. */
  limitsTtlMs?: number;
  /** Deadline for one image's download. */
  downloadTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;
const DEFAULT_LIMITS_TTL_MS = 60 * 60_000;

/** The longest a queue may sit idle, in seconds: Zulip 12.0's maximum (feature level 481). */
export const IDLE_QUEUE_TIMEOUT_S = 604_800;

/** The realm Zulip's system bots belong to (notification bot, welcome bot). */
export const SYSTEM_BOT_REALM = "zulipinternal";

/** A backfill reads this many mentions per page, and at most this many pages. */
const BACKFILL_PAGE = 100;
const BACKFILL_MAX_PAGES = 10;

type ZulipZ = Extract<ChatCredential, { kind: "zulip" }>;

interface ZulipMessage {
  id: number;
  type: "stream" | "private";
  sender_id: number;
  sender_full_name: string;
  sender_realm_str?: string;
  content: string;
  timestamp: number;
  stream_id?: number;
  display_recipient: string | unknown[];
  subject: string;
  flags?: string[];
}

interface ZulipStream {
  stream_id: number;
  name: string;
  invite_only: boolean;
  is_web_public: boolean;
  history_public_to_subscribers: boolean;
  is_archived?: boolean;
}

/** A refusal from the server, with its machine-readable `code` (`BAD_EVENT_QUEUE_ID`, …). */
export class ZulipError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ZulipError";
  }
  /** The server judged the request (4xx): asking again the same way will not change it. */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** A label as a link's text: the run's words, so its mentions silenced, and its brackets
 * escaped so they cannot close the link early. */
function linkText(label: string): string {
  // Zulip shows a backslash-escaped bracket in link text as the backslash and the bracket, so
  // brackets read as parentheses instead: the link stays whole, and a label opens with no
  // `[Name]` of its own. A backslash goes too: one at the end would escape the closing bracket.
  return escapeReferences("zulip", label).replaceAll("[", "(").replaceAll("]", ")")
    .replaceAll("\\", "/");
}

function basicAuth(email: string, key: string): string {
  const bytes = new TextEncoder().encode(`${email}:${key}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

function visibilityOf(stream: ZulipStream): ChannelVisibility {
  if (stream.invite_only) return "private";
  return stream.is_web_public ? "web-public" : "public";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text with every loud mention of the bot removed: `@**Name**` and `@**Name|id**` (any name
 * with the bot's id — the form the composer inserts when names collide). A silent mention
 * (`@_**Name**`) is not a mention and is left alone, as is anyone else's.
 */
export function stripBotMentions(content: string, bot: { id: string; name: string }): string {
  const pattern = new RegExp(
    `@\\*\\*(?:${escapeRegExp(bot.name)}|[^*|\\n]*\\|${escapeRegExp(bot.id)})\\*\\*[ \\t]*`,
    "gi",
  );
  return content.replace(pattern, "").trim();
}

/** An uploaded file shows up in raw markdown as a link into the server's upload store. */
function hasUpload(content: string): boolean {
  return content.includes("/user_uploads/");
}

/**
 * An upload's random part: `secrets.token_urlsafe(18)`, 24 URL-safe base64 characters, the same
 * for both of Zulip's storage backends (zerver/lib/upload/{local,s3}.py).
 */
const UPLOAD_TOKEN = /^[A-Za-z0-9_-]{24}$/;

/** The local backend's spreading directory, `format(random.randint(0, 255), "x")`. */
const UPLOAD_BUCKET = /^[0-9a-f]{1,2}$/;

/**
 * A file name as Zulip's `sanitize_name` leaves it: word characters (Unicode allowed), `.` and
 * `-`, with whitespace already turned into `-`. Nothing that could be a separator, an escape or
 * a query survives it, which is what lets the name be checked AFTER decoding.
 */
const UPLOAD_NAME = /^[\p{L}\p{M}\p{N}_.-]+$/u;

/**
 * An upload link's path as the one this adapter will ask for, or null for anything that is not
 * plainly an upload: `/user_uploads/<realm id>/[<bucket>/]<token>/<name>`, Zulip's own shape.
 *
 * Every segment is DECODED before it is judged and re-encoded after, so what is asked for is
 * exactly what was checked. Judging the encoded text is not enough: the URL parser the request
 * goes through reads `%2e%2e` as `..`, and a link like `/user_uploads/2/%2e%2e/%2e%2e/users/me`
 * would otherwise become an authenticated `GET /api/v1/users/me`. So a segment that decodes to
 * an encoded slash, a `%` (a second layer of encoding), a dot segment or nothing at all is no
 * upload, and neither is any path with more or fewer segments than Zulip writes.
 */
export function uploadPath(raw: string): string | null {
  const PREFIX = "/user_uploads/";
  if (!raw.startsWith(PREFIX)) return null;
  const segments: string[] = [];
  for (const encoded of raw.slice(PREFIX.length).split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    segments.push(decoded);
  }
  if (segments.length !== 3 && segments.length !== 4) return null;
  const [realm, ...rest] = segments;
  const name = rest.pop()!;
  const token = rest.pop()!;
  if (!/^\d{1,10}$/.test(realm)) return null;
  if (rest.length === 1 && !UPLOAD_BUCKET.test(rest[0])) return null;
  if (!UPLOAD_TOKEN.test(token)) return null;
  if (!UPLOAD_NAME.test(name) || /^\.+$/.test(name)) return null;
  return PREFIX + segments.map(encodeURIComponent).join("/");
}

/** The extensions an upload's name must end in for it to be worth fetching as an image. A name
 * only picks what to fetch; the bytes decide what it is. */
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * The image uploads a message's raw markdown links to, in the order they appear, each with the
 * link as the text it replaces and its path as `uploadPath` re-encoded it. A link that is not
 * plainly an upload (`uploadPath`) is not one this adapter will ask for. Bounded: past one more
 * than a mention takes, the rest would only be counted.
 */
export function imageUploads(content: string): ImageSource[] {
  const found: ImageSource[] = [];
  for (const match of content.matchAll(/\[[^\]\n]*\]\((\/user_uploads\/[^)\s]+)\)/g)) {
    const path = uploadPath(match[1]);
    if (path === null || !IMAGE_NAME.test(decodeURIComponent(path))) continue;
    found.push({ at: match[0], label: null, size: null, ref: { kind: "zulip", path } });
    if (found.length > MAX_MENTION_IMAGES) break;
  }
  return found;
}

export function zulipTransport(opts: ZulipTransportOptions = {}): ChatTransport {
  const dial = opts.fetch ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const limitsTtlMs = opts.limitsTtlMs ?? DEFAULT_LIMITS_TTL_MS;
  /** What each server said its ceiling on a message is — not a secret, and slow to change. */
  const limits = new Map<string, { maxMessageLength: number; at: number }>();

  const credOf = (credential: ChatCredential): ZulipZ => {
    if (credential.kind !== "zulip") throw new Error("zulip: not a Zulip credential");
    return credential;
  };

  /**
   * One API call. Non-string parameters are JSON-encoded, as the API expects (`narrow`,
   * `event_types`); a GET carries them in the query, anything else as a form body — or as the
   * multipart body it was handed, for an upload. A reply that is not `result: "success"` throws
   * a `ZulipError` naming the call, never the credential.
   */
  const call = async <T>(
    cred: ZulipZ,
    method: string,
    path: string,
    params: Record<string, unknown> | FormData = {},
    signal: AbortSignal = AbortSignal.timeout(timeoutMs),
  ): Promise<T> => {
    const multipart = params instanceof FormData ? params : null;
    const form = new URLSearchParams();
    for (const [key, value] of multipart === null ? Object.entries(params) : []) {
      if (value === undefined) continue;
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const query = method === "GET" && [...form.keys()].length > 0 ? `?${form}` : "";
    const label = `zulip ${method} ${path}`;
    const authorization = basicAuth(cred.botEmail, cred.apiKey);
    let res: Response;
    try {
      res = await dial(`${cred.realmUrl}/api/v1${path}${query}`, {
        method,
        headers: {
          authorization,
          ...(method === "GET" || multipart !== null
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
        },
        body: method === "GET" ? undefined : multipart ?? form.toString(),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err;
      // A header fetch refuses is quoted in its message, the key in it: never passed on.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}: ${redactSecrets(message, [authorization, cred.apiKey])}`);
    }
    const body = await res.json().catch(() => null) as
      | { result?: string; msg?: string; code?: string }
      | null;
    if (!res.ok || body === null || body.result !== "success") {
      throw new ZulipError(
        res.status,
        body?.code ?? null,
        `${label} answered ${res.status}${body?.code ? ` ${body.code}` : ""}${
          body?.msg ? `: ${body.msg}` : ""
        }`,
      );
    }
    return body as T;
  };

  /** A channel as the bot may see it; null when it may not — a private channel it is not
   * subscribed to answers "Invalid channel ID", exactly like one that does not exist. */
  const streamOf = async (cred: ZulipZ, streamId: string): Promise<ZulipStream | null> => {
    try {
      const res = await call<{ stream: ZulipStream }>(cred, "GET", `/streams/${streamId}`);
      return res.stream;
    } catch (err) {
      if (err instanceof ZulipError && err.refused && err.status !== 401) return null;
      throw err;
    }
  };

  /** Whether a sender is a bot. The bot itself and Zulip's system bots are known without a
   * call; anyone else is asked, and a user the server will not describe is treated as one —
   * an unknowable sender is not a commander. */
  const isBotSender = async (
    cred: ZulipZ,
    room: PlatformRoom,
    message: ZulipMessage,
  ): Promise<boolean> => {
    if (String(message.sender_id) === room.bot.id) return true;
    if (message.sender_realm_str === SYSTEM_BOT_REALM) return true;
    try {
      const res = await call<{ user: { is_bot: boolean } }>(
        cred,
        "GET",
        `/users/${message.sender_id}`,
      );
      return res.user.is_bot;
    } catch (err) {
      if (err instanceof ZulipError && err.refused && err.status !== 401) return true;
      throw err;
    }
  };

  /** One delivered message to the port's shape; null for anything that is not a mention in a
   * channel (a DM, a message the bot merely received as a subscriber). */
  const normalize = async (
    cred: ZulipZ,
    room: PlatformRoom,
    message: ZulipMessage,
    flags: string[],
  ): Promise<InboundMessage | null> => {
    if (message.type !== "stream" || message.stream_id === undefined) return null;
    if (!flags.includes("mentioned")) return null;
    const channelId = String(message.stream_id);
    const channelName = typeof message.display_recipient === "string"
      ? message.display_recipient
      : channelId;
    const isBot = await isBotSender(cred, room, message);
    // Visibility is read live — it decides what the control plane may start from here.
    const stream = isBot ? null : await streamOf(cred, channelId);
    return {
      messageId: String(message.id),
      threadKey: String(message.id),
      chatId: null,
      direct: false,
      channel: {
        id: channelId,
        name: stream?.name ?? channelName,
        visibility: stream === null ? "private" : visibilityOf(stream),
      },
      topic: message.subject,
      sender: { id: String(message.sender_id), name: message.sender_full_name, isBot },
      rawText: message.content,
      text: stripBotMentions(message.content, room.bot),
      hasAttachment: hasUpload(message.content),
      images: imageUploads(message.content),
      mentionsBot: true,
      // A private channel the bot is not subscribed to is invisible to it: it heard this
      // mention, and can do nothing else there.
      servable: isBot || stream !== null,
    };
  };

  const remember = (cred: ZulipZ, maxMessageLength: unknown): void => {
    if (typeof maxMessageLength === "number" && maxMessageLength > 0) {
      limits.set(cred.realmUrl, { maxMessageLength, at: Date.now() });
    }
  };

  /**
   * A fresh queue, then everything that mentioned the bot since `lastMessageId`. A room's first
   * queue starts from now: a mention older than the room was never addressed to it.
   */
  const registerAndBackfill = async (
    cred: ZulipZ,
    room: PlatformRoom,
    lastMessageId: number | null,
  ): Promise<PollBatch> => {
    const reg = await call<{
      queue_id: string;
      last_event_id: number;
      max_message_id: number;
      max_message_length?: number;
    }>(cred, "POST", "/register", {
      event_types: ["message"],
      fetch_event_types: ["message", "realm"],
      idle_queue_timeout: IDLE_QUEUE_TIMEOUT_S,
      apply_markdown: false,
    });
    remember(cred, reg.max_message_length);
    let position: PollPosition = {
      queueId: reg.queue_id,
      offset: reg.last_event_id,
      lastMessageId: lastMessageId ?? reg.max_message_id,
    };
    const updates: PollUpdate[] = [];
    if (lastMessageId === null) return { updates, position };
    let anchor = lastMessageId;
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const res = await call<{ messages: ZulipMessage[]; found_newest: boolean }>(
        cred,
        "GET",
        "/messages",
        {
          anchor: String(anchor),
          include_anchor: false,
          num_before: 0,
          num_after: BACKFILL_PAGE,
          narrow: [{ operator: "is", operand: "mentioned" }],
          apply_markdown: false,
        },
      );
      for (const message of res.messages) {
        if (message.id <= (position.lastMessageId ?? -1)) continue;
        position = { ...position, lastMessageId: message.id };
        updates.push({
          position,
          message: await normalize(cred, room, message, message.flags ?? []),
        });
      }
      if (res.found_newest || res.messages.length === 0) break;
      anchor = res.messages[res.messages.length - 1].id;
    }
    return { updates, position };
  };

  /**
   * The message BY ID (`GET /messages/{id}`), never through a narrow: a narrow with no channel
   * term is served from the caller's own UserMessage rows, and a bot that posts into a public
   * channel it is not subscribed to gets no row for its own post — the opening line a response
   * keys on would then be unfindable, and every follow-up, post and closing line after it lost.
   * The single-message endpoint runs Zulip's access check instead: any message in a public
   * channel, a private channel's only when subscribed. Its "Invalid message(s)" (400
   * BAD_REQUEST) is one answer for "no such message" and "not yours to read" — the port's null.
   */
  const locateIn = async (cred: ZulipZ, messageId: string): Promise<Located | null> => {
    if (!/^\d+$/.test(messageId)) return null;
    let message: ZulipMessage;
    try {
      message = (await call<{ message: ZulipMessage }>(
        cred,
        "GET",
        `/messages/${messageId}`,
        { apply_markdown: false },
      )).message;
    } catch (err) {
      if (err instanceof ZulipError && err.status === 400 && err.code === "BAD_REQUEST") {
        return null;
      }
      throw err;
    }
    // A DM has no conversation a run could bind.
    if (message.type !== "stream" || message.stream_id === undefined) return null;
    return {
      channel: {
        id: String(message.stream_id),
        name: typeof message.display_recipient === "string"
          ? message.display_recipient
          : String(message.stream_id),
      },
      topic: message.subject,
    };
  };

  /** Each image up into the realm's upload store, answered as the link that shows it. */
  const uploadInline = async (
    room: PlatformRoom,
    images: OutboundImage[],
  ): Promise<InlineUpload[]> => {
    const cred = credOf(room.credential);
    const answers: InlineUpload[] = [];
    for (const [index, image] of images.entries()) {
      try {
        const form = new FormData();
        form.set(
          "file",
          new File([await image.load()], imageFileName(index + 1, image.mime), {
            type: image.mime,
          }),
        );
        const res = await call<{ url?: unknown; uri?: unknown }>(
          cred,
          "POST",
          "/user_uploads",
          form,
          AbortSignal.timeout(downloadTimeoutMs),
        );
        // `url` since Zulip 9.0; `uri` before it, the same path.
        const path = typeof res.url === "string" ? res.url : res.uri;
        if (typeof path !== "string" || !path.startsWith("/user_uploads/")) {
          throw new Error("zulip POST /user_uploads: the reply names no upload path");
        }
        answers.push({ kind: "inline", markup: `[${linkText(image.label)}](${path})` });
      } catch (err) {
        answers.push({ kind: "failed", error: errorText(err) });
      }
    }
    return answers;
  };

  const transport: ChatTransport = {
    kind: "zulip",
    // An organization is channels and topics; a run binds to a topic, never to the realm.
    roomIsOneConversation: false,
    openTarget(channelId, topic) {
      // A Zulip topic IS its name: the opening line posted into it creates it.
      return { channelId, topic };
    },

    async whoAmI(credential): Promise<BotIdentity> {
      const cred = credOf(credential);
      const me = await call<{ user_id: number; full_name: string; is_bot: boolean }>(
        cred,
        "GET",
        "/users/me",
      );
      // A person's own API key would pass the call above; a room is a BOT, whose key the
      // organization can see, rotate and revoke as a bot's.
      if (!me.is_bot) throw new Error("zulip GET /users/me: the credential is not a bot's");
      let title: string | null = null;
      try {
        title = (await call<{ realm_name?: string }>(cred, "GET", "/server_settings"))
          .realm_name ?? null;
      } catch {
        // The organization's name is decoration; the credential is what was asked.
      }
      return { id: String(me.user_id), name: me.full_name, title };
    },

    async poll(room, { position, timeoutS, signal }) {
      const cred = credOf(room.credential);
      if (position === null || position.queueId === null) {
        return await registerAndBackfill(cred, room, position?.lastMessageId ?? null);
      }
      // Zulip holds a long poll up to its own timeout (90 s by default); this side's hold is
      // shorter, and ending it is harmless — the next poll asks from the same event id.
      const hold = AbortSignal.timeout(timeoutS > 0 ? timeoutS * 1000 : timeoutMs);
      let events: Array<{ id: number; type: string; message?: ZulipMessage; flags?: string[] }>;
      try {
        events = (await call<{ events: typeof events }>(cred, "GET", "/events", {
          queue_id: position.queueId,
          last_event_id: String(position.offset),
          ...(timeoutS > 0 ? {} : { dont_block: true }),
        }, AbortSignal.any([signal, hold]))).events;
      } catch (err) {
        if (err instanceof ZulipError && err.code === "BAD_EVENT_QUEUE_ID") {
          return await registerAndBackfill(cred, room, position.lastMessageId);
        }
        if (!signal.aborted && hold.aborted) return { updates: [], position };
        throw err;
      }
      let at: PollPosition = position;
      const updates: PollUpdate[] = [];
      for (const event of events) {
        at = { ...at, offset: Math.max(at.offset, event.id) };
        if (event.type !== "message" || event.message === undefined) continue;
        // A mention the backfill already handled, delivered again by the new queue.
        if (event.message.id <= (at.lastMessageId ?? -1)) {
          updates.push({ position: at, message: null });
          continue;
        }
        at = { ...at, lastMessageId: event.message.id };
        updates.push({
          position: at,
          message: await normalize(cred, room, event.message, event.flags ?? []),
        });
      }
      return { updates, position: at };
    },

    releaseAllBut() {
      // Nothing is held for a room between polls: the event queue lives on the realm, named by the
      // cursor the service stores, and Zulip expires it on its own once nobody asks.
    },

    locate(room, messageId) {
      return locateIn(credOf(room.credential), messageId);
    },

    async fetchThread(room, threadKey): Promise<ChatThread | null> {
      const cred = credOf(room.credential);
      const where = await locateIn(cred, threadKey);
      if (where === null) return null;
      const stream = await streamOf(cred, where.channel.id);
      if (stream === null) return null;
      let res: { messages: ZulipMessage[]; found_oldest: boolean; history_limited?: boolean };
      try {
        // `with:` returns whichever conversation holds the key message NOW, across renames,
        // resolves, splits and moves (Zulip 9.0, feature level 271).
        res = await call(cred, "GET", "/messages", {
          anchor: "newest",
          num_before: THREAD_MAX_MESSAGES,
          num_after: 0,
          narrow: [{ operator: "with", operand: Number(threadKey) }],
          apply_markdown: false,
        });
      } catch (err) {
        if (err instanceof ZulipError && err.code === "BAD_NARROW") return null;
        throw err;
      }
      let truncated = !res.found_oldest;
      const kept: ChatThread["messages"] = [];
      let chars = 0;
      // Newest first, so the bound drops the OLDEST.
      for (const message of [...res.messages].reverse()) {
        if (message.sender_realm_str === SYSTEM_BOT_REALM) continue;
        chars += message.content.length;
        if (chars > THREAD_MAX_CHARS) {
          truncated = true;
          break;
        }
        kept.push({
          id: String(message.id),
          sender: { id: String(message.sender_id), name: message.sender_full_name },
          text: message.content,
          sentAt: new Date(message.timestamp * 1000).toISOString(),
          hasAttachment: hasUpload(message.content),
        });
      }
      return {
        channel: {
          id: String(stream.stream_id),
          name: stream.name,
          visibility: visibilityOf(stream),
        },
        topic: where.topic,
        messages: kept.reverse(),
        truncated,
        // A private channel with protected history shows a subscribed bot only what came after
        // it joined; a plan limit (Zulip Cloud's free tier) hides the oldest messages too.
        historyLimited: (stream.invite_only && !stream.history_public_to_subscribers) ||
          res.history_limited === true,
      };
    },

    async send(room, target, text) {
      const res = await call<{ id?: unknown }>(credOf(room.credential), "POST", "/messages", {
        type: "stream",
        to: target.channelId,
        topic: target.topic ?? "",
        content: text,
      });
      if (typeof res.id !== "number") {
        throw new Error("zulip POST /messages: the reply names no message id");
      }
      return String(res.id);
    },

    uploadImages: uploadInline,

    async sendImages(room, target, images): Promise<ImageDelivery[]> {
      const uploads = await uploadInline(room, images);
      const answers: ImageDelivery[] = uploads.map((upload) =>
        upload.kind === "failed" ? upload : { kind: "failed", error: "not sent" }
      );
      const links = uploads.flatMap((upload, index) =>
        upload.kind === "inline" ? [{ index, line: upload.markup }] : []
      );
      if (links.length === 0) return answers;
      try {
        await transport.send(room, target, links.map(({ line }) => line).join("\n"));
        for (const { index } of links) answers[index] = { kind: "uploaded" };
      } catch (err) {
        for (const { index } of links) answers[index] = { kind: "failed", error: errorText(err) };
      }
      return answers;
    },

    async react(room, messageId) {
      await call(credOf(room.credential), "POST", `/messages/${messageId}/reactions`, {
        emoji_name: "eyes",
      });
    },

    async checkMembership(room, groupId, userId): Promise<CommanderVerdict> {
      if (!/^\d+$/.test(groupId) || !/^\d+$/.test(userId)) return "unknown";
      try {
        const res = await call<{ is_user_group_member: boolean }>(
          credOf(room.credential),
          "GET",
          `/user_groups/${groupId}/members/${userId}`,
        );
        return res.is_user_group_member ? "allowed" : "denied";
      } catch {
        // Down, a revoked key, a group that no longer exists: never read as a yes.
        return "unknown";
      }
    },

    async listChannels(room): Promise<ChannelList> {
      const res = await call<{ streams: ZulipStream[] }>(
        credOf(room.credential),
        "GET",
        "/streams",
        {
          include_web_public: true,
        },
      );
      // One call answers the realm's streams, so there is never a page left unread.
      return {
        channels: res.streams
          .filter((s) => s.is_archived !== true)
          .map((s) => ({ id: String(s.stream_id), name: s.name, visibility: visibilityOf(s) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        truncated: false,
      };
    },

    async listGroups(room): Promise<ChatGroup[]> {
      const res = await call<{
        user_groups: Array<{
          id: number;
          name: string;
          description: string;
          is_system_group: boolean;
          deactivated?: boolean;
        }>;
      }>(credOf(room.credential), "GET", "/user_groups");
      return res.user_groups
        .filter((g) => !g.is_system_group && g.deactivated !== true)
        .map((g) => ({ id: String(g.id), name: g.name, description: g.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async downloadImage(room, source, { maxBytes, signal }) {
      // Judged again here, and only the re-encoded form is asked for: the adapter's own
      // `imageUploads` made this ref, but the request is the bot's key going somewhere.
      const path = source.ref.kind === "zulip" ? uploadPath(source.ref.path) : null;
      if (path === null) return { kind: "failed", error: "zulip: not an upload path" };
      const cred = credOf(room.credential);
      // The temporary URL, asked for with the bot's key and spent at once: it is valid for a
      // minute, and needs no credential, so none rides the second request.
      let url: string;
      try {
        const res = await call<{ url?: unknown }>(
          cred,
          "GET",
          // `/api/v1` + the upload's own path: the API's twin of the browser's route.
          path,
          {},
          AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        );
        if (typeof res.url !== "string") {
          return { kind: "failed", error: "zulip GET /user_uploads: the reply names no url" };
        }
        url = res.url;
      } catch (err) {
        return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      // The URL is the realm's own; one naming another host is not followed. The realm may
      // still redirect it to its object store, which is its business.
      let target: URL;
      try {
        target = new URL(url, cred.realmUrl);
      } catch {
        return { kind: "failed", error: "zulip GET /user_uploads: the url does not parse" };
      }
      if (target.origin !== new URL(cred.realmUrl).origin) {
        return { kind: "failed", error: "zulip GET /user_uploads: the url is off the realm" };
      }
      return await downloadCapped(dial, target.href, { method: "GET" }, {
        label: "zulip upload download",
        maxBytes,
        timeoutMs: downloadTimeoutMs,
        signal,
      });
    },

    async maxMessageLength(room) {
      const cred = credOf(room.credential);
      const known = limits.get(cred.realmUrl);
      if (known !== undefined && Date.now() - known.at < limitsTtlMs) return known.maxMessageLength;
      // The limits are only in `register`'s realm state. A queue that listens for nothing is
      // made to ask, and deleted at once.
      const reg = await call<{ queue_id: string; max_message_length?: number }>(
        cred,
        "POST",
        "/register",
        { event_types: [], fetch_event_types: ["realm"] },
      );
      remember(cred, reg.max_message_length);
      await call(cred, "DELETE", "/events", { queue_id: reg.queue_id }).catch(() => {});
      const learned = limits.get(cred.realmUrl);
      if (learned === undefined) throw new Error("zulip POST /register: no max_message_length");
      return learned.maxMessageLength;
    },
  };
  return transport;
}
