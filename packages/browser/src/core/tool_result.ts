// An MCP `tools/call` result, and the two shapes every tool builds it from.

import { clip } from "./live.ts";
import { untrusted } from "./framing.ts";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** A refusal in the platform's own words: a bad argument, a ref that is gone. */
export const refusal = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

/** How much of a Playwright error the model is shown. Its call log is useful; its length is not. */
const ERROR_CAP = 2 * 1024;

/**
 * A failure Chromium reported. Playwright's messages quote the page — "<div class=…> intercepts
 * pointer events", a selector's text, a script's own exception — so the message goes inside the
 * fence like anything else the page wrote, after one platform line saying what failed. `extra`
 * is more page-written text that belongs with it (the dialogs the page raised on the way).
 */
export function failure(what: string, err: unknown, extra: string[] = []): ToolResult {
  const message = (err instanceof Error ? err.message : String(err))
    // Playwright colours its call log for a terminal; a model reads the escapes as noise.
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  const body = [clip(message, ERROR_CAP), ...extra].join("\n");
  return {
    content: [{ type: "text", text: `${what}\n\n${untrusted(body)}` }],
    isError: true,
  };
}

/** A result with platform-voice lines put before what it says (a tab replaced, a script stopped). */
export function withNotices(result: ToolResult, notices: string[]): ToolResult {
  if (notices.length === 0) return result;
  const lead = notices.join("\n");
  const [first, ...rest] = result.content;
  if (first?.type === "text") {
    return { ...result, content: [{ type: "text", text: `${lead}\n${first.text}` }, ...rest] };
  }
  return { ...result, content: [{ type: "text", text: lead }, ...result.content] };
}
