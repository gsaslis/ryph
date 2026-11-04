// A scripted `ChatTransport`, one per platform kind: the bots it knows by secret, the updates it
// will hand out per secret (drained as they are polled), where each message is "now", and every
// message it was asked to send or react to — each send minted an id like the platform would
// (Zulip a number from 1000, Telegram `<chatId>:<n>`, Slack `<channel>:<ts>`, Discord
// `<channel>:<snowflake>`), and a Zulip, Slack or Discord post is thereafter located in the
// conversation it went into, as the real server would answer. Never the network.

import type {
  ChatChannel,
  ChatGroup,
  ChatroomKind,
  ChatThread,
  CommanderVerdict,
} from "../src/core/types.ts";
import type {
  BotIdentity,
  ChatCredential,
  ChatTransport,
  ImageDelivery,
  ImageDownload,
  ImageSource,
  InboundMessage,
  InlineUpload,
  Located,
  PollPosition,
  PollUpdate,
} from "../src/ports/transport.ts";

export interface FakeTransport extends ChatTransport {
  /** Queues updates for the next `poll` on this secret. */
  deliver(secret: string, ...updates: PollUpdate[]): void;
  readonly sent: Array<{
    /** The id `send` answered for this message. */
    id: string;
    secret: string;
    channelId: string;
    topic: string | null;
    /** The thread a Discord post at the channel was asked to start (`threadName`), if any. */
    threadName?: string;
    text: string;
  }>;
  /** Every `sendImages`: where, and each image as it was handed over, its bytes loaded (null
   * for one whose load threw). */
  readonly imagesSent: Array<{
    secret: string;
    channelId: string;
    topic: string | null;
    images: Array<{ label: string; mime: string; url: string | null; bytes: Uint8Array | null }>;
    /** The words handed over as the images' caption (Telegram's), or null. */
    caption: string | null;
  }>;
  /** Every `uploadImages` (Zulip's only: the images that ride inside a post's words), each image
   * as it was handed over, its bytes loaded (null for one whose load threw). */
  readonly imagesUploaded: Array<{
    secret: string;
    images: Array<{ label: string; mime: string; url: string | null; bytes: Uint8Array | null }>;
  }>;
  /** What `sendImages` answers for a loaded image; `uploaded` by default. A load that throws is
   * always `failed`. */
  imageAnswer: ImageDelivery;
  readonly polls: Array<{ secret: string; position: PollPosition | null }>;
  /** The rooms the poller said it was watching, once per `releaseAllBut`. */
  readonly released: Array<ReadonlySet<string>>;
  readonly reactions: Array<{ secret: string; messageId: string }>;
  /** Where `locate` says each message is; a missing entry is the chat itself (Telegram), the
   * conversation the key names (Slack, Discord) or gone (Zulip). `null` is gone. */
  readonly locations: Map<string, Located | null>;
  /** What `checkMembership` answers, keyed `<groupId>:<userId>`; unknown otherwise. */
  readonly membership: Map<string, CommanderVerdict>;
  /** What `fetchThread` answers per key; a missing entry is gone. */
  readonly threads: Map<string, ChatThread>;
  channels: ChatChannel[];
  /** What `listChannels` says about whether the platform had more than it gave. */
  truncated: boolean;
  groups: ChatGroup[];
  maxLength: number;
  /** Makes every `send` throw until cleared. */
  refuseSends: boolean;
  /** How many more `send`s succeed before every one after throws; null for no limit. */
  sendsLeft: number | null;
  /** Every key `retract` took back (Slack and Discord). */
  readonly retracted: string[];
  /** What `whoAmI` throws instead of answering, when set. */
  whoAmIRefusal: Error | null;
  /** Makes every read (`locate`, `fetchThread`, lists) throw until cleared. */
  platformDown: boolean;
  /** How many times `whoAmI` was asked — every dial of a credential's server. */
  whoAmIs: number;
  /** What `downloadImage` answers per file (`refOf`); a missing entry failed to download. */
  readonly files: Map<string, ImageDownload>;
  /** Every download asked for: the file, and the cap it was asked under. */
  readonly downloads: Array<{ ref: string; maxBytes: number }>;
}

/** A source's file, as the fake keys it: the platform's own handle, whatever kind. */
export function refOf(source: ImageSource): string {
  const ref = source.ref;
  return ref.kind === "telegram" ? ref.fileId : ref.kind === "zulip" ? ref.path : ref.url;
}

export const BOT_TOKEN = "123456:secret-bot-token";
export const BOT = { id: "123456", name: "ryph_bot", title: null };

export const ZULIP_KEY = "zulip-secret-api-key";
export const ZULIP_BOT = { id: "10", name: "ryph", title: "Radicle" };
export const ZULIP_REALM = "https://radicle.zulip.test";
export const ZULIP_EMAIL = "ryph-bot@radicle.zulip.test";

export const SLACK_BOT_TOKEN = "xoxb-secret-bot-token";
export const SLACK_APP_TOKEN = "xapp-secret-app-token";
export const SLACK_BOT = { id: "U0BOT", name: "ryph", title: "Acme" };

export const DISCORD_BOT_TOKEN = "MTAw.discord-secret-bot-token";
export const DISCORD_GUILD = "800000000000000001";
export const DISCORD_BOT = { id: "800000000000000099", name: "ryph", title: "Acme Discord" };

/** The secret a credential is scripted by: Slack's bot half, which every read and post uses. */
const secretOf = (credential: ChatCredential): string =>
  credential.kind === "zulip" ? credential.apiKey : credential.botToken;

const DEFAULT_BOTS: Record<ChatroomKind, Record<string, BotIdentity>> = {
  telegram: { [BOT_TOKEN]: BOT },
  zulip: { [ZULIP_KEY]: ZULIP_BOT },
  slack: { [SLACK_BOT_TOKEN]: SLACK_BOT },
  discord: { [DISCORD_BOT_TOKEN]: DISCORD_BOT },
};

export function fakeTransport(
  kind: ChatroomKind,
  bots: Record<string, BotIdentity> = DEFAULT_BOTS[kind],
): FakeTransport {
  const queued = new Map<string, PollUpdate[]>();
  let nextSentId = 1000;
  /** A Slack or Discord key, or null for anything that is not one — the real adapters' own
   * parse: the channel, and the conversation (the second part on Slack, which may carry its
   * thread root third; always the second on Discord). */
  const threadAddress = (key: string): { channelId: string; threadTs: string } | null => {
    const parts = key.split(":");
    const [channelId, ts] = parts;
    if (channelId === undefined || ts === undefined) return null;
    return { channelId, threadTs: kind === "discord" ? ts : parts[2] ?? ts };
  };
  const transport: FakeTransport = {
    kind,
    roomIsOneConversation: kind === "telegram",
    openTarget: (channelId, topic) =>
      kind === "telegram"
        ? null
        : kind === "discord"
        ? { channelId, topic: null, threadName: topic }
        : { channelId, topic: kind === "slack" ? null : topic },
    sent: [],
    imagesSent: [],
    imagesUploaded: [],
    imageAnswer: { kind: "uploaded" },
    polls: [],
    released: [],
    reactions: [],
    locations: new Map(),
    membership: new Map(),
    threads: new Map(),
    channels: [],
    truncated: false,
    groups: [],
    maxLength: kind === "telegram"
      ? 4096
      : kind === "slack"
      ? 4000
      : kind === "discord"
      ? 2000
      : 10_000,
    refuseSends: false,
    sendsLeft: null,
    retracted: [],
    whoAmIRefusal: null,
    platformDown: false,
    whoAmIs: 0,
    files: new Map(),
    downloads: [],
    downloadImage(_room, source, { maxBytes }) {
      transport.downloads.push({ ref: refOf(source), maxBytes });
      const got = transport.files.get(refOf(source)) ?? { kind: "failed", error: "no such file" };
      if (got.kind === "bytes" && got.bytes.length > maxBytes) {
        return Promise.resolve({ kind: "too_large" });
      }
      return Promise.resolve(got);
    },
    deliver(secret, ...updates) {
      queued.set(secret, [...(queued.get(secret) ?? []), ...updates]);
    },
    whoAmI(credential) {
      transport.whoAmIs++;
      if (transport.whoAmIRefusal !== null) return Promise.reject(transport.whoAmIRefusal);
      const bot = bots[secretOf(credential)];
      return bot === undefined
        ? Promise.reject(new Error(`${kind} whoAmI answered 401: Unauthorized`))
        : Promise.resolve(bot);
    },
    poll(room, { position }) {
      const secret = secretOf(room.credential);
      transport.polls.push({ secret, position });
      const all = queued.get(secret) ?? [];
      queued.set(secret, []);
      return Promise.resolve({
        updates: all,
        position: all.at(-1)?.position ?? position ??
          { offset: 0, queueId: kind === "zulip" ? "q-1" : null, lastMessageId: null },
      });
    },
    releaseAllBut(polling) {
      transport.released.push(new Set(polling));
    },
    locate(room, messageId) {
      if (transport.platformDown) return Promise.reject(new Error(`${kind} is down`));
      const known = transport.locations.get(messageId);
      if (known !== undefined) return Promise.resolve(known);
      if (kind === "telegram" && room.chatId !== null) {
        return Promise.resolve({
          channel: { id: room.chatId, name: room.chatTitle ?? room.chatId },
          topic: null,
        });
      }
      if (kind === "slack" || kind === "discord") {
        // A Slack or Discord thread never moves, so a key locates itself — the real adapter's
        // answer.
        const at = threadAddress(messageId);
        return Promise.resolve(
          at === null ? null : { channel: { id: at.channelId, name: "" }, topic: at.threadTs },
        );
      }
      return Promise.resolve(null);
    },
    fetchThread(_room, threadKey) {
      if (transport.platformDown) return Promise.reject(new Error(`${kind} is down`));
      return Promise.resolve(transport.threads.get(threadKey) ?? null);
    },
    send(room, target, text) {
      if (transport.refuseSends || transport.sendsLeft === 0) {
        return Promise.reject(new Error(`${kind} send answered 400`));
      }
      if (transport.sendsLeft !== null) transport.sendsLeft--;
      const n = nextSentId++;
      const id = kind === "zulip" ? String(n) : kind === "discord"
        // A post into a thread answers that thread; one at the channel, its own snowflake.
        ? `${target.channelId}:${target.topic ?? `9000000000000${n}`}`
        : `${target.channelId}:${kind === "slack" ? `${n}.000000` : n}`;
      transport.sent.push({
        id,
        secret: secretOf(room.credential),
        channelId: target.channelId,
        topic: target.topic,
        ...(target.threadName === undefined ? {} : { threadName: target.threadName }),
        text,
      });
      // The post now lives where it went, until a test moves it.
      if (kind === "zulip" && !transport.locations.has(id)) {
        const name = transport.channels.find((c) => c.id === target.channelId)?.name ??
          target.channelId;
        transport.locations.set(id, {
          channel: { id: target.channelId, name },
          topic: target.topic,
        });
      }
      return Promise.resolve(id);
    },
    async sendImages(room, target, images, caption) {
      const record = {
        secret: secretOf(room.credential),
        channelId: target.channelId,
        topic: target.topic,
        images: [] as FakeTransport["imagesSent"][number]["images"],
        caption: caption ?? null,
      };
      transport.imagesSent.push(record);
      const answers: ImageDelivery[] = [];
      for (const image of images) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = await image.load();
          answers.push(transport.imageAnswer);
        } catch (err) {
          answers.push({ kind: "failed", error: String(err) });
        }
        record.images.push({ label: image.label, mime: image.mime, url: image.url, bytes });
      }
      return answers;
    },
    react(room, messageId) {
      transport.reactions.push({ secret: secretOf(room.credential), messageId });
      return Promise.resolve();
    },
    checkMembership(_room, groupId, userId) {
      if (transport.platformDown) return Promise.reject(new Error(`${kind} is down`));
      return Promise.resolve(transport.membership.get(`${groupId}:${userId}`) ?? "unknown");
    },
    listChannels() {
      if (transport.platformDown) return Promise.reject(new Error(`${kind} is down`));
      return Promise.resolve({ channels: transport.channels, truncated: transport.truncated });
    },
    listGroups() {
      if (transport.platformDown) return Promise.reject(new Error(`${kind} is down`));
      return Promise.resolve(transport.groups);
    },
    maxMessageLength() {
      return Promise.resolve(transport.maxLength);
    },
  };
  if (kind === "slack" || kind === "discord") {
    // A post at the channel opens a conversation on these two, so one can be taken back.
    transport.retract = (_room, key) => {
      transport.retracted.push(key);
      return Promise.resolve();
    };
  }
  if (kind === "telegram") {
    // Telegram sends a post's images where its words put them, the words after them as the
    // caption — the real adapter's bound.
    (transport as { captionLimit?: number }).captionLimit = 1_024;
  }
  if (kind === "zulip") {
    // Zulip shows an upload where a message links it, so its images go up ahead of the words.
    // A failed `imageAnswer` fails each upload, as the realm refusing it would.
    let nextUpload = 1;
    transport.uploadImages = async (room, images) => {
      const record = {
        secret: secretOf(room.credential),
        images: [] as FakeTransport["imagesUploaded"][number]["images"],
      };
      transport.imagesUploaded.push(record);
      const answers: InlineUpload[] = [];
      for (const image of images) {
        let bytes: Uint8Array | null = null;
        try {
          bytes = await image.load();
          answers.push(
            transport.imageAnswer.kind === "failed" ? transport.imageAnswer : {
              kind: "inline",
              markup: `[${image.label}](/user_uploads/2/up/${nextUpload++}.png)`,
            },
          );
        } catch (err) {
          answers.push({ kind: "failed", error: String(err) });
        }
        record.images.push({ label: image.label, mime: image.mime, url: image.url, bytes });
      }
      return answers;
    };
  }
  return transport;
}

/** A Telegram message the way a mention in a group arrives. */
export function mention(
  overrides: Partial<InboundMessage> & { updateId: number; text?: string },
): PollUpdate {
  const { updateId, ...rest } = overrides;
  const chatId = rest.chatId ?? "-100200300";
  const rawText = rest.rawText ?? rest.text ?? "@ryph_bot look at the cache first";
  return {
    position: { offset: updateId + 1, queueId: null, lastMessageId: null },
    message: {
      messageId: `${chatId}:${updateId}`,
      threadKey: "",
      chatId,
      direct: false,
      channel: { id: chatId ?? "", name: "acme incidents", visibility: "private" },
      topic: null,
      sender: { id: "42", name: "Grace Hopper", isBot: false },
      hasAttachment: false,
      images: [],
      mentionsBot: true,
      servable: true,
      ...rest,
      rawText,
      text: rest.text !== undefined
        ? rest.text.replace(/@ryph_bot\s*/gi, "").trim()
        : rawText.replace(/@ryph_bot\s*/gi, "").trim(),
    },
  };
}

/**
 * A Discord mention, as the Gateway delivered it. `id` is the message's own snowflake and
 * `threadId` the thread it sits in — the same one for a mention at the top of a channel (the id
 * the thread it starts will take), the thread's for one inside it. The position is the session's
 * sequence number.
 */
export function discordMention(
  id: string,
  overrides: Partial<InboundMessage> & { channelId?: string; threadId?: string; seq?: number } = {},
): PollUpdate {
  const { channelId = "800000000000000010", threadId = id, seq = 1, ...rest } = overrides;
  return {
    position: { offset: seq, queueId: "session-1 wss://gateway.discord.gg", lastMessageId: null },
    message: {
      messageId: `${channelId}:${threadId}:${id}`,
      threadKey: `${channelId}:${threadId}`,
      chatId: null,
      direct: false,
      channel: { id: channelId, name: "ops", visibility: "private" },
      topic: threadId === id ? null : "cache is cold",
      sender: { id: "800000000000000077", name: "alice", isBot: false },
      rawText: "<@800000000000000099> investigate this",
      text: "investigate this",
      hasAttachment: false,
      images: [],
      mentionsBot: true,
      servable: true,
      ...rest,
    },
  };
}

/** A position-only update: something arrived that is nobody's business. */
export function noise(updateId: number): PollUpdate {
  return { position: { offset: updateId + 1, queueId: null, lastMessageId: null }, message: null };
}

/** A Zulip mention, delivered by the events queue. */
export function zulipMention(
  id: number,
  overrides: Partial<InboundMessage> = {},
  eventId = id,
): PollUpdate {
  return {
    position: { offset: eventId, queueId: "q-1", lastMessageId: id },
    message: {
      messageId: String(id),
      threadKey: String(id),
      chatId: null,
      direct: false,
      channel: { id: "4", name: "bugs", visibility: "public" },
      topic: "crash on sync",
      sender: { id: "8", name: "alice", isBot: false },
      rawText: "@**ryph** investigate this",
      text: "investigate this",
      hasAttachment: false,
      images: [],
      mentionsBot: true,
      servable: true,
      ...overrides,
    },
  };
}

/**
 * A Slack `app_mention`, as the socket delivered it. `ts` is the message's own timestamp and
 * `threadTs` the conversation it sits in — the same one for a mention that starts a thread, the
 * root's for a reply that steers the run already working there. Slack has no position to resume
 * from, so every update carries the same empty one.
 */
export function slackMention(
  ts: string,
  overrides: Partial<InboundMessage> & { channelId?: string; threadTs?: string } = {},
): PollUpdate {
  const { channelId = "C0OPS", threadTs = ts, ...rest } = overrides;
  return {
    position: { offset: 0, queueId: null, lastMessageId: null },
    message: {
      messageId: `${channelId}:${ts}:${threadTs}`,
      threadKey: `${channelId}:${threadTs}`,
      chatId: null,
      direct: false,
      channel: { id: channelId, name: "ops", visibility: "private" },
      topic: null,
      sender: { id: "U0ALICE", name: "alice", isBot: false },
      rawText: "<@U0BOT> investigate this",
      text: "investigate this",
      hasAttachment: false,
      images: [],
      mentionsBot: true,
      servable: true,
      ...rest,
    },
  };
}
