// The service's decisions for a Discord room: the server is the room, its token sealed to it, a
// conversation is a thread keyed `<channel>:<thread>`, a response opens one by posting at the
// channel and starting a thread of the asked-for name from that post, and a follow-up in the
// thread matches the binding while one beside it does not.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  alertBlock,
  ChatRefusedError,
  closingLine,
  DISCORD_ALERT_EXCERPT_MAX,
  escapeReferences,
  openingLine,
} from "../src/core/service.ts";
import type { ChatBinding } from "../src/core/types.ts";
import { discordTransport } from "../src/adapters/transport/discord.ts";
import { CredentialRefusedError } from "../src/ports/transport.ts";
import { bindRun, makeApi, makeDiscordRoom } from "./api.ts";
import { DISCORD_BOT_TOKEN, DISCORD_GUILD, discordMention } from "./fake_transport.ts";

const never = new AbortController().signal;
const OPS = "800000000000000010";

test("a Discord room seals its token to its server and is linked from birth", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    assertEquals(room.kind, "discord");
    assertEquals(room.botUsername, "ryph");
    assertEquals(room.linked, true, "the server is the room");
    assertEquals(room.linkCode, null);
    assertEquals(room.chatTitle, "Acme Discord");
    assertEquals(room.realmUrl, null);
    assertEquals(room.botEmail, null);
    assert(!JSON.stringify(room).includes(DISCORD_BOT_TOKEN), "the token never comes back");

    const row = await api.store.getChatroom(room.id);
    assert(row !== null);
    assertEquals(row.chatId, DISCORD_GUILD, "the server rides chatId, from birth");
    assert(!row.sealedBotToken.includes(DISCORD_BOT_TOKEN), "the token is stored sealed");
    assertEquals(row.sealedAppToken, null, "one secret");

    // The token reaches the transport whole, with its server, for every read.
    await api.service.listGroups(room.id);
    // A row pointed at another server does not send the token there: the seal is bound to it.
    await api.store.saveChatroom({ ...row, chatId: "800000000000000666" });
    await assertRejects(() => api.service.listChannels(room.id));

    await assertRejects(
      () =>
        api.service.createChatroom({
          kind: "discord",
          name: "x",
          botToken: "wrong",
          guildId: DISCORD_GUILD,
          ownerUserId: "u",
        }),
      ChatRefusedError,
      "Discord did not accept the bot token",
    );
  } finally {
    await api.close();
  }
});

test("a Discord response opens a named thread from its own post and keys the run on it", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    const binding = await bindRun(api, room.id, "r-nightly", {
      kind: "new",
      channelId: OPS,
      topic: "nightly · 2026-10-28 12:00:00 UTC",
    });
    // The opening line went to the CHANNEL, and asked for a thread of the response's name.
    assertEquals(api.discord.sent.length, 1);
    assertEquals(api.discord.sent[0].channelId, OPS);
    assertEquals(api.discord.sent[0].topic, null);
    assertEquals(api.discord.sent[0].threadName, "nightly · 2026-10-28 12:00:00 UTC");
    assertEquals(binding.threadKey, api.discord.sent[0].id);
    assert(binding.threadKey.startsWith(`${OPS}:`));
    assert(api.discord.sent[0].text.includes("**automation: api latency**"));

    // Everything the run says afterwards lands IN that thread, whose id is the post's.
    const posted = await api.service.post("r-nightly", "the cache was cold");
    assertEquals(posted, { kind: "posted", parts: 1, images: null });
    const reply = api.discord.sent.at(-1);
    assertEquals(reply?.channelId, OPS);
    assertEquals(reply?.topic, binding.threadKey.split(":")[1], "in the thread");
    assertEquals(reply?.threadName, undefined, "starts nothing");
    assertEquals(reply?.text, "[Ada] the cache was cold");

    // A run's own words cannot address the server, even as rendering.
    await api.service.post("r-nightly", "paging @everyone and <@800000000000000077>");
    assertEquals(
      api.discord.sent.at(-1)?.text,
      "[Ada] paging @​everyone and <​@800000000000000077>",
    );

    // A second response in the same channel is a second thread, not a collision.
    const beside = await bindRun(api, room.id, "r-later", {
      kind: "new",
      channelId: OPS,
      topic: "nightly · 2026-10-28 13:00:00 UTC",
    });
    assert(beside.threadKey !== binding.threadKey);

    // A room made of channels has no room-wide conversation.
    const roomWide = await api.service.openBinding({
      runId: "r-incident",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(roomWide.kind === "refused" && roomWide.status === 409);
  } finally {
    await api.close();
  }
});

test("an opening line past 2 000 characters goes on inside the thread it opened", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    const outcome = await api.service.openBinding({
      runId: "r-big",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t".repeat(500),
      runUrl: "http://app.test/tasks/t-1",
      conversation: { kind: "new", channelId: OPS, topic: "big alert" },
      alert: { title: "a".repeat(500), payload: "x\n".repeat(2_000) },
    });
    assert(outcome.kind === "opened");
    assert(api.discord.sent.length > 1, "the line was split");
    const [first, ...rest] = api.discord.sent;
    assertEquals(first.topic, null);
    assertEquals(first.threadName, "big alert");
    for (const part of rest) {
      assertEquals(part.topic, outcome.binding.threadKey.split(":")[1], "into the thread");
      assertEquals(part.threadName, undefined, "no second thread");
    }
    for (const part of api.discord.sent) assert(part.text.length <= 2_000, "within the ceiling");
  } finally {
    await api.close();
  }
});

test("a Discord mention proposes its thread; a follow-up in it reaches the run", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    api.sink.answer = () => ({
      kind: "verdict",
      verdict: { outcome: "started", reply: null, react: true, runId: "r-1" },
    });
    // A mention at the top of a channel proposes the thread it would start.
    api.discord.deliver(DISCORD_BOT_TOKEN, discordMention("800000000000001000"));
    assertEquals(await api.service.pollOnce(room.id, never), { updates: 1, routed: 1 });
    const first = api.sink.delivered[0];
    assertEquals(first.threadKey, `${OPS}:800000000000001000`);
    assertEquals(first.boundRunId, null);
    assertEquals(first.topic, null, "no thread yet, so no name");
    assertEquals(first.channel, { id: OPS, name: "ops", visibility: "private" });
    assertEquals(api.discord.reactions.at(-1)?.messageId, first.messageId);
    // The session is the cursor, so a restart resumes rather than loses.
    const cursor = await api.store.getCursor(room.id);
    assertEquals(cursor?.offset, 1);
    assertEquals(cursor?.queueId, "session-1 wss://gateway.discord.gg");

    await bindRun(api, room.id, "r-1", `${OPS}:800000000000001000`);

    // A message in that thread — now started — is the run's, whatever its own id.
    api.sink.answer = (m) => ({
      kind: "verdict",
      verdict: { outcome: "joined", reply: null, react: true, runId: m.boundRunId ?? "" },
    });
    api.discord.deliver(
      DISCORD_BOT_TOKEN,
      discordMention("800000000000001009", { threadId: "800000000000001000", seq: 2 }),
    );
    await api.service.pollOnce(room.id, never);
    const followUp = api.sink.delivered.at(-1);
    assertEquals(followUp?.boundRunId, "r-1");
    assertEquals(followUp?.threadKey, `${OPS}:800000000000001000`, "the binding's key");
    assertEquals(followUp?.topic, "cache is cold", "the thread's name");

    // A mention in another thread of the same channel is nobody's run.
    api.discord.deliver(DISCORD_BOT_TOKEN, discordMention("800000000000001200", { seq: 3 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);
  } finally {
    await api.close();
  }
});

test("a door reply lands in the thread the mention was in, or the one it starts", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    api.discord.deliver(
      DISCORD_BOT_TOKEN,
      discordMention("800000000000001009", { threadId: "800000000000001000" }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.discord.sent.length, 1);
    assertEquals(api.discord.sent[0].channelId, OPS);
    assertEquals(api.discord.sent[0].topic, "800000000000001000", "in the thread");
    assertEquals(api.discord.sent[0].text, "No response is running right now.");

    // A mention at the top of a channel is answered in the thread it starts, so the channel
    // keeps one conversation rather than two.
    api.clock.advance(60_000);
    api.discord.deliver(DISCORD_BOT_TOKEN, discordMention("800000000000001500", { seq: 2 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.discord.sent.at(-1)?.topic, "800000000000001500");
  } finally {
    await api.close();
  }
});

const BINDING: ChatBinding = {
  id: "cb-1",
  chatroomId: "chr-d",
  runId: "r-1",
  threadKey: `${OPS}:800000000000001000`,
  agentName: "Ada",
  taskTitle: "t",
  runUrl: null,
  state: "closed",
  quiet: false,
  createdAt: "2026-10-28T00:00:00.000Z",
  closedAt: "2026-10-28T00:10:00.000Z",
};

test("nothing this service did not write can address a Discord room", () => {
  assertEquals(
    escapeReferences("discord", "@everyone @here deploy is red"),
    "@​everyone @​here deploy is red",
  );
  assertEquals(
    escapeReferences("discord", "ask <@1> <@!2> <@&3> in <#4>"),
    "ask <​@1> <​@!2> <​@&3> in <​#4>",
  );
  // Twice is once: a broken reference is not one to break again.
  const once = escapeReferences("discord", "@everyone <@1>");
  assertEquals(escapeReferences("discord", once), once);
  // The Markdown a run is told to write, and an e-mail address, are left alone.
  assertEquals(
    escapeReferences("discord", "**urgent** `cache.ts` [log](https://logs.test/x) ops@acme.test"),
    "**urgent** `cache.ts` [log](https://logs.test/x) ops@acme.test",
  );

  const opened = openingLine("discord", {
    agentName: "Ada",
    taskTitle: "@everyone api latency",
    runUrl: "http://app.test/tasks/t-1",
    botHandle: "ryph",
  }, "new");
  assert(opened.includes("**@​everyone api latency**"));

  const closed = closingLine("discord", BINDING, {
    outcome: "succeeded",
    summary: "The README says @here to escalate.",
    patches: [{ path: "src/<@1>.ts", state: "pushed", forgeUrl: null }],
    issues: [],
    runUrl: null,
  });
  assert(closed.includes("> The README says @​here to escalate."));
  assert(closed.includes("`src/<​@1>.ts`"));
});

test("Discord's own lines are its Markdown, links masked without previews", () => {
  assertEquals(
    openingLine("discord", {
      agentName: "Ada",
      taskTitle: "automation: api latency",
      runUrl: "http://app.test/tasks/t-1",
      botHandle: "ryph",
    }, "new"),
    "🚀 **automation: api latency** — **Ada** is on it. " +
      "[Follow the run](<http://app.test/tasks/t-1>) Mention me in this thread to talk to me.",
  );
  assertEquals(
    openingLine("discord", { agentName: "Ada", taskTitle: "t", runUrl: null, botHandle: "ryph" }),
    "🚀 **Ada** is on it. Mention me in this thread to talk to me.",
  );
  const closed = closingLine("discord", BINDING, {
    outcome: "succeeded",
    summary: "The cache was cold.",
    patches: [{ path: "repo", state: "pushed", forgeUrl: "http://forge.test/pr/1" }],
    issues: [{ repo: "acme/api", number: 12, url: "http://forge.test/i/12" }],
    runUrl: "http://app.test/tasks/t-1",
  });
  assertEquals(closed.split("\n\n"), [
    "✅ **Ada** finished with status `succeeded`. " +
    "[View the full task transcript](<http://app.test/tasks/t-1>)",
    "### Run summary\n> The cache was cold.",
    "### Patches\n- `repo`: http://forge.test/pr/1",
    "### Issues\n- `acme/api#12`: http://forge.test/i/12",
  ]);
});

test("an alert's excerpt is cut to fit Discord's 2 000 characters", () => {
  const block = alertBlock("discord", { title: "@here CPU", payload: "y".repeat(5_000) });
  assert(block.startsWith("**@​here CPU**\n```\n"));
  assert(block.endsWith("```\n…cut short."));
  assertEquals(block.split("\n")[2].length, DISCORD_ALERT_EXCERPT_MAX);
  assert(block.length < 2_000 - 500, "room beside it for the opening line");
  // Other platforms keep the longer excerpt.
  assert(alertBlock("zulip", { title: null, payload: "y".repeat(5_000) }).length > 2_000);
});

test("one bot serves one room: a second room on the same bot is refused", async () => {
  const api = await makeApi();
  try {
    const first = await makeDiscordRoom(api, "acme");
    // Its Gateway connection would carry both servers, and the day's identify budget is the
    // token's: refused, naming the room it already serves.
    await assertRejects(
      () => makeDiscordRoom(api, "acme-two"),
      ChatRefusedError,
      "This bot already serves the room acme. Create a separate bot application for each server.",
    );
    // Archived, the bot is free again.
    await api.service.archiveChatroom(first.id);
    const second = await makeDiscordRoom(api, "acme-two");
    assertEquals(second.kind, "discord");
  } finally {
    await api.close();
  }
});

test("a credential the platform took but a room cannot use is refused in the adapter's words", async () => {
  const api = await makeApi();
  try {
    api.discord.whoAmIRefusal = new CredentialRefusedError(
      "The bot is public, so anyone could add it to their server. Turn Public Bot off.",
    );
    await assertRejects(
      () => makeDiscordRoom(api),
      ChatRefusedError,
      "Turn Public Bot off",
    );
    // Any other failure is the platform's generic refusal, which repeats nothing it said.
    api.discord.whoAmIRefusal = new Error(`discord answered 401 for ${DISCORD_BOT_TOKEN}`);
    const err = await assertRejects(() => makeDiscordRoom(api), ChatRefusedError);
    assertEquals(err.message, "Discord did not accept the bot token");
  } finally {
    await api.close();
  }
});

test("an opening line refused part-way binds nothing and takes its first part back down", async () => {
  const api = await makeApi();
  try {
    const room = await makeDiscordRoom(api);
    // The first part lands and opens the thread; the second is refused.
    api.discord.sendsLeft = 1;
    const outcome = await api.service.openBinding({
      runId: "r-cut",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t".repeat(500),
      runUrl: "http://app.test/tasks/t-1",
      conversation: { kind: "new", channelId: OPS, topic: "big alert" },
      alert: { title: "a".repeat(500), payload: "x\n".repeat(2_000) },
    });
    assert(outcome.kind === "refused");
    assertEquals(outcome.status, 502);
    assertEquals(api.discord.sent.length, 1);
    assertEquals(api.discord.retracted, [api.discord.sent[0].id]);
    assertEquals(await api.store.getBindingByRun("r-cut"), null);

    // A post into a conversation that already exists takes nothing back.
    api.discord.sendsLeft = null;
    await bindRun(api, room.id, "r-ok", `${OPS}:800000000000004444`);
    api.discord.sendsLeft = 0;
    await api.service.post("r-ok", "words");
    assertEquals(api.discord.retracted.length, 1);
  } finally {
    await api.close();
  }
});

test("a Discord Reply at the top of the channel to a response's opening post steers its run", async () => {
  const api = await makeApi();
  try {
    // The real adapter's `locate` — it reads no network — so the matching below is the one a
    // live room does, over the keys the adapter makes.
    api.discord.locate = discordTransport().locate;
    const room = await makeDiscordRoom(api);
    const binding = await bindRun(api, room.id, "r-nightly", {
      kind: "new",
      channelId: OPS,
      topic: "nightly",
    });
    // The opening post's key, as `send` answers it: `<channel>:<post>`.
    const [channel, post] = binding.threadKey.split(":");
    assertEquals(channel, OPS);
    api.sink.answer = (m) => ({
      kind: "verdict",
      verdict: { outcome: "joined", reply: null, react: true, runId: m.boundRunId ?? "" },
    });
    // A Reply to that post, sitting at the top of the channel: the adapter keys it to the post's
    // thread (`<channel>:<post>:<reply>`), and it names no thread of its own.
    const reply = "800000000000006001";
    api.discord.deliver(
      DISCORD_BOT_TOKEN,
      discordMention(reply, { channelId: OPS, threadId: post, topic: null }),
    );
    await api.service.pollOnce(room.id, never);
    const heard = api.sink.delivered.at(-1);
    assertEquals(heard?.messageId, `${OPS}:${post}:${reply}`);
    assertEquals(heard?.boundRunId, "r-nightly", "the response's live run");
    assertEquals(heard?.threadKey, binding.threadKey);

    // A Reply to some other post at the top of the channel is a conversation of its own.
    api.discord.deliver(
      DISCORD_BOT_TOKEN,
      discordMention("800000000000006003", {
        channelId: OPS,
        threadId: "800000000000006002",
        topic: null,
        seq: 2,
      }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);
  } finally {
    await api.close();
  }
});

test("two Discord rooms created at once on one bot: one lands, the other is refused", async () => {
  const api = await makeApi();
  try {
    // Both creations read the room list before either writes, as two requests racing do: the
    // check both pass is the service's, and the store's unique index decides.
    const list = api.store.listChatrooms.bind(api.store);
    const waiting: Array<() => void> = [];
    let racing = 2;
    api.store.listChatrooms = async () => {
      const rooms = await list();
      if (racing > 0) {
        racing--;
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) { for (const go of waiting.splice(0)) go(); }
        });
      }
      return rooms;
    };
    const results = await Promise.allSettled([
      makeDiscordRoom(api, "acme"),
      makeDiscordRoom(api, "acme-two"),
    ]);
    const made = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assertEquals(made.length, 1);
    assertEquals(refused.length, 1);
    assert(refused[0].reason instanceof ChatRefusedError, String(refused[0].reason));
    // Named after the winner, read again after the refusal.
    const winner = (made[0] as PromiseFulfilledResult<{ id: string; name: string }>).value;
    assertEquals(
      refused[0].reason.message,
      `This bot already serves the room ${winner.name}. Create a separate bot application for ` +
        "each server.",
    );
    assertEquals(
      (await api.store.listChatrooms()).filter((r) => r.kind === "discord").length,
      1,
    );

    // Archived, the winner frees the bot — for the index too.
    await api.service.archiveChatroom(winner.id);
    const next = await makeDiscordRoom(api, "acme-three");
    assertEquals(next.kind, "discord");
    // And the store alone refuses a second live room on the bot, whatever the service asked.
    const row = await api.store.getChatroom(next.id);
    assert(row !== null);
    assertEquals(await api.store.createChatroom({ ...row, id: "chr-twin" }), false);
    // Another platform's room may share a bot id; only Discord's are one per bot.
    assertEquals(
      await api.store.createChatroom({ ...row, id: "chr-slack", kind: "slack" }),
      true,
    );
  } finally {
    await api.close();
  }
});
