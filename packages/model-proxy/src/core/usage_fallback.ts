// What keeps a model call from going unpriced when its response does not say what it cost.
//
// Usage is read off the response's own bytes (core/metering.ts), and a run controls a good part
// of whether those bytes carry it: a streamed Chat Completions call reports usage only when it
// asks for it, and a caller that hangs up before the stream's last event never lets the proxy
// read it. A row with no tokens prices at $0, so either was a way past the run's spend cap and
// the deployment's ceiling. Three answers, in order:
// 1. a streamed Chat Completions call is made to ask (`askForStreamUsage`): one more chunk at the
//    end, `choices: []`, which every client that reads the stream already skips
// 2. a caller that hangs up does not end the upstream call: the proxy reads it on to its end in
//    the background, bounded by `DRAIN_MS` and `MAX_DRAIN_BYTES`, so the usage still arrives
// 3. a spending call whose usage still never came (a cut past those bounds, an endpoint that
//    never reports) is charged an ESTIMATE (`estimatedTokens`), never nothing, and its row says
//    so (`estimated`)
//
// The estimate errs high on purpose: it is what a cap counts, and a cap that undercounts is one
// a run can walk past.
// - input: the request body's bytes over 4 (the usual rule of thumb for English text and JSON),
//   except long base64 runs — images and documents — which count `ceil(bytes / 750)` tokens each
//   and at least `MEDIA_MIN_TOKENS` (an image a provider resizes is ~1,600 tokens at most;
//   750 bytes a token is above what any image costs, and a document's pages land near it)
// - output: the most the request allowed (`max_tokens`, `max_output_tokens`,
//   `max_completion_tokens`), else the endpoint's declared maximum for the model, else
//   `FALLBACK_OUTPUT_TOKENS`
// - what the response DID report stands: an Anthropic stream cut after `message_start` keeps its
//   exact input and cache counts, and only its output is raised to the estimate

import type { ValueSpan } from "./model_field.ts";
import type { TokenCounts } from "./pricing.ts";

/** How long a call is read on after its caller hung up, for its usage. */
export const DRAIN_MS = 60_000;

/** How much of a call is read on after its caller hung up. A completion's whole stream is well
 * under this; past it the rest is not worth holding a connection for, and the row is estimated. */
export const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

/** The output charged when neither the request nor the endpoint says how much it may be. */
export const FALLBACK_OUTPUT_TOKENS = 32_000;

/** The least a base64 run (an image, a document) is counted as. */
export const MEDIA_MIN_TOKENS = 1_600;

/** A run of base64 this long is media, not text. */
const MEDIA_RUN_BYTES = 1024;

/** The request fields that cap a call's output, by dialect: Anthropic, Responses, Chat
 * Completions (both spellings). */
export const MAX_OUTPUT_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"];

const OPEN_OBJECT = 0x7b;
const enc = new TextEncoder();
const dec = new TextDecoder();

function spliced(
  bytes: Uint8Array,
  start: number,
  end: number,
  insert: string,
): Uint8Array<ArrayBuffer> {
  const middle = enc.encode(insert);
  const out = new Uint8Array(bytes.length - (end - start) + middle.length);
  out.set(bytes.subarray(0, start), 0);
  out.set(middle, start);
  out.set(bytes.subarray(end), start + middle.length);
  return out;
}

/**
 * A streamed Chat Completions body made to ask for its usage (`stream_options.include_usage:
 * true`), or null when it needs no change: it does not stream, it already asks, or its
 * `stream_options` is not an object the proxy can add to (the provider refuses that anyway). The
 * body is spliced, never parsed whole; only `stream_options` itself, which is small, is.
 * `members` is the walk's spans for `stream` and `stream_options`.
 */
export function askForStreamUsage(
  bytes: Uint8Array,
  members: Map<string, ValueSpan>,
): Uint8Array<ArrayBuffer> | null {
  const stream = members.get("stream");
  if (stream === undefined || dec.decode(bytes.subarray(stream.start, stream.end)) !== "true") {
    return null;
  }
  const options = members.get("stream_options");
  if (options === undefined) {
    const open = bytes.indexOf(OPEN_OBJECT);
    return spliced(bytes, open + 1, open + 1, '"stream_options":{"include_usage":true},');
  }
  const raw = dec.decode(bytes.subarray(options.start, options.end));
  if (raw === "null") {
    return spliced(bytes, options.start, options.end, '{"include_usage":true}');
  }
  if (options.end - options.start > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if ((parsed as Record<string, unknown>).include_usage === true) return null;
  return spliced(
    bytes,
    options.start,
    options.end,
    JSON.stringify({ ...parsed, include_usage: true }),
  );
}

/** The input a request body is estimated at (see the opening of this file). */
export function estimatedInputTokens(bytes: Uint8Array): number {
  let media = 0;
  let mediaTokens = 0;
  let run = 0;
  const endRun = () => {
    if (run >= MEDIA_RUN_BYTES) {
      media += run;
      mediaTokens += Math.max(MEDIA_MIN_TOKENS, Math.ceil(run / 750));
    }
    run = 0;
  };
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const base64 = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || c === 0x3d;
    if (base64) run += 1;
    else endRun();
  }
  endRun();
  return Math.ceil((bytes.length - media) / 4) + mediaTokens;
}

/** The most output the request allowed, off the walk's spans for `MAX_OUTPUT_FIELDS`. */
export function requestedMaxOutput(
  bytes: Uint8Array,
  members: Map<string, ValueSpan> | null,
): number | null {
  let most: number | null = null;
  for (const field of MAX_OUTPUT_FIELDS) {
    const span = members?.get(field);
    if (span === undefined) continue;
    const n = Number(dec.decode(bytes.subarray(span.start, span.end)));
    if (Number.isFinite(n) && n > 0) most = Math.max(most ?? 0, Math.ceil(n));
  }
  return most;
}

/**
 * The tokens a call is charged when its response did not report all of them: what it did
 * report, with what it did not filled in by the estimate, and its output at least the estimate.
 */
export function estimatedTokens(
  reported: TokenCounts | null,
  estimate: { input: number; output: number },
): TokenCounts {
  if (reported === null) {
    return {
      input: estimate.input,
      output: estimate.output,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
    };
  }
  const anyInput = reported.input + reported.cacheRead + reported.cacheWrite > 0;
  return {
    ...reported,
    input: anyInput ? reported.input : estimate.input,
    output: Math.max(reported.output, estimate.output),
  };
}
