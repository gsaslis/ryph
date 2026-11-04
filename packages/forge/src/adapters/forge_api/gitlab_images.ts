// Finding the images a GitLab body shows, and reading each one's bytes through the API.
//
// What GitLab writes when an image is pasted or dropped into a note: `![name](/uploads/<secret>/<file>)`
// — a path relative to the PROJECT, whose 32-hex secret is scoped to that project. The same upload
// is linked absolutely as `<instance>/<path_with_namespace>/uploads/<secret>/<file>` (copied from a
// rendered page) or, since 17.x, `<instance>/-/project/<id>/uploads/<secret>/<file>`; and any of
// these can stand in a raw `<img src>`. On a self-managed instance under a path prefix
// (`https://host/gitlab`) the absolute forms carry the prefix.
//
// Reading one in a private project needs the token: the page URL answers a sign-in redirect to a
// service. The bytes come from `GET /projects/:id/uploads/:secret/:filename` (17.4+), and the
// request is REBUILT from the parsed secret and file name — the URL in the body is never followed.
// Only this project's uploads on this instance are fetched, so the credentialed read is bounded to
// one origin and one route shape: a thread cannot point it at another host, another API path, or
// another project's upload (whose visibility it may not share).
//
// Unlike GitHub's, there is no rendered HTML to decide which images a reader saw — the notes API
// carries markdown only — so the markdown is read here: a `![alt](url)` or an `<img>` open tag,
// outside fenced blocks, code spans and HTML comments. A misreading can add or drop an image of
// this project's own uploads, never reach anything else.
//
// What is NOT an image: any URL that is not an upload on this instance (a badge, a hotlinked
// picture) stays text, as on GitHub — "look at this link" is not something a thread may make this
// service fetch. An upload of ANOTHER project on this instance is an image the reader saw, so it is
// a slot, but one omitted as `unavailable`: its secret is not this project's, and reading it with
// the bot's token would carry a private project's screenshot into this thread.

import {
  IMAGE_TIMEOUT_MS,
  imageOf,
  type ImageOutcome,
  MAX_THREAD_IMAGE_BYTES,
} from "../../helpers/image_download.ts";
import { readCappedBytes } from "@ryph/shared/http";
import { codeRanges, withinRanges } from "@ryph/shared/markdown";
import { type ImageSlot, MAX_IMAGE_MARKUP, MAX_SLOTS_PER_ENTRY } from "../../core/thread_images.ts";
import type { GitlabImageSlots, GitlabImageSource } from "../../ports/gitlab.ts";

/** An upload's secret: `SecureRandom.hex`, 32 lowercase hex. */
const SECRET = /^[0-9a-f]{32}$/;

/** How many `<img` openings one body's scan reads as tags — each read is bounded by
 * MAX_IMAGE_MARKUP, so this caps the work a body of thousands of `<img` can cause. */
const MAX_TAG_READS = 256;

/** What GitLab renders `![]()` of as a player, not a picture (its `VIDEO_EXT`/`AUDIO_EXT`):
 * bytes no reader looks at, so never downloaded. */
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|ogv|mp3|oga|ogg|spx|wav|flac|aac|m4a)$/i;

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** A blank line: what ends a paragraph, and so any raw tag or image in it. */
const BLANK_LINE = /\n[ \t]*\r?\n/;

// ── which URL is an upload ──────────────────────────────────────────────────────────────────

/** An upload a URL names: its secret and its one-segment file name (decoded), and whether it is
 * this project's — the only kind ever fetched. */
export interface GitlabUpload {
  secret: string;
  filename: string;
  own: boolean;
}

/** `<secret>/<file>` at the end of an upload path, or null — exactly two segments, the file name
 * one segment that decodes to no separator and is not a dot segment. */
function secretAndFile(rest: string): { secret: string; filename: string } | null {
  const parts = rest.split("/");
  if (parts.length !== 2 || !SECRET.test(parts[0]) || parts[1] === "") return null;
  let filename: string;
  try {
    filename = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (/[/\\\0]/.test(filename) || filename === "." || filename === "..") return null;
  return { secret: parts[0], filename };
}

/**
 * The upload `raw` names, read against `source` — null for anything that is not an upload on this
 * instance. The forms:
 *
 * - `/uploads/<secret>/<file>`: relative to the project, so always this project's
 * - `<instance>/<path>/uploads/<secret>/<file>`: this project's when `<path>` is its
 *   `path_with_namespace` (case-insensitively, as GitLab routes it), another's otherwise
 * - `<instance>/-/project/<id>/uploads/<secret>/<file>`: this project's when `<id>` is its id
 *
 * `<instance>` is `instanceUrl` with its path prefix, and the same paths written root-relative
 * (`/<prefix>/<path>/uploads/…`) are read the same. Scheme, host and port must be the instance's;
 * credentials in the URL, a query or a fragment name no upload — GitLab writes none of them.
 */
export function gitlabUpload(raw: string, source: GitlabImageSource): GitlabUpload | null {
  const relative = raw.match(/^\/uploads\/([^?#]*)$/);
  if (relative) {
    const found = secretAndFile(relative[1]);
    return found && { ...found, own: true };
  }
  let instance: URL;
  let url: URL;
  try {
    instance = new URL(source.instanceUrl);
    // A root-relative path resolves against the instance's origin; `//host/…` is another host.
    if (raw.startsWith("//")) return null;
    url = new URL(raw, instance.origin);
  } catch {
    return null;
  }
  if (
    url.origin !== instance.origin || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || /[?#]/.test(raw)
  ) return null;
  const prefix = instance.pathname.replace(/\/+$/, "");
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  const path = url.pathname.slice(prefix.length + 1);

  const byId = path.match(/^-\/project\/(\d+)\/uploads\/(.*)$/);
  if (byId) {
    const found = secretAndFile(byId[2]);
    return found && { ...found, own: byId[1] === source.projectId };
  }
  const at = path.indexOf("/uploads/");
  if (at <= 0) return null;
  const project = path.slice(0, at);
  // A project path: 2–20 segments, none empty, none GitLab's `-` route separator.
  const segments = project.split("/");
  if (segments.length < 2 || segments.some((s) => s === "" || s === "-")) return null;
  const found = secretAndFile(path.slice(at + "/uploads/".length));
  let decoded: string;
  try {
    decoded = decodeURIComponent(project);
  } catch {
    return null;
  }
  return found && { ...found, own: decoded.toLowerCase() === source.projectPath.toLowerCase() };
}

// ── where each image sits in the markdown ───────────────────────────────────────────────────

/**
 * The parts of `markdown` that render as no image, as sorted, disjoint `[start, end)` ranges: its
 * code (`codeRanges`, GitHub's reading too) and HTML comments, which GitLab hides. Not
 * GitLab's `$$` math, which can only make a quoted example of this project's own upload count as
 * an image.
 */
function quietRanges(markdown: string): Array<[number, number]> {
  const ranges = codeRanges(markdown);
  // Comments outside code: `<!--` to the next `-->`, or to the end.
  const code = [...ranges];
  for (let at = markdown.indexOf("<!--"); at !== -1;) {
    if (withinRanges(code, at)) {
      at = markdown.indexOf("<!--", at + 4);
      continue;
    }
    const close = markdown.indexOf("-->", at + 4);
    const end = close === -1 ? markdown.length : close + 3;
    ranges.push([at, end]);
    at = markdown.indexOf("<!--", end);
  }
  // Disjoint: a range inside an earlier one is dropped.
  const sorted = ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** The five entities an attribute value is likely to carry — enough for a URL. */
function unescapeHtml(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? "",
  );
}

/**
 * The CommonMark open tag at `at`, if `<img` starts one: attribute names
 * `[A-Za-z_:][A-Za-z0-9_.:-]*`, values bare, single- or double-quoted, whitespace before each
 * attribute, no blank line, at most MAX_IMAGE_MARKUP characters. Its end and first `src` value.
 */
function imgTagAt(markdown: string, at: number): { end: number; src: string | null } | null {
  const limit = Math.min(markdown.length, at + MAX_IMAGE_MARKUP);
  const nameStart = /[A-Za-z_:]/;
  const nameChar = /[A-Za-z0-9_.:-]/;
  let i = at + 4;
  let src: string | null = null;
  const finish = (end: number) => BLANK_LINE.test(markdown.slice(at, end)) ? null : { end, src };
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
    let value: string;
    const quote = markdown[j];
    if (quote === '"' || quote === "'") {
      const end = markdown.indexOf(quote, j + 1);
      if (end === -1 || end >= limit) return null;
      value = markdown.slice(j + 1, end);
      i = end + 1;
    } else {
      let end = j;
      while (end < limit && !isSpace(markdown[end]) && !`"'=<>\``.includes(markdown[end])) end++;
      if (end === j) return null;
      value = markdown.slice(j, end);
      i = end;
    }
    if (name === "src" && src === null) src = unescapeHtml(value);
  }
  return null;
}

/** A markdown image: `![alt](url)`, `![alt](<url>)`, either with a `"title"`, `'title'` or
 * `(title)`. The alt holds no bracket and no line break, the url no space or paren — an exotic
 * spelling is text, which only loses that one image. Each part stops at its first delimiter, so
 * the scan is linear. */
const MARKDOWN_IMAGE =
  /!\[[^[\]\n]*\]\([ \t]*(?:<([^<>\n]*)>|([^\s()<>]+))(?:[ \t\n]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/g;

/** One image markup in the markdown, before it is read as an upload. */
interface Found {
  start: number;
  end: number;
  url: string;
}

/** Every image markup of `markdown` outside quiet ranges, in order, none inside another (an
 * `![]()` spelled in an `<img>`'s alt is that alt's text). */
function imageMarkups(markdown: string): Found[] {
  const quiet = quietRanges(markdown);
  const found: Found[] = [];
  for (const m of markdown.matchAll(MARKDOWN_IMAGE)) {
    found.push({ start: m.index, end: m.index + m[0].length, url: m[1] ?? m[2] });
  }
  let reads = 0;
  for (const m of markdown.matchAll(/<img(?=[\s/>])/gi)) {
    if (reads++ >= MAX_TAG_READS) break;
    const tag = imgTagAt(markdown, m.index);
    if (tag !== null && tag.src !== null) {
      found.push({ start: m.index, end: tag.end, url: tag.src.trim() });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const kept: Found[] = [];
  let reach = 0;
  for (const f of found) {
    if (f.start < reach || withinRanges(quiet, f.start)) continue;
    kept.push(f);
    reach = f.end;
  }
  return kept;
}

/**
 * How many exact matches of `markup` in `markdown`, overlapping ones too, start before `start` —
 * counted the way the prompt finds the match again. Placements come in markdown order, so
 * `counted` carries each markup's count forward and the markdown is scanned once per markup.
 */
function occurrenceOf(
  markdown: string,
  markup: string,
  start: number,
  counted: Map<string, { from: number; count: number }>,
): number {
  let { from, count } = counted.get(markup) ?? { from: 0, count: 0 };
  for (let at = markdown.indexOf(markup, from); at !== -1 && at < start;) {
    count++;
    from = at + 1;
    at = markdown.indexOf(markup, from);
  }
  counted.set(markup, { from: start, count });
  return count;
}

// ── the read ────────────────────────────────────────────────────────────────────────────────

/**
 * One upload's bytes through `GET /projects/:id/uploads/:secret/:filename`, the path rebuilt from
 * its parts, with the adapter's token (inside `source.get`, which follows no redirect off the
 * instance). Never throws: anything but a 200 is `unavailable`, which is how an instance before
 * 17.4 — where the route does not exist and answers 404 — degrades.
 *
 * Verified on GitLab 17.11 with local storage: a Developer (and a Reporter's floor above it) gets
 * the bytes, 200 with no redirect, typed `application/octet-stream` — which is why the image is
 * sniffed, never taken from the header — while listing uploads stays Maintainer-only (403).
 *
 * Unverified: with object storage and `proxy_download: false`, GitLab may answer a 302 to the
 * bucket. `source.get` does not follow it off the instance, and it is `unavailable` here — the
 * bucket's URL is never dialled, keeping the read to the configured origin.
 */
async function readUpload(
  source: GitlabImageSource,
  upload: GitlabUpload,
  signal: AbortSignal,
): Promise<ImageOutcome> {
  const unavailable: ImageOutcome = { kind: "omitted", reason: "unavailable" };
  const path = `/projects/${encodeURIComponent(source.projectId)}/uploads/${upload.secret}/${
    encodeURIComponent(upload.filename)
  }`;
  try {
    const res = await source.get(
      path,
      AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
    );
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return unavailable;
    }
    return imageOf(await readCappedBytes(res, MAX_THREAD_IMAGE_BYTES));
  } catch {
    // A network death, the deadline, a body that failed mid-read: all the same to the reader.
    return unavailable;
  }
}

/**
 * Every image of `body` that is an upload on the instance, in order of appearance, at most
 * MAX_SLOTS_PER_ENTRY: this project's with a fetch of its bytes, another project's with none.
 * Each slot's markup is the `![]()` or `<img>` that showed it, and its name the upload's file name.
 */
export const gitlabImageSlots: GitlabImageSlots = (owner, body, source) => {
  const slots: ImageSlot[] = [];
  const counted = new Map<string, { from: number; count: number }>();
  for (const found of imageMarkups(body)) {
    if (slots.length >= MAX_SLOTS_PER_ENTRY) break;
    const upload = gitlabUpload(found.url, source);
    if (upload === null || MEDIA_EXT.test(upload.filename)) continue;
    const markup = body.slice(found.start, found.end);
    const occurrence = occurrenceOf(body, markup, found.start, counted);
    slots.push({
      owner,
      markup,
      ...(occurrence > 0 ? { occurrence } : {}),
      name: upload.filename,
      fetch: upload.own ? (signal) => readUpload(source, upload, signal) : null,
    });
  }
  return slots;
};
