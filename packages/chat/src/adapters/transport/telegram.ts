// `ChatTransport` over the Telegram Bot API. Long-polls `getUpdates` rather than registering a
// webhook: no public ingress, so it works on the homelab and on a laptop, and the token is the
// auth. A webhook transport can come later; Telegram forbids both at once, so it is a per-bot
// choice.
//
// The token rides the URL path — that is the Bot API's contract — so the URL is never logged:
// every failure here names the method, never the address.
//
// Images: a photo arrives as `photo`, the sizes Telegram made of it (smallest first), and its
// words as a `caption` with `caption_entities` — read here exactly as `text` and `entities`, or
// a mention in a caption would never be seen. An image sent as a FILE is a `document` that
// names an image type. Both are fetched only for a mention that reaches the door: `getFile`
// answers a path, and the file is served under the same token-bearing prefix the methods are.
// An album is one message per photo with the caption on one of them, so only that photo is the
// mention's; a reply to a photo hands the replied-to photo over too, because a bot cannot read
// a group's history and replying is how someone points at one.
//
// A run's images go out as uploads, multipart: `sendPhoto` for one, `sendMediaGroup` for two to
// ten (an album, in order, each photo captioned with its label), into the group the text went
// to. Telegram refuses a photo past its own bounds — a full-page screenshot is often taller than
// it takes — so a refused photo or album goes again one file at a time as `sendDocument`, which
// takes any image as it is.
//
// Words go out as HTML (`parse_mode: "HTML"`), converted from the Markdown a run writes
// (telegram_html.ts), so `**bold**` and backticks render instead of showing. Should Telegram
// refuse the markup, the same words go again as plain text: a message that reads raw is better
// than one that is lost. A caption is converted the same way.

import type {
  ChatTransport,
  ImageDelivery,
  ImageSource,
  InboundMessage,
  PollUpdate,
} from "../../ports/transport.ts";
import { MAX_MENTION_IMAGE_BYTES, TELEGRAM_MAX_POST_CHARS } from "../../core/types.ts";
import { imageFileName } from "../../core/agent_images.ts";
import { downloadCapped, redactSecrets } from "../../helpers/download.ts";
import { markdownToTelegramHtml } from "./telegram_html.ts";

/** Whether a `getFile` path is plain relative segments, none of them `.` or `..`. */
export function isPlainFilePath(path: string): boolean {
  const segments = path.split("/");
  return segments.every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && !/^\.+$/.test(s));
}

export interface TelegramTransportOptions {
  /**
   * The API origin; overridable for tests and for a local Bot API server in its default mode,
   * which answers `getFile` with a relative path and serves the file under `/file/bot<token>/`
   * as the cloud does. A server started with `--local` answers an ABSOLUTE path on its own disk
   * instead, to be read from that disk: this transport does not read one — a path off a reply
   * is not a file this process opens, and the chat service shares no disk with the Bot API
   * server anyway — so there each image is dropped with a note and the mention goes on.
   */
  apiUrl?: string;
  /** The outbound fetch, injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request deadline for the calls that do not long-poll. */
  requestTimeoutMs?: number;
  /** Deadline for one image's download. */
  downloadTimeoutMs?: number;
}

const DEFAULT_API_URL = "https://api.telegram.org";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20_000;

/** An upload carries up to ten images: it is given longer than a plain call. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Telegram's bound on a media caption. */
export const MAX_CAPTION_CHARS = 1_024;

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

/** One size of a photo; Telegram lists them smallest first. */
interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

/** What a message carries that may be an image — on the message, and on the one it replies to. */
interface TelegramMedia {
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

interface TelegramMessage extends TelegramMedia {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: TelegramUser;
  text?: string;
  entities?: TelegramEntity[];
  /** A photo's or a file's words, in place of `text`; `caption_entities` in place of
   * `entities`. */
  caption?: string;
  caption_entities?: TelegramEntity[];
  reply_to_message?: TelegramMedia & { from?: TelegramUser };
  sticker?: unknown;
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/** How a sender is named in the inbox: their display name, never a bare id. */
export function senderName(user: TelegramUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full !== "") return full;
  if (user.username) return `@${user.username}`;
  return `user ${user.id}`;
}

/** Every `@botname` in the text, removed — the mention is the address, not the message. */
function stripMention(text: string, username: string): string {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`@${escaped}\\b[ \\t]*`, "gi"), "").trim();
}

/**
 * The one image a message's media is, as a source: a photo's largest size the cap allows (or,
 * when none does, its smallest, which is then refused by its size without a fetch), or a file
 * whose type Telegram says is an image — a claim that only picks what to fetch. Null for
 * anything else: a sticker, a video, a file of another type.
 */
function imageOf(media: TelegramMedia, label: string | null): ImageSource | null {
  const photos = Array.isArray(media.photo)
    ? media.photo.filter((p) => typeof p?.file_id === "string")
    : [];
  if (photos.length > 0) {
    const fits = photos.filter((p) => (p.file_size ?? 0) <= MAX_MENTION_IMAGE_BYTES);
    const pick = fits.at(-1) ?? photos[0];
    return {
      at: null,
      label,
      size: pick.file_size ?? null,
      ref: { kind: "telegram", fileId: pick.file_id },
    };
  }
  const doc = media.document;
  if (
    doc !== undefined && typeof doc.file_id === "string" &&
    typeof doc.mime_type === "string" && doc.mime_type.startsWith("image/")
  ) {
    return {
      at: null,
      label,
      size: doc.file_size ?? null,
      ref: { kind: "telegram", fileId: doc.file_id },
    };
  }
  return null;
}

/**
 * One raw update's message to the port's shape; null for an update that carries no message.
 * A group has exactly one conversation, so the thread key is always "" and the "channel" is the
 * group itself — always private: a Telegram group is only ever read by its members.
 */
export function normalizeUpdate(
  raw: TelegramUpdate,
  bot: { username: string; id: string },
): InboundMessage | null {
  const message = raw.message;
  if (message === undefined) return null;
  // A photo's or a file's words are its caption, with their own entities: the same text, for
  // every purpose here.
  const text = typeof message.text === "string"
    ? message.text
    : typeof message.caption === "string"
    ? message.caption
    : null;
  const entities =
    (typeof message.text === "string" ? message.entities : message.caption_entities) ?? [];
  const mentioned = entities.some((e) =>
    e.type === "mention" && text !== null &&
    text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${bot.username.toLowerCase()}`
  );
  const replied = String(message.reply_to_message?.from?.id ?? "") === bot.id;
  const chatId = String(message.chat.id);
  const chatType = message.chat.type;
  return {
    messageId: `${chatId}:${message.message_id}`,
    threadKey: "",
    chatId,
    // A private chat with the bot is not the team's room, and a channel has no senders.
    direct: chatType !== "group" && chatType !== "supergroup",
    channel: { id: chatId, name: message.chat.title ?? chatId, visibility: "private" },
    topic: null,
    sender: message.from === undefined ? null : {
      id: String(message.from.id),
      name: senderName(message.from),
      isBot: message.from.is_bot === true,
    },
    rawText: text,
    text: text === null ? "" : stripMention(text, bot.username),
    hasAttachment: [
      message.photo,
      message.document,
      message.sticker,
      message.video,
      message.voice,
      message.audio,
    ].some((v) => v !== undefined),
    images: [
      imageOf(message, null),
      message.reply_to_message === undefined
        ? null
        : imageOf(message.reply_to_message, "from the message this one replies to"),
    ].filter((s): s is ImageSource => s !== null),
    mentionsBot: mentioned || replied,
    servable: true,
  };
}

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Telegram's own answer refusing a call: the request reached it and it said no. */
class TelegramRefusal extends Error {
  constructor(method: string, readonly status: number, readonly description: string | null) {
    super(`telegram ${method} answered ${status}${description ? `: ${description}` : ""}`);
    this.name = "TelegramRefusal";
  }
}

/**
 * Whether Telegram refused an image AS A PHOTO, which the same bytes as a document get past:
 * too large for a photo, or dimensions or a format its photo processing will not take. Only
 * then did nothing land. A timeout, a dropped connection, a 429 or a 5xx may come after the
 * album was already posted, and sending it again as documents would post it twice.
 */
function refusedAsPhoto(err: unknown): boolean {
  if (!(err instanceof TelegramRefusal)) return false;
  if (err.status === 413) return true;
  return err.status === 400 &&
    /PHOTO_|IMAGE_PROCESS_FAILED|too big|dimensions/i.test(err.description ?? "");
}

/** Whether Telegram refused the HTML a message or caption was sent with — nothing landed, and
 * the same words as plain text will. */
function refusedMarkup(err: unknown): boolean {
  return err instanceof TelegramRefusal && err.status === 400 &&
    /can't parse entities/i.test(
      err.description ?? "",
    );
}

export function telegramTransport(opts: TelegramTransportOptions = {}): ChatTransport {
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const dial = opts.fetch ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  /** One Bot API call — JSON, or multipart for one that uploads files. The response's `ok` is
   * the platform's verdict; anything else is a failure naming the method and the status, never
   * the token. */
  const call = async <T>(
    token: string,
    method: string,
    body: Record<string, unknown> | FormData,
    signal: AbortSignal,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await dial(`${apiUrl}/bot${token}/${method}`, {
        method: "POST",
        ...(body instanceof FormData
          ? { body }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal,
      });
    } catch (err) {
      // The token rides the URL, which a fetch error may quote.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`telegram ${method}: ${redactSecrets(message, [token])}`);
    }
    const answer = await res.json().catch(() => null) as
      | { ok?: boolean; result?: T; description?: string }
      | null;
    if (!res.ok || answer === null || answer.ok !== true) {
      throw new TelegramRefusal(method, res.status, answer?.description ?? null);
    }
    return answer.result as T;
  };

  const tokenOf = (credential: { kind: string; botToken?: string }): string => {
    if (credential.kind !== "telegram" || credential.botToken === undefined) {
      throw new Error("telegram: not a Telegram credential");
    }
    return credential.botToken;
  };

  /** The group, as the one channel and conversation a Telegram room has. */
  const groupOf = (room: { chatId: string | null; chatTitle: string | null }) =>
    room.chatId === null ? null : {
      id: room.chatId,
      name: room.chatTitle ?? room.chatId,
      visibility: "private" as const,
    };

  return {
    kind: "telegram",
    // A group is one conversation, keyed "": a response room's one-run-at-a-time rule.
    roomIsOneConversation: true,
    openTarget() {
      // Nothing to open: the group is the only conversation there is.
      return null;
    },
    captionLimit: MAX_CAPTION_CHARS,
    async whoAmI(credential) {
      const me = await call<TelegramUser>(
        tokenOf(credential),
        "getMe",
        {},
        AbortSignal.timeout(timeoutMs),
      );
      if (!me.username) throw new Error("telegram getMe: the bot has no username");
      return { id: String(me.id), name: me.username, title: null };
    },
    async poll(room, { position, timeoutS, signal }) {
      // The long poll's own deadline outlasts the platform's hold by a margin, and the caller's
      // signal cuts both — a drain must not wait out a 25-second hold.
      const deadline = AbortSignal.any([signal, AbortSignal.timeout((timeoutS + 10) * 1000)]);
      const offset = position?.offset ?? 0;
      const raw = await call<TelegramUpdate[]>(tokenOf(room.credential), "getUpdates", {
        offset,
        timeout: timeoutS,
        allowed_updates: ["message"],
      }, deadline);
      // An update with nothing to route still advances the cursor: it is delivered with a null
      // message so the caller's offset moves past it.
      const updates: PollUpdate[] = raw.map((update) => ({
        position: { offset: update.update_id + 1, queueId: null, lastMessageId: null },
        message: normalizeUpdate(update, { username: room.bot.name, id: room.bot.id }),
      }));
      return {
        updates,
        position: updates.at(-1)?.position ?? { offset, queueId: null, lastMessageId: null },
      };
    },
    releaseAllBut() {
      // Long polling holds nothing between calls: a room this poller drops simply stops being
      // asked about, and Telegram keeps its updates until someone asks again.
    },
    locate(room) {
      // One conversation per group: every message of the room is in the group.
      const group = groupOf(room);
      return Promise.resolve(
        group === null ? null : { channel: { id: group.id, name: group.name }, topic: null },
      );
    },
    fetchThread(room) {
      // A bot cannot read a group's history: the thread is the room, with nothing in it.
      const group = groupOf(room);
      return Promise.resolve(
        group === null
          ? null
          : { channel: group, topic: null, messages: [], truncated: false, historyLimited: true },
      );
    },
    async send(room, target, text) {
      const token = tokenOf(room.credential);
      const sendMessage = (body: Record<string, unknown>) =>
        call<{ message_id?: unknown; chat?: { id?: unknown } }>(
          token,
          "sendMessage",
          { chat_id: target.channelId, ...body },
          AbortSignal.timeout(timeoutMs),
        );
      let res: { message_id?: unknown; chat?: { id?: unknown } };
      try {
        res = await sendMessage({ text: markdownToTelegramHtml(text), parse_mode: "HTML" });
      } catch (err) {
        if (!refusedMarkup(err)) throw err;
        res = await sendMessage({ text });
      }
      if (typeof res.message_id !== "number") {
        throw new Error("telegram sendMessage: the reply names no message id");
      }
      // The same form `normalizeUpdate` gives an inbound message: the chat the platform says it
      // landed in, then the message's number within it.
      return `${res.chat?.id ?? target.channelId}:${res.message_id}`;
    },
    async sendImages(room, target, images, caption): Promise<ImageDelivery[]> {
      const token = tokenOf(room.credential);
      const answers: ImageDelivery[] = images.map(() => ({ kind: "failed", error: "not sent" }));
      const loaded: Array<{ index: number; file: File; label: string }> = [];
      for (const [index, image] of images.entries()) {
        try {
          loaded.push({
            index,
            file: new File([await image.load()], imageFileName(index + 1, image.mime), {
              type: image.mime,
            }),
            label: image.label.slice(0, MAX_CAPTION_CHARS),
          });
        } catch (err) {
          answers[index] = { kind: "failed", error: errorText(err) };
        }
      }
      if (loaded.length === 0) return answers;
      // The words that follow the images ride on the first of them, which is how Telegram shows
      // an album's caption under it; the labels then say nothing the words do not. Without
      // words, each image is captioned with its own label, as written.
      const words = caption === undefined || caption === null || caption.trim() === ""
        ? null
        : caption;
      /**
       * The caption fields for the nth loaded image: HTML from the words, or plain. The words
       * ride on `first`, the first image that is sent; the others carry none.
       */
      const captionOf = (i: number, first: boolean, html: boolean): Record<string, string> => {
        if (words === null) return { caption: loaded[i].label };
        if (!first) return {};
        return html
          ? { caption: markdownToTelegramHtml(words), parse_mode: "HTML" }
          : { caption: words.slice(0, MAX_CAPTION_CHARS) };
      };
      const upload = (method: string, form: FormData) =>
        call(token, method, form, AbortSignal.timeout(UPLOAD_TIMEOUT_MS));
      /** Tries again with the caption as plain text when Telegram refused its markup. */
      const withPlainFallback = async (send: (html: boolean) => Promise<unknown>) => {
        try {
          await send(words !== null);
        } catch (err) {
          if (words === null || !refusedMarkup(err)) throw err;
          await send(false);
        }
      };
      try {
        await withPlainFallback(async (html) => {
          const form = new FormData();
          form.set("chat_id", target.channelId);
          if (loaded.length === 1) {
            form.set("photo", loaded[0].file);
            for (const [k, v] of Object.entries(captionOf(0, true, html))) form.set(k, v);
            await upload("sendPhoto", form);
          } else {
            // An album names each file by the multipart field it rides in.
            form.set(
              "media",
              JSON.stringify(loaded.map((_, i) => ({
                type: "photo",
                media: `attach://image${i}`,
                ...captionOf(i, i === 0, html),
              }))),
            );
            loaded.forEach(({ file }, i) => form.set(`image${i}`, file));
            await upload("sendMediaGroup", form);
          }
        });
        for (const { index } of loaded) answers[index] = { kind: "uploaded" };
        return answers;
      } catch (err) {
        // Past a photo's bounds: each one again as the file it is. Anything else is reported,
        // never resent: the photos may already be in the group.
        if (!refusedAsPhoto(err)) {
          for (const { index } of loaded) {
            answers[index] = { kind: "failed", error: errorText(err) };
          }
          return answers;
        }
      }
      // The words go on the first file that lands, not the first one tried: the service counts
      // them delivered once any image is, so a file that fails must not take them down with it.
      let captioned = false;
      for (const [i, { index, file }] of loaded.entries()) {
        try {
          await withPlainFallback(async (html) => {
            const form = new FormData();
            form.set("chat_id", target.channelId);
            form.set("document", file);
            for (const [k, v] of Object.entries(captionOf(i, !captioned, html))) form.set(k, v);
            await upload("sendDocument", form);
          });
          captioned = true;
          answers[index] = { kind: "uploaded" };
        } catch (err) {
          answers[index] = { kind: "failed", error: errorText(err) };
        }
      }
      return answers;
    },
    react() {
      // Nothing to acknowledge with: a bot's reactions need an admin grant in most groups.
      return Promise.resolve();
    },
    checkMembership() {
      // The "group" commander policy is not offered for Telegram rooms.
      return Promise.resolve("unknown");
    },
    listChannels(room) {
      const group = groupOf(room);
      // One group, which is the whole room: there is never more to read.
      return Promise.resolve({ channels: group === null ? [] : [group], truncated: false });
    },
    listGroups() {
      return Promise.resolve([]);
    },
    maxMessageLength() {
      return Promise.resolve(TELEGRAM_MAX_POST_CHARS);
    },
    async downloadImage(room, source, { maxBytes, signal }) {
      if (source.ref.kind !== "telegram") {
        return { kind: "failed", error: "telegram: not a Telegram file" };
      }
      // The path first, then the file under the token-bearing prefix. Neither URL is ever
      // named in what comes back: both carry the token.
      let file: { file_path?: unknown; file_size?: unknown };
      try {
        file = await call(
          tokenOf(room.credential),
          "getFile",
          { file_id: source.ref.fileId },
          AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        );
      } catch (err) {
        return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      if (typeof file.file_path !== "string") {
        return { kind: "failed", error: "telegram getFile: the reply names no file path" };
      }
      // The path goes into a URL that carries the token, so it must stay a file under the
      // token's own prefix: plain segments only (`photos/file_1.jpg`), none of them a dot
      // segment, nothing encoded. Telegram writes it, but it is not ours to trust blindly.
      if (file.file_path.startsWith("/")) {
        return {
          kind: "failed",
          error: "telegram getFile: an absolute file path (a Bot API server in --local mode), " +
            "which this transport does not read",
        };
      }
      if (!isPlainFilePath(file.file_path)) {
        return { kind: "failed", error: "telegram getFile: the file path is not a plain path" };
      }
      if (typeof file.file_size === "number" && file.file_size > maxBytes) {
        return { kind: "too_large" };
      }
      return await downloadCapped(
        dial,
        `${apiUrl}/file/bot${tokenOf(room.credential)}/${file.file_path}`,
        { method: "GET" },
        { label: "telegram file download", maxBytes, timeoutMs: downloadTimeoutMs, signal },
      );
    },
  };
}
