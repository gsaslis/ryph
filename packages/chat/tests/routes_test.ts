// The management surface: any verified user lists and creates; the creator or an admin renames
// and archives; the token crosses once, inward, and never comes back.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { CHAT_DISABLED, disabledChatRoutes } from "../src/http/routes.ts";
import { makeRouter } from "@ryph/shared/http";
import { ADMIN, call, makeApi, OTHER, PLAIN } from "./api.ts";
import { BOT_TOKEN, ZULIP_EMAIL, ZULIP_KEY, ZULIP_REALM } from "./fake_transport.ts";

test("create, list, get: the bot's username shows, the token never does", async () => {
  const api = await makeApi();
  try {
    assertEquals((await call(api.handle, "GET", "/v1/chatrooms", undefined, null)).status, 401);
    const created = await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "telegram",
      name: "acme incidents",
      botToken: BOT_TOKEN,
    }, PLAIN);
    assertEquals(created.status, 201);
    const { chatroom } = await created.json();
    assertEquals(chatroom.botUsername, "ryph_bot");
    assertEquals(chatroom.ownerUserId, "u-plain");
    assertEquals(chatroom.linked, false);
    assertEquals(chatroom.quiet, false, "a room speaks unless asked not to");
    assert(!JSON.stringify(chatroom).includes("secret-bot-token"));

    const listed = await call(api.handle, "GET", "/v1/chatrooms", undefined, OTHER);
    assertEquals(listed.status, 200);
    const body = await listed.json();
    assertEquals(body.chatrooms.map((r: { id: string }) => r.id), [chatroom.id]);
    assert(!JSON.stringify(body).includes("secret-bot-token"));

    const got = await call(api.handle, "GET", `/v1/chatrooms/${chatroom.id}`, undefined, OTHER);
    assertEquals(got.status, 200);
    assertEquals((await call(api.handle, "GET", "/v1/chatrooms/chr-none")).status, 404);

    const bad = await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "telegram",
      name: "x",
      botToken: "nope",
    });
    assertEquals(bad.status, 400);
    assert((await bad.json()).error.includes("did not accept"));
    for (
      const body of [
        { kind: "telegram", name: "", botToken: BOT_TOKEN },
        { name: "x", botToken: BOT_TOKEN },
        { kind: "zulip", name: "x", realmUrl: "ftp://x", botEmail: ZULIP_EMAIL, apiKey: "k" },
        { kind: "zulip", name: "x", realmUrl: "https://z.test", apiKey: "k" },
      ]
    ) {
      assertEquals((await call(api.handle, "POST", "/v1/chatrooms", body)).status, 400);
    }
  } finally {
    await api.close();
  }
});

test("a Zulip room: the realm is normalized to its root, the key never comes back", async () => {
  const api = await makeApi();
  try {
    const created = await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "zulip",
      name: "radicle",
      realmUrl: "https://radicle.zulip.test/#narrow/channel/4-bugs",
      botEmail: ZULIP_EMAIL,
      apiKey: ZULIP_KEY,
    }, ADMIN);
    assertEquals(created.status, 201);
    const { chatroom } = await created.json();
    assertEquals(chatroom.kind, "zulip");
    assertEquals(chatroom.realmUrl, "https://radicle.zulip.test");
    assertEquals(chatroom.botEmail, ZULIP_EMAIL);
    assertEquals(chatroom.linked, true);
    assert(!JSON.stringify(chatroom).includes(ZULIP_KEY));
    const listed = await (await call(api.handle, "GET", "/v1/chatrooms", undefined, OTHER)).json();
    assert(!JSON.stringify(listed).includes(ZULIP_KEY));

    const wrong = await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "zulip",
      name: "radicle",
      realmUrl: "https://radicle.zulip.test",
      botEmail: ZULIP_EMAIL,
      apiKey: "wrong",
    });
    assertEquals(wrong.status, 400);
    assert(!(await wrong.text()).includes("wrong"), "the refusal does not echo the key");
  } finally {
    await api.close();
  }
});

test("a Zulip room takes chat:manage to create; a Telegram room is any writer's", async () => {
  const api = await makeApi();
  try {
    const zulip = {
      kind: "zulip",
      name: "radicle",
      realmUrl: ZULIP_REALM,
      botEmail: ZULIP_EMAIL,
      apiKey: ZULIP_KEY,
    };
    const refused = await call(api.handle, "POST", "/v1/chatrooms", zulip, PLAIN);
    assertEquals(refused.status, 403);
    assertEquals((await refused.json()).code, "forbidden");
    assertEquals(api.zulip.whoAmIs, 0, "the server never dialled the URL a non-admin named");
    assertEquals((await api.service.listChatrooms()).length, 0);

    const telegram = await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "telegram",
      name: "acme",
      botToken: BOT_TOKEN,
    }, PLAIN);
    assertEquals(telegram.status, 201);
    assertEquals((await call(api.handle, "POST", "/v1/chatrooms", zulip, ADMIN)).status, 201);
  } finally {
    await api.close();
  }
});

test("a realm is https, or plain http only at a loopback-named dev host", async () => {
  const api = await makeApi();
  try {
    const create = (realmUrl: string) =>
      call(api.handle, "POST", "/v1/chatrooms", {
        kind: "zulip",
        name: "radicle",
        realmUrl,
        botEmail: ZULIP_EMAIL,
        apiKey: ZULIP_KEY,
      }, ADMIN);
    for (
      const realmUrl of [
        "http://radicle.zulip.test",
        "http://127.0.0.1",
        "http://10.0.0.5:9991",
        "http://localhost.evil.test",
        "http://127.0.0.1.nip.io.evil.test",
      ]
    ) {
      const res = await create(realmUrl);
      assertEquals(res.status, 400, realmUrl);
      assert((await res.json()).error.includes("https"), realmUrl);
    }
    for (
      const realmUrl of [
        "https://radicle.zulip.test",
        "http://localhost:9991",
        "http://zulip.localhost",
        "http://127.0.0.1.nip.io:9991",
        "http://zulip.127.0.0.1.nip.io",
      ]
    ) {
      const res = await create(realmUrl);
      assertEquals(res.status, 201, realmUrl);
      assertEquals((await res.json()).chatroom.realmUrl, new URL(realmUrl).origin);
    }
  } finally {
    await api.close();
  }
});

test("a room's channels and groups, for its creator or an admin; a platform that does not answer is a 502", async () => {
  const api = await makeApi();
  try {
    const { chatroom } = await (await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "zulip",
      name: "radicle",
      realmUrl: "https://radicle.zulip.test",
      botEmail: ZULIP_EMAIL,
      apiKey: ZULIP_KEY,
    }, ADMIN)).json();
    api.zulip.channels = [
      { id: "4", name: "bugs", visibility: "web-public" },
      { id: "6", name: "core", visibility: "private" },
    ];
    api.zulip.groups = [{ id: "33", name: "core-team", description: "the core team" }];
    const path = `/v1/chatrooms/${chatroom.id}`;
    assertEquals((await call(api.handle, "GET", `${path}/channels`, undefined, null)).status, 401);
    // The channel list names private channels, the group list is the organization's: another
    // user is refused both, as they are renaming the room.
    assertEquals((await call(api.handle, "GET", `${path}/channels`, undefined, OTHER)).status, 403);
    assertEquals((await call(api.handle, "GET", `${path}/groups`, undefined, OTHER)).status, 403);
    const channels = await call(api.handle, "GET", `${path}/channels`, undefined, ADMIN);
    assertEquals(channels.status, 200);
    assertEquals((await channels.json()).channels, api.zulip.channels);
    const groups = await call(api.handle, "GET", `${path}/groups`, undefined, ADMIN);
    assertEquals((await groups.json()).groups, api.zulip.groups);
    assertEquals((await call(api.handle, "GET", "/v1/chatrooms/chr-none/groups")).status, 404);
    api.zulip.platformDown = true;
    assertEquals((await call(api.handle, "GET", `${path}/channels`)).status, 502);

    // Telegram: the one linked group, and no groups.
    const tg = await (await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "telegram",
      name: "acme",
      botToken: BOT_TOKEN,
    })).json();
    const tgChannels = await call(api.handle, "GET", `/v1/chatrooms/${tg.chatroom.id}/channels`);
    assertEquals((await tgChannels.json()).channels, [], "not linked yet");
  } finally {
    await api.close();
  }
});

test("renaming and archiving are the creator's or an admin's", async () => {
  const api = await makeApi();
  try {
    const { chatroom } = await (await call(api.handle, "POST", "/v1/chatrooms", {
      kind: "telegram",
      name: "acme incidents",
      botToken: BOT_TOKEN,
    }, PLAIN)).json();
    const path = `/v1/chatrooms/${chatroom.id}`;
    assertEquals((await call(api.handle, "PATCH", path, { name: "x" }, OTHER)).status, 403);
    assertEquals((await call(api.handle, "POST", `${path}/archive`, undefined, OTHER)).status, 403);
    const renamed = await call(api.handle, "PATCH", path, { name: "acme on-call" }, PLAIN);
    assertEquals(renamed.status, 200);
    assertEquals((await renamed.json()).chatroom.name, "acme on-call");
    // The quiet switch rides the same PATCH, and leaves the name it does not name alone.
    const hushed = await call(api.handle, "PATCH", path, { quiet: true }, PLAIN);
    assertEquals(hushed.status, 200);
    const hushedRoom = (await hushed.json()).chatroom;
    assertEquals([hushedRoom.name, hushedRoom.quiet], ["acme on-call", true]);
    // A PATCH that names nothing to change is the caller's mistake.
    assertEquals((await call(api.handle, "PATCH", path, {}, PLAIN)).status, 400);
    const archived = await call(api.handle, "POST", `${path}/archive`, undefined, ADMIN);
    assertEquals(archived.status, 200);
    assert((await archived.json()).chatroom.archivedAt !== null);
    assertEquals(
      (await call(api.handle, "PATCH", "/v1/chatrooms/chr-none", { name: "x" })).status,
      404,
    );
  } finally {
    await api.close();
  }
});

test("the disabled stand-in answers a stable refusal on every path", async () => {
  const handle = makeRouter(disabledChatRoutes({ authenticate: () => Promise.resolve(null) }));
  const res = await call(handle, "GET", "/v1/chatrooms");
  assertEquals(res.status, 503);
  assertEquals((await res.json()).code, CHAT_DISABLED);
  assertEquals((await call(handle, "POST", "/v1/chatrooms/x/archive")).status, 503);
  assertEquals((await call(handle, "GET", "/v1/chatrooms/x/channels")).status, 503);
  assertEquals((await call(handle, "GET", "/v1/chatrooms/x/groups")).status, 503);
});
