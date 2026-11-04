// Forge tools, as the control plane decides them, end to end through the pure handler: the policy
// gates at the form, the scope frozen onto a run, and the surface the forge enforces through —
// grant resolve, and the ledger a write is reserved in and settled against.

import { test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeHandler, type Principal, type ToolAccess } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import type { ConnectedRepo, ForgePolicy, Patch } from "../src/core/types.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const FORGE_TOKEN = "forge-service-token";
const FORGE_SERVER = "ms-platform-forge";
const BREAK_GLASS: Principal = { kind: "break-glass" };
const PLAIN_USER: Principal = {
  kind: "user",
  userId: "u-1",
  email: "grace@example.com",
  name: "Grace",
  caps: capsClaimOf("member"),
  emailVerified: true,
  sid: "s-1",
  via: "session",
};

const CONNECTED: ConnectedRepo = {
  id: "cr-api",
  provider: "github" as const,
  installationId: "12345",
  repoRef: "acme/api",
  url: "https://github.com/acme/api.git",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const POLICY: ForgePolicy = {
  repos: "run",
  read: true,
  createIssues: { max: 2 },
  comment: { where: "origin", max: 20 },
  review: null,
  closeIssues: null,
  labels: ["bug"],
};

const toolAccess: ToolAccess = {
  getServer: (id) => Promise.resolve({ id, slug: id, name: id, archivedAt: null }),
  issueRunCredentials: () => Promise.reject(new Error("not in these tests")),
  revokeRunCredentials: () => Promise.resolve(),
  archiveServer: () => Promise.reject(new Error("not in these tests")),
};

function buildApp(opts: { forgeTools?: boolean } = {}) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner } = fakeProvisioner();
  const { control } = fakeRunnerControl();
  let caller: Principal = BREAK_GLASS;
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: () => Promise.resolve(caller),
    toolAccess,
    forgeToken: FORGE_TOKEN,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: "https://ryph.test",
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: opts.forgeTools === false ? null : FORGE_SERVER,
        pending: false,
      },
    },
  });
  return { handler, store, as: (p: Principal) => (caller = p) };
}

type Handler = (req: Request) => Promise<Response>;

function send(handler: Handler, method: string, path: string, body?: unknown, token?: string) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const agentBody = (forgePolicy: unknown, harnessKind = "pi") => ({
  name: "Ada",
  email: "ada@example.com",
  harnessKind,
  memoryPolicy: null,
  forgePolicy,
});

/** An agent with the forge policy, and a task against the connected repo: the running run. */
async function forgeRun(app: ReturnType<typeof buildApp>, policy: ForgePolicy = POLICY) {
  await app.store.createConnectedRepo(CONNECTED);
  const agentRes = await send(app.handler, "POST", "/v1/agents", agentBody(policy));
  assertEquals(agentRes.status, 201);
  const agent = await agentRes.json();
  const taskRes = await send(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: CONNECTED.id,
    spec: { title: "Triage", instructions: "File what you find." },
  });
  const created = await taskRes.json();
  assertEquals(taskRes.status, 201, JSON.stringify(created));
  const { runId, taskId } = created;
  return { agent, runId: runId as string, taskId: taskId as string };
}

const resolveGrant = (handler: Handler, runId: string, token = FORGE_TOKEN) =>
  send(handler, "POST", "/v1/forge/tool-grants/resolve", { runId }, token);

const reserve = (handler: Handler, body: Record<string, unknown>) =>
  send(handler, "POST", "/v1/forge/tool-actions", body, FORGE_TOKEN);

test("a forge policy is refused where forge tools are not wired", async () => {
  const app = buildApp({ forgeTools: false });
  const res = await send(app.handler, "POST", "/v1/agents", agentBody(POLICY));
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "forge tools are not configured");
});

test("setting a forge policy is an admin's call; clearing one is anyone's", async () => {
  const app = buildApp();
  app.as(PLAIN_USER);
  const refused = await send(app.handler, "POST", "/v1/agents", agentBody(POLICY));
  assertEquals(refused.status, 403);
  assertEquals((await refused.json()).code, "forbidden");

  app.as(BREAK_GLASS);
  const agent = await (await send(app.handler, "POST", "/v1/agents", agentBody(POLICY))).json();
  app.as(PLAIN_USER);
  const cleared = await send(app.handler, "PATCH", `/v1/agents/${agent.id}`, { forgePolicy: null });
  assertEquals(cleared.status, 200);
  assertEquals((await cleared.json()).forgePolicy, null);
});

test("a forge policy needs a tools harness and live repos; a tool policy may not name the row", async () => {
  const app = buildApp();
  assertEquals(
    (await send(app.handler, "POST", "/v1/agents", agentBody(POLICY, "echo"))).status,
    400,
  );
  const unknownRepo = await send(
    app.handler,
    "POST",
    "/v1/agents",
    agentBody({ ...POLICY, repos: { connectedRepoIds: ["cr-nope"] } }),
  );
  assertEquals(unknownRepo.status, 400);
  const nothing = await send(
    app.handler,
    "POST",
    "/v1/agents",
    agentBody({ ...POLICY, read: false, createIssues: null, comment: null, labels: [] }),
  );
  assertEquals(nothing.status, 400, "a policy granting nothing is spelled null");
  const viaTools = await send(app.handler, "POST", "/v1/agents", {
    ...agentBody(null),
    toolPolicy: { servers: [{ serverId: FORGE_SERVER, allowedTools: "*" }] },
  });
  assertEquals(viaTools.status, 400);
  assertStringIncludes((await viaTools.json()).error, "forge policy");
});

test("a run freezes its forge scope, and the forge row joins its tool scope derived", async () => {
  const app = buildApp();
  const { runId, taskId } = await forgeRun(app);
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.forgeScope?.repos, [{
    connectedRepoId: CONNECTED.id,
    provider: "github" as const,
    repoRef: "acme/api",
    tenantId: "12345",
  }]);
  assertEquals(run.forgeScope?.origin, null);
  assertEquals(run.forgeScope?.provenance.agentName, "Ada");
  assertEquals(run.forgeScope?.provenance.runUrl, `https://ryph.test/tasks/${taskId}`);
  const forgeRow = run.toolScope?.servers.find((s) => s.serverId === FORGE_SERVER);
  assertEquals(forgeRow?.allowedTools, [
    "get_issue",
    "list_issues",
    "get_change_request",
    "compare_change_request",
    "list_change_requests",
    "create_issue",
    "add_comment",
    "add_labels",
  ]);
});

test("grant resolve: the forge token only; a run without a scope, or concluded, is 404", async () => {
  const app = buildApp();
  const { runId } = await forgeRun(app);
  assertEquals((await resolveGrant(app.handler, runId, "wrong")).status, 401);
  assertEquals((await resolveGrant(app.handler, "r-nope")).status, 404);

  const grant = await (await resolveGrant(app.handler, runId)).json();
  assertEquals(grant.runId, runId);
  assertEquals(grant.repos[0].repoRef, "acme/api");
  assertEquals(grant.opened, []);
  assertEquals("workedChangeRequests" in grant, false);
  assertEquals(grant.capabilities.createIssues, { max: 2 });

  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });
  assertEquals((await resolveGrant(app.handler, runId)).status, 404);
});

test("grant resolve: worked change requests stay separate and are filtered by live scope", async () => {
  const fixture = async (includeConnected: boolean) => {
    const app = buildApp();
    const createTask = app.store.createTask;
    app.store.createTask = (task, run) => {
      run.forgeScope = {
        ...run.forgeScope!,
        workedChangeRequests: [
          ...(includeConnected ? [{ connectedRepoId: CONNECTED.id, ref: "40" }] : []),
          { connectedRepoId: "cr-outside", ref: "41" },
        ],
      };
      return createTask(task, run);
    };
    return { app, ...await forgeRun(app) };
  };
  const { app, runId } = await fixture(true);
  const grant = await (await resolveGrant(app.handler, runId)).json();
  assertEquals(grant.workedChangeRequests, [{ connectedRepoId: CONNECTED.id, ref: "40" }]);
  assertEquals(grant.opened, []);
  assertEquals(grant.origin, null);

  const outside = await fixture(false);
  const filtered = await (await resolveGrant(outside.app.handler, outside.runId)).json();
  assertEquals("workedChangeRequests" in filtered, false);
});

test("grant resolve: a repo disconnected mid-run leaves the grant", async () => {
  const app = buildApp();
  const { runId } = await forgeRun(app);
  await app.store.saveConnectedRepo({ ...CONNECTED, archivedAt: "2026-01-02T00:00:00.000Z" });
  assertEquals((await resolveGrant(app.handler, runId)).status, 404);
});

test("the ledger: reserved against the cap, settled once, opened issues join the grant", async () => {
  const app = buildApp();
  const { runId, taskId } = await forgeRun(app);
  const issue = { runId, tool: "create_issue", connectedRepoId: CONNECTED.id, threadRef: null };

  const first = await reserve(app.handler, issue);
  assertEquals(first.status, 201);
  const { actionId } = await first.json();
  assertEquals((await reserve(app.handler, issue)).status, 201);
  const over = await reserve(app.handler, issue);
  assertEquals(over.status, 409);
  assertEquals((await over.json()).code, "over_cap");

  const done = {
    runId,
    outcome: "done",
    url: "https://github.com/acme/api/issues/77",
    createdThreadRef: "77",
  };
  assertEquals(
    (await send(app.handler, "POST", `/v1/forge/tool-actions/${actionId}`, done, FORGE_TOKEN))
      .status,
    200,
  );
  assertEquals(
    (await send(app.handler, "POST", `/v1/forge/tool-actions/${actionId}`, done, FORGE_TOKEN))
      .status,
    404,
    "a settled action is never re-settled",
  );
  assertEquals(
    (await send(app.handler, "POST", `/v1/forge/tool-actions/${actionId}`, {
      ...done,
      runId: "r-other",
    }, FORGE_TOKEN)).status,
    404,
  );

  const grant = await (await resolveGrant(app.handler, runId)).json();
  assertEquals(grant.opened, [{ connectedRepoId: CONNECTED.id, ref: "77" }]);

  const view = await (await send(app.handler, "GET", `/v1/tasks/${taskId}`)).json();
  const trail = view.runs[0].forgeActions;
  assertEquals(trail.length, 2);
  assertEquals(trail[0].state, "done");
  assertEquals(trail[0].url, "https://github.com/acme/api/issues/77");
  assertEquals(trail[1].state, "reserved");
});

test("grant resolve: the pull requests the run's own patches opened join the grant", async () => {
  // a run that opened a pull request with submit_patch must be able to answer there
  // under a `comment: origin` rule, as it can on an issue it opened.
  const app = buildApp();
  const { runId, taskId } = await forgeRun(app);
  const patch = (id: string, ofRun: string, forgeRef: string | null): Patch => ({
    id,
    connectedRepoId: CONNECTED.id,
    runId: ofRun,
    taskId,
    setId: `set-${id}`,
    path: "api",
    line: "work",
    branchName: `ryph/ada/${id}/work`,
    headSha: `sha-${id}`,
    bundleKey: `${ofRun}/${CONNECTED.id}/sha-${id}.bundle`,
    baseSha: null,
    generation: 1,
    title: null,
    description: null,
    commits: [],
    carries: [],
    state: forgeRef === null ? "queued" : "submitted",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    approvedBy: null,
    approvedAt: null,
    forgeRef,
    forgeUrl: forgeRef === null ? null : `https://github.com/acme/api/pull/${forgeRef}`,
    forgeBranch: forgeRef === null ? null : `ryph/ada/${id}/work`,
    diffRef: null,
    landed: null,
    supersededByPatchId: null,
    hookCheck: null,
    approvedHookPaths: [],
    memoryFateReportedAt: null,
    mergedCuedAt: null,
    heldReason: null,
    mergedCueClaimedAt: null,
    landingAskedAt: null,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await app.store.createPatch(patch("p-1", runId, "12"));
  // A second patch pushed onto the same pull request names it once.
  await app.store.createPatch(patch("p-2", runId, "12"));
  // Not yet at the forge: no thread to write to.
  await app.store.createPatch(patch("p-3", runId, null));
  // Another attempt's pull request is not this run's.
  await app.store.createPatch(patch("p-4", "r-earlier", "13"));

  const grant = await (await resolveGrant(app.handler, runId)).json();
  assertEquals(grant.opened, [{ connectedRepoId: CONNECTED.id, ref: "12" }]);
});

test("the ledger refuses a tool the scope never granted, and a repo outside it", async () => {
  const app = buildApp();
  const { runId } = await forgeRun(app);
  const review = await reserve(app.handler, {
    runId,
    tool: "submit_review",
    connectedRepoId: CONNECTED.id,
    threadRef: "4",
  });
  assertEquals(review.status, 403);
  // closing is its own capability: a policy that comments may still close nothing
  assertEquals(
    (await reserve(app.handler, {
      runId,
      tool: "close_issue",
      connectedRepoId: CONNECTED.id,
      threadRef: "4",
    })).status,
    403,
  );
  assertEquals(
    (await reserve(app.handler, {
      runId,
      tool: "add_comment",
      connectedRepoId: "cr-elsewhere",
      threadRef: "4",
    })).status,
    403,
  );
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunTransition({ ...run, state: "cancelled" }, run);
  const over = await reserve(app.handler, {
    runId,
    tool: "add_comment",
    connectedRepoId: CONNECTED.id,
    threadRef: "4",
  });
  assertEquals(over.status, 404);
  assert((await over.json()).error.includes("over"));
});
