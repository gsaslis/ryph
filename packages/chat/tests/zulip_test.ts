// The Zulip adapter against a fake Zulip server on a real socket: basic auth on every call, the
// events queue and its loss (re-register, backfill from the last message, no replay), mentions
// judged by the server's flag, the bot's mention stripped, bots and system notices dropped,
// locate and the bounded thread read, posts, reactions, the group check and the two lists.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  IDLE_QUEUE_TIMEOUT_S,
  stripBotMentions,
  zulipTransport,
} from "../src/adapters/transport/zulip.ts";
import { THREAD_MAX_CHARS } from "../src/core/types.ts";
import type { PlatformRoom, PollPosition } from "../src/ports/transport.ts";

const EMAIL = "ryph-bot@zulip.test";
const KEY = "the-api-key";
const BOT_ID = 10;

interface Msg {
  id: number;
  type: "stream" | "private";
  stream_id?: number;
  display_recipient: string | unknown[];
  subject: string;
  content: string;
  sender_id: number;
  sender_full_name: string;
  sender_realm_str: string;
  timestamp: number;
  /** The bot's flags on it. */
  flags: string[];
}

interface Stream {
  stream_id: number;
  name: string;
  invite_only: boolean;
  is_web_public: boolean;
  history_public_to_subscribers: boolean;
  /** Whether the bot may see it (public, or subscribed). */
  visible: boolean;
}

/** A small Zulip: enough state to answer the calls the adapter makes, and a log of them. */
function fakeZulip() {
  const streams: Stream[] = [
    {
      stream_id: 4,
      name: "bugs",
      invite_only: false,
      is_web_public: true,
      history_public_to_subscribers: true,
      visible: true,
    },
    {
      stream_id: 5,
      name: "core",
      invite_only: true,
      is_web_public: false,
      history_public_to_subscribers: true,
      visible: false,
    },
    {
      stream_id: 6,
      name: "core-protected",
      invite_only: true,
      is_web_public: false,
      history_public_to_subscribers: false,
      visible: true,
    },
    {
      stream_id: 7,
      name: "general",
      invite_only: false,
      is_web_public: false,
      history_public_to_subscribers: true,
      visible: true,
    },
  ];
  const users: Record<number, { is_bot: boolean }> = {
    8: { is_bot: false },
    9: { is_bot: false },
    [BOT_ID]: { is_bot: true },
    11: { is_bot: true },
  };
  const messages: Msg[] = [];
  const queues = new Map<
    string,
    Array<{ id: number; type: string; message?: Msg; flags?: string[] }>
  >();
  const log: Array<{ method: string; path: string; params: Record<string, string> }> = [];
  const sent: Array<Record<string, string>> = [];
  const reactions: Array<{ id: string; emoji: string }> = [];
  let queueSeq = 0;
  let eventSeq = 0;
  let nextId = 100;

  const ok = (body: Record<string, unknown> = {}) =>
    Response.json({ result: "success", msg: "", ...body });
  const err = (status: number, code: string, msg: string) =>
    Response.json({ result: "error", code, msg }, { status });

  const add = (
    m:
      & Omit<Msg, "id" | "type" | "timestamp" | "sender_realm_str" | "display_recipient">
      & Partial<Msg>,
  ) => {
    const stream = streams.find((s) => s.stream_id === m.stream_id);
    const msg: Msg = {
      id: nextId++,
      type: "stream",
      timestamp: 1_789_000_000 + nextId,
      sender_realm_str: "",
      display_recipient: stream?.name ?? "",
      ...m,
    };
    messages.push(msg);
    // Delivery: the bot hears only what mentions it (it is subscribed to nothing).
    if (msg.flags.includes("mentioned")) {
      for (const q of queues.values()) {
        q.push({ id: ++eventSeq, type: "message", message: msg, flags: msg.flags });
      }
    }
    return msg;
  };

  const visibleMsg = (m: Msg) => {
    const s = streams.find((x) => x.stream_id === m.stream_id);
    return s !== undefined && s.visible;
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    if (req.method !== "GET") {
      Object.assign(params, Object.fromEntries(new URLSearchParams(await req.text())));
    }
    log.push({ method: req.method, path, params });
    if (path === "/server_settings") return ok({ realm_name: "Scratch" });
    if (req.headers.get("authorization") !== `Basic ${btoa(`${EMAIL}:${KEY}`)}`) {
      return err(401, "UNAUTHORIZED", "Invalid API key");
    }
    if (path === "/users/me") return ok({ user_id: BOT_ID, full_name: "ryph", is_bot: true });
    if (path === "/register" && req.method === "POST") {
      const id = `q-${++queueSeq}`;
      const eventTypes = JSON.parse(params.event_types);
      if (eventTypes.length > 0) queues.set(id, []);
      return ok({
        queue_id: id,
        last_event_id: -1,
        max_message_id: messages.at(-1)?.id ?? 0,
        ...(JSON.parse(params.fetch_event_types ?? "[]").includes("realm")
          ? { max_message_length: 60 }
          : {}),
      });
    }
    if (path === "/events" && req.method === "DELETE") {
      queues.delete(params.queue_id);
      return ok();
    }
    if (path === "/events") {
      const q = queues.get(params.queue_id);
      if (q === undefined) {
        return err(400, "BAD_EVENT_QUEUE_ID", `Bad event queue ID: ${params.queue_id}`);
      }
      const after = Number(params.last_event_id);
      return ok({
        events: [...q.filter((e) => e.id > after), { id: ++eventSeq, type: "heartbeat" }],
      });
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/streams\/(\d+)$/))) {
      const id = Number(m[1]);
      const s = streams.find((x) => x.stream_id === id);
      if (s === undefined || !s.visible) return err(400, "BAD_REQUEST", "Invalid channel ID");
      return ok({ stream: s });
    }
    if (path === "/streams") return ok({ streams: streams.filter((s) => s.visible) });
    if ((m = path.match(/^\/users\/(\d+)$/))) {
      const u = users[Number(m[1])];
      return u === undefined ? err(400, "BAD_REQUEST", "No such user") : ok({ user: u });
    }
    if ((m = path.match(/^\/messages\/(\d+)$/)) && req.method === "GET") {
      // The single-message endpoint: Zulip's access check, not the caller's own rows — any
      // message in a public channel, a private channel's only when subscribed, and a DM the
      // bot is in. One 400 for "no such message" and "not yours to read".
      const id = Number(m[1]);
      const found = messages.find((x) => x.id === id);
      if (found === undefined || (found.type === "stream" && !visibleMsg(found))) {
        return err(400, "BAD_REQUEST", "Invalid message(s)");
      }
      return ok({ message: found, raw_content: found.content });
    }
    if (path === "/messages" && req.method === "GET") {
      // No `id:` narrow here: served from the caller's UserMessage rows, it misses the bot's own
      // post into a public channel it is not subscribed to — the adapter must fetch by id.
      const narrow = JSON.parse(params.narrow) as Array<{ operator: string; operand: unknown }>;
      const op = narrow[0];
      if (op.operator === "with") {
        const key = messages.find((x) => x.id === op.operand);
        if (key === undefined || !visibleMsg(key)) {
          return err(400, "BAD_NARROW", "Invalid 'with' operator");
        }
        const topic = messages.filter((x) =>
          x.stream_id === key.stream_id && x.subject === key.subject
        );
        const n = Number(params.num_before);
        return ok({
          messages: topic.slice(-n),
          found_oldest: topic.length <= n,
          found_newest: true,
          history_limited: false,
        });
      }
      if (op.operator === "is" && op.operand === "mentioned") {
        assertEquals(params.include_anchor, "false");
        const anchor = Number(params.anchor);
        const after = messages.filter((x) =>
          x.id > anchor && x.flags.includes("mentioned") && visibleMsg(x)
        );
        const n = Number(params.num_after);
        return ok({ messages: after.slice(0, n), found_newest: after.length <= n });
      }
    }
    if (path === "/messages" && req.method === "POST") {
      sent.push(params);
      // The post is a message like any other — the bot's own, in whatever channel it named
      // (Zulip lets a non-subscriber post to a public channel).
      const posted = add({
        stream_id: Number(params.to),
        subject: params.topic,
        content: params.content,
        sender_id: BOT_ID,
        sender_full_name: "ryph",
        flags: [],
      });
      return ok({ id: posted.id });
    }
    if ((m = path.match(/^\/messages\/(\d+)\/reactions$/))) {
      reactions.push({ id: m[1], emoji: params.emoji_name });
      return ok();
    }
    if ((m = path.match(/^\/user_groups\/(\d+)\/members\/(\d+)$/))) {
      if (m[1] !== "33") return err(400, "BAD_REQUEST", "Invalid user group");
      return ok({ is_user_group_member: m[2] === "8" });
    }
    if (path === "/user_groups") {
      return ok({
        user_groups: [
          {
            id: 9,
            name: "role:nobody",
            description: "Nobody",
            is_system_group: true,
            deactivated: false,
          },
          {
            id: 33,
            name: "core-team",
            description: "the core team",
            is_system_group: false,
            deactivated: false,
          },
          { id: 34, name: "old", description: "", is_system_group: false, deactivated: true },
        ],
      });
    }
    return err(404, "NOT_FOUND", `no route ${req.method} ${path}`);
  };

  return { streams, users, messages, queues, log, sent, reactions, add, handler };
}

async function withZulip(
  run: (ctx: {
    zulip: ReturnType<typeof fakeZulip>;
    room: PlatformRoom;
    transport: ReturnType<typeof zulipTransport>;
  }) => Promise<void>,
) {
  const zulip = fakeZulip();
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, zulip.handler);
  try {
    const realmUrl = `http://127.0.0.1:${server.addr.port}`;
    const room: PlatformRoom = {
      id: "chr-1",
      credential: { kind: "zulip", realmUrl, botEmail: EMAIL, apiKey: KEY },
      bot: { id: String(BOT_ID), name: "ryph" },
      chatId: null,
      chatTitle: "Scratch",
    };
    await run({ zulip, room, transport: zulipTransport() });
  } finally {
    await server.shutdown();
  }
}

const never = new AbortController().signal;

test("whoAmI: basic auth, the bot's id and name, the organization's title; a wrong key throws without naming it", async () => {
  await withZulip(async ({ room, transport }) => {
    assertEquals(await transport.whoAmI(room.credential), {
      id: "10",
      name: "ryph",
      title: "Scratch",
    });
    const err = await assertRejects(
      () =>
        transport.whoAmI({ ...room.credential, apiKey: "wrong-key" } as PlatformRoom["credential"]),
      Error,
    );
    assert(err.message.includes("401"));
    assert(!err.message.includes("wrong-key"));
  });
});

test("the poller registers, hears mentions only, drops bots, and survives a lost queue by backfilling", async () => {
  await withZulip(async ({ zulip, room, transport }) => {
    zulip.add({
      stream_id: 4,
      subject: "old",
      content: "@**ryph** before the room existed",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });

    // First poll: a queue, starting from now — nothing older is ours.
    let batch = await transport.poll(room, { position: null, timeoutS: 0, signal: never });
    const register = zulip.log.find((l) => l.path === "/register")!;
    assertEquals(JSON.parse(register.params.event_types), ["message"]);
    assertEquals(register.params.idle_queue_timeout, String(IDLE_QUEUE_TIMEOUT_S));
    assertEquals(register.params.apply_markdown, "false");
    assertEquals(batch.updates, []);
    let position: PollPosition = batch.position;
    assertEquals(position, { queueId: "q-1", offset: -1, lastMessageId: 100 });

    const report = zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "rad sync crashes",
      sender_id: 9,
      sender_full_name: "bob",
      flags: [],
    });
    const cmd = zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "@**ryph** investigate this, see [log](/user_uploads/2/ab/log.txt) and ask @**bob**",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });
    zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "@**ryph|10** loop",
      sender_id: 11,
      sender_full_name: "otherbot",
      flags: ["mentioned"],
    });
    zulip.add({
      stream_id: 5,
      subject: "secret",
      content: "@**ryph** in private",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });

    batch = await transport.poll(room, { position, timeoutS: 0, signal: never });
    const messages = batch.updates.map((u) => u.message);
    assertEquals(messages.length, 3);
    assertEquals(messages[0], {
      messageId: String(cmd.id),
      threadKey: String(cmd.id),
      chatId: null,
      direct: false,
      channel: { id: "4", name: "bugs", visibility: "web-public" },
      topic: "crash",
      sender: { id: "8", name: "alice", isBot: false },
      rawText: cmd.content,
      text: "investigate this, see [log](/user_uploads/2/ab/log.txt) and ask @**bob**",
      hasAttachment: true,
      // A text file is an upload, and not an image: it stays the link it was.
      images: [],
      mentionsBot: true,
      servable: true,
    });
    assertEquals(
      messages[1]?.sender?.isBot,
      true,
      "a bot's mention is marked, and the service drops it",
    );
    assertEquals([messages[2]?.servable, messages[2]?.channel.visibility], [false, "private"]);
    position = batch.position;
    assertEquals(position.queueId, "q-1");
    assert(position.offset > 0, "the heartbeat moved the event id");
    assertEquals(position.lastMessageId, cmd.id + 2);
    assert(report.id < cmd.id);

    // The queue is garbage-collected (a server restart); two mentions arrive while it is gone.
    zulip.queues.clear();
    const missed1 = zulip.add({
      stream_id: 7,
      subject: "a",
      content: "@**ryph** one",
      sender_id: 9,
      sender_full_name: "bob",
      flags: ["mentioned"],
    });
    const missed2 = zulip.add({
      stream_id: 7,
      subject: "b",
      content: "@**ryph** two",
      sender_id: 9,
      sender_full_name: "bob",
      flags: ["mentioned"],
    });
    batch = await transport.poll(room, { position, timeoutS: 0, signal: never });
    assertEquals(batch.updates.map((u) => u.message?.messageId), [
      String(missed1.id),
      String(missed2.id),
    ]);
    assertEquals(batch.position.queueId, "q-2");
    assertEquals(batch.position.lastMessageId, missed2.id);
    assertEquals(batch.updates[0].position.queueId, "q-2", "each update carries the new queue");
    position = batch.position;

    // The new queue also delivers anything the backfill already covered: no replay.
    zulip.queues.get("q-2")!.push({
      id: 999,
      type: "message",
      message: { ...missed2 },
      flags: ["mentioned"],
    });
    batch = await transport.poll(room, { position, timeoutS: 0, signal: never });
    assertEquals(batch.updates.map((u) => u.message), [null]);
  });
});

test("stripBotMentions removes the bot's loud mentions and nothing else", () => {
  const bot = { id: "10", name: "ryph" };
  assertEquals(stripBotMentions("@**ryph** look", bot), "look");
  assertEquals(stripBotMentions("@**Ryph** look", bot), "look");
  assertEquals(
    stripBotMentions("hey @**ryph|10**, look at @**ryph** again", bot),
    "hey , look at again",
  );
  assertEquals(stripBotMentions("@**ryph (old)|10** go", bot), "go");
  assertEquals(
    stripBotMentions("@_**ryph** silent and @**bob**", bot),
    "@_**ryph** silent and @**bob**",
  );
  assertEquals(
    stripBotMentions("@**ryph|11** is someone else", bot),
    "@**ryph|11** is someone else",
  );
  assertEquals(stripBotMentions("@**ryph**", bot), "");
});

test("locate fetches the message by id: the bot's own post into a public channel it is not subscribed to is found, a private channel it is not in is null", async () => {
  await withZulip(async ({ zulip, room, transport }) => {
    // "general" is public and the bot is subscribed to nothing: its post there is the key a
    // response binds to, and it has no UserMessage row of its own to be narrowed from.
    const posted = await transport.send(
      room,
      { channelId: "7", topic: "api latency" },
      "🚀 **Ada** is on it.",
    );
    assertEquals(await transport.locate(room, posted), {
      channel: { id: "7", name: "general" },
      topic: "api latency",
    });
    const byId = zulip.log.filter((l) => l.path === `/messages/${posted}`);
    assertEquals(byId.map((l) => [l.method, l.params.apply_markdown]), [["GET", "false"]]);
    assertEquals(
      zulip.log.filter((l) => l.path === "/messages" && l.method === "GET"),
      [],
      "never through a narrow",
    );

    // A private channel the bot is not subscribed to answers 400 "Invalid message(s)" — the
    // same answer as no such message — and that is the port's null, not a throw.
    const hidden = zulip.add({
      stream_id: 5,
      subject: "secret",
      content: "planning",
      sender_id: 8,
      sender_full_name: "alice",
      flags: [],
    });
    assertEquals(await transport.locate(room, String(hidden.id)), null);
    assertEquals(await transport.locate(room, String(hidden.id + 1000)), null, "no such message");
    // A DM the bot can read is still no conversation a run could bind.
    const dm = zulip.add({
      type: "private",
      display_recipient: [{ id: 8 }, { id: BOT_ID }],
      subject: "",
      content: "psst",
      sender_id: 8,
      sender_full_name: "alice",
      flags: [],
    });
    assertEquals(await transport.locate(room, String(dm.id)), null);
    // Anything but that 400 still throws, naming the call and never the credential.
    const rejected = await assertRejects(
      () =>
        transport.locate(
          { ...room, credential: { ...room.credential, apiKey: "wrong-key" } } as PlatformRoom,
          posted,
        ),
      Error,
    );
    assert(
      rejected.message.includes(`GET /messages/${posted}`) && rejected.message.includes("401"),
    );
    assert(!rejected.message.includes("wrong-key"));
  });
});

test("locate, the bounded thread read, posts, reactions, commanders and the lists", async () => {
  await withZulip(async ({ zulip, room, transport }) => {
    zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "rad sync crashes",
      sender_id: 9,
      sender_full_name: "bob",
      flags: [],
    });
    const key = zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "@**ryph** investigate",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });
    zulip.add({
      stream_id: 4,
      subject: "crash",
      content: "@_**alice|8** has marked this topic as resolved.",
      sender_id: 6,
      sender_full_name: "Notification Bot",
      sender_realm_str: "zulipinternal",
      flags: [],
    });
    const hidden = zulip.add({
      stream_id: 5,
      subject: "secret",
      content: "@**ryph** x",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });

    assertEquals(await transport.locate(room, String(key.id)), {
      channel: { id: "4", name: "bugs" },
      topic: "crash",
    });
    assertEquals(await transport.locate(room, "99999"), null, "deleted");
    assertEquals(await transport.locate(room, String(hidden.id)), null, "unreadable");
    assertEquals(await transport.locate(room, ""), null);

    const thread = await transport.fetchThread(room, String(key.id));
    assertEquals(thread?.channel, { id: "4", name: "bugs", visibility: "web-public" });
    assertEquals(thread?.topic, "crash");
    assertEquals(
      thread?.messages.map((m) => m.text),
      ["rad sync crashes", "@**ryph** investigate"],
      "the notice is dropped",
    );
    assertEquals(thread?.messages[0].sender, { id: "9", name: "bob" });
    assertEquals(thread?.truncated, false);
    assertEquals(thread?.historyLimited, false);
    assertEquals(await transport.fetchThread(room, "99999"), null);

    // A long topic keeps the newest messages that fit, and says it dropped some.
    for (let i = 0; i < 8; i++) {
      zulip.add({
        stream_id: 4,
        subject: "crash",
        content: `${i} ${"x".repeat(THREAD_MAX_CHARS / 5)}`,
        sender_id: 9,
        sender_full_name: "bob",
        flags: [],
      });
    }
    const bounded = await transport.fetchThread(room, String(key.id));
    assertEquals(bounded?.truncated, true);
    assert(bounded!.messages.length < 8 && bounded!.messages.at(-1)!.text.startsWith("7 "));

    // A private channel with protected history: the bot sees only what came after it joined.
    const protectedKey = zulip.add({
      stream_id: 6,
      subject: "p",
      content: "@**ryph** go",
      sender_id: 8,
      sender_full_name: "alice",
      flags: ["mentioned"],
    });
    assertEquals(
      (await transport.fetchThread(room, String(protectedKey.id)))?.historyLimited,
      true,
    );

    // The posted message's id comes back, as the server minted it — the key a run binds to
    // when the platform's own post opens its topic.
    const posted = await transport.send(
      room,
      { channelId: "4", topic: "✔ crash" },
      "[Ada] found it",
    );
    assertEquals(zulip.sent.at(-1), {
      type: "stream",
      to: "4",
      topic: "✔ crash",
      content: "[Ada] found it",
    });
    assert(/^\d+$/.test(posted));
    assert(Number(posted) > protectedKey.id, "minted after every message so far");
    await transport.react(room, String(key.id));
    assertEquals(zulip.reactions, [{ id: String(key.id), emoji: "eyes" }]);

    assertEquals(await transport.checkMembership(room, "33", "8"), "allowed");
    assertEquals(await transport.checkMembership(room, "33", "9"), "denied");
    assertEquals(
      await transport.checkMembership(room, "34", "8"),
      "unknown",
      "an error is never a yes",
    );
    assertEquals(await transport.checkMembership(room, "x", "8"), "unknown");

    assertEquals(await transport.listChannels(room), {
      channels: [
        { id: "4", name: "bugs", visibility: "web-public" },
        { id: "6", name: "core-protected", visibility: "private" },
        { id: "7", name: "general", visibility: "public" },
      ],
      // One call answers the realm, so a Zulip list is never partial.
      truncated: false,
    });
    assertEquals(await transport.listGroups(room), [{
      id: "33",
      name: "core-team",
      description: "the core team",
    }]);

    // The limit comes from the server, asked once through a queue that is deleted at once.
    assertEquals(await transport.maxMessageLength(room), 60);
    assertEquals(await transport.maxMessageLength(room), 60);
    assertEquals(zulip.log.filter((l) => l.path === "/register").length, 1);
    assertEquals(zulip.queues.size, 0);
  });
});
