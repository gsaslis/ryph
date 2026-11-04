// The ChatGPT plan's management surface through `setup()`, as a deployment mounts it: starting a
// sign-in, the loopback listener finishing it, the key list's `plan`, the provider list's
// included models, refreshing the models, archiving (which revokes), the doors a plan key does
// not have, and all of it switched off on a deployment that is not local.

import { test } from "bun:test";
import { type AddressInfo, createServer, type Server } from "node:net";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { importMasterKey } from "@ryph/sealed";
import { forbidden } from "@ryph/auth";
import { setup } from "../src/setup.ts";
import { CredentialRefusedError } from "../src/core/service.ts";
import type { KeyStore } from "../src/ports/key_store.ts";
import { makeCallbackListener, MAX_PLAN_SIGN_IN_BODY_BYTES } from "../src/http/chatgpt_plan.ts";
import { disabledProviderKeyRoutes } from "../src/http/routes.ts";
import type { Route } from "@ryph/shared/http";
import { unauthorized } from "@ryph/sealed";
import { CLIENT_ID, EMAIL, type FakeOpenAi, makeFakeOpenAi } from "./fake_openai.ts";
import { memoryKeyStore } from "./memory_store.ts";
import { publicDns } from "./dns.ts";

/** A plain TCP listener on a free loopback port, holding it until closed. */
function listenOnLoopback(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const ADMIN = "admin-secret";
const USER = "user-secret";

function router(routes: Route[]) {
  return async (req: Request): Promise<Response> => {
    for (const r of routes) {
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
}

async function makeApi(
  opts: { local?: boolean; port?: number; store?: KeyStore; fake?: FakeOpenAi } = {},
) {
  const fake = opts.fake ?? await makeFakeOpenAi();
  const store = opts.store ?? memoryKeyStore();
  const gate = (req: Request, adminsOnly: boolean) => {
    const presented = req.headers.get("authorization");
    if (presented === `Bearer ${ADMIN}`) return Promise.resolve(null);
    if (presented === `Bearer ${USER}`) {
      return Promise.resolve(
        adminsOnly
          ? new Response(JSON.stringify(forbidden("models:manage")), { status: 403 })
          : null,
      );
    }
    return Promise.resolve(unauthorized());
  };
  const built = setup({
    resolveHost: publicDns,
    store,
    masterKey: await importMasterKey("11".repeat(32)),
    authenticate: (req) => gate(req, false),
    authenticateManage: (req) => gate(req, true),
    authenticateUsage: (req) => gate(req, true),
    authenticateRunRead: (req) => gate(req, true),
    proxyUrl: "http://proxy.test",
    virtualKeyTtlMs: 60_000,
    limits: { backstopMs: 0, ceiling: null },
    now: () => new Date(),
    proxyDiag: { debug() {}, warn() {} },
    openAiAccounts: fake.accounts,
    ...(opts.local === false ? {} : {
      chatgptPlan: { callbackPort: opts.port ?? 0 },
    }),
  });
  const handler = router(built.routes);
  const call = (method: string, path: string, body?: unknown, token = ADMIN) =>
    handler(
      new Request(`http://proxy.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { built, call, store, fake };
}

test("plan optional body is capped before a sign-in opens its listener", async () => {
  const { built } = await makeApi();
  const handler = router(built.routes);
  const request = (size: number, token = ADMIN) =>
    new Request(
      "http://proxy.test/v1/chatgpt-plan/sign-ins",
      { method: "POST", headers: { authorization: `Bearer ${token}` }, body: " ".repeat(size) },
    );
  try {
    const over = await handler(request(MAX_PLAN_SIGN_IN_BODY_BYTES + 1));
    assertEquals(over.status, 413);
    assert((await over.json()).error.includes(`${MAX_PLAN_SIGN_IN_BODY_BYTES} bytes`));
    assertEquals(built.planListener?.port(), null);
    assertEquals((await handler(request(MAX_PLAN_SIGN_IN_BODY_BYTES + 1, USER))).status, 403);
    assertEquals(built.planListener?.port(), null);
    // Whitespace, like no body, still means {} at the inclusive byte boundary.
    assertEquals((await handler(request(MAX_PLAN_SIGN_IN_BODY_BYTES))).status, 201);
    assert(built.planListener?.port() !== null);
  } finally {
    await built.planListener?.close();
  }
});

/** Starts a sign-in through the route and has the fake accept a code for it. */
async function start(
  call: Awaited<ReturnType<typeof makeApi>>["call"],
  fake: FakeOpenAi,
  body?: unknown,
) {
  const res = await call("POST", "/v1/chatgpt-plan/sign-ins", body);
  assertEquals(res.status, 201);
  const started = await res.json();
  const authorize = new URL(started.authorizeUrl);
  const code = `code-${crypto.randomUUID()}`;
  fake.issueCode(code, authorize.searchParams.get("nonce")!);
  const landed = `http://127.0.0.1:1455/auth/callback?${new URLSearchParams({
    code,
    state: authorize.searchParams.get("state")!,
    client_id: CLIENT_ID,
  })}`;
  return { started, landed, code };
}

/** The browser's return, delivered to the listener wherever the test bound it. */
async function land(built: Awaited<ReturnType<typeof makeApi>>["built"], landed: string) {
  const port = built.planListener?.port();
  assert(port !== null && port !== undefined, "the listener is up");
  const page = await fetch(landed.replace("127.0.0.1:1455", `127.0.0.1:${port}`));
  return { status: page.status, html: await page.text() };
}

/** A whole sign-in, through the route and the listener: the new key's id. */
async function signIn(api: Awaited<ReturnType<typeof makeApi>>, body?: unknown): Promise<string> {
  const { started, landed } = await start(api.call, api.fake, body);
  assertEquals((await land(api.built, landed)).status, 200);
  const status = await (await api.call("GET", `/v1/chatgpt-plan/sign-ins/${started.id}`)).json();
  assertEquals(status.status, "done");
  return status.keyId;
}

test("the browser lands on the listener, which finishes the sign-in and then closes", async () => {
  const { built, call, fake } = await makeApi();
  try {
    const { started, landed, code } = await start(call, fake, { label: "team plan" });
    assertMatch(started.id, /^si/);
    assert(Date.parse(started.expiresAt) > Date.now());
    assertEquals(
      await (await call("GET", `/v1/chatgpt-plan/sign-ins/${started.id}`)).json(),
      { status: "pending" },
    );

    const port = built.planListener?.port();
    assert(port !== null && port !== undefined);
    const page = await fetch(landed.replace("127.0.0.1:1455", `127.0.0.1:${port}`));
    assertEquals(page.status, 200);
    assertEquals(page.headers.get("referrer-policy"), "no-referrer");
    const html = await page.text();
    assertMatch(html, /Signed in/);
    assert(!html.includes(code), "nothing from the address is reflected");

    const status = await (await call("GET", `/v1/chatgpt-plan/sign-ins/${started.id}`)).json();
    assertEquals(status.status, "done");
    assertMatch(status.keyId, /^pk/);
    // Nothing is pending any more, so the listener goes away.
    for (let i = 0; i < 50 && built.planListener?.port() !== null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(built.planListener?.port(), null);

    // Another path, or a callback for no sign-in, never finishes anything.
    assertEquals((await call("POST", "/v1/chatgpt-plan/sign-ins")).status, 201);
    const stray = await fetch(
      `http://127.0.0.1:${built.planListener?.port()}/auth/callback?state=x`,
    );
    assertEquals(stray.status, 400);
    await stray.text();
    const other = await fetch(`http://127.0.0.1:${built.planListener?.port()}/elsewhere`);
    assertEquals(other.status, 404);
    await other.text();
  } finally {
    await built.planListener?.close();
  }
});

test("a port someone else holds refuses the sign-in: there is no other way to finish it", async () => {
  const taken = await listenOnLoopback();
  const { built, call } = await makeApi({ port: (taken.address() as AddressInfo).port });
  try {
    const res = await call("POST", "/v1/chatgpt-plan/sign-ins");
    assertEquals(res.status, 409);
    assertMatch((await res.json()).error, /could not listen/);
  } finally {
    await new Promise((resolve) => taken.close(resolve));
    await built.planListener?.close();
  }
});

test("a finished sign-in shows the plan in the key and provider lists", async () => {
  const api = await makeApi();
  const { call } = api;
  try {
    const keyId = await signIn(api);

    const listed = await (await call("GET", "/v1/provider-keys", undefined, USER)).json();
    const key = listed.providerKeys.find((k: { id: string }) => k.id === keyId);
    assertEquals(key.provider, "chatgpt-plan");
    assertEquals(key.label, "ChatGPT plan", "not named after the account: everyone reads labels");
    assertEquals(key.last4, "");
    // A member sees the plan, not whose account it is.
    assertEquals(
      { ...key.plan, models: undefined },
      { email: null, planType: "plus", status: "active", limitedAt: null, models: undefined },
    );
    // Each model with this account's own levels; the efforts stay with the proxy.
    assertEquals(
      key.plan.models.map((m: { id: string; thinkingLevels?: string[] }) => [
        m.id,
        m.thinkingLevels,
      ]),
      [["gpt-6.1-sol", ["low", "high"]], ["gpt-6.1-mini", undefined]],
    );
    assert(!JSON.stringify(listed).includes("reasoningEfforts"));
    assert(!JSON.stringify(listed).includes(EMAIL));
    assert(!("encryptedSecret" in key));
    const asAdmin = await (await call("GET", "/v1/provider-keys")).json();
    assertEquals(
      asAdmin.providerKeys.find((k: { id: string }) => k.id === keyId).plan.email,
      EMAIL,
    );

    const providers = await (await call("GET", "/v1/providers", undefined, USER)).json();
    const plan = providers.providers.find((p: { id: string }) => p.id === "chatgpt-plan");
    assertEquals(plan.label, "ChatGPT plan");
    assertEquals(plan.dialect, "openai-responses");
    assertEquals(plan.builtin, true);
    assertEquals(
      plan.models.map((m: { id: string; pricing?: string }) => [m.id, m.pricing]),
      [["gpt-6.1-sol", "included"], ["gpt-6.1-mini", "included"]],
    );
    // The efforts the account's list gave a model, as the levels a picker offers; the efforts
    // themselves stay with the proxy. One the list said nothing of has none.
    assertEquals(plan.models[0].thinkingLevels, ["low", "high"]);
    assert(!("reasoningEfforts" in plan.models[0]));
    assert(!("thinkingLevels" in plan.models[1]));
  } finally {
    await api.built.planListener?.close();
  }
});

test("a return that is not this sign-in's answer finishes nothing; a declined one fails it", async () => {
  const api = await makeApi();
  try {
    const { started, landed } = await start(api.call, api.fake);
    const forged = await land(api.built, landed.replace(/state=[^&]+/, "state=forged"));
    assertEquals(forged.status, 400);
    assertEquals(
      (await (await api.call("GET", `/v1/chatgpt-plan/sign-ins/${started.id}`)).json()).status,
      "pending",
    );
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    const declined = await land(
      api.built,
      `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`,
    );
    assertEquals(declined.status, 400);
    const status = await (await api.call("GET", `/v1/chatgpt-plan/sign-ins/${started.id}`))
      .json();
    assertEquals(status.status, "failed");
    assertMatch(status.error, /declined/);
    assertEquals((await api.call("GET", "/v1/chatgpt-plan/sign-ins/si-nope")).status, 404);
  } finally {
    await api.built.planListener?.close();
  }
});

test("only an admin may sign a plan in", async () => {
  const { call } = await makeApi();
  assertEquals((await call("POST", "/v1/chatgpt-plan/sign-ins", {}, USER)).status, 403);
  assertEquals((await call("POST", "/v1/chatgpt-plan/sign-ins", {}, "nobody")).status, 401);
  assertEquals((await call("GET", "/v1/chatgpt-plan/sign-ins/si-x", undefined, USER)).status, 403);
});

test("a plan key is never made or rotated with a pasted secret", async () => {
  const api = await makeApi();
  const { call } = api;
  const create = await call("POST", "/v1/provider-keys", {
    provider: "chatgpt-plan",
    label: "x",
    secret: "sk-something-long",
  });
  assertEquals(create.status, 400);
  assertMatch((await create.json()).error, /signing in/);

  const keyId = await signIn(api);
  assertEquals(
    (await call("PATCH", `/v1/provider-keys/${keyId}`, { secret: "sk-something-long" })).status,
    400,
  );
  const relabelled = await call("PATCH", `/v1/provider-keys/${keyId}`, { label: "renamed" });
  assertEquals(relabelled.status, 200);
  assertEquals((await relabelled.json()).plan.status, "active");
});

test("relabelling a plan key never writes back the tokens it read", async () => {
  const api = await makeApi();
  const { call, store } = api;
  const keyId = await signIn(api);
  // A refresh rotates the tokens while the edit is between its read and its write.
  const inner = store.getProviderKey.bind(store);
  store.getProviderKey = async (id) => {
    const read = await inner(id);
    store.getProviderKey = inner;
    await store.updateProviderKey(id, { encryptedSecret: "rotated", updatedAt: "x" });
    return read;
  };
  const relabelled = await call("PATCH", `/v1/provider-keys/${keyId}`, { label: "renamed" });
  assertEquals(relabelled.status, 200);
  const row = (await store.getProviderKey(keyId))!;
  assertEquals(row.label, "renamed");
  assertEquals(row.encryptedSecret, "rotated");
});

test("the models route fetches the list again, and archiving revokes the session first", async () => {
  const api = await makeApi();
  const { call, fake, store } = api;
  const keyId = await signIn(api);

  const models = await call("POST", `/v1/provider-keys/${keyId}/chatgpt-plan/models`);
  assertEquals(models.status, 200);
  assertEquals(await models.json(), { models: ["gpt-6.1-sol", "gpt-6.1-mini"] });
  assertEquals((await call("POST", "/v1/provider-keys/pk-nope/chatgpt-plan/models")).status, 404);

  const archived = await call("POST", `/v1/provider-keys/${keyId}/archive`);
  assertEquals(archived.status, 200);
  const signedOut = await archived.json();
  assert(signedOut.archivedAt !== null);
  assertEquals(signedOut.revoked, true);
  assertEquals(fake.calls.filter((c) => c === "revoke").length, 1);
  assertEquals(fake.forms.at(-1)?.get("client_id"), CLIENT_ID);
  assert((await store.getProviderKey(keyId))?.archivedAt !== null);
  // Signing an archived key in again is refused.
  assertEquals((await call("POST", "/v1/chatgpt-plan/sign-ins", { keyId })).status, 400);
});

test("archiving says so when OpenAI could not confirm the sign-out", async () => {
  const api = await makeApi();
  const { call, fake } = api;
  const keyId = await signIn(api);
  fake.failRevoke = true;
  const archived = await call("POST", `/v1/provider-keys/${keyId}/archive`);
  assertEquals(archived.status, 200);
  const body = await archived.json();
  assert(body.archivedAt !== null);
  assertEquals(body.revoked, false);
});

test("a sign-in that opens the listener while it is closing still gets it", async () => {
  // A fixed port: the one the closing listener still holds.
  const probe = await listenOnLoopback();
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  const pending = new Set<string>();
  const listener = makeCallbackListener({
    port,
    complete: () => Promise.resolve(false),
    pending: (id) => Promise.resolve(pending.has(id)),
    now: () => new Date(),
    diag: { debug() {} },
  });
  try {
    pending.add("si-a");
    assert(await listener.open("si-a", Date.now() + 60_000));
    pending.delete("si-a");
    const sweeping = listener.sweep();
    // The sweep has let go of the server and is waiting for it to shut down.
    while (listener.port() !== null) await new Promise((resolve) => setTimeout(resolve, 0));
    pending.add("si-b");
    assert(await listener.open("si-b", Date.now() + 60_000), "bound once the old one let go");
    await sweeping;
    assertEquals(listener.port(), port);
  } finally {
    await listener.close();
  }
});

test("without a master key the plan routes answer model_access_disabled, never 404", async () => {
  const handler = router(disabledProviderKeyRoutes({ authenticate: () => Promise.resolve(null) }));
  for (
    const [method, path] of [
      ["POST", "/v1/chatgpt-plan/sign-ins"],
      ["GET", "/v1/chatgpt-plan/sign-ins/si-1"],
      ["POST", "/v1/provider-keys/pk-1/chatgpt-plan/models"],
    ]
  ) {
    const res = await handler(new Request(`http://proxy.test${path}`, { method }));
    assertEquals(res.status, 503, `${method} ${path}`);
    assertEquals((await res.json()).code, "model_access_disabled");
  }
});

test("off a local deployment nothing signs in, no run gets a plan, and signing out still works", async () => {
  // A key made while the deployment was local, then the same store under a hosted one.
  const local = await makeApi();
  const keyId = await signIn(local);
  await local.built.planListener?.close();
  const { built, call, fake } = await makeApi({
    local: false,
    store: local.store,
    fake: local.fake,
  });
  assertEquals(built.planListener, null);

  for (
    const [method, path] of [
      ["POST", "/v1/chatgpt-plan/sign-ins"],
      ["GET", "/v1/chatgpt-plan/sign-ins/si-1"],
      ["POST", `/v1/provider-keys/${keyId}/chatgpt-plan/models`],
    ]
  ) {
    const res = await call(method, path);
    assertEquals(res.status, 403, `${method} ${path}`);
    assertEquals((await res.json()).code, "chatgpt_plan_local_only");
  }
  const providers = await (await call("GET", "/v1/providers", undefined, USER)).json();
  assert(!providers.providers.some((p: { id: string }) => p.id === "chatgpt-plan"));

  await assertRejects(
    () =>
      built.issuer!.issue({
        runId: "r-1",
        agentId: "a-1",
        taskId: "t-1",
        providerKeyId: keyId,
        provider: "chatgpt-plan",
        allowedModels: "*",
        spendUsd: null,
      }),
    CredentialRefusedError,
    "your own machine",
  );

  const archived = await call("POST", `/v1/provider-keys/${keyId}/archive`);
  assertEquals(archived.status, 200);
  assertEquals((await archived.json()).revoked, true);
  assertEquals(fake.calls.filter((c) => c === "revoke").length, 1);
});
