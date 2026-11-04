// The mock chat platforms, driven by the chat service's own transports: what each transport calls
// is answered, a person's mention reaches the bot, and what the bot says is recorded.

import { afterAll, beforeAll, test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformTransports } from "@ryph/chat";
import type { PlatformRoom } from "@ryph/chat";
import { CHAT_CREDENTIALS, type MockChat, serveMockChat } from "../src/mock_chat.ts";

let dir: string;
let chat: MockChat;
let transports: ReturnType<typeof platformTransports>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mock-chat-"));
  chat = await serveMockChat(0, join(dir, "chat.json"));
  transports = platformTransports({
    telegram: chat.urls.telegram,
    slack: chat.urls.slack,
    discord: chat.urls.discord,
  });
});

afterAll(async () => {
  await chat.stop();
  await rm(dir, { recursive: true, force: true });
});

const signal = () => AbortSignal.timeout(10_000);

test("telegram: the bot, a linking mention from the group, a post into it", async () => {
  const t = transports.telegram;
  const credential = { kind: "telegram" as const, ...CHAT_CREDENTIALS.telegram };
  const me = await t.whoAmI(credential);
  const room: PlatformRoom = {
    id: "chr_tg",
    credential,
    bot: { id: me.id, name: me.name },
    chatId: null,
    chatTitle: null,
  };
  chat.say({
    platform: "telegram",
    channelId: chat.telegramGroupId,
    conversation: null,
    as: "olivia",
    text: "link code-1",
    mention: true,
  });
  const batch = await t.poll(room, { position: null, timeoutS: 1, signal: signal() });
  const msg = batch.updates[0].message!;
  assertEquals([msg.chatId, msg.mentionsBot, msg.text, msg.direct], [
    chat.telegramGroupId,
    true,
    "link code-1",
    false,
  ]);
  // Asked again from the cursor: nothing new, after a short hold.
  const again = await t.poll(room, { position: batch.position, timeoutS: 1, signal: signal() });
  assertEquals(again.updates, []);
  const key = await t.send(
    { ...room, chatId: chat.telegramGroupId },
    { channelId: chat.telegramGroupId, topic: null },
    "**hello**",
  );
  assert(key.startsWith(`${chat.telegramGroupId}:`));
  assertEquals(chat.messages().at(-1)?.text, "<b>hello</b>");
});

test("zulip: the realm, its channels, a queue that hears a mention, a topic opened and read", async () => {
  const z = transports.zulip;
  const credential = {
    kind: "zulip" as const,
    realmUrl: chat.urls.zulipRealm.replace("localhost", "127.0.0.1"),
    ...CHAT_CREDENTIALS.zulip,
  };
  const me = await z.whoAmI(credential);
  assertEquals(me.title, "Acme Zulip");
  const room: PlatformRoom = {
    id: "chr_z",
    credential,
    bot: { id: me.id, name: me.name },
    chatId: null,
    chatTitle: me.title,
  };
  const { channels } = await z.listChannels(room);
  assertEquals(
    channels.map((c) => `${c.name}:${c.visibility}`),
    ["general:public", "incidents:private", "platform-oncall:private"],
  );
  assertEquals(await z.maxMessageLength(room), 10_000);

  const opened = await z.send(room, z.openTarget("10", "HighErrorRate api")!, "Looking into it.");
  assertEquals(await z.locate(room, opened), {
    channel: { id: "10", name: "incidents" },
    topic: "HighErrorRate api",
  });

  const first = await z.poll(room, { position: null, timeoutS: 1, signal: signal() });
  assertEquals(first.updates, []);
  chat.say({
    platform: "zulip",
    channelId: "10",
    conversation: "HighErrorRate api",
    as: "max",
    text: "is it the cache?",
    mention: true,
  });
  const heard = await z.poll(room, { position: first.position, timeoutS: 5, signal: signal() });
  const msg = heard.updates[0].message!;
  assertEquals([msg.topic, msg.text, msg.sender?.isBot, msg.channel.visibility], [
    "HighErrorRate api",
    "is it the cache?",
    false,
    "private",
  ]);
  const thread = await z.fetchThread(room, opened);
  assertEquals(thread?.messages.map((m) => m.sender.name), ["ryph", "Max Member"]);

  // A queue the mock no longer knows (a restart) is registered again, backfilling the mention.
  const lost = { ...heard.position, queueId: "gone", lastMessageId: Number(opened) };
  const backfilled = await z.poll(room, { position: lost, timeoutS: 1, signal: signal() });
  assertEquals(backfilled.updates.map((u) => u.message?.text), ["is it the cache?"]);
});

test("slack: the app, its channels, a socket that hears a mention, a thread posted and read", async () => {
  const s = transports.slack;
  const credential = { kind: "slack" as const, ...CHAT_CREDENTIALS.slack };
  const me = await s.whoAmI(credential);
  const room: PlatformRoom = {
    id: "chr_s",
    credential,
    bot: { id: me.id, name: me.name },
    chatId: null,
    chatTitle: me.title,
  };
  const { channels } = await s.listChannels(room);
  assertEquals(channels.filter((c) => c.visibility === "private").length, 2);

  const opened = await s.send(room, s.openTarget("C0INCIDENTS", "ignored")!, "Opening.");
  const [channelId, ts] = opened.split(":");
  await s.send(room, { channelId, topic: ts }, "A follow-up in the thread.");

  const ac = new AbortController();
  // The first poll opens the socket and holds; the mention arrives while it does.
  const polled = s.poll(room, { position: null, timeoutS: 5, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 300));
  chat.say({
    platform: "slack",
    channelId,
    conversation: ts,
    as: "olivia",
    text: "what changed?",
    mention: true,
  });
  const batch = await polled;
  const msg = batch.updates[0].message!;
  assertEquals([msg.threadKey, msg.text, msg.channel.visibility], [
    opened,
    "what changed?",
    "private",
  ]);
  const thread = await s.fetchThread(room, opened);
  assertEquals(thread?.messages.map((m) => m.sender.name), [me.name, me.name, "Olivia Owner"]);
  ac.abort();
  s.releaseAllBut(new Set());
});

test("discord: the bot in its server, a Gateway that hears a mention, a thread opened and read", async () => {
  const d = transports.discord;
  const credential = { kind: "discord" as const, ...CHAT_CREDENTIALS.discord };
  const me = await d.whoAmI(credential);
  assertEquals(me.title, "Acme Discord");
  const room: PlatformRoom = {
    id: "chr_d",
    credential,
    bot: { id: me.id, name: me.name },
    chatId: credential.guildId,
    chatTitle: me.title,
  };
  const { channels } = await d.listChannels(room);
  assertEquals(
    channels.map((c) => `${c.name}:${c.visibility}`),
    ["general:public", "incidents:private", "platform-oncall:private"],
  );
  assertEquals((await d.listGroups(room)).map((g) => g.name), ["@oncall"]);

  // A response's conversation: the post at the channel, and a thread of its name from it.
  const incidents = channels.find((c) => c.name === "incidents")!.id;
  const opened = await d.send(room, d.openTarget(incidents, "HighErrorRate api")!, "Opening.");
  const [channelId, threadId] = opened.split(":");
  assertEquals(await d.send(room, { channelId, topic: threadId }, "In the thread."), opened);

  const ac = new AbortController();
  // The first poll dials the Gateway and holds; the mention arrives while it does.
  const polled = d.poll(room, { position: null, timeoutS: 5, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 300));
  chat.say({
    platform: "discord",
    channelId,
    conversation: threadId,
    as: "olivia",
    text: "what changed?",
    mention: true,
  });
  const batch = await polled;
  const msg = batch.updates[0].message!;
  assertEquals([msg.threadKey, msg.topic, msg.text, msg.channel.visibility], [
    opened,
    "HighErrorRate api",
    "what changed?",
    "private",
  ]);
  assert(batch.position.queueId !== null, "the session is the cursor");
  await d.react(room, msg.messageId);
  assertEquals(chat.messages().at(-1)?.reactions, ["👀"]);
  const thread = await d.fetchThread(room, opened);
  assertEquals(thread?.messages.map((m) => m.sender.name), [me.name, me.name, "Olivia Owner"]);
  assertEquals(
    await d.checkMembership(room, "900000000000000201", msg.sender!.id),
    "allowed",
    "Olivia is on call",
  );
  ac.abort();
  d.releaseAllBut(new Set());
});
