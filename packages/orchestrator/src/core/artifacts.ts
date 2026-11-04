// Artifacts: an HTML page an agent publishes to the instance, for every signed-in member to open. A
// run of an agent whose switch is on hands the control plane a title and a document; the control
// plane keeps it as a new artifact, or as the next version of one the same agent published before,
// and answers the link the agent posts.
//
// Invariants:
// - a publish is accepted only while the agent's `canPublishArtifacts` reads true LIVE and the
//   agent is not archived; the run's frozen copy decides only what its runner offers
// - only the agent that created an artifact may version or fetch it, and only by `mayVersion`:
//   from a task that made one of its versions, from a later mention in the same chat
//   conversation it was asked for in (a Zulip topic, a Slack thread; never on Telegram, whose
//   one conversation is the whole group), or (neither asked in a chat or by an automation) for
//   the person who first asked for it; never once it is deleted. Any other ask reads as no such
//   artifact, so a run learns nothing about artifacts it cannot touch
// - a version is immutable: its HTML, its served document and its images are what was
//   published, until a delete purges them all
// - every image a document names by ref is one of the publishing run's own tool images, or one
//   the version it updates already showed, checked at publish and kept by the version, so a
//   viewer who cannot see the run still sees them; what they add up to once inlined is capped
//   at publish and again at serve
// - the served document is made ONCE, at publish, by the browser's parsing algorithm
//   (helpers/artifact_html.ts, in a child process killed at its deadline): the tags that would steer or
//   beacon taken out of the tree, image refs made tokens, the handshake script and
//   `<base target="_blank">` first in <head>. Serving only fills the tokens with `data:` URIs,
//   which cannot change how the document parses, and answers with the §5 headers — the CSP
//   `sandbox` among them, which is the boundary. Inside it the page runs its own script in an
//   opaque origin: it cannot read the viewer's session or the app, but it CAN reach the
//   internet from the viewer's browser (popups, WebRTC), so it is treated as able to beacon
// - a run hands the sanitizer at most MAX_ARTIFACT_ATTEMPTS_PER_HOUR documents in any hour,
//   refused ones counted, and one at a time; a publish that changes nothing is answered before
//   the sanitizer and is not counted

import type { AttachmentStore } from "../ports/attachment_store.ts";
import type { ArtifactStore } from "../ports/artifact_store.ts";
import type { ArtifactHtmlOutcome, ArtifactHtmlPreparer } from "../ports/artifact_html.ts";
import type { TaskStore } from "../ports/task_store.ts";
import {
  ARTIFACT_HANDSHAKE,
  ARTIFACT_PREAMBLE,
  IMAGE_TOKEN,
  INJECTED_BASE,
  MAX_SERIALIZED_LENGTH,
} from "../helpers/artifact_html.ts";
import { sniffImage } from "./attachments.ts";
import { readCappedBytes } from "@ryph/shared/http";
import { resolveImageRefs } from "./image_refs.ts";
import { isTerminal } from "./lifecycle.ts";
import { worksForkHead } from "./repo_entries.ts";
import type { AttachmentMime, Run, Task } from "./types.ts";

export { ARTIFACT_HANDSHAKE, ARTIFACT_PREAMBLE, INJECTED_BASE };

/** The catalogue skill pinned on every run whose agent may publish artifacts. */
export const ARTIFACT_SKILL = "ryph-artifact-design";

/** The largest document one version may be, in UTF-8 bytes. */
export const MAX_ARTIFACT_HTML_BYTES = 2 * 1024 * 1024;

/** The largest served document one version may be, in UTF-8 bytes, before its images are
 * inlined. The parse can grow a document: misnested formatting elements are reconstructed in
 * every block they span, so 13.7 KB was measured to serve as 2.9 MB. The sanitizer holds every
 * serialization to it as it is written (MAX_SERIALIZED_LENGTH, counted in UTF-16 code units, which
 * are never more than the UTF-8 bytes); this byte count is the exact check after. */
export const MAX_ARTIFACT_SERVED_BYTES = MAX_SERIALIZED_LENGTH;

/** The longest title, in characters. */
export const MAX_ARTIFACT_TITLE = 200;

/** How many distinct image refs one document may name. */
export const MAX_ARTIFACT_IMAGE_REFS = 20;

/** The most the inlined images of one version may add to the served document: every use of
 * every ref, as the `data:` URI it becomes. */
export const MAX_ARTIFACT_INLINED_BYTES = 16 * 1024 * 1024;

/** The most the distinct images of one version may weigh, as stored. */
export const MAX_ARTIFACT_IMAGE_BYTES = 10 * 1024 * 1024;

/** How many versions one artifact may have. */
export const MAX_ARTIFACT_VERSIONS = 100;

/** How many documents one run may hand the sanitizer, across every artifact, in any hour:
 * every attempt, refused ones included. */
export const MAX_ARTIFACT_ATTEMPTS_PER_HOUR = 30;

/** The window MAX_ARTIFACT_ATTEMPTS_PER_HOUR counts over. */
export const ARTIFACT_PUBLISH_WINDOW_MS = 60 * 60 * 1000;

/** An artifact as the user surface lists it. */
export interface Artifact {
  id: string;
  /** The latest version's title; empty once deleted. */
  title: string;
  agentId: string;
  originRunId: string;
  /** The user the first publishing run acted for; null for break-glass. */
  requestedBy: string | null;
  /** How the first publishing run's task was asked for (`Task.origin`). */
  requestOrigin: Task["origin"];
  /** The chat room and conversation the first publishing run's task was asked for in
   * (`Run.originChatroomId`, `Task.chatConversation`); the conversation is null when it was
   * not asked for in one, or on Telegram. */
  originChatroomId: string | null;
  originConversation: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** One version, without its document. */
export interface ArtifactVersionInfo {
  version: number;
  title: string;
  runId: string;
  /** The task of the run that published it. */
  taskId: string;
  /** The user that run acted for; null for break-glass. */
  requestedBy: string | null;
  bytes: number;
  createdAt: string;
}

/** One version's document as published, as served, and the images it names, by ref. */
export interface ArtifactVersionContent {
  html: string;
  /** What the content route serves, its image refs as tokens (`servedDocument` fills them). */
  servedHtml: string;
  images: Array<{ ref: string; attachmentId: string }>;
}

/** Who is asking to version or fetch an artifact: the run's agent, its task and how that was
 * asked for, the user it acts for, and the chat room and conversation it was asked for in. */
export interface VersionAsker {
  agentId: string;
  taskId: string;
  requestedBy: string | null;
  requestOrigin: Task["origin"];
  chatroomId: string | null;
  conversation: string | null;
  /** The task works a fork pull request's head (`worksForkHead`): only its own artifacts. */
  confined?: boolean;
}

/** What a publish asks the store to write. */
export interface ArtifactPublish extends VersionAsker {
  /** The id a NEW artifact gets; unused when `artifactId` names an existing one. */
  newId: string;
  /** The artifact to version; null for a new one. */
  artifactId: string | null;
  runId: string;
  title: string;
  html: string;
  servedHtml: string;
  bytes: number;
  images: Array<{ ref: string; attachmentId: string }>;
  at: string;
}

export type ArtifactPublishResult =
  | { kind: "published"; id: string; version: number; created: boolean }
  /** The title and the document are the current version's — of the artifact named, or, for a
   * new one, of an artifact this same run created: nothing was written. */
  | { kind: "unchanged"; id: string; version: number }
  /** The run is terminal: nothing may land for it any more. */
  | { kind: "concluded" }
  /** No artifact by that id this run may version. */
  | { kind: "not_found" }
  /** The artifact holds MAX_ARTIFACT_VERSIONS already. */
  | { kind: "too_many_versions" };

export type ArtifactAttemptResult =
  | { kind: "recorded" }
  /** The run is terminal: nothing may land for it any more. */
  | { kind: "concluded" }
  /** The run made MAX_ARTIFACT_ATTEMPTS_PER_HOUR attempts in the last hour; it may again at
   * `retryAt`. */
  | { kind: "rate_limited"; retryAt: string };

/** Task origins that are not one person asking: a chat room's mentions act for the room's
 * owner, an automation's fires for its owner. Neither is the owner asking for this page. */
const NOT_A_PERSON_ASKING: ReadonlySet<Task["origin"]> = new Set(["chat", "automation"]);

/**
 * Whether a run may publish a new version of `artifact`, or fetch it: a run of the agent that
 * created it, and one of
 * - a task that already made one of its versions;
 * - the same chat conversation: both tasks were asked for in the same room's same conversation
 *   (`Task.chatConversation`: a Zulip topic, a Slack thread), so a later mention there may
 *   update the page an earlier one asked for. Whoever mentions the bot there may: a chat task
 *   acts for the room's owner, never for the person who wrote. Telegram has no conversation
 *   finer than the whole group, so there only the same task may;
 * - the same person: neither task came from a chat or an automation (each acts for an owner
 *   who did not ask for this page), and this run acts for the person who first asked for it.
 * Another person's task of the same agent cannot rewrite or read back a page someone else asked
 * for, and a task on a fork's head (`confined`) only its own. Both stores decide a publish by
 * this under the artifact's lock.
 */
export function mayVersion(
  artifact: Pick<
    Artifact,
    | "agentId"
    | "requestedBy"
    | "deletedAt"
    | "requestOrigin"
    | "originChatroomId"
    | "originConversation"
  >,
  versionTaskIds: readonly string[],
  asker: VersionAsker,
): boolean {
  if (artifact.deletedAt !== null || artifact.agentId !== asker.agentId) return false;
  if (versionTaskIds.includes(asker.taskId)) return true;
  // A run on a fork's head runs the contributor's code, which could have the agent rewrite, or
  // read back, a page the same person asked for about anything else.
  if (asker.confined === true) return false;
  if (
    artifact.originChatroomId !== null && artifact.originConversation !== null &&
    artifact.originChatroomId === asker.chatroomId &&
    artifact.originConversation === asker.conversation
  ) {
    return true;
  }
  return !NOT_A_PERSON_ASKING.has(artifact.requestOrigin) &&
    !NOT_A_PERSON_ASKING.has(asker.requestOrigin) &&
    artifact.requestedBy !== null && artifact.requestedBy === asker.requestedBy;
}

/** The asker a run is: its agent, its task's origin and person, its chat conversation. */
export function askerOf(
  run: Run,
  task: Pick<Task, "origin" | "requestedByUserId" | "chatConversation" | "repos"> | null,
) {
  return {
    ...(task !== null && worksForkHead(task.repos) ? { confined: true } : {}),
    agentId: run.agentId,
    taskId: run.taskId,
    requestedBy: task?.requestedByUserId ?? null,
    // A task that cannot be read (it always can) is treated as the most restricted asker.
    requestOrigin: task?.origin ?? "automation",
    chatroomId: run.originChatroomId,
    conversation: task?.chatConversation ?? null,
  } satisfies VersionAsker;
}

/** False when the agent no longer resolves, or is archived, too. */
export async function agentMayPublishArtifacts(
  store: Pick<TaskStore, "getAgent">,
  agentId: string,
): Promise<boolean> {
  const agent = await store.getAgent(agentId);
  return agent !== null && agent.archivedAt === null && agent.canPublishArtifacts;
}

/** The app's page for an artifact; null when the deployment has no app URL. */
export function artifactUrlOf(appUrl: string | null | undefined, id: string): string | null {
  return appUrl ? `${appUrl.replace(/\/+$/, "")}/artifacts/${encodeURIComponent(id)}` : null;
}

/** Characters a title never keeps: format characters (zero-width spaces and joiners, the
 * left-to-right and right-to-left marks, bidi embeddings, overrides and isolates), which are
 * invisible or reorder what surrounds the title wherever it is shown. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** C0 and C1 controls, and the line and paragraph separators: each becomes a space. */
// oxlint-disable-next-line no-control-regex
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** What shows nothing: whitespace, characters Unicode says to ignore by default (the Hangul
 * fillers among them), combining marks on their own, and the blank braille pattern. */
const INVISIBLE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{M}\u2800]/gu;

/** A title as it is kept and shown: controls and separators as spaces, format characters gone,
 * trimmed. */
export function cleanArtifactTitle(raw: string): string {
  return raw.replace(FORMAT_CHARS, "").replace(BREAKS, " ").trim();
}

/** Whether a cleaned title shows anything at all. */
export function titleIsVisible(title: string): boolean {
  return title.replace(INVISIBLE, "").length > 0;
}

/** How long a `data:` URI of `bytes` bytes of `mime` is. */
export function dataUriLength(mime: string, bytes: number): number {
  return "data:".length + mime.length + ";base64,".length + 4 * Math.ceil(bytes / 3);
}

/** How many times each ref's token appears in a served document. */
export function tokenUses(served: string): Map<string, number> {
  const uses = new Map<string, number>();
  for (const match of served.matchAll(IMAGE_TOKEN)) {
    uses.set(match[1], (uses.get(match[1]) ?? 0) + 1);
  }
  return uses;
}

/**
 * The served document with its image tokens filled: each one whose ref has a data URI becomes
 * that URI while the inlined total stays within MAX_ARTIFACT_INLINED_BYTES; one with none, or
 * past the budget, stays a token and shows broken. One linear pass, and parse-neutral: a data
 * URI holds nothing any tokenizer state treats specially (helpers/artifact_html.ts).
 */
export function servedDocument(served: string, dataUris: ReadonlyMap<string, string>): string {
  if (dataUris.size === 0) return served;
  let budget = MAX_ARTIFACT_INLINED_BYTES;
  return served.replace(IMAGE_TOKEN, (token, ref: string) => {
    const uri = dataUris.get(ref);
    if (uri === undefined || uri.length > budget) return token;
    budget -= uri.length;
    return uri;
  });
}

/** Script and style hosts: the npm and cdnjs library paths only, never jsdelivr's GitHub or
 * WordPress mirrors, which serve any repository's files. */
const CDN_SOURCES = "https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/";

/** The policy the content route serves an artifact under. The
 * app's ARTIFACT_CSP (packages/app/src/lib/server/artifact-content.ts) is this string, byte for
 * byte; a test on each side holds it to the literal. */
export const ARTIFACT_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN_SOURCES}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDN_SOURCES}`,
  `font-src https://fonts.gstatic.com ${CDN_SOURCES} data:`,
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Every header the content route answers with, besides the length and the ETag. A version
 * never changes, so a browser may keep it, but asks each time (a delete must take effect). */
export const ARTIFACT_CONTENT_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": ARTIFACT_CSP,
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-cache",
};

/** Bumped whenever what the content route makes of the same version changes, so a browser's
 * copy of the old rendering is not answered 304. */
const SERVED_REVISION = 2;

/** The strong ETag of a version as served. */
export function artifactEtag(id: string, version: number): string {
  return `"${id}.${version}.r${SERVED_REVISION}"`;
}

/** The input a runner's publish carries. */
export interface PublishInput {
  title: string;
  html: string;
  artifactId?: string;
}

export type PublishOutcome =
  | {
    kind: "published";
    id: string;
    version: number;
    created: boolean;
    /** True when nothing changed: `version` is the current one, and nothing was written. */
    unchanged: boolean;
    url: string | null;
    /** The title as kept. */
    title: string;
  }
  | { kind: "refused"; status: number; error: string };

export interface PublishDeps {
  store: Pick<
    TaskStore,
    "getAgent" | "getTask" | "getRun" | "agentAttachmentsByRefs" | "listAttachmentsByIds"
  >;
  artifacts: ArtifactStore;
  html: ArtifactHtmlPreparer;
  appUrl: string | null;
  now(): Date;
  mintId(): string;
}

/** The `artifact-published` run event's detail: `Published "Title" (version 2)`. */
export function artifactPublishedDetail(title: string, version: number): string {
  return `Published "${title}" (version ${version})`;
}

/** What a refusal over an artifact this run may not touch says, whatever the reason. */
function notFoundError(id: string | undefined): string {
  return `no artifact ${id} this run may update. ${WHO_MAY_UPDATE} Leave artifact out to ` +
    "publish a new one.";
}

/** Who may update or fetch an artifact (`mayVersion`), in the words a refusal hands the agent. */
const WHO_MAY_UPDATE = "Only the agent that published it may, and only from a task that " +
  "already published one of its versions, from a later mention in the same Zulip topic or " +
  "Slack thread it was asked for in (on Telegram only the same task), or for the person who " +
  "first asked for it outside chat and automations; a run on a pull request from a fork only " +
  "its own task's; never once it is deleted.";

/** "at 14:05 UTC (in 12 minutes)" */
function whenAgain(retryAt: string, now: Date): string {
  const at = new Date(retryAt);
  const minutes = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 60_000));
  return `at ${at.toISOString().slice(11, 16)} UTC (in ${minutes} minute${
    minutes === 1 ? "" : "s"
  })`;
}

/**
 * A run's publish: checked against the live switch, the title, the document's size and the
 * versioning rule, answered as it is when nothing changed, then given one of the sanitizer's
 * slots and counted against the run's hour, made into the served document (parsed and
 * sanitized in a child process), its image refs resolved, and written as a new artifact or the next
 * version of `artifactId`.
 */
export async function publishArtifact(
  deps: PublishDeps,
  run: Run,
  input: PublishInput,
): Promise<PublishOutcome> {
  const refused = (status: number, error: string): PublishOutcome => ({
    kind: "refused",
    status,
    error,
  });
  if (isTerminal(run)) return refused(409, `run is terminal (${run.state})`);
  if (!await agentMayPublishArtifacts(deps.store, run.agentId)) {
    return refused(403, "this run's agent may not publish artifacts");
  }
  if (input.title.includes("\0") || input.html.includes("\0")) {
    return refused(400, "the title and the document may not hold a NUL character");
  }
  const title = cleanArtifactTitle(input.title);
  if (title.length < 1 || title.length > MAX_ARTIFACT_TITLE || !titleIsVisible(title)) {
    return refused(
      400,
      `a title is 1 to ${MAX_ARTIFACT_TITLE} characters, and at least one of them must be ` +
        "visible",
    );
  }
  const bytes = new TextEncoder().encode(input.html).byteLength;
  if (bytes > MAX_ARTIFACT_HTML_BYTES) {
    return refused(
      413,
      `the document is ${bytes} bytes; an artifact is at most ${MAX_ARTIFACT_HTML_BYTES} bytes ` +
        "(2 MiB). Inline less, or name images by their img- ref instead of embedding them.",
    );
  }
  const task = await deps.store.getTask(run.taskId);
  const asker = askerOf(run, task);
  // An update is checked before anything about the document is said: an artifact this run may
  // not touch is a 404 whatever else is wrong with the ask. The store checks again under its
  // lock.
  let carried: Array<{ ref: string; attachmentId: string }> = [];
  const unchanged = (id: string, version: number): PublishOutcome => ({
    kind: "published",
    id,
    version,
    created: false,
    unchanged: true,
    url: artifactUrlOf(deps.appUrl, id),
    title,
  });
  if (input.artifactId !== undefined) {
    const row = await deps.artifacts.get(input.artifactId);
    const versions = row === null ? [] : await deps.artifacts.versions(row.id);
    if (row === null || !mayVersion(row, versions.map((v) => v.taskId), asker)) {
      return refused(404, notFoundError(input.artifactId));
    }
    const current = await deps.artifacts.versionContent(row.id, row.currentVersion);
    // The page as it stands, asked for again: answered before the sanitizer, and not counted.
    if (current !== null && current.html === input.html && row.title === title) {
      return unchanged(row.id, row.currentVersion);
    }
    carried = current?.images ?? [];
  } else {
    const same = await deps.artifacts.createdByRunWith(run.id, title, input.html);
    if (same !== null) return unchanged(same.id, same.version);
  }
  // One document of a run's at a time, and only so many of everyone's: past either it is
  // refused at once, never queued.
  const slot = deps.html.reserve(run.id);
  if (slot.kind === "busy") {
    return refused(
      429,
      "ryph is preparing as many pages as it can at once. Try again in a moment.",
    );
  }
  if (slot.kind === "owner_busy") {
    return refused(
      429,
      "this run's previous page is still being finished. Try again in a few seconds.",
    );
  }
  let prepared: ArtifactHtmlOutcome;
  try {
    // Counted before it is sanitized, whatever the sanitizer then says of it.
    const attempt = await deps.artifacts.recordAttempt(run.id, deps.now().toISOString());
    if (attempt.kind === "concluded") return refused(409, "run is terminal");
    if (attempt.kind === "rate_limited") {
      return refused(
        429,
        `this run has handed ryph ${MAX_ARTIFACT_ATTEMPTS_PER_HOUR} pages to publish in the ` +
          "last hour, refused ones included, the most one run may. It can publish again " +
          `${whenAgain(attempt.retryAt, deps.now())}.`,
      );
    }
    prepared = await slot.prepare(input.html);
  } finally {
    // Gives the slot back only if the sanitizer never started; once it has, the slot is free
    // when its work ends.
    slot.release();
  }
  switch (prepared.kind) {
    case "busy":
      return refused(429, "ryph is shutting down. Try again in a moment.");
    case "unavailable":
      return refused(
        503,
        "ryph's page sanitizer is unavailable, so it cannot publish pages right now. Try again " +
          "in a moment; if it keeps failing, the deployment's operator should read the control " +
          "plane's log.",
      );
    case "too_complex":
      return refused(
        400,
        `the document is too complex: ryph stopped reading it after ${
          Math.round(prepared.budgetMs / 1000)
        } s. Pages that take this long are built to be slow to parse (deeply nested or ` +
          "misnested markup, thousands of unclosed tags); write plainer HTML.",
      );
    case "too_many_attributes":
      return refused(
        400,
        `the document is too complex: an element carries more than ${prepared.max} ` +
          "attributes, the most ryph reads on one. Put fewer attributes on each element.",
      );
    case "too_many_nodes":
      return refused(
        400,
        `the document is too complex: a browser would build more than ${prepared.max} ` +
          "elements, text runs and attributes from it, the most ryph reads. A small page usually " +
          "gets there by leaving formatting tags such as <b> and <i> open: a browser re-opens " +
          "each one in every block that follows. Close them before the block they are in ends, " +
          "or split a very long page.",
      );
    case "too_large":
      return refused(
        400,
        `the document grows past ${MAX_ARTIFACT_SERVED_BYTES} bytes once a browser has read it; ` +
          `an artifact may serve at most ${MAX_ARTIFACT_SERVED_BYTES} bytes (4 MiB). Close ` +
          "formatting tags such as <b> and <i> before the block they are in ends.",
      );
    case "too_deep":
      return refused(
        400,
        "the document nests elements thousands of levels deep; browsers stop nesting at a few " +
          "hundred. Close your tags, or nest less.",
      );
    case "unsettled":
      return refused(
        400,
        "ryph could not make a copy of this document that a browser reads the same way twice " +
          "(markup that changes meaning when it is re-read, such as SVG or MathML text that " +
          "looks like closing tags). Simplify the markup inside <svg> and <math>.",
      );
  }
  const servedBytes = new TextEncoder().encode(prepared.served).byteLength;
  if (servedBytes > MAX_ARTIFACT_SERVED_BYTES) {
    return refused(
      400,
      `the document grows to ${servedBytes} bytes once a browser has read it; an artifact may ` +
        `serve at most ${MAX_ARTIFACT_SERVED_BYTES} bytes (4 MiB). Close formatting tags such ` +
        "as <b> and <i> before the block they are in ends.",
    );
  }
  const refs = prepared.refs;
  if (refs.length > MAX_ARTIFACT_IMAGE_REFS) {
    return refused(
      400,
      `the document names ${refs.length} images; an artifact may show at most ` +
        `${MAX_ARTIFACT_IMAGE_REFS}`,
    );
  }
  // No wait: the runner waits on its own uploads still in flight before it publishes, as it does
  // before it asks about a summary's refs.
  const { images, unknown } = refs.length === 0
    ? { images: [], unknown: [] }
    : await resolveImageRefs({ store: deps.store }, run, refs, { wait: false });
  // A ref the version being updated already shows keeps its image, whichever run took it.
  const carriedByRef = new Map(carried.map((i) => [i.ref, i]));
  const kept = [
    ...images.map((i) => ({ ref: i.ref, attachmentId: i.attachmentId })),
    ...unknown.flatMap((ref) => carriedByRef.has(ref) ? [carriedByRef.get(ref)!] : []),
  ];
  const missing = unknown.filter((ref) => !carriedByRef.has(ref));
  if (missing.length > 0) {
    return refused(
      400,
      `no image this run kept has the ref${missing.length === 1 ? "" : "s"} ${
        missing.join(", ")
      }. An image ref names an image a tool returned in this run (the \`Image ref:\` line ` +
        "right after it), or one the version you are updating already shows.",
    );
  }
  if (kept.length > 0) {
    const rows = new Map(
      (await deps.store.listAttachmentsByIds(kept.map((i) => i.attachmentId)))
        .map((r) => [r.id, r]),
    );
    const sizes = new Map(kept.map((i) => [i.ref, rows.get(i.attachmentId)]));
    const distinct = [...sizes.values()].reduce((sum, r) => sum + (r?.bytes ?? 0), 0);
    if (distinct > MAX_ARTIFACT_IMAGE_BYTES) {
      return refused(
        400,
        `the document's images weigh ${distinct} bytes; one version may show at most ` +
          `${MAX_ARTIFACT_IMAGE_BYTES} bytes (10 MiB) of images. Show fewer, or smaller ones.`,
      );
    }
    // Every token the content route fills, counted as the data URI it becomes.
    let inlined = 0;
    for (const [ref, uses] of tokenUses(prepared.served)) {
      const row = sizes.get(ref);
      if (row !== undefined) inlined += uses * dataUriLength(row.mime, row.bytes);
    }
    if (inlined > MAX_ARTIFACT_INLINED_BYTES) {
      return refused(
        400,
        `the document's images come to ${inlined} bytes once inlined, every use of each counted; ` +
          `a version may inline at most ${MAX_ARTIFACT_INLINED_BYTES} bytes (16 MiB). Use each ` +
          "image fewer times.",
      );
    }
  }
  const result = await deps.artifacts.publish({
    ...asker,
    newId: deps.mintId(),
    artifactId: input.artifactId ?? null,
    runId: run.id,
    title,
    html: input.html,
    servedHtml: prepared.served,
    bytes,
    images: kept,
    at: deps.now().toISOString(),
  });
  switch (result.kind) {
    case "concluded":
      return refused(409, "run is terminal");
    case "not_found":
      return refused(404, notFoundError(input.artifactId));
    case "too_many_versions":
      return refused(
        409,
        `artifact ${input.artifactId} has ${MAX_ARTIFACT_VERSIONS} versions, the most one may ` +
          "have. Publish a new artifact instead.",
      );
    case "unchanged":
      return unchanged(result.id, result.version);
    case "published":
      return {
        ...result,
        unchanged: false,
        url: artifactUrlOf(deps.appUrl, result.id),
        title,
      };
  }
}

export type FetchOutcome =
  | { kind: "ok"; id: string; title: string; version: number; html: string }
  | { kind: "refused"; status: number; error: string };

/**
 * A run's `fetch_artifact`: the current version's document as published, image refs as written,
 * for the agent to edit and publish again. The same rule as a publish: the agent's switch on
 * LIVE, and an artifact this run may version (`mayVersion`); anything else reads as no such
 * artifact.
 */
export async function fetchArtifactForRun(
  deps: { store: Pick<TaskStore, "getAgent" | "getTask">; artifacts: ArtifactStore },
  run: Run,
  artifactId: string,
): Promise<FetchOutcome> {
  if (isTerminal(run)) return { kind: "refused", status: 409, error: "run is terminal" };
  if (!await agentMayPublishArtifacts(deps.store, run.agentId)) {
    return { kind: "refused", status: 403, error: "this run's agent may not publish artifacts" };
  }
  const missing: FetchOutcome = {
    kind: "refused",
    status: 404,
    error: `no artifact ${artifactId} this run may fetch: a run fetches only what it may ` +
      `update. ${WHO_MAY_UPDATE}`,
  };
  const row = await deps.artifacts.get(artifactId);
  if (row === null || row.agentId !== run.agentId) return missing;
  const [versions, task] = await Promise.all([
    deps.artifacts.versions(row.id),
    deps.store.getTask(run.taskId),
  ]);
  if (!mayVersion(row, versions.map((v) => v.taskId), askerOf(run, task))) return missing;
  const content = await deps.artifacts.versionContent(row.id, row.currentVersion);
  if (content === null) return missing;
  return {
    kind: "ok",
    id: row.id,
    title: row.title,
    version: row.currentVersion,
    html: content.html,
  };
}

/** Why a version cannot be served: no such artifact or version (or deleted). */
export type ContentOutcome =
  | { kind: "ok"; html: string }
  | { kind: "missing" };

/**
 * A version's document as the content route serves it, its images read from the attachment
 * store and inlined. An image whose row or bytes are gone, whose bytes are no longer one of the
 * four image types, or that would take the version past MAX_ARTIFACT_IMAGE_BYTES read, is left
 * as its token and shows broken: the page still renders.
 */
export async function artifactContent(
  deps: {
    artifacts: ArtifactStore;
    store: Pick<TaskStore, "listAttachmentsByIds">;
    blobs: AttachmentStore | null;
  },
  artifactId: string,
  version: number,
  signal?: AbortSignal,
): Promise<ContentOutcome> {
  const content = await deps.artifacts.versionContent(artifactId, version);
  if (content === null) return { kind: "missing" };
  const uris = new Map<string, string>();
  if (content.images.length > 0 && deps.blobs !== null) {
    const rows = await deps.store.listAttachmentsByIds(content.images.map((i) => i.attachmentId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    let budget = MAX_ARTIFACT_IMAGE_BYTES;
    for (const image of content.images) {
      const row = byId.get(image.attachmentId);
      if (row === undefined || row.bytes > budget) continue;
      signal?.throwIfAborted();
      const stream = await deps.blobs.get(row.storageKey, signal);
      if (stream === null) continue;
      const read = await readCappedBytes(stream, budget, AbortSignal.timeout(5_000));
      signal?.throwIfAborted();
      if (!read.ok) continue;
      const bytes = read.bytes;
      budget -= bytes.byteLength;
      const mime = sniffImage(bytes);
      if (mime === null || mime !== row.mime) continue;
      uris.set(image.ref, dataUri(mime, bytes));
    }
  }
  return { kind: "ok", html: servedDocument(content.servedHtml, uris) };
}

function dataUri(mime: AttachmentMime, bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
