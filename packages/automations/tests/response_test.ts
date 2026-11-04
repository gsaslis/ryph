// The response policy: an automation whose fires open or join a response instead of starting
// a run each. This service only carries it — the clocks are validated and defaulted at the
// door, the policy rides every event verbatim, and the orchestrator's "joined" verdict lands in
// the fire history — so these tests pin exactly that carriage, end to end over the real
// stores and the mailroom.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { sql } from "drizzle-orm";
import { api, hmacHex, makeService, webhookCreateBody } from "./harness.ts";

const fire = async (
  svc: Awaited<ReturnType<typeof makeService>>,
  automation: { trigger: { path: string } },
  secret: string,
  payload: string,
) => {
  const res = await svc.handler(
    new Request(`http://automations.test${automation.trigger.path}`, {
      method: "POST",
      headers: { "x-ryph-signature": `sha256=${await hmacHex(secret, payload)}` },
      body: payload,
    }),
  );
  assertEquals(res.status, 202);
  await svc.webhooks.sweep();
};

test("a response policy is defaulted at the door, stored, listed, and rides every fire", async () => {
  const svc = await makeService();
  try {
    const created = await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: "chr-1" } }),
    );
    assertEquals(created.status, 201);
    const { automation, secret } = await created.json();
    // The clocks the caller left out get their defaults, and the policy is public.
    assertEquals(automation.response, {
      chatroomId: "chr-1",
      channelId: null,
      idleMs: 30 * 60_000,
      attendedIdleMs: 60 * 60_000,
      // A raw webhook reads no keys, so its fires join the automation's one open response.
      correlation: "automation",
      postAlert: false,
      conversation: "per-response",
    });
    const listed = await (await api(svc, "GET", "/v1/automations")).json();
    assertEquals(listed.automations[0].response.chatroomId, "chr-1");

    await fire(svc, automation, secret, '{"status":"firing"}');
    assertEquals(svc.delivered.length, 1);
    assertEquals(svc.delivered[0].response, {
      chatroomId: "chr-1",
      channelId: null,
      idleMs: 30 * 60_000,
      attendedIdleMs: 60 * 60_000,
      // A raw webhook reads no keys, so its fires join the automation's one open response.
      correlation: "automation",
      postAlert: false,
      conversation: "per-response",
    });
  } finally {
    await svc.db.close();
  }
});

test("no policy is null on the row and on the event; a PATCH sets it and null clears it", async () => {
  const svc = await makeService();
  try {
    const { automation, secret } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody(),
    )).json();
    assertEquals(automation.response, null);

    const set = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: null, idleMs: 120_000, attendedIdleMs: 3_600_000 },
    });
    assertEquals(set.status, 200);
    assertEquals((await set.json()).automation.response, {
      chatroomId: null,
      channelId: null,
      idleMs: 120_000,
      attendedIdleMs: 3_600_000,
      correlation: "automation",
      postAlert: false,
      conversation: "per-response",
    });
    // The event carries the policy in force at hand-over, like every other field of the recipe.
    await fire(svc, automation, secret, "{}");
    assertEquals(svc.delivered[0].response?.idleMs, 120_000);

    const cleared = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: null,
    });
    assertEquals((await cleared.json()).automation.response, null);
    // A PATCH that says nothing about it leaves it alone.
    const renamed = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      name: "renamed",
    });
    assertEquals((await renamed.json()).automation.response, null);
  } finally {
    await svc.db.close();
  }
});

test("an idle clock under a minute or over a day is refused at creation", async () => {
  const svc = await makeService();
  try {
    for (const bad of [{ idleMs: 1_000 }, { attendedIdleMs: 25 * 60 * 60_000 }]) {
      const res = await api(
        svc,
        "POST",
        "/v1/automations",
        webhookCreateBody({ response: { chatroomId: null, ...bad } }),
      );
      assertEquals(res.status, 400);
    }
  } finally {
    await svc.db.close();
  }
});

test("the door's resolved verdict lands in the fire history as resolved, with no task", async () => {
  const svc = await makeService({
    answer: () => ({ kind: "ok", outcome: "resolved", taskId: null, runId: null }),
  });
  try {
    const { automation, secret } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: null } }),
    )).json();
    await fire(svc, automation, secret, '{"status":"resolved"}');
    const fires = await (await api(svc, "GET", `/v1/automations/${automation.id}/fires`)).json();
    assertEquals(fires.fires.length, 1);
    assertEquals(fires.fires[0].outcome, "resolved");
    assertEquals(fires.fires[0].taskId, null);
  } finally {
    await svc.db.close();
  }
});

test("the door's joined verdict lands in the fire history as joined, with the response's task", async () => {
  const svc = await makeService({
    answer: () => ({ kind: "ok", outcome: "joined", taskId: "t-open", runId: "r-open" }),
  });
  try {
    const { automation, secret } = await (await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: null } }),
    )).json();
    await fire(svc, automation, secret, '{"status":"resolved"}');
    const fires = await (await api(svc, "GET", `/v1/automations/${automation.id}/fires`)).json();
    assertEquals(fires.fires.length, 1);
    assertEquals(fires.fires[0].outcome, "joined");
    assertEquals(fires.fires[0].taskId, "t-open");
    assertEquals(fires.fires[0].runId, "r-open");
  } finally {
    await svc.db.close();
  }
});

test("a Telegram room holds one response at a time: its correlation defaults to and must be automation", async () => {
  const svc = await makeService({ chatrooms: { "chr-1": "telegram" } });
  try {
    // A keyed format would join per key anywhere else; the room's one conversation cannot hold
    // two bound runs, so a second open response would run unheard.
    const keyed = (response: Record<string, unknown>) =>
      api(
        svc,
        "POST",
        "/v1/automations",
        webhookCreateBody({
          trigger: {
            kind: "webhook",
            format: { kind: "alertmanager" },
            verification: { kind: "hmac-sha256" },
          },
          response,
        }),
      );
    for (const correlation of ["key", "fire"]) {
      const refused = await keyed({ chatroomId: "chr-1", correlation });
      assertEquals(refused.status, 422);
      assertEquals((await refused.json()).error.startsWith("response.correlation:"), true);
    }
    const defaulted = await keyed({ chatroomId: "chr-1" });
    assertEquals(defaulted.status, 201);
    const { automation } = await defaulted.json();
    assertEquals(automation.response.correlation, "automation");

    // A PATCH naming the room is held to the same rule.
    const patched = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-1", correlation: "key" },
    });
    assertEquals(patched.status, 422);
    // Off the room, the keyed format's default is back.
    const roomless = await keyed({ chatroomId: null });
    assertEquals((await roomless.json()).automation.response.correlation, "key");
  } finally {
    await svc.db.close();
  }
});

const ZULIP = {
  platform: "zulip" as const,
  channels: [
    { id: "7", name: "incidents", visibility: "public" as const },
    { id: "8", name: "status", visibility: "web-public" as const },
    { id: "9", name: "war-room", visibility: "private" as const },
  ],
};

test("a response's chatroom must be a live room, asked as the caller; a Telegram room takes no channel", async () => {
  const svc = await makeService({
    chatrooms: { "chr-1": "telegram", "chr-down": "down" },
  });
  try {
    const create = (response: Record<string, unknown>) =>
      api(svc, "POST", "/v1/automations", webhookCreateBody({ response }));

    assertEquals((await create({ chatroomId: "chr-none" })).status, 422);
    assertEquals(
      (await create({ chatroomId: "chr-down" })).status,
      502,
      "an unanswered check is no yes",
    );
    const channelled = await create({ chatroomId: "chr-1", channelId: "7" });
    assertEquals(channelled.status, 422);
    assertEquals(
      (await channelled.json()).error,
      "response.channelId: a Telegram room has one conversation — leave channelId null",
    );
    // A channel without a room is a contradiction, refused before anyone is asked.
    const roomless = await create({ chatroomId: null, channelId: "7" });
    assertEquals(roomless.status, 422);
    assertEquals((await roomless.json()).error.startsWith("response.channelId:"), true);
    assertEquals((await (await api(svc, "GET", "/v1/automations")).json()).automations, []);
    // The lookups rode the caller's own bearer, and a Telegram room's channels were never asked for.
    assertEquals(svc.lookups[0], { id: "chr-none", authorization: "Bearer t" });
    assertEquals(svc.lookups.some((l) => l.channels === true), false);

    const { automation } = await (await create({ chatroomId: "chr-1" })).json();
    const patched = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-none" },
    });
    assertEquals(patched.status, 422);
    const kept = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(kept.automation.response.chatroomId, "chr-1");
    // A PATCH that does not name a room asks nobody.
    const before = svc.lookups.length;
    await api(svc, "PATCH", `/v1/automations/${automation.id}`, { name: "renamed" });
    assertEquals(svc.lookups.length, before);
  } finally {
    await svc.db.close();
  }
});

test("a Zulip room's response names one of the channels the room lists, and the event carries it", async () => {
  const svc = await makeService({
    chatrooms: {
      "chr-z": ZULIP,
      "chr-z-private": { platform: "zulip", channels: "forbidden" },
      "chr-z-dark": { platform: "zulip", channels: "down" },
    },
  });
  try {
    const create = (response: Record<string, unknown>) =>
      api(svc, "POST", "/v1/automations", webhookCreateBody({ response }));

    const unchannelled = await create({ chatroomId: "chr-z" });
    assertEquals(unchannelled.status, 422);
    assertEquals(
      (await unchannelled.json()).error,
      "response.channelId: a Zulip room needs a channel to open each response's conversation in",
    );
    const unlisted = await create({ chatroomId: "chr-z", channelId: "42" });
    assertEquals(unlisted.status, 422);
    assertEquals(
      (await unlisted.json()).error,
      "response.channelId: the room does not list channel 42 (the bot must be subscribed to a " +
        "private channel)",
    );
    const notMine = await create({ chatroomId: "chr-z-private", channelId: "7" });
    assertEquals(notMine.status, 403);
    assertEquals(
      (await notMine.json()).error,
      "response.chatroomId: only the room's creator or an admin may bind responses to a room's " +
        "channels",
    );
    assertEquals((await create({ chatroomId: "chr-z-dark", channelId: "7" })).status, 502);
    assertEquals((await (await api(svc, "GET", "/v1/automations")).json()).automations, []);
    // The channel list was read as the caller too.
    assertEquals(
      svc.lookups.filter((l) => l.channels === true)[0],
      { id: "chr-z", authorization: "Bearer t", channels: true },
    );

    // A response opens in a private channel only: its subscribers are the allowlist for steering
    // and the audience for everything the agent posts, so a listed public or web-public channel
    // is refused by name, and nothing is saved.
    const open = await create({ chatroomId: "chr-z", channelId: "7" });
    assertEquals(open.status, 422);
    assertEquals(
      (await open.json()).error,
      "response.channelId: a response opens in a private channel only — incidents is public",
    );
    const webPublic = await create({ chatroomId: "chr-z", channelId: "8" });
    assertEquals(webPublic.status, 422);
    assertEquals(
      (await webPublic.json()).error,
      "response.channelId: a response opens in a private channel only — status is web-public",
    );
    assertEquals((await (await api(svc, "GET", "/v1/automations")).json()).automations, []);

    const created = await create({ chatroomId: "chr-z", channelId: "9" });
    assertEquals(created.status, 201);
    const { automation, secret } = await created.json();
    assertEquals(automation.response, {
      chatroomId: "chr-z",
      channelId: "9",
      idleMs: 30 * 60_000,
      attendedIdleMs: 60 * 60_000,
      // A raw webhook reads no keys, so its fires join the automation's one open response.
      correlation: "automation",
      postAlert: false,
      conversation: "per-response",
    });
    await fire(svc, automation, secret, '{"status":"firing"}');
    assertEquals(svc.delivered[0].response?.chatroomId, "chr-z");
    assertEquals(svc.delivered[0].response?.channelId, "9");

    // A PATCH re-checks the whole binding: moving to the public channel is refused, as is
    // dropping the channel, and the prior policy is kept both times.
    const moved = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-z", channelId: "7" },
    });
    assertEquals(moved.status, 422);
    assertEquals(
      (await moved.json()).error,
      "response.channelId: a response opens in a private channel only — incidents is public",
    );
    const dropped = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-z" },
    });
    assertEquals(dropped.status, 422);
    const kept = await (await api(svc, "GET", `/v1/automations/${automation.id}`)).json();
    assertEquals(kept.automation.response.channelId, "9");
  } finally {
    await svc.db.close();
  }
});

test("a Discord room's response needs a private channel too", async () => {
  const svc = await makeService({
    chatrooms: {
      "chr-d": {
        platform: "discord",
        channels: [
          { id: "800000000000000011", name: "general", visibility: "public" },
          { id: "800000000000000012", name: "incidents", visibility: "private" },
        ],
      },
    },
  });
  try {
    const create = (response: Record<string, unknown>) =>
      api(svc, "POST", "/v1/automations", webhookCreateBody({ response }));
    const unchannelled = await create({ chatroomId: "chr-d" });
    assertEquals(unchannelled.status, 422);
    assertEquals(
      (await unchannelled.json()).error,
      "response.channelId: a Discord room needs a channel to open each response's conversation in",
    );
    const open = await create({ chatroomId: "chr-d", channelId: "800000000000000011" });
    assertEquals(open.status, 422);
    const created = await create({ chatroomId: "chr-d", channelId: "800000000000000012" });
    assertEquals(created.status, 201);
  } finally {
    await svc.db.close();
  }
});

test("a Slack room's response needs a private channel too", async () => {
  const svc = await makeService({
    chatrooms: {
      "chr-s": {
        platform: "slack",
        channels: [
          { id: "C0OPS", name: "ops", visibility: "public" },
          { id: "C0WAR", name: "war-room", visibility: "private" },
        ],
      },
    },
  });
  try {
    const create = (response: Record<string, unknown>) =>
      api(svc, "POST", "/v1/automations", webhookCreateBody({ response }));

    const unchannelled = await create({ chatroomId: "chr-s" });
    assertEquals(unchannelled.status, 422);
    assertEquals(
      (await unchannelled.json()).error,
      "response.channelId: a Slack room needs a channel to open each response's conversation in",
    );
    const open = await create({ chatroomId: "chr-s", channelId: "C0OPS" });
    assertEquals(open.status, 422);
    assertEquals(
      (await open.json()).error,
      "response.channelId: a response opens in a private channel only — ops is public",
    );

    const created = await create({ chatroomId: "chr-s", channelId: "C0WAR" });
    assertEquals(created.status, 201);
    const { automation, secret } = await created.json();
    assertEquals(automation.response.channelId, "C0WAR");
    await fire(svc, automation, secret, '{"status":"firing"}');
    assertEquals(svc.delivered[0].response?.channelId, "C0WAR");
  } finally {
    await svc.db.close();
  }
});

test("with no chat on the deployment, a response names no chatroom", async () => {
  const svc = await makeService({ chatrooms: null });
  try {
    const named = await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: "chr-1" } }),
    );
    assertEquals(named.status, 422);
    const roomless = await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: null } }),
    );
    assertEquals(roomless.status, 201);
  } finally {
    await svc.db.close();
  }
});

test("a shared conversation needs a channel, holds one response, and rides every fire", async () => {
  const svc = await makeService({
    chatrooms: {
      "chr-z": {
        platform: "zulip",
        channels: [{ id: "9", name: "war-room", visibility: "private" }],
      },
      "chr-tg": "telegram",
    },
  });
  try {
    // A schedule's fires each open a response of their own by default — the very case a shared
    // conversation is for, so there it defaults to the automation's one.
    const daily = (response: Record<string, unknown>) =>
      api(svc, "POST", "/v1/automations", {
        ...webhookCreateBody(),
        trigger: { kind: "schedule", cron: "0 9 * * *" },
        response,
      });
    const perResponse = await daily({ chatroomId: "chr-z", channelId: "9" });
    assertEquals((await perResponse.json()).automation.response.correlation, "fire");
    const created = await daily({ chatroomId: "chr-z", channelId: "9", conversation: "shared" });
    assertEquals(created.status, 201);
    const { automation } = await created.json();
    assertEquals(automation.response.conversation, "shared");
    assertEquals(automation.response.correlation, "automation");

    // Two responses open at once would want the one conversation at once: refused, by name.
    for (const correlation of ["fire", "key"]) {
      const refused = await api(
        svc,
        "POST",
        "/v1/automations",
        webhookCreateBody({
          response: { chatroomId: "chr-z", channelId: "9", conversation: "shared", correlation },
        }),
      );
      assertEquals(refused.status, 422);
      assertEquals(
        (await refused.json()).error,
        'response.correlation: a "shared" conversation holds one response at a time, so only ' +
          'one can be open — use "automation"',
      );
    }
    // A PATCH is held to the same rule, and decides an unnamed correlation the same way.
    const patchedKey = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: {
        chatroomId: "chr-z",
        channelId: "9",
        conversation: "shared",
        correlation: "fire",
      },
    });
    assertEquals(patchedKey.status, 422);
    const back = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-z", channelId: "9" },
    });
    assertEquals((await back.json()).automation.response, {
      chatroomId: "chr-z",
      channelId: "9",
      idleMs: 30 * 60_000,
      attendedIdleMs: 60 * 60_000,
      correlation: "fire",
      postAlert: false,
      conversation: "per-response",
    });
    const again = await api(svc, "PATCH", `/v1/automations/${automation.id}`, {
      response: { chatroomId: "chr-z", channelId: "9", conversation: "shared" },
    });
    assertEquals((await again.json()).automation.response.correlation, "automation");

    // Without a channel there is no conversation to share: no room, or Telegram's one.
    const roomless = await daily({ chatroomId: null, conversation: "shared" });
    assertEquals(roomless.status, 422);
    assertEquals((await roomless.json()).error.startsWith("response.conversation:"), true);
    const telegram = await daily({ chatroomId: "chr-tg", conversation: "shared" });
    assertEquals(telegram.status, 422);
    assertEquals(
      (await telegram.json()).error,
      'response.conversation: a Telegram room is one conversation already — use "per-response"',
    );

    // The policy rides the fire to the orchestrator, which acts on it.
    const hook = await (await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({
        response: { chatroomId: "chr-z", channelId: "9", conversation: "shared" },
      }),
    )).json();
    await fire(svc, hook.automation, hook.secret, '{"status":"firing"}');
    assertEquals(svc.delivered.at(-1)?.response?.conversation, "shared");
  } finally {
    await svc.db.close();
  }
});

test("a policy stored before postAlert and conversation reads with both defaulted", async () => {
  // A database built with db:push never runs the data migrations that write them in.
  const svc = await makeService();
  try {
    const created = await api(
      svc,
      "POST",
      "/v1/automations",
      webhookCreateBody({ response: { chatroomId: "chr-1" } }),
    );
    const { automation } = await created.json();
    await svc.db.handle.db.execute(
      sql`UPDATE "automations" SET "response" = "response" - 'postAlert' - 'conversation'`,
    );
    const read = await svc.store.getAutomation(automation.id);
    assertEquals(read?.response?.postAlert, false);
    assertEquals(read?.response?.conversation, "per-response");
  } finally {
    await svc.db.close();
  }
});
