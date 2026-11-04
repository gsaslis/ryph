// The BackgroundStore contract, held to BOTH implementations: the drizzle store over a real
// PostgreSQL (PGlite, or RYPH_TEST_DB) and the in-memory double the route suites run on. Writes
// once, the per-run cap, a concluded run refusing every write, and racing starts at the cap.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import type { BackgroundStart } from "../src/core/background.ts";
import type { Run } from "../src/core/types.ts";
import type { BackgroundStore } from "../src/ports/background_store.ts";
import type { TaskStore } from "../src/ports/task_store.ts";
import { drizzleBackgroundStore } from "../src/adapters/store/drizzle_background.ts";
import { drizzleTaskStore } from "../src/adapters/store/drizzle.ts";
import { closedAfterEach } from "@ryph/db/testing";
import { makeTestDb as openTestDb } from "./db.ts";
import { memoryBackgroundStore } from "./background_doubles.ts";
import { memoryTaskStore } from "./memory_store.ts";

// Its tests leave their handles open.
const makeTestDb = closedAfterEach(openTestDb);

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";

/** An agent, and a running run on a task, for the table's foreign key and the lock to take. */
async function seed(tasks: TaskStore, runId = "r-1"): Promise<Run> {
  if ((await tasks.getAgent("a-1")) === null) {
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
  }
  const run = {
    id: runId,
    taskId: `t-${runId}`,
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
    id: `t-${runId}`,
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
  return run;
}

const start = (jobId: string, runId = "r-1"): BackgroundStart => ({
  runId,
  jobId,
  label: `job ${jobId}`,
  command: "make test",
  cwd: "/work/repo",
  service: false,
  startedAt: T0,
  timeoutAt: T1,
});

const END = {
  endedAt: T1,
  reason: "exited" as const,
  exitCode: 1,
  signal: null,
  logBytes: 120,
  logTruncated: false,
  logTail: "FAILED",
};

const implementations: Array<
  [string, () => Promise<{ store: BackgroundStore; tasks: TaskStore }>]
> = [
  ["drizzle", async () => {
    const handle = await makeTestDb();
    return { store: drizzleBackgroundStore(handle), tasks: drizzleTaskStore(handle) };
  }],
  ["memory", () => {
    const tasks = memoryTaskStore();
    return Promise.resolve({ store: memoryBackgroundStore(tasks), tasks });
  }],
];

for (const [kind, make] of implementations) {
  test(`${kind}: a job is started once and ended once`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    assertEquals(await store.start(start("bg-1"), 64), "created");
    assertEquals(await store.start({ ...start("bg-1"), label: "again" }, 64), "exists");
    assertEquals((await store.get("r-1", "bg-1"))?.label, "job bg-1");

    assertEquals(await store.end("r-1", "bg-2", END), "missing");
    assertEquals(await store.end("r-1", "bg-1", END), "ended");
    assertEquals(await store.end("r-1", "bg-1", { ...END, exitCode: 0 }), "already");
    assertEquals(await store.get("r-1", "bg-1"), {
      ...start("bg-1"),
      ...END,
      hasLog: false,
      logClaim: null,
      logClaimedAt: null,
      logKey: null,
    });
  });

  test(`${kind}: a log has one writer: claimed, released, taken when stale, stored once`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.start(start("bg-1"), 64);
    const claim = (c: string, at = T0, staleBefore = "2025-12-31T23:58:00.000Z") =>
      store.claimLog("r-1", "bg-1", { claim: c, at, staleBefore });
    // A log belongs to an ended job: until its exit is recorded, nobody may claim it.
    assertEquals(await claim("a"), "running");
    await store.end("r-1", "bg-1", END);

    assertEquals(
      await store.claimLog("r-1", "bg-2", { claim: "x", at: T0, staleBefore: T0 }),
      "missing",
    );
    assertEquals(await claim("a"), "claimed");
    assertEquals(await claim("b"), "busy");
    // Only the claimant can end it.
    assertEquals(await store.markLog("r-1", "bg-1", "b", { key: "k-b", bytes: 1 }), "lost");
    await store.releaseLog("r-1", "bg-1", "b");
    assertEquals(await claim("b"), "busy");
    await store.releaseLog("r-1", "bg-1", "a");
    assertEquals(await claim("b"), "claimed");

    // A claim older than `staleBefore` is taken over; its holder can then mark nothing.
    assertEquals(await claim("c", T1, T1), "claimed");
    assertEquals(await store.markLog("r-1", "bg-1", "b", { key: "k-b", bytes: 1 }), "lost");
    assertEquals(await store.markLog("r-1", "bg-1", "c", { key: "k-c", bytes: 7 }), "ok");
    const row = (await store.get("r-1", "bg-1"))!;
    assertEquals([row.hasLog, row.logKey, row.logClaim, row.logClaimedAt], [
      true,
      "k-c",
      null,
      null,
    ]);
    // The row's size is now the stored object's (END reported 120), not the exit record's.
    assertEquals(row.logBytes, 7);
    // A log is written once.
    assertEquals(await claim("d", T1, T1), "stored");
  });

  test(`${kind}: claims racing for one log: exactly one wins`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await store.start(start("bg-1"), 64);
    await store.end("r-1", "bg-1", END);
    const outcomes = await Promise.all(
      Array.from(
        { length: 10 },
        (_, n) =>
          store.claimLog("r-1", "bg-1", {
            claim: `c${n}`,
            at: T0,
            staleBefore: "2025-01-01T00:00:00.000Z",
          }),
      ),
    );
    assertEquals(outcomes.filter((o) => o === "claimed").length, 1);
    assertEquals(outcomes.filter((o) => o === "busy").length, 9);
  });

  test(`${kind}: a run keeps at most its cap of jobs, and another run its own`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    await seed(tasks, "r-2");
    for (let n = 1; n <= 3; n++) assertEquals(await store.start(start(`bg-${n}`), 3), "created");
    assertEquals(await store.start(start("bg-4"), 3), "full");
    // At the cap, a job already on record is still answered as there.
    assertEquals(await store.start(start("bg-2"), 3), "exists");
    assertEquals(await store.start(start("bg-1", "r-2"), 3), "created");
    assertEquals((await store.list("r-1")).length, 3);
    assertEquals((await store.list("r-2")).map((r) => r.jobId), ["bg-1"]);
  });

  test(`${kind}: starts racing at the cap land no more than it`, async () => {
    const { store, tasks } = await make();
    await seed(tasks);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, n) => store.start(start(`bg-${n + 1}`), 4)),
    );
    assertEquals(outcomes.filter((o) => o === "created").length, 4);
    assertEquals(outcomes.filter((o) => o === "full").length, 6);
    assertEquals((await store.list("r-1")).length, 4);
  });

  test(`${kind}: a concluded or unknown run takes no write`, async () => {
    const { store, tasks } = await make();
    const run = await seed(tasks);
    assertEquals(await store.start(start("bg-1"), 64), "created");
    assertEquals(await store.start(start("bg-3"), 64), "created");
    assertEquals(await store.end("r-1", "bg-3", END), "ended");
    assertEquals(
      await store.claimLog("r-1", "bg-3", { claim: "early", at: T0, staleBefore: T0 }),
      "claimed",
    );
    await tasks.saveRunResult({ ...run, state: "succeeded" });
    assertEquals(await store.start(start("bg-2"), 64), "concluded");
    assertEquals(await store.end("r-1", "bg-1", END), "concluded");
    assertEquals(
      await store.claimLog("r-1", "bg-1", { claim: "late", at: T1, staleBefore: T0 }),
      "concluded",
    );
    // A log whose claim was granted while the run was live is still marked: no orphan object.
    assertEquals(await store.markLog("r-1", "bg-3", "early", { key: "k", bytes: 1 }), "ok");
    assertEquals((await store.get("r-1", "bg-3"))?.hasLog, true);
    assertEquals(await store.start(start("bg-1", "r-nope"), 64), "concluded");
    // What was recorded before stays readable.
    assertEquals(
      (await store.list("r-1")).map((r) => [r.jobId, r.endedAt]).sort(),
      [["bg-1", null], ["bg-3", END.endedAt]],
    );
    assertEquals(await store.markLog("r-1", "bg-9", "early", { key: "k", bytes: 1 }), "lost");
  });
}
