// When builds happen: a default branch moving (`branch.updated` → onBranchUpdated), the hourly
// reconcile backstop, and what a deploy changes — the harness layer (re-layer every ready image,
// runs wait for it) and the universal image (full rebuilds, throttled, runs never wait).

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { definitionKey, makeEnvironmentService, sameImage } from "../src/core/environments.ts";
import { type BranchUpdatedEvent, onBranchUpdated } from "../src/core/branch_updated.ts";
import type { ConnectedRepo, Environment } from "../src/core/types.ts";
import { BASE, HARNESS, sha, T0, tree, world } from "./environment_world.ts";
import { fakeBuilder, settleAsync } from "./environment_doubles.ts";

function pushed(repo: ConnectedRepo, commit: string): BranchUpdatedEvent {
  return {
    deliveryId: `push-${commit}`,
    kind: "branch.updated",
    repo: { provider: repo.provider, repoRef: repo.repoRef, url: repo.url },
    actorLogin: "octo",
    thread: null,
    body: null,
    sourceCommentId: null,
    branch: { ref: repo.defaultBranch, commit },
    receivedAt: T0,
  };
}

const HOUR = 60 * 60 * 1000;

test("the default branch moves with a new .ryph: a build now, for the repo and its workspace", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: null });
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  const builds = await w.builder.parked(2);
  assertEquals(builds.map((b) => b.spec.subjectKey).sort(), ["repo-cr-api", "workspace-ws-1"]);
  for (const build of builds) {
    assertEquals(
      build.spec.cacheScope.write,
      build.spec.subjectKey,
      "default branch: shared scope",
    );
  }
  assertEquals(
    [...w.environmentStore.rows.values()].map((r) => r.trigger),
    ["push", "push"],
  );

  // The same delivery again: nothing new — the build of these inputs is the build.
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  await settleAsync();
  assertEquals(w.environmentStore.rows.size, 2);
  for (const build of builds) build.succeed();
  await w.service!.idle();
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  await settleAsync();
  assertEquals(w.environmentStore.rows.size, 2, "already built: a redelivery builds nothing");
});

test("only code moved: rebuilt at most every RYPH_ENV_REBUILD_INTERVAL", async () => {
  const w = await world({ environments: { rebuildIntervalMs: 6 * HOUR } });
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  // Keep the workspace out of it: web has no .ryph, but the workspace's machine is api's.
  await w.store.removeWorkspaceRepo("ws-1", "cr-api");
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();

  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("b")), w.api);
  await settleAsync();
  assertEquals(w.builder.specs.length, 1, "an hour later, code only: the image is warm enough");

  w.clock.advance(6 * HOUR);
  w.setHead("acme/api", "main", { commit: sha("c"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("c")), w.api);
  const [refresh] = await w.builder.parked(1);
  assertEquals(refresh.spec.checkouts[0].commit, sha("c"));
  refresh.succeed();

  // The .ryph tree changing is never throttled.
  w.clock.advance(1000);
  w.setHead("acme/api", "main", { commit: sha("d"), tree: tree("d"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("d")), w.api);
  const [now] = await w.builder.parked(1);
  assertEquals(now.spec.checkouts[0].commit, sha("d"));
  now.succeed();
  await w.service!.idle();
});

test("only code moved under an image whose setup.yml did not finish: built now, once", async () => {
  // The push may be the fix: a lockfile or a script setup.yml runs, outside .ryph/.
  const w = await world({ environments: { rebuildIntervalMs: 6 * HOUR } });
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  await w.store.removeWorkspaceRepo("ws-1", "cr-api");
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  (await w.builder.parked(1))[0].succeed(undefined, {
    setupWarnings: [{ kind: "invalid", path: "api", error: "setup.yml: not valid YAML" }],
  });
  await w.service!.idle();

  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("b")), w.api);
  const [fix] = await w.builder.parked(1);
  assertEquals(fix.spec.checkouts[0].commit, sha("b"));
  fix.succeed();
  await w.service!.idle();

  // A clean image again: code-only pushes wait for the interval as before.
  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", { commit: sha("c"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("c")), w.api);
  await settleAsync();
  assertEquals(w.builder.specs.length, 2);
});

test("a setup step that fails at every build: one early build per episode, then the interval", async () => {
  // A step that needs a service or a secret only a run has fails on every commit: a busy repo's
  // pushes must not build back to back for ever.
  const w = await world({ environments: { rebuildIntervalMs: 6 * HOUR } });
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  await w.store.removeWorkspaceRepo("ws-1", "cr-api");
  const warned = {
    setupWarnings: [{
      kind: "step" as const,
      path: "api",
      step: "psql -c 'select 1'",
      index: 1,
      total: 1,
      code: 2,
      output: "could not connect",
      discarded: false,
    }],
  };
  let commit = 0;
  const push = async () => {
    const c = sha(String.fromCharCode("a".charCodeAt(0) + commit++));
    w.setHead("acme/api", "main", { commit: c, tree: tree("a"), dockerfile: true });
    await onBranchUpdated(hookDeps, pushed(w.api, c), w.api);
  };
  await push();
  (await w.builder.parked(1))[0].succeed(undefined, warned);
  await w.service!.idle();

  // Twelve pushes, ten minutes apart, all under the 6-hour interval: the first is the one early
  // build, which warns the same way; none of the rest builds.
  for (let i = 0; i < 12; i++) {
    w.clock.advance(10 * 60 * 1000);
    await push();
    await settleAsync();
    if (i === 0) {
      (await w.builder.parked(1))[0].succeed(undefined, warned);
      await w.service!.idle();
    }
  }
  assertEquals(w.builder.specs.length, 2);

  // The interval still applies: past it, a push builds.
  w.clock.advance(6 * HOUR);
  await push();
  const [later] = await w.builder.parked(1);
  later.succeed(undefined, warned);
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 3);
  // And that one, warned after warned, is no new episode either.
  w.clock.advance(10 * 60 * 1000);
  await push();
  await settleAsync();
  assertEquals(w.builder.specs.length, 3);
});

test("a default branch that drops .ryph retires its images, and builds nothing", async () => {
  const w = await world();
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  await w.store.removeWorkspaceRepo("ws-1", "cr-api");
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("a")), w.api);
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  const [built] = [...w.environmentStore.rows.values()];
  assertEquals(built.status, "ready");

  w.setHead("acme/api", "main", { commit: sha("b"), tree: null });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("b")), w.api);
  await settleAsync();
  assertEquals(w.environmentStore.rows.get(built.id)!.status, "superseded");
  assertEquals(w.builder.specs.length, 1);
});

test("a default branch that drops .ryph leaves a build a run waits for to finish", async () => {
  const w = await world();
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  const [build] = await w.builder.parked(1);
  w.setHead("acme/api", "main", { commit: sha("b"), tree: null });
  await onBranchUpdated(hookDeps, pushed(w.api, sha("b")), w.api);
  await settleAsync();
  assertEquals(build.signal.aborted, false);
  build.succeed();
  await w.service!.idle();
  assert((await w.store.getRun(runId))!.handle !== null, "the run it was promised to launched");
});

test("a workspace whose last .ryph/ goes calls off its build, and says it of the workspace", async () => {
  const w = await world();
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("w") });
  const subject = (await w.service!.loadSubject("workspace", "ws-1"))!;
  await w.service!.refreshSubject(subject, "push");
  const [build] = await w.builder.parked(1);
  w.setHead("acme/web", "main", { commit: sha("d"), tree: null });
  await w.service!.refreshSubject(subject, "push");
  await settleAsync();
  assertEquals(build.signal.aborted, true);
  const row = w.environmentStore.rows.get(build.spec.environmentId)!;
  assertEquals(row.status, "superseded");
  assertEquals(row.failure, "no member of the workspace has a .ryph directory any more");
});

test("environments off: a default branch moving means nothing", async () => {
  const w = await world({ environments: { enabled: false } });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(
    { diag: w.diag, store: w.store, environments: w.service },
    pushed(w.api, sha("a")),
    w.api,
  );
  await onBranchUpdated({ diag: w.diag, store: w.store }, pushed(w.api, sha("a")), w.api);
  await settleAsync();
  assertEquals(w.environmentStore.rows.size, 0);
});

test("the forge not answering is 'could not ask': the hook throws so the mailroom redelivers", async () => {
  const w = await world();
  w.unreachable.value = true;
  let threw = false;
  try {
    await onBranchUpdated(
      { diag: w.diag, store: w.store, environments: w.service },
      pushed(w.api, sha("a")),
      w.api,
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

test("reconcile: whatever an event should have queued, and every default branch refreshed", async () => {
  const w = await world();
  // The upstream renamed api's default branch to `trunk`; nobody told us.
  w.defaultBranches.set("acme/api", "trunk");
  w.setHead("acme/api", "trunk", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: null });
  await w.service!.reconcile();
  assertEquals((await w.store.getConnectedRepo("cr-api"))!.defaultBranch, "trunk");
  assertEquals((await w.store.getConnectedRepo("cr-web"))!.defaultBranch, "main");
  const builds = await w.builder.parked(2);
  assertEquals(builds.map((b) => b.spec.subjectKey).sort(), ["repo-cr-api", "workspace-ws-1"]);
  assert(builds.every((b) => b.spec.checkouts.find((c) => c.path === "api")!.ref === "trunk"));
  assert([...w.environmentStore.rows.values()].every((r) => r.trigger === "reconcile"));
  for (const b of builds) b.succeed();
  await w.service!.idle();

  // A second pass with nothing new builds nothing.
  await w.service!.reconcile();
  await settleAsync();
  assertEquals(w.builder.specs.length, 2);
});

test("reconcile skips a GitHub row of the other mode: no refresh, no build, no workspace", async () => {
  // The forge acts as a user now; api and web (and so the workspace) were connected as an App.
  const userMode = { mode: "user" as const, login: "octo" };
  const w = await world({
    githubMode: { current: () => userMode, get: () => Promise.resolve(userMode) },
  });
  await w.store.createConnectedRepo({
    ...w.api,
    id: "cr-docs",
    installationId: null,
    repoRef: "acme/docs",
    url: "https://github.com/acme/docs.git",
  });
  w.defaultBranches.set("acme/api", "trunk");
  w.setHead("acme/api", "trunk", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/docs", "main", { commit: sha("d"), tree: tree("d"), dockerfile: true });
  await w.service!.reconcile();
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.subjectKey, "repo-cr-docs");
  build.succeed();
  await w.service!.idle();
  await settleAsync();
  assertEquals(w.builder.specs.length, 1);
  assertEquals((await w.store.getConnectedRepo("cr-api"))!.defaultBranch, "main");
});

test("reconcile skips a GitLab row connected on another instance: no refresh, no build", async () => {
  const w = await world();
  w.forge.providers = () =>
    Promise.resolve({
      providers: ["github", "gitlab"],
      github: null,
      gitlab: {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: false,
      },
      radicle: null,
    });
  // Its project id is the instance RYPH_GITLAB_URL named before, which the forge refuses.
  await w.store.createConnectedRepo({
    ...w.api,
    id: "cr-old",
    provider: "gitlab",
    installationId: null,
    repoRef: "acme/old",
    url: "https://gitlab.old.example/acme/old.git",
  });
  await w.store.createGitlabProject("cr-old", "7", "https://gitlab.old.example", w.api.createdAt);
  w.defaultBranches.set("acme/old", "trunk");
  w.setHead("acme/old", "main", { commit: sha("o"), tree: tree("o"), dockerfile: true });
  await w.service!.reconcile();
  await w.service!.idle();
  await settleAsync();
  assert(!w.builder.specs.some((s) => s.subjectKey === "repo-cr-old"), "no build for it");
  assertEquals((await w.store.getConnectedRepo("cr-old"))!.defaultBranch, w.api.defaultBranch);
});

test("reconcile survives one subject the forge cannot read", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const original = w.forge.ryphTree.bind(w.forge);
  w.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/web"
      ? Promise.reject(new Error("web is down"))
      : original(repo, url, ref);
  await w.service!.reconcile();
  const builds = await w.builder.parked(1);
  assertEquals(builds[0].spec.subjectKey, "repo-cr-api");
  builds[0].succeed();
  await w.service!.idle();
});

function readyRow(overrides: Partial<Environment>): Environment {
  return {
    id: "env-x",
    subjectKind: "repo",
    subjectId: "cr-api",
    ref: "main",
    defaultBranch: true,
    commits: { api: sha("a") },
    definition: tree("a"),
    baseDigest: BASE,
    harnessDigest: HARNESS,
    image: `registry.test/x@sha256:${"9".repeat(64)}`,
    bakedImage: `registry.test/ryph-envs/repo-cr-api@sha256:${"8".repeat(64)}`,
    machineImage: null,
    status: "ready",
    toolchains: {},
    sizeBytes: null,
    trigger: "push",
    plan: {
      checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit: sha("a") }],
      dockerfileFrom: "api",
      cacheScope: { read: ["repo-cr-api"], write: "repo-cr-api" },
      relayerOf: null,
    },
    logRef: null,
    logTail: null,
    failure: null,
    egressRefusals: null,
    imagesRemovedAt: null,
    startedAt: T0,
    finishedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

test("a deploy with a new harness re-layers the default branch's image, before any base rebuild", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-both", harnessDigest: "harness@old", baseDigest: "base@old" }),
  );
  await w.environmentStore.createEnvironment(readyRow({
    id: "env-branch",
    ref: "feat",
    defaultBranch: false,
    harnessDigest: "harness@old",
    createdAt: "2026-01-01T00:00:01.000Z",
  }));
  // main has moved on since env-both was built: the base rebuild is of where it stands now.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  await w.service!.onBoot();
  const rows = [...w.environmentStore.rows.values()].filter((r) => r.status !== "ready")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // The branch's image is left for its next run to ask about.
  assertEquals(
    rows.map((r) => [r.ref, r.trigger, r.plan.relayerOf?.environmentId ?? null]).sort(),
    [
      ["main", "base", null],
      ["main", "harness", "env-both"],
    ],
  );
  // The re-layers keep their image's base: stage 4 on its baked stage, nothing below rebuilt.
  const mainRelayer = rows.find((r) => r.ref === "main" && r.plan.relayerOf !== null)!;
  assertEquals(mainRelayer.baseDigest, "base@old");
  assertEquals(mainRelayer.harnessDigest, HARNESS);
  // The base rebuild did not supersede the re-layer runs wait for.
  assertEquals(mainRelayer.status === "queued" || mainRelayer.status === "building", true);
  const rebuild = rows.find((r) => r.trigger === "base")!;
  assertEquals(rebuild.commits, { api: sha("b") });

  // Throttled to the concurrency, the re-layer first.
  const [first] = await w.builder.parked(1);
  assert(first.spec.relayerFrom !== null);
  w.clock.advance(1000);
  first.succeed();
  const [second] = await w.builder.parked(1);
  assertEquals([second.spec.relayerFrom, second.spec.baseImage], [null, BASE]);
  w.clock.advance(1000);
  second.succeed();
  await w.service!.idle();

  // Booting again with nothing changed queues nothing.
  const before = w.environmentStore.rows.size;
  await w.service!.onBoot();
  await settleAsync();
  assertEquals(w.environmentStore.rows.size, before);
});

test("a deploy re-layers main's own image, not a check's newer build of main", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-main", harnessDigest: "harness@old" }),
  );
  // A check's build of main at an older base, finished after main's own image.
  await w.environmentStore.createEnvironment(readyRow({
    id: "env-check",
    defaultBranch: false,
    trigger: "check",
    harnessDigest: "harness@old",
    commits: { api: sha("9") },
    finishedAt: "2026-01-01T00:00:05.000Z",
    createdAt: "2026-01-01T00:00:05.000Z",
  }));
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.service!.onBoot();
  const relayered = [...w.environmentStore.rows.values()]
    .filter((r) => r.plan.relayerOf !== null)
    .map((r) => [r.plan.relayerOf!.environmentId, r.defaultBranch]).sort();
  assertEquals(relayered, [["env-main", true]]);
});

test("a deploy asks once: a re-layer or base rebuild that failed is not queued again", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-both", harnessDigest: "harness@old", baseDigest: "base@old" }),
  );
  await w.environmentStore.createEnvironment(readyRow({
    id: "env-branch",
    ref: "feat",
    defaultBranch: false,
    harnessDigest: "harness@old",
    createdAt: "2026-01-01T00:00:01.000Z",
  }));
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.service!.onBoot();
  // Everything this deploy asked for fails.
  for (let i = 0; i < 2; i++) {
    const [build] = await w.builder.parked(1);
    build.fail("registry said no");
    await settleAsync();
  }
  await w.service!.idle();
  const asked = w.builder.specs.length;
  assertEquals(asked, 2);

  // The hourly repeat at the same head asks for nothing: each of those inputs failed.
  await w.service!.onBoot();
  await settleAsync();
  assertEquals(w.builder.specs.length, asked);

  // main moves (a force-push, say): its failed re-layer turns into a full build of the new head,
  // once.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  await w.service!.onBoot();
  const [full] = await w.builder.parked(1);
  assertEquals(full.spec.checkouts[0].commit, sha("b"));
  assertEquals([full.spec.relayerFrom, full.spec.defaultBranch], [null, true]);
  full.fail("still no");
  await w.service!.idle();
  await w.service!.onBoot();
  await settleAsync();
  assertEquals(w.builder.specs.length, asked + 1);
});

test("a base change never blocks a run: the previous image serves while it rebuilds", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow({ baseDigest: "base@old" }));
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.service!.onBoot();
  await w.builder.parked(1);
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentId, "env-x");
  assert(run.handle !== null);
  w.builder.pending[0].succeed();
  await w.service!.idle();
});

test("a re-tagged base is the same image: a deploy queues no rebuild for a tag alone", () => {
  // Measured on a GKE deployment: a deploy that mirrors the universal image RE-TAGS it, so
  // every deploy moved the reference while the digest stood still — and a string comparison read
  // that as a changed base and queued a full rebuild of every default-branch environment, ~45
  // minutes each, to produce the image that already existed.
  const digest = `@sha256:${"6b".repeat(32)}`;
  assert(
    sameImage(
      `reg/ryph-universal:aaaaaaaaaaaa${digest}`,
      `reg/ryph-universal:bbbbbbbbbbbb${digest}`,
    ),
  );
  // A different digest is a different image, whatever either tag says.
  assert(!sameImage(`reg/u:same${digest}`, `reg/u:same@sha256:${"c".repeat(64)}`));
  // Unpinned is compared as written: it is all an unpinned reference can mean.
  assert(!sameImage("reg/u:one", "reg/u:two"));
  assert(sameImage("reg/u:one", "reg/u:one"));
});

// ---- the definition is every member's .ryph/ -------------------------------------------------

test("definitionKey: a repo is its own tree; a workspace is one key over every member", async () => {
  assertEquals(await definitionKey("repo", [{ path: "api", tree: tree("a") }], "api"), tree("a"));
  assertEquals(await definitionKey("repo", [{ path: "api", tree: null }], "api"), null);
  assertEquals(
    await definitionKey(
      "workspace",
      [{ path: "api", tree: null }, { path: "web", tree: null }],
      "api",
    ),
    null,
  );
  const both = await definitionKey(
    "workspace",
    [{ path: "api", tree: tree("a") }, { path: "web", tree: null }],
    "api",
  );
  assert(both !== null && both.startsWith("sha256:"));
  // Member order is not part of it; every other input is.
  assertEquals(
    await definitionKey(
      "workspace",
      [{ path: "web", tree: null }, { path: "api", tree: tree("a") }],
      "api",
    ),
    both,
  );
  const variants = [
    await definitionKey(
      "workspace",
      [{ path: "api", tree: tree("a") }, { path: "web", tree: tree("w") }],
      "api",
    ),
    await definitionKey(
      "workspace",
      [{ path: "api", tree: tree("a") }, { path: "web", tree: null }],
      "web",
    ),
    await definitionKey(
      "workspace",
      [{ path: "api", tree: tree("a") }, { path: "www", tree: null }],
      "api",
    ),
    await definitionKey("workspace", [{ path: "api", tree: tree("a") }], "api"),
  ];
  for (const other of variants) assert(other !== both);
});

test("definitionKey: a one-member workspace is hashed, so moving its member moves the key", async () => {
  const at = (path: string) => definitionKey("workspace", [{ path, tree: tree("a") }], path);
  const api = await at("api");
  assert(api !== null && api.startsWith("sha256:"));
  assert(api !== tree("a"));
  assert(api !== await at("server"));
});

/** The workspace with api as its environment repo, built once at api@a and web@c. */
async function builtWorkspace(webTree: string | null = null) {
  const w = await world({ environments: { rebuildIntervalMs: 6 * HOUR } });
  const hookDeps = { diag: w.diag, store: w.store, environments: w.service };
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: webTree });
  const subject = (await w.service!.loadSubject("workspace", "ws-1"))!;
  await w.service!.refreshSubject(subject, "push");
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  const [first] = [...w.environmentStore.rows.values()];
  assertEquals(first.status, "ready");
  return { w, hookDeps, subject, first };
}

const workspaceRows = (w: Awaited<ReturnType<typeof world>>) =>
  [...w.environmentStore.rows.values()].filter((r) => r.subjectKind === "workspace");

test("a member that is not the environment repo adds .ryph/: the workspace builds now", async () => {
  const { w, hookDeps, first } = await builtWorkspace();
  w.clock.advance(HOUR);
  // web gains a setup.yml. Its own default branch moves; api, the environment repo, does not.
  w.setHead("acme/web", "main", { commit: sha("d"), tree: tree("w") });
  await onBranchUpdated(hookDeps, pushed(w.web, sha("d")), w.web);
  const builds = await w.builder.parked(2);
  assertEquals(builds.map((b) => b.spec.subjectKey).sort(), ["repo-cr-web", "workspace-ws-1"]);
  const [rebuilt] = workspaceRows(w).filter((r) => r.id !== first.id);
  assert(rebuilt.definition !== null && rebuilt.definition !== first.definition);
  assertEquals(rebuilt.commits, { api: sha("a"), web: sha("d") });
  for (const build of builds) build.succeed();
  await w.service!.idle();

  // Editing it again is a new definition again, still well inside the interval.
  w.clock.advance(HOUR);
  w.setHead("acme/web", "main", { commit: sha("e"), tree: tree("x") });
  await onBranchUpdated(hookDeps, pushed(w.web, sha("e")), w.web);
  const again = await w.builder.parked(2);
  assertEquals(again.map((b) => b.spec.subjectKey).sort(), ["repo-cr-web", "workspace-ws-1"]);
  for (const build of again) build.succeed();
  await w.service!.idle();
});

test("a member's setup.yml edit builds now, and warm from the last image: the machine is the same", async () => {
  const { w, subject, first } = await builtWorkspace(tree("w"));
  w.clock.advance(HOUR);
  w.setHead("acme/web", "main", { commit: sha("d"), tree: tree("x") });
  await w.service!.refreshSubject(subject, "push");
  const [build] = await w.builder.parked(1);
  const rebuilt = w.environmentStore.rows.get(build.spec.environmentId)!;
  assert(rebuilt.definition !== first.definition);
  assertEquals(rebuilt.plan.warmFrom?.environmentId, first.id);
  assertEquals(rebuilt.plan.depth, 1);
  assertEquals(build.spec.warmFrom, first.bakedImage);
  build.succeed();
  await w.service!.idle();
});

test("the environment repo's setup.yml edit builds warm too; its Dockerfile edit builds cold", async () => {
  const { w, subject, first } = await builtWorkspace();
  assertEquals(first.plan.machine, `dockerfile:${tree("a")}`);
  // api's .ryph/ moves, its Dockerfile does not.
  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", {
    commit: sha("b"),
    tree: tree("b"),
    dockerfile: true,
    dockerfileBlob: tree("a"),
  });
  await w.service!.refreshSubject(subject, "push");
  const [setupOnly] = await w.builder.parked(1);
  const warm = w.environmentStore.rows.get(setupOnly.spec.environmentId)!;
  assertEquals(warm.plan.warmFrom?.environmentId, first.id);
  setupOnly.succeed();
  await w.service!.idle();

  // Now the Dockerfile itself.
  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", { commit: sha("e"), tree: tree("e"), dockerfile: true });
  await w.service!.refreshSubject(subject, "push");
  const [dockerfile] = await w.builder.parked(1);
  const cold = w.environmentStore.rows.get(dockerfile.spec.environmentId)!;
  assertEquals(cold.plan.warmFrom, null);
  assertEquals(cold.plan.machine, `dockerfile:${tree("e")}`);
  assertEquals(dockerfile.spec.warmFrom, null);
  dockerfile.succeed();
  await w.service!.idle();
});

test("a member's code-only move still waits for the interval", async () => {
  const { w, hookDeps } = await builtWorkspace(tree("w"));
  // web's own environment, so its pushes have one already built.
  await w.service!.refreshSubject((await w.service!.loadSubject("repo", "cr-web"))!, "push");
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  const before = w.builder.specs.length;

  w.clock.advance(HOUR);
  w.setHead("acme/web", "main", { commit: sha("d"), tree: tree("w") });
  await onBranchUpdated(hookDeps, pushed(w.web, sha("d")), w.web);
  await settleAsync();
  assertEquals(w.builder.specs.length, before, "code only, an hour in: nothing");

  w.clock.advance(6 * HOUR);
  w.setHead("acme/web", "main", { commit: sha("e"), tree: tree("w") });
  await onBranchUpdated(hookDeps, pushed(w.web, sha("e")), w.web);
  const due = await w.builder.parked(2);
  assertEquals(due.map((b) => b.spec.subjectKey).sort(), ["repo-cr-web", "workspace-ws-1"]);
  for (const build of due) build.succeed();
  await w.service!.idle();
});

/** The same database under a control plane on a new harness. */
function deployedOnNewHarness(w: Awaited<ReturnType<typeof world>>) {
  const builder = fakeBuilder();
  const service = makeEnvironmentService({
    store: w.environmentStore,
    tasks: w.store,
    builder: builder.builder,
    logs: w.logs,
    forge: w.forge,
    diag: w.diag,
    now: w.clock.now,
    config: {
      ...w.config,
      environments: {
        ...w.config.environments,
        harnessImage: `registry.test/ryph-harness@sha256:${"9".repeat(64)}`,
      },
    },
  });
  return { builder, service };
}

test("a deploy never re-layers a stale definition: a member's .ryph/ moved, so a full build", async () => {
  const { w, first } = await builtWorkspace();
  // web gained a setup.yml and no event said so (a delivery lost, say).
  w.setHead("acme/web", "main", { commit: sha("d"), tree: tree("w") });
  const deployed = deployedOnNewHarness(w);
  await deployed.service.onBoot();
  const [build] = await deployed.builder.parked(1);
  assertEquals(build.spec.relayerFrom, null);
  assertEquals(build.spec.checkouts.map((c) => c.commit), [sha("a"), sha("d")]);
  const row = w.environmentStore.rows.get(build.spec.environmentId)!;
  assertEquals(row.trigger, "harness");
  assert(row.definition !== first.definition);
  build.succeed();
  await deployed.service.idle();
});

test("a re-layer keeps its source's definition and age: it never passes for a fresh build", async () => {
  const { w, hookDeps, first } = await builtWorkspace();
  w.clock.advance(5 * HOUR);
  // The deploy re-layers the image as it is: nothing in its definition moved.
  const deployed = deployedOnNewHarness(w);
  await deployed.service.onBoot();
  const [relayer] = await deployed.builder.parked(1);
  assertEquals(relayer.spec.relayerFrom !== null, true);
  relayer.succeed();
  await deployed.service.idle();
  const relayered = w.environmentStore.rows.get(relayer.spec.environmentId)!;
  assertEquals(relayered.definition, first.definition);

  const deployedDeps = { ...hookDeps, environments: deployed.service };
  w.clock.advance(HOUR);
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  await onBranchUpdated(deployedDeps, pushed(w.api, sha("b")), w.api);
  // Six hours since the tree in the image was cloned, one since the re-layer: the code is due.
  const due = await deployed.builder.parked(2);
  assertEquals(due.map((b) => b.spec.subjectKey).sort(), ["repo-cr-api", "workspace-ws-1"]);
  for (const build of due) assertEquals(build.spec.relayerFrom, null);
  for (const build of due) build.succeed();
  await deployed.service.idle();
});
