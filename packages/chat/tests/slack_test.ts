// The Slack adapter against a stand-in Web API and a scripted Socket Mode connection: what it
// asks, what it acknowledges, and what one `app_mention` becomes. Never the network, and never a
// real WebSocket — the dialer is the seam.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  conversationKey,
  parseAddress,
  renderSlackText,
  type SlackDialer,
  SlackError,
  slackTransport,
  stripBotMention,
} from "../src/adapters/transport/slack.ts";
import type { PlatformRoom } from "../src/ports/transport.ts";

const BOT_TOKEN = "xoxb-bot";
const APP_TOKEN = "xapp-app";
const SOCKET_URL = "wss://wss-primary.slack.test/link/?ticket=t1";

const ROOM: PlatformRoom = {
  id: "chr-s",
  credential: { kind: "slack", botToken: BOT_TOKEN, appToken: APP_TOKEN },
  bot: { id: "U0BOT", name: "ryph" },
  chatId: null,
  chatTitle: "Acme",
};

interface Call {
  method: string;
  token: string;
  contentType: string;
  /** The parameters as they came off the wire, so a body Slack could not read fails here. */
  params: Record<string, string>;
}

/** What a method answers: the body's own fields, or a whole `Response` for a refusal. A function
 * sees the call's own parameters, so one script can answer per user or per page. */
type Reply =
  | Record<string, unknown>
  | ((params: Record<string, string>) => Record<string, unknown> | Response);

/**
 * The Web API, scripted per method. A method with no script answers a bare success.
 *
 * The body is read as Slack reads it — FORM-ENCODED — never as JSON, because Slack does not
 * refuse a body it cannot parse: it runs the method with no arguments at all. A fake that took
 * either encoding would pass a call Slack would quietly empty.
 */
function fakeApi(replies: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const fetcher = ((input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const headers = new Headers(init?.headers);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    calls.push({
      method,
      token: String(headers.get("authorization")).replace("Bearer ", ""),
      contentType: headers.get("content-type") ?? "",
      params,
    });
    const scripted = replies[method];
    const body = typeof scripted === "function" ? scripted(params) : scripted;
    return Promise.resolve(
      body instanceof Response ? body : Response.json({ ok: true, ...body }),
    );
  }) as typeof fetch;
  return { calls, fetcher };
}

interface FakeSocket {
  url: string;
  /** Every envelope id this side acknowledged, in order. */
  acks: string[];
  closed: boolean;
  deliver(frame: unknown): void;
  end(): void;
}

function fakeDialer(): { sockets: FakeSocket[]; dial: SlackDialer } {
  const sockets: FakeSocket[] = [];
  const dial: SlackDialer = (url, handlers) => {
    const socket: FakeSocket = {
      url,
      acks: [],
      closed: false,
      deliver: (frame) => handlers.message(JSON.stringify(frame)),
      end: () => handlers.closed(),
    };
    sockets.push(socket);
    return {
      send: (text) => socket.acks.push(String(JSON.parse(text).envelope_id)),
      close: () => {
        socket.closed = true;
      },
    };
  };
  return { sockets, dial };
}

/** An `app_mention` envelope, as Socket Mode wraps one. */
function envelope(
  id: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "events_api",
    envelope_id: id,
    payload: { type: "event_callback", event: { type: "app_mention", ...event } },
  };
}

const CHANNEL = { channel: { id: "C0OPS", name: "ops", is_private: true } };
const ALICE = { user: { name: "alice", profile: { display_name: "Alice H" }, is_bot: false } };
const RYPH = { user: { name: "ryph", is_bot: true } };

/** The workspace's people, as `users.info` answers for each. */
const users = (params: Record<string, unknown>) => params.user === "U0BOT" ? RYPH : ALICE;

const nothing = new AbortController().signal;

test("slack: a key names the channel, the message and the thread it sits in", () => {
  assertEquals(parseAddress("C0OPS:1727530000.000100"), {
    channelId: "C0OPS",
    ts: "1727530000.000100",
    threadTs: "1727530000.000100",
  });
  const reply = parseAddress("C0OPS:1727530009.000200:1727530000.000100");
  assertEquals(reply?.threadTs, "1727530000.000100");
  assertEquals(conversationKey("C0OPS", "1727530000.000100"), "C0OPS:1727530000.000100");
  // Another platform's key, or nonsense, is not an address — never a wrong post.
  for (const bad of ["", "123", "C0OPS", "C0OPS:nope", "C0OPS:1:2:3:4", "C0 OPS:1.0"]) {
    assertEquals(parseAddress(bad), null, bad);
  }
});

test("slack: text is what the author typed, references named", () => {
  assertEquals(stripBotMention("<@U0BOT> look at the cache", "U0BOT"), "look at the cache");
  assertEquals(stripBotMention("<@U0BOT|ryph> hi", "U0BOT"), "hi");
  // Anyone else's mention stays, to be named below.
  assertEquals(stripBotMention("<@U0ALICE> and <@U0BOT>", "U0BOT"), "<@U0ALICE> and");

  const names = new Map([["U0ALICE", "Alice H"]]);
  assertEquals(renderSlackText("ask <@U0ALICE> about it", names), "ask @Alice H about it");
  // A person the workspace would not name keeps their id, which is still a reference.
  assertEquals(renderSlackText("ask <@U0BOB>", names), "ask @U0BOB");
  assertEquals(renderSlackText("see <#C0OPS|ops>", names), "see #ops");
  assertEquals(renderSlackText("<!here> deploy is red", names), "@here deploy is red");
  assertEquals(renderSlackText("<!subteam^S01|@sre> take it", names), "@sre take it");
  assertEquals(
    renderSlackText("the <https://logs.test/x|log> and <https://p.test>", names),
    "the log (https://logs.test/x) and https://p.test",
  );
  // The escapes are transport, not authoring — and are decoded last, so nothing they reveal is
  // read as markup.
  assertEquals(renderSlackText("a &lt;b&gt; &amp; c", names), "a <b> & c");
  assertEquals(renderSlackText("keep &lt;@U0ALICE&gt;", names), "keep <@U0ALICE>");
  // The mrkdwn around the references is the author's and is left alone.
  assertEquals(renderSlackText("*urgent* `cache.ts`", names), "*urgent* `cache.ts`");
});

test("slack: a call's arguments are form-encoded, which is what Slack reads", async () => {
  const api = fakeApi({ "users.info": { user: { name: "alice" } } });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  await transport.checkMembership(ROOM, "S0SRE", "U0ALICE");
  await transport.listChannels(ROOM);

  // Slack answers a body it cannot parse by running the method with NO arguments — `users.info`
  // then says `user_not_found` about a person who exists, and the mention behind it is dropped
  // as an undescribable sender. So the encoding is the contract, not an implementation detail.
  for (const call of api.calls) {
    assertEquals(call.contentType, "application/x-www-form-urlencoded; charset=utf-8", call.method);
  }
  assertEquals(api.calls[0].params, { usergroup: "S0SRE", include_disabled: "false" });
  // `users.conversations`, not `conversations.list`: the bot's own channels are the only ones it
  // can hear a mention from, so listing the rest would offer what could never work.
  assertEquals(api.calls[1].method, "users.conversations");
  assertEquals(api.calls[1].params, {
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: "200",
  });
});

test("slack: a token fetch cannot send is never in the error", async () => {
  const token = "xoxb-zero\u200bwidth";
  // What a runtime's fetch does with a header value past Latin-1: throws, quoting it.
  const fetcher = ((_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    return Promise.reject(new TypeError(`Header 'authorization' has invalid value: '${auth}'`));
  }) as unknown as typeof fetch;
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: fetcher });
  const err = await assertRejects(() =>
    transport.whoAmI({ kind: "slack", botToken: token, appToken: APP_TOKEN })
  );
  assert(!String((err as Error).message).includes(token), (err as Error).message);
});

test("slack: whoAmI vouches for both halves of the credential", async () => {
  const api = fakeApi({
    "auth.test": { user_id: "U0BOT", user: "ryph", team: "Acme", bot_id: "B01" },
    "apps.connections.open": { url: SOCKET_URL },
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  assertEquals(await transport.whoAmI(ROOM.credential), {
    id: "U0BOT",
    name: "ryph",
    title: "Acme",
  });
  // The bot token proves the app; the app-level token is spent once so a room that could never
  // hear anything is refused at creation rather than at the first mention.
  assertEquals(api.calls.map((c) => [c.method, c.token]), [
    ["auth.test", BOT_TOKEN],
    ["apps.connections.open", APP_TOKEN],
  ]);

  const personal = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({ "auth.test": { user_id: "U0ME", user: "grace", team: "Acme" } }).fetcher,
  });
  await assertRejects(
    () => personal.whoAmI(ROOM.credential),
    Error,
    "the credential is not a bot token",
  );

  const noSocket = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({
      "auth.test": { user_id: "U0BOT", user: "ryph", team: "Acme", bot_id: "B01" },
      "apps.connections.open": () => Response.json({ ok: false, error: "invalid_auth" }),
    }).fetcher,
  });
  await assertRejects(() => noSocket.whoAmI(ROOM.credential), SlackError, "invalid_auth");
});

test("slack: a mention off the socket is acknowledged, then normalized", async () => {
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });

  // The first poll opens the connection; nothing has arrived down it yet.
  const opened = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(opened.updates, []);
  assertEquals(opened.position, { offset: 0, queueId: null, lastMessageId: null });
  assertEquals(sockets.length, 1);
  assertEquals(sockets[0].url, SOCKET_URL);

  sockets[0].deliver({ type: "hello", num_connections: 1 });
  sockets[0].deliver(envelope("e1", {
    user: "U0ALICE",
    text: "<@U0BOT> the cache is cold, ask <@U0ALICE>",
    ts: "1727530000.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  // Every envelope is acknowledged on arrival — `hello` carries none.
  assertEquals(sockets[0].acks, ["e1"]);

  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(batch.updates.length, 1);
  const message = batch.updates[0].message;
  assert(message !== null);
  // The message id carries its thread, because a reply's own timestamp does not name one.
  assertEquals(message.messageId, "C0OPS:1727530000.000100:1727530000.000100");
  assertEquals(message.threadKey, "C0OPS:1727530000.000100");
  assertEquals(message.channel, { id: "C0OPS", name: "ops", visibility: "private" });
  assertEquals(message.topic, null);
  assertEquals(message.sender, { id: "U0ALICE", name: "Alice H", isBot: false });
  assertEquals(message.text, "the cache is cold, ask @Alice H");
  assertEquals(message.mentionsBot, true);
  assertEquals(message.servable, true);
  assertEquals(message.direct, false);
  // The same person twice costs one lookup: names are what the server said, not a secret.
  assertEquals(api.calls.filter((c) => c.method === "users.info").length, 1);
});

test("slack: a reply in a thread belongs to the thread, not to itself", async () => {
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  sockets[0].deliver(envelope("e2", {
    user: "U0ALICE",
    text: "<@U0BOT> any luck?",
    ts: "1727530099.000900",
    thread_ts: "1727530000.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  const message = batch.updates[0].message;
  assert(message !== null);
  assertEquals(message.threadKey, "C0OPS:1727530000.000100");
  assertEquals(message.messageId, "C0OPS:1727530099.000900:1727530000.000100");
  // And that is the conversation `locate` answers for it, with no call at all: a Slack thread
  // never leaves the channel it was made in.
  assertEquals(await transport.locate(ROOM, message.messageId), {
    channel: { id: "C0OPS", name: "" },
    topic: "1727530000.000100",
  });
  assertEquals(await transport.locate(ROOM, message.threadKey), {
    channel: { id: "C0OPS", name: "" },
    topic: "1727530000.000100",
  });
  assertEquals(await transport.locate(ROOM, "17275300"), null);
});

test("slack: a bot and a DM cost no read; a channel it cannot describe fails", async () => {
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": () => Response.json({ ok: false, error: "internal_error" }),
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });

  sockets[0].deliver(envelope("e3", {
    bot_id: "B99",
    text: "<@U0BOT> deploy finished",
    ts: "1727530001.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  sockets[0].deliver(envelope("e4", {
    user: "U0ALICE",
    text: "<@U0BOT> hi",
    ts: "1727530002.000100",
    channel: "D0ALICE",
    channel_type: "im",
  }));
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(batch.updates.length, 2);
  // Slack names a bot's post by its `bot_id` and no user, which is a message with no sender —
  // and the control plane drops those, ours and anyone else's.
  assertEquals(batch.updates[0].message?.sender, null);
  assertEquals(batch.updates[1].message?.direct, true);
  assertEquals(api.calls.some((c) => c.method === "conversations.info"), false);

  // A channel the bot cannot describe is never guessed at: visibility decides what may be
  // started from there, so a channel read Slack could not answer fails the poll and the mention
  // keeps its place. A channel that is GONE is a different answer, and is dropped — see below.
  sockets[0].deliver(envelope("e5", {
    user: "U0ALICE",
    text: "<@U0BOT> look",
    ts: "1727530003.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    SlackError,
    "internal_error",
  );
});

test("slack: a refused call costs no queued mention", async () => {
  // `conversations.info` is down for the first and third call of it. The envelopes are long
  // acknowledged, so anything the adapter lets go of here is a mention nobody ever answers.
  let reads = 0;
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": () => {
      reads += 1;
      return reads === 1 || reads === 3
        ? Response.json({ ok: false, error: "internal_error" })
        : CHANNEL;
    },
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  for (const [id, ts] of [["e6", "1727530006.000100"], ["e7", "1727530007.000100"]]) {
    sockets[0].deliver(envelope(id, {
      user: "U0ALICE",
      text: "<@U0BOT> look",
      ts,
      channel: "C0OPS",
      channel_type: "channel",
    }));
  }
  assertEquals(sockets[0].acks, ["e6", "e7"]);

  // Nothing was read before the refusal, so the poll fails and BOTH keep their place.
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    SlackError,
    "internal_error",
  );
  // The second refusal comes with one mention already in hand: that one is returned rather than
  // thrown away, and the one behind it waits for the next poll.
  const first = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(first.updates.map((u) => u.message?.messageId), [
    "C0OPS:1727530006.000100:1727530006.000100",
  ]);
  const second = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(second.updates.map((u) => u.message?.messageId), [
    "C0OPS:1727530007.000100:1727530007.000100",
  ]);
  assertEquals(
    (await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing })).updates,
    [],
  );
});

test("slack: a mention from a channel the bot cannot read is dropped, not stuck", async () => {
  // The bot was removed from C0GONE. That mention can never be served, and leaving it at the head
  // of the queue would hold back every mention behind it, in channels that are still fine.
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": (params) =>
      params.channel === "C0GONE" ? Response.json({ ok: false, error: "not_in_channel" }) : CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  for (const [id, channel] of [["e9", "C0GONE"], ["e10", "C0OPS"]]) {
    sockets[0].deliver(envelope(id, {
      user: "U0ALICE",
      text: "<@U0BOT> look",
      ts: "1727530010.000100",
      channel,
      channel_type: "channel",
    }));
  }
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  // The unreadable one is nothing to route; the one behind it arrives in the same batch.
  assertEquals(batch.updates.map((u) => u.message?.channel.id ?? null), [null, "C0OPS"]);
});

test("slack: a reconnection keeps what the old socket delivered", async () => {
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  sockets[0].deliver(envelope("e11", {
    user: "U0ALICE",
    text: "<@U0BOT> before the rotation",
    ts: "1727530011.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  // Slack rotates the connection before anyone drained it. The envelope was acknowledged on
  // arrival, so this side holds Slack's only copy — it moves to the new connection.
  sockets[0].deliver({ type: "disconnect", reason: "refresh_requested" });
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 2);
  assertEquals(batch.updates[0].message?.text, "before the rotation");
});

test("slack: a channel shared with another organization is not private", async () => {
  // Slack Connect keeps `is_private`, but the other organization manages its own members and can
  // add them later, so the channel's membership is no longer this workspace's allowlist.
  const connected = {
    channel: { id: "C0EXT", name: "vendor", is_private: true, is_ext_shared: true },
  };
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": connected,
    "users.info": ALICE,
    "users.conversations": {
      channels: [
        connected.channel,
        { id: "C0INV", name: "invited", is_private: true, is_pending_ext_shared: true },
        // A share across workspaces of the same Enterprise Grid organization is still this
        // company's own people, and stays private.
        { id: "C0GRID", name: "grid", is_private: true, is_org_shared: true },
        { id: "C0OPS", name: "ops", is_private: true },
      ],
    },
  });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  assertEquals(
    (await transport.listChannels(ROOM)).channels.map((c) => [c.name, c.visibility]),
    [["grid", "private"], ["invited", "public"], ["ops", "private"], ["vendor", "public"]],
  );

  // And the mention door sees the same thing, because it is the same read.
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  sockets[0].deliver(envelope("e12", {
    user: "U0ALICE",
    text: "<@U0BOT> ship it",
    ts: "1727530012.000100",
    channel: "C0EXT",
    channel_type: "channel",
  }));
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(batch.updates[0].message?.channel.visibility, "public");
});

test("slack: a reopen that fails keeps the mentions the old socket delivered", async () => {
  // The rotation below needs a new socket and Slack refuses the first ask. The envelope was
  // acknowledged on arrival, so letting go of the old connection here would lose it for good.
  let opens = 0;
  const api = fakeApi({
    "apps.connections.open": () => {
      opens += 1;
      return opens === 2 ? Response.json({ ok: false, error: "ratelimited" }) : { url: SOCKET_URL };
    },
    "conversations.info": CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  let clock = 1_700_000_000_000;
  const transport = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: api.fetcher,
    dial,
    now: () => clock,
  });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  sockets[0].deliver(envelope("e13", {
    user: "U0ALICE",
    text: "<@U0BOT> before the reopen",
    ts: "1727530013.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  assertEquals(sockets[0].acks, ["e13"]);

  clock += 16 * 60_000;
  await assertRejects(
    () => transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing }),
    SlackError,
    "ratelimited",
  );
  // The third ask succeeds, and the mention rides across to the connection it opens.
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 2);
  assertEquals(batch.updates[0].message?.text, "before the reopen");
});

test("slack: a connection that never closes is replaced anyway", async () => {
  const api = fakeApi({
    "apps.connections.open": { url: SOCKET_URL },
    "conversations.info": CHANNEL,
    "users.info": ALICE,
  });
  const { sockets, dial } = fakeDialer();
  let clock = 1_700_000_000_000;
  const transport = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: api.fetcher,
    dial,
    now: () => clock,
  });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  clock += 14 * 60_000;
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 1, "a connection in use is kept");

  // A socket can stop delivering without ever closing — a slept laptop, a dropped NAT flow — and
  // then it sits open and silent, taking no events and firing nothing this side can react to. Age
  // is the bound that does not depend on hearing about the failure.
  clock += 2 * 60_000;
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 2);
  assertEquals(sockets[0].closed, true);
  // And the fresh one hears what the old one would have missed.
  sockets[1].deliver(envelope("e8", {
    user: "U0ALICE",
    text: "<@U0BOT> anyone there?",
    ts: "1727530008.000100",
    channel: "C0OPS",
    channel_type: "channel",
  }));
  const batch = await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(batch.updates[0].message?.text, "anyone there?");
});

test("slack: a room the poller let go of loses its socket", async () => {
  const api = fakeApi({ "apps.connections.open": { url: SOCKET_URL } });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  const other: PlatformRoom = { ...ROOM, id: "chr-t" };
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  await transport.poll(other, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 2);

  // A room still polled keeps its socket; the one left out is archived, or another replica took
  // its lock — and a socket nobody drains would go on acknowledging events for it.
  transport.releaseAllBut(new Set([ROOM.id]));
  assertEquals(sockets.map((s) => s.closed), [false, true]);
  // Idempotent, and the room is polled again on a connection of its own.
  transport.releaseAllBut(new Set([ROOM.id]));
  await transport.poll(other, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 3);

  // The whole workspace gone quiet: nothing is polled, and nothing is left open.
  transport.releaseAllBut(new Set());
  assertEquals(sockets.map((s) => s.closed), [true, true, true]);
});

test("slack: a disconnect ends the connection, and the next poll reconnects", async () => {
  const api = fakeApi({ "apps.connections.open": { url: SOCKET_URL } });
  const { sockets, dial } = fakeDialer();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher, dial });
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  sockets[0].deliver({ type: "disconnect", reason: "refresh_requested" });
  assertEquals(sockets[0].closed, true);
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 2);
  // A socket the server simply dropped is the same story.
  sockets[1].end();
  await transport.poll(ROOM, { position: null, timeoutS: 0, signal: nothing });
  assertEquals(sockets.length, 3);
});

test("slack: a post threads, and opening a conversation posts at the channel", async () => {
  const api = fakeApi({
    "chat.postMessage": { ts: "1727530500.000700", channel: "C0OPS" },
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  assertEquals(await transport.maxMessageLength(ROOM), 4000);

  // A conversation the platform opens is addressed at the channel: the post's own thread becomes
  // it, and the topic a response policy asked for is not an address here.
  assertEquals(transport.openTarget("C0OPS", "nightly · 12:00 UTC"), {
    channelId: "C0OPS",
    topic: null,
  });
  assertEquals(transport.roomIsOneConversation, false);

  const opened = await transport.send(ROOM, { channelId: "C0OPS", topic: null }, "🚀 on it");
  assertEquals(opened, "C0OPS:1727530500.000700");
  assertEquals(api.calls[0].params.thread_ts, undefined);
  // Links are left unfurled: a run's posts carry patch and run URLs, and a preview of each would
  // bury the words.
  assertEquals(api.calls[0].params.unfurl_links, "false");

  await transport.send(ROOM, { channelId: "C0OPS", topic: "1727530000.000100" }, "found it");
  assertEquals(api.calls[1].params.thread_ts, "1727530000.000100");

  // An opening line refused part-way is taken back by the key its first part answered.
  await transport.retract!(ROOM, opened);
  assertEquals(api.calls[2].method, "chat.delete");
  assertEquals(api.calls[2].params, { channel: "C0OPS", ts: "1727530500.000700" });
});

test("slack: an acknowledgement reacts to the message; a repeat is no failure", async () => {
  let attempt = 0;
  const api = fakeApi({
    "reactions.add": () =>
      ++attempt === 1 ? { ok: true } : Response.json({ ok: false, error: "already_reacted" }),
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const id = "C0OPS:1727530099.000900:1727530000.000100";
  await transport.react(ROOM, id);
  assertEquals(api.calls[0].params, {
    channel: "C0OPS",
    timestamp: "1727530099.000900",
    name: "eyes",
  });
  await transport.react(ROOM, id);
  // Nothing to react to is nothing to do.
  await transport.react(ROOM, "not-a-key");
  assertEquals(api.calls.length, 2);
});

test("slack: a thread is read forward, notices dropped, a deleted one gone", async () => {
  const api = fakeApi({
    "conversations.info": CHANNEL,
    "users.info": users,
    "conversations.replies": {
      messages: [
        { user: "U0ALICE", text: "<@U0BOT> the cache is cold", ts: "1727530000.000100" },
        { subtype: "channel_join", user: "U0BOB", text: "has joined", ts: "1727530001.000100" },
        { bot_id: "B01", text: "🚀 *Ada* is on it.", ts: "1727530002.000100" },
      ],
      has_more: false,
    },
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const thread = await transport.fetchThread(ROOM, "C0OPS:1727530000.000100");
  assert(thread !== null);
  assertEquals(thread.channel, { id: "C0OPS", name: "ops", visibility: "private" });
  assertEquals(thread.topic, null);
  assertEquals(thread.truncated, false);
  // A member of a channel sees its whole history, so nothing is hidden from the bot that is not
  // hidden from everyone.
  assertEquals(thread.historyLimited, false);
  assertEquals(thread.messages.map((m) => m.text), [
    // The bot's own mention stays in the evidence, named like anyone else's: it is what the
    // person typed, and the run is reading the room it is working in.
    "@ryph the cache is cold",
    "🚀 *Ada* is on it.",
  ]);
  assertEquals(thread.messages[0].sender, { id: "U0ALICE", name: "Alice H" });
  assertEquals(thread.messages[0].sentAt, "2024-09-28T13:26:40.000Z");
  assertEquals(thread.messages[0].id, "C0OPS:1727530000.000100");

  const gone = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({
      "conversations.info": CHANNEL,
      "conversations.replies": () => Response.json({ ok: false, error: "thread_not_found" }),
    }).fetcher,
  });
  assertEquals(await gone.fetchThread(ROOM, "C0OPS:1727530000.000100"), null);
  // A key from another platform reaches Slack only through a mistake, and it reads as gone.
  assertEquals(await transport.fetchThread(ROOM, "4242"), null);
});

test("slack: a commander check is the usergroup's members, and never a guess", async () => {
  const api = fakeApi({ "usergroups.users.list": { users: ["U0ALICE", "U0BOB"] } });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  assertEquals(await transport.checkMembership(ROOM, "S0SRE", "U0ALICE"), "allowed");
  assertEquals(await transport.checkMembership(ROOM, "S0SRE", "U0EVE"), "denied");
  assertEquals(await transport.checkMembership(ROOM, "not a group", "U0ALICE"), "unknown");

  const down = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({
      "usergroups.users.list": () => Response.json({ ok: false, error: "invalid_auth" }),
    }).fetcher,
  });
  // A platform that cannot answer is never read as a yes.
  assertEquals(await down.checkMembership(ROOM, "S0SRE", "U0ALICE"), "unknown");
});

test("slack: the bot's own channels page; no usergroups is not a failure", async () => {
  let page = 0;
  const api = fakeApi({
    "users.conversations": () =>
      ++page === 1
        ? {
          channels: [{ id: "C0OPS", name: "ops", is_private: true }],
          response_metadata: { next_cursor: "c2" },
        }
        : {
          channels: [
            { id: "C0GEN", name: "general" },
            { id: "C0OLD", name: "old", is_archived: true },
          ],
          response_metadata: { next_cursor: "" },
        },
    "usergroups.list": {
      usergroups: [
        { id: "S0SRE", name: "SRE", handle: "sre", description: "on call" },
        { id: "S0GONE", name: "Gone", handle: "gone", date_delete: 1727530000 },
      ],
    },
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  assertEquals(await transport.listChannels(ROOM), {
    channels: [
      { id: "C0GEN", name: "general", visibility: "public" },
      { id: "C0OPS", name: "ops", visibility: "private" },
    ],
    // Slack ran out of channels before the page budget ran out, so this is the whole workspace.
    truncated: false,
  });
  assertEquals(api.calls.filter((c) => c.method === "users.conversations").length, 2);

  // A workspace that keeps handing back a cursor is bigger than the page budget, and the list
  // says so rather than looking like the whole of it.
  const endless = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({
      "users.conversations": () => ({
        channels: [{ id: "C0BIG", name: "big", is_private: false }],
        response_metadata: { next_cursor: "more" },
      }),
    }).fetcher,
  });
  const partial = await endless.listChannels(ROOM);
  assertEquals(partial.truncated, true);
  assertEquals(partial.channels.length, 10, "one page's worth per page, to the budget");
  assertEquals(await transport.listGroups(ROOM), [
    { id: "S0SRE", name: "@sre", description: "on call" },
  ]);

  const free = slackTransport({
    apiUrl: "https://slack.test/api",
    fetch: fakeApi({
      "usergroups.list": () => Response.json({ ok: false, error: "plan_upgrade_required" }),
    }).fetcher,
  });
  // Usergroups are a paid feature: a workspace without them has none, which is not an outage.
  assertEquals(await free.listGroups(ROOM), []);
});

test("slack: a file download whose token fetch cannot send never quotes it", async () => {
  const token = "xoxb-zero​width";
  const fetcher = ((_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    return Promise.reject(new TypeError(`Header 'authorization' has invalid value: '${auth}'`));
  }) as unknown as typeof fetch;
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: fetcher });
  const got = await transport.downloadImage(
    { ...ROOM, credential: { kind: "slack", botToken: token, appToken: APP_TOKEN } },
    { ref: { kind: "slack", url: "https://files.slack.com/files-pri/T1-F1/shot.png" } } as never,
    { maxBytes: 1024, signal: new AbortController().signal },
  );
  assert(got.kind === "failed", JSON.stringify(got));
  assert(!got.error.includes("zero"), got.error);
});
