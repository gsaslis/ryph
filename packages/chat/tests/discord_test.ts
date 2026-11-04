// The Discord adapter against a stand-in REST API and a scripted Gateway: what it asks, what it
// says on the socket (identify, heartbeat, resume), how it survives a dropped or zombie
// connection, what it refuses to retry, and what one MESSAGE_CREATE becomes. Never the network,
// and never a real WebSocket — the dialer is the seam.

import { afterEach, test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DISCORD_INTENTS,
  type DiscordDialer,
  DiscordError,
  DiscordThreadLockedError,
  discordTransport,
  type DiscordTransportOptions,
  parseDiscordAddress,
  renderDiscordText,
  stripBotMention,
  threadName,
} from "../src/adapters/transport/discord.ts";
import {
  type ChatTransport,
  CredentialRefusedError,
  type PlatformRoom,
  type PollBatch,
} from "../src/ports/transport.ts";

const TOKEN = "MTAw.bot-secret-token";
const GUILD = "800000000000000001";
const BOT = "800000000000000099";
const ALICE = "800000000000000077";
const CHANNEL = "800000000000000010";
const THREAD = "800000000000000020";
const FORUM = "800000000000000030";
const ROLE = "800000000000000088";
const OTHER_GUILD = "800000000000000555";
const API = "https://discord.test/api/v10";
const GATEWAY = "wss://gateway.discord.gg";
const RESUME = "wss://gateway-us-east1-b.discord.gg";

const ROOM: PlatformRoom = {
  id: "chr-d",
  credential: { kind: "discord", botToken: TOKEN, guildId: GUILD },
  bot: { id: BOT, name: "ryph" },
  chatId: GUILD,
  chatTitle: "Acme",
};

interface Call {
  method: string;
  /** The path under the API base, query included. */
  path: string;
  auth: string;
  json: Record<string, unknown> | null;
  form: FormData | null;
}

/** What a route answers: a body (200), a whole `Response`, or a function of the call. */
type Reply = unknown | ((call: Call) => unknown);

/** The REST API, scripted by `"<METHOD> <path>"` (query left off). An unscripted call is a 404
 * with Discord's Unknown Channel code — the answer for a thread that does not exist. */
function fakeApi(routes: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const answer = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = new URL(String(input));
    const path = url.href.slice(API.length);
    const body = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      auth: new Headers(init?.headers).get("authorization") ?? "",
      json: typeof body === "string" ? JSON.parse(body) : null,
      form: body instanceof FormData ? body : null,
    };
    calls.push(call);
    const scripted = routes[`${call.method} ${path.split("?")[0]}`];
    const reply = typeof scripted === "function" ? scripted(call) : scripted;
    if (reply instanceof Response) return reply;
    if (reply === undefined) {
      return Response.json({ message: "Unknown Channel", code: 10003 }, { status: 404 });
    }
    if (reply === null) return new Response(null, { status: 204 });
    return Response.json(reply);
  };
  const fetcher =
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(answer(input, init))) as typeof fetch;
  return { calls, fetcher };
}

const refuse = (status: number, code: number, message = "refused") =>
  Response.json({ message, code }, { status });

interface FakeSocket {
  url: string;
  /** Every frame this side sent, parsed. */
  sent: Array<{ op: number; d: unknown }>;
  /** The code this side closed with, or null while open. */
  closedWith: number | null;
  deliver(frame: unknown): void;
  /** The server ends the connection. */
  end(code: number, reason?: string): void;
}

function fakeDialer(): { sockets: FakeSocket[]; dial: DiscordDialer } {
  const sockets: FakeSocket[] = [];
  const dial: DiscordDialer = (url, handlers) => {
    let ended = false;
    const socket: FakeSocket = {
      url,
      sent: [],
      closedWith: null,
      deliver: (frame) => handlers.message(JSON.stringify(frame)),
      end: (code, reason = "") => {
        if (ended) return;
        ended = true;
        handlers.closed(code, reason);
      },
    };
    sockets.push(socket);
    return {
      send: (text) => socket.sent.push(JSON.parse(text)),
      close: (code) => {
        socket.closedWith = code;
        socket.end(code);
      },
    };
  };
  return { sockets, dial };
}

/** A text channel; `secret` denies `@everyone` View Channel, as the Private Channel switch does. */
const textChannel = (id = CHANNEL, secret = true, type = 0) => ({
  id,
  type,
  name: id === CHANNEL ? "ops" : `c${id.slice(-2)}`,
  guild_id: GUILD,
  permission_overwrites: secret ? [{ id: GUILD, type: 0, allow: "0", deny: "1024" }] : [],
});
const thread = (id = THREAD, parent = CHANNEL) => ({
  id,
  type: 11,
  name: "cache is cold",
  parent_id: parent,
  guild_id: GUILD,
});

/** A MESSAGE_CREATE's `d`: Alice mentioning the bot at the top of the ops channel. */
const message = (overrides: Record<string, unknown> = {}) => ({
  id: "800000000000001000",
  type: 0,
  channel_id: CHANNEL,
  guild_id: GUILD,
  author: { id: ALICE, username: "alice", global_name: "Alice H" },
  member: { nick: null },
  content: `<@${BOT}> look at the cache`,
  timestamp: "2026-10-28T10:00:00.000000+00:00",
  mentions: [{ id: BOT, username: "ryph", bot: true }],
  attachments: [],
  ...overrides,
});

/** The routes a gateway-driven test needs: the gateway's address and the channels. */
const baseRoutes = (more: Record<string, Reply> = {}): Record<string, Reply> => ({
  "GET /gateway/bot": { url: GATEWAY, shards: 1 },
  [`GET /channels/${CHANNEL}`]: textChannel(),
  [`GET /channels/${THREAD}`]: thread(),
  ...more,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const nothing = new AbortController().signal;

const opened: ChatTransport[] = [];
afterEach(() => {
  // Every socket closed, every heartbeat stopped.
  for (const transport of opened.splice(0)) transport.releaseAllBut(new Set());
});

function transportWith(api: ReturnType<typeof fakeApi>, more: DiscordTransportOptions = {}) {
  const dialer = fakeDialer();
  let now = 1_000_000;
  const transport = discordTransport({
    apiUrl: API,
    fetch: api.fetcher,
    dial: dialer.dial,
    jitter: () => 0.5,
    now: () => now,
    maxRetryAfterMs: 50,
    ...more,
  });
  opened.push(transport);
  return {
    transport,
    sockets: dialer.sockets,
    advance: (ms: number) => (now += ms),
  };
}

/** A poll left holding, with the socket it dialled: the test plays the Gateway, then awaits. */
async function polling(
  transport: ChatTransport,
  sockets: FakeSocket[],
  opts: { position?: PollBatch["position"] | null; timeoutS?: number; signal?: AbortSignal } = {},
): Promise<{ socket: FakeSocket; batch: Promise<PollBatch> }> {
  const dialled = sockets.length;
  const batch = transport.poll(ROOM, {
    position: opts.position ?? null,
    timeoutS: opts.timeoutS ?? 0.3,
    signal: opts.signal ?? nothing,
  });
  for (let i = 0; i < 20 && sockets.length === dialled; i++) await tick();
  return { socket: sockets[sockets.length - 1], batch };
}

/** HELLO, then READY — a fresh session, as Discord opens one. */
function open(socket: FakeSocket, heartbeatMs = 41_250) {
  socket.deliver({ op: 10, d: { heartbeat_interval: heartbeatMs } });
  socket.deliver({
    op: 0,
    t: "READY",
    s: 1,
    d: { session_id: "sess-1", resume_gateway_url: RESUME, user: { id: BOT } },
  });
}

test("discord: a key names the parent, the thread and the message", () => {
  assertEquals(parseDiscordAddress(`${CHANNEL}:${THREAD}`), {
    channelId: CHANNEL,
    threadId: THREAD,
    messageId: THREAD,
  });
  assertEquals(
    parseDiscordAddress(`${CHANNEL}:${THREAD}:800000000000001000`)?.messageId,
    "800000000000001000",
  );
  // Another platform's key, or nonsense, is not an address — never a wrong post.
  for (
    const bad of [
      "",
      CHANNEL,
      "C0OPS:1727530000.000100",
      "123:456",
      `${CHANNEL}:${THREAD}:1:2`,
      `${CHANNEL}:not-a-snowflake`,
    ]
  ) {
    assertEquals(parseDiscordAddress(bad), null, bad);
  }
});

test("discord: text is what the author saw, the bot's own mention gone", () => {
  assertEquals(stripBotMention(`<@${BOT}> look at the cache`, BOT), "look at the cache");
  assertEquals(stripBotMention(`<@!${BOT}> hi`, BOT), "hi");
  assertEquals(stripBotMention(`<@${ALICE}> and <@${BOT}>`, BOT), `<@${ALICE}> and`);
  // The bot's managed role, when it has one, is the bot too; any other role is not.
  assertEquals(stripBotMention(`<@&${ROLE}> hi <@&5>`, BOT, ROLE), "hi <@&5>");
  assertEquals(stripBotMention(`<@&${ROLE}> hi`, BOT), `<@&${ROLE}> hi`);
  const names = new Map([[ALICE, "Alice H"]]);
  assertEquals(
    renderDiscordText(`ask <@${ALICE}> or <@!${ALICE}>`, names),
    "ask @Alice H or @Alice H",
  );
  assertEquals(renderDiscordText("ask <@123456789012345678>", names), "ask @123456789012345678");
  assertEquals(
    renderDiscordText("on fire <:pepe_fire:123> <a:spin:456>", names),
    "on fire :pepe_fire: :spin:",
  );
  // Markdown, roles and channels stay as written.
  assertEquals(renderDiscordText("**now** <@&5> in <#6>", names), "**now** <@&5> in <#6>");
});

test("discord: whoAmI vouches for a bot in the server with Message Content on", async () => {
  const api = fakeApi({
    "GET /users/@me": { id: BOT, username: "ryph", bot: true },
    "GET /applications/@me": { id: "1", flags: 1 << 19 },
    [`GET /guilds/${GUILD}`]: { id: GUILD, name: "Acme" },
  });
  const { transport } = transportWith(api);
  assertEquals(await transport.whoAmI(ROOM.credential), { id: BOT, name: "ryph", title: "Acme" });
  // The token rides the header, in Discord's own scheme, and nowhere else.
  for (const call of api.calls) {
    assertEquals(call.auth, `Bot ${TOKEN}`);
    assert(!call.path.includes(TOKEN));
  }
});

test("discord: whoAmI refuses a person's token, intents off, and a server the bot is not in", async () => {
  const cases: Array<[Record<string, Reply>, string]> = [
    [{ "GET /users/@me": { id: ALICE, username: "alice" } }, "not a bot's"],
    [{
      "GET /users/@me": { id: BOT, username: "ryph", bot: true },
      "GET /applications/@me": { flags: 1 << 14 },
    }, "Message Content intent is off"],
    [{
      "GET /users/@me": { id: BOT, username: "ryph", bot: true },
      "GET /applications/@me": { flags: 1 << 18 },
      [`GET /guilds/${GUILD}`]: refuse(403, 50001, "Missing Access"),
    }, `not in the server ${GUILD}`],
  ];
  for (const [routes, said] of cases) {
    const { transport } = transportWith(fakeApi(routes));
    // In words for the person adding the room, which the service passes on.
    await assertRejects(() => transport.whoAmI(ROOM.credential), CredentialRefusedError, said);
  }
  // A public bot is one a stranger can add to their server, streaming it into this socket.
  const open = transportWith(fakeApi({
    "GET /users/@me": { id: BOT, username: "ryph", bot: true },
    "GET /applications/@me": { flags: 1 << 19, bot_public: true },
    [`GET /guilds/${GUILD}`]: { id: GUILD, name: "Acme" },
  }));
  await assertRejects(
    () => open.transport.whoAmI(ROOM.credential),
    CredentialRefusedError,
    "Turn Public Bot off",
  );
  // A refused token is Discord's 401, named by the call — never the token.
  const { transport } = transportWith(fakeApi({
    "GET /users/@me": refuse(401, 0, "401: Unauthorized"),
  }));
  const err = await assertRejects(() => transport.whoAmI(ROOM.credential), DiscordError);
  assert(err.message.includes("GET /users/@me answered 401"), err.message);
  assert(!err.message.includes(TOKEN));
});

test("discord: identify, heartbeat, and a mention drained off the Gateway", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets } = transportWith(api);
  const { socket, batch } = await polling(transport, sockets);
  assertEquals(socket.url, `${GATEWAY}/?v=10&encoding=json`);
  socket.deliver({ op: 10, d: { heartbeat_interval: 40 } });
  // IDENTIFY answers HELLO, with the three intents and the token — the only place it rides
  // besides a header.
  assertEquals(socket.sent[0].op, 2);
  const identify = socket.sent[0].d as { token: string; intents: number };
  assertEquals(identify.token, TOKEN);
  assertEquals(identify.intents, DISCORD_INTENTS);
  assertEquals(DISCORD_INTENTS, 1 | 512 | 32768);
  socket.deliver({
    op: 0,
    t: "READY",
    s: 1,
    d: { session_id: "sess-1", resume_gateway_url: RESUME },
  });
  // The first beat comes at the jittered fraction of the interval, carrying the last sequence.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(socket.sent[1], { op: 1, d: 1 });
  socket.deliver({ op: 11 });

  // The room's own talk, another server's mention and the bot's own post are never queued.
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: message({ content: "lunch?", mentions: [] }),
  });
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: message({ guild_id: "800000000000000555" }),
  });
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 4,
    d: message({ author: { id: BOT, username: "ryph", bot: true } }),
  });
  socket.deliver({ op: 0, t: "MESSAGE_CREATE", s: 5, d: message() });
  const got = await batch;
  assertEquals(got.updates.length, 1);
  const msg = got.updates[0].message;
  assert(msg !== null);
  // A mention at the top of a channel keys the thread it would start: its own id.
  assertEquals(msg.messageId, `${CHANNEL}:800000000000001000:800000000000001000`);
  assertEquals(msg.threadKey, `${CHANNEL}:800000000000001000`);
  assertEquals(msg.topic, null);
  assertEquals(msg.channel, { id: CHANNEL, name: "ops", visibility: "private" });
  assertEquals(msg.sender, { id: ALICE, name: "Alice H", isBot: false });
  assertEquals(msg.text, "look at the cache");
  assertEquals(msg.chatId, null);
  assertEquals(msg.direct, false);
  assertEquals(msg.mentionsBot, true);
  // The position is the session and the sequence the mention arrived under; drained, the batch
  // stands at the newest sequence seen.
  assertEquals(got.updates[0].position, {
    offset: 5,
    queueId: `sess-1 ${RESUME}`,
    lastMessageId: null,
  });
  assertEquals(got.position.offset, 5);
});

test("discord: a mention inside a thread is the thread's, its channel the parent", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets } = transportWith(api);
  const { socket, batch } = await polling(transport, sockets);
  open(socket);
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: message({
      id: "800000000000001001",
      channel_id: THREAD,
      // A reply to the bot with the ping turned off names nobody, and is still addressed to it.
      content: `also check <@${ALICE}>'s logs`,
      mentions: [{ id: ALICE, username: "alice", member: { nick: "Al" } }],
      referenced_message: { author: { id: BOT } },
      member: { nick: "Alice (ops)" },
    }),
  });
  const msg = (await batch).updates[0].message;
  assert(msg !== null);
  assertEquals(msg.threadKey, `${CHANNEL}:${THREAD}`);
  assertEquals(msg.messageId, `${CHANNEL}:${THREAD}:800000000000001001`);
  assertEquals(msg.topic, "cache is cold");
  assertEquals(msg.channel.id, CHANNEL, "the parent channel");
  assertEquals(msg.sender?.name, "Alice (ops)", "the server nickname first");
  assertEquals(msg.text, "also check @Al's logs");
  // A thread never leaves its parent: located from the key, with no call.
  const before = api.calls.length;
  assertEquals(await transport.locate(ROOM, msg.messageId), {
    channel: { id: CHANNEL, name: "" },
    topic: THREAD,
  });
  assertEquals(await transport.locate(ROOM, msg.threadKey), {
    channel: { id: CHANNEL, name: "" },
    topic: THREAD,
  });
  assertEquals(api.calls.length, before);
});

test("discord: forums, vanished channels and failing reads", async () => {
  const api = fakeApi(baseRoutes({
    [`GET /channels/${FORUM}`]: { id: FORUM, type: 15, name: "help" },
    "GET /channels/800000000000000040": thread("800000000000000040", FORUM),
    "GET /channels/800000000000000050": refuse(403, 50001, "Missing Access"),
  }));
  const { transport, sockets } = transportWith(api);
  const { socket, batch } = await polling(transport, sockets);
  open(socket);
  // A forum post's thread is not a channel anything could be started from; a channel the bot
  // lost sight of serves nothing. Both are dropped — as null updates, so the cursor moves.
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: message({ id: "800000000000001002", channel_id: "800000000000000040" }),
  });
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 3,
    d: message({ id: "800000000000001003", channel_id: "800000000000000050" }),
  });
  const got = await batch;
  assertEquals(got.updates.map((u) => u.message), [null, null]);
  assertEquals(got.updates.map((u) => u.position.offset), [2, 3]);

  // A channel Discord could not describe right now fails the poll, and the mention keeps its
  // place for the next one.
  let down = true;
  const flaky = fakeApi(baseRoutes({
    [`GET /channels/${CHANNEL}`]: () =>
      down ? refuse(500, 0, "Internal Server Error") : textChannel(CHANNEL, false),
  }));
  const second = transportWith(flaky);
  const held = await polling(second.transport, second.sockets);
  open(held.socket);
  held.socket.deliver({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message() });
  await assertRejects(() => held.batch, DiscordError, "answered 500");
  down = false;
  const retried = await second.transport.poll(ROOM, {
    position: null,
    timeoutS: 0,
    signal: nothing,
  });
  assertEquals(retried.updates.length, 1);
  assertEquals(retried.updates[0].message?.channel.visibility, "public");
});

test("discord: a dropped socket resumes the session; RECONNECT and a zombie do too", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets } = transportWith(api);
  const first = await polling(transport, sockets, { timeoutS: 0.05 });
  open(first.socket);
  first.socket.deliver({ op: 0, t: "GUILD_CREATE", s: 7, d: {} });
  await first.batch;
  // The network drops the connection: the next poll resumes on the URL READY named, from the
  // last sequence, without asking for the Gateway's address again.
  first.socket.end(1006, "gone");
  const gatewayAsks = api.calls.filter((c) => c.path === "/gateway/bot").length;
  const second = await polling(transport, sockets, { timeoutS: 0.05 });
  assertEquals(second.socket.url, `${RESUME}/?v=10&encoding=json`);
  second.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(second.socket.sent[0], {
    op: 6,
    d: { token: TOKEN, session_id: "sess-1", seq: 7 },
  });
  // Discord replays what was missed under the old session.
  second.socket.deliver({ op: 0, t: "RESUMED", s: 8, d: {} });
  second.socket.deliver({ op: 0, t: "MESSAGE_CREATE", s: 9, d: message() });
  assertEquals((await second.batch).updates.length, 1);
  assertEquals(api.calls.filter((c) => c.path === "/gateway/bot").length, gatewayAsks);

  // RECONNECT: Discord moves the connection. Closed resumably, and resumed.
  const third = await polling(transport, sockets, { timeoutS: 0.2 });
  third.socket.deliver({ op: 7, d: null });
  await third.batch;
  assertEquals(third.socket.closedWith, 4000, "anything but 1000 keeps the session");
  const fourth = await polling(transport, sockets, { timeoutS: 0.2 });
  fourth.socket.deliver({ op: 10, d: { heartbeat_interval: 20 } });
  assertEquals(fourth.socket.sent[0].op, 6);
  // A zombie: the beat goes unacknowledged, so the next one closes the socket instead.
  await fourth.batch;
  assertEquals(fourth.socket.sent.filter((f) => f.op === 1).length, 1);
  assertEquals(fourth.socket.closedWith, 4000);
  const fifth = await polling(transport, sockets, { timeoutS: 0.05 });
  fifth.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(fifth.socket.sent[0].op, 6, "resumed, not identified");
  await fifth.batch;
});

test("discord: an invalidated session identifies afresh — but not twice in quick succession", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets, advance } = transportWith(api);
  const first = await polling(transport, sockets, { timeoutS: 0.05 });
  open(first.socket);
  first.socket.deliver({ op: 9, d: false });
  await first.batch;
  // Discord resets a token that identifies a thousand times a day, so a room that just did is
  // held back, loudly, and the poller's own backoff takes it from there.
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0.05, signal: nothing }),
    Error,
    "the next identify waits",
  );
  advance(90_000);
  const second = await polling(transport, sockets, { timeoutS: 0.05 });
  second.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(second.socket.sent[0].op, 2, "identified, the old session forgotten");
  await second.batch;
});

test("discord: a close no reconnect fixes is thrown, readable, and not redialled", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets, advance } = transportWith(api);
  const first = await polling(transport, sockets);
  first.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  first.socket.end(4014, "Disallowed intent(s).");
  const err = await assertRejects(() => first.batch, DiscordError);
  assert(err.message.includes("closed 4014"), err.message);
  assert(err.message.includes("Message Content Intent"), err.message);
  assert(!err.message.includes(TOKEN));
  // Polled again, it throws the same without dialling: a misconfigured bot is not a reconnect
  // storm.
  const dialled = sockets.length;
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(sockets.length, dialled);
  // Not for a while, either: held until the room changes, however long it waits.
  advance(24 * 60 * 60_000);
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(sockets.length, dialled);
  // Let go of — archived, or re-added with a fixed bot — it is dialled again when polled.
  transport.releaseAllBut(new Set());
  const again = await polling(transport, sockets, { timeoutS: 0.05 });
  assertEquals(sockets.length, dialled + 1);
  again.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  await again.batch;

  // A refused token says so, too.
  const second = transportWith(fakeApi(baseRoutes()));
  const held = await polling(second.transport, second.sockets);
  held.socket.end(4004, "Authentication failed.");
  const refused = await assertRejects(() => held.batch, DiscordError, "the bot token was refused");
  assert(
    refused.message.endsWith("then archive this room and add it again with the new token"),
    refused.message,
  );
});

test("discord: a 4014 hold lifts once the intent is on; a 4004 one stays", async () => {
  let flags = 0;
  const api = fakeApi(baseRoutes({ "GET /applications/@me": () => ({ flags }) }));
  const { transport, sockets, advance } = transportWith(api);
  const appReads = () => api.calls.filter((c) => c.path === "/applications/@me").length;
  const first = await polling(transport, sockets);
  first.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  first.socket.end(4014, "Disallowed intent(s).");
  const err = await assertRejects(() => first.batch, DiscordError, "closed 4014");
  assert(err.message.endsWith("the room listens again once it is on"), err.message);
  // Held, and the flags not asked again before five minutes.
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(appReads(), 0);
  // Five minutes on, still off: asked once, still held, nothing dialled.
  advance(5 * 60_000);
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(appReads(), 1);
  assertEquals(sockets.length, 1);
  // Not again until the next five minutes.
  advance(60_000);
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(appReads(), 1);
  // Switched on in the developer portal (an unverified app's flag): the hold lifts, and the
  // room identifies afresh — the Gateway asked first, so the budget's floor still holds.
  flags = 1 << 19;
  advance(5 * 60_000);
  const gatewayAsks = api.calls.filter((c) => c.path === "/gateway/bot").length;
  const back = await polling(transport, sockets, { timeoutS: 0.05 });
  assertEquals(appReads(), 2);
  assertEquals(sockets.length, 2);
  assertEquals(api.calls.filter((c) => c.path === "/gateway/bot").length, gatewayAsks + 1);
  open(back.socket);
  assertEquals(back.socket.sent[0].op, 2, "IDENTIFY, not a resume");
  await back.batch;

  // A refused token stays held however long it waits: only a new room or a restart clears it.
  const other = transportWith(fakeApi(baseRoutes({ "GET /applications/@me": { flags: 1 << 18 } })));
  const held = await polling(other.transport, other.sockets);
  held.socket.end(4004, "Authentication failed.");
  await assertRejects(() => held.batch, DiscordError, "closed 4004");
  other.advance(24 * 60 * 60_000);
  await assertRejects(
    () => other.transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4004",
  );
  assertEquals(other.sockets.length, 1);
});

test("discord: a 4014 on a resume holds too, and a lifted room refused again is held again", async () => {
  const api = fakeApi(baseRoutes({ "GET /applications/@me": { flags: 1 << 18 } }));
  const { transport, sockets, advance } = transportWith(api);
  // The 4014 lands on a resume: the session is forgotten with it.
  const first = await polling(transport, sockets, { timeoutS: 0.05 });
  open(first.socket);
  await first.batch;
  first.socket.end(1006);
  const resumed = await polling(transport, sockets);
  resumed.socket.end(4014, "Disallowed intent(s).");
  await assertRejects(() => resumed.batch, DiscordError, "closed 4014");
  // The flags say on at the first recheck: an IDENTIFY, the old session gone.
  advance(5 * 60_000);
  const back = await polling(transport, sockets, { timeoutS: 0.05 });
  back.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(back.socket.sent[0].op, 2);
  // Another 4014 at once: held again, and the next lift waits its own five minutes.
  back.socket.end(4014, "Disallowed intent(s).");
  await assertRejects(() => back.batch, DiscordError, "closed 4014");
  advance(60_000);
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    DiscordError,
    "closed 4014",
  );
  assertEquals(sockets.length, 3);
});

test("discord: every fatal close says how the room comes back", async () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const { transport, sockets } = transportWith(fakeApi(baseRoutes()));
    const { socket, batch } = await polling(transport, sockets);
    socket.end(code);
    const err = await assertRejects(() => batch, DiscordError);
    assert(
      /archive this room and add it again|restart ryph|listens again once it is on/.test(
        err.message,
      ),
      err.message,
    );
  }
});

test("discord: a dial that throws leaves the room to dial again, not deaf", async () => {
  const api = fakeApi(baseRoutes());
  const dialer = fakeDialer();
  let refuseDial = true;
  const transport = discordTransport({
    apiUrl: API,
    fetch: api.fetcher,
    dial: (url, handlers) => {
      if (refuseDial) throw new Error("no sockets today");
      return dialer.dial(url, handlers);
    },
    jitter: () => 0.5,
    now: () => 1_000_000,
  });
  opened.push(transport);
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0.05, signal: nothing }),
    Error,
    "no sockets today",
  );
  // The next poll dials again rather than holding on a connection with no socket. No IDENTIFY
  // was sent, so the identify gap does not stand in the way.
  refuseDial = false;
  const { socket, batch } = await polling(transport, dialer.sockets, { timeoutS: 0.05 });
  assertEquals(dialer.sockets.length, 1);
  open(socket);
  assertEquals(socket.sent[0].op, 2);
  await batch;
});

test("discord: a role mention heard while the roles read failed is delivered once it succeeds", async () => {
  let rolesUp = false;
  const api = fakeApi(baseRoutes({
    [`GET /guilds/${GUILD}/roles`]: () =>
      rolesUp
        ? [
          { id: GUILD, name: "@everyone" },
          { id: "800000000000000201", name: "sre" },
          { id: ROLE, name: "ryph", managed: true, tags: { bot_id: BOT } },
        ]
        : refuse(500, 0, "Internal Server Error"),
  }));
  const { transport, sockets, advance } = transportWith(api);
  const roleReads = () => api.calls.filter((c) => c.path === `/guilds/${GUILD}/roles`).length;
  const first = await polling(transport, sockets, { timeoutS: 0.1 });
  open(first.socket);
  assertEquals(roleReads(), 1, "asked at the dial, and refused");
  const event = (s: number, d: unknown) =>
    first.socket.deliver({ op: 0, t: "MESSAGE_CREATE", s, d });
  event(
    2,
    message({
      id: "800000000000001010",
      content: `<@&${ROLE}> look at the cache`,
      mentions: [],
      mention_roles: [ROLE],
    }),
  );
  event(
    3,
    message({
      id: "800000000000001012",
      content: "<@&800000000000000201> hi",
      mentions: [],
      mention_roles: ["800000000000000201"],
    }),
  );
  // A plain mention of the bot is not held up by the unknown role.
  event(4, message({ id: "800000000000001020" }));
  const got = await first.batch;
  assertEquals(got.updates.map((u) => u.message?.messageId), [
    `${CHANNEL}:800000000000001020:800000000000001020`,
  ]);
  // Within the cooldown the roles are not asked again.
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(roleReads(), 1);
  // A minute on, they are — and answer: the bot's role's mention is delivered, its words
  // stripped of it, and the other role's is dropped.
  rolesUp = true;
  advance(60_000);
  const later = await transport.poll(ROOM, { position: null, timeoutS: 5, signal: nothing });
  assertEquals(roleReads(), 2);
  assertEquals(later.updates.length, 1);
  assertEquals(later.updates[0].message?.text, "look at the cache");
  assertEquals(later.updates[0].message?.threadKey, `${CHANNEL}:800000000000001010`);
  // Handed at where the batch settles, never behind a cursor already past it.
  assertEquals(later.updates[0].position, later.position);
  assertEquals(later.position.offset, 4);
  // Nothing left to decide.
  const after = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(after.updates, []);
});

test("discord: retract deletes the post a send answered", async () => {
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${CHANNEL}/messages`]: { id: "800000000000002000", channel_id: CHANNEL },
    [`POST /channels/${CHANNEL}/messages/800000000000002000/threads`]: { id: "800000000000002000" },
    [`DELETE /channels/${CHANNEL}/messages/800000000000002000`]: null,
    [`DELETE /channels/${THREAD}/messages/800000000000002005`]: null,
  });
  const { transport } = transportWith(api);
  assert(transport.retract !== undefined);
  // An opening post's key is two parts, `<channel>:<post>`: the post sits in the channel.
  const key = await transport.send(ROOM, transport.openTarget(CHANNEL, "nightly")!, "on it");
  assertEquals(key, `${CHANNEL}:800000000000002000`);
  await transport.retract(ROOM, key);
  const deletes = () =>
    api.calls.filter((c) => c.method === "DELETE").map((c) => `${c.method} ${c.path}`);
  assertEquals(deletes(), [`DELETE /channels/${CHANNEL}/messages/800000000000002000`]);
  // A three-part address names a message inside a thread: deleted there.
  await transport.retract(ROOM, `${CHANNEL}:${THREAD}:800000000000002005`);
  assertEquals(deletes().at(-1), `DELETE /channels/${THREAD}/messages/800000000000002005`);
  // Not a key at all: nothing is asked.
  await transport.retract(ROOM, "C0123:1700000000.000100");
  assertEquals(deletes().length, 2);
});

test("discord: a persisted session is resumed by the next process", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets } = transportWith(api);
  const position = { offset: 42, queueId: `sess-9 ${RESUME}`, lastMessageId: null };
  const { socket, batch } = await polling(transport, sockets, { position, timeoutS: 0.05 });
  assertEquals(socket.url, `${RESUME}/?v=10&encoding=json`);
  socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(socket.sent[0], { op: 6, d: { token: TOKEN, session_id: "sess-9", seq: 42 } });
  await batch;
  assertEquals(api.calls.some((c) => c.path === "/gateway/bot"), false);

  // A cursor row edited to name another host is not where the token goes: the session is
  // ignored, and the Gateway Discord names is dialled instead.
  const other = transportWith(fakeApi(baseRoutes()));
  const forged = { offset: 42, queueId: "sess-9 wss://evil.test", lastMessageId: null };
  const dialled = await polling(other.transport, other.sockets, {
    position: forged,
    timeoutS: 0.05,
  });
  assertEquals(dialled.socket.url, `${GATEWAY}/?v=10&encoding=json`);
  dialled.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(dialled.socket.sent[0].op, 2);
  await dialled.batch;
});

test("discord: a post at the channel opens a named thread; every post pings nobody", async () => {
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`POST /channels/${CHANNEL}/messages`]: { id: "800000000000002000", channel_id: CHANNEL },
    [`POST /channels/${CHANNEL}/messages/800000000000002000/threads`]: { id: "800000000000002000" },
    "POST /channels/800000000000002000/messages": { id: "800000000000002001" },
  });
  const { transport } = transportWith(api);
  const key = await transport.send(
    ROOM,
    transport.openTarget(CHANNEL, "nightly · 2026-10-28")!,
    "🚀 **nightly** — **Ada** is on it.",
  );
  // The post is the key; its thread took its id, named as the response asked.
  assertEquals(key, `${CHANNEL}:800000000000002000`);
  const started = api.calls.find((c) => c.path.endsWith("/threads"));
  assertEquals(started?.json, { name: "nightly · 2026-10-28" });
  // Into the thread from then on, answering the same key.
  assertEquals(
    await transport.send(ROOM, { channelId: CHANNEL, topic: "800000000000002000" }, "more"),
    `${CHANNEL}:800000000000002000`,
  );
  for (const call of api.calls.filter((c) => c.path.endsWith("/messages"))) {
    assertEquals(call.json?.allowed_mentions, { parse: [] });
    assertEquals(call.json?.flags, 4, "no link previews");
  }

  // A thread that would not start leaves no post claiming a run is on it.
  const failing = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`POST /channels/${CHANNEL}/messages`]: { id: "800000000000002002" },
    [`POST /channels/${CHANNEL}/messages/800000000000002002/threads`]: refuse(
      403,
      50013,
      "Missing Permissions",
    ),
    [`DELETE /channels/${CHANNEL}/messages/800000000000002002`]: null,
  });
  const second = transportWith(failing);
  await assertRejects(
    () => second.transport.send(ROOM, second.transport.openTarget(CHANNEL, "x")!, "hi"),
    DiscordError,
    "Missing Permissions",
  );
  assert(failing.calls.some((c) => c.method === "DELETE"));
});

test("discord: a mention's thread is started by the first post that needs it", async () => {
  const top = "800000000000003000";
  let threadExists = false;
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`POST /channels/${top}/messages`]: () =>
      threadExists ? { id: "800000000000003001" } : refuse(404, 10003, "Unknown Channel"),
    [`GET /channels/${CHANNEL}/messages/${top}`]: message({
      id: top,
      content: `<@${BOT}>   why is   the cache\ncold?`,
    }),
    [`POST /channels/${CHANNEL}/messages/${top}/threads`]: () => {
      threadExists = true;
      return { id: top };
    },
  });
  const { transport } = transportWith(api);
  const key = await transport.send(ROOM, { channelId: CHANNEL, topic: top }, "on it");
  assertEquals(key, `${CHANNEL}:${top}`);
  // Named after the mention's own words, the bot's name gone, on one line.
  assertEquals(
    api.calls.find((c) => c.path.endsWith("/threads"))?.json,
    { name: "why is the cache cold?" },
  );
  // Asked whether it is a thread yet (no such channel), started, and posted into — once.
  assertEquals(api.calls.filter((c) => c.path === `/channels/${top}/messages`).length, 1);
  assertEquals(threadExists, true);

  // Started by someone else in the meantime: used as it is.
  let raced = false;
  const race = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`POST /channels/${top}/messages`]: () =>
      raced ? { id: "800000000000003002" } : refuse(404, 10003, "Unknown Channel"),
    [`GET /channels/${CHANNEL}/messages/${top}`]: message({ id: top, content: `<@${BOT}>` }),
    [`POST /channels/${CHANNEL}/messages/${top}/threads`]: () => {
      raced = true;
      return refuse(400, 160004, "A thread has already been created for this message");
    },
  });
  const second = transportWith(race);
  assertEquals(
    await second.transport.send(ROOM, { channelId: CHANNEL, topic: top }, "on it"),
    `${CHANNEL}:${top}`,
  );

  // The mention was deleted: nothing left to hang the conversation from.
  const gone = transportWith(fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${CHANNEL}/messages/${top}`]: refuse(404, 10008, "Unknown Message"),
  }));
  await assertRejects(
    () => gone.transport.send(ROOM, { channelId: CHANNEL, topic: top }, "on it"),
    DiscordError,
    "starts from is gone",
  );

  // A locked thread is named for what it is.
  const locked = transportWith(fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: refuse(400, 50083, "Thread is archived"),
  }));
  await assertRejects(
    () => locked.transport.send(ROOM, { channelId: CHANNEL, topic: THREAD }, "on it"),
    DiscordThreadLockedError,
    "archived and locked",
  );
});

test("discord: a 429 is waited out, a bounded number of times", async () => {
  let refusals = 2;
  const api = fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: () =>
      refusals-- > 0
        ? Response.json({ message: "slow down", retry_after: 0.01, global: false }, {
          status: 429,
        })
        : { id: "800000000000004000" },
  });
  const { transport } = transportWith(api);
  await transport.send(ROOM, { channelId: CHANNEL, topic: THREAD }, "hi");
  assertEquals(api.calls.filter((c) => c.method === "POST").length, 3);

  // One that never lets up, or asks for longer than the adapter will wait, fails the call.
  const always = fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: () =>
      Response.json({ message: "slow down", retry_after: 0.01, global: true }, { status: 429 }),
  });
  const forever = transportWith(always);
  await assertRejects(
    () => forever.transport.send(ROOM, { channelId: CHANNEL, topic: THREAD }, "hi"),
    DiscordError,
    "rate limited globally",
  );
  assertEquals(always.calls.filter((c) => c.method === "POST").length, 3);
  const long = transportWith(fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: () =>
      Response.json({ message: "slow down", retry_after: 60 }, { status: 429 }),
  }));
  await assertRejects(
    () => long.transport.send(ROOM, { channelId: CHANNEL, topic: THREAD }, "hi"),
    DiscordError,
    "429",
  );
});

test("discord: roles are the groups; membership asked live, never a yes on failure", async () => {
  const api = fakeApi({
    [`GET /guilds/${GUILD}/roles`]: [
      { id: GUILD, name: "@everyone" },
      { id: "800000000000000201", name: "sre" },
      { id: "800000000000000202", name: "ryph", managed: true },
      { id: "800000000000000203", name: "admins" },
    ],
    [`GET /guilds/${GUILD}/members/${ALICE}`]: { roles: ["800000000000000201"] },
    [`GET /guilds/${GUILD}/members/800000000000000078`]: refuse(500, 0, "boom"),
  });
  const { transport } = transportWith(api);
  assertEquals(await transport.listGroups(ROOM), [
    { id: "800000000000000203", name: "@admins", description: "" },
    { id: "800000000000000201", name: "@sre", description: "" },
  ]);
  assertEquals(await transport.checkMembership(ROOM, "800000000000000201", ALICE), "allowed");
  assertEquals(await transport.checkMembership(ROOM, "800000000000000203", ALICE), "denied");
  assertEquals(
    await transport.checkMembership(ROOM, "800000000000000201", "800000000000000078"),
    "unknown",
  );
  assertEquals(await transport.checkMembership(ROOM, "S0SRE", ALICE), "unknown", "not an id");
});

test("discord: text and announcement channels, private when @everyone cannot view", async () => {
  const api = fakeApi({
    [`GET /guilds/${GUILD}/channels`]: [
      textChannel("800000000000000011", true),
      textChannel("800000000000000012", false),
      textChannel("800000000000000013", false, 5),
      { id: "800000000000000014", type: 2, name: "voice" },
      { id: "800000000000000015", type: 4, name: "category" },
      { id: FORUM, type: 15, name: "help" },
      // Another role denied, @everyone allowed: still public.
      {
        id: "800000000000000016",
        type: 0,
        name: "c16",
        permission_overwrites: [
          { id: "800000000000000201", type: 0, deny: "1024" },
          { id: GUILD, type: 0, allow: "1024", deny: "0" },
        ],
      },
    ],
  });
  const { transport } = transportWith(api);
  assertEquals(await transport.listChannels(ROOM), {
    channels: [
      { id: "800000000000000011", name: "c11", visibility: "private" },
      { id: "800000000000000012", name: "c12", visibility: "public" },
      { id: "800000000000000013", name: "c13", visibility: "public" },
      { id: "800000000000000016", name: "c16", visibility: "public" },
    ],
    truncated: false,
  });
});

test("discord: a mention's images, fetched without the token", async () => {
  const api = fakeApi(baseRoutes());
  const downloads: Array<{ url: string; auth: string | null }> = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.discordapp.com/")) {
      downloads.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Promise.resolve(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          headers: { "content-type": "image/png" },
        }),
      );
    }
    return api.fetcher(input, init);
  }) as typeof fetch;
  const { transport, sockets } = transportWith(api, { fetch: fetcher });
  const { socket, batch } = await polling(transport, sockets);
  open(socket);
  const png = "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1&is=2&hm=3";
  socket.deliver({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: message({
      attachments: [
        { filename: "shot.png", size: 4, url: png, content_type: "image/png" },
        {
          filename: "log.txt",
          size: 9,
          url: "https://cdn.discordapp.com/x/log.txt",
          content_type: "text/plain",
        },
        {
          filename: "evil.png",
          size: 4,
          url: "https://evil.test/e.png",
          content_type: "image/png",
        },
      ],
    }),
  });
  const msg = (await batch).updates[0].message;
  assert(msg !== null);
  assertEquals(msg.hasAttachment, true);
  assertEquals(msg.images, [{
    at: null,
    label: null,
    size: 4,
    ref: { kind: "discord", url: png },
  }]);
  const got = await transport.downloadImage(ROOM, msg.images[0], {
    maxBytes: 1024,
    signal: nothing,
  });
  assertEquals(got.kind, "bytes");
  assertEquals(downloads, [{ url: png, auth: null }]);
  // Anything not on Discord's CDN is not fetched.
  assertEquals(
    (await transport.downloadImage(ROOM, {
      at: null,
      label: null,
      size: 4,
      ref: { kind: "discord", url: "https://evil.test/e.png" },
    }, { maxBytes: 1024, signal: nothing })).kind,
    "failed",
  );
  // Nor is Discord's CDN host on a port of someone's choosing.
  assertEquals(
    (await transport.downloadImage(ROOM, {
      at: null,
      label: null,
      size: 4,
      ref: { kind: "discord", url: "https://cdn.discordapp.com:8443/attachments/1/2/shot.png" },
    }, { maxBytes: 1024, signal: nothing })).kind,
    "failed",
  );
  assertEquals(downloads.length, 1);
});

test("discord: a run's images go up on one message; without Attach Files, as links", async () => {
  const api = fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: { id: "800000000000005000" },
  });
  const { transport } = transportWith(api);
  const image = (label: string, url: string | null = "https://app.test/images/r/a") => ({
    label,
    mime: "image/png",
    url,
    load: () => Promise.resolve(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>),
  });
  const failing = {
    ...image("broken"),
    load: () => Promise.reject(new Error("the control plane is down")),
  };
  const answers = await transport.sendImages(
    ROOM,
    { channelId: CHANNEL, topic: THREAD },
    [image("the dashboard"), failing, image("@everyone look")],
  );
  assertEquals(answers.map((a) => a.kind), ["uploaded", "failed", "uploaded"]);
  const form = api.calls.find((c) => c.form !== null)?.form ?? null;
  assert(form !== null);
  const payload = JSON.parse(String(form.get("payload_json")));
  assertEquals(payload.allowed_mentions, { parse: [] });
  assertEquals(payload.content, "the dashboard\n@​everyone look");
  assertEquals(payload.attachments, [
    { id: 0, filename: "image-1.png", description: "the dashboard" },
    { id: 1, filename: "image-3.png", description: "@everyone look" },
  ]);
  assert(form.get("files[0]") instanceof Blob);
  assert(form.get("files[1]") instanceof Blob);

  const refused = fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: (call: Call) =>
      call.form !== null ? refuse(403, 50013, "Missing Permissions") : { id: "800000000000005001" },
  });
  const second = transportWith(refused);
  const linked = await second.transport.sendImages(
    ROOM,
    { channelId: CHANNEL, topic: THREAD },
    [image("the [dashboard]"), image("no link", null)],
  );
  assertEquals(linked.map((a) => a.kind), ["linked", "failed"]);
  assertEquals(
    refused.calls.at(-1)?.json?.content,
    "[the dashboard](<https://app.test/images/r/a>)",
  );
});

test("discord: the eyes go on the message where it sits", async () => {
  const api = fakeApi({
    [`PUT /channels/${CHANNEL}/messages/800000000000001000/reactions/%F0%9F%91%80/@me`]: null,
    [`PUT /channels/${THREAD}/messages/800000000000001001/reactions/%F0%9F%91%80/@me`]: null,
  });
  const { transport } = transportWith(api);
  // A thread's starter sits in the parent; anything after it, in the thread.
  await transport.react(ROOM, `${CHANNEL}:800000000000001000:800000000000001000`);
  await transport.react(ROOM, `${CHANNEL}:${THREAD}:800000000000001001`);
  assertEquals(api.calls.map((c) => c.method), ["PUT", "PUT"]);
});

test("discord: a thread read is its starter and its messages, newest kept", async () => {
  const msg = (id: string, content: string, type = 0) =>
    message({ id, content, type, channel_id: THREAD, mentions: [] });
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${THREAD}`]: thread(),
    [`GET /channels/${CHANNEL}/messages/${THREAD}`]: message({
      id: THREAD,
      content: `<@${BOT}> the cache is cold`,
    }),
    // Newest first, as Discord pages them.
    [`GET /channels/${THREAD}/messages`]: [
      msg("800000000000001003", "and now?"),
      msg("800000000000001002", "", 18),
      msg("800000000000001001", "since 9am"),
    ],
  });
  const { transport } = transportWith(api);
  const read = await transport.fetchThread(ROOM, `${CHANNEL}:${THREAD}`);
  assert(read !== null);
  assertEquals(read.topic, "cache is cold");
  assertEquals(read.channel, { id: CHANNEL, name: "ops", visibility: "private" });
  assertEquals(read.historyLimited, false);
  assertEquals(read.truncated, false);
  // The ids are the inbound form, so the mention is found among them.
  assertEquals(read.messages.map((m) => [m.id, m.text]), [
    [`${CHANNEL}:${THREAD}:${THREAD}`, "@ryph the cache is cold"],
    [`${CHANNEL}:${THREAD}:800000000000001001`, "since 9am"],
    [`${CHANNEL}:${THREAD}:800000000000001003`, "and now?"],
  ]);
  assertEquals(read.messages[0].sentAt, "2026-10-28T10:00:00.000000+00:00");
  assert(api.calls.some((c) => c.path === `/channels/${THREAD}/messages?limit=100`));

  // A mention at the top of a channel whose thread nobody started yet is that message alone.
  const lone = transportWith(fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${CHANNEL}/messages/800000000000001000`]: message(),
  }));
  const alone = await lone.transport.fetchThread(ROOM, `${CHANNEL}:800000000000001000`);
  assertEquals(alone?.topic, null);
  assertEquals(alone?.messages.length, 1);
  // Gone altogether: null, the port's "gone".
  const none = transportWith(fakeApi({ [`GET /channels/${CHANNEL}`]: textChannel() }));
  assertEquals(await none.transport.fetchThread(ROOM, `${CHANNEL}:800000000000001000`), null);
  assertEquals(await none.transport.fetchThread(ROOM, "C0OPS:1.2"), null);
});

test("discord: a long thread keeps its newest and says it is cut", async () => {
  let page = 0;
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${THREAD}`]: thread(),
    [`GET /channels/${CHANNEL}/messages/${THREAD}`]: refuse(404, 10008, "Unknown Message"),
    [`GET /channels/${THREAD}/messages`]: () => {
      // Snowflakes past 2^53: computed as big integers, as everything here must.
      const base = 800000000000900000n - BigInt(page * 100);
      page++;
      return Array.from({ length: 100 }, (_, i) => ({
        ...message({ channel_id: THREAD, mentions: [], content: "x" }),
        id: String(base - BigInt(i)),
      }));
    },
  });
  const { transport } = transportWith(api);
  const read = await transport.fetchThread(ROOM, `${CHANNEL}:${THREAD}`);
  assertEquals(read?.messages.length, 200);
  assertEquals(read?.truncated, true);
  assertEquals(read?.messages.at(-1)?.id, `${CHANNEL}:${THREAD}:800000000000900000`, "the newest");
  assert(api.calls.some((c) => c.path.includes("&before=")));
});

test("discord: INVALID_SESSION that may resume resumes; 4007 and 4009 identify afresh", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets, advance } = transportWith(api);
  const first = await polling(transport, sockets, { timeoutS: 0.05 });
  open(first.socket);
  first.socket.deliver({ op: 0, t: "GUILD_CREATE", s: 3, d: {} });
  // `d: true`: the session is still good, and the next connection resumes it.
  first.socket.deliver({ op: 9, d: true });
  await first.batch;
  assertEquals(first.socket.closedWith, 4000);
  const second = await polling(transport, sockets, { timeoutS: 0.05 });
  assertEquals(second.socket.url, `${RESUME}/?v=10&encoding=json`);
  second.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(second.socket.sent[0], {
    op: 6,
    d: { token: TOKEN, session_id: "sess-1", seq: 3 },
  });
  second.socket.deliver({ op: 0, t: "RESUMED", s: 4, d: {} });
  await second.batch;

  // An invalid sequence (4007) or a timed-out session (4009) ends it: the next one identifies.
  let last = second.socket;
  for (const code of [4007, 4009]) {
    last.end(code);
    advance(90_000);
    const next = await polling(transport, sockets, { timeoutS: 0.05 });
    assertEquals(next.socket.url, `${GATEWAY}/?v=10&encoding=json`, `after ${code}`);
    open(next.socket);
    assertEquals(next.socket.sent[0].op, 2, `identified after ${code}`);
    await next.batch;
    last = next.socket;
  }
});

test("discord: a resume that never answers falls back to identify; a run of them is thrown", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets, advance } = transportWith(api);
  const first = await polling(transport, sockets, { timeoutS: 0.05 });
  open(first.socket);
  await first.batch;
  first.socket.end(1006);
  // The resume URL READY named went dead: every dial there ends before HELLO.
  for (let i = 0; i < 3; i++) {
    const tried = await polling(transport, sockets);
    assertEquals(tried.socket.url, `${RESUME}/?v=10&encoding=json`);
    tried.socket.end(1006, "unreachable");
    assertEquals((await tried.batch).position.queueId, `sess-1 ${RESUME}`, "still tried");
  }
  // Three in a row: the session is forgotten, the Gateway asked for afresh, and identified.
  advance(90_000);
  const fresh = await polling(transport, sockets);
  assertEquals(fresh.socket.url, `${GATEWAY}/?v=10&encoding=json`);
  fresh.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(fresh.socket.sent[0].op, 2);
  fresh.socket.end(1006, "unreachable");
  // The cursor saved after it no longer names the dead session.
  assertEquals((await fresh.batch).position, { offset: 0, queueId: null, lastMessageId: null });
  // Five dials in a row with no handshake: the poll throws, so the poller logs it.
  advance(90_000);
  const fifth = await polling(transport, sockets);
  fifth.socket.end(1006, "unreachable");
  const loud = await assertRejects(() => fifth.batch, Error);
  // The same words on every failure, so the poller warns once; how the last ended is the cause.
  assertEquals(
    loud.message,
    "discord: the Gateway has not completed a handshake in 5 or more dials in a row",
  );
  assertEquals(loud.cause, "closed 1006 (unreachable)");
  // A handshake ends the run.
  advance(90_000);
  const sixth = await polling(transport, sockets, { timeoutS: 0.05 });
  open(sixth.socket);
  await sixth.batch;
  sixth.socket.end(1006);
  const seventh = await polling(transport, sockets);
  seventh.socket.end(1006);
  await seventh.batch;
});

test("discord: a socket silent in its handshake is closed", async () => {
  const api = fakeApi(baseRoutes());
  const { transport, sockets, advance } = transportWith(api, { handshakeTimeoutMs: 30 });
  // No HELLO at all: closed when the time runs out, and the poll that held on it returns.
  const silent = await polling(transport, sockets, { timeoutS: 5 });
  await silent.batch;
  assertEquals(silent.socket.closedWith, 4000);
  assertEquals(silent.socket.sent, []);
  // HELLO, then nothing after the IDENTIFY: closed too.
  const mute = await polling(transport, sockets, { timeoutS: 5 });
  mute.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  assertEquals(mute.socket.sent[0].op, 2);
  await mute.batch;
  assertEquals(mute.socket.closedWith, 4000);
  // A whole handshake is kept past the deadline.
  advance(90_000);
  const fine = await polling(transport, sockets, { timeoutS: 0.1 });
  open(fine.socket);
  await fine.batch;
  assertEquals(fine.socket.closedWith, null);
});

test("discord: a mention carried to a new session keeps the position it arrived at", async () => {
  let down = true;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const api = fakeApi(baseRoutes({
    [`GET /channels/${CHANNEL}`]: () => down ? refuse(500, 0, "boom") : textChannel(),
  }));
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!down && String(input).endsWith(`/channels/${CHANNEL}`)) await gate;
    return await api.fetcher(input, init);
  }) as typeof fetch;
  const { transport, sockets, advance } = transportWith(api, { fetch: fetcher });
  const first = await polling(transport, sockets);
  open(first.socket);
  first.socket.deliver({ op: 0, t: "MESSAGE_CREATE", s: 2, d: message() });
  await assertRejects(() => first.batch, DiscordError, "answered 500");
  // The session ends while the mention waits; the next connection identifies a new one.
  first.socket.deliver({ op: 9, d: false });
  advance(90_000);
  down = false;
  const second = await polling(transport, sockets);
  second.socket.deliver({ op: 10, d: { heartbeat_interval: 41_250 } });
  second.socket.deliver({
    op: 0,
    t: "READY",
    s: 1,
    d: { session_id: "sess-2", resume_gateway_url: RESUME },
  });
  // READY is in before the carried mention is drained.
  release();
  const got = await second.batch;
  assertEquals(got.updates.length, 1);
  // Its own session and sequence — never the new session's id beside the old one's number.
  assertEquals(got.updates[0].position, {
    offset: 2,
    queueId: `sess-1 ${RESUME}`,
    lastMessageId: null,
  });
  assertEquals(got.position, { offset: 1, queueId: `sess-2 ${RESUME}`, lastMessageId: null });
});

test("discord: letting a room go, or draining, closes its socket; an aborted poll dials nothing", async () => {
  const { transport, sockets } = transportWith(fakeApi(baseRoutes()));
  const held = await polling(transport, sockets, { timeoutS: 0.05 });
  open(held.socket);
  await held.batch;
  transport.releaseAllBut(new Set([ROOM.id]));
  assertEquals(held.socket.closedWith, null, "still polled, still open");
  transport.releaseAllBut(new Set());
  assertEquals(held.socket.closedWith, 4000, "closed, resumably");

  const drain = new AbortController();
  const second = transportWith(fakeApi(baseRoutes()));
  const draining = await polling(second.transport, second.sockets, {
    timeoutS: 5,
    signal: drain.signal,
  });
  open(draining.socket);
  drain.abort();
  await draining.batch;
  assertEquals(draining.socket.closedWith, 4000);

  // Aborted already, or while the Gateway's address was being asked: nothing is opened.
  const third = transportWith(fakeApi(baseRoutes()));
  await assertRejects(() =>
    third.transport.poll(ROOM, { position: null, timeoutS: 0, signal: drain.signal })
  );
  const late = new AbortController();
  const fourth = transportWith(fakeApi(baseRoutes({
    "GET /gateway/bot": () => {
      late.abort(new Error("draining"));
      return { url: GATEWAY };
    },
  })));
  await assertRejects(
    () => fourth.transport.poll(ROOM, { position: null, timeoutS: 0, signal: late.signal }),
    Error,
    "draining",
  );
  assertEquals(third.sockets.length + fourth.sockets.length, 0);
});

test("discord: an identify budget run low is not spent", async () => {
  let budget = 12;
  const api = fakeApi(baseRoutes({
    "GET /gateway/bot": () => ({
      url: GATEWAY,
      session_start_limit: { total: 1000, remaining: budget, reset_after: 3_600_000 },
    }),
  }));
  const { transport, sockets, advance } = transportWith(api);
  const asks = () => api.calls.filter((c) => c.path === "/gateway/bot").length;
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    Error,
    "12 Gateway identifies left today",
  );
  assertEquals(sockets.length, 0);
  // Held until Discord's count resets: not asked again on every tick meanwhile.
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    Error,
    "in 60 min",
  );
  assertEquals(asks(), 1);
  advance(3_600_000);
  budget = 1000;
  const fine = await polling(transport, sockets, { timeoutS: 0.05 });
  open(fine.socket);
  assertEquals(fine.socket.sent[0].op, 2);
  await fine.batch;
});

test("discord: the bot's role is a mention of it; a Reply to its post is that post's thread", async () => {
  const opening = "800000000000002000";
  const reply = "800000000000001011";
  const api = fakeApi(baseRoutes({
    [`GET /guilds/${GUILD}/roles`]: [
      { id: GUILD, name: "@everyone" },
      { id: "800000000000000201", name: "sre" },
      { id: ROLE, name: "ryph", managed: true, tags: { bot_id: BOT } },
    ],
    [`PUT /channels/${CHANNEL}/messages/${reply}/reactions/%F0%9F%91%80/@me`]: null,
  }));
  const { transport, sockets } = transportWith(api);
  const { socket, batch } = await polling(transport, sockets);
  open(socket);
  const event = (s: number, d: unknown) => socket.deliver({ op: 0, t: "MESSAGE_CREATE", s, d });
  // Its managed role, as Discord's @-autocomplete offers it: a mention, stripped like the bot's.
  event(
    2,
    message({
      id: "800000000000001010",
      content: `<@&${ROLE}> look at the cache`,
      mentions: [],
      mention_roles: [ROLE],
    }),
  );
  // Another role is not the bot.
  event(
    3,
    message({
      id: "800000000000001012",
      content: "<@&800000000000000201> hi",
      mentions: [],
      mention_roles: ["800000000000000201"],
    }),
  );
  // Discord talking about the channel — a thread made from the bot's post — addresses nobody.
  event(
    4,
    message({
      id: "800000000000001013",
      type: 18,
      content: "",
      mentions: [],
      referenced_message: { author: { id: BOT } },
    }),
  );
  // A Reply at the top of the channel to the bot's opening post.
  event(
    5,
    message({
      id: reply,
      type: 19,
      content: "is it fixed?",
      mentions: [],
      message_reference: { message_id: opening, channel_id: CHANNEL },
      referenced_message: { author: { id: BOT } },
    }),
  );
  // A Reply to a person's post is theirs.
  event(
    6,
    message({
      id: "800000000000001014",
      type: 19,
      content: "agreed",
      mentions: [],
      message_reference: { message_id: "800000000000001000", channel_id: CHANNEL },
      referenced_message: { author: { id: ALICE } },
    }),
  );
  const got = await batch;
  assertEquals(got.updates.length, 2);
  const [byRole, byReply] = got.updates.map((u) => u.message);
  assertEquals(byRole?.text, "look at the cache");
  assertEquals(byRole?.threadKey, `${CHANNEL}:800000000000001010`);
  // The opening post's conversation — where the run it opened is bound — not a new one.
  assertEquals(byReply?.threadKey, `${CHANNEL}:${opening}`);
  assertEquals(byReply?.messageId, `${CHANNEL}:${opening}:${reply}`);
  assertEquals(await transport.locate(ROOM, byReply!.messageId), {
    channel: { id: CHANNEL, name: "" },
    topic: opening,
  });
  // Its 👀 goes where it sits: the parent, once the thread says it holds no such message.
  await transport.react(ROOM, byReply!.messageId);
  assertEquals(
    api.calls.filter((c) => c.method === "PUT").map((c) => c.path.split("/")[2]),
    [opening, CHANNEL],
  );
});

test("discord: nothing of another server is read or posted to, nor a thread of another channel", async () => {
  const foreign = "800000000000000060";
  const foreignThread = "800000000000000061";
  const elsewhere = "800000000000000062";
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${foreign}`]: { ...textChannel(foreign), guild_id: OTHER_GUILD },
    [`GET /channels/${foreignThread}`]: {
      ...thread(foreignThread, foreign),
      guild_id: OTHER_GUILD,
    },
    // This server's thread, but under another channel than the key names.
    [`GET /channels/${elsewhere}`]: thread(elsewhere, "800000000000000012"),
    [`GET /channels/${elsewhere}/messages`]: [message({ channel_id: elsewhere })],
  });
  const { transport } = transportWith(api);
  // The bot may sit in another server too; a key naming its channels reads as gone.
  assertEquals(await transport.fetchThread(ROOM, `${foreign}:${foreignThread}`), null);
  assertEquals(await transport.fetchThread(ROOM, `${CHANNEL}:${foreignThread}`), null);
  assertEquals(await transport.fetchThread(ROOM, `${CHANNEL}:${elsewhere}`), null);
  assert(!api.calls.some((c) => c.path.startsWith(`/channels/${elsewhere}/messages`)));
  // And nothing is said there: not at its channel, not in its thread, not by starting one.
  await assertRejects(
    () => transport.send(ROOM, { channelId: foreign, topic: null }, "hi"),
    DiscordError,
    "no channel",
  );
  await assertRejects(
    () => transport.send(ROOM, { channelId: foreign, topic: foreignThread }, "hi"),
    DiscordError,
    "no channel",
  );
  await assertRejects(
    () => transport.send(ROOM, { channelId: CHANNEL, topic: foreignThread }, "hi"),
    DiscordError,
    "starts from is gone",
  );
  assertEquals(api.calls.filter((c) => c.method === "POST"), []);
});

test("discord: without Read Message History a thread still starts, and its past reads hidden", async () => {
  const top = "800000000000003000";
  const api = fakeApi({
    [`GET /channels/${CHANNEL}`]: textChannel(),
    [`GET /channels/${CHANNEL}/messages/${top}`]: refuse(403, 50001, "Missing Access"),
    [`POST /channels/${CHANNEL}/messages/${top}/threads`]: { id: top },
    [`POST /channels/${top}/messages`]: { id: "800000000000003001" },
    [`GET /channels/${THREAD}`]: thread(),
    [`GET /channels/${CHANNEL}/messages/${THREAD}`]: refuse(403, 50001, "Missing Access"),
    // Discord answers a history read without the permission with an empty page.
    [`GET /channels/${THREAD}/messages`]: [],
  });
  const { transport } = transportWith(api);
  // The mention it hangs from cannot be read, so the thread takes the fallback name.
  assertEquals(
    await transport.send(ROOM, { channelId: CHANNEL, topic: top }, "on it"),
    `${CHANNEL}:${top}`,
  );
  assertEquals(api.calls.find((c) => c.path.endsWith("/threads"))?.json, { name: "ryph" });
  const read = await transport.fetchThread(ROOM, `${CHANNEL}:${THREAD}`);
  assertEquals(read?.messages, []);
  assertEquals(read?.historyLimited, true, "the agent is told its past is hidden");
});

test("discord: a thread's name is one line, bounded, never half a character, never empty", () => {
  assertEquals(threadName("  why is\n the   cache cold? "), "why is the cache cold?");
  assertEquals(threadName(" \n "), "ryph");
  assertEquals(threadName("b".repeat(100)), "b".repeat(100));
  assertEquals(threadName("b".repeat(101)), `${"b".repeat(99)}…`);
  // An emoji astride the cut is dropped whole, not halved.
  assertEquals(threadName(`${"a".repeat(98)}😀 and more`), `${"a".repeat(98)}…`);
});

test("discord: a later post of images refused files links only its own images", async () => {
  let forms = 0;
  const api = fakeApi({
    [`GET /channels/${THREAD}`]: thread(),
    [`POST /channels/${THREAD}/messages`]: (call: Call) =>
      call.form === null
        ? { id: "800000000000005101" }
        : ++forms === 1
        ? { id: "800000000000005100" }
        : refuse(403, 50013, "Missing Permissions"),
  });
  const { transport } = transportWith(api);
  const images = Array.from({ length: 12 }, (_, i) => ({
    label: `shot ${i + 1}`,
    mime: "image/png",
    url: `https://app.test/images/r/${i + 1}`,
    load: () => Promise.resolve(new Uint8Array([1]) as Uint8Array<ArrayBuffer>),
  }));
  const answers = await transport.sendImages(ROOM, { channelId: CHANNEL, topic: THREAD }, images);
  // The first ten went up as files; the two after the refusal go as links — not all twelve.
  assertEquals(answers.map((a) => a.kind), [
    ...Array(10).fill("uploaded"),
    "linked",
    "linked",
  ]);
  assertEquals(
    api.calls.at(-1)?.json?.content,
    "[shot 11](<https://app.test/images/r/11>)\n[shot 12](<https://app.test/images/r/12>)",
  );
});

test("discord: an attachment's redirects stay on Discord's CDN", async () => {
  const fetched: string[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    assertEquals(init?.redirect, "manual");
    const to = (location: string) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location } }));
    if (url.endsWith("/ok.png")) return to("https://media.discordapp.net/a/moved.png");
    if (url.endsWith("/evil.png")) return to("http://10.0.0.1/internal");
    return Promise.resolve(
      new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
    );
  }) as typeof fetch;
  const { transport } = transportWith(fakeApi(), { fetch: fetcher });
  const source = (name: string) => ({
    at: null,
    label: null,
    size: 2,
    ref: { kind: "discord" as const, url: `https://cdn.discordapp.com/attachments/1/2/${name}` },
  });
  const opts = { maxBytes: 1024, signal: nothing };
  assertEquals((await transport.downloadImage(ROOM, source("ok.png"), opts)).kind, "bytes");
  const evil = await transport.downloadImage(ROOM, source("evil.png"), opts);
  assertEquals(evil.kind, "failed");
  assert(!fetched.includes("http://10.0.0.1/internal"), "the hop off the CDN is never taken");
});
