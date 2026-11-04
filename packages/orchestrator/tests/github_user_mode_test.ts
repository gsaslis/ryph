import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// GitHub's user mode on the control plane's side: a forge that acts through one person's token
// instead of an App. Repos are connected with no installation, coordinates read from GitHub
// through the forge; every active user's GitHub login is the token's; nobody signs in or links
// through GitHub; and runs on such a repo go through the gateway like any other.
//
// No GitHub anywhere — the boundary is the noop forge in user mode, and the wire is stubbed, as
// local_forge_test.ts does it.

import { capsClaimOf, NO_CODE_LEG, type Role } from "@ryph/auth";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler, type ToolAccess } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { httpForge } from "../src/adapters/forge/http.ts";
import { githubModeSource } from "../src/adapters/forge/github_mode.ts";
import { forgeUserModeDirectory } from "../src/adapters/identity_directory/forge_user_mode.ts";
import { forgeIdentityProvider } from "../src/adapters/identity_provider/forge.ts";
import type {
  Forge,
  ForgePermission,
  ForgeProviders,
  GithubMode,
  RepoListing,
} from "../src/ports/forge.ts";
import type { ConnectedRepo } from "../src/core/types.ts";
import { tenantFitsMode } from "../src/core/forge_repo.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "../src/core/patch_lifecycle.ts";

const GATEWAY = { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 };
const FORGE_TOKEN = "forge-service-token";
const TOKEN_LOGIN = "octo-ada";

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  caps: capsClaimOf("member"),
} as const;

const toolAccess: ToolAccess = {
  getServer: (id) => Promise.resolve({ id, slug: id, name: id, archivedAt: null }),
  issueRunCredentials: () => Promise.reject(new Error("not in these tests")),
  revokeRunCredentials: () => Promise.resolve(),
  archiveServer: () => Promise.reject(new Error("not in these tests")),
};

/** What GitHub knows: its own spelling of the name, and the clone URL. */
const PAYMENTS: RepoListing = {
  fullName: "Acme/Payments",
  url: "https://github.com/Acme/Payments.git",
  defaultBranch: "trunk",
  private: true,
};
const DOCS: RepoListing = {
  fullName: "acme/docs",
  url: "https://github.com/acme/docs.git",
  defaultBranch: "main",
  private: false,
};

function buildApp(
  opts: {
    role?: Role;
    github?: GithubMode;
    permission?: ForgePermission;
    githubRepo?: (repoRef: string) => RepoListing | null;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const noop = noopForge(silentDiagnostics(), {
    github: opts.github ?? { mode: "user", login: TOKEN_LOGIN },
    // The token administers payments, and only reads docs.
    repos: [{ ...PAYMENTS, admin: true }, { ...DOCS, admin: false }],
    ...(opts.githubRepo ? { githubRepo: opts.githubRepo } : {}),
  });
  /** Every permission question, as the forge was asked it. */
  const asked: Array<{ repoRef: string; tenantId: string | null; subject: string | null }> = [];
  const forge: Forge = {
    ...noop,
    checkPermission(repo, identity, _atLeast) {
      asked.push({ repoRef: repo.repoRef, tenantId: repo.tenantId, subject: identity.subject });
      return Promise.resolve(opts.permission ?? "allowed");
    },
  };
  const githubMode = githubModeSource({ forge, diag: silentDiagnostics() });
  // An operator by default: connecting a user-mode repo is an admin act, which needs
  // repos:manage-all there. Tests about members say so.
  let role: Role = opts.role ?? "operator";
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate:
      (() => Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    toolAccess,
    forgeToken: FORGE_TOKEN,
    forge,
    githubMode,
    githubConnect: noop,
    githubUserConnect: noop,
    radicleConnect: noop,
    localConnect: noop,
    identityDirectory: forgeUserModeDirectory(identities.directory, {
      github: githubMode,
      gitlab: null,
    }),
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
      platformTools: { webServerId: "ms-platform-web", web: false, forge: null, pending: false },
    },
  };
  return {
    handler: makeHandler(deps),
    deps,
    store,
    launches,
    noop,
    asked,
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
    provider: "github",
    repoRef: "acme/payments",
    ...over,
  });

// ---- connecting ------------------------------------------------------------------------------

test("user mode: fork pushes cannot be turned on — the token never pushes to a fork", async () => {
  const app = buildApp();
  const repo: ConnectedRepo = await (await connect(app)).json();
  const on = await send(app.handler, "PATCH", `/v1/connected-repos/${repo.id}`, {
    allowForkPushes: true,
  });
  assertEquals(on.status, 400);
  assertStringIncludes((await on.json()).error, "GitHub App");
  assertEquals((await app.store.getConnectedRepo(repo.id))?.allowForkPushes, false);
  // Off is always allowed: nothing is promised.
  const off = await send(app.handler, "PATCH", `/v1/connected-repos/${repo.id}`, {
    allowForkPushes: false,
  });
  assertEquals(off.status, 200);
});

test("user mode: a repo connects with no installation, its coordinates GitHub's, never the caller's", async () => {
  const app = buildApp();
  const res = await connect(app, { url: "https://evil.test/x.git", defaultBranch: "evil" });
  const repo = await res.json();
  assertEquals(res.status, 201, JSON.stringify(repo));
  assertEquals(repo.provider, "github");
  assertEquals(repo.installationId, null);
  // GitHub's own spelling of the name is the row's.
  assertEquals(repo.repoRef, "Acme/Payments");
  assertEquals(repo.url, PAYMENTS.url);
  assertEquals(repo.defaultBranch, "trunk");
  assertEquals(app.noop.githubDescribed, ["acme/payments"]);
  // The live admin check asked about the TOKEN's login, with no tenant.
  assertEquals(app.asked, [{ repoRef: "acme/payments", tenantId: null, subject: TOKEN_LOGIN }]);
});

test("user mode: an installationId is refused before anything is asked", async () => {
  const app = buildApp();
  const res = await connect(app, { installationId: "12345" });
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "without an installation");
  assertEquals(app.asked, []);
  assertEquals(app.noop.githubDescribed, []);
  assertEquals(await app.store.listConnectedRepos(), []);
});

test("user mode: the same repo twice is a 409, however its name is cased", async () => {
  const app = buildApp();
  assertEquals((await connect(app)).status, 201);
  const again = await connect(app, { repoRef: "ACME/PAYMENTS" });
  assertEquals(again.status, 409);
  assertStringIncludes((await again.json()).error, "already connected");
  assertEquals((await app.store.listConnectedRepos()).length, 1);
});

test("user mode: a repo GitHub does not know is a 404; a forge that did not answer is a 502", async () => {
  const gone = buildApp({ githubRepo: () => null });
  assertEquals((await connect(gone)).status, 404);
  assertEquals(await gone.store.listConnectedRepos(), []);

  const app = buildApp();
  app.noop.describeGithubRepo = () => Promise.reject(new Error("forge down"));
  assertEquals((await connect(app)).status, 502);
  assertEquals(await app.store.listConnectedRepos(), []);
});

test("user mode: a renamed repo is refused by its old name, and a malformed answer never stored", async () => {
  const renamed = buildApp({ githubRepo: () => ({ ...PAYMENTS, fullName: "acme/billing" }) });
  const res = await connect(renamed);
  assertEquals(res.status, 422);
  assertStringIncludes((await res.json()).error, "acme/billing");
  assertEquals(await renamed.store.listConnectedRepos(), []);

  const malformed = buildApp({ githubRepo: () => ({ ...PAYMENTS, url: "not a url" }) });
  assertEquals((await connect(malformed)).status, 502);
  assertEquals(await malformed.store.listConnectedRepos(), []);
});

test("user mode: no admin on the repo, no repos:connect, or a deactivated caller — nothing connects", async () => {
  const denied = buildApp({ permission: "denied" });
  const res = await connect(denied);
  assertEquals(res.status, 403);
  assertStringIncludes((await res.json()).error, `@${TOKEN_LOGIN}`);
  assertEquals(denied.noop.githubDescribed, []);

  const viewer = buildApp({ role: "viewer" });
  assertEquals((await connect(viewer)).status, 403);
  assertEquals(viewer.asked, []);

  // A deactivated user has no GitHub login, in user mode as in App mode: nothing to ask about.
  const gone = buildApp();
  gone.identities.deactivate(USER.userId);
  const refused = await connect(gone);
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "link your GitHub account");
  assertEquals(gone.asked, []);
  assertEquals(await gone.store.listConnectedRepos(), []);
});

test("App mode: a GitHub repo still needs its installation, and connects through it", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  const res = await connect(app);
  assertEquals(res.status, 400);
  assertStringIncludes((await res.json()).error, "installationId is required");

  await app.store.saveInstallation({
    id: "gi-1",
    installationId: "12345",
    accountLogin: "acme",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  app.identities.link(USER.userId, "ada");
  const ok = await connect(app, { repoRef: "acme/docs", installationId: "12345" });
  const repo = await ok.json();
  assertEquals(ok.status, 201, JSON.stringify(repo));
  assertEquals(repo.installationId, "12345");
  // The linked login, not any token's: the directory leaves App mode alone.
  assertEquals(app.asked, [{ repoRef: "acme/docs", tenantId: "12345", subject: "ada" }]);
  assertEquals(app.noop.githubDescribed, [], "the user-mode describe is never dialled");
});

test("a Radicle body still carries no installation", async () => {
  const app = buildApp();
  const res = await send(app.handler, "POST", "/v1/connected-repos", {
    provider: "radicle",
    repoRef: "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
    installationId: "12345",
  });
  assertEquals(res.status, 400);
});

test("user mode: the installation routes do not apply", async () => {
  const app = buildApp();
  const res = await send(app.handler, "POST", "/v1/installations", { installationId: "12345" });
  assertEquals(res.status, 501);
  assertEquals(
    (await send(app.handler, "GET", "/v1/installations/12345/repos")).status,
    501,
  );
});

// ---- who administers ---------------------------------------------------------------------------

/** A user-mode row, as an operator connected it. */
async function connectedAsOperator(app: ReturnType<typeof buildApp>): Promise<ConnectedRepo> {
  app.as("operator");
  const res = await connect(app);
  assertEquals(res.status, 201);
  return await res.json();
}

test("user mode: a member cannot administer a GitHub repo — the token's admin is everyone's", async () => {
  const app = buildApp({ role: "member" });
  // Connecting, even under the auto policy: refused before GitHub is asked anything.
  const refused = await connect(app, { submissionPolicy: "auto" });
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "repos:manage-all");
  assertEquals(app.asked, []);
  assertEquals(app.noop.githubDescribed, []);
  assertEquals(await app.store.listConnectedRepos(), []);

  const repo = await connectedAsOperator(app);
  app.as("member");
  app.asked.length = 0;
  // Flipping to auto, disconnecting: both the admin bar.
  const flip = await send(app.handler, "PATCH", `/v1/connected-repos/${repo.id}`, {
    submissionPolicy: "auto",
  });
  assertEquals(flip.status, 403);
  assertStringIncludes((await flip.json()).error, "repos:manage-all");
  assertEquals(
    (await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`)).status,
    403,
  );
  assertEquals(app.asked, [], "the token was never asked on a member's behalf");
  // A workspace with the repo in it is the repo's admins' to change.
  const ws = await (await send(app.handler, "POST", "/v1/workspaces", { name: "ws" })).json();
  app.as("operator");
  assertEquals(
    (await send(app.handler, "POST", `/v1/workspaces/${ws.workspace.id}/repos`, {
      connectedRepoId: repo.id,
    })).status,
    201,
  );
  app.as("member");
  app.asked.length = 0;
  assertEquals(
    (await send(app.handler, "PATCH", `/v1/workspaces/${ws.workspace.id}`, { name: "mine" }))
      .status,
    403,
  );
  assertEquals(app.asked, [], "the token was never asked on a member's behalf");
  const after = await app.store.getConnectedRepo(repo.id);
  assertEquals(after?.submissionPolicy, repo.submissionPolicy);
  assertEquals(after?.archivedAt, null);
});

test("user mode: an admin or owner administers — and the token must still hold admin", async () => {
  for (const role of ["operator", "owner"] as const) {
    const app = buildApp({ role });
    const repo: ConnectedRepo = await (await connect(app, { submissionPolicy: "auto" })).json();
    assertEquals(repo.submissionPolicy, "auto");
    assertEquals(
      (await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`)).status,
      200,
    );
    // Both admin checks were asked of GitHub, about the token.
    assertEquals(app.asked.map((a) => a.subject), [TOKEN_LOGIN, TOKEN_LOGIN]);
  }
  const notAdmin = buildApp({ role: "owner", permission: "denied" });
  assertEquals((await connect(notAdmin)).status, 403);
});

test("App mode: a member with admin on GitHub still administers a repo", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true }, role: "member" });
  await app.store.saveInstallation({
    id: "gi-1",
    installationId: "12345",
    accountLogin: "acme",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  app.identities.link(USER.userId, "ada");
  const res = await connect(app, { repoRef: "acme/docs", installationId: "12345" });
  assertEquals(res.status, 201);
  const repo: ConnectedRepo = await res.json();
  assertEquals(
    (await send(app.handler, "PATCH", `/v1/connected-repos/${repo.id}`, {
      submissionPolicy: "auto",
    })).status,
    200,
  );
  assertEquals(
    (await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`)).status,
    200,
  );
});

// ---- rows from the other mode -------------------------------------------------------------------

/** A GitHub row as App mode connected it: an installation the user-mode forge refuses. */
const appModeRow = (over: Partial<ConnectedRepo> = {}): ConnectedRepo => ({
  id: "cr-app",
  provider: "github",
  installationId: "12345",
  repoRef: "Acme/Payments",
  url: PAYMENTS.url,
  defaultBranch: "trunk",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

test("user mode: a row left over from App mode is no connection, and an admin can clear it", async () => {
  const app = buildApp();
  await app.store.createConnectedRepo(appModeRow());
  // The listing does not call it connected, and connecting the repo again is no duplicate.
  const listed = await (await send(app.handler, "GET", "/v1/github/repos")).json();
  assertEquals(listed.repos[0].connectedRepoId, null);
  assertEquals((await connect(app)).status, 201);

  // A member meets the admin check, which the forge can never pass for this row.
  app.as("member");
  app.asked.length = 0;
  const forge = app.deps.forge;
  app.deps.forge = { ...forge, checkPermission: () => Promise.resolve("denied" as const) };
  const handler = makeHandler(app.deps);
  assertEquals((await send(handler, "POST", "/v1/connected-repos/cr-app/archive")).status, 403);
  // An admin clears it without asking the forge.
  app.as("operator");
  app.deps.forge = {
    ...forge,
    checkPermission: () => Promise.reject(new Error("the forge must not be asked")),
  };
  const cleared = await send(makeHandler(app.deps), "POST", "/v1/connected-repos/cr-app/archive");
  assertEquals(cleared.status, 200);
  assert((await app.store.getConnectedRepo("cr-app"))?.archivedAt !== null);
});

test("App mode: a row left over from user mode is no connection, and an admin can clear it", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  await app.store.saveInstallation({
    id: "gi-1",
    installationId: "12345",
    accountLogin: "acme",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await app.store.createConnectedRepo(
    appModeRow({ id: "cr-user", installationId: null, repoRef: "acme/docs" }),
  );
  const listed = await (await send(app.handler, "GET", "/v1/installations/12345/repos")).json();
  assertEquals(
    listed.repos.find((r: { fullName: string }) => r.fullName === "acme/docs").connected,
    false,
  );
  app.identities.link(USER.userId, "ada");
  assertEquals(
    (await connect(app, { repoRef: "acme/docs", installationId: "12345" })).status,
    201,
    "the leftover is no duplicate",
  );
  app.deps.forge = {
    ...app.deps.forge,
    checkPermission: () => Promise.reject(new Error("the forge must not be asked")),
  };
  const cleared = await send(makeHandler(app.deps), "POST", "/v1/connected-repos/cr-user/archive");
  assertEquals(cleared.status, 200);
});

test("which tenant fits which mode: null is no GitHub at all, unknown fits everything", () => {
  const app = { provider: "github" as const, installationId: "12345" };
  const user = { provider: "github" as const, installationId: null };
  const radicle = { provider: "radicle" as const, installationId: null };
  const userMode: GithubMode = { mode: "user", login: TOKEN_LOGIN };
  assertEquals(tenantFitsMode(app, { mode: "app", signIn: true }), true);
  assertEquals(tenantFitsMode(user, { mode: "app", signIn: true }), false);
  assertEquals(tenantFitsMode(app, userMode), false);
  assertEquals(tenantFitsMode(user, userMode), true);
  // The forge runs no GitHub: no GitHub row fits.
  assertEquals(tenantFitsMode(app, null), false);
  assertEquals(tenantFitsMode(user, null), false);
  // Unknown: nothing is decided on no answer.
  assertEquals(tenantFitsMode(app, undefined), true);
  assertEquals(tenantFitsMode(user, undefined), true);
  for (const mode of [{ mode: "app", signIn: true } as const, userMode, null, undefined]) {
    assertEquals(tenantFitsMode(radicle, mode), true);
  }
});

test("a forge that runs no GitHub strands every GitHub row: an admin clears one unasked", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  await app.store.createConnectedRepo(appModeRow());
  app.deps.forge = {
    ...app.deps.forge,
    providers: () =>
      Promise.resolve({
        providers: ["radicle"],
        github: null,
        gitlab: null,
        radicle: { mode: "deployment" },
      }),
    checkPermission: () => Promise.reject(new Error("the forge must not be asked")),
  };
  const cleared = await send(makeHandler(app.deps), "POST", "/v1/connected-repos/cr-app/archive");
  assertEquals(cleared.status, 200);
  assert((await app.store.getConnectedRepo("cr-app"))?.archivedAt !== null);
});

test("App → user → App: a /ryph command finds the App row, not the newer user-mode leftover", async () => {
  // Denied, so the command stops at the permission check — which names the row it picked.
  const app = buildApp({ github: { mode: "app", signIn: true }, permission: "denied" });
  await app.store.createConnectedRepo(appModeRow());
  await app.store.createConnectedRepo(
    appModeRow({
      id: "cr-user",
      installationId: null,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    }),
  );
  const res = await send(
    app.handler,
    "POST",
    "/v1/forge/events",
    {
      deliveryId: "gh-delivery-stale-1",
      kind: "issue_comment.created",
      repo: { provider: "github", repoRef: "acme/payments", url: PAYMENTS.url },
      actorLogin: "someone",
      thread: { kind: "issue", ref: "7" },
      body: "/ryph ada fix it",
      sourceCommentId: "1234",
      receivedAt: "2026-02-02T00:00:00.000Z",
    },
    FORGE_TOKEN,
  );
  assertEquals((await res.json()).outcome, "denied");
  assertEquals(app.asked.map((a) => a.tenantId), ["12345"]);
});

test("a row that fits the mode is still checked live, admin or not", async () => {
  const app = buildApp({ permission: "denied" });
  await app.store.createConnectedRepo(appModeRow({ id: "cr-fits", installationId: null }));
  const res = await send(app.handler, "POST", "/v1/connected-repos/cr-fits/archive");
  assertEquals(res.status, 403);
  assertEquals(app.asked.length, 1);
});

// ---- installation settings -------------------------------------------------------------------

const settingsPath = "/v1/connected-repos/cr-app/installation-settings";

test("installation settings: redirects to the URL the forge resolves at click time", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true }, role: "viewer" });
  // No installation registry row or new metadata is required for historical connections.
  await app.store.createConnectedRepo(appModeRow());
  const asked: string[] = [];
  let url = "https://github.com/organizations/renamed-acme/settings/installations/12345";
  const handler = makeHandler({
    ...app.deps,
    githubConnect: {
      ...app.noop,
      getInstallationSettingsUrl: (id: string) => {
        asked.push(id);
        return Promise.resolve(url);
      },
      describeInstallation: () => Promise.reject(new Error("must not list installation repos")),
    },
  });
  const org = await send(handler, "GET", `${settingsPath}?installationId=999`);
  assertEquals(org.status, 302);
  assertEquals(org.headers.get("location"), url);
  assertEquals(org.headers.get("cache-control"), "no-store");
  url = "https://ghe.example/settings/installations/12345";
  const personal = await send(handler, "GET", settingsPath);
  assertEquals(personal.status, 302);
  assertEquals(personal.headers.get("location"), url);
  assertEquals(asked, ["12345", "12345"], "the stored installation id, never the caller's");
  assertEquals(app.asked, [], "GitHub enforces administration at the destination, not on the link");
});

test("installation settings: authenticates and requires repos:read before asking the forge", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  await app.store.createConnectedRepo(appModeRow());
  let calls = 0;
  const githubConnect = {
    ...app.noop,
    getInstallationSettingsUrl: () => {
      calls++;
      return Promise.reject(new Error("must not ask"));
    },
  };
  const anonymous = makeHandler({
    ...app.deps,
    githubConnect,
    authenticate: () => Promise.resolve(new Response(null, { status: 401 })),
  });
  assertEquals((await send(anonymous, "GET", settingsPath)).status, 401);
  const forbidden = makeHandler({
    ...app.deps,
    githubConnect,
    authenticate: () =>
      Promise.resolve({ ...USER, caps: [], emailVerified: true, sid: "s-1", via: "session" }),
  });
  assertEquals((await send(forbidden, "GET", settingsPath)).status, 403);
  assertEquals(calls, 0);
});

test("installation settings: absent, local, Radicle and user-mode repos do not ask GitHub", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  let calls = 0;
  const handler = makeHandler({
    ...app.deps,
    githubConnect: {
      ...app.noop,
      getInstallationSettingsUrl: () => {
        calls++;
        return Promise.reject(new Error("must not ask"));
      },
    },
  });
  assertEquals((await send(handler, "GET", settingsPath)).status, 404);
  for (
    const [id, provider, installationId] of [
      ["cr-local", "local", null],
      ["cr-radicle", "radicle", null],
      ["cr-user", "github", null],
    ] as const
  ) {
    await app.store.createConnectedRepo(appModeRow({ id, provider, installationId }));
    const res = await send(handler, "GET", `/v1/connected-repos/${id}/installation-settings`);
    assertEquals(res.status, 404);
  }
  assertEquals(calls, 0);
});

test("installation settings: no App, user mode and a forge that cannot say answer plainly", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  await app.store.createConnectedRepo(appModeRow());
  const noApp = makeHandler({ ...app.deps, githubConnect: undefined });
  assertEquals((await send(noApp, "GET", settingsPath)).status, 503);
  const failed = makeHandler({
    ...app.deps,
    githubConnect: {
      ...app.noop,
      getInstallationSettingsUrl: () => Promise.reject(new Error("GitHub is unavailable")),
    },
  });
  const res = await send(failed, "GET", settingsPath);
  assertEquals(res.status, 502);
  assertEquals(res.headers.get("location"), null);
  assertEquals(await res.json(), {
    error: "GitHub did not say where this installation is managed",
  });
  const user = buildApp();
  await user.store.createConnectedRepo(appModeRow());
  assertEquals((await send(user.handler, "GET", settingsPath)).status, 501);
});

test("installation repo listing carries the settings URL from the same forge read", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  await app.store.saveInstallation({
    id: "gi-1",
    installationId: "12345",
    accountLogin: "old-account-name",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  let settingsUrl: string | null =
    "https://github.com/organizations/acme/settings/installations/12345";
  let settingsAsked = 0;
  const handler = makeHandler({
    ...app.deps,
    githubConnect: {
      ...app.noop,
      getInstallationSettingsUrl: () => {
        settingsAsked++;
        return Promise.reject(new Error("the listing already has it"));
      },
      describeInstallation: () => Promise.resolve({ accountLogin: "acme", settingsUrl, repos: [] }),
    },
  });
  const listed = await send(handler, "GET", "/v1/installations/12345/repos");
  assertEquals(await listed.json(), { accountLogin: "acme", settingsUrl, repos: [] });
  settingsUrl = null;
  const unnamed = await send(handler, "GET", "/v1/installations/12345/repos");
  assertEquals((await unnamed.json()).settingsUrl, null);
  assertEquals(settingsAsked, 0);
});

test("noop forge names both kinds of settings page, so a playground shows each", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  assertEquals(
    await app.noop.getInstallationSettingsUrl("12344"),
    "https://github.com/settings/installations/12344",
  );
  assertEquals(
    await app.noop.getInstallationSettingsUrl("12345"),
    "https://github.com/organizations/noop-account-12345/settings/installations/12345",
  );
  assertEquals(
    (await app.noop.describeInstallation("12345")).settingsUrl,
    await app.noop.getInstallationSettingsUrl("12345"),
  );
});

// ---- listing ---------------------------------------------------------------------------------

test("GET /v1/github/repos lists the token's repos, each with its connected row", async () => {
  const app = buildApp();
  const connected: ConnectedRepo = await (await connect(app)).json();
  // An archived row is no connection.
  await app.store.createConnectedRepo({
    ...connected,
    id: "cr-old",
    repoRef: "acme/docs",
    archivedAt: "2026-01-01T00:00:00.000Z",
  });
  const res = await send(app.handler, "GET", "/v1/github/repos");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    repos: [
      { ...PAYMENTS, admin: true, connectedRepoId: connected.id },
      { ...DOCS, admin: false, connectedRepoId: null },
    ],
  });

  app.as("viewer");
  assertEquals((await send(app.handler, "GET", "/v1/github/repos")).status, 403);
});

test("GET /v1/github/repos is a 501 in App mode, and a 502 when the forge is down", async () => {
  const app = buildApp({ github: { mode: "app", signIn: true } });
  assertEquals((await send(app.handler, "GET", "/v1/github/repos")).status, 501);

  const down = buildApp();
  down.noop.listGithubRepos = () => Promise.reject(new Error("forge down"));
  assertEquals((await send(down.handler, "GET", "/v1/github/repos")).status, 502);
});

test("GET /v1/forge-providers says how GitHub is acted on", async () => {
  const user = buildApp();
  assertEquals(await (await send(user.handler, "GET", "/v1/forge-providers")).json(), {
    providers: ["github", "radicle"],
    github: { mode: "user", login: TOKEN_LOGIN },
    gitlab: null,
    radicle: { mode: "deployment" },
  });
  const app = buildApp({ github: { mode: "app", signIn: true } });
  assertEquals(await (await send(app.handler, "GET", "/v1/forge-providers")).json(), {
    providers: ["github", "radicle"],
    github: { mode: "app", signIn: true },
    gitlab: null,
    radicle: { mode: "deployment" },
  });
  const none = makeHandler({ ...user.deps, forge: null });
  assertEquals(await (await send(none, "GET", "/v1/forge-providers")).json(), {
    providers: [],
    github: null,
    gitlab: null,
    radicle: null,
  });
});

// ---- a run on a user-mode repo ------------------------------------------------------------------

test("user mode: a member starts a run as the token, cloned through the gateway with no tenant", async () => {
  const app = buildApp();
  const repo: ConnectedRepo = await (await connect(app)).json();
  // An operator connected it; a member runs on it — `write` is the token's answer alone.
  app.as("member");
  const agentRes = await send(app.handler, "POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  });
  const agent = await agentRes.json();
  const res = await send(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  });
  const created = await res.json();
  assertEquals(res.status, 201, JSON.stringify(created));
  // The write check on launch asked about the token's login.
  assertEquals(app.asked.at(-1), {
    repoRef: "Acme/Payments",
    tenantId: null,
    subject: TOKEN_LOGIN,
  });

  const token = (await bootstrapEnv(app.handler, app.launches[0].env)).RYPH_GIT_TOKEN;
  assert(token !== undefined && token.length > 0);
  const grant = await (await send(
    app.handler,
    "POST",
    "/v1/forge/git-keys/resolve",
    { token },
    FORGE_TOKEN,
  )).json();
  assertEquals(grant.repos.length, 1);
  assertEquals(grant.repos[0].provider, "github");
  assertEquals(grant.repos[0].repoRef, "Acme/Payments");
  assertEquals(grant.repos[0].tenantId, null);

  // A drifted origin cannot be "anonymous" for a repo whose null tenant means the token: the
  // member leaves the grant instead, and with nothing left the key resolves nothing.
  await app.store.saveConnectedRepo({ ...repo, url: "https://evil.test/acme/payments.git" });
  assertEquals(
    (await send(app.handler, "POST", "/v1/forge/git-keys/resolve", { token }, FORGE_TOKEN))
      .status,
    404,
  );
});

test("user mode: a pull request names who asked by their ryph name, not the token's login", async () => {
  const app = buildApp();
  app.identities.name(USER.userId, "Ada Lovelace");
  const repo: ConnectedRepo = await (await connect(app)).json();
  app.as("member");
  const agent = await (await send(app.handler, "POST", "/v1/agents", {
    name: "Ada",
    email: "ada@example.com",
    harnessKind: "echo",
  })).json();
  const created = await (await send(app.handler, "POST", "/v1/tasks", {
    agentId: agent.id,
    connectedRepoId: repo.id,
    spec: { title: "Fix the flaky test", instructions: "Find and fix it." },
  })).json();
  const task = (await app.store.getTask(created.taskId))!;
  const sha = "a".repeat(40);
  const reported = await send(app.handler, "POST", `/v1/runs/${created.runId}/result`, {
    status: "success",
    branches: [{
      connectedRepoId: repo.id,
      path: task.repos[0].path,
      name: `ryph/ada/${created.runId}/work`,
      line: "work",
      headSha: sha,
      commits: [{ sha, subject: "fix the flaky test" }],
      generation: 1,
      carries: [],
    }],
    summary: "Pinned the clock.",
  }, (await bootstrapEnv(app.handler, app.launches.at(-1)!.env!)).RYPH_RUN_TOKEN);
  assertEquals(reported.status, 200, await reported.clone().text());
  const patch = (await app.store.listPatches({ state: "pending_approval" })).patches[0];
  assertEquals((await send(app.handler, "POST", `/v1/patches/${patch.id}/approve`)).status, 200);

  await sweepPatches(
    {
      store: app.store,
      forge: app.deps.forge,
      identityDirectory: app.deps.identityDirectory,
      diag: silentDiagnostics(),
      now: () => new Date(),
    },
    DEFAULT_PATCH_SUBMIT_CONFIG,
  );
  assertEquals(app.noop.submissions.length, 1);
  const body = app.noop.submissions[0].body;
  assertStringIncludes(body, "requested by ryph user `Ada Lovelace`</sub>");
  assert(!body.includes(`@${TOKEN_LOGIN}`), "the token's owner asked for nothing");
});

// ---- identity -----------------------------------------------------------------------------------

/** A forge whose providers answer the test can change, counting how often it was asked. */
function scriptedForge(initial: ForgeProviders | Error) {
  let answer: ForgeProviders | Error = initial;
  let calls = 0;
  const forge = {
    providers: () => {
      calls++;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return {
    forge,
    set: (next: ForgeProviders | Error) => (answer = next),
    calls: () => calls,
  };
}

const USER_MODE: ForgeProviders = {
  providers: ["github"],
  github: { mode: "user", login: TOKEN_LOGIN },
  gitlab: null,
  radicle: null,
};
const APP_MODE: ForgeProviders = {
  providers: ["github"],
  github: { mode: "app", signIn: true },
  gitlab: null,
  radicle: null,
};

test("the directory answers the token's login for every active user, and nothing else changes", async () => {
  const ids = fakeIdentityDirectory();
  ids.link("u-linked", "someone-else");
  ids.link("u-1", "did:key:z6Mk", "radicle");
  ids.deactivate("u-gone");
  const { forge } = scriptedForge(USER_MODE);
  const dir = forgeUserModeDirectory(ids.directory, {
    github: githubModeSource({ forge, diag: silentDiagnostics() }),
    gitlab: null,
  });
  assertEquals(await dir.subjectFor("u-1", "github"), TOKEN_LOGIN);
  assertEquals(await dir.subjectFor("u-linked", "github"), TOKEN_LOGIN);
  assertEquals(await dir.subjectFor("u-gone", "github"), null);
  // Other forges, and the reverse lookup, are the inner directory's.
  assertEquals(await dir.subjectFor("u-1", "radicle"), "did:key:z6Mk");
  assertEquals(await dir.userIdsForLogin("github", TOKEN_LOGIN), []);
  assertEquals(await dir.isActiveUser("u-gone"), false);
});

test("user mode: the requester is named by their ryph name, never the token's login", async () => {
  const ids = fakeIdentityDirectory();
  ids.name("u-1", "Grace @hopper **bold**");
  ids.name("u-gone", "Gone");
  ids.deactivate("u-gone");
  ids.link("u-1", "did:key:z6Mk", "radicle");
  const dir = forgeUserModeDirectory(ids.directory, {
    github: githubModeSource({ forge: scriptedForge(USER_MODE).forge, diag: silentDiagnostics() }),
    gitlab: null,
  });
  // Sanitized to plain text: no @ to ping anyone, no markdown.
  assertEquals(await dir.requesterFor("u-1", "github"), { name: "Grace hopper bold" });
  assertEquals(await dir.requesterFor("u-gone", "github"), null);
  assertEquals(await dir.requesterFor("u-1", "radicle"), { login: "did:key:z6Mk" });

  const app = forgeUserModeDirectory(ids.directory, {
    github: githubModeSource({ forge: scriptedForge(APP_MODE).forge, diag: silentDiagnostics() }),
    gitlab: null,
  });
  ids.link("u-1", "grace");
  assertEquals(await app.requesterFor("u-1", "github"), { login: "grace" });
});

test("in App mode, or before the forge ever answered, the directory is the inner one", async () => {
  const ids = fakeIdentityDirectory();
  ids.link("u-linked", "someone-else");
  const app = forgeUserModeDirectory(ids.directory, {
    github: githubModeSource({ forge: scriptedForge(APP_MODE).forge, diag: silentDiagnostics() }),
    gitlab: null,
  });
  assertEquals(await app.subjectFor("u-linked", "github"), "someone-else");
  assertEquals(await app.subjectFor("u-1", "github"), null);

  const unanswered = forgeUserModeDirectory(ids.directory, {
    github: githubModeSource({
      forge: scriptedForge(new Error("down")).forge,
      diag: silentDiagnostics(),
    }),
    gitlab: null,
  });
  assertEquals(await unanswered.subjectFor("u-linked", "github"), "someone-else");
});

test("the mode is asked once per TTL, single-flight, and kept through a failed re-read", async () => {
  let at = 0;
  const scripted = scriptedForge(USER_MODE);
  const source = githubModeSource({
    forge: scripted.forge,
    diag: silentDiagnostics(),
    now: () => at,
    ttlMs: 1_000,
  });
  assertEquals(source.current(), undefined);
  const [a, b] = await Promise.all([source.get(), source.get()]);
  assertEquals(a, USER_MODE.github);
  assertEquals(b, USER_MODE.github);
  assertEquals(scripted.calls(), 1);
  assertEquals(source.current(), USER_MODE.github);

  at = 1_500;
  scripted.set(new Error("forge down"));
  assertEquals(await source.get(), USER_MODE.github, "stale beats a flip to App semantics");
  at = 2_000;
  await source.get();
  assertEquals(scripted.calls(), 2, "a failed re-read waits out another TTL");

  at = 3_000;
  scripted.set(APP_MODE);
  assertEquals(await source.get(), { mode: "app", signIn: true });

  const never = githubModeSource({
    forge: scriptedForge(new Error("down")).forge,
    diag: silentDiagnostics(),
  });
  await assertRejects(() => never.get());
});

test("user mode: GitHub is offered for neither sign-in nor linking, and has no organization", async () => {
  const noop = noopForge(silentDiagnostics());
  const user = githubModeSource({
    forge: scriptedForge(USER_MODE).forge,
    diag: silentDiagnostics(),
  });
  await user.get();
  const provider = forgeIdentityProvider({
    githubConnect: noop,
    store: memoryTaskStore(),
    githubMode: user,
  });
  assertEquals(provider.providers(), []);
  await assertRejects(() => provider.exchangeCode("github", "code", NO_CODE_LEG));
  assertEquals(
    await provider.isOrgMember("github", { login: "anyone", accountId: "1" }),
    "no-organization",
  );

  const app = githubModeSource({ forge: scriptedForge(APP_MODE).forge, diag: silentDiagnostics() });
  await app.get();
  const appProvider = forgeIdentityProvider({
    githubConnect: noop,
    store: memoryTaskStore(),
    githubMode: app,
  });
  assertEquals(appProvider.providers(), ["github"]);
  assertEquals((await appProvider.exchangeCode("github", "code", NO_CODE_LEG)).login !== "", true);
});

test("an App without an OAuth client, no GitHub, or a forge not yet heard from signs nobody in", async () => {
  const noopApp = noopForge(silentDiagnostics());
  const exchanged: string[] = [];
  const githubConnect = {
    ...noopApp,
    exchangeOAuthCode: (code: string) => {
      exchanged.push(code);
      return noopApp.exchangeOAuthCode(code);
    },
  };
  const noSignIn: ForgeProviders = { ...APP_MODE, github: { mode: "app", signIn: false } };
  const noGithub: ForgeProviders = { providers: [], github: null, gitlab: null, radicle: null };
  for (const answer of [noSignIn, noGithub]) {
    const mode = githubModeSource({
      forge: scriptedForge(answer).forge,
      diag: silentDiagnostics(),
    });
    await mode.get();
    const provider = forgeIdentityProvider({
      githubConnect,
      store: memoryTaskStore(),
      githubMode: mode,
    });
    assertEquals(provider.providers(), []);
    await assertRejects(() => provider.exchangeCode("github", "code", NO_CODE_LEG));
  }
  // Never answered: not offered, and a code is refused rather than redeemed on a guess.
  const silent = githubModeSource({
    forge: scriptedForge(new Error("down")).forge,
    diag: silentDiagnostics(),
  });
  const unheard = forgeIdentityProvider({
    githubConnect,
    store: memoryTaskStore(),
    githubMode: silent,
  });
  assertEquals(unheard.providers(), []);
  await assertRejects(() => unheard.exchangeCode("github", "code", NO_CODE_LEG));
  assertEquals(exchanged, [], "the forge is never asked");
});

// ---- the wire ---------------------------------------------------------------------------------

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

test("installation settings wire validates the URL and carries the service credential", async () => {
  for (
    const url of [
      "https://github.com/organizations/acme/settings/installations/12345",
      "https://github.com/settings/installations/12345",
      "https://github.com/enterprises/big-co/settings/installations/12345",
      // An Enterprise Server's host is the forge's to know, not this side's.
      "https://ghe.example/organizations/acme/settings/installations/12345",
    ]
  ) {
    const actual = await overWire(async (req) => {
      assertEquals(new URL(req.url).pathname, "/v1/service/installation-settings");
      assertEquals(req.method, "POST");
      assertEquals(req.headers.get("authorization"), "Bearer t");
      assertEquals(await req.json(), { installationId: "12345" });
      return jsonReply(200, { url });
    }, (f) => f.getInstallationSettingsUrl("12345"));
    assertEquals(actual, url);
  }
  for (
    const body of [
      {},
      { url: null },
      { url: "javascript:alert(1)" },
      { url: "http://github.com/settings/installations/12345" },
      { url: "https://user:pw@github.com/settings/installations/12345" },
      { url: "https://github.com/settings/installations/12345?next=https://evil.test" },
      { url: "https://github.com/settings/installations/99999" },
      { url: "https://github.com/acme" },
    ]
  ) {
    await assertRejects(() =>
      overWire(() => jsonReply(200, body), (f) => f.getInstallationSettingsUrl("12345"))
    );
  }
  for (const status of [401, 404, 501, 502]) {
    await assertRejects(() =>
      overWire(
        () => jsonReply(status, { error: "unavailable" }),
        (f) => f.getInstallationSettingsUrl("12345"),
      )
    );
  }
});

test("installation wire keeps a valid settings URL and drops one that is not", async () => {
  const listing = (settingsUrl: unknown) =>
    overWire(
      () => jsonReply(200, { accountLogin: "acme", settingsUrl, repos: [] }),
      (f) => f.describeInstallation("12345"),
    );
  const url = "https://github.com/organizations/acme/settings/installations/12345";
  assertEquals(await listing(url), { accountLogin: "acme", settingsUrl: url, repos: [] });
  for (const bad of [undefined, null, "javascript:alert(1)", "https://github.com/acme"]) {
    assertEquals((await listing(bad)).settingsUrl, null);
  }
});

test("providers carries the GitHub mode, and refuses one that disagrees with the list", async () => {
  assertEquals(
    await overWire(
      () =>
        jsonReply(200, {
          providers: ["github"],
          github: { mode: "user", login: "ada" },
          gitlab: null,
          radicle: null,
        }),
      (f) => f.providers(),
    ),
    { providers: ["github"], github: { mode: "user", login: "ada" }, gitlab: null, radicle: null },
  );
  assertEquals(
    await overWire(
      () =>
        jsonReply(200, {
          providers: ["radicle"],
          github: null,
          gitlab: null,
          radicle: { mode: "user" },
        }),
      (f) => f.providers(),
    ),
    { providers: ["radicle"], github: null, gitlab: null, radicle: { mode: "user" } },
  );
  for (
    const body of [
      { providers: ["github"] },
      { providers: ["github"], github: null },
      { providers: ["radicle"], github: { mode: "app" } },
      { providers: ["github"], github: { mode: "user" } },
      { providers: ["github"], github: { mode: "user", login: " " } },
      { providers: ["github"], github: { mode: "both" } },
      // Radicle's mode is part of the answer too, and drift either way is refused.
      { providers: ["radicle"], github: null },
      { providers: ["radicle"], github: null, gitlab: null, radicle: null },
      { providers: ["github"], github: { mode: "app" }, gitlab: null, radicle: { mode: "user" } },
      { providers: ["radicle"], github: null, gitlab: null, radicle: { mode: "admin" } },
    ]
  ) {
    await assertRejects(
      () => overWire(() => jsonReply(200, body), (f) => f.providers()),
      Error,
      undefined,
      JSON.stringify(body),
    );
  }
});

test("listGithubRepos reads the forge's listing, and throws on anything else", async () => {
  let path = "";
  const repos = await overWire((req) => {
    path = new URL(req.url).pathname;
    return jsonReply(200, { repos: [{ ...PAYMENTS, admin: true, extra: "dropped" }] });
  }, (f) => f.listGithubRepos());
  assertEquals(path, "/v1/service/github/repos");
  assertEquals(repos, [{ ...PAYMENTS, admin: true }]);
  await assertRejects(() =>
    overWire(() => jsonReply(501, { error: "not user mode" }), (f) => f.listGithubRepos())
  );
  await assertRejects(() =>
    overWire(
      () => jsonReply(200, { repos: [{ ...PAYMENTS, admin: true, defaultBranch: "bad..ref" }] }),
      (f) => f.listGithubRepos(),
    )
  );
  // GitHub's admin bit is part of the answer: missing, or not a boolean, refuses the listing.
  for (const admin of [undefined, "yes", null]) {
    await assertRejects(
      () =>
        overWire(
          () => jsonReply(200, { repos: [{ ...PAYMENTS, admin }] }),
          (f) => f.listGithubRepos(),
        ),
      Error,
      undefined,
      String(admin),
    );
  }
});

test("describeGithubRepo maps 200 and the forge's terminal 404, and throws on the rest", async () => {
  let asked: unknown = null;
  const described = await overWire(async (req) => {
    asked = { path: new URL(req.url).pathname, body: await req.json() };
    return jsonReply(200, PAYMENTS);
  }, (f) => f.describeGithubRepo("acme/payments"));
  assertEquals(asked, {
    path: "/v1/service/github/describe",
    body: { repoRef: "acme/payments" },
  });
  assertEquals(described, PAYMENTS);
  assertEquals(
    await overWire(
      () => jsonReply(404, { error: "no such repo", terminal: true }),
      (f) => f.describeGithubRepo("acme/x"),
    ),
    null,
  );
  // A 404 the forge did not call terminal is not GitHub's word — a proxy's, say.
  await assertRejects(() =>
    overWire(() => jsonReply(404, {}), (f) => f.describeGithubRepo("acme/x"))
  );
  await assertRejects(() =>
    overWire(
      () => jsonReply(502, { error: "github down", terminal: false }),
      (f) => f.describeGithubRepo("acme/x"),
    )
  );
  await assertRejects(() =>
    overWire(() => jsonReply(501, { error: "no" }), (f) => f.describeGithubRepo("acme/x"))
  );
});
