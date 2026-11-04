// The ingest boundary — every JSON payload is parsed against a schema here before it may
// travel as a core type, same doctrine as the orchestrator's.
//
// Bounds are a belt over the runner's own truncation braces: a well-behaved emitter clips
// text and payload before they ride the wire, but the historian refuses oversize input
// regardless of who is speaking.

import { z } from "@zod/zod";
import { clipText, type IncomingHistoryEvent, LANE } from "./core/types.ts";
import type { LiveEvent } from "./core/live.ts";
import type { CommandsEvent } from "./core/commands.ts";

/** Max events per ingest batch — mirrors the emitter's flush ceiling with headroom. */
export const MAX_BATCH = 200;
/** Max serialized payload per event. The emitter truncates at half this; the belt is looser. */
export const MAX_PAYLOAD_CHARS = 64_000;
export const MAX_TEXT = 8_000;
// Pinned against the runner emitter by history_limits_test.ts.
export const MAX_ASSISTANT_TEXT = 128_000;
/** Read at most this many UTF-8 bytes BEFORE parsing JSON, including unknown fields. */
export const MAX_INGEST_BYTES = 1_048_576;
const MAX_KIND = 256;

const payload = z.unknown().refine(
  (value) => {
    if (value === undefined || value === null) return true;
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined || serialized.length <= MAX_PAYLOAD_CHARS;
    } catch {
      return false; // cyclic or otherwise unserializable — it could never be stored
    }
  },
  { error: `payload must serialize to at most ${MAX_PAYLOAD_CHARS} characters` },
);

const HistoryEventWireSchema = z.object({
  // Absent is the run's own transcript; a subagent's lane is `sa-<n>`, and nothing else is a lane.
  lane: z.string().regex(LANE).default(""),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  at: z.iso.datetime(),
  voice: z.enum(["transcript", "diag"]),
  kind: z.string().min(1).max(MAX_KIND),
  level: z.enum(["debug", "warn"]).nullable().default(null),
  text: z.string().max(MAX_ASSISTANT_TEXT).nullable().default(null),
  payload: payload.optional().transform((v) => v ?? null),
}).refine(
  (event) =>
    (event.voice === "transcript" && event.kind === "assistant") ||
    (event.text?.length ?? 0) <= MAX_TEXT,
  { error: `non-assistant text must contain at most ${MAX_TEXT} characters`, path: ["text"] },
) satisfies z.ZodType<IncomingHistoryEvent, unknown>;

/** What POST /v1/runs/:id/events accepts. The runId comes from the URL, never the body. */
export const IngestBatchSchema = z.object({
  events: z.array(HistoryEventWireSchema).min(1).max(MAX_BATCH),
});

// The live channel's lines (POST /v1/runs/:id/live). Nothing here is stored, but everything here is
// HELD — in a room, in each viewer's mailbox, in every snapshot — and the uplink's run token is
// one the agent itself can read, so a line is untrusted input from the agent. Hence:
// - known shapes only: unknown fields are DROPPED (`z.object` strips), so nothing rides through
//   to be held and re-sent. `frame.viewport` is the one extra the contract sanctions.
// - every string is bounded. Identifiers over their bound fail the line; free text (a console
//   line, a title, a summary, a failure, a URL) is clipped instead, so an honest event that ran
//   long still lands.
// - arrays are bounded, and a frame's `data` must be base64 of at most MAX_FRAME_BYTES decoded,
//   checked by charset and length, never decoded.
// - lines are capped by type (`liveLineCap`): a line that can carry a frame or the tab list may
//   be large, every other kind is small.

/** A frame's JPEG, decoded, at most this many bytes. The sidecar's are ~11 KB. */
export const MAX_FRAME_BYTES = 400 * 1024;
/** Base64 length of MAX_FRAME_BYTES, padding included. */
export const MAX_FRAME_DATA_CHARS = 4 * Math.ceil(MAX_FRAME_BYTES / 3);
/** Line cap for `frame`, `snapshot` and `tabs`: a frame's data plus the whole tab list. */
export const MAX_LIVE_FRAME_LINE = 768 * 1024;
/** Line cap for every other kind of live line. */
export const MAX_LIVE_EVENT_LINE = 16 * 1024;
export const MAX_LIVE_TABS = 50;

const LIVE_TEXT = 8 * 1024;
const LIVE_URL = 2 * 1024;
const LIVE_TITLE = 1024;
const LIVE_NOTE = 1024; // an action's summary, a request's failure
const LIVE_TOOL = 64;
const LIVE_ID = 256;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const clipped = (max: number) => z.string().transform((text) => clipText(text, max));

/** Controls a label, a command or a cwd may not carry into a page: C0 and C1 (a tab is kept, a
 * line break becomes a space, so a multi-line command still reads as one), DEL, and the Unicode
 * bidi controls that would let one line render in an order other than its own. */
const UNSHOWN =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` without UNSHOWN, its line breaks spaces. */
export function shownText(text: string): string {
  return text.replace(/\r\n|[\n\r]/g, " ").replace(UNSHOWN, "");
}

/** A label, a command or a cwd: what people are shown, so `shownText`, then clipped. */
const shown = (max: number) => z.string().transform((text) => clipText(shownText(text), max));

const id = z.string().max(LIVE_ID);
const at = z.number().finite();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pixels = z.number().int().positive().max(100_000);
const liveStatus = z.enum(["idle", "launching", "active", "closed"]);
const liveTab = z.object({
  id,
  url: clipped(LIVE_URL),
  title: clipped(LIVE_TITLE),
  active: z.boolean(),
});
const liveTabs = z.array(liveTab).max(MAX_LIVE_TABS);
const liveFrame = z.object({
  mime: z.literal("image/jpeg"),
  data: z.string().max(MAX_FRAME_DATA_CHARS).regex(BASE64),
  width: pixels,
  height: pixels,
  tabId: id,
  viewport: z.object({ width: pixels, height: pixels }).optional(),
});
const rect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});

const LiveEventWireSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    at,
    status: liveStatus,
    tabs: liveTabs,
    frame: liveFrame.nullable(),
  }),
  z.object({ type: z.literal("frame"), at, frame: liveFrame }),
  z.object({ type: z.literal("tabs"), at, tabs: liveTabs }),
  z.object({
    type: z.literal("console"),
    at,
    tabId: id,
    level: z.enum(["debug", "log", "info", "warn", "error"]),
    text: clipped(LIVE_TEXT),
    source: z.object({ url: clipped(LIVE_URL), line: count.optional() }).optional(),
    exception: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("network"),
    at,
    tabId: id,
    method: z.string().max(LIVE_TOOL),
    url: clipped(LIVE_URL),
    resourceType: z.string().max(LIVE_TOOL),
    status: z.number().int().min(0).max(999).optional(),
    failure: clipped(LIVE_NOTE).optional(),
    durationMs: z.number().finite().min(0).optional(),
  }),
  z.object({
    type: z.literal("action"),
    at,
    tool: z.string().max(LIVE_TOOL),
    summary: clipped(LIVE_NOTE),
    target: rect.optional(),
  }),
  z.object({ type: z.literal("status"), at, status: liveStatus }),
]) satisfies z.ZodType<LiveEvent, unknown>;

/** The line cap for a live line of this `type`: large only where a frame or the tabs can ride. */
export function liveLineCap(type: unknown): number {
  return type === "frame" || type === "snapshot" || type === "tabs"
    ? MAX_LIVE_FRAME_LINE
    : MAX_LIVE_EVENT_LINE;
}

/**
 * One NDJSON line of the live uplink: the event, `"oversize"` for a line over its type's cap, or
 * `"malformed"` for one that is not a live event we understand. The caller has already refused
 * anything over MAX_LIVE_FRAME_LINE bytes before parsing.
 */
export function parseLiveLine(line: string): LiveEvent | "oversize" | "malformed" {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "malformed";
  }
  const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : null;
  if (line.length > liveLineCap(type)) return "oversize";
  const parsed = LiveEventWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : "malformed";
}

// The background commands' lines (POST /v1/runs/:id/live/commands). The same doctrine as the
// browser's above — held, never stored, and as untrusted as the agent — with one cap for every
// line, since none carries anything large: an output line's text is clipped to 8 KiB.
// - a job id is the runner's `bg-<n>` and nothing else, refused rather than clipped: it keys the
//   room's jobs and is what a viewer asks the orchestrator for the stored log by.
// - a label, a command and a cwd are clipped to what the contract shows people, after control and
//   bidi characters are taken out (`shownText`): the agent can write these lines itself.
// - a moment (`at`, `timeoutAt`) is epoch milliseconds or an ISO string, and is held and sent on
//   as milliseconds, as the browser's lines have it.

/** The cap on every commands line, in bytes. */
export const MAX_COMMANDS_LINE = 16 * 1024;
/** A background job's id, as the runner mints it. */
export const JOB_ID = /^bg-[0-9]{1,3}$/;
/** A signal's name, as the runtime reports one (`SIGTERM`). */
export const SIGNAL_NAME = /^SIG[A-Z0-9]{1,12}$/;

const jobId = z.string().regex(JOB_ID);
const moment = z.union([
  at,
  z.iso.datetime({ offset: true }).transform((iso) => Date.parse(iso)),
]);
/** A label: something must be left to show once `shown` has had it. */
const nonEmptyClipped = (max: number) =>
  shown(max).refine((text) => text.trim() !== "", { error: "nothing to show" });

const CommandsEventWireSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    at: moment,
    id: jobId,
    label: nonEmptyClipped(80),
    command: shown(2 * 1024),
    cwd: shown(1024),
    service: z.boolean(),
    timeoutAt: moment.nullable().default(null),
  }),
  z.object({ type: z.literal("output"), at: moment, id: jobId, text: clipped(LIVE_TEXT) }),
  z.object({ type: z.literal("skipped"), at: moment, id: jobId, bytes: count }),
  z.object({
    type: z.literal("exited"),
    at: moment,
    id: jobId,
    reason: z.enum(["exited", "timeout", "stopped", "run_ended"]),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().default(null),
    signal: z.string().regex(SIGNAL_NAME).nullable().default(null),
  }),
]) satisfies z.ZodType<CommandsEvent, unknown>;

/**
 * One NDJSON line of the commands uplink: the event, or `"malformed"` for one that is not a
 * commands event we understand. The caller has already refused anything over MAX_COMMANDS_LINE
 * bytes before parsing.
 */
export function parseCommandsLine(line: string): CommandsEvent | "malformed" {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return "malformed";
  }
  const parsed = CommandsEventWireSchema.safeParse(raw);
  return parsed.success ? parsed.data : "malformed";
}
