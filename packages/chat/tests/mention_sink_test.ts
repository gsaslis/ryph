// The HTTP mention sink against a door on a real socket: the token and the mention go out, a
// verdict comes back validated, a 4xx is "malformed", and a 5xx, an unreadable verdict or a dead
// socket are all "failed" — the poller's retry.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assertEquals } from "@std/assert";
import { httpMentionSink } from "../src/adapters/mention_sink/http.ts";
import type { ChatMention } from "../src/core/types.ts";

const MENTION: ChatMention = {
  chatroomId: "chr-1",
  messageId: "101",
  boundRunId: null,
  threadKey: "101",
  channel: { id: "4", name: "bugs", visibility: "public" },
  topic: "crash",
  sender: { id: "8", name: "alice" },
  text: "investigate this",
  hasAttachment: false,
  images: [],
  receivedAt: "2026-09-01T00:00:00.000Z",
};

test("the sink posts to the door with the chat token and reads its answer", async () => {
  const seen: Array<{ path: string; auth: string | null; body: unknown }> = [];
  let answer: () => Response = () =>
    Response.json({ outcome: "started", reply: null, react: true, runId: "r-1", taskId: "t-1" });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    seen.push({
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      body: await req.json(),
    });
    return answer();
  });
  try {
    const sink = httpMentionSink({
      orchestratorUrl: `http://127.0.0.1:${server.addr.port}/`,
      chatToken: "chat-token",
    });
    assertEquals(await sink.deliver(MENTION), {
      kind: "verdict",
      verdict: { outcome: "started", reply: null, react: true, runId: "r-1", taskId: "t-1" },
    });
    assertEquals(seen[0], { path: "/v1/chat/mentions", auth: "Bearer chat-token", body: MENTION });

    answer = () => Response.json({ error: "text: too long" }, { status: 400 });
    assertEquals(await sink.deliver(MENTION), {
      kind: "malformed",
      status: 400,
      error: "text: too long",
    });
    answer = () => Response.json({ error: "database down" }, { status: 503 });
    assertEquals((await sink.deliver(MENTION)).kind, "failed");
    answer = () => Response.json({ outcome: "maybe", reply: null, react: false });
    assertEquals(
      (await sink.deliver(MENTION)).kind,
      "failed",
      "an unreadable verdict is no verdict",
    );
  } finally {
    await server.shutdown();
  }
  const dead = httpMentionSink({ orchestratorUrl: "http://127.0.0.1:1", chatToken: "t" });
  assertEquals((await dead.deliver(MENTION)).kind, "failed");
});

test("a mention's images travel base64 in the same body", async () => {
  let body: unknown = null;
  const sink = httpMentionSink({
    orchestratorUrl: "http://door.test",
    chatToken: "t",
    fetch: ((_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(Response.json({ outcome: "joined", reply: null, react: true }));
    }) as typeof fetch,
  });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const delivered = await sink.deliver({ ...MENTION, text: "[image 1]", images: [{ bytes: png }] });
  assertEquals(delivered.kind, "verdict");
  assertEquals(body, { ...MENTION, text: "[image 1]", images: [{ data: "iVBORw0KGgo=" }] });
});
