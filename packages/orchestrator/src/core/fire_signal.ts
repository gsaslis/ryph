// What a fire says of itself (`FireSignal`) and which open response it belongs to. The automations
// service reads the signal out of the payload with the trigger's payload format and the door only
// ever acts on it: the orchestrator parses no payload. A signal's key and title are the SENDER's
// text, so they are bounded here on the way in — by the ingest schema for the HTTP door, and again
// by the door itself, because the single-process composition hands events over without zod.

import type { FireSignal, ResponseCorrelation, SignalStatus } from "./types.ts";

/** How long a signal's key or title may be, in code points. */
export const MAX_SIGNAL_TEXT = 200;

/** A fire that says nothing of itself: a schedule's, a `raw` webhook's, an older sender's. */
export const SILENT_SIGNAL: FireSignal = { status: "unknown", key: null, title: null };

const STATUSES: readonly SignalStatus[] = ["firing", "resolved", "update", "unknown"];

/**
 * A signal's key or title as the door keeps it: control characters and every run of whitespace
 * (line breaks included) collapsed to one space, trimmed, cut to `MAX_SIGNAL_TEXT` code points —
 * so an emoji is never split — and nothing left is null. One line, always: it lands in a chat
 * topic, a task title and a message header, none of which may be broken into two by a sender.
 */
export function boundSignalText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  // oxlint-disable-next-line no-control-regex -- control characters are what this strips
  const collapsed = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (collapsed === "") return null;
  const points = Array.from(collapsed);
  return points.length > MAX_SIGNAL_TEXT
    ? points.slice(0, MAX_SIGNAL_TEXT).join("").trimEnd()
    : collapsed;
}

/** A signal bounded as the door keeps it; a missing or unrecognised status is "unknown". */
export function normalizeSignal(signal: Partial<FireSignal> | null | undefined): FireSignal {
  if (signal === null || signal === undefined) return SILENT_SIGNAL;
  const status = STATUSES.includes(signal.status as SignalStatus)
    ? signal.status as SignalStatus
    : "unknown";
  return { status, key: boundSignalText(signal.key), title: boundSignalText(signal.title) };
}

/**
 * The slot a fire belongs to among its automation's open responses — the key half of the
 * `(automation_id, key)` partial unique index. `"fire"` keys on the event id, which no other fire
 * shares, so it never joins (a redelivery of the same event is the dedupe's, upstream of this);
 * `"automation"` is the one automation-wide slot, ""; `"key"` is the sender's key, a keyless fire
 * falling back to the automation-wide slot.
 */
export function responseSlotKey(
  correlation: ResponseCorrelation,
  signal: FireSignal,
  eventId: string,
): string {
  switch (correlation) {
    case "fire":
      return eventId;
    case "automation":
      return "";
    case "key":
      return signal.key ?? "";
  }
}

/** The task title a fire's run carries: the owner's words only. The task title heads the agent's
 * prompt, so a sender's title never goes there; it titles the response (and its chat topic)
 * instead, where people read it and the agent does not take it as its brief. */
export function automationTaskTitle(automationName: string): string {
  return `automation: ${automationName}`;
}
