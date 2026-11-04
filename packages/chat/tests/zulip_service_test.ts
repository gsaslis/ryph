// The service's decisions for a Zulip room: the organization is the room, a conversation is keyed
// by the mention that started its run and found by locating it, a follow-up is matched by where
// both messages are NOW, a private channel the bot is not in is answered here and never reaches
// the door, and a post lands wherever its conversation has moved to.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ChatRefusedError, NOT_SUBSCRIBED_REPLY } from "../src/core/service.ts";
import { bindRun, makeApi, makeZulipRoom } from "./api.ts";
import { ZULIP_EMAIL, ZULIP_KEY, ZULIP_REALM, zulipMention } from "./fake_transport.ts";

const never = new AbortController().signal;

const at = (channelId: string, topic: string, name = "bugs") => ({
  channel: { id: channelId, name },
  topic,
});

test("a Zulip room is verified, sealed, and linked from birth", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    assertEquals(room.kind, "zulip");
    assertEquals(room.botUsername, "ryph");
    assertEquals(room.linked, true, "the organization is the room");
    assertEquals(room.linkCode, null);
    assertEquals(room.realmUrl, ZULIP_REALM);
    assertEquals(room.botEmail, ZULIP_EMAIL);
    assertEquals(room.chatTitle, "Radicle");
    assert(!JSON.stringify(room).includes(ZULIP_KEY), "the key never comes back");
    const row = await api.store.getChatroom(room.id);
    assert(row !== null && !row.sealedBotToken.includes(ZULIP_KEY), "stored sealed");

    await assertRejects(
      () =>
        api.service.createChatroom({
          kind: "zulip",
          name: "x",
          realmUrl: ZULIP_REALM,
          botEmail: ZULIP_EMAIL,
          apiKey: "wrong",
          ownerUserId: "u",
        }),
      ChatRefusedError,
      "did not accept the bot's email and API key",
    );
  } finally {
    await api.close();
  }
});

test("a new mention proposes its own id as the thread key; the verdict reacts and replies in its topic", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.sink.answer = (m) => ({
      kind: "verdict",
      verdict: { outcome: "started", reply: null, react: true, runId: "r-1", taskId: m.messageId },
    });
    api.zulip.deliver(ZULIP_KEY, zulipMention(101));
    const stats = await api.service.pollOnce(room.id, never);
    assertEquals(stats, { updates: 1, routed: 1 });
    assertEquals(api.sink.delivered, [{
      chatroomId: room.id,
      messageId: "101",
      boundRunId: null,
      threadKey: "101",
      channel: { id: "4", name: "bugs", visibility: "public" },
      topic: "crash on sync",
      sender: { id: "8", name: "alice" },
      text: "investigate this",
      hasAttachment: false,
      images: [],
      receivedAt: "2026-09-01T00:00:00.000Z",
    }]);
    assertEquals(api.zulip.reactions.map((r) => r.messageId), ["101"]);
    assertEquals(api.zulip.sent, [], "no reply was asked for");
    const cursor = await api.store.getCursor(room.id);
    assertEquals([cursor?.queueId, cursor?.offset, cursor?.lastMessageId], ["q-1", 101, 101]);

    // A refusal the sender should hear lands in the mention's topic.
    api.sink.answer = () => ({
      kind: "verdict",
      verdict: {
        outcome: "not-served",
        reply: "This channel isn't set up for ryph.",
        react: false,
      },
    });
    api.zulip.deliver(
      ZULIP_KEY,
      zulipMention(102, {
        channel: { id: "7", name: "desktop", visibility: "public" },
        topic: "ui",
      }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.zulip.sent.at(-1), {
      id: "1000",
      secret: ZULIP_KEY,
      channelId: "7",
      topic: "ui",
      text: "This channel isn't set up for ryph.",
    });
  } finally {
    await api.close();
  }
});

test("a follow-up matches the binding whose key sits in the same channel and topic NOW", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    // Two runs in two topics of one room: bindings are per conversation.
    api.zulip.locations.set("101", at("4", "crash on sync"));
    api.zulip.locations.set("201", at("4", "flaky tests"));
    await bindRun(api, room.id, "r-crash", "101");
    await bindRun(api, room.id, "r-flaky", "201");
    // The opening lines went into each run's own topic.
    assertEquals(
      api.zulip.sent.map((s) => [s.channelId, s.topic]),
      [["4", "crash on sync"], ["4", "flaky tests"]],
    );
    // A second run in the same conversation is refused; the door would have joined instead.
    const again = await api.service.openBinding({
      runId: "r-other",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "101" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(again.kind === "refused" && again.status === 409);
    // A response-room binding (key "") has no conversation to go to in a Zulip room.
    const roomWide = await api.service.openBinding({
      runId: "r-incident",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(roomWide.kind === "refused" && roomWide.status === 409);
    assert(roomWide.error.includes("no room-wide conversation"));
    assertEquals(await api.store.getBindingByRun("r-incident"), null);

    // The crash topic was resolved since: its key message and the follow-up are both in
    // "✔ crash on sync" now, and the mention's own event still says the old name.
    api.zulip.locations.set("101", at("4", "✔ crash on sync"));
    api.zulip.locations.set("150", at("4", "✔ Crash On Sync"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(150, { text: "also check the logs" }));
    await api.service.pollOnce(room.id, never);
    const followUp = api.sink.delivered.at(-1);
    assertEquals(followUp?.boundRunId, "r-crash", "Zulip compares topics without case");
    assertEquals(followUp?.threadKey, "101", "the binding's key, not the mention's");

    // A mention in a topic with no run proposes a thread of its own.
    api.zulip.locations.set("160", at("4", "something else"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(160, { topic: "something else" }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);
    assertEquals(api.sink.delivered.at(-1)?.threadKey, "160");

    // The same topic NAME in another channel is another conversation.
    api.zulip.locations.set("170", at("9", "flaky tests", "ci"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(170));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);

    // A binding whose key message is gone matches nothing.
    api.zulip.locations.set("201", null);
    api.zulip.locations.set("180", at("4", "flaky tests"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(180));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);
  } finally {
    await api.close();
  }
});

test("a response opens a topic: the opening line is posted first, and the run is keyed by that post", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "bugs", visibility: "public" }];
    const outcome = await api.service.openBinding({
      runId: "r-resp",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "automation: api latency",
      runUrl: "http://app.test/tasks/t-1",
      conversation: { kind: "new", channelId: "4", topic: "api latency" },
    });
    assert(outcome.kind === "opened");
    // The line went into the named channel and topic, with the title: nothing before it says
    // what this topic is about.
    assertEquals(api.zulip.sent, [{
      id: "1000",
      secret: ZULIP_KEY,
      channelId: "4",
      topic: "api latency",
      text: "🚀 **automation: api latency** — **Ada** is on it. " +
        "[Follow the run](http://app.test/tasks/t-1) Mention me in this topic to talk to me.",
    }]);
    // ...and the binding's key IS that post.
    assertEquals(outcome.binding.threadKey, "1000");
    assertEquals((await api.store.getBindingByRun("r-resp"))?.threadKey, "1000");
    // The same run again is the binding it has; nothing is posted twice.
    const again = await api.service.openBinding({
      runId: "r-resp",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "api latency" },
    });
    assertEquals(again.kind, "already");
    assertEquals(api.zulip.sent.length, 1);

    // A follow-up mention in the opened topic is this run's: the key message — the bot's own
    // post — sits in the same channel and topic as the mention, located now.
    api.zulip.locations.set("150", at("4", "API Latency"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(150, { topic: "API Latency", text: "status?" }));
    await api.service.pollOnce(room.id, never);
    const followUp = api.sink.delivered.at(-1);
    assertEquals(followUp?.boundRunId, "r-resp");
    assertEquals(followUp?.threadKey, "1000", "the binding's key, not the mention's");
    assertEquals(followUp?.text, "status?");
    // A second topic in the same channel is another conversation: another run may open it,
    // and a mention there proposes a thread of its own.
    const second = await bindRun(api, room.id, "r-other", {
      kind: "new",
      channelId: "4",
      topic: "flaky tests",
    });
    assertEquals(second.threadKey, "1001");
    api.zulip.locations.set("160", at("4", "something else"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(160, { topic: "something else" }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);

    // The tool and the closing line follow the key message wherever moderators move it.
    api.zulip.locations.set("1000", at("6", "✔ api latency", "core"));
    assertEquals(await api.service.post("r-resp", "Found it."), {
      kind: "posted",
      parts: 1,
      images: null,
    });
    assertEquals(
      [api.zulip.sent.at(-1)?.channelId, api.zulip.sent.at(-1)?.topic],
      ["6", "✔ api latency"],
    );
    await api.service.closeBinding("r-resp", {
      outcome: "succeeded",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    });
    assert(api.zulip.sent.at(-1)?.text.startsWith("✅ **Ada** finished"));
    assertEquals(api.zulip.sent.at(-1)?.topic, "✔ api latency");
    assertEquals((await api.store.getBindingByRun("r-resp"))?.state, "closed");
  } finally {
    await api.close();
  }
});

test("a second response into a topic that already holds a run is refused before anything is posted", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "bugs", visibility: "public" }];
    const first = await bindRun(api, room.id, "r-first", {
      kind: "new",
      channelId: "4",
      topic: "api latency",
    });
    assertEquals(first.threadKey, "1000");
    assertEquals(api.zulip.sent.length, 1);

    // Two automations named alike, firing the same minute: the second lands in the same
    // conversation (Zulip compares topics without case) and is refused with the 409 a bound
    // thread key gets — otherwise both would bind, and every follow-up would steer the older.
    const again = await api.service.openBinding({
      runId: "r-second",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "automation: api latency",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "API Latency" },
    });
    assert(again.kind === "refused" && again.status === 409, JSON.stringify(again));
    assertEquals(again.reason, "conversation_held");
    assertEquals(api.zulip.sent.length, 1, "nothing was posted");
    assertEquals(await api.store.getBindingByRun("r-second"), null);
    assertEquals((await api.store.listActiveBindings(room.id)).map((b) => b.runId), ["r-first"]);

    // The first binding still owns the topic's follow-ups.
    api.zulip.locations.set("150", at("4", "API Latency"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(150, { topic: "API Latency", text: "status?" }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, "r-first");
    assertEquals(api.sink.delivered.at(-1)?.threadKey, "1000");

    // Another topic of the same channel is free; so is the topic once its run has closed.
    const other = await bindRun(api, room.id, "r-other", {
      kind: "new",
      channelId: "4",
      topic: "flaky tests",
    });
    assertEquals(other.threadKey, "1001");
    assertEquals(api.zulip.sent.at(-1)?.topic, "flaky tests");
    await api.service.closeBinding("r-first", {
      outcome: "succeeded",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    });
    const reopened = await api.service.openBinding({
      runId: "r-second",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "automation: api latency",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "API Latency" },
    });
    assert(reopened.kind === "opened");
    assertEquals(api.zulip.sent.at(-1)?.topic, "API Latency");

    // The platform unable to say whether the conversation is free: nothing is posted, no row.
    api.zulip.platformDown = true;
    const unsure = await api.service.openBinding({
      runId: "r-unsure",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "something" },
    });
    assert(unsure.kind === "refused" && unsure.status === 502);
    assertEquals(api.zulip.sent.at(-1)?.topic, "API Latency");
    assertEquals(await api.store.getBindingByRun("r-unsure"), null);
    assert(api.warnings.includes("chat.opening_check_failed"));
  } finally {
    await api.close();
  }
});

test("a topic the platform will not open binds nothing: a 502 naming the call, and no row", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.refuseSends = true;
    const outcome = await api.service.openBinding({
      runId: "r-resp",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "api latency" },
    });
    assert(outcome.kind === "refused" && outcome.status === 502);
    assert(outcome.error.includes("zulip send answered 400"), outcome.error);
    assert(!outcome.error.includes(ZULIP_KEY), "the credential never rides an error");
    assertEquals(await api.store.getBindingByRun("r-resp"), null);
    assertEquals(await api.store.listActiveBindings(room.id), []);
    assert(api.warnings.includes("chat.opening_post_failed"));

    // The platform back: the same request opens the topic.
    api.zulip.refuseSends = false;
    const retried = await api.service.openBinding({
      runId: "r-resp",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "api latency" },
    });
    assert(retried.kind === "opened");
    assertEquals(retried.binding.threadKey, api.zulip.sent[0].id);
  } finally {
    await api.close();
  }
});

test("a private channel the bot is not in is answered here and never reaches the door", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.deliver(
      ZULIP_KEY,
      zulipMention(301, {
        channel: { id: "5", name: "core", visibility: "private" },
        topic: "secret",
        servable: false,
      }),
      zulipMention(302, { sender: { id: "11", name: "otherbot", isBot: true } }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered, []);
    assertEquals(api.zulip.sent, [{
      id: "1000",
      secret: ZULIP_KEY,
      channelId: "5",
      topic: "secret",
      text: NOT_SUBSCRIBED_REPLY,
    }]);
    assertEquals((await api.store.getCursor(room.id))?.lastMessageId, 302);
  } finally {
    await api.close();
  }
});

test("chat__post locates the key message and posts where the conversation is now", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.locations.set("101", at("4", "crash on sync"));
    await bindRun(api, room.id, "r-1", "101");
    api.zulip.sent.length = 0;

    // Moved to another channel and resolved: the post follows.
    api.zulip.locations.set("101", at("6", "✔ crash on sync", "core"));
    assertEquals(await api.service.post("r-1", "Found it."), {
      kind: "posted",
      parts: 1,
      images: null,
    });
    assertEquals(api.zulip.sent.at(-1), {
      id: "1001",
      secret: ZULIP_KEY,
      channelId: "6",
      topic: "✔ crash on sync",
      text: "[Ada] Found it.",
    });

    // Split at the SERVER's ceiling, not Telegram's.
    api.zulip.maxLength = 50;
    const outcome = await api.service.post("r-1", "x".repeat(120));
    assert(outcome.kind === "posted" && outcome.parts === 3);

    // The key message deleted: refused with a reason the agent reads.
    api.zulip.locations.set("101", null);
    const gone = await api.service.post("r-1", "hello?");
    assert(gone.kind === "refused" && gone.reason.includes("is gone"));

    // The platform down: refused, not thrown.
    api.zulip.platformDown = true;
    const down = await api.service.post("r-1", "hello?");
    assert(down.kind === "refused");

    // The closing line finds nowhere to go and says so in the diag, never failing the close.
    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    });
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");
    assert(api.warnings.includes("chat.closing_line_failed"));
  } finally {
    await api.close();
  }
});

test("the commander check and the thread read never throw", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.membership.set("33:8", "allowed");
    api.zulip.membership.set("33:9", "denied");
    const ask = (userId: string) =>
      api.service.checkCommander({ chatroomId: room.id, userId, groupId: "33" });
    assertEquals(await ask("8"), "allowed");
    assertEquals(await ask("9"), "denied");
    assertEquals(await ask("10"), "unknown");
    assertEquals(
      await api.service.checkCommander({ chatroomId: "chr-none", userId: "8", groupId: "33" }),
      "unknown",
    );
    api.zulip.platformDown = true;
    assertEquals(await ask("8"), "unknown", "down is never a yes");

    const thread = {
      channel: { id: "4", name: "bugs", visibility: "public" as const },
      topic: "crash on sync",
      messages: [{
        id: "100",
        sender: { id: "9", name: "bob" },
        text: "rad sync crashes",
        sentAt: "2026-09-01T00:00:00.000Z",
        hasAttachment: false,
      }],
      truncated: false,
      historyLimited: false,
    };
    api.zulip.threads.set("101", thread);
    assertEquals(
      await api.service.fetchThread({ chatroomId: room.id, threadKey: "101" }),
      { kind: "unavailable" },
    );
    api.zulip.platformDown = false;
    assertEquals(
      await api.service.fetchThread({ chatroomId: room.id, threadKey: "101" }),
      { kind: "thread", thread },
    );
    assertEquals(
      await api.service.fetchThread({ chatroomId: room.id, threadKey: "999" }),
      { kind: "gone" },
    );
  } finally {
    await api.close();
  }
});
