// A thread's images, as the forge reads them: which markdown is an image, where its bytes may be
// downloaded from (and where they may not), which images a read takes when there are too many,
// and both adapters carrying them on the thread. Fake servers on 127.0.0.1 throughout — the
// fixture HTML is GitHub's own shape, copied from a real `full+json` read (2026-10-04).

import { test } from "bun:test";
import { assert, assertEquals, assertExists } from "@std/assert";
import { serve } from "@ryph/service";
import { githubImages, uploadKey } from "../src/adapters/forge_api/github_images.ts";
import { githubForgeApi } from "../src/adapters/forge_api/github.ts";
import { radicleForgeApi } from "../src/adapters/forge_api/radicle.ts";
import {
  downloadImage,
  MAX_THREAD_IMAGE_BYTES,
  MAX_THREAD_IMAGES,
  onAllowedOrigin,
  sniffImage,
} from "../src/helpers/image_download.ts";
import {
  attachThreadImages,
  type ImageSlot,
  MAX_IMAGE_MARKUP,
  MAX_IMAGE_NAME,
} from "../src/core/thread_images.ts";
import type { ThreadContext, ThreadImage } from "../src/ports/forge_api.ts";
import { silentDiagnostics } from "./util.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const UUID_A = "a6e7968e-9bd1-4f13-aa2e-1eab5d773f38";
const UUID_B = "9a4d77a9-57f2-4ee8-a752-4954f6595979";

/** A server that answers `respond`, records every request and its headers. */
async function fakeServer(respond: (req: Request, path: string) => Response | Promise<Response>) {
  const seen: Array<{ path: string; headers: Headers }> = [];
  const server = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    seen.push({ path, headers: req.headers });
    return respond(req, path);
  });
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    seen,
    shutdown: () => server.shutdown(),
  };
}

const png = () => new Response(PNG.slice(), { headers: { "content-type": "image/png" } });

// ── which markdown is an image, and where its bytes are ─────────────────────────────────────

test("githubImages matches each upload to its signed URL by identity, in the order rendered", () => {
  // Today's paste (an `<img>` tag), and an older `![]()`, out of order in the HTML on purpose:
  // each still takes its own markup, by UUID. (GitHub renders in reading order; the HTML's order
  // is the one kept.)
  const markdown = `<img width="784" height="519" alt="Image" ` +
    `src="https://github.com/user-attachments/assets/${UUID_A}" />\n\nand then\n\n` +
    `![shot](https://github.com/user-attachments/assets/${UUID_B})`;
  const signed = (uuid: string) =>
    `https://private-user-images.githubusercontent.com/1018218/665064416-${uuid}.png?jwt=eyJ0&amp;x=1`;
  const html = `<p><a href="${signed(UUID_B)}"><img src="${signed(UUID_B)}" alt="shot"></a></p>` +
    `<a target="_blank" href="${signed(UUID_A)}"><img width="784" alt="Image" ` +
    `src="${signed(UUID_A)}" style="max-width: 100%;"></a>`;
  const found = githubImages(markdown, html);
  assertEquals(found.map((f) => f.markup), [
    `![shot](https://github.com/user-attachments/assets/${UUID_B})`,
    `<img width="784" height="519" alt="Image" src="https://github.com/user-attachments/assets/${UUID_A}" />`,
  ]);
  // The entity is undone: the URL is the one GitHub signed, not the one its HTML escaped.
  assertEquals(found.map((f) => f.url), [
    signed(UUID_B).replace("&amp;", "&"),
    signed(UUID_A).replace("&amp;", "&"),
  ]);
});

test("githubImages keeps a legacy upload's own URL and leaves everything that is not an upload as text", () => {
  const legacy = `https://user-images.githubusercontent.com/4406983/201892998-${UUID_A}.png`;
  const markdown = `![image](${legacy})\n` +
    "![badge](https://img.shields.io/badge/ci-green.svg)\n" +
    "![hotlink](https://evil.example/x.png)\n" +
    '```html\n<img src="https://github.com/user-attachments/assets/' + UUID_B + '">\n```';
  const html = `<img src="${legacy}" alt="image">` +
    `<img src="https://camo.githubusercontent.com/abc/def" alt="badge">` +
    `<img src="https://camo.githubusercontent.com/123/456" alt="hotlink">` +
    `<pre><code>&lt;img src="https://github.com/user-attachments/assets/${UUID_B}"&gt;</code></pre>`;
  const found = githubImages(markdown, html);
  // The badge and the hotlink are images of somewhere else, and the quoted tag inside a code
  // block was never rendered: none of them is something this service downloads.
  assertEquals(found, [{ markup: `![image](${legacy})`, occurrence: 0, key: UUID_A, url: legacy }]);
});

test("githubImages reads an <img>'s real src, never one spelled inside another attribute", () => {
  const signed = (uuid: string) =>
    `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=x`;
  // The alt, written first, spells a src and a `>`: the tag's src is still B, in the markdown
  // and in the HTML alike.
  const decoy = `alt=' src="https://github.com/user-attachments/assets/${UUID_A}" > '`;
  const markdown = `<img ${decoy} src="https://github.com/user-attachments/assets/${UUID_B}">`;
  // GitHub's HTML escapes the `>`; a title there spells a signed URL of A.
  const html = `<img ${decoy.replace(">", "&gt;")} title=' src="${signed(UUID_A)}"' ` +
    `src="${signed(UUID_B)}">`;
  assertEquals(githubImages(markdown, html), [
    { markup: markdown, occurrence: 0, key: UUID_B, url: signed(UUID_B) },
  ]);
  // Bare and single-quoted values, `SRC` in capitals, a second src ignored as a browser does.
  assertEquals(
    githubImages(
      `<IMG SRC=https://github.com/user-attachments/assets/${UUID_A} src="https://github.com/user-attachments/assets/${UUID_B}">`,
      `<img src='${signed(UUID_A)}'>`,
    ).map((f) => f.key),
    [UUID_A],
  );
  // A tag never closed is no tag, so it is not where the image sat — but whether there IS an
  // image is the HTML's to say: kept, its marker after the text.
  assertEquals(
    githubImages(
      `<img src="https://github.com/user-attachments/assets/${UUID_A}"`,
      `<img src="${signed(UUID_A)}">`,
    ),
    [{ markup: "", occurrence: 0, key: UUID_A, url: signed(UUID_A) }],
  );
  // An <img> spelled inside another tag's quoted alt is that alt's text, never a second tag.
  const inner = `<img src="https://github.com/user-attachments/assets/${UUID_A}">`;
  assertEquals(
    githubImages(
      `<img alt='${inner}' src="https://github.com/user-attachments/assets/${UUID_B}">`,
      `<img src="${signed(UUID_B)}">`,
    ).map((f) => f.key),
    [UUID_B],
  );
});

// Every case below was rendered by GitHub itself (`gh api -X POST markdown`, 2026-10-05): the
// HTML is the shape it answered, with the signed URL a `full+json` read carries in place of the
// `user-attachments` one. Each once lost or misplaced an image.
const ua = (uuid: string) => `https://github.com/user-attachments/assets/${uuid}`;
const sig = (uuid: string) =>
  `https://private-user-images.githubusercontent.com/1/2-${uuid}.png?jwt=x`;
const shown = (uuid: string) =>
  `<a target="_blank" rel="noopener noreferrer" href="${sig(uuid)}">` +
  `<img src="${sig(uuid)}" alt="Image" style="max-width: 100%;"></a>`;
const paste = (uuid: string) => `<img width="784" alt="Image" src="${ua(uuid)}" />`;

test("githubImages takes which images from the HTML and only their place from the markdown", () => {
  const cases: Array<[string, string, string, Array<[string, string]>]> = [
    [
      "a code span holding an unclosed tag, then a paste",
      'Wrap it in `<img src="…"` and then:\n\n' + `<img width=784 alt="Image" src=${ua(UUID_A)} />`,
      `<p>Wrap it in <code>&lt;img src="…"</code> and then:</p>${shown(UUID_A)}`,
      [[UUID_A, `<img width=784 alt="Image" src=${ua(UUID_A)} />`]],
    ],
    [
      "a code span holding an unclosed quote",
      'the bug: `<img alt="` breaks\n\n' + `<img src="${ua(UUID_A)}" width="300">`,
      `<p>the bug: <code>&lt;img alt="</code> breaks</p>${shown(UUID_A)}`,
      [[UUID_A, `<img src="${ua(UUID_A)}" width="300">`]],
    ],
    [
      "a fence holding an unclosed quote",
      '```html\n<img alt="foo\n```\n\n' +
      `<img src=${ua(UUID_A)} width=1>\n<img src=${ua(UUID_B)} width=1>`,
      `<pre><code>&lt;img alt="foo\n</code></pre>${shown(UUID_A)}\n${shown(UUID_B)}`,
      [
        [UUID_A, `<img src=${ua(UUID_A)} width=1>`],
        [UUID_B, `<img src=${ua(UUID_B)} width=1>`],
      ],
    ],
    [
      "a tag left open is text, the next paragraph's is an image",
      `<img src="${ua(UUID_A)}"\n\nsecond: <img src="${ua(UUID_B)}">`,
      `<p>&lt;img src="${ua(UUID_A)}"</p><p>second: ${shown(UUID_B)}</p>`,
      [[UUID_B, `<img src="${ua(UUID_B)}">`]],
    ],
    [
      "an unclosed single quote, then a paste",
      `<img alt='oops\n\n${paste(UUID_A)}`,
      `<p>&lt;img alt='oops</p>${shown(UUID_A)}`,
      [[UUID_A, paste(UUID_A)]],
    ],
    [
      "an apostrophe in a code span, then a paste on the same line",
      "The `<img alt='x` case fails, see " + paste(UUID_A),
      `<p>The <code>&lt;img alt='x</code> case fails, see ${shown(UUID_A)}</p>`,
      [[UUID_A, paste(UUID_A)]],
    ],
    [
      "an upload quoted in a code span, shown later",
      `Earlier I used \`<img src="${ua(UUID_A)}"\` like this, now it looks like ${paste(UUID_B)}` +
      `\n\nand before: ${paste(UUID_A)}`,
      `<p>Earlier I used <code>&lt;img src="${ua(UUID_A)}"</code> like this, now it looks like ` +
      `${shown(UUID_B)}</p><p>and before: ${shown(UUID_A)}</p>`,
      [[UUID_B, paste(UUID_B)], [UUID_A, paste(UUID_A)]],
    ],
  ];
  for (const [name, markdown, html, want] of cases) {
    const found = githubImages(markdown, html);
    assertEquals(found.map((f) => [f.key, f.markup]), want, name);
    for (const f of found) assert(markdown.includes(f.markup), name);
  }
});

test("githubImages places the n-th rendered image of an upload at the n-th time the markdown shows it", () => {
  // The same upload three times: a bare mention, a link and a code span are passed over, each
  // rendered image takes the next markup that showed it, and one the markdown cannot place
  // (a reference definition names it once for two uses) trails the text.
  const markdown =
    `see ${ua(UUID_A)} or [the link](${ua(UUID_A)}) or \`![x](${ua(UUID_A)})\`:\n\n` +
    `![first](${ua(UUID_A)}) then <img width=1 src="${ua(UUID_A)}">\n\n![ref][r]\n\n[r]: ${
      ua(UUID_A)
    }`;
  const html = `<p>see …</p><p>${shown(UUID_A)} then ${shown(UUID_A)}</p><p>${shown(UUID_A)}</p>`;
  assertEquals(githubImages(markdown, html).map((f) => f.markup), [
    `![first](${ua(UUID_A)})`,
    `<img width=1 src="${ua(UUID_A)}">`,
    "",
  ]);
  // A src spelling the UUID twice (a copied signed URL, its query naming it again) is one
  // image's markup, never two.
  const twice = `<img src="${sig(UUID_A).replace("jwt=x", `jwt=${UUID_A}`)}">`;
  assertEquals(
    githubImages(twice, shown(UUID_A) + shown(UUID_A)).map((f) => f.markup),
    [twice, ""],
  );
  // A URL that is not the upload's own, spelling its UUID, is no placement for it.
  assertEquals(
    githubImages(`<img src="https://evil.example/${UUID_A}.png">`, shown(UUID_A)).map((f) =>
      f.markup
    ),
    [""],
  );
});

test("githubImages leaves out what a cut body never names, and trails it in a whole one", () => {
  // The kept start of a longer body: upload B is rendered, but its markup is past the cut.
  const markdown = `look ${paste(UUID_A)} and then`;
  const html = `<p>look ${shown(UUID_A)} and then … ${shown(UUID_B)}</p>`;
  assertEquals(githubImages(markdown, html, undefined, { truncated: true }).map((f) => f.key), [
    UUID_A,
  ]);
  assertEquals(githubImages(markdown, html).map((f) => [f.key, f.markup]), [
    [UUID_A, paste(UUID_A)],
    [UUID_B, ""],
  ]);
  // One the kept text does name but this cannot place — a reference-style image, or one past
  // the cap on looks — may well be in the text the reader sees: it trails, cut or not.
  const reference = `![shot][r]\n\n[r]: ${ua(UUID_B)}`;
  assertEquals(
    githubImages(reference, shown(UUID_B), undefined, { truncated: true }).map((f) => f.markup),
    [""],
  );
  // Spelled with a character reference, which GitHub decodes before it signs (measured).
  const escaped = `<img src="${ua(UUID_B).replace("-", "&#45;")}">`;
  assertEquals(
    githubImages(escaped, shown(UUID_B), undefined, { truncated: true }).map((f) => f.key),
    [UUID_B],
  );
  const crowded = `${ua(UUID_A)} `.repeat(300) + paste(UUID_A);
  assertEquals(
    githubImages(crowded, shown(UUID_A), undefined, { truncated: true }).map((f) => f.key),
    [UUID_A],
  );
});

test("githubImages says which spelling of its markup each image is", () => {
  // GitHub renders the fenced copy as code and the footnote's image last; the n-th match of
  // the very same text is the one that showed each (a fence, another tag's alt, a plain repeat).
  const image = `![x](${ua(UUID_A)})`;
  const occurrences = (markdown: string, html: string) =>
    githubImages(markdown, html).map((f) => [f.key, f.occurrence, f.markup]);
  assertEquals(occurrences("```\n" + image + "\n```\n\nreal: " + image, shown(UUID_A)), [
    [UUID_A, 1, image],
  ]);
  const footnote = `[^1]: <img alt="${image}" src="${ua(UUID_B)}">`;
  assertEquals(
    occurrences(`${footnote}\n\nsee[^1] and here: ${image}`, shown(UUID_A) + shown(UUID_B)),
    [[UUID_A, 1, image], [UUID_B, 0, footnote.slice(6)]],
  );
  assertEquals(occurrences(`${image} ${image} ${image}`, shown(UUID_A).repeat(3)), [
    [UUID_A, 0, image],
    [UUID_A, 1, image],
    [UUID_A, 2, image],
  ]);
});

test("githubImages finds images in lists, tables and quotes, several to a comment", () => {
  const markdown = `- one <img src="${ua(UUID_A)}" width="300">\n` +
    `> ![b](${ua(UUID_B)} "title")\n\n| a |\n|---|\n| ![a](<${ua(UUID_A)}>) |`;
  const html = `<ul><li>one ${shown(UUID_A)}</li></ul><blockquote>${shown(UUID_B)}</blockquote>` +
    `<table><tr><td>${shown(UUID_A)}</td></tr></table>`;
  assertEquals(githubImages(markdown, html).map((f) => f.markup), [
    `<img src="${ua(UUID_A)}" width="300">`,
    `![b](${ua(UUID_B)} "title")`,
    `![a](<${ua(UUID_A)}>)`,
  ]);
});

test("githubImages places a markdown image of a full signed URL, however long its JWT", () => {
  // A copied image keeps GitHub's signed URL: 818–824 characters in the wild. Built to that
  // shape here (a real one carries a live signature for a private repo's object).
  const b64 = (text: string) =>
    btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const payload = b64(JSON.stringify({
    iss: "github.com",
    aud: "raw.githubusercontent.com",
    key: "key5",
    exp: 1791155149,
    nbf: 1791154849,
    path: `/1611510/664218278-${UUID_A}.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=` +
      "AKIAEXAMPLEEXAMPLE00%2F20261004%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261004T230049Z" +
      `&X-Amz-Expires=300&X-Amz-Signature=${"0".repeat(64)}&X-Amz-SignedHeaders=host` +
      "&response-content-type=image%2Fpng",
  }));
  const url = `https://private-user-images.githubusercontent.com/1611510/664218278-${UUID_A}.png` +
    `?jwt=${b64('{"typ":"JWT","alg":"HS256"}')}.${payload}.${"s".repeat(43)}`;
  assert(url.length > 800, `${url.length}`);
  const markdown = `Copied from the other issue: ![Screenshot](${url})`;
  const html = `<p>Copied from the other issue: <a href="${url.replaceAll("&", "&amp;")}">` +
    `<img src="${url.replaceAll("&", "&amp;")}" alt="Screenshot"></a></p>`;
  assertEquals(githubImages(markdown, html), [
    { markup: `![Screenshot](${url})`, occurrence: 0, key: UUID_A, url },
  ]);
});

/**
 * `text` as a string that counts what is read of it: a character by index, a `slice` by its
 * length, an `indexOf` by how far it looked, and anything else (a `matchAll`, an `includes`) as the
 * whole string. Throws once `budget` characters have been read, so a scan gone quadratic fails
 * at once instead of running into the test's timeout.
 */
function metered(text: string, budget: number): { text: string; reads: () => number } {
  let reads = 0;
  const read = (n: number) => {
    reads += n;
    if (reads > budget) {
      throw new Error(`read ${reads} characters of ${text.length}, over ${budget}`);
    }
  };
  const methods: Record<string, unknown> = {
    slice: (from = 0, to = text.length) => {
      const part = text.slice(from, to);
      read(part.length);
      return part;
    },
    indexOf: (needle: string, from = 0) => {
      const at = text.indexOf(needle, from);
      read((at === -1 ? text.length : at + needle.length) - Math.max(0, from));
      return at;
    },
  };
  const proxy = new Proxy(new String(text), {
    get(_, key) {
      if (key === "length") return text.length;
      if (typeof key === "string") {
        const c = key.charCodeAt(0);
        if ((c >= 48 && c <= 57) || c === 45) {
          read(1);
          return text[Number(key)];
        }
        if (key in methods) return methods[key];
      }
      const value = (text as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        read(text.length);
        return (value as (...a: unknown[]) => unknown).apply(text, args);
      };
    },
  });
  return { text: proxy as unknown as string, reads: () => reads };
}

test("finding a comment's images stays linear however both sides are spelled", () => {
  // Each opening used to scan to the end of the body, and later each occurrence of a rendered
  // upload could; a thread holds hundreds of entries. Every shape here spells a rendered upload
  // as often as it can, on both sides, at the size an entry is cut to.
  const N = 262_144;
  const rep = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const A = ua(UUID_A);
  const htmls = [shown(UUID_A), rep(shown(UUID_A)), rep(`<img src="${sig(UUID_A)}" a="`)];
  const markdowns = [
    rep(`${UUID_A} `),
    rep(`<img src="${A}"`),
    "<img " + rep(`a=${UUID_A} `),
    rep(`<img a="<img b='<img c="${UUID_A} `),
    rep(`<img <img <img <img <img <img <img <img <img ${UUID_A}`),
    rep(`<img ${"a=b ".repeat(900)}src="${A}"`),
    // Each occurrence a look of its own over a whole window: these are what the cap on looks
    // (MAX_PLACEMENT_LOOKS) holds, 100–180 ms without it.
    rep(`<img ` + `a=${UUID_A} `.repeat(10)),
    rep(`<img a="` + `${UUID_A} `.repeat(100) + `<img b='` + `${UUID_A} `.repeat(100)),
    rep(`<img a='${UUID_A.repeat(16)}`),
    rep(`<img alt="${UUID_A}" src=x> `),
    rep(`![a](${A} "`),
    rep(`![${"a".repeat(3000)}](${A}`),
    rep("` `` ``` `" + UUID_A),
    rep("```\n" + UUID_A + "\n"),
    rep(`<img src="${A}"> `),
    rep(`<img a="\n\n" src="${A}">`),
    rep("<img "),
    rep("!["),
    rep("plain words, nothing to see. "),
  ];
  // Characters read, not CPU time: time on a shared check machine is noise a regression hides
  // in, while a count is the same everywhere. Measured (2026-10-13): the worst shape
  // reads 12.4 characters of markdown per character and 3.9 of HTML; without the cap on looks
  // (MAX_PLACEMENT_LOOKS) the same shapes read 90–254 of markdown, and a tag search that does
  // not resume where the last tag ended never finishes at this size.
  const MARKDOWN_READS = 20;
  const HTML_READS = 8;
  for (const html of htmls) {
    for (const markdown of markdowns) {
      const md = metered(markdown, MARKDOWN_READS * markdown.length);
      const rendered = metered(html, HTML_READS * html.length);
      const shape = `${JSON.stringify(markdown.slice(0, 40))} / ${
        JSON.stringify(html.slice(0, 40))
      }`;
      let found;
      try {
        found = githubImages(md.text, rendered.text);
      } catch (e) {
        throw new Error(`${shape}: ${(e as Error).message}`);
      }
      // The meter only watches: the answer is the one an ordinary string gets.
      assertEquals(found, githubImages(markdown, html), shape);
    }
  }
});

test("uploadKey names only GitHub's upload URLs, by their UUID", () => {
  assertEquals(uploadKey(`https://github.com/user-attachments/assets/${UUID_A}`), UUID_A);
  assertEquals(uploadKey(`https://github.com/user-attachments/assets/${UUID_A}/`), UUID_A);
  assertEquals(uploadKey(`https://user-images.githubusercontent.com/1/2-${UUID_A}.png`), UUID_A);
  assertEquals(
    uploadKey(`https://private-user-images.githubusercontent.com/1/2-${UUID_A}.PNG?jwt=x`),
    UUID_A,
  );
  // Only the exact path GitHub signs (measured): anything else stays an unfetchable github.com
  // URL in `body_html`, no image, so it may not take a real image's place.
  for (
    const path of [
      `zz${UUID_A}`,
      `${UUID_A}x`,
      `${UUID_A}/x`,
      `${UUID_A}//`,
      `${UUID_A}.png`,
      UUID_A.toUpperCase(),
      `${UUID_A}?raw=true`,
      `${UUID_A}#gh-dark-mode-only`,
    ]
  ) {
    assertEquals(uploadKey(`https://github.com/user-attachments/assets/${path}`), null, path);
  }
  assertEquals(uploadKey(`https://github.com/x/user-attachments/assets/${UUID_A}`), null);
  assertEquals(uploadKey(`https://user-images.githubusercontent.com/1/${UUID_A}.png`), null);
  assertEquals(uploadKey(`https://user-images.githubusercontent.com/1/2-${UUID_A}`), null);
  assertEquals(uploadKey(`https://github.com/acme/app/blob/main/${UUID_A}.png`), null);
  assertEquals(uploadKey(`http://user-images.githubusercontent.com/1/2-${UUID_A}.png`), null);
  assertEquals(uploadKey(`https://user-images.githubusercontent.com.evil.example/${UUID_A}`), null);
  assertEquals(uploadKey("not a url"), null);
});

// ── where a download may go ─────────────────────────────────────────────────────────────────

test("onAllowedOrigin is scheme, host and port, and refuses credentials", () => {
  const allowed = ["https://private-user-images.githubusercontent.com"];
  assert(
    onAllowedOrigin(new URL("https://private-user-images.githubusercontent.com/a.png"), allowed),
  );
  assert(!onAllowedOrigin(new URL("http://private-user-images.githubusercontent.com/a"), allowed));
  assert(
    !onAllowedOrigin(new URL("https://private-user-images.githubusercontent.com:8443/a"), allowed),
  );
  assert(
    !onAllowedOrigin(new URL("https://u:p@private-user-images.githubusercontent.com/a"), allowed),
  );
  assert(!onAllowedOrigin(new URL("https://169.254.169.254/latest/meta-data"), allowed));
});

test("downloadImage fetches an allowlisted image without sending anything of ours", async () => {
  const host = await fakeServer(() => png());
  try {
    const got = await downloadImage(`${host.origin}/u/1-x.png?jwt=signed`, {
      origins: [host.origin],
    });
    assertEquals(got.kind, "image");
    if (got.kind === "image") assertEquals(got.bytes, PNG);
    assertEquals(host.seen[0].headers.get("authorization"), null);
    assertEquals(host.seen[0].headers.get("cookie"), null);
  } finally {
    await host.shutdown();
  }
});

test("downloadImage never dials an origin off the list, nor follows a redirect off it", async () => {
  const inside = await fakeServer(() => png());
  const outside = await fakeServer(() => png());
  const bouncer = await fakeServer((_req, path) =>
    path.startsWith("/in")
      ? new Response(null, { status: 302, headers: { location: `${inside.origin}/x.png` } })
      : new Response(null, { status: 302, headers: { location: `${outside.origin}/x.png` } })
  );
  try {
    const origins = [bouncer.origin, inside.origin];
    // Off the list from the start: nothing is asked at all.
    const direct = await downloadImage(`${outside.origin}/x.png`, { origins });
    assertEquals(direct, { kind: "omitted", reason: "unavailable" });
    // A redirect inside the list is followed…
    const within = await downloadImage(`${bouncer.origin}/in`, { origins });
    assertEquals(within.kind, "image");
    // …and one that leaves it is not, however it is spelled.
    const away = await downloadImage(`${bouncer.origin}/out`, { origins });
    assertEquals(away, { kind: "omitted", reason: "unavailable" });
    assertEquals(outside.seen.length, 0);
  } finally {
    await Promise.all([inside.shutdown(), outside.shutdown(), bouncer.shutdown()]);
  }
});

test("downloadImage caps the read, declared or streamed, and decides the format by the bytes", async () => {
  const big = new Uint8Array(MAX_THREAD_IMAGE_BYTES + 1);
  big.set(PNG);
  const host = await fakeServer((_req, path) => {
    if (path === "/declared") return new Response(big);
    if (path === "/streamed") {
      // No content-length: the count as it arrives is what holds.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(big.subarray(0, 4 * 1024 * 1024));
            c.enqueue(big.subarray(4 * 1024 * 1024));
            c.close();
          },
        }),
      );
    }
    if (path === "/svg") return new Response(SVG, { headers: { "content-type": "image/png" } });
    if (path === "/missing") return new Response("no", { status: 404 });
    return png();
  });
  try {
    const opts = { origins: [host.origin] };
    assertEquals(await downloadImage(`${host.origin}/declared`, opts), {
      kind: "omitted",
      reason: "too_large",
    });
    assertEquals(await downloadImage(`${host.origin}/streamed`, opts), {
      kind: "omitted",
      reason: "too_large",
    });
    // Claimed to be a PNG, is an SVG: the claim is not evidence.
    assertEquals(await downloadImage(`${host.origin}/svg`, opts), {
      kind: "omitted",
      reason: "unsupported",
    });
    assertEquals(await downloadImage(`${host.origin}/missing`, opts), {
      kind: "omitted",
      reason: "unavailable",
    });
  } finally {
    await host.shutdown();
  }
});

test("sniffImage knows the four formats and nothing else", () => {
  assertEquals(sniffImage(PNG), "image/png");
  assertEquals(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(sniffImage(new TextEncoder().encode("GIF89a...")), "image/gif");
  assertEquals(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(sniffImage(SVG), null);
  assertEquals(sniffImage(new Uint8Array()), null);
});

// ── which images a read takes ───────────────────────────────────────────────────────────────

const context = (entries: number): ThreadContext => ({
  kind: "issue",
  ref: "7",
  title: "t",
  body: "",
  authorLogin: "grace",
  createdAt: "",
  state: "open",
  entries: Array.from({ length: entries }, (_, i) => ({
    id: `c${i}`,
    kind: "comment" as const,
    authorLogin: "linus",
    body: "",
    createdAt: "",
    state: null,
    location: null,
  })),
  truncated: false,
  changeRequest: null,
});

const slot = (owner: ImageSlot["owner"], markup: string): ImageSlot => ({
  owner,
  markup,
  fetch: () => Promise.resolve({ kind: "image", bytes: PNG }),
});

test("past the cap a read takes the command's comment, then the opening post, then the newest", async () => {
  const thread = context(4);
  await attachThreadImages(
    thread,
    [
      slot("body", "b1"),
      slot(0, "e0"),
      slot(1, "e1"),
      slot(2, "f1"),
      slot(2, "f2"),
      slot(3, "e3"),
    ],
    "c2",
    { max: 4 },
  );
  const kinds = (images: ThreadImage[] | undefined) =>
    (images ?? []).map((i) => `${i.markup}:${i.kind === "image" ? "image" : i.reason}`);
  // The focus (c2) both, the body, then the newest of the rest (c3); the two oldest are counted
  // out — and still placed, so the reader can say they were there.
  assertEquals(kinds(thread.bodyImages), ["b1:image"]);
  assertEquals(kinds(thread.entries[2].images), ["f1:image", "f2:image"]);
  assertEquals(kinds(thread.entries[3].images), ["e3:image"]);
  assertEquals(kinds(thread.entries[0].images), ["e0:limit"]);
  assertEquals(kinds(thread.entries[1].images), ["e1:limit"]);
});

test("a download that throws or outruns the budget costs only itself", async () => {
  const thread = context(2);
  await attachThreadImages(
    thread,
    [
      { owner: 0, markup: "boom", fetch: () => Promise.reject(new Error("boom")) },
      {
        owner: 1,
        markup: "slow",
        fetch: (signal) =>
          new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () => resolve({ kind: "omitted", reason: "unavailable" }),
            )
          ),
      },
      slot("body", "fine"),
    ],
    null,
    { budgetMs: 50 },
  );
  assertEquals(thread.bodyImages?.[0].kind, "image");
  assertEquals(thread.entries[0].images, [
    { kind: "omitted", markup: "boom", reason: "unavailable" },
  ]);
  assertEquals(thread.entries[1].images, [
    { kind: "omitted", markup: "slow", reason: "unavailable" },
  ]);
});

test("a focus-only read downloads the command's comment's images and writes no others", async () => {
  const thread = context(3);
  let asked = 0;
  const counted = (owner: ImageSlot["owner"], markup: string): ImageSlot => ({
    owner,
    markup,
    fetch: () => {
      asked++;
      return Promise.resolve({ kind: "image", bytes: PNG });
    },
  });
  await attachThreadImages(
    thread,
    [counted("body", "b"), counted(0, "e0"), counted(1, "mine"), counted(2, "e2")],
    "c1",
    { focusOnly: true },
  );
  assertEquals(asked, 1, "nothing but the focus is downloaded");
  assertEquals(thread.entries[1].images?.map((i) => i.markup), ["mine"]);
  // Not `[]`: an entry this read did not ask about says nothing about its images.
  assertEquals(thread.bodyImages, undefined);
  assertEquals(thread.entries[0].images, undefined);
  assertEquals(thread.entries[2].images, undefined);
});

test('a markup longer than the control plane takes is carried as "", and a name is cut', async () => {
  const thread = context(1);
  // What one pasted `<img>` with an essay of alt text looks like: legal markdown, any length.
  const huge = `<img alt="${
    "A".repeat(5_000)
  }" src="https://github.com/user-attachments/assets/${UUID_A}">`;
  await attachThreadImages(thread, [
    { ...slot(0, huge), name: "n".repeat(1_000) },
    slot(0, `<img src="x">`),
  ], null);
  const [first, second] = thread.entries[0].images ?? [];
  assertEquals(first.kind, "image");
  assertEquals(first.markup, "", "the image is kept, its marker trails the text");
  assertEquals(first.name?.length, MAX_IMAGE_NAME);
  assertEquals(second.markup, `<img src="x">`);
  assert(huge.length > MAX_IMAGE_MARKUP);
});

// ── the GitHub adapter, end to end ──────────────────────────────────────────────────────────

async function testKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

test("GitHub: a read with images asks for full+json and carries each comment's images", async () => {
  const images = await fakeServer((_req, path) => path.includes("svg") ? new Response(SVG) : png());
  const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  const signed = (n: number) => `${images.origin}/1/2-${uuid(n)}.png?jwt=t${n}`;
  const tag = (n: number) =>
    `<img alt="Image" src="https://github.com/user-attachments/assets/${uuid(n)}" />`;
  const html = (...ns: number[]) => ns.map((n) => `<img src="${signed(n)}">`).join("");
  const gh = await fakeServer((req, path) => {
    if (req.method === "POST" && path.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }),
        {
          status: 201,
        },
      );
    }
    // A private repo: its uploads are downloaded without asking whether they are public.
    if (path === "/repos/acme/app") return new Response(JSON.stringify({ private: true }));
    if (path === "/repos/acme/app/issues/7") {
      return new Response(JSON.stringify({
        title: "Broken page",
        // Longer than an entry keeps: the HTML renders all of it, upload 5 past the cut too,
        // and that one is in no text the reader will see.
        body: `It looks like this:\n${tag(1)}\n\n${"x".repeat(16_000)} ${tag(5)}`,
        body_html: `<p>It looks like this:</p>${html(1)}<p>${"x".repeat(16_000)} ${html(5)}</p>`,
        state: "open",
        user: { login: "grace" },
        created_at: "2026-01-01T00:00:00Z",
      }));
    }
    if (path.startsWith("/repos/acme/app/issues/7/comments")) {
      return new Response(JSON.stringify([
        {
          id: 101,
          user: { login: "linus" },
          body: `Same here ${tag(2)} and an svg ${tag(3)}`,
          body_html: html(2) + `<img src="${images.origin}/1/2-${uuid(3)}.svg?jwt=x">`,
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: 102,
          user: { login: "ada" },
          body: `/ryph ada fix this ${tag(4)}`,
          body_html: html(4),
          created_at: "2026-01-03T00:00:00Z",
        },
        // Exactly as long as an entry keeps, so whole: an image its text cannot place still
        // trails it, as in any whole body (the HTML is made up — what a misreading looks like).
        {
          id: 103,
          user: { login: "linus" },
          body: "x".repeat(16_000),
          body_html: html(6),
          created_at: "2026-01-04T00:00:00Z",
        },
      ]));
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  });
  try {
    const api = await githubForgeApi({
      appId: "999",
      privateKeyPem: await testKeyPem(),
      oauth: { clientId: "Iv1.client", clientSecret: "shhh" },
      apiBase: gh.origin,
      oauthBase: gh.origin,
      imageOrigins: [images.origin],
      diag: silentDiagnostics(),
    });
    const repo = { repoRef: "acme/app", tenantId: "42" };

    // Without images: the plain media type, no image is touched, and the ids still ride.
    const plain = await api.fetchThread(repo, { kind: "issue", ref: "7" });
    assertEquals(plain.bodyImages, undefined);
    assertEquals(plain.entries.map((e) => e.id), ["101", "102", "103"]);
    assertEquals(images.seen.length, 0);
    assert(gh.seen.every((s) => s.headers.get("accept") !== "application/vnd.github.full+json"));

    const thread = await api.fetchThread(repo, { kind: "issue", ref: "7" }, {
      images: { focus: "102" },
    });
    const reads = gh.seen.filter((s) => s.path.startsWith("/repos/acme/app/issues/7"));
    assert(reads.some((s) => s.headers.get("accept") === "application/vnd.github.full+json"));
    assertEquals(thread.bodyImages?.length, 1);
    assertEquals(thread.bodyImages?.[0].markup, tag(1));
    assertEquals(thread.bodyImages?.[0].kind, "image");
    const first = thread.entries[0].images ?? [];
    assertEquals(first.map((i) => i.kind), ["image", "omitted"]);
    assertEquals(first[1], { kind: "omitted", markup: tag(3), reason: "unsupported" });
    const own = thread.entries[1].images?.[0];
    assertExists(own);
    assert(own.kind === "image");
    assertEquals(Uint8Array.fromBase64(own.data), PNG);
    // The text stays the forge's own: placing a marker is the reader's job.
    assertEquals(thread.entries[1].body, `/ryph ada fix this ${tag(4)}`);
    assertEquals(thread.entries[2].images?.map((i) => [i.kind, i.markup]), [["image", ""]]);
    // Signed URLs only, and nothing of ours on them.
    assert(images.seen.every((s) => s.path.includes("jwt=")));
    assert(images.seen.every((s) => s.headers.get("authorization") === null));
  } finally {
    await Promise.all([gh.shutdown(), images.shutdown()]);
  }
});

test("GitHub: a thread with more images than a read carries asks for no more than the cap", async () => {
  const images = await fakeServer(() => png());
  const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const comments = Array.from({ length: 12 }, (_, i) => ({
    id: 200 + i,
    user: { login: "linus" },
    body: `![s](https://github.com/user-attachments/assets/${uuid(i)})`,
    body_html: `<img src="${images.origin}/1/2-${uuid(i)}.png?jwt=t">`,
    created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const gh = await fakeServer((req, path) => {
    if (req.method === "POST") {
      return new Response(JSON.stringify({ token: "t", expires_at: "2099-01-01T00:00:00Z" }), {
        status: 201,
      });
    }
    if (path === "/repos/acme/app") return new Response(JSON.stringify({ private: true }));
    if (path === "/repos/acme/app/issues/7") {
      return new Response(JSON.stringify({ title: "t", body: "", user: { login: "g" } }));
    }
    if (path.startsWith("/repos/acme/app/issues/7/comments")) {
      return new Response(JSON.stringify(comments));
    }
    return new Response("{}", { status: 404 });
  });
  try {
    const api = await githubForgeApi({
      appId: "999",
      privateKeyPem: await testKeyPem(),
      oauth: { clientId: "c", clientSecret: "s" },
      apiBase: gh.origin,
      imageOrigins: [images.origin],
      diag: silentDiagnostics(),
    });
    // The command is in the OLDEST comment: it is taken first anyway.
    const thread = await api.fetchThread({ repoRef: "acme/app", tenantId: "42" }, {
      kind: "issue",
      ref: "7",
    }, { images: { focus: "200" } });
    assertEquals(images.seen.length, MAX_THREAD_IMAGES);
    const kinds = thread.entries.map((e) => e.images?.[0].kind);
    assertEquals(kinds[0], "image");
    // Then newest first: the two counted out are the oldest after the focus.
    assertEquals(kinds.slice(1, 3), ["omitted", "omitted"]);
    assertEquals(kinds.slice(3), Array(9).fill("image"));
  } finally {
    await Promise.all([gh.shutdown(), images.shutdown()]);
  }
});

test("GitHub: on a public repo an upload is downloaded only when GitHub shows it to anyone", async () => {
  const images = await fakeServer(() => png());
  // github.com's own answer to an anonymous `user-attachments/assets/<uuid>`: a redirect to
  // the bytes for an upload made on a public repo, 404 for one made on a private repo.
  const uploads = await fakeServer((_req, path) =>
    path.endsWith(UUID_A)
      ? new Response(null, { status: 302, headers: { location: "https://s3.example/x" } })
      : new Response("Not Found", { status: 404 })
  );
  const md = (uuid: string) => `![s](https://github.com/user-attachments/assets/${uuid})`;
  const html = (uuid: string) => `<img src="${images.origin}/1/2-${uuid}.png?jwt=t">`;
  let visibility: Response | null = new Response(JSON.stringify({ private: false }));
  const gh = await fakeServer((req, path) => {
    if (req.method === "POST") {
      return new Response(JSON.stringify({ token: "t", expires_at: "2099-01-01T00:00:00Z" }), {
        status: 201,
      });
    }
    if (path === "/repos/acme/app") {
      return visibility ?? new Response(JSON.stringify({ message: "boom" }), { status: 502 });
    }
    if (path === "/repos/acme/app/issues/7") {
      return new Response(JSON.stringify({
        title: "t",
        // This repo's own screenshot, then one somebody lifted from a private repository.
        body: `${md(UUID_A)}\n${md(UUID_B)}`,
        body_html: html(UUID_A) + html(UUID_B),
        user: { login: "g" },
      }));
    }
    if (path.startsWith("/repos/acme/app/issues/7/comments")) return new Response("[]");
    return new Response("{}", { status: 404 });
  });
  try {
    const api = await githubForgeApi({
      appId: "999",
      privateKeyPem: await testKeyPem(),
      oauth: { clientId: "c", clientSecret: "s" },
      apiBase: gh.origin,
      imageOrigins: [images.origin],
      uploadBase: uploads.origin,
      diag: silentDiagnostics(),
    });
    const read = () =>
      api.fetchThread({ repoRef: "acme/app", tenantId: "42" }, { kind: "issue", ref: "7" }, {
        images: { focus: null },
      });
    const kinds = (t: ThreadContext) =>
      (t.bodyImages ?? []).map((i) => i.kind === "image" ? "image" : i.reason);

    assertEquals(kinds(await read()), ["image", "unavailable"]);
    // The private one was never downloaded, only asked after — and anonymously.
    assertEquals(images.seen.map((s) => s.path.includes(UUID_B)), [false]);
    assert(uploads.seen.every((s) => s.headers.get("authorization") === null));

    // A visibility nobody could read is a public one: asked about all the same.
    visibility = null;
    assertEquals(kinds(await read()), ["image", "unavailable"]);
  } finally {
    await Promise.all([gh.shutdown(), images.shutdown(), uploads.shutdown()]);
  }
});

// ── the Radicle adapter ─────────────────────────────────────────────────────────────────────

test("Radicle: embeds become images through the bridge, matched to the link that shows them", async () => {
  const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
  const ISSUE = "b".repeat(40);
  const SHOT = "1".repeat(40);
  const NOTES = "2".repeat(40);
  const HUGE = "3".repeat(40);
  const bridge = await fakeServer((_req, raw) => {
    const path = decodeURIComponent(raw);
    if (path === `/v1/repos/${RID}/issues/${ISSUE}`) {
      return new Response(JSON.stringify({
        issue: {
          id: ISSUE,
          title: "Broken",
          author: { did: "did:key:them" },
          state: "open",
          body: `see [shot.png](${SHOT})`,
          comments: [
            {
              id: "c0",
              author: { did: "did:key:them" },
              body: `see [shot.png](${SHOT})`,
              embeds: [{ name: "shot.png", oid: SHOT }],
            },
            {
              id: "c1",
              author: { did: "did:key:us" },
              body: "/ryph ada look",
              // Embedded, never linked: shown after the text.
              embeds: [{ name: "notes.txt", oid: NOTES }, { name: "big.png", oid: HUGE }],
            },
          ],
        },
      }));
    }
    const embed = path.match(/\/embeds\/([0-9a-f]{40})$/)?.[1];
    if (embed === SHOT) {
      return new Response(
        JSON.stringify({ embed: { name: "shot.png", oid: SHOT, data: PNG.toBase64() } }),
      );
    }
    if (embed === NOTES) {
      return new Response(JSON.stringify({
        embed: { name: "notes.txt", oid: NOTES, data: new TextEncoder().encode("hi").toBase64() },
      }));
    }
    if (embed === HUGE) return new Response(JSON.stringify({ error: "too big" }), { status: 413 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
  try {
    const api = radicleForgeApi({
      baseUrl: bridge.origin,
      token: "bridge-secret",
      explorerUrl: null,
      diag: silentDiagnostics(),
    });
    const repo = { repoRef: RID, tenantId: null };
    const thread = await api.fetchThread(repo, { kind: "issue", ref: ISSUE }, {
      images: { focus: `issue:${ISSUE}:c1` },
    });
    // The entry is named by the handle a command in it arrives with.
    assertEquals(thread.entries[0].id, `issue:${ISSUE}:c1`);
    assertEquals(thread.bodyImages?.map((i) => [i.kind, i.markup, i.name]), [
      ["image", `[shot.png](${SHOT})`, "shot.png"],
    ]);
    assertEquals(thread.entries[0].images, [
      { kind: "omitted", markup: "", name: "notes.txt", reason: "unsupported" },
      { kind: "omitted", markup: "", name: "big.png", reason: "too_large" },
    ]);
    const asked = bridge.seen.filter((s) => s.path.includes("/embeds/"));
    assertEquals(asked.length, 3);
    assert(asked.every((s) => s.headers.get("authorization") === "Bearer bridge-secret"));
    assert(asked.every((s) => decodeURIComponent(s.path).includes(`/issues/${ISSUE}/embeds/`)));
  } finally {
    await bridge.shutdown();
  }
});
