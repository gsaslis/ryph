// The shared history emitter — one batching HTTP client behind BOTH outbound voices'
// history adapters (narrator and diagnostics), POSTing to the orchestrator-mounted
// historian's ingest route. One client so one seq counter per LANE: the runner is the single
// writer for its run, and a single monotonic seq across both voices is a total order for free —
// and, as (runId, lane, seq), the idempotency key that makes blind retries safe. The run's own
// transcript is lane "" (the wire leaves `lane` out for it); each subagent writes a lane of its
// own (core/subagents.ts), counted from 1 so its seqs never inflate a gap in the run's own.
// Every lane rides the same queue, batches and bounds, in emit order.
//
// Invariants (the Narrator/Diagnostics contracts, inherited):
// - `emit` is total and instant: it assigns seq + at, enqueues, returns. It can neither
//   throw nor block a run.
// - more reliable than fire-and-forget, still never gating: batches ride a timer (or a full
//   queue by count or bytes), one POST in flight at a time so batches land in order, 5xx/network kept and
//   retried with backoff (seq dedups whatever landed), 4xx dropped as definitive.
// - bounded memory: a full buffer drops the INCOMING event and counts it, per lane; when space
//   frees, a synthetic diag event records the gap IN THE LANE THAT LOST EVENTS — the history
//   admits its own holes where a reader of that lane looks. The one exception is an event the
//   caller marks `keep`, which is queued past the cap: see below.
// - the emitter's own failures are reported via the BASE diagnostics it was built with,
//   never a tee'd one — an emitter that narrated its own failures to itself would recurse.

import { serializeValue } from "@ryph/logger";
import type { Diagnostics } from "../../ports/diagnostics.ts";

const FLUSH_INTERVAL_MS = 1_000;
const MAX_BATCH = 100;
const MAX_BUFFER = 5_000;
// A byte-bounded batch may still be 1 MiB; allow slower links time to deliver it.
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
const SHUTDOWN_DEADLINE_MS = 3_000;
/** Serialized payloads above this are replaced by a truncation stub. */
const MAX_PAYLOAD_CHARS = 32_000;
/** Longest string field a truncation stub still carries — enough for an id, not for content. */
const MAX_KEPT_FIELD_CHARS = 256;
export const MAX_TEXT_CHARS = 8_000;
/** UTF-8 JSON bytes, including the batch envelope. One maximum-size event fits. */
export const MAX_BATCH_BYTES = 1_048_576;
const MAX_BUFFER_BYTES = 8 * MAX_BATCH_BYTES;
const encoder = new TextEncoder();
const wireBytes = (event: WireEvent): number => encoder.encode(JSON.stringify(event)).byteLength;
// Keep conversational prose, not just the short previews used for tools and diagnostics.
// Pinned against the historian's ingest limits by history_limits_test.ts.
export const MAX_ASSISTANT_TEXT_CHARS = 128_000;
const TRUNCATED_TEXT = "\n\n[message truncated]";

function boundText(event: HistoryEmitterEvent): string | null {
  if (event.text === undefined) return null;
  const max = event.voice === "transcript" && event.kind === "assistant"
    ? MAX_ASSISTANT_TEXT_CHARS
    : MAX_TEXT_CHARS;
  if (event.text.length <= max) return event.text;
  let end = max - TRUNCATED_TEXT.length;
  const last = event.text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return event.text.slice(0, end) + TRUNCATED_TEXT;
}

export interface HistoryEmitterEvent {
  voice: "transcript" | "diag";
  kind: string;
  level?: "debug" | "warn";
  text?: string;
  payload?: unknown;
  /**
   * Queue this even when the buffer is full.
   *
   * For the events whose LOSS CORRUPTS the record rather than shortening it. Dropping an
   * ordinary event leaves a hole, and a hole is admitted by the gap marker; dropping a
   * retraction leaves the thing it retracts standing, and a reader acting on a mark that was
   * meant to be taken back does the wrong thing with no sign anything went missing. A run that
   * overflows near its end is exactly when that happens (see the `final` mark in
   * adapters/narrator/history.ts). A subagent lane's lifecycle rows are the same kind of thing:
   * a lane whose `subagent.start` is lost is never listed, one whose `subagent.end` is lost
   * reads as running forever.
   *
   * Safe to hold past the cap because what is marked is a tiny row of a kind a busy run does not
   * produce in bulk: the `final` mark at most twice a run, and per subagent stretch two rows (its
   * `subagent.start` or `subagent.resume`, and its `subagent.end`). Starts are capped at 16 a run
   * (SUBAGENT_MAX_STARTED); a resume needs a parent tool call and four stretches at most run at
   * once, so what bounds the rest is what bounds the parent's own turns: the run's model limits.
   * Each row's payload is clipped by the core well under MAX_PAYLOAD_CHARS. Never rides the
   * wire: it is a queueing instruction, not part of the record.
   */
  keep?: boolean;
  /** The lane the event belongs to: absent or `""` for the run's own transcript, a subagent's
   * id for its own. Its seq is that lane's. */
  lane?: string;
}

export interface HistoryEmitter {
  /**
   * Total: stamps seq + at, enqueues, returns. Never throws, never blocks.
   *
   * Returns the seq it stamped, in the event's lane — the only handle anything upstream has on an event it has
   * already let go of, and what lets a writer point back at one later (the pi adapter's `final`
   * mark names the assistant message a run's result was taken from, which is only known once the
   * run settles). Undefined when nothing was queued: the emitter is shut down, or the buffer is
   * full and this event was the one dropped.
   */
  emit(event: HistoryEmitterEvent): number | undefined;
  /** Stops the timer and drains the queue best-effort within a deadline. Idempotent. */
  shutdown(): Promise<void>;
}

export interface HttpHistoryEmitterOptions {
  /** The orchestrator's base URL (the historian mounts there); a trailing slash is tolerated. */
  baseUrl: string;
  /** The run-scoped bearer — the same one the gateway reports with. */
  runToken: string;
  runId: string;
  /** The BASE diagnostics (logger-only). Never pass a diagnostics that feeds back into this emitter. */
  diag: Diagnostics;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxBuffer?: number;
  requestTimeoutMs?: number;
  backoffBaseMs?: number;
  shutdownDeadlineMs?: number;
}

interface WireEvent {
  /** Left out for the run's own lane, "". */
  lane?: string;
  seq: number;
  at: string;
  voice: "transcript" | "diag";
  kind: string;
  level: "debug" | "warn" | null;
  text: string | null;
  payload: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function httpHistoryEmitter(opts: HttpHistoryEmitterOptions): HistoryEmitter {
  const { runId, diag } = opts;
  const flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxBatch = opts.maxBatch ?? MAX_BATCH;
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const backoffBaseMs = opts.backoffBaseMs ?? BACKOFF_BASE_MS;
  const shutdownDeadlineMs = opts.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/runs/${encodeURIComponent(runId)}/events`;
  const headers = {
    authorization: `Bearer ${opts.runToken}`,
    "content-type": "application/json",
  };

  /** The next seq per lane: the run's own counts from 0 as it always has, a subagent's from 1. */
  const seqs = new Map<string, number>([["", 0]]);
  const nextSeq = (lane: string): number => seqs.get(lane) ?? 1;
  const takeSeq = (lane: string): number => {
    const stamped = nextSeq(lane);
    seqs.set(lane, stamped + 1);
    return stamped;
  };
  const queue: WireEvent[] = [];
  const sizes = new WeakMap<WireEvent, number>();
  let queueBytes = 0;
  const push = (event: WireEvent): void => {
    const bytes = wireBytes(event);
    sizes.set(event, bytes);
    queueBytes += bytes + 1;
    queue.push(event);
  };
  const remove = (count: number): void => {
    for (const event of queue.splice(0, count)) queueBytes -= sizes.get(event)! + 1;
  };
  /** Events dropped on overflow and not yet admitted by a marker, per lane. */
  const dropped = new Map<string, number>();
  let inFlight = false;
  let failures = 0;
  let blockedUntil = 0;
  let stopped = false;

  // An oversize payload, reduced to what still identifies it.
  //
  // Replacing the whole payload with a bare stub was cheaper and wrong: a payload's identity lives
  // in its short scalar fields, and the bulk is always a big string or a nested object. Dropping
  // both together took `toolCallId` out of an oversize `tool_result` — the key the reader joins a
  // call to its outcome on — so the row it belonged to waited on an answer that had already arrived,
  // and the answer rendered as a second, detached row. A `read` of a large file did it every time.
  //
  // Shape-agnostic on purpose: this knows nothing of tool calls, only that small scalars identify
  // and big things are bulk. Whoever renders it still sees `truncated` and can degrade. One
  // exception, as small as the scalars: the run attachments the payload's image blocks name
  // (`{type: "image", attachment: {id, mime}}`, pi_vision.ts) ride as `images: [{id, mime}]`, so
  // an image kept beside a large text result is still drawn (app `imagesOf`).
  const identify = (safe: unknown, bytes: number): unknown => {
    const stub: Record<string, unknown> = { truncated: true, bytes };
    if (typeof safe === "object" && safe !== null && !Array.isArray(safe)) {
      for (const [key, value] of Object.entries(safe)) {
        if (value === null || typeof value === "number" || typeof value === "boolean") {
          stub[key] = value;
        } else if (typeof value === "string" && value.length <= MAX_KEPT_FIELD_CHARS) {
          stub[key] = value;
        }
      }
    }
    const images = attachmentRefsIn(safe);
    if (images.length > 0) stub.images = images;
    // Belt: a payload of thousands of tiny fields must not rebuild the bulk it was reduced from.
    const size = JSON.stringify(stub)?.length ?? Infinity;
    return size <= MAX_PAYLOAD_CHARS ? stub : { truncated: true, bytes };
  };

  // Bounds every event at the door: an unserializable or oversize payload becomes a stub
  // here, so the queue holds only what could actually land.
  const bound = (payload: unknown): unknown => {
    if (payload === undefined || payload === null) return null;
    try {
      const safe = serializeValue(payload);
      const serialized = JSON.stringify(safe);
      if (serialized !== undefined && serialized.length > MAX_PAYLOAD_CHARS) {
        return identify(safe, serialized.length);
      }
      return safe;
    } catch {
      return { truncated: true, reason: "unserializable" };
    }
  };

  /**
   * A hole in the record, admitted in the record. `overflow` outran the buffer; `rejected` was
   * refused upstream and will never be accepted. Both are gone for good, and the difference matters
   * to whoever is reading: overflow means the run outpaced this emitter, rejection means these
   * particular events were malformed.
   */
  const noteGap = (reason: "overflow" | "rejected", count: number, lane: string): boolean => {
    // Reserve room for this small diagnostic as well as ordinary events.
    if (count === 0 || queue.length >= maxBuffer || queueBytes > MAX_BUFFER_BYTES - 1024) {
      return false;
    }
    push({
      ...(lane === "" ? {} : { lane }),
      seq: takeSeq(lane),
      at: new Date().toISOString(),
      voice: "diag",
      kind: "history.dropped",
      level: "warn",
      text: null,
      payload: { count, reason },
    });
    return true;
  };

  // Space freed after an overflow: the gap gets its own diag event before anything newer.
  // Called wherever room may have appeared (a new emit, a delivered batch) — a drop that
  // happens last must still reach the record before the queue drains for good.
  const noteOverflow = (): void => {
    for (const [lane, count] of dropped) {
      // The count is cleared only once the marker is actually queued. noteGap refuses a full
      // buffer, and clearing first threw the count away with it — so a run that stayed full to
      // the end came out short AND silent about being short, which is the one thing this is for.
      if (!noteGap("overflow", count, lane)) return;
      dropped.delete(lane);
    }
  };

  // Seq is stamped HERE, at push time, so a gap marker minted between two events can never
  // carry a later seq than an event queued behind it in the same lane.
  const enqueue = (
    event: Omit<WireEvent, "seq" | "lane">,
    lane: string,
    keep = false,
  ): number | undefined => {
    noteOverflow();
    const candidate: WireEvent = { ...(lane === "" ? {} : { lane }), seq: nextSeq(lane), ...event };
    if (
      (queue.length >= maxBuffer || queueBytes + wireBytes(candidate) + 1 > MAX_BUFFER_BYTES) &&
      !keep
    ) {
      dropped.set(lane, (dropped.get(lane) ?? 0) + 1);
      return undefined;
    }
    const stamped = takeSeq(lane);
    push(candidate);
    return stamped;
  };

  const flush = async (force = false): Promise<void> => {
    if (inFlight || queue.length === 0) return;
    if (!force && Date.now() < blockedUntil) return;
    inFlight = true;
    const batch: WireEvent[] = [];
    let bytes = 13; // {"events":[]} plus a conservative comma per event
    for (const event of queue) {
      const size = sizes.get(event)! + 1;
      if (batch.length >= maxBatch || bytes + size > MAX_BATCH_BYTES) break;
      batch.push(event);
      bytes += size;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (res.ok) {
        remove(batch.length);
        failures = 0;
        blockedUntil = 0;
        noteOverflow();
      } else if (res.status >= 400 && res.status < 500) {
        // Definitive: this batch will never be accepted. Drop it rather than wedge the queue.
        remove(batch.length);
        diag.warn("history.batch.rejected", { runId, status: res.status, count: batch.length });
        // ...and say so IN the record. The ingest schema validates a batch all-or-nothing, so one
        // malformed event takes up to `maxBatch - 1` good ones with it — a hole the reader would
        // otherwise have no way of knowing about, since this warn goes only to the runner's stderr,
        // which is the one place nobody reading a run's history is looking.
        //
        // Markers are excluded from the count, so a sink refusing everything (a bad token, say)
        // settles instead of minting a marker for the marker it just rejected, forever.
        // Each lane that lost events is told in itself.
        const lost = new Map<string, number>();
        for (const e of batch) {
          if (e.kind !== "history.dropped") {
            lost.set(e.lane ?? "", (lost.get(e.lane ?? "") ?? 0) + 1);
          }
        }
        for (const [lane, count] of lost) noteGap("rejected", count, lane);
      } else {
        failures++;
        blockedUntil = Date.now() + Math.min(BACKOFF_CAP_MS, backoffBaseMs * 2 ** (failures - 1));
        diag.warn("history.batch.failed", { runId, status: res.status, attempt: failures });
      }
    } catch (err) {
      failures++;
      blockedUntil = Date.now() + Math.min(BACKOFF_CAP_MS, backoffBaseMs * 2 ** (failures - 1));
      diag.warn("history.batch.unreachable", { runId, err: String(err), attempt: failures });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void flush(), flushIntervalMs);

  return {
    emit(event) {
      if (stopped) return undefined;
      try {
        const stamped = enqueue(
          {
            at: new Date().toISOString(),
            voice: event.voice,
            kind: event.kind.slice(0, 256),
            level: event.level ?? null,
            text: boundText(event),
            payload: bound(event.payload),
          },
          event.lane ?? "",
          event.keep === true,
        );
        // A full batch flushes now rather than waiting out the timer.
        if (queue.length >= maxBatch || queueBytes >= MAX_BATCH_BYTES) void flush();
        return stamped;
      } catch {
        // Total by contract: nothing here may escape into a caller.
        return undefined;
      }
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const deadline = Date.now() + shutdownDeadlineMs;
      // Drain best-effort: backoff is ignored (this is the last chance), the deadline is not.
      while (queue.length > 0 && Date.now() < deadline) {
        if (inFlight) {
          await sleep(20);
          continue;
        }
        const before = queue.length;
        await flush(true).catch(() => {});
        // No progress means the sink is down; burning the deadline on hot retries helps no one.
        if (queue.length >= before) await sleep(100);
      }
      if (queue.length > 0) {
        diag.warn("history.shutdown.incomplete", { runId, undelivered: queue.length });
      }
    },
  };
}

/** The `{id, mime}` of every image block in a payload that names a run attachment, in order. */
function attachmentRefsIn(value: unknown): Array<{ id: string; mime: string }> {
  const found: Array<{ id: string; mime: string }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v === null || typeof v !== "object") return;
    const object = v as Record<string, unknown>;
    if (object.type === "image") {
      const ref = object.attachment as { id?: unknown; mime?: unknown } | undefined;
      if (
        typeof ref?.id === "string" && typeof ref.mime === "string" &&
        ref.id.length <= MAX_KEPT_FIELD_CHARS && ref.mime.length <= MAX_KEPT_FIELD_CHARS
      ) {
        found.push({ id: ref.id, mime: ref.mime });
      }
      return;
    }
    Object.values(object).forEach(walk);
  };
  walk(value);
  return found;
}
