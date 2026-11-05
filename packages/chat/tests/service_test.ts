// The service's decisions for a Telegram room: a room from a token the platform vouches for, one
// active binding per room (its one conversation) and the lines the platform posts at its edges,
// every mention handed to the door and its verdict applied, and the link code that keeps a
// stranger's group from capturing the room.

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  ALERT_EXCERPT_MAX,
  alertBlock,
  capSummary,
  ChatRefusedError,
  closingLine,
  DOOR_DOWN_REPLY,
  openingLine,
  signPost,
  splitPost,
  unsignThread,
} from "../src/core/service.ts";
import { CLOSING_SUMMARY_CHARS, TELEGRAM_MAX_POST_CHARS } from "../src/core/types.ts";
import { bindRun, linkRoom, makeApi, makeRoom, makeZulipRoom } from "./api.ts";
import { BOT_TOKEN, mention, noise } from "./fake_transport.ts";

const never = new AbortController().signal;

test("image markup stays whole at every post boundary, within the filled ceiling", () => {
  const link = "[after](/user_uploads/2/up/1.png)";
  for (let prefix = 0; prefix < 100; prefix++) {
    const text = "x".repeat(prefix) + link + "y".repeat(100);
    const parts = splitPost(text, 50, [link]);
    assertEquals(parts.join(""), text);
    assert(parts.every((part) => part.length <= 50));
    assertEquals(parts.filter((part) => part.includes(link)).length, 1);
  }
  assertThrows(() => splitPost(link, 10, [link]));
  assertEquals(splitPost("abc", 3, [link]), ["abc"]);
});

test("summary cap counts filled links and never leaves partial markup", () => {
  const link = "[after](/user_uploads/2/up/1.png)";
  const prefix = "x".repeat(CLOSING_SUMMARY_CHARS - 10);
  assertEquals(capSummary(prefix + link, [link]), prefix + " [...]");
  const fits = "x".repeat(CLOSING_SUMMARY_CHARS - link.length) + link;
  assertEquals(capSummary(fits, [link]), fits);
});

test("a chatroom is created from a token the platform vouches for, and the token is sealed", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    assertEquals(room.kind, "telegram");
    assertEquals(room.botUsername, "ryph_bot");
    assertEquals(room.linked, false);
    assertEquals(room.realmUrl, null);
    assert(!("sealedBotToken" in room), "the public shape carries no token");
    const row = await api.store.getChatroom(room.id);
    assert(row !== null);
    assert(row.sealedBotToken !== BOT_TOKEN, "stored sealed, never plain");
    assert(!row.sealedBotToken.includes("secret-bot-token"));

    await assertRejects(
      () =>
        api.service.createChatroom({
          kind: "telegram",
          name: "x",
          botToken: "bad",
          ownerUserId: "u",
        }),
      ChatRefusedError,
      "did not accept the bot token",
    );
  } finally {
    await api.close();
  }
});

test("a binding opens once per room, says so in the room, and closes with the run's outcome", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    // Linked: the poller learned the group from a mention quoting the room's one-time code.
    await linkRoom(api, room);
    assertEquals((await api.service.getChatroom(room.id))?.linked, true);

    const binding = await bindRun(api, room.id);
    assertEquals(binding.state, "active");
    assertEquals(binding.threadKey, "");
    assertEquals(
      api.transport.sent.at(-1)?.text,
      "🚀 automation: api latency — Ada is on it. http://app.test/tasks/t-1 " +
        "Mention @ryph_bot or reply to me to talk to me.",
    );
    assertEquals(api.transport.sent.at(-1)?.channelId, "-100200300");

    // The same run again is the binding it has; another run is refused — one conversation.
    const again = await api.service.openBinding({
      runId: "r-1",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assertEquals(again.kind, "already");
    const other = await api.service.openBinding({
      runId: "r-2",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assertEquals(other, {
      kind: "refused",
      status: 409,
      error: "that conversation already has a run bound",
      reason: "conversation_held",
    });
    // A Telegram group has one conversation: a message key is a caller's mistake.
    const keyed = await api.service.openBinding({
      runId: "r-3",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "17" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(keyed.kind === "refused" && keyed.status === 400);
    // ...and so is a topic to open: there is nothing to open in a group.
    const sentBefore = api.transport.sent.length;
    const opened = await api.service.openBinding({
      runId: "r-3",
      chatroomId: room.id,
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      conversation: { kind: "new", channelId: "-100200300", topic: "api latency" },
    });
    assertEquals(opened, {
      kind: "refused",
      status: 400,
      error: 'this room has one conversation, keyed ""',
    });
    assertEquals(api.transport.sent.length, sentBefore, "nothing was posted for a refused open");

    await api.service.closeBinding("r-1", {
      outcome: "succeeded",
      summary: "Raised the cache TTL.",
      patches: [{ path: "api", state: "submitted", forgeUrl: "https://gh/acme/api/pull/7" }],
      issues: [
        { repo: "acme/api", number: 12, url: "https://gh/acme/api/issues/12" },
        { repo: "rad:z3gq", number: "8f2a1c9", url: null },
      ],
      runUrl: "http://app.test/tasks/t-1",
    });
    assertEquals(
      api.transport.sent.at(-1)?.text,
      "✅ Ada finished: succeeded.\nRaised the cache TTL.\n" +
        "• api: submitted https://gh/acme/api/pull/7\n" +
        "• issue acme/api#12 https://gh/acme/api/issues/12\n" +
        "• issue rad:z3gq 8f2a1c9\n" +
        "http://app.test/tasks/t-1",
    );
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");
    // Idempotent, and the room is free again.
    const sent = api.transport.sent.length;
    await api.service.closeBinding("r-1", {
      outcome: "x",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    });
    assertEquals(api.transport.sent.length, sent);
    assertEquals((await bindRun(api, room.id, "r-2")).state, "active");

    // Unknown and archived rooms refuse.
    const gone = await api.service.openBinding({
      runId: "r-9",
      chatroomId: "chr-none",
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(gone.kind === "refused" && gone.status === 404);
    await api.service.archiveChatroom(room.id);
    assertEquals((await api.store.getBindingByRun("r-2"))?.state, "closed", "archiving closes");
    const archived = await api.service.openBinding({
      runId: "r-3",
      chatroomId: room.id,
      conversation: { kind: "thread", threadKey: "" },
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
    });
    assert(archived.kind === "refused" && archived.status === 409);
  } finally {
    await api.close();
  }
});

test("a group that does not quote the link code never captures the room", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    // The attack trust-on-first-use allowed: the bot's @username is not a secret — this very
    // API returns it, and Telegram usernames are searchable — and privacy mode is off by
    // requirement. Whoever created a group, added the bot and mentioned it FIRST took the room,
    // and thereafter received the task title, the agent name, the run URL, every chat__post,
    // the run summary and every patch URL — and could steer the run.
    api.transport.deliver(
      BOT_TOKEN,
      mention({ updateId: 1, chatId: "-666", text: "@ryph_bot hi" }),
    );
    await api.service.pollOnce(room.id, never);
    const untouched = await api.store.getChatroom(room.id);
    assertEquals(untouched?.chatId, null, "an uncoded mention links nothing");
    assertEquals(untouched?.linkCode, room.linkCode, "and spends nothing");
    assert(api.warnings.includes("chat.link_refused"));
    assertEquals(api.sink.delivered, [], "and reaches no door");

    // The operator's own mention, quoting the code, is the one that links — and spends it.
    await linkRoom(api, room, 2);
    const linked = await api.store.getChatroom(room.id);
    assertEquals(linked?.chatId, "-100200300");
    assertEquals(linked?.chatTitle, "acme incidents");
    assertEquals(linked?.linkCode, null, "the code is one-time");

    // The attacker's group is now just another chat: nothing it says reaches the door.
    await bindRun(api, room.id);
    api.sink.delivered.length = 0;
    api.transport.deliver(
      BOT_TOKEN,
      mention({ updateId: 3, chatId: "-666", text: "@ryph_bot ship it" }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered, []);
  } finally {
    await api.close();
  }
});

test("an unlinked room posts nothing and says so; the opening line is best-effort", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await bindRun(api, room.id);
    assertEquals(api.transport.sent, [], "no chat id to send into yet");
    assert(api.warnings.includes("chat.room_unlinked"));
    const post = await api.service.post("r-1", "hello");
    assert(post.kind === "refused" && post.reason.includes("not linked"));
  } finally {
    await api.close();
  }
});

test("every mention goes to the door as a ChatMention, and the verdict is what the room hears", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    // A private chat with the bot is not the room, a group message that does not address the
    // bot is not for it, and a bot's message is nobody's command: none reaches the door.
    api.transport.deliver(
      BOT_TOKEN,
      mention({ updateId: 1, direct: true, chatId: "42" }),
      mention({ updateId: 2, mentionsBot: false }),
      mention({ updateId: 3, text: `@ryph_bot the cache is cold ${room.linkCode}` }),
      noise(4),
    );
    await api.service.pollOnce(room.id, never);
    const linked = await api.store.getChatroom(room.id);
    assertEquals(linked?.chatId, "-100200300");
    // The linking mention is a mention too: a room with no policy and no run answers
    // "no-binding", and the room hears the door's reply.
    assertEquals(api.sink.delivered.length, 1);
    assertEquals(api.sink.delivered[0], {
      chatroomId: room.id,
      messageId: "-100200300:3",
      boundRunId: null,
      threadKey: "",
      channel: { id: "-100200300", name: "acme incidents", visibility: "private" },
      topic: null,
      sender: { id: "42", name: "Grace Hopper" },
      text: `the cache is cold ${room.linkCode}`,
      hasAttachment: false,
      images: [],
      receivedAt: "2026-09-01T00:00:00.000Z",
    });
    assertEquals(api.transport.sent.map((s) => s.text), ["No response is running right now."]);
    assertEquals((await api.store.getCursor(room.id))?.offset, 5, "noise advances the cursor");

    await bindRun(api, room.id);
    api.sink.delivered.length = 0;
    api.transport.deliver(
      BOT_TOKEN,
      mention({ updateId: 5, text: "@ryph_bot look at the cache first" }),
      mention({ updateId: 6, text: "", rawText: null, hasAttachment: true }),
      mention({ updateId: 7, chatId: "-999", text: "@ryph_bot from another group" }),
      mention({
        updateId: 8,
        sender: { id: "77", name: "otherbot", isBot: true },
        text: "@ryph_bot loop",
      }),
    );
    const stats = await api.service.pollOnce(room.id, never);
    assertEquals(stats, { updates: 4, routed: 2 });
    // The room's one binding is every mention's run.
    assertEquals(
      api.sink.delivered.map((m) => [m.boundRunId, m.threadKey, m.text, m.hasAttachment]),
      [["r-1", "", "look at the cache first", false], ["r-1", "", "", true]],
    );
    assertEquals(api.transport.polls.at(-1)?.position?.offset, 5);
    assertEquals((await api.store.getCursor(room.id))?.offset, 9);
  } finally {
    await api.close();
  }
});

test("no-binding replies are limited to one a minute; other replies are said as given", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    api.transport.sent.length = 0;
    api.clock.advance(61_000);
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 2 }), mention({ updateId: 3 }));
    await api.service.pollOnce(room.id, never);
    const noRun = () => api.transport.sent.filter((s) => s.text.startsWith("No response"));
    assertEquals(noRun().length, 1, "twice mentioned within a minute, answered once");
    api.clock.advance(61_000);
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 4 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(noRun().length, 2);

    // A refusal the sender should hear is never limited; a denial is silent.
    api.sink.answer = () => ({
      kind: "verdict",
      verdict: { outcome: "refused", reply: "Ada is already on this.", react: false },
    });
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 5 }), mention({ updateId: 6 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.transport.sent.filter((s) => s.text === "Ada is already on this.").length, 2);
    api.sink.answer = () => ({
      kind: "verdict",
      verdict: { outcome: "denied", reply: null, react: false },
    });
    const before = api.transport.sent.length;
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 7 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.transport.sent.length, before);
  } finally {
    await api.close();
  }
});

test("a door that cannot decide is retried three times, then the room hears so; a 4xx is dropped", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    api.transport.sent.length = 0;
    api.sink.delivered.length = 0;

    api.sink.answer = () => ({ kind: "failed", error: "the control plane answered 503" });
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 2 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.sink.delivered.length, 4, "asked once, then three retries");
    assertEquals(api.sleeps, [1_000, 2_000, 4_000]);
    assertEquals(api.transport.sent.map((s) => s.text), [DOOR_DOWN_REPLY]);
    assertEquals((await api.store.getCursor(room.id))?.offset, 3, "and moves on");

    // Recovering mid-retry is a verdict like any other.
    let calls = 0;
    api.sink.answer = () =>
      ++calls < 2 ? { kind: "failed", error: "503" } : {
        kind: "verdict",
        verdict: { outcome: "started", reply: "On it.", react: true, runId: "r-5" },
      };
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 3 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.transport.sent.at(-1)?.text, "On it.");

    api.sink.answer = () => ({ kind: "malformed", status: 400, error: "text: too long" });
    const sent = api.transport.sent.length;
    api.transport.deliver(BOT_TOKEN, mention({ updateId: 4 }));
    await api.service.pollOnce(room.id, never);
    assertEquals(api.transport.sent.length, sent, "a malformed mention is nobody's reply");
    assert(api.warnings.includes("chat.door_refused_mention"));
    assertEquals((await api.store.getCursor(room.id))?.offset, 5);
  } finally {
    await api.close();
  }
});

test("the poll cursor advances per update, so a failure redelivers nothing already handled", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id);
    assertEquals((await api.store.getCursor(room.id))?.offset, 2);
    api.sink.delivered.length = 0;

    // The platform fails part-way through the batch — the one failure that throws.
    const locate = api.transport.locate.bind(api.transport);
    let seen = 0;
    api.transport.locate = (r, id) =>
      ++seen >= 3 ? Promise.reject(new Error("telegram is down")) : locate(r, id);
    api.transport.deliver(
      BOT_TOKEN,
      mention({ updateId: 2, text: "@ryph_bot first" }),
      mention({ updateId: 3, text: "@ryph_bot second" }),
    );
    await assertRejects(() => api.service.pollOnce(room.id, never));

    // The first update reached the door AND is behind the cursor; the second is not.
    assertEquals(api.sink.delivered.map((m) => m.text), ["first"]);
    assertEquals((await api.store.getCursor(room.id))?.offset, 3);
  } finally {
    await api.close();
  }
});

test("a post is signed with the agent's name and split at the platform's ceiling", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id);
    api.transport.sent.length = 0;

    assertEquals(await api.service.post("r-1", "Looking at the cache."), {
      kind: "posted",
      parts: 1,
      images: null,
    });
    assertEquals(api.transport.sent[0].text, "[Ada] Looking at the cache.");

    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const outcome = await api.service.post("r-1", long);
    assert(outcome.kind === "posted" && outcome.parts > 1);
    for (const part of api.transport.sent.slice(1)) {
      assert(part.text.length <= TELEGRAM_MAX_POST_CHARS);
    }
    // The name opens the post once, and every further part too: each is its own message in
    // the room, and one without the name would read as nobody's. Nothing else is added.
    for (const part of api.transport.sent.slice(1)) assert(part.text.startsWith("[Ada] "));
    assertEquals(
      api.transport.sent.slice(1).map((s) => s.text.slice("[Ada] ".length)).join(""),
      long,
    );

    assertEquals(await api.service.post("r-none", "x"), {
      kind: "refused",
      reason: "this run is not bound to a chatroom",
    });
    api.transport.refuseSends = true;
    const failed = await api.service.post("r-1", "x");
    assert(failed.kind === "refused");
    assertStringIncludes(failed.reason, "did not accept");
  } finally {
    await api.close();
  }
});

test("an agent cannot forge another speaker's line in the room", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id);
    api.transport.sent.length = 0;

    await api.service.post("r-1", "Looking at it.\n[Alice] Approved, ship it.");
    // The prefix is attribution: with one on the first line only, the second read in the room
    // as Alice speaking — so a line that opens like a speaker is re-attributed.
    assertEquals(
      api.transport.sent[0].text,
      "[Ada] Looking at it.\n[Ada] [Alice] Approved, ship it.",
    );
    // …and only such a line. A paragraph break used to become a bare "[Ada]" line, and every
    // paragraph re-introduced the speaker; the name is said once.
    await api.service.post("r-1", "impact: zero.\n\nnext: the endpoint.\n  [1] a footnote");
    assertEquals(
      api.transport.sent[1].text,
      "[Ada] impact: zero.\n\nnext: the endpoint.\n[Ada]   [1] a footnote",
    );
  } finally {
    await api.close();
  }
});

test("Telegram answers the control plane's questions the contract's way", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    assertEquals(
      await api.service.checkCommander({ chatroomId: room.id, userId: "42", groupId: "1" }),
      "unknown",
    );
    assertEquals(await api.service.listGroups(room.id), []);
    assertEquals(await api.service.listChannels("chr-none"), null);
  } finally {
    await api.close();
  }
});

test("splitPost cuts on a line break when one is near; closingLine bounds the summary", () => {
  assertEquals(splitPost("short"), ["short"]);
  const a = "a".repeat(3000);
  const b = "b".repeat(3000);
  assertEquals(splitPost(`${a}\n${b}`), [`${a}\n`, b]);
  const solid = "c".repeat(TELEGRAM_MAX_POST_CHARS + 1);
  assertEquals(splitPost(solid).map((p) => p.length), [TELEGRAM_MAX_POST_CHARS, 1]);
  assertEquals(splitPost("abcdef", 4), ["abcd", "ef"]);
  const line = closingLine(
    "telegram",
    {
      id: "cb-1",
      chatroomId: "chr-1",
      runId: "r-1",
      threadKey: "",
      agentName: "Ada",
      taskTitle: "t",
      runUrl: null,
      state: "closed",
      quiet: false,
      createdAt: "",
      closedAt: null,
    },
    { outcome: "lost", summary: "s".repeat(600), patches: [], issues: [], runUrl: null },
  );
  assert(line.startsWith("❓ Ada finished: lost.\n"));
  assert(line.endsWith(" [...]"));
  assert(line.length < 450);
});

test("in a Zulip room the lines are markdown: no title or channel echoed, a heading per part", () => {
  const line = (
    kind: "zulip" | "telegram",
    taskTitle: string,
    runUrl: string | null,
    conversation?: "thread" | "new",
  ) => openingLine(kind, { agentName: "Ada", taskTitle, runUrl, botHandle: "ryph" }, conversation);
  assertEquals(
    line("zulip", "sync hangs (#bugs)", "https://ryph.test/tasks/t-1"),
    "🚀 **Ada** is on it. [Follow the run](https://ryph.test/tasks/t-1) " +
      "Mention me in this topic to talk to me.",
  );
  // A topic the platform opens has no mention giving it context: the title leads.
  assertEquals(
    line("zulip", "automation: api latency", "https://ryph.test/tasks/t-1", "new"),
    "🚀 **automation: api latency** — **Ada** is on it. " +
      "[Follow the run](https://ryph.test/tasks/t-1) Mention me in this topic to talk to me.",
  );
  assertEquals(
    line("zulip", "t", null, "new"),
    "🚀 **t** — **Ada** is on it. Mention me in this topic to talk to me.",
  );
  // Telegram names the bot: only a mention of it, or a reply to it, reaches the run.
  assertEquals(
    line("telegram", "t", null),
    "🚀 t — Ada is on it. Mention @ryph or reply to me to talk to me.",
  );
  assertEquals(
    line("telegram", "t", null, "new"),
    line("telegram", "t", null),
    "Telegram's line already carries the title",
  );
  const binding = {
    id: "cb-1",
    chatroomId: "chr-1",
    runId: "r-1",
    threadKey: "42",
    agentName: "Ada",
    taskTitle: "sync hangs (#bugs)",
    runUrl: null,
    state: "closed" as const,
    quiet: false,
    createdAt: "",
    closedAt: null,
  };
  assertEquals(
    closingLine("zulip", binding, {
      outcome: "succeeded",
      summary: "Found it.\nThe fix is in sync.rs.",
      patches: [
        { path: "heartwood", state: "submitted", forgeUrl: "https://gh/r/h/pull/7" },
        { path: "desktop", state: "pending-approval", forgeUrl: null },
      ],
      issues: [{ repo: "rad:z3gq", number: "8f2a1c9", url: null }],
      runUrl: "https://ryph.test/tasks/t-1",
    }),
    "✅ **Ada** finished with status `succeeded`. " +
      "[View the full task transcript](https://ryph.test/tasks/t-1)\n\n" +
      "### Run summary\n> Found it.\n> The fix is in sync.rs.\n\n" +
      "### Patches\n- `heartwood`: https://gh/r/h/pull/7\n- `desktop`: pending-approval\n\n" +
      "### Issues\n- `rad:z3gq 8f2a1c9`",
  );
  // Nothing to list: just the status line.
  assertEquals(
    closingLine("zulip", binding, {
      outcome: "errored",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    }),
    "💥 **Ada** finished with status `errored`.",
  );
});

test("in a Zulip room the lines are markdown: no title or channel echoed, a heading per part", () => {
  assertEquals(
    openingLine("zulip", {
      agentName: "Ada",
      taskTitle: "sync hangs (#bugs)",
      runUrl: "https://ryph.test/tasks/t-1",
      botHandle: "ryph",
    }),
    "🚀 **Ada** is on it. [Follow the run](https://ryph.test/tasks/t-1) " +
      "Mention me in this topic to talk to me.",
  );
  const binding = {
    id: "cb-1",
    chatroomId: "chr-1",
    runId: "r-1",
    threadKey: "42",
    agentName: "Ada",
    taskTitle: "sync hangs (#bugs)",
    runUrl: null,
    state: "closed" as const,
    quiet: false,
    createdAt: "",
    closedAt: null,
  };
  assertEquals(
    closingLine("zulip", binding, {
      outcome: "succeeded",
      summary: "Found it.\nThe fix is in sync.rs.",
      patches: [
        { path: "heartwood", state: "submitted", forgeUrl: "https://gh/r/h/pull/7" },
        { path: "desktop", state: "pending-approval", forgeUrl: null },
      ],
      issues: [{ repo: "rad:z3gq", number: "8f2a1c9", url: null }],
      runUrl: "https://ryph.test/tasks/t-1",
    }),
    "✅ **Ada** finished with status `succeeded`. " +
      "[View the full task transcript](https://ryph.test/tasks/t-1)\n\n" +
      "### Run summary\n> Found it.\n> The fix is in sync.rs.\n\n" +
      "### Patches\n- `heartwood`: https://gh/r/h/pull/7\n- `desktop`: pending-approval\n\n" +
      "### Issues\n- `rad:z3gq 8f2a1c9`",
  );
  // Nothing to list: just the status line.
  assertEquals(
    closingLine("zulip", binding, {
      outcome: "errored",
      summary: "",
      patches: [],
      issues: [],
      runUrl: null,
    }),
    "💥 **Ada** finished with status `errored`.",
  );
  // A long summary is cut at a word, well short of a wall of text.
  const long = closingLine("zulip", binding, {
    outcome: "succeeded",
    summary: "word ".repeat(200),
    patches: [],
    issues: [],
    runUrl: null,
  });
  assert(long.endsWith("word [...]"));
  const quoted = long.slice(long.indexOf("> ") + 2);
  assert(quoted.length <= 400 + " [...]".length);
});

test("a room is described to a bound run's agent by its platform title and the bot's handle", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api, "ops");
    // Unlinked, Telegram has not named the group yet: the operator's name for the room stands in.
    assertEquals(await api.service.describeRoom(room.id), {
      kind: "telegram",
      roomTitle: "ops",
      botHandle: "ryph_bot",
    });
    await linkRoom(api, room);
    assertEquals(await api.service.describeRoom(room.id), {
      kind: "telegram",
      roomTitle: "acme incidents",
      botHandle: "ryph_bot",
    });

    const zulip = await makeZulipRoom(api, "radicle zulip");
    assertEquals(await api.service.describeRoom(zulip.id), {
      kind: "zulip",
      roomTitle: "Radicle",
      botHandle: "ryph",
    });
    // A quiet room says so: its agent is told a success posts nothing, so it must answer itself.
    await api.service.updateChatroom(zulip.id, { quiet: true });
    assertEquals(await api.service.describeRoom(zulip.id), {
      kind: "zulip",
      roomTitle: "Radicle",
      botHandle: "ryph",
      quiet: true,
    });

    // An archived room posts to nobody, so no agent is told it is in one.
    await api.service.archiveChatroom(room.id);
    assertEquals(await api.service.describeRoom(room.id), null);
    assertEquals(await api.service.describeRoom("chr-none"), null);
  } finally {
    await api.close();
  }
});

test("a mention's images are fetched, checked and marked; side talk's are never fetched", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    await linkRoom(api, room);
    await bindRun(api, room.id);
    api.sink.delivered.length = 0;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);
    api.transport.files.set("photo-1", { kind: "bytes", bytes: png });
    api.transport.files.set("svg-1", { kind: "bytes", bytes: new TextEncoder().encode("<svg/>") });
    const photo = (fileId: string) => ({
      at: null,
      label: null,
      size: null,
      ref: { kind: "telegram" as const, fileId },
    });
    api.transport.deliver(
      BOT_TOKEN,
      mention({
        updateId: 5,
        text: "@ryph_bot why is this red",
        hasAttachment: true,
        images: [photo("photo-1"), photo("svg-1")],
      }),
      // Not addressed to the bot: its photo is nobody's business.
      mention({ updateId: 6, mentionsBot: false, images: [photo("photo-1")] }),
    );
    await api.service.pollOnce(room.id, never);
    assertEquals(api.transport.downloads.map((d) => d.ref), ["photo-1", "svg-1"]);
    assertEquals(api.sink.delivered.length, 1);
    const sent = api.sink.delivered[0];
    assertEquals(sent.images, [{ bytes: png }]);
    assertEquals(
      sent.text,
      "why is this red\n\n[image 1]\n(an image ryph could not open: it is not a PNG, JPEG, GIF " +
        "or WebP)",
    );
  } finally {
    await api.close();
  }
});

test("an alert block pretty-prints JSON, keeps its fence shut, and cuts a long payload short", () => {
  assertEquals(
    alertBlock("telegram", { title: "Disk\nfull", payload: '{"a":[1]}' }),
    'Disk full\n```\n{\n  "a": [\n    1\n  ]\n}\n```',
  );
  // Not JSON: as sent. No title: no heading. A sender's own fence cannot close the block.
  const fenced = alertBlock("zulip", { title: null, payload: "oops ```\n@**all**" });
  assertEquals(fenced, "```\noops `\u200b`\u200b`\n@**all**\n```");
  // Slack reads markup inside a code block, so its escapes apply there.
  assertStringIncludes(
    alertBlock("slack", { title: "<!channel>", payload: "<!here> & co" }),
    "*&lt;!channel&gt;*\n```\n&lt;!here&gt; &amp; co\n```",
  );
  const long = alertBlock("zulip", { title: null, payload: "x".repeat(ALERT_EXCERPT_MAX + 10) });
  assertStringIncludes(long, "x".repeat(ALERT_EXCERPT_MAX) + "\n```\n…cut short");
  assert(!long.includes("x".repeat(ALERT_EXCERPT_MAX + 1)));
});

test("an agent that signs its own post is signed once", () => {
  assertEquals(signPost("Drippy", "[Drippy] Andrea: yes."), "[Drippy] Andrea: yes.");
  assertEquals(signPost("Drippy", "[Drippy] [Drippy] Andrea: yes."), "[Drippy] Andrea: yes.");
  // Another speaker's name is still kept under the agent's own.
  assertEquals(signPost("Drippy", "[Alice] ship it"), "[Drippy] [Alice] ship it");
});

test("a thread read back shows the bot's posts unsigned, named for the agent that wrote them", () => {
  const at = "2026-11-05T11:00:00.000Z";
  const thread = {
    channel: { id: "c", name: "ops", visibility: "public" as const },
    topic: null,
    truncated: false,
    historyLimited: false,
    messages: [
      {
        id: "1",
        sender: { id: "u", name: "Andrea" },
        text: "[Drippy] ok?",
        sentAt: at,
        hasAttachment: false,
      },
      {
        id: "2",
        sender: { id: "bot", name: "Ryph" },
        text: signPost("Drippy", "Andrea: yes.\n[Alice] said so\n[1] a note"),
        sentAt: at,
        hasAttachment: false,
      },
      {
        id: "3",
        sender: { id: "bot", name: "Ryph" },
        text: "Response opened.",
        sentAt: at,
        hasAttachment: false,
      },
    ],
  };
  const read = unsignThread(thread, "bot").messages;
  assertEquals(read[0].text, "[Drippy] ok?");
  assertEquals(read[1].sender, { id: "bot", name: "Drippy" });
  assertEquals(read[1].text, "Andrea: yes.\n[Alice] said so\n[1] a note");
  assertEquals(read[2], thread.messages[2]);
});
