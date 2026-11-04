// A shared response conversation: every response of one automation binds to the conversation the
// last one was in, keyed by the same message, for as long as that conversation is there — and
// falls back to opening a new one when it is not.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type { OpenBindingConversation } from "../src/core/service.ts";
import { bindRun, makeApi, makeRoom, makeSlackRoom, makeZulipRoom } from "./api.ts";
import { ZULIP_KEY, zulipMention } from "./fake_transport.ts";

const never = new AbortController().signal;

const at = (channelId: string, topic: string, name = "ops") => ({
  channel: { id: channelId, name },
  topic,
});

const succeeded = {
  outcome: "succeeded",
  summary: "",
  patches: [],
  issues: [],
  runUrl: null,
};

const shared = (...previousRunIds: string[]): OpenBindingConversation => ({
  kind: "continue",
  previousRunIds,
  channelId: "4",
  topic: "daily digest",
});

test("a response continues the conversation the last one was in, keyed by the same post", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    // The first response has no previous one: the orchestrator opens it `new`.
    const first = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "4",
      topic: "daily digest",
    });
    assertEquals(first.threadKey, "1000");
    await api.service.closeBinding("r-1", succeeded);
    const said = api.zulip.sent.length;

    // The next day's response binds to the same key message: no new topic, and the line it
    // hears is the one a conversation that already exists gets — no title, which the topic
    // already says.
    const second = await bindRun(api, room.id, "r-2", shared("r-1"));
    assertEquals(second.threadKey, "1000");
    assertEquals(api.zulip.sent.length, said + 1);
    assertEquals(api.zulip.sent.at(-1)?.topic, "daily digest");
    assertEquals(
      api.zulip.sent.at(-1)?.text,
      "🚀 **Ada** is on it. [Follow the run](http://app.test/tasks/t-1) Mention me in this " +
        "topic to talk to me.",
    );
    // A follow-up in the topic steers the run that continued it.
    api.zulip.locations.set("150", at("4", "daily digest"));
    api.zulip.deliver(ZULIP_KEY, zulipMention(150, { topic: "daily digest", text: "and?" }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.at(-1)?.boundRunId, "r-2");
    assertEquals(api.sink.delivered.at(-1)?.threadKey, "1000");

    // While that run is still bound, the next response cannot have the conversation too.
    const busy = await api.service.openBinding({
      runId: "r-3",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: shared("r-2"),
    });
    assert(busy.kind === "refused" && busy.status === 409, JSON.stringify(busy));
    assertEquals(await api.store.getBindingByRun("r-3"), null);

    // A topic renamed (resolved) in its channel is still the conversation, and is followed.
    await api.service.closeBinding("r-2", succeeded);
    api.zulip.locations.set("1000", at("4", "✔ daily digest"));
    const third = await bindRun(api, room.id, "r-3", shared("r-2"));
    assertEquals(third.threadKey, "1000");
    assertEquals(api.zulip.sent.at(-1)?.topic, "✔ daily digest");
    await api.service.closeBinding("r-3", succeeded);
    // Every run that used the key holds a row; only the closed ones exist, and none collide.
    assertEquals(await api.store.listActiveBindings(room.id), []);
  } finally {
    await api.close();
  }
});

test("a conversation that is gone, moved away or never bound falls back to a new one", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];

    // No previous binding at all (its open failed, or the policy just turned shared): new.
    const fresh = await bindRun(api, room.id, "r-1", shared("r-never"));
    assertEquals(fresh.threadKey, "1000");
    assertEquals(api.zulip.sent.at(-1)?.topic, "daily digest");
    assert(api.zulip.sent.at(-1)?.text.includes("**automation: api latency** —"), "titled");
    await api.service.closeBinding("r-1", succeeded);

    // The key message deleted: a new conversation, and the NEXT response continues that one.
    api.zulip.locations.set("1000", null);
    const reopened = await bindRun(api, room.id, "r-2", shared("r-1"));
    assert(reopened.threadKey !== "1000");
    await api.service.closeBinding("r-2", succeeded);
    const next = await bindRun(api, room.id, "r-3", shared("r-2"));
    assertEquals(next.threadKey, reopened.threadKey);
    await api.service.closeBinding("r-3", succeeded);

    // The topic moved to another channel — or the policy did — is not this policy's audience
    // any more: a new conversation in the channel the policy names.
    api.zulip.locations.set(reopened.threadKey, at("9", "daily digest", "elsewhere"));
    const moved = await bindRun(api, room.id, "r-4", shared("r-3"));
    assert(moved.threadKey !== reopened.threadKey);
    assertEquals(api.zulip.sent.at(-1)?.channelId, "4");
    await api.service.closeBinding("r-4", succeeded);

    // A previous binding in another room is not this room's conversation.
    const other = await makeZulipRoom(api, "another org");
    await bindRun(api, other.id, "r-elsewhere", {
      kind: "new",
      channelId: "4",
      topic: "elsewhere",
    });
    await api.service.closeBinding("r-elsewhere", succeeded);
    const crossed = await bindRun(api, room.id, "r-5", shared("r-elsewhere"));
    assertEquals(api.zulip.sent.at(-1)?.id, crossed.threadKey, "opened, not continued");
  } finally {
    await api.close();
  }
});

test("a continued conversation another run holds, or the platform cannot place, binds nothing", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    await bindRun(api, room.id, "r-1", { kind: "new", channelId: "4", topic: "daily digest" });
    await api.service.closeBinding("r-1", succeeded);
    // Someone mentioned the bot in the topic between responses, and that run is still going: its
    // key is the mention, not the opening post, so only locating both finds the clash.
    api.zulip.locations.set("150", at("4", "daily digest"));
    await bindRun(api, room.id, "r-mention", "150");
    const sent = api.zulip.sent.length;
    const held = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: shared("r-1"),
    });
    assert(held.kind === "refused" && held.status === 409, JSON.stringify(held));
    assertEquals(api.zulip.sent.length, sent, "nothing was posted");

    // The platform unable to say where the key message is: a 502, never a second conversation
    // beside one that may be perfectly fine.
    await api.service.closeBinding("r-mention", succeeded);
    api.zulip.platformDown = true;
    const unsure = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: shared("r-1"),
    });
    assert(unsure.kind === "refused" && unsure.status === 502, JSON.stringify(unsure));
    assertEquals(await api.store.getBindingByRun("r-2"), null);
    assert(api.warnings.includes("chat.continuation_check_failed"));
  } finally {
    await api.close();
  }
});

test("a Slack response continues the thread; a Telegram room has nothing to continue", async () => {
  const api = await makeApi();
  try {
    const room = await makeSlackRoom(api);
    const first = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "C0OPS",
      topic: "nightly",
    });
    await api.service.closeBinding("r-1", succeeded);
    const second = await bindRun(api, room.id, "r-2", {
      kind: "continue",
      previousRunIds: ["r-1"],
      channelId: "C0OPS",
      topic: "nightly",
    });
    assertEquals(second.threadKey, first.threadKey);
    assertEquals(api.slack.sent.at(-1)?.topic, first.threadKey.split(":")[1], "in the thread");

    const telegram = await makeRoom(api);
    const refused = await api.service.openBinding({
      runId: "r-tg",
      chatroomId: telegram.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "continue", previousRunIds: ["r-1"], channelId: "1", topic: "t" },
    });
    assert(refused.kind === "refused" && refused.status === 400);
  } finally {
    await api.close();
  }
});

test("a response that never bound does not break the chain: the newest bound one is continued", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    const first = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "4",
      topic: "daily digest",
    });
    await api.service.closeBinding("r-1", succeeded);
    // r-2's open failed (the platform was down that morning): it holds no binding. The next
    // response is handed both, newest first, and continues r-1's conversation.
    const third = await bindRun(api, room.id, "r-3", shared("r-2", "r-1"));
    assertEquals(third.threadKey, first.threadKey);
  } finally {
    await api.close();
  }
});

test("a stale binding released silently says nothing and frees its conversation", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    // A finished run whose close never reached the chat service: its binding leaked, and holds
    // the automation's topic. A `new` into that topic is refused while it does.
    await bindRun(api, room.id, "r-1", { kind: "new", channelId: "4", topic: "daily digest" });
    const blocked = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "4", topic: "daily digest" },
    });
    assert(blocked.kind === "refused" && blocked.status === 409, JSON.stringify(blocked));

    // The control plane, which knows r-1 is over, releases it: no closing line, and the topic
    // is free again.
    const said = api.zulip.sent.length;
    await api.service.closeBinding("r-1", { ...succeeded, outcome: "failed", silent: true });
    assertEquals(api.zulip.sent.length, said, "a stale binding is released without a word");
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");
    const freed = await bindRun(api, room.id, "r-2", {
      kind: "new",
      channelId: "4",
      topic: "daily digest",
    });
    assert(freed.threadKey !== "");
  } finally {
    await api.close();
  }
});

test("two closes racing for one binding say one closing line", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    await bindRun(api, room.id, "r-1", { kind: "new", channelId: "4", topic: "daily digest" });
    const said = api.zulip.sent.length;
    // The run's conclusion and a person closing its response, both reading it active.
    await Promise.all([
      api.service.closeBinding("r-1", succeeded),
      api.service.closeBinding("r-1", { ...succeeded, outcome: "cancelled" }),
    ]);
    assertEquals(api.zulip.sent.length, said + 1);
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");
  } finally {
    await api.close();
  }
});

test("the conversation a response would continue is read by the rule that binds it", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    const read = (...previousRunIds: string[]) =>
      api.service.fetchContinuedThread({ chatroomId: room.id, previousRunIds, channelId: "4" });

    // Nothing bound yet: nothing to read, and the binding will open a new conversation.
    assertEquals(await read("r-never"), { kind: "none" });

    const first = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "4",
      topic: "daily digest",
    });
    await api.service.closeBinding("r-1", succeeded);
    const thread = {
      channel: { id: "4", name: "ops", visibility: "private" as const },
      topic: "daily digest",
      messages: [{
        id: first.threadKey,
        sender: { id: "bot-1", name: "ryph" },
        text: "digest",
        sentAt: "2026-03-04T05:06:07.000Z",
        hasAttachment: false,
      }],
      truncated: false,
      historyLimited: false,
    };
    api.zulip.threads.set(first.threadKey, thread);
    // The newest previous response bound in the room is the one read — a response that never
    // bound is stepped over, as the binding steps over it — with the bot's id to tell its posts.
    const botId = (await api.store.getChatroom(room.id))!.botId;
    assertEquals(await read("r-2", "r-1"), { kind: "thread", thread, botId });

    // Moved out of the policy's channel: the binding opens a new conversation, so nothing is
    // read from the old one.
    api.zulip.locations.set(first.threadKey, at("9", "daily digest", "elsewhere"));
    assertEquals(await read("r-1"), { kind: "none" });
    api.zulip.locations.set(first.threadKey, at("4", "daily digest"));

    // Another room's binding is not this room's conversation.
    const other = await makeZulipRoom(api, "another org");
    await bindRun(api, other.id, "r-elsewhere", { kind: "new", channelId: "4", topic: "x" });
    assertEquals(await read("r-elsewhere"), { kind: "none" });

    // The platform not answering is told apart from there being nothing to read.
    api.zulip.platformDown = true;
    assertEquals(await read("r-1"), { kind: "unavailable" });
    assert(api.warnings.includes("chat.continued_thread_fetch_failed"));
    api.zulip.platformDown = false;

    // A Telegram room is one conversation and continues nothing.
    const telegram = await makeRoom(api);
    assertEquals(
      await api.service.fetchContinuedThread({
        chatroomId: telegram.id,
        previousRunIds: ["r-1"],
        channelId: "4",
      }),
      { kind: "none" },
    );
  } finally {
    await api.close();
  }
});

test("a conversation the previous run still holds is read, and its bind refused as held", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.channels = [{ id: "4", name: "ops", visibility: "private" }];
    const first = await bindRun(api, room.id, "r-1", {
      kind: "new",
      channelId: "4",
      topic: "daily digest",
    });
    const thread = {
      channel: { id: "4", name: "ops", visibility: "private" as const },
      topic: "daily digest",
      messages: [],
      truncated: false,
      historyLimited: false,
    };
    api.zulip.threads.set(first.threadKey, thread);
    // r-1 is still bound: the read answers the conversation the binding would follow all the
    // same — it is read before the bind and asks nothing of who holds it …
    const botId = (await api.store.getChatroom(room.id))!.botId;
    assertEquals(
      await api.service.fetchContinuedThread({
        chatroomId: room.id,
        previousRunIds: ["r-1"],
        channelId: "4",
      }),
      { kind: "thread", thread, botId },
    );
    // … and the bind that follows is refused with the reason a caller acts on, binding nothing.
    const held = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: shared("r-1"),
    });
    assert(held.kind === "refused" && held.reason === "conversation_held", JSON.stringify(held));
    assertEquals(await api.store.getBindingByRun("r-2"), null);
  } finally {
    await api.close();
  }
});
