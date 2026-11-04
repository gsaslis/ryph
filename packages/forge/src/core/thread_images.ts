// Which of a thread's images a read downloads, and where each one lands on the thread — the part
// of a read with images that is the same on every forge. The adapters find the images (GitHub
// in `body_html`, Radicle in a comment's embeds) and say how to fetch each; this decides.
//
// The rule, when a thread shows more than one read carries (`MAX_THREAD_IMAGES`):
//
//   1. the FOCUS entry's — the comment that issued the command, which is what "look at this"
//      points at
//   2. the opening post's — on an issue, that is the bug report's own screenshot
//   3. everything else, NEWEST entry first — where the thread stands now
//
// and, within one entry, in order of appearance. An image past the count is still placed, as
// `omitted` with `limit`, so the reader can say one was there. A download that fails does not
// hand its place to the next one: the count is of images ASKED for, which keeps the number of
// requests one read makes at the cap however hostile the thread.

import type { ThreadContext, ThreadImage } from "../ports/forge_api.ts";
import { type ImageOutcome, MAX_THREAD_IMAGES } from "../helpers/image_download.ts";

/** How long all of a read's downloads may take together. The control plane gives a read with
 * images at most 40 s less what the command's handling has already spent
 * (IMAGE_READ_DEADLINE_MS in its forge_api.ts), inside an event handler's 60 s; the 45 s of
 * DEFAULT_THREAD_TIMEOUT_MS is the text-only read's. This leaves the listings most of it, and
 * an image still in flight when it runs out is `unavailable`. */
export const IMAGES_BUDGET_MS = 15_000;

/** How many downloads run at once. */
const CONCURRENCY = 4;

/** How many images one entry may name before the rest are left as plain text. A body of
 * 16 000 characters holds hundreds of tiny `<img>` tags; nobody posted those to be looked at. */
export const MAX_SLOTS_PER_ENTRY = 50;

/** The longest `markup` a thread image carries — the control plane's thread schema holds it to
 * the same (`MAX_THREAD_IMAGE_MARKUP` in packages/orchestrator/src/ports/forge.ts, and a parity
 * test holds the two together). The markup is whatever its author typed: an `<img>` tag's alt
 * text is unbounded, and one tag over the control plane's bound used to fail the WHOLE thread
 * read, every redelivery, until the command was lost. A longer one is carried as "" — the
 * image is still the entry's, and its marker follows the text instead of replacing the tag. */
export const MAX_IMAGE_MARKUP = 4_000;

/** The longest `ThreadEntry.id` a read names an entry by — the control plane's schema bound,
 * and the request schema's for `focus`. A GitHub handle is a number; a Radicle one is two
 * object ids and a kind. One longer than this is left off: the entry is still the thread's, only
 * not one a command can be found in. */
export const MAX_ENTRY_ID = 300;

/** The longest file `name` a thread image carries (a Radicle embed's); cut, never refused. The
 * control plane's schema allows 255. */
export const MAX_IMAGE_NAME = 200;

/** One image an adapter found, before anything was downloaded. */
export interface ImageSlot {
  /** Whose: the opening post, or the entry at this index of `ThreadContext.entries`. */
  owner: "body" | number;
  /** The text in that body that showed it (see `ThreadImage.markup`). */
  markup: string;
  /** Which exact match of `markup` in that body it is (see `ThreadImage.occurrence`); absent
   * for the first. */
  occurrence?: number;
  name?: string;
  /** How to get the bytes; null when the adapter already knows there are none to get (an
   * `<img>` whose signed URL the forge never rendered). */
  fetch: ((signal: AbortSignal) => Promise<ImageOutcome>) | null;
}

/**
 * Downloads the chosen slots and writes every slot onto the thread — `bodyImages` and each
 * entry's `images`, in order of appearance — as an image or an omission. Mutates `context`.
 * Never throws: a fetch that does is `unavailable`.
 */
export async function attachThreadImages(
  context: ThreadContext,
  given: readonly ImageSlot[],
  focus: string | null,
  opts: { budgetMs?: number; max?: number; focusOnly?: boolean } = {},
): Promise<void> {
  const max = opts.max ?? MAX_THREAD_IMAGES;
  const focusIndex = focus === null ? -1 : context.entries.findIndex((e) => e.id === focus);
  // `focusOnly`: the reader wants the command's own comment's images and nothing else (a
  // follow-up to a live run, which was handed the rest at its start) — so nothing else is
  // downloaded, and nothing else is written: an entry without `images` is one this read did not
  // ask about, which is not the same as one with none.
  const slots = opts.focusOnly ? given.filter((slot) => slot.owner === focusIndex) : given;
  // Lower ranks first; ties keep the order the adapter found them in, which is appearance.
  const rank = (slot: ImageSlot): number => {
    if (slot.owner === focusIndex) return 0;
    if (slot.owner === "body") return 1;
    return 2 + (context.entries.length - slot.owner);
  };
  const ordered = slots.map((slot, i) => ({ slot, i })).sort((a, b) =>
    rank(a.slot) - rank(b.slot) || a.i - b.i
  );

  const outcomes = new Map<number, ImageOutcome | { kind: "omitted"; reason: "limit" }>();
  const chosen: Array<{ i: number; fetch: (signal: AbortSignal) => Promise<ImageOutcome> }> = [];
  for (const { slot, i } of ordered) {
    if (slot.fetch === null) outcomes.set(i, { kind: "omitted", reason: "unavailable" });
    else if (chosen.length < max) chosen.push({ i, fetch: slot.fetch });
    else outcomes.set(i, { kind: "omitted", reason: "limit" });
  }

  const budget = AbortSignal.timeout(opts.budgetMs ?? IMAGES_BUDGET_MS);
  let next = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const { i, fetch } = chosen[next++];
      if (budget.aborted) {
        outcomes.set(i, { kind: "omitted", reason: "unavailable" });
        continue;
      }
      try {
        outcomes.set(i, await fetch(budget));
      } catch {
        outcomes.set(i, { kind: "omitted", reason: "unavailable" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chosen.length) }, worker));

  const body: ThreadImage[] = [];
  const perEntry = new Map<number, ThreadImage[]>();
  slots.forEach((slot, i) => {
    const outcome = outcomes.get(i) ?? { kind: "omitted", reason: "unavailable" };
    const named = slot.name === undefined ? {} : { name: slot.name.slice(0, MAX_IMAGE_NAME) };
    const markup = slot.markup.length > MAX_IMAGE_MARKUP ? "" : slot.markup;
    // Only a match after the first is said: an occurrence of "" is no place, and 0 is the
    // default the control plane reads an absent one as.
    const where = markup !== "" && slot.occurrence !== undefined && slot.occurrence > 0
      ? { markup, occurrence: slot.occurrence }
      : { markup };
    const image: ThreadImage = outcome.kind === "image"
      ? { kind: "image", ...where, ...named, data: outcome.bytes.toBase64() }
      : { kind: "omitted", ...where, ...named, reason: outcome.reason };
    if (slot.owner === "body") body.push(image);
    else perEntry.set(slot.owner, [...(perEntry.get(slot.owner) ?? []), image]);
  });
  if (opts.focusOnly) {
    if (focusIndex !== -1) context.entries[focusIndex].images = perEntry.get(focusIndex) ?? [];
    return;
  }
  context.bodyImages = body;
  context.entries.forEach((entry, i) => {
    entry.images = perEntry.get(i) ?? [];
  });
}
