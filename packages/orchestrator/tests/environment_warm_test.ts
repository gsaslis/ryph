// Incremental builds: which ready image a build may start from (`warmSource`), and what the queue
// records and hands the builder when it does — the chain cap, the fall back to cold after a warm
// build failed, and the trust rule that keeps a branch's tree out of a default-branch image.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import {
  makeEnvironmentService,
  newestForChecks,
  retainedOfGroup,
  warmSource,
  warningRebuildDue,
} from "../src/core/environments.ts";
import type { SetupWarning } from "../src/core/setup_warnings.ts";
import type { Environment, EnvironmentTrigger } from "../src/core/types.ts";
import { sha, T0, tree, world } from "./environment_world.ts";
import { fakeBuilder } from "./environment_doubles.ts";

type World = Awaited<ReturnType<typeof world>>;

const BAKED = `registry.test/ryph-envs/repo-cr-api@sha256:${"d".repeat(64)}`;

/** Queues a build of acme/api at `commit`, on `main` unless another branch is named. */
async function queueApi(
  w: World,
  commit: string,
  opts: { treeId?: string; machine?: string | null; ref?: string; force?: boolean } = {},
) {
  const ref = opts.ref ?? "main";
  return await w.service!.enqueue({
    subject: (await w.service!.loadSubject("repo", "cr-api"))!,
    ref,
    defaultBranch: ref === "main",
    checkouts: [{ path: "api", connectedRepoId: "cr-api", ref, commit }],
    definition: opts.treeId ?? tree("a"),
    dockerfile: true,
    machine: opts.machine === undefined ? null : opts.machine,
    trigger: "push",
    force: opts.force,
  });
}

/** Queues, lets the build run, and settles it as told; answers the settled row. */
async function build(
  w: World,
  commit: string,
  outcome: "succeed" | "fail" = "succeed",
  opts: { treeId?: string; machine?: string | null; ref?: string; force?: boolean } = {},
) {
  const row = await queueApi(w, commit, opts);
  const [parked] = await w.builder.parked(1);
  if (outcome === "succeed") parked.succeed();
  else parked.fail();
  await w.service!.idle();
  w.clock.advance(60_000);
  return { row: w.environmentStore.rows.get(row.id)!, spec: parked.spec };
}

test("a code-only rebuild starts from the last ready image, and says so in its plan and spec", async () => {
  const w = await world();
  const cold = await build(w, sha("a"));
  assertEquals(cold.row.plan.warmFrom, null);
  assertEquals(cold.row.plan.depth, 0);
  assertEquals(cold.spec.warmFrom, null);

  const warm = await build(w, sha("b"));
  assertEquals(warm.row.plan.warmFrom, { environmentId: cold.row.id, bakedImage: BAKED });
  assertEquals(warm.row.plan.depth, 1);
  assertEquals(warm.spec.warmFrom, BAKED);
  assertEquals(warm.spec.relayerFrom, null);
  assertEquals(warm.row.status, "ready");
});

test("a changed .ryph tree builds cold: the machine it would start from is not this one", async () => {
  const w = await world();
  await build(w, sha("a"));
  const next = await build(w, sha("b"), "succeed", { treeId: tree("b") });
  assertEquals(next.row.plan.warmFrom, null);
  assertEquals(next.spec.warmFrom, null);
});

test("the chain is capped at RYPH_ENV_WARM_CHAIN, and the build after the cap is cold", async () => {
  const w = await world({ environments: { warmChain: 2 } });
  const depths = [];
  for (const letter of ["a", "b", "c", "d", "e"]) {
    depths.push((await build(w, sha(letter))).row.plan.depth);
  }
  assertEquals(depths, [0, 1, 2, 0, 1]);
});

test("RYPH_ENV_WARM_CHAIN=0 builds every image cold", async () => {
  const w = await world({ environments: { warmChain: 0 } });
  await build(w, sha("a"));
  assertEquals((await build(w, sha("b"))).spec.warmFrom, null);
});

test("a warm build that failed is followed by a cold one, and warm resumes after it", async () => {
  const w = await world();
  await build(w, sha("a"));
  const failed = await build(w, sha("b"), "fail");
  assert(failed.row.plan.warmFrom !== null, "the failed build was a warm one");
  assertEquals(failed.row.status, "failed");

  const cold = await build(w, sha("c"));
  assertEquals(cold.row.plan.warmFrom, null, "a warm tree that broke a build is not tried again");
  const again = await build(w, sha("d"));
  assertEquals(again.row.plan.warmFrom?.environmentId, cold.row.id);
});

test("a forced Rebuild is cold", async () => {
  const w = await world();
  await build(w, sha("a"));
  const forced = await build(w, sha("b"), "succeed", { force: true });
  assertEquals(forced.row.plan.warmFrom, null);
  assertEquals(forced.row.plan.depth, 0);
});

test("a re-layer moves the baked image as it is: never warm, and its depth carried", async () => {
  const w = await world();
  await build(w, sha("a"));
  const warm = await build(w, sha("b"));
  // The default branch still describes the machine it was built from.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
  // The next deploy: a control plane on a new harness, over the same database.
  const builder = fakeBuilder();
  const deployed = makeEnvironmentService({
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
  await deployed.onBoot();
  const [parked] = await builder.parked(1);
  const relayer = w.environmentStore.rows.get(parked.spec.environmentId)!;
  assertEquals(relayer.plan.relayerOf?.environmentId, warm.row.id);
  assertEquals(relayer.plan.warmFrom, null);
  assertEquals(relayer.plan.depth, 1);
  assertEquals(parked.spec.warmFrom, null);
  assertEquals(parked.spec.relayerFrom, BAKED);
});

// The pure rule, over hand-made rows.

function row(overrides: Partial<Environment> & { at: number }): Environment {
  const at = new Date(Date.parse(T0) + overrides.at * 60_000).toISOString();
  return {
    id: `env-${overrides.at}`,
    subjectKind: "repo",
    subjectId: "cr-api",
    ref: "main",
    defaultBranch: true,
    commits: { api: sha("a") },
    definition: tree("a"),
    baseDigest: `base@sha256:${"a".repeat(64)}`,
    harnessDigest: `harness@sha256:${"b".repeat(64)}`,
    image: `img-${overrides.at}`,
    bakedImage: `baked-${overrides.at}`,
    machineImage: null,
    status: "ready",
    toolchains: {},
    sizeBytes: null,
    trigger: "push",
    plan: {
      checkouts: [{ path: "api", connectedRepoId: "cr-api", ref: "main", commit: sha("a") }],
      dockerfileFrom: "api",
      cacheScope: { read: [], write: null },
      relayerOf: null,
      warmFrom: null,
      depth: 0,
    },
    logRef: null,
    logTail: null,
    failure: null,
    egressRefusals: null,
    imagesRemovedAt: null,
    startedAt: at,
    finishedAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const want = (overrides: Partial<Parameters<typeof warmSource>[1]> = {}) => ({
  ref: "main",
  defaultBranch: true,
  definition: tree("a"),
  machine: null as string | null,
  baseImage: `base:other-tag@sha256:${"a".repeat(64)}`,
  dockerfileFrom: "api",
  checkouts: [{ path: "api", connectedRepoId: "cr-api" }],
  force: false,
  trigger: "push" as EnvironmentTrigger,
  ...overrides,
});

test("warmSource: a default-branch build never starts from a branch's image", () => {
  const branch = row({ at: 2, ref: "feature", defaultBranch: false });
  assertEquals(warmSource([branch], want(), 8), null);
  const main = row({ at: 1 });
  assertEquals(warmSource([main, branch], want(), 8)?.id, main.id, "the older trusted one wins");
});

test("warmSource: a branch build prefers its own last image, then the default branch's", () => {
  const main = row({ at: 3 });
  const own = row({ at: 1, ref: "feature", defaultBranch: false });
  const other = row({ at: 4, ref: "other", defaultBranch: false });
  const branch = want({ ref: "feature", defaultBranch: false });
  assertEquals(warmSource([main, own, other], branch, 8)?.id, own.id);
  assertEquals(warmSource([main, other], branch, 8)?.id, main.id, "never another branch's");
});

test("warmSource: the same machine only — base, Dockerfile owner and checkout layout", () => {
  const source = row({ at: 1 });
  assertEquals(warmSource([source], want(), 8)?.id, source.id, "a base re-tagged is the same base");
  assertEquals(warmSource([source], want({ baseImage: `base@sha256:${"c".repeat(64)}` }), 8), null);
  assertEquals(warmSource([source], want({ dockerfileFrom: null }), 8), null);
  assertEquals(
    warmSource(
      [source],
      want({
        checkouts: [{ path: "api", connectedRepoId: "cr-api" }, {
          path: "web",
          connectedRepoId: "cr-web",
        }],
      }),
      8,
    ),
    null,
  );
  assertEquals(
    warmSource([source], want({ checkouts: [{ path: "api", connectedRepoId: "cr-other" }] }), 8),
    null,
    "another repo at the same path is another tree",
  );
  assertEquals(warmSource([source], want({ definition: null }), 8), null);
});

test("warmSource: a changed definition on the same machine starts warm; a new Dockerfile does not", () => {
  const machine = `dockerfile:${"f".repeat(40)}`;
  const source = row({ at: 1 });
  source.plan.machine = machine;
  // A member's setup.yml moved: another definition, the same Dockerfile.
  const setupOnly = want({ definition: "sha256:other", machine });
  assertEquals(warmSource([source], setupOnly, 8)?.id, source.id);
  // The Dockerfile moved: another machine.
  assertEquals(
    warmSource(
      [source],
      want({ definition: "sha256:other", machine: `dockerfile:${"e".repeat(40)}` }),
      8,
    ),
    null,
  );
  // Not known on either side: the definition alone decides, as before.
  assertEquals(warmSource([source], want({ definition: "sha256:other" }), 8), null);
  assertEquals(warmSource([row({ at: 1 })], setupOnly, 8), null, "a row queued before the key");
  // The machine never stands in for the rest: base, Dockerfile owner and layout still count.
  assertEquals(warmSource([source], { ...setupOnly, dockerfileFrom: null }, 8), null);
});

test("warmSource: only a ready image with a baked stage", () => {
  assertEquals(warmSource([row({ at: 1, status: "superseded" })], want(), 8), null);
  assertEquals(warmSource([row({ at: 1, bakedImage: null })], want(), 8), null);
});

test("warmSource: past the cap on its own image, a branch tries the default branch's", () => {
  const main = row({ at: 1 });
  const own = row({ at: 2, ref: "feature", defaultBranch: false });
  own.plan = { ...own.plan, depth: 4 };
  const branch = want({ ref: "feature", defaultBranch: false });
  assertEquals(warmSource([main, own], branch, 4)?.id, main.id);
  assertEquals(warmSource([own], branch, 4), null);
});

test("warmSource: a failed warm build stops warm starts only for its own kind of build", () => {
  const main = row({ at: 1 });
  // A check's build of main at its base: a branch build of the default branch, failed warm.
  const checkBuild = row({ at: 2, defaultBranch: false, status: "failed", trigger: "check" });
  checkBuild.plan = { ...checkBuild.plan, warmFrom: { environmentId: main.id, bakedImage: "b" } };
  assertEquals(
    warmSource([main, checkBuild], want(), 8)?.id,
    main.id,
    "main's own builds stay warm",
  );
  assertEquals(warmSource([main, checkBuild], want({ defaultBranch: false }), 8), null);
});

test("warmSource: a patch's build proves its definition cold; a push's builds warm", () => {
  const source = row({ at: 1 });
  assertEquals(warmSource([source], want({ trigger: "push" }), 8)?.id, source.id);
  assertEquals(warmSource([source], want({ trigger: "patch" }), 8), null);
  const branch = row({ at: 2, ref: "feature", defaultBranch: false });
  const patch = want({ ref: "feature", defaultBranch: false, trigger: "patch" });
  assertEquals(
    warmSource([source, branch], patch, 8),
    null,
    "not even from its own branch's image",
  );
});

// Builds whose setup.yml did not finish.

const stepFailed: SetupWarning[] = [{
  kind: "step",
  path: "api",
  step: "npm ci",
  index: 1,
  total: 1,
  code: 1,
  output: "",
  discarded: true,
}];
const dirtyOnly: SetupWarning[] = [{ kind: "dirty", path: "api", files: ["package-lock.json"] }];
const warmOf = (source: Environment) => ({ environmentId: source.id, bakedImage: "b" });

/** `row`, as a real build lands: queued at `at`, finished half a minute later. */
function built(overrides: Partial<Environment> & { at: number }): Environment {
  const done = new Date(Date.parse(T0) + (overrides.at + 0.5) * 60_000).toISOString();
  return row({ finishedAt: done, updatedAt: done, ...overrides });
}

test("warmSource: never from a build whose setup step failed or whose setup.yml was invalid", () => {
  // C0 clean, since superseded; W1 warm from it, its step failed. Nothing is left to warm from.
  const c0 = built({ at: 1, status: "superseded" });
  const w1 = built({ at: 2, setupWarnings: stepFailed });
  w1.plan = { ...w1.plan, warmFrom: warmOf(c0), depth: 1 };
  assertEquals(warmSource([c0, w1], want(), 8), null);
  // Nor from a cold build that broke, or an invalid setup.yml.
  const cold = built({ at: 3, setupWarnings: stepFailed });
  assertEquals(warmSource([c0, w1, cold], want(), 8), null);
  const invalid = built({ at: 4, setupWarnings: [{ kind: "invalid", path: "api", error: "x" }] });
  assertEquals(warmSource([invalid], want(), 8), null);
});

test("warmSource: a clean image is the source while a newer one's setup broke", () => {
  const clean = built({ at: 1 });
  const w1 = built({ at: 2, setupWarnings: stepFailed });
  w1.plan = { ...w1.plan, warmFrom: warmOf(clean), depth: 1 };
  assertEquals(warmSource([clean, w1], want(), 8)?.id, clean.id);
  // A tree setup only left dirty finished its setup: it is a source, the newest one.
  const dirty = built({ at: 3, setupWarnings: dirtyOnly });
  dirty.plan = { ...dirty.plan, warmFrom: warmOf(clean), depth: 1 };
  assertEquals(warmSource([clean, w1, dirty], want(), 8)?.id, dirty.id);
});

test("newestForChecks: a clean image only of the newest's definition", () => {
  const clean = row({ at: 1 });
  const warned = row({ at: 2, setupWarnings: stepFailed });
  assertEquals(newestForChecks([clean, warned])?.id, clean.id);
  // An older definition's clean image is not the machine the repo describes now.
  const otherDef = row({ at: 1, definition: tree("z") });
  assertEquals(newestForChecks([otherDef, warned])?.id, warned.id);
  // A dirty-only build finished its setup: it is clean enough.
  const dirty = row({ at: 3, setupWarnings: dirtyOnly });
  assertEquals(newestForChecks([clean, warned, dirty])?.id, dirty.id);
  assertEquals(newestForChecks([]), null);
});

test("retainedOfGroup: keeps the clean image checks use, never an old definition's", () => {
  const clean = row({ at: 1 });
  const warned = row({ at: 2, setupWarnings: stepFailed });
  assertEquals([...retainedOfGroup([clean, warned])].sort(), [clean.id, warned.id].sort());
  const otherDef = row({ at: 1, definition: tree("z") });
  assertEquals([...retainedOfGroup([otherDef, warned])], [warned.id]);
});

test("warningRebuildDue: once per episode — after a clean build, or none", () => {
  const clean = row({ at: 1 });
  const first = row({ at: 2, setupWarnings: stepFailed });
  assertEquals(warningRebuildDue(first, [clean, first]), true);
  assertEquals(warningRebuildDue(first, [first]), true, "the first build ever");
  // The early build warned too: no more early builds, though its predecessor was retired.
  const retired = { ...first, status: "superseded" as const };
  const second = row({ at: 3, setupWarnings: stepFailed });
  assertEquals(warningRebuildDue(second, [clean, retired, second]), false);
  // A failed build in between is no clean one; a new definition starts a new episode.
  const failed = row({ at: 2.5, status: "failed", image: null, setupWarnings: null });
  assertEquals(warningRebuildDue(second, [clean, retired, failed, second]), false);
  const newDef = row({ at: 4, definition: tree("n"), setupWarnings: stepFailed });
  assertEquals(warningRebuildDue(newDef, [clean, retired, second, newDef]), true);
  // A clean or dirty-only latest needs nothing early.
  assertEquals(warningRebuildDue(clean, [clean]), false);
  assertEquals(warningRebuildDue(row({ at: 5, setupWarnings: dirtyOnly }), [clean]), false);
  // A re-layer is judged by the build whose tree it carries.
  const relayer = row({ at: 6, setupWarnings: stepFailed });
  relayer.plan = { ...relayer.plan, relayerOf: { environmentId: first.id, bakedImage: "b" } };
  assertEquals(warningRebuildDue(relayer, [clean, retired, relayer]), true);
});
