// The build scheduler: the queue and its deployment-wide cap, the wall-clock cap, supersede and
// abort, what a build is handed (cache scopes, the egress claim, the clone and its credential),
// what it leaves behind (status, log, tail), orphans, and retention.

import { toEnvironmentView } from "../src/http/environments_api.ts";
import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BRANCH_IMAGE_TTL_MS,
  CACHE_RETIRED_GRACE_MS,
  IMAGE_REMOVAL_BATCH,
  IMAGE_REMOVAL_EVERY_MS,
  IMAGE_REMOVAL_FAILURES,
  IMAGE_REMOVAL_GRACE_MS,
  makeEnvironmentService,
  ORPHAN_GRACE_MS,
  RECONCILE_EVERY_MS,
  registryHosts,
  STRANDED_AFTER_MS,
} from "../src/core/environments.ts";
import type { AdoptResult, AdoptSpec } from "../src/ports/environment_builder.ts";
import type { Environment } from "../src/core/types.ts";
import { HARNESS, sha, T0, tree, world } from "./environment_world.ts";
import { fakeBuilder, settleAsync } from "./environment_doubles.ts";

/**
 * A SECOND control plane over the same database: its own builder and its own in-flight map, which
 * is the whole of what distinguishes one replica from another here.
 */
function replica(
  w: Awaited<ReturnType<typeof world>>,
  opts: { adopt?: (spec: AdoptSpec) => AdoptResult | Promise<AdoptResult> } = {},
) {
  const builder = fakeBuilder({ adopt: opts.adopt });
  const service = makeEnvironmentService({
    store: w.environmentStore,
    tasks: w.store,
    builder: builder.builder,
    logs: w.logs,
    forge: w.forge,
    diag: w.diag,
    now: w.clock.now,
    config: w.config,
  });
  return { service, builder };
}

async function subject(
  w: Awaited<ReturnType<typeof world>>,
  kind: "repo" | "workspace",
  id: string,
) {
  return (await w.service!.loadSubject(kind, id))!;
}

/** Queues a default-branch build of acme/api at `commit`. */
async function queueApi(w: Awaited<ReturnType<typeof world>>, commit: string, treeId = tree("a")) {
  return await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-api"),
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit }],
    definition: treeId,
    dockerfile: true,
    machine: null,
    trigger: "push",
  });
}

function decodeClaim(token: string): { r: string; e: number; h: string[] } {
  const payload = token.split(".")[1];
  const b64 = payload.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)));
}

test("builds run at most RYPH_ENV_BUILD_CONCURRENCY at once, deployment-wide, oldest first", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  const first = await queueApi(w, sha("a"));
  const second = await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-web"),
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "web", connectedRepoId: "cr-web", ref: "main", commit: sha("c") }],
    definition: tree("c"),
    dockerfile: false,
    machine: null,
    trigger: "push",
  });
  const [running] = await w.builder.parked(1);
  await settleAsync();
  assertEquals(w.builder.pending.length, 1, "the second waits for a slot");
  assertEquals(running.spec.environmentId, first.id);
  assertEquals(w.environmentStore.rows.get(second.id)!.status, "queued");

  running.succeed();
  const [next] = await w.builder.parked(1);
  assertEquals(next.spec.environmentId, second.id);
  next.succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "ready");
  assertEquals(w.environmentStore.rows.get(second.id)!.status, "ready");
});

test("a ready build records its image, size, toolchains, tail, and its whole log in the store", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  await w.service!.idle();
  const ready = w.environmentStore.rows.get(row.id)!;
  assertEquals(ready.status, "ready");
  assertEquals(ready.image, `registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  assertEquals(ready.sizeBytes, 3 * 1024 ** 3);
  assertEquals(ready.toolchains, { rustc: "1.97.1" });
  assertEquals(ready.logRef, `environments/${row.id}.log`);
  assertEquals(ready.logTail, "step 1\nstep 2\nbuilt");
  assertEquals(await w.service!.readLog(ready), "step 1\nstep 2\nbuilt\n");
  assert(ready.startedAt !== null && ready.finishedAt !== null);
  // Every repo's setup finished: no warnings on the row.
  assertEquals(ready.setupWarnings, null);
});

test("a build whose setup.yml did not finish is READY, and carries the warning on its row", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  const warning = { kind: "invalid" as const, path: "api", error: "setup.yml: not valid YAML" };
  build.succeed(undefined, { setupWarnings: [warning] });
  await w.service!.idle();
  const ready = w.environmentStore.rows.get(row.id)!;
  assertEquals(ready.status, "ready");
  assertEquals(ready.failure, null);
  assertEquals(ready.setupWarnings, [warning]);
  // The card says it, as a summary line and the parser's words apart.
  assertEquals(toEnvironmentView(ready).setupWarnings, [{
    path: "api",
    kind: "invalid",
    summary:
      "`api/`: `.ryph/setup.yml` is invalid, so none of its steps ran, and the build went on.",
    detail: "setup.yml: not valid YAML",
  }]);
});

test("a failed build keeps its reason and log tail; a builder that throws is a fault", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  build.fail("apt-get: package not found");
  await w.service!.idle();
  const failed = w.environmentStore.rows.get(row.id)!;
  assertEquals(failed.status, "failed");
  assertEquals(failed.failure, "apt-get: package not found");
  assertEquals(failed.logTail, "error: apt-get: package not found");
  assertEquals(
    w.service!.builderFault(),
    null,
    "a repo's broken Dockerfile is not a builder fault",
  );

  const thrower = await world({
    auto: () => {
      throw new Error("adapter bug");
    },
  });
  const bad = await queueApi(thrower, sha("a"));
  await settleAsync();
  await thrower.service!.idle();
  assertEquals(thrower.environmentStore.rows.get(bad.id)!.status, "failed");
  assertEquals(thrower.service!.builderFault(), "adapter bug");
});

test("a build past RYPH_ENV_BUILD_TIMEOUT is aborted and failed, and its slot freed", async () => {
  const w = await world({ environments: { buildTimeoutMs: 20, buildConcurrency: 1 } });
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.timeoutMs, 20);
  // The adapter here ignores its timeout; the core's own cap still ends it.
  for (let i = 0; i < 100 && !build.signal.aborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert(build.signal.aborted);
  await w.service!.idle();
  const failed = w.environmentStore.rows.get(row.id)!;
  assertEquals(failed.status, "failed");
  assertStringIncludes(failed.failure!, "RYPH_ENV_BUILD_TIMEOUT");
});

test("an adapter that never answers is abandoned past the grace: slot, row and waiters freed", async () => {
  const w = await world({
    environments: { buildTimeoutMs: 20, buildConcurrency: 1 },
    abandonGraceMs: 20,
  });
  // A builder whose API call hangs: it neither returns nor hears the abort.
  w.builder.builder.build = () => new Promise(() => {});
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  await w.service!.idle();
  const row = [...w.environmentStore.rows.values()][0];
  assertEquals(row.status, "failed");
  assertStringIncludes(row.failure!, "RYPH_ENV_BUILD_TIMEOUT");
  assertEquals((await w.store.getRun(runId))!.state, "errored");
  assert(w.diagEvents.some((e) => e.event === "environments.build_abandoned"));
});

test("a build of the same inputs is the same build; an unforced ask for built inputs is the image", async () => {
  const w = await world();
  const first = await queueApi(w, sha("a"));
  assertEquals((await queueApi(w, sha("a"))).id, first.id, "a redelivery joins the build");
  const [build] = await w.builder.parked(1);
  build.succeed();
  await w.service!.idle();
  assertEquals((await queueApi(w, sha("a"))).id, first.id, "already built: nothing to do");
  const forced = await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-api"),
    ref: "main",
    defaultBranch: true,
    checkouts: first.plan.checkouts,
    definition: first.definition,
    dockerfile: true,
    machine: null,
    trigger: "manual",
    force: true,
  });
  assert(forced.id !== first.id, "Rebuild builds anyway");
});

test("a newer build of a branch supersedes older ones nobody waits for — queued or running", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  // Another subject's build holds the only slot, so api's builds queue behind it.
  await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-web"),
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "web", connectedRepoId: "cr-web", ref: "main", commit: sha("c") }],
    definition: tree("c"),
    dockerfile: false,
    machine: null,
    trigger: "push",
  });
  const [occupying] = await w.builder.parked(1);
  const stale = await queueApi(w, sha("a"));
  const newer = await queueApi(w, sha("b"));
  assertEquals(w.environmentStore.rows.get(stale.id)!.status, "superseded", "never started");

  occupying.succeed();
  const [running] = await w.builder.parked(1);
  assertEquals(running.spec.environmentId, newer.id);
  const newest = await queueApi(w, sha("c"), tree("c"));
  await settleAsync();
  assert(running.signal.aborted, "the running one is aborted");
  assertEquals(w.environmentStore.rows.get(newer.id)!.status, "superseded");
  const [latest] = await w.builder.parked(1);
  assertEquals(latest.spec.environmentId, newest.id);
  latest.succeed();
  await w.service!.idle();
  // Supersede is never rewritten by the aborted build's own settle.
  assertEquals(w.environmentStore.rows.get(newer.id)!.status, "superseded");
  assertEquals(w.environmentStore.rows.get(newest.id)!.status, "ready");
  assertEquals(w.builder.specs.map((s) => s.environmentId).includes(stale.id), false);
});

test("a build a run waits for is never superseded out from under it", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const [build] = await w.builder.parked(1);
  await queueApi(w, sha("b"), tree("b"));
  await settleAsync();
  assertEquals(build.signal.aborted, false);
  build.succeed();
  // The newer build queued behind it runs next.
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  assert((await w.store.getRun((started as { runId: string }).runId))!.handle !== null);
});

/** A Rebuild of exactly the inputs `of` was built from. */
async function rebuildOf(w: Awaited<ReturnType<typeof world>>, of: Environment) {
  return await w.service!.enqueue({
    subject: await subject(w, "repo", of.subjectId),
    ref: of.ref,
    defaultBranch: of.defaultBranch,
    checkouts: of.plan.checkouts,
    definition: of.definition,
    dockerfile: true,
    machine: null,
    trigger: "manual",
    force: true,
  });
}

test("a Rebuild while the same inputs build supersedes that build; any other ask joins it", async () => {
  const w = await world();
  const first = await queueApi(w, sha("a"));
  const [running] = await w.builder.parked(1);
  const rebuilt = await rebuildOf(w, first);
  assert(rebuilt.id !== first.id, "a fresh build, not the one going");
  await settleAsync();
  assert(running.signal.aborted, "the build it replaces is aborted");
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "superseded");
  assertEquals((await queueApi(w, sha("a"))).id, rebuilt.id, "a push joins the Rebuild");
  const [fresh] = await w.builder.parked(1);
  assertEquals(fresh.spec.environmentId, rebuilt.id);
  fresh.succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(rebuilt.id)!.status, "ready");
});

test("a Rebuild takes over the runs waiting on the build it replaces", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const runId = ((await w.startRepo()) as { runId: string }).runId;
  const [doomed] = await w.builder.parked(1);
  const old = w.environmentStore.rows.get(doomed.spec.environmentId)!;
  const rebuilt = await rebuildOf(w, old);
  await settleAsync();
  assert(doomed.signal.aborted, "nobody waits for the old build any more");
  assertEquals(w.environmentStore.rows.get(old.id)!.status, "superseded");
  const waiting = (await w.store.getRun(runId))!;
  assertEquals(waiting.state, "starting");
  assertEquals(waiting.environmentWait?.environmentId, rebuilt.id);

  const [fresh] = await w.builder.parked(1);
  fresh.succeed();
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.environmentId, rebuilt.id);
  assertEquals(w.launches.length, 1);
});

test("a run that starts waiting on a build after a Rebuild superseded it follows the Rebuild", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const runId = ((await w.startRepo()) as { runId: string }).runId;
  const [doomed] = await w.builder.parked(1);
  const old = w.environmentStore.rows.get(doomed.spec.environmentId)!;
  const rebuilt = await rebuildOf(w, old);
  await settleAsync();
  assertEquals(w.environmentStore.rows.get(old.id)!.status, "superseded");
  // The run's ask raced the Rebuild: it took the old build, and wrote its wait after both
  // hand-overs had looked.
  const late = (await w.store.getRun(runId))!;
  await w.store.saveRunTransition({
    ...late,
    environmentWait: { environmentId: old.id, status: "building" },
  }, late);
  await w.wired!.settleWaitingRun((await w.store.getRun(runId))!);
  const moved = (await w.store.getRun(runId))!;
  assertEquals(moved.state, "starting", "not refused");
  assertEquals(moved.environmentWait?.environmentId, rebuilt.id);

  const [fresh] = await w.builder.parked(1);
  fresh.succeed();
  await w.service!.idle();
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.environmentId, rebuilt.id);
  assertEquals(w.launches.length, 1);
});

test("a run waiting on a build superseded by a newer commit is still refused", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const runId = ((await w.startRepo()) as { runId: string }).runId;
  const [doomed] = await w.builder.parked(1);
  const old = w.environmentStore.rows.get(doomed.spec.environmentId)!;
  await w.environmentStore.saveEnvironmentIfStatus({ ...old, status: "superseded" }, [
    "queued",
    "building",
  ]);
  await queueApi(w, sha("b"));
  await w.wired!.settleWaitingRun((await w.store.getRun(runId))!);
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "errored", "a build of other inputs is not its machine");
  assertEquals(run.environmentWait, null);
});

test("a Rebuild leaves the build it replaces running while a waiter it cannot move remains", async () => {
  const w = await world();
  const first = await queueApi(w, sha("a"));
  w.service!.addWaiters((id) => Promise.resolve(id === first.id));
  const [running] = await w.builder.parked(1);
  const rebuilt = await rebuildOf(w, first);
  assert(rebuilt.id !== first.id);
  await settleAsync();
  assertEquals(running.signal.aborted, false);
  const [, fresh] = await w.builder.parked(2);
  assertEquals(fresh.spec.environmentId, rebuilt.id);
  running.succeed();
  await settleAsync();
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "ready", "its waiter gets it");
  w.clock.advance(1000);
  fresh.succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(rebuilt.id)!.status, "ready");
});

test("the spec: pinned base and harness, clone through the gateway on the build's own key", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  const { spec } = build;
  assertEquals(spec.subjectKey, "repo-cr-api");
  assertEquals(spec.baseImage, w.config.environments.baseImage);
  assertEquals(spec.harnessImage, HARNESS);
  assertEquals([spec.relayerFrom, spec.defaultBranch], [null, true]);
  assertEquals(spec.cacheScope, { read: ["repo-cr-api"], write: "repo-cr-api" });
  assertEquals(spec.clone.urls, {
    api: `http://gateway.test:7412/v1/git/${row.id}/cr-api/repo.git`,
  });
  assertEquals(spec.clone.env.GIT_CONFIG_KEY_0, "http.http://gateway.test:7412/.extraheader");
  const header = spec.clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.slice("Authorization: Basic ".length)).split(":")[1];
  const { sha256Hex } = await import("@ryph/sealed");
  const key = await w.environmentStore.getBuildGitKeyByTokenHash(await sha256Hex(token));
  assertEquals(key?.environmentId, row.id);
  assertEquals(key?.revokedAt, null);
  build.succeed();
  await w.service!.idle();
  const revoked = await w.environmentStore.getBuildGitKeyByTokenHash(await sha256Hex(token));
  assert(revoked?.revokedAt !== null, "the key dies with the build");
});

test("the spec: a builder that clones on the host dials the gateway at its own address", async () => {
  const w = await world({ environments: { buildGatewayUrl: "http://localhost:7412" } });
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  // The credential is scoped to the address the clone uses, or git would never send it.
  assertEquals(build.spec.clone.urls, {
    api: `http://localhost:7412/v1/git/${row.id}/cr-api/repo.git`,
  });
  assertEquals(build.spec.clone.env.GIT_CONFIG_KEY_0, "http.http://localhost:7412/.extraheader");
  build.succeed();
  await w.service!.idle();
});

test("the spec without a gateway: the repo URL, and no credential", async () => {
  const w = await world({ gitGateway: null });
  await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  assertEquals(build.spec.clone.urls, { api: "https://github.com/acme/api.git" });
  assertEquals(build.spec.clone.env, {});
});

test("the spec's egress: a claim at the deployment ceiling, as Docker's proxy args", async () => {
  const key = new Uint8Array(32).fill(7);
  const w = await world({
    environments: { registry: "europe-docker.pkg.dev/acme-dev/ryph-envs/cell" },
    egress: {
      policy: {
        mode: "proxy",
        bundles: ["npm"],
        hosts: ["static.rust-lang.org"],
        proxyUrl: "http://egress.test:3128",
      },
      key,
      tokenTtlMs: 24 * 60 * 60 * 1000,
    },
  });
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  const proxy = new URL(build.spec.proxyEnv.HTTPS_PROXY);
  assertEquals(proxy.host, "egress.test:3128");
  assertEquals(decodeURIComponent(proxy.username), row.id);
  const claim = decodeClaim(decodeURIComponent(proxy.password));
  assertEquals(claim.r, row.id);
  assert(claim.h.includes("static.rust-lang.org"));
  assert(claim.h.includes("registry.npmjs.org"), "every bundle of the ceiling, no agent narrowing");
  // BuildKit pulls the pinned base and harness, and pushes the result, through the same proxy.
  assert(claim.h.includes("quay.io"), "the base and harness images' registry");
  assert(claim.h.includes("europe-docker.pkg.dev"), "the registry builds push to");
  assertEquals(build.spec.proxyEnv.NO_PROXY, "localhost,127.0.0.1,::1,[::1]");
  assertEquals(build.spec.proxyEnv.http_proxy, build.spec.proxyEnv.HTTPS_PROXY);

  const open = await world({
    egress: {
      policy: { mode: "open", bundles: [], hosts: [], proxyUrl: null },
      key: null,
      tokenTtlMs: 0,
    },
  });
  await queueApi(open, sha("a"));
  const [unproxied] = await open.builder.parked(1);
  assertEquals(unproxied.spec.proxyEnv, {});
});

test("registry hosts: only a reference that names one", () => {
  assertEquals(
    registryHosts([
      "europe-docker.pkg.dev/p/ryph/ryph-harness@sha256:aa",
      "localhost:5000/ryph-universal:dev",
      "ryph-harness:dev",
      "library/debian:trixie",
      null,
      "Europe-Docker.pkg.dev/p/ryph-envs",
    ]),
    ["europe-docker.pkg.dev", "localhost"],
  );
});

// Adoption: a `building` row nobody is stamping any more. The control plane that claimed it is
// gone, so the question "is this build still going?" is put to the BUILDER, whose Job outlives
// the process that created it — never to a clock derived from the build's timeout.

/** A `building` row this replica is not running: what another replica left behind when it went. */
async function stranded(
  w: Awaited<ReturnType<typeof world>>,
  id = "env-stranded",
): Promise<Environment> {
  const queued = await queueApi(w, sha("a"));
  // Clear this replica's own slot, so the row below is one it has never heard of.
  await w.builder.parked(1).then(([b]) => b.succeed());
  await w.service!.idle();
  const left: Environment = { ...queued, id, status: "building", startedAt: T0, updatedAt: T0 };
  await w.environmentStore.saveEnvironment(left);
  return left;
}

const ADOPTED_IMAGE = `registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`;
const adoptedOk = (image = ADOPTED_IMAGE): AdoptResult => ({
  kind: "settled",
  result: {
    ok: true,
    image,
    bakedImage: `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`,
    sizeBytes: 1024,
    toolchains: { rustc: "1.97.1" },
    log: "adopted\nbuilt\n",
  },
});

test("a stranded build whose job is still running is adopted, and settles here when it ends", async () => {
  let release!: (outcome: AdoptResult) => void;
  const answer = new Promise<AdoptResult>((resolve) => (release = resolve));
  const w = await world({ adopt: () => answer });
  const left = await stranded(w);

  await w.service!.tick();
  assertEquals(w.builder.adopted.length, 0, "not while its heartbeat could merely be late");
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  assertEquals(w.builder.adopted.map((s) => s.environmentId), [left.id]);
  assertEquals(
    w.environmentStore.rows.get(left.id)!.status,
    "building",
    "still building — this replica is watching it now",
  );
  // The adopted build holds a slot exactly as one started here does.
  assertEquals(w.builder.specs.length, 1, "nothing was rebuilt");

  release(adoptedOk());
  await w.service!.idle();
  const row = w.environmentStore.rows.get(left.id)!;
  assertEquals(row.status, "ready");
  assertEquals(row.image, ADOPTED_IMAGE);
  assertEquals(row.toolchains, { rustc: "1.97.1" });
  assertEquals(w.logs.logs.get(`environments/${left.id}.log`), "adopted\nbuilt\n");
});

test("a stranded build whose job already finished is settled on the result it left behind", async () => {
  const w = await world({ adopt: () => adoptedOk() });
  const left = await stranded(w);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  const row = w.environmentStore.rows.get(left.id)!;
  assertEquals(row.status, "ready");
  assertEquals(row.image, ADOPTED_IMAGE);
  assertEquals(row.finishedAt, w.clock.now().toISOString());
});

test("a stranded build whose job already failed fails the row with what the build said", async () => {
  const w = await world({
    adopt: () => ({
      kind: "settled",
      result: {
        ok: false,
        kind: "failed",
        message: "the environment build failed: RUN cargo build exited 101",
        logTail: "error: RUN cargo build exited 101",
        log: "step 1\nerror: RUN cargo build exited 101\n",
      },
    }),
  });
  const left = await stranded(w);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  const row = w.environmentStore.rows.get(left.id)!;
  assertEquals(row.status, "failed");
  assertStringIncludes(row.failure!, "cargo build exited 101");
  assertStringIncludes(row.logTail!, "cargo build exited 101");
});

test("a stranded build the builder has no record of fails within a tick, not at the timeout", async () => {
  // The 180 minutes that turned a stranded row into a three-hour wedge in practice: the recovery
  // must have nothing to do with it. The default `adopt` of the double answers `gone`, which is
  // what an adapter with no durable record of its own (docker) always answers.
  const w = await world({ environments: { buildTimeoutMs: 3 * 60 * 60 * 1000 } });
  const left = await stranded(w);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  const row = w.environmentStore.rows.get(left.id)!;
  assertEquals(row.status, "failed");
  assertStringIncludes(row.failure!, "no record of it");
  // A minute and a tick, not three hours.
  assertEquals(w.clock.now().getTime() - Date.parse(T0), STRANDED_AFTER_MS + 1);
});

test("a builder that cannot be asked decides nothing: the row waits, and is asked again", async () => {
  const w = await world({
    environments: { buildTimeoutMs: 60_000 },
    adopt: () => ({ kind: "unknown", why: "connection refused" }),
  });
  const left = await stranded(w);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(left.id)!.status, "building", "nothing was decided");
  assertEquals(w.builder.adopted.length, 1);

  // Taking the row stamped it, so it is asked again only once it has gone cold again.
  await w.service!.tick();
  assertEquals(w.builder.adopted.length, 1, "no hot loop against an API that is not answering");
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  assertEquals(w.builder.adopted.length, 2);

  // Past the deadline the build itself was created with, the cluster would have ended it anyway:
  // the last-resort floor, and the only place the build timeout is still consulted.
  w.clock.advance(60_000 + ORPHAN_GRACE_MS + 1);
  await w.service!.tick();
  await w.service!.idle();
  const row = w.environmentStore.rows.get(left.id)!;
  assertEquals(row.status, "failed");
  assertStringIncludes(row.failure!, "could not be asked");
});

test("a build this replica is running is stamped every tick, so no peer takes it over", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  await w.builder.parked(1);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await w.service!.tick();
  assertEquals(
    w.environmentStore.rows.get(row.id)!.updatedAt,
    w.clock.now().toISOString(),
    "the heartbeat is the claim a running build makes on its row",
  );
  const peer = replica(w);
  await peer.service.tick();
  assertEquals(peer.builder.adopted.length, 0, "its owner is still stamping it");
  await w.builder.parked(1).then(([b]) => b.succeed());
  await w.service!.idle();
});

test("two replicas find the same stranded build: exactly one of them goes and asks", async () => {
  const w = await world({ adopt: () => adoptedOk() });
  const peer = replica(w, {
    adopt: () => adoptedOk("registry.test/peer@sha256:" + "a".repeat(64)),
  });
  const left = await stranded(w);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  await Promise.all([w.service!.tick(), peer.service.tick()]);
  await Promise.all([w.service!.idle(), peer.service.idle()]);
  assertEquals(
    w.builder.adopted.length + peer.builder.adopted.length,
    1,
    "the claim is a compare-and-set on the stamp: the loser leaves it alone",
  );
  assertEquals(w.environmentStore.rows.get(left.id)!.status, "ready");
});

test("a build a second replica takes over anyway settles once: the late verdict is dropped", async () => {
  // The window the claim cannot close: this replica IS running the build, but stalled past the
  // heartbeat, so the peer's tick finds the row cold and adopts a build that is going fine. Two
  // watchers, and the conditional settle is what makes that survivable.
  const peerImage = `registry.test/peer@sha256:${"9".repeat(64)}`;
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [running] = await w.builder.parked(1);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  const peer = replica(w, { adopt: () => adoptedOk(peerImage) });
  await peer.service.tick();
  await peer.service.idle();
  assertEquals(w.environmentStore.rows.get(row.id)!.image, peerImage, "the adopter settled it");

  running.succeed(`registry.test/original@sha256:${"7".repeat(64)}`);
  await w.service!.idle();
  assertEquals(
    w.environmentStore.rows.get(row.id)!.image,
    peerImage,
    "one settle lands, and it is the first",
  );
  assert(
    w.diagEvents.some((e) => e.event === "environments.settle_dropped"),
    "the second is dropped on the stored status, not written over the first",
  );
});

test("the builder's record of a build is dropped only once the row has been written", async () => {
  // The measured failure this ordering exists for: a Job deleted the moment its log was read, a
  // control plane that ended a heartbeat later, and a successful build with an image in the
  // registry, a row still `building`, and no record left for the next control plane to read.
  const seen: Array<{ status: string; image: string | null }> = [];
  let rowId = "";
  const w = await world({
    discard: (id) => {
      const row = w.environmentStore.rows.get(id)!;
      seen.push({ status: row.status, image: row.image });
    },
  });
  const row = await queueApi(w, sha("a"));
  rowId = row.id;
  const [build] = await w.builder.parked(1);
  assertEquals(w.builder.discarded, [], "not while it is building");
  build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`);
  await w.service!.idle();
  assertEquals(w.builder.discarded, [rowId]);
  assertEquals(seen, [{
    status: "ready",
    image: `registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`,
  }]);
});

test("the settle that loses the row writes no log over the one that won", async () => {
  // Two watchers of one build, and they do not agree: the one that discarded the record first
  // leaves the other polling a Job that has disappeared, which it reads as a failed build. The
  // conditional save decides which VERDICT stands; this is what keeps the loser's narration off
  // the winner's log, where it would destroy the only record of an hour-long build.
  const peerImage = `registry.test/peer@sha256:${"9".repeat(64)}`;
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [running] = await w.builder.parked(1);
  w.clock.advance(STRANDED_AFTER_MS + 1);
  const peer = replica(w, { adopt: () => adoptedOk(peerImage) });
  await peer.service.tick();
  await peer.service.idle();

  running.fail("the build job disappeared");
  await w.service!.idle();
  const stored = w.environmentStore.rows.get(row.id)!;
  assertEquals(stored.status, "ready");
  assertEquals(stored.image, peerImage);
  assertEquals(
    w.logs.logs.get(`environments/${row.id}.log`),
    "adopted\nbuilt\n",
    "the winner's log, not the loser's account of a Job it could not find",
  );
});

test("a superseded build nobody here is running is ended at the builder", async () => {
  // Superseding a row aborts an AbortController in a map. When the replica holding it is gone,
  // that is a no-op and the row leaves `building`, so the stranded sweep never looks at it
  // again: without this the Job would run out its deadline, holding a node and a work volume for
  // an image nobody will ever launch.
  const w = await world();
  const left = await stranded(w);
  w.builder.discarded.length = 0;
  await queueApi(w, sha("b"));
  await settleAsync();
  assertEquals(w.environmentStore.rows.get(left.id)!.status, "superseded");
  assertEquals(w.builder.discarded, [left.id]);
});

test("a local build whose row was superseded elsewhere is aborted on the next tick", async () => {
  const w = await world();
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  const stored = w.environmentStore.rows.get(row.id)!;
  await w.environmentStore.saveEnvironment({
    ...stored,
    status: "superseded",
    failure: "elsewhere",
  });
  await w.service!.tick();
  assert(build.signal.aborted);
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(row.id)!.status, "superseded");
});

test("retention: the newest ready image per branch, plus anything a live run is on", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const first = await queueApi(w, sha("a"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  // A run is on the first image.
  const started = await w.startRepo();
  assertEquals(
    (await w.store.getRun((started as { runId: string }).runId))!.environmentId,
    first.id,
  );

  w.clock.advance(1000);
  const second = await queueApi(w, sha("b"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "ready", "a live run is on it");

  w.clock.advance(1000);
  const third = await queueApi(w, sha("c"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(second.id)!.status, "superseded");
  assertEquals(w.environmentStore.rows.get(third.id)!.status, "ready");

  // The run ends; the sweep lets its image go.
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  await w.store.saveRunResult({ ...run, state: "succeeded" });
  await w.service!.sweepRetention();
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "superseded");
  assertEquals(w.environmentStore.rows.get(third.id)!.status, "ready");
});

test("retention: a build whose setup.yml did not finish keeps the newest clean one beside it", async () => {
  const w = await world();
  const unfinished = {
    setupWarnings: [{ kind: "invalid" as const, path: "api", error: "setup.yml: not valid YAML" }],
  };
  const first = await queueApi(w, sha("a"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  w.clock.advance(1000);
  const second = await queueApi(w, sha("b"));
  (await w.builder.parked(1))[0].succeed(undefined, unfinished);
  await w.service!.idle();
  w.clock.advance(1000);
  const third = await queueApi(w, sha("c"));
  (await w.builder.parked(1))[0].succeed(undefined, unfinished);
  await w.service!.idle();
  const status = (id: string) => w.environmentStore.rows.get(id)!.status;
  // The clean one stays for the checks that run without setup.yml; the older warned one goes.
  assertEquals([status(first.id), status(second.id), status(third.id)], [
    "ready",
    "superseded",
    "ready",
  ]);
  await w.service!.sweepRetention();
  assertEquals(status(first.id), "ready", "the sweep keeps it too");
  // A clean successor settles: now the old clean one may go.
  w.clock.advance(1000);
  const fourth = await queueApi(w, sha("d"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  assertEquals([status(first.id), status(third.id), status(fourth.id)], [
    "superseded",
    "superseded",
    "ready",
  ]);
});

/** Two ready builds of acme/api's main, the first now superseded by the second, retired long
 * enough ago that its images may go. */
async function retiredAndCurrent(w: Awaited<ReturnType<typeof world>>) {
  // Each with an image and a baked image of its own, as a full build's are.
  let built = 0;
  const succeed = async () => {
    const [build] = await w.builder.parked(1);
    build.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${String(++built).repeat(64)}`, {
      bakedImage: `registry.test/baked-${build.spec.environmentId}`,
    });
    await w.service!.idle();
  };
  const first = await queueApi(w, sha("a"));
  await succeed();
  w.clock.advance(1000);
  const second = await queueApi(w, sha("b"));
  await succeed();
  assertEquals(w.environmentStore.rows.get(first.id)!.status, "superseded");
  w.clock.advance(IMAGE_REMOVAL_GRACE_MS + 1);
  return {
    retired: w.environmentStore.rows.get(first.id)!,
    current: w.environmentStore.rows.get(second.id)!,
  };
}

/** A retention sweep, and the removal it starts. */
const sweep = async (w: Awaited<ReturnType<typeof world>>) => {
  await w.service!.sweepRetention();
  await w.service!.idle();
};

/** What the builder was asked to remove, as [row, baked image] pairs. */
const removals = (w: Awaited<ReturnType<typeof world>>) =>
  w.builder.removed.map((r) => [r.environmentId, r.bakedImage]);

test("retention removes a retired build's images, its baked one with them, once", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  await sweep(w);
  assertEquals(w.builder.removed, [{
    environmentId: retired.id,
    subjectKey: "repo-cr-api",
    defaultBranch: retired.defaultBranch,
    recorded: true,
    image: retired.image,
    machineImage: null,
    bakedImage: retired.bakedImage,
  }]);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
  await sweep(w);
  assertEquals(w.builder.removed.length, 1, "a removed row is not asked about again");
});

test("retention leaves a just-retired build's images for the grace period", async () => {
  const w = await world();
  await retiredAndCurrent(w);
  w.clock.advance(-IMAGE_REMOVAL_GRACE_MS);
  await sweep(w);
  assertEquals(w.builder.removed, []);
});

test("the tick removes retired images too, at most every few minutes", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  await w.service!.tick();
  await w.service!.idle();
  assertEquals(removals(w).map(([id]) => id), [retired.id]);
  // Another retired since, but the next look is minutes away.
  w.environmentStore.rows.set(retired.id, { ...retired, imagesRemovedAt: null });
  w.builder.removed.length = 0;
  w.clock.advance(60_000);
  await w.service!.tick();
  await w.service!.idle();
  assertEquals(w.builder.removed, []);
  w.clock.advance(IMAGE_REMOVAL_EVERY_MS);
  await w.service!.tick();
  await w.service!.idle();
  assertEquals(removals(w).map(([id]) => id), [retired.id]);
});

test("retention leaves a retired build alone while a holder still has it", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  let suiteOnIt = true;
  w.service!.addImageHolders((id) => Promise.resolve(id === retired.id && suiteOnIt));
  await sweep(w);
  assertEquals(w.builder.removed, []);
  assertEquals(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt, null);
  suiteOnIt = false;
  await sweep(w);
  assertEquals(removals(w).map(([id]) => id), [retired.id]);
});

test("a pass that dies midway leaves the row to be done again", async () => {
  let failBaked = true;
  const w = await world({
    removeImages: (spec) => {
      if (spec.bakedImage !== null && failBaked) throw new Error("the daemon went away");
      return true;
    },
  });
  const { retired } = await retiredAndCurrent(w);
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt, null);
  failBaked = false;
  await sweep(w);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
  assertEquals(removals(w).at(-1), [retired.id, retired.bakedImage]);
});

/** `count` more retired rows like `of`, retired just before it, oldest first. */
function moreRetired(w: Awaited<ReturnType<typeof world>>, of: Environment, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const row = {
      ...of,
      id: `${of.id}-${String(i).padStart(3, "0")}`,
      bakedImage: null,
      updatedAt: new Date(Date.parse(of.updatedAt) - count + i).toISOString(),
    };
    w.environmentStore.rows.set(row.id, row);
    return row;
  });
}

test("a pass reads on past rows held for long, so they never stand in front of the rest", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  const rows = moreRetired(w, retired, IMAGE_REMOVAL_BATCH + 1);
  const free = rows.at(-1)!;
  w.service!.addImageHolders((id) => Promise.resolve(id !== free.id));
  await sweep(w);
  assertEquals(removals(w), [[free.id, null]]);
  assert(w.environmentStore.rows.get(free.id)!.imagesRemovedAt);
});

test("a pass ends once the builder keeps failing, and the next starts over", async () => {
  const w = await world({
    removeImages: () => {
      throw new Error("Cannot connect to the Docker daemon");
    },
  });
  const { retired } = await retiredAndCurrent(w);
  moreRetired(w, retired, 5);
  await sweep(w);
  assertEquals(w.builder.removed.length, IMAGE_REMOVAL_FAILURES);
  await sweep(w);
  assertEquals(w.builder.removed.length, 2 * IMAGE_REMOVAL_FAILURES);
});

test("retention untags a failed build's names, once its backend can no longer be pushing", async () => {
  const w = await world();
  const failed = await queueApi(w, sha("a"));
  (await w.builder.parked(1))[0].fail("boom");
  await w.service!.idle();
  const settled = w.environmentStore.rows.get(failed.id)!;
  assertEquals(settled.status, "failed");
  // Superseded before any replica claimed it: nothing was built, so nothing is asked.
  const never: Environment = { ...settled, id: "env-never", status: "superseded", startedAt: null };
  w.environmentStore.rows.set(never.id, never);

  w.clock.advance(IMAGE_REMOVAL_GRACE_MS + 1);
  await sweep(w);
  // A build abandoned or adopted as gone may still be running (or queued, its clock not started).
  assertEquals(w.builder.removed, [], "not before twice the build timeout");
  assert(w.environmentStore.rows.get(never.id)!.imagesRemovedAt, "nothing to wait for");
  w.clock.advance(2 * w.config.environments.buildTimeoutMs + ORPHAN_GRACE_MS);
  await sweep(w);
  assertEquals(w.builder.removed, [{
    environmentId: failed.id,
    subjectKey: "repo-cr-api",
    defaultBranch: true,
    recorded: false,
    image: null,
    machineImage: null,
    bakedImage: null,
  }]);
  assert(w.environmentStore.rows.get(failed.id)!.imagesRemovedAt);
  await sweep(w);
  assertEquals(w.builder.removed.length, 1, "each asked about once");
});

test("a build's machine is recorded, and handed back by digest when the row retires", async () => {
  const w = await world();
  const machine = (id: string) => `registry.test/ryph-envs/repo-cr-api@sha256:${id.repeat(64)}`;
  const first = await queueApi(w, sha("a"));
  (await w.builder.parked(1))[0].succeed(undefined, {
    bakedImage: "registry.test/baked-1",
    machineImage: machine("7"),
  });
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(first.id)!.machineImage, machine("7"));
  w.clock.advance(1000);
  await queueApi(w, sha("b"));
  (await w.builder.parked(1))[0].succeed(undefined, { bakedImage: "registry.test/baked-2" });
  await w.service!.idle();
  w.clock.advance(IMAGE_REMOVAL_GRACE_MS + 1);
  await sweep(w);
  assertEquals(w.builder.removed.map((r) => [r.environmentId, r.machineImage]), [
    [first.id, machine("7")],
  ]);
});

test("a digest another row still names is never handed over to delete", async () => {
  const w = await world();
  const at = (c: string) => `registry.test/ryph-envs/repo-cr-api@sha256:${c.repeat(64)}`;
  const { retired, current } = await retiredAndCurrent(w);
  // The retired build's machine is the current one's too (an unchanged machine), and its image
  // is one another row reported as well.
  w.environmentStore.rows.set(retired.id, { ...retired, image: at("b"), machineImage: at("a") });
  w.environmentStore.rows.set(current.id, { ...current, machineImage: at("a") });
  w.environmentStore.rows.set("env-elsewhere", {
    ...current,
    id: "env-elsewhere",
    image: at("b"),
    machineImage: null,
  });
  await sweep(w);
  assertEquals(w.builder.removed.map((r) => [r.environmentId, r.image, r.machineImage]), [
    [retired.id, null, null],
  ]);

  // A baked image another unstamped row names as its IMAGE (a claim, not a re-layer's share), and
  // a live run frozen on what is left: nothing of either is handed over.
  const again = await world();
  const two = await retiredAndCurrent(again);
  const started = await again.startRepo();
  const run = (await again.store.getRun((started as { runId: string }).runId))!;
  await again.store.saveRun({ ...run, id: `${run.id}-pinned`, image: at("c") });
  again.environmentStore.rows.set(two.retired.id, {
    ...two.retired,
    image: at("c"),
    bakedImage: at("d"),
    machineImage: at("e"),
  });
  again.environmentStore.rows.set("env-claims", {
    ...two.current,
    id: "env-claims",
    image: at("d"),
    machineImage: null,
  });
  await sweep(again);
  assertEquals(
    again.builder.removed.map((r) => [r.image, r.bakedImage, r.machineImage]),
    [[null, null, at("e")]],
  );
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt, "done: the rest is theirs");
});

test("a reconcile counts as in use whatever a row not done with, a live run or a build names", async () => {
  const w = await world();
  const d = (c: string) => `sha256:${c.repeat(64)}`;
  const { retired, current } = await retiredAndCurrent(w);
  const at = (c: string) => `registry.test/ryph-envs/repo-cr-api@${d(c)}`;
  // A row not yet done with names its machine; one done with names nothing any more.
  w.environmentStore.rows.set(current.id, { ...current, machineImage: at("a") });
  w.environmentStore.rows.set(retired.id, {
    ...retired,
    image: at("b"),
    imagesRemovedAt: w.clock.now().toISOString(),
  });
  // A queued re-layer starts from a baked image no settled row names.
  await w.environmentStore.createEnvironment({
    ...current,
    id: "env-relayer",
    status: "queued",
    image: null,
    bakedImage: null,
    machineImage: null,
    plan: { ...current.plan, relayerOf: { environmentId: "env-gone", bakedImage: at("c") } },
  });
  // A live run frozen on a digest nothing else names any more.
  const started = await w.startRepo();
  const run = (await w.store.getRun((started as { runId: string }).runId))!;
  await w.store.saveRun({ ...run, id: `${run.id}-pinned`, image: at("f") });
  await sweep(w);
  assertEquals(w.builder.reconciled.length, 1);
  const [{ untaggedForMs, inUse }] = w.builder.reconciled;
  const timeout = w.config.environments.buildTimeoutMs;
  assertEquals(untaggedForMs, 2 * timeout + ORPHAN_GRACE_MS + IMAGE_REMOVAL_GRACE_MS);
  assertEquals(
    [...await inUse([d("a"), d("b"), d("c"), d("f"), d("9")])].sort(),
    [d("a"), d("c"), d("f")],
  );
  // Once an hour, not on every pass.
  await sweep(w);
  assertEquals(w.builder.reconciled.length, 1);
  w.clock.advance(RECONCILE_EVERY_MS);
  await sweep(w);
  assertEquals(w.builder.reconciled.length, 2);
});

test("a pass that did something says so once, with its counts; one that did nothing is quiet", async () => {
  const quiet = await world();
  await sweep(quiet);
  assertEquals(
    quiet.diagEvents.filter((e) => /pass|pruned|reconciled/.test(e.event)).map((e) => e.event),
    [],
  );

  const w = await world({
    summaries: {
      deletesPerRemoval: 2,
      prune: { candidates: 4, deleteRequested: 4, failures: 0 },
      reconcile: { candidates: 3, deleteRequested: 2, failures: 1, firstError: "boom" },
    },
  });
  await retiredAndCurrent(w);
  await sweep(w);
  const said = (event: string) =>
    w.diagEvents.filter((e) => e.event === event).map((e) => e.fields);
  assertEquals(said("environments.images_removal_pass"), [{
    rowsSeen: 1,
    rowsStamped: 1,
    unanswered: 0,
    failures: 0,
    versionsDeleteRequested: 2,
  }]);
  assertEquals(said("environments.cache_pruned"), [{
    candidates: 4,
    deleteRequested: 4,
    failures: 0,
  }]);
  assertEquals(said("environments.images_reconciled"), [{
    candidates: 3,
    deleteRequested: 2,
    failures: 1,
    firstError: "boom",
  }]);
});

test("a removal pass that failed says so once, with its first error", async () => {
  const w = await world({
    removeImages: () => {
      throw new Error("PERMISSION_DENIED");
    },
  });
  await retiredAndCurrent(w);
  await sweep(w);
  const [said] = w.diagEvents.filter((e) => e.event === "environments.images_removal_pass");
  assertEquals(said.fields!.failures, 1);
  assertStringIncludes(String(said.fields!.firstError), "PERMISSION_DENIED");
});

test("the removal pass prunes a registry's layer cache past the build timeout", async () => {
  const w = await world();
  await sweep(w);
  assertEquals(w.builder.pruned, [w.config.environments.buildTimeoutMs + CACHE_RETIRED_GRACE_MS]);
});

test("retention keeps a retired build unstamped while the builder says something uses it", async () => {
  let inUse = true;
  const w = await world({ removeImages: () => !inUse });
  const { retired } = await retiredAndCurrent(w);
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt, null);
  inUse = false;
  await sweep(w);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
});

test("retention keeps a baked image a queued build starts from, or a ready row names", async () => {
  const w = await world();
  const { retired, current } = await retiredAndCurrent(w);
  const baked = retired.bakedImage!;
  // A queued build warm from the retired one: its whole build is held.
  await w.environmentStore.createEnvironment({
    ...current,
    id: "env-warm",
    status: "queued",
    image: null,
    bakedImage: null,
    plan: { ...current.plan, warmFrom: { environmentId: retired.id, bakedImage: baked } },
  });
  await sweep(w);
  assertEquals(w.builder.removed, []);

  // That build gone, a ready re-layer still answers the same baked image: the retired row's own
  // image goes and the row is done with; the baked image stays, for the re-layer.
  w.environmentStore.rows.delete("env-warm");
  await w.environmentStore.saveEnvironment({ ...current, bakedImage: baked });
  await sweep(w);
  assertEquals(removals(w), [[retired.id, null]]);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
  await sweep(w);
  assertEquals(w.builder.removed.length, 1, "and is not asked about again");
});

test("retention keeps a baked image a re-layer retired only just now still names", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  // A re-layer of the retired build, retired itself a moment ago: inside its grace, its checks
  // still run in the baked image they share.
  await w.environmentStore.createEnvironment({
    ...retired,
    id: "env-relayer",
    image: `registry.test/ryph-envs/repo-cr-api@sha256:${"7".repeat(64)}`,
    plan: {
      ...retired.plan,
      relayerOf: { environmentId: retired.id, bakedImage: retired.bakedImage! },
    },
    updatedAt: w.clock.now().toISOString(),
  });
  await sweep(w);
  assertEquals(removals(w), [[retired.id, null]]);
});
/** A retired re-layer of `retired`, sharing its baked image. */
async function retiredRelayer(w: Awaited<ReturnType<typeof world>>, retired: Environment) {
  const relayer: Environment = {
    ...retired,
    id: "env-relayer",
    image: `registry.test/ryph-envs/repo-cr-api@sha256:${"7".repeat(64)}`,
    plan: {
      ...retired.plan,
      relayerOf: { environmentId: retired.id, bakedImage: retired.bakedImage! },
    },
  };
  await w.environmentStore.createEnvironment(relayer);
  return relayer;
}

/** Another replica's pass, done with `other` the moment this one stamps `row`: each read the
 * other's row before either stamp landed. */
function racedBy(w: Awaited<ReturnType<typeof world>>, row: string, other: string) {
  const mark = w.environmentStore.markEnvironmentImagesRemoved.bind(w.environmentStore);
  w.environmentStore.markEnvironmentImagesRemoved = async (id, at) => {
    await mark(id, at);
    if (id === row && at !== null) await mark(other, at);
  };
}

test("two replicas handing a shared baked image to each other: the last to stamp removes it", async () => {
  const w = await world();
  const { retired } = await retiredAndCurrent(w);
  const relayer = await retiredRelayer(w, retired);
  // Retired only just now, so this pass leaves it to the other.
  w.environmentStore.rows.set(relayer.id, { ...relayer, updatedAt: w.clock.now().toISOString() });
  racedBy(w, retired.id, relayer.id);
  await sweep(w);
  assertEquals(removals(w), [[retired.id, null], [retired.id, retired.bakedImage]]);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
});

test("one that cannot remove a shared baked image after such a race takes its stamp back", async () => {
  const w = await world({ removeImages: (spec) => spec.bakedImage === null });
  const { retired } = await retiredAndCurrent(w);
  const relayer = await retiredRelayer(w, retired);
  // Retired only just now, so this pass leaves it to the other.
  w.environmentStore.rows.set(relayer.id, { ...relayer, updatedAt: w.clock.now().toISOString() });
  racedBy(w, retired.id, relayer.id);
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt, null, "still owed");
});

test("retention removes a shared baked image with the last row naming it", async () => {
  let refuse: string | null = null;
  const w = await world({ removeImages: (spec) => spec.environmentId !== refuse });
  const { retired } = await retiredAndCurrent(w);
  // A re-layer of the retired build, itself retired: it answers the same baked image.
  const relayer: Environment = {
    ...retired,
    id: "env-relayer",
    image: `registry.test/ryph-envs/repo-cr-api@sha256:${"7".repeat(64)}`,
    plan: {
      ...retired.plan,
      relayerOf: { environmentId: retired.id, bakedImage: retired.bakedImage! },
    },
  };
  await w.environmentStore.createEnvironment(relayer);

  // The re-layer kept by the builder: the retired row's own image goes, the baked one stays.
  refuse = relayer.id;
  await sweep(w);
  assertEquals(removals(w), [[retired.id, null], [relayer.id, retired.bakedImage]]);
  assert(w.environmentStore.rows.get(retired.id)!.imagesRemovedAt);
  assertEquals(w.environmentStore.rows.get(relayer.id)!.imagesRemovedAt, null);

  // Asked again, the re-layer is the last row naming it, and takes it.
  refuse = null;
  w.builder.removed.length = 0;
  let suiteOnRetired = true;
  w.service!.addImageHolders((id) => Promise.resolve(id === retired.id && suiteOnRetired));
  await sweep(w);
  // Unless a check on the retired row still runs in it.
  assertEquals(removals(w), [[relayer.id, null]]);
  suiteOnRetired = false;
  w.builder.removed.length = 0;
  await sweep(w);
  assertEquals(removals(w), [[relayer.id, retired.bakedImage]]);
  assert(w.environmentStore.rows.get(relayer.id)!.imagesRemovedAt);
});
test("a build that succeeds after its row moved on is untagged at once, deleted by nothing it says", async () => {
  const w = await world();
  const at = (c: string) => `registry.test/ryph-envs/repo-cr-api@sha256:${c.repeat(64)}`;
  const row = await queueApi(w, sha("a"));
  const [build] = await w.builder.parked(1);
  // Retired while it ran, by whatever moved the row on.
  const stored = w.environmentStore.rows.get(row.id)!;
  w.environmentStore.rows.set(row.id, { ...stored, status: "superseded" });
  // What it reports may be a digest a build still in flight pushed and has not recorded yet:
  // its own names go now, and the reconcile, past its age gate, takes what that leaves.
  build.succeed(at("9"), { bakedImage: at("2"), machineImage: at("3") });
  await w.service!.idle();
  assertEquals(w.builder.removed, [{
    environmentId: row.id,
    subjectKey: "repo-cr-api",
    defaultBranch: true,
    recorded: false,
    image: null,
    machineImage: null,
    bakedImage: null,
  }]);
});

/** Queues a check's build of acme/api's main at `commit`: a branch build of the default branch. */
async function queueCheckBuild(w: Awaited<ReturnType<typeof world>>, commit: string) {
  return await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-api"),
    ref: "main",
    defaultBranch: false,
    checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit }],
    definition: tree("a"),
    dockerfile: true,
    machine: null,
    trigger: "check",
  });
}

test("a check's build of main never retires, satisfies or stands in for main's own image", async () => {
  const w = await world();
  // A: the default image of main@b lands first; a check's build of main@a (its base, behind)
  // lands after it. The newer-built check image must not retire the default one.
  const own = await queueApi(w, sha("b"));
  const check = await queueCheckBuild(w, sha("a"));
  assert(check.id !== own.id);
  const parked = await w.builder.parked(2);
  parked.find((b) => b.spec.environmentId === own.id)!.succeed();
  await settleAsync();
  w.clock.advance(1000);
  parked.find((b) => b.spec.environmentId === check.id)!.succeed();
  await w.service!.idle();
  assertEquals(w.environmentStore.rows.get(own.id)!.status, "ready");
  assertEquals(w.environmentStore.rows.get(check.id)!.status, "ready");
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(own.id)!.status, "ready", "the sweep keeps it too");

  // B: the default branch asks for the very commit the check built: a default row of its own.
  const again = await queueApi(w, sha("a"));
  assert(again.id !== check.id, "a check's image is not the default branch's");
  assertEquals(again.defaultBranch, true);
  // And the other way: a check's ask is not answered by the default branch's image.
  const checkOfOwn = await queueCheckBuild(w, sha("b"));
  assert(checkOfOwn.id !== own.id);
  assertEquals(checkOfOwn.defaultBranch, false);
});

test("retention: a branch image goes after 14 days; a default-branch one never does alone", async () => {
  const w = await world();
  const branch = await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-api"),
    ref: "feat",
    defaultBranch: false,
    checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "feat", commit: sha("b") }],
    definition: tree("b"),
    dockerfile: true,
    machine: null,
    trigger: "run",
  });
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  const main = await queueApi(w, sha("a"));
  (await w.builder.parked(1))[0].succeed();
  await w.service!.idle();
  w.clock.advance(BRANCH_IMAGE_TTL_MS - 1000);
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(branch.id)!.status, "ready");
  w.clock.advance(2000);
  await sweep(w);
  assertEquals(w.environmentStore.rows.get(branch.id)!.status, "superseded");
  assertEquals(w.environmentStore.rows.get(main.id)!.status, "ready");
});

test("off or unbuildable: nothing is ever claimed", async () => {
  const w = await world({ builderKind: "manual" });
  await queueApi(w, sha("a"));
  await w.service!.tick();
  await settleAsync();
  assertEquals(w.builder.specs.length, 0);
  assertStringIncludes(w.service!.refusedReason!, "manual");
});

test("the reaper leaves a waiting run be, and launches it when its build settled without it", async () => {
  const { sweep } = await import("../src/core/reaper.ts");
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const started = await w.startRepo();
  const runId = (started as { runId: string }).runId;
  const [build] = await w.builder.parked(1);
  const cfg = { heartbeatTimeoutMs: 1, startupGraceMs: 1, cancelGraceMs: 1, idleGraceMs: 1 };
  const reaperDeps = {
    store: w.store,
    provisioner: w.deps.provisioner,
    diag: w.diag,
    now: w.clock.now,
    settleWaitingRun: w.wired!.settleWaitingRun,
  };
  // Long past the startup grace: a waiting run has no container to be silent.
  w.clock.advance(60 * 60 * 1000);
  await sweep(reaperDeps, cfg);
  let run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "starting");
  assert(run.environmentWait !== null);

  // The replica that ran the build died after its settle but before telling the waiters: the
  // row is ready, the run still waits. The next sweep catches it up.
  const row = w.environmentStore.rows.get(build.spec.environmentId)!;
  w.environmentStore.rows.set(row.id, {
    ...row,
    status: "ready",
    image: `registry.test/x@sha256:${"d".repeat(64)}`,
    finishedAt: w.clock.now().toISOString(),
  });
  await sweep(reaperDeps, cfg);
  run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.image, `registry.test/x@sha256:${"d".repeat(64)}`);
  assertEquals(w.launches.length, 1);
  build.succeed();
  await w.service!.idle();
  assertEquals(w.launches.length, 1, "the late settle finds nobody waiting any more");
});

test("a run left waiting where builds are off any more is refused by the reaper, not stranded", async () => {
  const { sweep } = await import("../src/core/reaper.ts");
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const { runId } = (await w.startRepo()) as { runId: string };
  const [build] = await w.builder.parked(1);
  // A restart with RYPH_ENVIRONMENTS=off: the reaper has no one to hand the run to.
  await sweep(
    { store: w.store, provisioner: w.deps.provisioner, diag: w.diag, now: w.clock.now },
    { heartbeatTimeoutMs: 1, startupGraceMs: 1, cancelGraceMs: 1, idleGraceMs: 1 },
  );
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.state, "errored");
  assertEquals(run.environmentWait, null);
  build.succeed();
  await w.service!.idle();
  assertEquals(w.launches.length, 0);
});

test("a build whose repo was disconnected fails as a build, and the builder is not blamed", async () => {
  const w = await world({ environments: { buildConcurrency: 1 } });
  // A slot is taken, so the next build is claimed only after its repo went away.
  const holder = await queueApi(w, sha("a"));
  const [first] = await w.builder.parked(1);
  const queued = await w.service!.enqueue({
    subject: await subject(w, "repo", "cr-web"),
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "web", connectedRepoId: "cr-web", ref: "main", commit: sha("c") }],
    definition: tree("c"),
    dockerfile: false,
    machine: null,
    trigger: "push",
  });
  const web = (await w.store.getConnectedRepo("cr-web"))!;
  await w.store.saveConnectedRepo({ ...web, archivedAt: T0 });
  first.succeed();
  await w.service!.idle();
  await settleAsync();
  await w.service!.idle();
  const failed = w.environmentStore.rows.get(queued.id)!;
  assertEquals(failed.status, "failed");
  assertStringIncludes(failed.failure!, "disconnected");
  assertEquals(w.service!.builderFault(), null);
  assertEquals(w.environmentStore.rows.get(holder.id)!.status, "ready");
});
