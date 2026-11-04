import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The `local` provider on the control plane's side, end to end through the HTTP surface: a
// repository on the forge's own disk, connected through the forge's reading of a path, managed
// by the deployment's admins, written to by anyone who may act at all, and run through the
// gateway like any other connected repo — with no forge tools, because it has nothing for them
// to act on.
//
// No disk and no git anywhere — the boundary is the noop forge with a scripted describe, as
// every other provider's tests here use it.

import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler, type ToolAccess } from "../src/http/app.ts";
import { refuseRepoPermission } from "../src/http/user_api.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { httpForge } from "../src/adapters/forge/http.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import {
  approvePatch,
  DEFAULT_PATCH_SUBMIT_CONFIG,
  failHookCheck,
  holdPatch,
  recordHookCheck,
  retryPatch,
} from "../src/core/patch_lifecycle.ts";
import { notifyPatch } from "../src/core/inbox.ts";
import type { Forge, LocalRepoDescription, PatchHooksOutcome } from "../src/ports/forge.ts";
import type { ConnectedRepo, ForgePolicy, Patch } from "../src/core/types.ts";
import { isRepoRef } from "../src/schema.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

const REAL = "/Users/ada/code/payments";
const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };
const FORGE_TOKEN = "forge-service-token";
const FORGE_SERVER = "ms-platform-forge";

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
} as const;

const POLICY: ForgePolicy = {
  repos: "run",
  read: true,
  createIssues: { max: 2 },
  comment: null,
  review: null,
  closeIssues: null,
  labels: [],
};

const GITHUB_REPO: ConnectedRepo = {
  id: "cr-github",
  provider: "github",
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

const toolAccess: ToolAccess = {
  getServer: (id) => Promise.resolve({ id, slug: id, name: id, archivedAt: null }),
  issueRunCredentials: () => Promise.reject(new Error("not in these tests")),
  revokeRunCredentials: () => Promise.resolve(),
  archiveServer: () => Promise.reject(new Error("not in these tests")),
};

/** The forge's describe, as the local provider answers a path it accepts: canonicalised. */
const accepts = (): LocalRepoDescription => ({
  kind: "described",
  repoRef: REAL,
  url: REAL,
  defaultBranch: "trunk",
});

function buildApp(
  opts: {
    role?: Role;
    localRepo?: (path: string) => LocalRepoDescription;
    /** What a forge permission question answers. "denied" by default: a local repository must
     * never be asked about, so any path that did ask would refuse — the tests pass only if
     * nothing does. */
    permission?: "allowed" | "denied";
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const forge = noopForge(silentDiagnostics(), {
    permission: opts.permission ?? "denied",
    localRepo: opts.localRepo ?? accepts,
  });
  let role: Role = opts.role ?? "owner";
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate:
      (() => Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    toolAccess,
    forgeToken: FORGE_TOKEN,
    forge: forge as Forge,
    githubConnect: forge,
    radicleConnect: forge,
    localConnect: forge,
    identityDirectory: identities.directory,
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: GATEWAY,
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
        forge: FORGE_SERVER,
        pending: false,
      },
    },
  };
  return {
    handler: makeHandler(deps),
    deps,
    store,
    launches,
    forge,
    identities,
    as: (next: Role) => (role = next),
  };
}

type Handler = (req: Request) => Promise<Response>;
const send = (h: Handler, method: string, path: string, body?: unknown, token = "t") =>
  h(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const connect = (app: ReturnType<typeof buildApp>, over: Record<string, unknown> = {}) =>
  send(app.handler, "POST", "/v1/connected-repos", {
    provider: "local",
    path: "/Users/ada/code/../code/payments/",
    ...over,
  });

async function agent(app: ReturnType<typeof buildApp>, forgePolicy: ForgePolicy | null = null) {
  const res = await send(app.handler, "POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: forgePolicy === null ? "echo" : "pi",
    memoryPolicy: null,
    forgePolicy,
  });
  assertEquals(res.status, 201, await res.clone().text());
  return await res.json();
}

// ---- connecting ------------------------------------------------------------------------------

test("an admin connects a local repo: the forge's canonical path is the row, never the caller's", async () => {
  const app = buildApp();
  const res = await connect(app, { repoRef: "/etc", url: "/etc" });
  assertEquals(res.status, 201);
  const repo = await res.json();
  assertEquals(repo.provider, "local");
  assertEquals(repo.repoRef, REAL);
  assertEquals(repo.url, REAL);
  assertEquals(repo.installationId, null);
  assertEquals(repo.defaultBranch, "trunk");
  assertEquals(repo.submissionPolicy, "require-approval");
  // The path as typed reached the forge — canonicalising it is the forge's job, not ours.
  assertEquals(app.forge.localDescribed, ["/Users/ada/code/../code/payments/"]);
  assertEquals((await app.store.listConnectedRepos()).map((r) => r.repoRef), [REAL]);
});

test("the forge's refusal of a path is passed through as a 422 with its reason", async () => {
  const app = buildApp({
    localRepo: () => ({
      kind: "refused",
      reason: "outside_root",
      error: "/srv/other is outside the allowed root (/Users/ada)",
      root: "/Users/ada",
    }),
  });
  const res = await connect(app, { path: "/srv/other" });
  assertEquals(res.status, 422);
  // The allowed root rides along, so the page can say where repositories CAN be.
  assertEquals(await res.json(), {
    error: "/srv/other is outside the allowed root (/Users/ada)",
    reason: "outside_root",
    root: "/Users/ada",
  });
  assertEquals(await app.store.listConnectedRepos(), []);

  // Any other refusal carries no root, whatever the port handed over.
  const bare = buildApp({
    localRepo: () => ({
      kind: "refused",
      reason: "bare_repository",
      error: "a bare repository",
      root: "/Users/ada",
    }),
  });
  assertEquals(await (await connect(bare)).json(), {
    error: "a bare repository",
    reason: "bare_repository",
  });
});

test("a forge with no local provider is a 503, as a deployment with no GitHub App is", async () => {
  const app = buildApp({ localRepo: () => ({ kind: "unsupported" }) });
  const res = await connect(app);
  assertEquals(res.status, 503);
  assertStringIncludes((await res.json()).error, "not enabled on this deployment");
});

test("a forge answer that is not a canonical local address is refused, never stored", async () => {
  const app = buildApp({
    localRepo: () => ({
      kind: "described",
      repoRef: "code/../payments",
      url: "x",
      defaultBranch: "main",
    }),
  });
  assertEquals((await connect(app)).status, 502);
  assertEquals(await app.store.listConnectedRepos(), []);
});

test("a forge answer the forge's own address rule would refuse is never stored either", async () => {
  // The two rules agree: a real path with a control character in it, or whitespace at its end,
  // is no address, whichever side reads it.
  for (const real of ["/Users/ada/tab\trepo", "/Users/ada/repo "]) {
    const app = buildApp({
      localRepo: () => ({ kind: "described", repoRef: real, url: real, defaultBranch: "main" }),
    });
    assertEquals((await connect(app)).status, 502, JSON.stringify(real));
    assertEquals(await app.store.listConnectedRepos(), []);
  }
});

test("a typed path is handed to the forge as typed, edge whitespace and all", async () => {
  const app = buildApp();
  assertEquals((await connect(app, { path: " /Users/ada/code/payments " })).status, 201);
  assertEquals(app.forge.localDescribed, [" /Users/ada/code/payments "]);
});

test("the same repository twice is a 409, however its path was spelled", async () => {
  const app = buildApp();
  assertEquals((await connect(app)).status, 201);
  const again = await connect(app, { path: REAL });
  assertEquals(again.status, 409);
  assertStringIncludes((await again.json()).error, "already connected");
});

test("a body naming no path, or a path that is not one, is a 400", async () => {
  const app = buildApp();
  assertEquals((await connect(app, { path: undefined })).status, 400);
  assertEquals((await connect(app, { path: "/a\u0000b" })).status, 400);
  assertEquals((await connect(app, { path: "/a\nb" })).status, 400);
  assertEquals((await connect(app, { path: "/a\tb" })).status, 400);
  assertEquals((await connect(app, { path: "/a\u007fb" })).status, 400);
  assertEquals(app.forge.localDescribed, [], "the forge was asked about none of them");
});

test("a plain member cannot connect a local repo, and the forge is never asked about the path", async () => {
  const app = buildApp({ role: "member" });
  const res = await connect(app);
  assertEquals(res.status, 403);
  assertStringIncludes((await res.json()).error, "repos:manage-all");
  assertEquals(app.forge.localDescribed, []);
});

// ---- who may do what -----------------------------------------------------------------------------

test("writing to a local repo is subjectless; administering it is repos:manage-all", async () => {
  const app = buildApp();
  const repo: ConnectedRepo = await (await connect(app)).json();
  const member = { ...USER, caps: capsClaimOf("member") } as never;
  const operator = { ...USER, caps: capsClaimOf("operator") } as never;
  // The noop answers every forge question "denied", so a null here means nobody asked it.
  assertEquals(await refuseRepoPermission(app.deps, member, repo, "write"), null);
  assertEquals(await refuseRepoPermission(app.deps, operator, repo, "admin"), null);
  const refused = await refuseRepoPermission(app.deps, member, repo, "admin");
  assertEquals(refused?.status, 403);
  assertStringIncludes((await refused!.json()).error, "repos:manage-all");
});

test("a member with no linked identity starts a task on a local repo, and cannot disconnect it", async () => {
  const app = buildApp();
  const repo = await (await connect(app)).json();
  const a = await agent(app);
  app.as("member");
  const res = await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  });
  assertEquals(res.status, 201, await res.clone().text());

  const archive = await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`);
  assertEquals(archive.status, 403);
  app.as("operator");
  const archived = await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`);
  assertEquals(archived.status, 200);
  assert((await archived.json()).archivedAt !== null);
});

// ---- running on one -----------------------------------------------------------------------------

test("a run on a local repo clones through the gateway with a run key, and gets no forge tools", async () => {
  const app = buildApp();
  const repo = await (await connect(app)).json();
  const a = await agent(app, POLICY);
  const res = await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  });
  const created = await res.json();
  assertEquals(res.status, 201, JSON.stringify(created));

  const run = (await app.store.getRun(created.runId))!;
  // The gateway's member URL, never the path on disk.
  assertEquals(
    run.workItem.repos[0].url,
    `${GATEWAY.url}/v1/git/${created.runId}/${repo.id}/repo.git`,
  );
  assertEquals(run.workItem.repos[0].ref, "trunk");
  // A forge policy that would grant tools on any other repo grants nothing here.
  assertEquals(run.forgeScope, null);
  assertEquals(run.toolScope?.servers.some((s) => s.serverId === FORGE_SERVER) ?? false, false);

  const [launch] = app.launches;
  const credentials = await bootstrapEnv(app.handler, launch.env);
  assertEquals(credentials.RYPH_GIT_ORIGIN, GATEWAY.url);
  const token = credentials.RYPH_GIT_TOKEN;
  assert(token !== undefined && token.length > 0);
  assertEquals("mounts" in launch, false, "nothing is mounted into the run");

  // The key resolves to the repository at its path, with no tenant.
  const resolved = await send(
    app.handler,
    "POST",
    "/v1/forge/git-keys/resolve",
    { token },
    FORGE_TOKEN,
  );
  assertEquals(resolved.status, 200);
  const grant = await resolved.json();
  assertEquals(grant.repos.length, 1);
  assertEquals(grant.repos[0].provider, "local");
  assertEquals(grant.repos[0].repoRef, REAL);
  assertEquals(grant.repos[0].url, REAL);
  assertEquals(grant.repos[0].tenantId, null);
});

test("a policy listing a local repo drops it, and a local-only checkout gets no forge tools", async () => {
  // The GitHub repo is asked about, as it always is; it needs a login and a yes.
  const app = buildApp({ permission: "allowed" });
  app.identities.link(USER.userId, "ada");
  const local = await (await connect(app)).json();
  await app.store.createConnectedRepo(GITHUB_REPO);

  // Listed beside a GitHub repo, on a run of the GitHub repo: only the GitHub repo is in scope.
  const listing = await agent(app, {
    ...POLICY,
    repos: { connectedRepoIds: [local.id, GITHUB_REPO.id] },
  });
  const onGithub = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: listing.id,
    connectedRepoId: GITHUB_REPO.id,
    spec: { title: "Triage", instructions: "File what you find." },
  })).json();
  const github = (await app.store.getRun(onGithub.runId))!;
  assertEquals(github.forgeScope?.repos.map((r) => r.connectedRepoId), [GITHUB_REPO.id]);

  // The same agent on the local repo alone: nothing it checked out is a forge repo, so no
  // forge tools at all.
  const onLocal = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: listing.id,
    connectedRepoId: local.id,
    spec: { title: "Triage", instructions: "File what you find." },
  })).json();
  const localRun = (await app.store.getRun(onLocal.runId))!;
  assertEquals(localRun.forgeScope, null);
  assertEquals(
    localRun.toolScope?.servers.some((s) => s.serverId === FORGE_SERVER) ?? false,
    false,
  );
});

test("a checkout mixing a local repo with a GitHub one keeps forge tools on the GitHub one only", async () => {
  // A local repository is private source: it rides `sourceRepos`, where the forge's visibility
  // rule weighs it as private, and never `repos`, where a write could go.
  const app = buildApp({ permission: "allowed" });
  app.identities.link(USER.userId, "ada");
  const local = await (await connect(app)).json();
  await app.store.createConnectedRepo(GITHUB_REPO);
  const { workspace } = await (await send(app.handler, "POST", "/v1/workspaces", {
    name: "Shop",
  })).json();
  for (const id of [local.id, GITHUB_REPO.id]) {
    const added = await send(app.handler, "POST", `/v1/workspaces/${workspace.id}/repos`, {
      connectedRepoId: id,
    });
    assertEquals(added.status, 201, await added.clone().text());
  }
  const a = await agent(app, POLICY);
  const res = await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    workspaceId: workspace.id,
    spec: { title: "Triage", instructions: "File what you find." },
  });
  const created = await res.json();
  assertEquals(res.status, 201, JSON.stringify(created));
  const run = (await app.store.getRun(created.runId))!;
  assertEquals(run.forgeScope?.repos.map((r) => r.connectedRepoId), [GITHUB_REPO.id]);
  assertEquals(
    run.forgeScope?.sourceRepos.map((r) => [r.connectedRepoId, r.provider]).sort(),
    [[GITHUB_REPO.id, "github"], [local.id, "local"]].sort(),
  );
  // Signed as the requester's GitHub login — never asked of `local`, which has none.
  assertEquals(run.forgeScope?.provenance.requestedBy, "ada");
  assertEquals(run.toolScope?.servers.some((s) => s.serverId === FORGE_SERVER), true);
});

test("a local repo without a git gateway is refused, never cloned by its path", async () => {
  const app = buildApp();
  const repo = await (await connect(app)).json();
  const a = await agent(app);
  const handler = makeHandler({ ...app.deps, config: { ...app.deps.config, gitGateway: null } });
  const res = await send(handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  });
  assertEquals(res.status, 503);
  assertStringIncludes((await res.json()).error, "git gateway");
  assertEquals(app.launches, []);
});

// ---- the wire ---------------------------------------------------------------------------------

/** Runs `fn` against an http forge whose every request `reply` answers. Stubbed rather than
 * served, as forge_http_test.ts does, so this suite stays socket-free. */
async function overWire<T>(
  reply: (req: Request) => Response | Promise<Response>,
  fn: (forge: ReturnType<typeof httpForge>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      reply(
        input instanceof Request ? new Request(input, init) : new Request(String(input), init),
      ),
    )) as typeof fetch;
  try {
    return await fn(
      httpForge({ baseUrl: "http://forge.test", forgeToken: "t", diag: silentDiagnostics() }),
    );
  } finally {
    globalThis.fetch = original;
  }
}

const jsonReply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("describe maps the forge's 200, 422 and 501, and throws on anything else", async () => {
  let asked: { path: string; body: unknown } | null = null;
  const described = await overWire(async (req) => {
    asked = { path: new URL(req.url).pathname, body: await req.json() };
    return jsonReply(200, { repoRef: REAL, url: REAL, defaultBranch: "main" });
  }, (forge) => forge.describeLocalRepo("/Users/ada/code/payments/"));
  assertEquals(asked, {
    path: "/v1/service/local/describe",
    body: { path: "/Users/ada/code/payments/" },
  });
  assertEquals(described, { kind: "described", repoRef: REAL, url: REAL, defaultBranch: "main" });

  assertEquals(
    await overWire(
      () => jsonReply(422, { error: "a bare repository", reason: "bare_repository" }),
      (forge) => forge.describeLocalRepo(REAL),
    ),
    { kind: "refused", reason: "bare_repository", error: "a bare repository" },
  );
  assertEquals(
    await overWire(
      () => jsonReply(501, { error: "no local provider" }),
      (f) => f.describeLocalRepo(REAL),
    ),
    { kind: "unsupported" },
  );
  // `outside_root` carries the allowed root through; on any other reason, or as anything but an
  // absolute path, a `root` is dropped.
  assertEquals(
    await overWire(
      () => jsonReply(422, { error: "outside", reason: "outside_root", root: "/Users/ada" }),
      (forge) => forge.describeLocalRepo("/srv/x"),
    ),
    { kind: "refused", reason: "outside_root", error: "outside", root: "/Users/ada" },
  );
  assertEquals(
    await overWire(
      () => jsonReply(422, { error: "outside", reason: "outside_root", root: 7 }),
      (forge) => forge.describeLocalRepo("/srv/x"),
    ),
    { kind: "refused", reason: "outside_root", error: "outside" },
  );
  assertEquals(
    await overWire(
      () => jsonReply(422, { error: "bare", reason: "bare_repository", root: "/Users/ada" }),
      (forge) => forge.describeLocalRepo(REAL),
    ),
    { kind: "refused", reason: "bare_repository", error: "bare" },
  );
  // A reason the contract does not have is not a refusal to pass on; nor is a 500.
  await assertRejects(() =>
    overWire(
      () => jsonReply(422, { error: "?", reason: "made_up" }),
      (f) => f.describeLocalRepo(REAL),
    )
  );
  await assertRejects(() =>
    overWire(() => jsonReply(500, { error: "boom" }), (f) => f.describeLocalRepo(REAL))
  );
});

test("a local delivery's 201 with a null url is submitted, never retried to failed — over the wire", async () => {
  // The whole loop on a local repo, with the real http adapter delivering it: the forge answers
  // a local push `201 { ref: <branch>, url: null }`, because a branch on disk has no web page.
  const app = buildApp();
  const repo = await (await connect(app)).json();
  const a = await agent(app);
  const created = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  })).json();
  const task = (await app.store.getTask(created.taskId))!;
  const sha = "a".repeat(40);
  const branchName = `ryph/ada/${created.runId}/work`;
  const reported = await send(app.handler, "POST", `/v1/runs/${created.runId}/result`, {
    status: "success",
    branches: [{
      connectedRepoId: repo.id,
      path: task.repos[0].path,
      name: branchName,
      line: "work",
      headSha: sha,
      commits: [{ sha, subject: "fix the flaky test" }],
      generation: 1,
      carries: [],
    }],
    summary: "Pinned the clock.",
  }, (await bootstrapEnv(app.handler, app.launches.at(-1)!.env)).RYPH_RUN_TOKEN);
  assertEquals(reported.status, 200, await reported.clone().text());
  const [patch] = (await app.store.listPatches({ state: "pending_approval" })).patches;
  assertEquals(
    (await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`)).status,
    200,
  );

  const asked: Array<{ path: string; body: Record<string, unknown> }> = [];
  await overWire(async (req) => {
    asked.push({ path: new URL(req.url).pathname, body: await req.json() });
    return jsonReply(201, { ref: branchName, url: null });
  }, (http) =>
    sweepPatches(
      {
        store: app.store,
        // The real adapter on the delivery; everything else stays the noop's.
        forge: { ...app.forge, submitPatch: http.submitPatch },
        identityDirectory: app.identities.directory,
        diag: silentDiagnostics(),
        now: () => new Date(),
      },
      DEFAULT_PATCH_SUBMIT_CONFIG,
    ));

  assertEquals(asked.map((r) => r.path), ["/v1/service/submit"]);
  assertEquals((asked[0].body.repo as { provider: string }).provider, "local");
  const done = (await app.store.getPatch(patch.id))!;
  assertEquals(done.state, "submitted", done.lastError ?? "");
  assertEquals(done.forgeRef, branchName);
  assertEquals(done.forgeUrl, null);
  const submitted = (await app.store.listEvents(created.runId))
    .find((e) => e.kind === "patch-submitted");
  assertEquals(submitted?.detail, branchName, "the trail names the branch when there is no link");

  // "" from the forge means the same: no address, never an empty link.
  const blank = await overWire(
    () => jsonReply(201, { ref: branchName, url: "" }),
    (http) => http.submitPatch(asked[0].body as never),
  );
  assertEquals(blank, { kind: "submitted", ref: branchName, url: null });
  // A 201 naming no ref is still no delivery this side can settle.
  const noRef = await overWire(
    () => jsonReply(201, { url: null }),
    (http) => http.submitPatch(asked[0].body as never),
  );
  assertEquals(noRef.kind, "failed");
});

test("a run told its local patch was delivered hears a branch, not a pull request to link", async () => {
  const app = buildApp();
  const repo = await (await connect(app)).json();
  const a = await agent(app);
  const created = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  })).json();
  // A live run, and a patch of it delivered as a branch with no url.
  const patch = {
    id: "p-1",
    runId: created.runId,
    taskId: created.taskId,
    connectedRepoId: repo.id,
    path: "payments",
    line: "work",
    branchName: "ryph/ada/x",
    headSha: "a".repeat(40),
    generation: 1,
    forgeRef: "ryph/ada/x",
    forgeUrl: null,
  } as never;
  await notifyPatch(
    { store: app.store, diag: silentDiagnostics(), now: () => new Date() },
    patch,
    "submitted",
    null,
    undefined,
    { provider: "local" },
  );
  const [note] = await app.store.listRunMessages(created.runId);
  assertStringIncludes(note.text, "the branch `ryph/ada/x`");
  assert(!note.text.includes("pull request"), note.text);
});

// ---- git hooks ----------------------------------------------------------------------------------

const HOOK = ".husky/pre-commit";

/** A local repo (under `policy`), a run on it that reported one branch, and the patch born from
 * it — `pending_approval` or, under `auto`, `queued`. */
async function bornLocalPatch(
  app: ReturnType<typeof buildApp>,
  policy: ConnectedRepo["submissionPolicy"] = "require-approval",
) {
  const repo: ConnectedRepo = await (await connect(app)).json();
  await app.store.saveConnectedRepo({ ...repo, submissionPolicy: policy });
  const a = await agent(app);
  const created = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: a.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  })).json();
  const task = (await app.store.getTask(created.taskId))!;
  const sha = "a".repeat(40);
  // Mid-run, through the runner's patch route: the run stays live to hear what happens to it.
  const born = await send(app.handler, "POST", `/v1/runs/${created.runId}/patches`, {
    branch: {
      connectedRepoId: repo.id,
      path: task.repos[0].path,
      name: `ryph/ada/${created.runId}/work`,
      line: "work",
      headSha: sha,
      commits: [{ sha, subject: "fix the flaky test" }],
      generation: 1,
      carries: [],
    },
    baseSha: "b".repeat(40),
  }, (await bootstrapEnv(app.handler, app.launches.at(-1)!.env)).RYPH_RUN_TOKEN);
  assertEquals(born.status, 201, await born.clone().text());
  const [patch] = await app.store.patchesForTask(created.taskId);
  // The answer links the patch's page, where a person approves it.
  assertEquals((await born.json()).url, `https://ryph.test/patches/${patch.id}`);
  return { repo, patch, runId: created.runId as string, taskId: created.taskId as string };
}

const sweep = (app: ReturnType<typeof buildApp>, forge: Forge = app.forge) =>
  sweepPatches(
    {
      store: app.store,
      forge,
      identityDirectory: app.identities.directory,
      diag: silentDiagnostics(),
      appUrl: "https://ryph.test",
      now: () => new Date(),
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );

/** A bare patch row for the pure transitions. */
const rowOf = (over: Partial<Patch> = {}): Patch => ({
  id: "p-1",
  connectedRepoId: "cr-1",
  runId: "r-1",
  taskId: "t-1",
  setId: "ps-1",
  path: "payments",
  line: "work",
  branchName: "ryph/ada/r-1",
  headSha: "a".repeat(40),
  bundleKey: "r-1/cr-1/a.bundle",
  baseSha: null,
  generation: 1,
  title: null,
  description: null,
  commits: [],
  carries: [],
  state: "queued",
  attempts: 0,
  nextAttemptAt: null,
  leaseExpiresAt: null,
  lastError: null,
  approvedBy: { kind: "user", userId: "u-1" },
  approvedAt: "2026-01-01T00:00:00.000Z",
  forgeRef: null,
  forgeUrl: null,
  forgeBranch: null,
  diffRef: null,
  landed: null,
  supersededByPatchId: null,
  hookCheck: null,
  approvedHookPaths: [],
  memoryFateReportedAt: null,
  mergedCuedAt: null,
  mergedCueClaimedAt: null,
  landingAskedAt: null,
  heldReason: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const AT = "2026-01-02T00:00:00.000Z";
const CHECK = { touched: [HOOK], hooksPaths: [".husky"], more: false, at: AT };

test("holdPatch: queued or submitting back to a person, approval and lease cleared", () => {
  for (const state of ["queued", "submitting"] as const) {
    const held = holdPatch(rowOf({ state, leaseExpiresAt: AT, nextAttemptAt: AT }), CHECK, AT);
    assert(held.kind === "applied");
    assertEquals(held.patch.state, "pending_approval");
    assertEquals(held.patch.hookCheck, CHECK);
    assertEquals([held.patch.approvedBy, held.patch.approvedAt], [null, null]);
    assertEquals([held.patch.leaseExpiresAt, held.patch.nextAttemptAt], [null, null]);
    assertEquals(held.events.map((e) => [e.kind, e.detail]), [[
      "patch-held",
      `git hooks: ${HOOK}`,
    ]]);
  }
  for (const state of ["pending_approval", "submitted", "failed", "rejected"] as const) {
    assertEquals(holdPatch(rowOf({ state }), CHECK, AT).kind, "refused");
  }
  // A hold at delivery hands back the attempt the lease took: nothing failed.
  const atDelivery = holdPatch(rowOf({ state: "submitting", attempts: 3 }), CHECK, AT);
  assert(atDelivery.kind === "applied");
  assertEquals(atDelivery.patch.attempts, 2);
  const fromQueue = holdPatch(rowOf({ state: "queued", attempts: 3 }), CHECK, AT);
  assert(fromQueue.kind === "applied");
  assertEquals(fromQueue.patch.attempts, 3);
});

test("recordHookCheck: hooks hold a queued patch; a clean answer or a waiting patch only records", () => {
  const held = recordHookCheck(rowOf(), CHECK, AT);
  assert(held.kind === "applied");
  assertEquals(held.patch.state, "pending_approval");
  // Hidden hook files alone hold it too: nothing was shown, so nothing can be approved.
  const hidden = recordHookCheck(rowOf(), { ...CHECK, touched: [], more: true }, AT);
  assert(hidden.kind === "applied");
  assertEquals(hidden.patch.state, "pending_approval");
  const clean = recordHookCheck(rowOf(), { ...CHECK, touched: [] }, AT);
  assert(clean.kind === "applied");
  assertEquals([clean.patch.state, clean.events], ["queued", []]);
  assertEquals(clean.patch.approvedBy, { kind: "user", userId: "u-1" });
  const waiting = recordHookCheck(rowOf({ state: "pending_approval" }), CHECK, AT);
  assert(waiting.kind === "applied");
  assertEquals([waiting.patch.state, waiting.patch.hookCheck], ["pending_approval", CHECK]);
  // Still on the run's record: the approval it waits for is about these files now.
  assertEquals(waiting.events.map((e) => [e.kind, e.detail]), [[
    "patch-held",
    `git hooks: ${HOOK}`,
  ]]);
  assertEquals(recordHookCheck(rowOf({ hookCheck: CHECK }), CHECK, AT).kind, "refused");
  assertEquals(recordHookCheck(rowOf({ state: "submitting" }), CHECK, AT).kind, "refused");
  // A retry keeps the gate: what was checked and what was approved ride through unchanged.
  const retried = retryPatch(
    rowOf({ state: "failed", hookCheck: CHECK, approvedHookPaths: [HOOK] }),
    AT,
  );
  assert(retried.kind === "applied");
  assertEquals([retried.patch.hookCheck, retried.patch.approvedHookPaths], [CHECK, [HOOK]]);
});

test("an auto local patch changing a git hook is held, the run told, and nothing delivered without a human", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(HOOK);
  const { patch, runId } = await bornLocalPatch(app, "auto");
  assertEquals([patch.state, patch.hookCheck], ["queued", null]);

  await sweep(app);
  const held = (await app.store.getPatch(patch.id))!;
  assertEquals(held.state, "pending_approval");
  assertEquals(held.hookCheck?.touched, [HOOK]);
  assertEquals(app.forge.submissions.length, 0, "never delivered unread");
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-held").length,
    1,
  );
  const note = (await app.store.listRunMessages(runId)).find((m) =>
    m.payload?.kind === "patch" && m.payload.state === "held"
  );
  assert(note !== undefined, "the run hears it was held");
  assertEquals(note.payload?.kind === "patch" ? note.payload.hookPaths : null, [HOOK]);
  assertStringIncludes(note.text, HOOK);
  assertStringIncludes(note.text, "approve it in ryph");
  // ...with the page they approve it on, for the agent to hand them.
  assertStringIncludes(note.text, `https://ryph.test/patches/${patch.id}`);
  // Sweeping on changes nothing: checked once, waiting on a person.
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "pending_approval");
  assertEquals(app.forge.hookChecks.length, 1);

  // A person who saw the hook approves it; the forge takes it with exactly that list.
  const approved = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [HOOK],
  });
  assertEquals(approved.status, 200, await approved.clone().text());
  assertEquals((await approved.json()).patch.approvedHookPaths, [HOOK]);
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "submitted");
  assertEquals(app.forge.submissions.map((s) => s.approvedHookPaths), [[HOOK]]);
});

test("a queued local patch waits for its hook check; an unanswered check is asked again", async () => {
  const app = buildApp();
  const { patch } = await bornLocalPatch(app, "auto");
  let answer: "unavailable" | "checked" = "unavailable";
  const forge: Forge = {
    ...app.forge,
    checkPatchHooks: (repo, url, ask) =>
      answer === "unavailable"
        ? Promise.resolve({ kind: "unavailable", message: "forge unreachable" })
        : app.forge.checkPatchHooks(repo, url, ask),
  };
  await sweep(app, forge);
  await sweep(app, forge);
  const waiting = (await app.store.getPatch(patch.id))!;
  assertEquals([waiting.state, waiting.hookCheck], ["queued", null]);
  assertEquals(app.forge.submissions.length, 0, "not delivered unchecked");

  answer = "checked";
  await sweep(app, forge);
  const done = (await app.store.getPatch(patch.id))!;
  assertEquals(done.state, "submitted");
  assertEquals(done.hookCheck?.touched, []);
  // The check was the reviewer's live diff ask.
  const [asked] = app.forge.hookChecks;
  assertEquals(asked.ask.mode, "live");
  assertEquals(asked.ask.headSha, patch.headSha);
  assertEquals(asked.ask.bundleKey, patch.bundleKey);
});

test("approving a local patch covers only the hook files both shown and known", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(".husky/x");
  const { patch } = await bornLocalPatch(app);
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.hookCheck?.touched, [".husky/x"]);

  // Shown nothing — the page rendered before the check landed: the approval covers no hook.
  const blind = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [],
  });
  assertEquals(blind.status, 200);
  assertEquals((await app.store.getPatch(patch.id))!.approvedHookPaths, []);

  // ...so the forge holds it at delivery, back to a person, with the approval cleared.
  await sweep(app);
  const reheld = (await app.store.getPatch(patch.id))!;
  assertEquals(reheld.state, "pending_approval");
  assertEquals([reheld.approvedBy, reheld.approvedAt], [null, null]);
  assertEquals(reheld.hookCheck?.touched, [".husky/x"]);
  assertEquals(app.forge.submissions.length, 0);

  // Shown more than the server knows: only the one it knows is approved.
  const seen = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [".husky/x", ".husky/not-touched"],
  });
  assertEquals(seen.status, 200);
  assertEquals((await app.store.getPatch(patch.id))!.approvedHookPaths, [".husky/x"]);
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "submitted");

  // A body that is not a list of paths is refused at the door.
  const bad = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: ["a\nb"],
  });
  assertEquals(bad.status, 400);
});

test("a patch's views say whether its hooks are checked, and what they are", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(HOOK);
  const { patch, taskId } = await bornLocalPatch(app);
  const before = (await (await send(app.handler, "GET", `/v1/patches/${patch.id}`)).json()).patch;
  assertEquals([before.hookCheck, before.hooksPending, before.provider], [null, true, "local"]);
  await sweep(app);
  const after = (await (await send(app.handler, "GET", `/v1/patches/${patch.id}`)).json()).patch;
  assertEquals(after.hooksPending, false);
  assertEquals(after.hookCheck, { touched: [HOOK], hooksPaths: [".git/hooks"], more: false });
  const listed = (await (await send(app.handler, "GET", "/v1/patches")).json()).patches;
  assertEquals(listed[0].hookCheck.touched, [HOOK]);
  const detail = await (await send(app.handler, "GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.patches[0].provider, "local");
  assertEquals(detail.patches[0].hooksPending, false);
  assertEquals(detail.patches[0].hookCheck.touched, [HOOK]);
});

test("the hook pre-check and a held submission map over the wire", async () => {
  const ask = {
    connectedRepoId: "cr-1",
    bundleKey: "r/cr-1/a.bundle",
    branchName: "ryph/ada/r",
    headSha: "a".repeat(40),
    baseSha: null,
    targetRef: "trunk",
    mode: "live" as const,
  };
  const repo = { provider: "local" as const, repoRef: REAL, tenantId: null };
  let asked: { path: string; body: unknown } | null = null;
  const checked = await overWire(async (req) => {
    asked = { path: new URL(req.url).pathname, body: await req.json() };
    return jsonReply(200, { touched: [HOOK], hooksPaths: [".husky"], more: false });
  }, (f) => f.checkPatchHooks(repo, REAL, ask));
  assertEquals(checked, { kind: "checked", touched: [HOOK], hooksPaths: [".husky"], more: false });
  // Exactly the patch-diff body: repo, url and the ask.
  assertEquals(asked, { path: "/v1/service/local/patch-hooks", body: { repo, url: REAL, ...ask } });
  // The repository's root as its hooks folder (`core.hooksPath` of the repo itself) is ".".
  assertEquals(
    await overWire(
      () => jsonReply(200, { touched: ["pre-commit"], hooksPaths: ["."], more: false }),
      (f) => f.checkPatchHooks(repo, REAL, ask),
    ),
    { kind: "checked", touched: ["pre-commit"], hooksPaths: ["."], more: false },
  );
  // The forge's own terminal word is a refusal, with its reason; nothing else is.
  for (
    const [status, error] of [
      [422, "hook files are checked only for a repository on this machine"],
      [410, "the patch's bundle is gone"],
      [409, "the branch this patch would land on, trunk, is gone from the repo"],
    ] as const
  ) {
    assertEquals(
      await overWire(
        () => jsonReply(status, { error, terminal: true }),
        (f) => f.checkPatchHooks(repo, REAL, ask),
      ),
      { kind: "refused", message: error },
    );
  }
  for (
    const [reply, message] of [
      [jsonReply(500, {}), "the forge answered 500"],
      // A 500 naming no terminality is asked again, whatever it says.
      [jsonReply(500, { error: "boom" }), "boom"],
      [jsonReply(503, { error: "base cache unavailable, retry" }), "base cache unavailable, retry"],
      [jsonReply(404, { error: "x", terminal: false }), "x"],
    ] as const
  ) {
    assertEquals(
      await overWire(() => reply, (f) => f.checkPatchHooks(repo, REAL, ask)),
      { kind: "unavailable", message },
    );
  }
  // An answer this cannot read — an empty path among them — is malformed, never a clean check.
  for (
    const body of [
      { touched: "x" },
      { touched: [], hooksPaths: [""], more: false },
      { touched: [""], hooksPaths: ["."], more: false },
    ]
  ) {
    assertEquals(
      (await overWire(() => jsonReply(200, body), (f) => f.checkPatchHooks(repo, REAL, ask))).kind,
      "malformed",
    );
  }

  const submission = {
    bundleKey: ask.bundleKey,
    branchName: ask.branchName,
    headSha: ask.headSha,
    repo,
    repoUrl: REAL,
    baseBranch: "trunk",
    title: "t",
    body: "b",
    runId: "r",
    approvedHookPaths: [".husky/old"],
  };
  let sent: unknown = null;
  const held = await overWire(async (req) => {
    sent = await req.json();
    return jsonReply(409, {
      code: "needs_approval",
      touched: [HOOK],
      hooksPaths: [".husky"],
      more: true,
    });
  }, (f) => f.submitPatch(submission));
  assertEquals(held, { kind: "held", touched: [HOOK], hooksPaths: [".husky"], more: true });
  assertEquals((sent as { approvedHookPaths: string[] }).approvedHookPaths, [".husky/old"]);
  // The root spelled "." is a hold like any other.
  assertEquals(
    await overWire(
      () =>
        jsonReply(409, {
          code: "needs_approval",
          touched: ["pre-commit"],
          hooksPaths: ["."],
          more: false,
        }),
      (f) => f.submitPatch(submission),
    ),
    { kind: "held", touched: ["pre-commit"], hooksPaths: ["."], more: false },
  );
  // A hold this cannot read names nothing a person could approve: a retryable failure, which
  // spends an attempt and so ends, rather than a hold nobody could ever lift.
  assertEquals(
    await overWire(
      () => jsonReply(409, { code: "needs_approval", touched: 7 }),
      (f) => f.submitPatch(submission),
    ),
    {
      kind: "failed",
      message: "the forge held this patch for its git hook files, but its answer could not be read",
      terminal: false,
    },
  );
  // Any other 409 is the failure it always was.
  assertEquals(
    (await overWire(
      () => jsonReply(409, { error: "moved", terminal: true }),
      (f) => f.submitPatch(submission),
    )).kind,
    "failed",
  );
});

test("a held submission over the real adapter puts the patch back with a person", async () => {
  const app = buildApp();
  const { patch, runId } = await bornLocalPatch(app, "auto");
  // Checked clean (the noop sees no hook), so it is due — and the forge then finds one at
  // delivery: a target that moved, say.
  const http = httpForge({
    baseUrl: "http://forge.test",
    forgeToken: "t",
    diag: silentDiagnostics(),
  });
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonReply(409, {
        code: "needs_approval",
        touched: [HOOK],
        hooksPaths: [".husky"],
        more: false,
      }),
    )) as unknown as typeof fetch;
  try {
    await sweep(app, { ...app.forge, submitPatch: http.submitPatch });
  } finally {
    globalThis.fetch = original;
  }
  const held = (await app.store.getPatch(patch.id))!;
  assertEquals(held.state, "pending_approval");
  assertEquals(held.hookCheck?.touched, [HOOK]);
  assertEquals(held.lastError, null, "a hold is not a failure");
  assertEquals(held.attempts, 0, "nor does it spend an attempt");
  assert(
    (await app.store.listRunMessages(runId)).some((m) =>
      m.payload?.kind === "patch" && m.payload.state === "held"
    ),
  );
});

// ---- a hook check that cannot be answered ------------------------------------------------------

/** A forge whose hook check always answers `answer`, the rest the app's noop. */
const answering = (app: ReturnType<typeof buildApp>, answer: PatchHooksOutcome): Forge => ({
  ...app.forge,
  checkPatchHooks: () => Promise.resolve(answer),
});

test("a terminal hook-check refusal fails a queued local patch at once, and the run hears why", async () => {
  const app = buildApp();
  const { patch, runId } = await bornLocalPatch(app, "auto");
  const forge = answering(app, { kind: "refused", message: "the patch's bundle is gone" });
  await sweep(app, forge);
  const failed = (await app.store.getPatch(patch.id))!;
  assertEquals(failed.state, "failed");
  assertEquals(failed.nextAttemptAt, null, "no clock: a person decides");
  assertEquals(failed.lastError, "the git hook check failed: the patch's bundle is gone");
  assertEquals(failed.hookCheck, null);
  assertEquals(app.forge.submissions.length, 0);
  const note = (await app.store.listRunMessages(runId)).find((m) =>
    m.payload?.kind === "patch" && m.payload.state === "failed"
  );
  assert(note !== undefined, "the run hears its patch failed");
  assertStringIncludes(note.text, "the patch's bundle is gone");
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-submit-failed").length,
    1,
  );
  // Nothing asks again: the patch is out of the check's working set.
  let asked = 0;
  await sweep(app, {
    ...forge,
    checkPatchHooks: () => {
      asked++;
      return Promise.resolve({ kind: "refused", message: "x" });
    },
  });
  assertEquals(asked, 0);
  assertEquals((await app.store.getPatch(patch.id))!.state, "failed");
});

test("a malformed hook answer is asked again on a clock, and fails the patch once attempts run out", async () => {
  const app = buildApp();
  const { patch } = await bornLocalPatch(app, "auto");
  const forge = answering(app, { kind: "malformed", message: "unreadable" });
  const cfg = { ...DEFAULT_PATCH_SUBMIT_CONFIG, maxAttempts: 3, baseBackoffMs: 0 };
  const deps = {
    store: app.store,
    forge,
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: () => new Date(),
  };
  await sweepPatches(deps, cfg);
  const once = (await app.store.getPatch(patch.id))!;
  assertEquals([once.state, once.attempts], ["queued", 1]);
  assertEquals(once.lastError, "the git hook check failed: unreadable");
  assert(once.nextAttemptAt !== null, "backed off");
  await sweepPatches(deps, cfg);
  await sweepPatches(deps, cfg);
  const done = (await app.store.getPatch(patch.id))!;
  assertEquals([done.state, done.attempts, done.nextAttemptAt], ["failed", 3, null]);
  assertEquals(app.forge.submissions.length, 0);

  // A person retries it: asked once more, and a clean answer this time sends it on its way with
  // a fresh budget — the check's attempts were never deliveries.
  assertEquals((await send(app.handler, "POST", `/v1/patches/${patch.id}/retry`)).status, 200);
  await sweepPatches({ ...deps, forge: app.forge }, cfg);
  const shipped = (await app.store.getPatch(patch.id))!;
  assertEquals(shipped.state, "submitted");
  assertEquals(shipped.lastError, null);
});

test("a check that fails waits out its clock rather than asking every tick", () => {
  const backedOff = failHookCheck(rowOf(), { message: "unreadable", terminal: false }, AT);
  assert(backedOff.kind === "applied");
  assertEquals(backedOff.patch.state, "queued");
  assertEquals(
    backedOff.patch.nextAttemptAt,
    new Date(Date.parse(AT) + DEFAULT_PATCH_SUBMIT_CONFIG.baseBackoffMs).toISOString(),
  );
  assertEquals(backedOff.events, []);
  // Never fails a patch still waiting for its approval — a failed patch's retry would skip it.
  const waiting = failHookCheck(
    rowOf({ state: "pending_approval" }),
    { message: "gone", terminal: true },
    AT,
  );
  assert(waiting.kind === "applied");
  assertEquals([waiting.patch.state, waiting.patch.attempts], ["pending_approval", 1]);
  assert(waiting.patch.nextAttemptAt !== null);
  // ...and its approval asks again at once.
  const approved = approvePatch(waiting.patch, { kind: "user", userId: "u-1" }, AT);
  assert(approved.kind === "applied");
  assertEquals(approved.patch.nextAttemptAt, null);
  // An answer clears the check's retries.
  const answered = recordHookCheck(
    rowOf({ attempts: 2, nextAttemptAt: AT, lastError: "x" }),
    { ...CHECK, touched: [] },
    AT,
  );
  assert(answered.kind === "applied");
  assertEquals(
    [answered.patch.attempts, answered.patch.nextAttemptAt, answered.patch.lastError],
    [0, null, null],
  );
  assertEquals(
    failHookCheck(rowOf({ hookCheck: CHECK }), { message: "x", terminal: true }, AT).kind,
    "refused",
  );
  assertEquals(
    failHookCheck(rowOf({ state: "submitting" }), { message: "x", terminal: true }, AT).kind,
    "refused",
  );
});

test("an unreachable forge leaves the check to the next tick, spending nothing", async () => {
  const app = buildApp();
  const { patch } = await bornLocalPatch(app, "auto");
  const forge = answering(app, { kind: "unavailable", message: "forge unreachable" });
  for (let i = 0; i < 10; i++) await sweep(app, forge);
  const waiting = (await app.store.getPatch(patch.id))!;
  assertEquals([waiting.state, waiting.attempts, waiting.lastError], ["queued", 0, null]);
});

test("a local patch whose checkout entry no longer resolves fails rather than waiting on its check", async () => {
  const app = buildApp();
  const { patch } = await bornLocalPatch(app, "auto");
  await app.store.savePatch({ ...patch, path: "not-in-the-checkout" });
  await sweep(app);
  const failed = (await app.store.getPatch(patch.id))!;
  assertEquals([failed.state, failed.nextAttemptAt], ["failed", null]);
  assertStringIncludes(failed.lastError ?? "", "no longer resolves");
});

test("a malformed hold at delivery fails retryably, then for good, never waiting forever", async () => {
  const app = buildApp();
  const { patch } = await bornLocalPatch(app, "auto");
  const http = httpForge({
    baseUrl: "http://forge.test",
    forgeToken: "t",
    diag: silentDiagnostics(),
  });
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      jsonReply(409, { code: "needs_approval", touched: 7 }),
    )) as unknown as typeof fetch;
  const cfg = { ...DEFAULT_PATCH_SUBMIT_CONFIG, maxAttempts: 2, baseBackoffMs: 0 };
  const deps = {
    store: app.store,
    forge: { ...app.forge, submitPatch: http.submitPatch },
    identityDirectory: app.identities.directory,
    diag: silentDiagnostics(),
    now: () => new Date(),
  };
  try {
    await sweepPatches(deps, cfg);
    const once = (await app.store.getPatch(patch.id))!;
    assertEquals(once.state, "failed");
    assert(once.nextAttemptAt !== null, "retryable");
    assertStringIncludes(once.lastError ?? "", "could not be read");
    await sweepPatches(deps, cfg); // requeued
    await sweepPatches(deps, cfg); // second and last attempt
  } finally {
    globalThis.fetch = original;
  }
  const done = (await app.store.getPatch(patch.id))!;
  assertEquals([done.state, done.attempts, done.nextAttemptAt], ["failed", 2, null]);
});

test("a waiting patch whose hook check failed says why and can be approved; a terminal answer then fails it, undelivered", async () => {
  const app = buildApp();
  const { patch, taskId } = await bornLocalPatch(app);
  const view = async () =>
    (await (await send(app.handler, "GET", `/v1/patches/${patch.id}`)).json()).patch;
  const fresh = await view();
  assertEquals([fresh.hooksPending, fresh.hookCheckError], [true, null]);

  // An unreachable forge is no answer: still checking, nothing to say.
  await sweep(app, answering(app, { kind: "unavailable", message: "forge unreachable" }));
  const unanswered = await view();
  assertEquals([unanswered.hooksPending, unanswered.hookCheckError], [true, null]);

  // A refusal is an answer that never will come: no longer pending, and the reason is shown.
  const refusing = answering(app, { kind: "refused", message: "the patch's bundle is gone" });
  await sweep(app, refusing);
  const stored = (await app.store.getPatch(patch.id))!;
  assertEquals([stored.state, stored.attempts], ["pending_approval", 1]);
  const failedCheck = await view();
  assertEquals(
    [failedCheck.hooksPending, failedCheck.hookCheckError],
    [false, "the patch's bundle is gone"],
  );
  const listed = (await (await send(app.handler, "GET", "/v1/patches")).json()).patches;
  assertEquals([listed[0].hooksPending, listed[0].hookCheckError], [
    false,
    "the patch's bundle is gone",
  ]);
  const detail = await (await send(app.handler, "GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(detail.patches[0].hookCheckError, "the patch's bundle is gone");

  // Approving asks again at once, and the same refusal fails it with its reason.
  const approved = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [],
  });
  assertEquals(approved.status, 200, await approved.clone().text());
  const queued = (await approved.json()).patch;
  assertEquals([queued.state, queued.nextAttemptAt, queued.approvedHookPaths], [
    "queued",
    null,
    [],
  ]);
  await sweep(app, refusing);
  const failed = (await app.store.getPatch(patch.id))!;
  assertEquals([failed.state, failed.hookCheck], ["failed", null]);
  assertEquals(failed.lastError, "the git hook check failed: the patch's bundle is gone");
  assertEquals(app.forge.submissions.length, 0, "never delivered unchecked");
  const after = await view();
  assertEquals([after.hooksPending, after.hookCheckError], [false, null]);
});

// ---- a decision racing the sweep ----------------------------------------------------------------

/** Runs `meanwhile` once, right after the first read of a patch: a write landing between a
 * route's read and its own. */
function raceAfterRead(
  app: ReturnType<typeof buildApp>,
  meanwhile: (read: Patch) => Promise<void>,
) {
  const read = app.store.getPatch.bind(app.store);
  let fired = false;
  app.store.getPatch = async (id) => {
    const patch = await read(id);
    if (!fired && patch !== null) {
      fired = true;
      await meanwhile(patch);
    }
    return patch;
  };
}

test("an approval racing a hook check is refused rather than written over it", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(HOOK);
  const { patch, runId } = await bornLocalPatch(app);
  // The page was read before the check landed: it showed no hook files.
  raceAfterRead(app, () => sweep(app));
  const res = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [],
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    code: "patch_changed",
    error: "This patch changed while you were looking. Look at it again.",
  });
  const kept = (await app.store.getPatch(patch.id))!;
  assertEquals([kept.state, kept.approvedBy], ["pending_approval", null]);
  assertEquals(kept.hookCheck?.touched, [HOOK]);
  // Nothing goes round again: one hold on the record, one notice, nothing delivered.
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "pending_approval");
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-held").length,
    1,
  );
  assertEquals(
    (await app.store.listRunMessages(runId)).filter((m) =>
      m.payload?.kind === "patch" && m.payload.state === "held"
    ).length,
    1,
  );
  assertEquals(app.forge.submissions.length, 0);
});

test("a decision racing a newer patch's supersede never revives the replaced one", async () => {
  for (const action of ["approve", "reject"] as const) {
    const app = buildApp();
    const { patch, runId } = await bornLocalPatch(app);
    raceAfterRead(app, (read) =>
      app.store.savePatch({
        ...read,
        state: "superseded",
        supersededByPatchId: "p-newer",
        updatedAt: new Date(Date.parse(read.updatedAt) + 1).toISOString(),
      }));
    const res = await send(app.handler, "POST", `/v1/patches/${patch.id}/${action}`, {});
    assertEquals(res.status, 409, action);
    assertEquals((await res.json()).code, "patch_changed");
    assertEquals((await app.store.getPatch(patch.id))!.state, "superseded", action);
    assertEquals(
      (await app.store.listEvents(runId)).filter((e) =>
        e.kind === "patch-approved" || e.kind === "patch-rejected"
      ).length,
      0,
      action,
    );
  }
});

// ---- more hook files than can be shown -----------------------------------------------------------

test("a patch with more hook files than ryph can show cannot be approved, and nothing moves", async () => {
  const app = buildApp();
  const { patch, runId } = await bornLocalPatch(app);
  const forge = answering(app, {
    kind: "checked",
    touched: Array.from({ length: 50 }, (_, i) => `.husky/h${i}`),
    hooksPaths: [".husky"],
    more: true,
  });
  await sweep(app, forge);
  const before = (await app.store.getPatch(patch.id))!;
  assertEquals([before.state, before.hookCheck?.more], ["pending_approval", true]);
  const messages = (await app.store.listRunMessages(runId)).length;
  const events = (await app.store.listEvents(runId)).length;

  const res = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: before.hookCheck!.touched,
  });
  assertEquals(res.status, 409);
  assertEquals(await res.json(), {
    code: "too_many_hook_files",
    error: "This change edits more git hook files than Ryph can show. Reject it, or review it " +
      "outside Ryph.",
  });
  assertEquals(await app.store.getPatch(patch.id), before, "no state change");
  assertEquals(
    (await app.store.listRunMessages(runId)).length,
    messages,
    "the run is told nothing",
  );
  assertEquals((await app.store.listEvents(runId)).length, events);
  // Rejecting it stays open.
  assertEquals((await send(app.handler, "POST", `/v1/patches/${patch.id}/reject`)).status, 200);
});

// ---- the held notice on the run's record ---------------------------------------------------------

test("a patch held after its run ended is still on the run's record, and nothing wakes", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(HOOK);
  const { patch, runId, taskId } = await bornLocalPatch(app, "auto");
  const run = (await app.store.getRun(runId))!;
  await app.store.saveRunResult({ ...run, state: "succeeded" });

  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "pending_approval");
  const ended = (await app.store.getRun(runId))!;
  assertEquals([ended.state, ended.attended], ["succeeded", run.attended], "not woken");
  const notes = (await app.store.listRunMessages(runId)).filter((m) =>
    m.payload?.kind === "patch" && m.payload.state === "held"
  );
  assertEquals(notes.length, 1);
  assertEquals(notes[0].kind, "system");
  assertEquals(notes[0].sender, { kind: "platform" });
  assertEquals(notes[0].payload, {
    kind: "patch",
    patchId: patch.id,
    path: patch.path,
    line: patch.line,
    headSha: patch.headSha,
    generation: patch.generation,
    state: "held",
    forgeUrl: null,
    reason: null,
    hookPaths: [HOOK],
  });
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-held").length,
    1,
  );
  // What the run page reads: the task detail's run carries it among its messages.
  const detail = await (await send(app.handler, "GET", `/v1/tasks/${taskId}`)).json();
  const shown = detail.runs.find((r: { id: string }) => r.id === runId);
  assert(
    shown.messages.some((m: { payload: { kind?: string; state?: string } | null }) =>
      m.payload?.kind === "patch" && m.payload.state === "held"
    ),
  );

  // Only a hold is recorded on an ended run: other news about the patch has nobody to hear it.
  const approved = await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`, {
    hookPaths: [HOOK],
  });
  assertEquals(approved.status, 200);
  assertEquals(
    (await app.store.listRunMessages(runId)).filter((m) =>
      m.payload?.kind === "patch" && m.payload.state === "approved"
    ).length,
    0,
  );
});

test("a waiting patch found to change hooks is on its run's record too", async () => {
  const app = buildApp();
  app.forge.hookFiles.push(HOOK);
  const { patch, runId } = await bornLocalPatch(app); // require-approval: already waiting
  await sweep(app);
  assertEquals((await app.store.getPatch(patch.id))!.state, "pending_approval");
  assertEquals(
    (await app.store.listEvents(runId)).filter((e) => e.kind === "patch-held").length,
    1,
  );
  const note = (await app.store.listRunMessages(runId)).find((m) =>
    m.payload?.kind === "patch" && m.payload.state === "held"
  );
  assertEquals(note?.payload?.kind === "patch" ? note.payload.hookPaths : null, [HOOK]);
});

test("providers is the forge's answer, and an unanswered question throws instead of claiming GitHub", async () => {
  assertEquals(
    await overWire(
      () =>
        jsonReply(200, {
          providers: ["github", "local"],
          github: { mode: "app", signIn: true },
          gitlab: null,
          radicle: null,
        }),
      (f) => f.providers(),
    ),
    {
      providers: ["github", "local"],
      github: { mode: "app", signIn: true },
      gitlab: null,
      radicle: null,
    },
  );
  // An App that does not say it signs people in is taken not to.
  assertEquals(
    (await overWire(
      () =>
        jsonReply(200, {
          providers: ["github"],
          github: { mode: "app" },
          gitlab: null,
          radicle: null,
        }),
      (f) => f.providers(),
    )).github,
    { mode: "app", signIn: false },
  );
  // GitLab's mode rides the answer exactly when GitLab is listed, all three fields of it.
  const bot = {
    mode: "bot" as const,
    login: "ryph-bot",
    accountId: "1@https://gitlab.example.com/gl",
    url: "https://gitlab.example.com/gl",
    signIn: true,
  };
  assertEquals(
    await overWire(
      () => jsonReply(200, { providers: ["gitlab"], github: null, gitlab: bot, radicle: null }),
      (f) => f.providers(),
    ),
    { providers: ["gitlab"], github: null, gitlab: bot, radicle: null },
  );
  for (
    const drift of [
      { providers: ["gitlab"], github: null, gitlab: null, radicle: null },
      { providers: [], github: null, gitlab: bot, radicle: null },
      { providers: ["gitlab"], github: null, gitlab: { ...bot, mode: "app" }, radicle: null },
      { providers: ["gitlab"], github: null, gitlab: { ...bot, url: "ftp://x" }, radicle: null },
      { providers: ["gitlab"], github: null, gitlab: { ...bot, login: "" }, radicle: null },
    ]
  ) {
    await assertRejects(() => overWire(() => jsonReply(200, drift), (f) => f.providers()));
  }
  await assertRejects(() => overWire(() => jsonReply(503, {}), (f) => f.providers()));
  await assertRejects(() =>
    overWire(
      () => jsonReply(200, { providers: ["github", "gitlab"], github: { mode: "app" } }),
      (f) => f.providers(),
    )
  );
  await assertRejects(() =>
    overWire(() => Promise.reject(new TypeError("connection refused")), (f) => f.providers())
  );
});

test("GET /v1/forge-providers says the forge is unreachable rather than guessing", async () => {
  const app = buildApp();
  const forge = {
    ...app.forge,
    providers: () => Promise.reject(new Error("forge down")),
  };
  const handler = makeHandler({ ...app.deps, forge: forge as Forge });
  const res = await send(handler, "GET", "/v1/forge-providers");
  assertEquals(res.status, 502);
});

test("a local address is an absolute, canonical path and nothing else", () => {
  assertEquals(isRepoRef("local", REAL), true);
  assertEquals(isRepoRef("local", "/a"), true);
  // The forge's `isLocalRepoRef` accepts these, so this must too: whitespace inside a path, and
  // the longest path it carries.
  assertEquals(isRepoRef("local", "/Users/ada/My Code/app"), true);
  assertEquals(isRepoRef("local", "/ a"), true);
  assertEquals(isRepoRef("local", `/${"a".repeat(4_095)}`), true);
  for (
    const bad of [
      "relative/path",
      "/",
      "/trailing/",
      "/double//slash",
      "/a/./b",
      "/a/../b",
      "/a/..",
      "/nul\u0000",
      "/line\nbreak",
      "/tab\trepo",
      "/escape\u001b[31m",
      "/delete\u007f",
      "/trailing space ",
      "/trailing nbsp\u00a0",
      `/${"a".repeat(4_096)}`,
      "",
    ]
  ) {
    assertEquals(isRepoRef("local", bad), false, `${JSON.stringify(bad)} is not a local address`);
  }
});
