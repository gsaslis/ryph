// A GitLab thread's images: which markdown names an upload of this project on this instance, the
// credentialed read each one becomes — rebuilt from the parsed secret and file name, never the URL
// as written — and how the read degrades. `source.get` is a fake throughout: it records the API
// paths it is asked for, which is everything the slot builder can make the adapter request.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { gitlabImageSlots, gitlabUpload } from "../src/adapters/forge_api/gitlab_images.ts";
import { type ImageFailure, MAX_THREAD_IMAGE_BYTES } from "../src/helpers/image_download.ts";
import {
  attachThreadImages,
  type ImageSlot,
  MAX_SLOTS_PER_ENTRY,
} from "../src/core/thread_images.ts";
import type { GitlabImageSource } from "../src/ports/gitlab.ts";
import type { ThreadContext } from "../src/ports/forge_api.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const SECRET_A = "0123456789abcdef0123456789abcdef";
const SECRET_B = "fedcba9876543210fedcba9876543210";

/** A source for project 42, `group/sub/app`, whose `get` answers `respond` and records paths. */
function source(
  respond: (path: string) => Response | Promise<Response> = () => png(),
  over: Partial<GitlabImageSource> = {},
) {
  const asked: string[] = [];
  const src: GitlabImageSource = {
    instanceUrl: "https://gitlab.example.com",
    projectId: "42",
    projectPath: "group/sub/app",
    get: async (path, signal) => {
      assert(signal instanceof AbortSignal);
      asked.push(path);
      return await respond(path);
    },
    ...over,
  };
  return { src, asked };
}

const png = () => new Response(PNG.slice(), { headers: { "content-type": "image/png" } });

/** What each slot is, without its fetch: markup, occurrence, name, and whether it is fetched. */
const shape = (slots: ImageSlot[]) =>
  slots.map((s) => ({
    owner: s.owner,
    markup: s.markup,
    occurrence: s.occurrence ?? 0,
    name: s.name,
    fetched: s.fetch !== null,
  }));

// ── which URL is an upload ──────────────────────────────────────────────────────────────────

test("gitlabUpload reads the relative, the path and the project-id forms, and whose each is", () => {
  const { src } = source();
  const I = "https://gitlab.example.com";
  assertEquals(gitlabUpload(`/uploads/${SECRET_A}/shot.png`, src), {
    secret: SECRET_A,
    filename: "shot.png",
    own: true,
  });
  assertEquals(gitlabUpload(`${I}/group/sub/app/uploads/${SECRET_A}/a.png`, src)?.own, true);
  // GitLab routes paths case-insensitively.
  assertEquals(gitlabUpload(`${I}/Group/Sub/APP/uploads/${SECRET_A}/a.png`, src)?.own, true);
  assertEquals(gitlabUpload(`${I}/-/project/42/uploads/${SECRET_A}/a.png`, src)?.own, true);
  // Root-relative spellings of the absolute forms are the same upload.
  assertEquals(gitlabUpload(`/group/sub/app/uploads/${SECRET_A}/a.png`, src)?.own, true);
  assertEquals(gitlabUpload(`/-/project/42/uploads/${SECRET_A}/a.png`, src)?.own, true);
  // Another project's upload on this instance is an upload, but not this project's.
  assertEquals(gitlabUpload(`${I}/other/proj/uploads/${SECRET_A}/a.png`, src)?.own, false);
  assertEquals(gitlabUpload(`${I}/-/project/7/uploads/${SECRET_A}/a.png`, src)?.own, false);
  assertEquals(gitlabUpload(`${I}/group/sub/app-2/uploads/${SECRET_A}/a.png`, src)?.own, false);
});

test("gitlabUpload names no upload off the instance, or in any shape GitLab does not write", () => {
  const { src } = source();
  const I = "https://gitlab.example.com";
  for (
    const raw of [
      `https://evil.example/uploads/${SECRET_A}/a.png`,
      `https://gitlab.example.com.evil.example/group/sub/app/uploads/${SECRET_A}/a.png`,
      `http://gitlab.example.com/group/sub/app/uploads/${SECRET_A}/a.png`,
      `https://gitlab.example.com:8443/group/sub/app/uploads/${SECRET_A}/a.png`,
      `https://user:pw@gitlab.example.com/group/sub/app/uploads/${SECRET_A}/a.png`,
      `//evil.example/group/sub/app/uploads/${SECRET_A}/a.png`,
      `${I}/group/sub/app/uploads/${SECRET_A}/a.png?x=1`,
      `${I}/group/sub/app/uploads/${SECRET_A}/a.png#frag`,
      `/uploads/${SECRET_A}/a.png?x=1`,
      // Not a 32-hex secret, a further segment, a missing file, a file that decodes to a path.
      `/uploads/${SECRET_A.slice(1)}/a.png`,
      `/uploads/${SECRET_A.toUpperCase()}/a.png`,
      `/uploads/${SECRET_A}/x/a.png`,
      `/uploads/${SECRET_A}/`,
      `/uploads/${SECRET_A}/..%2Fsecrets`,
      `/uploads/${SECRET_A}/a%5Cb.png`,
      `/uploads/${SECRET_A}/%2E%2E`,
      `/uploads/${SECRET_A}/%E0%A4%A`,
      // A single-segment "project", and a `-` route that is not `-/project/<id>`.
      `${I}/app/uploads/${SECRET_A}/a.png`,
      `${I}/group/-/uploads/${SECRET_A}/a.png`,
      `${I}/-/project/abc/uploads/${SECRET_A}/a.png`,
      "https://img.shields.io/badge/x-y-green.svg",
      "not a url at all",
    ]
  ) assertEquals(gitlabUpload(raw, src), null, raw);
});

test("gitlabUpload on a self-managed instance under a path prefix needs the prefix", () => {
  const { src } = source(undefined, { instanceUrl: "https://git.corp.example/gitlab" });
  const I = "https://git.corp.example/gitlab";
  assertEquals(gitlabUpload(`${I}/group/sub/app/uploads/${SECRET_A}/a.png`, src)?.own, true);
  assertEquals(gitlabUpload(`${I}/-/project/42/uploads/${SECRET_A}/a.png`, src)?.own, true);
  assertEquals(gitlabUpload(`/gitlab/group/sub/app/uploads/${SECRET_A}/a.png`, src)?.own, true);
  // The relative form is the project's whatever the prefix.
  assertEquals(gitlabUpload(`/uploads/${SECRET_A}/a.png`, src)?.own, true);
  // Without the prefix it is some other app on the same host.
  assertEquals(
    gitlabUpload(`https://git.corp.example/group/sub/app/uploads/${SECRET_A}/a.png`, src),
    null,
  );
  assertEquals(
    gitlabUpload(`https://git.corp.example/gitlabx/group/app/uploads/${SECRET_A}/a.png`, src),
    null,
  );
});

// ── which markdown is an image, and where it sits ───────────────────────────────────────────

test("gitlabImageSlots finds `![]()` and `<img>` uploads in order, with their markup and name", () => {
  const { src } = source();
  const body = [
    `Broken here: ![shot](/uploads/${SECRET_A}/shot.png)`,
    `and <img width="300" alt="zoom" src="https://gitlab.example.com/group/sub/app/uploads/${SECRET_B}/zoom.png">`,
    `plus ![titled](</uploads/${SECRET_B}/my%20file.png> "a title")`,
    `and a badge ![ci](https://img.shields.io/badge/ci-ok-green.svg) that stays text.`,
  ].join("\n");
  assertEquals(shape(gitlabImageSlots(3, body, src)), [
    {
      owner: 3,
      markup: `![shot](/uploads/${SECRET_A}/shot.png)`,
      occurrence: 0,
      name: "shot.png",
      fetched: true,
    },
    {
      owner: 3,
      markup:
        `<img width="300" alt="zoom" src="https://gitlab.example.com/group/sub/app/uploads/${SECRET_B}/zoom.png">`,
      occurrence: 0,
      name: "zoom.png",
      fetched: true,
    },
    {
      owner: 3,
      markup: `![titled](</uploads/${SECRET_B}/my%20file.png> "a title")`,
      occurrence: 0,
      name: "my file.png",
      fetched: true,
    },
  ]);
});

test("gitlabImageSlots leaves code, comments, links and media alone", () => {
  const { src } = source();
  const up = `/uploads/${SECRET_A}/a.png`;
  const body = [
    "```",
    `![fenced](${up})`,
    "```",
    `> ~~~`,
    `> ![quoted fence](${up})`,
    `> ~~~`,
    `Inline \`![span](${up})\` and \`\`<img src="${up}">\`\`.`,
    `<!-- ![hidden](${up}) -->`,
    `A link [not an image](${up}) and a bare ${up}.`,
    `A video ![clip](/uploads/${SECRET_B}/clip.mp4).`,
    `An unclosed <img src="${up}"`,
    "",
    `The one: ![real](${up})`,
  ].join("\n");
  assertEquals(shape(gitlabImageSlots("body", body, src)).map((s) => s.markup), [
    `![real](${up})`,
  ]);
});

test("gitlabImageSlots reads an <img>'s own src and treats markup inside its alt as text", () => {
  const { src } = source();
  const a = `/uploads/${SECRET_A}/a.png`;
  const b = `/uploads/${SECRET_B}/b.png`;
  const tag = `<img alt="see ![x](${b}) and src=${b}" src="${a}">`;
  const found = gitlabImageSlots("body", `${tag} and ![y](${b})`, src);
  assertEquals(found.map((s) => [s.markup, s.name]), [[tag, "a.png"], [`![y](${b})`, "b.png"]]);
  // Entities in the attribute are decoded before the URL is read.
  const escaped =
    `<img src="https://gitlab.example.com/-/project/42/uploads/${SECRET_A}/a&amp;b.png">`;
  assertEquals(gitlabImageSlots("body", escaped, src).map((s) => s.name), ["a&b.png"]);
});

test("gitlabImageSlots says which spelling of its markup each image is", () => {
  const { src } = source();
  const m = `![s](/uploads/${SECRET_A}/s.png)`;
  const body = `\`${m}\` quoted, then ${m} and ${m}`;
  assertEquals(shape(gitlabImageSlots("body", body, src)).map((s) => s.occurrence), [1, 2]);
});

test("gitlabImageSlots slots another project's upload unfetched and never asks for it", async () => {
  const { src, asked } = source();
  const body = [
    `![theirs](https://gitlab.example.com/other/secret-proj/uploads/${SECRET_A}/leak.png)`,
    `![theirs too](https://gitlab.example.com/-/project/7/uploads/${SECRET_B}/leak.png)`,
  ].join("\n");
  const slots = gitlabImageSlots("body", body, src);
  assertEquals(shape(slots).map((s) => [s.name, s.fetched]), [
    ["leak.png", false],
    ["leak.png", false],
  ]);
  const context = { kind: "issue", body, state: "open", entries: [] } as unknown as ThreadContext;
  await attachThreadImages(context, slots, null);
  assertEquals(context.bodyImages?.map((i) => i.kind === "omitted" ? i.reason : "image"), [
    "unavailable",
    "unavailable",
  ]);
  assertEquals(asked, []);
});

test("gitlabImageSlots stops at MAX_SLOTS_PER_ENTRY, and a hostile body stays cheap", () => {
  const { src } = source();
  const many = Array.from(
    { length: MAX_SLOTS_PER_ENTRY + 20 },
    (_, i) => `![${i}](/uploads/${SECRET_A}/${i}.png)`,
  ).join(" ");
  assertEquals(gitlabImageSlots("body", many, src).length, MAX_SLOTS_PER_ENTRY);

  const started = performance.now();
  const hostile = "<img src=".repeat(20_000) + "![".repeat(50_000) + "`".repeat(30_000) +
    "<!--".repeat(20_000);
  assertEquals(gitlabImageSlots("body", hostile, src), []);
  assert(performance.now() - started < 2_000, "the scan stays linear");
});

// ── the credentialed read ───────────────────────────────────────────────────────────────────

test("a slot's fetch asks for the rebuilt upload route and nothing else", async () => {
  const { src, asked } = source();
  const body = [
    `![a](https://gitlab.example.com/Group/Sub/App/uploads/${SECRET_A}/my%20shot.png)`,
    `![b](/uploads/${SECRET_B}/b%23c.png)`,
  ].join("\n");
  const outcomes = await Promise.all(
    gitlabImageSlots("body", body, src).map((s) => s.fetch!(new AbortController().signal)),
  );
  assertEquals(outcomes, [{ kind: "image", bytes: PNG }, { kind: "image", bytes: PNG }]);
  assertEquals(asked, [
    `/projects/42/uploads/${SECRET_A}/my%20shot.png`,
    `/projects/42/uploads/${SECRET_B}/b%23c.png`,
  ]);
});

test("a read degrades to an omission: old instance, no access, redirect, size, format, failure", async () => {
  const cases: Array<[string, () => Response | Promise<Response>, ImageFailure]> = [
    // GitLab before 17.4 has no such route.
    ["404", () => new Response('{"error":"404 Not Found"}', { status: 404 }), "unavailable"],
    ["403", () => new Response("{}", { status: 403 }), "unavailable"],
    [
      "302 to a bucket",
      () => new Response(null, { status: 302, headers: { location: "https://bucket.example/x" } }),
      "unavailable",
    ],
    ["500", () => new Response("", { status: 500 }), "unavailable"],
    [
      "declared too large",
      () =>
        new Response(PNG.slice(), {
          headers: { "content-length": String(MAX_THREAD_IMAGE_BYTES + 1) },
        }),
      "too_large",
    ],
    [
      "streamed too large",
      () => new Response(new Uint8Array(MAX_THREAD_IMAGE_BYTES + 1)),
      "too_large",
    ],
    [
      "svg",
      () => new Response(SVG.slice(), { headers: { "content-type": "image/png" } }),
      "unsupported",
    ],
    ["empty", () => new Response(new Uint8Array()), "unsupported"],
    ["thrown", () => Promise.reject(new Error("network down")), "unavailable"],
  ];
  for (const [what, respond, reason] of cases) {
    const { src } = source(respond);
    const [slot] = gitlabImageSlots("body", `![a](/uploads/${SECRET_A}/a.png)`, src);
    assertEquals(
      await slot.fetch!(new AbortController().signal),
      { kind: "omitted", reason },
      what,
    );
  }
});

test("a read's budget aborts the request in flight", async () => {
  let seen: AbortSignal | null = null;
  const { src } = source(undefined, {
    get: (_path, signal) => {
      seen = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason))
      );
    },
  });
  const [slot] = gitlabImageSlots("body", `![a](/uploads/${SECRET_A}/a.png)`, src);
  const budget = new AbortController();
  const pending = slot.fetch!(budget.signal);
  budget.abort();
  assertEquals(await pending, { kind: "omitted", reason: "unavailable" });
  assert(seen !== null && (seen as AbortSignal).aborted);
});

test("slots carry a thread's images onto the body and the entries", async () => {
  const { src } = source((path) =>
    path.includes(SECRET_B) ? new Response("", { status: 404 }) : png()
  );
  const body = `Report ![one](/uploads/${SECRET_A}/one.png)`;
  const note = `Also ![two](/uploads/${SECRET_B}/two.png)`;
  const context = {
    kind: "issue",
    body,
    state: "open",
    entries: [{ id: "issue-1:9", author: "a", body: note }],
  } as unknown as ThreadContext;
  await attachThreadImages(context, [
    ...gitlabImageSlots("body", body, src),
    ...gitlabImageSlots(0, note, src),
  ], null);
  assertEquals(context.bodyImages, [{
    kind: "image",
    markup: `![one](/uploads/${SECRET_A}/one.png)`,
    name: "one.png",
    data: PNG.toBase64(),
  }]);
  assertEquals(context.entries[0].images, [{
    kind: "omitted",
    markup: `![two](/uploads/${SECRET_B}/two.png)`,
    name: "two.png",
    reason: "unavailable",
  }]);
});
