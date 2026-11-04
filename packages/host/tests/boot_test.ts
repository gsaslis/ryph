// Boot smoke test: buildApp assembles every service-shaped module into one deployment.
// Drives the merged control-plane handler and the data-plane handler in-process with plain
// Request objects — no sockets, no env.
//
// ONE PGlite instance for the whole file, provisioned once and shared by every test. Not just
// speed: a PGlite instance costs a few hundred megabytes of WASM memory that the process never
// gets back, so a per-test instance would run this file into the gigabytes. That the tests can
// share one is the point of buildApp taking a cluster rather than a URL.

import { spyOn, test } from "bun:test";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type DbCluster, openDbCluster } from "@ryph/db";
import { pushSchema } from "drizzle-kit/api";
import * as authSchema from "@ryph/auth/schema";
import * as historySchema from "@ryph/historian/schema";
import * as keySchema from "@ryph/model-proxy/schema";
import * as mcpSchema from "@ryph/mcp-gateway/schema";
import * as memorySchema from "@ryph/memory/schema";
import * as chatSchema from "@ryph/chat/schema";
import * as orchestratorSchema from "@ryph/orchestrator/schema";
import * as automationsSchema from "@ryph/automations/schema";
import * as webhooksSchema from "@ryph/webhooks/schema";
import { importMasterKey, sha256Hex } from "@ryph/sealed";
import type { ToolHost } from "@ryph/mcp-gateway";
import { startLauncher } from "@ryph/launcher";
import { serve } from "@ryph/service";
import {
  DEFAULT_CHECK_POLICY,
  DEFAULT_EGRESS_POLICY,
  DEFAULT_ENVIRONMENTS_CONFIG,
  DEFAULT_HARNESS_KINDS,
  DEFAULT_RUN_SIZES,
  DEFAULT_SERVICE_POLICY,
  directorySkillCatalogue,
  launcherClients,
  NO_RUN_LIMITS,
} from "@ryph/orchestrator";
import {
  drizzleKeyStore,
  makeCredentialIssuer,
  scopeModelProxyDb,
  THINKING_LEVELS,
} from "@ryph/model-proxy";
// By path, not through @ryph/runner's export map: the runner is a spawned container in every
// deployment and nothing imports it as a module, so giving it a second public export to serve one
// test would put its whole ingest boundary under JSR's slow-type rules for no other gain. This is
// the far end of the credentials wire, and the point of the test below is that it parses with the
// schema that actually runs — not with a copy of it.
import { RunCredentialsSchema } from "../../runner/src/schema.ts";
import { THINKING_LEVELS as RUNNER_THINKING_LEVELS } from "../../runner/src/core/types.ts";
import { proxyModelsConfig } from "../../runner/src/adapters/harness/pi.ts";
// The proxy tests' restatement of pi-ai's `getSupportedThinkingLevels`.
import { supportedLevels } from "../../model-proxy/tests/pi_levels.ts";
// The app's level pickers, by path for the reason the runner is: the app is a SvelteKit build
// nothing imports, and these two files import nothing through `$lib` so that this test can run
// the rule the pickers run rather than a copy of it.
import { thinkingLevelsFor } from "../../app/src/lib/components/model-picker/thinking.ts";
import { THINKING_LEVELS as APP_THINKING_LEVELS } from "../../app/src/lib/api/thinking-levels.ts";
import { buildApp, type HostConfig } from "../src/app.ts";

const BASE = "http://host.test";

/**
 * Every mounted module's tables, in the one database the single-process deployment uses.
 *
 * ONE combined push, never a loop over the six schemas: `pushSchema` is interactive, so a
 * second push would see the first's tables in the database but not in the schema it was handed,
 * fail to tell created from renamed, and PROMPT — which under a test runner is an infinite hang,
 * not an error. Combining them is also what packages/host/drizzle.config.ts does.
 */
async function provisioned(): Promise<DbCluster> {
  const cluster = await openDbCluster("pglite:memory://");
  const combined = {
    ...orchestratorSchema,
    ...authSchema,
    ...keySchema,
    ...mcpSchema,
    ...historySchema,
    ...automationsSchema,
    ...webhooksSchema,
    ...memorySchema,
    ...chatSchema,
  };
  const { apply } = await pushSchema(combined, cluster.scope(combined) as never);
  await apply();
  return cluster;
}

let shared: DbCluster | null = null;
const sharedCluster = async (): Promise<DbCluster> => shared ??= await provisioned();

async function testConfig(overrides: Partial<HostConfig> = {}): Promise<HostConfig> {
  return {
    cluster: await sharedCluster(),
    historyCluster: null,
    authDisabled: false,
    multiUser: true,
    smtp: null,
    masterKey: await importMasterKey("ab".repeat(32)),
    modelProxyUrl: "http://localhost:7420",
    virtualKeyTtlMs: 60_000,
    modelSpend: { backstopMs: 30_000, ceiling: null },
    mcpKey: await importMasterKey("cd".repeat(32)),
    mcpGatewayUrl: "http://localhost:7430",
    mcpVirtualKeyTtlMs: 60_000,
    mcpUpstream: { allowInsecure: false, allowPrivate: false },
    chatUrl: null,
    chatToken: null,
    chatGatewayToken: null,
    webTools: true,
    webUrl: null,
    webGatewayToken: null,
    webSearch: { provider: null, key: null },
    webAllowInsecure: false,
    webFetchTimeoutMs: 20_000,
    forgeToolsUrl: null,
    forgeGatewayToken: null,
    chatKey: await importMasterKey("ef".repeat(32)),
    toolGuardImage: "ryph-tool-guard:test",
    provisioner: { kind: "manual" },
    services: DEFAULT_SERVICE_POLICY,
    browser: null,
    gitGateway: null,
    forgeToken: null,
    forge: null,
    historyUrl: null,
    historyToken: null,
    memoryUrl: null,
    memoryToken: null,
    memoryGatewayToken: null,
    appUrl: null,
    publicUrl: "http://localhost:7411",
    // Every field of HostConfig is required, this one included: a deployment that reached
    // buildApp without an egress policy would be one whose runs have no stated boundary at
    // all, which is the state this type exists to make unrepresentable.
    egress: { policy: DEFAULT_EGRESS_POLICY, key: null, tokenTtlMs: 3_600_000 },
    agentImage: null,
    harnessKinds: [...DEFAULT_HARNESS_KINDS],
    runSizes: DEFAULT_RUN_SIZES,
    limits: {
      ceiling: NO_RUN_LIMITS,
      concurrency: null,
      maxCredentials: 3,
      deadlineGraceMs: 0,
      startupGraceMs: 600_000,
    },
    environments: DEFAULT_ENVIRONMENTS_CONFIG,
    environmentLogs: null,
    // Multi-user, auth's setup refuses to start without one.
    proxySecret: "boot-test-proxy-secret",
    ...overrides,
  };
}

/** What a task needs to start: a forge, the gateway every run clones through, and a repo. The
 * recording fake stands in for the forge; a repo on this machine needs no linked login. */
const TASKS: Partial<HostConfig> = {
  forge: { kind: "noop" },
  forgeToken: "forge-secret",
  gitGateway: { url: "http://localhost:7412", keyTtlMs: 60_000 },
};

const REPO = {
  id: "cr-app",
  provider: "local" as const,
  installationId: null,
  repoRef: "/srv/app",
  url: "/srv/app",
  defaultBranch: "main",
  submissionPolicy: "require-approval" as const,
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** The repo's id, connected once per database: the cluster is shared across tests. */
async function connectedRepo(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  if ((await app.store.getConnectedRepo(REPO.id)) === null) {
    await app.store.createConnectedRepo(REPO);
  }
  return REPO.id;
}

const OWNER = { email: "owner@example.com", name: "Owner", password: "correct horse battery" };
const ownerTokens = new WeakMap<object, string>();

/**
 * An access token for the instance's owner, minted through the mounted auth routes: the first
 * call bootstraps the account (with the setup token, while no users exist) and every call signs
 * in.
 * The cluster is shared across tests, so the bootstrap is a no-op after the first.
 */
async function ownerToken(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const cached = ownerTokens.get(app);
  if (cached !== undefined) return cached;
  const post = (path: string, body: unknown) =>
    app.handler(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const setupToken = app.auth.setupToken ?? undefined;
  await (await post("/v1/auth/users", { ...OWNER, setupToken })).body?.cancel();
  const login = await post("/v1/auth/login", { email: OWNER.email, password: OWNER.password });
  assertEquals(login.status, 200, "the owner signs in");
  const { accessToken } = await login.json();
  ownerTokens.set(app, accessToken);
  return accessToken;
}

const authed = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  path: string,
  init: RequestInit = {},
): Promise<Request> =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await ownerToken(app)}`, ...init.headers },
  });

test("previews are mounted only for an explicitly enabled localhost binary", async () => {
  for (
    const [enabled, appUrl, expected] of [
      [false, "http://localhost:3000", 404],
      [true, "https://acme.ryph.ai", 404],
      [true, "http://localhost:3000", 401],
    ] as const
  ) {
    const app = await buildApp(await testConfig({ localPreviews: enabled, appUrl }));
    try {
      const response = await app.handler(new Request(`${BASE}/v1/runs/unknown/runner/previews`));
      assertEquals(response.status, expected);
      await response.body?.cancel();
      const reader = await app.handler(new Request(`${BASE}/v1/runs/unknown/previews`));
      assertEquals(reader.status, expected);
      await reader.body?.cancel();
      app.closePreviews();
      app.closePreviews(); // drain and final close are idempotent
    } finally {
      app.close();
    }
  }
});

test("control plane serves every mounted surface from one handler", async () => {
  const app = await buildApp(await testConfig());

  // The orchestrator's own user surface.
  const tasks = await app.handler(await authed(app, "/v1/tasks"));
  assertEquals(tasks.status, 200);
  await tasks.body?.cancel();

  // @ryph/auth, mounted: present (not 404), and refusing garbage credentials.
  const login = await app.handler(
    new Request(`${BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong" }),
    }),
  );
  assert(login.status !== 404 && login.status < 500, `login: ${login.status}`);
  await login.body?.cancel();
  const jwks = await app.handler(new Request(`${BASE}/.well-known/jwks.json`));
  assertEquals(jwks.status, 200);
  await jwks.body?.cancel();

  // @ryph/model-proxy's key CRUD, mounted.
  const keys = await app.handler(await authed(app, "/v1/provider-keys"));
  assertEquals(keys.status, 200);
  await keys.body?.cancel();

  // @ryph/mcp-gateway's server CRUD, mounted.
  const servers = await app.handler(await authed(app, "/v1/mcp-servers"));
  assertEquals(servers.status, 200);
  await servers.body?.cancel();

  // @ryph/historian's read surface, mounted: an unknown run is an empty record, not a 404.
  const history = await app.handler(await authed(app, "/v1/runs/unknown/events"));
  assertEquals(history.status, 200);
  await history.body?.cancel();

  const missing = await app.handler(new Request(`${BASE}/no/such/route`));
  assertEquals(missing.status, 404);
  await missing.body?.cancel();

  app.close();
});

test("data plane is wired over the same key store and rejects unknown keys", async () => {
  const app = await buildApp(await testConfig());
  assert(app.proxyHandler !== null);

  const refused = await app.proxyHandler(
    new Request(`${BASE}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "not-a-virtual-key" },
    }),
  );
  assertEquals(refused.status, 401);
  await refused.body?.cancel();

  app.close();
});

test("the MCP gateway data plane is wired over the same store and rejects unknown tokens", async () => {
  const app = await buildApp(await testConfig());
  assert(app.mcpGatewayHandler !== null);

  const refused = await app.mcpGatewayHandler(
    new Request(`${BASE}/v1/mcp/run-1/linear`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-virtual-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assertEquals(refused.status, 401);
  await refused.body?.cancel();

  app.close();
});

test("an agent's tool policy is checked against the mounted gateway's servers", async () => {
  // The in-process ToolAccess adapter: the orchestrator asks the gateway store for the server
  // the policy names, and an id nobody registered is the definitive 400 — not a 5xx, and not
  // an agent created with a policy that could never boot a run.
  const app = await buildApp(await testConfig());
  const refused = await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Toolless",
        email: "toolless@example.com",
        harnessKind: "pi",
        toolPolicy: { servers: [{ serverId: "ms-nobody", allowedTools: "*" }] },
      }),
    }),
  );
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "no such MCP server");
  app.close();
});

test("an unprovisioned database fails the boot with the db:push pointer", async () => {
  // A fresh PGlite instance is real PostgreSQL with none of our tables — exactly what a new
  // data directory looks like before `db:push`. The probe must throw its clear error before any
  // module (the auth service reads its signing key at construction) hits a raw driver failure.
  const empty = await openDbCluster("pglite:memory://");
  try {
    await assertRejects(
      async () => await buildApp(await testConfig({ cluster: empty })),
      Error,
      "has no schema",
    );
  } finally {
    await empty.close();
  }
});

test("a forge token mounts the forge surface; without one it is dark", async () => {
  const resolve = (app: Awaited<ReturnType<typeof buildApp>>) =>
    app.handler(
      new Request(`${BASE}/v1/forge/git-keys/resolve`, {
        method: "POST",
        headers: { authorization: "Bearer forge-secret", "content-type": "application/json" },
        body: JSON.stringify({ key: "not-a-git-key" }),
      }),
    );

  const dark = await buildApp(await testConfig());
  const missing = await resolve(dark);
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
  dark.close();

  const app = await buildApp(
    await testConfig({ forgeToken: "forge-secret", forge: { kind: "noop" } }),
  );
  const refused = await resolve(app);
  assert(refused.status !== 404, `forge surface unmounted: ${refused.status}`);
  await refused.body?.cancel();
  app.close();
});

test("the in-process ModelAccess resolves a key's DIALECT, and the agent form reads it", async () => {
  // The composition root's adaptation of the model-proxy issuer to the orchestrator's
  // ModelAccess port is the one place the single-process deployment joins a key row to the
  // provider that says what wire shape it speaks. Nothing below re-derives that from the
  // provider id — a registered endpoint's id is a slug an admin typed — so this drives the
  // whole path: a real key row in, an agent whose harness was checked against the dialect out.
  const app = await buildApp(await testConfig());
  const created = await app.handler(
    await authed(app, "/v1/provider-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", label: "dialect-probe", secret: "sk-ant-x" }),
    }),
  );
  assertEquals(created.status, 201);
  const { id: providerKeyId } = await created.json();

  const modelPolicy = {
    providerKeyId,
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5"],
    defaultModel: "claude-sonnet-5",
  };
  const agent = await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Dialect",
        email: "dialect@example.com",
        harnessKind: "pi",
        modelPolicy,
      }),
    }),
  );
  assertEquals(agent.status, 201);
  await agent.body?.cancel();

  // And the refusal the dialect is FOR: echo speaks no wire shape at all, so the same live key
  // is out of its reach — with the answer naming shapes rather than provider ids.
  const refused = await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Echoey",
        email: "echoey@example.com",
        harnessKind: "echo",
        modelPolicy,
      }),
    }),
  );
  assertEquals(refused.status, 400);
  const body = await refused.json();
  assertStringIncludes(body.error, "anthropic-messages");
  assertEquals(body.supportedDialects, []);

  app.close();
});

test("the runner and the app take exactly the thinking levels the proxy lists models by", () => {
  // Spelled in each — the runner imports no other package, nor the app a server one — and a
  // level only one of them knew would be one the pickers offer and every run drops with a
  // warning, or the other way round.
  assertEquals([...RUNNER_THINKING_LEVELS], [...THINKING_LEVELS]);
  assertEquals([...APP_THINKING_LEVELS], [...THINKING_LEVELS]);
});

/** The levels pi takes for each model of the models.json the runner writes from a run's env:
 * pi's loader reads an unset `reasoning` as false (pi-coding-agent 1.1.0 provider-composer.js
 * `modelFromJson`), and `supportedLevels` is pi-ai's rule from there. */
function piLevelsFor(
  env: Record<string, string>,
  provider: string,
): Record<string, string[] | undefined> {
  const config = proxyModelsConfig(
    { kind: "pi", provider } as Parameters<typeof proxyModelsConfig>[0],
    (name) => env[name],
  );
  assert(config !== null, "the runner wrote no models.json");
  const entry = (config.models.providers as Record<string, { models: Record<string, unknown>[] }>)[
    provider
  ];
  return Object.fromEntries(
    entry.models.map((model) => [String(model.id), supportedLevels(model)]),
  );
}

type ListedModel = { id: string; reasoning?: boolean; thinkingLevels?: string[] };

/** What the app's pickers offer for each id, off the model list they read. */
function appLevelsFor(models: ListedModel[], ids: string[]): Record<string, string[]> {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      [...thinkingLevelsFor(models as Parameters<typeof thinkingLevelsFor>[0], id, true)],
    ]),
  );
}

test("the levels the app offers for a custom or plan model are the ones pi takes for it", async () => {
  // The proxy lists these models as stored and fills nothing in, so the app works out what pi
  // will do with one; a level it offers that pi does not take is one a person picks and pi
  // silently drops. So for every way a model can be declared, the app's rule over the provider
  // list and pi's own rule over the models.json the runner writes from the run's blob must agree.
  const app = await buildApp(await testConfig({ appUrl: "http://localhost:3000" }));
  try {
    const declared = [
      { id: "unsaid" },
      { id: "not-reasoning", reasoning: false },
      { id: "reasoning", reasoning: true },
      { id: "levels-only", thinkingLevels: ["low", "max"] },
      { id: "reasoning-levels", reasoning: true, thinkingLevels: ["off", "medium", "xhigh"] },
      { id: "reasoning-off-only", reasoning: true, thinkingLevels: ["off"] },
      { id: "ant-ling", reasoning: true, compat: { thinkingFormat: "ant-ling" } },
    ];
    const endpoint = await app.handler(
      await authed(app, "/v1/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "levels-wire",
          label: "Levels wire",
          baseUrl: "https://api.groq.com/openai/v1",
          models: declared,
        }),
      }),
    );
    assertEquals(endpoint.status, 201);
    await endpoint.body?.cancel();
    const key = await app.handler(
      await authed(app, "/v1/provider-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "levels-wire", label: "wire", secret: "gsk-secret-y" }),
      }),
    );
    assertEquals(key.status, 201);
    const { id: providerKeyId } = await key.json();

    const providers: { id: string; builtin: boolean; models: ListedModel[] }[] =
      (await (await app.handler(await authed(app, "/v1/providers"))).json()).providers;
    const custom = providers.find((p) => p.id === "levels-wire")!;
    // Listed as stored, and not built-in: the app reads it as a model declared to pi.
    assertEquals(custom.models, declared);
    assertEquals(custom.builtin, false);

    const store = drizzleKeyStore(scopeModelProxyDb(await sharedCluster()));
    const issuer = makeCredentialIssuer({
      store,
      now: () => new Date(),
      proxyUrl: "http://model-proxy.test:7420",
      planOn: true,
    });
    const scope = { agentId: "agent-levels", taskId: "task-levels" };
    const pi = piLevelsFor(
      await issuer.issue({
        ...scope,
        runId: "run-levels",
        providerKeyId,
        provider: "levels-wire",
        allowedModels: "*",
      }),
      "levels-wire",
    );
    assertEquals(appLevelsFor(custom.models, Object.keys(pi)), pi);
    assertEquals(pi, {
      "unsaid": ["off"],
      "not-reasoning": ["off"],
      "reasoning": ["off", "minimal", "low", "medium", "high"],
      "levels-only": ["low", "max"],
      "reasoning-levels": ["off", "medium", "xhigh"],
      "reasoning-off-only": ["off"],
      "ant-ling": ["off", "minimal", "low", "medium", "high"],
    });

    // A ChatGPT plan rides the same blob, with the key's own model list: its levels come off
    // the efforts the account's list names, and nothing else is said of a model.
    const at = new Date().toISOString();
    const planKey = (id: string, models: Record<string, unknown>[]) =>
      store.createProviderKey({
        id,
        provider: "chatgpt-plan",
        label: id,
        last4: "plan",
        encryptedSecret: "sealed-never-read",
        archivedAt: null,
        createdAt: at,
        updatedAt: at,
        plan: {
          clientId: "oaiapp_levels",
          subject: `sub-${id}`,
          email: null,
          planType: "pro",
          scopes: [],
          models: models as never,
          modelsFetchedAt: models.length === 0 ? null : at,
        },
        planStatus: "active",
      });
    await planKey("pk-plan-levels", [
      { id: "p-unsaid" },
      { id: "p-none", reasoning: false, reasoningEfforts: [] },
      { id: "p-some", reasoning: true, reasoningEfforts: ["low", "high"] },
      { id: "p-off", reasoning: true, reasoningEfforts: ["none", "medium", "xhigh"] },
      { id: "p-unknown", reasoning: true, reasoningEfforts: ["turbo"] },
    ]);
    // One whose model list never came back: the run is told the agent's allowlist, by id.
    await planKey("pk-plan-unlisted", []);

    // The key's own models, as the key read lists them: what the pickers read for a plan key
    // (`modelsForKey`), each with this account's levels.
    const keys: { id: string; plan?: { models: ListedModel[] } }[] =
      (await (await app.handler(await authed(app, "/v1/provider-keys"))).json()).providerKeys;
    const keyModels = (id: string) => keys.find((k) => k.id === id)!.plan!.models;

    const planPi = piLevelsFor(
      await issuer.issue({
        ...scope,
        runId: "run-levels-plan",
        providerKeyId: "pk-plan-levels",
        provider: "chatgpt-plan",
        allowedModels: "*",
      }),
      "chatgpt-plan",
    );
    assertEquals(appLevelsFor(keyModels("pk-plan-levels"), Object.keys(planPi)), planPi);
    assertEquals(planPi, {
      "p-unsaid": ["off"],
      "p-none": ["off"],
      "p-some": ["low", "high"],
      "p-off": ["off", "medium", "xhigh"],
      "p-unknown": ["off", "minimal", "low", "medium", "high"],
    });

    const unlistedPi = piLevelsFor(
      await issuer.issue({
        ...scope,
        runId: "run-levels-unlisted",
        providerKeyId: "pk-plan-unlisted",
        provider: "chatgpt-plan",
        allowedModels: ["gpt-allow-only"],
      }),
      "chatgpt-plan",
    );
    assertEquals(keyModels("pk-plan-unlisted"), []);
    assertEquals(appLevelsFor(keyModels("pk-plan-unlisted"), ["gpt-allow-only"]), unlistedPi);
    assertEquals(unlistedPi, { "gpt-allow-only": ["off"] });
  } finally {
    app.close();
  }
});

test("what the issuer emits is what the runner's credentials schema accepts", async () => {
  // The one test that crosses the model-proxy's real output with @ryph/runner's real ingest
  // schema. Both ends live in this workspace and neither imports the other — the runner is a
  // container that talks HTTP — so nothing else in the repo would notice if the issuer started
  // emitting a variable name the runner refuses. It did: the runner rejects anything under its
  // own brand prefix as an attempt to reconfigure it, and a custom endpoint's credential is
  // three variables under exactly that prefix. Every such run boot-failed.
  const app = await buildApp(await testConfig());

  const endpoint = await app.handler(
    await authed(app, "/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "issuer-wire",
        label: "Issuer wire",
        baseUrl: "https://api.groq.com/openai/v1",
        models: [{ id: "llama-3.3-70b-versatile", contextWindow: 128_000 }],
      }),
    }),
  );
  assertEquals(endpoint.status, 201);
  await endpoint.body?.cancel();

  const key = await app.handler(
    await authed(app, "/v1/provider-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "issuer-wire", label: "wire", secret: "gsk-secret-x" }),
    }),
  );
  assertEquals(key.status, 201);
  const { id: providerKeyId } = await key.json();

  // The real issuer over the same store the routes above wrote to — not a hand-built env map.
  const issuer = makeCredentialIssuer({
    store: drizzleKeyStore(scopeModelProxyDb(await sharedCluster())),
    now: () => new Date(),
    proxyUrl: "http://model-proxy.test:7420",
  });
  const custom = await issuer.issue({
    runId: "run-wire",
    agentId: "agent-wire",
    taskId: "task-wire",
    providerKeyId,
    provider: "issuer-wire",
    allowedModels: ["llama-3.3-70b-versatile"],
  });
  const parsed = RunCredentialsSchema.safeParse({ env: custom });
  assert(
    parsed.success,
    `the runner refuses what the issuer emits: ${JSON.stringify(parsed.error?.issues)}`,
  );
  assertEquals(Object.keys(parsed.data!.env).sort(), [
    "RYPH_MODEL_API_KEY",
    "RYPH_MODEL_BASE_URL",
    "RYPH_MODEL_PROVIDER_CONFIG",
  ]);

  // And the built-in path, which has always parsed — asserted so the carve-out above cannot be
  // widened into "the prefix rule is gone" without this noticing.
  const builtinKey = await app.handler(
    await authed(app, "/v1/provider-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", label: "wire", secret: "sk-ant-secret-x" }),
    }),
  );
  assertEquals(builtinKey.status, 201);
  const builtin = await issuer.issue({
    runId: "run-wire-builtin",
    agentId: "agent-wire",
    taskId: "task-wire",
    providerKeyId: (await builtinKey.json()).id,
    provider: "anthropic",
    allowedModels: "*",
  });
  assertEquals(
    Object.keys(RunCredentialsSchema.parse({ env: builtin }).env).sort(),
    ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  );

  app.close();
});

test("without a master key, model access and the data plane are dark", async () => {
  const app = await buildApp(await testConfig({ masterKey: null }));
  assertEquals(app.proxyHandler, null);

  // The paths stay mounted so a client can tell "turned off" from "broken": a 404 here would
  // read as a fault and take down the pages that ask for keys.
  const keys = await app.handler(await authed(app, "/v1/provider-keys"));
  assertEquals(keys.status, 503);
  assertEquals((await keys.json()).code, "model_access_disabled");

  const created = await app.handler(
    await authed(app, "/v1/provider-keys", {
      method: "POST",
      body: JSON.stringify({ provider: "anthropic", label: "team", secret: "sk-ant-xxxx" }),
    }),
  );
  assertEquals(created.status, 503);
  await created.body?.cancel();

  app.close();
});

test("without an MCP key, tool access and the gateway data plane are dark", async () => {
  const app = await buildApp(await testConfig({ mcpKey: null }));
  assertEquals(app.mcpGatewayHandler, null);

  // The same contract as model access: the paths stay mounted and answer a coded 503, so the
  // tool-servers page and the agent form can tell "turned off" from "broken".
  const servers = await app.handler(await authed(app, "/v1/mcp-servers"));
  assertEquals(servers.status, 503);
  assertEquals((await servers.json()).code, "mcp_disabled");

  // And the orchestrator, handed no ToolAccess, refuses a tool policy at creation rather than
  // storing one that could never boot a run.
  const refused = await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Toolless",
        email: "toolless@example.com",
        harnessKind: "pi",
        toolPolicy: { servers: [{ serverId: "ms-nobody", allowedTools: "*" }] },
      }),
    }),
  );
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "tool access is not configured");

  app.close();
});

test("under the manual provisioner, hosting is unavailable and the catalogue says why", async () => {
  const app = await buildApp(await testConfig());
  await app.hosting!.boot();

  // Remote servers work exactly as before; only the hosting paths say no, with the fix named.
  const catalogue = await app.handler(await authed(app, "/v1/mcp-catalogue"));
  assertEquals(catalogue.status, 200);
  const body = await catalogue.json();
  assertEquals(body.hostingAvailable, false);
  assertStringIncludes(body.reason, "RYPH_PROVISIONER=docker");
  assert(body.entries.some((e: { id: string }) => e.id === "grafana"), "the catalogue still lists");

  const refused = await app.handler(
    await authed(app, "/v1/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "hosted",
        catalogueId: "grafana",
        name: "Grafana",
        settings: { GRAFANA_URL: "https://grafana.example.com" },
        credential: { "X-Grafana-Service-Account-Token": "not-a-real-token" },
      }),
    }),
  );
  assertEquals(refused.status, 503);
  assertEquals((await refused.json()).code, "hosting_unavailable");
  app.close();
});

test("checks are off unless asked for; on a backend with no check pods they say why", async () => {
  const off = await buildApp(await testConfig());
  assertEquals(off.checks, null);
  off.close();
  const on = await buildApp(
    await testConfig({
      checks: { ...DEFAULT_CHECK_POLICY, enabled: true },
      environmentLogs: { put: () => Promise.resolve(), get: () => Promise.resolve(null) },
    }),
  );
  assert(on.checks !== null);
  assertStringIncludes(on.checks.refusedReason!, "cannot run check pods");
  // The tick does nothing on a refused deployment, and says nothing by throwing.
  await on.checks.tick();
  on.close();
});

test("on a container backend, hosting boots the guard and a catalogue server starts", async () => {
  // A real launcher on loopback, its docker faked: the boot's reconcile goes through it.
  const dockerCalls: string[] = [];
  const launcher = await startLauncher({
    token: "boot-test-run-token",
    toolsToken: null,
    docker: {},
    checks: false,
    environments: null,
    prefetch: null,
    tools: null,
    exec: (args) => {
      dockerCalls.push(args.join(" "));
      return Promise.resolve("");
    },
    serve: (handler) => serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, handler),
  });
  // A ToolHost that launches nothing: the pin is the wiring — the host hands the gateway a
  // ToolHost, the catalogue says available once it has booted, and a create answers `starting`
  // with the minted guard URL — not the container runtime, which the gateway's tests cover.
  const launched: string[] = [];
  const toolHost: ToolHost = {
    kind: "fake",
    reachesGuard: false,
    ensureNetwork: () => Promise.resolve(),
    launch: (spec) => {
      launched.push(spec.name);
      return Promise.resolve({
        handle: spec.name,
        address: spec.publish ? "127.0.0.1:47999" : `${spec.name}:${spec.port}`,
      });
    },
    stop: () => Promise.resolve(),
    list: () => Promise.resolve(launched),
    inspect: () => Promise.resolve("running"),
    address: (handle, port) => Promise.resolve(`${handle}:${port}`),
    logs: () => Promise.resolve(""),
  };
  const app = await buildApp(
    await testConfig({
      provisioner: {
        kind: "docker",
        launcher: launcherClients(
          { url: launcher.url, token: "boot-test-run-token" },
          { debug() {}, warn() {} },
        ),
      },
      toolHost,
      // The entry's url setting meets the upstream rule like any other upstream, and there is no
      // DNS in this test (nor net permission to try): the flag a local deployment sets anyway is
      // what lets `grafana.example.com` through without resolving it.
      mcpUpstream: { allowInsecure: false, allowPrivate: true },
      // One probe and done: there is no server behind the fake, and no net permission here.
      hostingLimits: { startupTimeoutMs: 0 },
    }),
  );
  await app.hosting!.boot();
  assertEquals(launched, ["ryph-tool-guard"]);
  const catalogue = await (await app.handler(await authed(app, "/v1/mcp-catalogue"))).json();
  assertEquals(catalogue.hostingAvailable, true);

  const created = await app.handler(
    await authed(app, "/v1/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "hosted",
        catalogueId: "grafana",
        name: "Grafana",
        settings: { GRAFANA_URL: "https://grafana.example.com" },
        credential: { "X-Grafana-Service-Account-Token": "not-a-real-token" },
      }),
    }),
  );
  assertEquals(created.status, 201);
  const server = await created.json();
  assertEquals([server.kind, server.host.status], ["hosted", "starting"]);
  // A marker nothing dials: the data plane dials the server's launch key on the guard.
  assertEquals(server.url, "hosted://grafana");
  await app.hosting!.idle();
  // The server's container, named by its launch key, then the guard again: its route table
  // gained that key.
  assertEquals(launched.length, 3, launched.join(", "));
  assert(/^ryph-tool-[0-9a-f]{32}$/.test(launched[1]!), launched[1]);
  assertEquals(launched[2], "ryph-tool-guard");

  // Archive, so the next test's reads of the shared database see no live hosted row.
  const archived = await app.handler(
    await authed(app, `/v1/mcp-servers/${server.id}/archive`, { method: "POST" }),
  );
  assertEquals((await archived.json()).host.status, "stopped");
  app.close();
  // The boot reconcile listed through the launcher (and read no store before it did).
  assert(dockerCalls.some((c) => c.startsWith("ps -a")), dockerCalls.join("\n"));
  await launcher.close();
});

// Not a behaviour test — the shared instance is this file's resource, and one left open keeps the
// test process up.
test("memory is mounted in-process: the surface answers, the platform row is seeded, and a run's tool call reaches it through the gateway", async () => {
  const app = await buildApp(await testConfig({ agentImage: "ryph-agent:test", ...TASKS }));
  assert(app.mcpGatewayHandler !== null);
  assert(app.consolidateMemory !== null);

  // The management surface, mounted and gated.
  const anon = await app.handler(new Request(`${BASE}/v1/memories`));
  assertEquals(anon.status, 401);
  await anon.body?.cancel();
  const written = await app.handler(
    await authed(app, "/v1/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "The app tests are vitest",
        kind: "procedure",
        subject: { kind: "repo", url: REPO.url },
      }),
    }),
  );
  assertEquals(written.status, 201);
  const memory = await written.json();
  assertEquals(memory.trust, "human");

  // The platform rows: seeded, listed, and unmanageable — memory's, and chat's and the web
  // service's beside it, since this composition mounts all three in-process.
  const servers = await (await app.handler(await authed(app, "/v1/mcp-servers"))).json();
  const platformRows = servers.mcpServers.filter((s: { kind: string }) => s.kind === "platform");
  assertEquals(platformRows.map((s: { slug: string }) => s.slug).sort(), [
    "chat",
    "memory",
    "web",
  ]);
  const webRow = platformRows.find((s: { slug: string }) => s.slug === "web");
  const platform = platformRows.find((s: { slug: string }) => s.slug === "memory");
  const archive = await app.handler(
    await authed(app, `/v1/mcp-servers/${platform.id}/archive`, { method: "POST" }),
  );
  assertEquals(archive.status, 409);
  await archive.body?.cancel();

  // A remembering agent's run: the brief rides the spec, the credentials name the memory server,
  // and a tool call through the gateway's data plane reaches the in-process memory service.
  const agent = await (await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com", harnessKind: "pi" }),
    }),
  )).json();
  assertEquals(agent.memoryPolicy, { budgetTokens: 2000 });
  const launchOutput = spyOn(console, "log");
  const task = await (await app.handler(
    await authed(app, "/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: agent.id,
        spec: { title: "Fix the tests", instructions: "vitest is red" },
        connectedRepoId: await connectedRepo(app),
      }),
    }),
  )).json();
  const printed = launchOutput.mock.calls.map((args) => args.join(" ")).join("\n");
  launchOutput.mockRestore();
  const bootstrapToken = /RYPH_BOOTSTRAP_TOKEN="([^"]+)"/.exec(printed)?.[1];
  assert(bootstrapToken);
  const run = (await app.store.getRun(task.runId))!;
  assertStringIncludes(run.injectedContext?.brief?.text ?? "", "[" + memory.id + "]");
  assertEquals(run.injectedContext?.brief?.memoryIds, [memory.id]);
  // Memory, because the agent remembers, and the web tools, which every tool-capable agent gets
  // wherever the deployment serves them.
  assertEquals(run.toolScope, {
    servers: [
      { serverId: platform.id, allowedTools: "*" },
      { serverId: webRow.id, allowedTools: "*" },
    ],
  });

  // Redeem the manual provisioner's launch token exactly as a real runner does.
  const boot = await app.handler(
    new Request(`${BASE}/v1/runs/${task.runId}/bootstrap`, {
      method: "POST",
      headers: { authorization: `Bearer ${bootstrapToken}` },
    }),
  );
  assertEquals(boot.status, 200);
  const { env } = await boot.json();
  const runToken = env.RYPH_RUN_TOKEN;
  const creds = await (await app.handler(
    new Request(`${BASE}/v1/runs/${task.runId}/credentials`, {
      headers: { authorization: `Bearer ${runToken}` },
    }),
  )).json();
  assertEquals(creds.mcp.servers.map((s: { slug: string }) => s.slug), ["memory", "web"]);
  const memoryServer = creds.mcp.servers.find((s: { slug: string }) => s.slug === "memory");
  const call = await app.mcpGatewayHandler(
    new Request(memoryServer.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.mcp.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "vitest tests" } },
      }),
    }),
  );
  assertEquals(call.status, 200);
  const answer = await call.json();
  assertStringIncludes(answer.result.content[0].text, `[${memory.id}] The app tests are vitest`);

  // And the web service, mounted the same way: its tool list reaches the run through the
  // gateway, with `search` absent because this deployment has no search key.
  const webServer = creds.mcp.servers.find((s: { slug: string }) => s.slug === "web");
  const webCall = await app.mcpGatewayHandler(
    new Request(webServer.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creds.mcp.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assertEquals(webCall.status, 200);
  assertEquals(
    (await webCall.json()).result.tools.map((t: { name: string }) => t.name),
    ["fetch"],
  );

  // The consolidator has an inbox to work.
  assertEquals(await app.consolidateMemory(), {
    screened: 0,
    promoted: 0,
    merged: 0,
    rejected: 0,
    held: 0,
    judged: 0,
    awaiting: 0,
    modelFailures: 0,
    swept: 0,
  });
  app.close();
});

// A run frozen before a deploy fetches its catalogue skills by a digest the new process may no
// longer ship: only the store has it then. So the composition must store every catalogue bundle
// at boot and hand the store to the runner surface, and nothing but this test notices if not.
test("catalogue bundles are stored at boot, and a run is served a digest only the store holds", async () => {
  const cfg = await testConfig({ agentImage: "ryph-agent:test", ...TASKS });
  const app = await buildApp(cfg);
  const db = cfg.cluster.scope(orchestratorSchema);
  const stored = new Set((await db.query.skillBundles.findMany()).map((b) => b.digest));
  const catalogue = await directorySkillCatalogue();
  assert(catalogue.list().length > 0);
  for (const skill of catalogue.list()) assert(stored.has(skill.digest), skill.name);

  const oldDigest = `sha256:${"7".repeat(64)}`;
  const oldFiles = [{ path: "SKILL.md", executable: false, content: "YWJj" }];
  await db.insert(orchestratorSchema.skillBundles)
    .values({ digest: oldDigest, files: oldFiles, bytes: 3, createdAt: new Date().toISOString() })
    .onConflictDoNothing();

  const agent = await (await app.handler(
    await authed(app, "/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Skilled", email: "skilled@example.com", harnessKind: "pi" }),
    }),
  )).json();
  const task = await (await app.handler(
    await authed(app, "/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: agent.id,
        spec: { title: "Add a check", instructions: "Lint on every push." },
        connectedRepoId: await connectedRepo(app),
      }),
    }),
  )).json();
  const run = (await app.store.getRun(task.runId))!;
  assert(run.skills !== null && run.skills.skills.length > 0, "a pi run is frozen with skills");
  const runToken = "run-token-known-to-the-test";
  // Model a run created under an older catalogue, not an edit to a live frozen scope.
  task.runId = `${run.id}-historical-fixture`;
  await app.store.saveRun({
    ...run,
    id: task.runId,
    tokenHash: await sha256Hex(runToken),
    skills: { ...run.skills, skills: [{ ...run.skills.skills[0], digest: oldDigest }] },
  });
  const res = await app.handler(
    new Request(`${BASE}/v1/runs/${task.runId}/skills/${oldDigest}`, {
      headers: { authorization: `Bearer ${runToken}` },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { files: oldFiles });
  app.close();
});

test("releases the shared database", async () => {
  await shared?.close();
  shared = null;
});

test("chat is mounted in-process: the chatroom surface answers and the poll is the host's", async () => {
  const app = await buildApp(await testConfig());
  // The surface is live (not the `chat_disabled` stand-in): an empty list, not a refusal.
  const listed = await app.handler(await authed(app, "/v1/chatrooms"));
  assertEquals(listed.status, 200);
  assertEquals(await listed.json(), { chatrooms: [] });
  // A bad token is refused where the service checks it — a 4xx, never a crash — and nothing
  // durable is written: creating a room calls the platform's getMe, which no test may reach.
  const created = await app.handler(
    await authed(app, "/v1/chatrooms", {
      method: "POST",
      body: JSON.stringify({ name: "incidents", botToken: "not-a-real-token" }),
    }),
  );
  assert(created.status >= 400 && created.status < 500, `got ${created.status}`);
  await created.body?.cancel();
  // The command-room surface is the orchestrator's own, at a path the chat routes cannot shadow.
  const room = await app.handler(await authed(app, "/v1/command-rooms/chr-none"));
  assertEquals(room.status, 404);
  assertEquals((await room.json()).error, "this chatroom has no command policy");
  // The poll pass is this process's to tick, and an empty deployment polls nothing.
  assert(app.chat !== null);
  await app.chat.pollAll(new AbortController().signal);
  app.close();
});

test("RYPH_WEB_TOOLS=off leaves the web server unmounted, unseeded and out of every scope", async () => {
  // Its OWN database: a platform row outlives the boot that seeded it, so "no row" can only be
  // asserted on a cluster no other boot in this file has touched.
  const cluster = await provisioned();
  const app = await buildApp(
    await testConfig({ cluster, webTools: false, agentImage: "ryph-agent:test", ...TASKS }),
  );
  try {
    const servers = await (await app.handler(await authed(app, "/v1/mcp-servers"))).json();
    const slugs = servers.mcpServers
      .filter((s: { kind: string }) => s.kind === "platform")
      .map((s: { slug: string }) => s.slug)
      .sort();
    assertEquals(slugs, ["chat", "memory"], "no web row was seeded");

    const agent = await (await app.handler(
      await authed(app, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Grace", email: "grace@example.com", harnessKind: "pi" }),
      }),
    )).json();
    const task = await (await app.handler(
      await authed(app, "/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          spec: { title: "Nothing", instructions: "nothing" },
          connectedRepoId: await connectedRepo(app),
        }),
      }),
    )).json();
    const run = (await app.store.getRun(task.runId))!;
    assertEquals(
      run.toolScope?.servers.some((s) => s.serverId === "ms-platform-web") ?? false,
      false,
      "no run is scoped to a server this deployment does not serve",
    );
  } finally {
    app.close();
    await cluster.close();
  }
});

test("RYPH_WEB_TOOLS=off also drops the row from an agent whose own tool policy names it", async () => {
  // A platform row cannot be archived, so a row seeded while the tools were on outlives the
  // switch — and an agent's policy may name it. The switch has to take the GRANT away, not only
  // stop adding one.
  const cluster = await provisioned();
  const on = await buildApp(await testConfig({ cluster, agentImage: "ryph-agent:test" }));
  let agentId: string;
  try {
    const servers = await (await on.handler(await authed(on, "/v1/mcp-servers"))).json();
    const web = servers.mcpServers.find((s: { slug: string }) => s.slug === "web");
    assert(web, "the row is seeded while the tools are on");
    const agent = await (await on.handler(
      await authed(on, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Hopper",
          email: "hopper@example.com",
          harnessKind: "pi",
          toolPolicy: { servers: [{ serverId: web.id, allowedTools: ["fetch"] }] },
        }),
      }),
    )).json();
    assertEquals(agent.toolPolicy.servers[0].serverId, "ms-platform-web");
    agentId = agent.id;
  } finally {
    on.close();
  }

  // Same database, same agent, tools off.
  const off = await buildApp(
    await testConfig({ cluster, webTools: false, agentImage: "ryph-agent:test", ...TASKS }),
  );
  try {
    const task = await (await off.handler(
      await authed(off, "/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          spec: { title: "Read something", instructions: "anything" },
          connectedRepoId: await connectedRepo(off),
        }),
      }),
    )).json();
    const run = (await off.store.getRun(task.runId))!;
    assertEquals(
      run.toolScope?.servers.some((s) => s.serverId === "ms-platform-web") ?? false,
      false,
      "the policy still names it; the run is not granted it",
    );
  } finally {
    off.close();
    await cluster.close();
  }
});

test("the mounted historian takes a concluded run's last flush, and nothing past the grace", async () => {
  const app = await buildApp(await testConfig({ agentImage: "ryph-agent:test", ...TASKS }));
  try {
    const agent = await (await app.handler(
      await authed(app, "/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada", email: "ada@example.com", harnessKind: "pi" }),
      }),
    )).json();
    /** A launched run and its token, redeemed as a runner redeems it. */
    const startRun = async () => {
      const launchOutput = spyOn(console, "log");
      const task = await (await app.handler(
        await authed(app, "/v1/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: agent.id,
            spec: { title: "Write it down", instructions: "keep a transcript" },
            connectedRepoId: await connectedRepo(app),
          }),
        }),
      )).json();
      const printed = launchOutput.mock.calls.map((args) => args.join(" ")).join("\n");
      launchOutput.mockRestore();
      const bootstrapToken = /RYPH_BOOTSTRAP_TOKEN="([^"]+)"/.exec(printed)?.[1];
      assert(bootstrapToken);
      const boot = await app.handler(
        new Request(`${BASE}/v1/runs/${task.runId}/bootstrap`, {
          method: "POST",
          headers: { authorization: `Bearer ${bootstrapToken}` },
        }),
      );
      return { runId: task.runId as string, token: (await boot.json()).env.RYPH_RUN_TOKEN };
    };
    const ingest = async (run: { runId: string; token: string }) => {
      const res = await app.handler(
        new Request(`${BASE}/v1/runs/${run.runId}/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${run.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            events: [{
              seq: 0,
              at: new Date().toISOString(),
              voice: "transcript",
              kind: "assistant",
              level: null,
              text: "hello",
              payload: {},
            }],
          }),
        }),
      );
      await res.body?.cancel();
      return res.status;
    };
    const conclude = async (runId: string, msAgo: number) => {
      const run = (await app.store.getRun(runId))!;
      const at = new Date(Date.now() - msAgo).toISOString();
      assert(await app.store.saveRunTransition({ ...run, state: "failed", updatedAt: at }, run));
    };

    const recent = await startRun();
    assertEquals(await ingest(recent), 200);
    // Concluded just now: the runner's final flush still lands.
    await conclude(recent.runId, 0);
    assertEquals(await ingest(recent), 200);
    // Concluded a minute ago: the token writes nothing more.
    const old = await startRun();
    await conclude(old.runId, 60_000);
    assertEquals(await ingest(old), 401);
  } finally {
    app.close();
  }
});
