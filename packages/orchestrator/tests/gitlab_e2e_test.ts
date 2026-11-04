import { test } from "bun:test";

// GitLab end to end across the control plane: the orchestrator's real HTTP surface and store,
// its real forge client (adapters/forge/http.ts) dialing the REAL forge (`startForge` from
// @ryph/forge), and the forge acting on @ryph/fake-gitlab — real git over HTTP, real webhooks,
// real OAuth. The forge dials back into the orchestrator for run keys and to deliver events, so
// both listen. What is not real: the provisioner (a run is played by this test, cloning through
// the gateway and handing in a bundle as the runner does) and the clock of the sweeps (called).
//
// Reaching into `../../fake-gitlab` and `../../auth/tests` is deliberate: a cross-package test.

import { capsClaimOf, setup as setupAuth } from "@ryph/auth";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { openDbCluster } from "@ryph/db";
import { scopeWebhooksDb } from "../../webhooks/src/mod.ts";
import { type RunningForge, startForge } from "@ryph/forge";
import { serve } from "@ryph/service";
import { makeGit } from "../../forge/src/helpers/git_exec.ts";
import { type FakeGitlab, s256, startFakeGitlab } from "../../fake-gitlab/src/mod.ts";
import { memoryAuthStore } from "../../auth/tests/memory_store.ts";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { httpForge } from "../src/adapters/forge/http.ts";
import { forgeRepoRef } from "../src/core/forge_repo.ts";
import { gitlabModeSource } from "../src/adapters/forge/gitlab_mode.ts";
import { githubModeSource } from "../src/adapters/forge/github_mode.ts";
import { forgeUserModeDirectory } from "../src/adapters/identity_directory/forge_user_mode.ts";
import { authStoreIdentityDirectory } from "../src/adapters/identity_directory/auth_store.ts";
import { gitlabAccountId } from "@ryph/forge/gitlab-account";
import { forgeIdentityProvider } from "../src/adapters/identity_provider/forge.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { sweepPatches } from "../src/core/reaper.ts";
import { DEFAULT_PATCH_SUBMIT_CONFIG } from "../src/core/patch_lifecycle.ts";
import { DEFAULT_MERGE_POLL_CONFIG } from "../src/core/merge_poll.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import type { Role } from "@ryph/auth";
import { makeTestDb } from "./db.ts";
import { bootstrapEnv } from "./bootstrap_helpers.ts";
import {
  fakeClock,
  fakeIdentityDirectory,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const FORGE_TOKEN = "forge-service-token";
const MASTER = "gitlab-webhook-master-secret";
const CLIENT = { clientId: "ryph-app", clientSecret: "ryph-app-secret" };
const PROJECT = "acme/widgets";
const REDIRECT = "https://ryph.test/gitlab/callback";

const USER = {
  kind: "user",
  userId: "u-grace",
  email: "grace@example.com",
  name: "Grace",
} as const;

type Handler = (req: Request) => Promise<Response>;

interface World {
  gitlab: FakeGitlab;
  forge: RunningForge;
  forgeOrigin: string;
  handler: Handler;
  /** Every ForgeEvent the forge delivered, and how the orchestrator answered it. */
  events: Array<{ kind: string; status: number; answer: string }>;
  store: ReturnType<typeof drizzleTaskStore>;
  launches: ReturnType<typeof fakeProvisioner>["launches"];
  identities: ReturnType<typeof fakeIdentityDirectory>;
  authStore: ReturnType<typeof memoryAuthStore>;
  gitlabMode: ReturnType<typeof gitlabModeSource>;
  clock: ReturnType<typeof fakeClock>;
  /** The submit sweep's tick (which also runs the merge poll), as the reaper calls it. */
  sweep(): Promise<void>;
  as(role: Role): void;
  root: string;
  dispose(): Promise<void>;
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * GitLab with `acme/widgets` (main protected), the bot a Developer on it, grace a Maintainer of
 * `acme`, ada a Developer; a forge on it in `mode` (bot: webhooks + the OAuth application + the
 * `acme` group gate; user: as grace); the orchestrator in front, over a real database.
 */
async function world(mode: "bot" | "user" = "bot"): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "ryph-gitlab-e2e-"));
  const gitlab = await startFakeGitlab({ basePath: "/gitlab" });
  gitlab.addUser({ username: "ryph-bot", name: "ryph", bot: true });
  gitlab.addUser({ username: "grace", name: "Grace Hopper", email: "grace@example.com" });
  gitlab.addUser({ username: "ada", name: "Ada Lovelace", email: "ada@example.com" });
  gitlab.addUser({ username: "mallory", name: "Mallory", email: "mallory@example.com" });
  gitlab.addGroup("acme");
  await gitlab.addProject(PROJECT, {
    files: { "README.md": "# widgets\n", "src/widget.ts": "export const two = 2;\n" },
  });
  gitlab.addMember("acme", "grace", "maintainer");
  gitlab.addMember(PROJECT, "ryph-bot", "developer");
  gitlab.addMember(PROJECT, "ada", "developer");
  gitlab.oauthApp({ ...CLIENT, redirectUris: [REDIRECT] });

  // The orchestrator listens first, behind a handler bound once the forge's address is known:
  // each dials the other.
  let inner: Handler = () => Promise.resolve(new Response("booting", { status: 503 }));
  const orchestratorServer = await serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => inner(req),
  );
  const orchestratorUrl = `http://127.0.0.1:${orchestratorServer.addr.port}`;

  const cluster = await openDbCluster("pglite:memory://");
  await cluster.migrate(
    new URL("../../automations/drizzle", import.meta.url).pathname,
    "__drizzle_migrations_automations",
  );
  const vars: Record<string, string> = mode === "bot"
    ? {
      RYPH_GITLAB_URL: gitlab.url,
      RYPH_GITLAB_TOKEN: gitlab.token("ryph-bot"),
      RYPH_GITLAB_WEBHOOK_SECRET: MASTER,
      RYPH_GITLAB_CLIENT_ID: CLIENT.clientId,
      RYPH_GITLAB_CLIENT_SECRET: CLIENT.clientSecret,
      RYPH_GITLAB_GROUP: "acme",
    }
    : {
      RYPH_GITLAB_URL: gitlab.url,
      RYPH_GITLAB_MODE: "user",
      RYPH_GITLAB_TOKEN: gitlab.token("grace"),
    };
  const forge = await withEnv(vars, () =>
    startForge({
      port: 0,
      orchestratorUrl,
      forgeToken: FORGE_TOKEN,
      dataDir: join(root, "forge"),
      ...(mode === "bot" ? { webhooksDb: scopeWebhooksDb(cluster) } : {}),
      localRoot: null,
      radicle: null,
    }));
  const forgeOrigin = `http://127.0.0.1:${forge.server.addr.port}`;

  const diag = silentDiagnostics();
  const db = await makeTestDb();
  const store = drizzleTaskStore(db);
  const clock = fakeClock();
  const { provisioner, launches } = fakeProvisioner();
  const identities = fakeIdentityDirectory();
  const client = httpForge({ baseUrl: forgeOrigin, forgeToken: FORGE_TOKEN, diag });
  const githubMode = githubModeSource({ forge: client, diag });
  const gitlabMode = gitlabModeSource({ forge: client, diag });
  const identityDirectory = forgeUserModeDirectory(identities.directory, {
    github: githubMode,
    gitlab: gitlabMode,
  });
  let role: Role = "member";
  const authenticate =
    (() => Promise.resolve({ ...USER, caps: capsClaimOf(role) })) as unknown as Authenticate;

  // @ryph/auth mounted as the control plane mounts it, signing people in through the forge.
  const authStore = memoryAuthStore();
  const auth = await setupAuth({
    store: authStore,
    now: () => new Date(),
    identityProvider: forgeIdentityProvider({
      githubConnect: client,
      store,
      githubMode,
      forgeConnect: client,
      gitlabMode,
    }),
    challengeProvider: null,
    mailer: null,
    appUrl: "https://ryph.test",
    onMailError() {},
    multiUser: true,
    proxySecret: null,
    requireProxySecret: false,
  });

  const handler = makeHandler({
    store,
    provisioner,
    runnerControl: fakeRunnerControl().control,
    diag,
    authenticate,
    forgeToken: FORGE_TOKEN,
    forge: client,
    githubMode,
    patchDiffs: client,
    githubConnect: client,
    githubUserConnect: client,
    gitlabConnect: client,
    radicleConnect: client,
    localConnect: client,
    identityDirectory,
    now: clock.now,
    config: {
      publicUrl: orchestratorUrl,
      ...imageConfig(),
      gitGateway: { url: forgeOrigin, keyTtlMs: 60 * 60 * 1000 },
      runHistoryUrl: null,
      // The webhook URL the connect answer shows is the app's; here the forge stands at it.
      appUrl: forgeOrigin,
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
  }, auth.routes);
  // Every ForgeEvent the forge delivers, with the orchestrator's answer to it.
  const events: World["events"] = [];
  inner = async (req) => {
    if (new URL(req.url).pathname !== "/v1/forge/events") return await handler(req);
    const body = await req.clone().json().catch(() => ({})) as { kind?: string };
    const res = await handler(req);
    events.push({ kind: body.kind ?? "", status: res.status, answer: await res.clone().text() });
    return res;
  };

  return {
    gitlab,
    forge,
    forgeOrigin,
    handler,
    events,
    store,
    launches,
    identities,
    authStore,
    gitlabMode,
    clock,
    root,
    as: (next) => void (role = next),
    sweep: () =>
      sweepPatches(
        {
          store,
          forge: client,
          identityDirectory,
          diag,
          appUrl: null,
          githubMode,
          mergePoll: { ...DEFAULT_MERGE_POLL_CONFIG, intervalMs: 0 },
          now: clock.now,
        },
        DEFAULT_PATCH_SUBMIT_CONFIG,
      ),
    async dispose() {
      forge.beginDrain();
      await forge.server.shutdown();
      await forge.close();
      await orchestratorServer.shutdown();
      await gitlab.shutdown();
      await db.close();
      await cluster.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const send = (w: World, method: string, path: string, body?: unknown, token = "t") =>
  w.handler(
    new Request(`http://orchestrator.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function until<T>(
  what: string,
  fn: () => T | Promise<T>,
  ms = 15_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The patch once its merge's settle has landed it. A sweep waits on the settles it starts only
 * a bounded time (core/merge_settle.ts), and the forge's containment read is a run of git
 * commands that can outlast it on a loaded machine; the settle then lands the patch on its own.
 */
function landedPatch(w: World, patchId: string) {
  return until("the patch landed", async () => {
    const patch = await w.store.getPatch(patchId);
    return patch?.landed ? patch : null;
  }, 45_000);
}

/**
 * What the runner does with a launch: boot (its credentials), clone each repo through the git
 * gateway at the ref its spec names, commit `files` on the run's `work` line, hand the bundle to
 * the gateway's intake, and report the branch as its result.
 */
async function playRun(
  w: World,
  launchEnv: Record<string, string>,
  connectedRepoId: string,
  files: Record<string, string>,
) {
  const env = await bootstrapEnv(w.handler, launchEnv);
  const runId = env.RYPH_RUN_ID!;
  const origin = env.RYPH_GIT_ORIGIN!;
  const git = makeGit({ debug() {} }, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${env.RYPH_GIT_TOKEN}`)}`,
  });
  const ws = join(w.root, `ws-${runId}`);
  await mkdir(ws, { recursive: true });
  await git(
    ws,
    "clone",
    "--quiet",
    "--",
    `${origin}/v1/git/${runId}/${connectedRepoId}/repo.git`,
    ".",
  );
  const base = await git(ws, "rev-parse", "HEAD");
  const branch = `ryph/ada/${runId}/work`;
  await git(ws, "checkout", "--quiet", "-b", branch);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(ws, path, ".."), { recursive: true });
    await writeFile(join(ws, path), content);
  }
  await git(ws, "add", ".");
  await git(
    ws,
    "-c",
    "user.name=Ada",
    "-c",
    "user.email=ada@example.com",
    "commit",
    "--quiet",
    "-m",
    "make two 22",
  );
  const headSha = await git(ws, "rev-parse", "HEAD");
  const bundlePath = join(w.root, `${runId}.bundle`);
  await git(ws, "bundle", "create", bundlePath, `${base}..refs/heads/${branch}`);
  const intake = await fetch(`${origin}/v1/patches/${connectedRepoId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RYPH_GIT_TOKEN}` },
    body: await readFile(bundlePath),
  });
  assertEquals(intake.status, 201, await intake.clone().text());
  const reported = await send(w, "POST", `/v1/runs/${runId}/result`, {
    status: "success",
    branches: [{
      connectedRepoId,
      path: "widgets",
      name: branch,
      line: "work",
      headSha,
      commits: [{ sha: headSha, subject: "make two 22" }],
      generation: 1,
      carries: [],
    }],
    summary: "Two is 22 now.",
  }, env.RYPH_RUN_TOKEN);
  assertEquals(reported.status, 200, await reported.clone().text());
  return { runId, headSha, base };
}

/** Connects acme/widgets as grace and, in bot mode, pastes the hook the answer describes into
 * GitLab exactly as given. */
async function connect(w: World) {
  const res = await send(w, "POST", "/v1/connected-repos", {
    provider: "gitlab",
    repoRef: PROJECT,
  });
  assertEquals(res.status, 201, await res.clone().text());
  const { repo, webhook } = await res.json();
  if (webhook !== null) {
    w.gitlab.addHook(PROJECT, {
      url: webhook.url,
      token: webhook.token,
      pushEvents: true,
      pushEventsBranchFilter: webhook.pushBranchFilter,
      noteEvents: true,
      mergeRequestsEvents: true,
    });
  }
  return { repo, webhook };
}

/** A GitLab user's account id on the fake's instance — the subject a link stands for, and what
 * every permission is asked about. */
function accountOf(w: World, username: string): string {
  return gitlabAccountId(w.gitlab.url, String(w.gitlab.world.userByUsername(username)!.id));
}

test("bot mode, the whole loop: connect, /ryph on an issue, run, merge request, merge, landed", async () => {
  const w = await world();
  try {
    // Connecting asks GitLab, live, whether grace maintains the project. Her identity is linked
    // with GitLab's id for her account, which a /ryph note's author is resolved by.
    w.identities.link(
      USER.userId,
      accountOf(w, "grace"),
      "gitlab",
      String(w.gitlab.world.userByUsername("grace")!.id),
    );
    const { repo, webhook } = await connect(w);
    assertEquals(repo.provider, "gitlab");
    assertEquals(repo.repoRef, PROJECT);
    assertEquals(repo.defaultBranch, "main");
    assert(webhook.url.startsWith(`${w.forgeOrigin}/v1/hooks/gitlab?project=`));

    const agent = await (await send(w, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    assertEquals(agent.handle, "ada");

    const issue = w.gitlab.openIssue(PROJECT, { as: "grace", title: "Two should be 22" });
    const { noteId } = await w.gitlab.comment(PROJECT, `issue-${issue.iid}`, {
      as: "grace",
      body: "/ryph ada make two 22",
    });
    await w.gitlab.flush();
    const launch = await until("the run's launch", () => w.launches[0]);
    const run = await playRun(w, launch.env!, repo.id, {
      "src/widget.ts": "export const two = 22;\n",
    });
    const awards = await until("the eyes", async () => {
      const res = await w.gitlab.client("grace")(
        "GET",
        `/projects/${encodeURIComponent(PROJECT)}/issues/${issue.iid}/notes/${noteId}/award_emoji`,
      );
      const list = await res.json() as Array<{ name: string; user: { username: string } }>;
      return list.length > 0 ? list : null;
    });
    assertEquals(awards.map((a) => [a.name, a.user.username]), [["eyes", "ryph-bot"]]);

    // Approved and swept: the forge pushes the bundle and opens the merge request as the bot.
    const [pending] = (await w.store.listPatches({ state: "pending_approval" })).patches;
    assertEquals((await send(w, "POST", `/v1/patches/${pending!.id}/approve`)).status, 200);
    await w.sweep();
    const submitted = (await w.store.listPatches({ state: "submitted" })).patches[0]!;
    assertEquals(submitted.forgeRef, "mr-1");
    assertStringIncludes(submitted.forgeUrl!, "/acme/widgets/-/merge_requests/1");
    const mr = await (await w.gitlab.client("grace")(
      "GET",
      `/projects/${encodeURIComponent(PROJECT)}/merge_requests/1`,
    )).json();
    assertEquals([mr.sha, mr.author.username, mr.target_branch], [run.headSha, "ryph-bot", "main"]);
    assertStringIncludes(mr.description, "Two is 22 now.");

    // grace merges it on GitLab. The Merge Request Hook records the merge, and the sweep's
    // settle judges the patch landed: its head is the head GitLab names as merged, which the
    // forge proves against the project's history.
    await w.gitlab.merge(PROJECT, 1, { as: "grace", method: "squash" });
    await w.gitlab.flush();
    const recorded = await until(
      "the merge record",
      () => w.store.getChangeRequestMerge(repo.id, "mr-1"),
    );
    assertEquals(recorded.heads, [run.headSha]);
    await w.sweep();
    const settled = await landedPatch(w, submitted.id);
    assertEquals([settled.landed?.kind, settled.landed?.mergedInto], ["merged", "main"]);

    // Every event the forge delivered was taken — the merge request's opening (a push event
    // carrying the instance's http:// page URL) among them.
    assertEquals(
      w.events.map((e) => [e.kind, e.status]).sort(),
      [
        ["branch.updated", 200],
        ["change_request.merged", 200],
        ["change_request.pushed", 200],
        ["issue_comment.created", 200],
      ],
      JSON.stringify(w.events),
    );
  } finally {
    await w.dispose();
  }
});

test("user mode: no webhooks, so the merge is found by the poll and the patch lands", async () => {
  const w = await world("user");
  try {
    // A person's own token connects their project: repos:manage-all, no webhook to paste.
    w.as("operator");
    const { repo, webhook } = await connect(w);
    assertEquals(webhook, null);
    assertEquals(w.gitlab.world.project(PROJECT)!.hooks, []);

    const agent = await (await send(w, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    const created = await send(w, "POST", "/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Make two 22", instructions: "Make it 22." },
      connectedRepoId: repo.id,
    });
    assertEquals(created.status, 201, await created.clone().text());
    const run = await playRun(w, w.launches.at(-1)!.env!, repo.id, {
      "src/widget.ts": "export const two = 22;\n",
    });
    const [pending] = (await w.store.listPatches({ state: "pending_approval" })).patches;
    assertEquals((await send(w, "POST", `/v1/patches/${pending!.id}/approve`)).status, 200);
    await w.sweep();
    const submitted = (await w.store.listPatches({ state: "submitted" })).patches[0]!;
    assertEquals(submitted.forgeRef, "mr-1");
    const mr = await (await w.gitlab.client("grace")(
      "GET",
      `/projects/${encodeURIComponent(PROJECT)}/merge_requests/1`,
    )).json();
    assertEquals([mr.sha, mr.author.username], [run.headSha, "grace"], "opened as grace herself");

    // An open merge request is asked about and left alone.
    await w.sweep();
    assertEquals(await w.store.getChangeRequestMerge(repo.id, "mr-1"), null);

    // Merged on GitLab, which tells nobody: the next ticks read it, record it and land the patch.
    await w.gitlab.merge(PROJECT, 1, { as: "grace" });
    w.clock.advance(60_000);
    await w.sweep();
    const recorded = await w.store.getChangeRequestMerge(repo.id, "mr-1");
    assertEquals(recorded?.heads, [run.headSha]);
    await w.sweep();
    const settled = await landedPatch(w, submitted.id);
    assertEquals([settled.landed?.kind, settled.landed?.mergedInto], ["merged", "main"]);
    assertEquals(w.events, [], "nothing arrived by webhook");
  } finally {
    await w.dispose();
  }
});

test("user mode: a renamed project's own merge request is worked on its branch, and the row learns the path", async () => {
  const w = await world("user");
  try {
    w.as("operator");
    const { repo } = await connect(w);
    await w.gitlab.commit(PROJECT, {
      as: "grace",
      branch: "feat/two",
      from: "main",
      files: { "src/widget.ts": "export const two = 2.0;\n" },
    });
    await w.gitlab.openMergeRequest(PROJECT, {
      as: "grace",
      sourceBranch: "feat/two",
      title: "Two",
    });
    // The project moves; a user-mode deployment takes no webhook, so nothing tells the row.
    w.gitlab.addGroup("elsewhere");
    w.gitlab.addMember("elsewhere", "grace", "maintainer");
    w.gitlab.renameProject(PROJECT, "elsewhere/widgets");
    assertEquals((await w.store.getConnectedRepo(repo.id))?.repoRef, PROJECT);

    const agent = await (await send(w, "POST", "/v1/agents", {
      name: "Ada",
      email: "ada@example.com",
      harnessKind: "echo",
    })).json();
    const created = await send(w, "POST", "/v1/tasks", {
      agentId: agent.id,
      spec: { title: "Address the review", instructions: "Do it." },
      connectedRepoId: repo.id,
      targetChangeRequest: { connectedRepoId: repo.id, thread: "mr-1" },
    });
    assertEquals(created.status, 201, await created.clone().text());
    // The project's own merge request, by its ids — not a fork for its path having moved: its
    // branch is checked out and pushed onto, as before the move.
    const task = (await w.store.getTask((await created.json()).taskId))!;
    assertEquals(task.repos.map((r) => ({ ref: r.ref, fork: r.forkHead })), [
      { ref: "refs/heads/feat/two", fork: undefined },
    ]);
    // And the row names where the project is now, as GitLab answers it by the project's id.
    const now = (await w.store.getConnectedRepo(repo.id))!;
    assertEquals(now.repoRef, "elsewhere/widgets");
    assertStringIncludes(now.url, "elsewhere/widgets");
  } finally {
    await w.dispose();
  }
});

/** The authorize leg as the app sends a browser through it, `who` approving at GitLab; the code
 * GitLab redirects back with. */
async function authorize(w: World, who: string, verifier: string): Promise<string> {
  w.gitlab.signInAs(who);
  const q = new URLSearchParams({
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "read_user",
    state: "s-1",
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
  });
  const res = await fetch(`${w.gitlab.url}/oauth/authorize?${q}`, { redirect: "manual" });
  assertEquals(res.status, 302, await res.clone().text());
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

test("GitLab sign-in: offered, the code redeemed with its redirect URI and PKCE verifier, the group gate", async () => {
  const w = await world();
  try {
    const offered = await until("GitLab offered", async () => {
      const { providers } = await (await w.handler(
        new Request("http://orchestrator.test/v1/auth/providers"),
      )).json();
      return providers.includes("gitlab") ? providers : null;
    });
    assert(offered.includes("gitlab"));

    const verifier = `v${crypto.randomUUID().replaceAll("-", "")}${"x".repeat(20)}`;
    const callback = (code: string, codeVerifier: string) =>
      w.handler(
        new Request("http://orchestrator.test/v1/auth/oauth/gitlab/callback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, redirectUri: REDIRECT, codeVerifier }),
        }),
      );

    // The wrong verifier: GitLab refuses the code.
    const refused = await callback(await authorize(w, "grace", verifier), "w".repeat(43));
    assertEquals(refused.status, 502, await refused.clone().text());

    // Registration closed, the forge's group open to join: RYPH_GITLAB_GROUP=acme decides.
    await w.authStore.saveSettings({
      allowOpenRegistration: false,
      allowForgeOrgJoin: true,
      updatedAt: new Date().toISOString(),
    });
    // mallory, outside `acme`, is not let in.
    const stranger = await callback(await authorize(w, "mallory", verifier), verifier);
    assertEquals(stranger.status, 403, await stranger.clone().text());
    assertStringIncludes(await stranger.text(), "registration is closed");

    // eve is in `acme`, and the instance confirmed the address she typed: victim's, who has an
    // account here. Admitted, her GitLab account still reaches nobody's account by address.
    const at = new Date().toISOString();
    await w.authStore.createUser({
      id: "u-victim",
      email: "victim@example.com",
      name: "Victim",
      passwordHash: null,
      role: "member",
      status: "active",
      emailVerifiedAt: at,
      unprovenEmail: null,
      resetRequestedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    w.gitlab.addUser({ username: "eve", name: "Eve", email: "victim@example.com" });
    w.gitlab.addMember("acme", "eve", "developer");
    const squat = await callback(await authorize(w, "eve", verifier), verifier);
    assertEquals(squat.status, 409, await squat.clone().text());
    assertEquals((await squat.json()).code, "link_required");
    assertEquals(await w.authStore.listIdentitiesByUser("u-victim"), []);

    // grace, a maintainer in `acme`, signs up by signing in, and her GitLab identity is linked by
    // its stable id on this instance. Her address is GitLab's word, not proof: the account holds
    // it beside a stand-in, so it is never the key to her account, nor anyone else's.
    const signedIn = await callback(await authorize(w, "grace", verifier), verifier);
    assertEquals(signedIn.status, 200, await signedIn.clone().text());
    const signedInBody = await signedIn.json();
    assert(typeof signedInBody.accessToken === "string");
    assertEquals(await w.authStore.getUserByEmail("grace@example.com"), null);
    const user = await w.authStore.getUserById(signedInBody.user.id);
    assertEquals(user?.unprovenEmail, "grace@example.com");
    const linked = await w.authStore.getIdentity(user!.id, "gitlab");
    assertEquals(
      [linked?.providerAccountId, linked?.login],
      [`${w.gitlab.world.userByUsername("grace")!.id}@${w.gitlab.url}`, "grace"],
    );

    // A webhook names her by GitLab's bare id (the note's author, as the forge reads it): the
    // control plane's directory finds the link sign-in just stored under it.
    const directory = authStoreIdentityDirectory(w.authStore, { gitlab: w.gitlabMode });
    const graceId = String(w.gitlab.world.userByUsername("grace")!.id);
    assertEquals(await directory.userIdsForAccount("gitlab", graceId), [user!.id]);
  } finally {
    await w.dispose();
  }
});

test("a renamed project's old path, re-created by somebody else, administers nothing of the connected one", async () => {
  const w = await world();
  try {
    const graceId = String(w.gitlab.world.userByUsername("grace")!.id);
    w.identities.link(USER.userId, accountOf(w, "grace"), "gitlab", graceId);
    const { repo, webhook } = await connect(w);
    const projectId = String(w.gitlab.world.project(PROJECT)!.id);

    // The project moves out of acme; mallory makes a project at the old path, public so ryph's
    // bot sees it, and maintains it. ryph's row still names the old path: no delivery has said
    // otherwise.
    w.gitlab.addGroup("elsewhere");
    w.gitlab.renameProject(PROJECT, "elsewhere/widgets");
    await w.gitlab.addProject(PROJECT, {
      visibility: "public",
      files: { "README.md": "# mine\n" },
    });
    w.gitlab.addMember(PROJECT, "mallory", "maintainer");
    const stored = (await w.store.getConnectedRepo(repo.id))!;
    assertEquals([stored.repoRef, stored.forgeId], [PROJECT, `${projectId}@${w.gitlab.url}`]);
    // The chat door's visibility read asks the connected project too, not the public squatter.
    const client = httpForge({
      baseUrl: w.forgeOrigin,
      forgeToken: FORGE_TOKEN,
      diag: silentDiagnostics(),
    });
    assertEquals(await client.repoVisibility(forgeRepoRef(stored)), "private");

    // As mallory: Maintainer of what lives at the path now, nothing of the connected project.
    w.identities.link(USER.userId, accountOf(w, "mallory"), "gitlab");
    const shown = await send(w, "GET", `/v1/connected-repos/${repo.id}/gitlab-hook`);
    assertEquals(shown.status, 403, await shown.clone().text());
    const rotated = await send(w, "POST", `/v1/connected-repos/${repo.id}/gitlab-hook/rotate`);
    assertEquals(rotated.status, 403, await rotated.clone().text());
    const patched = await send(w, "PATCH", `/v1/connected-repos/${repo.id}`, {
      submissionPolicy: "auto",
    });
    assertEquals(patched.status, 403, await patched.clone().text());
    assertEquals((await w.store.getGitlabProject(repo.id))?.hookGeneration, 1);

    // grace, who maintains the connected project wherever it lives, still administers it — and
    // the row learns the path it moved to.
    w.identities.link(USER.userId, accountOf(w, "grace"), "gitlab", graceId);
    w.gitlab.addMember("elsewhere", "grace", "maintainer");
    const again = await send(w, "GET", `/v1/connected-repos/${repo.id}/gitlab-hook`);
    assertEquals(again.status, 200, await again.clone().text());
    assertEquals((await again.json()).webhook.token, webhook.token);
    assertStringIncludes(webhook.url, `project=${projectId}`);
    assertEquals((await w.store.getConnectedRepo(repo.id))?.repoRef, "elsewhere/widgets");
  } finally {
    await w.dispose();
  }
});
