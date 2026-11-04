// The forge restates the control plane's image rules — the four formats by their magic numbers,
// the 5 MiB cap, ten images a read — and the thread schema's bounds, because it imports nothing
// of the orchestrator's. Restated rules drift; these tests hold them to the originals, and hold
// what a thread read PRODUCES to the schema that will judge it. Tests sit outside both
// architecture guards, so the import across packages is a test's, never the forge's.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  MAX_THREAD_IMAGE_BYTES,
  MAX_THREAD_IMAGES,
  sniffImage,
} from "../src/helpers/image_download.ts";
import {
  attachThreadImages,
  MAX_ENTRY_ID,
  MAX_IMAGE_MARKUP,
  MAX_IMAGE_NAME,
} from "../src/core/thread_images.ts";
import type { ThreadContext } from "../src/ports/forge_api.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  sniffImage as controlPlaneSniff,
} from "../../orchestrator/src/core/attachments.ts";
import {
  MAX_THREAD_ENTRY_ID,
  MAX_THREAD_IMAGE_MARKUP,
  MAX_THREAD_IMAGE_NAME,
} from "../../orchestrator/src/ports/forge.ts";
import { ForgeThreadContextSchema } from "../../orchestrator/src/schema.ts";
import { composeForgeTask } from "../../orchestrator/src/core/thread_context.ts";
import { githubImages } from "../src/adapters/forge_api/github_images.ts";

test("the forge's image caps are the control plane's", () => {
  assertEquals(MAX_THREAD_IMAGE_BYTES, MAX_ATTACHMENT_BYTES);
  assertEquals(MAX_THREAD_IMAGES, MAX_ATTACHMENTS);
  assertEquals(MAX_IMAGE_MARKUP, MAX_THREAD_IMAGE_MARKUP);
  assertEquals(MAX_ENTRY_ID, MAX_THREAD_ENTRY_ID);
  assert(MAX_IMAGE_NAME <= MAX_THREAD_IMAGE_NAME);
});

test("the forge's sniffImage answers as the control plane's on every signature and its near misses", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const cases = [
    bytes(),
    bytes(...png),
    bytes(...png.slice(0, 7)),
    bytes(0xff, 0xd8, 0xff, 0xe0),
    bytes(0xff, 0xd8),
    bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61),
    bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61),
    bytes(0x47, 0x49, 0x46, 0x38, 0x38, 0x61),
    bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
    bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45),
    bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42),
    new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    new TextEncoder().encode("%PDF-1.7"),
  ];
  for (const sample of cases) {
    assertEquals(sniffImage(sample), controlPlaneSniff(sample), `bytes ${[...sample]}`);
  }
});

test("what a thread read produces at every bound is a thread the control plane reads", async () => {
  const PNG = new Uint8Array(MAX_THREAD_IMAGE_BYTES);
  PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const thread: ThreadContext = {
    kind: "issue",
    ref: "7",
    title: "t",
    body: "",
    authorLogin: "a",
    createdAt: "",
    state: "open",
    entries: [{
      kind: "comment",
      authorLogin: "b",
      body: "x",
      createdAt: "",
      state: null,
      location: null,
      id: "9".repeat(MAX_ENTRY_ID),
    }],
    truncated: false,
    changeRequest: null,
  };
  const image = (markup: string) => ({
    owner: 0 as const,
    markup,
    name: "n".repeat(10_000),
    fetch: () => Promise.resolve({ kind: "image" as const, bytes: PNG }),
  });
  // One `<img>` whose alt text runs past every bound: this used to refuse the whole thread.
  await attachThreadImages(thread, [
    image(`<img alt="${"A".repeat(5_000)}" src="x">`),
    image("m".repeat(MAX_IMAGE_MARKUP)),
  ], null);
  const parsed = ForgeThreadContextSchema.safeParse(JSON.parse(JSON.stringify(thread)));
  assert(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  const images = parsed.data.entries[0].images ?? [];
  assertEquals(images.map((i) => i.kind), ["image", "image"]);
  assertEquals(images.map((i) => i.markup.length), [0, MAX_IMAGE_MARKUP]);
  assertEquals(parsed.data.entries[0].id, thread.entries[0].id);
});

test("an image's marker lands on the markup GitHub rendered, from the forge's read to the prompt", async () => {
  // Each body was rendered by GitHub itself (`gh api -X POST markdown`, 2026-10-05); the HTML
  // is what it answered, with the signed URL a `full+json` read carries in place of the
  // `user-attachments` one. The same markup is spelled more than once in each, and only one of
  // them is where the image sat: finding the first one put the marker in the code block (and
  // left the real image as text), or inside the other image's alt.
  const A = "a6e7968e-9bd1-4f13-aa2e-1eab5d773f38";
  const B = "9a4d77a9-57f2-4ee8-a752-4954f6595979";
  const ua = (uuid: string) => `https://github.com/user-attachments/assets/${uuid}`;
  const signed = (html: string) =>
    [A, B].reduce(
      (out, uuid) =>
        out.replaceAll(
          ua(uuid),
          `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=x`,
        ),
      html,
    );
  const shown = (uuid: string) =>
    `<a target="_blank" rel="noopener noreferrer" href="${ua(uuid)}"><img src="${ua(uuid)}" ` +
    `alt="x" style="max-width: 100%;"></a>`;
  const image = `![x](${ua(A)})`;
  const cases: Array<
    { name: string; body: string; html: string; instructions: string; want: string[] }
  > = [
    {
      name: "a fenced copy first",
      body: "```\n" + image + "\n```\n\nreal: " + image,
      html: `<pre class="notranslate"><code class="notranslate">${image}\n</code></pre>\n` +
        `<p>real: ${shown(A)}</p>`,
      instructions: "fix it",
      want: ["```\n" + image + "\n```\n\nreal: [image 1]"],
    },
    {
      name: "another tag's alt first",
      body: `[^1]: <img alt="${image}" src="${ua(B)}">\n\nsee[^1] and here: ${image}`,
      html: `<p>see<sup><a href="#user-content-fn-1">1</a></sup> and here: ${shown(A)}</p>\n` +
        `<section data-footnotes="" class="footnotes"><ol>\n<li id="user-content-fn-1">\n` +
        `<img alt="${image}" src="${ua(B)}">\n</li>\n</ol>\n</section>`,
      instructions: "fix it",
      want: ["[^1]: [image 1]\n\nsee[^1] and here: [image 2]"],
    },
    {
      name: "the command's own words, a code span between two images",
      body: `before ${image}\n/ryph ada look at \`${image}\` and ${image}`,
      html: `<p>before ${shown(A)}<br>\n/ryph ada look at <code class="notranslate">${image}` +
        `</code> and ${shown(A)}</p>`,
      instructions: `look at \`${image}\` and ${image}`,
      want: [
        `before [image 1]\n/ryph ada look at \`${image}\` and [image 2]`,
        `this, and only this, is what you were asked to do:\n\nlook at \`${image}\` and [image 2]`,
      ],
    },
  ];
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  for (const { name, body, html, instructions, want } of cases) {
    const thread: ThreadContext = {
      kind: "issue",
      ref: "7",
      title: "t",
      body: "",
      authorLogin: "a",
      createdAt: "",
      state: "open",
      entries: [{
        kind: "comment",
        authorLogin: "b",
        body,
        createdAt: "",
        state: null,
        location: null,
        id: "9",
      }],
      truncated: false,
      changeRequest: null,
    };
    const found = githubImages(body, signed(html));
    await attachThreadImages(
      thread,
      found.map((f) => ({
        owner: 0 as const,
        markup: f.markup,
        occurrence: f.occurrence,
        fetch: () => Promise.resolve({ kind: "image" as const, bytes: PNG }),
      })),
      "9",
    );
    const parsed = ForgeThreadContextSchema.parse(JSON.parse(JSON.stringify(thread)));
    const task = composeForgeTask(parsed, {
      instructions,
      actorLogin: "ada-owner",
      provider: "github",
      repoRef: "acme/app",
      checkoutRef: "main",
      checkoutPath: "/workspace/app",
      alongside: [],
      sourceCommentId: "9",
    });
    for (const text of want) assertStringIncludes(task.instructions, text, name);
    assertEquals(task.images.length, found.length, name);
  }
});
