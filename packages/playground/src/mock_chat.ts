/**
 * Telegram, Zulip, Slack and Discord, as small as the chat service's transports need them to be:
 * one bot on each, a group (Telegram) or a few channels (Zulip, Slack, Discord), what the bot posts
 * recorded, and people's messages handed to the bot the way each platform delivers them
 * (Telegram's `getUpdates`, a Zulip events queue, a Slack Socket Mode socket, a Discord Gateway).
 * Served from this process on one port, with a page at `/` that shows every conversation and lets
 * you answer as a person.
 *
 * Routes, by platform:
 * - Telegram: `/telegram/bot<token>/<method>`, the host told by RYPH_CHAT_TELEGRAM_API_URL;
 * - Slack: `/slack/api/<method>` (RYPH_CHAT_SLACK_API_URL), the socket at `/slack/socket`;
 * - Discord: `/discord/api/v10/…` (RYPH_CHAT_DISCORD_API_URL), whose `GET /gateway/bot` names
 *   the Gateway at `/discord/gateway`;
 * - Zulip: `/api/v1/…` at the root, since a realm URL is an origin (`http://localhost:<port>`).
 *
 * What was said is kept in a JSON file beside the playground's database, so a restarted
 * playground still finds the messages its responses are keyed on. Uploaded images are not.
 */

import { readFile, writeFile } from "node:fs/promises";
import { type HttpServer, serve, type ServeHandlerInfo } from "@ryph/service";
import { renderViewer } from "./mock_chat_viewer.ts";

export type Platform = "telegram" | "zulip" | "slack" | "discord";

/** The mock Discord server (guild) the seeded room names. */
export const DISCORD_GUILD_ID = "900000000000000001";

/** The credentials the seeded chatrooms are created with; anything else is refused. */
export const CHAT_CREDENTIALS = {
  telegram: { botToken: "7000000001:playground-telegram-token" },
  zulip: { botEmail: "ryph-bot@zulip.acme.local", apiKey: "playground-zulip-key" },
  slack: { botToken: "xoxb-playground-bot", appToken: "xapp-playground-app" },
  discord: { botToken: "playground-discord-token", guildId: DISCORD_GUILD_ID },
} as const;

/** The people who talk in the mock rooms: the playground's own team. */
export const CHAT_PEOPLE = [
  { key: "olivia", name: "Olivia Owner", username: "olivia" },
  { key: "max", name: "Max Member", username: "max" },
] as const;

export type PersonKey = (typeof CHAT_PEOPLE)[number]["key"];

interface Person {
  key: string;
  name: string;
  username: string;
  telegramId: number;
  zulipId: number;
  slackId: string;
  discordId: string;
}

const PEOPLE: Person[] = CHAT_PEOPLE.map((p, i) => ({
  ...p,
  telegramId: 5000 + i,
  zulipId: 10 + i,
  slackId: `U0${p.username.toUpperCase()}`,
  discordId: String(900000000000000100n + BigInt(i)),
}));

const BOTS = {
  telegram: { id: "7000000001", name: "ryph_ops_bot" },
  zulip: { id: "100", name: "ryph" },
  slack: { id: "U0RYPHBOT", name: "ryph", botId: "B0RYPHBOT" },
  discord: { id: "900000000000000099", name: "ryph" },
} as const;

/** One channel; Telegram's group is its one channel. */
interface Channel {
  id: string;
  name: string;
  private: boolean;
}

const CHANNELS: Record<Platform, Channel[]> = {
  telegram: [{ id: "-1001000000001", name: "Ops", private: true }],
  zulip: [
    { id: "10", name: "incidents", private: true },
    { id: "11", name: "platform-oncall", private: true },
    { id: "12", name: "general", private: false },
  ],
  slack: [
    { id: "C0INCIDENTS", name: "incidents", private: true },
    { id: "C0ONCALL", name: "platform-oncall", private: true },
    { id: "C0GENERAL", name: "general", private: false },
  ],
  discord: [
    { id: "900000000000000011", name: "incidents", private: true },
    { id: "900000000000000012", name: "platform-oncall", private: true },
    { id: "900000000000000013", name: "general", private: false },
  ],
};

/** The private Zulip channel the seeded Grafana automation opens its responses in. */
export const ZULIP_INCIDENTS_CHANNEL = "10";

export const SPACE_NAMES: Record<Platform, string> = {
  telegram: "Telegram",
  zulip: "Acme Zulip",
  slack: "Acme Slack",
  discord: "Acme Discord",
};

/** A message as the viewer shows it, whichever platform it is on. */
export interface Message {
  /** The platform's own id: Telegram's message_id, Zulip's id, Slack's ts, Discord's snowflake. */
  id: string;
  /** The channel; on Discord, a thread's PARENT. */
  channelId: string;
  /** The conversation: Zulip's topic, the Slack thread's root ts, the Discord thread's id (the
   * message it was started from; a message's own id at the top of a channel), "" for Telegram's
   * group. */
  conversation: string;
  sender: { id: string; name: string; bot: boolean };
  text: string;
  at: number;
  /** Ids under `/files/`, for the images that came with it. */
  files: string[];
  reactions: string[];
}

interface Saved {
  version: 1;
  messages: Message[];
  next: {
    telegramMessage: number;
    telegramUpdate: number;
    zulipMessage: number;
    slackSeq: number;
    discordSeq?: number;
  };
  /** Discord's threads, by id (the message each was started from): their names. */
  discordThreads?: Record<string, string>;
}

interface TelegramUpdate {
  update_id: number;
  message: Record<string, unknown>;
}

interface ZulipEvent {
  id: number;
  type: "message";
  message: Record<string, unknown>;
  flags: string[];
}

export interface MockChat {
  readonly port: number;
  /** Where the host dials each platform. */
  readonly urls: {
    telegram: string;
    slack: string;
    discord: string;
    zulipRealm: string;
    viewer: string;
  };
  /** The Telegram group's chat id. */
  readonly telegramGroupId: string;
  /** A person says something, delivered to the bot as its platform would. */
  say(input: SayInput): Message;
  messages(): Message[];
  stop(): Promise<void>;
}

export interface SayInput {
  platform: Platform;
  channelId: string;
  /** Zulip's topic, or the Slack or Discord thread to reply in; null starts a new one (Slack,
   * Discord) or is refused (Zulip needs a topic). Ignored on Telegram. */
  conversation: string | null;
  as: string;
  text: string;
  /** Prepend the platform's mention of the bot. */
  mention: boolean;
}

/** How long a long poll is held when nothing arrives: well inside the service's own hold. */
const HOLD_MS = 15_000;

export async function serveMockChat(
  port: number,
  statePath: string,
): Promise<MockChat> {
  const state = await load(statePath);
  const files = new Map<string, { mime: string; bytes: Uint8Array }>();
  const telegramUpdates: TelegramUpdate[] = [];
  const zulipQueues = new Map<string, { events: ZulipEvent[]; next: number }>();
  const slackSockets = new Set<WebSocket>();
  /** Discord Gateway sockets, and each one's sequence once it identified. */
  const discordSockets = new Map<WebSocket, { seq: number; ready: boolean }>();
  const waiters = new Set<() => void>();
  const stopping = new AbortController();

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeFile(statePath, JSON.stringify(state) + "\n").catch(() => {});
    }, 200);
  };
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  /** Holds until `ready()` answers something or the hold runs out. */
  const waitFor = async <T>(ready: () => T | null, ms: number, signal: AbortSignal) => {
    const until = Date.now() + ms;
    for (;;) {
      const got = ready();
      if (got !== null) return got;
      const left = until - Date.now();
      if (left <= 0 || signal.aborted || stopping.signal.aborted) return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  };

  const record = (m: Omit<Message, "at" | "files" | "reactions"> & { files?: string[] }) => {
    const message: Message = { at: Date.now(), reactions: [], ...m, files: m.files ?? [] };
    state.messages.push(message);
    save();
    notify();
    return message;
  };
  const channel = (platform: Platform, id: string) =>
    CHANNELS[platform].find((c) => c.id === String(id)) ?? null;
  const storeFile = (mime: string, bytes: Uint8Array) => {
    const id = crypto.randomUUID();
    files.set(id, { mime, bytes });
    return id;
  };
  const slackTs = () => {
    state.next.slackSeq += 1;
    save();
    return `${Math.floor(Date.now() / 1000)}.${String(state.next.slackSeq).padStart(6, "0")}`;
  };

  // ── Telegram ────────────────────────────────────────────────────────────────────────────
  const telegramGroup = CHANNELS.telegram[0];
  const tgChat = { id: Number(telegramGroup.id), type: "supergroup", title: telegramGroup.name };
  const tgOk = (result: unknown) => Response.json({ ok: true, result });
  const tgError = (status: number, description: string) =>
    Response.json({ ok: false, error_code: status, description }, { status });

  const telegram = async (req: Request, token: string, method: string): Promise<Response> => {
    if (token !== CHAT_CREDENTIALS.telegram.botToken) return tgError(401, "Unauthorized");
    const form = (req.headers.get("content-type") ?? "").includes("multipart/form-data")
      ? await req.formData()
      : null;
    const body: Record<string, unknown> = form === null
      ? (await req.json().catch(() => ({})) as Record<string, unknown>)
      : Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"));
    const sent = (text: string, fileIds: string[] = []) => {
      if (String(body.chat_id) !== telegramGroup.id) return tgError(400, "chat not found");
      const id = state.next.telegramMessage++;
      record({
        id: String(id),
        channelId: telegramGroup.id,
        conversation: "",
        sender: { id: BOTS.telegram.id, name: BOTS.telegram.name, bot: true },
        text,
        files: fileIds,
      });
      return tgOk({ message_id: id, chat: tgChat, date: Math.floor(Date.now() / 1000), text });
    };
    const uploads = async (field: string) => {
      const f = form?.get(field);
      return f instanceof File ? [storeFile(f.type, new Uint8Array(await f.arrayBuffer()))] : [];
    };
    switch (method) {
      case "getMe":
        return tgOk({
          id: Number(BOTS.telegram.id),
          is_bot: true,
          first_name: "ryph",
          username: BOTS.telegram.name,
        });
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        // An offset confirms every update before it, as Telegram's does.
        while (telegramUpdates.length > 0 && telegramUpdates[0].update_id < offset) {
          telegramUpdates.shift();
        }
        const holdMs = Math.min(Number(body.timeout ?? 0) * 1000, HOLD_MS);
        const ready = () => {
          const due = telegramUpdates.filter((u) => u.update_id >= offset);
          return due.length > 0 ? due : null;
        };
        return tgOk(await waitFor(ready, holdMs, req.signal) ?? []);
      }
      case "sendMessage":
        return sent(String(body.text ?? ""));
      case "sendPhoto":
        return sent(String(body.caption ?? ""), await uploads("photo"));
      case "sendDocument":
        return sent(String(body.caption ?? ""), await uploads("document"));
      case "sendMediaGroup": {
        const media = JSON.parse(String(body.media ?? "[]")) as Array<
          { media: string; caption?: string }
        >;
        const ids: string[] = [];
        for (const m of media) ids.push(...await uploads(m.media.replace("attach://", "")));
        const res = sent(media.map((m) => m.caption).filter(Boolean).join("\n"), ids);
        return res;
      }
      default:
        return tgError(404, `Not Found: method ${method} is not mocked`);
    }
  };

  const telegramSay = (person: Person, text: string): Message => {
    const id = state.next.telegramMessage++;
    const entities = [...text.matchAll(/@[A-Za-z0-9_]+/g)].map((m) => ({
      type: "mention",
      offset: m.index!,
      length: m[0].length,
    }));
    telegramUpdates.push({
      update_id: state.next.telegramUpdate++,
      message: {
        message_id: id,
        chat: tgChat,
        date: Math.floor(Date.now() / 1000),
        from: {
          id: person.telegramId,
          is_bot: false,
          first_name: person.name.split(" ")[0],
          last_name: person.name.split(" ").slice(1).join(" ") || undefined,
          username: person.username,
        },
        text,
        ...(entities.length ? { entities } : {}),
      },
    });
    return record({
      id: String(id),
      channelId: telegramGroup.id,
      conversation: "",
      sender: { id: String(person.telegramId), name: person.name, bot: false },
      text,
    });
  };

  // ── Zulip ───────────────────────────────────────────────────────────────────────────────
  const zOk = (rest: Record<string, unknown> = {}) =>
    Response.json({ result: "success", msg: "", ...rest });
  const zError = (status: number, code: string, msg: string) =>
    Response.json({ result: "error", code, msg }, { status });
  const zStream = (c: Channel) => ({
    stream_id: Number(c.id),
    name: c.name,
    description: "",
    invite_only: c.private,
    is_web_public: false,
    history_public_to_subscribers: true,
    is_archived: false,
  });
  const mentionsZulipBot = (text: string) => text.includes(`@**${BOTS.zulip.name}**`);
  const zMessage = (m: Message) => ({
    id: Number(m.id),
    type: "stream",
    sender_id: Number(m.sender.id),
    sender_full_name: m.sender.name,
    sender_realm_str: "acme",
    content: m.text,
    timestamp: Math.floor(m.at / 1000),
    stream_id: Number(m.channelId),
    display_recipient: channel("zulip", m.channelId)?.name ?? m.channelId,
    subject: m.conversation,
    flags: mentionsZulipBot(m.text) && !m.sender.bot ? ["read", "mentioned"] : ["read"],
  });
  const zulipIds = new Set(CHANNELS.zulip.map((c) => c.id));
  const zulipMessages = () => state.messages.filter((m) => zulipIds.has(m.channelId));

  const zulip = async (req: Request, path: string): Promise<Response> => {
    const expected = `Basic ${
      btoa(`${CHAT_CREDENTIALS.zulip.botEmail}:${CHAT_CREDENTIALS.zulip.apiKey}`)
    }`;
    if (req.headers.get("authorization") !== expected) {
      return zError(401, "UNAUTHORIZED", "Invalid API key");
    }
    const url = new URL(req.url);
    const params = new Map<string, string>(url.searchParams);
    if (req.method !== "GET") {
      const type = req.headers.get("content-type") ?? "";
      if (type.includes("multipart/form-data")) {
        const form = await req.formData();
        const file = form.get("file");
        if (path === "/user_uploads" && file instanceof File) {
          const id = storeFile(file.type, new Uint8Array(await file.arrayBuffer()));
          const token = id.replaceAll("-", "").slice(0, 24);
          const name = file.name.replace(/[^\w.-]/g, "-");
          zulipUploads.set(`2/${token}/${name}`, id);
          return zOk({
            url: `/user_uploads/2/${token}/${name}`,
            uri: `/user_uploads/2/${token}/${name}`,
          });
        }
        return zError(400, "BAD_REQUEST", "no file");
      }
      for (const [k, v] of new URLSearchParams(await req.text())) params.set(k, v);
    }
    const json = (key: string) => {
      try {
        return JSON.parse(params.get(key) ?? "null");
      } catch {
        return params.get(key);
      }
    };
    const route = `${req.method} ${path}`;
    let m: RegExpMatchArray | null;
    if (route === "GET /users/me") {
      return zOk({
        user_id: Number(BOTS.zulip.id),
        full_name: BOTS.zulip.name,
        email: CHAT_CREDENTIALS.zulip.botEmail,
        is_bot: true,
      });
    }
    if ((m = route.match(/^GET \/users\/(\d+)$/))) {
      if (m[1] === BOTS.zulip.id) return zOk({ user: { user_id: Number(m[1]), is_bot: true } });
      const p = PEOPLE.find((p) => String(p.zulipId) === m![1]);
      return p
        ? zOk({ user: { user_id: p.zulipId, full_name: p.name, is_bot: false } })
        : zError(400, "BAD_REQUEST", "No such user");
    }
    if (route === "GET /server_settings") {
      return zOk({ realm_name: SPACE_NAMES.zulip, zulip_feature_level: 500 });
    }
    if (route === "GET /streams") return zOk({ streams: CHANNELS.zulip.map(zStream) });
    if ((m = route.match(/^GET \/streams\/(\d+)$/))) {
      const c = channel("zulip", m[1]);
      return c ? zOk({ stream: zStream(c) }) : zError(400, "BAD_REQUEST", "Invalid channel ID");
    }
    if (route === "GET /user_groups") {
      return zOk({
        user_groups: [{
          id: 1,
          name: "oncall",
          description: "Whoever is on call this week",
          is_system_group: false,
        }],
      });
    }
    if ((m = route.match(/^GET \/user_groups\/(\d+)\/members\/(\d+)$/))) {
      return zOk({ is_user_group_member: m[1] === "1" && m[2] === String(PEOPLE[0].zulipId) });
    }
    if (route === "POST /register") {
      const eventTypes = json("event_types") as string[] | null;
      const queueId = crypto.randomUUID();
      if (eventTypes?.length) zulipQueues.set(queueId, { events: [], next: 0 });
      const ids = zulipMessages().map((m) => Number(m.id));
      return zOk({
        queue_id: queueId,
        last_event_id: -1,
        max_message_id: ids.length ? Math.max(...ids) : -1,
        max_message_length: 10_000,
      });
    }
    if (route === "DELETE /events") {
      zulipQueues.delete(params.get("queue_id") ?? "");
      return zOk();
    }
    if (route === "GET /events") {
      const queue = zulipQueues.get(params.get("queue_id") ?? "");
      if (!queue) return zError(400, "BAD_EVENT_QUEUE_ID", "Bad event queue ID");
      const last = Number(params.get("last_event_id") ?? -1);
      // Everything up to what the caller has seen is acknowledged, as Zulip does.
      queue.events = queue.events.filter((e) => e.id > last);
      const ready = () => queue.events.length > 0 ? queue.events : null;
      const hold = params.get("dont_block") === "true" ? 0 : HOLD_MS;
      const events = await waitFor(ready, hold, req.signal);
      return zOk({ events: events ?? [] });
    }
    if ((m = route.match(/^GET \/messages\/(\d+)$/))) {
      const found = zulipMessages().find((x) => x.id === m![1]);
      return found
        ? zOk({ message: zMessage(found) })
        : zError(400, "BAD_REQUEST", "Invalid message(s)");
    }
    if (route === "GET /messages") {
      const narrow = (json("narrow") ?? []) as Array<{ operator: string; operand: unknown }>;
      const all = zulipMessages().sort((a, b) => Number(a.id) - Number(b.id));
      const with_ = narrow.find((n) => n.operator === "with");
      if (with_) {
        const key = all.find((x) => x.id === String(with_.operand));
        if (!key) return zError(400, "BAD_NARROW", "Invalid narrow");
        const thread = all.filter((x) =>
          x.channelId === key.channelId && x.conversation === key.conversation
        );
        const before = Number(params.get("num_before") ?? 100);
        return zOk({
          messages: thread.slice(-before).map(zMessage),
          found_oldest: thread.length <= before,
          found_newest: true,
        });
      }
      if (narrow.some((n) => n.operator === "is" && n.operand === "mentioned")) {
        const anchor = Number(params.get("anchor") ?? 0);
        const after = Number(params.get("num_after") ?? 100);
        const hits = all.filter((x) =>
          Number(x.id) > anchor && !x.sender.bot && mentionsZulipBot(x.text)
        );
        return zOk({
          messages: hits.slice(0, after).map(zMessage),
          found_newest: hits.length <= after,
        });
      }
      return zOk({ messages: [], found_newest: true, found_oldest: true });
    }
    if (route === "POST /messages") {
      const c = channel("zulip", params.get("to") ?? "") ??
        CHANNELS.zulip.find((c) => c.name === params.get("to")) ?? null;
      if (!c) return zError(400, "STREAM_DOES_NOT_EXIST", "Channel does not exist");
      const id = state.next.zulipMessage++;
      record({
        id: String(id),
        channelId: c.id,
        conversation: params.get("topic") ?? "",
        sender: { id: BOTS.zulip.id, name: BOTS.zulip.name, bot: true },
        text: params.get("content") ?? "",
      });
      return zOk({ id });
    }
    if ((m = route.match(/^POST \/messages\/(\d+)\/reactions$/))) {
      const found = zulipMessages().find((x) => x.id === m![1]);
      if (!found) return zError(400, "BAD_REQUEST", "Invalid message(s)");
      found.reactions.push(params.get("emoji_name") ?? "?");
      save();
      notify();
      return zOk();
    }
    if ((m = route.match(/^GET \/user_uploads\/(.+)$/))) {
      const id = zulipUploads.get(m[1]);
      return id ? zOk({ url: `/files/${id}` }) : zError(404, "NOT_FOUND", "no such upload");
    }
    return zError(404, "NOT_FOUND", `${route} is not mocked`);
  };
  const zulipUploads = new Map<string, string>();

  const zulipSay = (person: Person, c: Channel, topic: string, text: string): Message => {
    const id = state.next.zulipMessage++;
    const message = record({
      id: String(id),
      channelId: c.id,
      conversation: topic,
      sender: { id: String(person.zulipId), name: person.name, bot: false },
      text,
    });
    const event = zMessage(message);
    for (const queue of zulipQueues.values()) {
      queue.events.push({ id: queue.next++, type: "message", message: event, flags: event.flags });
    }
    notify();
    return message;
  };

  // ── Slack ───────────────────────────────────────────────────────────────────────────────
  const sError = (error: string) => Response.json({ ok: false, error });
  const sChannel = (c: Channel) => ({
    id: c.id,
    name: c.name,
    is_channel: true,
    is_private: c.private,
    is_archived: false,
    is_member: true,
  });
  const sMessage = (m: Message) => ({
    type: "message",
    ...(m.sender.bot ? { bot_id: BOTS.slack.botId } : {}),
    user: m.sender.id,
    text: m.text,
    ts: m.id,
    ...(m.conversation !== m.id ? { thread_ts: m.conversation } : {}),
    ...(m.files.length
      ? { files: m.files.map((id) => ({ id, mimetype: files.get(id)?.mime })) }
      : {}),
  });
  const slackUploads = new Map<string, string>();

  const slack = async (req: Request, method: string, base: string): Promise<Response> => {
    const auth = req.headers.get("authorization");
    const appCall = method === "apps.connections.open";
    const token = appCall ? CHAT_CREDENTIALS.slack.appToken : CHAT_CREDENTIALS.slack.botToken;
    if (auth !== `Bearer ${token}`) return sError("invalid_auth");
    const p = Object.fromEntries(new URLSearchParams(await req.text()));
    const posted = (c: Channel, text: string, threadTs: string | undefined, fileIds: string[]) => {
      const ts = slackTs();
      record({
        id: ts,
        channelId: c.id,
        conversation: threadTs ?? ts,
        sender: { id: BOTS.slack.id, name: BOTS.slack.name, bot: true },
        text,
        files: fileIds,
      });
      return ts;
    };
    switch (method) {
      case "auth.test":
        return Response.json({
          ok: true,
          url: "https://acme.slack.local/",
          team: SPACE_NAMES.slack,
          user: BOTS.slack.name,
          team_id: "T0ACME",
          user_id: BOTS.slack.id,
          bot_id: BOTS.slack.botId,
        });
      case "apps.connections.open":
        return Response.json({ ok: true, url: `${base.replace(/^http/, "ws")}/slack/socket` });
      case "users.conversations":
      case "conversations.list":
        return Response.json({
          ok: true,
          channels: CHANNELS.slack.map(sChannel),
          response_metadata: { next_cursor: "" },
        });
      case "conversations.info": {
        const c = channel("slack", p.channel ?? "");
        return c ? Response.json({ ok: true, channel: sChannel(c) }) : sError("channel_not_found");
      }
      case "users.info": {
        if (p.user === BOTS.slack.id) {
          return Response.json({
            ok: true,
            user: { id: p.user, name: BOTS.slack.name, is_bot: true },
          });
        }
        const who = PEOPLE.find((x) => x.slackId === p.user);
        return who
          ? Response.json({
            ok: true,
            user: {
              id: who.slackId,
              name: who.username,
              real_name: who.name,
              is_bot: false,
              profile: { display_name: who.name, real_name: who.name },
            },
          })
          : sError("user_not_found");
      }
      case "chat.postMessage": {
        const c = channel("slack", p.channel ?? "");
        if (!c) return sError("channel_not_found");
        const ts = posted(c, p.text ?? "", p.thread_ts, []);
        return Response.json({ ok: true, channel: c.id, ts });
      }
      case "conversations.replies": {
        const c = channel("slack", p.channel ?? "");
        if (!c) return sError("channel_not_found");
        const thread = state.messages.filter((m) =>
          m.channelId === c.id && (m.id === p.ts || m.conversation === p.ts)
        );
        if (!thread.some((m) => m.id === p.ts)) return sError("thread_not_found");
        return Response.json({
          ok: true,
          messages: thread.map(sMessage),
          has_more: false,
          response_metadata: { next_cursor: "" },
        });
      }
      case "reactions.add": {
        const found = state.messages.find((m) => m.channelId === p.channel && m.id === p.timestamp);
        if (!found) return sError("message_not_found");
        if (found.reactions.includes(p.name)) return sError("already_reacted");
        found.reactions.push(p.name);
        save();
        notify();
        return Response.json({ ok: true });
      }
      case "usergroups.list":
        return Response.json({
          ok: true,
          usergroups: [{ id: "S0ONCALL", handle: "oncall", name: "On-call", description: "" }],
        });
      case "usergroups.users.list":
        return Response.json({
          ok: true,
          users: p.usergroup === "S0ONCALL" ? [PEOPLE[0].slackId] : [],
        });
      case "files.getUploadURLExternal": {
        const fileId = `F${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        return Response.json({
          ok: true,
          file_id: fileId,
          upload_url: `${base}/slack/upload/${fileId}`,
        });
      }
      case "files.completeUploadExternal": {
        const c = channel("slack", p.channel_id ?? "");
        if (!c) return sError("channel_not_found");
        const done = JSON.parse(p.files ?? "[]") as Array<{ id: string; title?: string }>;
        posted(
          c,
          done.map((f) => f.title ?? "").filter(Boolean).join("\n"),
          p.thread_ts,
          done.map((f) => slackUploads.get(f.id)).filter((x): x is string => x !== undefined),
        );
        return Response.json({ ok: true, files: done.map((f) => ({ id: f.id })) });
      }
      default:
        return sError("unknown_method");
    }
  };

  const slackSay = (
    person: Person,
    c: Channel,
    threadTs: string | null,
    text: string,
  ): Message => {
    const ts = slackTs();
    const message = record({
      id: ts,
      channelId: c.id,
      conversation: threadTs ?? ts,
      sender: { id: person.slackId, name: person.name, bot: false },
      text,
    });
    // Only an `app_mention` is ever delivered: the transport reads nothing else off the socket.
    if (text.includes(`<@${BOTS.slack.id}>`)) {
      const frame = JSON.stringify({
        type: "events_api",
        envelope_id: crypto.randomUUID(),
        accepts_response_payload: false,
        payload: {
          type: "event_callback",
          event: {
            type: "app_mention",
            user: person.slackId,
            text,
            ts,
            ...(threadTs === null ? {} : { thread_ts: threadTs }),
            channel: c.id,
            channel_type: c.private ? "group" : "channel",
          },
        },
      });
      for (const socket of slackSockets) socket.send(frame);
    }
    return message;
  };

  // ── Discord ─────────────────────────────────────────────────────────────────────────────
  const threads = (state.discordThreads ??= {});
  const discordGuild = { id: DISCORD_GUILD_ID, name: SPACE_NAMES.discord };
  const snowflake = () => {
    state.next.discordSeq = (state.next.discordSeq ?? 0) + 1;
    save();
    return String(
      ((BigInt(Date.now()) - 1420070400000n) << 22n) | BigInt(state.next.discordSeq % 4096),
    );
  };
  const dError = (status: number, code: number, message: string) =>
    Response.json({ message, code }, { status });
  const dChannel = (c: Channel) => ({
    id: c.id,
    type: 0,
    name: c.name,
    guild_id: DISCORD_GUILD_ID,
    // Private as Discord's own switch makes one: `@everyone` (the server's id) denied View Channel.
    permission_overwrites: c.private
      ? [{ id: DISCORD_GUILD_ID, type: 0, allow: "0", deny: "1024" }]
      : [],
  });
  /** A thread: one started from a message in a channel, by that message's id. */
  const dThread = (id: string) => {
    const parent = state.messages.find((m) => m.id === id && channel("discord", m.channelId));
    return parent && threads[id] !== undefined
      ? {
        id,
        type: 11,
        name: threads[id],
        parent_id: parent.channelId,
        guild_id: DISCORD_GUILD_ID,
      }
      : null;
  };
  const discordAuthor = (m: Message) =>
    m.sender.bot
      ? { id: BOTS.discord.id, username: BOTS.discord.name, bot: true }
      : { id: m.sender.id, username: m.sender.name.toLowerCase(), global_name: m.sender.name };
  const dMessage = (m: Message) => ({
    id: m.id,
    type: 0,
    // A thread's starter sits in its parent; everything else in a thread sits in the thread.
    channel_id: m.conversation !== m.id ? m.conversation : m.channelId,
    guild_id: DISCORD_GUILD_ID,
    author: discordAuthor(m),
    content: m.text,
    timestamp: new Date(m.at).toISOString(),
    mentions: m.text.includes(`<@${BOTS.discord.id}>`)
      ? [{ id: BOTS.discord.id, username: BOTS.discord.name, bot: true }]
      : [],
    attachments: m.files.map((id) => ({
      id,
      filename: "image.png",
      content_type: files.get(id)?.mime,
      url: `${discordBase}/files/${id}`,
    })),
  });
  let discordBase = `http://127.0.0.1:${port}`;
  /** Every identified socket hears every message, as GUILD_MESSAGES delivers them. */
  const dispatch = (t: string, d: unknown) => {
    for (const [socket, session] of discordSockets) {
      if (!session.ready) continue;
      session.seq += 1;
      socket.send(JSON.stringify({ op: 0, t, s: session.seq, d }));
    }
  };
  /** Where a post to `/channels/<id>/messages` lands: a channel's top, or a thread. */
  const discordTarget = (id: string): { channel: Channel; conversation: string | null } | null => {
    const c = channel("discord", id);
    if (c) return { channel: c, conversation: null };
    const t = dThread(id);
    const parent = t ? channel("discord", t.parent_id) : null;
    return parent ? { channel: parent, conversation: id } : null;
  };
  const discordPost = (
    target: { channel: Channel; conversation: string | null },
    sender: Message["sender"],
    text: string,
    fileIds: string[] = [],
  ): Message => {
    const id = snowflake();
    const message = record({
      id,
      channelId: target.channel.id,
      conversation: target.conversation ?? id,
      sender,
      text,
      files: fileIds,
    });
    dispatch("MESSAGE_CREATE", dMessage(message));
    return message;
  };

  const discord = async (req: Request, path: string, base: string): Promise<Response> => {
    discordBase = base;
    if (req.headers.get("authorization") !== `Bot ${CHAT_CREDENTIALS.discord.botToken}`) {
      return dError(401, 0, "401: Unauthorized");
    }
    const route = `${req.method} ${path}`;
    let m: RegExpMatchArray | null;
    if (route === "GET /users/@me") {
      return Response.json({ id: BOTS.discord.id, username: BOTS.discord.name, bot: true });
    }
    // Message Content on, as an unverified app gets it by flipping the switch.
    // Public Bot off, as the setup asks.
    if (route === "GET /applications/@me") {
      return Response.json({ id: "1", flags: 1 << 19, bot_public: false });
    }
    if (route === "GET /gateway/bot") {
      return Response.json({ url: `${base.replace(/^http/, "ws")}/discord/gateway`, shards: 1 });
    }
    if ((m = route.match(/^GET \/guilds\/(\d+)(\/.*)?$/))) {
      if (m[1] !== DISCORD_GUILD_ID) return dError(404, 10004, "Unknown Guild");
      const rest = m[2] ?? "";
      if (rest === "") return Response.json(discordGuild);
      if (rest === "/channels") return Response.json(CHANNELS.discord.map(dChannel));
      if (rest === "/roles") {
        return Response.json([
          { id: DISCORD_GUILD_ID, name: "@everyone" },
          { id: "900000000000000201", name: "oncall" },
          // The bot's own managed role, which a mention may name instead of the bot.
          {
            id: "900000000000000202",
            name: "ryph",
            managed: true,
            tags: { bot_id: BOTS.discord.id },
          },
        ]);
      }
      const member = rest.match(/^\/members\/(\d+)$/);
      if (member) {
        const who = PEOPLE.find((p) => p.discordId === member[1]);
        if (!who) return dError(404, 10007, "Unknown Member");
        // Olivia is on call, as on Slack.
        return Response.json({ roles: who === PEOPLE[0] ? ["900000000000000201"] : [] });
      }
      return dError(404, 0, "404: Not Found");
    }
    if ((m = route.match(/^GET \/channels\/(\d+)$/))) {
      const c = channel("discord", m[1]);
      const t = c ? dChannel(c) : dThread(m[1]);
      return t ? Response.json(t) : dError(404, 10003, "Unknown Channel");
    }
    if ((m = route.match(/^GET \/channels\/(\d+)\/messages\/(\d+)$/))) {
      const found = state.messages.find((x) =>
        x.id === m![2] && (x.channelId === m![1] || x.conversation === m![1])
      );
      return found ? Response.json(dMessage(found)) : dError(404, 10008, "Unknown Message");
    }
    if ((m = route.match(/^GET \/channels\/(\d+)\/messages$/))) {
      const t = dThread(m[1]);
      if (!t) return dError(404, 10003, "Unknown Channel");
      const url = new URL(req.url);
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const inThread = state.messages
        .filter((x) => x.conversation === t.id && x.id !== t.id)
        .filter((x) => before === null || BigInt(x.id) < BigInt(before))
        .reverse()
        .slice(0, limit);
      return Response.json(inThread.map(dMessage));
    }
    if ((m = route.match(/^POST \/channels\/(\d+)\/messages$/))) {
      const target = discordTarget(m[1]);
      if (!target) return dError(404, 10003, "Unknown Channel");
      const form = (req.headers.get("content-type") ?? "").includes("multipart/form-data")
        ? await req.formData()
        : null;
      const body = (form === null
        ? await req.json()
        : JSON.parse(String(form.get("payload_json") ?? "{}"))) as { content?: string };
      const fileIds: string[] = [];
      for (const [name, value] of form?.entries() ?? []) {
        if (!name.startsWith("files[") || typeof value === "string") {
          continue;
        }
        fileIds.push(
          storeFile(value.type || "image/png", new Uint8Array(await value.arrayBuffer())),
        );
      }
      const posted = discordPost(
        target,
        { id: BOTS.discord.id, name: BOTS.discord.name, bot: true },
        body.content ?? "",
        fileIds,
      );
      return Response.json(dMessage(posted));
    }
    if ((m = route.match(/^POST \/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
      const starter = state.messages.find((x) => x.id === m![2] && x.channelId === m![1]);
      if (!starter || starter.conversation !== starter.id) {
        return dError(404, 10008, "Unknown Message");
      }
      if (threads[starter.id] !== undefined) {
        return dError(400, 160004, "A thread has already been created for this message");
      }
      const { name } = await req.json() as { name?: string };
      threads[starter.id] = (name ?? "").slice(0, 100) || "thread";
      save();
      notify();
      return Response.json(dThread(starter.id));
    }
    if ((m = route.match(/^DELETE \/channels\/(\d+)\/messages\/(\d+)$/))) {
      const at = state.messages.findIndex((x) => x.id === m![2]);
      if (at === -1) return dError(404, 10008, "Unknown Message");
      state.messages.splice(at, 1);
      save();
      notify();
      return new Response(null, { status: 204 });
    }
    if ((m = route.match(/^PUT \/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/))) {
      const found = state.messages.find((x) => x.id === m![2]);
      if (!found) return dError(404, 10008, "Unknown Message");
      const emoji = decodeURIComponent(m[3]);
      if (!found.reactions.includes(emoji)) found.reactions.push(emoji);
      save();
      notify();
      return new Response(null, { status: 204 });
    }
    return dError(404, 0, "404: Not Found");
  };

  /** One Gateway frame from the adapter: identify, resume, heartbeat. */
  const gatewayFrame = (socket: WebSocket, text: string, base: string) => {
    const session = discordSockets.get(socket);
    if (!session) return;
    let frame: { op?: number; d?: Record<string, unknown> };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (frame.op === 1) {
      socket.send(JSON.stringify({ op: 11 }));
      return;
    }
    if (frame.op !== 2 && frame.op !== 6) return;
    if (frame.d?.token !== CHAT_CREDENTIALS.discord.botToken) {
      socket.close(4004, "Authentication failed.");
      return;
    }
    session.ready = true;
    session.seq += 1;
    // A resume replays nothing here: the mock keeps no session history, which is the case of a
    // session Discord had already let go of — the adapter loses nothing it would not lose there.
    socket.send(JSON.stringify(
      frame.op === 2
        ? {
          op: 0,
          t: "READY",
          s: session.seq,
          d: {
            v: 10,
            session_id: crypto.randomUUID(),
            resume_gateway_url: `${base.replace(/^http/, "ws")}/discord/gateway`,
            user: { id: BOTS.discord.id, username: BOTS.discord.name, bot: true },
            guilds: [{ id: DISCORD_GUILD_ID, unavailable: true }],
          },
        }
        : { op: 0, t: "RESUMED", s: session.seq, d: null },
    ));
  };

  const discordSay = (
    person: Person,
    c: Channel,
    threadId: string | null,
    text: string,
  ): Message => {
    const sender = { id: person.discordId, name: person.name, bot: false };
    if (threadId === null) return discordPost({ channel: c, conversation: null }, sender, text);
    // Answering in a conversation that is still one message: the client starts its thread, as
    // a person clicking "Create Thread" on it would.
    if (threads[threadId] === undefined) {
      const starter = state.messages.find((m) => m.id === threadId);
      threads[threadId] = (starter?.text ?? "thread").replace(/<@\d+>/g, "").trim()
        .slice(0, 100) || "thread";
      save();
    }
    return discordPost({ channel: c, conversation: threadId }, sender, text);
  };

  // ── People, from the viewer ─────────────────────────────────────────────────────────────
  const say = (input: SayInput): Message => {
    const person = PEOPLE.find((p) => p.key === input.as) ?? PEOPLE[0];
    const c = channel(input.platform, input.channelId);
    if (!c) throw new Error(`no ${input.platform} channel ${input.channelId}`);
    const text = input.text.trim();
    if (!text) throw new Error("say something");
    switch (input.platform) {
      case "telegram":
        return telegramSay(person, input.mention ? `@${BOTS.telegram.name} ${text}` : text);
      case "zulip": {
        const topic = (input.conversation ?? "").trim();
        if (!topic) throw new Error("a Zulip message needs a topic");
        return zulipSay(person, c, topic, input.mention ? `@**${BOTS.zulip.name}** ${text}` : text);
      }
      case "slack":
        return slackSay(
          person,
          c,
          input.conversation || null,
          input.mention ? `<@${BOTS.slack.id}> ${text}` : text,
        );
      case "discord":
        return discordSay(
          person,
          c,
          input.conversation || null,
          input.mention ? `<@${BOTS.discord.id}> ${text}` : text,
        );
    }
  };

  const snapshot = () => ({
    bots: BOTS,
    people: PEOPLE.map(({ key, name }) => ({ key, name })),
    discordThreads: threads,
    platforms: (["telegram", "zulip", "slack", "discord"] as const).map((platform) => ({
      platform,
      name: SPACE_NAMES[platform],
      channels: CHANNELS[platform].map((c) => ({
        ...c,
        messages: state.messages.filter((m) => m.channelId === c.id),
      })),
    })),
  });

  const handler = async (req: Request, info: ServeHandlerInfo): Promise<Response> => {
    const url = new URL(req.url);
    const base = `http://${req.headers.get("host") ?? `127.0.0.1:${port}`}`;
    const path = url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/telegram\/bot([^/]+)\/([A-Za-z]+)$/))) {
      return await telegram(req, decodeURIComponent(m[1]), m[2]);
    }
    if ((m = path.match(/^\/slack\/api\/([A-Za-z.]+)$/))) return await slack(req, m[1], base);
    if (path === "/slack/socket") {
      const { socket, response } = info.upgradeWebSocket(req, { idleTimeout: 0 });
      socket.onopen = () => {
        slackSockets.add(socket);
        socket.send(JSON.stringify({ type: "hello", num_connections: slackSockets.size }));
      };
      socket.onclose = () => slackSockets.delete(socket);
      return response;
    }
    if (path.startsWith("/discord/api/v10/")) {
      return await discord(req, path.slice("/discord/api/v10".length), base);
    }
    if (path === "/discord/gateway") {
      const { socket, response } = info.upgradeWebSocket(req, { idleTimeout: 0 });
      socket.onopen = () => {
        discordSockets.set(socket, { seq: 0, ready: false });
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));
      };
      socket.onmessage = (event) => gatewayFrame(socket, String(event.data), base);
      socket.onclose = () => discordSockets.delete(socket);
      return response;
    }
    if ((m = path.match(/^\/slack\/upload\/([A-Z0-9]+)$/)) && req.method === "POST") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      slackUploads.set(m[1], storeFile("image/png", bytes));
      return new Response("OK - " + bytes.byteLength);
    }
    if (path.startsWith("/api/v1/")) return await zulip(req, path.slice("/api/v1".length));
    if ((m = path.match(/^\/files\/([0-9a-f-]+)$/))) {
      const f = files.get(m[1]);
      return f
        ? new Response(f.bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": f.mime } })
        : new Response("gone", { status: 404 });
    }
    if (path === "/" && req.method === "GET") {
      return new Response(renderViewer(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/state.json") return Response.json(snapshot());
    if (path === "/say" && req.method === "POST") {
      try {
        const body = await req.json() as SayInput;
        return Response.json({ message: say(body) });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  // Loopback on both families: a Zulip realm URL must name `localhost`, which may be either.
  const servers: HttpServer[] = [
    await serve({ port, hostname: "127.0.0.1", onListen() {} }, handler),
  ];
  // Port 0 (tests) asks for a free one; the second family takes the same.
  port = servers[0].addr.port;
  try {
    servers.push(await serve({ port, hostname: "::1", onListen() {} }, handler));
  } catch { /* no IPv6 loopback: localhost is 127.0.0.1 here */ }

  return {
    port,
    urls: {
      telegram: `http://127.0.0.1:${port}/telegram`,
      slack: `http://127.0.0.1:${port}/slack/api`,
      discord: `http://127.0.0.1:${port}/discord/api/v10`,
      zulipRealm: `http://localhost:${port}`,
      viewer: `http://localhost:${port}/`,
    },
    telegramGroupId: telegramGroup.id,
    say,
    messages: () => [...state.messages],
    async stop() {
      stopping.abort();
      notify();
      for (const socket of slackSockets) socket.close();
      for (const socket of discordSockets.keys()) socket.close();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        await writeFile(statePath, JSON.stringify(state) + "\n").catch(() => {});
      }
      await Promise.all(servers.map((s) => s.shutdown()));
    },
  };
}

async function load(path: string): Promise<Saved> {
  try {
    const saved = JSON.parse(await readFile(path, "utf8")) as Saved;
    if (saved.version === 1) return saved;
  } catch { /* none yet */ }
  return {
    version: 1,
    messages: [],
    next: { telegramMessage: 1, telegramUpdate: 1, zulipMessage: 1000, slackSeq: 0 },
  };
}
