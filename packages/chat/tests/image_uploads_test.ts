// A run's images on their way out, per platform, against a stand-in API over an injected fetch:
// what each adapter uploads, where it shares them, in what order, under which caption — and what
// it falls back to when the platform will not take them. Then the control plane's side of it,
// on a real socket: the resolve and the bytes, with the chat token.

import { test } from "bun:test";
import { serve } from "@ryph/service";
import { assert, assertEquals } from "@std/assert";
import { slackTransport } from "../src/adapters/transport/slack.ts";
import { telegramTransport } from "../src/adapters/transport/telegram.ts";
import { zulipTransport } from "../src/adapters/transport/zulip.ts";
import { httpRunImages } from "../src/adapters/run_images/http.ts";
import type { OutboundImage, PlatformRoom } from "../src/ports/transport.ts";

const bytesOf = (text: string) => new TextEncoder().encode(text);

function image(label: string, opts: { url?: string | null; fails?: boolean } = {}): OutboundImage {
  return {
    label,
    mime: "image/png",
    url: opts.url === undefined ? `https://app.test/images/r-1/att-${label.length}` : opts.url,
    load: () =>
      opts.fails
        ? Promise.reject(new Error("control plane attachment answered 404"))
        : Promise.resolve(bytesOf(`png:${label}`)),
  };
}

// ── Slack ──────────────────────────────────────────────────────────────────────────────────

const SLACK_ROOM: PlatformRoom = {
  id: "chr-s",
  credential: { kind: "slack", botToken: "xoxb-bot", appToken: "xapp-app" },
  bot: { id: "U0BOT", name: "ryph" },
  chatId: null,
  chatTitle: "Acme",
};

interface SlackCall {
  url: string;
  authorization: string | null;
  params: Record<string, string>;
  bytes: string | null;
}

function fakeSlack(replies: Record<string, (params: Record<string, string>) => Response> = {}) {
  const calls: SlackCall[] = [];
  const fetcher = (async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;
    const isBytes = body instanceof Uint8Array;
    const params = isBytes ? {} : Object.fromEntries(new URLSearchParams(String(body ?? "")));
    calls.push({
      url,
      authorization: headers.get("authorization"),
      params,
      bytes: isBytes ? new TextDecoder().decode(body) : null,
    });
    await Promise.resolve();
    if (url.startsWith("https://files.slack.test/upload/")) return new Response("OK - 12");
    const method = url.split("/").at(-1) ?? "";
    const scripted = replies[method];
    if (scripted !== undefined) return scripted(params);
    if (method === "files.getUploadURLExternal") {
      return Response.json({
        ok: true,
        upload_url: `https://files.slack.test/upload/v1/${params.filename}`,
        file_id: `F-${params.filename}`,
      });
    }
    if (method === "chat.postMessage") return Response.json({ ok: true, ts: "1.000200" });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("slack: each image goes up through the external upload, then all of them are shared into the thread in order", async () => {
  const api = fakeSlack();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const answers = await transport.sendImages(
    SLACK_ROOM,
    { channelId: "C0OPS", topic: "1727530000.000100" },
    [image("login page after the fix"), image("Image 2")],
  );
  assertEquals(answers, [{ kind: "uploaded" }, { kind: "uploaded" }]);

  const tickets = api.calls.filter((c) => c.url.endsWith("files.getUploadURLExternal"));
  assertEquals(tickets.map((c) => c.params), [
    { filename: "image-1.png", length: "28", alt_txt: "login page after the fix" },
    { filename: "image-2.png", length: "11", alt_txt: "Image 2" },
  ]);
  assert(tickets.every((c) => c.authorization === "Bearer xoxb-bot"));
  // The bytes go to the URL Slack answered, raw, and the token does not ride along.
  const uploads = api.calls.filter((c) => c.url.startsWith("https://files.slack.test/upload/"));
  assertEquals(uploads.map((c) => [c.bytes, c.authorization]), [
    ["png:login page after the fix", null],
    ["png:Image 2", null],
  ]);
  const complete = api.calls.filter((c) => c.url.endsWith("files.completeUploadExternal"));
  assertEquals(complete.length, 1, "one share, so the images sit together, in order");
  assertEquals(complete[0].params.channel_id, "C0OPS");
  assertEquals(complete[0].params.thread_ts, "1727530000.000100");
  assertEquals(JSON.parse(complete[0].params.files), [
    { id: "F-image-1.png", title: "login page after the fix" },
    { id: "F-image-2.png", title: "Image 2" },
  ]);
});

test("slack: an image the control plane cannot serve costs only itself", async () => {
  const api = fakeSlack();
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const answers = await transport.sendImages(
    SLACK_ROOM,
    { channelId: "C0OPS", topic: "1.0" },
    [image("one", { fails: true }), image("two")],
  );
  assertEquals(answers, [
    { kind: "failed", error: "control plane attachment answered 404" },
    { kind: "uploaded" },
  ]);
  const complete = api.calls.find((c) => c.url.endsWith("files.completeUploadExternal"));
  assertEquals(JSON.parse(complete?.params.files ?? "[]"), [{ id: "F-image-2.png", title: "two" }]);
});

test("slack: an app without files:write sends the ryph links instead, escaped, in the thread", async () => {
  const api = fakeSlack({
    "files.getUploadURLExternal": () => Response.json({ ok: false, error: "missing_scope" }),
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const answers = await transport.sendImages(
    SLACK_ROOM,
    { channelId: "C0OPS", topic: "1.0" },
    [image("<!channel> before"), image("no link", { url: null })],
  );
  assertEquals(answers, [
    { kind: "linked", reason: "missing_scope" },
    {
      kind: "failed",
      error: "Slack takes no files from this app, and there is no ryph link to send instead",
    },
  ]);
  const post = api.calls.find((c) => c.url.endsWith("chat.postMessage"));
  assertEquals(post?.params.text, "<https://app.test/images/r-1/att-17|&lt;!channel&gt; before>");
  assertEquals(post?.params.thread_ts, "1.0");
  assertEquals(
    api.calls.filter((c) => c.url.endsWith("files.completeUploadExternal")).length,
    0,
  );
});

test("slack: a share Slack refuses fails every image it carried", async () => {
  const api = fakeSlack({
    "files.completeUploadExternal": () => Response.json({ ok: false, error: "not_in_channel" }),
  });
  const transport = slackTransport({ apiUrl: "https://slack.test/api", fetch: api.fetcher });
  const answers = await transport.sendImages(SLACK_ROOM, { channelId: "C0OPS", topic: "1.0" }, [
    image("one"),
  ]);
  assertEquals(answers, [{
    kind: "failed",
    error: "slack files.completeUploadExternal answered 200: not_in_channel",
  }]);
});

// ── Telegram ───────────────────────────────────────────────────────────────────────────────

const TELEGRAM_ROOM: PlatformRoom = {
  id: "chr-t",
  credential: { kind: "telegram", botToken: "123:tok" },
  bot: { id: "123", name: "ryph_bot" },
  chatId: "-100200300",
  chatTitle: "acme",
};

interface TelegramCall {
  method: string;
  fields: Record<string, string>;
  files: Record<string, { name: string; type: string; text: string }>;
}

function fakeTelegram(
  refuse: Set<string> = new Set(),
  answer: () => Response | Promise<Response> = () =>
    Response.json({ ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }, {
      status: 400,
    }),
) {
  const calls: TelegramCall[] = [];
  const fetcher = (async (input, init) => {
    const method = String(input).split("/").at(-1) ?? "";
    const fields: Record<string, string> = {};
    const files: TelegramCall["files"] = {};
    assert(init?.body instanceof FormData, `${method} goes multipart`);
    for (const [key, entry] of init.body.entries()) {
      // bun-types gives FormData's entries as strings alone; a file part is a File at runtime.
      const value = entry as string | File;
      if (typeof value === "string") fields[key] = value;
      else files[key] = { name: value.name, type: value.type, text: await value.text() };
    }
    calls.push({ method, fields, files });
    if (refuse.has(method)) return await answer();
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("telegram: one image is a photo, captioned, into the group", async () => {
  const api = fakeTelegram();
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
  const answers = await transport.sendImages(
    TELEGRAM_ROOM,
    { channelId: "-100200300", topic: null },
    [image("the error page")],
  );
  assertEquals(answers, [{ kind: "uploaded" }]);
  assertEquals(api.calls, [{
    method: "sendPhoto",
    fields: { chat_id: "-100200300", caption: "the error page" },
    files: { photo: { name: "image-1.png", type: "image/png", text: "png:the error page" } },
  }]);
});

test("telegram: several images are one album, in order, each captioned", async () => {
  const api = fakeTelegram();
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
  const answers = await transport.sendImages(
    TELEGRAM_ROOM,
    { channelId: "-100200300", topic: null },
    [image("before"), image("gone", { fails: true }), image("after")],
  );
  assertEquals(answers, [
    { kind: "uploaded" },
    { kind: "failed", error: "control plane attachment answered 404" },
    { kind: "uploaded" },
  ]);
  assertEquals(api.calls.length, 1);
  const [album] = api.calls;
  assertEquals(album.method, "sendMediaGroup");
  assertEquals(JSON.parse(album.fields.media), [
    { type: "photo", media: "attach://image0", caption: "before" },
    { type: "photo", media: "attach://image1", caption: "after" },
  ]);
  assertEquals(album.files.image0.text, "png:before");
  assertEquals(album.files.image1.text, "png:after");
  assertEquals(album.files.image1.name, "image-3.png", "named by its place in the post");
});

test("telegram: the words after the images ride as the album's caption, as HTML, on the first photo only", async () => {
  const api = fakeTelegram();
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
  const answers = await transport.sendImages(
    TELEGRAM_ROOM,
    { channelId: "-100200300", topic: null },
    [image("failing run"), image("passing run")],
    "1. The output starts with `$ deno task …`",
  );
  assertEquals(answers, [{ kind: "uploaded" }, { kind: "uploaded" }]);
  assertEquals(JSON.parse(api.calls[0].fields.media), [
    {
      type: "photo",
      media: "attach://image0",
      caption: "1. The output starts with <code>$ deno task …</code>",
      parse_mode: "HTML",
    },
    { type: "photo", media: "attach://image1" },
  ]);

  const one = fakeTelegram();
  await telegramTransport({ apiUrl: "https://tg.test", fetch: one.fetcher }).sendImages(
    TELEGRAM_ROOM,
    { channelId: "-1", topic: null },
    [image("alone")],
    "**after**",
  );
  assertEquals(one.calls[0].fields, {
    chat_id: "-1",
    caption: "<b>after</b>",
    parse_mode: "HTML",
  });
});

test("telegram: a photo Telegram refuses goes again as the file it is", async () => {
  const api = fakeTelegram(new Set(["sendMediaGroup"]));
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
  const answers = await transport.sendImages(
    TELEGRAM_ROOM,
    { channelId: "-100200300", topic: null },
    [image("a full page"), image("another")],
  );
  assertEquals(answers, [{ kind: "uploaded" }, { kind: "uploaded" }]);
  assertEquals(api.calls.map((c) => c.method), ["sendMediaGroup", "sendDocument", "sendDocument"]);
  assertEquals(api.calls[1].fields, { chat_id: "-100200300", caption: "a full page" });
  assertEquals(api.calls[1].files.document.text, "png:a full page");

  const refused = fakeTelegram(new Set(["sendPhoto", "sendDocument"]));
  const alone = telegramTransport({ apiUrl: "https://tg.test", fetch: refused.fetcher });
  const failed = await alone.sendImages(TELEGRAM_ROOM, { channelId: "-1", topic: null }, [
    image("x"),
  ]);
  assertEquals(failed, [{
    kind: "failed",
    error: "telegram sendDocument answered 400: Bad Request: PHOTO_INVALID_DIMENSIONS",
  }]);
  // The token rides the path; no error names it.
  assert(!JSON.stringify(failed).includes("123:tok"));
});

test("telegram: as files, the words ride the first file that lands, not the first one tried", async () => {
  // The album is refused, then the first file; the second lands and must carry the words, since
  // the service counts them delivered once any image is.
  let refusals = 0;
  const api = fakeTelegram(
    new Set(["sendMediaGroup", "sendDocument"]),
    () =>
      ++refusals <= 2
        ? Response.json({ ok: false, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" }, {
          status: 400,
        })
        : Response.json({ ok: true, result: {} }),
  );
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
  const answers = await transport.sendImages(
    TELEGRAM_ROOM,
    { channelId: "-1", topic: null },
    [image("too big"), image("fits"), image("also fits")],
    "**after**",
  );
  assertEquals(answers, [
    {
      kind: "failed",
      error: "telegram sendDocument answered 400: Bad Request: PHOTO_INVALID_DIMENSIONS",
    },
    { kind: "uploaded" },
    { kind: "uploaded" },
  ]);
  assertEquals(api.calls.map((c) => [c.method, c.fields.caption]), [
    ["sendMediaGroup", undefined],
    ["sendDocument", "<b>after</b>"],
    ["sendDocument", "<b>after</b>"],
    ["sendDocument", undefined],
  ]);
});

test("telegram: a photo that may have landed is reported failed, never sent again", async () => {
  const cases: Array<[() => Response | Promise<Response>, string]> = [
    [
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      "telegram sendPhoto: timed out",
    ],
    [
      () => Response.json({ ok: false, description: "Bad Gateway" }, { status: 502 }),
      "telegram sendPhoto answered 502: Bad Gateway",
    ],
    [
      () =>
        Response.json(
          { ok: false, description: "Too Many Requests: retry after 5" },
          { status: 429 },
        ),
      "telegram sendPhoto answered 429: Too Many Requests: retry after 5",
    ],
    [
      () =>
        Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }),
      "telegram sendPhoto answered 400: Bad Request: chat not found",
    ],
  ];
  for (const [answer, error] of cases) {
    const api = fakeTelegram(new Set(["sendPhoto"]), answer);
    const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: api.fetcher });
    const answers = await transport.sendImages(
      TELEGRAM_ROOM,
      { channelId: "-100200300", topic: null },
      [image("the chart")],
    );
    assertEquals(answers, [{ kind: "failed", error }]);
    assertEquals(api.calls.map((c) => c.method), ["sendPhoto"]);
  }
});

// ── Zulip ──────────────────────────────────────────────────────────────────────────────────

const ZULIP_ROOM: PlatformRoom = {
  id: "chr-z",
  credential: {
    kind: "zulip",
    realmUrl: "https://zulip.test",
    botEmail: "bot@zulip.test",
    apiKey: "key",
  },
  bot: { id: "10", name: "ryph" },
  chatId: null,
  chatTitle: "Radicle",
};

test("zulip: each image is uploaded to the realm, then linked in one message to the topic, in order", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let upload = 0;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body;
    if (body instanceof FormData) {
      const file = body.get("file") as File;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body: await file.text() });
      upload += 1;
      // A server before 9.0 answers `uri` alone.
      const path = `/user_uploads/2/ab/${"x".repeat(23)}${upload}/${file.name}`;
      return Response.json(
        upload === 1
          ? { result: "success", uri: path }
          : { result: "success", uri: path, url: path },
      );
    }
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: Object.fromEntries(new URLSearchParams(String(body ?? ""))),
    });
    return Response.json({ result: "success", id: 99 });
  }) as typeof fetch;
  const transport = zulipTransport({ fetch: fetcher });
  const answers = await transport.sendImages(
    ZULIP_ROOM,
    { channelId: "4", topic: "crash on sync" },
    [image("before [old] @**all**"), image("lost", { fails: true }), image("after")],
  );
  assertEquals(answers, [
    { kind: "uploaded" },
    { kind: "failed", error: "control plane attachment answered 404" },
    { kind: "uploaded" },
  ]);
  assertEquals(calls.slice(0, 2), [
    { method: "POST", path: "/api/v1/user_uploads", body: "png:before [old] @**all**" },
    { method: "POST", path: "/api/v1/user_uploads", body: "png:after" },
  ]);
  assertEquals(calls[2], {
    method: "POST",
    path: "/api/v1/messages",
    body: {
      type: "stream",
      to: "4",
      topic: "crash on sync",
      // The run's words: brackets cannot close the link, a wildcard pages nobody.
      content: `[before (old) @_**all**](/user_uploads/2/ab/${"x".repeat(23)}1/image-1.png)\n` +
        `[after](/user_uploads/2/ab/${"x".repeat(23)}2/image-3.png)`,
    },
  });
});

test("zulip: an upload the realm refuses fails only that image, and nothing links to it", async () => {
  const fetcher = ((_input, init) =>
    Promise.resolve(
      init?.body instanceof FormData
        ? Response.json({ result: "error", code: "BAD_REQUEST", msg: "Upload too large" }, {
          status: 400,
        })
        : Response.json({ result: "success", id: 1 }),
    )) as typeof fetch;
  const transport = zulipTransport({ fetch: fetcher });
  const answers = await transport.sendImages(ZULIP_ROOM, { channelId: "4", topic: "t" }, [
    image("big"),
  ]);
  assertEquals(answers, [{
    kind: "failed",
    error: "zulip POST /user_uploads answered 400 BAD_REQUEST: Upload too large",
  }]);
});

test("zulip: images go up ahead of the words, each answered as the link that shows it, and nothing is posted", async () => {
  const calls: string[] = [];
  const fetcher = ((input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const body = init?.body;
    if (body instanceof FormData) {
      const file = body.get("file") as File;
      return Promise.resolve(
        Response.json({ result: "success", url: `/user_uploads/2/ab/${file.name}` }),
      );
    }
    return Promise.resolve(Response.json({ result: "success", id: 1 }));
  }) as typeof fetch;
  const transport = zulipTransport({ fetch: fetcher });
  assert(transport.uploadImages !== undefined);
  const answers = await transport.uploadImages(ZULIP_ROOM, [
    image("[Ada] [Alice] ok @**all**"),
    image("lost", { fails: true }),
  ]);
  assertEquals(answers, [
    // Brackets cannot close the link or read as a speaker; a wildcard pages nobody.
    { kind: "inline", markup: "[(Ada) (Alice) ok @_**all**](/user_uploads/2/ab/image-1.png)" },
    { kind: "failed", error: "control plane attachment answered 404" },
  ]);
  assertEquals(calls, ["/api/v1/user_uploads"], "uploaded, and no message sent");
});

// ── The control plane ──────────────────────────────────────────────────────────────────────

test("run images: the resolve and the bytes go to the control plane's chat routes with the chat token", async () => {
  const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  let resolveAnswer: () => Response = () =>
    Response.json({
      images: [{
        ref: "img-3f9a1c0b2d4e",
        attachmentId: "att-1",
        mime: "image/png",
        url: "https://app.test/images/r-1/att-1",
      }],
      unknown: ["img-000000000000"],
    });
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    seen.push({
      method: req.method,
      path,
      auth: req.headers.get("authorization"),
      body: req.method === "POST" ? await req.json() : null,
    });
    if (path.endsWith("/images/resolve")) return resolveAnswer();
    if (path.endsWith("/att-1")) {
      return new Response(bytesOf("png bytes"), { headers: { "content-type": "image/png" } });
    }
    return Response.json({ error: "no such attachment" }, { status: 404 });
  });
  try {
    const images = httpRunImages({
      orchestratorUrl: `http://127.0.0.1:${server.addr.port}/`,
      chatToken: "chat-token",
    });
    assertEquals(await images.resolve("r-1", ["img-3f9a1c0b2d4e", "img-000000000000"]), {
      images: [{
        ref: "img-3f9a1c0b2d4e",
        attachmentId: "att-1",
        mime: "image/png",
        url: "https://app.test/images/r-1/att-1",
      }],
      unknown: ["img-000000000000"],
    });
    assertEquals(seen[0], {
      method: "POST",
      path: "/v1/chat/runs/r-1/images/resolve",
      auth: "Bearer chat-token",
      body: { refs: ["img-3f9a1c0b2d4e", "img-000000000000"] },
    });
    assertEquals(new TextDecoder().decode(await images.fetch("r-1", "att-1")), "png bytes");
    assertEquals(seen[1].path, "/v1/chat/runs/r-1/attachments/att-1");
    assertEquals(seen[1].auth, "Bearer chat-token");

    let threw = await images.fetch("r-1", "att-2").then(() => null, (err) => String(err));
    assertEquals(threw, "Error: control plane attachment answered 404");
    resolveAnswer = () => Response.json({ error: "refs: too many" }, { status: 400 });
    threw = await images.resolve("r-1", []).then(() => null, (err) => String(err));
    assertEquals(threw, "Error: the control plane answered 400 resolving images: refs: too many");
    resolveAnswer = () => Response.json({ images: "nope" });
    threw = await images.resolve("r-1", []).then(() => null, (err) => String(err));
    assert(threw?.includes("unreadable resolution"), threw ?? "");
  } finally {
    await server.shutdown();
  }
});
