// What a tool call answers, as text. Every page-mutating tool reports the same five things — what
// it did, where the page is now (URL and title), console errors since the last report, any dialog
// it dismissed, and a fresh snapshot — so the agent never needs a second call to find out what its
// click did, and the refs it holds are always the ones the last answer printed.
//
// The layout is the framing rule made concrete: the platform's own words (what was done, what was
// cut) stand OUTSIDE the fence; everything the page wrote — its URL, its title, its accessibility
// tree, its console — stands inside ONE fence under ONE notice line.

import { capText, kb, oneLine, untrusted } from "./framing.ts";
import { clip, type ConsoleLevel, type Tab } from "./live.ts";

/**
 * The snapshot a page-mutating tool answers with, at most this long: enough to see what the
 * action did on most pages, small enough that a run of clicks does not fill the agent's context
 * with the same page over and over. `snapshot` reads more.
 */
export const REPORT_SNAPSHOT_CAP = 12 * 1024;
/** The snapshot `snapshot` itself answers with, at most this long (see RESULT_BUDGET). */
export const SNAPSHOT_TOOL_CAP = 28 * 1024;
/**
 * A whole page report, notice and fence included, at most this long SERIALIZED: as
 * `JSON.stringify` of the text, escapes counted. The runner keeps a tool result in the run's
 * history only when the whole `tool_execution_end` event serializes to at most 32,000 characters
 * (`MAX_PAYLOAD_CHARS` in its history emitter), and JSON escaping inflates exactly what a page
 * report is made of: an aria snapshot's quotes and a console error's newlines (a 31,002-character
 * report serialized to 39,192 and was stubbed). 2,000 is left for the event around the text. A
 * report under it is recorded whole, so what the transcript shows is what the agent read. The
 * snapshot gives way when the rest of the report (a long URL, many tabs, console errors) would
 * push it over, and the rest is cut when even no snapshot is too much.
 */
export const RESULT_BUDGET = 30_000;

/** The length `text` has in the runner's history, quotes and escapes included (see RESULT_BUDGET). */
export function serializedLength(text: string): number {
  return JSON.stringify(text).length;
}
/** How many console lines (and requests) one listing returns, newest kept. */
export const LIST_CAP = 200;
/** One console line in a listing, at most this long. */
export const LINE_CAP = 2 * 1024;
/** One console error in a page report, at most this long: a report carries up to 20. */
const REPORT_LINE_CAP = 500;
/** One dialog's message as kept, at most this long (a report prints at most 500 of it). */
export const DIALOG_TEXT_CAP = 1024;

export interface ConsoleEntry {
  seq: number;
  at: number;
  tabId: string;
  level: ConsoleLevel;
  text: string;
  source?: { url: string; line?: number };
  exception?: true;
}

export interface NetworkEntry {
  seq: number;
  at: number;
  tabId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  durationMs?: number;
}

export interface DialogEntry {
  type: string;
  message: string;
  /** What the sidecar answered: `beforeunload` is accepted (leaving goes ahead), the rest dismissed. */
  answer: "accepted" | "dismissed";
}

export interface PageState {
  url: string;
  title: string;
  tabs: Tab[];
  consoleErrors: ConsoleEntry[];
  dialogs: DialogEntry[];
  /** The AI-mode aria snapshot, or null when it could not be taken (the reason is in `notes`). */
  snapshot: string | null;
  /** Platform-voice facts about the call: "did not finish loading in 30 s". */
  notes: string[];
}

export function formatConsoleLine(e: ConsoleEntry, cap = LINE_CAP): string {
  const where = e.source ? ` (${e.source.url}${e.source.line ? `:${e.source.line}` : ""})` : "";
  const kind = e.exception ? "uncaught" : e.level;
  return `[${kind}] ${clip(e.text, cap)}${clip(where, 300)}`;
}

/** Dialogs as lines of a fenced block: what each said and how it was answered. */
export function dialogLines(dialogs: DialogEntry[]): string[] {
  return dialogs.map((d) => `  ${d.type} (${d.answer}): ${oneLine(d.message, 500)}`);
}

export function formatNetworkLine(e: NetworkEntry): string {
  const outcome = e.failure !== undefined
    ? `FAILED ${e.failure}`
    : e.status !== undefined
    ? String(e.status)
    : "pending";
  const took = e.durationMs !== undefined ? ` ${e.durationMs} ms` : "";
  return `${e.method} ${clip(e.url, 1000)} → ${outcome} (${e.resourceType}${took})`;
}

function tabLines(tabs: Tab[]): string[] {
  return tabs.map((t, i) =>
    `  ${i}: ${oneLine(t.title || "(untitled)", 120)} — ${clip(t.url, 500)}${
      t.active ? " (current)" : ""
    }`
  );
}

export interface ReportOptions {
  /** The snapshot's cap: REPORT_SNAPSHOT_CAP for an action, SNAPSHOT_TOOL_CAP for `snapshot`. */
  snapshotCap?: number;
  /** True for `snapshot` itself, whose cut note cannot send the agent to `snapshot`. */
  explicit?: boolean;
}

/** The full answer of a page-mutating tool, at most RESULT_BUDGET long serialized (see there). */
export function formatPageReport(did: string, state: PageState, opts: ReportOptions = {}): string {
  const explicit = opts.explicit ?? false;
  let cap = opts.snapshotCap ?? REPORT_SNAPSHOT_CAP;
  // The snapshot gives way to the rest. Cutting n characters saves at least n serialized ones
  // (an escape only makes a character longer), so a second pass is almost always the last: only
  // the cut note and the fence (by a longer backtick run) can move after it.
  for (let pass = 0; pass < 8; pass++) {
    const out = buildReport(did, state, cap, explicit);
    const over = serializedLength(out) - RESULT_BUDGET;
    if (over <= 0) return out;
    if (cap === 0) break;
    cap = Math.max(0, cap - over);
  }
  // Even with no snapshot the page is too much (fifty long tabs, twenty escape-heavy console
  // errors): the page block itself is cut, as long as fits, found by bisection.
  let lo = 0;
  let best = buildReport(did, state, 0, explicit, 0);
  let hi = buildReport(did, state, 0, explicit).length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const out = buildReport(did, state, 0, explicit, mid);
    if (serializedLength(out) <= RESULT_BUDGET) {
      best = out;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function buildReport(
  did: string,
  state: PageState,
  cap: number,
  explicit: boolean,
  pageCap?: number,
): string {
  const page: string[] = [`URL: ${clip(state.url, 2000)}`, `Title: ${oneLine(state.title, 300)}`];
  if (state.tabs.length > 1) page.push("Tabs:", ...tabLines(state.tabs));
  if (state.dialogs.length > 0) page.push("Dialogs:", ...dialogLines(state.dialogs));
  if (state.consoleErrors.length > 0) {
    page.push(`Console errors since the last call (${state.consoleErrors.length}):`);
    for (const e of state.consoleErrors.slice(-20)) {
      page.push(`  ${formatConsoleLine(e, REPORT_LINE_CAP)}`);
    }
  }
  const notes = [...state.notes];
  if (state.snapshot !== null) {
    const capped = capText(state.snapshot, cap);
    page.push("Snapshot:", capped.text);
    if (capped.truncated) {
      // The aria snapshot is the WHOLE page, scrolled-away parts included: scrolling shows
      // nothing new. Narrowing does.
      notes.push(
        `The snapshot was cut at ${kb(capped.text.length)} of ${kb(capped.total)}; ` +
          (explicit
            ? "it already covers the whole page, so scrolling shows nothing new. Narrow with " +
              "`evaluate` on a ref instead, e.g. `(el) => el.innerText`."
            : "call `browser__snapshot` for the full page, or narrow with `evaluate` on a ref, " +
              "e.g. `(el) => el.innerText`."),
      );
    }
  }
  if (state.consoleErrors.length > 20) {
    notes.push(
      `${state.consoleErrors.length - 20} earlier console errors are not shown; ` +
        "console_messages lists them.",
    );
  }
  let body = page.join("\n");
  if (pageCap !== undefined) {
    const capped = capText(body, pageCap);
    if (capped.truncated) {
      body = capped.text;
      notes.push(
        `The page report was cut at ${kb(capped.text.length)} of ${kb(capped.total)}; ` +
          "`browser__tabs` and `browser__console_messages` list their parts in full.",
      );
    }
  }
  return [did, ...notes, "", untrusted(body)].join("\n");
}

/** `console_messages`: the lines since the last call, newest LIST_CAP kept. */
export function formatConsoleList(entries: ConsoleEntry[], dropped: number): string {
  if (entries.length === 0 && dropped === 0) return "No console messages since the last call.";
  const shown = entries.slice(-LIST_CAP);
  const notes: string[] = [];
  const older = entries.length - shown.length + dropped;
  if (older > 0) notes.push(`${older} older messages are not shown.`);
  return [
    `${shown.length} console messages since the last call.`,
    ...notes,
    "",
    untrusted(shown.map((e) => formatConsoleLine(e)).join("\n")),
  ].join("\n");
}

/** `network_requests`: the requests since the last call, newest LIST_CAP kept. */
export function formatNetworkList(entries: NetworkEntry[], all: boolean, dropped: number): string {
  const kinds = all ? "requests" : "document, fetch/XHR and failed requests";
  if (entries.length === 0 && dropped === 0) return `No ${kinds} since the last call.`;
  const shown = entries.slice(-LIST_CAP);
  const notes: string[] = [];
  const older = entries.length - shown.length + dropped;
  if (older > 0) notes.push(`${older} older requests are not shown.`);
  return [
    `${shown.length} ${kinds} since the last call.`,
    ...notes,
    "",
    untrusted(shown.map(formatNetworkLine).join("\n")),
  ].join("\n");
}

export function formatTabList(tabs: Tab[]): string {
  return [
    `${tabs.length} tab${tabs.length === 1 ? "" : "s"}:`,
    "",
    untrusted(tabLines(tabs).join("\n")),
  ]
    .join("\n");
}
