// Sealed secrets over the real store and the real crypto: a provider key's secret is bound to the
// key, its provider and its endpoint's request shape; changing the shape drops the secret until it
// is entered again.

import { test } from "bun:test";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { eq } from "drizzle-orm";
import { importMasterKey } from "@ryph/sealed";
import { drizzleKeyStore } from "../src/adapters/store/drizzle.ts";
import * as schema from "../src/adapters/store/db/schema.ts";
import { BUILTIN_PROVIDERS, customProviderSpec, endpointShape } from "../src/core/registry.ts";
import { makeProxySealer, providerKeyBinding } from "../src/core/sealing.ts";
import {
  CredentialRefusedError,
  makeCredentialIssuer,
  resolveProvider,
} from "../src/core/service.ts";
import { makeSpendMeter } from "../src/core/spend_meter.ts";
import { ENDPOINT_MISCONFIGURED, makeProxyHandler } from "../src/http/proxy.ts";
import { providerKeyRoutes, SECRET_REQUIRED } from "../src/http/routes.ts";
import type { Route } from "@ryph/shared/http";
import type { KeyStore } from "../src/ports/key_store.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { publicDns } from "./dns.ts";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const MASTER_HEX = "5e".repeat(32);
const T0 = "2026-01-01T00:00:00.000Z";
const BASE_URL = "https://api.groq.com/openai/v1";

async function slice() {
  const handle = await makeTestDb();
  const store = drizzleKeyStore(handle);
  const master = await importMasterKey(MASTER_HEX);
  const sealer = makeProxySealer(master);
  const now = () => new Date(T0);
  const routes = providerKeyRoutes({
    resolveHost: publicDns,
    store,
    encrypt: sealer.sealKey,
    authenticate: () => Promise.resolve(null),
    authenticateManage: () => Promise.resolve(null),
    now,
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://control.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const r of routes as Route[]) {
      const match = r.method === req.method ? r.pattern.exec(req.url) : null;
      if (!match) continue;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.pathname.groups)) if (v) params[k] = v;
      return await r.handler(req, params);
    }
    throw new Error(`no route for ${method} ${path}`);
  };
  const upstream: Array<{ url: string; auth: string | null; headers: Headers }> = [];
  /** Every diag line the proxy wrote, as text — what a test holds a secret's absence against. */
  const logs: string[] = [];
  const log = (event: string, data?: Record<string, unknown>) =>
    logs.push(`${event} ${JSON.stringify(data ?? {})}`);
  const proxy = makeProxyHandler({
    resolveHost: publicDns,
    store,
    decrypt: sealer.openKey,
    now,
    diag: { debug: log, warn: log },
    limits: { meter: makeSpendMeter({ backstopMs: 0 }), gauge: null },
    upstreamFetch: (url, init) => {
      const headers = new Headers(init.headers);
      upstream.push({ url: String(url), auth: headers.get("authorization"), headers });
      return Promise.resolve(Response.json({ ok: true }));
    },
  });
  const issuer = makeCredentialIssuer({ store, now, proxyUrl: "http://proxy.test", ttlMs: 60_000 });
  let run = 0;
  /** A run's credential for the key, and one completion call through the proxy with it. */
  const callWith = async (key: { id: string; provider: string }) => {
    const env = await issuer.issue({
      runId: `r-${++run}`,
      agentId: "a-1",
      taskId: "t-1",
      providerKeyId: key.id,
      provider: key.provider,
      allowedModels: "*",
    });
    return await proxy(
      new Request("http://proxy.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
        },
        body: JSON.stringify({ model: "llama-4" }),
      }),
    );
  };
  return { handle, store, master, sealer, api, upstream, callWith, issuer, proxy, logs };
}

const ENDPOINT = {
  id: "groq",
  label: "Groq",
  baseUrl: BASE_URL,
  models: [{ id: "llama-4" }],
};

test("a key sealed through the routes is v2, opens at the proxy, and not once its endpoint is rewritten underneath", async () => {
  const { handle, store, api, upstream, callWith } = await slice();
  assertEquals((await api("POST", "/v1/providers", ENDPOINT)).status, 201);
  const created = await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-the-real-secret",
  });
  assertEquals(created.status, 201);
  const key = await created.json();
  assertEquals(key.needsSecret, false);
  const row = (await store.getProviderKey(key.id))!;
  assert(row.encryptedSecret.startsWith("v2."));

  assertEquals((await callWith(key)).status, 200);
  assertEquals(upstream.at(-1)?.auth, "Bearer gsk-the-real-secret");
  assert(upstream.at(-1)!.url.startsWith(BASE_URL));

  // A database writer without the key repoints the endpoint: the secret does not follow.
  await handle.db.update(schema.customProviders)
    .set({ baseUrl: "https://attacker.example.com/v1" })
    .where(eq(schema.customProviders.id, "groq"));
  const sent = upstream.length;
  const refused = await callWith(key);
  assertEquals(refused.status, 409);
  assertEquals((await refused.json()).code, SECRET_REQUIRED, "the same answer as no secret");
  assertEquals(upstream.length, sent, "nothing was sent anywhere");
});

test("the binding names the key, its provider and a custom endpoint's address", async () => {
  const { sealer } = await slice();
  const groq = customProviderSpec({
    ...ENDPOINT,
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const key = { id: "pk-1", provider: "groq" };
  const sealed = await sealer.sealKey("gsk-secret", providerKeyBinding(key, groq));
  assertEquals(await sealer.openKey(sealed, providerKeyBinding(key, groq)), "gsk-secret");
  const moved = { ...groq, baseUrl: "https://elsewhere.example.com/v1" };
  await assertRejects(() => sealer.openKey(sealed, providerKeyBinding(key, moved)));
  // The rest of the request shape is bound too: the header the key rides in, its scheme, and the
  // static headers beside it.
  for (
    const changed of [
      { ...groq, auth: { header: "x-api-key", scheme: null } },
      { ...groq, auth: { header: "authorization", scheme: "Token" } },
      { ...groq, extraHeaders: { "x-tenant": "theirs" } },
    ]
  ) {
    await assertRejects(() => sealer.openKey(sealed, providerKeyBinding(key, changed)));
  }
  // Header order is not part of it.
  const two = { ...groq, extraHeaders: { "x-a": "1", "x-b": "2" } };
  const twoSealed = await sealer.sealKey("gsk-secret", providerKeyBinding(key, two));
  assertEquals(
    await sealer.openKey(
      twoSealed,
      providerKeyBinding(key, { ...groq, extraHeaders: { "x-b": "2", "x-a": "1" } }),
    ),
    "gsk-secret",
  );
  await assertRejects(() =>
    sealer.openKey(sealed, providerKeyBinding({ ...key, id: "pk-2" }, groq))
  );
  await assertRejects(() =>
    sealer.openKey(
      sealed,
      providerKeyBinding({ ...key, provider: "openai" }, BUILTIN_PROVIDERS.openai),
    )
  );
  // A built-in binds no address: its address is code.
  assertEquals(providerKeyBinding({ id: "pk-3", provider: "openai" }, BUILTIN_PROVIDERS.openai), {
    id: "pk-3",
    provider: "openai",
    endpoint: null,
  });
  // The two classes never open each other's values.
  await assertRejects(() => sealer.openVerifier(sealed, providerKeyBinding(key, groq)));
});

test("moving an endpoint's address drops its keys' secrets until they are entered again", async () => {
  const { store, api, upstream, callWith } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-old-secret",
  })).json();
  const other = await (await api("POST", "/v1/provider-keys", {
    provider: "anthropic",
    label: "untouched",
    secret: "sk-ant-untouched",
  })).json();

  // A relabel moves nothing.
  assertEquals((await api("PATCH", "/v1/providers/groq", { label: "Groq Cloud" })).status, 200);
  assertEquals((await store.getProviderKey(key.id))!.encryptedSecret.startsWith("v2."), true);

  const NEW_URL = "https://api.groq.example.com/v1";
  assertEquals((await api("PATCH", "/v1/providers/groq", { baseUrl: NEW_URL })).status, 200);
  const listed = (await (await api("GET", "/v1/provider-keys")).json()).providerKeys as Array<
    { id: string; needsSecret: boolean }
  >;
  assertEquals(listed.find((k) => k.id === key.id)?.needsSecret, true);
  assertEquals(listed.find((k) => k.id === other.id)?.needsSecret, false, "another provider's key");
  assertEquals((await store.getProviderKey(key.id))!.encryptedSecret, "");

  // No run can be issued against it, and a credential already out is refused with the reason.
  await assertRejects(() => callWith(key), CredentialRefusedError, "entered again");

  // Entering it again (a rotation) seals it for the new address.
  const rotated = await api("PATCH", `/v1/provider-keys/${key.id}`, { secret: "gsk-new-secret" });
  assertEquals(rotated.status, 200);
  assertEquals((await rotated.json()).needsSecret, false);
  assertEquals((await callWith(key)).status, 200);
  assertEquals(upstream.at(-1)?.auth, "Bearer gsk-new-secret");
  assert(upstream.at(-1)!.url.startsWith(NEW_URL));
});

test("a credential already out when the address moves is refused with the reason", async () => {
  const { api, issuer, proxy, upstream } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-old-secret",
  })).json();
  const env = await issuer.issue({
    runId: "r-early",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: key.id,
    provider: "groq",
    allowedModels: "*",
  });
  await api("PATCH", "/v1/providers/groq", { baseUrl: "https://api.groq.example.com/v1" });
  const res = await proxy(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
      },
      body: JSON.stringify({ model: "llama-4" }),
    }),
  );
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, SECRET_REQUIRED);
  assertEquals(upstream.length, 0);
});

test("a rotation sealed for the old address while the endpoint moved is refused, and the save says so", async () => {
  const { store, api } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-old-secret",
  })).json();
  // The endpoint moves between the rotation's seal and its write.
  const realWrite = store.writeProviderKeySealedFor.bind(store);
  store.writeProviderKeySealedFor = async (sealedFor, write) => {
    await store.updateCustomProvider("groq", {
      baseUrl: "https://moved.example.com/v1",
      updatedAt: T0,
    });
    return await realWrite(sealedFor, write);
  };
  const res = await api("PATCH", `/v1/provider-keys/${key.id}`, { secret: "gsk-raced-secret" });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, SECRET_REQUIRED);
  const row = (await store.getProviderKey(key.id))!;
  assertEquals(row.encryptedSecret, "", "the move dropped the old secret, the rotation wrote none");
  assertEquals(row.last4, key.last4, "nothing of the refused rotation landed");
});

test("a key created while its endpoint moved is refused, and no row is left behind", async () => {
  const { store, api } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const realWrite = store.writeProviderKeySealedFor.bind(store);
  store.writeProviderKeySealedFor = async (sealedFor, write) => {
    await store.updateCustomProvider("groq", { authHeader: "x-api-key", updatedAt: T0 });
    return await realWrite(sealedFor, write);
  };
  const res = await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-raced-secret",
  });
  assertEquals(res.status, 409);
  assertEquals((await res.json()).code, SECRET_REQUIRED);
  assertEquals((await store.listProviderKeys()).length, 0);
});

test("a rotation that lands just before the endpoint moves is dropped by the move", async () => {
  const { store, api } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-old-secret",
  })).json();
  // The other order: the move starts as soon as the rotation's guarded write has committed.
  const realWrite = store.writeProviderKeySealedFor.bind(store);
  const pending: { move?: ReturnType<KeyStore["updateCustomProvider"]> } = {};
  store.writeProviderKeySealedFor = async (sealedFor, write) => {
    const written = await realWrite(sealedFor, write);
    pending.move = store.updateCustomProvider("groq", {
      baseUrl: "https://moved.example.com/v1",
      updatedAt: T0,
    });
    return written;
  };
  assertEquals(
    (await api("PATCH", `/v1/provider-keys/${key.id}`, { secret: "gsk-new-secret" })).status,
    200,
  );
  assertEquals((await pending.move)?.keysCleared, 1);
  assertEquals((await store.getProviderKey(key.id))!.encryptedSecret, "");
});

// PGlite runs every query on one session, so this passes with the FOR SHARE / FOR UPDATE locks
// deleted: it pins the outcome, not the locks. tests/locks_postgres_test.ts holds the locks on a
// real Postgres (RYPH_TEST_POSTGRES_URL).
test("the guarded write and the move serialise on the endpoint row, whichever starts first", async () => {
  const { store, sealer, api } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-old-secret",
  })).json();
  for (let round = 0; round < 20; round++) {
    const before = (await resolveProvider(store, "groq"))!;
    const sealed = await sealer.sealKey(`gsk-${round}`, providerKeyBinding(key, before));
    const [written] = await Promise.all([
      store.writeProviderKeySealedFor(
        { providerId: "groq", shape: endpointShape(before) },
        { id: key.id, patch: { encryptedSecret: sealed, updatedAt: T0 } },
      ),
      store.updateCustomProvider("groq", {
        baseUrl: `https://moved-${round}.example.com/v1`,
        updatedAt: T0,
      }),
    ]);
    // Either way — refused after the move, or written first and dropped by it — the key never
    // holds a secret sealed for an address the endpoint has left.
    assertEquals(
      (await store.getProviderKey(key.id))!.encryptedSecret,
      "",
      `moved: ${written.moved}`,
    );
  }
});

// ── canonical endpoint shape ────────────────────────────────────────────────────────────────

test("re-saving an endpoint's headers in another case or order never clears its keys", async () => {
  const { store, api, callWith, upstream } = await slice();
  const created = await api("POST", "/v1/providers", {
    ...ENDPOINT,
    authHeader: "X-Api-Key",
    authScheme: null,
    extraHeaders: { "X-Org": " acme ", "X-Team": "core" },
  });
  assertEquals(created.status, 201);
  const stored = (await store.getCustomProvider("groq"))!;
  assertEquals(stored.authHeader, "x-api-key", "names are stored lower-cased");
  assertEquals(stored.extraHeaders, { "x-org": "acme", "x-team": "core" }, "values trimmed");
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-secret",
  })).json();

  for (
    const same of [
      {
        authHeader: "x-api-key",
        authScheme: null,
        extraHeaders: { "x-team": "core", "x-org": "acme" },
      },
      { authHeader: "X-API-KEY", extraHeaders: { "X-Team": "core ", "X-ORG": "acme" } },
      { baseUrl: ` ${BASE_URL} ` },
    ]
  ) {
    const res = await api("PATCH", "/v1/providers/groq", same);
    assertEquals(res.status, 200, JSON.stringify(same));
    assertEquals((await res.json()).keysCleared, 0, JSON.stringify(same));
    assert((await store.getProviderKey(key.id))!.encryptedSecret.startsWith("v2."));
  }
  assertEquals((await callWith(key)).status, 200);
  assertEquals(upstream.at(-1)?.headers.get("x-api-key"), "gsk-secret");

  // A row written before names were stored lower-cased compares equal to its re-save too.
  await store.updateCustomProvider("groq", {
    extraHeaders: { "X-Org": "acme", "X-Team": "core" },
    updatedAt: T0,
  });
  assert((await store.getProviderKey(key.id))!.encryptedSecret.startsWith("v2."));

  // A real change is reported with how many keys it cleared.
  const changed = await api("PATCH", "/v1/providers/groq", { extraHeaders: { "x-org": "other" } });
  assertEquals((await changed.json()).keysCleared, 1);
});

test("two header names that differ only in case are refused", async () => {
  const { api } = await slice();
  const res = await api("POST", "/v1/providers", {
    ...ENDPOINT,
    extraHeaders: { "X-Org": "a", "x-org": "b" },
  });
  assertEquals(res.status, 400);
});

// ── header policy ───────────────────────────────────────────────────────────────────────────

test("an auth header that says where the request goes is refused", async () => {
  const { api } = await slice();
  for (const authHeader of ["Host", "x-forwarded-host", "Forwarded"]) {
    const res = await api("POST", "/v1/providers", { ...ENDPOINT, authHeader });
    assertEquals(res.status, 400, authHeader);
  }
});

test("a custom endpoint never forwards the run's own forwarding headers", async () => {
  const { api, issuer, proxy, upstream } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-secret",
  })).json();
  const env = await issuer.issue({
    runId: "r-fwd",
    agentId: "a-1",
    taskId: "t-1",
    providerKeyId: key.id,
    provider: "groq",
    allowedModels: "*",
  });
  const res = await proxy(
    new Request("http://proxy.test/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RYPH_MODEL_API_KEY}`,
        "x-forwarded-host": "attacker.example.com",
        "x-forwarded-for": "10.0.0.1",
        forwarded: "host=attacker.example.com",
        "x-real-ip": "10.0.0.1",
        "x-kept": "yes",
      },
      body: JSON.stringify({ model: "llama-4" }),
    }),
  );
  assertEquals(res.status, 200);
  const sent = upstream.at(-1)!.headers;
  for (const name of ["x-forwarded-host", "x-forwarded-for", "forwarded", "x-real-ip"]) {
    assertEquals(sent.get(name), null, name);
  }
  assertEquals(sent.get("x-kept"), "yes");
});

test("a malformed header stored in the database is a coded 502, never a 500", async () => {
  const { handle, api, callWith, upstream } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-secret",
  })).json();
  const brokenRows: Array<{ authHeader?: string; extraHeaders?: Record<string, string> }> = [
    { extraHeaders: { " Host": "attacker.example.com" } },
    { extraHeaders: { "x-ok": "a\r\nHost: attacker.example.com" } },
    { authHeader: "bad header" },
    { authHeader: "host" },
  ];
  for (const broken of brokenRows) {
    await handle.db.update(schema.customProviders)
      .set({ authHeader: "authorization", extraHeaders: {}, ...broken })
      .where(eq(schema.customProviders.id, "groq"));
    const sent = upstream.length;
    // Issued before the shape changed would not matter: the refusal comes first.
    const res = await callWith(key);
    assertEquals(res.status, 502, JSON.stringify(broken));
    assertEquals((await res.json()).code, ENDPOINT_MISCONFIGURED, JSON.stringify(broken));
    assertEquals(upstream.length, sent);
  }
});

/** Runs `work` with console's writers captured, and answers what they were given as text. */
async function capturingConsole(work: () => Promise<void>): Promise<string> {
  const seen: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...args: unknown[]) =>
    seen.push(
      args.map((a) => a instanceof Error ? `${a.message} ${a.stack}` : String(a)).join(" "),
    );
  console.error = grab;
  console.warn = grab;
  console.log = grab;
  try {
    await work();
  } finally {
    Object.assign(console, saved);
  }
  return seen.join("\n");
}

test("header values the proxy cannot send as given are refused at the API", async () => {
  const { api } = await slice();
  const refused: Array<[string, Record<string, unknown>]> = [
    ["a full-width space inside the scheme", { authScheme: "Bea\u3000rer" }],
    ["a scheme of two words", { authScheme: "Bearer token" }],
    ["a non-ASCII static header value", { extraHeaders: { "x-org": "caf\u00e9" } }],
    ["a zero-width space in a static header value", { extraHeaders: { "x-org": "a\u200bb" } }],
    ["two spaces inside a static header value", { extraHeaders: { "x-org": "a  b" } }],
    ["a framing header", { extraHeaders: { "transfer-encoding": "chunked" } }],
    ["a proxy header", { extraHeaders: { "Proxy-Authorization": "Basic x" } }],
    ["a proxy header as the auth header", { authHeader: "proxy-authorization" }],
  ];
  for (const [what, fields] of refused) {
    const res = await api("POST", "/v1/providers", { ...ENDPOINT, ...fields });
    assertEquals(res.status, 400, what);
  }
  const ok = await api("POST", "/v1/providers", {
    ...ENDPOINT,
    extraHeaders: { "x-org": "one two" },
  });
  assertEquals(ok.status, 201);
  for (const secret of ["gsk-\u200bsecret", "gsk-s\u3000ecret", "gsk-caf\u00e9-secret"]) {
    const res = await api("POST", "/v1/provider-keys", { provider: "groq", label: "k", secret });
    assertEquals(res.status, 400, JSON.stringify(secret));
  }
});

test("the scheme sent is the canonical one the key was sealed for, not the stored spelling", async () => {
  const { handle, api, callWith, upstream } = await slice();
  await api("POST", "/v1/providers", { ...ENDPOINT, extraHeaders: { "x-org": "acme" } });
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-secret",
  })).json();
  // Written straight into the database: a full-width space trimmed off is the same scheme to the
  // binding, so the key opens — and it must go out as exactly that scheme.
  await handle.db.update(schema.customProviders)
    .set({ authScheme: "Bearer\u3000", extraHeaders: { "X-Org": " acme " } })
    .where(eq(schema.customProviders.id, "groq"));
  const res = await callWith(key);
  assertEquals(res.status, 200);
  assertEquals(upstream.at(-1)!.auth, "Bearer gsk-secret");
  assertEquals(upstream.at(-1)!.headers.get("x-org"), "acme");
});

test("a header the proxy cannot send never puts the secret in a log", async () => {
  const { handle, api, callWith, upstream, sealer, store, logs } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-valid-secret",
  })).json();
  const row = (await store.getProviderKey(key.id))!;
  const spec = customProviderSpec((await store.getCustomProvider("groq"))!);

  // A secret that opens but cannot ride a header — sealed for this very row and shape, as one
  // stored before the API refused it would be.
  const SECRET = "gsk-zero\u200bwidth-SECRET";
  await store.updateProviderKey(key.id, {
    encryptedSecret: await sealer.sealKey(SECRET, providerKeyBinding(row, spec)),
    updatedAt: T0,
  });
  let res: Response | null = null;
  const printed = await capturingConsole(async () => {
    res = await callWith(key);
  });
  assertEquals(res!.status, 409);
  assertEquals(res!.headers.get("x-should-retry"), "false");
  const body = await res!.text();
  assertEquals(JSON.parse(body).code, SECRET_REQUIRED);
  const sent = upstream.length;

  // A scheme with a full-width space INSIDE it, and a static header value past Latin-1: each a
  // coded 502 before anything is set, the key's secret nowhere.
  const printedToo = await capturingConsole(async () => {
    for (
      const broken of [{ authScheme: "Bea\u3000rer" }, { extraHeaders: { "x-org": "a\u3000x" } }]
    ) {
      await handle.db.update(schema.customProviders)
        .set({ authScheme: "Bearer", extraHeaders: {}, ...broken })
        .where(eq(schema.customProviders.id, "groq"));
      const refused = await callWith(key);
      assertEquals(refused.status, 502, JSON.stringify(broken));
      assertEquals(refused.headers.get("x-should-retry"), "false");
      assertEquals((await refused.json()).code, ENDPOINT_MISCONFIGURED);
    }
  });
  assertEquals(upstream.length, sent, "nothing went upstream");
  for (const text of [printed, printedToo, body, logs.join("\n")]) {
    assert(!text.includes("SECRET"), text);
    assert(!text.includes("gsk-"), text);
  }
});

test("a custom endpoint's auth header, scheme and extra headers are part of what its keys are sealed for", async () => {
  const { store, api, callWith, upstream } = await slice();
  await api("POST", "/v1/providers", ENDPOINT);
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-the-secret",
  })).json();
  for (
    const patch of [
      { authHeader: "x-api-key" },
      { authScheme: "Token" },
      { extraHeaders: { "x-tenant": "t-1" } },
    ]
  ) {
    assertEquals(
      (await api("PATCH", `/v1/provider-keys/${key.id}`, { secret: "gsk-again" })).status,
      200,
    );
    assert((await store.getProviderKey(key.id))!.encryptedSecret.startsWith("v2."));
    assertEquals((await api("PATCH", "/v1/providers/groq", patch)).status, 200);
    assertEquals((await store.getProviderKey(key.id))!.encryptedSecret, "", JSON.stringify(patch));
  }
  // Entered again for the new shape, it is sent the new way.
  await api("PATCH", `/v1/provider-keys/${key.id}`, { secret: "gsk-final" });
  assertEquals((await callWith(key)).status, 200);
  assertEquals(upstream.at(-1)?.headers.get("x-api-key"), "Token gsk-final");
  assertEquals(upstream.at(-1)?.headers.get("x-tenant"), "t-1");
});

test("extra headers may not say where a request goes, nor stand in for the key's header", async () => {
  const { handle, api, callWith, upstream } = await slice();
  for (const name of ["Host", "x-forwarded-host", "Forwarded", "x-real-ip", "authorization"]) {
    const res = await api("POST", "/v1/providers", {
      ...ENDPOINT,
      extraHeaders: { [name]: "attacker.example.com" },
    });
    assertEquals(res.status, 400, name);
  }
  // On a named auth header, that header is the one refused.
  assertEquals(
    (await api("POST", "/v1/providers", {
      ...ENDPOINT,
      authHeader: "api-key",
      extraHeaders: { "API-Key": "x" },
    })).status,
    400,
  );
  assertEquals((await api("POST", "/v1/providers", ENDPOINT)).status, 201);
  assertEquals(
    (await api("PATCH", "/v1/providers/groq", { extraHeaders: { host: "attacker.example.com" } }))
      .status,
    400,
  );
  // An edit to the auth header is held against the extra headers already stored.
  await api("PATCH", "/v1/providers/groq", { extraHeaders: { "x-tenant": "t" } });
  assertEquals((await api("PATCH", "/v1/providers/groq", { authHeader: "x-tenant" })).status, 400);

  // A row written straight into the database is refused at the forward, before anything is sent.
  const key = await (await api("POST", "/v1/provider-keys", {
    provider: "groq",
    label: "groq key",
    secret: "gsk-the-secret",
  })).json();
  await handle.db.update(schema.customProviders)
    .set({ extraHeaders: { "x-tenant": "t", Host: "attacker.example.com" } })
    .where(eq(schema.customProviders.id, "groq"));
  const sent = upstream.length;
  assertEquals((await callWith(key)).status, 502);
  assertEquals(upstream.length, sent);
});
