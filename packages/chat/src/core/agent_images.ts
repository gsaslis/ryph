// The images a run puts into what it says: `![alt](img-…)` in a `chat__post` or in the summary
// the closing line quotes.
//
// A platform message cannot carry an image in its text, so the text and the images part ways
// here: each ref's markdown becomes its alt in the words (or `Image N` when the alt is empty),
// and the images follow the text into the same conversation, in the order they first appear,
// each captioned with that same label — so a reader can tell which picture the words meant. A
// platform that shows an upload inside a message's words (Zulip) is the exception: there the
// images go up first, and each ref's markdown becomes the link that shows it (`renderImageRefs`).
// So is one that sends images between messages (Telegram, a `captionLimit`): the text is cut
// where the images stand, and the words after a run of images ride as its caption.
//
// Invariants:
// - only `![alt](img-<12 hex>)` is a ref. Any other image markdown, or a bare `img-…`, is the
//   run's own text and goes out as written
// - one ref is one image, however often it appears: the first occurrence names it, and every
//   occurrence reads as that one label
// - at most MAX_POST_IMAGES distinct refs in one text; the caller refuses more

/** The most images one post may carry: the control plane's per-body bound. */
export const MAX_POST_IMAGES = 10;

/** A ref in markdown image syntax: an alt on one line, brackets in it balanced one level deep,
 * and the ref alone in the parentheses (spaces and `<…>` tolerated). The forge, the control plane
 * and the runner read the same grammar. */
const IMAGE_REF = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?(img-[0-9a-f]{12})>?\s*\)/g;

/** One image a text names, in order: its ref and the label the text reads it by. */
export interface ImageMention {
  ref: string;
  /** The alt as written, trimmed, or `Image N` for an empty one — never empty. */
  label: string;
}

export interface SplitImages {
  /** The text with every ref's markdown replaced by its label. */
  text: string;
  /** The distinct refs, in the order they first appear. */
  images: ImageMention[];
}

/** The text with its refs taken out, and the images they named. */
export function splitImageRefs(text: string): SplitImages {
  return renderImageRefs(text, (image) => image.label);
}

/**
 * The text with each ref's markdown replaced by what `render` makes of it, told whether this is
 * the occurrence that names the image (its first) — and the images they named. A platform that
 * shows a picture inside a message's words puts it at its first occurrence; every later one,
 * and anything `render` leaves to the label, reads as the label.
 */
export function renderImageRefs(
  text: string,
  render: (image: ImageMention, first: boolean) => string,
): SplitImages {
  const images: ImageMention[] = [];
  const labels = new Map<string, string>();
  const out = text.replace(IMAGE_REF, (_whole, alt: string, ref: string) => {
    let label = labels.get(ref);
    const first = label === undefined;
    if (label === undefined) {
      label = alt.trim() === "" ? `Image ${images.length + 1}` : alt.trim();
      labels.set(ref, label);
      images.push({ ref, label });
    }
    return render({ ref, label }, first);
  });
  return { text: out, images };
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The file name the nth image (1-based) goes up under: the platforms show it, and some judge
 * the file's kind by its extension. */
export function imageFileName(n: number, mime: string): string {
  return `image-${n}.${EXTENSIONS[mime] ?? "png"}`;
}
