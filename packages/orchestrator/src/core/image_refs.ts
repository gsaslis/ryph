// Image refs: how an agent puts an image its tool returned into what it writes. pi's images
// extension shows the model a line `Image ref: img-<12 hex>` after each such image
// (packages/pi-mcp/images.ts); the runner uploads the bytes with that ref (core/attachments.ts
// `storeAgentAttachment`); the agent writes `![alt](img-…)` in a summary, a patch description, a
// forge body or a chat post; and whoever writes that text to a surface resolves the refs here,
// against the run, and renders them in the form the surface can carry. The text itself is
// stored and sent on as the agent wrote it: rendering is the receiving service's.
//
// Invariants:
// - a ref is `img-` and the first 12 hex of the SHA-256 of the image's bytes, so an upload is
//   only stored under the ref its bytes hash to
// - a ref resolves only against ONE run's own tool images (`source: "agent"`): no text can name
//   an image of another run, or one a person uploaded
// - at most MAX_IMAGE_REFS refs per body, and a ref that names nothing fails the write that
//   carries it, by name (`unknownRefsError`) — never a silently broken image. The one exception
//   is a run's result, which has no tool call left to fail: an unknown ref there is left out of
//   its `images` and the page shows the alt text
// - while the run is live a missing ref is waited on for up to REF_WAIT_MS: the model sees the
//   tool's result before the runner has uploaded its image

import type { TaskStore } from "../ports/task_store.ts";
import { isTerminal } from "./lifecycle.ts";
import type { Attachment, AttachmentMime, ResultImage, Run, RunnerResult } from "./types.ts";

/** A ref as the extension prints it. */
export const IMAGE_REF = /^img-[0-9a-f]{12}$/;

/** How many refs one body may carry. */
export const MAX_IMAGE_REFS = 10;

/** How many refs one resolve may ask about: two bodies' worth. */
export const MAX_RESOLVE_REFS = 20;

/** How long a live run's missing ref is waited on before it is unknown. */
export const REF_WAIT_MS = 10_000;
const REF_POLL_MS = 250;

/** `![alt](img-…)`, the one syntax that names an image. Any other image link is left alone. */
const REF_SYNTAX = /!\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*<?(img-[0-9a-f]{12})>?\s*\)/g;

/** The ref of an image whose hex SHA-256 is `sha256`. */
export function imageRefOf(sha256: string): string {
  return `img-${sha256.slice(0, 12)}`;
}

/** Every `![alt](img-…)` in `text`, once per ref, in the order each is first named. */
export function imageRefsIn(text: string): Array<{ ref: string; alt: string }> {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(REF_SYNTAX)) {
    if (!seen.has(match[2])) seen.set(match[2], match[1].trim());
  }
  return [...seen].map(([ref, alt]) => ({ ref, alt }));
}

/** What a write with refs that name nothing is refused with, to the agent. */
export function unknownRefsError(unknown: readonly string[]): string {
  const named = unknown.length === 1
    ? `No image this run kept has the ref ${unknown[0]}.`
    : `No images this run kept have the refs ${unknown.join(", ")}.`;
  return `${named} An image ref names an image a tool returned in this run: the \`Image ref:\` ` +
    "line right after it. An image that could not be saved was not kept: take it again, and use " +
    "the ref shown after it.";
}

/** What a body with more than MAX_IMAGE_REFS refs is refused with. */
export function tooManyRefsError(count: number): string {
  return `The text names ${count} images; one text may show at most ${MAX_IMAGE_REFS}.`;
}

/** One resolved ref. `url` is the app's image link (`/images/<runId>/<attachmentId>`), null when
 * the deployment has no app URL. */
export interface ResolvedImage {
  ref: string;
  attachmentId: string;
  mime: AttachmentMime;
  url: string | null;
}

/** The app's link to one of a run's images: behind the same login and read access as the run. */
export function imageUrlOf(
  appUrl: string | null | undefined,
  runId: string,
  attachmentId: string,
): string | null {
  return appUrl
    ? `${appUrl.replace(/\/+$/, "")}/images/${encodeURIComponent(runId)}/${
      encodeURIComponent(attachmentId)
    }`
    : null;
}

export interface ResolveDeps {
  store: Pick<TaskStore, "agentAttachmentsByRefs" | "getRun">;
  appUrl?: string | null;
  /** Waits; tests pass a clock-free one. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Each of `refs` against the run's tool images, in the order given: resolved, or unknown. With
 * `wait`, a ref not found while the run is live is looked for again until it is found, the run
 * ends, or REF_WAIT_MS pass.
 */
export async function resolveImageRefs(
  deps: ResolveDeps,
  run: Run,
  refs: readonly string[],
  opts: { wait: boolean } = { wait: true },
): Promise<{ images: ResolvedImage[]; unknown: string[] }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const wanted = [...new Set(refs)];
  const found = new Map<string, Attachment>();
  const look = async () => {
    const missing = wanted.filter((ref) => !found.has(ref));
    if (missing.length === 0) return;
    for (const row of await deps.store.agentAttachmentsByRefs(run.id, missing)) {
      if (row.ref !== null) found.set(row.ref, row);
    }
  };
  await look();
  if (opts.wait && found.size < wanted.length && !isTerminal(run)) {
    const until = now() + REF_WAIT_MS;
    while (found.size < wanted.length && now() < until) {
      await sleep(REF_POLL_MS);
      await look();
      const live = await deps.store.getRun(run.id);
      if (live === null || isTerminal(live)) {
        await look();
        break;
      }
    }
  }
  const images: ResolvedImage[] = [];
  const unknown: string[] = [];
  for (const ref of wanted) {
    const row = found.get(ref);
    if (row === undefined) {
      unknown.push(ref);
      continue;
    }
    images.push({
      ref,
      attachmentId: row.id,
      mime: row.mime,
      url: imageUrlOf(deps.appUrl, run.id, row.id),
    });
  }
  return { images, unknown };
}

/**
 * Whether a text the agent is writing may go: null when every ref it names is one of the run's
 * images (or it names none), else the reason, for the agent. `wait` as `resolveImageRefs`.
 */
export async function checkImageRefs(
  deps: ResolveDeps,
  run: Run,
  text: string,
  opts: { wait: boolean },
): Promise<string | null> {
  const refs = imageRefsIn(text).map((r) => r.ref);
  if (refs.length === 0) return null;
  if (refs.length > MAX_IMAGE_REFS) return tooManyRefsError(refs.length);
  const { unknown } = await resolveImageRefs(deps, run, refs, opts);
  return unknown.length === 0 ? null : unknownRefsError(unknown);
}

/** The images a run's summary shows, for its stored result: unknown refs left out, no wait. */
export async function resultImages(
  deps: ResolveDeps,
  run: Run,
  summary: string,
): Promise<ResultImage[]> {
  const named = imageRefsIn(summary).slice(0, MAX_IMAGE_REFS);
  if (named.length === 0) return [];
  const { images } = await resolveImageRefs(deps, run, named.map((n) => n.ref), { wait: false });
  const byRef = new Map(images.map((i) => [i.ref, i]));
  return named.flatMap(({ ref, alt }) => {
    const image = byRef.get(ref);
    return image === undefined
      ? []
      : [{ ref, attachmentId: image.attachmentId, mime: image.mime, alt }];
  });
}

/**
 * A result's summary as it is sent on to a forge or a chat: the refs its `images` hold stay as
 * written, for the receiving service to render; any other ref reads as its alt text (or `Image`),
 * as the run page shows it. The receiving service refuses a body naming a ref it cannot resolve,
 * or more than MAX_IMAGE_REFS, and a status comment or a pull request body must not be refused
 * for an image the result already left out. `alongside` is text sent in the same body (a patch's
 * description): its refs count against the limit first, and the summary keeps only what fits.
 * Empty for a result with no summary.
 */
export function summaryToSend(result: RunnerResult | null, alongside = ""): string {
  if (result === null || !("summary" in result)) return "";
  const named = new Set(imageRefsIn(alongside).map((r) => r.ref));
  const kept = new Set<string>();
  let added = 0;
  for (const { ref } of result.images ?? []) {
    if (named.has(ref)) kept.add(ref);
    else if (named.size + added < MAX_IMAGE_REFS) {
      kept.add(ref);
      added++;
    }
  }
  return refsOnly(result.summary, kept);
}

/**
 * `text` with every ref outside `kept` read as its alt text (or `Image`). Until nothing changes:
 * an alt read in place can close a ref with the text around it (`!![[x]](img-a)(img-b)` reads as
 * `![x](img-b)` after one pass), and every pass that changes anything removes a ref, so it ends.
 */
function refsOnly(text: string, kept: ReadonlySet<string>): string {
  for (;;) {
    const next = text.replace(
      REF_SYNTAX,
      (whole, alt: string, ref: string) => kept.has(ref) ? whole : alt.trim() || "Image",
    );
    if (next === text) return text;
    text = next;
  }
}

/**
 * A composed body as it goes to a forge: the refs `meant` names stay (the agent's description
 * and the summary `summaryToSend` made), and every other ref reads as its alt text. The forge
 * renders and checks every ref in a body, and the rest of it quotes text nobody checked: a
 * commit subject the agent wrote with `git commit`, a chat name. One of those naming an image
 * the run does not hold, or pushing the body past MAX_IMAGE_REFS, would refuse the whole pull
 * request or status comment, for good.
 */
export function bodyToSend(body: string, meant: string): string {
  return refsOnly(body, new Set(imageRefsIn(meant).map((r) => r.ref)));
}
