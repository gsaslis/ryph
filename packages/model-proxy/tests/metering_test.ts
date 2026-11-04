// Reading usage off a response: every provider dialect, JSON and streamed, fed in awkward chunks —
// and everything that must come back unmetered rather than wrong.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { makeUsageMeter, type MeteredUsage } from "../src/core/metering.ts";
import type { Dialect } from "../src/core/registry.ts";
import type { TokenCounts } from "../src/core/pricing.ts";

const encoder = new TextEncoder();

/** Feeds `body` to a fresh meter in chunks of `size` BYTES, so lines and characters split. */
function meter(
  dialect: Dialect,
  contentType: string | null,
  body: string,
  size = Infinity,
): TokenCounts | null {
  return metered(dialect, contentType, body, size).tokens;
}

/** The whole report: the tokens AND the model the response said it served. */
function metered(
  dialect: Dialect,
  contentType: string | null,
  body: string,
  size = Infinity,
): MeteredUsage {
  const m = makeUsageMeter(dialect, contentType);
  const bytes = encoder.encode(body);
  const step = Number.isFinite(size) ? size : bytes.length || 1;
  for (let i = 0; i < bytes.length; i += step) m.push(bytes.slice(i, i + step));
  return m.finish();
}

const sse = (...events: unknown[]) =>
  events.map((e) => typeof e === "string" ? e : `event: x\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

const counts = (over: Partial<TokenCounts>): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  reasoning: 0,
  ...over,
});

test("anthropic JSON: cache reads and writes sit beside input, 1h writes are split out", () => {
  const body = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: "usage is a word that appears in prose too" }],
    usage: {
      input_tokens: 12,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 800,
      cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 200 },
    },
  });
  assertEquals(
    meter("anthropic-messages", "application/json", body),
    counts({ input: 12, output: 340, cacheRead: 5000, cacheWrite: 800, cacheWrite1h: 200 }),
  );
});

test("anthropic stream: message_start opens the count, message_delta carries it forward", () => {
  const body = sse(
    {
      type: "message_start",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 9000 },
      },
    },
    { type: "content_block_delta", delta: { type: "text_delta", text: "héllo — usage" } },
    { type: "message_delta", usage: { output_tokens: 120 } },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 256, output_tokens_details: { thinking_tokens: 100 } },
    },
    { type: "message_stop" },
  );
  const expected = counts({ input: 40, output: 256, cacheRead: 9000, reasoning: 100 });
  assertEquals(meter("anthropic-messages", "text/event-stream; charset=utf-8", body), expected);
  // Byte-at-a-time splits every line and the multi-byte characters in it.
  assertEquals(meter("anthropic-messages", "text/event-stream", body, 1), expected);
  assertEquals(
    meter("anthropic-messages", "text/event-stream", body.replaceAll("\n", "\r\n"), 7),
    expected,
  );
});

test("an anthropic stream cut after message_start still reports its input side", () => {
  const body = sse({ type: "message_start", message: { usage: { input_tokens: 70 } } });
  assertEquals(meter("anthropic-messages", "text/event-stream", body), counts({ input: 70 }));
});

test("openai responses stream: only the terminal event's usage counts, cache comes out of input", () => {
  const body = sse(
    { type: "response.created", response: { id: "resp_1", usage: null } },
    { type: "response.output_text.delta", delta: "the usage of words" },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 10_000,
          input_tokens_details: { cached_tokens: 8_000 },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 600 },
          total_tokens: 10_900,
        },
      },
    },
  );
  const expected = counts({ input: 2_000, output: 900, cacheRead: 8_000, reasoning: 600 });
  assertEquals(meter("openai-responses", "text/event-stream", body), expected);
  assertEquals(meter("openai-responses", "text/event-stream", body, 13), expected);
  // Byte at a time, and CRLF line ends: still exactly one terminal usage.
  assertEquals(
    meter("openai-responses", "text/event-stream", body.replaceAll("\n", "\r\n"), 1),
    expected,
  );
});

test("openai responses JSON body: cached and reasoning tokens come out the same way", () => {
  const body = JSON.stringify({
    object: "response",
    model: "gpt-5.4",
    output: [{ type: "message", content: [{ type: "output_text", text: "usage" }] }],
    usage: {
      input_tokens: 500,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 520,
    },
  });
  const expected = counts({
    input: 350,
    output: 20,
    cacheRead: 100,
    cacheWrite: 50,
    reasoning: 12,
  });
  assertEquals(meter("openai-responses", "application/json", body), expected);
  assertEquals(metered("openai-responses", "application/json", body).model, "gpt-5.4");
});

test("openai responses stream that ends incomplete or failed is still metered off its usage", () => {
  const usage = {
    input_tokens: 4_000,
    input_tokens_details: { cached_tokens: 1_000 },
    output_tokens: 256,
    output_tokens_details: { reasoning_tokens: 200 },
  };
  const expected = counts({ input: 3_000, output: 256, cacheRead: 1_000, reasoning: 200 });
  // Out of output budget: `response.incomplete`, tokens spent all the same.
  const incomplete = sse(
    { type: "response.created", response: { model: "gpt-5.4", usage: null } },
    { type: "response.reasoning_summary_text.delta", delta: "thinking about usage" },
    {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" }, usage },
    },
  );
  const report = metered("openai-responses", "text/event-stream", incomplete, 7);
  assertEquals(report.tokens, expected);
  // The model off the opening event, which carries `usage: null` and so is read.
  assertEquals(report.model, "gpt-5.4");
  // A mid-stream failure — a ChatGPT plan's usage limit arrives exactly this way.
  const failed = sse(
    { type: "response.created", response: { usage: null } },
    {
      type: "response.failed",
      response: { error: { code: "subscription_sharing_usage_limit_exceeded" }, usage },
    },
  );
  assertEquals(meter("openai-responses", "text/event-stream", failed), expected);
  // A failure that reports no usage is an unmetered row, never a zero one.
  const bare = sse(
    { type: "response.created", response: { usage: null } },
    { type: "response.failed", response: { error: { code: "server_error" }, usage: null } },
  );
  assertEquals(meter("openai-responses", "text/event-stream", bare), null);
});

test("either OpenAI dialect meters either OpenAI shape, since the proxy forwards both paths", () => {
  // A Chat Completions caller on the built-in openai provider (whose dialect is Responses) is
  // forwarded all the same; its usage is read by field name, not by the provider's dialect.
  const chat = JSON.stringify({
    usage: {
      prompt_tokens: 300,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  });
  const expected = counts({ input: 100, output: 40, cacheRead: 200, reasoning: 10 });
  assertEquals(meter("openai-responses", "application/json", chat), expected);
  assertEquals(meter("openai-completions", "application/json", chat), expected);
});

test("openai chat completions: a JSON body, and a stream that asked for usage", () => {
  const usage = {
    prompt_tokens: 300,
    prompt_tokens_details: { cached_tokens: 200 },
    completion_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 10 },
  };
  const expected = counts({ input: 100, output: 40, cacheRead: 200, reasoning: 10 });
  assertEquals(
    meter("openai-completions", "application/json", JSON.stringify({ usage })),
    expected,
  );

  const stream = sse(
    { choices: [{ delta: { content: "hi" } }], usage: null },
    { choices: [], usage },
    "data: [DONE]\n\n",
  );
  assertEquals(meter("openai-completions", "text/event-stream", stream, 5), expected);
});

test("a stream that never asked for usage, an error body, and a non-JSON body: unmetered", () => {
  const noUsage = sse({ choices: [{ delta: { content: "hi" } }], usage: null }, "data: [DONE]\n\n");
  assertEquals(meter("openai-completions", "text/event-stream", noUsage), null);
  assertEquals(
    meter("anthropic-messages", "application/json", JSON.stringify({ type: "error", error: {} })),
    null,
  );
  assertEquals(meter("anthropic-messages", "text/plain", "usage: 12"), null);
  assertEquals(
    meter("anthropic-messages", null, JSON.stringify({ usage: { input_tokens: 1 } })),
    null,
  );
  assertEquals(
    meter("anthropic-messages", "application/json", '{"usage": {"input_tokens": 1'),
    null,
  );
});

test("a final event with no trailing newline is still read", () => {
  const body = `data: ${
    JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } })
  }`;
  assertEquals(meter("anthropic-messages", "text/event-stream", body), counts({ input: 3 }));
});

test("negative, fractional and non-numeric figures are ignored or rounded, never trusted", () => {
  const body = JSON.stringify({
    usage: { input_tokens: -5, output_tokens: 2.6, cache_read_input_tokens: "9" },
  });
  assertEquals(meter("anthropic-messages", "application/json", body), counts({ output: 3 }));
});

test("the model comes off the RESPONSE, in every dialect, or not at all", () => {
  const started = sse({
    type: "message_start",
    message: { model: "claude-sonnet-5-20260101", usage: { input_tokens: 1 } },
  });
  assertEquals(
    metered("anthropic-messages", "text/event-stream", started).model,
    "claude-sonnet-5-20260101",
  );

  const completed = sse({
    type: "response.completed",
    response: { model: "gpt-5.4", usage: { input_tokens: 2, output_tokens: 1 } },
  });
  assertEquals(metered("openai-responses", "text/event-stream", completed).model, "gpt-5.4");

  const chat = JSON.stringify({
    model: "gpt-5-mini",
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  assertEquals(metered("openai-completions", "application/json", chat).model, "gpt-5-mini");

  // A response that names none leaves the row to fall back on what the request asked for.
  const anonymous = JSON.stringify({ usage: { input_tokens: 1 } });
  assertEquals(metered("anthropic-messages", "application/json", anonymous).model, null);
});

test("a JSON body far too big to hold is still metered, from its two ends", () => {
  const body = JSON.stringify({
    id: "msg_1",
    type: "message",
    model: "claude-sonnet-5",
    // Longer than both windows put together, so the middle is never held at all.
    content: [{ type: "text", text: "x".repeat(400_000) }],
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
  });
  assert(body.length > 2 * 64 * 1024, "the body really is past both windows");

  const expected = counts({ input: 11, output: 22, cacheRead: 33 });
  for (const size of [Infinity, 8192, 7]) {
    const report = metered("anthropic-messages", "application/json", body, size);
    assertEquals(report.tokens, expected, `chunks of ${size}`);
    assertEquals(report.model, "claude-sonnet-5", `chunks of ${size}`);
  }
});

test("a JSON body that spans both windows without overflowing them is still parsed whole", () => {
  // Between one window and two: the two ends overlap and the body is reassembled exactly.
  const body = JSON.stringify({
    model: "gpt-5.4",
    output: [{ text: "y".repeat(100_000) }],
    usage: { input_tokens: 5, output_tokens: 6 },
  });
  assert(body.length > 64 * 1024 && body.length < 2 * 64 * 1024, "one window, not two");
  const report = metered("openai-completions", "application/json", body, 4096);
  assertEquals(report.tokens, counts({ input: 5, output: 6 }));
  assertEquals(report.model, "gpt-5.4");
});

test("an oversized body whose prose talks about usage is metered off the real object", () => {
  const body = JSON.stringify({
    model: "claude-sonnet-5",
    content: [{ type: "text", text: `${"z".repeat(300_000)} "usage": {"input_tokens": 999}` }],
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  // The prose copy is escaped inside a JSON string and the real one is last; the tail wins.
  assertEquals(
    metered("anthropic-messages", "application/json", body).tokens,
    counts({ input: 1, output: 2 }),
  );
});

test("the DIALECT decides how usage is read, not the provider's name", () => {
  // One body, both dialects. Anthropic counts cache reads BESIDE input; every
  // OpenAI-compatible upstream counts them inside it — which is why a custom endpoint an admin
  // named "anthropic-ish" is still metered by what it speaks, and why nothing switches on an id.
  const body = JSON.stringify({
    model: "llama-4",
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 40,
      input_tokens_details: { cached_tokens: 40 },
    },
  });
  assertEquals(
    meter("anthropic-messages", "application/json", body),
    counts({ input: 100, output: 10, cacheRead: 40 }),
  );
  assertEquals(
    meter("openai-completions", "application/json", body),
    counts({ input: 60, output: 10, cacheRead: 40 }),
  );
});

test("a report is final only once the response has said all it will", () => {
  const start = { type: "message_start", message: { usage: { input_tokens: 70 } } };
  const delta = { type: "message_delta", usage: { output_tokens: 30 } };
  // Anthropic's stream gives the input first and the output only on its closing delta.
  assertEquals(metered("anthropic-messages", "text/event-stream", sse(start)).final, false);
  assertEquals(metered("anthropic-messages", "text/event-stream", sse(start, delta)).final, true);
  assertEquals(
    metered(
      "anthropic-messages",
      "application/json",
      JSON.stringify({ usage: { input_tokens: 1 } }),
    )
      .final,
    true,
  );
  // An OpenAI stream reports once, at the end, or never.
  const usage = { prompt_tokens: 3, completion_tokens: 4 };
  assertEquals(
    metered("openai-completions", "text/event-stream", sse({ choices: [], usage })).final,
    true,
  );
  assertEquals(
    metered("openai-completions", "text/event-stream", sse({ choices: [], usage: null })).final,
    false,
  );
  const created = { type: "response.created", response: { model: "gpt-5", usage: null } };
  assertEquals(metered("openai-responses", "text/event-stream", sse(created)).final, false);
});
