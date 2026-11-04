// What a person watching a slow build gets: the log while it runs, how long builds like it take,
// and the way out of waiting — a run started on what is ready instead.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildKindOf, typicalBuildMs } from "../src/core/environments.ts";
import type { Environment } from "../src/core/types.ts";
import { AGENT_IMAGE, HARNESS, sha, T0, tree, world } from "./environment_world.ts";

const kinds = (events: Array<{ kind: string }>) => events.map((e) => e.kind);

/** A settled build of acme/api that took `minutes`, finished `at` minutes after T0. */
function built(
  at: number,
  minutes: number,
  overrides: Partial<Environment> & { warm?: boolean } = {},
): Environment {
  const finished = Date.parse(T0) + at * 60_000;
  const { warm, ...rest } = overrides;
  return {
    id: `env-${at}`,
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
    toolchains: {},
    sizeBytes: 1,
    trigger: "push",
    plan: {
      checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit: sha("a") }],
      dockerfileFrom: "api",
      cacheScope: { read: [], write: null },
      relayerOf: null,
      warmFrom: warm ? { environmentId: "env-src", bakedImage: "baked" } : null,
    },
    logRef: null,
    logTail: null,
    failure: null,
    egressRefusals: null,
    imagesRemovedAt: null,
    startedAt: new Date(finished - minutes * 60_000).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    createdAt: T0,
    updatedAt: T0,
    ...rest,
  };
}

test("a build's kind: full, incremental, or a re-layer", () => {
  assertEquals(buildKindOf(built(1, 10)), "full");
  assertEquals(buildKindOf(built(1, 10, { warm: true })), "incremental");
  const relayer = built(1, 1);
  assertEquals(
    buildKindOf({
      ...relayer,
      plan: { ...relayer.plan, relayerOf: { environmentId: "e", bakedImage: "b" } },
    }),
    "relayer",
  );
});

test("the estimate: the median of the last five settled builds of the same kind", () => {
  const history = [
    built(1, 40),
    built(2, 30),
    built(3, 4, { warm: true }),
    built(4, 6, { warm: true }),
    built(5, 20),
    built(6, 90, { status: "failed", image: null }),
    built(7, 10),
    built(8, 50),
    built(9, 25),
  ];
  // Full builds, newest five: 25, 50, 10, 20, 30 → median 25. The failed one never counts.
  assertEquals(typicalBuildMs(history, "full"), 25 * 60_000);
  assertEquals(typicalBuildMs(history, "incremental"), 5 * 60_000);
  assertEquals(typicalBuildMs(history, "relayer"), null);
  assertEquals(typicalBuildMs([], "full"), null);
});

test("a running build's log is readable while it runs, then the stored one", async () => {
  const liveLogs = new Map<string, string>();
  const w = await world({ liveLogs });
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.startRepo();
  const [build] = await w.builder.parked(1);
  const row = (await w.environmentStore.getEnvironment(build.spec.environmentId))!;
  assertEquals(await w.service!.readLog(row), null, "nothing logged yet");
  liveLogs.set(row.id, "ryph: cloning api\n#4 12.1 Compiling serde\n");
  assertStringIncludes((await w.service!.readLog(row))!, "Compiling serde");

  build.succeed();
  await w.service!.idle();
  const settled = (await w.environmentStore.getEnvironment(row.id))!;
  assertEquals(await w.service!.readLog(settled), "step 1\nstep 2\nbuilt\n");
});

test("start it anyway: a run waiting on a first build launches on the default image now", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  const runId = ((await w.startRepo()) as { runId: string }).runId;
  const [build] = await w.builder.parked(1);

  assertEquals(await w.wired!.startWithoutEnvironment(runId, "Ada"), true);
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environmentId, null);
  assertEquals(
    run.environment?.id,
    "default",
    "on the default image, said as a default launch says it",
  );
  assertEquals(w.launches.length, 1);
  assert(w.launches[0].env.RYPH_BOOTSTRAP_TOKEN !== undefined, "bootstrap minted at launch");
  assertEquals(w.launches[0].env.RYPH_GIT_TOKEN, undefined);
  const events = await w.store.listEvents(runId);
  assertEquals(kinds(events).filter((k) => k === "environment.fallback").length, 1);
  assertStringIncludes(events.find((e) => e.kind === "environment.fallback")!.detail!, "Ada");
  assert(!build.signal.aborted, "the build goes on for the runs after this one");

  // It is not waiting any more: a second ask, or a settle racing it, launches nothing.
  assertEquals(await w.wired!.startWithoutEnvironment(runId, "Ada"), false);
  build.succeed();
  await w.service!.idle();
  assertEquals(w.launches.length, 1);
});

test("start it anyway: a branch waiting on its own machine starts on the default branch's", async () => {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.startRepo();
  const [first] = await w.builder.parked(1);
  first.succeed();
  await w.service!.idle();
  const ready = (await w.environmentStore.getEnvironment(first.spec.environmentId))!;

  w.setHead("acme/api", "feature", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  const runId = ((await w.startRepo(w.api, "feature")) as { runId: string }).runId;
  assert((await w.store.getRun(runId))!.environmentWait !== null);
  assertEquals(await w.wired!.startWithoutEnvironment(runId, "Ada"), true);
  const run = (await w.store.getRun(runId))!;
  assertEquals(run.environmentId, ready.id);
  assertEquals(run.image, ready.image);
  const detail = (await w.store.listEvents(runId)).find((e) => e.kind === "environment.fallback")!
    .detail!;
  assertStringIncludes(detail, `newest ready environment (${ready.id}`);
});

test("start it anyway: a run that is not waiting is not touched", async () => {
  const w = await world();
  const runId = ((await w.startRepo()) as { runId: string }).runId;
  const before = (await w.store.getRun(runId))!;
  assertEquals(await w.wired!.startWithoutEnvironment(runId, "Ada"), false);
  assertEquals(await w.wired!.startWithoutEnvironment("run-nope", "Ada"), false);
  assertEquals((await w.store.getRun(runId))!.updatedAt, before.updatedAt);
});
