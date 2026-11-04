// The Telegram adapter: raw updates to the port's shape, and the calls over an injected fetch —
// the token in the path, never in an error.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { normalizeUpdate, telegramTransport } from "../src/adapters/transport/telegram.ts";
import type { PlatformRoom } from "../src/ports/transport.ts";

const BOT = { username: "ryph_bot", id: "123456" };

test("normalizeUpdate: a mention by username, a reply to the bot, an attachment, a private chat", () => {
  const base = {
    update_id: 7,
    message: {
      message_id: 1,
      chat: { id: -100200300, type: "supergroup", title: "acme incidents" },
      from: { id: 42, first_name: "Grace", last_name: "Hopper", username: "grace" },
      text: "@ryph_bot look at the cache",
      entities: [{ type: "mention", offset: 0, length: 9 }],
    },
  };
  assertEquals(normalizeUpdate(base, BOT), {
    messageId: "-100200300:1",
    threadKey: "",
    chatId: "-100200300",
    direct: false,
    channel: { id: "-100200300", name: "acme incidents", visibility: "private" },
    topic: null,
    sender: { id: "42", name: "Grace Hopper", isBot: false },
    rawText: "@ryph_bot look at the cache",
    text: "look at the cache",
    hasAttachment: false,
    images: [],
    mentionsBot: true,
    servable: true,
  });
  // The mention is removed wherever it sits, whatever its case; the words stay.
  assertEquals(
    normalizeUpdate({
      ...base,
      message: { ...base.message, text: "please @Ryph_Bot check" },
    }, BOT)?.text,
    "please check",
  );
  // Somebody else mentioned, or nobody: not for the bot.
  assertEquals(
    normalizeUpdate({
      ...base,
      message: {
        ...base.message,
        text: "@someone hi",
        entities: [{ type: "mention", offset: 0, length: 8 }],
      },
    }, BOT)?.mentionsBot,
    false,
  );
  // A reply to the bot's own message counts as addressing it.
  assertEquals(
    normalizeUpdate({
      ...base,
      message: {
        ...base.message,
        text: "yes",
        entities: [],
        reply_to_message: { from: { id: 123456 } },
      },
    }, BOT)?.mentionsBot,
    true,
  );
  // A bot is a bot.
  assertEquals(
    normalizeUpdate({
      ...base,
      message: { ...base.message, from: { id: 77, first_name: "other", is_bot: true } },
    }, BOT)?.sender?.isBot,
    true,
  );
  const photo = normalizeUpdate({
    ...base,
    message: { ...base.message, text: undefined, entities: undefined, photo: [{ file_id: "p1" }] },
  }, BOT);
  assertEquals(photo?.rawText, null);
  assertEquals(photo?.text, "");
  assertEquals(photo?.hasAttachment, true);
  const dm = normalizeUpdate({
    ...base,
    message: { ...base.message, chat: { id: 42, type: "private" }, from: { id: 42 } },
  }, BOT);
  assertEquals(dm?.direct, true);
  assertEquals(dm?.sender, { id: "42", name: "user 42", isBot: false });
  assertEquals(normalizeUpdate({ update_id: 8 }, BOT), null);
});

test("the transport dials the Bot API with the token in the path and reads its verdicts", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const dial = ((input: URL | Request | string, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    if (url.includes("/bot bad-token/")) {
      return Promise.resolve(
        Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }),
      );
    }
    if (url.endsWith("/getMe")) {
      return Promise.resolve(
        Response.json({ ok: true, result: { id: 123456, username: "ryph_bot" } }),
      );
    }
    if (url.endsWith("/getUpdates")) {
      return Promise.resolve(Response.json({
        ok: true,
        result: [
          { update_id: 1, edited_message: {} },
          {
            update_id: 2,
            message: {
              message_id: 5,
              chat: { id: -1, type: "group", title: "g" },
              from: { id: 9, first_name: "Ann" },
              text: "@ryph_bot hi",
              entities: [{ type: "mention", offset: 0, length: 9 }],
            },
          },
        ],
      }));
    }
    if (url.endsWith("/sendMessage")) {
      return Promise.resolve(Response.json({
        ok: true,
        result: { message_id: 77, chat: { id: -1, type: "group", title: "g" }, text: "hello" },
      }));
    }
    return Promise.resolve(Response.json({ ok: true, result: {} }));
  }) as typeof fetch;
  const transport = telegramTransport({ apiUrl: "https://tg.test/", fetch: dial });
  const room: PlatformRoom = {
    id: "chr-1",
    credential: { kind: "telegram", botToken: "tok" },
    bot: { id: "123456", name: "ryph_bot" },
    chatId: "-1",
    chatTitle: "g",
  };

  assertEquals(await transport.whoAmI(room.credential), {
    id: "123456",
    name: "ryph_bot",
    title: null,
  });
  assertEquals(calls[0].url, "https://tg.test/bottok/getMe");

  const batch = await transport.poll(room, {
    position: { offset: 1, queueId: null, lastMessageId: null },
    timeoutS: 25,
    signal: new AbortController().signal,
  });
  assertEquals(calls[1].body, { offset: 1, timeout: 25, allowed_updates: ["message"] });
  // The messageless update still advances the cursor; the mention is routed.
  assertEquals(
    batch.updates.map((u) => [u.position.offset, u.message?.mentionsBot ?? null]),
    [[2, null], [3, true]],
  );
  assertEquals(batch.position.offset, 3);

  // The posted message's id, in the form an inbound message carries: `<chatId>:<message_id>`.
  assertEquals(await transport.send(room, { channelId: "-1", topic: null }, "hello"), "-1:77");
  assertEquals(calls[2].body, { chat_id: "-1", text: "hello", parse_mode: "HTML" });

  // One conversation per group; nothing to read, nothing to ask.
  assertEquals(await transport.locate(room, ""), {
    channel: { id: "-1", name: "g" },
    topic: null,
  });
  assertEquals(await transport.fetchThread(room, ""), {
    channel: { id: "-1", name: "g", visibility: "private" },
    topic: null,
    messages: [],
    truncated: false,
    historyLimited: true,
  });
  assertEquals(await transport.checkMembership(room, "1", "9"), "unknown");
  assertEquals(await transport.listChannels(room), {
    channels: [{ id: "-1", name: "g", visibility: "private" }],
    truncated: false,
  });
  assertEquals(await transport.listChannels({ ...room, chatId: null }), {
    channels: [],
    truncated: false,
  });
  assertEquals(await transport.listGroups(room), []);
  assertEquals(await transport.maxMessageLength(room), 4096);

  const err = await assertRejects(
    () => transport.whoAmI({ kind: "telegram", botToken: " bad-token" }),
    Error,
  );
  assert(err.message.includes("getMe answered 401: Unauthorized"));
  assert(!err.message.includes("bad-token"), "the token never rides an error");
});

test("telegram: a run's Markdown goes out as HTML, and as plain text when Telegram refuses the markup", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let refuseHtml = false;
  const dial = ((_input: URL | Request | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (refuseHtml && body.parse_mode === "HTML") {
      return Promise.resolve(Response.json({
        ok: false,
        description: "Bad Request: can't parse entities: Unsupported start tag",
      }, { status: 400 }));
    }
    return Promise.resolve(
      Response.json({ ok: true, result: { message_id: 3, chat: { id: -1 } } }),
    );
  }) as typeof fetch;
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: dial });
  const room: PlatformRoom = {
    id: "chr-1",
    credential: { kind: "telegram", botToken: "tok" },
    bot: { id: "123456", name: "ryph_bot" },
    chatId: "-1",
    chatTitle: "g",
  };
  const target = { channelId: "-1", topic: null };

  await transport.send(room, target, "[Ada] **Fixed** the `deno task` <script> step");
  assertEquals(bodies, [{
    chat_id: "-1",
    text: "[Ada] <b>Fixed</b> the <code>deno task</code> &lt;script&gt; step",
    parse_mode: "HTML",
  }]);

  bodies.length = 0;
  refuseHtml = true;
  assertEquals(await transport.send(room, target, "**odd**"), "-1:3");
  assertEquals(bodies, [
    { chat_id: "-1", text: "<b>odd</b>", parse_mode: "HTML" },
    { chat_id: "-1", text: "**odd**" },
  ]);
});
