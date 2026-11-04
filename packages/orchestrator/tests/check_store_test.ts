// The CheckStore contract, held to BOTH implementations: the drizzle store over a real
// PostgreSQL (PGlite, or RYPH_TEST_DB) and the in-memory double the engine suites run on — so a
// behaviour the engine tests lean on is a behaviour the deployed store has.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import type {
  CheckApproval,
  CheckForgeReport,
  CheckRequest,
  CheckResult,
  CheckSuite,
} from "../src/core/check_types.ts";
import type { ConnectedRepo, Patch, Run } from "../src/core/types.ts";
import type { CheckStore } from "../src/ports/check_store.ts";
import { drizzleCheckStore } from "../src/adapters/store/drizzle_checks.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { drizzleEnvironmentStore } from "../src/adapters/store/drizzle_environments.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { memoryCheckStore } from "./check_doubles.ts";
import { memoryTaskStore } from "./memory_store.ts";
import type { TaskStore } from "../src/ports/task_store.ts";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const T3 = "2026-01-01T00:03:00.000Z";
const sha = (c: string) => c.repeat(40);

const REPO: ConnectedRepo = {
  id: "cr-1",
  provider: "github",
  installationId: "42",
  repoRef: "acme/api",
  url: "https://github.com/acme/api.git",
  defaultBranch: "main",
  submissionPolicy: "require-approval",
  sizeClass: null,
  allowForkPushes: false,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

function suite(over: Partial<CheckSuite> = {}): CheckSuite {
  return {
    id: "cs-0000000001",
    remote: null,
    connectedRepoId: REPO.id,
    commit: sha("d"),
    checksRef: "main",
    checksCommit: sha("a"),
    checksBlob: sha("c"),
    checksPath: ".ryph/checks.yml",
    definition: {
      setup: [],
      checks: [{ name: "lint", run: "x", timeoutSeconds: 60, services: [], watch: [] }],
    },
    environmentKey: "default:img",
    inputsKey: "k",
    networkScope: { mode: "open" as const, bundles: [], hosts: [] },
    environmentId: null,
    image: "img",
    services: [],
    source: { runId: "r-1", path: "api", bundleKey: "k", branchName: "b", baseRef: "main" },
    state: "queued",
    generation: 1,
    reason: null,
    attempts: 0,
    ryphChanged: null,
    leaseUntil: null,
    pods: null,
    version: 0,
    waitingSince: null,
    nextAttemptAt: null,
    launchedAt: null,
    finishedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    suiteId: "cs-0000000001",
    generation: 1,
    name: "lint",
    state: "queued",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    logKey: null,
    logTail: null,
    watchedChanged: null,
    forgeRef: null,
    inheritedFrom: null,
    ...over,
  };
}

function request(over: Partial<CheckRequest> = {}): CheckRequest {
  return {
    id: "cq-0000000001",
    remote: null,
    suiteId: null,
    rerunOf: null,
    connectedRepoId: REPO.id,
    commit: sha("d"),
    runId: null,
    patchId: null,
    changeRequest: null,
    userId: null,
    kind: "tool",
    state: "pending",
    note: null,
    source: { runId: "r-1", path: "api", bundleKey: "k", branchName: "b", baseRef: "main" },
    checksRef: "main",
    reportedGeneration: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: T0,
    expiresAt: null,
    ...over,
  };
}

function report(over: Partial<CheckForgeReport> = {}): CheckForgeReport {
  return {
    id: "fr-0000000001",
    patchId: "p-1",
    requestId: null,
    connectedRepoId: REPO.id,
    headSha: sha("d"),
    checksRef: "main",
    suiteId: null,
    reportedFingerprint: null,
    attempts: 0,
    nextAttemptAt: T0,
    lastError: null,
    disabledUntil: null,
    revision: 0,
    openGenerations: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** The rows the check tables' foreign keys point at: a repo, a run and a patch. */
async function seed(tasks: TaskStore): Promise<{ runId: string; patchId: string }> {
  await tasks.createConnectedRepo(REPO);
  await tasks.createAgent({
    id: "a-1",
    name: "Ada",
    handle: "ada",
    email: "ada@example.com",
    systemPrompt: null,
    harnessKind: "echo",
    modelPolicy: null,
    toolPolicy: null,
    memoryPolicy: null,
    forgePolicy: null,
    networkPolicy: null,
    limitPolicy: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  } as never);
  const run = {
    id: "r-1",
    taskId: "t-1",
    agentId: "a-1",
    state: "running",
    phase: null,
    heartbeatSeq: 0,
    lastHeartbeatAt: null,
    desiredState: null,
    cancelRequestedAt: null,
    attended: false,
    idleDeadlineAt: null,
    originThreadRepoId: null,
    originThreadKind: null,
    originThreadRef: null,
    originChatroomId: null,
    originThreadKey: null,
    tokenHash: "h",
    controlToken: "c",
    handle: null,
    launchedAt: null,
    branchNamespace: "b",
    image: null,
    environmentId: null,
    environment: null,
    environmentWait: null,
    workItem: {} as never,
    injectedContext: null,
    modelScope: null,
    toolScope: null,
    forgeScope: null,
    services: null,
    networkScope: { mode: "open" } as never,
    limits: { deadlineMs: null, spendUsd: null, callsInFlight: null } as never,
    egressRefusals: null,
    result: null,
    memoryOutcomeReportedAt: null,
    skillsReportedAt: null,
    createdAt: T0,
    updatedAt: T0,
  } as unknown as Run;
  await tasks.createTask({
    id: "t-1",
    agentId: "a-1",
    spec: { title: "T", instructions: "I" },
    repos: [],
    workspaceId: null,
    origin: "user",
    requestedByUserId: "u-1",
    requestedVia: null,
    targetChangeRequest: null,
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    purpose: null,
    createdAt: T0,
  } as never, run);
  const patch: Patch = {
    id: "p-1",
    connectedRepoId: REPO.id,
    runId: run.id,
    taskId: "t-1",
    setId: "ps-1",
    path: "api",
    line: "work",
    branchName: "b",
    headSha: sha("d"),
    bundleKey: "k",
    baseSha: null,
    generation: 1,
    title: null,
    description: null,
    commits: [],
    carries: [],
    state: "submitted",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    approvedBy: null,
    approvedAt: null,
    forgeRef: "7",
    forgeUrl: null,
    forgeBranch: "b",
    diffRef: null,
    landed: null,
    supersededByPatchId: null,
    hookCheck: null,
    approvedHookPaths: [],
    memoryFateReportedAt: null,
    mergedCuedAt: null,
    heldReason: null,
    mergedCueClaimedAt: null,
    landingAskedAt: null,
    version: 0,
    createdAt: T0,
    updatedAt: T0,
  };
  await tasks.createPatch(patch);
  return { runId: run.id, patchId: patch.id };
}

const implementations: Array<[string, () => Promise<{ store: CheckStore; tasks: TaskStore }>]> = [
  ["drizzle", async () => {
    const handle = await makeTestDb();
    return { store: drizzleCheckStore(handle), tasks: drizzleTaskStore(handle) };
  }],
  ["memory", () => {
    const tasks = memoryTaskStore();
    return Promise.resolve({ store: memoryCheckStore(tasks), tasks });
  }],
];

for (const [kind, make] of implementations) {
  test(`${kind}: a suite is claimed on its identity, and a second claim joins it`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const first = await store.claimSuite(suite());
    assertEquals(first.created, true);
    const second = await store.claimSuite(suite({ id: "cs-0000000002", state: "waiting" }));
    assertEquals(second.created, false);
    assertEquals(second.suite.id, "cs-0000000001");
    assertEquals(second.suite.state, "queued");
    // A different blob is a different suite.
    assertEquals(
      (await store.claimSuite(suite({ id: "cs-0000000003", checksBlob: sha("e") }))).created,
      true,
    );
    assertEquals(
      (await store.findSuiteByIdentity({
        connectedRepoId: REPO.id,
        commit: sha("d"),
        checksBlob: sha("c"),
        environmentKey: "default:img",
        inputsKey: "k",
      }))?.id,
      "cs-0000000001",
    );
    assertEquals((await store.listSuitesForCommit(REPO.id, sha("d"))).length, 2);
    assertEquals(
      (await store.listSuitesByIds(["cs-0000000003", "cs-0000000001"])).map((s) => s.id),
      ["cs-0000000001", "cs-0000000003"],
    );
    const got = await store.getSuite("cs-0000000001");
    assertEquals(got, suite());
  });

  test(`${kind}: a suite moves only by compare-and-set on state, generation, lease and version`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite());
    const running = suite({ state: "running", leaseUntil: T1, attempts: 1, updatedAt: T1 });
    assertEquals(await store.saveSuiteIf(running, { states: ["queued"], generation: 1 }), true);
    assertEquals(await store.saveSuiteIf(running, { states: ["queued"], generation: 1 }), false);
    assertEquals(
      await store.saveSuiteIf({ ...running, leaseUntil: T2 }, {
        states: ["running"],
        generation: 1,
        leaseUntil: T0,
      }),
      false,
      "a stale lease loses",
    );
    assertEquals(
      await store.saveSuiteIf({ ...running, leaseUntil: null }, {
        states: ["running"],
        generation: 2,
      }),
      false,
      "a stale generation loses",
    );
    assertEquals(
      await store.saveSuiteIf({ ...running, leaseUntil: null, launchedAt: T1 }, {
        states: ["running"],
        generation: 1,
        leaseUntil: T1,
      }),
      true,
    );
    // Every write bumped it, whatever the row written said: claimed at 0, then two writes.
    assertEquals((await store.getSuite(running.id))!.version, 2);
    const pods = {
      "ryph-check-cs-0000000001-g1-o0-e2e": {
        attempts: 2,
        launchedAt: T2,
        keyId: null,
        reason: null,
      },
    };
    assertEquals(
      await store.saveSuiteIf({ ...running, leaseUntil: null, pods }, {
        states: ["running"],
        generation: 1,
        leaseUntil: null,
        version: 1,
      }),
      false,
      "a read older than the last write loses, written in the same millisecond or not",
    );
    assertEquals(
      await store.saveSuiteIf({ ...running, leaseUntil: null, launchedAt: T1, pods, version: 9 }, {
        states: ["running"],
        generation: 1,
        leaseUntil: null,
        version: 2,
      }),
      true,
    );
    assertEquals((await store.getSuite(running.id))!.pods, pods);
    assertEquals(
      (await store.getSuite(running.id))!.version,
      3,
      "the store's count, not the row's",
    );
    assertEquals(
      await store.saveSuiteIf({ ...running, state: "passed", leaseUntil: null }, {
        states: ["running"],
        generation: 1,
        leaseUntil: null,
      }),
      true,
    );
    assertEquals((await store.getSuite(running.id))!.state, "passed");
    assertEquals(await store.countSuitesByState(["passed"]), 1);
    assertEquals((await store.listSuitesByState(["queued", "running"])).length, 0);
    await store.claimSuite(suite({
      id: "cs-0000000009",
      commit: sha("9"),
      state: "waiting",
      environmentId: null,
    }));
    assertEquals((await store.listSuitesByState(["waiting"])).map((s) => s.id), ["cs-0000000009"]);
  });

  test(`${kind}: whether .ryph/ changed is stamped once, only over null, outside the version`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite({ state: "running", ryphChanged: null }));
    await store.setSuiteRyphChanged(suite().id, true);
    const stamped = (await store.getSuite(suite().id))!;
    assertEquals(stamped.ryphChanged, true);
    // Unleased: a lease holder's compare-and-set from the row read before it still lands, and
    // keeps the stamp over its own null.
    assertEquals(stamped.version, 0);
    assertEquals(
      await store.saveSuiteIf({ ...stamped, ryphChanged: null, reason: "held" }, {
        states: ["running"],
        generation: 1,
        version: 0,
      }),
      true,
    );
    await store.setSuiteRyphChanged(suite().id, false);
    const after = (await store.getSuite(suite().id))!;
    assertEquals([after.ryphChanged, after.reason], [true, "held"], "the first answer stands");
    assertEquals(after.version, 1, "the save bumped it, the stamps did not");
  });

  test(`${kind}: results upsert per generation and keep a posted check run's id`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite());
    await store.upsertResults([result(), result({ name: "test" })]);
    await store.setResultForgeRef("cs-0000000001", 1, "lint", "4242");
    await store.upsertResults([result({ state: "passed", exitCode: 0, finishedAt: T1 })]);
    await store.upsertResults([result({ generation: 2 })]);
    const gen1 = await store.listResults("cs-0000000001", 1);
    assertEquals(gen1.map((r) => [r.name, r.state, r.exitCode, r.forgeRef]), [
      ["lint", "passed", 0, "4242"],
      ["test", "queued", null, null],
    ]);
    assertEquals((await store.listResults("cs-0000000001")).length, 3);
    assertEquals((await store.listResults("cs-0000000001", 2))[0].forgeRef, null);
    // A settled row keeps its first verdict: a slower replica's progress or settle lands on
    // nothing.
    await store.upsertResults([
      result({ state: "running" }),
      result({ state: "failed", exitCode: 1 }),
      result({ name: "test", state: "failed", exitCode: 2, finishedAt: T1 }),
    ]);
    assertEquals(
      (await store.listResults("cs-0000000001", 1)).map((r) => [r.name, r.state, r.exitCode]),
      [["lint", "passed", 0], ["test", "failed", 2]],
    );
    await store.upsertResults([result({ name: "test", state: "error" })]);
    assertEquals((await store.listResults("cs-0000000001", 1))[1].state, "failed");
  });

  test(`${kind}: request note fencing preserves remote cancellation across stale writes`, async () => {
    const { store, tasks } = await make();
    const { runId } = await seed(tasks);
    const original = request({ runId, note: null });
    await store.createRequest(original);
    assert(
      await store.saveRequestIf({ ...original, note: "observed" }, ["pending"], {
        noteNot: "withdrawal",
      }),
      "noteNot includes a NULL note",
    );
    assertEquals(await store.saveRequestIf(original, ["pending"], { note: null }), false);
    assert(
      await store.saveRequestIf({ ...original, note: "withdrawal" }, ["pending"], {
        note: "observed",
      }),
    );
    assertEquals(
      await store.saveRequestIf({ ...original, state: "active" }, ["pending"], {
        noteNot: "withdrawal",
      }),
      false,
    );
    assertEquals((await store.getRequest(original.id))!.note, "withdrawal");
    assert(
      await store.saveRequestIf({ ...original, state: "superseded" }, ["pending"], {
        note: "withdrawal",
      }),
    );
  });

  test(`${kind}: requests — pending and due, per run and patch, told once per generation`, async () => {
    const { store, tasks } = await make();
    const { runId, patchId } = await seed(tasks);
    await store.claimSuite(suite({ state: "failed", generation: 1 }));
    await store.createRequest(request({ runId, nextAttemptAt: T1 }));
    await store.createRequest(request({ id: "cq-0000000002", runId, kind: "patch", patchId }));
    assertEquals((await store.listPendingRequests(T0, 10)).map((r) => r.id), ["cq-0000000002"]);
    assertEquals((await store.listPendingRequests(T1, 10)).length, 2);
    assertEquals(await store.countToolRequestsForRun(runId), 1);
    assertEquals((await store.listRequestsForPatches([patchId])).map((r) => r.id), [
      "cq-0000000002",
    ]);
    assertEquals((await store.listRequestsForRun(runId)).length, 2);

    // A resolve lands only on a pending request: a superseded one stays superseded.
    assert(
      await store.saveRequestIf(request({ runId, suiteId: "cs-0000000001", state: "active" }), [
        "pending",
      ]),
    );
    assertEquals(
      await store.saveRequestIf(request({ runId, state: "refused" }), ["pending"]),
      false,
    );
    assertEquals((await store.listRequestsForSuite("cs-0000000001")).length, 1);
    assertEquals(
      (await store.listRequestsForCommit(REPO.id, sha("d"))).map((r) => [r.id, r.state]),
      [["cq-0000000001", "active"], ["cq-0000000002", "pending"]],
    );
    assertEquals((await store.listRequestsForCommit(REPO.id, sha("e"))).length, 0);
    assertEquals((await store.listRequestsToTell(10)).map((r) => r.id), ["cq-0000000001"]);
    assertEquals(await store.markRequestReported("cq-0000000001", 1), true);
    assertEquals(await store.markRequestReported("cq-0000000001", 1), false);
    assertEquals((await store.listRequestsToTell(10)).length, 0);
    // A re-run's generation is told again.
    const gen2 = suite({ state: "passed", generation: 2 });
    assert(await store.saveSuiteIf(gen2, { states: ["failed"], generation: 1 }));
    assertEquals((await store.listRequestsToTell(10)).map((r) => r.id), ["cq-0000000001"]);
    assertEquals(await store.markRequestReported("cq-0000000001", 2), true);
  });

  test(`${kind}: forge reports — due, touched per suite or head, upserted by patch, re-pointed`, async () => {
    const { store, tasks } = await make();
    const { patchId } = await seed(tasks);
    const ID = "fr-0000000001";
    await store.claimSuite(suite());
    await store.upsertForgeReport(report({ patchId, nextAttemptAt: T1 }));
    assertEquals((await store.listDueForgeReports(T0, 10)).length, 0);
    assertEquals((await store.listDueForgeReports(T1, 10)).length, 1);
    assertEquals((await store.listForgeReportsForCommit(REPO.id, sha("d"))).map((r) => r.id), [ID]);
    assertEquals((await store.listForgeReportsForCommit(REPO.id, sha("e"))).length, 0);
    // A report settles: what it said lands, and so does its clock — it read the latest revision.
    await store.settleForgeReport(ID, { reportedFingerprint: "1:q:x", updatedAt: T1 }, {
      nextAttemptAt: null,
      readRevision: 0,
      readSuiteId: null,
    });
    let row = (await store.getForgeReport(ID))!;
    assertEquals([row.reportedFingerprint, row.nextAttemptAt, row.revision], ["1:q:x", null, 0]);
    // Upserting again — under a fresh id, as every relay mints one — only makes the patch's row
    // due; what the forge was told stays.
    await store.upsertForgeReport(
      report({ id: "fr-0000000002", patchId, nextAttemptAt: T0, updatedAt: T1 }),
    );
    assertEquals((await store.findForgeReport({ patchId }))!.id, ID);
    assertEquals(await store.getForgeReport("fr-0000000002"), null);
    row = (await store.getForgeReport(ID))!;
    assertEquals([row.reportedFingerprint, row.nextAttemptAt, row.revision], ["1:q:x", T0, 1]);
    // A touch while a report is in flight: the report's result lands, its clock does not.
    await store.touchForgeReports(suite(), T2);
    await store.settleForgeReport(ID, { suiteId: "cs-0000000001", attempts: 0 }, {
      nextAttemptAt: null,
      readRevision: 1,
      readSuiteId: null,
    });
    row = (await store.getForgeReport(ID))!;
    assertEquals([row.suiteId, row.nextAttemptAt, row.revision], ["cs-0000000001", T2, 2]);
    // Bound to its suite, it is touched by that suite and no other head's.
    await store.settleForgeReport(ID, {}, {
      nextAttemptAt: null,
      readRevision: 2,
      readSuiteId: "cs-0000000001",
    });
    await store.touchForgeReports(suite({ id: "cs-other0000", commit: sha("e") }), T1);
    assertEquals((await store.getForgeReport(ID))!.nextAttemptAt, null);
    await store.touchForgeReports(suite(), T1);
    assertEquals((await store.getForgeReport(ID))!.nextAttemptAt, T1);
    // A re-run's new suite of the head takes the row over, due at once.
    await store.settleForgeReport(ID, {}, {
      nextAttemptAt: null,
      readRevision: 3,
      readSuiteId: "cs-0000000001",
    });
    await store.repointForgeReports("cs-other0000", { id: "cs-nobody000" }, T2);
    assertEquals((await store.getForgeReport(ID))!.suiteId, "cs-0000000001");
    await store.claimSuite(suite({ id: "cs-0000000009", checksBlob: sha("9") }));
    await store.repointForgeReports("cs-0000000001", { id: "cs-0000000009" }, T2);
    row = (await store.getForgeReport(ID))!;
    assertEquals([row.suiteId, row.nextAttemptAt, row.revision], ["cs-0000000009", T2, 4]);
    // A report of the old suite that was in flight across the repoint: what it said lands, the
    // suite it read does not come back, and neither does its clock.
    await store.settleForgeReport(ID, {
      suiteId: "cs-0000000001",
      reportedFingerprint: "cs-0000000001:1:running:x",
      openGenerations: [{ suiteId: "cs-0000000001", generation: 1 }],
    }, { nextAttemptAt: null, readRevision: 3, readSuiteId: "cs-0000000001" });
    row = (await store.getForgeReport(ID))!;
    assertEquals(
      [row.suiteId, row.nextAttemptAt, row.reportedFingerprint, row.openGenerations],
      [
        "cs-0000000009",
        T2,
        "cs-0000000001:1:running:x",
        [{ suiteId: "cs-0000000001", generation: 1 }],
      ],
    );
    // Upserting again keeps what was remembered.
    await store.upsertForgeReport(report({ patchId, nextAttemptAt: T0 }));
    assertEquals((await store.getForgeReport(ID))!.openGenerations, [
      { suiteId: "cs-0000000001", generation: 1 },
    ]);
  });

  test(`${kind}: a push request's forge row is its own, beside a patch's on the same head`, async () => {
    const { store, tasks } = await make();
    const { patchId } = await seed(tasks);
    const push = request({
      id: "cq-0000000007",
      kind: "push",
      changeRequest: "42",
      source: {
        runId: null,
        changeRequest: "42",
        fetchRef: "refs/pull/42/head",
        branchName: "pull/42/head",
        baseRef: "main",
        url: null,
      },
    });
    await store.createRequest(push);
    await store.upsertForgeReport(report({ patchId, nextAttemptAt: T1 }));
    await store.upsertForgeReport(
      report({ id: "fr-0000000003", patchId: null, requestId: push.id, nextAttemptAt: T1 }),
    );
    assertEquals((await store.findForgeReport({ requestId: push.id }))!.id, "fr-0000000003");
    assertEquals((await store.findForgeReport({ patchId }))!.id, "fr-0000000001");
    assertEquals((await store.listDueForgeReports(T1, 10)).map((r) => r.id), [
      "fr-0000000001",
      "fr-0000000003",
    ]);
    // The push request's again: a touch of ITS row, the patch's untouched.
    await store.upsertForgeReport(
      report({ id: "fr-0000000004", patchId: null, requestId: push.id, nextAttemptAt: T2 }),
    );
    const row = (await store.getForgeReport("fr-0000000003"))!;
    assertEquals([row.nextAttemptAt, row.revision, row.checksRef], [T2, 1, "main"]);
    assertEquals((await store.getForgeReport("fr-0000000001"))!.revision, 0);
    // Settled by id, as every row is.
    await store.settleForgeReport("fr-0000000003", { lastError: "x" }, {
      nextAttemptAt: null,
      readRevision: 1,
      readSuiteId: null,
    });
    assertEquals((await store.getForgeReport("fr-0000000003"))!.lastError, "x");
    assertEquals((await store.getForgeReport("fr-0000000001"))!.lastError, null);
  });

  test(`${kind}: a withdraw sets aside only a live request, and answers it as stored`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite());
    await store.createRequest(request({ nextAttemptAt: T1 }));
    // Resolved after the withdrawer read it as pending: the withdraw answers the suite it holds.
    const read = (await store.getRequest("cq-0000000001"))!;
    assert(
      await store.saveRequestIf(
        { ...read, state: "active", suiteId: "cs-0000000001", note: "n" },
        ["pending"],
      ),
    );
    const withdrawn = (await store.withdrawRequest(read.id))!;
    assertEquals(
      [withdrawn.state, withdrawn.suiteId, withdrawn.nextAttemptAt, withdrawn.note],
      ["superseded", "cs-0000000001", null, "n"],
    );
    assertEquals((await store.getRequest(read.id))!.suiteId, "cs-0000000001");
    // A pending one goes the same way, its clock cleared.
    await store.createRequest(request({ id: "cq-0000000003", nextAttemptAt: T2 }));
    const pending = (await store.withdrawRequest("cq-0000000003"))!;
    assertEquals([pending.state, pending.suiteId, pending.nextAttemptAt], [
      "superseded",
      null,
      null,
    ]);
    // Already set aside, or refused: nothing to withdraw.
    assertEquals(await store.withdrawRequest(read.id), null);
    await store.createRequest(request({ id: "cq-0000000002", state: "refused" }));
    assertEquals(await store.withdrawRequest("cq-0000000002"), null);
    assertEquals(await store.withdrawRequest("cq-nobody0000"), null);
  });

  test(`${kind}: a forge row names exactly one asker`, async () => {
    const { store, tasks } = await make();
    const { patchId } = await seed(tasks);
    // A real request, so only the rule can refuse the row naming both.
    await store.createRequest(request({ id: "cq-0000000005" }));
    let refused = 0;
    for (
      const over of [{ patchId: null, requestId: null }, { patchId, requestId: "cq-0000000005" }]
    ) {
      await store.upsertForgeReport(report({ id: "fr-0000000009", ...over })).catch(() =>
        refused++
      );
    }
    assertEquals(refused, 2);
    assertEquals(await store.getForgeReport("fr-0000000009"), null);
  });

  test(`${kind}: a change request's push requests are found by it, and one by id`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const forge = (changeRequest: string) => ({
      runId: null,
      changeRequest,
      fetchRef: null,
      branchName: `patches/${changeRequest}`,
      baseRef: "main",
      url: null,
    });
    await store.createRequest(
      request({ id: "cq-0000000001", kind: "push", changeRequest: "42", source: forge("42") }),
    );
    await store.createRequest(
      request({
        id: "cq-0000000002",
        kind: "push",
        changeRequest: "43",
        source: forge("43"),
        createdAt: T1,
      }),
    );
    await store.createRequest(
      request({
        id: "cq-0000000003",
        kind: "push",
        changeRequest: "42",
        source: forge("42"),
        createdAt: T2,
      }),
    );
    // A tool request on the same head is no push.
    await store.createRequest(request({ id: "cq-0000000004" }));
    assertEquals((await store.listPushRequests(REPO.id, "42")).map((r) => r.id), [
      "cq-0000000001",
      "cq-0000000003",
    ]);
    // Every state: one set aside is still the change request's.
    await store.withdrawRequest("cq-0000000001");
    assertEquals(
      (await store.listPushRequests(REPO.id, "42")).map((r) => [r.id, r.state]),
      [["cq-0000000001", "superseded"], ["cq-0000000003", "pending"]],
    );
    assertEquals(await store.listPushRequests("cr-other", "42"), []);
    assertEquals((await store.getRequest("cq-0000000002"))!.source, forge("43"));
    assertEquals(await store.getRequest("cq-nobody0000"), null);
  });

  test(`${kind}: a re-run request names the suite it re-runs`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite());
    await store.createRequest(request({ kind: "rerun", rerunOf: "cs-0000000001" }));
    const [pending] = await store.listPendingRequests(T2, 10);
    assertEquals([pending.suiteId, pending.rerunOf], [null, "cs-0000000001"]);
  });

  test(`${kind}: suites page by id after a cursor, whatever was written last`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    for (const n of [3, 1, 2]) {
      await store.claimSuite(
        suite({ id: `cs-000000000${n}`, checksBlob: sha(String(n)), state: "waiting" }),
      );
    }
    const page = async (after?: string) =>
      (await store.listSuitesByState(["waiting"], 2, after)).map((s) => s.id);
    assertEquals(await page(""), ["cs-0000000001", "cs-0000000002"]);
    assertEquals(await page("cs-0000000002"), ["cs-0000000003"]);
  });

  test(`${kind}: the checks list pages newest first, filtered and scoped in the query`, async () => {
    const { store, tasks } = await make();
    const { runId, patchId } = await seed(tasks);
    const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
    const add = async (n: number, over: Partial<CheckSuite>, asked: Partial<CheckRequest>[]) => {
      const id = `cs-000000000${n}`;
      await store.claimSuite(suite({ id, checksBlob: sha(String(n)), createdAt: at(n), ...over }));
      for (const [i, r] of asked.entries()) {
        await store.createRequest(
          request({ id: `cq-00000000${n}${i}`, suiteId: id, state: "active", ...r }),
        );
      }
    };
    // Through the run, the patch, and only the source's run (a re-run's); one nobody asked for,
    // and one whose only asker came from a run that is gone.
    const gone = { runId: "r-gone", path: "api", bundleKey: "k", branchName: "b", baseRef: "main" };
    await add(1, { state: "passed" }, [{ kind: "tool", runId, source: { ...gone, runId } }]);
    await add(2, { state: "failed" }, [{ kind: "patch", patchId, source: gone }]);
    await add(3, { state: "running" }, [{ kind: "rerun" }]);
    await add(4, { state: "error", checksRef: "release" }, []);
    await add(5, {
      state: "passed",
      definition: { ...suite().definition, partial: true },
    }, [{ kind: "tool", runId, state: "superseded" }]);
    await add(6, { state: "failed" }, [{ kind: "forge", state: "refused", source: gone }]);

    const ids = async (query: Partial<Parameters<CheckStore["listSuites"]>[0]> = {}) =>
      (await store.listSuites({ limit: 10, ...query })).suites.map((s) => s.id.slice(-1));
    assertEquals(await ids(), ["6", "5", "4", "3", "2", "1"]);
    assertEquals(await ids({ states: ["failed", "error"] }), ["6", "4", "2"]);
    assertEquals(await ids({ states: [] }), []);
    assertEquals(await ids({ connectedRepoId: "cr-nope" }), []);
    assertEquals(await ids({ full: true }), ["6", "4", "3", "2", "1"]);
    assertEquals(await ids({ checksRef: "release" }), ["4"]);
    assertEquals(await ids({ askedBy: ["tool"] }), ["5", "1"], "a superseded asker still asked");
    assertEquals(await ids({ askedBy: ["rerun", "forge"] }), ["3"], "a refused one did not");

    const own = { kind: "principal" as const, userId: "u-1", writableRepoIds: [] };
    const stranger = { kind: "principal" as const, userId: "u-2", writableRepoIds: [REPO.id] };
    assertEquals(await ids({ scope: own }), ["5", "3", "2", "1"]);
    assertEquals(await ids({ scope: { kind: "all" } }), ["6", "5", "4", "3", "2", "1"]);
    // Write on the repo is not enough: the seeded task checks out no connected repo.
    assertEquals(await ids({ scope: stranger }), []);

    // Pages are full under a filter, and the cursor carries on after the last row shown.
    const first = await store.listSuites({ limit: 2, scope: own });
    assertEquals(first.suites.map((s) => s.id.slice(-1)), ["5", "3"]);
    assert(first.nextCursor !== null);
    const second = await store.listSuites({ limit: 2, scope: own, cursor: first.nextCursor });
    assertEquals(second.suites.map((s) => s.id.slice(-1)), ["2", "1"]);
    assertEquals(second.nextCursor, null);
  });

  test(`${kind}: a list page's requests and results are read for many suites at once`, async () => {
    const { store, tasks } = await make();
    const { runId } = await seed(tasks);
    const one = "cs-0000000001";
    const two = "cs-0000000002";
    await store.claimSuite(suite({ id: one }));
    await store.claimSuite(suite({ id: two, checksBlob: sha("2") }));
    await store.createRequest(request({ id: "cq-0000000003", suiteId: two, createdAt: T2 }));
    await store.createRequest(request({ suiteId: one, runId, createdAt: T1 }));
    await store.createRequest(request({ id: "cq-0000000002", createdAt: T0 }));
    assertEquals((await store.listRequestsForSuites([one, two])).map((r) => r.id), [
      "cq-0000000001",
      "cq-0000000003",
    ]);
    assertEquals((await store.listRequestsForSuites([two])).map((r) => r.id), ["cq-0000000003"]);
    assertEquals(await store.listRequestsForSuites([]), []);

    await store.upsertResults([
      result({ suiteId: one, generation: 1, name: "test" }),
      result({ suiteId: one, generation: 1, name: "lint" }),
      result({ suiteId: one, generation: 2, name: "lint" }),
      result({ suiteId: two, generation: 1, name: "lint" }),
      result({ suiteId: two, generation: 2, name: "lint" }),
    ]);
    const read = await store.listResultsForGenerations([
      { suiteId: one, generation: 1 },
      { suiteId: two, generation: 2 },
    ]);
    assertEquals(read.map((r) => [r.suiteId.slice(-1), r.generation, r.name]), [
      ["1", 1, "lint"],
      ["1", 1, "test"],
      ["2", 2, "lint"],
    ]);
    assertEquals(await store.listResultsForGenerations([]), []);
  });

  test(`${kind}: a hidden task's asking does not count toward the asker filter`, async () => {
    const { store, tasks } = await make();
    const { patchId } = await seed(tasks);
    // A second task, its run and its own asking all someone else's.
    const run = (await tasks.getRun("r-1"))!;
    const task = (await tasks.getTask("t-1"))!;
    await tasks.createTask(
      { ...task, id: "t-2", requestedByUserId: "u-2" },
      { ...run, id: "r-2", taskId: "t-2", tokenHash: "h2", controlToken: "c2" },
    );
    const hidden = { runId: "r-2", path: "api", bundleKey: "k", branchName: "b", baseRef: "main" };
    await store.claimSuite(suite());
    await store.createRequest(
      request({ suiteId: "cs-0000000001", kind: "patch", patchId, state: "active" }),
    );
    await store.createRequest(request({
      id: "cq-0000000002",
      suiteId: "cs-0000000001",
      runId: "r-2",
      source: hidden,
      state: "active",
    }));
    const ids = async (query: Partial<Parameters<CheckStore["listSuites"]>[0]>) =>
      (await store.listSuites({ limit: 10, ...query })).suites.map((s) => s.id);
    const own = { kind: "principal" as const, userId: "u-1", writableRepoIds: [] };
    const other = { kind: "principal" as const, userId: "u-2", writableRepoIds: [] };
    assertEquals(await ids({ scope: own }), ["cs-0000000001"], "visible through the patch");
    assertEquals(await ids({ scope: own, askedBy: ["patch"] }), ["cs-0000000001"]);
    assertEquals(await ids({ scope: own, askedBy: ["tool"] }), [], "the tool call is not theirs");
    assertEquals(await ids({ scope: other, askedBy: ["tool"] }), ["cs-0000000001"]);
    assertEquals(await ids({ askedBy: ["tool"] }), ["cs-0000000001"]);
    // A push to a change request names no task: a stranger still sees nothing of it, a reader of
    // every task finds it.
    await store.createRequest(request({
      id: "cq-0000000003",
      suiteId: "cs-0000000001",
      kind: "push",
      changeRequest: "42",
      state: "active",
      source: {
        runId: null,
        changeRequest: "42",
        fetchRef: null,
        branchName: "pull/42/head",
        baseRef: "main",
        url: null,
      },
    }));
    const stranger = { kind: "principal" as const, userId: "u-9", writableRepoIds: [] };
    assertEquals(await ids({ scope: stranger }), []);
    assertEquals(await ids({ scope: stranger, askedBy: ["push"] }), []);
    assertEquals(await ids({ scope: { kind: "all" }, askedBy: ["push"] }), ["cs-0000000001"]);
  });

  test(`${kind}: check git keys are found by hash and revoked per suite generation, or one alone`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.claimSuite(suite());
    await store.createCheckGitKey({
      id: "ck-1",
      suiteId: "cs-0000000001",
      generation: 1,
      tokenHash: "hash-1",
      expiresAt: T2,
      revokedAt: null,
      createdAt: T0,
    });
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-1"))?.id, "ck-1");
    assertEquals(await store.getCheckGitKeyByTokenHash("nope"), null);
    await store.createCheckGitKey({
      id: "ck-2",
      suiteId: "cs-0000000001",
      generation: 1,
      tokenHash: "hash-2",
      expiresAt: T2,
      revokedAt: null,
      createdAt: T0,
    });
    // One key alone: a failed launch's, never its successor's.
    await store.revokeCheckGitKey("ck-2", T0);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-2"))?.revokedAt, T0);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-1"))?.revokedAt, null);
    await store.createCheckGitKey({
      id: "ck-3",
      suiteId: "cs-0000000001",
      generation: 2,
      tokenHash: "hash-3",
      expiresAt: T2,
      revokedAt: null,
      createdAt: T0,
    });
    // One generation's: a re-run's next one keeps its key.
    await store.revokeCheckGitKeys("cs-0000000001", 1, T1);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-1"))?.revokedAt, T1);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-3"))?.revokedAt, null);
    await store.revokeCheckGitKeys("cs-0000000001", 2, T2);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-3"))?.revokedAt, T2);
    assertEquals((await store.getCheckGitKeyByTokenHash("hash-2"))?.revokedAt, T0, "kept");
  });

  test(`${kind}: a person's live local asks are found by them, and the expired by their end`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const local = (branchName: string) => ({
      runId: null,
      userId: "u-1",
      bundleKey: `users/u-1/0123456789abcdef/${REPO.id}/${sha("d")}.bundle`,
      branchName,
      baseRef: "main",
    });
    const pushed = {
      runId: null,
      changeRequest: null,
      fetchRef: "refs/heads/feat",
      branchName: "feat",
      baseRef: "main",
      url: null,
    };
    await store.createRequest(
      request({
        id: "cq-0000000001",
        kind: "local",
        userId: "u-1",
        source: local("a"),
        expiresAt: T1,
      }),
    );
    await store.createRequest(
      request({
        id: "cq-0000000002",
        kind: "local",
        userId: "u-1",
        source: pushed,
        state: "active",
        createdAt: T1,
        expiresAt: T2,
      }),
    );
    await store.createRequest(
      request({
        id: "cq-0000000003",
        kind: "local",
        userId: "u-1",
        source: local("c"),
        expiresAt: T0,
      }),
    );
    // Another person's, and a tool request: neither is theirs.
    await store.createRequest(
      request({
        id: "cq-0000000004",
        kind: "local",
        userId: "u-2",
        source: local("a"),
        expiresAt: T1,
      }),
    );
    await store.createRequest(request({ id: "cq-0000000005" }));
    await store.withdrawRequest("cq-0000000003");
    assertEquals(
      (await store.listLiveLocalRequests("u-1")).map((r) => [r.id, r.state, r.userId]),
      [["cq-0000000001", "pending", "u-1"], ["cq-0000000002", "active", "u-1"]],
    );
    // Both arms of a local source come back as they went in.
    assertEquals((await store.getRequest("cq-0000000002"))!.source, pushed);
    assertEquals((await store.getRequest("cq-0000000001"))!.source, local("a"));
    assertEquals(await store.listLiveLocalRequests("u-nobody"), []);
    // Ended at or before T1, still standing, local only: the withdrawn one is not listed.
    assertEquals((await store.listExpiredLocalRequests(T1, 10)).map((r) => r.id), [
      "cq-0000000001",
      "cq-0000000004",
    ]);
    assertEquals((await store.listExpiredLocalRequests(T2, 1)).map((r) => r.id), [
      "cq-0000000001",
    ]);
    // Given another day: only its end moves, and only while it stands.
    const renewed = await store.extendRequest("cq-0000000001", T2);
    assertEquals([renewed?.expiresAt, renewed?.state, renewed?.source], [
      T2,
      "pending",
      local("a"),
    ]);
    assertEquals((await store.listExpiredLocalRequests(T1, 10)).map((r) => r.id), [
      "cq-0000000004",
    ]);
    assertEquals(await store.extendRequest("cq-0000000003", T2), null, "withdrawn already");
    assertEquals((await store.getRequest("cq-0000000003"))!.expiresAt, T0);
    // The sweep's withdraw holds to the end it read: a request renewed since is kept.
    assertEquals(await store.withdrawExpired("cq-0000000004", T0), null, "its end is T1");
    assertEquals((await store.getRequest("cq-0000000004"))!.state, "pending");
    assertEquals((await store.withdrawExpired("cq-0000000004", T1))?.state, "superseded");
    assertEquals(await store.withdrawExpired("cq-0000000004", T2), null, "already withdrawn");
    assertEquals(await store.withdrawExpired("cq-0000000005", T2), null, "no end: not local");
    // A whole-row write from a copy read before a renewal never puts the old end back.
    const stale = (await store.getRequest("cq-0000000002"))!;
    await store.extendRequest("cq-0000000002", "2026-01-02T00:00:00.000Z");
    assert(await store.saveRequestIf({ ...stale, attempts: 3 }, ["active"]));
    const saved = (await store.getRequest("cq-0000000002"))!;
    assertEquals([saved.attempts, saved.expiresAt], [3, "2026-01-02T00:00:00.000Z"]);
  });

  test(`${kind}: an approval is claimed per head, listed newest first, and moved by state`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const approval = (over: Partial<CheckApproval> = {}): CheckApproval => ({
      id: "ca-1",
      connectedRepoId: REPO.id,
      changeRequest: "42",
      headSha: sha("a"),
      fetchRef: "refs/pull/42/head",
      url: "https://github.com/acme/api/pull/42",
      author: "mallory",
      state: "pending",
      commentId: null,
      commentClaimedAt: null,
      approvedByUserId: null,
      approvedByLogin: null,
      approvedAt: null,
      createdAt: T0,
      updatedAt: T0,
      ...over,
    });
    const first = await store.claimApproval(approval());
    assertEquals(first.created, true);
    // The same head again, under another id: the standing row answers.
    const again = await store.claimApproval(approval({ id: "ca-2", createdAt: T1 }));
    assertEquals([again.created, again.approval.id], [false, "ca-1"]);
    await store.claimApproval(approval({ id: "ca-3", headSha: sha("b"), createdAt: T1 }));
    await store.claimApproval(approval({ id: "ca-4", changeRequest: "43", createdAt: T2 }));
    assertEquals((await store.listApprovals(REPO.id, "42")).map((a) => a.id), ["ca-3", "ca-1"]);
    assertEquals(await store.getApproval("ca-nobody"), null);

    const approved = approval({
      state: "approved",
      commentId: "c-1",
      approvedByUserId: "u-1",
      approvedByLogin: "grace",
      approvedAt: T1,
      updatedAt: T1,
    });
    assertEquals(await store.saveApprovalIf(approved, ["pending"]), true);
    assertEquals(await store.getApproval("ca-1"), approved);
    // A second approver, or a newer push, finds it moved on.
    assertEquals(
      await store.saveApprovalIf(approval({ state: "superseded" }), ["pending"]),
      false,
    );
    assertEquals((await store.getApproval("ca-1"))!.state, "approved");
    assertEquals(await store.saveApprovalIf(approved, []), false);
  });

  test(`${kind}: one delivery at a time holds the right to post an approval's comment`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const pending: CheckApproval = {
      id: "ca-1",
      connectedRepoId: REPO.id,
      changeRequest: "42",
      headSha: sha("a"),
      fetchRef: null,
      url: null,
      author: "mallory",
      state: "pending",
      commentId: null,
      commentClaimedAt: null,
      approvedByUserId: null,
      approvedByLogin: null,
      approvedAt: null,
      createdAt: T0,
      updatedAt: T0,
    };
    await store.claimApproval(pending);
    const claim = (at: string, staleBefore: string, seen: string | null = null) =>
      store.claimApprovalComment("ca-1", { at, staleBefore, seen });
    assertEquals(await claim(T1, T0), true);
    // Held, and not stale yet: a second delivery is refused.
    assertEquals(await claim(T2, T0), false);
    // A release by someone else's claim leaves it held; the holder's own release frees it.
    await store.releaseApprovalComment("ca-1", T2);
    assertEquals(await claim(T2, T0), false);
    await store.releaseApprovalComment("ca-1", T1);
    assertEquals(await claim(T2, T0), true);
    // Once stale (taken before `staleBefore`), another delivery takes it over.
    assertEquals(await claim(T3, T3), true);
    assertEquals((await store.getApproval("ca-1"))!.commentClaimedAt, T3);
    // A comment posted: only one who saw that very comment fail to edit may claim.
    await store.saveApprovalIf({ ...pending, commentId: "c-1" }, ["pending"]);
    assertEquals(await claim(T3, T3), false);
    assertEquals(await claim(T3, T3, "c-1"), true);
    // Not pending: nobody posts.
    await store.saveApprovalIf({ ...pending, state: "superseded" }, ["pending"]);
    assertEquals(await claim(T3, "9999"), false);
    assertEquals(await claim(T3, "9999", null), false);
  });

  test(`${kind}: upload attempts are counted per person from a time, and pruned`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const upload = (id: string, userId: string, at: string) =>
      store.recordLocalUpload({ id, userId, connectedRepoId: REPO.id, at });
    await upload("lu-1", "u-1", T0);
    await upload("lu-2", "u-1", T1);
    await upload("lu-3", "u-2", T1);
    await upload("lu-4", "u-1", T2);
    assertEquals(await store.countLocalUploadsSince("u-1", T0), 3);
    assertEquals(await store.countLocalUploadsSince("u-1", T1), 2);
    assertEquals(await store.countLocalUploadsSince("u-2", T0), 1);
    assertEquals(await store.countLocalUploadsSince("u-nobody", T0), 0);
    // A refusal's own attempt is taken back.
    await store.deleteLocalUpload("lu-4");
    assertEquals(await store.countLocalUploadsSince("u-1", T1), 1);
    await store.deleteLocalUpload("lu-nobody");
    await store.pruneLocalUploads(T1);
    assertEquals(await store.countLocalUploadsSince("u-1", T0), 1, "only the one before T1 went");
    assertEquals(await store.countLocalUploadsSince("u-2", T0), 1);
  });

  test(`${kind}: a runless ask's suite lists for the asker and for a writer of its repo`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const pushed = {
      runId: null,
      changeRequest: null,
      fetchRef: "refs/heads/feat",
      branchName: "feat",
      baseRef: "main",
      url: null,
    };
    const forge = { ...pushed, changeRequest: "42", fetchRef: "refs/pull/42/head" };
    await store.claimSuite(suite({ id: "cs-0000000001", source: pushed, createdAt: T0 }));
    await store.claimSuite(
      suite({ id: "cs-0000000002", checksBlob: sha("2"), source: forge, createdAt: T1 }),
    );
    await store.claimSuite(
      suite({ id: "cs-0000000003", checksBlob: sha("3"), source: pushed, createdAt: T2 }),
    );
    await store.createRequest(request({
      id: "cq-0000000001",
      suiteId: "cs-0000000001",
      kind: "local",
      userId: "u-1",
      state: "active",
      source: pushed,
    }));
    await store.createRequest(request({
      id: "cq-0000000002",
      suiteId: "cs-0000000002",
      kind: "push",
      changeRequest: "42",
      state: "active",
      source: forge,
    }));
    // A local ask set aside since is still one the asker made.
    await store.createRequest(request({
      id: "cq-0000000003",
      suiteId: "cs-0000000003",
      kind: "local",
      userId: "u-1",
      state: "superseded",
      source: pushed,
    }));
    const ids = async (query: Partial<Parameters<CheckStore["listSuites"]>[0]> = {}) =>
      (await store.listSuites({ limit: 10, ...query })).suites.map((s) => s.id.slice(-1));
    const asker = { kind: "principal" as const, userId: "u-1", writableRepoIds: [] };
    const writer = { kind: "principal" as const, userId: "u-2", writableRepoIds: [REPO.id] };
    const stranger = { kind: "principal" as const, userId: "u-3", writableRepoIds: ["cr-x"] };
    assertEquals(await ids({ scope: asker }), ["3", "1"]);
    assertEquals(await ids({ scope: writer }), ["3", "2", "1"]);
    assertEquals(await ids({ scope: stranger }), []);
    assertEquals(await ids({ askedBy: ["local"] }), ["3", "1"]);
    assertEquals(await ids({ askedBy: ["local"], scope: asker }), ["3", "1"]);
    assertEquals(await ids({ askedBy: ["push"], scope: asker }), []);
    assertEquals(await ids({ askedBy: ["push"], scope: writer }), ["2"]);
  });

  test(`${kind}: a list page's patches are read by id at once, missing ids absent`, async () => {
    const { tasks } = await make();
    const { patchId } = await seed(tasks);
    assertEquals((await tasks.listPatchesByIds([patchId, "p-missing"])).map((p) => p.id), [
      patchId,
    ]);
    assertEquals(await tasks.listPatchesByIds([]), []);
  });
}

test("drizzle: a suite holds its build's image until it settles", async () => {
  const handle = await makeTestDb();
  try {
    const store = drizzleCheckStore(handle);
    await seed(drizzleTaskStore(handle));
    await drizzleEnvironmentStore(handle).createEnvironment({
      id: "env-1",
      subjectKind: "repo",
      subjectId: REPO.id,
      ref: "main",
      defaultBranch: true,
      commits: {},
      definition: null,
      baseDigest: "base",
      harnessDigest: "harness",
      image: "img",
      bakedImage: null,
      machineImage: null,
      status: "superseded",
      toolchains: {},
      sizeBytes: null,
      trigger: "push",
      plan: {
        checkouts: [],
        dockerfileFrom: null,
        cacheScope: { read: [], write: null },
        relayerOf: null,
      },
      logRef: null,
      logTail: null,
      failure: null,
      egressRefusals: null,
      imagesRemovedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    assertEquals(await store.hasUnsettledSuiteOn("env-1"), false);
    const { suite: claimed } = await store.claimSuite(suite({ environmentId: "env-1" }));
    assertEquals(await store.hasUnsettledSuiteOn("env-1"), true);
    assert(
      await store.saveSuiteIf({ ...claimed, state: "passed" }, {
        states: ["queued"],
        generation: 1,
      }),
    );
    assertEquals(await store.hasUnsettledSuiteOn("env-1"), false);
  } finally {
    await handle.close();
  }
});
