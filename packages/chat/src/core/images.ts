// The images a mention hands the control plane: fetched from the platform with the bot's
// credential (the run's own egress is locked, and it holds no credential anyway), checked here
// by the control plane's own rules, and placed in the text as the markers the agent is told
// about.
//
// Invariants:
// - what an image IS is decided by its bytes' magic numbers, never by what the platform claimed
//   (a Slack `mimetype`, a Telegram `mime_type`, a filename): PNG, JPEG, GIF and WebP only. The
//   check is restated from the control plane, which makes it again at its own door; it is made
//   HERE so a bad image is dropped with a note instead of refusing the whole mention there
// - every image is capped while it streams (the adapter's read), at MAX_MENTION_IMAGE_BYTES,
//   and all of a mention's together at MAX_MENTION_IMAGE_TOTAL_BYTES; at most
//   MAX_MENTION_IMAGES are taken
// - an image that cannot be taken costs only itself: the mention goes on, with a note in its
//   text where the image sat. Nothing here throws for an image's sake
// - the nth image handed over is `imageMarker(n)` in the text, counted in the order of the list,
//   and every `[image n]` in the text is one of those: the sender's own are neutralized first
// - the text fits the door's MAX_MENTION_TEXT_CHARS, markers and notes included: the sender's
//   words are what is cut

import type { ImageDownload, ImageSource } from "../ports/transport.ts";
import {
  imageMarker,
  MAX_MENTION_IMAGE_BYTES,
  MAX_MENTION_IMAGE_TOTAL_BYTES,
  MAX_MENTION_IMAGES,
  MAX_MENTION_TEXT_CHARS,
  type MentionImage,
} from "./types.ts";

/** The four formats a run may be handed. */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * The image format these bytes ARE, by their magic numbers; null for anything else — the control
 * plane's `sniffImage`, restated: PNG's eight-byte header, JPEG's SOI marker and a marker byte,
 * GIF's two versioned headers, and WebP's RIFF container naming `WEBP`.
 */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const at = (offset: number, sig: readonly number[]) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return "image/gif";
  }
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/** Why an image was not handed over, as the text says it. */
type Dropped = "too_large" | "over_total" | "not_image" | "failed";

const REASONS: Record<Dropped, string> = {
  too_large: "it is larger than 5 MiB",
  over_total: "the message's images together are more than ryph takes at once",
  not_image: "it is not a PNG, JPEG, GIF or WebP",
  failed: "it could not be downloaded",
};

/** Fetches one image, reading at most `maxBytes` — the adapter's `downloadImage`, bound to a
 * room and a signal. */
export type ImageFetcher = (source: ImageSource, maxBytes: number) => Promise<ImageDownload>;

/**
 * The images a message carries, fetched and checked, and its text with each one's place said:
 * the marker of an image handed over, or a note for one that was not. An inline source (`at`)
 * is replaced where it sits — its first occurrence after the previous one's — and the rest go
 * on lines after the text, in order. Sources past MAX_MENTION_IMAGES are not fetched at all and
 * are counted in one note.
 *
 * The sender's own words are kept apart from what this writes, for two things only this side
 * can do. Anything they typed in a marker's shape becomes `(image n)` (`neutralizeMarkers`), so
 * every `[image n]` in the result is one written here. And the result always fits the door's
 * MAX_MENTION_TEXT_CHARS: the words are cut from the end, with a note saying so, and never a
 * marker or a note — a mention past the cap would be refused there as malformed and lost.
 */
export async function attachImages(
  text: string,
  sources: readonly ImageSource[],
  fetchImage: ImageFetcher,
): Promise<{ text: string; images: MentionImage[] }> {
  const images: MentionImage[] = [];
  let total = 0;
  const pieces: Piece[] = [];
  let cursor = 0;
  const trailing: string[] = [];
  const taken = sources.slice(0, MAX_MENTION_IMAGES);

  for (const source of taken) {
    const left = MAX_MENTION_IMAGE_TOTAL_BYTES - total;
    const outcome = await take(source, left, fetchImage);
    const found = source.at === null ? -1 : text.indexOf(source.at, cursor);
    // The image's marker, or why it was not taken.
    let marker: string | null = null;
    let reason = "";
    if (outcome.kind === "image") {
      images.push({ bytes: outcome.bytes });
      total += outcome.bytes.length;
      marker = imageMarker(images.length) + (source.label === null ? "" : ` (${source.label})`);
    } else {
      reason = REASONS[outcome.why];
    }
    if (found === -1) {
      const where = source.label === null ? "" : `, ${source.label}`;
      trailing.push(marker ?? `(an image ryph could not open${where}: ${reason})`);
      continue;
    }
    pieces.push({ ours: false, text: text.slice(cursor, found) });
    if (marker !== null) {
      pieces.push({ ours: true, text: marker });
    } else {
      // The link stays, as the sender's words; the note beside it is ours.
      pieces.push({ ours: false, text: source.at! });
      pieces.push({
        ours: true,
        text: ` (ryph could not open this image: ${reason})`,
      });
    }
    cursor = found + source.at!.length;
  }
  pieces.push({ ours: false, text: text.slice(cursor) });

  const skipped = sources.length - taken.length;
  if (skipped > 0) {
    trailing.push(
      `(${skipped} more image${skipped === 1 ? " was" : "s were"} not taken: ryph takes at most ` +
        `${MAX_MENTION_IMAGES} from one message)`,
    );
  }
  return { text: compose(pieces, trailing), images };
}

/** A run of the result: the sender's words, or what this side wrote (a marker, a note). */
interface Piece {
  ours: boolean;
  text: string;
}

/** The note a text cut to fit ends with. */
const CUT_NOTE =
  `(the rest of this message was cut: ryph reads at most ${MAX_MENTION_TEXT_CHARS} ` +
  `characters of one)`;

/**
 * What the sender typed in a marker's shape, made plainly not one: `[image 2]` → `(image 2)`,
 * any case and spacing, fullwidth brackets too, and the control plane's `[image not attached…`
 * note → `(image not attached…`. Never longer than what it was given, so the cut below measures
 * true. Without it a caption saying "[image 2]" would read exactly as the second image handed
 * over — to the agent, and to the door, which counts markers as no ask. The control plane's
 * `neutraliseMarkers` (core/attachments.ts), restated; the parity test holds the two equal.
 */
export function neutralizeMarkers(text: string): string {
  return text
    .replace(/[\[\uFF3B]\s*image\s*(\d+)\s*[\]\uFF3D]/giu, "(image $1)")
    .replace(/[\[\uFF3B](\s*image\b)/giu, "($1");
}

/**
 * The pieces as one text, the words neutralized, the trailing lines after a blank line, all of
 * it within MAX_MENTION_TEXT_CHARS. Past the cap, the words keep their start (where the ask
 * is) and lose their end, the markers and notes keep their places, and CUT_NOTE is said last.
 */
function compose(pieces: Piece[], trailing: string[]): string {
  const words = pieces.map((p) => p.ours ? p : { ours: false, text: neutralizeMarkers(p.text) });
  const render = (ps: Piece[], tail: string[]) =>
    [ps.map((p) => p.text).join("").trim(), tail.join("\n")]
      .filter((s) => s !== "").join("\n\n").trim();
  const whole = render(words, trailing);
  if (whole.length <= MAX_MENTION_TEXT_CHARS) return whole;

  const tail = [...trailing, CUT_NOTE];
  // What is ours, the blank line, and the newlines between trailing lines: an upper bound, as
  // trimming only shortens. Bounded far below the cap — ten markers and notes, one count.
  const fixed = words.filter((p) => p.ours).reduce((n, p) => n + p.text.length, 0) +
    tail.join("\n").length + 2;
  let budget = Math.max(0, MAX_MENTION_TEXT_CHARS - fixed);
  const cut = words.map((p) => {
    if (p.ours) return p;
    if (p.text.length <= budget) {
      budget -= p.text.length;
      return p;
    }
    // Cut: what is kept ends with "… ", so it reads as cut and stays apart from a marker after
    // it — and never ends in half a surrogate pair.
    let keep = Math.max(0, budget - 2);
    if (keep > 0 && /[\uD800-\uDBFF]/.test(p.text[keep - 1])) keep -= 1;
    budget = 0;
    return { ours: false, text: keep === 0 ? "" : `${p.text.slice(0, keep)}… ` };
  });
  return render(cut, tail);
}

/** One source, fetched and checked, or why not. A size the platform announced over what is
 * left is refused before a byte is asked for. */
async function take(
  source: ImageSource,
  left: number,
  fetchImage: ImageFetcher,
): Promise<{ kind: "image"; bytes: Uint8Array } | { kind: "dropped"; why: Dropped }> {
  if (source.size !== null && source.size > MAX_MENTION_IMAGE_BYTES) {
    return { kind: "dropped", why: "too_large" };
  }
  if (left <= 0 || (source.size !== null && source.size > left)) {
    return { kind: "dropped", why: "over_total" };
  }
  const cap = Math.min(MAX_MENTION_IMAGE_BYTES, left);
  const got = await fetchImage(source, cap);
  if (got.kind === "failed") return { kind: "dropped", why: "failed" };
  if (got.kind === "too_large") {
    return { kind: "dropped", why: cap < MAX_MENTION_IMAGE_BYTES ? "over_total" : "too_large" };
  }
  if (got.bytes.length === 0) return { kind: "dropped", why: "failed" };
  if (sniffImage(got.bytes) === null) return { kind: "dropped", why: "not_image" };
  return { kind: "image", bytes: got.bytes };
}
