// The drizzle EnvironmentStore against real PostgreSQL (PGlite, or RYPH_TEST_DB): round trips,
// the conditional settle, the claim's deployment-wide cap under concurrent claimers and its
// priority order, the heartbeat and the compare-and-set that hands a stranded build to one
// replica, and build git keys.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { drizzleEnvironmentStore } from "../src/adapters/store/drizzle_environments.ts";
import type { Environment } from "../src/core/types.ts";
import { makeTestDb } from "./db.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function row(id: string, overrides: Partial<Environment> = {}): Environment {
  return {
    id,
    subjectKind: "repo",
    subjectId: "cr-1",
    ref: "main",
    defaultBranch: true,
    commits: { api: "a".repeat(40) },
    definition: "b".repeat(40),
    baseDigest: "base@sha256:1",
    harnessDigest: "harness@sha256:2",
    image: null,
    bakedImage: null,
    machineImage: null,
    status: "queued",
    toolchains: {},
    sizeBytes: null,
    trigger: "push",
    reason: null,
    plan: {
      checkouts: [{ path: "api", connectedRepoId: "cr-1", ref: "main", commit: "a".repeat(40) }],
      dockerfileFrom: "api",
      cacheScope: { read: ["repo-cr-1"], write: "repo-cr-1" },
      relayerOf: null,
    },
    logRef: null,
    logTail: null,
    failure: null,
    egressRefusals: null,
    setupWarnings: null,
    imagesRemovedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

test("environments round-trip field for field, a big image size included", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    const ready = row("env-1", {
      status: "ready",
      image: `registry/x@sha256:${"c".repeat(64)}`,
      bakedImage: `registry/x@sha256:${"d".repeat(64)}`,
      sizeBytes: 8 * 1024 ** 3,
      toolchains: { rustc: "1.97.1", node: "24.3.0" },
      logRef: "environments/env-1.log",
      logTail: "built",
      setupWarnings: [{ kind: "invalid", path: "api", error: "setup.yml: not valid YAML" }],
      startedAt: T0,
      finishedAt: T0,
    });
    await store.createEnvironment(ready);
    assertEquals(await store.getEnvironment("env-1"), ready);
    assertEquals(await store.getEnvironment("env-nope"), null);

    await store.createEnvironment(
      row("env-2", { ref: "feat", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    await store.createEnvironment(row("env-3", { subjectId: "cr-2" }));
    assertEquals(
      (await store.listEnvironmentsForSubject("repo", "cr-1")).map((e) => e.id),
      ["env-2", "env-1"],
    );
    assertEquals(
      (await store.listEnvironmentsForSubject("repo", "cr-1", { ref: "main" })).map((e) => e.id),
      ["env-1"],
    );
    assertEquals(
      (await store.listEnvironmentsByStatus(["queued"])).map((e) => e.id).sort(),
      ["env-2", "env-3"],
    );
  } finally {
    await handle.close();
  }
});

test("the builds list pages newest first and narrows by status and subject", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    await store.createEnvironment(row("env-1", { status: "ready" }));
    await store.createEnvironment(
      row("env-2", { status: "failed", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    await store.createEnvironment(
      row("env-3", {
        subjectKind: "workspace",
        subjectId: "ws-1",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    const ids = (page: { environments: Environment[] }) => page.environments.map((e) => e.id);

    const first = await store.listEnvironments({ limit: 2 });
    assertEquals(ids(first), ["env-3", "env-2"]);
    assert(first.nextCursor !== null);
    const rest = await store.listEnvironments({ limit: 2, cursor: first.nextCursor });
    assertEquals(ids(rest), ["env-1"]);
    assertEquals(rest.nextCursor, null);

    assertEquals(ids(await store.listEnvironments({ limit: 10, statuses: ["failed", "ready"] })), [
      "env-2",
      "env-1",
    ]);
    assertEquals(ids(await store.listEnvironments({ limit: 10, statuses: [] })), []);
    assertEquals(
      ids(await store.listEnvironments({ limit: 10, subject: { kind: "workspace", id: "ws-1" } })),
      ["env-3"],
    );
    assertEquals(ids(await store.listEnvironments({ limit: 10, subjectKinds: ["repo"] })), [
      "env-2",
      "env-1",
    ]);
    assertEquals(ids(await store.listEnvironments({ limit: 10, subjectKinds: [] })), []);

    // A branch build shows only for the repos and workspaces named; the default branch's always.
    await store.createEnvironment(
      row("env-4", { ref: "feat", defaultBranch: false, createdAt: "2026-01-04T00:00:00.000Z" }),
    );
    assertEquals(ids(await store.listEnvironments({ limit: 10, branchBuildsFor: [] })), [
      "env-3",
      "env-2",
      "env-1",
    ]);
    assertEquals(
      ids(
        await store.listEnvironments({
          limit: 10,
          branchBuildsFor: ["cr-1"],
        }),
      ),
      ["env-4", "env-3", "env-2", "env-1"],
    );
    // One checkout the caller may not write hides the build, whatever its subject is now.
    await store.createEnvironment(row("env-5", {
      subjectKind: "workspace",
      subjectId: "ws-1",
      ref: "feat",
      defaultBranch: false,
      createdAt: "2026-01-05T00:00:00.000Z",
      plan: {
        ...row("x").plan,
        checkouts: [
          { path: "api", connectedRepoId: "cr-1", ref: "feat", commit: "a".repeat(40) },
          { path: "web", connectedRepoId: "cr-2", ref: "feat", commit: "b".repeat(40) },
        ],
      },
    }));
    assertEquals(
      ids(await store.listEnvironments({ limit: 10, branchBuildsFor: ["cr-1"] }))[0],
      "env-4",
    );
    assertEquals(
      ids(await store.listEnvironments({ limit: 10, branchBuildsFor: ["cr-1", "cr-2"] }))[0],
      "env-5",
    );
  } finally {
    await handle.close();
  }
});

test("a settle lands only over the status it expects", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    await store.createEnvironment(row("env-1", { status: "building" }));
    await store.saveEnvironment({ ...row("env-1"), status: "superseded" });
    assertEquals(
      await store.saveEnvironmentIfStatus({ ...row("env-1"), status: "ready" }, ["building"]),
      false,
    );
    assertEquals((await store.getEnvironment("env-1"))!.status, "superseded");
    assertEquals(
      await store.saveEnvironmentIfStatus({ ...row("env-1"), status: "ready" }, ["superseded"]),
      true,
    );
  } finally {
    await handle.close();
  }
});

test("removed images: listed once retired long enough, a page at a time, by baked image", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    const image = `registry/x@sha256:${"c".repeat(64)}`;
    const baked = "ryph-env/repo-cr-1:baked-env-1";
    const later = "2026-01-02T00:00:00.000Z";
    await store.createEnvironment(row("env-1", { status: "superseded", image, bakedImage: baked }));
    await store.createEnvironment(
      row("env-5", { status: "superseded", image, updatedAt: "2026-01-01T00:00:01.000Z" }),
    );
    await store.createEnvironment(row("env-6", { status: "superseded", image }));
    // Superseded mid-build, and failed: no image recorded, but the build may have pushed one.
    await store.createEnvironment(row("env-2", { status: "superseded" }));
    await store.createEnvironment(row("env-7", { status: "failed" }));
    await store.createEnvironment(row("env-8", { status: "building" }));
    await store.createEnvironment(row("env-3", { status: "ready", image, bakedImage: baked }));
    await store.createEnvironment(row("env-4", { status: "superseded", image, updatedAt: later }));
    // Retired before the cutoff only, oldest retired first, at most `limit`.
    assertEquals(
      (await store.listImagesToRemove(later, 10)).map((e) => e.id),
      ["env-1", "env-2", "env-6", "env-7", "env-5"],
    );
    const [first] = await store.listImagesToRemove(later, 1);
    assertEquals(first.id, "env-1");
    // The next page starts past the last row of the one before, ties broken by id.
    const [second] = await store.listImagesToRemove(later, 1, first);
    assertEquals(second.id, "env-2");
    assertEquals(
      (await store.listImagesToRemove(later, 5, second)).map((e) => e.id),
      ["env-6", "env-7", "env-5"],
    );
    assertEquals(
      (await store.listEnvironmentsByBakedImage(baked)).map((e) => e.id).sort(),
      ["env-1", "env-3"],
    );

    await store.markEnvironmentImagesRemoved("env-1", T0);
    await store.markEnvironmentImagesRemoved("env-3", T0);
    await store.markEnvironmentImagesRemoved("env-7", T0);
    assertEquals(
      (await store.listImagesToRemove(later, 10)).map((e) => e.id),
      ["env-2", "env-6", "env-5"],
    );
    assertEquals((await store.getEnvironment("env-1"))!.imagesRemovedAt, T0);
    assertEquals((await store.getEnvironment("env-3"))!.imagesRemovedAt, null, "not superseded");

    // A whole-row write from a copy read before the stamp does not take it off.
    await store.saveEnvironment(row("env-1", { status: "superseded", image }));
    assertEquals((await store.getEnvironment("env-1"))!.imagesRemovedAt, T0);
    // Taken back, by the stamp's own write.
    await store.markEnvironmentImagesRemoved("env-1", null);
    assertEquals((await store.getEnvironment("env-1"))!.imagesRemovedAt, null);
  } finally {
    await handle.close();
  }
});

test("rows naming a digest are found by it, as image, baked image or machine", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    await store.createEnvironment(row("env-1", { image: `r/a@${d("1")}` }));
    await store.createEnvironment(row("env-2", { bakedImage: `r/a@${d("2")}` }));
    await store.createEnvironment(row("env-3", { machineImage: `r/a@${d("3")}` }));
    await store.createEnvironment(row("env-4", { image: `r/a@${d("4")}` }));
    assertEquals(
      (await store.listEnvironmentsNamingDigests([d("1"), d("2"), d("3"), d("9")]))
        .map((e) => e.id).sort(),
      ["env-1", "env-2", "env-3"],
    );
    assertEquals((await store.getEnvironment("env-3"))!.machineImage, `r/a@${d("3")}`);
    assertEquals(await store.listEnvironmentsNamingDigests(["%"]), [], "only digests");
  } finally {
    await handle.close();
  }
});

test("claims hold the deployment-wide cap under concurrent claimers, re-layers first", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    await store.createEnvironment(
      row("env-base", { trigger: "base", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await store.createEnvironment(
      row("env-push", { trigger: "push", createdAt: "2026-01-01T00:00:01.000Z" }),
    );
    await store.createEnvironment(
      row("env-relayer", { trigger: "harness", createdAt: "2026-01-01T00:00:02.000Z" }),
    );
    await store.createEnvironment(
      row("env-run", { trigger: "run", createdAt: "2026-01-01T00:00:03.000Z" }),
    );
    const claims = await Promise.all([1, 2, 3, 4].map(() => store.claimNextBuild(T0, 2)));
    const claimed = claims.filter((c) => c !== null).map((c) => c!.id).sort();
    assertEquals(claimed, ["env-relayer", "env-run"], "two slots, and the builds runs wait for");
    assert(claims.every((c) => c === null || (c.status === "building" && c.startedAt === T0)));
    assertEquals((await store.listEnvironmentsByStatus(["building"])).length, 2);
    assertEquals(await store.claimNextBuild(T0, 2), null);
    await store.saveEnvironment({ ...(await store.getEnvironment("env-run"))!, status: "ready" });
    assertEquals((await store.claimNextBuild(T0, 2))!.id, "env-push");
    await store.saveEnvironment({ ...(await store.getEnvironment("env-push"))!, status: "ready" });
    assertEquals((await store.claimNextBuild(T0, 2))!.id, "env-base");
  } finally {
    await handle.close();
  }
});

test("a patch build is claimed with a run's, ahead of the default branch's; a base rebuild last", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    // Oldest first, so the order below is priority's, not age's.
    for (const [i, trigger] of (["base", "push", "patch"] as const).entries()) {
      await store.createEnvironment(
        row(`env-${trigger}`, { trigger, createdAt: `2026-01-01T00:00:0${i}.000Z` }),
      );
    }
    const order: string[] = [];
    for (let claimed; (claimed = await store.claimNextBuild(T0, 10)) !== null;) {
      order.push(claimed.id);
    }
    assertEquals(order, ["env-patch", "env-push", "env-base"]);
  } finally {
    await handle.close();
  }
});

test("the heartbeat stamps only a building row, and only one claimer takes a cold one", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  const T1 = "2026-01-01T00:05:00.000Z";
  const T2 = "2026-01-01T00:06:00.000Z";
  try {
    await store.createEnvironment(row("env-live", { status: "building", startedAt: T0 }));
    await store.createEnvironment(row("env-done", { status: "ready", finishedAt: T0 }));
    await store.touchBuild("env-live", T1);
    await store.touchBuild("env-done", T1);
    assertEquals((await store.getEnvironment("env-live"))!.updatedAt, T1);
    assertEquals(
      (await store.getEnvironment("env-done"))!.updatedAt,
      T0,
      "a heartbeat arriving after a settle must not put a finished row back in motion",
    );

    // Every replica's tick finds the same cold row at the same moment; the compare-and-set on
    // the stamp is what makes exactly one of them the one that goes asking the builder.
    const taken = await Promise.all(
      [1, 2, 3].map(() => store.claimStrandedBuild("env-live", T1, T2)),
    );
    const took = taken.filter((t) => t !== null);
    assertEquals(took.map((t) => t!.id), ["env-live"]);
    // The claimed row is what the adopter then settles, so it has to come back whole.
    assertEquals(took[0]!.plan, row("env-live").plan);
    assertEquals(took[0]!.commits, row("env-live").commits);
    assertEquals(took[0]!.startedAt, T0);
    assertEquals(took[0]!.updatedAt, T2);
    assertEquals((await store.getEnvironment("env-live"))!.updatedAt, T2);
    assertEquals(await store.claimStrandedBuild("env-live", T1, T2), null, "the stamp moved on");
    assertEquals(
      await store.claimStrandedBuild("env-done", T0, T2),
      null,
      "and a row that is not building is nobody's to take over",
    );
  } finally {
    await handle.close();
  }
});

test("build git keys: hash lookup, and revocation per build", async () => {
  const handle = await makeTestDb();
  const store = drizzleEnvironmentStore(handle);
  try {
    await store.createEnvironment(row("env-1"));
    await store.createBuildGitKey({
      id: "bk-1",
      environmentId: "env-1",
      tokenHash: "h".repeat(64),
      expiresAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null,
      createdAt: T0,
    });
    assertEquals((await store.getBuildGitKeyByTokenHash("h".repeat(64)))!.environmentId, "env-1");
    assertEquals(await store.getBuildGitKeyByTokenHash("x".repeat(64)), null);
    await store.revokeBuildGitKeys("env-1", T0);
    assertEquals((await store.getBuildGitKeyByTokenHash("h".repeat(64)))!.revokedAt, T0);
  } finally {
    await handle.close();
  }
});
