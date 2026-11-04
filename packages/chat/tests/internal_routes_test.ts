// The orchestrator's surface: service-authed, open a binding (201, or 200 for the same run),
// close it (204, always), check a commander and read a thread — both of which answer 200 with
// the port's own "unknown" / "unavailable" rather than failing as HTTP — and describe a room
// to the agent a run bound to it is about to start.

import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { call, makeApi, makeRoom, makeZulipRoom, SERVICE } from "./api.ts";

const OPEN = (chatroomId: string, runId = "r-1", threadKey = "") => ({
  runId,
  chatroomId,
  agentName: "Ada",
  taskTitle: "automation: api latency",
  runUrl: null,
  conversation: { kind: "thread", threadKey },
});

/** A binding that opens a Zulip topic. */
const OPEN_NEW = (chatroomId: string, runId: string, channelId = "4", topic = "api latency") => ({
  ...OPEN(chatroomId, runId),
  conversation: { kind: "new", channelId, topic },
});

const CLOSE = {
  outcome: "succeeded",
  summary: "done",
  patches: [],
  issues: [
    { repo: "acme/api", number: 4, url: "https://gh/acme/api/issues/4" },
    { repo: "rad:z3gq", number: "8f2a1c9", url: null },
  ],
  runUrl: null,
};

test("every internal route takes the service token and nothing else", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    for (const token of [null, "admin-secret", "user-secret"]) {
      for (
        const [path, body] of [
          ["/internal/v1/bindings", OPEN(room.id)],
          ["/internal/v1/runs/r-1/close", CLOSE],
          ["/internal/v1/commanders/check", { chatroomId: room.id, userId: "8", groupId: "3" }],
          ["/internal/v1/threads/fetch", { chatroomId: room.id, threadKey: "" }],
          ["/internal/v1/threads/continued", {
            chatroomId: room.id,
            previousRunIds: ["r-1"],
            channelId: "4",
          }],
        ] as const
      ) {
        assertEquals((await call(api.handle, "POST", path, body, token)).status, 401, path);
      }
      const context = `/internal/v1/chatrooms/${room.id}/context`;
      assertEquals((await call(api.handle, "GET", context, undefined, token)).status, 401);
    }
  } finally {
    await api.close();
  }
});

test("an opening that carries the alert posts it under the line, in one message", async () => {
  const api = await makeApi();
  try {
    const zulip = await makeZulipRoom(api);
    const opened = await call(api.handle, "POST", "/internal/v1/bindings", {
      ...OPEN_NEW(zulip.id, "r-1"),
      alert: { title: "ApiLatency", payload: '{"status":"firing"}' },
    }, SERVICE);
    assertEquals(opened.status, 201);
    const { binding } = await opened.json();
    const sent = api.zulip.sent.filter((m) => m.topic === "api latency");
    assertEquals(sent.length, 1);
    assertEquals(binding.threadKey, sent[0].id);
    assertStringIncludes(sent[0].text, "is on it.");
    assertStringIncludes(sent[0].text, '**ApiLatency**\n```\n{\n  "status": "firing"\n}\n```');
  } finally {
    await api.close();
  }
});

test("open is a 201, again a 200, a busy conversation a 409, an unknown room a 404; close is a 204", async () => {
  const api = await makeApi();
  try {
    const room = await makeRoom(api);
    const opened = await call(api.handle, "POST", "/internal/v1/bindings", OPEN(room.id), SERVICE);
    assertEquals(opened.status, 201);
    const { binding } = await opened.json();
    assertEquals([binding.runId, binding.threadKey], ["r-1", ""]);
    assertEquals(
      (await call(api.handle, "POST", "/internal/v1/bindings", OPEN(room.id), SERVICE)).status,
      200,
    );
    // A held conversation's 409 says so in a field the caller reads, not in its words.
    const busy = await call(
      api.handle,
      "POST",
      "/internal/v1/bindings",
      OPEN(room.id, "r-2"),
      SERVICE,
    );
    assertEquals(busy.status, 409);
    assertEquals((await busy.json()).reason, "conversation_held");
    assertEquals(
      (await call(api.handle, "POST", "/internal/v1/bindings", OPEN("chr-none"), SERVICE)).status,
      404,
    );
    for (
      const bad of [
        { runId: "r" },
        { ...OPEN(room.id), conversation: undefined },
        // The pre-union top-level key is not read any more.
        { ...OPEN(room.id), conversation: undefined, threadKey: "" },
        { ...OPEN(room.id), conversation: { kind: "thread" } },
        { ...OPEN(room.id), conversation: { kind: "thread", threadKey: "a b" } },
        { ...OPEN(room.id), conversation: { kind: "topic", channelId: "4", topic: "t" } },
        { ...OPEN(room.id), conversation: { kind: "new", channelId: "4" } },
        { ...OPEN(room.id), conversation: { kind: "new", channelId: "", topic: "t" } },
        { ...OPEN(room.id), conversation: { kind: "new", channelId: "4", topic: " " } },
        { ...OPEN(room.id), conversation: { kind: "new", channelId: "4", topic: "a\nb" } },
        { ...OPEN(room.id), conversation: { kind: "new", channelId: "4", topic: "t".repeat(61) } },
        // Well-formed, but a Telegram group has nothing to open.
        OPEN_NEW(room.id, "r-5", "-100200300"),
      ]
    ) {
      assertEquals(
        (await call(api.handle, "POST", "/internal/v1/bindings", bad, SERVICE)).status,
        400,
        JSON.stringify(bad),
      );
    }
    // A Zulip room binds per conversation.
    const zulip = await makeZulipRoom(api);
    api.zulip.locations.set("101", { channel: { id: "4", name: "bugs" }, topic: "t" });
    assertEquals(
      (await call(
        api.handle,
        "POST",
        "/internal/v1/bindings",
        OPEN(zulip.id, "r-3", "101"),
        SERVICE,
      ))
        .status,
      201,
    );
    assertEquals(
      (await call(
        api.handle,
        "POST",
        "/internal/v1/bindings",
        OPEN(zulip.id, "r-4", "102"),
        SERVICE,
      ))
        .status,
      201,
    );
    // ...or opens a topic, and is keyed by the post that opened it. The topic is trimmed.
    const topicOpened = await call(
      api.handle,
      "POST",
      "/internal/v1/bindings",
      OPEN_NEW(zulip.id, "r-5", "4", "  api latency "),
      SERVICE,
    );
    assertEquals(topicOpened.status, 201);
    const { binding: topicBinding } = await topicOpened.json();
    assertEquals(api.zulip.sent.at(-1)?.topic, "api latency");
    assertEquals(topicBinding.threadKey, api.zulip.sent.at(-1)?.id);
    // The platform refusing the opening post is its 502, and binds nothing.
    api.zulip.refuseSends = true;
    const refused = await call(
      api.handle,
      "POST",
      "/internal/v1/bindings",
      OPEN_NEW(zulip.id, "r-6", "4", "another"),
      SERVICE,
    );
    assertEquals(refused.status, 502);
    assertEquals(await api.store.getBindingByRun("r-6"), null);
    api.zulip.refuseSends = false;

    assertEquals(
      (await call(api.handle, "POST", "/internal/v1/runs/r-1/close", CLOSE, SERVICE)).status,
      204,
    );
    assertEquals((await api.store.getBindingByRun("r-1"))?.state, "closed");
    // A run this service never bound: still a 204.
    assertEquals(
      (await call(api.handle, "POST", "/internal/v1/runs/r-9/close", CLOSE, SERVICE)).status,
      204,
    );
    const { issues: _, ...withoutIssues } = CLOSE;
    assertEquals(
      (await call(api.handle, "POST", "/internal/v1/runs/r-1/close", withoutIssues, SERVICE))
        .status,
      400,
    );
  } finally {
    await api.close();
  }
});

test("the commander check and the thread read answer the port's union as JSON", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    api.zulip.membership.set("33:8", "allowed");
    const check = (userId: string) =>
      call(api.handle, "POST", "/internal/v1/commanders/check", {
        chatroomId: room.id,
        userId,
        groupId: "33",
      }, SERVICE);
    assertEquals(await (await check("8")).json(), { verdict: "allowed" });
    assertEquals(await (await check("9")).json(), { verdict: "unknown" });
    assertEquals(
      (await call(
        api.handle,
        "POST",
        "/internal/v1/commanders/check",
        { chatroomId: room.id },
        SERVICE,
      ))
        .status,
      400,
    );

    const fetch = (threadKey: string) =>
      call(api.handle, "POST", "/internal/v1/threads/fetch", {
        chatroomId: room.id,
        threadKey,
      }, SERVICE);
    assertEquals(await (await fetch("404")).json(), { kind: "gone" });
    api.zulip.platformDown = true;
    const down = await fetch("404");
    assertEquals(down.status, 200);
    assertEquals(await down.json(), { kind: "unavailable" });
  } finally {
    await api.close();
  }
});

test("a room's context is 200 with its platform title and the bot's handle, 404 once it is gone", async () => {
  const api = await makeApi();
  try {
    const room = await makeZulipRoom(api);
    const describe = (id: string) =>
      call(api.handle, "GET", `/internal/v1/chatrooms/${id}/context`, undefined, SERVICE);
    const found = await describe(room.id);
    assertEquals(found.status, 200);
    assertEquals(await found.json(), { kind: "zulip", roomTitle: "Radicle", botHandle: "ryph" });
    assertEquals((await describe("chr-none")).status, 404);
    await api.service.archiveChatroom(room.id);
    assertEquals((await describe(room.id)).status, 404);
  } finally {
    await api.close();
  }
});
