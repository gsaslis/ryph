// Reading a Responses API event stream for how it ENDED — and, for a caller that never asked for a
// stream, turning it back into the one JSON response that caller expects. Pure, fed the bytes as
// they pass, like metering.ts beside it.
//
// Why it exists: a ChatGPT plan answers only streamed requests, and reports its usage limit as a
// `response.failed` event after the stream has opened with a 200 — so the proxy has to watch the
// terminal event to know whether to mark the key `limited` (or clear it), and has to assemble the
// stream for the memory service, which calls Responses non-streaming.
//
// Invariants:
// - never throws: an unreadable stream is one that ended with no terminal event
// - watching only holds one SSE line at a time; assembling holds the response, bounded by the
//   caller (the proxy caps it like a request body)

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How a stream ended: its terminal event's kind, or null when none arrived. */
export type ResponsesEnding = "completed" | "incomplete" | "failed" | "error" | null;

export interface ResponsesStreamResult {
  ending: ResponsesEnding;
  /** The error code a `response.failed` or `error` event carried. */
  errorCode: string | null;
  /** The terminal event's whole `response` (or the `error` event itself), with its `output`
   * filled from the stream's finished items when the terminal event left it empty. Only when
   * assembling. */
  response: Json | null;
}

export interface ResponsesStreamReader {
  push(chunk: Uint8Array): void;
  finish(): ResponsesStreamResult;
}

/** One SSE line over this is skipped unread, like metering's. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;

const TERMINAL: Record<string, ResponsesEnding> = {
  "response.completed": "completed",
  "response.incomplete": "incomplete",
  "response.failed": "failed",
  "error": "error",
};

/**
 * @param assemble keep the response and every finished output item, for a caller that wants
 * JSON. Without it only the ending and its code are kept, and only terminal-looking lines are
 * parsed at all.
 */
export function makeResponsesStreamReader(assemble: boolean): ResponsesStreamReader {
  const decoder = new TextDecoder();
  let pending = "";
  let overflowed = false;
  let ending: ResponsesEnding = null;
  let errorCode: string | null = null;
  let response: Json | null = null;
  const items = new Map<number, unknown>();

  const event = (raw: string) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) return;
    // A content delta is never parsed when watching: only an event that could end the stream.
    if (!assemble && !/"type"\s*:\s*"(response\.(completed|incomplete|failed)|error)"/.test(line)) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line.slice("data:".length));
    } catch {
      return;
    }
    if (!isObject(payload) || typeof payload.type !== "string") return;
    if (payload.type === "response.output_item.done" && typeof payload.output_index === "number") {
      items.set(payload.output_index, payload.item);
      return;
    }
    if (!Object.hasOwn(TERMINAL, payload.type)) return;
    ending = TERMINAL[payload.type];
    if (payload.type === "error") {
      errorCode = typeof payload.code === "string" ? payload.code : null;
      if (assemble) response = payload;
      return;
    }
    const subject = isObject(payload.response) ? payload.response : null;
    const error = subject !== null && isObject(subject.error) ? subject.error : null;
    errorCode = error !== null && typeof error.code === "string" ? error.code : null;
    if (assemble) response = subject;
  };

  return {
    push(chunk) {
      try {
        const text = decoder.decode(chunk, { stream: true });
        let start = 0;
        for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
          if (overflowed) overflowed = false;
          else event(pending + text.slice(start, nl));
          pending = "";
          start = nl + 1;
        }
        if (!overflowed) {
          pending += text.slice(start);
          if (pending.length > MAX_LINE_CHARS) {
            pending = "";
            overflowed = true;
          }
        }
      } catch {
        // Reading never breaks a model call.
      }
    },
    finish() {
      try {
        if (!overflowed) {
          pending += decoder.decode();
          if (pending !== "") event(pending);
        }
      } catch {
        // As above.
      }
      pending = "";
      if (
        assemble && response !== null && ending !== "error" &&
        (!Array.isArray(response.output) || response.output.length === 0) && items.size > 0
      ) {
        response = {
          ...response,
          output: [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
        };
      }
      return { ending, errorCode, response };
    },
  };
}
