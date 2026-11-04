// A run's background commands, durably: what each job the agent started with `ryph__background_run`
// was, how it ended, and its log once it has. Live output is the historian's (its commands room);
// this is what is left when that is gone.
//
// Invariants:
// - everything here was written by the runner on the agent's behalf, over a token the agent can
//   read, so every field is bounded at the wire (schema.ts) and again here where it is shaped
//   for storage; nothing the agent wrote picks a storage key — the key is composed from the run's
//   id and a job id that matched JOB_ID first
// - a run keeps at most MAX_BACKGROUND_COMMANDS rows, and no write lands once the run is
//   concluded: both are decided under the run's row lock (ports/background_store.ts)
// - the started record and the exit record are each written once: a retry is answered as done
//   and changes nothing, so the runner may fire them blind
// - a log, like a check's, is ANSI-stripped and THEN credential-redacted (a color code inside a
//   credential cannot hide it), stored whole, and served as inert text

import { redactCredentials } from "../helpers/credentials.ts";
import { stripAnsi } from "./check_feedback.ts";
import type { BackgroundStore } from "../ports/background_store.ts";
import type { BuildLogStore } from "../ports/build_log_store.ts";
import { type Run, TERMINAL_STATES } from "./types.ts";

/** How a job ended: by itself, by its timeout, by the agent's `background_stop`, or with the run. */
export type BackgroundEndReason = "exited" | "timeout" | "stopped" | "run_ended";
export const BACKGROUND_END_REASONS = ["exited", "timeout", "stopped", "run_ended"] as const;

/** A job's id, as the runner mints it: `bg-1`, `bg-2`, … */
export const JOB_ID = /^bg-[0-9]{1,3}$/;
/** Rows a run may hold — the runner's own cap on jobs started per run. */
export const MAX_BACKGROUND_COMMANDS = 64;
/** A log as stored: the runner sends the file's last 4 MiB. */
export const MAX_BACKGROUND_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_BACKGROUND_COMMAND_CHARS = 4 * 1024;
export const MAX_BACKGROUND_LABEL_CHARS = 80;
export const MAX_BACKGROUND_CWD_CHARS = 1024;
export const BACKGROUND_TAIL_LINES = 64;
export const MAX_BACKGROUND_TAIL_CHARS = 16 * 1024;

/** One row of `run_background_commands`. Times are ISO. */
export interface BackgroundCommand {
  runId: string;
  jobId: string;
  label: string;
  command: string;
  cwd: string;
  service: boolean;
  startedAt: string;
  timeoutAt: string | null;
  endedAt: string | null;
  reason: BackgroundEndReason | null;
  exitCode: number | null;
  signal: string | null;
  /** The log's size: as the exit record reported the runner's view, until a log is stored, then
   * the stored object's own — whoever's upload won the claim, that is what the page serves. */
  logBytes: number;
  /** That view is only the end of the output: the runner dropped its start. As the runner says. */
  logTruncated: boolean;
  /** The output's last lines, as the exit record carried them, cleaned like the log. */
  logTail: string | null;
  hasLog: boolean;
  /** The upload holding the right to write the log, while one does (`claimBackgroundLog`), and
   * when it took it. Never shown to anyone. */
  logClaim: string | null;
  logClaimedAt: string | null;
  /** Where the marked upload's log is (`backgroundLogKey`); null until one is. */
  logKey: string | null;
}

export type BackgroundStart = Pick<
  BackgroundCommand,
  "runId" | "jobId" | "label" | "command" | "cwd" | "service" | "startedAt" | "timeoutAt"
>;
export type BackgroundEnd =
  & Pick<
    BackgroundCommand,
    "endedAt" | "reason" | "exitCode" | "signal" | "logBytes" | "logTruncated" | "logTail"
  >
  & { endedAt: string; reason: BackgroundEndReason };

/** Why a write did not land: the run is over, it is at its cap, or the job was never started. */
export type BackgroundRefusal = "concluded" | "full" | "missing";

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `text` cut to at most `max` UTF-16 units with an ellipsis, never leaving half a surrogate
 * pair behind. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  if (end > 0 && isHigh(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

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

/** The last `max` UTF-16 units of `text`, never starting on half a surrogate pair. */
function keepEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - max;
  if (isLow(text.charCodeAt(start))) start++;
  return text.slice(start);
}

/** The last `max` bytes of `text` as UTF-8, never starting inside a character. */
export function lastUtf8Bytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return text;
  let start = bytes.byteLength - max;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** Controls output may not carry into a page: C0 but a tab, a line feed and a carriage return
 * (the line rules below take the last), DEL, C1, and the Unicode bidi controls. */
const UNPRINTED =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * What an agent's output becomes before anyone can read it, in the order the runner cleans its
 * live output: no escapes; no controls (a `\x07` or a U+200E inside a credential would otherwise
 * split it past the redactor's patterns); line ends as the live view draws them (a `\r` that
 * opens a line is dropped — it would read as a blank one — then `\r\n` and a lone `\r` are each
 * a `\n`); then no credentials.
 */
export function cleanOutput(text: string): string {
  return redactCredentials(
    stripAnsi(text).replace(UNPRINTED, "").replace(/(^|\n)\r+/g, "$1").replace(/\r\n?/g, "\n"),
  );
}

/** The last BACKGROUND_TAIL_LINES lines of `text`, cleaned, at most MAX_BACKGROUND_TAIL_CHARS
 * (the end kept). Cleaned BEFORE it is cut, so a cut cannot split a credential past the
 * redactor. */
export function backgroundTailOf(text: string): string {
  const lines = cleanOutput(text).trimEnd().split("\n").slice(-BACKGROUND_TAIL_LINES).join("\n");
  return keepEnd(lines, MAX_BACKGROUND_TAIL_CHARS);
}

const CLAIM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where one upload of a job's log is kept: under the job, keyed by the upload's claim, so an
 * upload whose claim was taken over as stale writes beside the winner's object and never over it.
 * The row names the key of the one that was marked. Only ever called with a job id that matched
 * JOB_ID and a claim minted here.
 */
export function backgroundLogKey(runId: string, jobId: string, claim: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`not a background job id: ${JSON.stringify(jobId)}`);
  if (!CLAIM.test(claim)) throw new Error(`not a log claim: ${JSON.stringify(claim)}`);
  return `runs/${runId}/background/${jobId}/${claim}.log`;
}

/** The started record, shaped for storage. Idempotent: a job already on record keeps its first. */
export async function recordBackgroundStart(
  store: BackgroundStore,
  start: BackgroundStart,
): Promise<{ created: boolean } | BackgroundRefusal> {
  const outcome = await store.start({
    ...start,
    label: clipText(shownText(start.label), MAX_BACKGROUND_LABEL_CHARS),
    command: clipText(shownText(start.command), MAX_BACKGROUND_COMMAND_CHARS),
    cwd: clipText(shownText(start.cwd), MAX_BACKGROUND_CWD_CHARS),
  }, MAX_BACKGROUND_COMMANDS);
  if (outcome === "created") return { created: true };
  if (outcome === "exists") return { created: false };
  return outcome;
}

/** The exit record. Idempotent: a job that already ended keeps its first. */
export async function recordBackgroundEnd(
  store: BackgroundStore,
  runId: string,
  jobId: string,
  end: Omit<BackgroundEnd, "logTail"> & { logTail: string | null },
): Promise<{ ended: boolean } | BackgroundRefusal> {
  const outcome = await store.end(runId, jobId, {
    ...end,
    logTail: end.logTail === null ? null : backgroundTailOf(end.logTail),
  });
  if (outcome === "ended") return { ended: true };
  if (outcome === "already") return { ended: false };
  return outcome;
}

/** How long a claim on a job's log holds without its upload finishing: past it, the upload is
 * taken for dead (its process gone mid-read) and another may claim. Longer than the body's
 * deadline, so a live upload is always over before its claim can be taken. */
export const LOG_CLAIM_TTL_MS = 2 * 60_000;

/**
 * Claims the right to write a job's log, before its body is read. Only the claimant writes the
 * object, so of uploads racing for one job exactly one reads its body; the rest are answered
 * "busy", a job that has its log "stored" (a log is written once), and a job with no exit record
 * yet "running": a log belongs to an ended job, and the runner records the exit first — so the
 * agent's token cannot take a running job's log ahead of the runner. The claim is released if
 * the upload fails, so the runner's retry can take it.
 */
export async function claimBackgroundLog(
  store: BackgroundStore,
  runId: string,
  jobId: string,
  now: Date,
): Promise<
  { claim: string } | "stored" | "busy" | "running" | Exclude<BackgroundRefusal, "full">
> {
  const claim = crypto.randomUUID();
  const outcome = await store.claimLog(runId, jobId, {
    claim,
    at: now.toISOString(),
    staleBefore: new Date(now.getTime() - LOG_CLAIM_TTL_MS).toISOString(),
  });
  return outcome === "claimed" ? { claim } : outcome;
}

/** Gives a claim back after an upload that stored nothing. */
export async function releaseBackgroundLog(
  store: BackgroundStore,
  runId: string,
  jobId: string,
  claim: string,
): Promise<void> {
  await store.releaseLog(runId, jobId, claim);
}

/**
 * A job's log, written by the holder of its claim: cleaned, cut to its last
 * MAX_BACKGROUND_LOG_BYTES as UTF-8 (cleaning can grow it: every invalid byte the lossy decode
 * met is three in U+FFFD, and a redaction can be longer than what it hides), stored under its
 * key, then marked on its row with its size. The mark does not ask whether the run is still live: the claim
 * was granted while it was, and a run concluding mid-upload must not leave an object no row
 * points at. "lost" when the claim was no longer held (taken as stale): nothing is marked.
 */
export async function storeBackgroundLog(
  deps: { store: BackgroundStore; logs: BuildLogStore },
  runId: string,
  jobId: string,
  claim: string,
  raw: string,
): Promise<{ bytes: number } | "lost"> {
  const log = lastUtf8Bytes(cleanOutput(raw), MAX_BACKGROUND_LOG_BYTES);
  const key = backgroundLogKey(runId, jobId, claim);
  const bytes = new TextEncoder().encode(log).byteLength;
  await deps.logs.put(key, log);
  if (await deps.store.markLog(runId, jobId, claim, { key, bytes }) === "lost") return "lost";
  return { bytes };
}

/**
 * The jobs of a run as people read them. A run that concluded with a job still on record as running ended it (the runner stops every job before it reports, but a lost runner reports
 * nothing): such a job is shown as ended with the run, at the run's last update.
 */
export function presentBackgroundCommands(
  rows: BackgroundCommand[],
  run: { state: Run["state"]; updatedAt: string },
): BackgroundCommand[] {
  const over = TERMINAL_STATES.has(run.state);
  return sortBackgroundCommands(rows).map((row) => {
    return !over || row.endedAt !== null ? row : {
      ...row,
      endedAt: run.updatedAt,
      reason: "run_ended" as const,
      exitCode: null,
      signal: null,
    };
  });
}

/** A job's stored log, or null when it has none (or the store lost it). */
export async function readBackgroundLog(
  deps: { store: BackgroundStore; logs: BuildLogStore },
  runId: string,
  jobId: string,
): Promise<string | null> {
  if (!JOB_ID.test(jobId)) return null;
  const row = await deps.store.get(runId, jobId);
  if (row === null || !row.hasLog || row.logKey === null) return null;
  return await deps.logs.get(row.logKey);
}

/** The jobs of a run in the order they started: the runner numbers them that way. */
export function sortBackgroundCommands(rows: BackgroundCommand[]): BackgroundCommand[] {
  const n = (jobId: string) => Number(jobId.slice("bg-".length));
  return [...rows].sort((a, b) => n(a.jobId) - n(b.jobId));
}
