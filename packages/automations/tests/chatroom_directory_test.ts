// The HTTP directory against a stand-in chat service: the caller's bearer rides along, 404 is
// "no such room", an archived room is none, 403 on the channel list is "forbidden", and anything
// else that is not a 200 throws.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assertEquals, assertRejects } from "@std/assert";
import { httpChatroomDirectory } from "../src/adapters/chatroom_directory/http.ts";

test("the directory reads the room's platform with the caller's bearer", async () => {
  const seen: Array<string | null> = [];
  const rooms: Record<string, unknown> = {
    "chr-tg": { id: "chr-tg", kind: "telegram", archivedAt: null },
    "chr-z": { id: "chr-z", kind: "zulip", archivedAt: null },
    "chr-s": { id: "chr-s", kind: "slack", archivedAt: null },
    "chr-d": { id: "chr-d", kind: "discord", archivedAt: null },
    // A chat service newer than this one: the save refuses rather than guess a room's shape.
    "chr-next": { id: "chr-next", kind: "matrix", archivedAt: null },
    "chr-old": { id: "chr-old", kind: "telegram", archivedAt: "2026-09-01T00:00:00.000Z" },
  };
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    seen.push(req.headers.get("authorization"));
    const id = new URL(req.url).pathname.split("/").at(-1)!;
    if (id === "chr-broken") return new Response("{}", { status: 500 });
    const chatroom = rooms[id];
    return chatroom === undefined
      ? Response.json({ error: "no such chatroom" }, { status: 404 })
      : Response.json({ chatroom });
  });
  try {
    const dir = httpChatroomDirectory({ chatUrl: `http://127.0.0.1:${server.addr.port}/` });
    assertEquals(await dir.platformOf("chr-tg", "Bearer u"), "telegram");
    assertEquals(await dir.platformOf("chr-z", "Bearer u"), "zulip");
    assertEquals(await dir.platformOf("chr-s", "Bearer u"), "slack");
    assertEquals(await dir.platformOf("chr-d", "Bearer u"), "discord");
    assertEquals(await dir.platformOf("chr-old", "Bearer u"), null);
    assertEquals(await dir.platformOf("chr-none", null), null);
    await assertRejects(() => dir.platformOf("chr-broken", "Bearer u"));
    await assertRejects(() => dir.platformOf("chr-next", "Bearer u"));
    assertEquals(seen, [
      "Bearer u",
      "Bearer u",
      "Bearer u",
      "Bearer u",
      "Bearer u",
      null,
      "Bearer u",
      "Bearer u",
    ]);
  } finally {
    await server.shutdown();
  }
});

test("the directory reads the room's channels with the caller's bearer, and 403 is forbidden", async () => {
  const seen: Array<string | null> = [];
  const channels = [
    { id: "7", name: "incidents", visibility: "public" as const },
    { id: "9", name: "war-room", visibility: "private" as const },
  ];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    seen.push(req.headers.get("authorization"));
    const parts = new URL(req.url).pathname.split("/");
    if (parts.at(-1) !== "channels") return new Response("{}", { status: 500 });
    switch (parts.at(-2)) {
      case "chr-z":
        return Response.json({ channels });
      case "chr-theirs":
        return Response.json({ error: "admins only" }, { status: 403 });
      case "chr-broken":
        return Response.json({ error: "the chat platform did not answer" }, { status: 502 });
      case "chr-odd":
        return Response.json({ channels: [{ id: 7 }] });
      default:
        return Response.json({ error: "no such chatroom" }, { status: 404 });
    }
  });
  try {
    const dir = httpChatroomDirectory({ chatUrl: `http://127.0.0.1:${server.addr.port}/` });
    assertEquals(await dir.channelsOf("chr-z", "Bearer u"), {
      kind: "channels",
      channels,
      truncated: false,
    });
    assertEquals(await dir.channelsOf("chr-theirs", "Bearer u"), { kind: "forbidden" });
    assertEquals(await dir.channelsOf("chr-none", null), { kind: "none" });
    await assertRejects(() => dir.channelsOf("chr-broken", "Bearer u"));
    await assertRejects(() => dir.channelsOf("chr-odd", "Bearer u"));
    assertEquals(seen, ["Bearer u", "Bearer u", null, "Bearer u", "Bearer u"]);
  } finally {
    await server.shutdown();
  }
});
