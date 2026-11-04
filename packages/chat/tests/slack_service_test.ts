// The service's decisions for a Slack room: the workspace is the room, both secrets are sealed, a
// conversation is a thread keyed by its root, a response opens one by posting at the channel, and
// a follow-up in the thread matches the binding while one beside it does not.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  ChatRefusedError,
  closingLine,
  escapeReferences,
  openingLine,
} from "../src/core/service.ts";
import { bindRun, makeApi, makeSlackRoom } from "./api.ts";
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN, slackMention } from "./fake_transport.ts";

const never = new AbortController().signal;

test("a Slack room seals both tokens and is linked from birth", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    assertEquals(room.kind, "slack");
    assertEquals(room.botUsername, "ryph");
    assertEquals(room.linked, true, "the workspace is the room");
    assertEquals(room.linkCode, null);
    assertEquals(room.chatTitle, "Acme");
    // Slack has no realm URL and no bot email; the workspace's name is what names the room.
    assertEquals(room.realmUrl, null);
    assertEquals(room.botEmail, null);
    const serialized = JSON.stringify(room);
    assert(!serialized.includes(SLACK_BOT_TOKEN), "the bot token never comes back");
    assert(!serialized.includes(SLACK_APP_TOKEN), "the app token never comes back");

    const row = await api.store.getChatroom(room.id);
    assert(row !== null);
    assert(!row.sealedBotToken.includes(SLACK_BOT_TOKEN), "the bot token is stored sealed");
    assert(row.sealedAppToken !== null, "Slack is the room with two secrets");
    assert(!row.sealedAppToken.includes(SLACK_APP_TOKEN), "the app token is stored sealed");

    await assertRejects(
      () =>
        api.service.createChatroom({
          kind: "slack",
          name: "x",
          botToken: "xoxb-wrong",
          appToken: SLACK_APP_TOKEN,
          ownerUserId: "u",
        }),
      ChatRefusedError,
      "Slack did not accept the bot token and the app-level token",
    );
  } finally {
    await api.close();
  }
});

test("a Slack response opens a thread at the channel and keys the run on it", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    const binding = await bindRun(api, room.id, "r-nightly", {
      kind: "new",
      channelId: "C0WAR",
      topic: "nightly · 2026-09-28 12:00:00 UTC",
    });
    // The opening line went to the CHANNEL: a Slack thread has no name, so the post's own thread
    // becomes the conversation and the topic asked for is not an address.
    assertEquals(api.slack.sent.length, 1);
    assertEquals(api.slack.sent[0].channelId, "C0WAR");
    assertEquals(api.slack.sent[0].topic, null);
    assertEquals(binding.threadKey, api.slack.sent[0].id);
    assert(binding.threadKey.startsWith("C0WAR:"));
    // And the title is in the line, because nothing before it says what the thread is about.
    assert(api.slack.sent[0].text.includes("automation: api latency"));

    // Everything the run says afterwards lands IN that thread.
    const posted = await api.service.post("r-nightly", "the cache was cold");
    assertEquals(posted, { kind: "posted", parts: 1, images: null });
    const reply = api.slack.sent.at(-1);
    assertEquals(reply?.channelId, "C0WAR");
    assertEquals(reply?.topic, binding.threadKey.split(":")[1], "threaded under the opening line");
    assertEquals(reply?.text, "[Ada] the cache was cold");

    // A run's own words reach the room as writing, never as a reference: what it quotes out of a
    // thread it was handed as evidence cannot page the channel. The opening line above is markup
    // the SERVICE composed, and is posted as it was written.
    await api.service.post("r-nightly", "the README says <!channel> to escalate");
    assertEquals(
      api.slack.sent.at(-1)?.text,
      "[Ada] the README says &lt;!channel&gt; to escalate",
    );

    // A second response in the same channel is a second thread, not a collision.
    const beside = await bindRun(api, room.id, "r-later", {
      kind: "new",
      channelId: "C0WAR",
      topic: "nightly · 2026-09-28 13:00:00 UTC",
    });
    assert(beside.threadKey !== binding.threadKey);

    // A response-room binding has no conversation to go to in a room made of channels.
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
  } finally {
    await api.close();
  }
});

test("a Slack mention proposes its thread; a follow-up in it reaches the run", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    api.sink.answer = () => ({
      kind: "verdict",
      verdict: { outcome: "started", reply: null, react: true, runId: "r-1" },
    });
    // A mention at the top of a channel proposes the thread it would root.
    api.slack.deliver(SLACK_BOT_TOKEN, slackMention("1727530000.000100"));
    assertEquals(await api.service.pollOnce(room.id, never), { updates: 1, routed: 1 });
    const first = api.sink.delivered[0];
    assertEquals(first.threadKey, "C0OPS:1727530000.000100");
    assertEquals(first.boundRunId, null);
    assertEquals(first.topic, null, "a Slack thread has no name");
    assertEquals(first.channel, { id: "C0OPS", name: "ops", visibility: "private" });
    // The acknowledgement went to the mention itself, whose id carries its thread.
    assertEquals(api.slack.reactions.at(-1)?.messageId, first.messageId);

    await bindRun(api, room.id, "r-1", "C0OPS:1727530000.000100");

    // A reply in that thread is the run's, whatever its own timestamp.
    api.sink.answer = (m) => ({
      kind: "verdict",
      verdict: { outcome: "joined", reply: null, react: true, runId: m.boundRunId ?? "" },
    });
    api.slack.deliver(
      SLACK_BOT_TOKEN,
      slackMention("1727530099.000900", {
        threadTs: "1727530000.000100",
        text: "also check the logs",
      }),
    );
    await api.service.pollOnce(room.id, never);
    const followUp = api.sink.delivered.at(-1);
    assertEquals(followUp?.boundRunId, "r-1");
    assertEquals(followUp?.threadKey, "C0OPS:1727530000.000100", "the binding's key");

    // A mention in another thread of the same channel is nobody's run.
    api.slack.deliver(SLACK_BOT_TOKEN, slackMention("1727530200.000300"));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);

    // And neither is the same timestamp in another channel.
    api.slack.deliver(
      SLACK_BOT_TOKEN,
      slackMention("1727530000.000100", { channelId: "C0CI" }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, null);
  } finally {
    await api.close();
  }
});

test("a door reply lands in the thread the mention was in, not in the channel", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    // A room with nothing running, which is what a Slack workspace looks like most of the time:
    // the default door answers "no response is running", and it belongs where it was asked.
    api.slack.deliver(
      SLACK_BOT_TOKEN,
      slackMention("1727530099.000900", { threadTs: "1727530000.000100" }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.slack.sent.length, 1);
    assertEquals(api.slack.sent[0].channelId, "C0OPS");
    assertEquals(api.slack.sent[0].topic, "1727530000.000100", "threaded under the conversation");
    assertEquals(api.slack.sent[0].text, "No response is running right now.");

    // A mention at the top of a channel is answered in the thread it roots, so the channel keeps
    // one conversation rather than two.
    api.clock.advance(60_000);
    api.slack.deliver(SLACK_BOT_TOKEN, slackMention("1727530500.000100"));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.slack.sent.at(-1)?.topic, "1727530500.000100");
  } finally {
    await api.close();
  }
});

test("nothing this service did not write can address a Slack room", () => {
  // What a run quotes out of a thread it was handed as evidence — where Slack's escapes were
  // decoded for it to read — cannot page the room on the way back out.
  assertEquals(
    escapeReferences("slack", "<!channel> deploy is red"),
    "&lt;!channel&gt; deploy is red",
  );
  assertEquals(escapeReferences("slack", "ping <@U0ALICE>"), "ping &lt;@U0ALICE&gt;");
  assertEquals(
    escapeReferences("slack", "<https://evil.test|your bank>"),
    "&lt;https://evil.test|your bank&gt;",
  );
  // The ampersand goes first, or an escape would be escaped again.
  assertEquals(escapeReferences("slack", "a &lt; b"), "a &amp;lt; b");
  // The formatting a run is told to write is left alone, and a bare link still links.
  assertEquals(
    escapeReferences("slack", "*urgent* `cache.ts` https://logs.test/x"),
    "*urgent* `cache.ts` https://logs.test/x",
  );
  // Zulip's own reference syntax pages a channel just as loudly, and becomes its silent form:
  // the name still renders, nobody is notified.
  assertEquals(escapeReferences("zulip", "<!channel> @**all**"), "<!channel> @_**all**");
  assertEquals(
    escapeReferences("zulip", "ask @**Alice H** or @*sre*"),
    "ask @_**Alice H** or @_*sre*",
  );
  // Applying it twice changes nothing, because a silent mention is not a mention to silence.
  assertEquals(escapeReferences("zulip", "@_**all**"), "@_**all**");
  // Telegram posts carry no parse mode, so its text is only ever the characters written.
  assertEquals(escapeReferences("telegram", "<!channel> @**all**"), "<!channel> @**all**");

  // The lines this service composes carry values it did not write, and those are escaped where
  // they sit — while the markup around them, its own, is posted as markup.
  const opened = openingLine("slack", {
    agentName: "Ada",
    taskTitle: "<!here> api latency",
    runUrl: "http://app.test/tasks/t-1",
    botHandle: "ryph",
  }, "new");
  assert(opened.includes("*&lt;!here&gt; api latency*"));
  assert(opened.includes("<http://app.test/tasks/t-1|Follow the run>"), "the link is still a link");

  const closed = closingLine("slack", {
    id: "cb-1",
    chatroomId: "chr-s",
    runId: "r-1",
    threadKey: "C0OPS:1727530000.000100",
    agentName: "Ada",
    taskTitle: "t",
    runUrl: null,
    state: "closed",
    quiet: false,
    createdAt: "2026-09-28T00:00:00.000Z",
    closedAt: "2026-09-28T00:10:00.000Z",
  }, {
    outcome: "succeeded",
    summary: "The README says <!channel> to escalate.",
    patches: [{ path: "src/<@U0BOT>.ts", state: "pushed", forgeUrl: null }],
    issues: [{ repo: "acme/<api>", number: 12, url: null }],
    runUrl: "http://app.test/tasks/t-1",
  });
  assert(closed.includes("> The README says &lt;!channel&gt; to escalate."));
  assert(closed.includes("`src/&lt;@U0BOT&gt;.ts`"));
  assert(closed.includes("`acme/&lt;api&gt;#12`"));
  assert(closed.includes("<http://app.test/tasks/t-1|View the full task transcript>"));
});

test("Slack's own lines are mrkdwn: one asterisk, and no headings", () => {
  const opened = openingLine("slack", {
    agentName: "Ada",
    taskTitle: "automation: api latency",
    runUrl: "http://app.test/tasks/t-1",
    botHandle: "ryph",
  }, "new");
  assertEquals(
    opened,
    "🚀 *automation: api latency* — *Ada* is on it. " +
      "<http://app.test/tasks/t-1|Follow the run> Mention me in this thread to talk to me.",
  );
  // A thread a mention started is already the context, so the title would only repeat it.
  const joined = openingLine("slack", {
    agentName: "Ada",
    taskTitle: "automation: api latency",
    runUrl: null,
    botHandle: "ryph",
  });
  assertEquals(joined, "🚀 *Ada* is on it. Mention me in this thread to talk to me.");

  const closed = closingLine(
    "slack",
    {
      id: "cb-1",
      chatroomId: "chr-s",
      runId: "r-1",
      threadKey: "C0OPS:1727530000.000100",
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      state: "closed",
      quiet: false,
      createdAt: "2026-09-28T00:00:00.000Z",
      closedAt: "2026-09-28T00:10:00.000Z",
    },
    {
      outcome: "succeeded",
      summary: "The cache was cold.",
      patches: [{ path: "repo", state: "pushed", forgeUrl: "http://forge.test/pr/1" }],
      issues: [{ repo: "acme/api", number: 12, url: "http://forge.test/i/12" }],
      runUrl: "http://app.test/tasks/t-1",
    },
  );
  assertEquals(closed.split("\n\n"), [
    "✅ *Ada* finished with status `succeeded`. " +
    "<http://app.test/tasks/t-1|View the full task transcript>",
    "*Run summary*\n> The cache was cold.",
    "*Patches*\n• `repo`: http://forge.test/pr/1",
    "*Issues*\n• `acme/api#12`: http://forge.test/i/12",
  ]);
});

test("a Slack opening line past 4 000 characters goes on inside the thread it opened", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    const outcome = await api.service.openBinding({
      runId: "r-big",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t".repeat(1_500),
      runUrl: "http://app.test/tasks/t-1",
      conversation: { kind: "new", channelId: "C0WAR", topic: "big alert" },
      alert: { title: "a".repeat(500), payload: "x\n".repeat(3_000) },
    });
    assert(outcome.kind === "opened");
    assert(api.slack.sent.length > 1, "the line was split");
    const [first, ...rest] = api.slack.sent;
    // The first part opens the thread at the channel and keys the run; every part after it
    // goes INTO that thread, never beside it at the top of the channel.
    assertEquals(first.topic, null);
    assertEquals(outcome.binding.threadKey, first.id);
    for (const part of rest) {
      assertEquals(part.channelId, "C0WAR");
      assertEquals(part.topic, first.id.split(":")[1], "into the thread");
    }
    for (const part of api.slack.sent) assert(part.text.length <= 4_000, "within the ceiling");

    // Refused part-way, the first part is taken back down and nothing binds.
    api.slack.sendsLeft = 1;
    const cut = await api.service.openBinding({
      runId: "r-cut",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t".repeat(1_500),
      runUrl: "http://app.test/tasks/t-1",
      conversation: { kind: "new", channelId: "C0WAR", topic: "big alert 2" },
      alert: { title: "a".repeat(500), payload: "x\n".repeat(3_000) },
    });
    assert(cut.kind === "refused" && cut.status === 502);
    assertEquals(api.slack.retracted, [api.slack.sent.at(-1)?.id]);
    assertEquals(await api.store.getBindingByRun("r-cut"), null);
  } finally {
    await api.close();
  }
});
