import { z } from "zod";
import type { LaneSummary } from "$lib/api/history";
import type { ToolCall } from "$lib/api/tools";
import type { HistoryEvent } from "$lib/api/types";
import { formatElapsed } from "./format";

// Subagents as a reader meets them: the marks a subagent's lane opens, continues and closes with,
// its standing as the historian lists it, the agent's `ryph__subagent_*` calls that name it, and
// the notice the agent is handed when one ends.

/** A subagent's id, which is also its lane. */
export const SUBAGENT_ID = /^sa-[1-9][0-9]{0,3}$/;
/** The id a start answers with, on its own first line. */
const STARTED_ID = /^sa-\d+/;
const RYPH_SERVER = "ryph";

const modeSchema = z.enum(["explore", "work"]);
const reasonSchema = z.enum(["answered", "timeout", "stopped", "failed", "run_ended"]);
export type SubagentMode = z.infer<typeof modeSchema>;
export type SubagentEndReason = z.infer<typeof reasonSchema>;

const startPayload = z.object({
  id: z.string(),
  label: z.string(),
  mode: modeSchema,
  task: z.string(),
});
const messagePayload = z.object({ id: z.string(), message: z.string() });
const endPayload = z.object({
  id: z.string(),
  reason: reasonSchema,
  answerChars: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

/** One of the marks the runner writes into a subagent's lane, as its transcript draws it. */
export type LaneMark =
  | { kind: "start"; label: string; mode: SubagentMode; task: string }
  /** The parent continued it: what it said, where the next stretch begins. */
  | { kind: "resume"; message: string }
  /** The parent spoke to it while it worked. */
  | { kind: "message"; message: string }
  | { kind: "end"; reason: SubagentEndReason; durationMs: number };

/** The mark an event is, or null for any other event. Checked whole: the text is the agent's. */
export function laneMarkOf(event: HistoryEvent): LaneMark | null {
  switch (event.kind) {
    case "subagent.start": {
      const parsed = startPayload.safeParse(event.payload);
      if (!parsed.success) return null;
      const { label, mode, task } = parsed.data;
      return { kind: "start", label, mode, task };
    }
    case "subagent.resume":
    case "subagent.message": {
      const parsed = messagePayload.safeParse(event.payload);
      if (!parsed.success) return null;
      return {
        kind: event.kind === "subagent.resume" ? "resume" : "message",
        message: parsed.data.message,
      };
    }
    case "subagent.end": {
      const parsed = endPayload.safeParse(event.payload);
      return parsed.success
        ? { kind: "end", reason: parsed.data.reason, durationMs: parsed.data.durationMs }
        : null;
    }
    default:
      return null;
  }
}

// ---- The notice -------------------------------------------------------------------------------

const noticeSchema = z.object({
  subagent: z.object({
    id: z.string(),
    label: z.string(),
    reason: reasonSchema,
    durationMs: z.number().nonnegative(),
  }),
});
export type SubagentNotice = z.infer<typeof noticeSchema>["subagent"];

/**
 * The notice a payload carries, or null when it is not one. The runner hands the agent a
 * subagent's end as a platform message, narrated as `inbound` like a background command's, with
 * `subagent` beside its text. Checked whole: the label is what the agent typed.
 */
export function subagentNoticeOf(payload: unknown): SubagentNotice | null {
  if (typeof payload !== "object" || payload === null || !("subagent" in payload)) return null;
  return noticeSchema.safeParse(payload).data?.subagent ?? null;
}

// ---- The list ---------------------------------------------------------------------------------

/** A subagent as the tab lists it. */
export interface Subagent {
  id: string;
  label: string;
  mode: SubagentMode;
  task: string;
  startedAt: number;
  /** When the stretch running now began: the start, or the latest continue. Null once it ended. */
  runningSince: number | null;
  /** It was continued at least once. */
  continued: boolean;
  /** How its latest stretch ended; null while one runs. */
  end: { reason: SubagentEndReason; at: number; durationMs: number } | null;
  /** How long it worked in every stretch that ended; the one running now is not in it. */
  ranMs: number;
}

/** The lane is running: it has not ended, or was continued since it last did. */
export function laneRunning(lane: LaneSummary): boolean {
  return lane.end === null || (lane.resume !== null && lane.resume.seq > lane.end.seq);
}

/**
 * The subagents a listing describes, in the order they were started. A lane whose opening does not
 * read as one is left out. Once the run is over, one the listing still has running ended with it.
 */
export function subagentsOf(
  lanes: readonly LaneSummary[],
  runEndedAt: number | null = null,
): Subagent[] {
  const out: Subagent[] = [];
  for (const lane of lanes) {
    const start = laneMarkOf(lane.start);
    if (start?.kind !== "start") continue;
    const startedAt = Date.parse(lane.start.at);
    const ended = lane.end === null ? null : laneMarkOf(lane.end);
    const end = ended?.kind === "end"
      ? { reason: ended.reason, at: Date.parse(lane.end!.at), durationMs: ended.durationMs }
      : null;
    const running = laneRunning(lane);
    const since = running ? Date.parse((lane.resume ?? lane.start).at) : null;
    const subagent: Subagent = {
      id: lane.lane,
      label: start.label,
      mode: start.mode,
      task: start.task,
      startedAt,
      runningSince: since,
      continued: lane.resume !== null,
      end: running ? null : end,
      ranMs: lane.ranMs,
    };
    out.push(runEndedAt === null || since === null ? subagent : settle(subagent, runEndedAt));
  }
  return out;
}

/** A subagent still running when the run ended, as having ended with it. */
function settle(subagent: Subagent, runEndedAt: number): Subagent {
  const since = subagent.runningSince ?? runEndedAt;
  const durationMs = Math.max(0, runEndedAt - since);
  return {
    ...subagent,
    runningSince: null,
    end: { reason: "run_ended", at: Math.max(since, runEndedAt), durationMs },
    ranMs: subagent.ranMs + durationMs,
  };
}

export type SubagentTone = "running" | "ok" | "failed" | "quiet";

const ENDED: Record<SubagentEndReason, { label: string; tone: SubagentTone }> = {
  answered: { label: "Answered", tone: "ok" },
  timeout: { label: "Timed out", tone: "failed" },
  stopped: { label: "Stopped", tone: "quiet" },
  failed: { label: "Failed", tone: "failed" },
  run_ended: { label: "Ended with the run", tone: "quiet" },
};

/** How an end reads, on its own: the tab's status and the lane's closing line. */
export function endLabel(reason: SubagentEndReason): { label: string; tone: SubagentTone } {
  return ENDED[reason];
}

/** Running, or how it last ended, and how long it has worked in all. */
export function subagentStatus(
  subagent: Subagent,
  now: number,
): { label: string; duration: string; tone: SubagentTone } {
  if (subagent.runningSince !== null) {
    return {
      label: "Running",
      duration: formatElapsed(subagent.ranMs + Math.max(0, now - subagent.runningSince)),
      tone: "running",
    };
  }
  const ended = ENDED[subagent.end?.reason ?? "failed"];
  return { ...ended, duration: formatElapsed(subagent.ranMs) };
}

export function modeLabel(mode: SubagentMode): string {
  return mode === "explore" ? "Explore" : "Work";
}

/**
 * The subagent the tab shows: the one asked for, which may not be listed yet (null then, never
 * another in its place); with none asked for, the newest running one, else the newest.
 */
export function pickSubagent(
  subagents: readonly Subagent[],
  wanted: string | null,
): Subagent | null {
  if (wanted !== null) return subagents.find((s) => s.id === wanted) ?? null;
  return subagents.findLast((s) => s.runningSince !== null) ?? subagents.at(-1) ?? null;
}

// ---- The calls --------------------------------------------------------------------------------

export interface SubagentCall {
  tool: "start" | "message" | "stop";
  /** The subagent it names: the one a start made, or the one the call was given; null for none. */
  id: string | null;
  /** What a start called it. */
  label: string | null;
}

/** A `ryph__subagent_*` call, read for the subagents it names; null for any other call. */
export function subagentCallOf(call: ToolCall): SubagentCall | null {
  if (call.view.kind !== "mcp" || call.view.server !== RYPH_SERVER) return null;
  const args = (call.view.args ?? {}) as { id?: unknown; label?: unknown };
  const named = typeof args.id === "string" && SUBAGENT_ID.test(args.id) ? args.id : null;
  switch (call.view.tool) {
    case "subagent_start": {
      // The id is minted by the runner and opens its reply; a refused start has none.
      const minted = call.isError ? null : call.view.output?.trimStart().match(STARTED_ID)?.[0];
      const label = typeof args.label === "string" && args.label !== "" ? args.label : null;
      return {
        tool: "start",
        id: minted != null && SUBAGENT_ID.test(minted) ? minted : null,
        label,
      };
    }
    case "subagent_message":
      return { tool: "message", id: named, label: null };
    case "subagent_stop":
      return { tool: "stop", id: named, label: null };
    default:
      return null;
  }
}

// ---- The live list ---------------------------------------------------------------------------

/** A lane's number, which is the order subagents were started in. */
function laneNumber(lane: string): number {
  const n = Number(lane.replace(/^sa-/, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * A lane as the live feed says it, over the ones held: it replaces its own row, or joins the list
 * in start order. The feed repeats every lane when it reopens, so a repeat changes nothing.
 */
export function withLane(lanes: readonly LaneSummary[], next: LaneSummary): LaneSummary[] {
  return [...lanes.filter((lane) => lane.lane !== next.lane), next].toSorted((a, b) =>
    laneNumber(a.lane) - laneNumber(b.lane)
  );
}
