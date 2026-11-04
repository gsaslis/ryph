import { test } from "bun:test";

// GitLab's connect flow on the control plane's side: the project picker, connecting a project
// (bot mode: from the bot's own reach, with the caller's Maintainer access read live; user mode:
// the person's project, and repos:manage-all), the webhook a Maintainer pastes — at connect and
// again later — and the fork-push switch. No GitLab anywhere: the forge is the noop stand-in and
// the connect surface a scripted double.

import { capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler, type ToolAccess } from "../src/http/app.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { gitlabModeSource } from "../src/adapters/forge/gitlab_mode.ts";
import { forgeUserModeDirectory } from "../src/adapters/identity_directory/forge_user_mode.ts";
import type {
  Forge,
  ForgePermission,
  GitlabConnect,
  GitlabMode,
  GitlabProjectListing,
} from "../src/ports/forge.ts";
import type { ConnectedRepo } from "../src/core/types.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";

/** ada's GitLab account as her link names it — what every permission is asked about. */
const ADA = "31@https://gitlab.example";
const BOT: GitlabMode = {
  mode: "bot",
  login: "ryph-bot",
  accountId: "1@https://gitlab.example",
  url: "https://gitlab.example",
  signIn: true,
};
const PERSON: GitlabMode = {
  mode: "user",
  login: "ada",
  accountId: "1@https://gitlab.example",
  url: "https://gitlab.example",
  signIn: false,
};
const TOKEN = "a".repeat(64);

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

/** GitLab's own spelling of a nested path, and its clone URL. */
const PAYMENTS: GitlabProjectListing = {
  id: "42",
  pathWithNamespace: "Acme/Platform/Payments",
  url: "https://gitlab.example/Acme/Platform/Payments.git",
  webUrl: "https://gitlab.example/Acme/Platform/Payments",
  defaultBranch: "trunk",
  visibility: "internal",
  admin: false,
};
const EMPTY: GitlabProjectListing = {
  ...PAYMENTS,
  id: "43",
  pathWithNamespace: "acme/empty",
  url: "https://gitlab.example/acme/empty.git",
  webUrl: "https://gitlab.example/acme/empty",
  defaultBranch: null,
};

function buildApp(
  opts: {
    gitlab?: GitlabMode | null;
    role?: Role;
    permission?: ForgePermission;
    projects?: GitlabProjectListing[];
    described?: (project: string) => GitlabProjectListing | null;
    hookToken?: () => Promise<string>;
    appUrl?: string | null;
    /** Connect methods replaced outright. */
    connect?: Partial<GitlabConnect>;
  } = {},
) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const gitlab = opts.gitlab === undefined ? BOT : opts.gitlab;
  const noop = noopForge(silentDiagnostics(), {
    providers: gitlab === null ? ["github"] : ["github", "gitlab"],
    ...(gitlab === null ? {} : { gitlab }),
  });
  /** Every permission question, as the forge was asked it. */
  const asked: Array<
    { provider: string; repoRef: string; forgeId?: string; subject: string | null; at: string }
  > = [];
  const forge: Forge = {
    ...noop,
    checkPermission(repo, identity, atLeast) {
      asked.push({
        provider: repo.provider,
        repoRef: repo.repoRef,
        ...(repo.forgeId === undefined ? {} : { forgeId: repo.forgeId }),
        subject: identity.subject,
        at: atLeast,
      });
      return Promise.resolve(opts.permission ?? "allowed");
    },
  };
  const projects = opts.projects ?? [PAYMENTS, EMPTY];
  const calls: string[] = [];
  const gitlabConnect: GitlabConnect = {
    listGitlabProjects() {
      calls.push("list");
      return Promise.resolve(structuredClone(projects));
    },
    describeGitlabProject(project) {
      calls.push(`describe ${project}`);
      return Promise.resolve(
        opts.described
          ? opts.described(project)
          : projects.find((p) =>
            p.id === project || p.pathWithNamespace.toLowerCase() === project.toLowerCase()
          ) ?? null,
      );
    },
    gitlabHookToken(projectId, generation) {
      calls.push(`token ${projectId}@${generation}`);
      return opts.hookToken ? opts.hookToken() : Promise.resolve(TOKEN);
    },
    gitlabLogin(accountId) {
      calls.push(`login ${accountId}`);
      return Promise.resolve(null);
    },
    ...opts.connect,
  };
  const gitlabMode = gitlabModeSource({ forge, diag: silentDiagnostics() });
  let role: Role = opts.role ?? "member";
  const deps = {
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate:
      (() => Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate,
    toolAccess,
    forgeToken: "forge-service-token",
    forge,
    githubConnect: noop,
    githubUserConnect: noop,
    gitlabConnect,
    radicleConnect: noop,
    localConnect: noop,
    identityDirectory: forgeUserModeDirectory(identities.directory, {
      github: null,
      gitlab: gitlabMode,
    }),
    now: clock.now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: { url: "http://gateway.test:7412", keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      appUrl: opts.appUrl === undefined ? "https://ryph.test" : opts.appUrl,
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
    store,
    asked,
    calls,
    identities,
    as: (next: Role) => (role = next),
  };
}

type Handler = (req: Request) => Promise<Response>;
const send = (h: Handler, method: string, path: string, body?: unknown) =>
  h(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const connect = (app: ReturnType<typeof buildApp>, repoRef = "acme/platform/payments") =>
  send(app.handler, "POST", "/v1/connected-repos", { provider: "gitlab", repoRef });

const WEBHOOK = {
  url: "https://ryph.test/v1/hooks/gitlab?project=42&generation=1",
  token: TOKEN,
  projectId: "42",
  generation: 1,
  triggers: ["push_events", "note_events", "merge_requests_events"],
  pushBranchFilter: "trunk",
  sslVerification: true,
};

// ---- the picker ------------------------------------------------------------------------------

test("the providers answer names GitLab's mode, and the picker lists the token's reach", async () => {
  const app = buildApp();
  const providers = await (await send(app.handler, "GET", "/v1/forge-providers")).json();
  assertEquals(providers.gitlab, BOT);

  app.identities.link("u-1", ADA, "gitlab");
  await connect(app);
  const res = await send(app.handler, "GET", "/v1/gitlab/projects");
  assertEquals(res.status, 200);
  const { projects } = await res.json();
  // The connected one is matched case-blind, as GitLab matches paths.
  const [payments, empty] = projects;
  assertEquals(payments.pathWithNamespace, "Acme/Platform/Payments");
  assertEquals(typeof payments.connectedRepoId, "string");
  assertEquals(empty.connectedRepoId, null);
});

test("the picker says why it cannot list: no GitLab here, or a forge that did not answer", async () => {
  assertEquals(
    (await send(buildApp({ gitlab: null }).handler, "GET", "/v1/gitlab/projects")).status,
    503,
  );
  // A listing that throws is the forge's failure to answer, never an empty reach.
  const down = buildApp({ connect: { listGitlabProjects: () => Promise.reject(new Error("x")) } });
  assertEquals((await send(down.handler, "GET", "/v1/gitlab/projects")).status, 502);
});

// ---- connecting, bot mode --------------------------------------------------------------------

test("bot mode: a project connects from the bot's own reach, Maintainer read live, with its webhook", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const res = await connect(app);
  const body = await res.json();
  assertEquals(res.status, 201, JSON.stringify(body));
  const repo: ConnectedRepo = body.repo;
  // GitLab's own spelling and coordinates, no tenant.
  assertEquals(repo.provider, "gitlab");
  assertEquals(repo.repoRef, "Acme/Platform/Payments");
  assertEquals(repo.url, PAYMENTS.url);
  assertEquals(repo.defaultBranch, "trunk");
  assertEquals(repo.installationId, null);
  assertEquals(repo.allowForkPushes, false);
  // The caller's linked username, asked about at admin — Maintainer on GitLab — of the project
  // by the id GitLab gave for the path, never by the path.
  assertEquals(app.asked, [{
    provider: "gitlab",
    repoRef: "Acme/Platform/Payments",
    forgeId: "42@https://gitlab.example",
    subject: ADA,
    at: "admin",
  }]);
  // Described for its id, then found by it in the bot's own listing: a project merely visible
  // to the bot is not its reach.
  assertEquals(app.calls, ["describe acme/platform/payments", "list", "token 42@1"]);
  // The project's id is recorded beside the row: what its events are matched on.
  assertEquals((await app.store.getGitlabProject(repo.id))?.projectId, "42");
  assertEquals(body.webhook, WEBHOOK);
  assertEquals((await app.store.listConnectedRepos()).length, 1);

  // Once is enough, case-blind.
  const again = await connect(app, "ACME/platform/payments");
  assertEquals(again.status, 409);
});

test("bot mode: refusals — no link, no Maintainer, not the bot's, moved, empty", async () => {
  const unlinked = buildApp();
  const noLink = await connect(unlinked);
  assertEquals(noLink.status, 403);
  assertStringIncludes((await noLink.json()).error, "link your GitLab account");
  // One read for the project's id, and not the listing's walk.
  assertEquals(unlinked.calls, ["describe acme/platform/payments"]);

  const denied = buildApp({ permission: "denied" });
  denied.identities.link("u-1", ADA, "gitlab");
  const notMaintainer = await connect(denied);
  assertEquals(notMaintainer.status, 403);
  assertStringIncludes(
    (await notMaintainer.json()).error,
    "your linked GitLab account does not have admin access",
  );

  const unknown = buildApp({ permission: "unknown" });
  unknown.identities.link("u-1", ADA, "gitlab");
  assertEquals((await connect(unknown)).status, 403);

  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const notMember = await connect(app, "acme/elsewhere");
  assertEquals(notMember.status, 404);
  assertStringIncludes((await notMember.json()).error, "@ryph-bot is not a member");
  // Visible to the bot (public, say) but not in its reach.
  const visible = buildApp({ described: () => ({ ...PAYMENTS, id: "99" }) });
  visible.identities.link("u-1", ADA, "gitlab");
  const outside = await connect(visible);
  assertEquals(outside.status, 404);
  assertStringIncludes((await outside.json()).error, "@ryph-bot is not a member");

  const empty = await connect(app, "acme/empty");
  assertEquals(empty.status, 422);
  assertStringIncludes((await empty.json()).error, "is empty");
  assertEquals(await app.store.listConnectedRepos(), []);
});

test("bot mode: a webhook token the forge does not give writes no row", async () => {
  const app = buildApp({ hookToken: () => Promise.reject(new Error("down")) });
  app.identities.link("u-1", ADA, "gitlab");
  assertEquals((await connect(app)).status, 502);
  assertEquals(await app.store.listConnectedRepos(), []);
});

test("bot mode: without RYPH_APP_URL the webhook has no URL to name, and still its token", async () => {
  const app = buildApp({ appUrl: null });
  app.identities.link("u-1", ADA, "gitlab");
  const body = await (await connect(app)).json();
  assertEquals(body.webhook, { ...WEBHOOK, url: null });
});

test("a forge running no GitLab, or not saying, refuses the connect before asking anything", async () => {
  const none = buildApp({ gitlab: null });
  none.identities.link("u-1", ADA, "gitlab");
  const res = await connect(none);
  assertEquals(res.status, 503);
  assertEquals(none.asked, []);
});

// ---- connecting, user mode -------------------------------------------------------------------

test("user mode: connecting needs repos:manage-all and the token's Maintainer, and takes no webhook", async () => {
  const member = buildApp({ gitlab: PERSON });
  const refused = await connect(member);
  assertEquals(refused.status, 403);
  assertStringIncludes((await refused.json()).error, "acts on GitLab as one account");
  assertEquals(member.asked, []);

  const app = buildApp({ gitlab: PERSON, role: "operator" });
  const res = await connect(app);
  const body = await res.json();
  assertEquals(res.status, 201, JSON.stringify(body));
  assertEquals(body.webhook, null);
  assertEquals(body.repo.repoRef, "Acme/Platform/Payments");
  // The person reaches everything they see: the project is described, not listed; and the
  // live check asked about the TOKEN's account id, whoever called.
  assertEquals(app.calls, ["describe acme/platform/payments"]);
  assertEquals(app.asked, [{
    provider: "gitlab",
    repoRef: "Acme/Platform/Payments",
    forgeId: "42@https://gitlab.example",
    subject: "1@https://gitlab.example",
    at: "admin",
  }]);
});

test("user mode: a project GitLab answers under another path is refused, not stored", async () => {
  const app = buildApp({
    gitlab: PERSON,
    role: "operator",
    described: () => ({ ...PAYMENTS, pathWithNamespace: "acme/billing" }),
  });
  const res = await connect(app);
  assertEquals(res.status, 422);
  assertStringIncludes((await res.json()).error, "acme/billing");
  const none = buildApp({ gitlab: PERSON, role: "operator", described: () => null });
  assertEquals((await connect(none)).status, 404);
});

// ---- the webhook again -----------------------------------------------------------------------

test("the webhook is shown again to a Maintainer only, read live, and never in user mode", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  const path = `/v1/connected-repos/${repo.id}/gitlab-hook`;
  const res = await send(app.handler, "GET", path);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    webhook: WEBHOOK,
    lastDeliveryAt: null,
    lastMergeRequestDeliveryAt: null,
    droppedComments: 0,
    droppedOtherEvents: 0,
    lastDroppedAt: null,
  });
  // Read by the project's id, never the path it was connected under — and the Maintainer asked
  // about is of that id too.
  assertEquals(app.calls.at(-2), "describe 42");
  assertEquals(app.asked.at(-1)?.forgeId, "42@https://gitlab.example");

  // Not a Maintainer any more: no token.
  const denied = buildApp({ permission: "denied" });
  denied.identities.link("u-1", ADA, "gitlab");
  const row: ConnectedRepo = { ...repo, id: "cr-denied" };
  await denied.store.createConnectedRepo(row);
  await denied.store.createGitlabProject(row.id, "42", "https://gitlab.example", row.createdAt);
  assertEquals(
    (await send(denied.handler, "GET", "/v1/connected-repos/cr-denied/gitlab-hook")).status,
    403,
  );
  assertEquals(denied.calls, []);

  const person = buildApp({ gitlab: PERSON, role: "operator" });
  await person.store.createConnectedRepo(row);
  assertEquals(
    (await send(person.handler, "GET", "/v1/connected-repos/cr-denied/gitlab-hook")).status,
    501,
  );
  assertEquals(
    (await send(app.handler, "GET", "/v1/connected-repos/nope/gitlab-hook")).status,
    404,
  );
});

test("the webhook is read and rotated with repos:manage only, Maintainer or not", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  const hook = `/v1/connected-repos/${repo.id}/gitlab-hook`;
  // A viewer (or a token holding repos:read alone) who is a Maintainer on GitLab still neither
  // reads the token, which makes deliveries count, nor rotates it, which silences the hook.
  app.as("viewer");
  const before = app.calls.length;
  const asked = app.asked.length;
  assertEquals((await send(app.handler, "GET", hook)).status, 403);
  assertEquals((await send(app.handler, "POST", `${hook}/rotate`)).status, 403);
  assertEquals(app.calls.length, before);
  assertEquals(app.asked.length, asked);
  assertEquals((await app.store.getGitlabProject(repo.id))?.hookGeneration, 1);
  app.as("member");
  assertEquals((await send(app.handler, "GET", hook)).status, 200);
});

/** What the forge asks before it reads GitLab for a verified delivery (`heard`: the consumer's
 * question, which records the arrival), or before it stores one (none: the door's). Answers
 * the admission alone. */
const admit = (
  app: ReturnType<typeof buildApp>,
  projectId: string,
  generation: string,
  heard: "merge_request" | "other" | "door" = "other",
) =>
  app.handler(
    new Request("http://orchestrator.test/v1/forge/gitlab/hooks/admit", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer forge-service-token" },
      body: JSON.stringify({ projectId, generation, heard: heard === "door" ? undefined : heard }),
    }),
  ).then((r) => r.json()).then((body) => ({ admission: body.admission }));

test("rotating the webhook token: a Maintainer's act, a new generation, and the old one refused", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  const hook = `/v1/connected-repos/${repo.id}/gitlab-hook`;

  // The door's question records nothing: it is asked before anything is stored.
  assertEquals(await admit(app, "42", "1", "door"), { admission: "current" });
  const unseen = await (await send(app.handler, "GET", hook)).json();
  assertEquals(unseen.lastDeliveryAt, null);
  // Generation 1 is admitted, and its arrival recorded for the page — a push or a note says
  // nothing about merge request events, which a merge request's delivery then does.
  assertEquals(await admit(app, "42", "1"), { admission: "current" });
  const seen = await (await send(app.handler, "GET", hook)).json();
  assertEquals(typeof seen.lastDeliveryAt, "string");
  assertEquals(seen.lastMergeRequestDeliveryAt, null);
  assertEquals(await admit(app, "42", "1", "merge_request"), { admission: "current" });
  const merged = await (await send(app.handler, "GET", hook)).json();
  assertEquals(typeof merged.lastMergeRequestDeliveryAt, "string");
  // Another project, or a generation nobody minted, is not.
  assertEquals(await admit(app, "43", "1"), { admission: "unconnected" });
  assertEquals(await admit(app, "42", "01"), { admission: "stale" });

  // A Maintainer no longer: no rotation, and nothing moves.
  const demoted = buildApp({ permission: "denied" });
  demoted.identities.link("u-1", ADA, "gitlab");
  await demoted.store.createConnectedRepo(repo);
  await demoted.store.createGitlabProject(repo.id, "42", "https://gitlab.example", "t");
  assertEquals((await send(demoted.handler, "POST", `${hook}/rotate`)).status, 403);
  assertEquals((await demoted.store.getGitlabProject(repo.id))?.hookGeneration, 1);

  const rotated = await send(app.handler, "POST", `${hook}/rotate`);
  assertEquals(rotated.status, 200);
  const body = await rotated.json();
  assertEquals(body.webhook.generation, 2);
  assertEquals(body.webhook.url, "https://ryph.test/v1/hooks/gitlab?project=42&generation=2");
  assertEquals(body.lastDeliveryAt, null, "the last delivery was the old token's");
  assertEquals(app.calls.at(-1), "token 42@2");
  // The old token is refused from the next delivery on; the new one is heard.
  assertEquals(await admit(app, "42", "1"), { admission: "stale" });
  assertEquals(await admit(app, "42", "2"), { admission: "current" });
});

/** The forge's report of deliveries its door dropped over a project's budget. */
const dropped = (
  app: ReturnType<typeof buildApp>,
  projectId: string,
  generation: string,
  count: number,
  lane: "comments" | "other" = "other",
) =>
  app.handler(
    new Request("http://orchestrator.test/v1/forge/gitlab/hooks/dropped", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer forge-service-token" },
      body: JSON.stringify({ projectId, generation, lane, count }),
    }),
  ).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("deliveries dropped over budget are counted for the page by budget, at the current token only", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  const hook = `/v1/connected-repos/${repo.id}/gitlab-hook`;

  assertEquals(await dropped(app, "42", "1", 3), { status: 200, counted: true });
  assertEquals(await dropped(app, "42", "1", 2), { status: 200, counted: true });
  assertEquals(await dropped(app, "42", "1", 1, "comments"), { status: 200, counted: true });
  // A budget the door does not have is no report.
  assertEquals((await dropped(app, "42", "1", 1, "pushes" as never)).status, 400);
  // Another project's, or a generation that is not the current one, count for nothing here.
  assertEquals(await dropped(app, "43", "1", 9), { status: 200, counted: false });
  assertEquals(await dropped(app, "42", "7", 9), { status: 200, counted: false });
  const page = await (await send(app.handler, "GET", hook)).json();
  assertEquals([page.droppedComments, page.droppedOtherEvents], [1, 5]);
  assertEquals(typeof page.lastDroppedAt, "string");

  // Only the forge may say so.
  const anonymous = await app.handler(
    new Request("http://orchestrator.test/v1/forge/gitlab/hooks/dropped", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "42", generation: "1", lane: "other", count: 1 }),
    }),
  );
  assertEquals(anonymous.status, 401);

  // A rotation starts the count again: those were the old token's.
  const rotated = await (await send(app.handler, "POST", `${hook}/rotate`)).json();
  assertEquals([rotated.droppedComments, rotated.droppedOtherEvents], [0, 0]);
  assertEquals(rotated.lastDroppedAt, null);
});

test("a project connected again gets a token past every earlier one, and is matched by id", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  assertEquals(
    (await send(app.handler, "POST", `/v1/connected-repos/${repo.id}/archive`)).status,
    200,
  );
  assertEquals(await admit(app, "42", "1"), { admission: "unconnected" });
  const again = await (await connect(app)).json();
  assertEquals(again.webhook.generation, 2, "the archived connection's token stays dead");
  assertEquals(await admit(app, "42", "1"), { admission: "stale" });
  assertEquals(await admit(app, "42", "2"), { admission: "current" });

  // Moved on GitLab: the page reads it by id and the row follows the new path.
  const moved = buildApp({
    described: (p) => p === "42" ? { ...PAYMENTS, pathWithNamespace: "acme/billing" } : null,
  });
  moved.identities.link("u-1", ADA, "gitlab");
  await moved.store.createConnectedRepo(again.repo);
  await moved.store.createGitlabProject(again.repo.id, "42", "https://gitlab.example", "t");
  const res = await send(moved.handler, "GET", `/v1/connected-repos/${again.repo.id}/gitlab-hook`);
  assertEquals(res.status, 200);
  assertEquals((await moved.store.getConnectedRepo(again.repo.id))?.repoRef, "acme/billing");
});

test("a project connected on another GitLab instance is no connection here: the id connects anew, above its generations, and the old row's webhook is never shown", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  // Project 42 on the instance RYPH_GITLAB_URL named before — a stranger's project here.
  const { repo: first } = await (await connect(app)).json();
  const old: ConnectedRepo = { ...first, id: "cr-old" };
  await app.store.createConnectedRepo(old);
  const held = await app.store.createGitlabProject(
    old.id,
    "42",
    "https://gitlab.old.example",
    old.createdAt,
  );
  // Its id names the instance it was connected on; the forge refuses that one here.
  assertEquals(
    (await app.store.getConnectedRepo(old.id))?.forgeId,
    "42@https://gitlab.old.example",
  );
  const before = app.calls.length;
  const hook = await send(app.handler, "GET", `/v1/connected-repos/${old.id}/gitlab-hook`);
  assertEquals(hook.status, 409);
  assertStringIncludes((await hook.json()).error, "https://gitlab.old.example");
  assertEquals(app.calls.slice(before), [], "nothing is read or derived for it");
  // The listing does not call this instance's project 42 connected through it.
  const listed = await (await send(app.handler, "GET", "/v1/gitlab/projects")).json();
  assertEquals(
    listed.projects.find((p: { id: string }) => p.id === "42")?.connectedRepoId,
    first.id,
  );
  assert(held.hookGeneration > 1, "generations count across instances");
});

test("a row stranded on another GitLab instance, or with no GitLab at all, is cleared by an admin without asking", async () => {
  // The forge refuses every question about such a row (its id names a project on an instance it
  // does not run), so the live admin check could never pass, not even an owner's.
  const row: ConnectedRepo = {
    id: "cr-old",
    provider: "gitlab",
    installationId: null,
    repoRef: "acme/platform/payments",
    url: "https://gitlab.old.example/acme/platform/payments.git",
    defaultBranch: "trunk",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  for (const gitlab of [BOT, PERSON, null]) {
    const app = buildApp({ gitlab, permission: "denied" });
    await app.store.createConnectedRepo(row);
    await app.store.createGitlabProject(row.id, "42", "https://gitlab.old.example", row.createdAt);
    app.identities.link("u-1", ADA, "gitlab");
    // A member still meets the check, and its refusal.
    const denied = await send(app.handler, "POST", `/v1/connected-repos/${row.id}/archive`);
    assertEquals(denied.status, 403, `${gitlab?.mode}: ${await denied.clone().text()}`);
    app.as("operator");
    app.asked.length = 0;
    const cleared = await send(app.handler, "POST", `/v1/connected-repos/${row.id}/archive`);
    assertEquals(cleared.status, 200, `${gitlab?.mode}: ${await cleared.clone().text()}`);
    assert((await app.store.getConnectedRepo(row.id))?.archivedAt !== null);
    assertEquals(app.asked, [], "the forge is not asked about it");
  }
  // A row on THIS instance is no leftover: an admin meets the live check like anyone.
  const app = buildApp({ permission: "denied", role: "operator" });
  app.identities.link("u-1", ADA, "gitlab");
  await app.store.createConnectedRepo(row);
  await app.store.createGitlabProject(row.id, "42", BOT.url, row.createdAt);
  assertEquals(
    (await send(app.handler, "POST", `/v1/connected-repos/${row.id}/archive`)).status,
    403,
  );
  assertEquals(app.asked.length, 1, "asked live");
});

test("the webhook route answers only for a GitLab project", async () => {
  const app = buildApp();
  const github: ConnectedRepo = {
    id: "cr-gh",
    provider: "github",
    installationId: "1",
    repoRef: "acme/app",
    url: "https://github.com/acme/app.git",
    defaultBranch: "main",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
  };
  await app.store.createConnectedRepo(github);
  assertEquals(
    (await send(app.handler, "GET", "/v1/connected-repos/cr-gh/gitlab-hook")).status,
    404,
  );
});

// ---- fork pushes -----------------------------------------------------------------------------

test("fork pushes: on for a bot's GitLab project, refused where GitLab is one person's token", async () => {
  const app = buildApp();
  app.identities.link("u-1", ADA, "gitlab");
  const { repo } = await (await connect(app)).json();
  const on = await send(app.handler, "PATCH", `/v1/connected-repos/${repo.id}`, {
    allowForkPushes: true,
  });
  assertEquals(on.status, 200);
  assertEquals((await app.store.getConnectedRepo(repo.id))?.allowForkPushes, true);

  const person = buildApp({ gitlab: PERSON, role: "operator" });
  const { repo: theirs } = await (await connect(person)).json();
  const refused = await send(person.handler, "PATCH", `/v1/connected-repos/${theirs.id}`, {
    allowForkPushes: true,
  });
  assertEquals(refused.status, 400);
  assertStringIncludes((await refused.json()).error, "GitLab acting as a bot");
  // Off is always allowed: nothing is promised.
  const off = await send(person.handler, "PATCH", `/v1/connected-repos/${theirs.id}`, {
    allowForkPushes: false,
  });
  assertEquals(off.status, 200);
});
