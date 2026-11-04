// The pure rules of a ChatGPT plan: what a forwarded request may carry, which routes exist, how
// the account's model list is read, which app address counts as a local deployment, and how a
// Responses stream is watched and turned back into one JSON response.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  errorCodeOf,
  instantOf,
  isLocalAppUrl,
  makePlanStreamRestorer,
  MAX_PLAN_BODY_BYTES,
  MAX_PLAN_JSON_DEPTH,
  MAX_PLAN_JSON_TOKENS,
  nearestEffort,
  planBodyTooBig,
  type PlanModel,
  planModelsOf,
  planRoute,
  restorePlanPayload,
  rewritePlanRequest,
} from "../src/core/chatgpt_plan.ts";
import { makeResponsesStreamReader } from "../src/core/responses_stream.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parse = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body));

/** What pi sends to `/v1/responses` through the proxy (pi-ai 1.0.0's buildParams). */
const PI_REQUEST = {
  model: "gpt-6.1-sol",
  input: [
    { role: "developer", content: "You are a coding agent." },
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", encrypted_content: "gAAA…", summary: [] },
  ],
  stream: true,
  store: false,
  prompt_cache_key: "session-1",
  prompt_cache_retention: "24h",
  max_output_tokens: 32000,
  temperature: 0.2,
  tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
  reasoning: { effort: "high", summary: "auto" },
  include: ["reasoning.encrypted_content"],
};

test("pi's request is forwarded without the fields a plan refuses, its tools grouped", () => {
  const rewritten = rewritePlanRequest(bytes(PI_REQUEST));
  assert(rewritten.ok);
  assertEquals(rewritten.stripped, ["max_output_tokens", "prompt_cache_retention", "temperature"]);
  assertEquals(rewritten.clientStreams, true);
  assertEquals(rewritten.groupedTools, ["bash"]);
  const {
    max_output_tokens: _m,
    temperature: _t,
    prompt_cache_retention: _p,
    tools,
    input,
    ...kept
  } = PI_REQUEST;
  assertEquals(parse(rewritten.body), {
    ...kept,
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "namespace", name: "functions", description: "", tools }],
      },
      ...input,
    ],
  });
});

test("a system item becomes a developer item where it stood; nothing else about it changes", () => {
  const rewritten = rewritePlanRequest(bytes({
    model: "m",
    input: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { type: "message", role: "system", content: [{ type: "input_text", text: "later" }] },
    ],
  }));
  assert(rewritten.ok);
  assertEquals(parse(rewritten.body).input, [
    { role: "developer", content: "be terse" },
    { role: "user", content: "hi" },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "later" }] },
  ]);
  assertEquals(rewritten.rewritten, [
    "input[0] role system → developer",
    "input[2] role system → developer",
  ]);
  assertEquals(rewritten.groupedTools, null, "no tools, nothing to shape back");
});

test("function and custom tools are grouped in one namespace; other tools stay as they are", () => {
  const rewritten = rewritePlanRequest(bytes({
    model: "m",
    input: "hi",
    tools: [
      { type: "web_search" },
      { type: "function", name: "read", parameters: { type: "object" }, strict: false },
      { type: "namespace", name: "crm", description: "CRM", tools: [] },
      { type: "custom", name: "patch", format: { type: "grammar" } },
    ],
  }));
  assert(rewritten.ok);
  const body = parse(rewritten.body);
  assertEquals(body.tools, undefined, "no top-level tools are left");
  assertEquals(body.input, [
    {
      type: "additional_tools",
      role: "developer",
      tools: [
        { type: "web_search" },
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: [
            { type: "function", name: "read", parameters: { type: "object" }, strict: false },
            { type: "custom", name: "patch", format: { type: "grammar" } },
          ],
        },
        { type: "namespace", name: "crm", description: "CRM", tools: [] },
      ],
    },
    // A string input is the one user message it stands for.
    { role: "user", content: "hi" },
  ]);
  assertEquals(rewritten.groupedTools, ["read", "patch"]);

  // An `additional_tools` item the caller sent is grouped where it stands.
  const inline = rewritePlanRequest(bytes({
    model: "m",
    input: [
      { role: "user", content: "hi" },
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "x" }] },
    ],
  }));
  assert(inline.ok);
  assertEquals(parse(inline.body).input[1].tools, [
    {
      type: "namespace",
      name: "functions",
      description: "",
      tools: [{ type: "function", name: "x" }],
    },
  ]);
  assertEquals(inline.groupedTools, ["x"]);

  // An empty tool list is no tools at all.
  const none = rewritePlanRequest(bytes({ model: "m", input: "hi", tools: [] }));
  assert(none.ok);
  assertEquals(parse(none.body), {
    model: "m",
    input: [{ role: "user", content: "hi" }],
    store: false,
    stream: true,
  });
});

const SOL: PlanModel = { id: "sol", reasoning: true, reasoningEfforts: ["low", "medium", "high"] };

test("an effort the model does not list becomes the nearest one it does", () => {
  const effort = (asked: string, models: PlanModel[] = [SOL]) => {
    const rewritten = rewritePlanRequest(
      bytes({ model: "sol", input: "hi", reasoning: { effort: asked, summary: "auto" } }),
      models,
    );
    assert(rewritten.ok);
    return parse(rewritten.body).reasoning;
  };
  // pi's "no thinking level": `none`, on a model that cannot switch reasoning off.
  assertEquals(effort("none"), { effort: "low", summary: "auto" });
  assertEquals(effort("minimal"), { effort: "low", summary: "auto" });
  assertEquals(effort("high"), { effort: "high", summary: "auto" });
  assertEquals(effort("xhigh"), { effort: "high", summary: "auto" });
  // A value this does not know is left to the model's default.
  assertEquals(effort("turbo"), { summary: "auto" });
  // A model the key does not list, or one that lists no efforts, keeps what it was sent.
  assertEquals(effort("none", []), { effort: "none", summary: "auto" });
  assertEquals(effort("none", [{ id: "sol", reasoning: true }]), {
    effort: "none",
    summary: "auto",
  });
  assertEquals(effort("none", [{ ...SOL, reasoningEfforts: ["none", "low"] }]), {
    effort: "none",
    summary: "auto",
  });

  assertEquals(nearestEffort("medium", ["low", "high"]), "low");
  assertEquals(nearestEffort("none", ["high", "medium"]), "medium");
  assertEquals(nearestEffort("max", ["low", "xhigh"]), "xhigh");
  assertEquals(nearestEffort("low", ["ultra"]), null);
});

test("a model that reasons is always asked for its encrypted reasoning, store being false", () => {
  const include = (body: Record<string, unknown>, models: PlanModel[] = [SOL]) => {
    const rewritten = rewritePlanRequest(bytes({ model: "sol", input: "hi", ...body }), models);
    assert(rewritten.ok);
    return parse(rewritten.body).include;
  };
  // pi set no effort — it did not take the model for a reasoning one — and the model reasons.
  assertEquals(include({}), ["reasoning.encrypted_content"]);
  assertEquals(include({ include: ["message.output_text.logprobs"] }), [
    "message.output_text.logprobs",
    "reasoning.encrypted_content",
  ]);
  assertEquals(include({ include: ["reasoning.encrypted_content"] }), [
    "reasoning.encrypted_content",
  ]);
  // An effort `none` fitted up to `low` reasons too.
  assertEquals(include({ reasoning: { effort: "none" } }), ["reasoning.encrypted_content"]);
  // A model the list says nothing about, asked for no reasoning: nothing added.
  assertEquals(include({}, []), undefined);
  assertEquals(include({ reasoning: { effort: "none" } }, []), undefined);
  assertEquals(include({ reasoning: { effort: "low" } }, []), ["reasoning.encrypted_content"]);
});

test("every refused field is stripped, and store/stream are forced whatever was sent", () => {
  const refused = Object.fromEntries(
    [
      "background",
      "conversation",
      "max_output_tokens",
      "max_tool_calls",
      "metadata",
      "moderation",
      "multi_agent",
      "prompt",
      "prompt_cache_retention",
      "safety_identifier",
      "temperature",
      "top_logprobs",
      "top_p",
      "truncation",
      "user",
    ].map((field) => [field, 1]),
  );
  const rewritten = rewritePlanRequest(
    bytes({ model: "m", input: "hi", store: true, stream: false, ...refused }),
  );
  assert(rewritten.ok);
  assertEquals(parse(rewritten.body), {
    model: "m",
    input: [{ role: "user", content: "hi" }],
    store: false,
    stream: true,
  });
  assertEquals(rewritten.clientStreams, false, "the caller asked for JSON, and will get it");
  assertEquals(rewritten.stripped.length, 15);
  // No `stream` at all is a non-streaming call, as the API reads it.
  const bare = rewritePlanRequest(bytes({ model: "m", input: "hi" }));
  assert(bare.ok && !bare.clientStreams);
});

test("a bare string input is always sent as a list, with or without tools", () => {
  // "Input must be a list": what the plan's route answered the title writer, which sends
  // `instructions` and a string and no tools.
  const rewritten = rewritePlanRequest(
    bytes({ model: "m", instructions: "Name it.", input: "fix the login" }),
  );
  assert(rewritten.ok);
  assertEquals(parse(rewritten.body).input, [{ role: "user", content: "fix the login" }]);
  assertEquals(parse(rewritten.body).instructions, "Name it.");
});

test("what cannot be rewritten without changing the conversation is refused by name", () => {
  const refused = rewritePlanRequest(bytes({
    model: "m",
    previous_response_id: "resp_1",
    input: [
      { role: "system", content: "be terse" },
      { type: "message", role: "user", content: "hi" },
      { type: "tool_search_output", tools: [] },
      { type: "additional_tools", role: "developer", tools: [{ type: "file_search" }] },
    ],
    tools: [
      { type: "function", name: "ok" },
      { type: "web_search" },
      { type: "image_generation" },
      { type: "code_interpreter" },
      { type: "mcp", server_url: "https://example.com" },
      { type: "file_search" },
      { type: "computer_use_preview" },
      { type: "tool_search" },
    ],
  }));
  assert(!refused.ok);
  assertEquals(refused.refused, [
    "previous_response_id",
    "input[2] (tool_search_output)",
    "input[3].tools[0] (file_search)",
    "tools[2] (image_generation)",
    "tools[3] (code_interpreter)",
    "tools[4] (mcp)",
    "tools[5] (file_search)",
    "tools[6] (computer_use_preview)",
    "tools[7] (tool_search)",
  ]);
  assertMatch(refused.error, /previous_response_id/);
  // A null previous_response_id is no previous response.
  assert(rewritePlanRequest(bytes({ model: "m", input: "hi", previous_response_id: null })).ok);
});

test("a body that is not a JSON object is refused, not forwarded", () => {
  assert(!rewritePlanRequest(new TextEncoder().encode("not json")).ok);
  assert(!rewritePlanRequest(bytes([1, 2])).ok);
});

test("a body is measured before it is parsed: bytes, values and depth", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  assertEquals(planBodyTooBig(bytes(PI_REQUEST)), null);
  // A long string is one value, whatever it holds: brackets, commas, escaped quotes.
  const image = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
  const noisy = 'say \\"[{,:}]\\" and \\\\';
  assertEquals(planBodyTooBig(bytes({ input: [{ image }, noisy] })), null);

  const deep = encode(`{"input":${"[".repeat(MAX_PLAN_JSON_DEPTH + 1)}${"]".repeat(129)}}`);
  assertMatch(planBodyTooBig(deep) ?? "", /nest/);
  const ok = encode(`{"input":${"[".repeat(MAX_PLAN_JSON_DEPTH - 1)}${"]".repeat(127)}}`);
  assertEquals(planBodyTooBig(ok), null);

  const many = encode(`{"input":[${"{},".repeat(MAX_PLAN_JSON_TOKENS / 2)}{}]}`);
  assertMatch(planBodyTooBig(many) ?? "", /values/);
  // An escaped quote does not end a string: the brackets after it are still inside it.
  const escaped = encode(`{"a":"\\"${"[".repeat(200)}"}`);
  assertEquals(planBodyTooBig(escaped), null);

  const huge = new Uint8Array(MAX_PLAN_BODY_BYTES + 1);
  assertMatch(planBodyTooBig(huge) ?? "", /bytes/);
  const refused = rewritePlanRequest(deep);
  assert(!refused.ok && refused.status === 413);
});

test("a plan serves exactly two routes", () => {
  assertEquals(planRoute("POST", "/v1/responses"), "responses");
  assertEquals(planRoute("GET", "/v1/models"), "models");
  assertEquals(planRoute("GET", "/v1/responses"), null);
  assertEquals(planRoute("POST", "/v1/chat/completions"), null);
  assertEquals(planRoute("GET", "/v1/responses/resp_1"), null);
  assertEquals(planRoute("POST", "/v1/files"), null);
  assertEquals(planRoute("POST", "/v1/models"), null);
});

test("the model list keeps listed models in order, and reads the plain shape too", () => {
  assertEquals(
    planModelsOf({
      models: [
        { slug: "b", display_name: "B", visibility: "list", supported_reasoning_levels: [] },
        { slug: "hidden", visibility: "hide" },
        { slug: "a", input_modalities: ["text"] },
        { slug: "b", visibility: "list" },
        { display_name: "no slug" },
      ],
    }),
    [
      { id: "b", label: "B", reasoning: false },
      // Nothing said about reasoning: left to pi's default.
      { id: "a", vision: false },
    ],
  );
  // The efforts, from Codex's `{effort, description}` presets or plain strings.
  assertEquals(
    planModelsOf({
      models: [
        {
          slug: "c",
          supported_reasoning_levels: [
            { effort: "low", description: "fast" },
            { effort: "high", description: "deep" },
          ],
        },
        { slug: "d", supported_reasoning_levels: ["medium", "medium", 3] },
      ],
    }),
    [
      { id: "c", reasoning: true, reasoningEfforts: ["low", "high"] },
      { id: "d", reasoning: true, reasoningEfforts: ["medium"] },
    ],
  );
  assertEquals(planModelsOf({ data: [{ id: "x" }] }), [{ id: "x" }]);
  assertEquals(planModelsOf("nope"), []);
});

test("only a loopback app address is a local deployment", () => {
  for (
    const url of [
      "http://localhost:5173",
      "http://ryph.localhost",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]
  ) {
    assert(isLocalAppUrl(url), url);
  }
  for (
    const url of [
      null,
      "https://ryph.example.com",
      "http://192.168.1.4:3000",
      "http://localhost.evil.com",
      "nope",
    ]
  ) {
    assertEquals(isLocalAppUrl(url), false, String(url));
  }
});

test("an error code is found in an error body, a failed response, or an error event", () => {
  assertEquals(
    errorCodeOf({ error: { code: "subscription_sharing_usage_limit_exceeded" } }),
    "subscription_sharing_usage_limit_exceeded",
  );
  assertEquals(errorCodeOf({ response: { error: { code: "x" } } }), "x");
  assertEquals(errorCodeOf({ type: "error", code: "y" }), "y");
  assertEquals(errorCodeOf({ detail: "direct route unavailable" }), null);
});

test("earliest_refresh_at is read as seconds, milliseconds or a date", () => {
  assertEquals(instantOf(1790000000), "2026-09-21T14:13:20.000Z");
  assertEquals(instantOf(1790000000000), "2026-09-21T14:13:20.000Z");
  assertEquals(instantOf("2026-09-21T14:13:20Z"), "2026-09-21T14:13:20.000Z");
  assertEquals(instantOf(null), null);
});

// ── the stream ──────────────────────────────────────────────────────────────────────────────

const sse = (...events: unknown[]) =>
  new TextEncoder().encode(
    events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
  );

const MESSAGE = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hello" }],
};

test("a stream that completes is assembled, its output filled from the finished items", () => {
  const reader = makeResponsesStreamReader(true);
  const stream = sse(
    { type: "response.created", response: { id: "r", model: "m", usage: null, output: [] } },
    { type: "response.output_text.delta", delta: "Hel" },
    { type: "response.output_item.done", output_index: 0, item: MESSAGE },
    {
      type: "response.completed",
      response: {
        id: "r",
        model: "m",
        status: "completed",
        output: [],
        usage: { input_tokens: 3 },
      },
    },
  );
  // Split mid-line, as a network would.
  reader.push(stream.subarray(0, 37));
  reader.push(stream.subarray(37));
  const result = reader.finish();
  assertEquals(result.ending, "completed");
  assertEquals(result.errorCode, null);
  assertEquals(result.response, {
    id: "r",
    model: "m",
    status: "completed",
    output: [MESSAGE],
    usage: { input_tokens: 3 },
  });
});

test("a mid-stream usage limit is the stream's ending, and its code is kept", () => {
  for (const assemble of [true, false]) {
    const reader = makeResponsesStreamReader(assemble);
    reader.push(sse(
      { type: "response.created", response: { id: "r" } },
      {
        type: "response.failed",
        response: {
          id: "r",
          status: "failed",
          error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" },
        },
      },
    ));
    const result = reader.finish();
    assertEquals(result.ending, "failed");
    assertEquals(result.errorCode, "subscription_sharing_usage_limit_exceeded");
    assertEquals(result.response === null, !assemble, "only an assembler keeps the response");
  }
});

test("a stream that stops before any terminal event has no ending", () => {
  const reader = makeResponsesStreamReader(true);
  reader.push(sse({ type: "response.created", response: { id: "r" } }));
  assertEquals(reader.finish(), { ending: null, errorCode: null, response: null });
});

// ── tool calls shaped back ──────────────────────────────────────────────────────────────────

const GROUPED = new Set(["bash", "patch"]);

/** A function call as the plan answers it: the call names the namespace its tool was in. */
const NAMESPACED_CALL = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "bash",
  namespace: "functions",
  arguments: '{"command":"ls"}',
  status: "completed",
};
/** The same call as pi expects it: a call to a top-level tool. */
const PLAIN_CALL = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "bash",
  arguments: '{"command":"ls"}',
  status: "completed",
};

test("a call to a grouped tool comes back as a call to the top-level tool", () => {
  const response: { id: string; output: unknown[] } = {
    id: "r",
    output: [
      structuredClone(NAMESPACED_CALL),
      {
        type: "custom_tool_call",
        call_id: "c2",
        name: "patch",
        namespace: "functions",
        input: "x",
      },
      // A namespace the caller made itself, a tool this did not group, and a prefixed name.
      { type: "function_call", call_id: "c3", name: "lookup", namespace: "crm", arguments: "{}" },
      {
        type: "function_call",
        call_id: "c4",
        name: "other",
        namespace: "functions",
        arguments: "",
      },
      { type: "function_call", call_id: "c5", name: "functions.bash", arguments: "{}" },
      { type: "message", role: "assistant", content: [] },
    ],
  };
  assert(restorePlanPayload(response, GROUPED));
  assertEquals(response.output, [
    PLAIN_CALL,
    { type: "custom_tool_call", call_id: "c2", name: "patch", input: "x" },
    { type: "function_call", call_id: "c3", name: "lookup", namespace: "crm", arguments: "{}" },
    { type: "function_call", call_id: "c4", name: "other", namespace: "functions", arguments: "" },
    { type: "function_call", call_id: "c5", name: "bash", arguments: "{}" },
    { type: "message", role: "assistant", content: [] },
  ]);
  assert(!restorePlanPayload({ id: "r", output: [PLAIN_CALL] }, GROUPED), "nothing to change");
});

test("a stream's tool calls are shaped back in every event that carries one, the rest byte for byte", () => {
  const upstream = sse(
    { type: "response.created", response: { id: "r", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...NAMESPACED_CALL, arguments: "", status: "in_progress" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":' },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      name: "functions.bash",
      arguments: '{"command":"ls"}',
    },
    { type: "response.output_item.done", output_index: 0, item: NAMESPACED_CALL },
    { type: "response.output_text.delta", delta: 'the word "functions" in prose' },
    { type: "response.completed", response: { id: "r", output: [NAMESPACED_CALL] } },
  );
  const expected = sse(
    { type: "response.created", response: { id: "r", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...PLAIN_CALL, arguments: "", status: "in_progress" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":' },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      name: "bash",
      arguments: '{"command":"ls"}',
    },
    { type: "response.output_item.done", output_index: 0, item: PLAIN_CALL },
    { type: "response.output_text.delta", delta: 'the word "functions" in prose' },
    { type: "response.completed", response: { id: "r", output: [PLAIN_CALL] } },
  );
  // Fed in every split a network could make, down to one byte at a time.
  for (const size of [1, 7, 64, upstream.byteLength]) {
    const restorer = makePlanStreamRestorer(GROUPED);
    const parts: Uint8Array[] = [];
    for (let at = 0; at < upstream.byteLength; at += size) {
      parts.push(restorer.push(upstream.subarray(at, at + size)));
    }
    parts.push(restorer.finish());
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    assertEquals(new TextDecoder().decode(out), new TextDecoder().decode(expected), `size ${size}`);
  }
});

test("a stream with no grouped call in it passes through unchanged, CRLF and a tail included", () => {
  const text =
    'event: x\r\ndata: {"type":"response.output_text.delta","delta":"hi"}\r\n\r\ndata: [DONE]';
  const restorer = makePlanStreamRestorer(GROUPED);
  const out = new TextDecoder().decode(restorer.push(new TextEncoder().encode(text))) +
    new TextDecoder().decode(restorer.finish());
  assertEquals(out, text);
});

test("a JWT's exp is read without verifying it; anything else has none", async () => {
  const { accessExpiryOf, jwtExpiryMs } = await import("../src/core/chatgpt_plan.ts");
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${b64({ alg: "RS256" })}.${b64({ exp: 1_800_000_000, sub: "ü" })}.sig`;
  assertEquals(jwtExpiryMs(jwt), 1_800_000_000_000);
  assertEquals(jwtExpiryMs("at-1"), null);
  assertEquals(jwtExpiryMs("a.b.c"), null);
  assertEquals(jwtExpiryMs(`${b64({})}.${b64({ exp: "soon" })}.x`), null);
  const at = 1_799_990_000_000;
  // The token's exp (10 000 s out) beats an expires_in of a day.
  assertEquals(
    accessExpiryOf({ accessToken: jwt, expiresIn: 86_400, expiresAt: null }, at),
    new Date(1_800_000_000_000).toISOString(),
  );
  // Nothing said: the default hour.
  assertEquals(
    accessExpiryOf({ accessToken: "at-1", expiresIn: null, expiresAt: null }, at),
    new Date(at + 3_600_000).toISOString(),
  );
});
