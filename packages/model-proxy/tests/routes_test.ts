// The management surface: write-only secrets, rotation under a stable id, idempotent
// archiving, who may read versus who may write, and the host's gates honored on every route.

import { MAX_JSON_BODY_BYTES } from "@ryph/shared/http";
import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { providerKeyRoutes } from "../src/http/routes.ts";
import type { Route } from "@ryph/shared/http";
import { FORBIDDEN, forbidden } from "@ryph/auth";
import { unauthorized } from "@ryph/sealed";
import { makePlatformCredentialIssuer } from "../src/core/service.ts";
import { makeProxyHandler } from "../src/http/proxy.ts";
import { makeSpendMeter } from "../src/core/spend_meter.ts";
import { memoryKeyStore } from "./memory_store.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { sha256Hex } from "@ryph/sealed";

/** The data plane over the same store, to prove a revoked credential no longer spends. */
function proxyFor(store: KeyStore): (req: Request) => Promise<Response> {
  return makeProxyHandler({
    resolveHost: publicDns,
    store,
    decrypt: (sealed) => Promise.resolve(sealed.replace(/^sealed:/, "")),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    diag: { debug() {}, warn() {} },
    limits: { meter: makeSpendMeter({ backstopMs: 0 }), gauge: null },
    upstreamFetch: () => Promise.reject(new Error("must never reach the upstream")),
  });
}

/** Three callers: an admin, a signed-in non-admin, and nobody. */
const ADMIN = "admin-secret";
const USER = "user-secret";

function makeApi(opts: { gate?: boolean; store?: KeyStore; resolveHost?: ResolveHost } = {}) {
  const store = opts.store ?? memoryKeyStore();
  const sealed: string[] = [];
  // The two gates the host mounts, with the real refusals: unknown bearer 401, a verified
  // non-admin on an admin route 403 with the coded body.
  const gate = (req: Request, adminsOnly: boolean): Response | null => {
    if (opts.gate === false) return null;
    const presented = req.headers.get("authorization");
    if (presented === `Bearer ${ADMIN}`) return null;
    if (presented === `Bearer ${USER}`) {
      return adminsOnly
        ? new Response(JSON.stringify(forbidden("models:manage")), { status: 403 })
        : null;
    }
    return unauthorized();
  };
  const routes = providerKeyRoutes({
    resolveHost: opts.resolveHost ?? publicDns,
    store,
    encrypt: (plaintext) => {
      sealed.push(plaintext);
      return Promise.resolve(`sealed:${plaintext}`);
    },
    authenticate: (req) => Promise.resolve(gate(req, false)),
    authenticateManage: (req) => Promise.resolve(gate(req, true)),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    planOn: true,
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
  return { handler, store, sealed };
}

function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  token: string = ADMIN,
) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const CREATE = { provider: "anthropic", label: "team key", secret: "sk-ant-verysecret" };

test("management JSON cap is inclusive, streamed, and checked after auth before sealing", async () => {
  const { handler, store, sealed } = makeApi();
  const value = JSON.stringify({ ...CREATE, label: "équipe" });
  const bytes = new TextEncoder().encode(value);
  const callSized = (size: number, token = ADMIN) => {
    const padded = new Uint8Array(size).fill(32);
    padded.set(bytes);
    return handler(
      new Request("http://proxy.test/v1/provider-keys", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: new ReadableStream({
          start(c) {
            c.enqueue(padded);
            c.close();
          },
        }),
      }),
    );
  };
  const over = await callSized(MAX_JSON_BODY_BYTES + 1);
  assertEquals(over.status, 413);
  assert((await over.json()).error.includes(`${MAX_JSON_BODY_BYTES} bytes`));
  assertEquals(sealed, []);
  assertEquals(await store.listProviderKeys(), []);
  assertEquals((await callSized(MAX_JSON_BODY_BYTES + 1, USER)).status, 403);
  assertEquals((await callSized(MAX_JSON_BODY_BYTES)).status, 201);
  assertEquals(sealed, [CREATE.secret]);
});

test("create seals the secret and answers only its trace; list never leaks it", async () => {
  const { handler, store, sealed } = makeApi();
  const created = await call(handler, "POST", "/v1/provider-keys", CREATE);
  assertEquals(created.status, 201);
  const key = await created.json();
  assertEquals(key.provider, "anthropic");
  assertEquals(key.last4, "cret");
  assert(!("encryptedSecret" in key), "the sealed secret never rides a response");
  assert(!JSON.stringify(key).includes("verysecret"));
  assertEquals(sealed, ["sk-ant-verysecret"]); // sealed exactly once, verbatim

  // The row itself holds only the sealed form.
  const row = await store.getProviderKey(key.id);
  assertEquals(row?.encryptedSecret, "sealed:sk-ant-verysecret");

  const listed = await (await call(handler, "GET", "/v1/provider-keys")).json();
  assertEquals(listed.providerKeys.length, 1);
  assert(!JSON.stringify(listed).includes("verysecret"));
});

test("rotation replaces the secret under the same id; a relabel touches nothing else", async () => {
  const { handler } = makeApi();
  const key = await (await call(handler, "POST", "/v1/provider-keys", CREATE)).json();

  const rotated = await call(handler, "PATCH", `/v1/provider-keys/${key.id}`, {
    secret: "sk-ant-freshkey9",
  });
  assertEquals(rotated.status, 200);
  const rotatedKey = await rotated.json();
  assertEquals(rotatedKey.id, key.id, "rotation must not move the id anything references");
  assertEquals(rotatedKey.last4, "key9");
  assertEquals(rotatedKey.label, "team key");

  const relabeled = await (await call(handler, "PATCH", `/v1/provider-keys/${key.id}`, {
    label: "spend-capped CI key",
  })).json();
  assertEquals(relabeled.last4, "key9"); // untouched
  assertEquals(relabeled.label, "spend-capped CI key");

  const empty = await call(handler, "PATCH", `/v1/provider-keys/${key.id}`, {});
  assertEquals(empty.status, 400);
});

test("archive is idempotent and keeps the row resolvable", async () => {
  const { handler, store } = makeApi();
  const key = await (await call(handler, "POST", "/v1/provider-keys", CREATE)).json();
  const archived = await call(handler, "POST", `/v1/provider-keys/${key.id}/archive`);
  assertEquals(archived.status, 200);
  assert((await archived.json()).archivedAt !== null);
  const again = await call(handler, "POST", `/v1/provider-keys/${key.id}/archive`);
  assertEquals(again.status, 200);
  assert((await store.getProviderKey(key.id)) !== null, "archived, never deleted");
});

test("an unknown provider and a malformed secret die at the boundary", async () => {
  const { handler } = makeApi();
  // The provider check now runs in the ROUTE, against built-ins ∪ live rows rather than a static
  // map — a well-formed slug that names no endpoint is still a 400, just from one layer down.
  const unknown = await call(handler, "POST", "/v1/provider-keys", {
    ...CREATE,
    provider: "acme-llm",
  });
  assertEquals(unknown.status, 400);
  assert((await unknown.json()).error.includes("no such provider"));

  const malformed = await call(handler, "POST", "/v1/provider-keys", {
    ...CREATE,
    provider: "Acme LLM",
  });
  assertEquals(malformed.status, 400);
  assert((await malformed.json()).error.includes("slug"));

  const spacey = await call(handler, "POST", "/v1/provider-keys", {
    ...CREATE,
    secret: "sk ant oops",
  });
  assertEquals(spacey.status, 400);
});

test("every route sits behind the host's gate", async () => {
  const { handler } = makeApi();
  for (
    const [method, path, body] of [
      ["POST", "/v1/provider-keys", CREATE],
      ["GET", "/v1/provider-keys"],
      ["PATCH", "/v1/provider-keys/pk-x", {}],
      ["POST", "/v1/provider-keys/pk-x/archive"],
      ["GET", "/v1/platform-model-policy"],
      ["PUT", "/v1/platform-model-policy", { providerKeyId: "pk-x", model: "claude-sonnet-5" }],
      ["DELETE", "/v1/platform-model-policy"],
      ["GET", "/v1/providers"],
      ["GET", "/v1/providers/x"],
      ["POST", "/v1/providers", { id: "x", label: "x", baseUrl: "https://x.dev", models: [] }],
      ["PATCH", "/v1/providers/x", { label: "x" }],
      ["POST", "/v1/providers/x/archive"],
    ] as Array<[string, string, unknown?]>
  ) {
    const res = await call(handler, method, path, body, "");
    assertEquals(res.status, 401, `${method} ${path}`);
    await res.body?.cancel();
  }
});

test("a signed-in non-admin may read keys and the policy, and may change neither", async () => {
  const { handler, store } = makeApi();
  const key = await (await call(handler, "POST", "/v1/provider-keys", CREATE)).json();
  await (await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: key.id,
    model: "claude-sonnet-5",
  })).body?.cancel();

  // Reading is any signed-in user's: the app lists the keys and shows the policy.
  const listed = await call(handler, "GET", "/v1/provider-keys", undefined, USER);
  assertEquals(listed.status, 200);
  assertEquals((await listed.json()).providerKeys.length, 1);
  const shown = await call(handler, "GET", "/v1/platform-model-policy", undefined, USER);
  assertEquals(shown.status, 200);
  assertEquals((await shown.json()).policy.providerKeyId, key.id);

  // Everything that touches a credential is an admin's, and says so in a coded body.
  for (
    const [method, path, body] of [
      ["POST", "/v1/provider-keys", CREATE],
      ["PATCH", `/v1/provider-keys/${key.id}`, { label: "mine now" }],
      ["POST", `/v1/provider-keys/${key.id}/archive`],
      ["PUT", "/v1/platform-model-policy", {
        providerKeyId: key.id,
        model: "claude-haiku-4-5-20251001",
      }],
      ["DELETE", "/v1/platform-model-policy"],
    ] as Array<[string, string, unknown?]>
  ) {
    const res = await call(handler, method, path, body, USER);
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).code, FORBIDDEN, `${method} ${path}`);
  }

  // Nothing moved: one key, still labeled and live, and the policy still names its model.
  assertEquals((await store.listProviderKeys()).length, 1);
  assertEquals((await store.getProviderKey(key.id))?.label, "team key");
  assertEquals((await store.getProviderKey(key.id))?.archivedAt, null);
  assertEquals((await store.getPlatformPolicy())?.model, "claude-sonnet-5");
});

test("an admin's policy change revokes every platform credential already out", async () => {
  const { handler, store } = makeApi();
  const key = await (await call(handler, "POST", "/v1/provider-keys", CREATE)).json();
  await (await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: key.id,
    model: "claude-sonnet-5",
  })).body?.cancel();

  const issuer = makePlatformCredentialIssuer({
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ttlMs: 24 * 60 * 60 * 1000,
  });
  const cred = await issuer.issue("memory");
  const hash = await sha256Hex(cred.token);
  assertEquals((await store.getVirtualKeyByTokenHash(hash))?.revokedAt, null);

  // Narrowing the allowlist must bind the credential already out, not just the next one.
  const narrowed = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: key.id,
    allowedModels: ["claude-haiku-4-5-20251001"],
    model: "claude-haiku-4-5-20251001",
  });
  assertEquals(narrowed.status, 200);
  await narrowed.body?.cancel();
  assertEquals(
    (await store.getVirtualKeyByTokenHash(hash))?.revokedAt,
    "2026-01-01T00:00:00.000Z",
  );

  // And the data plane refuses to spend it — a revoked key is not a credential.
  const refused = await proxyFor(store)(
    new Request("http://proxy.test/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cred.token, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    }),
  );
  assertEquals(refused.status, 401);
  await refused.body?.cancel();

  // Clearing the policy kills the re-minted one too: "dark" has to mean now.
  const next = await issuer.issue("memory");
  const cleared = await call(handler, "DELETE", "/v1/platform-model-policy");
  assertEquals(cleared.status, 200);
  await cleared.body?.cancel();
  assertEquals(
    (await store.getVirtualKeyByTokenHash(await sha256Hex(next.token)))?.revokedAt,
    "2026-01-01T00:00:00.000Z",
  );
});

test("the platform policy names a live key; its provider is the key's; clearing empties it", async () => {
  const { handler } = makeApi();
  const empty = await call(handler, "GET", "/v1/platform-model-policy");
  assertEquals(await empty.json(), { policy: null });

  const missing = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: "pk-nope",
    model: "claude-sonnet-5",
  });
  assertEquals(missing.status, 400);
  await missing.body?.cancel();

  const created = await (await call(handler, "POST", "/v1/provider-keys", CREATE)).json();
  const outside = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: created.id,
    allowedModels: ["claude-haiku-4-5-20251001"],
    model: "claude-sonnet-5",
  });
  assertEquals(outside.status, 400);
  assert(((await outside.json()).error as string).includes("one of allowedModels"));

  const set = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: created.id,
    model: "claude-sonnet-5",
  });
  assertEquals(set.status, 200);
  const { policy } = await set.json();
  assertEquals(policy.provider, "anthropic");
  assertEquals(policy.allowedModels, "*");
  assertEquals(policy.model, "claude-sonnet-5");
  assertEquals(
    (await (await call(handler, "GET", "/v1/platform-model-policy")).json()).policy,
    policy,
  );

  await call(handler, "POST", `/v1/provider-keys/${created.id}/archive`).then((r) =>
    r.body?.cancel()
  );
  const archived = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: created.id,
    model: "claude-sonnet-5",
  });
  assertEquals(archived.status, 400);
  await archived.body?.cancel();

  const cleared = await call(handler, "DELETE", "/v1/platform-model-policy");
  assertEquals(await cleared.json(), { policy: null });
  const gated = await call(handler, "GET", "/v1/platform-model-policy", undefined, "");
  assertEquals(gated.status, 401);
  await gated.body?.cancel();
});

// ── custom model endpoints ─────────────────────────────────────────────────────────────────

import { disabledProviderKeyRoutes, MODEL_ACCESS_DISABLED } from "../src/http/routes.ts";
import { isPrivateModelEndpointHost, refuseModelEndpointUrl } from "../src/schema.ts";
import { publicDns } from "./dns.ts";
import type { ResolveHost } from "../src/schema.ts";

const ENDPOINT = {
  id: "groq",
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  models: [{
    id: "llama-4",
    label: "Llama 4",
    price: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
  }],
};

test("the provider list is built-ins then rows, and never carries extraHeaders", async () => {
  const { handler } = makeApi();
  const before = await (await call(handler, "GET", "/v1/providers")).json();
  assertEquals(
    before.providers.map((p: { id: string }) => p.id),
    ["anthropic", "openai", "chatgpt-plan"],
  );
  assertEquals(before.providers[0].dialect, "anthropic-messages");
  // OpenAI is driven over the Responses API; a custom endpoint (below) stays on Chat Completions.
  assertEquals(before.providers[1].dialect, "openai-responses");
  assert(before.providers.every((p: { builtin: boolean }) => p.builtin));
  // The rule the forwarding path depends on: openai's base URL carries its /v1.
  assertEquals(before.providers[1].baseUrl, "https://api.openai.com/v1");
  // How the credential rides upstream is not a secret and the edit dialog has to show it, so
  // the list carries it: Anthropic's bare `x-api-key`, OpenAI's `authorization: Bearer`.
  assertEquals(before.providers[0].authHeader, "x-api-key");
  assertEquals(before.providers[0].authScheme, null);
  assertEquals(before.providers[1].authHeader, "authorization");
  assertEquals(before.providers[1].authScheme, "Bearer");
  // A built-in's models are the price list's, so the app can offer them as choices.
  const sonnet = before.providers[0].models.find((m: { id: string }) => m.id === "claude-sonnet-5");
  assertEquals(sonnet?.price, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert(before.providers[1].models.some((m: { id: string }) => m.id === "gpt-5"));
  // And the thinking levels pi's catalogue says each takes, for the level pickers.
  assertEquals(sonnet?.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const created = await call(handler, "POST", "/v1/providers", {
    ...ENDPOINT,
    authHeader: "api-key",
    extraHeaders: { "x-org": "acme" },
  });
  assertEquals(created.status, 201);
  const body = await created.json();
  assertEquals(body.id, "groq");
  assertEquals(body.dialect, "openai-completions");
  assertEquals(body.builtin, false);
  assertEquals(body.archivedAt, null);
  assert(!("extraHeaders" in body), "an operator's headers are not the reader's business");
  assertEquals(body.authHeader, "api-key");
  assertEquals(body.authScheme, null, "a named header wants the bare value");

  const after = await (await call(handler, "GET", "/v1/providers", undefined, USER)).json();
  assertEquals(
    after.providers.map((p: { id: string }) => p.id),
    ["anthropic", "openai", "chatgpt-plan", "groq"],
  );
  assert(!after.providers.some((p: { extraHeaders?: unknown }) => "extraHeaders" in p));
  assertEquals(after.providers[3].authHeader, "api-key");
});

test("every route answers with an endpoint's models exactly as stored", async () => {
  // Nothing filled in on the way out — no thinking levels pi would default to — so a client that
  // saves back what any of these answered saves the declaration unchanged.
  const { handler } = makeApi();
  const declared = [
    { id: "unsaid" },
    { id: "not-reasoning", reasoning: false },
    { id: "reasoning", reasoning: true },
    { id: "levels-only", thinkingLevels: ["low", "max"] },
    { id: "reasoning-levels", reasoning: true, thinkingLevels: ["off", "medium", "xhigh"] },
    { id: "compat", reasoning: true, compat: { thinkingFormat: "ant-ling" } },
  ];
  const listed = async () =>
    (await (await call(handler, "GET", "/v1/providers", undefined, USER)).json()).providers
      .find((p: { id: string }) => p.id === "groq").models;
  const read = async () => (await (await call(handler, "GET", "/v1/providers/groq")).json()).models;

  const created = await call(handler, "POST", "/v1/providers", { ...ENDPOINT, models: declared });
  assertEquals(created.status, 201);
  assertEquals((await created.json()).models, declared);
  assertEquals(await listed(), declared);
  assertEquals(await read(), declared);

  // A PATCH of what the read answered changes nothing, and answers the same.
  const patched = await call(handler, "PATCH", "/v1/providers/groq", { models: await read() });
  assertEquals(patched.status, 200);
  assertEquals((await patched.json()).models, declared);
  assertEquals(await read(), declared);

  const archived = await call(handler, "POST", "/v1/providers/groq/archive");
  assertEquals(archived.status, 200);
  assertEquals((await archived.json()).models, declared);
  assertEquals(await listed(), declared);
});

test("an admin marks an endpoint's model as taking images, and can take it back", async () => {
  const { handler } = makeApi();
  const created = await call(handler, "POST", "/v1/providers", {
    ...ENDPOINT,
    models: [{ id: "llama-4", vision: true }, { id: "llama-4-mini" }],
  });
  assertEquals(created.status, 201);
  const models = async () =>
    (await (await call(handler, "GET", "/v1/providers/groq")).json()).models;
  assertEquals(await models(), [{ id: "llama-4", vision: true }, { id: "llama-4-mini" }]);

  // The PATCH replaces the list whole: the edit dialog sends every model back with its flag.
  const patched = await call(handler, "PATCH", "/v1/providers/groq", {
    models: [{ id: "llama-4", vision: false }, { id: "llama-4-mini", vision: true }],
  });
  assertEquals(patched.status, 200);
  await patched.body?.cancel();
  assertEquals(await models(), [
    { id: "llama-4", vision: false },
    { id: "llama-4-mini", vision: true },
  ]);
  const listed = await (await call(handler, "GET", "/v1/providers", undefined, USER)).json();
  assertEquals(listed.providers[3].models[1].vision, true, "every reader sees the flag");

  const bad = await call(handler, "PATCH", "/v1/providers/groq", {
    models: [{ id: "llama-4", vision: "yes" }],
  });
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});

test("one endpoint in full is an admin's read — the list's redaction lifted for the editor", async () => {
  const { handler } = makeApi();
  await (await call(handler, "POST", "/v1/providers", {
    ...ENDPOINT,
    authHeader: "api-key",
    extraHeaders: { "x-org": "acme" },
  })).body?.cancel();

  const detail = await (await call(handler, "GET", "/v1/providers/groq")).json();
  assertEquals(detail.id, "groq");
  assertEquals(detail.authHeader, "api-key");
  assertEquals(detail.authScheme, null);
  assertEquals(detail.extraHeaders, { "x-org": "acme" });
  assertEquals(detail.models, ENDPOINT.models, "everything the edit dialog prefills from");

  // A built-in resolves here like any other id: which kind it turns out to be is not a reason
  // to answer differently, and it has no static headers to report.
  const builtin = await (await call(handler, "GET", "/v1/providers/anthropic")).json();
  assertEquals(builtin.builtin, true);
  assertEquals(builtin.extraHeaders, {});
  assertEquals(builtin.authHeader, "x-api-key");

  const missing = await call(handler, "GET", "/v1/providers/nope");
  assertEquals(missing.status, 404);
  await missing.body?.cancel();

  // The whole reason this is a route of its own: the list is every signed-in user's, and
  // `extraHeaders` is the one field it holds back.
  const asUser = await call(handler, "GET", "/v1/providers/groq", undefined, USER);
  assertEquals(asUser.status, 403);
  assertEquals((await asUser.json()).code, FORBIDDEN);
});

test("registering: a duplicate is 409, a built-in's name is refused, and models are required", async () => {
  const { handler } = makeApi();
  assertEquals((await call(handler, "POST", "/v1/providers", ENDPOINT)).status, 201);

  const again = await call(handler, "POST", "/v1/providers", ENDPOINT);
  assertEquals(again.status, 409, "the id is what keys and policies point at — never an upsert");
  await again.body?.cancel();

  for (
    const [body, expected] of [
      [{ ...ENDPOINT, id: "anthropic" }, "reserved"],
      [{ ...ENDPOINT, id: "Groq Cloud" }, "slug"],
      [{ ...ENDPOINT, models: [] }, "model"],
      [{ ...ENDPOINT, models: [{ id: "a" }, { id: "a" }] }, "duplicate"],
      [{ ...ENDPOINT, extraHeaders: { "x-a": "one\r\nx-b: two" } }, "visible ASCII"],
    ] as Array<[unknown, string]>
  ) {
    const res = await call(handler, "POST", "/v1/providers", body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assert(((await res.json()).error as string).includes(expected));
  }
});

test("a provider key may only be registered against a live provider", async () => {
  const { handler } = makeApi();
  const orphan = await call(handler, "POST", "/v1/provider-keys", {
    ...CREATE,
    provider: "groq",
  });
  assertEquals(orphan.status, 400);
  await orphan.body?.cancel();

  await (await call(handler, "POST", "/v1/providers", ENDPOINT)).body?.cancel();
  const ok = await call(handler, "POST", "/v1/provider-keys", { ...CREATE, provider: "groq" });
  assertEquals(ok.status, 201);
  assertEquals((await ok.json()).provider, "groq");

  // Archived, the endpoint stops accepting new keys: one that could never spend is a mistake
  // worth catching at the keyboard, not at a run's boot.
  await (await call(handler, "POST", "/v1/providers/groq/archive")).body?.cancel();
  const late = await call(handler, "POST", "/v1/provider-keys", { ...CREATE, provider: "groq" });
  assertEquals(late.status, 400);
  assert(((await late.json()).error as string).includes("archived"));
});

test("patch and archive touch rows only: a built-in has none, and archiving is idempotent", async () => {
  const { handler, store } = makeApi();
  await (await call(handler, "POST", "/v1/providers", ENDPOINT)).body?.cancel();

  const patched = await call(handler, "PATCH", "/v1/providers/groq", {
    label: "Groq (EU)",
    models: [{ id: "llama-4-eu" }],
  });
  assertEquals(patched.status, 200);
  const body = await patched.json();
  assertEquals(body.label, "Groq (EU)");
  assertEquals(body.models, [{ id: "llama-4-eu" }]);
  assertEquals(body.baseUrl, ENDPOINT.baseUrl, "an absent field is left alone");

  for (const path of ["/v1/providers/anthropic", "/v1/providers/nope"]) {
    const res = await call(handler, "PATCH", path, { label: "mine now" });
    assertEquals(res.status, 404, path);
    await res.body?.cancel();
  }
  const emptyPatch = await call(handler, "PATCH", "/v1/providers/groq", {});
  assertEquals(emptyPatch.status, 400);
  await emptyPatch.body?.cancel();

  const archived = await call(handler, "POST", "/v1/providers/groq/archive");
  assertEquals(archived.status, 200);
  const at = (await archived.json()).archivedAt as string;
  assert(at !== null);

  // And an archived endpoint is not editable. Everything else treats archiving as a kill
  // switch — no new key, no credential, nothing forwarded — and there is deliberately no
  // un-archive path, so a silent 200 here would be an edit to something unusable.
  const late = await call(handler, "PATCH", "/v1/providers/groq", { label: "Groq (back?)" });
  assertEquals(late.status, 400);
  assert(((await late.json()).error as string).includes("archived"));
  assertEquals((await store.getCustomProvider("groq"))?.label, "Groq (EU)", "unchanged");

  const again = await call(handler, "POST", "/v1/providers/groq/archive");
  assertEquals((await again.json()).archivedAt, at, "idempotent: the first archiving counts");
  assert((await store.getCustomProvider("groq")) !== null, "archived, never deleted");

  for (const path of ["/v1/providers/openai/archive", "/v1/providers/nope/archive"]) {
    const res = await call(handler, "POST", path);
    assertEquals(res.status, 404, path);
    await res.body?.cancel();
  }
});

test("reading the provider list is any user's; writing one is an admin's", async () => {
  const { handler } = makeApi();
  await (await call(handler, "POST", "/v1/providers", ENDPOINT)).body?.cancel();
  assertEquals((await call(handler, "GET", "/v1/providers", undefined, USER)).status, 200);

  for (
    const [method, path, body] of [
      ["POST", "/v1/providers", { ...ENDPOINT, id: "other" }],
      ["PATCH", "/v1/providers/groq", { label: "mine now" }],
      ["POST", "/v1/providers/groq/archive"],
    ] as Array<[string, string, unknown?]>
  ) {
    const res = await call(handler, method, path, body, USER);
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).code, FORBIDDEN);
  }
});

test("without a master key the provider routes answer the same coded 503 as key CRUD", async () => {
  const routes = disabledProviderKeyRoutes({
    authenticate: (req) =>
      Promise.resolve(req.headers.get("authorization") ? null : unauthorized()),
  });
  const off = async (method: string, path: string) => {
    for (const r of routes as Route[]) {
      if (r.method !== method) continue;
      const match = r.pattern.exec(`http://control.test${path}`);
      if (!match) continue;
      return await r.handler(
        new Request(`http://control.test${path}`, {
          method,
          headers: { authorization: "Bearer someone" },
        }),
        {},
      );
    }
    return new Response("not found", { status: 404 });
  };
  for (
    const [method, path] of [
      ["GET", "/v1/providers"],
      ["GET", "/v1/providers/groq"],
      ["POST", "/v1/providers"],
      ["PATCH", "/v1/providers/groq"],
      ["POST", "/v1/providers/groq/archive"],
    ] as const
  ) {
    const res = await off(method, path);
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals((await res.json()).code, MODEL_ACCESS_DISABLED);
  }
});

// ── the base-URL guard ─────────────────────────────────────────────────────────────────────

test("a base URL that could reach the cluster, or lose half of itself, is refused", () => {
  // Fine: https, a path, a port, a public host.
  for (
    const ok of [
      "https://api.groq.com/openai/v1",
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "https://8.8.8.8:8443/v1",
      "https://models.example.com",
    ]
  ) {
    assertEquals(refuseModelEndpointUrl(ok, false), null, ok);
  }

  const refused: Array<[string, string]> = [
    ["http://api.groq.com/v1", "https"], // plain http, without the escape hatch
    ["ftp://api.groq.com/v1", "http(s)"],
    ["api.groq.com/v1", "absolute"], // no scheme at all
    ["https://user:pw@api.groq.com/v1", "credentials"],
    // The proxy appends the request's own path and search, so either would be silently lost.
    ["https://api.groq.com/v1?key=abc", "query"],
    ["https://api.groq.com/v1#frag", "fragment"],
    // Everything that is the deployment itself. 169.254.169.254 above all: the metadata server
    // is the address an SSRF is usually after.
    ["https://127.0.0.1/v1", "private"],
    ["https://localhost:8080/v1", "private"],
    ["https://vllm.localhost/v1", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://10.4.2.1/v1", "private"],
    ["https://172.16.0.9/v1", "private"],
    ["https://172.31.255.1/v1", "private"],
    ["https://192.168.1.10/v1", "private"],
    ["https://0.0.0.0/v1", "private"],
    ["https://[::1]:9000/v1", "private"],
    ["https://[fd00::1]/v1", "private"],
    ["https://[fe80::1]/v1", "private"],
    ["https://[::ffff:127.0.0.1]/v1", "private"],
    // Carrier-grade NAT: the NetworkPolicy excepts 100.64/10, so an endpoint here would
    // register and then hang on every run rather than be refused at the keyboard.
    ["https://100.64.0.1/v1", "private"],
    ["https://100.127.255.254/v1", "private"],
    // An IPv4 address hidden inside an IPv6 literal — NAT64 and 6to4 both spell the metadata
    // server this way, and no rule about `169.254.…` would ever see it.
    ["https://[64:ff9b::a9fe:a9fe]/v1", "private"],
    ["https://[2002:a9fe:a9fe::]/v1", "private"],
  ];
  for (const [url, expected] of refused) {
    const refusal = refuseModelEndpointUrl(url, false);
    assert(refusal !== null, `${url} must be refused`);
    assert(refusal.includes(expected), `${url}: ${refusal}`);
  }

  // RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS=1 is the LAN vLLM escape hatch: it opens the private
  // ADDRESS rule, and plain http along with it — but only for a private address.
  for (const url of ["http://192.168.1.10:8000/v1", "http://[fd00::1]:8000/v1"]) {
    assertEquals(refuseModelEndpointUrl(url, true), null, url);
  }
  assertEquals(refuseModelEndpointUrl("https://vllm.lan:8000/v1", true), null);
  // The two rules used to share the switch, so the flag a LAN vLLM needs also made this
  // registrable — and the sealed provider key then crossed the public internet in cleartext.
  assertEquals(refuseModelEndpointUrl("http://10.4.2.1:8000/v1", true), null);
  assertEquals(refuseModelEndpointUrl("http://[fd00::1]/v1", true), null);
  // Not globally routable, so refused without the flag, but not a private network either: the
  // 6to4 relay and Teredo are reached across the public internet, so http to them stays refused.
  for (
    const url of [
      "http://api.some-gateway.example.com/v1",
      "http://vllm.lan:8000/v1",
      "http://192.88.99.1/v1",
      "http://[2001:0:4136:e378::1]/v1",
    ]
  ) {
    const refusal = refuseModelEndpointUrl(url, true);
    assert(refusal !== null, `${url} must still be refused`);
    assert(refusal.includes("https"), refusal);
  }
  // It is not a licence to write a broken URL, though.
  assert(refuseModelEndpointUrl("https://vllm.lan/v1?k=1", true) !== null);

  // 172.32 is NOT in 172.16/12, 100.63 and 100.128 are outside the CGNAT range, and a public v4
  // in v6-mapped form is still public.
  assertEquals(isPrivateModelEndpointHost("172.32.0.1"), false);
  assertEquals(isPrivateModelEndpointHost("172.15.0.1"), false);
  assertEquals(isPrivateModelEndpointHost("100.63.255.255"), false);
  assertEquals(isPrivateModelEndpointHost("100.128.0.1"), false);
  assertEquals(isPrivateModelEndpointHost("::ffff:8.8.8.8"), false);
  assertEquals(isPrivateModelEndpointHost("2606:4700::1111"), false);
  assertEquals(isPrivateModelEndpointHost("api.groq.com"), false);
});

test("the platform policy may not be set against an archived model endpoint", async () => {
  // The key is live; the endpoint behind it is not. Without this the policy was accepted and
  // every platform mint then failed on `resolvePlatformPolicy`'s definitive refusal — memory
  // consolidation goes dark, and nothing at the keyboard said why.
  const { handler } = makeApi();
  await (await call(handler, "POST", "/v1/providers", ENDPOINT)).body?.cancel();
  const created = await (await call(handler, "POST", "/v1/provider-keys", {
    ...CREATE,
    provider: "groq",
  })).json();

  const live = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: created.id,
    model: "llama-4",
  });
  assertEquals(live.status, 200);
  await live.body?.cancel();

  await (await call(handler, "POST", "/v1/providers/groq/archive")).body?.cancel();
  const refused = await call(handler, "PUT", "/v1/platform-model-policy", {
    providerKeyId: created.id,
    model: "llama-4",
  });
  assertEquals(refused.status, 400);
  const error = (await refused.json()).error as string;
  assert(error.includes("model endpoint"), error);
  assert(error.includes("archived"), error);
});

test("the base-URL guard reads its escape hatch from the environment, per parse", async () => {
  const { handler } = makeApi();
  const lan = { ...ENDPOINT, id: "vllm", baseUrl: "http://192.168.1.10:8000/v1" };
  const refused = await call(handler, "POST", "/v1/providers", lan);
  assertEquals(refused.status, 400);
  await refused.body?.cancel();

  process.env.RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS = "1";
  try {
    const allowed = await call(handler, "POST", "/v1/providers", lan);
    assertEquals(allowed.status, 201, "a LAN vLLM is the only reason the knob exists");
    assertEquals((await allowed.json()).baseUrl, lan.baseUrl);
  } finally {
    delete process.env.RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS;
  }
});

test("a base URL whose NAME resolves inside the network is refused at registration", async () => {
  // `169.254.169.254.nip.io` is the metadata server under a public-looking name: the literal
  // check never sees an address, so the name is resolved.
  const dns: Record<string, string[]> = {
    "169.254.169.254.nip.io": ["169.254.169.254"],
    "split.example.com": ["93.184.216.34", "10.0.0.7"],
  };
  const { handler, store } = makeApi({
    resolveHost: (host) => Promise.resolve(dns[host] ?? []),
  });
  for (const host of Object.keys(dns)) {
    const res = await call(handler, "POST", "/v1/providers", {
      ...ENDPOINT,
      baseUrl: `https://${host}/v1`,
    });
    assertEquals(res.status, 400, host);
    assert(((await res.json()).error as string).includes("private or local"), host);
  }
  assertEquals(await store.listCustomProviders(), []);
  // A name that does not resolve (yet, or right now) is not one that points inside.
  const nowhere = await call(handler, "POST", "/v1/providers", {
    ...ENDPOINT,
    id: "later",
    baseUrl: "https://does-not-resolve.example/v1",
  });
  assertEquals(nowhere.status, 201);

  // An edit is held to it too.
  const ok = makeApi();
  assertEquals((await call(ok.handler, "POST", "/v1/providers", ENDPOINT)).status, 201);
  const moved = makeApi({
    store: ok.store,
    resolveHost: (host) => Promise.resolve(dns[host] ?? ["93.184.216.34"]),
  });
  const patched = await call(moved.handler, "PATCH", `/v1/providers/${ENDPOINT.id}`, {
    baseUrl: "https://169.254.169.254.nip.io/v1",
  });
  assertEquals(patched.status, 400);

  // The escape hatch opens it, as it opens a literal.
  process.env.RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS = "1";
  try {
    const allowed = await call(handler, "POST", "/v1/providers", {
      ...ENDPOINT,
      id: "lan",
      baseUrl: "https://split.example.com/v1",
    });
    assertEquals(allowed.status, 201);
  } finally {
    delete process.env.RYPH_ALLOW_PRIVATE_MODEL_ENDPOINTS;
  }
});
