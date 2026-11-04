// The credential issuer: what the env map carries, what lands in a row, and every refusal.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { makeCredentialIssuer } from "../src/core/service.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { sha256Hex } from "@ryph/sealed";
import type { CustomProvider, ProviderKey } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function anthropicKey(overrides: Partial<ProviderKey> = {}): ProviderKey {
  return {
    id: "pk-1",
    provider: "anthropic",
    label: "team key",
    last4: "cret",
    encryptedSecret: "v1.sealed",
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeIssuer(store = memoryKeyStore()) {
  const issuer = makeCredentialIssuer({
    store,
    now: () => new Date(T0),
    proxyUrl: "http://model-proxy.internal:7420",
    ttlMs: 60_000,
  });
  return { issuer, store };
}

const SCOPE = {
  runId: "r-1",
  agentId: "a-1",
  taskId: "t-1",
  providerKeyId: "pk-1",
  provider: "anthropic",
  allowedModels: ["claude-sonnet-5"] as string[] | "*",
};

test("issue mints a virtual key: env via the registry's names, only a hash in the row", async () => {
  const { issuer, store } = makeIssuer();
  await store.createProviderKey(anthropicKey());

  const env = await issuer.issue(SCOPE);
  const token = env.ANTHROPIC_API_KEY;
  assert(token.startsWith("ryph-vk-"), "recognizably a ryph credential, not a real key");
  assertEquals(env.ANTHROPIC_BASE_URL, "http://model-proxy.internal:7420");

  const row = await store.getVirtualKeyByTokenHash(await sha256Hex(token));
  assert(row !== null);
  assertEquals(row.runId, "r-1");
  assertEquals(row.providerKeyId, "pk-1");
  assertEquals(row.allowedModels, ["claude-sonnet-5"]);
  assertEquals(row.expiresAt, "2026-01-01T00:01:00.000Z"); // now + ttl
  assertEquals(row.revokedAt, null);
  // A scope that names no caps mints an uncapped credential.
  assertEquals([row.spendUsd, row.callsInFlight], [null, null]);
});

test("issue freezes the run's spend and in-flight caps onto the virtual key", async () => {
  const { issuer, store } = makeIssuer();
  await store.createProviderKey(anthropicKey());
  const env = await issuer.issue({ ...SCOPE, spendUsd: 20, callsInFlight: 8 });
  const row = await store.getVirtualKeyByTokenHash(await sha256Hex(env.ANTHROPIC_API_KEY));
  assertEquals([row?.spendUsd, row?.callsInFlight], [20, 8]);
});

test("issue carries the provider's client base path: OpenAI's base includes /v1, Anthropic's is bare", async () => {
  const { issuer, store } = makeIssuer();
  await store.createProviderKey(
    anthropicKey({ id: "pk-oai", provider: "openai", label: "oai key" }),
  );

  const env = await issuer.issue({
    runId: "r-1",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: "pk-oai",
    provider: "openai",
    allowedModels: ["gpt-4o"],
  });
  assert(env.OPENAI_API_KEY.startsWith("ryph-vk-"));
  assertEquals(env.OPENAI_BASE_URL, "http://model-proxy.internal:7420/v1");
});

test("issue refuses an unknown, archived, or mismatched provider key", async () => {
  const { issuer, store } = makeIssuer();
  await assertRejects(() => issuer.issue(SCOPE), Error, "does not exist");

  await store.createProviderKey(anthropicKey({ archivedAt: T0 }));
  await assertRejects(() => issuer.issue(SCOPE), Error, "archived");

  await store.saveProviderKey(anthropicKey({ provider: "openai", archivedAt: null }));
  await assertRejects(() => issuer.issue(SCOPE), Error, 'for "openai"');

  await assertRejects(
    () => issuer.issue({ ...SCOPE, provider: "acme-llm" }),
    Error,
    "unknown provider",
  );
});

function customProvider(overrides: Partial<CustomProvider> = {}): CustomProvider {
  return {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: { "x-ryph": "yes" },
    models: [
      { id: "llama-4", label: "Llama 4", contextWindow: 128_000, compat: { maxTokensField: "m" } },
    ],
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const CUSTOM_SCOPE = { ...SCOPE, provider: "groq", allowedModels: ["llama-4"] as string[] | "*" };

test("a custom endpoint's env carries the key, the proxy's /v1, and the provider config", async () => {
  const { issuer, store } = makeIssuer();
  await store.createCustomProvider(customProvider());
  await store.createProviderKey(anthropicKey({ provider: "groq" }));

  const env = await issuer.issue(CUSTOM_SCOPE);
  assertEquals(Object.keys(env).toSorted(), [
    "RYPH_MODEL_API_KEY",
    "RYPH_MODEL_BASE_URL",
    "RYPH_MODEL_PROVIDER_CONFIG",
  ]);
  assert(env.RYPH_MODEL_API_KEY.startsWith("ryph-vk-"));
  // The PROXY's address with the OpenAI client base path — never the upstream's own URL.
  assertEquals(env.RYPH_MODEL_BASE_URL, "http://model-proxy.internal:7420/v1");
  assertEquals(JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG), {
    id: "groq",
    dialect: "openai-completions",
    models: [
      {
        id: "llama-4",
        label: "Llama 4",
        contextWindow: 128_000,
        compat: { maxTokensField: "m" },
      },
    ],
  });
  // Nothing an admin typed about the UPSTREAM leg crosses into a container.
  const blob = env.RYPH_MODEL_PROVIDER_CONFIG;
  assert(!blob.includes("api.groq.com"), "the upstream URL stays in the proxy");
  assert(!blob.includes("x-ryph"), "and so do its headers");
});

test("a model marked as taking images says so in the config the harness reads", async () => {
  const { issuer, store } = makeIssuer();
  await store.createCustomProvider(customProvider({
    models: [{ id: "llama-4", vision: true }, { id: "llama-4-text" }],
  }));
  await store.createProviderKey(anthropicKey({ provider: "groq" }));
  const env = await issuer.issue(CUSTOM_SCOPE);
  // The runner's pi adapter turns `vision: true` into pi's `input: ["text", "image"]`; unset,
  // pi treats the model as text-only and replaces every image with a placeholder.
  assertEquals(JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG).models, [
    { id: "llama-4", vision: true },
    { id: "llama-4-text" },
  ]);
});

test("a model reaches the run as declared, its levels said or not", async () => {
  const { issuer, store } = makeIssuer();
  await store.createCustomProvider(customProvider({
    models: [
      { id: "llama-4", reasoning: false },
      { id: "llama-4-think", reasoning: true },
      { id: "llama-4-old" },
    ],
  }));
  await store.createProviderKey(anthropicKey({ provider: "groq" }));
  const env = await issuer.issue(CUSTOM_SCOPE);
  // Nothing filled in: the runner writes each into pi's models.json, and pi's own defaults
  // decide what an unsaid one takes.
  assertEquals(JSON.parse(env.RYPH_MODEL_PROVIDER_CONFIG).models, [
    { id: "llama-4", reasoning: false },
    { id: "llama-4-think", reasoning: true },
    { id: "llama-4-old" },
  ]);
});

test("issue refuses an archived custom endpoint definitively, and an unknown slug", async () => {
  const { issuer, store } = makeIssuer();
  await store.createCustomProvider(customProvider({ archivedAt: T0 }));
  await store.createProviderKey(anthropicKey({ provider: "groq" }));
  // Better a boot failure the runner reports than a run that starts and 403s on its first call.
  await assertRejects(() => issuer.issue(CUSTOM_SCOPE), Error, "is archived");
  await assertRejects(
    () => issuer.issue({ ...CUSTOM_SCOPE, provider: "never-registered" }),
    Error,
    "unknown provider",
  );
});

test("revokeForRun kills every live credential of the run and only that run's", async () => {
  const { issuer, store } = makeIssuer();
  await store.createProviderKey(anthropicKey());

  const first = (await issuer.issue(SCOPE)).ANTHROPIC_API_KEY;
  const second = (await issuer.issue(SCOPE)).ANTHROPIC_API_KEY; // a refetched boot
  const other = (await issuer.issue({ ...SCOPE, runId: "r-2" })).ANTHROPIC_API_KEY;

  await issuer.revokeForRun("r-1");
  for (const token of [first, second]) {
    const row = await store.getVirtualKeyByTokenHash(await sha256Hex(token));
    assertEquals(row?.revokedAt, T0);
  }
  const otherRow = await store.getVirtualKeyByTokenHash(await sha256Hex(other));
  assertEquals(otherRow?.revokedAt, null);
});

// ── platform credentials ───────────────────────────────────────────────────────────────────

import { makePlatformCredentialIssuer } from "../src/core/service.ts";
import { platformPrincipal } from "../src/core/types.ts";

function makePlatform(store = memoryKeyStore()) {
  const issuer = makePlatformCredentialIssuer({ store, now: () => new Date(T0), ttlMs: 60_000 });
  return { issuer, store };
}

test("platform: refuses definitively without a policy, and with an archived key", async () => {
  const { issuer, store } = makePlatform();
  await assertRejects(() => issuer.issue("memory"), Error, "no platform model policy");
  await store.createProviderKey(anthropicKey({ archivedAt: T0 }));
  await store.savePlatformPolicy({
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
    model: "claude-sonnet-5",
    updatedAt: T0,
  });
  await assertRejects(() => issuer.issue("memory"), Error, "is archived");
});

test("platform: mints under the platform principal, from the policy, and revokes by consumer", async () => {
  const { issuer, store } = makePlatform();
  await store.createProviderKey(anthropicKey());
  await store.savePlatformPolicy({
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5", "claude-haiku-4-5-20251001"],
    model: "claude-sonnet-5",
    updatedAt: T0,
  });
  const cred = await issuer.issue("memory");
  assert(cred.token.startsWith("ryph-vk-"));
  assertEquals(cred.provider, "anthropic");
  // The consumer builds its request body from the DIALECT: a slug says nothing about the shape.
  assertEquals(cred.dialect, "anthropic-messages");
  assertEquals(cred.model, "claude-sonnet-5");
  assertEquals(cred.basePath, "");
  assertEquals(cred.expiresAt, "2026-01-01T00:01:00.000Z");
  const row = await store.getVirtualKeyByTokenHash(await sha256Hex(cred.token));
  assert(row !== null);
  assertEquals(row.runId, platformPrincipal("memory"));
  assertEquals(row.runId, "platform:memory");
  assertEquals(row.allowedModels, ["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  // The platform's own work is never capped per credential; the deployment ceiling bounds it.
  assertEquals([row.spendUsd, row.callsInFlight], [null, null]);
  await issuer.revoke("memory");
  assertEquals((await store.getVirtualKeyByTokenHash(await sha256Hex(cred.token)))?.revokedAt, T0);
});

test("platform: re-minting leaves exactly one live credential per consumer", async () => {
  const { issuer, store } = makePlatform();
  await store.createProviderKey(anthropicKey());
  await store.savePlatformPolicy({
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
    model: "claude-sonnet-5",
    updatedAt: T0,
  });
  // A consumer re-mints on every restart, expiry and 401; each of those used to leave the last
  // credential working for its whole TTL.
  const first = await issuer.issue("memory");
  const second = await issuer.issue("memory");
  assert(first.token !== second.token);
  assertEquals((await store.getVirtualKeyByTokenHash(await sha256Hex(first.token)))?.revokedAt, T0);
  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(second.token)))?.revokedAt,
    null,
  );

  // Another consumer's credential is its own; one re-mint must not disarm the rest of the
  // platform.
  const other = await issuer.issue("ingest");
  await issuer.issue("memory");
  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(other.token)))?.revokedAt,
    null,
  );
});

test("platform: a store-wide revoke kills every consumer's credential and nothing else", async () => {
  const { issuer, store } = makePlatform();
  await store.createProviderKey(anthropicKey());
  await store.savePlatformPolicy({
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: "*",
    model: "claude-sonnet-5",
    updatedAt: T0,
  });
  const memory = await issuer.issue("memory");
  const ingest = await issuer.issue("ingest");
  const run = await makeIssuer(store).issuer.issue(SCOPE);

  await store.revokePlatformVirtualKeys(T0);

  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(memory.token)))?.revokedAt,
    T0,
  );
  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(ingest.token)))?.revokedAt,
    T0,
  );
  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(run.ANTHROPIC_API_KEY)))?.revokedAt,
    null,
    "a run's credential is not the platform's to revoke",
  );
});
