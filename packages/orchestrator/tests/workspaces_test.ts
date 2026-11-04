import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// Workspaces end to end with no GitHub anywhere: a saved list of connected repos becomes what a
// task checks out, what a `/ryph` command on any of its repos expands to, and what an
// automation targets — one grant naming the set, one patch per repo the run changed, grouped
// as a set, and the live permission gate on every member.

import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { sweepPatches, sweepProgressComments } from "../src/core/reaper.ts";
import { withoutSiblings } from "../src/http/forge_api.ts";
import type { StartTaskRepo } from "../src/core/start_task.ts";
import type { ConnectedRepo } from "../src/core/types.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "../src/core/patch_lifecycle.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { defaultPathFor, MAX_REPOS } from "../src/core/workspaces.ts";
import type { Forge, ForgePermission, GithubConnect } from "../src/ports/forge.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };
const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: ["*"],
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;

const API = {
  fullName: "acme/api",
  url: "https://github.com/acme/api.git",
  defaultBranch: "main",
  private: true,
};
const WEB = {
  fullName: "acme/web",
  url: "https://github.com/acme/web.git",
  defaultBranch: "develop",
  private: true,
};
const DOCS = {
  fullName: "acme/docs",
  url: "https://github.com/acme/docs.git",
  defaultBranch: "main",
  private: false,
};

function buildApp(
  opts: {
    forge?: Forge;
    /** GitHub's connect surface, beside the port: a test that supplies its own forge with a
     * different installation listing supplies this too. */
    githubConnect?: GithubConnect;
    permission?: ForgePermission;
    role?: Role;
    /** Turn service containers on, so a member's `.ryph/services.yml` is read at all. */
    services?: boolean;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const forge = opts.forge ??
    noopForge(silentDiagnostics(), {
      permission: opts.permission ?? "allowed",
      repos: [API, WEB, DOCS],
    });
  // The caller's platform role, switchable mid-test: `repos:manage-all` is the one key to a
  // workspace that does not go through the forge.
  let role: Role = opts.role ?? "owner";
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate:
      (() => Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    forgeToken: "forge-service-token",
    automationsToken: "automations-service-token",
    forge,
    githubConnect: opts.githubConnect ??
      noopForge(silentDiagnostics(), { repos: [API, WEB, DOCS] }),
    identityDirectory: identities.directory,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
      runHistoryUrl: null,
      appUrl: null,
      services: opts.services
        ? { ...DEFAULT_SERVICE_POLICY, enabled: true }
        : DEFAULT_SERVICE_POLICY,
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
  };
  return {
    handler: makeHandler(deps),
    deps,
    store,
    clock,
    launches,
    forge,
    identities,
    setRole: (r: Role) => (role = r),
  };
}

type Handler = (req: Request) => Promise<Response>;
const call = (
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
  token = "t",
) =>
  handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const post = (handler: Handler, path: string, body: unknown = {}, token = "t") =>
  call(handler, "POST", path, body, token);
const get = (handler: Handler, path: string) => call(handler, "GET", path);

/** Identity, installation, both repos connected, an agent — and a workspace holding both. */
async function prepare(app: ReturnType<typeof buildApp>) {
  app.identities.link(USER.userId, "noop-ada-lovelace");
  assertEquals(
    (await post(app.handler, "/v1/installations", { installationId: "42" })).status,
    201,
  );
  const api = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: API.fullName,
  })).json();
  const web = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: WEB.fullName,
  })).json();
  const agent = await (await post(app.handler, "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const created = await post(app.handler, "/v1/workspaces", {
    name: "Shop",
    description: "the storefront and its API",
  });
  assertEquals(created.status, 201);
  const { workspace } = await created.json();
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
      connectedRepoId: api.id,
      description: "the API, deployed as prod-api",
    })).status,
    201,
  );
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
      connectedRepoId: web.id,
      path: "frontend",
      description: "the dashboard, talks to the API over /v1",
    })).status,
    201,
  );
  return { api, web, agent, workspace };
}

test("a workspace is a saved list: default paths, overrides, and the two uniqueness rules", async () => {
  const app = buildApp();
  const { api, web, workspace } = await prepare(app);

  const shown = await (await get(app.handler, `/v1/workspaces/${workspace.id}`)).json();
  assertEquals(shown.workspace.name, "Shop");
  assertEquals(shown.repos.map((r: { path: string }) => r.path), ["api", "frontend"]);
  assertEquals(defaultPathFor("Acme/Web_App"), "web-app");

  // A repo belongs to at most one workspace — refused, naming the one that holds it.
  const other = await (await post(app.handler, "/v1/workspaces", { name: "Other" })).json();
  const twice = await post(app.handler, `/v1/workspaces/${other.workspace.id}/repos`, {
    connectedRepoId: api.id,
  });
  assertEquals(twice.status, 409);
  assertStringIncludes((await twice.json()).error, "already belongs to workspace Shop");

  // A path is unique within the workspace: the second `frontend` is refused at the door.
  const moved = await call(
    app.handler,
    "PATCH",
    `/v1/workspaces/${workspace.id}/repos/${api.id}`,
    { path: "frontend" },
  );
  assertEquals(moved.status, 409);
  // ...and a path is a label: nothing that could nest or escape.
  const bad = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}/repos/${api.id}`, {
    path: "../etc",
  });
  assertEquals(bad.status, 400);

  // Removing frees the repo for another workspace; archiving keeps the row.
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${web.id}`)).status,
    200,
  );
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${other.workspace.id}/repos`, {
      connectedRepoId: web.id,
    })).status,
    201,
  );
  const archived = await post(app.handler, `/v1/workspaces/${other.workspace.id}/archive`);
  assertEquals((await archived.json()).workspace.archivedAt !== null, true);
  assertEquals(
    (await get(app.handler, "/v1/workspaces")).status,
    200,
  );
});

test("a task on a workspace checks out the list: one grant naming the set, one patch per repo, one set", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);

  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Add the field", instructions: "Add it to the API and show it." },
    workspaceId: workspace.id,
  });
  assertEquals(created.status, 201);
  const { taskId, runId } = await created.json();

  // The task froze the list — upstream URLs, the workspace's refs and paths, the descriptions.
  const task = (await app.store.getTask(taskId))!;
  assertEquals(task.workspaceId, workspace.id);
  assertEquals(
    task.repos.map((r) => ({ id: r.connectedRepoId, url: r.url, ref: r.ref, path: r.path })),
    [
      { id: api.id, url: API.url, ref: "main", path: "api" },
      { id: web.id, url: WEB.url, ref: "develop", path: "frontend" },
    ],
  );
  assertEquals(task.repos[1].description, "the dashboard, talks to the API over /v1");
  // The run clones each through the gateway, as a member of the one grant.
  const run = (await app.store.getRun(runId))!;
  assertEquals(run.workItem.repos.map((r) => r.url), [
    `${GATEWAY.url}/v1/git/${runId}/${api.id}/repo.git`,
    `${GATEWAY.url}/v1/git/${runId}/${web.id}/repo.git`,
  ]);
  assertEquals(run.workItem.workspace, { name: "Shop", description: "the storefront and its API" });
  assertEquals(
    new Set(run.workItem.repos.map((r) => r.branchNamespace)).size,
    1,
    "one branch namespace",
  );

  // The grant: the run, and both members with their upstreams and refs.
  const env = await bootstrapEnv(app.handler, app.launches[0].env!);
  const grant = await (await post(
    app.handler,
    "/v1/forge/git-keys/resolve",
    { token: env.RYPH_GIT_TOKEN },
    "forge-service-token",
  )).json();
  assertEquals(grant.runId, runId);
  assertEquals(
    grant.repos.map((r: { connectedRepoId: string; ref: string }) => [r.connectedRepoId, r.ref]),
    [[api.id, "main"], [web.id, "develop"]],
  );

  // The result ships both repos: two patches, one set, each against its own repo and base.
  const sha = (c: string) => c.repeat(40);
  const reported = await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [
      {
        connectedRepoId: api.id,
        path: "api",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("a"),
        commits: [{ sha: sha("a"), subject: "api: add the field" }],
        generation: 1,
        carries: [],
      },
      {
        connectedRepoId: web.id,
        path: "frontend",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("b"),
        commits: [{ sha: sha("b"), subject: "web: show the field" }],
        generation: 1,
        carries: [],
      },
    ],
    summary: "Added the field end to end.",
  }, env.RYPH_RUN_TOKEN);
  assertEquals(reported.status, 200);
  const patches = await app.store.patchesForTask(taskId);
  assertEquals(patches.map((p) => [p.connectedRepoId, p.path]), [[api.id, "api"], [
    web.id,
    "frontend",
  ]]);
  assertEquals(new Set(patches.map((p) => p.setId)).size, 1, "born together, one set");
  assertEquals(await app.store.patchesForSet(patches[0].setId), patches);
  assertEquals(patches[1].bundleKey, `${runId}/work/${web.id}/${sha("b")}.bundle`);

  // Each patch carries ITS repo's commits, not the run's.
  const listed = await (await get(app.handler, "/v1/patches?state=pending_approval")).json();
  const frontend = listed.patches.find((p: { path: string }) => p.path === "frontend");
  assertEquals(frontend.repoRef, WEB.fullName);
  assertEquals(frontend.commits.map((c: { subject: string }) => c.subject), [
    "web: show the field",
  ]);

  // Approved and swept: two submissions, each to its own repo and base, each naming the other.
  for (const patch of patches) {
    assertEquals((await post(app.handler, `/v1/patches/${patch.id}/approve`)).status, 200);
  }
  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store: app.store,
      forge,
      diag: silentDiagnostics(),
      identityDirectory: app.identities.directory,
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(
    forge.submissions.map((s) => [s.repo.repoRef, s.baseBranch]),
    [[API.fullName, "main"], [WEB.fullName, "develop"]],
  );
  assertStringIncludes(forge.submissions[0].body, "api: add the field");
  assert(!forge.submissions[0].body.includes("web: show the field"), "its own commits only");
  // Each says how many other parts there are, and never which: a pull request is read in its
  // own repo, which may be public while a sibling is private.
  for (const submission of forge.submissions) {
    assertStringIncludes(
      submission.body,
      "**Part of a set.** This run also changed 1 other repository",
    );
  }
  assert(!forge.submissions[0].body.includes("frontend"), "no sibling path");
  assert(!forge.submissions[0].body.includes(WEB.fullName), "no sibling name");
  assert(!forge.submissions[1].body.includes(API.fullName), "no sibling name, and no link");
  assert(!forge.submissions[1].body.includes("/pull/"), "no link to a sibling's pull request");

  // The task view groups them: the workspace resolves, the patches say their set.
  const view = await (await get(app.handler, `/v1/tasks/${taskId}`)).json();
  assertEquals(view.workspace.name, "Shop");
  assertEquals(view.patches.length, 2);
});

/** A forge that grants everything until told to deny one repo — so the setup that needs admin
 * on both goes through, and the access loss lands on the door under test. */
function forgeDenying(fullName: string) {
  const forge = noopForge(silentDiagnostics(), { repos: [API, WEB, DOCS] });
  let denying = false;
  const denyingForge: Forge = {
    ...forge,
    checkPermission: (repo) =>
      Promise.resolve(
        denying && repo.repoRef === fullName ? "denied" as const : "allowed" as const,
      ),
  };
  return { forge: denyingForge, comments: forge.comments, deny: () => (denying = true) };
}

test("the permission gate loops: write on every repo, or no task at all", async () => {
  // A forge that grants the API and denies the web repo: the task must not start with half
  // the checkout, and the refusal names the repo.
  const denyWeb = forgeDenying(WEB.fullName);
  const app = buildApp({ forge: denyWeb.forge });
  const { agent, workspace } = await prepare(app);
  denyWeb.deny();
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "t", instructions: "i" },
    workspaceId: workspace.id,
  });
  assertEquals(created.status, 403);
  assertStringIncludes((await created.json()).error, WEB.fullName);
  assertEquals(app.launches.length, 0);
});

test("a result naming a repo the task never held opens no patch for it", async () => {
  const app = buildApp();
  const { api, agent } = await prepare(app);
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "t", instructions: "i" },
    connectedRepoId: api.id,
  });
  const { taskId, runId } = await created.json();
  const run = (await app.store.getRun(runId))!;
  await post(app.handler, `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [{
      connectedRepoId: "cr-somebody-elses",
      path: "api",
      name: `${run.branchNamespace}/work`,
      line: "work",
      headSha: "f".repeat(40),
      commits: [{ sha: "f".repeat(40), subject: "x" }],
      generation: 1,
      carries: [],
    }],
    summary: "",
  }, (await bootstrapEnv(app.handler, app.launches[0].env!)).RYPH_RUN_TOKEN);
  assertEquals(await app.store.patchesForTask(taskId), []);
});

test("a /ryph command on a repo in a workspace checks out the workspace, its own repo at the thread's branch", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  assertEquals(agent.handle, "ada");

  // A pull request on the WEB repo: web at the PR head, api at the workspace's ref.
  const res = await post(app.handler, "/v1/forge/events", {
    deliveryId: "gh-1",
    kind: "issue_comment.created",
    repo: {
      provider: "github",
      repoRef: "Acme/Web",
      url: "https://github.com/Acme/Web.git",
    },
    actorLogin: "noop-ada-lovelace",
    thread: { kind: "change_request", ref: "7" },
    body: "/ryph ada address the review",
    sourceCommentId: "1",
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  const body = await res.json();
  assertEquals(body.outcome, "started");
  const task = (await app.store.getTask(body.taskId))!;
  assertEquals(task.workspaceId, workspace.id);
  assertEquals(task.repos.map((r) => [r.path, r.ref]), [
    ["api", "main"],
    ["frontend", "refs/heads/noop/pr-7"],
  ]);
  // The pull request target names ITS repo: the api's patch opens a pull request of its own.
  assertEquals(task.targetChangeRequest, { connectedRepoId: web.id, thread: "7" });
  assertStringIncludes(task.spec.instructions!, "checked out under `frontend/` at `noop/pr-7`");
  assertStringIncludes(task.spec.instructions!, `checked out beside it: ${API.fullName}`);

  // The run's work in both repos: web pushes onto the PR, api opens a pull request.
  const run = (await app.store.getRun(body.runId))!;
  const sha = (c: string) => c.repeat(40);
  await post(app.handler, `/v1/runs/${run.id}/result`, {
    status: "success",
    branches: [
      {
        connectedRepoId: api.id,
        path: "api",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("a"),
        commits: [{ sha: sha("a"), subject: "api" }],
        generation: 1,
        carries: [],
      },
      {
        connectedRepoId: web.id,
        path: "frontend",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("b"),
        commits: [{ sha: sha("b"), subject: "web" }],
        generation: 1,
        carries: [],
      },
    ],
    summary: "done",
  }, (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN);
  for (const patch of await app.store.patchesForTask(task.id)) {
    await post(app.handler, `/v1/patches/${patch.id}/approve`);
  }
  const forge = app.forge as ReturnType<typeof noopForge>;
  await sweepPatches(
    {
      store: app.store,
      forge,
      diag: silentDiagnostics(),
      identityDirectory: app.identities.directory,
      now: app.clock.now,
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(
    forge.submissions.map((s) => [s.repo.repoRef, s.baseBranch, s.changeRequest ?? null]),
    [[API.fullName, "main", null], [WEB.fullName, "noop/pr-7", "7"]],
  );
});

test("a /ryph command is denied when the commenter lacks write on a sibling repo", async () => {
  const denyWeb = forgeDenying(WEB.fullName);
  const app = buildApp({ forge: denyWeb.forge });
  await prepare(app);
  denyWeb.deny();
  // The command lands on the API repo, which the commenter may write — but the workspace
  // checks out the web repo beside it, which they may not.
  const res = await post(app.handler, "/v1/forge/events", {
    deliveryId: "gh-2",
    kind: "issue_comment.created",
    repo: { provider: "github", repoRef: API.fullName, url: API.url },
    actorLogin: "noop-ada-lovelace",
    thread: { kind: "issue", ref: "3" },
    body: "/ryph ada fix it",
    sourceCommentId: "2",
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  assertEquals((await res.json()).outcome, "denied");
  assertEquals(app.launches.length, 0);
  // Said out loud — but the thread may be public and the sibling private, so the reply names
  // the workspace, never the sibling.
  const refusal = denyWeb.comments.find((c) => c.body.includes("no write access to"));
  assert(refusal !== undefined, "the refusal is said out loud");
  assertStringIncludes(refusal.body, `another repo of workspace "Shop"`);
  assert(!refusal.body.includes(WEB.fullName), "a private sibling is never named in a thread");
});

test("a /ryph command beside a local sibling asks the forge nothing about it", async () => {
  // A forge that denies the local path outright: a GitHub login is not an identity on a
  // directory, and asking about one could only ever refuse a sibling whose `write` is
  // subjectless.
  const LOCAL = "/Users/ada/code/payments";
  const denyLocal = forgeDenying(LOCAL);
  const app = buildApp({ forge: denyLocal.forge });
  const { workspace } = await prepare(app);
  const local: ConnectedRepo = {
    id: "cr-local",
    provider: "local",
    installationId: null,
    repoRef: LOCAL,
    url: LOCAL,
    defaultBranch: "trunk",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await app.store.createConnectedRepo(local);
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
      connectedRepoId: local.id,
    })).status,
    201,
  );
  denyLocal.deny();
  const res = await post(app.handler, "/v1/forge/events", {
    deliveryId: "gh-local",
    kind: "issue_comment.created",
    repo: { provider: "github", repoRef: API.fullName, url: API.url },
    actorLogin: "noop-ada-lovelace",
    thread: { kind: "issue", ref: "3" },
    body: "/ryph ada fix it",
    sourceCommentId: "2",
    receivedAt: "2026-01-01T00:00:00.000Z",
  }, "forge-service-token");
  const body = await res.json();
  assertEquals(body.outcome, "started", JSON.stringify(body));
  const task = (await app.store.getTask(body.taskId))!;
  assert(
    task.repos.some((r) => r.connectedRepoId === local.id),
    "the local sibling is checked out",
  );
});

test("an automation targets a workspace and fires on its list as it stands", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  const fire = (eventId: string) =>
    post(app.handler, "/v1/automations/events", {
      eventId,
      automationId: "auto-1",
      name: "alert triage",
      ownerUserId: "u-1",
      agentId: agent.id,
      target: { kind: "workspace", workspaceId: workspace.id },
      instructions: "find which repo the alert belongs to",
      payload: '{"alert":"5xx on prod-api"}',
      firedAt: "2026-01-01T00:00:00.000Z",
    }, "automations-service-token");

  const first = await (await fire("hook-1")).json();
  assertEquals(first.outcome, "started");
  const task = (await app.store.getTask(first.taskId))!;
  assertEquals(task.repos.map((r) => r.connectedRepoId), [api.id, web.id]);
  assertEquals(task.workspaceId, workspace.id);

  // The workspace edited between fires: the next fire sees the change, the started run did not.
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${web.id}`)).status,
    200,
  );
  const second = await (await fire("hook-2")).json();
  assertEquals(second.outcome, "started");
  assertEquals((await app.store.getTask(second.taskId))!.repos.map((r) => r.connectedRepoId), [
    api.id,
  ]);
  assertEquals((await app.store.getTask(first.taskId))!.repos.length, 2);

  // A workspace that is gone is its own verdict.
  const gone = await (await post(app.handler, "/v1/automations/events", {
    eventId: "hook-3",
    automationId: "auto-1",
    name: "alert triage",
    ownerUserId: "u-1",
    agentId: agent.id,
    target: { kind: "workspace", workspaceId: "ws-nope" },
    instructions: "x",
    payload: "{}",
    firedAt: "2026-01-01T00:00:00.000Z",
  }, "automations-service-token")).json();
  assertEquals(gone.outcome, "no-such-workspace");
});

// ---- managing a workspace ------------------------------------------------------------

/** A `/ryph` command on `repo`'s issue #3, as the forge delivers it. */
const commandOn = (
  repo: { fullName: string; url: string },
  deliveryId: string,
  commentId: string,
) => ({
  deliveryId,
  kind: "issue_comment.created",
  repo: { provider: "github", repoRef: repo.fullName, url: repo.url },
  actorLogin: "noop-ada-lovelace",
  thread: { kind: "issue", ref: "3" },
  body: "/ryph ada fix it",
  sourceCommentId: commentId,
  receivedAt: "2026-01-01T00:00:00.000Z",
});

test("managing a workspace takes admin on every member, or repos:manage-all", async () => {
  const denyWeb = forgeDenying(WEB.fullName);
  const app = buildApp({ forge: denyWeb.forge, role: "member" });
  const { api, web, workspace } = await prepare(app);
  const shown = () => get(app.handler, `/v1/workspaces/${workspace.id}`).then((r) => r.json());
  assertEquals((await shown()).canManage, true, "admin on both members: theirs to manage");

  // Admin on the API repo only: the workspace is no longer theirs to shape, and the API says
  // so before any click — on the one and in the list.
  denyWeb.deny();
  assertEquals((await shown()).canManage, false);
  const listed = await (await get(app.handler, "/v1/workspaces")).json();
  assertEquals(listed.workspaces.map((w: { canManage: boolean }) => w.canManage), [false]);

  // Rename, archive, edit a member, add a repo they ARE admin on: refused, naming the member
  // that gates it.
  const rename = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, {
    name: "Store",
  });
  assertEquals(rename.status, 403);
  assertStringIncludes((await rename.json()).error, WEB.fullName);
  assertEquals((await post(app.handler, `/v1/workspaces/${workspace.id}/archive`)).status, 403);
  assertEquals(
    (await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}/repos/${api.id}`, {
      description: "the API, now with feelings",
    })).status,
    403,
  );
  const docs = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: DOCS.fullName,
  })).json();
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: docs.id }))
      .status,
    403,
    "admin on the repo joining is not enough: joining changes every member's tasks",
  );
  const unchanged = await shown();
  assertEquals(unchanged.workspace.name, "Shop");
  assertEquals(unchanged.workspace.archivedAt, null);
  assertEquals(unchanged.repos.length, 2);

  // Taking their OWN repo out stays theirs to do; the other member's is not.
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${web.id}`)).status,
    403,
  );
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${api.id}`)).status,
    200,
  );

  // `repos:manage-all` is the other key: it opens every door without asking the forge.
  app.setRole("owner");
  assertEquals((await shown()).canManage, true);
  assertEquals(
    (await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, { name: "Store" })).status,
    200,
  );
});

test("a member's ref must name a branch, refused where the ref is typed", async () => {
  // A tag or a pull-request ref is a ref NAME git would take, so it saved happily — and then
  // every future task on the workspace was unstartable, because a run clones through the
  // gateway's cache, which anchors a base on a local branch. That refusal would land on
  // whoever launched a task days later; it belongs on whoever edited the workspace.
  const app = buildApp();
  const { api, workspace } = await prepare(app);
  const docs = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: DOCS.fullName,
  })).json();

  const before = (await app.store.findWorkspaceRepo(api.id))!.ref;
  for (const ref of ["refs/tags/v1.0", "refs/pull/7/head"]) {
    assertEquals(
      (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
        connectedRepoId: docs.id,
        ref,
      })).status,
      400,
      `adding a member at ${ref}`,
    );
    assertEquals(
      (await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}/repos/${api.id}`, { ref }))
        .status,
      400,
      `moving a member to ${ref}`,
    );
  }
  // Untouched by the refusals: the member still sits where it did.
  assertEquals((await app.store.findWorkspaceRepo(api.id))!.ref, before);

  // A branch, in either spelling, is what these doors are for.
  assertEquals(
    (await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}/repos/${api.id}`, {
      ref: "refs/heads/release",
    })).status,
    200,
  );
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
      connectedRepoId: docs.id,
      ref: "release-2",
    })).status,
    201,
  );
});

test("archiving a workspace releases its repos: they run alone again and may join another", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  const archived = await post(app.handler, `/v1/workspaces/${workspace.id}/archive`);
  assertEquals(archived.status, 200);
  const body = await archived.json();
  assert(body.workspace.archivedAt !== null);
  assertEquals(body.repos, [], "the members are released, not kept bound to history");
  assertEquals(await app.store.findWorkspaceRepo(api.id), null);

  // A command on a released repo checks out that repo alone — what the archive dialog says.
  const res = await post(
    app.handler,
    "/v1/forge/events",
    commandOn(API, "gh-9", "9"),
    "forge-service-token",
  );
  const started = await res.json();
  assertEquals(started.outcome, "started");
  const task = (await app.store.getTask(started.taskId))!;
  assertEquals(task.repos.map((r) => r.connectedRepoId), [api.id]);
  assertEquals(task.workspaceId, null);

  // A released repo may join another workspace; the archived one is history, not a target.
  const other = await (await post(app.handler, "/v1/workspaces", { name: "Other" })).json();
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${other.workspace.id}/repos`, {
      connectedRepoId: web.id,
    })).status,
    201,
  );
  const onArchived = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "t", instructions: "i" },
    workspaceId: workspace.id,
  });
  assertEquals(onArchived.status, 409);
  assertStringIncludes((await onArchived.json()).error, "archived");
  // Archiving twice is the same archive.
  assertEquals((await post(app.handler, `/v1/workspaces/${workspace.id}/archive`)).status, 200);
});

test("a workspace holds at most MAX_REPOS repos — the most a run can check out", async () => {
  const many = Array.from({ length: MAX_REPOS + 1 }, (_, i) => ({
    fullName: `acme/r${i}`,
    url: `https://github.com/acme/r${i}.git`,
    defaultBranch: "main",
    private: true,
  }));
  const listing = noopForge(silentDiagnostics(), { repos: many });
  const app = buildApp({ forge: listing, githubConnect: listing });
  app.identities.link(USER.userId, "noop-ada-lovelace");
  assertEquals(
    (await post(app.handler, "/v1/installations", { installationId: "42" })).status,
    201,
  );
  const { workspace } = await (await post(app.handler, "/v1/workspaces", { name: "Big" })).json();
  const ids: string[] = [];
  for (const granted of many) {
    const connected = await (await post(app.handler, "/v1/connected-repos", {
      installationId: "42",
      repoRef: granted.fullName,
    })).json();
    ids.push(connected.id);
  }
  for (const id of ids.slice(0, MAX_REPOS)) {
    assertEquals(
      (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: id }))
        .status,
      201,
    );
  }
  const overflow = await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, {
    connectedRepoId: ids[MAX_REPOS],
  });
  assertEquals(overflow.status, 409);
  assertStringIncludes((await overflow.json()).error, `already holds ${MAX_REPOS} repos`);
});

test("a repo disconnected mid-run drops out of the run's grant at the next resolve", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  const created = await (await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "t", instructions: "i" },
    workspaceId: workspace.id,
  })).json();
  const env = await bootstrapEnv(app.handler, app.launches[0].env!);
  const resolve = async () =>
    (await (await post(
      app.handler,
      "/v1/forge/git-keys/resolve",
      { token: env.RYPH_GIT_TOKEN },
      "forge-service-token",
    )).json()).repos.map((r: { connectedRepoId: string }) => r.connectedRepoId);
  assertEquals(await resolve(), [api.id, web.id]);
  assertEquals((await post(app.handler, `/v1/connected-repos/${web.id}/archive`)).status, 200);
  assertEquals(await resolve(), [api.id], "the gateway stops fetching for the disconnected repo");
  assertEquals(
    (await app.store.getRun(created.runId))!.state,
    "starting",
    "the run itself goes on",
  );
});

test("a task created on a pull request checks out its head branch and pushes back onto it", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  const spec = { title: "Address the review", instructions: "Do what the review says." };

  // On a workspace: the pull request's repo at its head branch, the rest at the workspace's refs.
  const created = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec,
    workspaceId: workspace.id,
    targetChangeRequest: { connectedRepoId: api.id, thread: "5" },
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(created.status, 201);
  const task = (await app.store.getTask((await created.json()).taskId))!;
  assertEquals(task.targetChangeRequest, { connectedRepoId: api.id, thread: "5" });
  assertEquals(task.repos.map((r) => r.ref), ["refs/heads/noop/pr-5", "develop"]);

  // On a single connected repo, the same.
  const single = await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec,
    connectedRepoId: api.id,
    targetChangeRequest: { connectedRepoId: api.id, thread: "6" },
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(single.status, 201);
  assertEquals(
    (await app.store.getTask((await single.json()).taskId))!.repos.map((r) => r.ref),
    ["refs/heads/noop/pr-6"],
  );

  // Refusals: the repo must be in the checkout; a pull request that is merged has no branch
  // left to work on.
  const refused = async (body: Record<string, unknown>) =>
    await post(app.handler, "/v1/tasks", { agentId: agent.id, spec, ...body });
  assertEquals(
    (await refused({
      connectedRepoId: api.id,
      targetChangeRequest: { connectedRepoId: web.id, thread: "5" },
      lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    })).status,
    400,
  );
  assertEquals(
    (await refused({
      workspaceId: workspace.id,
      targetChangeRequest: { connectedRepoId: "cr-nope", thread: "5" },
      lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    })).status,
    400,
  );
  const base = noopForge(silentDiagnostics(), { repos: [API, WEB, DOCS] });
  const mergedForge: Forge = {
    ...base,
    fetchThread: async (repo, thread) => {
      const out = await base.fetchThread(repo, thread);
      if (out.kind !== "thread" || out.thread.changeRequest === null) return out;
      return {
        kind: "thread",
        thread: { ...out.thread, changeRequest: { ...out.thread.changeRequest, merged: true } },
      };
    },
  };
  const mergedApp = buildApp({ forge: mergedForge });
  const prepared = await prepare(mergedApp);
  const onMerged = await post(mergedApp.handler, "/v1/tasks", {
    agentId: prepared.agent.id,
    spec,
    workspaceId: prepared.workspace.id,
    targetChangeRequest: { connectedRepoId: prepared.api.id, thread: "5" },
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  });
  assertEquals(onMerged.status, 409);
  assertStringIncludes((await onMerged.json()).error, "merged");
  assertEquals(mergedApp.launches.length, 0);
});

test("archiving is one unit: a racing add leaves no member bound, and nothing changes after it", async () => {
  const app = buildApp();
  const { workspace } = await prepare(app);
  const docs = await (await post(app.handler, "/v1/connected-repos", {
    installationId: "42",
    repoRef: DOCS.fullName,
  })).json();
  const [add, archive] = await Promise.all([
    post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: docs.id }),
    post(app.handler, `/v1/workspaces/${workspace.id}/archive`),
  ]);
  assert([201, 409].includes(add.status), String(add.status));
  assertEquals(archive.status, 200);
  const shown = await (await get(app.handler, `/v1/workspaces/${workspace.id}`)).json();
  assert(shown.workspace.archivedAt !== null, "the archive stands");
  assertEquals(shown.repos, []);
  assertEquals(shown.canManage, false, "history is nobody's to change");
  assertEquals(await app.store.findWorkspaceRepo(docs.id), null);

  // Not even for `repos:manage-all`: an archived workspace is renamed by nobody, joined by nobody.
  const rename = await call(app.handler, "PATCH", `/v1/workspaces/${workspace.id}`, {
    name: "Renamed",
  });
  assertEquals(rename.status, 409);
  assertEquals((await app.store.getWorkspace(workspace.id))!.name, "Shop");
  assertEquals(
    (await post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: docs.id }))
      .status,
    409,
  );
});

test("repos:manage-all removes any member, as canManage promises", async () => {
  const denyWeb = forgeDenying(WEB.fullName);
  const app = buildApp({ forge: denyWeb.forge, role: "owner" });
  const { web, workspace } = await prepare(app);
  denyWeb.deny();
  const shown = await (await get(app.handler, `/v1/workspaces/${workspace.id}`)).json();
  assertEquals(shown.canManage, true);
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${web.id}`)).status,
    200,
  );
});

test("a /ryph reply never names a sibling, not even a disconnected one", async () => {
  const app = buildApp();
  const { web } = await prepare(app);
  assertEquals((await post(app.handler, `/v1/connected-repos/${web.id}/archive`)).status, 200);
  const res = await post(
    app.handler,
    "/v1/forge/events",
    commandOn(API, "gh-20", "20"),
    "forge-service-token",
  );
  assertEquals((await res.json()).outcome, "refused");
  const forge = app.forge as ReturnType<typeof noopForge>;
  const reply = forge.comments.at(-1)!;
  assertStringIncludes(reply.body, `workspace "Shop"`);
  assert(!reply.body.includes(WEB.fullName), reply.body);
  assert(!reply.body.includes("frontend"), reply.body);
});

test("withoutSiblings hides every sibling, by name and by URL, and keeps the commanded repo", () => {
  const entry = (id: string, name: string, path: string) =>
    ({
      connectedRepo: { id },
      name,
      path,
      url: `https://github.com/${name}.git`,
    }) as unknown as StartTaskRepo;
  const repos = [entry("cr-api", "acme/api", "api"), entry("cr-web", "acme/web", "frontend")];
  const said = withoutSiblings(
    "could not read acme/web's .ryph/services.yml at develop (https://github.com/acme/web.git, " +
      "ACME/Web); acme/api is fine",
    repos,
    "cr-api",
    "Shop",
  );
  assert(!said.toLowerCase().includes("acme/web"), said);
  assertStringIncludes(
    said,
    `could not read another repo of workspace "Shop"'s .ryph/services.yml`,
  );
  assertStringIncludes(said, "acme/api is fine");

  // A sibling named by the directory it is cloned into — the slugified repo name, which is the
  // private repo's name just the same.
  const byPath = withoutSiblings("frontend: setup failed", repos, "cr-api", "Shop");
  assert(!byPath.includes("frontend"), byPath);
  assertStringIncludes(byPath, `another repo of workspace "Shop": setup failed`);

  // ...as a whole word only: a path is a short label, and substituting it inside ordinary
  // words would turn the rest of the sentence into noise.
  assertStringIncludes(
    withoutSiblings("the frontends are fine", repos, "cr-api", "Shop"),
    "the frontends are fine",
  );
});

test("a refusal about a sibling is summarized, never relayed into the thread", async () => {
  // The leak this closes: the refusal's own text names the sibling's branch, its checkout
  // directory and what the forge said about it, and it would be posted verbatim into the
  // commanded repo's thread — which may be public while the sibling is private.
  const base = noopForge(silentDiagnostics(), { repos: [API, WEB, DOCS] });
  const forge: Forge = {
    ...base,
    readServicesFile: (_repo, url) =>
      Promise.resolve(
        url === WEB.url
          ? { kind: "unavailable" as const, detail: "github answered 500 for refs/heads/develop" }
          : { kind: "absent" as const },
      ),
  };
  const app = buildApp({ forge, services: true });
  await prepare(app);
  const res = await post(
    app.handler,
    "/v1/forge/events",
    commandOn(API, "gh-30", "30"),
    "forge-service-token",
  );
  assertEquals((await res.json()).outcome, "refused");

  const reply = base.comments.at(-1)!;
  assertStringIncludes(reply.body, `another repo of workspace "Shop"`);
  assertStringIncludes(reply.body, "could not be read");
  assert(!reply.body.includes(WEB.fullName), reply.body);
  assert(!reply.body.includes("develop"), "the sibling's branch: " + reply.body);
  assert(!reply.body.includes("frontend"), "the sibling's checkout path: " + reply.body);
  assert(!reply.body.includes("500"), "what the forge said about it: " + reply.body);
});

test("a task created on a pull request says so on it, and the report there shows that repo's part alone", async () => {
  const app = buildApp();
  const { api, web, agent, workspace } = await prepare(app);
  const created = await (await post(app.handler, "/v1/tasks", {
    agentId: agent.id,
    spec: { title: "Address the review", instructions: "Do what the review says." },
    workspaceId: workspace.id,
    targetChangeRequest: { connectedRepoId: api.id, thread: "5" },
  })).json();
  const forge = app.forge as ReturnType<typeof noopForge>;
  assert(
    forge.comments.some((c) => c.repoRef === API.fullName && c.thread === "5"),
    "the pull request hears a run is at work on it",
  );
  assertEquals(
    (await app.store.listOpenProgressComments()).map((r) => [
      r.runId,
      r.threadKind,
      r.threadRef,
    ]),
    [[created.runId, "change_request", "5"]],
  );

  const run = (await app.store.getRun(created.runId))!;
  const sha = (c: string) => c.repeat(40);
  const reported = await post(app.handler, `/v1/runs/${run.id}/result`, {
    status: "success",
    branches: [
      {
        connectedRepoId: api.id,
        path: "api",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("a"),
        commits: [{ sha: sha("a"), subject: "api: the fix" }],
        generation: 1,
        carries: [],
      },
      {
        connectedRepoId: web.id,
        path: "frontend",
        name: `${run.branchNamespace}/work`,
        line: "work",
        headSha: sha("b"),
        commits: [{ sha: sha("b"), subject: "web: the private part" }],
        generation: 1,
        carries: [],
      },
    ],
    summary: "done",
  }, (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN);
  assertEquals(reported.status, 200);
  await sweepProgressComments({
    store: app.store,
    forge,
    diag: silentDiagnostics(),
    identityDirectory: app.identities.directory,
    now: app.clock.now,
    appUrl: null,
  });
  const final = forge.commentUpdates.at(-1)!;
  // With the run, whose image refs the forge renders in the summary.
  assertEquals(final.runId, created.runId);
  assertStringIncludes(final.body, "api: the fix");
  assertStringIncludes(final.body, "· requested by ");
  assertStringIncludes(final.body, "This run also changed 1 other repository");
  assert(!final.body.includes("web: the private part"), final.body);
  assert(!final.body.includes("frontend"), final.body);
});

// On Radicle the `admin` bar is never a Radicle capability — Radicle has no such tier. It is
// ryph's own bar for what ryph does with a repo: its submission policy, its command allowlist,
// its workspace membership. So `repos:manage-all` clears it beside delegacy, at the
// per-repo gate and not only at the workspace one. GitHub, which has real tiers that mean what
// they say, is untouched.
const RID = "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5";
const THEIR_DID = "did:key:z6MktaNvN1tMt1Nkm5gNomgQsjqR3nrPtAVSt58BJgmv5J3z";

/**
 * The noop forge, plus a switch that makes it deny `admin` on the Radicle repo (nobody
 * delegates it) and on the web repo (nobody is admin of it) once the fixture is built.
 *
 * Both tiers are modelled, not just the one the test switches on. A blanket "allowed" for
 * `write` would make this fake a no-op gate on that tier, and the `admin` assertions below
 * would then be read as proof of a tier model that nothing here implements — GitHub's `write`
 * really is a grant to a named account, and Radicle's really is permissionless. The
 * cross-forge rule is modelled for the same reason: it is the boundary's, so it is the fake's.
 */
function forgeDenyingAdmin() {
  const base = noopForge(silentDiagnostics(), { repos: [API, WEB, DOCS] });
  let strict = false;
  const forge: Forge = {
    ...base,
    checkPermission: (repo, identity, atLeast) => {
      if (identity.provider !== repo.provider) return Promise.resolve("denied" as const);
      if (atLeast === "write") {
        // Radicle: permissionless on a public repo — the subject is not consulted, and a null
        // one (nobody linked) is answered just the same. GitHub: no subject, no access.
        return Promise.resolve(
          repo.provider === "radicle" || identity.subject !== null
            ? "allowed" as const
            : "denied" as const,
        );
      }
      // `admin` is delegacy on Radicle and a real collaborator tier on GitHub. Nobody holds
      // either anonymously, whether or not the switch below is on.
      if (identity.subject === null) return Promise.resolve("denied" as const);
      if (!strict) return Promise.resolve("allowed" as const);
      const denied = repo.provider === "radicle" || repo.repoRef === WEB.fullName;
      return Promise.resolve(denied ? "denied" as const : "allowed" as const);
    },
  };
  return { forge, strict: () => (strict = true) };
}

test("repos:manage-all administers a Radicle member with no delegacy at all", async () => {
  const denying = forgeDenyingAdmin();
  const app = buildApp({ forge: denying.forge, role: "member" });
  const { workspace } = await prepare(app);
  app.identities.link(USER.userId, THEIR_DID, "radicle");
  const at = "2026-01-01T00:00:00.000Z";
  const rad: ConnectedRepo = {
    id: "cr-rad",
    provider: "radicle",
    installationId: null,
    repoRef: RID,
    url: RID,
    defaultBranch: "main",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  await app.store.createConnectedRepo(rad);
  denying.strict();

  const join = () =>
    post(app.handler, `/v1/workspaces/${workspace.id}/repos`, { connectedRepoId: rad.id });
  const makeAuto = () =>
    call(app.handler, "PATCH", `/v1/connected-repos/${rad.id}`, { submissionPolicy: "auto" });

  // A linked user who is not a delegate: refused, and the refusal is the forge's, not a
  // missing link.
  const refusedJoin = await join();
  assertEquals(refusedJoin.status, 403);
  assertStringIncludes((await refusedJoin.json()).error, RID);
  assertEquals((await makeAuto()).status, 403);

  // `repos:manage-all`, with no delegacy anywhere: both doors open. `auto` is the
  // sharpest of them — it retires the approval gate on every patch this repo opens.
  app.setRole("owner");
  assertEquals((await join()).status, 201);
  const auto = await makeAuto();
  assertEquals(auto.status, 200);
  assertEquals((await auto.json()).submissionPolicy, "auto");
  assertEquals(
    (await call(app.handler, "DELETE", `/v1/workspaces/${workspace.id}/repos/${rad.id}`)).status,
    200,
  );

  // GitHub is not bent at the tier this test moves: the same admin role, a GitHub repo the
  // forge says they are not admin of, and the answer is still no. (The platform role is a way
  // through `admin` on RADICLE only, and only because Radicle has no such tier of its own.)
  const github = await (await get(app.handler, "/v1/connected-repos")).json();
  const web = github.repos.find((r: { repoRef: string }) => r.repoRef === WEB.fullName);
  assertEquals(
    (await call(app.handler, "PATCH", `/v1/connected-repos/${web.id}`, {
      submissionPolicy: "auto",
    })).status,
    403,
  );
});
