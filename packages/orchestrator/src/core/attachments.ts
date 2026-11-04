// Attachments: the images a run is handed — a screenshot pasted into the run page, a photo sent
// to the chat, an image embedded in the forge thread a run was commanded from. The control plane
// owns them: a row per image in `run_attachments`, the bytes in the attachment store (the object
// store patches live in), and one door every producer comes through, so what an image IS gets
// decided in one place:
//
//   an attachment is an allowed image, sniffed from its own bytes, under the cap, owned by one
//   run, and handed to that run's agent exactly once.
//
// Invariants:
// - the format is decided by the bytes' magic numbers, never by a claimed content type or a
//   filename: what a client says it sent is not evidence of what it sent. PNG, JPEG, GIF and
//   WebP only — SVG above all is refused, because an SVG is a document that can carry script
// - an image is at most MAX_ATTACHMENT_BYTES, and a message or a run start carries at most
//   MAX_ATTACHMENTS of them
// - an attachment belongs to exactly one run, and is used at most once: by the run's start
//   (`claimedBy: "task"`), by ONE message (`claimedBy: <message id>`), or by the agent's own
//   tool that returned it (`claimedBy: "tool"`, claimed from birth). An upload no message ever
//   carried stays unclaimed, and the runner is never served one
// - unclaimed uploads are bounded: at most MAX_UNCLAIMED_ATTACHMENTS per run, counted and
//   written under one lock on the run (`createUnclaimedAttachment`), taken back when
//   the run page removes one, and swept by the reaper once UNCLAIMED_ATTACHMENT_TTL_MS old
// - a row and its blob live and die together: a blob is written only once nothing but the row's
//   own write can still refuse it, and a blob whose row will never exist is deleted again
// - an image is UNTRUSTED input, exactly like the text beside it: the runner frames it inside the
//   same untrusted envelope, and nothing an image shows can widen what a run may do
// - storage keys are composed here, from ids minted here
//
// Three doors in, sharing every check:
// - `storeAttachment` takes one image for a run that already exists (the run page's upload, a
//   chat or forge follow-up), stored unclaimed; the message that carries it claims it
//   (`postMessage`, core/inbox.ts, with `attachmentIds`). `storeAttachments` is it for a
//   follow-up's several, all or none
// - `storeAgentAttachment` takes an image the run's OWN agent got back from a tool (a browser
//   screenshot, a file its read tool opened), uploaded by the runner so the transcript can show
//   it. Stored already claimed (`claimedBy: "tool"`, `source: "agent"`): it never shares the
//   composer's unclaimed cap, is never swept, and cannot be taken back or ride a message. Capped
//   per run at MAX_AGENT_ATTACHMENTS images and MAX_AGENT_ATTACHMENT_BYTES in all; a run at
//   either is refused before its body is read (`agentAttachmentRoom`). Each is stored under its
//   image ref, one row per ref per run (core/image_refs.ts)
// - `checkRunStartImages` / `planRunAttachments` / `storeRunAttachmentBlobs` take the images a
//   run STARTS with (a forge thread's screenshots, a chat mention's photo, a re-run's copies),
//   for `startTask`: checked first, planned into rows and refs the work item names, the blobs
//   stored after every other refusal, and the rows written in the run's own insert — so the
//   runner hands them to the agent with the task

import { mintId } from "@ryph/sealed";
import type { AttachmentStore } from "../ports/attachment_store.ts";
import type { Diagnostics } from "../ports/diagnostics.ts";
import type { TaskStore } from "../ports/task_store.ts";
import { imageRefOf } from "./image_refs.ts";
import { isTerminal } from "./lifecycle.ts";
import type { Attachment, AttachmentMime, AttachmentRef, AttachmentSource, Run } from "./types.ts";

/** The largest image the platform takes: 5 MiB, past what any vision model reads at full size. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** How many images one message, or one run start, may carry. */
export const MAX_ATTACHMENTS = 10;

/**
 * The placeholder a producer writes into its text where the Nth image (1-based, in the order the
 * images are handed over) sat — a GitHub comment's `<img>`, a Telegram photo's place before its
 * caption. The runner tells the agent, beside the text, which file each `[image N]` is.
 */
export function imageMarker(n: number): string {
  return `[image ${n}]`;
}

/**
 * Untrusted text with every `[image n]` it spells — and every `[image not attached…` note —
 * rewritten as `(image n)`, `(image not attached…`: still legible as what the author wrote, no
 * longer a marker. Fullwidth brackets and stray spacing count too; a reader would take them for
 * a marker just the same. Never longer than what it was given, so a budget measured before it
 * still holds after. Every producer that places markers runs its untrusted words through this
 * first (core/thread_context.ts for forge and chat threads); the chat service restates it
 * (packages/chat core/images.ts `neutralizeMarkers`), held equal by its parity test.
 */
export function neutraliseMarkers(text: string): string {
  return text
    .replace(/[\[\uFF3B]\s*image\s*(\d+)\s*[\]\uFF3D]/giu, "(image $1)")
    .replace(/[\[\uFF3B](\s*image\b)/giu, "($1");
}

/**
 * The image format these bytes ARE, by their magic numbers; null for anything else. The four
 * signatures are fixed by their formats: PNG's eight-byte header, JPEG's SOI marker followed by
 * a marker byte, GIF's two versioned headers, and WebP's RIFF container naming `WEBP`.
 */
export function sniffImage(bytes: Uint8Array): AttachmentMime | null {
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

/** The file extension an allowed format is saved under — by the runner, and in a download's
 * filename. */
export function attachmentExtension(mime: AttachmentMime): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
  }
}

/** Where an attachment's bytes live in the store: under the run, by the attachment's own id. */
export function attachmentKey(runId: string, attachmentId: string): string {
  return `attachments/${runId}/${attachmentId}`;
}

/**
 * A refusal, as a value with the status a route answers it with. `reason` tells apart the two
 * refusals that share a 409 and mean opposite things to a producer deciding what to do next:
 * `terminal`, the run has ended (a chat or forge join may start a fresh run instead), and `cap`,
 * the run is alive and holds MAX_UNCLAIMED_ATTACHMENTS uploads already (starting a second run
 * beside it is exactly what a join must never do). A status alone cannot carry that.
 */
export interface AttachmentRefusal {
  kind: "refused";
  status: 400 | 409 | 413 | 415 | 503;
  error: string;
  reason?: "terminal" | "cap";
}

/**
 * The agent's door's refusal: `cap` is its count spent, and `bytes` adds this image not fitting
 * what is left of the run's byte budget — a smaller one may still go, so the runner keeps trying.
 */
export type AgentAttachmentRefusal = Omit<AttachmentRefusal, "reason"> & {
  reason?: "terminal" | "cap" | "bytes" | "ref";
};

/**
 * Whether these bytes may be an attachment: present, under the cap, and one of the four formats.
 * Pure — the check both doors make before anything is stored, and the one a producer may make
 * itself first, to drop an image it would rather not fail a whole start over.
 */
export function inspectImage(
  bytes: Uint8Array,
): AttachmentRefusal | { kind: "image"; mime: AttachmentMime } {
  if (bytes.length === 0) return { kind: "refused", status: 400, error: "the image is empty" };
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      kind: "refused",
      status: 413,
      error: `an image is at most ${MAX_ATTACHMENT_BYTES} bytes (5 MiB); this one is ` +
        `${bytes.length}`,
    };
  }
  const mime = sniffImage(bytes);
  if (mime === null) {
    return {
      kind: "refused",
      status: 415,
      error: "not a supported image: PNG, JPEG, GIF and WebP are accepted",
    };
  }
  return { kind: "image", mime };
}

/**
 * How many uploads one run may hold that no message has carried yet: two messages' worth. The
 * composer uploads an image the moment it is added, so a message being written holds up to
 * MAX_ATTACHMENTS of them, and a second allowance covers chips removed and re-added. Past it an
 * upload is refused: without a cap, anyone who may steer a run could file blobs against it
 * forever, since an unclaimed upload is only reclaimed by the sweep.
 */
export const MAX_UNCLAIMED_ATTACHMENTS = 2 * MAX_ATTACHMENTS;

/**
 * How long an upload may wait for the message that carries it before the reaper takes it back
 * (`sweepUnclaimedAttachments`). A day: far past any message being written, and short enough
 * that an abandoned composer costs a day of storage, not forever.
 */
export const UNCLAIMED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AttachmentDeps {
  store: Pick<TaskStore, "createUnclaimedAttachment" | "countUnclaimedAttachments">;
  /** Where the bytes go. Null/absent: this deployment keeps no attachments, and every door
   * refuses one with a 503 rather than losing it. */
  attachmentStore?: AttachmentStore | null;
  diag: Diagnostics;
  now(): Date;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const NO_STORE: AttachmentRefusal = {
  kind: "refused",
  status: 503,
  error: "this deployment has no attachment store",
};

const UNCLAIMED_CAP: AttachmentRefusal = {
  kind: "refused",
  status: 409,
  error: `this run already holds ${MAX_UNCLAIMED_ATTACHMENTS} images waiting to be sent; ` +
    "send or remove some first",
  reason: "cap",
};

/**
 * THE door for one image into a run that already exists: sniffed, capped, hashed, its bytes
 * stored and its row written, unclaimed. What comes back is the attachment a message then names
 * in `attachmentIds` (core/inbox.ts `postMessage`), which is what claims it. A terminal run
 * refuses, as it refuses messages: nobody is there to look (`reason: "terminal"`). A run already
 * holding MAX_UNCLAIMED_ATTACHMENTS uploads no message carried refuses too (`reason: "cap"`).
 *
 * Never throws for the caller's sake on a bad image — a refusal is a value with a status. A
 * store that fails to write does throw: that is the deployment breaking, not the image.
 */
export async function storeAttachment(
  deps: AttachmentDeps,
  run: Run,
  bytes: Uint8Array,
  source: AttachmentSource,
): Promise<AttachmentRefusal | { kind: "stored"; attachment: Attachment }> {
  if (!deps.attachmentStore) return NO_STORE;
  if (isTerminal(run)) {
    return {
      kind: "refused",
      status: 409,
      error: `run is terminal (${run.state})`,
      reason: "terminal",
    };
  }
  const inspected = inspectImage(bytes);
  if (inspected.kind === "refused") return inspected;
  // Counted first, so a run already at the cap is refused before five megabytes are written for
  // nothing. The count is only that shortcut: the rule itself is the row's write below, which
  // counts again and inserts under a lock on the run, so uploads racing for the last slots
  // cannot all pass.
  if (await deps.store.countUnclaimedAttachments(run.id) >= MAX_UNCLAIMED_ATTACHMENTS) {
    return UNCLAIMED_CAP;
  }
  const attachment = await composeAttachment(run.id, bytes, inspected.mime, {
    source,
    claimedBy: null,
    at: deps.now().toISOString(),
  });
  await deps.attachmentStore.put(attachment.storageKey, bytes);
  let written: boolean;
  try {
    written = await deps.store.createUnclaimedAttachment(attachment, MAX_UNCLAIMED_ATTACHMENTS);
  } catch (err) {
    // No row, so nothing can ever name the blob: take it back rather than leave it.
    await discardAttachmentBlobs(deps, [attachment]);
    throw err;
  }
  if (!written) {
    // Lost the last slot to an upload that landed in the meantime: no row, so no blob either.
    await discardAttachmentBlobs(deps, [attachment]);
    return UNCLAIMED_CAP;
  }
  deps.diag.debug("attachment.stored", {
    runId: run.id,
    attachmentId: attachment.id,
    mime: attachment.mime,
    bytes: attachment.bytes,
    source,
  });
  return { kind: "stored", attachment };
}

/**
 * How many tool-result images one run may keep (`storeAgentAttachment`). A browser session
 * screenshots often; past this the runner narrates further images without one, which costs the
 * transcript a picture and the run nothing. Bounds what one run can file against the bucket.
 */
export const MAX_AGENT_ATTACHMENTS = 200;

/**
 * How many bytes of tool-result images one run may keep, all of them together: 200 MiB. The
 * count alone lets a run file 200 × 5 MiB, a gigabyte nothing ever sweeps (these rows are claimed
 * from birth); a screenshot is a few hundred KiB, so 200 of them sit well inside this.
 */
export const MAX_AGENT_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** What `claimedBy` holds for an image the agent's own tool returned. */
export const TOOL_CLAIM = "tool";

/** The count is spent: no later image fits either. */
function agentCap(): AgentAttachmentRefusal {
  return {
    kind: "refused",
    status: 409,
    error: `this run already keeps ${MAX_AGENT_ATTACHMENTS} images its tools returned`,
    reason: "cap",
  };
}

/** This image does not fit the byte budget's room; a smaller one still may (`reason: "bytes"`). */
function agentBytes(): AgentAttachmentRefusal {
  return {
    kind: "refused",
    status: 409,
    error: `this image does not fit the ${MAX_AGENT_ATTACHMENT_BYTES} bytes of tool images a ` +
      "run keeps",
    reason: "bytes",
  };
}

/**
 * Whether the run has room for one more tool image of `incoming` bytes (0 when not yet known:
 * the body has not been read): under MAX_AGENT_ATTACHMENTS, and its kept bytes plus these within
 * MAX_AGENT_ATTACHMENT_BYTES. One unlocked read — the door asks it BEFORE reading a body or
 * touching the store, so a run at its budget is refused for free. Only a shortcut: the rule is
 * the row's write, which counts and sums again under the run's lock.
 */
export async function agentAttachmentRoom(
  store: Pick<TaskStore, "agentAttachmentUsage">,
  runId: string,
  incoming = 0,
): Promise<AgentAttachmentRefusal | null> {
  const used = await store.agentAttachmentUsage(runId);
  if (used.count >= MAX_AGENT_ATTACHMENTS) return agentCap();
  if (used.bytes + Math.max(incoming, 1) > MAX_AGENT_ATTACHMENT_BYTES) return agentBytes();
  return null;
}

/**
 * The runner's door for an image one of the agent's tools returned: the same checks as every
 * other door (sniffed, under 5 MiB, a live run), stored already claimed by `"tool"` with
 * `source: "agent"`, so both read doors serve it and nothing can take it back or send it. At
 * most MAX_AGENT_ATTACHMENTS per run and MAX_AGENT_ATTACHMENT_BYTES in all, looked at before the
 * blob is written (`agentAttachmentRoom`) and enforced by the row's write under the run's lock
 * (`createAgentAttachment`): `reason: "cap"` past the count, `"bytes"` past the budget. A refusal is a value; a store that
 * cannot write throws, its blob taken back first.
 *
 * Stored under `ref`, the name the agent writes it by (core/image_refs.ts): bytes that do not
 * hash to it are refused (`reason: "ref"`, 400), and a ref the run already keeps answers that
 * row, with no blob written and no limit counted.
 */
export async function storeAgentAttachment(
  deps: {
    store: Pick<
      TaskStore,
      "createAgentAttachment" | "agentAttachmentUsage" | "agentAttachmentsByRefs"
    >;
    attachmentStore?: AttachmentStore | null;
    diag: Diagnostics;
    now(): Date;
  },
  run: Run,
  bytes: Uint8Array,
  ref: string,
): Promise<AgentAttachmentRefusal | { kind: "stored"; attachment: Attachment }> {
  if (!deps.attachmentStore) return NO_STORE;
  if (isTerminal(run)) {
    return {
      kind: "refused",
      status: 409,
      error: `run is terminal (${run.state})`,
      reason: "terminal",
    };
  }
  const inspected = inspectImage(bytes);
  if (inspected.kind === "refused") return inspected;
  const attachment = await composeAttachment(run.id, bytes, inspected.mime, {
    source: "agent",
    claimedBy: TOOL_CLAIM,
    at: deps.now().toISOString(),
    ref,
  });
  // The name the agent will write it by must be the bytes': a ref is a promise about them.
  if (imageRefOf(attachment.sha256) !== ref) {
    return {
      kind: "refused",
      status: 400,
      error: `the image's bytes do not hash to ${ref}`,
      reason: "ref",
    };
  }
  // Before the blob is written: the same image again is the row already there, and a run
  // already at its budget costs no PUT and DELETE.
  const [same] = await deps.store.agentAttachmentsByRefs(run.id, [ref]);
  if (same !== undefined) return { kind: "stored", attachment: same };
  const room = await agentAttachmentRoom(deps.store, run.id, bytes.length);
  if (room !== null) return room;
  await deps.attachmentStore.put(attachment.storageKey, bytes);
  let written: Awaited<ReturnType<TaskStore["createAgentAttachment"]>>;
  try {
    written = await deps.store.createAgentAttachment(attachment, {
      maxCount: MAX_AGENT_ATTACHMENTS,
      maxBytes: MAX_AGENT_ATTACHMENT_BYTES,
    });
  } catch (err) {
    await discardAttachmentBlobs(deps, [attachment]);
    throw err;
  }
  if (written.kind === "existing") {
    // Lost a race to the same image: its row stands, and this blob is nobody's.
    await discardAttachmentBlobs(deps, [attachment]);
    return { kind: "stored", attachment: written.attachment };
  }
  if (written.kind === "full") {
    await discardAttachmentBlobs(deps, [attachment]);
    // The locked write says only no; which limit it was is read again, unlocked: it only tells
    // the runner whether a smaller image may still go, and a wrong guess costs one refused look.
    const used = await deps.store.agentAttachmentUsage(run.id);
    return used.count >= MAX_AGENT_ATTACHMENTS ? agentCap() : agentBytes();
  }
  deps.diag.debug("attachment.stored", {
    runId: run.id,
    attachmentId: attachment.id,
    mime: attachment.mime,
    bytes: attachment.bytes,
    source: "agent",
  });
  return { kind: "stored", attachment };
}

/**
 * Takes back an upload no message carried — a chip removed from the message box. The row goes
 * first, conditionally (`deleteUnclaimedAttachment`: this run's, still unclaimed), so a message
 * claiming it in the same instant either wins and keeps the image or loses and is refused; the
 * blob follows, best-effort. A claimed attachment is part of the conversation and is never
 * taken back here; it reads, like an unknown id, as nothing to remove.
 */
export async function takeBackAttachment(
  deps: {
    store: Pick<TaskStore, "deleteUnclaimedAttachment">;
    attachmentStore?: AttachmentStore | null;
    diag: Diagnostics;
  },
  runId: string,
  attachmentId: string,
): Promise<boolean> {
  const removed = await deps.store.deleteUnclaimedAttachment(runId, attachmentId);
  if (removed === null) return false;
  await discardAttachmentBlobs(deps, [removed]);
  return true;
}

/**
 * Several images for one message of a run that already exists — a chat or forge follow-up's —
 * stored through `storeAttachment` in order, all or none: the first refusal (or throw) takes
 * back what this call already stored before it is answered, so a follow-up that gives up leaves
 * no upload behind for the sweep to find a day later. The ids come back in the order given, the
 * order the message's markers count.
 */
export async function storeAttachments(
  deps: AttachmentDeps & { store: Pick<TaskStore, "deleteUnclaimedAttachment"> },
  run: Run,
  images: readonly Uint8Array[],
  source: AttachmentSource,
): Promise<AttachmentRefusal | { kind: "stored"; ids: string[] }> {
  const ids: string[] = [];
  try {
    for (const bytes of images) {
      const stored = await storeAttachment(deps, run, bytes, source);
      if (stored.kind === "refused") {
        await takeBackAttachments(deps, run.id, ids);
        return stored;
      }
      ids.push(stored.attachment.id);
    }
  } catch (err) {
    await takeBackAttachments(deps, run.id, ids);
    throw err;
  }
  return { kind: "stored", ids };
}

/**
 * `takeBackAttachment` for each of `ids`, best-effort: a producer whose message was refused
 * after it stored the images gives them back, and one that cannot is logged and left to the
 * sweep — never thrown over, since the caller is already answering something else.
 */
export async function takeBackAttachments(
  deps: Parameters<typeof takeBackAttachment>[0],
  runId: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    try {
      await takeBackAttachment(deps, runId, id);
    } catch (err) {
      deps.diag.warn("attachment.take_back_failed", { attachmentId: id, err: String(err) });
    }
  }
}

/**
 * The retention half of the unclaimed rule: every upload older than
 * UNCLAIMED_ATTACHMENT_TTL_MS that no message carried — a composer abandoned, an upload whose
 * message never came, a follow-up whose post failed — has its row and its blob deleted. Rides
 * the reaper's tick (core/reaper.ts `sweep`), at most `limit` per tick, so a backlog drains over
 * a few ticks instead of in one long one. Each delete is the same conditional one the take-back
 * makes, so a message claiming an image mid-sweep keeps it.
 */
export async function sweepUnclaimedAttachments(
  deps: {
    store: Pick<TaskStore, "listUnclaimedAttachmentsBefore" | "deleteUnclaimedAttachment">;
    attachmentStore?: AttachmentStore | null;
    diag: Diagnostics;
    now(): Date;
  },
  limit = 100,
): Promise<void> {
  const before = new Date(deps.now().getTime() - UNCLAIMED_ATTACHMENT_TTL_MS).toISOString();
  let swept = 0;
  for (const stale of await deps.store.listUnclaimedAttachmentsBefore(before, limit)) {
    if (await takeBackAttachment(deps, stale.runId, stale.id)) swept += 1;
  }
  if (swept > 0) deps.diag.debug("reaper.unclaimed_attachments_swept", { attachments: swept });
}

/** Composes an attachment's row: a minted id, the key under its run, the hash. Stores nothing. */
async function composeAttachment(
  runId: string,
  bytes: Uint8Array,
  mime: AttachmentMime,
  opts: { source: AttachmentSource; claimedBy: string | null; at: string; ref?: string },
): Promise<Attachment> {
  const id = mintId("att");
  return {
    id,
    runId,
    mime,
    bytes: bytes.length,
    sha256: await sha256Of(bytes),
    ref: opts.ref ?? null,
    source: opts.source,
    storageKey: attachmentKey(runId, id),
    claimedBy: opts.claimedBy,
    createdAt: opts.at,
  };
}

/**
 * One image a run starts with, as a producer hands it to `startTask` (`StartTaskArgs.images`):
 * the bytes it fetched and which door it came through. Its place in the spec's text is an
 * `imageMarker(n)` the producer wrote, n counting this list from 1.
 */
export interface RunStartImage {
  bytes: Uint8Array;
  source: AttachmentSource;
}

/** A start image that passed `checkRunStartImages`, with the format its bytes were sniffed as. */
export interface CheckedRunStartImage extends RunStartImage {
  mime: AttachmentMime;
}

/**
 * Whether a run may start with these images: a store to keep them in, at most MAX_ATTACHMENTS,
 * and every one an allowed image under the cap. Pure, so `startTask` asks it before anything at
 * all is queued or written on the run's behalf; what it answers is what `planRunAttachments`
 * takes, so nothing is inspected twice.
 */
export function checkRunStartImages(
  deps: Pick<AttachmentDeps, "attachmentStore">,
  images: readonly RunStartImage[],
): AttachmentRefusal | { kind: "ok"; images: CheckedRunStartImage[] } {
  if (images.length === 0) return { kind: "ok", images: [] };
  if (!deps.attachmentStore) return NO_STORE;
  if (images.length > MAX_ATTACHMENTS) {
    return {
      kind: "refused",
      status: 400,
      error: `a task starts with at most ${MAX_ATTACHMENTS} images; this one has ${images.length}`,
    };
  }
  const checked: CheckedRunStartImage[] = [];
  for (const [i, image] of images.entries()) {
    const inspected = inspectImage(image.bytes);
    if (inspected.kind === "refused") {
      return { ...inspected, error: `image ${i + 1}: ${inspected.error}` };
    }
    checked.push({ ...image, mime: inspected.mime });
  }
  return { kind: "ok", images: checked };
}

/**
 * The images a run starts with, as the run will name them: ids minted, keys composed under the
 * run's id, bytes hashed — and NOTHING stored. The refs go onto the work item; the rows ride the
 * run's own insert (`createTask`'s `attachments`), in the same transaction, so a run is never on
 * record naming an image it has no row for; the blobs go to the store last of all, past every
 * refusal (`storeRunAttachmentBlobs`).
 */
export async function planRunAttachments(
  runId: string,
  images: readonly CheckedRunStartImage[],
  at: string,
): Promise<{ refs: AttachmentRef[]; rows: Attachment[]; bytes: Uint8Array[] }> {
  const rows: Attachment[] = [];
  for (const image of images) {
    rows.push(
      await composeAttachment(runId, image.bytes, image.mime, {
        source: image.source,
        claimedBy: "task",
        at,
      }),
    );
  }
  return { refs: rows.map(refOf), rows, bytes: images.map((image) => image.bytes) };
}

/**
 * Writes a planned start's blobs, all or none: a store that fails part-way has what it already
 * took deleted again (best-effort) before the failure is rethrown, so a start that dies here
 * leaves nothing behind for nobody to name.
 */
export async function storeRunAttachmentBlobs(
  deps: { attachmentStore?: AttachmentStore | null; diag: Diagnostics },
  planned: { rows: readonly Attachment[]; bytes: readonly Uint8Array[] },
): Promise<void> {
  if (planned.rows.length === 0) return;
  if (!deps.attachmentStore) throw new Error("run attachments planned with no attachment store");
  const written: Attachment[] = [];
  try {
    for (const [i, row] of planned.rows.entries()) {
      await deps.attachmentStore.put(row.storageKey, planned.bytes[i]);
      written.push(row);
    }
  } catch (err) {
    await discardAttachmentBlobs(deps, written);
    throw err;
  }
}

/**
 * Deletes blobs no row will ever name — a start refused after its images were stored, an
 * unclaimed upload taken back or swept. Best-effort by contract: a delete that fails costs a
 * blob nothing can read (every door reads through a row), so it is logged, never thrown.
 */
export async function discardAttachmentBlobs(
  deps: { attachmentStore?: AttachmentStore | null; diag: Diagnostics },
  rows: readonly Pick<Attachment, "id" | "storageKey">[],
): Promise<void> {
  if (!deps.attachmentStore) return;
  for (const row of rows) {
    try {
      await deps.attachmentStore.delete(row.storageKey);
    } catch (err) {
      deps.diag.warn("attachment.discard_failed", { attachmentId: row.id, err: String(err) });
    }
  }
}

/**
 * The images a task started with, read back as start images for a re-run of it: the bytes of
 * each, in the order its work item froze them — the order its `[image N]` markers count — so a
 * re-run handed the same instructions is handed the same pictures. COPIES, not shared keys: the
 * new run's start stores them under its own id like any other start's, so every blob belongs to
 * exactly one row and deleting one run's images can never take another's.
 *
 * The task's first attempt whose work item names images is the one asked. An image whose row or
 * bytes are gone refuses the re-run rather than starting it with a marker that points at nothing.
 */
export async function readTaskStartImages(
  deps: {
    store: Pick<TaskStore, "runsForTask" | "listAttachmentsByIds">;
    attachmentStore?: AttachmentStore | null;
  },
  taskId: string,
): Promise<AttachmentRefusal | { kind: "images"; images: RunStartImage[] }> {
  const runs = await deps.store.runsForTask(taskId);
  const refs = runs.find((run) => (run.workItem.attachments ?? []).length > 0)?.workItem
    .attachments ?? [];
  if (refs.length === 0) return { kind: "images", images: [] };
  if (!deps.attachmentStore) return NO_STORE;
  const rows = new Map(
    (await deps.store.listAttachmentsByIds(refs.map((ref) => ref.id))).map((a) => [a.id, a]),
  );
  const gone: AttachmentRefusal = {
    kind: "refused",
    status: 409,
    error: "an image this task started with is no longer stored, so it cannot be re-run as it was",
  };
  const images: RunStartImage[] = [];
  for (const ref of refs) {
    const row = rows.get(ref.id);
    if (row === undefined) return gone;
    const stream = await deps.attachmentStore.get(row.storageKey);
    if (stream === null) return gone;
    images.push({
      bytes: new Uint8Array(await new Response(stream).arrayBuffer()),
      source: row.source,
    });
  }
  return { kind: "images", images };
}

export function refOf(attachment: Pick<Attachment, "id" | "mime">): AttachmentRef {
  return { id: attachment.id, mime: attachment.mime };
}

/**
 * Thrown by the store's `appendRunMessage` when a message's attachments could not all be
 * claimed in the same transaction as the append: one was claimed by another message in the
 * meantime, or never belonged to the run. Nothing was written. `postMessage` checks first and
 * answers a refusal; this is the race that check cannot close on its own.
 */
export class AttachmentClaimConflict extends Error {
  constructor(message = "an attachment was already used by another message") {
    super(message);
    this.name = "AttachmentClaimConflict";
  }
}

/**
 * Whether `ids` may ride a new message of `runId`: at most MAX_ATTACHMENTS, no repeats, each
 * one this run's and unclaimed. The refs come back in the order given — the order the message's
 * `[image N]` markers count. An id that is not this run's reads exactly as one that does not
 * exist: which ids other runs hold is nobody's business here.
 */
export async function claimableAttachments(
  store: Pick<TaskStore, "listAttachmentsByIds">,
  runId: string,
  ids: readonly string[],
): Promise<AttachmentRefusal | { kind: "claimable"; refs: AttachmentRef[] }> {
  if (ids.length === 0) return { kind: "claimable", refs: [] };
  if (ids.length > MAX_ATTACHMENTS) {
    return {
      kind: "refused",
      status: 400,
      error: `a message carries at most ${MAX_ATTACHMENTS} images`,
    };
  }
  if (new Set(ids).size !== ids.length) {
    return { kind: "refused", status: 400, error: "an attachment is named twice" };
  }
  const found = new Map((await store.listAttachmentsByIds(ids)).map((a) => [a.id, a]));
  const refs: AttachmentRef[] = [];
  for (const id of ids) {
    const attachment = found.get(id);
    if (attachment === undefined || attachment.runId !== runId) {
      return { kind: "refused", status: 400, error: `no such attachment on this run: ${id}` };
    }
    if (attachment.claimedBy !== null) {
      return {
        kind: "refused",
        status: 409,
        error: `attachment ${id} was already sent; upload the image again to send it again`,
      };
    }
    refs.push(refOf(attachment));
  }
  return { kind: "claimable", refs };
}
