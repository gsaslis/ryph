import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The forge surface and the gateway-aware task creation, end to end through the pure handler:
// a task created against a CONNECTED repo with a configured gateway gets a rewritten WorkItem, a
// run-scoped git key in the provisioner env, and a key the gateway can resolve — until the run
// concludes. With no gateway configured, no task starts at all.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler, type ModelAccess } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import type { ConnectedRepo } from "../src/core/types.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const FORGE_TOKEN = "forge-service-token";
const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };
/** The tests' default caller: the total-bypass principal, like RYPH_AUTH=off yields. */
const BREAK_GLASS = { kind: "break-glass" } as const;

const AGENT_BODY = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  harnessKind: "echo",
};

const SPEC = {
  spec: { title: "Fix the flaky test", instructions: "Find and fix the flaky test in CI." },
};

const CONNECTED: ConnectedRepo = {
  id: "cr-payments",
  provider: "github" as const,
  installationId: "12345",
  repoRef: "acme/payments",
  url: "https://github.com/acme/payments.git",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** What the gateway serves for the connected repo: the upstream truth, base already resolved. */
const CONNECTED_REPO_REF = { url: CONNECTED.url, ref: CONNECTED.defaultBranch };

function buildApp(
  opts: {
    authenticate?: Authenticate;
    modelAccess?: ModelAccess | null;
    gitGateway?: { url: string; keyTtlMs: number } | null;
    forgeToken?: string | null;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const { control } = fakeRunnerControl();
  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: control,
    diag: silentDiagnostics(),
    authenticate: opts.authenticate ?? (() => Promise.resolve(BREAK_GLASS)),
    modelAccess: opts.modelAccess ?? null,
    forgeToken: opts.forgeToken === undefined ? FORGE_TOKEN : opts.forgeToken,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: opts.gitGateway === undefined ? GATEWAY : opts.gitGateway,
      runHistoryUrl: null,
      appUrl: null,
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
        forge: null,
        pending: false,
      },
    },
  });
  return { handler, store, clock, launches };
}

type Handler = (req: Request) => Promise<Response>;

function post(handler: Handler, path: string, body: unknown, token?: string) {
  return handler(
    new Request(`http://orchestrator.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function createAgent(app: ReturnType<typeof buildApp>) {
  const agentRes = await post(app.handler, "/v1/agents", AGENT_BODY);
  assertEquals(agentRes.status, 201);
  return await agentRes.json();
}

/** Creates agent + connected-repo task — the only shape the gateway serves. */
async function createGatewayTask(
  app: ReturnType<typeof buildApp>,
  taskBody: Record<string, unknown> = {},
) {
  await app.store.createConnectedRepo(CONNECTED);
  const agent = await createAgent(app);
  const taskRes = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: CONNECTED.id,
    ...SPEC,
    ...taskBody,
  });
  return { taskRes, agent };
}

function resolveKey(handler: Handler, token: string, serviceToken = FORGE_TOKEN) {
  return post(handler, "/v1/forge/git-keys/resolve", { token }, serviceToken);
}

test("gateway-backed task: WorkItem points at the gateway, env carries the key", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  assertEquals(taskRes.status, 201);
  const { runId } = await taskRes.json();

  const env = await bootstrapEnv(app.handler, app.launches[0].env!);
  assertEquals(env.RYPH_GIT_ORIGIN, GATEWAY.url);
  assert(env.RYPH_GIT_TOKEN, "the run-scoped git key arrives in the bootstrap response");

  const run = await app.store.getRun(runId);
  assertEquals(run!.workItem.repos.length, 1);
  assertEquals(
    run!.workItem.repos[0].url,
    `${GATEWAY.url}/v1/git/${runId}/${CONNECTED.id}/repo.git`,
  );
  assertEquals(run!.workItem.repos[0].ref, "main");
  // The task row keeps the user-named repo as user-facing truth.
  const task = await app.store.getTask(run!.taskId);
  assertEquals(task!.repos.length, 1);
  assertEquals({ url: task!.repos[0].url, ref: task!.repos[0].ref }, CONNECTED_REPO_REF);
});

test("gateway ref normalization: refs/heads/* narrows, refs/tags/* is refused", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app, { ref: "refs/heads/develop" });
  assertEquals(taskRes.status, 201);
  const { runId } = await taskRes.json();
  assertEquals((await app.store.getRun(runId))!.workItem.repos[0].ref, "develop");

  const refused = await createGatewayTask(app, { ref: "refs/tags/v1.0" });
  assertEquals(refused.taskRes.status, 400);
  assertStringIncludes((await refused.taskRes.json()).error, "not a tag or a pull request ref");
});

test("a pull request's head is no ref a task may be started on by hand", async () => {
  // Only the doors that know a head is a fork's (a `/ryph`, `targetChangeRequest`) check one out:
  // as a plain ref it would run with the head's own setup, context files and skills.
  const app = buildApp();
  for (const ref of ["refs/pull/42/head", "pull/42/head", "refs/heads/pull/42/head"]) {
    const { taskRes } = await createGatewayTask(app, { ref });
    assertEquals(taskRes.status, 400, ref);
    assertStringIncludes((await taskRes.json()).error, "pull request ref");
  }
  assertEquals(app.launches.length, 0);
});

test("no gateway configured: no task starts, nothing launches, forge surface dark", async () => {
  // The gateway is the only way a run reaches a repository: without one, a task on a connected
  // repo has nothing to clone and is refused before anything is persisted.
  const app = buildApp({ gitGateway: null, forgeToken: null });
  const { taskRes } = await createGatewayTask(app);
  assertEquals(taskRes.status, 503);
  assertStringIncludes((await taskRes.json()).error, "git gateway");
  assertEquals(app.launches, []);
  assertEquals((await app.store.listTasks()).tasks, []);

  const res = await resolveKey(app.handler, "anything");
  assertEquals(res.status, 404); // not mounted at all
  await res.body?.cancel();
});

test("key resolve: the grant carries the run and the UPSTREAM repo", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  const { runId } = await taskRes.json();
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  const res = await resolveKey(app.handler, token);
  assertEquals(res.status, 200);
  const grant = await res.json();
  assertEquals(grant.runId, runId);
  // One member per connected repo of the checkout: the upstream truth, never the gateway URL.
  assertEquals(grant.repos.length, 1);
  assertEquals(grant.repos[0].connectedRepoId, CONNECTED.id);
  assertEquals({ url: grant.repos[0].url, ref: grant.repos[0].ref }, CONNECTED_REPO_REF);
  assertEquals(grant.repos[0].branchNamespace, (await app.store.getRun(runId))!.branchNamespace);
});

test("key resolve: the grant names the tenant that granted us the repo", async () => {
  // What lets the gateway clone a PRIVATE base: an id it can mint an installation token from.
  // The id, never the token — this control plane hands out names of credentials, not credentials.
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  await taskRes.body?.cancel();
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  const grant = await (await resolveKey(app.handler, token)).json();
  assertEquals(grant.repos[0].tenantId, CONNECTED.installationId);
  assertStringIncludes(JSON.stringify(grant), CONNECTED.installationId!);
  // And nothing that could BE a credential rode along.
  assertEquals(Object.keys(grant).sort(), ["repos", "runId"]);
  assertEquals(
    Object.keys(grant.repos[0]).sort(),
    ["branchNamespace", "connectedRepoId", "provider", "ref", "repoRef", "tenantId", "url"],
  );
});

test("key resolve: a GitLab member carries its project id, which the gateway fetches it by", async () => {
  // A project renamed keeps its id while its old path can be taken by another: the gateway must
  // reach the project by the id, so the grant names it — read live off the project's row.
  const app = buildApp();
  const gitlab: ConnectedRepo = {
    ...CONNECTED,
    provider: "gitlab",
    installationId: null,
    repoRef: "acme/payments",
    url: "https://gitlab.example/acme/payments.git",
  };
  await app.store.createConnectedRepo(gitlab);
  await app.store.createGitlabProject(
    gitlab.id,
    "4242",
    "https://gitlab.example",
    "2026-01-01T00:00:00.000Z",
  );
  const agent = await createAgent(app);
  const taskRes = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: gitlab.id,
    ...SPEC,
  });
  assertEquals(taskRes.status, 201, await taskRes.clone().text());
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  const grant = await (await resolveKey(app.handler, token)).json();
  assertEquals(grant.repos[0].provider, "gitlab");
  // The project's id on the instance it was connected on: the forge refuses it anywhere else.
  assertEquals(grant.repos[0].forgeId, "4242@https://gitlab.example");
  assertEquals(grant.repos[0].tenantId, null);
});

test("key resolve: a repo whose origin drifted loses its tenant, it does not keep it", async () => {
  // The task row's URL and the connected repo's agree by construction — both come off the row.
  // If they ever stop agreeing, the tenant's live token would be pointed at a host that tenant
  // never vouched for. Degrade to an anonymous fetch; never send it anyway.
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  await taskRes.body?.cancel();
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  await app.store.saveConnectedRepo({ ...CONNECTED, url: "https://evil.test/acme/payments.git" });

  const grant = await (await resolveKey(app.handler, token)).json();
  assertEquals(grant.repos[0].tenantId, null);
  // the task row is still the upstream truth
  assertEquals({ url: grant.repos[0].url, ref: grant.repos[0].ref }, CONNECTED_REPO_REF);
});

test("key resolve: wrong service token is 401, unknown key is 404", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  await taskRes.body?.cancel();
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  assertEquals((await resolveKey(app.handler, token, "not-the-forge-token")).status, 401);
  assertEquals((await resolveKey(app.handler, "no-such-key")).status, 404);
});

test("key resolve: an expired key answers exactly like an unknown one", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  await taskRes.body?.cancel();
  const token = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;

  app.clock.advance(GATEWAY.keyTtlMs + 1);
  assertEquals((await resolveKey(app.handler, token)).status, 404);
});

test("key resolve: a concluded run's key resolves nothing (and the result revokes it)", async () => {
  const app = buildApp();
  const { taskRes } = await createGatewayTask(app);
  const { runId } = await taskRes.json();
  const gitToken = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_GIT_TOKEN;
  const runToken = (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_RUN_TOKEN;

  assertEquals((await resolveKey(app.handler, gitToken)).status, 200);

  const report = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "failure",
    reason: "nothing produced",
    summary: "",
    branches: [],
  }, runToken);
  assertEquals(report.status, 200);

  assertEquals((await resolveKey(app.handler, gitToken)).status, 404);
});
