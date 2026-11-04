// The ryph images extension for pi: no request pi sends carries more images than the provider
// takes.
//
// Images enter a pi run's history in three ways — on a prompt the runner sends (resized by pi),
// as a `read` of an image file, and as an image an MCP tool returned (both of those normalized by
// pi as they enter) — and once in, every one of them rides EVERY later request. Nothing in pi
// bounds the total: its compaction estimates an image at 4,800 characters whatever its size, so
// it never compacts for them. Measured with pi 1.0.0 and a strict mock of Anthropic's limits:
// four task images inline, then a message of ten the agent read one by one, made request 11 a
// 33.4 MB (31.9 MiB) one and request 12 36.0 MB (34.3 MiB), past the 32 MiB the mock allows —
// a 413, and since the history keeps them, every retry fails the same way and the run is dead. A run that reads 101 small images dies at the 100-image cap
// instead. No budget the runner keeps can prevent that: it sees only the images it sends.
//
// So this extension enforces the limit where requests are built. pi fires `context` before each
// LLM call with a copy of the conversation (dist/core/extensions/runner.js `emitContext` starts
// from a structuredClone, and agent-loop.js uses the result for that one call only — the stored
// history is untouched), and this handler keeps the newest images that fit `IMAGE_BUDGET`,
// putting a short line in place of each older one. An image left out of one request is still in
// the history and on disk: the line says how to see it again. Compaction and branch summaries
// need nothing: pi serializes those conversations to text (compaction/utils.js
// `serializeConversation` keeps text blocks only), so they never carry an image.
//
// Where the line falls is a trade with the prompt cache. Anthropic bills a request's cached
// prefix at a tenth of the input price and anything after the first difference as a cache write
// at 1.25x, and the line is where one request first differs from the last. Cutting at exactly
// what fits moved it on every new image past the budget, so every such request rewrote the cache
// from deep in the history (measured: the 21st image left a request identical to the one before
// for 2 of 41 messages). So the line falls only on block boundaries counted from the start of the
// conversation (`cutPoint`), and moves a block at a time: it stays put while the next block of
// images arrives (ten, fewer when they are large), and the price is that a request then carries
// between about half and all of the budget rather than always all of it.
//
// And it names every image a tool returns, so the agent can put it in what it writes: a text block
// `Image ref: img-<12 hex>` right after each image of a tool result, MCP tools and pi's own `read`
// alike. The ref is the first 12 hex characters of the SHA-256 of the image's decoded bytes, so
// the same screenshot is the same ref, and the runner (which uploads the bytes it narrates)
// computes the same one. Two hooks, both on what pi stores (dist/core/agent-session.js):
// `tool_result` runs inside the agent's `afterToolCall`, so its blocks are in the result that
// `tool_execution_end` carries to the runner AND in the toolResult message pi keeps. But pi
// normalizes a tool's images AFTER that hook (`normalizeToolResultImages`: an image over 2000 px
// or 4.5 MiB is resized, one in another format converted), and new bytes are a new ref. So
// `message_end`, which sees the toolResult message as it is stored and may replace it, puts each
// ref right again. The runner trusts a narrated ref only when the bytes beside it hash to it.
//
// Invariants:
// - every image of a tool result in pi's history is followed, before the next image, by exactly
//   one ref line, and that line names the image's own bytes
// - a ref line is its own text block, so an image left out of a request below (budget, text-only
//   model) keeps it: the agent can still attach an image it can no longer see
// - every request holds at most IMAGE_BUDGET.count images and IMAGE_BUDGET.chars characters of
//   image base64, and no single image over IMAGE_MAX_CHARS
// - the newest images are the ones kept, cut on one line: once an image is left out, every older
//   one is too, so what the agent sees is always "the most recent ones"
// - the line is a function of the conversation alone, and new images never move it back: the
//   handler keeps nothing between calls
// - the request filter stores nothing: it returns a new list for the call and never edits pi's
//   history (the ref hooks are the only edit, and they only add or correct ref lines)
// - a model that cannot see images (`RYPH_MODEL_TEXT_ONLY=1` on pi's env, set by the runner's
//   pi adapter from the model's `input`) gets NO image in any request: each is a line saying so.
//   pi 1.0.0 puts its own placeholder in for such a model (pi-ai's transform-messages.js), but
//   that is pi's to change; this holds whatever pi does
// - plumbing only, no network, no npm dependency: it loads in every run, tools or not
//
// Loaded by pi through jiti beside the MCP extension (`/opt/ryph/pi-mcp/images.ts` in the image)
// and tested under Bun. Only the structural slice of pi's `ExtensionAPI` and message shapes this
// file needs is typed, so neither runtime depends on the pi package.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";

/**
 * What one request's images may add up to. Anthropic's limits are a 32 MB request, 100 images,
 * 5 MB per image, and 2000x2000 for every image of a request holding more than 20.
 *
 * - 16 MiB of base64 is half the request, leaving the other half for everything else: the text
 *   of a full 1M-token context window is around 4 MB, so even that fits more than three times
 *   over. Every image pi resizes is at most 4.5 MiB of base64, so this holds three of the largest
 *   and typically five or six screenshots (fewer just after the cut moves, see `cutPoint`).
 * - 20 images keeps every request out of the 2000x2000 rule (pi's resize meets it anyway, an MCP
 *   image pi could not process might not) and far from the 100 cap; at roughly 1,600 tokens an
 *   image at most, 20 of them are about 32k tokens of context.
 */
export const IMAGE_BUDGET = { count: 20, chars: 16 * 1024 * 1024 };
/** Anthropic's per-image limit, on the base64. pi's resize keeps its images under 4.5 MiB; an
 * image it could not process passes through as the tool returned it, and is held to this. */
export const IMAGE_MAX_CHARS = 5 * 1024 * 1024;

/** How the ready line on stderr starts, after this module's `ryph pi-images: ` stamp. The runner's
 * pi adapter matches on it: `-e` is not acknowledged by pi, so a pi that stopped loading this file
 * would otherwise run on without the limit, silently. */
const READY = "ready";

/** What replaces an image left out of a request, by where it sat. Short and plain: the model
 * reads them in place of the image. */
export const LEFT_OUT = {
  /** In a message: the runner's note in the same message names its file. */
  message:
    "[An earlier image is left out here to keep the request small. Its file is named in this message: open it with your read tool to see it again.]",
  /** In what the read tool returned: the call above names the file. */
  read:
    "[An earlier image is left out here to keep the request small. Read the file again to see it.]",
  /** In what any other tool returned. */
  tool:
    "[An earlier image is left out here to keep the request small. Run the tool again to see it.]",
  /** Over the per-image limit: no request can carry it. */
  tooLarge: "[An image is left out here: it is too large to send.]",
  /** Every image, for a model that cannot see images. */
  textOnly: "[An image is left out here: the model you run on cannot see images.]",
};

/** The env var the runner's pi adapter sets to "1" on pi's spawn env when the run's model cannot
 * see images (packages/runner `TEXT_ONLY_HARNESS_ENV`, held equal by its test). */
export const TEXT_ONLY_ENV = "RYPH_MODEL_TEXT_ONLY";

/** An image block as pi holds it (pi-ai's `ImageContent`). */
export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** The slice of pi's `AgentMessage` this file reads: a role, and content that may hold images.
 * Every other field is carried over untouched. */
export interface PiMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  [key: string]: unknown;
}

/** What a `tool_result` handler sees and may answer: the result's content, replaced whole. */
export interface PiToolResultEvent {
  toolName: string;
  content: unknown[];
  structuredContent?: unknown;
}

/** The slice of pi's `ExtensionAPI` this extension uses. */
export interface PiImagesApi {
  on(
    event: "context",
    handler: (event: { messages: PiMessage[] }) => { messages: PiMessage[] } | undefined,
  ): void;
  on(
    event: "tool_result",
    handler: (
      event: PiToolResultEvent,
    ) => { content: unknown[]; structuredContent?: unknown } | undefined,
  ): void;
  on(
    event: "message_end",
    handler: (event: { message: PiMessage }) => { message: PiMessage } | undefined,
  ): void;
}

export interface ImagesExtensionOptions {
  budget?: { count: number; chars: number };
  /** Leave every image out: the model cannot see them. Defaults to `TEXT_ONLY_ENV` being "1". */
  textOnly?: boolean;
  /** Where the ready line goes. Defaults to stderr. */
  note?: (message: string) => void;
}

/** Builds the extension factory pi calls with its `ExtensionAPI`; the default export is the
 * production instance. */
export function makeImagesExtension(
  opts: ImagesExtensionOptions = {},
): (pi: PiImagesApi) => void {
  const budget = opts.budget ?? IMAGE_BUDGET;
  const note = opts.note ?? ((message: string) => {
    process.stderr.write(`ryph pi-images: ${message}\n`);
  });
  const textOnly = opts.textOnly ?? process.env[TEXT_ONLY_ENV] === "1";
  return (pi) => {
    pi.on("context", (event) => {
      const messages = textOnly
        ? withoutImages(event.messages)
        : limitImages(event.messages, budget);
      return messages === event.messages ? undefined : { messages };
    });
    pi.on("tool_result", (event) => {
      const content = withImageRefs(event.content);
      if (content === event.content) return undefined;
      // pi drops structured content that is not handed back beside new content; a ref line
      // changes nothing it describes.
      return event.structuredContent === undefined
        ? { content }
        : { content, structuredContent: event.structuredContent };
    });
    pi.on("message_end", (event) => {
      const message = event.message;
      if (message.role !== "toolResult" || !Array.isArray(message.content)) return undefined;
      const content = withImageRefs(message.content);
      return content === message.content ? undefined : { message: { ...message, content } };
    });
    note(
      textOnly
        ? `${READY} — text-only model, no images in any request`
        : `${READY} — at most ${budget.count} images per request`,
    );
  };
}

/** How a ref line starts; the ref follows. The runner reads it (packages/runner pi_vision.ts
 * `REF_LINE`, held equal by its test). */
export const REF_LINE_PREFIX = "Image ref: ";
const REF_LINE = /^Image ref: (img-[0-9a-f]{12})$/;

/** The ref of an image: `img-` and the first 12 hex characters of the SHA-256 of its decoded
 * bytes — the bytes, not the base64, which pi may re-encode without changing a pixel. */
export function imageRef(data: string): string {
  const bytes = Buffer.from(data, "base64");
  return `img-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
}

/**
 * Tool-result content with each image followed by its ref line: one already among the text
 * blocks between it and the next image is corrected in place when it names other bytes (pi
 * resized the image after the line was written), and kept when right; with none, the line goes
 * right after the image. Returns `content` itself when nothing changed.
 */
export function withImageRefs(content: unknown[]): unknown[] {
  if (!content.some(isImage)) return content;
  const out: unknown[] = [];
  let changed = false;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    out.push(block);
    if (!isImage(block)) continue;
    const ref = imageRef(block.data);
    const line = text(REF_LINE_PREFIX + ref);
    // The blocks up to the next image: the ref line, if any, is among them.
    let end = i + 1;
    while (end < content.length && !isImage(content[end])) end++;
    const following = content.slice(i + 1, end);
    const at = following.findIndex((b) => refOfLine(b) !== null);
    if (at === -1) {
      out.push(line);
      changed = true;
    } else if (refOfLine(following[at]) !== ref) {
      following[at] = line;
      changed = true;
    }
    out.push(...following);
    i = end - 1;
  }
  return changed ? out : content;
}

/** The ref a block names, when it is a ref line. */
function refOfLine(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const b = block as { type?: unknown; text?: unknown };
  if (b.type !== "text" || typeof b.text !== "string") return null;
  return REF_LINE.exec(b.text)?.[1] ?? null;
}

/**
 * The conversation with every image before the cut replaced by a line saying so (see
 * `cutPoint`): images are numbered from the start of the conversation, each message's own in
 * order, and the ones from the cut on are kept. An image over IMAGE_MAX_CHARS is always left out
 * and is not numbered, so it never moves the cut. Returns `messages` itself when nothing was left
 * out, and otherwise a new list sharing every message it did not change.
 */
export function limitImages(
  messages: PiMessage[],
  budget: { count: number; chars: number } = IMAGE_BUDGET,
): PiMessage[] {
  const sizes: number[] = [];
  let tooLarge = false;
  let newest = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const first = sizes.length;
    for (const block of message.content) {
      if (!isImage(block)) continue;
      if (block.data.length > IMAGE_MAX_CHARS) tooLarge = true;
      else sizes.push(block.data.length);
    }
    if (sizes.length > first) newest = first;
  }
  const cut = cutPoint(sizes, budget, newest);
  if (cut === 0 && !tooLarge) return messages;
  let index = 0;
  let out: PiMessage[] | null = null;
  for (const [i, message] of messages.entries()) {
    const content = message.content;
    if (!Array.isArray(content) || !content.some(isImage)) continue;
    let changed = false;
    const kept = content.map((block: unknown) => {
      if (!isImage(block)) return block;
      if (block.data.length > IMAGE_MAX_CHARS) {
        changed = true;
        return text(LEFT_OUT.tooLarge);
      }
      if (index++ >= cut) return block;
      changed = true;
      return text(leftOutLine(message));
    });
    if (!changed) continue;
    out ??= messages.slice();
    out[i] = { ...message, content: kept };
  }
  return out ?? messages;
}

/**
 * The conversation with EVERY image replaced by `LEFT_OUT.textOnly`, for a model that cannot see
 * any. Returns `messages` itself when there was none, and otherwise a new list sharing every
 * message it did not change.
 */
export function withoutImages(messages: PiMessage[]): PiMessage[] {
  let out: PiMessage[] | null = null;
  for (const [i, message] of messages.entries()) {
    const content = message.content;
    if (!Array.isArray(content) || !content.some(isImage)) continue;
    out ??= messages.slice();
    out[i] = {
      ...message,
      content: content.map((block: unknown) => isImage(block) ? text(LEFT_OUT.textOnly) : block),
    };
  }
  return out ?? messages;
}

/**
 * Where the kept images start, given every sendable image's base64 length, oldest first: 0 when
 * they all fit, and otherwise the earliest BOUNDARY from which the rest fit the budget. The
 * first image of the newest message holding any (`newest`) counts as a boundary too, so a
 * message's images that fit a request together arrive together: the runner sends a prompt's
 * images inline only when they do, beside a note saying they are attached. A message of one
 * image never needs it; the cut it gives stays only until the next image arrives.
 *
 * Boundaries are what keep the prompt cache: Anthropic caches a request's prefix, and the cut is
 * the first place two requests differ, so a cut that moved on every new image would make every
 * request a cache write of everything after it (1.25x the input price) where a read costs 0.1x.
 * An image is a boundary when it starts a new half of the budget counted from the start of the
 * conversation — every `count / 2`-th image, and the first image starting in each next
 * `chars / 2` of base64 — so the cut stays put while new images arrive, and moves only once
 * the images past the last boundary no longer fit, by a block at a time. Each boundary depends
 * only on the images before it, so the same conversation always gets the same cut (the handler
 * keeps nothing between calls) and appending images never moves the cut back.
 *
 * The cost is seeing fewer images: after the cut moves, the kept images fill about half the
 * budget rather than all of it (11 of 20 by count, at least half of it less one image by size).
 *
 * The latest boundary always fits when no image is over IMAGE_MAX_CHARS and that is at most half
 * of `chars`, as with IMAGE_BUDGET: past it lie under `count / 2` images and under half the
 * characters plus one image. A smaller budget (tests) can miss that; then the cut is the earliest
 * image from which the rest fit, and the end when not even the newest does.
 */
export function cutPoint(
  sizes: readonly number[],
  budget: { count: number; chars: number },
  newest: number = sizes.length,
): number {
  const n = sizes.length;
  // tail[c]: the characters of images c..n-1.
  const tail = new Array<number>(n + 1);
  tail[n] = 0;
  for (let c = n - 1; c >= 0; c--) tail[c] = tail[c + 1] + sizes[c];
  const fits = (c: number) => n - c <= budget.count && tail[c] <= budget.chars;
  if (fits(0)) return 0;
  const countStep = Math.max(1, Math.ceil(budget.count / 2));
  const charStep = Math.max(1, budget.chars / 2);
  let before = 0; // the characters of images 0..c-1
  for (let c = 0; c < n; c++) {
    const startsHalf = c === 0 ||
      Math.floor(before / charStep) > Math.floor((before - sizes[c - 1]) / charStep);
    if ((c % countStep === 0 || startsHalf || c === newest) && fits(c)) return c;
    before += sizes[c];
  }
  for (let c = 0; c < n; c++) if (fits(c)) return c;
  return n;
}

function leftOutLine(message: PiMessage): string {
  if (message.role !== "toolResult") return LEFT_OUT.message;
  return message.toolName === "read" ? LEFT_OUT.read : LEFT_OUT.tool;
}

function isImage(block: unknown): block is PiImage {
  return typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string";
}

function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

/** The production instance: pi calls this with its `ExtensionAPI`. */
const extension: (pi: PiImagesApi) => void = makeImagesExtension();
export default extension;
