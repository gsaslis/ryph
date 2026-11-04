// A run's history, as a model wants to read it: one line per thing that happened, each tool call
// folded with its result, long text cut, the diag voice and the model's thinking left out unless
// asked for. Every event starts a line with its seq (a message's further lines are indented), the cursor a caller pages with and the handle
// `run_transcript {seq}` reads one event in full by.
//
// The events are the historian's (packages/historian `HistoryEvent`), and the payloads are the
// runner's, typed `unknown` by contract: the echo harness sends none, and the runner's emitter
// reduces a payload over 32 KB to its identifying scalars. Every read here is defensive and falls
// back to the event's flat `text`, which is always there. The app reads them the same way
// (packages/app/src/lib/api/tools.ts).

import { clip, cut, duration } from "./format.ts";

export interface HistoryEvent {
  runId: string;
  lane: string;
  seq: number;
  at: string;
  voice: "transcript" | "diag";
  kind: string;
  level: "debug" | "warn" | null;
  text: string | null;
  payload: unknown;
}

export interface SummaryOptions {
  /** The model's reasoning, which is long and rarely what a reader is after. */
  thinking?: boolean;
  /** The runner's diag voice; its warnings are shown regardless. */
  diag?: boolean;
  /** How much of an assistant or inbound message a line carries. */
  textChars?: number;
  /** How much of a tool's result a line carries. */
  resultChars?: number;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

const s = (v: unknown): string | null => typeof v === "string" ? v : null;

/** A tool_use payload's id, name and arguments. */
function useOf(e: HistoryEvent): { id: string; name: string; args: unknown } | null {
  const p = obj(e.payload);
  const id = s(p?.toolCallId);
  const name = s(p?.toolName);
  return id && name ? { id, name, args: p?.args } : null;
}

/** A tool_result payload's id, result and error flag. */
function resultOf(e: HistoryEvent): { id: string; result: unknown; isError: boolean } | null {
  const p = obj(e.payload);
  const id = s(p?.toolCallId);
  return id ? { id, result: p?.result, isError: p?.isError === true } : null;
}

/** The text parts of an MCP-style result, joined; else the event's own text. */
export function resultText(result: unknown, fallback: string | null): string {
  const content = obj(result)?.content;
  if (Array.isArray(content)) {
    const parts = content.flatMap((c) => {
      const part = obj(c);
      if (part?.type === "text" && typeof part.text === "string") return [part.text];
      if (part?.type === "image") return ["[image]"];
      return [];
    });
    if (parts.length > 0) return parts.join("");
  }
  if (typeof result === "string") return result;
  return fallback ?? "";
}

/** What a call was asked to do, in one short line. */
function argsLine(name: string, args: unknown): string {
  const a = obj(args);
  if (name === "bash" && typeof a?.command === "string") return clip(a.command, 240);
  if ((name === "read" || name === "edit" || name === "write") && typeof a?.path === "string") {
    const extra = name === "write" && typeof a.content === "string"
      ? ` (${a.content.split("\n").length} lines)`
      : "";
    return `${a.path}${extra}`;
  }
  if (args === undefined) return "";
  return clip(JSON.stringify(args), 200);
}

/** The transcript lines of a page of events, oldest first. */
export function summarize(events: readonly HistoryEvent[], opts: SummaryOptions = {}): {
  lines: string[];
  hidden: { thinking: number; diag: number };
} {
  const textChars = opts.textChars ?? 1200;
  const resultChars = opts.resultChars ?? 300;
  const results = new Map<string, HistoryEvent>();
  const used = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_result") {
      const r = resultOf(e);
      if (r) results.set(r.id, e);
    } else if (e.kind === "tool_use") {
      const u = useOf(e);
      if (u) used.add(u.id);
    }
  }
  const hidden = { thinking: 0, diag: 0 };
  const lines: string[] = [];
  // Only an event's first line starts at the margin: the rest of a multi-line message is
  // indented, so a run's text holding "#12 bash …" cannot pass for an event line of its own.
  const push = (line: string) => void lines.push(line.replace(/\r\n|\r|\n/g, "\n    "));
  for (const e of events) {
    const head = `#${e.seq}`;
    if (e.voice === "diag") {
      if (opts.diag || e.level === "warn") {
        push(`${head} ${e.level === "warn" ? "⚠ " : ""}[${e.kind}] ${clip(e.text, 300)}`);
      } else {
        hidden.diag++;
      }
      continue;
    }
    switch (e.kind) {
      case "final":
        continue;
      case "thinking":
        if (opts.thinking) push(`${head} thinking: ${clip(e.text, textChars)}`);
        else hidden.thinking++;
        continue;
      case "assistant":
        push(`${head} assistant: ${cut((e.text ?? "").trim(), textChars)}`);
        continue;
      case "inbound":
        push(`${head} inbound message: ${cut((e.text ?? "").trim(), textChars)}`);
        continue;
      case "tool_use": {
        const u = useOf(e);
        if (u === null) {
          push(`${head} tool: ${clip(e.text, 240)}`);
          continue;
        }
        const r = results.get(u.id);
        const call = `${head} ${u.name}${
          argsLine(u.name, u.args) ? ` ${argsLine(u.name, u.args)}` : ""
        }`;
        if (r === undefined) {
          push(`${call} → (no result in this page; still running, or on a later page)`);
          continue;
        }
        const parsed = resultOf(r)!;
        const text = resultText(parsed.result, r.text).trim();
        push(
          `${call} → ${parsed.isError ? "ERROR" : "ok"}${
            text ? `: ${clip(text, resultChars)}` : ""
          }`,
        );
        continue;
      }
      case "tool_result": {
        const r = resultOf(e);
        // Folded into its call above.
        if (r !== null && used.has(r.id)) continue;
        const text = resultText(r?.result, e.text).trim();
        push(
          `${head} result of an earlier call${r?.isError ? " (ERROR)" : ""}: ${
            clip(text, resultChars)
          }`,
        );
        continue;
      }
      case "subagent.start":
      case "subagent.resume":
      case "subagent.message": {
        const p = obj(e.payload);
        const said = s(p?.task) ?? s(p?.message) ?? e.text;
        push(`${head} ${e.kind}${s(p?.id) ? ` ${p!.id}` : ""}: ${clip(said, 300)}`);
        continue;
      }
      case "subagent.end": {
        const p = obj(e.payload);
        const took = typeof p?.durationMs === "number" ? ` after ${duration(p.durationMs)}` : "";
        push(
          `${head} subagent.end${s(p?.id) ? ` ${p!.id}` : ""}: ${s(p?.reason) ?? "ended"}${took}`,
        );
        continue;
      }
      default:
        push(`${head} ${e.kind}: ${clip(e.text, 300)}`);
    }
  }
  return { lines, hidden };
}

/** One event in full: a tool call with its whole arguments and result, or the whole text. */
export function eventInFull(event: HistoryEvent, events: readonly HistoryEvent[], max = 40_000) {
  const header = `#${event.seq} ${event.voice}/${event.kind} at ${event.at}${
    event.lane ? ` in ${event.lane}` : ""
  }`;
  if (event.kind === "tool_use") {
    const u = useOf(event);
    if (u !== null) {
      const r = events.find((e) => e.kind === "tool_result" && resultOf(e)?.id === u.id);
      const parsed = r ? resultOf(r)! : null;
      return [
        header,
        `Tool: ${u.name}`,
        `Arguments: ${cut(JSON.stringify(u.args ?? null, null, 2), max / 2)}`,
        r === undefined
          ? "Result: not found near it (still running, or further on)."
          : `Result (#${r.seq}${parsed!.isError ? ", ERROR" : ""}):\n${
            cut(resultText(parsed!.result, r.text), max)
          }`,
      ].join("\n");
    }
  }
  if (event.kind === "tool_result") {
    const r = resultOf(event);
    return `${header}\n${cut(resultText(r?.result, event.text), max)}`;
  }
  const text = event.text ?? "";
  const payload = event.payload === undefined || event.payload === null
    ? ""
    : `\nPayload: ${cut(JSON.stringify(event.payload), max / 4)}`;
  return `${header}\n${cut(text, max)}${payload}`;
}
