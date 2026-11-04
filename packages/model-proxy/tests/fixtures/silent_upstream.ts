// Two model calls held silent past Bun's fetch idle timeout, which the test shortens for this
// process (`BUN_CONFIG_HTTP_IDLE_TIMEOUT`, read once at startup, so it takes a process of its
// own). One upstream answers only after `HOLD_MS`, as a non-streamed answer from a model that
// thinks first does; the other sends its first event and then nothing for `HOLD_MS`. Prints
// what the proxy relayed, as JSON.

import { serve } from "@ryph/service";
import { makeProxyHandler } from "../../src/http/proxy.ts";
import { makeCredentialIssuer } from "../../src/core/service.ts";
import { makeSpendMeter } from "../../src/core/spend_meter.ts";
import { memoryKeyStore } from "../memory_store.ts";

const HOLD_MS = Number(process.env.HOLD_MS ?? "10000");
const enc = new TextEncoder();
const hold = () => new Promise((resolve) => setTimeout(resolve, HOLD_MS));

const upstream = await serve(
  { port: 0, hostname: "127.0.0.1", onListen() {} },
  async (req) => {
    if (new URL(req.url).searchParams.has("stream")) {
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(enc.encode("event: message_start\n\n"));
            await hold();
            controller.enqueue(enc.encode("event: message_stop\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    await hold();
    return Response.json({ answer: "after a long think" });
  },
);

const store = memoryKeyStore();
await store.createProviderKey({
  id: "pk-1",
  provider: "anthropic",
  label: "team key",
  last4: "cret",
  encryptedSecret: "sk-ant-realkey",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const env = await makeCredentialIssuer({
  store,
  now: () => new Date(),
  proxyUrl: "http://proxy.test",
  ttlMs: 600_000,
}).issue({
  runId: "r-1",
  agentId: "a-1",
  taskId: "t-1",
  providerKeyId: "pk-1",
  provider: "anthropic",
  allowedModels: "*",
  spendUsd: null,
  callsInFlight: null,
});
const handler = makeProxyHandler({
  store,
  decrypt: (sealed) => Promise.resolve(sealed),
  now: () => new Date(),
  diag: { debug() {}, warn() {} },
  limits: { meter: makeSpendMeter({ backstopMs: 30_000 }), gauge: null },
  baseUrlFor: () => `http://127.0.0.1:${upstream.addr.port}`,
  upstreamFetch: fetch,
});

const call = async (query: string) => {
  try {
    const res = await handler(
      new Request(`http://proxy.test/v1/messages${query}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": env.ANTHROPIC_API_KEY,
        },
        body: JSON.stringify({ model: "claude-sonnet-5" }),
      }),
    );
    return `${res.status} ${await res.text()}`;
  } catch (err) {
    return `threw ${err}`;
  }
};

const [whole, streamed] = await Promise.all([call(""), call("?stream")]);
console.log(JSON.stringify({ whole, streamed }));
process.exit(0);
