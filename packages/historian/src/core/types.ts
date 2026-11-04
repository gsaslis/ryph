// The historian's one noun: a HistoryEvent, the atom of "what happened during a run".
//
// Two voices flow through the same envelope — the transcript (what the model did: assistant
// text, thinking, tool calls, tool results) and diagnostics (the runner's machinery story).
// The runner is the single writer for a run, so IT assigns `seq`: one counter across both
// voices yields a total order for free, and (runId, lane, seq) doubles as the idempotency key —
// a retried batch dedups instead of duplicating.
//
// A run's history is split into LANES. Lane `""` is the run's own transcript; each subagent the
// agent starts writes a lane of its own (`sa-<n>`) with its own
// seq counter. Lanes are independent records that share a run: nothing orders one lane's events
// against another's, and every reader asks for exactly one lane.
//
// Invariants:
// - ordering is `seq` within a lane, always; `at` is the runner's clock and is display-only
// - `payload` is carried, never queried into — the historian stores it verbatim (NULs aside,
//   which Postgres cannot hold) and hands it back; interpretation belongs to whoever renders it

export type HistoryVoice = "transcript" | "diag";

export interface HistoryEvent {
  runId: string;
  /** `""` for the run's own transcript, `sa-<n>` for a subagent's. Always present on output. */
  lane: string;
  /** Runner-assigned, monotonic per lane across BOTH voices — the order and, with the run and the
   * lane, the idempotency key. */
  seq: number;
  /** Runner clock, ISO-8601. Display only; ordering is seq. */
  at: string;
  voice: HistoryVoice;
  /** transcript: the chunk kind ("assistant", "tool_use", ...); diag: the dot-namespaced event key ("pi.spawn"). */
  kind: string;
  /** diag severity; null for transcript events. */
  level: "debug" | "warn" | null;
  text: string | null;
  /** transcript: the harness-native raw chunk; diag: the structured fields. */
  payload: unknown;
}

/** A HistoryEvent as it arrives on the wire — the runId comes from the URL, not the body. A
 * missing `lane` is the main lane, `""`, by the time it is one of these. */
export type IncomingHistoryEvent = Omit<HistoryEvent, "runId">;

/** The run's own transcript. */
export const MAIN_LANE = "";

/** The most subagent lanes a run can have: `sa-1` to `sa-16`. The runner starts at most this many
 * subagents in a run (its SUBAGENT_MAX_STARTED, pinned against this by the runner's
 * history_limits_test.ts), so a lane past it is one no honest runner writes. It is what keeps the
 * lane listing bounded: the listing probes exactly these lanes. */
export const MAX_SUBAGENT_LANES = 16;

/** Every lane there can be: the main lane, or a subagent's `sa-<n>` with n from 1 to
 * MAX_SUBAGENT_LANES, no leading zeros. Anything else is refused at the boundary, on ingest and on
 * read alike. */
export const LANE = /^(|sa-([1-9]|1[0-6]))$/;

/** The lane of the nth subagent, n from 1. */
export function subagentLane(n: number): string {
  return `sa-${n}`;
}

/**
 * One subagent lane as `GET /v1/runs/:id/lanes` lists it: the lane's opening, its latest
 * continuation and its latest close, each the stored transcript event CLIPPED (`clipLaneEvent`):
 * its text and the payload's strings cut to LANE_SUMMARY_TEXT_MAX, and only the payload fields the
 * listing is read for kept. The whole event is in the lane's own history. A lane is listed only
 * once it has a `subagent.start`; the main lane never is.
 *
 * running  <=>  end === null || (resume !== null && resume.seq > end.seq)
 */
export interface LaneSummary {
  /** `sa-<n>`. */
  lane: string;
  /** The lane's `subagent.start` (its first, should the runner ever write two). */
  start: HistoryEvent;
  /** Its latest `subagent.resume`, null if it was never continued. */
  resume: HistoryEvent | null;
  /** Its latest `subagent.end`, null while its first stretch is still running. */
  end: HistoryEvent | null;
  /** The sum of `payload.durationMs` over the lane's latest LANE_ENDS_SUMMED `subagent.end`s —
   * its time in all, across continuations. 0 with no end; a duration that is not a number from 0
   * to MAX_STRETCH_MS counts nothing. */
  ranMs: number;
}

/** What a lane summary's text and payload strings are cut to. The full text stays in the lane. */
export const LANE_SUMMARY_TEXT_MAX = 4_096;

/** The payload fields a lane summary keeps, per kind: what the listing is read for. */
const LANE_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  "subagent.start": ["id", "label", "mode", "task"],
  "subagent.resume": ["id", "message"],
  "subagent.end": ["id", "reason", "answerChars", "durationMs"],
};

/** Cut to `max` UTF-16 units with an ellipsis, never leaving half a surrogate pair behind. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * A lifecycle event as a lane summary carries it. The runner's run token is readable by the agent,
 * so what a lane holds is the agent's to write, and a summary is sent to every viewer of the run on
 * every change: its text is clipped, and its payload keeps only its kind's fields, each a string
 * (clipped), a finite number, a boolean or null. Anything else is dropped.
 */
export function clipLaneEvent(event: HistoryEvent): HistoryEvent {
  const fields = LANE_PAYLOAD_FIELDS[event.kind] ?? [];
  let payload: Record<string, unknown> | null = null;
  if (
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
  ) {
    const source = event.payload as Record<string, unknown>;
    payload = {};
    for (const field of fields) {
      if (!Object.hasOwn(source, field)) continue;
      const value = source[field];
      if (typeof value === "string") payload[field] = clipText(value, LANE_SUMMARY_TEXT_MAX);
      else if (typeof value === "number" && Number.isFinite(value)) payload[field] = value;
      else if (typeof value === "boolean" || value === null) payload[field] = value;
    }
  }
  return {
    ...event,
    text: event.text === null ? null : clipText(event.text, LANE_SUMMARY_TEXT_MAX),
    payload,
  };
}

/** How many of a lane's latest ends `ranMs` sums. The runner writes one end per stretch, and a
 * stretch is a continuation the agent asked for, so an honest lane is far inside it; what it
 * bounds is a lane the agent wrote itself, which could otherwise hold a million. */
export const LANE_ENDS_SUMMED = 256;

/** The longest one stretch can count toward `ranMs`: a day. The runner's stretches are at most an
 * hour; a duration outside 0..this is not one it wrote, and counts nothing. */
export const MAX_STRETCH_MS = 86_400_000;

/** The duration an end's payload contributes to `ranMs`: its `durationMs` when that is a number
 * from 0 to MAX_STRETCH_MS, 0 otherwise. */
export function stretchMs(payload: unknown): number {
  if (payload === null || typeof payload !== "object") return 0;
  const ms = (payload as { durationMs?: unknown }).durationMs;
  return typeof ms === "number" && ms >= 0 && ms <= MAX_STRETCH_MS ? ms : 0;
}

/** Lane order for listings: by the n of `sa-<n>`, numerically, so `sa-10` follows `sa-9`. */
export function compareLanes(a: string, b: string): number {
  return Number(a.slice("sa-".length)) - Number(b.slice("sa-".length));
}

/** The kinds a lane listing is drawn from, all transcript events the runner writes `keep`. */
export const LANE_START = "subagent.start";
export const LANE_RESUME = "subagent.resume";
export const LANE_END = "subagent.end";

/** Whether storing this event changes its lane's `LaneSummary`: a transcript start, resume or end
 * in a subagent's lane. What the lane listing is read from, and what wakes its live stream. */
export function changesLaneSummary(event: HistoryEvent): boolean {
  return event.lane !== MAIN_LANE && event.voice === "transcript" &&
    (event.kind === LANE_START || event.kind === LANE_RESUME || event.kind === LANE_END);
}
