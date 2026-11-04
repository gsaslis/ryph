// Reading a model call's token usage off its response as the bytes stream past — the metering half
// of the data plane, pure and DIALECT-aware, so every shape is unit-tested with byte arrays.
//
// Keyed on the dialect rather than on a provider id, because a provider id is now whatever an
// admin typed when registering an endpoint: a name cannot say which usage shape comes back, and
// a table mapping the two would have to be edited every time someone adds a Groq. The dialect
// travels with the provider (see registry.ts) and is the only thing this file switches on.
//
// Three wire shapes carry usage, and the proxy forwards all three untouched:
// - Anthropic Messages: `usage` on a JSON body. Streamed, `message_start` carries the input side
//   and every `message_delta` the running totals; a non-null field overrides what came before.
// - OpenAI Responses (the `openai-responses` dialect): `usage` on a JSON body. Streamed, on the
//   terminal event's `response` (`response.completed`, `.incomplete`, `.failed`); the opening
//   `response.created` carries `usage: null` and the model. Cached tokens sit inside
//   `input_tokens` (`input_tokens_details.cached_tokens`), reasoning inside `output_tokens`
//   (`output_tokens_details.reasoning_tokens`).
// - OpenAI Chat Completions: `usage` on a JSON body. Streamed, on the last chunk ONLY when the
//   request asked with `stream_options.include_usage` — which the proxy makes every streamed call
//   ask (core/usage_fallback.ts), since the caller choosing is the caller choosing to go unpriced.
//
// Whether the usage read is FINAL is reported beside it: Anthropic's stream opens with the input
// side and only its closing `message_delta` carries the output total, so a stream cut in between
// has counts that are not what was spent. The proxy fills what is missing with an estimate.
//
// Invariants:
// - never throws: a body that will not parse is an unmetered row, never a failed model call
// - bounded memory: a JSON body is held only at its two ends (JSON_WINDOW_CHARS each, which is
//   where `model` and `usage` live) and an SSE line up to MAX_BUFFERED_CHARS; past that, the
//   middle of the body — or that one line — is dropped rather than growing the process
// - `input` never includes cache reads or writes, whichever provider's own figure did
// - the MODEL comes back with the tokens, off the same payloads: what a call cost is a fact
//   about the response, not about what the caller asked for

import type { Dialect } from "./registry.ts";
import type { TokenCounts } from "./pricing.ts";

/** What a response told us about itself. */
export interface MeteredUsage {
  /** The usage the body carried, or null when it carried none. */
  tokens: TokenCounts | null;
  /**
   * The model the provider says it SERVED, off the same payloads the usage comes from — the
   * authority on what a request cost. A request's own body is only a request: a snapshot alias
   * resolves upstream. Null when nothing metered named one.
   */
  model: string | null;
  /** Whether `tokens` is the response's whole account: a JSON body's usage, Anthropic's closing
   * `message_delta`, an OpenAI stream's usage-bearing last event. False for a body that carried
   * none, and for an Anthropic stream that stopped after `message_start`. */
  final: boolean;
}

export interface UsageMeter {
  /** Feeds one chunk of the response body, in order. */
  push(chunk: Uint8Array): void;
  /** What the body reported. Call once, at the end. */
  finish(): MeteredUsage;
}

/** How much of one SSE line is held before the line is skipped, unread, to its end. */
const MAX_BUFFERED_CHARS = 8 * 1024 * 1024;

/**
 * How much of each END of a JSON body is held. A non-streaming completion is not read line by
 * line, so metering one used to mean accumulating the WHOLE body just to parse it at the end —
 * against this file's own bounded-memory invariant, and up to 16 MB of UTF-16 per in-flight
 * request. Two windows are enough: every dialect writes `model` near the head of its object and
 * `usage` at the tail, and a body that still fits inside them is parsed whole as before.
 */
const JSON_WINDOW_CHARS = 64 * 1024;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

export function makeUsageMeter(dialect: Dialect, contentType: string | null): UsageMeter {
  const type = contentType?.toLowerCase() ?? "";
  const mode = type.includes("text/event-stream") ? "sse" : type.includes("json") ? "json" : "none";
  const decoder = new TextDecoder();
  let tokens: TokenCounts | null = null;
  let model: string | null = null;
  let final = false;
  // sse: the line being read.
  let pending = "";
  // sse: that line outgrew the buffer, and is skipped to its end.
  let overflowed = false;
  // json: the two ends of the body, and how long the whole of it was.
  let head = "";
  let tail = "";
  let total = 0;

  const takeUsage = (usage: Json, closing: boolean): void => {
    // The ONE place the two shapes part: Anthropic reports in installments across a stream and
    // counts cache reads and writes beside input; every OpenAI-compatible upstream — built-in or
    // custom, Responses or Chat Completions — reports one final object with the cached tokens
    // counted inside input. Both OpenAI dialects read both OpenAI shapes, because the proxy
    // forwards either path for either (`openAiCounts` tells them apart by field name).
    tokens = dialect === "anthropic-messages"
      ? mergeAnthropic(tokens, usage)
      : openAiCounts(usage) ?? tokens;
    // An OpenAI shape reports usage once, at the end; Anthropic's stream in installments, the
    // last of them on `message_delta`.
    if (tokens !== null && (dialect !== "anthropic-messages" || closing)) final = true;
  };

  const observe = (payload: unknown): void => {
    if (!isObject(payload)) return;
    const subject = subjectOf(payload);
    // First one wins: a stream names its model once, on the event that opens it.
    if (model === null && typeof subject.model === "string" && subject.model !== "") {
      model = subject.model;
    }
    if (isObject(subject.usage)) {
      takeUsage(subject.usage, mode === "json" || payload.type === "message_delta");
    }
  };

  /** Keeps a JSON body's two ends, whatever its size. */
  const takeJson = (text: string): void => {
    total += text.length;
    if (head.length < JSON_WINDOW_CHARS) head += text.slice(0, JSON_WINDOW_CHARS - head.length);
    tail = (tail + text).slice(-JSON_WINDOW_CHARS);
  };

  const eventLine = (raw: string): void => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Only data lines, and only those that could hold usage: a content delta is never parsed —
    // which is also why the model is read off the usage-bearing events and nowhere else. A
    // stream that reports no usage is an unmetered row whose model the request had to name.
    if (!line.startsWith("data:") || !line.includes("usage")) return;
    try {
      observe(JSON.parse(line.slice("data:".length)));
    } catch {
      // Not JSON (`[DONE]`, a comment) — nothing to meter.
    }
  };

  return {
    push(chunk) {
      if (mode === "none") return;
      try {
        const text = decoder.decode(chunk, { stream: true });
        if (mode === "json") {
          takeJson(text);
          return;
        }
        let start = 0;
        for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
          if (overflowed) overflowed = false; // the oversize line ends here, unread
          else eventLine(pending + text.slice(start, nl));
          pending = "";
          start = nl + 1;
        }
        if (!overflowed) {
          pending += text.slice(start);
          if (pending.length > MAX_BUFFERED_CHARS) {
            pending = "";
            overflowed = true;
          }
        }
      } catch {
        // Metering never breaks a model call.
      }
    },

    finish() {
      try {
        if (mode === "json") {
          takeJson(decoder.decode());
          if (total > 0 && total <= head.length + tail.length) {
            // The windows still cover the whole body, overlap and all: parse it as one.
            observe(JSON.parse(head + tail.slice(head.length - (total - tail.length))));
          } else if (total > 0) {
            // Too big to hold. Both halves of what a row needs are still within reach.
            const named = MODEL_IN_HEAD.exec(head);
            if (model === null && named !== null) model = named[1];
            const usage = usageAtTheEnd(tail);
            if (usage !== null) takeUsage(usage, true);
          }
        } else if (mode === "sse" && !overflowed) {
          pending += decoder.decode();
          if (pending !== "") eventLine(pending);
        }
      } catch {
        // An unparseable body is an unmetered one.
      }
      pending = "";
      head = "";
      tail = "";
      return { tokens, model, final };
    },
  };
}

/** The object a payload hangs its `model` and `usage` off. */
function subjectOf(payload: Json): Json {
  // Anthropic's stream opens with the message itself, model and usage inside it.
  if (payload.type === "message_start" && isObject(payload.message)) return payload.message;
  // OpenAI Responses streams whole response objects; only the terminal one has usage filled in.
  if (
    typeof payload.type === "string" && payload.type.startsWith("response.") &&
    isObject(payload.response)
  ) {
    return payload.response;
  }
  return payload;
}

/** Anthropic reports cache reads and writes BESIDE input, and a stream reports in installments. */
function mergeAnthropic(previous: TokenCounts | null, usage: Json): TokenCounts | null {
  const next: TokenCounts = previous === null
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 }
    : { ...previous };
  let seen = previous !== null;
  const set = (field: keyof TokenCounts, value: unknown) => {
    const n = count(value);
    if (n === null) return;
    next[field] = n;
    seen = true;
  };
  set("input", usage.input_tokens);
  set("output", usage.output_tokens);
  set("cacheRead", usage.cache_read_input_tokens);
  set("cacheWrite", usage.cache_creation_input_tokens);
  if (isObject(usage.cache_creation)) {
    set("cacheWrite1h", usage.cache_creation.ephemeral_1h_input_tokens);
  }
  if (isObject(usage.output_tokens_details)) {
    set("reasoning", usage.output_tokens_details.thinking_tokens);
  }
  return seen ? next : null;
}

/** OpenAI counts cached and cache-written tokens INSIDE its input figure; they come back out here.
 * Chat Completions names the figures prompt/completion, Responses input/output. */
function openAiCounts(usage: Json): TokenCounts | null {
  const chat = count(usage.prompt_tokens) !== null;
  const inputAll = count(chat ? usage.prompt_tokens : usage.input_tokens);
  const output = count(chat ? usage.completion_tokens : usage.output_tokens);
  if (inputAll === null && output === null) return null;
  const inDetails = usage[chat ? "prompt_tokens_details" : "input_tokens_details"];
  const outDetails = usage[chat ? "completion_tokens_details" : "output_tokens_details"];
  const cacheRead = isObject(inDetails) ? count(inDetails.cached_tokens) ?? 0 : 0;
  const cacheWrite = isObject(inDetails) ? count(inDetails.cache_write_tokens) ?? 0 : 0;
  return {
    input: Math.max(0, (inputAll ?? 0) - cacheRead - cacheWrite),
    output: output ?? 0,
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    reasoning: isObject(outDetails) ? count(outDetails.reasoning_tokens) ?? 0 : 0,
  };
}

/** The `model` a JSON body names, off its head: every dialect writes it before the content or
 * output it belongs to, so the FIRST one in the window is the response's own. */
const MODEL_IN_HEAD = /"model"\s*:\s*"([^"\\]{1,200})"/;

/** The `usage` object at the end of a body too big to hold, found without parsing the body. */
function usageAtTheEnd(tail: string): Json | null {
  const opens = [...tail.matchAll(/"usage"\s*:\s*\{/g)];
  for (let i = opens.length - 1; i >= 0; i--) {
    const open = (opens[i].index ?? -1) + opens[i][0].length - 1;
    if (open < 0) continue;
    const close = matchingBrace(tail, open);
    if (close === -1) continue;
    try {
      const parsed = JSON.parse(tail.slice(open, close + 1));
      if (isObject(parsed)) return parsed;
    } catch {
      // Not the object we were after — try an earlier one.
    }
  }
  return null;
}

/** The index of the `}` closing the `{` at `open`, or -1. String-aware, so a brace inside a
 * string value never counts. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
