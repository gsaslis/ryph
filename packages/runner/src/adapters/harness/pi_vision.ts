// What pi's model sees, and what the transcript keeps of what it saw.
//
// Two things, both pi's knowledge and nothing the core needs to learn:
//
// - `keepToolImages`: every image a tool returned (a browser screenshot, a file pi's read tool
//   opened, any MCP tool's image) is uploaded as a run attachment BEFORE the tool's result is
//   narrated, so the narrated block names it by id (`attachment: {id, mime}`) and the history
//   never carries its bytes. The uploads run OFF the adapter's read loop, one at a time, and
//   narration goes through an ordered chain that waits on each event's own uploads (pi.ts): pi's
//   RPC mode waits on stdout backpressure for every event, so a read loop that awaited an upload
//   would freeze the agent. Bounded: each image gets KEEP_IMAGE_TIMEOUT_MS, an event
//   KEEP_EVENT_BUDGET_MS in all, at most KEEP_BACKLOG events wait on uploads (an image arriving
//   past that is narrated unkept), and after KEEP_FAILURES_TO_PAUSE failures in a row — refused,
//   timed out, or slower than KEEP_SLOW_MS — uploads pause for KEEP_PAUSE_MS. An image that was
//   not kept is narrated without `attachment`, which costs the transcript a picture, and is
//   reported to the run by its ref with why (`unkeptImage`): the model has already read a ref
//   for it, and a text naming that ref is refused for what really happened. Each goes up under
//   its image ref, the name the agent writes it by: the ref line pi's images extension put
//   after it (`Image ref: img-…`, packages/pi-mcp/images.ts), read by position, when the bytes
//   beside it hash to it, and the hash of those bytes otherwise. They differ when pi resized the
//   image after the extension's `tool_result` hook named it: the extension corrects pi's history
//   at `message_end`, after this event was printed, so the hash is what the agent reads, and the
//   narrated line is corrected to it as well.
// - `piModelSeesImages`: whether the run's model takes images, decided at boot (the browser is
//   configured before pi starts). A custom endpoint's model sees only when the admin said so
//   (`vision: true`); a built-in one's answer is pi's own catalogue entry (`input`), read from
//   the pi package the harness layer baked; anything that cannot be read defaults to true,
//   which is what the run did before anyone asked.

import { readFile } from "node:fs/promises";
import { type AttachmentRef, THINKING_LEVELS } from "../../core/types.ts";
import { imageRefOf, type UnkeptReason } from "../../core/image_refs.ts";
import type { Diagnostics } from "../../ports/diagnostics.ts";
import { MODEL_ENDPOINT_ENV } from "../../core/brand.ts";
import { errorMessage } from "../../helpers/errors.ts";

type JsonObject = Record<string, unknown>;

/** The control plane's per-image cap (core/attachments.ts `MAX_ATTACHMENT_BYTES`), restated and
 * pinned by tests/pi_vision_test.ts: a larger image is never sent, since it would be refused. */
export const KEEP_MAX_BYTES = 5 * 1024 * 1024;
/** The four types the control plane keeps; pi's read also returns BMP, which it would refuse. */
const KEPT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** How long one image's upload may hold the narration back. */
export const KEEP_IMAGE_TIMEOUT_MS = 15_000;
/** How long one event's images may hold it back in all; later images in it go unkept. */
export const KEEP_EVENT_BUDGET_MS = 30_000;
/** An upload slower than this counts as a failure towards the pause, even when it is kept: a
 * control plane that slow holds every later narration back. */
export const KEEP_SLOW_MS = 5_000;
/** Failures in a row (refused, timed out, or slow) that pause uploads: a control plane that does
 * not answer, or answers slowly, should not cost every screenshot its full timeout. */
const KEEP_FAILURES_TO_PAUSE = 2;
const KEEP_PAUSE_MS = 60_000;
/** How many events may wait on their uploads at once; an event with images arriving past that is
 * narrated without keeping them (in its place), so a stalled control plane holds a bounded
 * amount of pi's output, and bytes, in the runner. */
export const KEEP_BACKLOG = 8;

export interface KeepImagesOptions {
  imageTimeoutMs?: number;
  eventBudgetMs?: number;
  slowMs?: number;
  backlog?: number;
  now?: () => number;
}

/** The uploads of one run's tool images: the keep function, its bounds, and the pause state. */
export interface ToolImageKeeper {
  /** The refs of the event's kept images, by the block object they were read from. */
  keep(event: JsonObject, signal: AbortSignal): Promise<Map<object, AttachmentRef>>;
}

/** How a ref line starts (packages/pi-mcp/images.ts `REF_LINE_PREFIX`, held equal by
 * tests/pi_vision_test.ts). */
export const REF_LINE_PREFIX = "Image ref: ";
const REF_LINE = /^Image ref: (img-[0-9a-f]{12})$/;

export function toolImageKeeper(
  keepImage: (
    bytes: Uint8Array,
    imageRef: string,
    signal: AbortSignal,
  ) => Promise<AttachmentRef | null>,
  diag: Diagnostics,
  opts: KeepImagesOptions = {},
  /** Each image NOT kept, by every ref the agent may know it by, and why. */
  unkept: (imageRef: string, reason: UnkeptReason) => void = () => {},
): ToolImageKeeper {
  const imageTimeoutMs = opts.imageTimeoutMs ?? KEEP_IMAGE_TIMEOUT_MS;
  const eventBudgetMs = opts.eventBudgetMs ?? KEEP_EVENT_BUDGET_MS;
  const slowMs = opts.slowMs ?? KEEP_SLOW_MS;
  const now = opts.now ?? Date.now;
  let failures = 0;
  let pausedUntil = 0;

  /** One image: the ref, or null — never longer than `ms`, whatever the port does. */
  const one = async (bytes: Uint8Array, imageRef: string, ms: number, run: AbortSignal) => {
    const timer = AbortSignal.timeout(ms);
    const signal = AbortSignal.any([run, timer]);
    let unhook = () => {};
    const stopped = new Promise<null>((resolve) => {
      const done = () => resolve(null);
      signal.addEventListener("abort", done, { once: true });
      unhook = () => signal.removeEventListener("abort", done);
    });
    try {
      const ref = await Promise.race([
        keepImage(bytes, imageRef, signal).catch((err) => {
          diag.warn("pi.tool_image.keep_threw", { err: errorMessage(err) });
          return null;
        }),
        stopped,
      ]);
      return { ref, timedOut: ref === null && timer.aborted && !run.aborted };
    } finally {
      unhook();
    }
  };

  return {
    async keep(event, signal) {
      const kept = new Map<object, AttachmentRef>();
      const blocks = imageBlocksWithLines(event.result);
      if (blocks.length === 0) return kept;
      const deadline = now() + eventBudgetMs;
      for (const { block, line } of blocks) {
        if (signal.aborted) break;
        // The agent read a ref for this image whatever happens to it here (pi's images
        // extension printed it before this event was): an image not kept is said so by that
        // ref, so a text naming it is refused for what really happened.
        const named = line === null ? null : REF_LINE.exec(line.text)?.[1] ?? null;
        let bytes: Uint8Array | null = null;
        try {
          bytes = Uint8Array.fromBase64(block.data);
        } catch {
          // Said below, once the cheaper reasons are ruled out.
        }
        const imageRef = bytes === null ? null : await imageRefOf(bytes);
        if (imageRef !== null && line !== null && named !== imageRef) {
          diag.debug("pi.tool_image.ref_corrected", { narrated: named, ref: imageRef });
          line.text = REF_LINE_PREFIX + imageRef;
        }
        const skip = (reason: UnkeptReason, detail: Record<string, unknown> = {}) => {
          diag[reason === "event-budget" ? "warn" : "debug"]("pi.tool_image.unkept", {
            reason,
            ...detail,
          });
          for (const ref of new Set([named, imageRef])) if (ref !== null) unkept(ref, reason);
        };
        const left = Math.min(imageTimeoutMs, deadline - now());
        if (left <= 0) {
          skip("event-budget");
          continue;
        }
        if (now() < pausedUntil) {
          skip("paused");
          continue;
        }
        if (!KEPT_TYPES.has(String(block.mimeType))) {
          skip("type", { mimeType: block.mimeType });
          continue;
        }
        if (base64Bytes(block.data) > KEEP_MAX_BYTES) {
          skip("too-large", { chars: block.data.length });
          continue;
        }
        if (bytes === null || imageRef === null) {
          skip("not-base64");
          continue;
        }
        const started = now();
        const { ref, timedOut } = await one(bytes, imageRef, left, signal);
        if (ref !== null) kept.set(block, ref);
        // The run is over: not a failure of the control plane's, and nothing more is asked.
        if (signal.aborted) break;
        const slow = now() - started > slowMs;
        if (ref === null) skip(timedOut ? "timeout" : "refused");
        if (ref !== null && !slow) {
          failures = 0;
          continue;
        }
        if (++failures >= KEEP_FAILURES_TO_PAUSE) {
          pausedUntil = now() + KEEP_PAUSE_MS;
          failures = 0;
          diag.warn("pi.tool_image.paused", {
            ms: KEEP_PAUSE_MS,
            last: ref === null ? (timedOut ? "timeout" : "refused") : "slow",
          });
        }
      }
      return kept;
    },
  };
}

/** Every ref a tool's result names its images by: each ref line, and the hash of each image's
 * bytes. For an event narrated without its images being kept, to say so by ref. */
export async function imageRefsOfResult(value: unknown): Promise<string[]> {
  const refs = new Set<string>();
  for (const { block, line } of imageBlocksWithLines(value)) {
    const named = line === null ? null : REF_LINE.exec(line.text)?.[1];
    if (named) refs.add(named);
    try {
      refs.add(await imageRefOf(Uint8Array.fromBase64(block.data)));
    } catch {
      // Not base64: only its line names it.
    }
  }
  return [...refs];
}

/** Whether a tool's result holds any inline image at all. */
export function hasImage(value: unknown): boolean {
  return imageBlocks(value).length > 0;
}

/**
 * Every image block in a tool's result, in order, by object identity, each with the ref line that
 * follows it: the first text block naming a ref between it and the next image of the same list,
 * or null when there is none.
 */
function imageBlocksWithLines(
  value: unknown,
): Array<{ block: { data: string; mimeType?: unknown }; line: { text: string } | null }> {
  const found: Array<
    { block: { data: string; mimeType?: unknown }; line: { text: string } | null }
  > = [];
  const isImageBlock = (v: unknown): v is { data: string; mimeType?: unknown } =>
    v !== null && typeof v === "object" && (v as JsonObject).type === "image" &&
    typeof (v as JsonObject).data === "string";
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (!isImageBlock(item)) return walk(item);
        let line: { text: string } | null = null;
        for (let j = i + 1; j < v.length && !isImageBlock(v[j]); j++) {
          const b = v[j] as JsonObject | null;
          if (b?.type === "text" && typeof b.text === "string" && REF_LINE.test(b.text)) {
            line = b as { text: string };
            break;
          }
        }
        found.push({ block: item, line });
      });
      return;
    }
    if (v === null || typeof v !== "object") return;
    const object = v as JsonObject;
    if (isImageBlock(object)) {
      found.push({ block: object, line: null });
      return;
    }
    Object.values(object).forEach(walk);
  };
  walk(value);
  return found;
}

/** Every image block in a tool's result, in order, by object identity. */
function imageBlocks(value: unknown): Array<{ data: string; mimeType?: unknown }> {
  const found: Array<{ data: string; mimeType?: unknown }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const object = v as JsonObject;
    if (object.type === "image" && typeof object.data === "string") {
      found.push(object as { data: string; mimeType?: unknown });
      return;
    }
    Object.values(object).forEach(walk);
  };
  walk(value);
  return found;
}

/** How many bytes a base64 string decodes to, without decoding it. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor(data.length * 3 / 4) - padding;
}

/** What `withoutImageData` writes in place of an image's bytes. */
const OMITTED_NOTE = /^\[\d+ base64 chars omitted\]$/;

/**
 * An event with every inline image's bytes replaced by a note of their size — and, for an image
 * that was kept, its ref: `{type: "image", mimeType, data: "[N base64 chars omitted]",
 * attachment: {id, mime}}`. The transcript never carries the bytes; the run page draws a kept
 * image from the attachment, and says an unkept one was not kept.
 */
export function withoutImageData(
  value: unknown,
  kept: ReadonlyMap<object, AttachmentRef> = new Map(),
): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutImageData(v, kept));
  if (value === null || typeof value !== "object") return value;
  const object = value as JsonObject;
  if (object.type === "image" && typeof object.data === "string") {
    // Already a note (an event cleaned before it was queued): left as it is, not re-measured.
    if (OMITTED_NOTE.test(object.data)) return object;
    const ref = kept.get(object);
    return {
      ...object,
      data: `[${object.data.length} base64 chars omitted]`,
      ...(ref === undefined ? {} : { attachment: { id: ref.id, mime: ref.mime } }),
    };
  }
  return Object.fromEntries(
    Object.entries(object).map(([k, v]) => [k, withoutImageData(v, kept)]),
  );
}

/**
 * Where the harness layer installs pi (images/harness/Dockerfile: `lib/pi`, the pinned
 * `@earendil-works/pi-coding-agent`). pi's model catalogue is its `@earendil-works/pi-ai`
 * dependency's `dist/providers/data/<provider>.json`, nested under pi's own package or hoisted
 * beside it depending on how npm laid the tree out; both are tried.
 */
export const PI_PACKAGE_ROOT = "/opt/ryph/lib/pi/node_modules";

/** The catalogue files a provider's models may be in, most specific first. */
export function piCatalogueFiles(provider: string, root = PI_PACKAGE_ROOT): string[] {
  const data = `@earendil-works/pi-ai/dist/providers/data/${provider}.json`;
  return [
    `${root}/@earendil-works/pi-coding-agent/node_modules/${data}`,
    `${root}/${data}`,
  ];
}

/**
 * Whether the run's model takes images. Decided from what pi itself goes by — a model's
 * `input` — without starting pi:
 *
 * - a custom endpoint (the credentials channel's config blob is set): its model's `vision`, as
 *   the admin declared it. Unset, or a model the blob does not list, is false: pi is then handed
 *   no `input` and treats the model as text-only (pi 1.0.0 defaults a custom model to `["text"]`)
 * - a built-in provider: pi's catalogue entry for the model (`input` includes "image"). pi 1.0.0
 *   ships one JSON file per provider, `{<api>: {"chat:<id>": {id, input, …}}}`. A provider or
 *   model it does not list, a `--model` pattern rather than an id, no model named at all, or a
 *   catalogue that cannot be read is true: what every run assumed before, and pi itself still
 *   puts a placeholder in for a model that turns out blind. A catalogue that cannot be read is
 *   also warned about, once per `diag`; images/harness/Dockerfile fails a build whose pi moved it.
 */
export async function piModelSeesImages(
  spec: { provider?: string; model?: string },
  getEnv: (name: string) => string | undefined,
  readText: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  root = PI_PACKAGE_ROOT,
  diag?: Pick<Diagnostics, "warn">,
): Promise<boolean> {
  const blob = getEnv(MODEL_ENDPOINT_ENV.config);
  if (blob !== undefined && blob.trim() !== "") {
    try {
      const models = (JSON.parse(blob) as { models?: Array<{ id?: unknown; vision?: unknown }> })
        .models;
      const model = Array.isArray(models) ? models.find((m) => m?.id === spec.model) : undefined;
      return model?.vision === true;
    } catch {
      // The adapter refuses a broken blob by name when it writes pi's config; until then, a
      // model nobody could say sees is taken not to.
      return false;
    }
  }
  if (!spec.provider || !spec.model || !/^[a-z0-9._-]+$/i.test(spec.provider)) return true;
  const ids = catalogueIds(spec.provider, spec.model);
  const files = piCatalogueFiles(spec.provider, root);
  for (const file of files) {
    let catalogue: unknown;
    try {
      catalogue = JSON.parse(await readText(file));
    } catch {
      continue;
    }
    for (const id of ids) {
      const input = catalogueInput(catalogue, id);
      if (input !== null) return input.includes("image");
    }
    return true;
  }
  // Not silent: a pi that moved its catalogue would otherwise make every text-only model "see"
  // without a word. Once per diagnostics sink — a process's — not once per lookup.
  if (diag !== undefined && !warnedUnreadable.has(diag)) {
    warnedUnreadable.add(diag);
    diag.warn("pi.model_catalogue.unreadable", {
      provider: spec.provider,
      files,
      assumed: "sees images",
    });
  }
  return true;
}

const warnedUnreadable = new WeakSet<object>();

/** pi's thinking levels, which `--model` takes as an `id:<level>` suffix. Built from the one
 * list rather than spelled out, which once left `max` off. */
const THINKING_SUFFIX = new RegExp(`:(?:${THINKING_LEVELS.join("|")})$`);

/**
 * The ids a `--model` value may name in a provider's catalogue, most literal first. `--model`
 * also takes `<provider>/<id>` and an `<id>:<thinking>` suffix; the prefix is stripped only when
 * it IS the run's provider, because a gateway's own ids carry a slash (openrouter's
 * `anthropic/claude-sonnet-4`, vercel-ai-gateway's alike), and a suffix only when it is a
 * thinking level (openrouter's `:free` is part of the id).
 */
function catalogueIds(provider: string, model: string): string[] {
  const ids = [model];
  const unprefixed = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  for (const id of [unprefixed, unprefixed.replace(THINKING_SUFFIX, "")]) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The `input` of model `id` in one provider's catalogue file, or null when it is not there. */
function catalogueInput(catalogue: unknown, id: string): string[] | null {
  if (catalogue === null || typeof catalogue !== "object") return null;
  for (const group of Object.values(catalogue as JsonObject)) {
    if (group === null || typeof group !== "object") continue;
    for (const entry of Object.values(group as JsonObject)) {
      const model = entry as { id?: unknown; input?: unknown; type?: unknown };
      if (model?.id !== id || (model.type !== undefined && model.type !== "chat")) continue;
      if (Array.isArray(model.input)) return model.input.map(String);
    }
  }
  return null;
}
