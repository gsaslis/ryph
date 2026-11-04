// What a run's agent wrote on the forge, in its own words. The forge ledger records where each write
// went and how it ended, not what it said; that is in the agent's call, so each ledger entry is
// paired with the call that made it.

import type { ToolCall } from "$lib/api/tools";
import type { ForgeToolAction } from "$lib/api/types";

/** A remark a review anchored to a line of the diff. */
export interface ReviewRemark {
  path: string;
  line: number;
  body: string;
}

/** What one forge write said, by tool. */
export type ForgeWrite =
  | { tool: "add_comment"; body: string | null; reply: boolean; resolve: boolean }
  | { tool: "submit_review"; body: string | null; remarks: ReviewRemark[] }
  | { tool: "create_issue"; title: string | null; body: string | null; labels: string[] }
  | { tool: "add_labels"; labels: string[] }
  | { tool: "close_issue"; reason: "completed" | "not_planned"; comment: string | null };

type Tool = ForgeToolAction["tool"];
const TOOLS: ReadonlySet<string> = new Set<Tool>([
  "add_comment",
  "submit_review",
  "create_issue",
  "add_labels",
  "close_issue",
]);

/** The slug the platform's forge tools are mounted under (the gateway reserves it). */
export const FORGE_SERVER = "forge";

/** A forge write call as read off the transcript, before it is matched to its ledger entry. */
export interface ForgeCall {
  tool: Tool;
  at: number;
  thread: string | null;
  write: ForgeWrite;
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? v as Record<string, unknown> : {};

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function writeOf(tool: Tool, args: Record<string, unknown>): ForgeWrite {
  switch (tool) {
    case "add_comment":
      return {
        tool,
        body: str(args, "body"),
        reply: str(args, "replyTo") !== null,
        resolve: args.resolve === true,
      };
    case "submit_review": {
      const comments = Array.isArray(args.comments) ? args.comments.map(record) : [];
      return {
        tool,
        body: str(args, "body"),
        remarks: comments.flatMap((c) => {
          const path = str(c, "path");
          const body = str(c, "body");
          return path === null || body === null || typeof c.line !== "number"
            ? []
            : [{ path, line: c.line, body }];
        }),
      };
    }
    case "create_issue":
      return {
        tool,
        title: str(args, "title"),
        body: str(args, "body"),
        labels: strings(args, "labels"),
      };
    case "add_labels":
      return { tool, labels: strings(args, "labels") };
    case "close_issue":
      return {
        tool,
        reason: args.reason === "not_planned" ? "not_planned" : "completed",
        comment: str(args, "comment"),
      };
  }
}

/** A call to one of the forge's write tools, read for its words; null for any other call. */
export function forgeCallOf(call: ToolCall): ForgeCall | null {
  const view = call.view;
  // Only the platform's own forge server: an operator's GitHub or Linear server may well have a
  // `create_issue` of its own, and its words are not this ledger's.
  if (view.kind !== "mcp" || view.server !== FORGE_SERVER || !TOOLS.has(view.tool)) return null;
  // A call refused before anything was written left no ledger entry to pair with.
  if (call.done && call.isError) return null;
  const tool = view.tool as Tool;
  const args = record(view.args);
  return { tool, at: Date.parse(call.at), thread: str(args, "thread"), write: writeOf(tool, args) };
}

/** How soon after its close a closing note's entry is recorded. */
const NOTE_MS = 2_000;

/**
 * The ledger entries that are a closing note: `close_issue` with a comment records the comment as
 * an `add_comment` of its own on the same thread, reserved just after the close. It has no call of
 * its own to pair with, and the close's row already shows it. One per close, and none for a close
 * whose call is loaded and carried no comment, so a comment the agent posted beside a bare close
 * stays its own.
 */
export function closingNotes(
  actions: readonly ForgeToolAction[],
  calls: readonly ForgeCall[],
): Set<string> {
  const closes = actions.filter((a) => a.tool === "close_issue");
  if (closes.length === 0) return new Set();
  const words = matchForgeWrites(closes, calls);
  const comments = actions
    .filter((a) => a.tool === "add_comment")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const notes = new Set<string>();
  for (const close of closes) {
    const write = words.get(close.id);
    if (write?.tool === "close_issue" && write.comment === null) continue;
    const at = Date.parse(close.createdAt);
    const note = comments.find((c) =>
      !notes.has(c.id) && c.threadRef === close.threadRef &&
      c.connectedRepoId === close.connectedRepoId &&
      Date.parse(c.createdAt) >= at && Date.parse(c.createdAt) - at <= NOTE_MS
    );
    if (note) notes.add(note.id);
  }
  return notes;
}

/** How far apart a call and its ledger entry may be, the two clocks' skew included. */
const WINDOW_MS = 30_000;

const bare = (thread: string) => thread.replace(/^#/, "");

/**
 * Each ledger entry's words: the call of the same tool, on the same thread, nearest in time to when
 * the entry was recorded and not already taken by an earlier one. A call the forge refused before
 * recording anything is simply never picked; an entry whose call is not loaded has no words.
 */
export function matchForgeWrites(
  actions: readonly ForgeToolAction[],
  calls: readonly ForgeCall[],
): Map<string, ForgeWrite> {
  const out = new Map<string, ForgeWrite>();
  const taken = new Set<ForgeCall>();
  const byTime = actions.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const action of byTime) {
    const at = Date.parse(action.createdAt);
    let best: ForgeCall | null = null;
    for (const call of calls) {
      if (call.tool !== action.tool || taken.has(call)) continue;
      if (Math.abs(call.at - at) > WINDOW_MS) continue;
      if (
        action.threadRef !== null && call.thread !== null &&
        bare(call.thread) !== bare(action.threadRef)
      ) continue;
      if (best === null || Math.abs(call.at - at) < Math.abs(best.at - at)) best = call;
    }
    if (best === null) continue;
    taken.add(best);
    out.set(action.id, best.write);
  }
  return out;
}
