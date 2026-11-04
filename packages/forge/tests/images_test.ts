// An agent's images as each forge carries them (core/images.ts), and the wire to the control
// plane that resolves them (adapters/run_images/http.ts).

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { serve } from "@ryph/service";
import {
  gitBlobOid,
  ImageRefError,
  imageRefsIn,
  MAX_IMAGES_PER_BODY,
  renderImages,
} from "../src/core/images.ts";
import { type FakeRunImage, fakeRunImages } from "../src/adapters/run_images/fake.ts";
import { httpRunImages } from "../src/adapters/run_images/http.ts";
import { git } from "../src/helpers/git_exec.ts";
import { silentDiagnostics } from "./util.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function image(n: number, over: Partial<FakeRunImage> = {}): FakeRunImage {
  const hex = n.toString(16).padStart(12, "0");
  return {
    ref: `img-${hex}`,
    attachmentId: `att-${n}`,
    mime: "image/png",
    url: `https://ryph.test/images/r-1/att-${n}`,
    bytes: PNG,
    ...over,
  };
}

test("refs are found once each, in order, and other images are not refs", () => {
  assertEquals(
    imageRefsIn(
      "![a](img-00000000000b) ![b](https://x/y.png) ![c](<img-00000000000a>) ![C](img-00000000000D) ![d](img-00000000000b)" +
        " ![e](img-123) [f](img-00000000000c)",
    ),
    ["img-00000000000b", "img-00000000000a"],
  );
});

test("GitHub: a link behind ryph's login, alt escaped, empty alt named Image", async () => {
  const images = fakeRunImages({
    "r-1": [image(1), image(2, { url: null }), image(3, { url: "https://ryph.test/a(b)" })],
  });
  const out = await renderImages(
    images,
    "r-1",
    "![a *bold* [x]](img-000000000001) ![](img-000000000001) ![named](img-000000000002) " +
      "![](img-000000000002) ![p](img-000000000003) ![kept](https://elsewhere/x.png)",
    "link",
  );
  assertEquals(
    out.text,
    "[Image: a \\*bold\\* \\[x\\]](https://ryph.test/images/r-1/att-1) " +
      "[Image](https://ryph.test/images/r-1/att-1) named Image " +
      "[Image: p](https://ryph.test/a%28b%29) ![kept](https://elsewhere/x.png)",
  );
  assertEquals(out.embeds, []);
  assertEquals(images.fetched, [], "a link needs no bytes");
});

test("GitHub: a `!` in front of a ref never turns its link into an image", async () => {
  const images = fakeRunImages({ "r-1": [image(1), image(2, { url: null })] });
  const out = await renderImages(
    images,
    "r-1",
    "!![x](img-000000000001) \\!![y](img-000000000001) !![z](img-000000000002)",
    "link",
  );
  assertEquals(
    out.text,
    "\\![Image: x](https://ryph.test/images/r-1/att-1) " +
      "\\![Image: y](https://ryph.test/images/r-1/att-1) !z",
  );
});

test("Radicle: an embed per image, linked by its git blob id", async () => {
  const images = fakeRunImages({ "r-1": [image(1), image(2, { mime: "image/jpeg" })] });
  const out = await renderImages(
    images,
    "r-1",
    "before ![the [old] page](img-000000000001) after ![](img-000000000002) " +
      "again ![x](img-000000000001)",
    "embed",
  );
  // git itself agrees on the id: it is what the bridge stores the blob under.
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await writeFile(`${dir}/shot`, PNG);
    const fromGit = await git(dir, "hash-object", "shot");
    assertEquals(await gitBlobOid(PNG), fromGit);
    assertEquals(
      out.text,
      `before [the (old) page](${fromGit}) after [img-000000000002.jpg](${fromGit}) ` +
        `again [x](${fromGit})`,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
  assertEquals(out.embeds.map((e) => e.name), ["img-000000000001.png", "img-000000000002.jpg"]);
  assertEquals(images.fetched.map((f) => f.attachmentId), ["att-1", "att-2"]);
});

test("an unknown ref, too many refs, or no run refuse with a sentence naming why", async () => {
  const images = fakeRunImages({ "r-1": [image(1)] });
  const unknown = await assertRejects(
    () => renderImages(images, "r-1", "![a](img-000000000001) ![b](img-0000000000ff)", "link"),
    ImageRefError,
  );
  assertStringIncludes(unknown.message, "img-0000000000ff");
  assertStringIncludes(unknown.message, "images are only those a tool returned in this run");
  assertEquals(unknown.message.includes("img-000000000001"), false);

  const many = Array.from(
    { length: MAX_IMAGES_PER_BODY + 1 },
    (_, i) => `![x](img-${i.toString(16).padStart(12, "0")})`,
  ).join(" ");
  const tooMany = await assertRejects(
    () => renderImages(images, "r-1", many, "link"),
    ImageRefError,
  );
  assertStringIncludes(tooMany.message, `at most ${MAX_IMAGES_PER_BODY}`);

  await assertRejects(
    () => renderImages(images, null, "![a](img-000000000001)", "link"),
    ImageRefError,
  );
  await assertRejects(
    () => renderImages(null, "r-1", "![a](img-000000000001)", "link"),
    ImageRefError,
  );
  assertEquals(images.resolved.length, 1, "only the unknown-ref case got as far as asking");
});

test("a body with no refs is handed back untouched, and nobody is asked", async () => {
  const images = fakeRunImages();
  const out = await renderImages(images, null, "plain ![x](https://a/b.png)", "embed");
  assertEquals(out, { text: "plain ![x](https://a/b.png)", embeds: [] });
  assertEquals(images.resolved, []);
});

test("http: resolve and bytes against the orchestrator's routes, service-authed", async () => {
  const seen: Array<{ method: string; path: string; auth: string | null; body: unknown }> = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    seen.push({
      method: req.method,
      path,
      auth: req.headers.get("authorization"),
      body: req.method === "POST" ? await req.json() : null,
    });
    if (path === "/v1/forge/runs/r-1/images/resolve") {
      return Response.json({
        images: [{
          ref: "img-000000000001",
          attachmentId: "att-1",
          mime: "image/png",
          url: "https://ryph.test/images/r-1/att-1",
        }],
        unknown: ["img-000000000002"],
      });
    }
    if (path === "/v1/forge/runs/r-1/attachments/att-1") {
      // The content type lies; the bytes are what decide.
      return new Response(PNG, { headers: { "content-type": "text/plain" } });
    }
    if (path === "/v1/forge/runs/r-1/attachments/att-text") return new Response("hello");
    if (path === "/v1/forge/runs/r-down/images/resolve") return new Response(null, { status: 503 });
    if (path === "/v1/forge/runs/r-odd/images/resolve") return Response.json({ images: "no" });
    return new Response(null, { status: 404 });
  });
  try {
    const images = httpRunImages({
      orchestratorUrl: `http://127.0.0.1:${server.addr.port}/`,
      forgeToken: "forge-secret",
      diag: silentDiagnostics(),
    });
    const resolved = await images.resolve("r-1", ["img-000000000001", "img-000000000002"]);
    assertEquals(resolved.unknown, ["img-000000000002"]);
    assertEquals(resolved.images[0].attachmentId, "att-1");
    assertEquals(seen[0], {
      method: "POST",
      path: "/v1/forge/runs/r-1/images/resolve",
      auth: "Bearer forge-secret",
      body: { refs: ["img-000000000001", "img-000000000002"] },
    });

    const got = await images.bytes("r-1", "att-1");
    assertEquals(got, { bytes: PNG, mime: "image/png" });
    assertEquals(seen[1].auth, "Bearer forge-secret");

    // "Could not ask" is a throw, never "unknown".
    await assertRejects(() => images.resolve("r-down", ["img-000000000001"]));
    await assertRejects(() => images.resolve("r-odd", ["img-000000000001"]));
    await assertRejects(() => images.bytes("r-1", "att-missing"));
    const notImage = await assertRejects(() => images.bytes("r-1", "att-text"));
    assert(notImage instanceof Error && notImage.message.includes("not an image"));
  } finally {
    await server.shutdown();
  }
});
