import { z } from "zod";
import type { BackgroundJob, BackgroundReason } from "$lib/api/background";
import type { ToolCall } from "$lib/api/tools";
import { formatElapsed } from "./format";

// Background commands as a reader meets them: a job's status in words, the runner's notice that
// one became ready or ended, and the agent's `ryph__background_*` calls.

/** How a job ended, as the runner records it. */
export interface JobEnd {
  reason: BackgroundReason;
  exitCode: number | null;
  signal: string | null;
}

/** The ending in a few words: "exited 1", "timed out", "stopped", "ended with the run". */
export function endedPhrase(end: JobEnd): string {
  switch (end.reason) {
    case "timeout":
      return "timed out";
    case "stopped":
      return "stopped";
    case "run_ended":
      return "ended with the run";
    case "exited":
      if (end.exitCode !== null) return `exited ${end.exitCode}`;
      return end.signal !== null ? `killed by ${end.signal}` : "exited";
  }
}

/** Whether an ending is a failure: a non-zero exit, a signal nobody sent, or a timeout. */
export function endedBadly(end: JobEnd): boolean {
  if (end.reason === "timeout") return true;
  if (end.reason !== "exited") return false;
  return end.exitCode !== 0;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export type JobTone = "running" | "ok" | "failed" | "quiet";

/** A job's status for a list row: what it is doing or how it ended, and how long it took. */
export function jobStatus(
  job: Pick<BackgroundJob, "startedAt" | "endedAt" | "reason" | "exitCode" | "signal">,
  now: number,
): { label: string; duration: string; tone: JobTone } {
  if (job.endedAt === null || job.reason === null) {
    return {
      label: "Running",
      duration: formatElapsed(Math.max(0, now - job.startedAt)),
      tone: "running",
    };
  }
  const end = { reason: job.reason, exitCode: job.exitCode, signal: job.signal };
  return {
    label: capitalise(endedPhrase(end)),
    duration: formatElapsed(Math.max(0, job.endedAt - job.startedAt)),
    tone: endedBadly(end) ? "failed" : end.reason === "exited" ? "ok" : "quiet",
  };
}

// ---- The notice ---------------------------------------------------------------------------

/** What the runner's notice says off the `inbound` event's payload. A notice is sent for
 * readiness, an exit or a timeout; a stop, or the run ending, sends none. */
const noticeSchema = z.object({
  background: z.object({
    id: z.string(),
    label: z.string(),
    reason: z.enum(["exited", "timeout", "ready"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    durationMs: z.number().nonnegative(),
  }),
});
export type BackgroundNotice = z.infer<typeof noticeSchema>["background"];

/**
 * The notice a payload carries, or null when it is not one. The notice is narrated as `inbound`
 * like a wake-up, and its message carries `background` beside the text where a wake-up carries
 * `wake`. Checked whole: the payload is the runner's, but it names what the agent typed.
 */
export function backgroundNoticeOf(payload: unknown): BackgroundNotice | null {
  if (typeof payload !== "object" || payload === null || !("background" in payload)) return null;
  return noticeSchema.safeParse(payload).data?.background ?? null;
}

/** The notice after its label: "ready after 12s" or "exited 1 after 4m 12s". */
export function noticeSentence(notice: BackgroundNotice): string {
  const phrase = notice.reason === "ready"
    ? "ready"
    : endedPhrase({ ...notice, reason: notice.reason });
  return `${phrase} after ${formatElapsed(notice.durationMs)}`;
}

/** Readiness is not an ending, and must never get an exit-failure treatment. */
export function noticeFailed(notice: BackgroundNotice): boolean {
  return notice.reason !== "ready" && endedBadly({ ...notice, reason: notice.reason });
}

// ---- The agent's calls --------------------------------------------------------------------

/** The loopback server the runner's own tools are registered under. */
const RYPH_SERVER = "ryph";
const JOB_ID = /\bbg-[0-9]{1,3}\b/;

export interface BackgroundCall {
  tool: "run" | "output" | "stop";
  /** The job the call is about; null for a listing, or a start that has not answered. */
  jobId: string | null;
  /** The label the agent gave it, where the call carries one (a start). */
  label: string | null;
}

/** A `ryph__background_*` call, read; null for any other call. */
export function backgroundCallOf(call: ToolCall): BackgroundCall | null {
  if (call.view.kind !== "mcp" || call.view.server !== RYPH_SERVER) return null;
  const args = (call.view.args ?? {}) as { id?: unknown; label?: unknown };
  const named = typeof args.id === "string" && JOB_ID.test(args.id) ? args.id : null;
  switch (call.view.tool) {
    case "background_run": {
      // The id is minted by the runner and is in its reply; a refused start has none.
      const minted = call.isError ? null : (call.view.output?.match(JOB_ID)?.[0] ?? null);
      const label = typeof args.label === "string" && args.label !== "" ? args.label : null;
      return { tool: "run", jobId: minted, label };
    }
    case "background_output":
      return { tool: "output", jobId: named, label: null };
    case "background_stop":
      return { tool: "stop", jobId: named, label: null };
    default:
      return null;
  }
}
