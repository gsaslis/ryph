// Which environment a run gets — every row of core/environment_resolve.ts's table, driven through startTask
// the way every door starts work, plus the harness re-layer wait, the fallbacks and the
// refusals. The builder is a fake the test settles by hand; nothing touches docker.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cancelRun } from "../src/core/cancel_run.ts";
import { AGENT_IMAGE, HARNESS, sha, T0, tree, world } from "./environment_world.ts";
import { fakeRunnerControl } from "./doubles.ts";
import { settleAsync } from "./environment_doubles.ts";
import type { Environment } from "../src/core/types.ts";

const kinds = (events: Array<{ kind: string }>) => events.map((e) => e.kind);

/** A ready default-branch image for acme/api, as if built earlier. */
function readyRow(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-old",
    subjectKind: "repo",
    subjectId: "cr-api",
    ref: "main",
    defaultBranch: true,
    commits: { api: sha("a") },
    definition: tree("a"),
    baseDigest: "base@sha256:x",
    harnessDigest: HARNESS,
    image: `registry.test/ryph-envs/repo-cr-api@sha256:${"9".repeat(64)}`,
    bakedImage: `registry.test/ryph-envs/repo-cr-api@sha256:${"8".repeat(64)}`,
    machineImage: null,
    status: "ready",
    toolchains: { rustc: "1.97.1" },
    sizeBytes: 1,
    trigger: "push",
    plan: {
      checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit: sha("a") }],
      dockerfileFrom: "api",
      cacheScope: { read: ["repo-cr-api"], write: "repo-cr-api" },
      relayerOf: null,
    },
    logRef: null,
    logTail: "built",
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

test("off: every run launches on RYPH_AGENT_IMAGE and the spec carries no environment", async () => {
  const w = await world({ environments: { enabled: false } });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  assertEquals(started.kind, "started");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environment, null);
  assertEquals(run.environmentId, null);
  assertEquals(w.launches.length, 1);
  assertEquals(w.builder.specs.length, 0);
  assertEquals(w.environmentStore.rows.size, 0);
});

test("no service wired at all is the same as off", async () => {
  const w = await world({ noService: true });
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals([run.image, run.environment], [AGENT_IMAGE, null]);
});

test("nothing ready and no .ryph at all: the default image, no wait, nothing built", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: null });
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.state, "starting");
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environment, {
    id: "default",
    image: AGENT_IMAGE,
    baked: false,
    commits: {},
    builtAt: null,
    toolchains: {},
    ref: null,
  });
  assertEquals(w.launches.length, 1);
  await settleAsync();
  assertEquals(w.environmentStore.rows.size, 0);
});

test("nothing ready, a .ryph with no Dockerfile: the default image now, a build behind it", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: false });
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environmentWait, null);
  assertEquals(w.launches.length, 1);
  const [build] = await w.builder.parked(1);
  // The universal image is the machine: no Dockerfile to build from.
  assertEquals(build.spec.dockerfileFrom, null);
  assertEquals(build.spec.cacheScope, { read: ["repo-cr-api"], write: "repo-cr-api" });
});

test("nothing ready and a Dockerfile: the run WAITS, then launches on the first build", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  assertEquals(started.kind, "started");
  const runId = (started as { runId: string }).runId;
  let run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "starting");
  assertEquals(run.handle, null);
  assertEquals(run.image, null);
  assert(run.environmentWait !== null);
  assertEquals(w.launches.length, 0, "no container while the machine is being built");
  assert(kinds(await w.store.listEvents(runId)).includes("environment.building"));

  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.dockerfileFrom, "api");
  assertEquals(build.spec.checkouts, [{
    path: "api",
    connectedRepoId: "cr-api",
    ref: "main",
    commit: sha("a"),
  }]);
  run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait?.status, "building");

  build.succeed();
  await w.service!.idle();
  run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.handle, `fake-${runId}`);
  assertStringIncludes(run.image!, "@sha256:");
  assertEquals(run.environment?.baked, true);
  assertEquals(run.environment?.commits, { api: sha("a") });
  assertEquals(run.environment?.toolchains, { rustc: "1.97.1" });
  assertEquals(w.launches.length, 1);
  assertEquals(w.launches[0].image, run.image);
  // Deferred launches use the same secret-free bootstrap contract.
  assert(w.launches[0].env.RYPH_BOOTSTRAP_TOKEN !== undefined);
  assertEquals(w.launches[0].env.RYPH_GIT_TOKEN, undefined);
  assertEquals(w.launches[0].env.RYPH_RUN_TOKEN, undefined);
  assertEquals(
    kinds(await w.store.listEvents(runId)).filter((k) =>
      k.startsWith("environment") || k === "launched"
    ),
    ["environment.building", "environment.building", "environment.ready", "launched"],
  );
});

test("a ready default-branch image is used at once, however old", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  // The branch has moved three commits since: still the same machine.
  w.setHead("acme/api", "main", { commit: sha("d"), tree: tree("b"), dockerfile: true });
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentId, "env-old");
  assertEquals(run.image, readyRow().image);
  assertEquals(run.environment?.baked, true);
  assertEquals(w.launches.length, 1);
  assertEquals(w.builder.specs.length, 0, "old is not wrong: nothing is built for the run");
});

test("a fork's head uses the default branch's image and never builds", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.kinds.set(w.key("acme/api", "fork-feature"), "foreign");
  w.setHead("acme/api", "fork-feature", { commit: sha("f"), tree: tree("f"), dockerfile: true });
  const started = await w.startRepo(w.api, "refs/heads/fork-feature");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentId, "env-old");
  await settleAsync();
  assertEquals(w.builder.specs.length, 0);
});

test("a branch whose .ryph equals the default branch's uses the default branch's image", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo(w.api, "feat");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentId, "env-old");
  assertEquals(w.builder.specs.length, 0);
});

test("a branch whose .ryph differs waits for its own image, which only its runs use", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  const started = await w.startRepo(w.api, "feat");
  const runId = (started as { runId: string }).runId;
  assert((await w.store.getRun(runId))!.environmentWait !== null);

  const [build] = await w.builder.parked(1);
  // A branch build reads the shared cache and writes none, and pushes as a branch build.
  assertEquals(build.spec.cacheScope, { read: ["repo-cr-api"], write: null });
  assertEquals(build.spec.defaultBranch, false);
  assertEquals(build.spec.checkouts[0].commit, sha("b"));
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`);
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.image, `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`);
  assertEquals(run.environment?.ref, "feat");

  // The next run on the branch finds it ready; a default-branch run keeps the old machine.
  const again = await w.startRepo(w.api, "feat");
  assertEquals((await w.store.getRun((again as { runId: string }).runId))!.image, run.image);
  const onMain = await w.startRepo();
  assertEquals(
    (await w.store.getRun((onMain as { runId: string }).runId))!.environmentId,
    "env-old",
  );
  assertEquals(w.builder.specs.length, 1);
});

test("a branch image whose setup.yml did not finish serves a later commit, which builds behind it", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  const [build] = await w.builder.parked(1);
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`, {
    setupWarnings: [{ kind: "invalid", path: "api", error: "setup.yml: not valid YAML" }],
  });
  await w.service!.idle();
  // The same commit: the image, and nothing built.
  await w.startRepo(w.api, "feat");
  await settleAsync();
  assertEquals(w.builder.specs.length, 1);
  // A newer commit, .ryph/ unchanged: the run launches on the image at once, and the commit —
  // which may be setup.yml's fix outside .ryph/ — is built behind it.
  w.setHead("acme/api", "feat", { commit: sha("c"), tree: tree("b"), dockerfile: true });
  const later = await w.startRepo(w.api, "feat");
  const run = (await w.store.getRun((later as { runId: string }).runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.image, `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`);
  const [rebuild] = await w.builder.parked(1);
  assertEquals(rebuild.spec.checkouts[0].commit, sha("c"));
  rebuild.succeed();
  await w.service!.idle();
});

test("a branch whose setup step fails at every build: one build behind a run per episode, not one per run", async () => {
  const w = await world();
  const image = `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`;
  const warned = {
    setupWarnings: [{
      kind: "step" as const,
      path: "api",
      step: "make seed",
      index: 1,
      total: 1,
      code: 1,
      output: "no database",
      discarded: false,
    }],
  };
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  (await w.builder.parked(1))[0].succeed(image, warned);
  await w.service!.idle();
  // The first new commit is built behind its run, and warns the same way.
  w.setHead("acme/api", "feat", { commit: sha("c"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  (await w.builder.parked(1))[0].succeed(image, warned);
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 2);
  // Every later commit's run launches on the image, and builds nothing.
  for (const c of ["d", "e", "f"]) {
    w.setHead("acme/api", "feat", { commit: sha(c), tree: tree("b"), dockerfile: true });
    const later = await w.startRepo(w.api, "feat");
    const run = (await w.store.getRun((later as { runId: string }).runId))!;
    assertEquals(run.environmentWait, null);
    await settleAsync();
  }
  assertEquals(w.builder.specs.length, 2);
});

test("a branch whose early build after a warning fails: that ends the episode, later runs build nothing", async () => {
  const w = await world();
  const image = `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`;
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  (await w.builder.parked(1))[0].succeed(image, {
    setupWarnings: [{ kind: "invalid", path: "api", error: "setup.yml: not valid YAML" }],
  });
  await w.service!.idle();
  // The first new commit is built early, behind its run, and that build fails.
  w.setHead("acme/api", "feat", { commit: sha("c"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  (await w.builder.parked(1))[0].fail("the registry refused the push");
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 2);
  // Every later commit's run launches on the warned image, and queues no doomed build.
  for (const c of ["d", "e", "f"]) {
    w.setHead("acme/api", "feat", { commit: sha(c), tree: tree("b"), dockerfile: true });
    const later = await w.startRepo(w.api, "feat");
    const run = (await w.store.getRun((later as { runId: string }).runId))!;
    assertEquals(run.environmentWait, null);
    assertEquals(run.image, image);
    await settleAsync();
  }
  assertEquals(w.builder.specs.length, 2);
});

test("a branch build still queued on an older harness holds off the early build after a warning", async () => {
  const w = await world();
  const image = `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`;
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.startRepo(w.api, "feat");
  const [first] = await w.builder.parked(1);
  first.succeed(image, {
    setupWarnings: [{ kind: "invalid", path: "api", error: "setup.yml: not valid YAML" }],
  });
  await w.service!.idle();
  const warned = (await w.environmentStore.getEnvironment(first.spec.environmentId))!;
  await w.environmentStore.createEnvironment({
    ...warned,
    id: "env-queued-old-harness",
    status: "queued",
    image: null,
    setupWarnings: null,
    harnessDigest: "quay.io/ryph/ryph-harness@sha256:old",
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(Date.parse(warned.createdAt) + 1).toISOString(),
  });
  w.setHead("acme/api", "feat", { commit: sha("c"), tree: tree("b"), dockerfile: true });
  const later = await w.startRepo(w.api, "feat");
  const run = (await w.store.getRun((later as { runId: string }).runId))!;
  assertEquals(run.image, image);
  await settleAsync();
  assertEquals(w.builder.specs.length, 1);
});

test("a branch behind a main that moved its .ryph changed nothing: main's machine, no build", async () => {
  // the branch forked when main's `.ryph/` was tree(a); main moved on to tree(m).
  // The branch still carries tree(a) — different from main's head, but not a change it made,
  // and it merges into main's machine.
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("m"), tree: tree("m"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  w.bases.set(sha("b"), { base: sha("m"), mergeBase: sha("a"), tree: tree("a"), changed: [] });
  const started = await w.startRepo(w.api, "feat");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.environmentId, "env-old");
  await settleAsync();
  assertEquals(w.builder.specs.length, 0);
});

test("a branch that changed .ryph since its merge base waits for its own build, which says why", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("m"), tree: tree("m"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  w.bases.set(sha("b"), {
    base: sha("m"),
    mergeBase: sha("a"),
    tree: tree("a"),
    changed: [".ryph/Dockerfile"],
  });
  const started = await w.startRepo(w.api, "feat");
  assert((await w.store.getRun((started as { runId: string }).runId))!.environmentWait !== null);
  const [build] = await w.builder.parked(1);
  const row = [...w.environmentStore.rows.values()].find((r) => r.ref === "feat")!;
  assertEquals(row.trigger, "run");
  assertStringIncludes(
    row.reason!,
    "a run on feat needed it: feat changed .ryph/ (.ryph/Dockerfile)",
  );
  build.succeed();
  await w.service!.idle();
});

test("a branch that edited setup.yml alone waits for nothing: same machine", async () => {
  // The case that sent a real run into `waiting`: neither ref carries a Dockerfile, so
  // both machines are the universal image and the only difference is a `setup.yml` the run
  // re-runs from its own checkout anyway.
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: false });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: false });
  const started = await w.startRepo(w.api, "feat");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.environmentId, "env-old");
  // And nothing was built for the branch.
  assertEquals(w.builder.specs.length, 0);
});

test("a branch that deleted .ryph describes no machine: the default image", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "plain", { commit: sha("c"), tree: null });
  const started = await w.startRepo(w.api, "plain");
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  assertEquals([run.image, run.environment?.id], [AGENT_IMAGE, "default"]);
});

test("a build that fails refuses the run waiting for it, with the log's tail", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  const [build] = await w.builder.parked(1);
  build.fail("cargo-nextest could not be installed");
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "errored");
  assertEquals(run.environmentWait, null);
  assertEquals(w.launches.length, 0);
  const failed = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.failed")!;
  assertStringIncludes(failed.detail!, "cargo-nextest could not be installed");

  // The same inputs again: refused at the door, with the log, and nothing persisted.
  const tasksBefore = (await w.store.listTasks()).tasks.length;
  const refused = await w.startRepo();
  assertEquals(refused.kind, "refused");
  if (refused.kind !== "refused") return;
  assertEquals(refused.status, 409);
  assertStringIncludes(refused.error, "failed to build");
  assertStringIncludes(refused.error, "cargo-nextest could not be installed");
  assertEquals(refused.about?.connectedRepoId, "cr-api");
  assertEquals((await w.store.listTasks()).tasks.length, tasksBefore);

  // A new commit is a new attempt.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  const retried = await w.startRepo();
  assertEquals(retried.kind, "started");
  await w.builder.parked(1);
});

test("a build whose setup.yml did not finish launches the waiting run, and the next one, never refuses", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  const [build] = await w.builder.parked(1);
  // A setup step failed in the bake: a warning on a ready build, not a failed one.
  build.succeed(undefined, {
    setupWarnings: [{
      kind: "step",
      path: "api",
      step: "npm ci",
      index: 1,
      total: 1,
      code: 1,
      output: "",
      discarded: false,
    }],
  });
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.handle, `fake-${runId}`);
  assertEquals(w.launches.length, 1);
  // The same inputs again: the image, at once.
  const again = await w.startRepo();
  assertEquals(again.kind, "started");
  assertEquals(w.launches.length, 2);
});

test("an image on an old harness layer waits for its re-layer, then launches on it", async () => {
  const w = await world();
  const stale = readyRow({ harnessDigest: "quay.io/ryph/ryph-harness@sha256:old" });
  await w.environmentStore.createEnvironment(stale);
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  assertEquals((await w.store.getRun(runId))!.environmentWait !== null, true);
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.harnessImage, HARNESS);
  // Stage 4 only, on the image's own baked stage: nothing cloned, nothing baked again.
  assertEquals(build.spec.relayerFrom, stale.bakedImage);
  assertEquals(build.spec.clone, { urls: {}, env: {} });
  assertEquals(build.spec.baseImage, stale.baseDigest);
  assertEquals(build.spec.checkouts, stale.plan.checkouts);
  build.succeed();
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assert(run.environmentId !== "env-old");
  assertEquals(run.handle, `fake-${runId}`);
  // A second run meanwhile joins the same re-layer rather than queueing another: covered by
  // the build being ready now.
  const next = await w.startRepo();
  assertEquals(
    (await w.store.getRun((next as { runId: string }).runId))!.environmentId,
    run.environmentId,
  );
});

test("a re-layer that failed is not asked for again: the next run builds the branch's head", async () => {
  const w = await world();
  // Built at a commit a force-push has since taken off main.
  const stale = readyRow({ harnessDigest: "quay.io/ryph/ryph-harness@sha256:old" });
  await w.environmentStore.createEnvironment(stale);
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  const first = await w.startRepo();
  const [relayer] = await w.builder.parked(1);
  assertEquals(relayer.spec.relayerFrom, stale.bakedImage);
  relayer.fail("the harness does not start on this base");
  await w.service!.idle();
  assertEquals((await w.store.getRun((first as { runId: string }).runId))!.state, "errored");

  // The next run: no second re-layer of the same image, but a full build of main as it is now.
  const next = await w.startRepo();
  const runId = (next as { runId: string }).runId;
  assert((await w.store.getRun(runId))!.environmentWait !== null);
  const [full] = await w.builder.parked(1);
  assertEquals(full.spec.relayerFrom, null);
  assertEquals(full.spec.checkouts.map((c) => c.commit), [sha("b")]);
  assertEquals(full.spec.baseImage, w.config.environments.baseImage);
  full.succeed();
  await w.service!.idle();
  assert((await w.store.getRun(runId))!.handle !== null);
  // The re-layer was asked for once.
  assertEquals(w.builder.specs.filter((spec) => spec.relayerFrom !== null).length, 1);
});

test("the forge cannot be asked: the newest ready image, with an event", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.unreachable.value = true;
  const started = await w.startRepo(w.api, "feat");
  const runId = (started as { runId: string }).runId;
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentId, "env-old");
  const fallback = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.fallback");
  assertStringIncludes(fallback!.detail!, "could not say whose branch");
});

test("the forge cannot be asked and nothing is ready: the default image, with an event", async () => {
  const w = await world();
  w.unreachable.value = true;
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(w.launches.length, 1);
  assert(kinds(await w.store.listEvents(runId)).includes("environment.fallback"));
});

test("the builder is down: a run that would wait falls back instead", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  // The first build finds the registry down — refused — and its waiter is refused with it.
  const first = await w.startRepo();
  const [build] = await w.builder.parked(1);
  build.fail("registry unreachable", "refused");
  await w.service!.idle();
  assertEquals((await w.store.getRun((first as { runId: string }).runId))!.state, "errored");
  assertEquals(w.service!.builderFault(), "registry unreachable");

  // The next run does not wait on a builder that is known to be down.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  const next = await w.startRepo();
  const runId = (next as { runId: string }).runId;
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environmentWait, null);
  const fallback = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.fallback");
  assertStringIncludes(fallback!.detail!, "builder is not answering");
});

test("a backend with no builder (manual) runs everything on the default image, silently", async () => {
  const w = await world({ builderKind: "manual" });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  assertEquals((await w.store.getRun(runId))!.image, AGENT_IMAGE);
  assertEquals(kinds(await w.store.listEvents(runId)), ["created", "launched"]);
  assertEquals(w.environmentStore.rows.size, 0);
});

test("cancelling a waiting run ends it at once and calls off the branch build it asked for", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  const started = await w.startRepo(w.api, "feat");
  const runId = (started as { runId: string }).runId;
  const [build] = await w.builder.parked(1);
  const outcome = await cancelRun(
    {
      store: w.store,
      runnerControl: fakeRunnerControl().control,
      environments: w.service,
      now: w.clock.now,
    },
    (await w.store.getRun(runId))!,
  );
  assertEquals(outcome.kind, "applied");
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "cancelled");
  assertEquals(run.environmentWait, null);
  await w.service!.idle();
  assert(build.signal.aborted, "the build nobody waits for any more was aborted");
  const row = w.environmentStore.rows.get(build.spec.environmentId)!;
  assertEquals([row.status, row.failure], ["superseded", "the run waiting for it was cancelled"]);
  assertEquals(w.launches.length, 0);
});

test("a default-branch first build is NOT called off when its waiter is cancelled", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const [build] = await w.builder.parked(1);
  await cancelRun(
    {
      store: w.store,
      runnerControl: fakeRunnerControl().control,
      environments: w.service,
      now: w.clock.now,
    },
    (await w.store.getRun((started as { runId: string }).runId))!,
  );
  assertEquals(build.signal.aborted, false);
  build.succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(build.spec.environmentId)!.status, "ready");
  assertEquals(w.launches.length, 0, "the cancelled run never launches");
});

/** Marks a waiting run's build ready behind the service's back, as a replica that died after
 * its settle but before telling the waiters would leave it. */
function readyBehindTheBack(w: Awaited<ReturnType<typeof world>>, environmentId: string) {
  const row = w.environmentStore.rows.get(environmentId)!;
  w.environmentStore.rows.set(row.id, {
    ...row,
    status: "ready",
    image: `registry.test/x@sha256:${"d".repeat(64)}`,
    bakedImage: `registry.test/x@sha256:${"c".repeat(64)}`,
    finishedAt: w.clock.now().toISOString(),
  });
}

test("a waiting run settled by two callers at once launches once", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  const [build] = await w.builder.parked(1);
  readyBehindTheBack(w, build.spec.environmentId);
  // The build's settle hook and the reaper's backstop, holding the same waiting run.
  const run = (await w.store.getRun(runId))!;
  await Promise.all([w.wired!.settleWaitingRun(run), w.wired!.settleWaitingRun(run)]);
  assertEquals(w.launches.length, 1);
  const events = kinds(await w.store.listEvents(runId));
  assertEquals(events.filter((k) => k === "environment.ready").length, 1);
  assertEquals(events.filter((k) => k === "launched").length, 1);
  build.succeed();
  await w.service!.idle();
  assertEquals(w.launches.length, 1);
});

test("a cancel racing the launch of a waiting run either stops it or is carried to it", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  const [build] = await w.builder.parked(1);
  readyBehindTheBack(w, build.spec.environmentId);
  const run = (await w.store.getRun(runId))!;
  await Promise.all([
    w.wired!.settleWaitingRun(run),
    cancelRun(
      {
        store: w.store,
        runnerControl: fakeRunnerControl().control,
        environments: w.service,
        now: w.clock.now,
      },
      run,
    ),
  ]);
  const after = (await w.store.getRun(runId))!;
  // Never a launch that forgot the cancel: launched means the cancel is on its record.
  if (w.launches.length === 0) {
    assertEquals(after.state, "cancelled");
  } else {
    assertEquals(w.launches.length, 1);
    assertEquals(after.desiredState, "cancelled");
  }
  build.succeed();
  await w.service!.idle();
});

test("a cancelled waiting run is never launched by a settle holding its old copy", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  const [build] = await w.builder.parked(1);
  const stale = (await w.store.getRun(runId))!;
  await cancelRun(
    {
      store: w.store,
      runnerControl: fakeRunnerControl().control,
      environments: w.service,
      now: w.clock.now,
    },
    stale,
  );
  readyBehindTheBack(w, build.spec.environmentId);
  await w.wired!.settleWaitingRun(stale);
  assertEquals(w.launches.length, 0);
  assertEquals((await w.store.getRun(runId))!.state, "cancelled");
  build.succeed();
  await w.service!.idle();
});

test("a workspace that pins its environment repo at another ref builds and runs on that ref", async () => {
  const w = await world();
  const [api] = await w.store.listWorkspaceRepos("ws-1");
  await w.store.saveWorkspaceRepo({ ...api, ref: "develop" });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "develop", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: null });
  // The workspace's ordinary run starts api at develop: its "default", built as the shared image.
  const started = await w.startWorkspace();
  const runId = (started as { runId: string }).runId;
  assert((await w.store.getRun(runId))!.environmentWait !== null);
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.defaultBranch, true);
  assertEquals(build.spec.cacheScope, { read: ["workspace-ws-1"], write: "workspace-ws-1" });
  assertEquals(build.spec.checkouts.map((c) => [c.path, c.ref, c.commit]), [
    ["api", "develop", sha("b")],
    ["web", "main", sha("c")],
  ]);
  build.succeed();
  await w.service!.idle();
  assert((await w.store.getRun(runId))!.handle !== null);
  // The next ordinary run is on that image, without asking for a branch build.
  const next = await w.startWorkspace();
  const nextRun = (await w.store.getRun((next as { runId: string }).runId))!;
  assertEquals(nextRun.environmentId, build.spec.environmentId);
  assertEquals(w.builder.specs.length, 1);
  // And the refresh a push or the reconcile runs builds develop, not main.
  w.setHead("acme/api", "develop", { commit: sha("d"), tree: tree("d"), dockerfile: true });
  await w.service!.refreshSubject((await w.service!.loadSubject("workspace", "ws-1"))!, "push");
  const [refreshed] = await w.builder.parked(1);
  assertEquals(refreshed.spec.checkouts[0].ref, "develop");
  assertEquals(refreshed.spec.checkouts[0].commit, sha("d"));
  refreshed.succeed();
  await w.service!.idle();
});

test("a workspace builds one machine from its environment repo, every member baked in order", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("c"), dockerfile: true });
  const started = await w.startWorkspace();
  const runId = (started as { runId: string }).runId;
  const [build] = await w.builder.parked(1);
  // The first member is the environment repo by default.
  assertEquals(build.spec.subjectKey, "workspace-ws-1");
  assertEquals(build.spec.dockerfileFrom, "api");
  assertEquals(build.spec.checkouts.map((c) => [c.path, c.commit]), [["api", sha("a")], [
    "web",
    sha("c"),
  ]]);
  build.succeed();
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environment?.commits, { api: sha("a"), web: sha("c") });

  // An admin names web the environment repo: the next build takes web's Dockerfile.
  await w.store.updateWorkspace("ws-1", {
    name: "Shop",
    description: null,
    sizeClass: null,
    environmentRepoId: "cr-web",
    updatedAt: T0,
  });
  await w.service!.refreshSubject((await w.service!.loadSubject("workspace", "ws-1"))!, "manual");
  const [second] = await w.builder.parked(1);
  assertEquals(second.spec.dockerfileFrom, "web");
  assertEquals(second.spec.checkouts.map((c) => c.path), ["api", "web"]);
});

test("a single-repo run of a workspace member uses the repo's own environment", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(readyRow());
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-ws", subjectKind: "workspace", subjectId: "ws-1" }),
  );
  const started = await w.startRepo();
  assertEquals(
    (await w.store.getRun((started as { runId: string }).runId))!.environmentId,
    "env-old",
  );
});

test("a workspace branch that changes the environment repo's .ryph waits for its own build", async () => {
  const w = await world();
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-ws", subjectKind: "workspace", subjectId: "ws-1" }),
  );
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: null });
  const started = await w.startWorkspace({ "cr-api": "feat" });
  const runId = (started as { runId: string }).runId;
  assert((await w.store.getRun(runId))!.environmentWait !== null);
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.checkouts.map((c) => [c.path, c.ref, c.commit]), [
    ["api", "feat", sha("b")],
    ["web", "main", sha("c")],
  ]);
  assertEquals(build.spec.cacheScope, { read: ["workspace-ws-1"], write: null });
});

test("a workspace branch's own image is found again by its whole definition", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("w") });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-ws", subjectKind: "workspace", subjectId: "ws-1" }),
  );
  const first = await w.startWorkspace({ "cr-api": "feat" });
  const [build] = await w.builder.parked(1);
  const row = w.environmentStore.rows.get(build.spec.environmentId)!;
  assert(row.definition !== null && row.definition.startsWith("sha256:"));
  build.succeed();
  await w.service!.idle();
  assertEquals(
    (await w.store.getRun((first as { runId: string }).runId))!.environmentId,
    row.id,
  );

  // The next run on the branch launches on it at once: nothing new to build.
  const second = await w.startWorkspace({ "cr-api": "feat" });
  assertEquals(
    (await w.store.getRun((second as { runId: string }).runId))!.environmentId,
    row.id,
  );
  assertEquals(w.builder.specs.length, 1);

  // web's .ryph/ moving on its ref is a new definition for the branch: a build of its own.
  w.setHead("acme/web", "main", { commit: sha("d"), tree: tree("x") });
  const third = await w.startWorkspace({ "cr-api": "feat" });
  assert((await w.store.getRun((third as { runId: string }).runId))!.environmentWait !== null);
  const [next] = await w.builder.parked(1);
  assert(w.environmentStore.rows.get(next.spec.environmentId)!.definition !== row.definition);
  next.succeed();
  await w.service!.idle();
});

test("a member the forge cannot read keeps a workspace branch on its own ready image", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("w") });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-ws", subjectKind: "workspace", subjectId: "ws-1" }),
  );
  await w.startWorkspace({ "cr-api": "feat" });
  const [build] = await w.builder.parked(1);
  build.succeed();
  await w.service!.idle();
  const own = build.spec.environmentId;

  // web is a slow Radicle seed now: every read of it fails, api's still answer.
  const original = w.forge.ryphTree.bind(w.forge);
  w.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/web"
      ? Promise.reject(new Error("over the git door's budget"))
      : original(repo, url, ref);
  const started = await w.startWorkspace({ "cr-api": "feat" });
  const runId = (started as { runId: string }).runId;
  assertEquals((await w.store.getRun(runId))!.environmentId, own);
  const fallback = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.fallback");
  assertStringIncludes(fallback!.detail!, "feat's newest ready environment");
  assertEquals(w.builder.specs.length, 1);
});

test("a member the forge cannot read, and no own image: the fallback as before", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/api", "feat", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.environmentStore.createEnvironment(
    readyRow({ id: "env-ws", subjectKind: "workspace", subjectId: "ws-1" }),
  );
  const original = w.forge.ryphTree.bind(w.forge);
  w.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/web"
      ? Promise.reject(new Error("over the git door's budget"))
      : original(repo, url, ref);
  const started = await w.startWorkspace({ "cr-api": "feat" });
  const runId = (started as { runId: string }).runId;
  assertEquals((await w.store.getRun(runId))!.environmentId, "env-ws");
  const fallback = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.fallback");
  assertStringIncludes(fallback!.detail!, "could not read feat's .ryph directories");
});

test("a member the forge cannot read still waits for the first build already under way", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("w") });
  const first = await w.startWorkspace();
  const [build] = await w.builder.parked(1);

  const original = w.forge.ryphTree.bind(w.forge);
  w.forge.ryphTree = (repo, url, ref) =>
    repo.repoRef === "acme/web"
      ? Promise.reject(new Error("over the git door's budget"))
      : original(repo, url, ref);
  const second = await w.startWorkspace();
  const runId = (second as { runId: string }).runId;
  assertEquals(
    (await w.store.getRun(runId))!.environmentWait?.environmentId,
    build.spec.environmentId,
  );
  assertEquals(w.launches.length, 0, "never on the universal image while its machine is built");

  build.succeed();
  await w.service!.idle();
  for (const started of [first, second]) {
    const run = (await w.store.getRun((started as { runId: string }).runId))!;
    assertEquals(run.environmentId, build.spec.environmentId);
  }
  assertEquals(w.builder.specs.length, 1);
});

test("planFor reads every member at once, and keeps member order", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: tree("w") });
  const original = w.forge.ryphTree.bind(w.forge);
  let inFlight = 0;
  let most = 0;
  w.forge.ryphTree = async (repo, url, ref) => {
    inFlight++;
    most = Math.max(most, inFlight);
    // api, first in member order, answers last.
    await new Promise((r) => setTimeout(r, repo.repoRef === "acme/api" ? 20 : 0));
    inFlight--;
    return await original(repo, url, ref);
  };
  const subject = (await w.service!.loadSubject("workspace", "ws-1"))!;
  const plan = await w.service!.planFor(subject, "main");
  assertEquals(most, 2);
  assertEquals(plan.checkouts.map((c) => [c.path, c.commit]), [["api", sha("a")], [
    "web",
    sha("c"),
  ]]);
  assertEquals(plan.dockerfile, true);
});
