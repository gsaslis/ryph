// Finding the images a GitHub comment shows, and where each one can actually be downloaded.
//
// What GitHub does, measured against the live API (2026-10-04, private and public repos):
//
// - the markdown names an upload as `<img … src="https://github.com/user-attachments/assets/<uuid>">`
//   (what pasting an image writes today), `![alt](https://github.com/user-attachments/assets/<uuid>)`,
//   or, for uploads before 2023, `https://user-images.githubusercontent.com/<user>/<n>-<uuid>.png`
// - the `user-attachments` URL is NOT fetchable by a service: 404 without a browser session on a
//   private repo, a redirect to an S3 bucket on a public one
// - the same comment read with `Accept: application/vnd.github.full+json` carries `body_html`,
//   where each upload is `<img src="https://private-user-images.githubusercontent.com/<user>/<n>-<uuid>.png?jwt=…">`:
//   a URL signed for five minutes that answers 200 with the bytes and needs no credentials — on
//   public repos too. A legacy upload keeps its `user-images.githubusercontent.com` URL there,
//   which is fetchable as is
// - only the bare `user-attachments` URL is signed: one with a fragment or a query
//   (`#gh-dark-mode-only`, `?raw=true`) stays the unfetchable `github.com` URL in `body_html`,
//   so an image spelled that way is not seen at all (measured 2026-10-05)
// - every one of those URLs carries the upload's UUID, which is how an image in the HTML is matched
//   to the markdown that showed it — by identity, not by counting `<img>` tags, so an image the
//   renderer added or dropped cannot shift the rest onto the wrong comment text
//
// Which images a comment shows is decided by `body_html` alone: it is GitHub's own rendering,
// sanitized and well formed, so an `<img>` there is an image a reader saw and nothing else is.
// The markdown is read only for WHERE each one sat — the markup the prompt swaps for its marker —
// and a misreading of it can only misplace a marker (or trail it after the text), never add,
// drop or swap an image. Three rounds of matching tags in the markdown itself proved the other
// way round wrong: a backtick span or an unclosed `<img` a reader never saw as a tag either hid
// a real image or made a scan quadratic.
//
// Only uploads are images here. A markdown image of any other URL (a badge, a hotlinked picture,
// `camo.githubusercontent.com`'s proxy of one) stays text: "look at this link" is not something a
// thread may make this service fetch, and a run's egress decides what a run may.

import { codeRanges } from "@ryph/shared/markdown";
import { MAX_IMAGE_MARKUP } from "../../core/thread_images.ts";

/** Where GitHub serves the bytes of an upload — the only origins a download dials. */
export const GITHUB_IMAGE_ORIGINS: readonly string[] = [
  "https://private-user-images.githubusercontent.com",
  "https://user-images.githubusercontent.com",
];

/** Hosts whose URLs in MARKDOWN name an upload. Matched on host, never followed. */
const UPLOAD_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_ALL = new RegExp(UUID.source, "gi");

/** The path of an upload on github.com, exactly as GitHub signs it in `body_html`: the UUID in
 * lowercase, at most one trailing `/`. Measured 2026-10-05 (POST /markdown, a real upload):
 * an uppercase UUID, a prefix or suffix on it, a further segment, `//`, a `.png`, a query or a
 * fragment all come back as the same `github.com` URL, unsigned — no image of a forge origin, so
 * markdown spelled that way names no upload and cannot take a real one's place. */
const ATTACHMENT_PATH = new RegExp(`^/user-attachments/assets/(${UUID.source})/?$`);
/** The path of an upload on `*.githubusercontent.com`: `/<user id>/<n>-<uuid>.<ext>`, the shape
 * a legacy upload keeps and a signed URL carries. */
const USER_IMAGE_PATH = new RegExp(`^/\\d+/\\d+-(${UUID.source})\\.[a-z0-9]+$`, "i");
const UUID_LENGTH = 36;

/** How many markdown occurrences of rendered uploads one comment's placement looks at. Each look
 * is bounded (MAX_IMAGE_MARKUP around the occurrence, MAX_OPENERS tags tried), so this caps the
 * work a comment spelling one rendered UUID thousands of times can cause; an image past it
 * trails the text. Five times what a read keeps of one entry (MAX_SLOTS_PER_ENTRY). */
const MAX_PLACEMENT_LOOKS = 256;

/** How many `<img` openings before an occurrence are tried as the tag around it. */
const MAX_OPENERS = 8;

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** A blank line: what ends a paragraph, and so any raw tag or image in it. */
const BLANK_LINE = /\n[ \t]*\r?\n/;

// ── the rendered side ────────────────────────────────────────────────────────────────────────

/** Where an `<img` tag may start: the name, then what ends a tag name. */
const IMG_OPEN = /<img(?=[\s/>])/gi;

/**
 * The `src` of every `<img>` tag of sanitized HTML, in order: the attributes read the way an
 * HTML tokenizer reads them — a name, then optionally `=` and a value, double-quoted,
 * single-quoted or bare — so a ` src=` or a `>` inside ANOTHER attribute's quoted value is that
 * value's text, never the src or the end of the tag. The first `src` wins, as it does in a
 * browser. A tag never closed is no tag.
 *
 * Linear in `html`: the search for the next tag resumes where the last scan stopped, closed or
 * not, so no character is scanned for two openings, and an `<img` spelled inside another tag's
 * quoted attribute is that attribute's text, never a second tag. No length bound: GitHub writes
 * an alt of any length into the tag, and that image is still one a reader saw.
 */
function* htmlImgSrcs(html: string): Generator<string> {
  let resumeAt = 0;
  for (const open of html.matchAll(IMG_OPEN)) {
    if (open.index < resumeAt) continue;
    const limit = html.length;
    let i = open.index + open[0].length;
    let src: string | null = null;
    let closed = false;
    while (i < limit) {
      const c = html[i];
      if (c === ">") {
        closed = true;
        i++;
        break;
      }
      if (isSpace(c) || c === "/") {
        i++;
        continue;
      }
      // The name: up to space, `/`, `>` or `=` (a leading `=` belongs to it).
      const nameStart = i;
      i++;
      while (i < limit && !isSpace(html[i]) && !"/>=".includes(html[i])) i++;
      const name = html.slice(nameStart, i).toLowerCase();
      while (i < limit && isSpace(html[i])) i++;
      let value: string | null = null;
      if (html[i] === "=") {
        i++;
        while (i < limit && isSpace(html[i])) i++;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          if (end === -1) {
            i = limit;
            break;
          }
          value = html.slice(i + 1, end);
          i = end + 1;
        } else {
          const start = i;
          while (i < limit && !isSpace(html[i]) && html[i] !== ">") i++;
          value = html.slice(start, i);
        }
      }
      if (name === "src" && src === null && value !== null) src = value;
    }
    resumeAt = i;
    if (closed && src !== null) yield src;
  }
}

/** The five entities GitHub's renderer escapes in an attribute — enough for a URL. */
function unescapeHtml(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? "",
  );
}

/** The upload this URL names, by its UUID — null for anything that is not a GitHub upload. */
export function uploadKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !UPLOAD_HOSTS.has(url.hostname)) return null;
  // `url.search`/`url.hash` are not looked at for a githubusercontent URL: a copied signed URL
  // carries its `?jwt=`, and the path alone says which upload it is.
  if (url.hostname === "github.com") {
    return url.search === "" && url.hash === ""
      ? url.pathname.match(ATTACHMENT_PATH)?.[1] ?? null
      : null;
  }
  return url.pathname.match(USER_IMAGE_PATH)?.[1].toLowerCase() ?? null;
}

// ── the written side: only where each rendered image sat ─────────────────────────────────────

/** `[start, end)` of the markdown. */
interface Span {
  start: number;
  end: number;
}

/**
 * The CommonMark open tag at `at`, if `<img` starts one: attribute names
 * `[A-Za-z_:][A-Za-z0-9_.:-]*`, values bare (no whitespace or `"'=<>\``), single- or
 * double-quoted, whitespace before each attribute, no blank line, at most MAX_IMAGE_MARKUP
 * characters. Returns where it ends and where its first `src` value sits.
 */
function openTagAt(
  markdown: string,
  at: number,
): { end: number; src: Span | null } | null {
  if (markdown.slice(at, at + 4).toLowerCase() !== "<img") return null;
  const limit = Math.min(markdown.length, at + MAX_IMAGE_MARKUP);
  const nameStart = /[A-Za-z_:]/;
  const nameChar = /[A-Za-z0-9_.:-]/;
  let i = at + 4;
  let src: Span | null = null;
  while (i < limit) {
    const spaced = isSpace(markdown[i]);
    while (i < limit && isSpace(markdown[i])) i++;
    if (markdown[i] === ">") return finish(i + 1);
    if (markdown[i] === "/" && markdown[i + 1] === ">") return finish(i + 2);
    if (!spaced || i >= limit || !nameStart.test(markdown[i])) return null;
    const nameAt = i;
    while (i < limit && nameChar.test(markdown[i])) i++;
    const name = markdown.slice(nameAt, i).toLowerCase();
    let j = i;
    while (j < limit && isSpace(markdown[j])) j++;
    if (markdown[j] !== "=") continue;
    j++;
    while (j < limit && isSpace(markdown[j])) j++;
    let value: Span;
    const quote = markdown[j];
    if (quote === '"' || quote === "'") {
      let end = j + 1;
      while (end < limit && markdown[end] !== quote) end++;
      if (end >= limit) return null;
      value = { start: j + 1, end };
      i = end + 1;
    } else {
      let end = j;
      while (end < limit && !isSpace(markdown[end]) && !`"'=<>\``.includes(markdown[end])) end++;
      if (end === j) return null;
      value = { start: j, end };
      i = end;
    }
    if (name === "src" && src === null) src = value;
  }
  return null;

  function finish(end: number) {
    return BLANK_LINE.test(markdown.slice(at, end)) ? null : { end, src };
  }
}

/**
 * The `<img>` tag the occurrence at `p` sits in, if it sits in that tag's `src` and the src
 * names `key`: up to MAX_OPENERS `<img` openings in the MAX_IMAGE_MARKUP before it are read as
 * tags, and the OUTERMOST one that reaches past `p` decides — an `<img>` spelled inside another
 * tag's quoted alt is that alt's text, so an occurrence there is no placement. `undefined` when
 * no tag reaches it (then it may be a `![]()`), null when one does but not by its src.
 */
function imgTagAround(markdown: string, p: number, key: string): Span | null | undefined {
  const floor = Math.max(0, p - MAX_IMAGE_MARKUP);
  let around: { at: number; end: number; src: Span | null } | undefined;
  let q = p;
  for (let tries = 0; tries < MAX_OPENERS;) {
    q--;
    while (q >= floor && markdown[q] !== "<") q--;
    if (q < floor) break;
    if (markdown.slice(q, q + 4).toLowerCase() !== "<img") continue;
    tries++;
    const tag = openTagAt(markdown, q);
    if (tag !== null && tag.end > p) around = { at: q, ...tag };
  }
  if (around === undefined) return undefined;
  const { src } = around;
  if (src === null || src.start > p || src.end < p + UUID_LENGTH) return null;
  if (uploadKey(unescapeHtml(markdown.slice(src.start, src.end))) !== key) return null;
  return { start: around.at, end: around.end };
}

/**
 * The `![alt](url)` or `![alt](url "title")` whose url the occurrence at `p` sits in, if that url
 * names `key`: walked out from `p` — back over the url to `(` (or `(<`), `]`, an alt holding no
 * bracket, `![`; forward over the rest of the url, a title, `)` — all within MAX_IMAGE_MARKUP and
 * no blank line. An exotic spelling (a bracket in the alt, a paren in the url) is no placement,
 * which only trails the marker.
 */
function markdownImageAround(markdown: string, p: number, key: string): Span | null {
  const floor = Math.max(0, p - MAX_IMAGE_MARKUP);
  let s = p;
  while (s > floor && !isSpace(markdown[s - 1]) && !"()<>".includes(markdown[s - 1])) s--;
  let k = s - 1;
  const angle = markdown[k] === "<";
  if (angle) k--;
  while (k >= floor && isSpace(markdown[k])) k--;
  if (k < floor || markdown[k] !== "(" || markdown[k - 1] !== "]") return null;
  let b = k - 2;
  while (b >= floor && markdown[b] !== "[" && markdown[b] !== "]") b--;
  if (b - 1 < floor || markdown[b] !== "[" || markdown[b - 1] !== "!") return null;
  const start = b - 1;
  const limit = Math.min(markdown.length, start + MAX_IMAGE_MARKUP);
  let e = p;
  if (angle) {
    while (e < limit && !"<>\n".includes(markdown[e])) e++;
    if (markdown[e] !== ">") return null;
  } else {
    while (e < limit && !isSpace(markdown[e]) && !"()<>".includes(markdown[e])) e++;
  }
  const url = markdown.slice(s, e);
  if (angle) e++;
  let w = e;
  while (w < limit && isSpace(markdown[w])) w++;
  const opener = markdown[w];
  if (w > e && (opener === '"' || opener === "'" || opener === "(")) {
    const closer = opener === "(" ? ")" : opener;
    let t = w + 1;
    while (t < limit && markdown[t] !== closer) t += markdown[t] === "\\" ? 2 : 1;
    if (t >= limit) return null;
    w = t + 1;
    while (w < limit && isSpace(markdown[w])) w++;
  }
  if (w >= limit || markdown[w] !== ")") return null;
  if (BLANK_LINE.test(markdown.slice(start, w + 1)) || uploadKey(url) !== key) return null;
  return { start, end: w + 1 };
}

export interface GithubImageOccurrence {
  /** The markdown that showed it, verbatim — "" when it could not be told where the image sat
   * (the prompt then puts its marker after the text). */
  markup: string;
  /** WHICH spelling of `markup` in the markdown it is: how many exact matches of it (overlapping
   * ones too) start before it. The same text can stand in a code block, inside another tag's
   * alt, or simply twice, and only this one is where the image sat — the prompt replaces that
   * match and no other. 0 when `markup` is "". */
  occurrence: number;
  /** The upload's UUID, lowercased (`uploadKey`) — what `isPublishedUpload` asks about. */
  key: string;
  /** Where its bytes can be downloaded: the signed URL `body_html` carries for the same upload,
   * on an allowlisted origin. */
  url: string;
}

/**
 * Every upload `html` (`body_html`) renders as an image, in order, with the signed URL it carries
 * and the markup of `markdown` (the same body as written) that showed it.
 *
 * WHICH images: the `<img>` tags of the HTML whose src is on `origins`, one per tag, so an image
 * GitHub did not render — inside a code block, an unclosed tag, an HTML comment — is not one, and
 * one it did is never lost to a misreading of the markdown.
 *
 * WHERE: the n-th rendered image of an upload takes the n-th occurrence of its UUID in the
 * markdown that is outside code and sits in an image's own markup — the `src` of a valid `<img>`
 * open tag, or the url of a `![]()` — naming the same upload. An occurrence that is not (a link,
 * a bare mention, a tag left open, a reference definition) is passed over; an image with no
 * occurrence left gets markup "".
 *
 * `truncated`: `markdown` is only the start of the body `html` renders whole (an entry cut to its
 * budget). An image whose upload the kept markdown never names (outside code, or through
 * numeric character references) is then past the cut — in no text the reader will see — and is
 * left out rather than trailed, so it does not take a download from the read's cap. One it names but
 * this cannot place (a reference-style image, a spelling this does not read, the cap on looks
 * reached) trails as in a whole body: it may well sit in the kept text, and an image GitHub
 * renders there is never dropped for a misreading here.
 *
 * Linear in both inputs: one pass over the HTML, one over the markdown for its code and UUIDs,
 * and at most MAX_PLACEMENT_LOOKS bounded looks around an occurrence.
 */
export function githubImages(
  markdown: string,
  html: string,
  origins: readonly string[] = GITHUB_IMAGE_ORIGINS,
  opts: { truncated?: boolean } = {},
): GithubImageOccurrence[] {
  const rendered: Array<{ key: string; url: string }> = [];
  for (const src of htmlImgSrcs(html)) {
    const url = unescapeHtml(src);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!origins.includes(parsed.origin)) continue;
    const key = parsed.pathname.match(UUID)?.[0].toLowerCase();
    if (key !== undefined) rendered.push({ key, url });
  }
  if (rendered.length === 0) return [];

  // Every occurrence of a rendered upload's UUID outside code, per upload, in order.
  const keys = new Set(rendered.map((r) => r.key));
  const code = codeRanges(markdown);
  const occurrences = new Map<string, number[]>();
  let range = 0;
  for (const m of markdown.matchAll(UUID_ALL)) {
    const key = m[0].toLowerCase();
    if (!keys.has(key)) continue;
    while (range < code.length && code[range][1] <= m.index) range++;
    if (range < code.length && code[range][0] <= m.index) continue;
    const list = occurrences.get(key);
    if (list) list.push(m.index);
    else occurrences.set(key, [m.index]);
  }

  // Whether a cut body names an upload at all: plainly (outside code), or spelled with numeric
  // character references, which GitHub decodes in a URL before it signs it (measured
  // 2026-10-05: `4ace29ac&#45;0a9f-…` comes back signed) and which no placement here reads.
  // Over-counting only trails an image a cut body never showed, under-counting would drop one.
  const decoded = opts.truncated && markdown.includes("&#")
    ? markdown.replace(/&#(?:[xX]([0-9a-fA-F]{1,6})|(\d{1,7}));/g, (ref, hex, dec) => {
      const point = hex === undefined ? Number(dec) : parseInt(hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : ref;
    }).toLowerCase()
    : "";
  const next = new Map<string, number>();
  const counted = new Map<string, { from: number; count: number }>();
  let looks = 0;
  const placed = rendered.map(({ key, url }) => {
    const list = occurrences.get(key) ?? [];
    let at = next.get(key) ?? 0;
    let markup = "";
    let start = -1;
    while (at < list.length && looks < MAX_PLACEMENT_LOOKS) {
      const p = list[at++];
      looks++;
      const tag = imgTagAround(markdown, p, key);
      const found = tag === undefined ? markdownImageAround(markdown, p, key) : tag;
      if (found !== null) {
        markup = markdown.slice(found.start, found.end);
        start = found.start;
        // One markup is one image: a src spelling the UUID twice places only one.
        while (at < list.length && list[at] < found.end) at++;
        break;
      }
    }
    next.set(key, at);
    const occurrence = start === -1 ? 0 : occurrenceOf(markdown, markup, start, counted);
    return { markup, occurrence, key, url, named: list.length > 0 || decoded.includes(key) };
  });
  return placed
    .filter((image) => !opts.truncated || image.named)
    .map(({ named: _, ...image }) => image);
}

/**
 * How many exact matches of `markup` in `markdown`, overlapping ones too, start before `start`
 * (where it was placed, itself a match). Counted the way the prompt finds the match again
 * (`withPlaceholders` in the control plane's core/thread_context.ts). Placements come in
 * rendered order, which for one markup is markdown order, so `counted` carries each markup's
 * count forward and the markdown is scanned once per distinct markup.
 */
function occurrenceOf(
  markdown: string,
  markup: string,
  start: number,
  counted: Map<string, { from: number; count: number }>,
): number {
  const seen = counted.get(markup) ?? { from: 0, count: 0 };
  // A placement before the last one counted (rendered order is not always markdown order — a
  // footnote's image renders at the end) starts the count again.
  let { from, count } = seen.from <= start ? seen : { from: 0, count: 0 };
  for (let at = markdown.indexOf(markup, from); at !== -1 && at < start;) {
    count++;
    from = at + 1;
    at = markdown.indexOf(markup, from);
  }
  counted.set(markup, { from: start, count });
  return count;
}

/** Where a pre-2023 upload lives: a URL anyone can fetch, in the markdown and the HTML alike.
 * Published by construction, so `isPublishedUpload` is never asked about one. */
export const LEGACY_IMAGE_ORIGIN = "https://user-images.githubusercontent.com";

/**
 * Whether GitHub serves this upload to ANYONE: `github.com/user-attachments/assets/<uuid>`,
 * asked with no credentials, redirects to the bytes for an upload made on a public repository
 * and answers 404 for one made on a private repository. Measured 2026-10-04.
 *
 * Why it is asked: the signature on a `private-user-images` URL follows the READER's access to
 * the repository the upload was made in, not the repository whose comment names it — rendered
 * for a user who can see a private repo, a comment on a public repo naming that private repo's
 * upload comes back signed (POST /markdown, context a public repo: signed; the same request
 * anonymous: not). A comment on a public repository is anyone's to write, so on one, an upload
 * this check does not find public is not downloaded: the thread would otherwise be a way to
 * walk a private repository's screenshot into a run working in the open, through credentials
 * the commenter never had. Asked by the UUID alone — no token, no cookie, and the answer's body
 * is never read.
 */
export async function isPublishedUpload(
  key: string,
  opts: { uploadBase?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const base = (opts.uploadBase ?? "https://github.com").replace(/\/+$/, "");
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 5_000);
  try {
    const res = await fetch(`${base}/user-attachments/assets/${encodeURIComponent(key)}`, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      signal: opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline,
    });
    await res.body?.cancel().catch(() => {});
    return res.status >= 300 && res.status < 400;
  } catch {
    return false;
  }
}
