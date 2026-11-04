// The data plane with a ChatGPT plan key behind the run: what a run's credential looks like, the
// request rewritten on its way, the refusals, the refresh after a 401, the usage limit marking
// the key (before the stream, and in the middle of it), the stream assembled for a caller that
// asked for JSON, and the plan's usage metered as included — outside every spend cap.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { makeProxyHandler } from "../src/http/proxy.ts";
import {
  CredentialRefusedError,
  makeCredentialIssuer,
  makePlatformCredentialIssuer,
} from "../src/core/service.ts";
import { makePlanKeys } from "../src/core/plan_keys.ts";
import { parseTokenSet } from "../src/core/chatgpt_plan.ts";
import { toPublicProviderKey } from "../src/core/types.ts";
import { makeDeploymentGauge, makeSpendMeter } from "../src/core/spend_meter.ts";
import { priceRecord } from "../src/core/spend.ts";
import type { UsageRecord } from "../src/core/types.ts";
import { makeFakeOpenAi, signInPlanKey } from "./fake_openai.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { usageRow } from "./usage_fixtures.ts";
import { publicDns } from "./dns.ts";

const T0 = Date.parse("2026-10-07T10:00:00.000Z");

const sse = (...events: unknown[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

const COMPLETED = sse(
  { type: "response.created", response: { id: "r", model: "gpt-6.1-sol", usage: null } },
  { type: "response.output_text.delta", delta: "Hi" },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
  },
  {
    type: "response.completed",
    response: {
      id: "r",
      model: "gpt-6.1-sol",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
      },
    },
  },
);

const LIMIT_FAILED = sse(
  { type: "response.created", response: { id: "r", model: "gpt-6.1-sol", usage: null } },
  {
    type: "response.failed",
    response: {
      id: "r",
      model: "gpt-6.1-sol",
      status: "failed",
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit reached" },
      usage: null,
    },
  },
);

const streamed = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/event-stream" } });

async function makePlanSlice(opts: {
  upstream?: (req: Request, n: number) => Response;
  allowedModels?: string[] | "*";
  maxRequestBodyBytes?: number;
  spendUsd?: number;
  ceiling?: number;
  trail?: UsageRecord[];
  /** Merged into every token response the fake OpenAI sends. */
  grantExtra?: Record<string, unknown>;
} = {}) {
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const fake = await makeFakeOpenAi({ now });
  fake.grantExtra = opts.grantExtra ?? {};
  const store = memoryKeyStore();
  const events: string[] = [];
  const diag = {
    debug: (event: string) => void events.push(event),
    warn: (event: string) => void events.push(event),
  };
  const plan = makePlanKeys({
    store,
    accounts: fake.accounts,
    seal: (plaintext) => Promise.resolve(`v2.sealed:${plaintext}`),
    unseal: (sealed) => Promise.resolve(sealed.replace(/^v2\.sealed:/, "")),
    sealVerifier: (plaintext) => Promise.resolve(`v2.sealed:${plaintext}`),
    unsealVerifier: (sealed) => Promise.resolve(sealed.replace(/^v2\.sealed:/, "")),
    now,
    diag,
  });
  const keyId = await signInPlanKey(plan, fake);
  for (const row of opts.trail ?? []) await store.recordUsage(row);
  const issuer = makeCredentialIssuer({
    store,
    now,
    proxyUrl: "http://proxy.test",
    ttlMs: 86_400_000,
    planOn: true,
  });
  const env = await issuer.issue({
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: keyId,
    provider: "chatgpt-plan",
    allowedModels: opts.allowedModels ?? "*",
    spendUsd: opts.spendUsd ?? null,
  });
  const sent: Array<{
    url: string;
    auth: string | null;
    headers: Headers;
    body: Record<string, unknown> | null;
  }> = [];
  const upstream = opts.upstream ?? (() => streamed(COMPLETED));
  const gauge = opts.ceiling === undefined
    ? null
    : makeDeploymentGauge({ ceilingUsd: opts.ceiling, windowDays: 30 });
  const handler = makeProxyHandler({
    resolveHost: publicDns,
    store,
    decrypt: () => Promise.reject(new Error("a plan key's secret is never sent as a key")),
    now,
    diag,
    limits: { meter: makeSpendMeter({ backstopMs: 0 }), gauge },
    plan,
    maxRequestBodyBytes: opts.maxRequestBodyBytes,
    upstreamFetch: (async (input: URL | Request | string, init?: RequestInit) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
      const text = await req.text();
      sent.push({
        url: req.url,
        auth: req.headers.get("authorization"),
        headers: req.headers,
        body: text === "" ? null : JSON.parse(text),
      });
      return upstream(req, sent.length);
    }) as typeof fetch,
  });
  const call = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    extra: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      raw?: string;
      token?: string;
    } = {},
  ) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${extra.token ?? env.RYPH_MODEL_API_KEY}`,
          "content-type": "application/json",
          ...extra.headers,
        },
        ...(extra.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra.raw !== undefined
          ? { body: extra.raw }
          : body === undefined
          ? {}
          : { body: JSON.stringify(body) }),
      }),
    );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { handler, store, env, fake, sent, call, keyId, clock, settle, events, now };
}

const PI_BODY = {
  model: "gpt-6.1-sol",
  input: [{ role: "developer", content: "be useful" }, { role: "user", content: "hi" }],
  stream: true,
  store: false,
  max_output_tokens: 32000,
  temperature: 0.5,
  prompt_cache_retention: "24h",
};

test("a run on a plan key gets ryph's own variables and the key's models, never a token", async () => {
  const { env } = await makePlanSlice();
  assertEquals(Object.keys(env).sort(), [
    "RYPH_MODEL_API_KEY",
    "RYPH_MODEL_BASE_URL",
    "RYPH_MODEL_PROVIDER_CONFIG",
  ]);
  assertEquals(env.RYPH_MODEL_BASE_URL, "http://proxy.test/v1");
  assert(env.RYPH_MODEL_API_KEY.startsWith("ryph-vk-"));
  const config = JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG);
  assertEquals(config.id, "chatgpt-plan");
  assertEquals(config.dialect, "openai-responses");
  assertEquals(config.models.map((m: { id: string }) => m.id), ["gpt-6.1-sol", "gpt-6.1-mini"]);
  // What the list says of reasoning reaches pi; the efforts stay with the proxy.
  assertEquals(config.models[0].reasoning, true);
  assertEquals(config.models[0].reasoningEfforts, undefined);
  assertEquals(config.models[1].reasoning, undefined);
  // ...as the thinking levels they are, so pi clamps a level to them before the proxy fits it;
  // a model the list said nothing about is said to have none.
  assertEquals(config.models[0].thinkingLevels, ["low", "high"]);
  assertEquals(config.models[1].thinkingLevels, undefined);
  assert(!JSON.stringify(env).includes("at-"), "no access token in the run's env");
});

test("a streamed call is forwarded rewritten, with the access token, and streamed back", async () => {
  const { call, sent, store, fake } = await makePlanSlice();
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), COMPLETED, "the stream passes through untouched");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, "https://api.openai.com/v1/responses");
  assertEquals(sent[0].auth, `Bearer ${fake.accessTokens[0]}`);
  assertEquals(sent[0].body, {
    model: "gpt-6.1-sol",
    input: PI_BODY.input,
    stream: true,
    store: false,
    // The key's list says the model reasons, and nothing is stored to fetch its reasoning from.
    include: ["reasoning.encrypted_content"],
  });

  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.provider, "chatgpt-plan");
  assertEquals(row.model, "gpt-6.1-sol");
  assertEquals([row.inputTokens, row.cacheReadTokens, row.outputTokens], [600, 400, 50]);
  assertEquals(priceRecord(row, {}), 0, "included: metered, and $0");
});

test("non-streaming plan assembly accepts its byte boundary and cancels overflow", async () => {
  const max = 4096;
  const encoded = new TextEncoder().encode(COMPLETED);
  assert(encoded.byteLength < max);
  for (const extra of [0, 1]) {
    let cancelled = false;
    const { call } = await makePlanSlice({
      maxRequestBodyBytes: max,
      upstream: () => {
        // A legal SSE comment pads the terminal response to the exact byte budget.
        const padding = new TextEncoder().encode(
          `:${" ".repeat(max - encoded.byteLength - 3 + extra)}\n\n`,
        );
        let step = 0;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (step++ === 0) c.enqueue(encoded);
              else if (step === 2) c.enqueue(padding);
              else if (extra === 0) c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const res = await call("/v1/responses", { model: "gpt-6.1-sol", input: "hi", stream: false });
    assertEquals(res.status, extra === 0 ? 200 : 502);
    const body = await res.json();
    if (extra === 1) {
      assert(body.error.message.includes("size limit"));
      assert(cancelled, "overflow cancels upstream rather than reading the remaining stream");
    }
  }
});

test("a caller that did not ask for a stream gets the stream assembled into one JSON answer", async () => {
  const { call, sent, store } = await makePlanSlice();
  // The memory service's call: no stream, a max_output_tokens the plan refuses.
  const res = await call("/v1/responses", {
    model: "gpt-6.1-sol",
    instructions: "summarise",
    input: "text",
    max_output_tokens: 1024,
    store: false,
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/json");
  const body = await res.json();
  assertEquals(body.status, "completed");
  assertEquals(body.output[0].content[0].text, "Hi");
  assertEquals(body.usage.output_tokens, 50);
  assertEquals(sent[0].body?.stream, true);
  assertEquals(sent[0].body?.max_output_tokens, undefined);
  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.status, 200);
  assertEquals(row.outputTokens, 50, "metered off the stream it was assembled from");
});

test("an assembled call that fails on the usage limit answers 429 and marks the key", async () => {
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () => streamed(LIMIT_FAILED),
  });
  const res = await call("/v1/responses", { model: "gpt-6.1-sol", input: "x" });
  assertEquals(res.status, 429);
  assertEquals((await res.json()).error.code, "subscription_sharing_usage_limit_exceeded");
  await settle();
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "limited");
});

test("what a plan cannot take is refused by name, and nothing is sent", async () => {
  const { call, sent } = await makePlanSlice();
  const hosted = await call("/v1/responses", {
    ...PI_BODY,
    tools: [{ type: "code_interpreter" }],
  });
  assertEquals(hosted.status, 400);
  const body = await hosted.json();
  assertEquals(body.code, "plan_unsupported");
  assertEquals(body.refused, ["tools[0] (code_interpreter)"]);

  // Past the plan's own list, the rule every OpenAI body is held to.
  const byUrl = await call("/v1/responses", {
    ...PI_BODY,
    input: [{
      role: "user",
      content: [{ type: "input_image", image_url: "https://attacker.example/x.png" }],
    }],
  });
  assertEquals(byUrl.status, 400);
  assertEquals((await byUrl.json()).code, "body_not_allowed");

  const chat = await call("/v1/chat/completions", { model: "gpt-6.1-sol", messages: [] });
  assertEquals(chat.status, 404);
  assertEquals((await chat.json()).code, "plan_route_not_supported");
  const file = await call("/v1/files", undefined, "GET");
  assertEquals(file.status, 404);
  assertEquals(sent.length, 0);
});

test("the models list is forwarded as it is", async () => {
  const { call, sent } = await makePlanSlice({
    upstream: () => Response.json({ models: [{ slug: "gpt-6.1-sol" }] }),
  });
  const res = await call("/v1/models");
  assertEquals(res.status, 200);
  assertEquals(sent[0].url, "https://api.openai.com/v1/models");
  assertEquals(sent[0].body, null);
});

test("a 401 refreshes the token once and sends the request again", async () => {
  const { call, sent, fake, clock } = await makePlanSlice({
    upstream: (_req, n) =>
      n === 1 ? Response.json({ detail: "expired" }, { status: 401 }) : streamed(COMPLETED),
  });
  clock.ms += 6 * 60 * 1000; // a token minted moments ago is not refreshed on a 401
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(sent.length, 2);
  assertEquals(sent[0].auth, `Bearer ${fake.accessTokens[0]}`);
  assertEquals(sent[1].auth, `Bearer ${fake.accessTokens[1]}`);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a refresh OpenAI refuses marks the key needs_reauth, and the run is told so", async () => {
  const { call, sent, fake, store, keyId, clock } = await makePlanSlice();
  clock.ms += 3600 * 1000;
  fake.failRefresh = "refresh_token_expired";
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "needs_reauth");
  assertMatch(body.error, /sign/);
  assertEquals(sent.length, 0);
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "needs_reauth");
  // And from then on, without asking OpenAI again.
  assertEquals((await call("/v1/responses", PI_BODY)).status, 403);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("a 429 on the usage limit marks the key limited, and the next success clears it", async () => {
  let limited = true;
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () =>
      limited
        ? Response.json({
          error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" },
        }, { status: 429 })
        : streamed(COMPLETED),
  });
  const refused = await call("/v1/responses", PI_BODY);
  assertEquals(refused.status, 429);
  assertEquals((await refused.json()).error.code, "subscription_sharing_usage_limit_exceeded");
  await settle();
  const key = (await store.getProviderKey(keyId))!;
  assertEquals(key.planStatus, "limited");
  assert(key.planLimitedAt !== null);

  limited = false;
  const ok = await call("/v1/responses", PI_BODY);
  await ok.text();
  await settle();
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "active");
});

test("a usage limit whose answer breaks off after its first chunk still marks the key", async () => {
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          // The reset comes on the read AFTER the first chunk: an error() in start() would drop
          // the chunk still queued.
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" },
            })));
          },
          pull(controller) {
            controller.error(new Error("reset"));
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
  });
  const refused = await call("/v1/responses", PI_BODY);
  assertEquals(refused.status, 429);
  assertEquals((await refused.json()).error.code, "subscription_sharing_usage_limit_exceeded");
  await settle();
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "limited");
});

test("a usage limit in the middle of a stream marks the key limited too", async () => {
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () => streamed(LIMIT_FAILED),
  });
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200, "the stream had already opened");
  assertEquals(await res.text(), LIMIT_FAILED);
  await settle();
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "limited");
});

test("no spend cap refuses a plan's call: there is nothing for it to count", async () => {
  // The run is far past a one-cent cap on earlier Anthropic spend, and the deployment past its
  // ceiling: a priced call would be refused here; the plan's included one is not.
  const trail = [usageRow({ inputTokens: 1_000_000, outputTokens: 1_000_000 })];
  const { call } = await makePlanSlice({ spendUsd: 0.01, ceiling: 0.01, trail });
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

test("the access token written back after a refresh is the one the next call uses", async () => {
  const { call, sent, store, keyId, clock, fake } = await makePlanSlice();
  clock.ms += 59 * 60 * 1000;
  await (await call("/v1/responses", PI_BODY)).text();
  const tokens = parseTokenSet(
    (await store.getProviderKey(keyId))!.encryptedSecret.replace(/^v2\.sealed:/, ""),
  );
  assertEquals(sent[0].auth, `Bearer ${tokens.accessToken}`);
  assertEquals(tokens.refreshToken, fake.refreshToken());
});

test("a plan key with no model list declares the run's allowlist, or refuses to issue", async () => {
  const { store, keyId } = await makePlanSlice();
  const key = (await store.getProviderKey(keyId))!;
  await store.updateProviderKey(keyId, {
    plan: { ...key.plan!, models: [] },
    updatedAt: key.updatedAt,
  });
  const issuer = makeCredentialIssuer({
    store,
    now: () => new Date(T0),
    proxyUrl: "http://p",
    planOn: true,
  });
  const scope = {
    runId: "r-2",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: keyId,
    provider: "chatgpt-plan",
  };
  const env = await issuer.issue({ ...scope, allowedModels: ["gpt-6.1-sol"] });
  // Nothing is known of the model but its name, so nothing more is said of it.
  assertEquals(JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG).models, [{ id: "gpt-6.1-sol" }]);
  await assertRejects(
    () => issuer.issue({ ...scope, allowedModels: "*" }),
    CredentialRefusedError,
    "no model list",
  );
  await store.updateProviderKey(keyId, { planStatus: "needs_reauth", updatedAt: key.updatedAt });
  await assertRejects(
    () => issuer.issue({ ...scope, allowedModels: ["gpt-6.1-sol"] }),
    CredentialRefusedError,
    "signing in again",
  );
});

// ── what pi sends, reshaped, and its tool calls shaped back ─────────────────────────────────

/** pi-ai 1.0.0's request for a model it does not take for a reasoning one: the system prompt as
 * a `system` item, the tools top-level. */
const PI_TOOL_BODY = {
  model: "gpt-6.1-sol",
  input: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: [{ type: "input_text", text: "list the files" }] },
  ],
  stream: true,
  store: false,
  tools: [{
    type: "function",
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    strict: false,
  }],
  reasoning: { effort: "none" },
};

/** The plan's answer: a call to `bash`, naming the namespace it was grouped under. */
const CALL_ITEM = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "bash",
  namespace: "functions",
  arguments: '{"command":"ls"}',
  status: "completed",
};
const { namespace: _ns, ...PLAIN_CALL_ITEM } = CALL_ITEM;

const TOOL_CALL_STREAM = sse(
  { type: "response.created", response: { id: "r", model: "gpt-6.1-sol", usage: null } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...CALL_ITEM, arguments: "", status: "in_progress" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"command":"ls"}' },
  { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"command":"ls"}' },
  { type: "response.output_item.done", output_index: 0, item: CALL_ITEM },
  {
    type: "response.completed",
    response: {
      id: "r",
      model: "gpt-6.1-sol",
      status: "completed",
      output: [CALL_ITEM],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  },
);

test("pi's system item, top-level tools and `none` effort go up in the shapes the plan takes", async () => {
  const { call, sent } = await makePlanSlice({ upstream: () => streamed(TOOL_CALL_STREAM) });
  const res = await call("/v1/responses", PI_TOOL_BODY);
  assertEquals(res.status, 200);
  await res.text();
  assertEquals(sent[0].body, {
    model: "gpt-6.1-sol",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "functions",
          description: "",
          tools: PI_TOOL_BODY.tools,
        }],
      },
      { role: "developer", content: "You are a coding agent." },
      PI_TOOL_BODY.input[1],
    ],
    stream: true,
    store: false,
    // gpt-6.1-sol lists low and high: `none` is its lightest, and it reasons.
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"],
  });
});

/** A stream that arrives a few bytes at a time, lines split anywhere. */
const trickled = (body: string, size = 7) => {
  const bytes = new TextEncoder().encode(body);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.byteLength) return controller.close();
        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

test("a streamed tool call comes back as pi declared the tool, and is metered as it came", async () => {
  const { call, store } = await makePlanSlice({ upstream: () => trickled(TOOL_CALL_STREAM) });
  const res = await call("/v1/responses", PI_TOOL_BODY);
  const text = await res.text();
  assert(!text.includes('"namespace"'), "no namespace reaches pi");
  const expected = TOOL_CALL_STREAM
    .replaceAll(',"namespace":"functions"', "");
  assertEquals(text, expected, "everything else byte for byte");
  const [row] = await store.listUsageForRun("r-1");
  assertEquals([row.inputTokens, row.outputTokens, row.status], [100, 10, 200]);
});

test("an assembled tool call comes back as the caller declared the tool", async () => {
  const { call } = await makePlanSlice({ upstream: () => streamed(TOOL_CALL_STREAM) });
  const res = await call("/v1/responses", { ...PI_TOOL_BODY, stream: false });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.output, [PLAIN_CALL_ITEM]);
});

test("a call with no tools passes its stream through untouched, a namespace and all", async () => {
  const { call } = await makePlanSlice({ upstream: () => streamed(TOOL_CALL_STREAM) });
  const { tools: _t, ...noTools } = PI_TOOL_BODY;
  const res = await call("/v1/responses", noTools);
  assertEquals(await res.text(), TOOL_CALL_STREAM);
});

test("a 401 on a token minted moments ago is relayed, not answered with a refresh", async () => {
  const { call, sent, fake } = await makePlanSlice({
    upstream: () => Response.json({ detail: "nope" }, { status: 401 }),
  });
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 401);
  await res.body?.cancel();
  assertEquals(sent.length, 1);
  assert(!fake.calls.includes("token:refresh_token"));
});

test("only the headers a Responses client needs go up, and no query string", async () => {
  const { call, sent } = await makePlanSlice();
  const res = await call("/v1/responses?api-version=x&user=someone", PI_BODY, "POST", {
    headers: {
      "openai-organization": "org-elsewhere",
      "openai-project": "proj-elsewhere",
      "x-made-up": "1",
      "session_id": "s-1",
      "x-client-request-id": "s-1",
      "user-agent": "pi/1.0",
      "accept": "text/event-stream",
    },
  });
  await res.text();
  assertEquals(sent[0].url, "https://api.openai.com/v1/responses");
  const names = [...sent[0].headers.keys()].sort();
  assertEquals(names, [
    "accept",
    "authorization",
    "content-type",
    "session_id",
    "user-agent",
    "x-client-request-id",
  ]);
});

test("a plan body too big to take apart is refused with a 413 before anything is sent", async () => {
  const { call, sent } = await makePlanSlice();
  const deep = await call("/v1/responses", undefined, "POST", {
    raw: `{"model":"gpt-6.1-sol","input":${"[".repeat(200)}${"]".repeat(200)}}`,
  });
  assertEquals(deep.status, 413);
  assertMatch((await deep.json()).error, /nest/);
  // Past the plan's byte cap, though under the proxy's own: refused while it is read.
  const big = await call("/v1/responses", undefined, "POST", {
    raw: `{"model":"gpt-6.1-sol","input":"${"a".repeat(25 * 1024 * 1024)}"}`,
  });
  assertEquals(big.status, 413);
  await big.body?.cancel();
  assertEquals(sent.length, 0);
});

test("an error answer too long to read is relayed as a short error with its status", async () => {
  const { call } = await makePlanSlice({
    upstream: () => new Response("x".repeat(2 * 1024 * 1024), { status: 500 }),
  });
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 500);
  assertMatch((await res.json()).error.message, /too long/);
});

const INCOMPLETE = sse(
  { type: "response.created", response: { id: "r", model: "gpt-6.1-sol", usage: null } },
  {
    type: "response.incomplete",
    response: {
      id: "r",
      model: "gpt-6.1-sol",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
);

test("an incomplete response does not clear the usage limit; only a completed one does", async () => {
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () => streamed(INCOMPLETE),
  });
  await store.markPlanLimited(keyId, new Date(T0).toISOString());
  await (await call("/v1/responses", PI_BODY)).text();
  const assembled = await call("/v1/responses", { model: "gpt-6.1-sol", input: "x" });
  assertEquals(assembled.status, 200, "as the API answers it unstreamed");
  assertEquals((await assembled.json()).status, "incomplete");
  await settle();
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "limited");
});

/** A stream that sends `body` and then stays open until it is cancelled. */
const hanging = (body: string, cancelled: { value: boolean }) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel() {
        cancelled.value = true;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

test("a caller that hangs up after the usage limit arrived still marks the key", async () => {
  const cancelled = { value: false };
  const { call, store, keyId, settle } = await makePlanSlice({
    upstream: () => hanging(LIMIT_FAILED, cancelled),
  });
  const res = await call("/v1/responses", PI_BODY);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  await settle();
  assert(cancelled.value);
  assertEquals((await store.getProviderKey(keyId))?.planStatus, "limited");
  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.status, 499);
});

test("an assembled call whose stream breaks off is recorded as the 502 it answered", async () => {
  const { call, store } = await makePlanSlice({
    upstream: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(LIMIT_FAILED.slice(0, 40)));
            controller.error(new Error("reset"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const res = await call("/v1/responses", { model: "gpt-6.1-sol", input: "x" });
  assertEquals(res.status, 502);
  await res.body?.cancel();
  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.status, 502);
});

test("an assembled call stops reading the plan when its caller hangs up", async () => {
  const cancelled = { value: false };
  const { call, store } = await makePlanSlice({
    upstream: () => hanging(COMPLETED.split("event: response.completed")[0], cancelled),
  });
  const hangUp = new AbortController();
  const answered = call("/v1/responses", { model: "gpt-6.1-sol", input: "x" }, "POST", {
    signal: hangUp.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  hangUp.abort();
  const res = await answered;
  await res.body?.cancel();
  assert(cancelled.value, "the upstream read was cancelled");
  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.status, 499);
});

// ── OpenAI ending a token early ─────────────────────────────────────────────────────────────

/** What OpenAI answered in the incident: a token it ended before its expiry (a plan change). */
const TOKEN_EXPIRED = () =>
  Response.json({
    error: {
      message: "Provided authentication token is expired.",
      type: null,
      code: "token_expired",
      param: null,
    },
  }, { status: 401 });

/** Thirty minutes before OpenAI lets this sign-in refresh, as a response may say. */
const LATE_REFRESH = { earliest_refresh_at: Math.floor(T0 / 1000) + 30 * 60 };

test("a token OpenAI ended early: 401 token_expired refreshes at once and the retry succeeds", async () => {
  const { call, sent, fake, clock, events } = await makePlanSlice({
    upstream: (_req, n) => n === 1 ? TOKEN_EXPIRED() : streamed(COMPLETED),
    grantExtra: LATE_REFRESH,
  });
  clock.ms += 2 * 60 * 1000; // minted moments ago, before earliest_refresh_at, far from expiry
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), COMPLETED);
  assertEquals(sent.length, 2);
  assertEquals(sent[1].auth, `Bearer ${fake.accessTokens[1]}`);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 1);
  assert(events.includes("chatgpt_plan.rejected_refreshing"));
});

test("token_expired in the x-error-json header, with a bare body, refreshes at once too", async () => {
  const header = btoa(JSON.stringify({ error: { code: "token_expired", message: "expired" } }));
  const { call, sent, fake, clock } = await makePlanSlice({
    upstream: (_req, n) =>
      n === 1
        ? Response.json({ detail: "Unauthorized" }, {
          status: 401,
          headers: { "x-error-json": header },
        })
        : streamed(COMPLETED),
    grantExtra: LATE_REFRESH,
  });
  clock.ms += 2 * 60 * 1000; // minted moments ago, before earliest_refresh_at, far from expiry
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 200);
  assertEquals(sent.length, 2);
  assertEquals(sent[1].auth, `Bearer ${fake.accessTokens[1]}`);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("an x-error-json header that is not base64 JSON is no code", async () => {
  const { call, sent, fake, clock } = await makePlanSlice({
    upstream: () =>
      Response.json({ detail: "Unauthorized" }, {
        status: 401,
        headers: { "x-error-json": "not base64 json!" },
      }),
    grantExtra: LATE_REFRESH,
  });
  clock.ms += 6 * 60 * 1000;
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 401);
  assertEquals(sent.length, 1);
  assert(!fake.calls.includes("token:refresh_token"));
});

test("an assembled (non-streaming) call gets the same token_expired refresh and retry", async () => {
  const { call, sent, fake } = await makePlanSlice({
    upstream: (_req, n) => n === 1 ? TOKEN_EXPIRED() : streamed(COMPLETED),
    grantExtra: LATE_REFRESH,
  });
  const res = await call("/v1/responses", { ...PI_BODY, stream: false });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).status, "completed");
  assertEquals(sent.length, 2);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 1);
});

test("any other 401 before earliest_refresh_at is answered as a fixed refusal, and logged", async () => {
  const { call, sent, fake, clock, events } = await makePlanSlice({
    upstream: () =>
      Response.json({ error: { code: "invalid_api_key", account: "person@example.com" } }, {
        status: 401,
      }),
    grantExtra: LATE_REFRESH,
  });
  clock.ms += 6 * 60 * 1000;
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 401);
  const text = await res.text();
  assertEquals(JSON.parse(text).code, "upstream_credential_refused");
  assert(!text.includes("person@example.com"), "the upstream's own body stays here");
  assertEquals(sent.length, 1);
  assert(!fake.calls.includes("token:refresh_token"));
  assert(events.includes("chatgpt_plan.rejected_refresh_denied"));
  assert(events.includes("proxy.plan_unauthorized_relayed"));
});

test("token_expired with the refresh token revoked too: the caller is told to sign in again", async () => {
  const { call, fake, store, keyId } = await makePlanSlice({ upstream: TOKEN_EXPIRED });
  fake.failRefresh = "invalid_grant";
  const res = await call("/v1/responses", PI_BODY);
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.code, "needs_reauth");
  assertMatch(body.error, /signs it in again/);
  const key = (await store.getProviderKey(keyId))!;
  assertEquals(toPublicProviderKey(key).plan?.status, "needs_reauth", "the app's Needs sign-in");
});

test("a platform credential on a plan key refreshes near expiry and after token_expired", async () => {
  let refuse = false;
  const { call, sent, fake, store, keyId, clock, now } = await makePlanSlice({
    upstream: () => refuse ? (refuse = false, TOKEN_EXPIRED()) : streamed(COMPLETED),
  });
  await store.savePlatformPolicy({
    providerKeyId: keyId,
    provider: "chatgpt-plan",
    allowedModels: "*",
    model: "gpt-6.1-sol",
    updatedAt: now().toISOString(),
  });
  const platform = await makePlatformCredentialIssuer({ store, now }).issue("titles");

  clock.ms += 59 * 60 * 1000; // inside the refresh margin
  const first = await call("/v1/responses", PI_BODY, "POST", { token: platform.token });
  assertEquals(first.status, 200);
  await first.text();
  assertEquals(sent[0].auth, `Bearer ${fake.accessTokens[1]}`, "refreshed before it was sent");

  clock.ms += 10 * 60 * 1000;
  refuse = true;
  const second = await call("/v1/responses", PI_BODY, "POST", { token: platform.token });
  assertEquals(second.status, 200);
  await second.text();
  assertEquals(sent.at(-1)!.auth, `Bearer ${fake.accessTokens[2]}`);
  assertEquals(fake.calls.filter((c) => c === "token:refresh_token").length, 2);
});
