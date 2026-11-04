// Image refs, as the runner checks them: the agent names an image a tool returned by the ref
// pi's images extension printed after it (`Image ref: img-<12 hex>`, packages/pi-mcp/images.ts)
// and writes `![alt](img-…)` in a summary or a patch description. Before such a text is
// recorded or shipped, the runner waits on its own uploads (an image's upload may still be in
// flight when the agent writes about it) and asks the control plane which refs the run keeps;
// one that names nothing fails the tool call with a reason the agent can act on. The control
// plane's core/image_refs.ts is the rule; the syntax, the limit and the words are restated here
// (the runner imports no service package) and held equal by tests/image_refs_test.ts.

import type { Attachments } from "../ports/attachments.ts";
import { errorMessage } from "../helpers/errors.ts";

/** How many refs one text may carry. */
export const MAX_IMAGE_REFS = 10;

/** How long a check waits on the run's own uploads still in flight before it asks anyway. */
export const IMAGE_UPLOADS_WAIT_MS = 30_000;

/** `![alt](img-…)`, the one syntax that names an image. */
const REF_SYNTAX = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?(img-[0-9a-f]{12})>?\s*\)/g;

/** Every ref `text` names as an image, once each, in the order first named. */
export function imageRefsIn(text: string): string[] {
  return [...new Set([...text.matchAll(REF_SYNTAX)].map((m) => m[2]))];
}

/** The ref of an image: `img-` and the first 12 hex of the SHA-256 of its bytes. */
export async function imageRefOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "img-" +
    Array.from(digest.subarray(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a text naming refs the run does not keep is refused with (the control plane's words). */
export function unknownRefsError(unknown: readonly string[]): string {
  const named = unknown.length === 1
    ? `No image this run kept has the ref ${unknown[0]}.`
    : `No images this run kept have the refs ${unknown.join(", ")}.`;
  return `${named} An image ref names an image a tool returned in this run: the \`Image ref:\` ` +
    "line right after it. An image that could not be saved was not kept: take it again, and use " +
    "the ref shown after it.";
}

/** Why the runner did not keep an image a tool returned (adapters/harness/pi_vision.ts). */
export type UnkeptReason =
  | "event-budget"
  | "paused"
  | "type"
  | "too-large"
  | "not-base64"
  | "timeout"
  | "refused"
  | "backlog";

/** How many unkept refs a run remembers: the latest ones, which are the ones a text names. */
export const MAX_UNKEPT_REFS = 64;

const UNKEPT_WHY: Record<UnkeptReason, string> = {
  "event-budget": "its tool returned more images than could be saved in time",
  paused: "saving images was paused after uploads failed or were slow",
  type: "its format is not one ryph keeps (PNG, JPEG, GIF or WebP)",
  "too-large": "it is larger than 5 MiB",
  "not-base64": "its data could not be read",
  timeout: "its upload timed out",
  refused: "its upload was refused",
  backlog: "too many images were waiting to be saved",
};

/** What a text naming an image the runner did not keep is refused with: what happened to it. */
export function unkeptRefError(ref: string, reason: UnkeptReason): string {
  const retry = reason === "type" || reason === "too-large"
    ? "It cannot be shown; show a smaller PNG or JPEG instead."
    : "Take it again, and use the ref shown after it.";
  return `The image ${ref} was not saved: ${UNKEPT_WHY[reason]}. ${retry}`;
}

/** What a text naming more than MAX_IMAGE_REFS images is refused with. */
export function tooManyRefsError(count: number): string {
  return `The text names ${count} images; one text may show at most ${MAX_IMAGE_REFS}.`;
}

/**
 * Null when every image ref `text` names is one the run keeps (or it names none), else why not,
 * for the agent. Waits on `pending` (the run's uploads still in flight) for up to `waitMs` first.
 * `unkept` is what the runner knows it did not keep, and why: pi's images extension shows the
 * model a ref before the runner has tried to keep the image, so a ref the agent read may name
 * nothing, and the refusal says why rather than that no tool returned it.
 */
export async function checkImageRefs(
  text: string,
  attachments: Pick<Attachments, "resolveImageRefs"> | undefined,
  pending: readonly Promise<unknown>[],
  unkept: ReadonlyMap<string, UnkeptReason> = new Map(),
  waitMs = IMAGE_UPLOADS_WAIT_MS,
): Promise<string | null> {
  const refs = imageRefsIn(text);
  if (refs.length === 0) return null;
  if (refs.length > MAX_IMAGE_REFS) return tooManyRefsError(refs.length);
  if (attachments === undefined) {
    return "This run keeps no images, so a text cannot show one: leave out the ![…](img-…).";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => timer = setTimeout(resolve, waitMs)),
  ]);
  clearTimeout(timer);
  let answer: { known: string[]; unknown: string[] };
  try {
    answer = await attachments.resolveImageRefs(refs);
  } catch (err) {
    return `The images it shows could not be checked just now (${errorMessage(err)}); try ` +
      "again shortly.";
  }
  if (answer.unknown.length === 0) return null;
  const explained = answer.unknown.flatMap((ref) => {
    const reason = unkept.get(ref);
    return reason === undefined ? [] : [unkeptRefError(ref, reason)];
  });
  const rest = answer.unknown.filter((ref) => !unkept.has(ref));
  return [...explained, ...(rest.length === 0 ? [] : [unknownRefsError(rest)])].join(" ");
}
