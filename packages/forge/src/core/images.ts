// An agent's images, as a forge can carry them. A tool returned an image, the model saw its ref
// (`img-` + 12 hex), and the agent wrote `![alt](img-…)` in a body; this turns that markdown into
// what each forge shows, before it is signed:
//
//   GitHub  : `[Image: alt](<app>/images/<run>/<attachment>)` — a LINK behind ryph's login. Never
//             `![]`: GitHub's image proxy would fetch the URL without a login and show a broken
//             image, and nothing of the run is public
//   Radicle : the image becomes a file of the COB itself (an embed, a git blob in the repo), and
//             the body links it by its blob id as `[alt](<oid>)` — what Radicle Desktop writes,
//             and what both Desktop and the explorer render the embed below
//
// Invariants:
// - a ref is resolved against the RUN that wrote it, by the control plane: an image is only one a
//   tool returned in this run, and a ref it does not know fails the write with a sentence naming
//   it — never a silently broken image
// - at most `MAX_IMAGES_PER_BODY` distinct refs a body; more fails the write the same way
// - nothing here spends a cap: every refusal comes before the write is reserved
// - any other image markdown is left exactly as the agent wrote it; the forge's own sanitizing
//   applies to it as it does to any text

import type { BodyEmbed } from "../ports/forge_api.ts";
import type { ResolvedImage, RunImages } from "../ports/run_images.ts";
import type { ForgeProvider } from "./types.ts";
import { escapeInline } from "./provenance.ts";

/** How many distinct images one body may show — the control plane's per-message cap. */
export const MAX_IMAGES_PER_BODY = 10;

/**
 * `![alt](img-…)`: an alt on one line, brackets in it balanced one level deep as markdown allows
 * (`![the [old] page](…)`), and the ref alone between the parentheses (spaces and an
 * angle-bracket wrapping tolerated). The same grammar as the control plane's, the runner's and
 * chat's (and what the app's markdown reads as an image), so a ref one side checks is a ref the
 * other renders. A ref is lower-case hex; `img-ABC…` is not one.
 */
const IMAGE_MARKDOWN = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?(img-[0-9a-f]{12})>?\s*\)/g;

/** How a forge carries an image: a link to ryph, or a file of the thread itself. */
export type ImageStyle = "link" | "embed";

export function imageStyleOf(provider: ForgeProvider): ImageStyle {
  return provider === "radicle" ? "embed" : "link";
}

/** A refusal about the body's images, in the sentence the agent reads. Nothing was written. */
export class ImageRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRefError";
  }
}

/** A body ready for its forge: the text, and the files a forge that embeds must store with it. */
export interface RenderedBody {
  text: string;
  embeds: BodyEmbed[];
}

/** The distinct refs a text shows, lower-cased, in order of first appearance. */
export function imageRefsIn(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(IMAGE_MARKDOWN)) {
    const ref = match[2].toLowerCase();
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** The sentence an unknown ref fails a write with. */
export function unknownRefsMessage(refs: string[]): string {
  return `${refs.length === 1 ? "Unknown image" : "Unknown images"} ${refs.join(", ")} — ` +
    "images are only those a tool returned in this run and ryph kept, by the ref shown beside " +
    "each one; one that could not be saved must be taken again. Nothing was written.";
}

/** The git blob id of these bytes — what Radicle names an embed by, and what its body links. */
export async function gitBlobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const whole = new Uint8Array(header.length + bytes.length);
  whole.set(header, 0);
  whole.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", whole);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** An embed's file name: the ref and the format's extension, which an older explorer reads the
 * type from. Unique per body because refs are. */
function embedName(ref: string, mime: string): string {
  return `${ref}.${EXTENSIONS[mime] ?? "bin"}`;
}

/** GitHub's form: a link, escaped like every other inline text the forge writes. */
function linkMarkdown(alt: string, image: ResolvedImage): string {
  const label = alt.trim() === "" ? "Image" : `Image: ${escapeInline(alt.trim())}`;
  if (image.url === null) return alt.trim() === "" ? "Image" : escapeInline(alt.trim());
  // The id parts are the control plane's, but a parenthesis would still end the link early.
  const href = encodeURI(image.url).replaceAll("(", "%28").replaceAll(")", "%29");
  return `[${label}](${href})`;
}

/** Whether `text` has an unescaped `!` right before `offset`. */
function bangBefore(text: string, offset: number): boolean {
  if (text[offset - 1] !== "!") return false;
  let slashes = 0;
  while (text[offset - 2 - slashes] === "\\") slashes++;
  return slashes % 2 === 0;
}

/** Radicle's form: a link to the embed's blob id. Brackets in the alt become parentheses rather
 * than escapes, so the forge's own reader (`embedMarkup`) still finds the link. */
function embedMarkdown(alt: string, name: string, oid: string): string {
  const text = alt.trim().replaceAll("[", "(").replaceAll("]", ")");
  return `[${text === "" ? name : escapeInline(text)}](${oid})`;
}

/**
 * The body as its forge shows it. `runId` is the run that wrote it; null only where the caller
 * has none, and then a body with refs is refused rather than guessed at. Throws `ImageRefError`
 * for a refusal the agent reads; anything else it throws is the control plane not answering.
 */
export async function renderImages(
  images: RunImages | null,
  runId: string | null,
  text: string,
  style: ImageStyle,
): Promise<RenderedBody> {
  const refs = imageRefsIn(text);
  if (refs.length === 0) return { text, embeds: [] };
  if (refs.length > MAX_IMAGES_PER_BODY) {
    throw new ImageRefError(
      `This shows ${refs.length} images; one body may show at most ${MAX_IMAGES_PER_BODY}. ` +
        "Nothing was written.",
    );
  }
  if (images === null || runId === null) {
    throw new ImageRefError(
      "Images cannot be shown here, so nothing was written. Write it without the image refs.",
    );
  }
  const resolved = await images.resolve(runId, refs);
  const byRef = new Map(resolved.images.map((i) => [i.ref.toLowerCase(), i]));
  const unknown = refs.filter((r) => !byRef.has(r));
  if (unknown.length > 0) throw new ImageRefError(unknownRefsMessage(unknown));

  const embedded = new Map<string, BodyEmbed>();
  if (style === "embed") {
    for (const ref of refs) {
      const image = byRef.get(ref)!;
      const got = await images.bytes(runId, image.attachmentId);
      embedded.set(ref, {
        name: embedName(ref, got.mime),
        oid: await gitBlobOid(got.bytes),
        bytes: got.bytes,
      });
    }
  }
  let rendered = "";
  let from = 0;
  for (const match of text.matchAll(IMAGE_MARKDOWN)) {
    const [whole, alt, ref] = match;
    const key = ref.toLowerCase();
    let before = text.slice(from, match.index);
    let out: string;
    if (style === "embed") {
      const embed = embedded.get(key)!;
      out = embedMarkdown(alt, embed.name, embed.oid);
    } else {
      out = linkMarkdown(alt, byRef.get(key)!);
      // `!![x](img-…)` would read as `![Image: x](url)`, an image GitHub's proxy fetches without
      // a login: the `!` left in front is escaped, and reads as itself before the link. (On
      // Radicle `![x](<oid>)` is the embed itself.)
      if (out.startsWith("[") && bangBefore(text, match.index)) {
        before = `${before.slice(0, -1)}\\!`;
      }
    }
    rendered += before + out;
    from = match.index + whole.length;
  }
  rendered += text.slice(from);
  return { text: rendered, embeds: [...embedded.values()] };
}
