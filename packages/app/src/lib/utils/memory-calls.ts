// What a run's agent wrote to memory, read off its calls to the memory server's tools. Memory keeps
// these as signals and proposals, but answers nothing by run, so the run's own calls are the record
// a run's page has of them.

import type { ToolCall } from "$lib/api/tools";

/** The slug the memory server's tools are mounted under. */
export const MEMORY_SERVER = "memory";

interface MemoryCallBase {
  /** The call's place in the run, to find it in the transcript. */
  seq: number;
  at: string;
  /** In flight, recorded, or refused; `detail` says why when refused. */
  state: "pending" | "done" | "failed";
  detail: string | null;
}

export type MemoryCall =
  & MemoryCallBase
  & (
    | {
      tool: "propose";
      text: string | null;
      /** The proposal memory recorded it as, once it has; null in flight or when refused. */
      proposalId: string | null;
    }
    | { tool: "confirm"; id: string | null }
    | {
      tool: "refute";
      id: string | null;
      reason: string | null;
      /** What the agent said is true instead; null when it said only that this was wrong. */
      replacement: string | null;
    }
  );

function str(args: unknown, key: string): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A call that proposed, confirmed or refuted a memory, read for the pane; null for any other. */
export function memoryCallOf(call: ToolCall): MemoryCall | null {
  const view = call.view;
  if (view.kind !== "mcp" || view.server !== MEMORY_SERVER) return null;
  const base: MemoryCallBase = {
    seq: call.seq,
    at: call.at,
    state: !call.done ? "pending" : call.isError ? "failed" : "done",
    detail: call.isError ? (view.output?.trim() || null) : null,
  };
  switch (view.tool) {
    case "propose":
      return {
        ...base,
        tool: "propose",
        text: str(view.args, "text"),
        proposalId: base.state === "done"
          ? (view.output?.match(/Recorded as proposal ([^\s.]+)/)?.[1] ?? null)
          : null,
      };
    case "confirm":
      return { ...base, tool: "confirm", id: str(view.args, "id") };
    case "refute":
      return {
        ...base,
        tool: "refute",
        id: str(view.args, "id"),
        reason: str(view.args, "reason"),
        replacement: str(view.args, "replacement"),
      };
    default:
      return null;
  }
}
