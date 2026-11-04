// The internal surface: the three questions a remote control plane asks, the service gate on
// every one of them, and the definitive-vs-retryable split that decides whether a run boot-fails
// now or keeps retrying.

import { MAX_JSON_BODY_BYTES } from "@ryph/shared/http";
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { internalCredentialRoutes } from "../src/http/internal.ts";
import { makeServiceGate } from "@ryph/sealed";
import { makeCredentialIssuer } from "../src/core/service.ts";
import type { Route } from "@ryph/shared/http";
import type { ProviderKey } from "../src/core/types.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { spendOfRun } from "../src/core/spend.ts";
import { usageRow } from "./usage_fixtures.ts";

const TOKEN = "service-secret";
const NOW = new Date("2026-01-01T00:00:00.000Z");

function providerKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: "pk-1",
    provider: "anthropic",
    label: "team",
    last4: "wxyz",
    encryptedSecret: "sealed:sk-ant-vwxyz",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeApi(
  opts: {
    store?: KeyStore;
    proxyUrl?: string | null;
    ceilingReached?: boolean;
    ceiling?: { usd: number; windowDays: number };
  } = {},
) {
  const store = opts.store ?? memoryKeyStore();
  const proxyUrl = opts.proxyUrl === undefined ? "http://proxy.internal:7420" : opts.proxyUrl;
  const warnings: string[] = [];
  const routes = internalCredentialRoutes({
    store,
    issuer: proxyUrl === null
      ? null
      : makeCredentialIssuer({ store, now: () => NOW, proxyUrl, ttlMs: 60_000 }),
    spend: {
      ofRun: (runId) => spendOfRun(store, runId),
      ceilingReached: () => Promise.resolve(opts.ceilingReached ?? false),
      ceiling: opts.ceiling ?? null,
    },
    authenticate: makeServiceGate(TOKEN),
    now: () => NOW,
    diag: { warn: (event) => warnings.push(event) },
  });
  const handler = async (req: Request): Promise<Response> => {
    for (const r of routes as Route[]) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.pathname.groups)) {
        if (value !== undefined) params[key] = value;
      }
      return await r.handler(req, params);
    }
    return new Response("not found", { status: 404 });
  };
  return { handler, store, warnings };
}

function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
) {
  return handler(
    new Request(`http://proxy.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

test("every internal route refuses without the service token", async () => {
  const { handler } = makeApi();
  for (
    const [method, path] of [
      ["GET", "/internal/v1/provider-keys/pk-1"],
      ["POST", "/internal/v1/runs/run-1/credentials"],
      ["DELETE", "/internal/v1/runs/run-1/credentials"],
      ["GET", "/internal/v1/runs/run-1/spend"],
      ["GET", "/internal/v1/spend-ceiling"],
    ] as const
  ) {
    for (const token of [null, "wrong-secret"]) {
      const res = await call(handler, method, path, undefined, token);
      assertEquals(res.status, 401, `${method} ${path} with ${token}`);
      await res.body?.cancel();
    }
  }
});

test("the key lookup answers metadata only, and 404s an unknown id", async () => {
  const { handler, store } = makeApi();
  await store.createProviderKey(providerKey());

  const found = await call(handler, "GET", "/internal/v1/provider-keys/pk-1");
  assertEquals(found.status, 200);
  // Exactly the five fields the control plane's policy check reads — the dialect among them,
  // because a provider id may now be a slug an admin typed and says nothing about the wire
  // shape, and BOTH archived timestamps, because the endpoint behind a live key can be
  // withdrawn on its own. No label, no last4, and above all no sealed secret: the control plane
  // cannot open one and must never receive one.
  assertEquals(await found.json(), {
    id: "pk-1",
    provider: "anthropic",
    dialect: "anthropic-messages",
    providerArchivedAt: null,
    archivedAt: null,
  });

  const missing = await call(handler, "GET", "/internal/v1/provider-keys/pk-nope");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

test("a key's dialect comes off the provider it names, custom or built-in", async () => {
  const { handler, store } = makeApi();
  await store.createCustomProvider({
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    models: [{ id: "llama-4" }],
    // Archived, and the lookup still answers: the control plane refuses the POLICY on the
    // timestamps, and a key whose dialect it could not read would be a different refusal.
    // `providerArchivedAt` is how it learns the endpoint is gone while the KEY is still live —
    // without it, the agent form said 201 and every run of that agent boot-failed.
    archivedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await store.createProviderKey(providerKey({ id: "pk-groq", provider: "groq" }));
  const res = await call(handler, "GET", "/internal/v1/provider-keys/pk-groq");
  assertEquals(await res.json(), {
    id: "pk-groq",
    provider: "groq",
    dialect: "openai-completions",
    providerArchivedAt: NOW.toISOString(),
    archivedAt: null,
  });

  // A key for a provider this deployment has no idea about is config drift, not a 404.
  await store.createProviderKey(providerKey({ id: "pk-drift", provider: "vanished" }));
  const drifted = await call(handler, "GET", "/internal/v1/provider-keys/pk-drift");
  assertEquals(drifted.status, 502);
  await drifted.body?.cancel();
});

test("internal JSON cap refuses before minting and accepts the exact boundary", async () => {
  const store = memoryKeyStore();
  const create = store.createVirtualKey.bind(store);
  let minted = 0;
  store.createVirtualKey = (key) => {
    minted++;
    return create(key);
  };
  const { handler } = makeApi({ store });
  await store.createProviderKey(providerKey());
  const value = JSON.stringify({
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
  });
  const request = (size: number, token = TOKEN) =>
    new Request(
      "http://proxy.test/internal/v1/runs/run-1/credentials",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: value.padEnd(size),
      },
    );
  const over = await handler(request(MAX_JSON_BODY_BYTES + 1));
  assertEquals(over.status, 413);
  assert((await over.json()).error.includes(`${MAX_JSON_BODY_BYTES} bytes`));
  assertEquals(minted, 0);
  assertEquals((await handler(request(MAX_JSON_BODY_BYTES + 1, "wrong"))).status, 401);
  assertEquals(minted, 0);
  assertEquals((await handler(request(MAX_JSON_BODY_BYTES))).status, 200);
  assertEquals(minted, 1);
});

test("issue mints a virtual key and returns the container's env", async () => {
  const { handler, store } = makeApi();
  await store.createProviderKey(providerKey());

  const res = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", {
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-opus-5"],
    spendUsd: 20,
    callsInFlight: 8,
  });
  assertEquals(res.status, 200);
  const { env } = await res.json() as { env: Record<string, string> };
  assert(env.ANTHROPIC_API_KEY.startsWith("ryph-vk-"), "the raw virtual token rides the env");
  assertEquals(env.ANTHROPIC_BASE_URL, "http://proxy.internal:7420");

  // Only the hash landed in a row, and it is bound to this run.
  const stored = await store.getVirtualKeyByTokenHash(
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(env.ANTHROPIC_API_KEY),
        ),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join(""),
  );
  assertEquals(stored?.runId, "run-1");
  assertEquals(stored?.allowedModels, ["claude-opus-5"]);
  // The caps the control plane decided ride the scope and freeze onto the row.
  assertEquals([stored?.spendUsd, stored?.callsInFlight], [20, 8]);
});

test("a definitive refusal answers 400, so the caller knows retrying cannot help", async () => {
  const { handler, store, warnings } = makeApi();
  await store.createProviderKey(providerKey({ id: "pk-archived", archivedAt: NOW.toISOString() }));
  await store.createProviderKey(providerKey({ id: "pk-openai", provider: "openai" }));

  const cases: Array<[string, string]> = [
    ["pk-nope", "anthropic"], // no such key
    ["pk-archived", "anthropic"], // archived
    ["pk-openai", "anthropic"], // registered for a different provider
  ];
  for (const [providerKeyId, provider] of cases) {
    const res = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", {
      providerKeyId,
      provider,
      allowedModels: "*",
    });
    assertEquals(res.status, 400, providerKeyId);
    assert(typeof (await res.json()).error === "string");
  }
  // 400 is a verdict about the caller's request, not a fault of ours — nothing to warn about.
  assertEquals(warnings, []);
});

test("a store that is down answers 503, not 400", async () => {
  const store = memoryKeyStore();
  const broken: KeyStore = {
    ...store,
    getProviderKey: () => Promise.reject(new Error("connection terminated unexpectedly")),
  };
  const { handler, warnings } = makeApi({ store: broken });

  const res = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", {
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
  });
  // Retryable: the run's boot fetch should try again rather than fail for good over a blip.
  assertEquals(res.status, 503);
  await res.body?.cancel();
  assertEquals(warnings, ["internal.issue_failed"]);
});

test("issue without a proxy address refuses, and says which knob is missing", async () => {
  const { handler, store } = makeApi({ proxyUrl: null });
  await store.createProviderKey(providerKey());

  const res = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", {
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
  });
  assertEquals(res.status, 503);
  assert((await res.json() as { error: string }).error.includes("RYPH_MODEL_PROXY_URL"));
});

test("issue validates its body before it reaches the issuer", async () => {
  const { handler } = makeApi();
  for (
    const body of [
      { provider: "anthropic", allowedModels: "*" }, // no providerKeyId
      {
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: "pk-1",
        provider: "nope",
        allowedModels: "*",
      }, // unknown provider
      {
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: "pk-1",
        provider: "anthropic",
        allowedModels: "everything",
      },
      {
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: "pk-1",
        provider: "anthropic",
        allowedModels: "*",
        spendUsd: -1,
      }, // a cap must be positive
    ]
  ) {
    const res = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", body);
    assertEquals(res.status, 400, JSON.stringify(body));
    await res.body?.cancel();
  }
});

test("revoke kills a run's live credentials and is idempotent", async () => {
  const { handler, store } = makeApi();
  await store.createProviderKey(providerKey());
  const issued = await call(handler, "POST", "/internal/v1/runs/run-1/credentials", {
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
  });
  const { env } = await issued.json() as { env: Record<string, string> };
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ANTHROPIC_API_KEY)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

  const first = await call(handler, "DELETE", "/internal/v1/runs/run-1/credentials");
  assertEquals(first.status, 204);
  assertEquals((await store.getVirtualKeyByTokenHash(hash))?.revokedAt, NOW.toISOString());

  // The control plane fires this on every conclusion, including runs that never had a
  // credential — a second call, and a call for an unknown run, must both be a quiet 204.
  assertEquals((await call(handler, "DELETE", "/internal/v1/runs/run-1/credentials")).status, 204);
  assertEquals((await call(handler, "DELETE", "/internal/v1/runs/nope/credentials")).status, 204);
});

test("revoke works even without a proxy address configured", async () => {
  // The store holds the rows, not the issuer. A deployment that lost its proxy URL must not
  // thereby keep every live credential alive until its TTL lapses.
  const { handler } = makeApi({ proxyUrl: null });
  assertEquals((await call(handler, "DELETE", "/internal/v1/runs/run-1/credentials")).status, 204);
});

test("the spend reads: a run's priced total, and whether the ceiling is reached", async () => {
  const { handler, store } = makeApi({ ceiling: { usd: 100, windowDays: 30 } });
  await store.recordUsage(usageRow({ runId: "run-1" }));
  await store.recordUsage(usageRow({ runId: "run-1", model: "claude-imaginary-9" }));

  const spend = await (await call(handler, "GET", "/internal/v1/runs/run-1/spend")).json();
  assertEquals(spend.runId, "run-1");
  assertEquals(Math.round(spend.spentUsd * 1e6), 100 * 2 + 50 * 10); // sonnet at 2 / 10 per M
  assertEquals(spend.unpricedRequests, 1);
  assertEquals(await (await call(handler, "GET", "/internal/v1/runs/none/spend")).json(), {
    runId: "none",
    spentUsd: 0,
    unpricedRequests: 0,
  });

  const under = await (await call(handler, "GET", "/internal/v1/spend-ceiling")).json();
  assertEquals(under, { reached: false, ceiling: { usd: 100, windowDays: 30 } });
  const { handler: full } = makeApi({ ceilingReached: true });
  assertEquals(await (await call(full, "GET", "/internal/v1/spend-ceiling")).json(), {
    reached: true,
    ceiling: null,
  });
});

// ── the platform route ─────────────────────────────────────────────────────────────────────

import { platformCredentialRoutes } from "../src/http/internal.ts";
import { makePlatformCredentialIssuer } from "../src/core/service.ts";

const PLATFORM_TOKEN = "platform-secret";

function makePlatformApi() {
  const store = memoryKeyStore();
  const routes = platformCredentialRoutes({
    issuer: makePlatformCredentialIssuer({ store, now: () => NOW, ttlMs: 60_000 }),
    authenticate: makeServiceGate(PLATFORM_TOKEN),
    diag: { warn() {} },
  });
  const handler = async (req: Request): Promise<Response> => {
    for (const r of routes as Route[]) {
      if (r.method !== req.method) continue;
      const match = r.pattern.exec(req.url);
      if (!match) continue;
      return await r.handler(req, {});
    }
    return new Response("not found", { status: 404 });
  };
  return { handler, store };
}

test("platform credentials: its own token, 400 without a policy, a credential with one", async () => {
  const { handler, store } = makePlatformApi();
  const denied = await call(handler, "POST", "/internal/v1/platform/credentials", {
    consumer: "memory",
  }, TOKEN);
  assertEquals(denied.status, 401);
  await denied.body?.cancel();

  const unset = await call(handler, "POST", "/internal/v1/platform/credentials", {
    consumer: "memory",
  }, PLATFORM_TOKEN);
  assertEquals(unset.status, 400);
  assert(((await unset.json()).error as string).includes("no platform model policy"));

  await store.createProviderKey(providerKey({ provider: "openai" }));
  await store.savePlatformPolicy({
    providerKeyId: "pk-1",
    provider: "openai",
    allowedModels: "*",
    model: "gpt-5",
    updatedAt: NOW.toISOString(),
  });
  const res = await call(handler, "POST", "/internal/v1/platform/credentials", {
    consumer: "memory",
  }, PLATFORM_TOKEN);
  assertEquals(res.status, 200);
  const cred = await res.json();
  assert(cred.token.startsWith("ryph-vk-"));
  assertEquals(cred.provider, "openai");
  assertEquals(cred.model, "gpt-5");
  assertEquals(cred.basePath, "/v1");

  const bad = await call(handler, "POST", "/internal/v1/platform/credentials", {
    consumer: "Not A Name",
  }, PLATFORM_TOKEN);
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});
