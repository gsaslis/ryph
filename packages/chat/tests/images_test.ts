// A mention's images: which files each platform's message names as images, how each is fetched
// with the bot's credential (capped, timed, never naming a token), and how the core checks them
// and says in the text where each one went — over injected fetches, never the network.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { attachImages, neutralizeMarkers, sniffImage } from "../src/core/images.ts";
import {
  imageMarker,
  MAX_MENTION_IMAGE_BYTES,
  MAX_MENTION_IMAGE_TOTAL_BYTES,
  MAX_MENTION_TEXT_CHARS,
} from "../src/core/types.ts";
import {
  isPlainFilePath,
  normalizeUpdate,
  telegramTransport,
} from "../src/adapters/transport/telegram.ts";
import { imageUploads, uploadPath, zulipTransport } from "../src/adapters/transport/zulip.ts";
import { imageFiles, slackTransport } from "../src/adapters/transport/slack.ts";
import type { ImageDownload, ImageSource, PlatformRoom } from "../src/ports/transport.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00");
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0x24,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBPVP8 "),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const never = new AbortController().signal;

/** A source the core is handed, by a name the fake fetch answers for. */
const source = (name: string, over: Partial<ImageSource> = {}): ImageSource => ({
  at: null,
  label: null,
  size: null,
  ref: { kind: "slack", url: name },
  ...over,
});

/** A fetch over a table of answers, recording what was asked under which cap. */
function files(answers: Record<string, ImageDownload>) {
  const asked: Array<{ name: string; maxBytes: number }> = [];
  const fetchImage = (s: ImageSource, maxBytes: number): Promise<ImageDownload> => {
    const name = s.ref.kind === "slack" ? s.ref.url : "?";
    asked.push({ name, maxBytes });
    const got = answers[name] ?? { kind: "failed", error: "gone" };
    return Promise.resolve(
      got.kind === "bytes" && got.bytes.length > maxBytes ? { kind: "too_large" } : got,
    );
  };
  return { fetchImage, asked };
}

// ---- the core ---------------------------------------------------------------------------------

test("the marker is the control plane's form, and the sniff takes the four formats only", () => {
  assertEquals(imageMarker(3), "[image 3]");
  assertEquals(sniffImage(PNG), "image/png");
  assertEquals(sniffImage(JPEG), "image/jpeg");
  assertEquals(sniffImage(GIF), "image/gif");
  assertEquals(sniffImage(WEBP), "image/webp");
  assertEquals(sniffImage(SVG), null);
  assertEquals(sniffImage(new Uint8Array()), null);
});

test("attachImages marks each image where it sat, and says where one could not be taken", async () => {
  const { fetchImage } = files({
    a: { kind: "bytes", bytes: PNG },
    b: { kind: "bytes", bytes: SVG },
    c: { kind: "bytes", bytes: JPEG },
  });
  const out = await attachImages(
    "see [a.png](/a) and [b.png](/b), then [c.png](/c)",
    [
      source("a", { at: "[a.png](/a)" }),
      source("b", { at: "[b.png](/b)" }),
      source("c", { at: "[c.png](/c)" }),
      source("gone"),
    ],
    fetchImage,
  );
  // The bad one keeps its place and its link, and does not take a number.
  assertEquals(
    out.text,
    "see [image 1] and [b.png](/b) (ryph could not open this image: it is not a PNG, JPEG, GIF " +
      "or WebP), then [image 2]\n\n(an image ryph could not open: it could not be downloaded)",
  );
  assertEquals(out.images.map((i) => i.bytes), [PNG, JPEG]);
});

test("attachImages appends images shown apart from the words, with where they came from", async () => {
  const { fetchImage } = files({
    a: { kind: "bytes", bytes: PNG },
    r: { kind: "bytes", bytes: GIF },
  });
  const out = await attachImages(
    "what is this",
    [source("a"), source("r", { label: "from the message this one replies to" })],
    fetchImage,
  );
  assertEquals(
    out.text,
    "what is this\n\n[image 1]\n[image 2] (from the message this one replies to)",
  );
  // A photo with no words is its marker alone.
  assertEquals((await attachImages("", [source("a")], fetchImage)).text, "[image 1]");
  // No images, nothing but the trim.
  assertEquals(await attachImages("  as is ", [], fetchImage), { text: "as is", images: [] });
});

test("attachImages holds the caps: per image, ten at most, and all together", async () => {
  const big = new Uint8Array(MAX_MENTION_IMAGE_BYTES + 1);
  big.set(PNG);
  const { fetchImage, asked } = files({
    a: { kind: "bytes", bytes: PNG },
    big: { kind: "bytes", bytes: big },
  });

  // An announced size over the cap is never fetched; one that streams past it is cut off.
  const sized = await attachImages(
    "",
    [source("a", { size: MAX_MENTION_IMAGE_BYTES + 1 }), source("big")],
    fetchImage,
  );
  assertEquals(sized.images, []);
  assertEquals(asked.map((a) => a.name), ["big"]);
  assertEquals(asked[0].maxBytes, MAX_MENTION_IMAGE_BYTES);
  assertStringIncludes(sized.text, "it is larger than 5 MiB");

  // Past ten, nothing is fetched and the rest are counted.
  asked.length = 0;
  const many = await attachImages("x", Array.from({ length: 12 }, () => source("a")), fetchImage);
  assertEquals(many.images.length, 10);
  assertEquals(asked.length, 10);
  assertStringIncludes(many.text, "[image 10]");
  assertStringIncludes(many.text, "(2 more images were not taken: ryph takes at most 10");

  // All of one mention's images together: what is left shrinks each fetch's cap, and one that
  // would cross it is said to be over the message's total.
  const fiveMiB = new Uint8Array(MAX_MENTION_IMAGE_BYTES);
  fiveMiB.set(PNG);
  const heavy = files({ f: { kind: "bytes", bytes: fiveMiB } });
  const count = Math.floor(MAX_MENTION_IMAGE_TOTAL_BYTES / MAX_MENTION_IMAGE_BYTES);
  const total = await attachImages(
    "",
    [...Array.from({ length: count }, () => source("f")), source("f", { size: 10 }), source("f")],
    heavy.fetchImage,
  );
  assertEquals(total.images.length, count);
  assertStringIncludes(total.text, "the message's images together are more than ryph takes");
});

test("a marker the sender typed is made words, before the real ones are placed", async () => {
  const { fetchImage } = files({
    a: { kind: "bytes", bytes: PNG },
    b: { kind: "bytes", bytes: SVG },
  });
  const out = await attachImages(
    "compare [image 2] with [Image  1 ] and [x.png](/a) and [image 1](/b)",
    [source("a", { at: "[x.png](/a)" }), source("b", { at: "[image 1](/b)" })],
    fetchImage,
  );
  // The one real marker is the only `[image n]`; a dropped link that LOOKED like one is words.
  assertEquals(
    out.text,
    "compare (image 2) with (image 1) and [image 1] and (image 1)(/b) (ryph could not open " +
      "this image: it is not a PNG, JPEG, GIF or WebP)",
  );
  assertEquals(out.text.match(/\[image \d+\]/g), ["[image 1]"]);
  // With no images at all, too: the door would otherwise read it as no ask.
  assertEquals((await attachImages("[image 1]", [], fetchImage)).text, "(image 1)");
  assertEquals(neutralizeMarkers("[image 12] [image] [images 1]"), "(image 12) (image] [images 1]");
  // The control plane's notes and fullwidth brackets are no marker either.
  assertEquals(
    neutralizeMarkers("[image not attached: x] \uFF3Bimage 3\uFF3D"),
    "(image not attached: x] (image 3)",
  );
});

test("a mention's text always fits the door: the sender's words are cut, never a marker or a note", async () => {
  const { fetchImage } = files({
    a: { kind: "bytes", bytes: PNG },
    b: { kind: "bytes", bytes: SVG },
  });
  // Words right at the cap, then images whose markers and notes would push it past.
  const words = "w".repeat(MAX_MENTION_TEXT_CHARS - 4);
  const out = await attachImages(
    `${words} [x.png](/a)`,
    [
      source("a", { at: "[x.png](/a)" }),
      source("a", { label: "from the message this one replies to" }),
      source("b"),
      ...Array.from({ length: 10 }, () => source("a")),
    ],
    fetchImage,
  );
  assert(out.text.length <= MAX_MENTION_TEXT_CHARS, `${out.text.length}`);
  // Ten taken, one of them no image: nine handed over, three counted.
  assertEquals(out.images.length, 9);
  for (let n = 1; n <= 9; n++) assertStringIncludes(out.text, imageMarker(n));
  assertStringIncludes(out.text, "(an image ryph could not open: it is not a PNG");
  assertStringIncludes(out.text, "(3 more images were not taken");
  assert(out.text.endsWith("characters of one)"), out.text.slice(-200));
  assert(out.text.startsWith("www"));
  // The inline marker kept its place after the words that are left.
  assert(/w… \[image 1\]/.test(out.text));

  // Words alone past the cap are cut too, and never through a surrogate pair.
  const long = await attachImages("😀".repeat(MAX_MENTION_TEXT_CHARS), [], fetchImage);
  assert(long.text.length <= MAX_MENTION_TEXT_CHARS);
  assert(!long.text.includes("\uFFFD") && long.text.isWellFormed());
  // Under the cap, nothing is cut.
  const fits = await attachImages("w".repeat(100), [source("a")], fetchImage);
  assertEquals(fits.text, `${"w".repeat(100)}\n\n[image 1]`);
});

test("a Telegram file path is plain segments, none a dot segment", () => {
  assert(isPlainFilePath("photos/file_1.jpg"));
  assert(isPlainFilePath("documents/file_3.png"));
  for (const p of ["../x", "photos/../../x", "./x", "a//b", "/abs", "a%2e%2e/b", "a?b", ""]) {
    assert(!isPlainFilePath(p), p);
  }
});

// ---- Telegram -----------------------------------------------------------------------------------

const TG_BOT = { username: "ryph_bot", id: "123456" };
const tgBase = {
  update_id: 7,
  message: {
    message_id: 1,
    chat: { id: -100200300, type: "supergroup", title: "acme incidents" },
    from: { id: 42, first_name: "Grace" },
  },
};

test("normalizeUpdate reads a caption as the text: a mention there is a mention", () => {
  const msg = normalizeUpdate({
    ...tgBase,
    message: {
      ...tgBase.message,
      caption: "@ryph_bot why is this red",
      caption_entities: [{ type: "mention", offset: 0, length: 9 }],
      photo: [
        { file_id: "small", width: 90, height: 60, file_size: 1_000 },
        { file_id: "large", width: 1280, height: 853, file_size: 120_000 },
      ],
    },
  }, TG_BOT);
  assertEquals(msg?.mentionsBot, true);
  assertEquals(msg?.rawText, "@ryph_bot why is this red");
  assertEquals(msg?.text, "why is this red");
  assertEquals(msg?.hasAttachment, true);
  // The largest size is the one fetched.
  assertEquals(msg?.images, [{
    at: null,
    label: null,
    size: 120_000,
    ref: { kind: "telegram", fileId: "large" },
  }]);
  // A caption's entities are not a text's: the `entities` of a photo message are ignored.
  const wrongEntities = normalizeUpdate({
    ...tgBase,
    message: {
      ...tgBase.message,
      caption: "@ryph_bot hi",
      entities: [{ type: "mention", offset: 0, length: 9 }],
      photo: [{ file_id: "p" }],
    },
  }, TG_BOT);
  assertEquals(wrongEntities?.mentionsBot, false);
});

test("normalizeUpdate: photo sizes under the cap, image files, a replied-to photo, and no others", () => {
  const huge = MAX_MENTION_IMAGE_BYTES + 1;
  const photo = normalizeUpdate({
    ...tgBase,
    message: {
      ...tgBase.message,
      photo: [
        { file_id: "s", file_size: 50_000 },
        { file_id: "m", file_size: 4_000_000 },
        { file_id: "xl", file_size: huge },
      ],
    },
  }, TG_BOT);
  assertEquals(photo?.images.map((i) => i.ref), [{ kind: "telegram", fileId: "m" }]);
  // Every size over the cap: the smallest is offered, and refused by its size unfetched.
  const tooBig = normalizeUpdate({
    ...tgBase,
    message: { ...tgBase.message, photo: [{ file_id: "a", file_size: huge }] },
  }, TG_BOT);
  assertEquals(tooBig?.images[0].size, huge);
  // A file Telegram says is an image; a PDF is not one.
  const files = ["image/png", "application/pdf"].map((mime_type) =>
    normalizeUpdate({
      ...tgBase,
      message: {
        ...tgBase.message,
        text: "@ryph_bot look",
        entities: [{ type: "mention", offset: 0, length: 9 }],
        document: { file_id: "d", mime_type, file_size: 10 },
      },
    }, TG_BOT)?.images.length
  );
  assertEquals(files, [1, 0]);
  // A reply to a photo hands the photo over, after the message's own, saying where it is from.
  const reply = normalizeUpdate({
    ...tgBase,
    message: {
      ...tgBase.message,
      text: "@ryph_bot what is this",
      entities: [{ type: "mention", offset: 0, length: 9 }],
      reply_to_message: { from: { id: 9 }, photo: [{ file_id: "theirs", file_size: 5 }] },
    },
  }, TG_BOT);
  assertEquals(reply?.images, [{
    at: null,
    label: "from the message this one replies to",
    size: 5,
    ref: { kind: "telegram", fileId: "theirs" },
  }]);
});

const TG_ROOM: PlatformRoom = {
  id: "chr-1",
  credential: { kind: "telegram", botToken: "123:tok" },
  bot: { id: "123", name: "ryph_bot" },
  chatId: "-1",
  chatTitle: "g",
};

test("Telegram downloads by getFile, then the file under the token's path, capped", async () => {
  const asked: string[] = [];
  const served: Record<string, () => Response> = {
    "p": () =>
      Response.json({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 6 } }),
    "big": () =>
      Response.json({ ok: true, result: { file_path: "photos/b.jpg", file_size: 10_000 } }),
    "stream": () => Response.json({ ok: true, result: { file_path: "photos/s.jpg" } }),
    "climb": () =>
      Response.json({ ok: true, result: { file_path: "../../bot123:tok/getMe", file_size: 6 } }),
    "gone": () => Response.json({ ok: false, description: "file is too big" }, { status: 400 }),
    // A Bot API server run with --local names a file on its own disk.
    "local": () =>
      Response.json({
        ok: true,
        result: { file_path: "/var/lib/telegram-bot-api/123:tok/photos/file_1.jpg" },
      }),
  };
  const dial = ((input: string, init?: RequestInit) => {
    asked.push(input);
    if (input.endsWith("/getFile")) {
      return Promise.resolve(served[JSON.parse(String(init?.body)).file_id]());
    }
    if (input.endsWith("/photos/file_1.jpg")) return Promise.resolve(new Response(JPEG));
    // A body that announces nothing and keeps coming.
    return Promise.resolve(new Response(new Uint8Array(100)));
  }) as typeof fetch;
  const transport = telegramTransport({ apiUrl: "https://tg.test", fetch: dial });
  const at = (fileId: string, maxBytes = 50) =>
    transport.downloadImage(TG_ROOM, {
      at: null,
      label: null,
      size: null,
      ref: { kind: "telegram", fileId },
    }, { maxBytes, signal: never });

  assertEquals(await at("p"), { kind: "bytes", bytes: JPEG });
  assertEquals(asked, [
    "https://tg.test/bot123:tok/getFile",
    "https://tg.test/file/bot123:tok/photos/file_1.jpg",
  ]);
  // Too large by what getFile said: the file is never asked for.
  asked.length = 0;
  assertEquals(await at("big"), { kind: "too_large" });
  assertEquals(asked.length, 1);
  assertEquals(await at("stream"), { kind: "too_large" });
  // A path that would leave the token's file prefix is never fetched.
  asked.length = 0;
  assertEquals((await at("climb")).kind, "failed");
  assertEquals(asked, ["https://tg.test/bot123:tok/getFile"]);
  // Nor is a local server's absolute path, read off disk or otherwise: said for what it is.
  asked.length = 0;
  const local = await at("local");
  assert(local.kind === "failed" && local.error.includes("--local"), JSON.stringify(local));
  assert(!local.error.includes("tok"), "the token is never named");
  assertEquals(asked, ["https://tg.test/bot123:tok/getFile"]);
  const refused = await at("gone");
  assertEquals(refused.kind, "failed");
  assert(refused.kind === "failed" && !refused.error.includes("tok"), "the token is never named");
});

// ---- Zulip --------------------------------------------------------------------------------------

test("imageUploads finds the image uploads a message links, and nothing else", () => {
  const content = "look [shot.png](/user_uploads/2/ab/AbCdEfGhIjKlMnOpQrStUv12/shot.png) and " +
    "[log.txt](/user_uploads/2/AbCdEfGhIjKlMnOpQrStUv12/log.txt), [a.JPG](/user_uploads/2/AbCdEfGhIjKlMnOpQrStUv12/a.JPG), " +
    "[evil.png](/user_uploads/2/../../evil.png), [far.png](https://elsewhere.test/user_uploads/2/f.png)";
  assertEquals(imageUploads(content), [
    {
      at: "[shot.png](/user_uploads/2/ab/AbCdEfGhIjKlMnOpQrStUv12/shot.png)",
      label: null,
      size: null,
      ref: { kind: "zulip", path: "/user_uploads/2/ab/AbCdEfGhIjKlMnOpQrStUv12/shot.png" },
    },
    {
      at: "[a.JPG](/user_uploads/2/AbCdEfGhIjKlMnOpQrStUv12/a.JPG)",
      label: null,
      size: null,
      ref: { kind: "zulip", path: "/user_uploads/2/AbCdEfGhIjKlMnOpQrStUv12/a.JPG" },
    },
  ]);
});

test("an upload path is judged decoded: no encoded dot segment, slash or second encoding gets through", () => {
  const T = "AbCdEfGhIjKlMnOpQrStUv12";
  // The finding: `%2e%2e` is `..` to the URL parser, and this was an authenticated GET of
  // /api/v1/users/me/presence.png.
  for (
    const path of [
      "/user_uploads/2/%2e%2e/%2e%2e/users/me/presence.png",
      "/user_uploads/2/%2E%2E/%2e%2e/%2e%2e/%2e%2e/x.png",
      `/user_uploads/2/${T}/%2e%2e`,
      `/user_uploads/2/${T}/.`,
      `/user_uploads/2/${T}/..%2fx.png`,
      `/user_uploads/2/${T}%2f..%2f..%2fx.png`,
      `/user_uploads/2/${T}/%252e%252e.png`,
      `/user_uploads/2/${T}/a%5cb.png`,
      `/user_uploads/2/${T}/a.png%3fx=1`,
      `/user_uploads/2/${T}/%E0%A4%A.png`,
      `/user_uploads/2/${T}//a.png`,
      `/user_uploads/2/${T}/`,
      `/user_uploads/2/short/a.png`,
      `/user_uploads/2/zz/${T}/a.png`,
      `/user_uploads/2/ab/cd/${T}/a.png`,
      `/user_uploads/thumbnail/2/${T}/a.png`,
      `/user_uploads/x/${T}/a.png`,
    ]
  ) {
    assertEquals(uploadPath(path), null, path);
    assertEquals(imageUploads(`[x.png](${path})`), [], path);
  }
  // Zulip's two shapes, and a Unicode name, encoded or not, asked for in one canonical form.
  assertEquals(uploadPath(`/user_uploads/2/${T}/a-b_c.1.png`), `/user_uploads/2/${T}/a-b_c.1.png`);
  assertEquals(uploadPath(`/user_uploads/2/f/${T}/a.png`), `/user_uploads/2/f/${T}/a.png`);
  assertEquals(
    uploadPath(`/user_uploads/2/${T}/%C3%A9t%C3%A9.png`),
    `/user_uploads/2/${T}/%C3%A9t%C3%A9.png`,
  );
  assertEquals(
    uploadPath(`/user_uploads/2/${T}/été.png`),
    `/user_uploads/2/${T}/%C3%A9t%C3%A9.png`,
  );
  assertEquals(uploadPath(`/user_uploads/2/${T}/%61.png`), `/user_uploads/2/${T}/a.png`);
});

const ZULIP_ROOM: PlatformRoom = {
  id: "chr-z",
  credential: {
    kind: "zulip",
    realmUrl: "https://zulip.test",
    botEmail: "bot@zulip.test",
    apiKey: "zkey",
  },
  bot: { id: "10", name: "ryph" },
  chatId: null,
  chatTitle: null,
};

test("Zulip downloads through the temporary URL, asked for with the key and spent without it", async () => {
  const asked: Array<{ url: string; auth: string | null }> = [];
  let temporary = "/user_uploads/temporary/tok123/shot.png";
  const dial = ((input: string, init?: RequestInit) => {
    asked.push({ url: input, auth: new Headers(init?.headers).get("authorization") });
    if (input.startsWith("https://zulip.test/api/v1/user_uploads/")) {
      return Promise.resolve(Response.json({ result: "success", msg: "", url: temporary }));
    }
    return Promise.resolve(new Response(PNG, { headers: { "content-type": "image/png" } }));
  }) as typeof fetch;
  const transport = zulipTransport({ fetch: dial });
  const shot: ImageSource = {
    at: null,
    label: null,
    size: null,
    ref: { kind: "zulip", path: "/user_uploads/2/ab/AbCdEfGhIjKlMnOpQrStUv12/shot.png" },
  };
  assertEquals(
    await transport.downloadImage(ZULIP_ROOM, shot, { maxBytes: 100, signal: never }),
    { kind: "bytes", bytes: PNG },
  );
  assertEquals(
    asked[0].url,
    "https://zulip.test/api/v1/user_uploads/2/ab/AbCdEfGhIjKlMnOpQrStUv12/shot.png",
  );
  assert(asked[0].auth?.startsWith("Basic "));
  assertEquals(asked[1], {
    url: "https://zulip.test/user_uploads/temporary/tok123/shot.png",
    auth: null,
  });
  // A URL off the realm is not followed.
  asked.length = 0;
  temporary = "https://elsewhere.test/x.png";
  const off = await transport.downloadImage(ZULIP_ROOM, shot, { maxBytes: 100, signal: never });
  assertEquals(off.kind, "failed");
  assertEquals(asked.length, 1);
  // A path that is not an upload is never asked about, encoded or not.
  for (const path of ["/api/v1/users/me", "/user_uploads/2/%2e%2e/%2e%2e/users/me/presence.png"]) {
    const bad = await transport.downloadImage(ZULIP_ROOM, {
      ...shot,
      ref: { kind: "zulip", path },
    }, { maxBytes: 100, signal: never });
    assertEquals(bad.kind, "failed");
    assertEquals(asked.length, 1);
  }
});

// ---- Slack --------------------------------------------------------------------------------------

test("imageFiles takes Slack's images on its own file host only", () => {
  assertEquals(
    imageFiles([
      { mimetype: "image/png", size: 12, url_private_download: "https://files.slack.com/a.png" },
      { mimetype: "application/pdf", url_private_download: "https://files.slack.com/b.pdf" },
      { mimetype: "image/png", url_private_download: "https://evil.test/c.png" },
      { mimetype: "image/jpeg", mode: "tombstone" },
    ]),
    [{
      at: null,
      label: null,
      size: 12,
      ref: { kind: "slack", url: "https://files.slack.com/a.png" },
    }],
  );
  assertEquals(imageFiles(undefined), []);
});

test("Slack downloads with the bot token, only from its file host, and a sign-in page is no file", async () => {
  const asked: Array<{ url: string; auth: string | null }> = [];
  let page = false;
  const fetcher = ((input: string, init?: RequestInit) => {
    asked.push({ url: input, auth: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(
      page
        ? new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } })
        : new Response(PNG, { headers: { "content-type": "image/png", "content-length": "12" } }),
    );
  }) as typeof fetch;
  const transport = slackTransport({ fetch: fetcher });
  const room: PlatformRoom = {
    id: "chr-s",
    credential: { kind: "slack", botToken: "xoxb-bot", appToken: "xapp-app" },
    bot: { id: "U0BOT", name: "ryph" },
    chatId: null,
    chatTitle: null,
  };
  const file = (url: string): ImageSource => ({
    at: null,
    label: null,
    size: null,
    ref: { kind: "slack", url },
  });
  assertEquals(
    await transport.downloadImage(room, file("https://files.slack.com/a.png"), {
      maxBytes: 100,
      signal: never,
    }),
    { kind: "bytes", bytes: PNG },
  );
  assertEquals(asked, [{ url: "https://files.slack.com/a.png", auth: "Bearer xoxb-bot" }]);
  // A declared length over the cap is refused before a byte is read.
  assertEquals(
    await transport.downloadImage(room, file("https://files.slack.com/a.png"), {
      maxBytes: 5,
      signal: never,
    }),
    { kind: "too_large" },
  );
  // The token never goes anywhere else.
  asked.length = 0;
  const elsewhere = await transport.downloadImage(room, file("https://evil.test/a.png"), {
    maxBytes: 100,
    signal: never,
  });
  assertEquals(elsewhere.kind, "failed");
  assertEquals(asked, []);
  // What Slack serves a token without files:read.
  page = true;
  const signIn = await transport.downloadImage(room, file("https://files.slack.com/a.png"), {
    maxBytes: 100,
    signal: never,
  });
  assertEquals(signIn.kind, "failed");
  assertStringIncludes(signIn.kind === "failed" ? signIn.error : "", "web page");
});
