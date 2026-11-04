import { test } from "bun:test";
import { bootstrapEnv } from "./bootstrap_helpers.ts";

// The environment surface over HTTP: the cards, the log, Rebuild and who may press it, the
// workspace's environment repo, what the run and task views and the runner's spec say about a
// run's machine, and the build's own git key at the gateway door.

import { type Capability, capsClaimOf, type Role } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { sha256Hex } from "@ryph/sealed";
import { fakeIdentityDirectory, fakeRunnerControl } from "./doubles.ts";
import { AGENT_IMAGE, sha, tree, world, type WorldOptions } from "./environment_world.ts";

const USER = {
  kind: "user",
  userId: "u-1",
  email: "ada@example.com",
  name: "Ada",
  emailVerified: true,
  sid: "s-1",
  via: "session",
} as const;
const FORGE_TOKEN = "forge-service-token";

async function app(opts: WorldOptions = {}) {
  const w = await world(opts);
  let role: Role = "owner";
  // A caller's own capabilities, as a scoped API token carries them; null: the role's.
  let caps: Capability[] | null = null;
  const identities = fakeIdentityDirectory();
  const handler = makeHandler({
    store: w.store,
    provisioner: w.deps.provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: w.diag,
    authenticate: (() =>
      Promise.resolve({ ...USER, caps: caps ?? capsClaimOf(role) })) as unknown as Authenticate,
    identityDirectory: identities.directory,
    forgeToken: FORGE_TOKEN,
    forge: w.forge,
    environments: w.service,
    startWithoutEnvironment: w.wired?.startWithoutEnvironment ?? null,
    now: w.clock.now,
    config: { ...w.config, harnessKinds: ["pi", "echo"] },
  });
  const call = async (method: string, path: string, body?: unknown, token = "t") =>
    await handler(
      new Request(`http://orchestrator.test${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    ...w,
    handler,
    call,
    identities,
    setRole: (r: Role) => (role = r),
    setCaps: (c: Capability[] | null) => (caps = c),
  };
}

test("the repo card: off is an answer, not an error", async () => {
  const a = await app({ environments: { enabled: false } });
  const res = await a.call("GET", "/v1/connected-repos/cr-api/environment");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    enabled: false,
    builder: null,
    refusedReason: null,
    current: null,
    latest: null,
    sizeClass: null,
  });
  assertEquals((await a.call("GET", "/v1/connected-repos/cr-nope/environment")).status, 404);
  const definition = await a.call("GET", "/v1/connected-repos/cr-api/environment/definition");
  assertEquals(definition.status, 200);
  assertEquals(await definition.json(), { definition: null, ignoredDockerfiles: [] });
  assertEquals(
    (await a.call("GET", "/v1/connected-repos/cr-nope/environment/definition")).status,
    404,
  );
});

test("repo services distinguish absent, invalid, unavailable and cached declarations", async () => {
  const a = await app({ environments: { enabled: false } });
  const path = "/v1/connected-repos/cr-api/services";
  a.setCaps([]);
  assertEquals((await a.call("GET", path)).status, 403);
  a.setCaps(null);
  assertEquals((await a.call("GET", "/v1/connected-repos/missing/services")).status, 404);
  a.forge.readServicesFile = () => Promise.resolve({ kind: "absent" });
  assertEquals(await (await a.call("GET", path)).json(), { state: "none" });
  a.forge.readServicesFile = () => Promise.resolve({ kind: "invalid", detail: "too large" });
  assertEquals(await (await a.call("GET", path)).json(), { state: "invalid", error: "too large" });
  a.forge.readServicesFile = () => Promise.resolve({ kind: "unavailable", detail: "offline" });
  assertEquals((await a.call("GET", path)).status, 503);
  a.forge.readServicesFile = () =>
    Promise.resolve({ kind: "file", stale: false, text: "services: []" });
  assertEquals((await (await a.call("GET", path)).json()).state, "invalid");
  a.forge.readServicesFile = (_repo, _url, ref) => {
    assertEquals(ref, "main");
    return Promise.resolve({
      kind: "file",
      stale: true,
      text:
        "services:\n  db:\n    uses: postgres@18\n    port: 5432\n    env:\n      POSTGRES_PASSWORD: secret\n" +
        "  testdb:\n    uses: postgres@18\n    port: 5433\n    checks_only: true\n",
    });
  };
  const res = await a.call("GET", path);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.state, "declared");
  assertEquals(body.stale, true);
  assertEquals(body.services, [
    { name: "db", source: "postgres@18", port: 5432, checksOnly: false },
    { name: "testdb", source: "postgres@18", port: 5433, checksOnly: true },
  ]);
  assertStringIncludes(body.problem, "RYPH_SERVICES");
  assert(!JSON.stringify(body).includes("secret"));
  // Judged as a run would be: a checks-only service alone is no problem with services off.
  a.forge.readServicesFile = () =>
    Promise.resolve({
      kind: "file",
      stale: false,
      text: "services:\n  testdb:\n    uses: postgres@18\n    port: 5433\n    checks_only: true\n",
    });
  assertEquals((await (await a.call("GET", path)).json()).problem, null);
  a.forge.readServicesFile = () =>
    Promise.resolve({ kind: "file", stale: false, text: "# placeholder" });
  assertEquals(await (await a.call("GET", path)).json(), {
    state: "declared",
    stale: false,
    services: [],
    problem: null,
  });
});

test("the card itself never asks the forge, so a page never waits on one", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  // Every read below is a database read: a forge nothing can reach changes none of them.
  a.unreachable.value = true;
  const repoCard = await a.call("GET", "/v1/connected-repos/cr-api/environment");
  assertEquals(repoCard.status, 200);
  assertEquals((await repoCard.json()).latest.trigger, "manual");
  const wsCard = await a.call("GET", "/v1/workspaces/ws-1/environment");
  assertEquals(wsCard.status, 200);
  assertEquals((await wsCard.json()).environmentRepoId, null);
  assert(
    !a.diagEvents.some((e) => e.event === "environments.member_unreadable"),
    "the forge was never asked",
  );

  // The forge half is where the cost is, and where a failure lands: the card's other route.
  const unreadable = await a.call("GET", "/v1/connected-repos/cr-api/environment/definition");
  assertEquals(unreadable.status, 503);
  assertStringIncludes((await unreadable.json()).error, "acme/api");
  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
});

test("Rebuild is an admin's; the card then shows the build, and its log once it lands", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  a.setRole("member");
  const denied = await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  assertEquals(denied.status, 403);
  assertEquals((await denied.json()).code, "forbidden");
  assertEquals(a.environmentStore.rows.size, 0);

  a.setRole("owner");
  const res = await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  assertEquals(res.status, 202);
  const { environment } = await res.json();
  assertEquals(environment.trigger, "manual");
  assertEquals(environment.ref, "main");
  assertEquals(environment.commits, { api: sha("a") });
  assertStringIncludes(environment.reason, "rebuilt by hand");
  assertEquals(Object.keys(environment).sort(), [
    "baseDigest",
    "commits",
    "createdAt",
    "definition",
    "egressNote",
    "estimateMs",
    "finishedAt",
    "harnessDigest",
    "id",
    "image",
    "kind",
    "logTail",
    "machine",
    "reason",
    "ref",
    "setupWarnings",
    "sizeBytes",
    "startedAt",
    "status",
    "subjectId",
    "subjectKind",
    "toolchains",
    "trigger",
  ]);

  // Readable by anyone signed in.
  a.setRole("member");
  const building = await (await a.call("GET", "/v1/connected-repos/cr-api/environment")).json();
  assertEquals(building.enabled, true);
  assertEquals(building.builder, "docker");
  assertEquals(building.current, null);
  assertEquals(building.latest.id, environment.id);

  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
  const ready = await (await a.call("GET", "/v1/connected-repos/cr-api/environment")).json();
  assertEquals(ready.current.id, environment.id);
  assertEquals(ready.current.status, "ready");
  assertEquals(ready.current.toolchains, { rustc: "1.97.1" });

  const log = await a.call("GET", `/v1/environments/${environment.id}/log`);
  assertEquals(log.status, 200);
  assertEquals(log.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(await log.text(), "step 1\nstep 2\nbuilt\n");
  assertEquals((await a.call("GET", "/v1/environments/env-nope/log")).status, 404);
});

test("Rebuild refuses what cannot be built, and says why", async () => {
  const off = await app({ environments: { enabled: false } });
  assertEquals(
    (await off.call("POST", "/v1/connected-repos/cr-api/environment/rebuild")).status,
    409,
  );

  const manual = await app({ builderKind: "manual" });
  const refused = await manual.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  assertEquals(refused.status, 409);
  assertStringIncludes((await refused.json()).error, "manual");
  const card = await (await manual.call("GET", "/v1/connected-repos/cr-api/environment")).json();
  assertStringIncludes(card.refusedReason, "manual");

  const plain = await app();
  plain.setHead("acme/api", "main", { commit: sha("a"), tree: null });
  const nothing = await plain.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  assertEquals(nothing.status, 409);
  assertStringIncludes((await nothing.json()).error, "no .ryph directory");

  plain.unreachable.value = true;
  assertEquals(
    (await plain.call("POST", "/v1/connected-repos/cr-api/environment/rebuild")).status,
    503,
  );
});

test("the workspace card names its environment repo and the Dockerfiles it passes over", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  a.setHead("acme/web", "main", { commit: sha("c"), tree: tree("c"), dockerfile: true });
  const card = await (await a.call("GET", "/v1/workspaces/ws-1/environment")).json();
  assertEquals(card.environmentRepoId, null);
  const described = await (await a.call("GET", "/v1/workspaces/ws-1/environment/definition"))
    .json();
  assertEquals(described.definition, { ryph: true, dockerfile: true });
  assertEquals(described.ignoredDockerfiles, ["acme/web"]);

  const rebuilt = await a.call("POST", "/v1/workspaces/ws-1/environment/rebuild");
  assertEquals(rebuilt.status, 202);
  const [build] = await a.builder.parked(1);
  assertEquals(build.spec.subjectKey, "workspace-ws-1");
  assertEquals(build.spec.dockerfileFrom, "api");
  build.succeed();
  await a.service!.idle();
});

test("the workspace card reads every member: a member's .ryph/ is a definition to revise", async () => {
  const a = await app();
  // The environment repo describes nothing; web has a setup.yml, which builds an image.
  a.setHead("acme/api", "main", { commit: sha("a"), tree: null });
  a.setHead("acme/web", "main", { commit: sha("c"), tree: tree("c") });
  const described = await (await a.call("GET", "/v1/workspaces/ws-1/environment/definition"))
    .json();
  assertEquals(described.definition, { ryph: true, dockerfile: false });
  assertEquals(described.ignoredDockerfiles, []);

  // A member the forge cannot read is taken as describing nothing; only the environment repo's
  // read must answer.
  const original = a.forge.ryphTree.bind(a.forge);
  a.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/web"
      ? Promise.reject(new Error("web is down"))
      : original(repo, url, ref);
  const partial = await a.call("GET", "/v1/workspaces/ws-1/environment/definition");
  assertEquals(partial.status, 200);
  assertEquals((await partial.json()).definition, { ryph: false, dockerfile: false });
  a.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/api"
      ? Promise.reject(new Error("api is down"))
      : original(repo, url, ref);
  const unreadable = await a.call("GET", "/v1/workspaces/ws-1/environment/definition");
  assertEquals(unreadable.status, 503);
  assertStringIncludes((await unreadable.json()).error, "acme/api");
});

test("PATCH environmentRepoId: an admin's, and only a member", async () => {
  const a = await app();
  a.setRole("member");
  const denied = await a.call("PATCH", "/v1/workspaces/ws-1", { environmentRepoId: "cr-web" });
  assertEquals(denied.status, 403);

  a.setRole("owner");
  const stranger = await a.call("PATCH", "/v1/workspaces/ws-1", { environmentRepoId: "cr-other" });
  assertEquals(stranger.status, 400);
  assertStringIncludes((await stranger.json()).error, "not a member");

  const set = await a.call("PATCH", "/v1/workspaces/ws-1", { environmentRepoId: "cr-web" });
  assertEquals(set.status, 200);
  assertEquals((await set.json()).workspace.environmentRepoId, "cr-web");
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  a.setHead("acme/web", "main", { commit: sha("c"), tree: tree("c"), dockerfile: true });
  const card = await (await a.call("GET", "/v1/workspaces/ws-1/environment")).json();
  assertEquals(card.environmentRepoId, "cr-web");
  const described = await (await a.call("GET", "/v1/workspaces/ws-1/environment/definition"))
    .json();
  assertEquals(described.ignoredDockerfiles, ["acme/api"]);

  const cleared = await a.call("PATCH", "/v1/workspaces/ws-1", { environmentRepoId: null });
  assertEquals((await cleared.json()).workspace.environmentRepoId, null);
  // Renaming alone leaves it be.
  await a.call("PATCH", "/v1/workspaces/ws-1", { environmentRepoId: "cr-web" });
  const renamed = await a.call("PATCH", "/v1/workspaces/ws-1", { name: "Store" });
  assertEquals((await renamed.json()).workspace.environmentRepoId, "cr-web");
});

test("a waiting run: the task views show the wait, then the machine; the spec serves it", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await a.startRepo();
  const { taskId, runId } = started as { taskId: string; runId: string };

  const waiting = await (await a.call("GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(waiting.runs[0].environment, null);
  assertEquals(waiting.runs[0].environmentWait.status, "building");
  assert(waiting.runs[0].events.some((e: { kind: string }) => e.kind === "environment.building"));
  // The LIST row says the run is starting and nothing about the build: the wait belongs to the
  // task page (above), and the list's row is one indexed read of the tasks table — no column of
  // it, and no query per row, carries a run's environment.
  const listed = (await (await a.call("GET", "/v1/tasks")).json()).tasks[0];
  assertEquals(listed.id, taskId);
  assertEquals(listed.state, "starting");
  assertEquals("environmentWait" in listed, false);

  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
  const running = await (await a.call("GET", `/v1/tasks/${taskId}`)).json();
  assertEquals(running.runs[0].environmentWait, null);
  // The view is narrowed to what a person reads off it.
  assertEquals(Object.keys(running.runs[0].environment).sort(), [
    "builtAt",
    "commits",
    "id",
    "image",
    "ref",
  ]);
  assertEquals(running.runs[0].environment.commits, { api: sha("a") });
  assertEquals("tokenHash" in running.runs[0], false);

  // The runner, with the token minted at launch, is served the whole frozen environment.
  const token = (await bootstrapEnv(a.handler, a.launches[0].env)).RYPH_RUN_TOKEN;
  const spec = await (await a.call("GET", `/v1/runs/${runId}/spec`, undefined, token)).json();
  assertEquals(spec.environment.baked, true);
  assertEquals(spec.environment.ref, "main");
  assertEquals(spec.environment.toolchains, { rustc: "1.97.1" });
  assertEquals(spec.environment.image, running.runs[0].environment.image);
});

test("the spec's environment: the default image unbaked when on, null when off", async () => {
  const on = await app();
  on.setHead("acme/api", "main", { commit: sha("a"), tree: null });
  const { runId } = (await on.startRepo()) as { runId: string };
  const spec = await (await on.call(
    "GET",
    `/v1/runs/${runId}/spec`,
    undefined,
    (await bootstrapEnv(on.handler, on.launches[0].env)).RYPH_RUN_TOKEN,
  )).json();
  assertEquals(spec.environment, {
    id: "default",
    image: AGENT_IMAGE,
    baked: false,
    commits: {},
    builtAt: null,
    toolchains: {},
    ref: null,
  });

  const off = await app({ environments: { enabled: false } });
  const offRun = (await off.startRepo()) as { runId: string };
  const offSpec = await (await off.call(
    "GET",
    `/v1/runs/${offRun.runId}/spec`,
    undefined,
    (await bootstrapEnv(off.handler, off.launches[0].env)).RYPH_RUN_TOKEN,
  )).json();
  assertEquals(offSpec.environment, null);
});

test("a build's git key resolves at the gateway door only while it builds, to its checkouts", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild");
  const [build] = await a.builder.parked(1);
  const header = build.spec.clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.slice("Authorization: Basic ".length)).split(":")[1];
  const resolve = () => a.call("POST", "/v1/forge/git-keys/resolve", { token }, FORGE_TOKEN);

  const res = await resolve();
  assertEquals(res.status, 200);
  const grant = await res.json();
  assertEquals(grant.runId, build.spec.environmentId);
  assertEquals(grant.repos, [{
    connectedRepoId: "cr-api",
    url: "https://github.com/acme/api.git",
    ref: "main",
    branchNamespace: `ryph-build/${build.spec.environmentId}`,
    provider: "github",
    repoRef: "acme/api",
    tenantId: "42",
  }]);
  // A token nobody minted is as unknown as ever.
  assertEquals(
    (await a.call("POST", "/v1/forge/git-keys/resolve", { token: "nope" }, FORGE_TOKEN)).status,
    404,
  );

  build.succeed();
  await a.service!.idle();
  assertEquals((await resolve()).status, 404, "the key died with the build");
  assert((await a.environmentStore.getBuildGitKeyByTokenHash(await sha256Hex(token)))!.revokedAt);
});

test("one build over HTTP: its kind and how long builds like it take", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await a.startRepo();
  const [build] = await a.builder.parked(1);
  const res = await a.call("GET", `/v1/environments/${build.spec.environmentId}`);
  assertEquals(res.status, 200);
  const view = await res.json();
  assertEquals(view.id, build.spec.environmentId);
  assertEquals(view.kind, "full");
  assertEquals(view.estimateMs, null, "nothing to go by yet");
  assertEquals((await a.call("GET", "/v1/environments/env-nope")).status, 404);
});

test("start without waiting: the task's waiting run launches now; a second ask is a 409", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = (await a.startRepo()) as { taskId: string; runId: string };
  const res = await a.call("POST", `/v1/tasks/${started.taskId}/start-without-environment`);
  assertEquals(res.status, 202);
  assertEquals((await res.json()).runId, started.runId);
  assertEquals((await a.store.getRun(started.runId))!.image, AGENT_IMAGE);
  assertEquals(
    (await a.call("POST", `/v1/tasks/${started.taskId}/start-without-environment`)).status,
    409,
  );
  assertEquals((await a.call("POST", "/v1/tasks/t-nope/start-without-environment")).status, 404);
});

test("the builds list: every build here, newest first, named, narrowed and paged", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  a.setHead("acme/web", "main", { commit: sha("c"), tree: tree("c"), dockerfile: true });
  const repoBuild = (await (await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild"))
    .json()).environment;
  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
  a.clock.advance(1000);
  const wsBuild = (await (await a.call("POST", "/v1/workspaces/ws-1/environment/rebuild"))
    .json()).environment;

  a.setRole("member");
  const all = await (await a.call("GET", "/v1/environments")).json();
  assertEquals(all.builds.map((b: { build: { id: string } }) => b.build.id), [
    wsBuild.id,
    repoBuild.id,
  ]);
  assertEquals(all.builds[0].subject, { name: "Shop", provider: null });
  assertEquals(all.builds[1].subject, { name: "acme/api", provider: "github" });
  assertEquals(all.nextCursor, null);

  const ids = async (query: string) =>
    (await (await a.call("GET", `/v1/environments?${query}`)).json()).builds
      .map((b: { build: { id: string } }) => b.build.id);
  assertEquals(await ids("state=ready"), [repoBuild.id]);
  assertEquals(await ids("state=active"), [wsBuild.id]);
  assertEquals(await ids("state=failed"), []);
  assertEquals(await ids("subject=repo:cr-api"), [repoBuild.id]);
  assertEquals(await ids("subject=workspace:ws-1"), [wsBuild.id]);

  const first = await (await a.call("GET", "/v1/environments?limit=1")).json();
  assertEquals(first.builds.length, 1);
  const rest = await (await a.call("GET", `/v1/environments?cursor=${first.nextCursor}`)).json();
  assertEquals(rest.builds.map((b: { build: { id: string } }) => b.build.id), [repoBuild.id]);

  assertEquals((await a.call("GET", "/v1/environments?state=nope")).status, 400);
  assertEquals((await a.call("GET", "/v1/environments?subject=cr-api")).status, 400);
  assertEquals((await a.call("GET", "/v1/environments?cursor=nope")).status, 400);

  // A list row carries neither the log tail nor the definition key: it is re-read every few
  // seconds while anything builds.
  assertEquals("logTail" in all.builds[0].build, false);
  assertEquals("definition" in all.builds[0].build, false);

  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
});

test("the builds list shows a branch build only to whoever may read its task", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const main = (await (await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild"))
    .json()).environment;
  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
  const stored = a.environmentStore.rows.get(main.id)!;
  await a.environmentStore.createEnvironment({
    ...stored,
    id: "env-branch",
    ref: "feat/secret",
    defaultBranch: false,
    trigger: "run",
    createdAt: new Date(Date.parse(stored.createdAt) + 1000).toISOString(),
  });
  const ids = async () =>
    (await (await a.call("GET", "/v1/environments")).json()).builds
      .map((b: { build: { id: string } }) => b.build.id);

  // An operator reads every task, so every build.
  a.setRole("operator");
  assertEquals(await ids(), ["env-branch", main.id]);
  // A member who may write nothing here sees the default branch's builds, as on the card.
  a.setRole("member");
  assertEquals(await ids(), [main.id]);
});

test("the builds list asks the forge who may write, and shows a branch build by its checkouts", async () => {
  const a = await app();
  a.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const main = (await (await a.call("POST", "/v1/connected-repos/cr-api/environment/rebuild"))
    .json()).environment;
  (await a.builder.parked(1))[0].succeed();
  await a.service!.idle();
  const stored = a.environmentStore.rows.get(main.id)!;
  const checkout = (connectedRepoId: string, path: string) => ({
    path,
    connectedRepoId,
    ref: "feat/x",
    commit: sha("b"),
  });
  const branch = (id: string, minutes: number, overrides: Partial<typeof stored>) =>
    a.environmentStore.createEnvironment({
      ...stored,
      id,
      ref: "feat/x",
      defaultBranch: false,
      trigger: "run",
      createdAt: new Date(Date.parse(stored.createdAt) + minutes * 60_000).toISOString(),
      ...overrides,
    });
  // The repo's own branch build, and the workspace's: one checkout of each member.
  await branch("env-api-branch", 1, {
    plan: { ...stored.plan, checkouts: [checkout("cr-api", "api")] },
  });
  await branch("env-ws-branch", 2, {
    subjectKind: "workspace",
    subjectId: "ws-1",
    plan: { ...stored.plan, checkouts: [checkout("cr-api", "api"), checkout("cr-web", "web")] },
  });

  // Ada may write acme/api on the forge, and not acme/web.
  a.identities.link(USER.userId, "ada");
  const writable = new Set(["acme/api"]);
  a.forge.checkPermission = (repo, who) =>
    Promise.resolve(who.subject === "ada" && writable.has(repo.repoRef) ? "allowed" : "denied");
  a.setRole("member");
  const ids = async () =>
    (await (await a.call("GET", "/v1/environments")).json()).builds
      .map((b: { build: { id: string } }) => b.build.id);
  // The repo's branch build is hers to read; the workspace's checked out acme/web too.
  assertEquals(await ids(), ["env-api-branch", main.id]);

  // Once she may write acme/web too (and the cached answer has turned over), the workspace's is.
  writable.add("acme/web");
  a.clock.advance(11 * 60_000);
  assertEquals(await ids(), ["env-ws-branch", "env-api-branch", main.id]);

  // A token without workspaces:read sees no workspace's build at all, filtered or not.
  a.setCaps(["repos:read"]);
  assertEquals(await ids(), ["env-api-branch", main.id]);
  const probed = await (await a.call("GET", "/v1/environments?subject=workspace:ws-1")).json();
  assertEquals(probed.builds, []);
});
