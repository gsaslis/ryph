// `ryph mcp`'s tools against a real deployment: the whole single-process host built in-process
// (packages/host buildApp, as its boot test builds it) over a throwaway PGlite, an owner signed
// in through the mounted auth routes, and an API token minted the way the account page mints
// one. The client talks to the host's handler directly, the app's proxy left out (its doors are
// held to the tools by mcp_doors_test.ts): what this proves is that the token exchange, the
// response shapes the tools read, and the token's own capability subset are what the services
// enforce.

import { afterAll, beforeAll, test } from "bun:test";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type DbCluster, openDbCluster } from "@ryph/db";
import { importMasterKey } from "@ryph/sealed";
import {
  DEFAULT_EGRESS_POLICY,
  DEFAULT_ENVIRONMENTS_CONFIG,
  DEFAULT_HARNESS_KINDS,
  DEFAULT_RUN_SIZES,
  DEFAULT_SERVICE_POLICY,
  NO_RUN_LIMITS,
} from "@ryph/orchestrator";
// By path: the host's package exports its `main`, and this is the composition its boot test
// drives.
import { buildApp, type HostApp } from "../../host/src/app.ts";
import { ApiError, RyphClient } from "../src/api/client.ts";
import { MIGRATION_SETS } from "../src/embedded.ts";
import { ryphTools } from "../src/mcp/server.ts";
import type { ToolContext } from "../src/mcp/tool.ts";
import { applySchema } from "../src/schema_guard.ts";

const BASE = "http://host.test";
const OWNER = { email: "owner@example.com", name: "Owner", password: "correct horse battery" };

let cluster: DbCluster;
let app: HostApp;
let session: string;

beforeAll(async () => {
  cluster = await openDbCluster("pglite:memory://");
  await applySchema(MIGRATION_SETS, cluster, null);
  app = await buildApp({
    cluster,
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
    webTools: false,
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
    proxySecret: "mcp-host-test-proxy-secret",
  });
  const post = (path: string, body: unknown, bearer?: string) =>
    app.handler(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  await (await post("/v1/auth/users", { ...OWNER, setupToken: app.auth.setupToken ?? undefined }))
    .body?.cancel();
  const login = await post("/v1/auth/login", { email: OWNER.email, password: OWNER.password });
  assertEquals(login.status, 200);
  session = (await login.json()).accessToken;
});

afterAll(async () => {
  app?.close();
  await cluster?.close();
});

/** An API token holding `caps`, minted by the owner, and a tool context speaking with it. */
async function withToken(caps: string[]): Promise<ToolContext> {
  const minted = await app.handler(
    new Request(`${BASE}/v1/auth/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
      body: JSON.stringify({ name: `mcp ${caps.join(" ")}`, caps }),
    }),
  );
  assertEquals(minted.status, 201);
  const { token } = await minted.json() as { token: string };
  // The CLI dials `<app>/api/v1/…`; the host itself answers `/v1/…`.
  const client = new RyphClient({
    url: BASE,
    token,
    warn: () => {},
    fetch: ((input: string | URL, init?: RequestInit) =>
      app.handler(
        new Request(String(input).replace(`${BASE}/api/`, `${BASE}/`), init),
      )) as typeof globalThis.fetch,
  });
  return {
    api: () => Promise.resolve(client),
    cwd: process.cwd(),
    progress: () => {},
    intervalMs: 0,
    signal: new AbortController().signal,
  };
}

function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  return ryphTools().find((t) => t.name === name)!.run(args, ctx);
}

test("whoami reads the token's own capabilities and the person behind it", async () => {
  const ctx = await withToken(["tasks:read", "agents:read"]);
  const text = await call("whoami", {}, ctx);
  assertStringIncludes(text, `Deployment: ${BASE}`);
  assertStringIncludes(text, "Owner <owner@example.com>, role owner");
  // Not the owner's `*`: the token's subset.
  assertStringIncludes(text, "Token capabilities: tasks:read, agents:read");
  assertStringIncludes(text, "Tools it can use: tasks_list, task_get");
});

test("a token's capability subset is what the services enforce", async () => {
  const reader = await withToken(["agents:read", "tasks:read"]);
  assertStringIncludes(await call("tasks_list", {}, reader), "No tasks match.");
  assertEquals(await call("agents", { action: "list" }, reader), "None.");
  const body = {
    name: "Coder",
    email: "coder@example.com",
    harnessKind: DEFAULT_HARNESS_KINDS[0],
  };
  const refused = await assertRejects(
    () => call("agents_manage", { action: "create", body }, reader),
    ApiError,
  );
  assertEquals((refused as ApiError).status, 403);
  assertStringIncludes((refused as ApiError).message, "agents:write");
  // Every service decides from the same claim: the automations service too.
  const automations = await assertRejects(
    () => call("automations", { action: "list" }, reader),
    ApiError,
  );
  assertEquals((automations as ApiError).status, 403);

  const writer = await withToken(["agents:read", "agents:write"]);
  assertStringIncludes(
    await call("agents_manage", { action: "create", body }, writer),
    '"name":"Coder"',
  );
  assertStringIncludes(await call("agents", { action: "list" }, reader), "Coder (@coder) · ");
});

test("the read tools parse what the real routes answer", async () => {
  const ctx = await withToken([
    "repos:read",
    "workspaces:read",
    "patches:read",
    "agents:read",
    "skills:read",
  ]);
  assertEquals(await call("repos", { action: "list" }, ctx), "None.");
  assertEquals(await call("workspaces", { action: "list" }, ctx), "None.");
  assertStringIncludes(await call("patches", { action: "list" }, ctx), "No patches.");
  assertStringIncludes(await call("environments", { action: "list" }, ctx), "No builds.");
  assertStringIncludes(await call("deployment", { action: "harnesses" }, ctx), "harnesses");
  assertStringIncludes(await call("checks", { action: "list" }, ctx), "No suites.");
});
