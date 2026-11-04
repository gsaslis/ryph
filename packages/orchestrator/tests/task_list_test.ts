// The task list as the store answers it: a keyset page, the filters a list narrows by, and the
// denormalized attempt that makes both of those one indexed scan instead of a query per row.
//
// On a real database (see tests/db.ts) rather than the double, because everything asserted here
// is SQL: a row comparison used as a cursor, a jsonb containment lookup, a tsquery, and an UPDATE
// conditioned on the run being the task's current one. A double would agree with whatever the
// adapter did.

import { jest, test } from "bun:test";
import { capsClaimOf } from "@ryph/auth";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { drizzleTaskStore, taskSearchQuery } from "../src/adapters/store/drizzle.ts";
import { memoryTaskFeed } from "../src/adapters/task_feed/memory.ts";
import { publishTaskChanges } from "../src/publish_task_changes.ts";
import { type Agent, NO_RUN_LIMITS, type Run, type Task } from "../src/core/types.ts";
import { type Authenticate, makeHandler } from "../src/http/app.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { MAX_TASK_PAGE, type TaskStore } from "../src/ports/task_store.ts";
import { makeTestDb } from "./db.ts";
import { memoryTaskStore } from "./memory_store.ts";
import {
  fakeClock,
  fakeProvisioner,
  fakeRunnerControl,
  imageConfig,
  silentDiagnostics,
} from "./doubles.ts";

const AT = (hour: number) => `2026-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`;

function agentRow(id: string, name: string): Agent {
  return {
    id,
    name,
    handle: name.toLowerCase(),
    email: `${name.toLowerCase()}@example.com`,
    systemPrompt: "You are helpful.",
    harnessKind: "echo",
    modelPolicy: null,
    toolPolicy: null,
    forgePolicy: null,
    skillPolicy: null,
    networkPolicy: null,
    limitPolicy: null,
    canOpenPatches: true,
    canPublishArtifacts: false,
    browserEnabled: false,
    memoryPolicy: { budgetTokens: 0 },
    archivedAt: null,
    createdAt: AT(0),
    updatedAt: AT(0),
  };
}

function taskRow(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    agentId: "a-1",
    spec: { title: "Do the thing", instructions: "Please do the thing." },
    repos: [{
      connectedRepoId: "cr-1",
      name: "example/repo",
      url: "https://example.com/repo.git",
      ref: "main",
      path: "repo",
      branchNamespace: `ryph/ada/${id}`,
      description: null,
    }],
    workspaceId: null,
    origin: "user",
    requestedByUserId: null,
    requestedVia: null,
    chatConversation: null,
    targetChangeRequest: null,
    landings: {},
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    purpose: null,
    createdAt: AT(1),
    ...over,
  };
}

function runRow(id: string, taskId: string, over: Partial<Run> = {}): Run {
  return {
    id,
    launchedAt: null,
    taskId,
    agentId: "a-1",
    state: "starting",
    phase: null,
    heartbeatSeq: -1,
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
    tokenHash: `hash-${id}`,
    controlToken: `control-${id}`,
    handle: null,
    branchNamespace: `ryph/ada/${id}`,
    image: "ryph-agent-echo:test",
    environmentId: null,
    environment: null,
    environmentWait: null,
    workItem: {
      id,
      agent: { name: "Ada", email: "ada@example.com" },
      spec: { title: "Do the thing", instructions: "Please do the thing." },
      repos: [],
      workspace: null,
      harness: { kind: "echo" },
      lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
      canOpenPatches: true,
      canPublishArtifacts: false,
    },
    injectedContext: null,
    modelScope: null,
    forgeScope: null,
    networkScope: { mode: "open", bundles: [], hosts: [] },
    limits: NO_RUN_LIMITS,
    egressRefusals: null,
    skills: null,
    toolScope: null,
    services: null,
    result: null,
    memoryOutcomeReportedAt: null,
    skillsReportedAt: null,
    createdAt: AT(1),
    updatedAt: AT(1),
    ...over,
  };
}

/** `count` tasks, newest last — t-1 is the oldest, so a newest-first page starts at the end. */
async function seed(store: TaskStore, count: number): Promise<void> {
  await store.createAgent(agentRow("a-1", "Ada"));
  for (let i = 1; i <= count; i++) {
    const id = `t-${i}`;
    await store.createTask(
      taskRow(id, { createdAt: AT(i) }),
      runRow(`r-${i}`, id, {
        createdAt: AT(i),
        updatedAt: AT(i),
      }),
    );
  }
}

test("history excludes cancelled unprompted tasks before pagination, but retains direct reads", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    const states = ["running", "cancelled", "failed", "errored", "cancelled"] as const;
    for (const [i, state] of states.entries()) {
      const id = `t-${i}`;
      await store.createTask(
        taskRow(id, {
          createdAt: AT(i),
          ...(i === 4 ? {} : { spec: { title: null, instructions: null } }),
        }),
        runRow(`r-${i}`, id, { state, createdAt: AT(i) }),
      );
    }
    const first = await store.listTasks({ limit: 3 });
    assertEquals(first.tasks.map((r) => r.task.id), ["t-4", "t-3", "t-2"]);
    assert(first.nextCursor !== null);
    const second = await store.listTasks({ limit: 3, cursor: first.nextCursor });
    assertEquals(second.tasks.map((r) => r.task.id), ["t-0"]);
    assertEquals(second.nextCursor, null);
    assertEquals(
      (await store.listTasks({ statuses: ["cancelled"] })).tasks.map((r) => r.task.id),
      ["t-4"],
    );
    assertEquals((await store.listTasks({ ids: ["t-1"] })).tasks, []);
    assertEquals(
      (await store.listTasks({ ids: ["t-1"], includeAbandonedDrafts: true })).tasks
        .map((r) => r.task.id),
      ["t-1"],
    );
    assertEquals(
      (await store.listTasks({
        ids: ["t-1"],
        includeAbandonedDrafts: true,
        scope: { kind: "principal", userId: "u-other", writableRepoIds: [] },
      })).tasks,
      [],
    );
    assert(await store.getTask("t-1") !== null);
    assertEquals((await store.getRun("r-1"))?.state, "cancelled");
    assertEquals((await store.listTasksByIds(["t-1"])).length, 1);
  } finally {
    await store.close();
  }
});

test("the list pages by keyset: no row seen twice, none skipped, newest first", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await seed(store, 5);

    const first = await store.listTasks({ limit: 2 });
    assertEquals(first.tasks.map((r) => r.task.id), ["t-5", "t-4"]);
    assert(first.nextCursor !== null, "a sixth row exists, so the page says so");

    const second = await store.listTasks({ limit: 2, cursor: first.nextCursor });
    assertEquals(second.tasks.map((r) => r.task.id), ["t-3", "t-2"]);

    const third = await store.listTasks({ limit: 2, cursor: second.nextCursor ?? undefined });
    assertEquals(third.tasks.map((r) => r.task.id), ["t-1"]);
    // The last page reached the oldest task: there is nothing to walk to.
    assertEquals(third.nextCursor, null);
  } finally {
    await store.close();
  }
});

test("a task created mid-paging shifts nothing below it — the cursor is the sort key", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await seed(store, 4);
    const first = await store.listTasks({ limit: 2 });
    assertEquals(first.tasks.map((r) => r.task.id), ["t-4", "t-3"]);

    // Someone assigns a task while the reader is between pages. Under OFFSET this is what pushes
    // a row the reader already saw onto the next page; under a keyset it lands at the head, which
    // the reader is no longer looking at.
    await store.createTask(
      taskRow("t-new", { createdAt: AT(9) }),
      runRow("r-new", "t-new", { createdAt: AT(9), updatedAt: AT(9) }),
    );

    const second = await store.listTasks({ limit: 2, cursor: first.nextCursor ?? undefined });
    assertEquals(second.tasks.map((r) => r.task.id), ["t-2", "t-1"]);
  } finally {
    await store.close();
  }
});

test("two tasks with the same createdAt still page exactly once each", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    // The tie the id breaks: without it, a cursor built from the timestamp alone either repeats
    // the row it stopped on or steps over its twin.
    for (const id of ["t-a", "t-b", "t-c"]) {
      await store.createTask(
        taskRow(id, { createdAt: AT(3) }),
        runRow(`r-${id}`, id, { createdAt: AT(3), updatedAt: AT(3) }),
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const answer = await store.listTasks({ limit: 1, cursor });
      seen.push(...answer.tasks.map((r) => r.task.id));
      if (answer.nextCursor === null) break;
      cursor = answer.nextCursor;
    }
    assertEquals(seen.sort(), ["t-a", "t-b", "t-c"]);
  } finally {
    await store.close();
  }
});

test("a run's state lives on the task row, and only the current attempt may write it", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await seed(store, 1);
    const [fresh] = (await store.listTasks()).tasks;
    assertEquals(fresh.currentRun, {
      id: "r-1",
      state: "starting",
      phase: null,
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(fresh.lastActivityAt, AT(1));

    // The run moves: the list's copy moves with it, in the same transaction.
    await store.saveHeartbeat(runRow("r-1", "t-1", {
      state: "running",
      heartbeatSeq: 0,
      phase: "cloning",
      createdAt: AT(1),
      updatedAt: AT(2),
    }));
    const [moved] = (await store.listTasks()).tasks;
    assertEquals(moved.currentRun, {
      id: "r-1",
      state: "running",
      phase: "cloning",
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(moved.lastActivityAt, AT(2));

    // A write about some OTHER run of the task must not roll the row back to it. (Runs are 1:1
    // with tasks today; this is the rule that keeps a retry from rewriting history when they
    // are not.)
    await store.saveRun(runRow("r-old", "t-1", {
      state: "failed",
      createdAt: AT(0),
      updatedAt: AT(0),
    }));
    const [unmoved] = (await store.listTasks()).tasks;
    assertEquals(unmoved.currentRun, {
      id: "r-1",
      state: "running",
      phase: "cloning",
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(unmoved.lastActivityAt, AT(2));

    // Someone speaking to the run is activity too.
    await store.markRunAttended("r-1", AT(3));
    assertEquals((await store.listTasks()).tasks[0].lastActivityAt, AT(3));
  } finally {
    await store.close();
  }
});

test("the list filters: status, agent, origin, repo, workspace, requester, and a window", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    await store.createAgent(agentRow("a-2", "Bob"));
    await store.createWorkspace({
      id: "w-1",
      name: "platform",
      description: null,
      sizeClass: null,
      environmentRepoId: null,
      archivedAt: null,
      createdAt: AT(0),
      updatedAt: AT(0),
    });

    // One task per thing being narrowed by, so every filter has exactly one right answer.
    await store.createTask(
      taskRow("t-live", { createdAt: AT(1) }),
      runRow("r-live", "t-live", { state: "running", createdAt: AT(1), updatedAt: AT(1) }),
    );
    await store.createTask(
      taskRow("t-bob", { createdAt: AT(2), agentId: "a-2" }),
      runRow("r-bob", "t-bob", {
        agentId: "a-2",
        state: "succeeded",
        createdAt: AT(2),
        updatedAt: AT(2),
      }),
    );
    await store.createTask(
      taskRow("t-forge", {
        createdAt: AT(3),
        origin: "forge",
        requestedByUserId: "u-1",
        workspaceId: "w-1",
        repos: [{
          connectedRepoId: "cr-7",
          name: "acme/app",
          url: "https://github.com/acme/app.git",
          ref: "main",
          path: "app",
          branchNamespace: "ryph/ada/r-forge",
          description: null,
        }],
      }),
      runRow("r-forge", "t-forge", { state: "errored", createdAt: AT(3), updatedAt: AT(3) }),
    );

    const ids = async (query: Parameters<TaskStore["listTasks"]>[0]) =>
      (await store.listTasks(query)).tasks.map((r) => r.task.id);

    assertEquals(await ids({ statuses: ["live"] }), ["t-live"]);
    // "broken" is the system's failure — errored and lost — which is a different question from
    // the agent failing the work.
    assertEquals(await ids({ statuses: ["broken"] }), ["t-forge"]);
    // Several statuses OR together, as a multi-select control means them.
    assertEquals(await ids({ statuses: ["live", "succeeded"] }), ["t-bob", "t-live"]);
    assertEquals(await ids({ agentIds: ["a-2"] }), ["t-bob"]);
    assertEquals(await ids({ origins: ["forge"] }), ["t-forge"]);
    assertEquals(await ids({ workspaceId: "w-1" }), ["t-forge"]);
    assertEquals(await ids({ connectedRepoId: "cr-7" }), ["t-forge"]);
    assertEquals(await ids({ connectedRepoId: "cr-nope" }), []);
    assertEquals(await ids({ requestedByUserId: "u-1" }), ["t-forge"]);
    // The window: `from` inclusive, `to` exclusive.
    assertEquals(await ids({ createdFrom: AT(2), createdTo: AT(3) }), ["t-bob"]);
    // Filters AND together — a live task of Bob's is not one of these.
    assertEquals(await ids({ statuses: ["live"], agentIds: ["a-2"] }), []);
  } finally {
    await store.close();
  }
});

test("the search box matches words in a title, the last one as a prefix", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    const titles = {
      "t-1": "Fix the flaky login test",
      "t-2": "Rewrite the billing exporter",
      "t-3": "Fix billing rounding",
    };
    let hour = 1;
    for (const [id, title] of Object.entries(titles)) {
      await store.createTask(
        taskRow(id, { createdAt: AT(hour), spec: { title, instructions: "…" } }),
        runRow(`r-${id}`, id, { createdAt: AT(hour), updatedAt: AT(hour) }),
      );
      hour++;
    }
    const ids = async (q: string) => (await store.listTasks({ q })).tasks.map((r) => r.task.id);

    assertEquals(await ids("billing"), ["t-3", "t-2"]);
    // A second word narrows rather than widens — the terms AND.
    assertEquals(await ids("fix billing"), ["t-3"]);
    // Still being typed: the last term matches as a prefix.
    assertEquals(await ids("bill"), ["t-3", "t-2"]);
    assertEquals(await ids("nothing here"), []);
    // Punctuation alone narrows by nothing rather than matching nothing.
    assertEquals(await ids("!!"), ["t-3", "t-2", "t-1"]);
    // A search pages like any other list.
    const page = await store.listTasks({ q: "billing", limit: 1 });
    assertEquals(page.tasks.map((r) => r.task.id), ["t-3"]);
    assertEquals(
      (await store.listTasks({ q: "billing", limit: 1, cursor: page.nextCursor ?? undefined }))
        .tasks.map((r) => r.task.id),
      ["t-2"],
    );
  } finally {
    await store.close();
  }
});

test("nothing a caller types reaches the tsquery parser", () => {
  assertEquals(taskSearchQuery("fix billing"), "fix & billing:*");
  assertEquals(taskSearchQuery("fix  FIX fix"), "fix:*");
  // Operators, quotes and parentheses are not terms and never become syntax.
  assertEquals(taskSearchQuery("a & b | !c (d)"), "a & b & c & d:*");
  assertEquals(taskSearchQuery("   "), null);
  assertEquals(taskSearchQuery("&|!():*"), null);
});

test("a page bounds itself: the limit is clamped, and `ids` asks about a handful", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await seed(store, 3);
    // Asking for the whole table is not a thing this answers.
    assertEquals((await store.listTasks({ limit: 10_000 })).tasks.length, 3);
    assertEquals((await store.listTasks({ limit: 0 })).tasks.length, 1);

    const byIds = await store.listTasksByIds(["t-1", "t-3", "t-missing"]);
    assertEquals(byIds.map((r) => r.task.id), ["t-3", "t-1"]);
    assertEquals(await store.listTasksByIds([]), []);

    // `ids` as a FILTER — what a live tail asks to learn whether the rows it heard about still
    // belong in the list it is showing. The seeded runs are `starting`, so they belong in a
    // list of live tasks and not in one of settled ones.
    assertEquals(
      (await store.listTasks({ ids: ["t-1", "t-2"], statuses: ["live"] })).tasks.map((r) =>
        r.task.id
      ),
      ["t-2", "t-1"],
    );
    assertEquals(
      (await store.listTasks({ ids: ["t-1", "t-2"], statuses: ["succeeded"] })).tasks,
      [],
    );
    assertEquals((await store.listTasks({ ids: [] })).tasks, []);
  } finally {
    await store.close();
  }
});

test("declarations reach list pages and live refreshes, including resets", async () => {
  const store = publishTaskChanges(drizzleTaskStore(await makeTestDb()), {
    publish: (id) => announced.push(id),
    subscribe: () => () => {},
  });
  const announced: string[] = [];
  try {
    await seed(store, 1);
    const initial = (await store.getRun("r-1"))!;
    const beat = {
      ...initial,
      state: "running" as const,
      phase: "running" as const,
      idleState: "idle" as const,
    };
    let seq = 0;
    for (
      const declaredOutcome of [
        "success",
        "success",
        "no-changes",
        "in-progress",
        "failed",
        null,
      ] as const
    ) {
      assert(await store.saveHeartbeat({ ...beat, heartbeatSeq: ++seq, declaredOutcome }));
      assertEquals((await store.listTasks()).tasks[0].currentRun.declaredOutcome, declaredOutcome);
      assertEquals(
        (await store.listTasksByIds(["t-1"]))[0].currentRun.declaredOutcome,
        declaredOutcome,
      );
    }
    assertEquals(announced.length, 6); // creation plus five changed declarations
    assertEquals(
      await store.saveHeartbeat({ ...beat, heartbeatSeq: 1, declaredOutcome: "success" }),
      null,
    );
    assertEquals(announced.length, 6);
    assertEquals((await store.listTasks()).tasks[0].currentRun.declaredOutcome, null);
    assert(await store.saveHeartbeat({ ...beat, heartbeatSeq: ++seq, declaredOutcome: "success" }));
    // A lifecycle transition carrying a stale declaration cannot erase it.
    const current = (await store.getRun("r-1"))!;
    assert(await store.saveRunTransition({ ...current, declaredOutcome: null }, current));
    assertEquals((await store.listTasks()).tasks[0].currentRun.declaredOutcome, "success");
    assertEquals(announced.length, 7); // the persisted row still says success: no false reset
    assert(await store.saveHeartbeat({ ...beat, heartbeatSeq: ++seq, declaredOutcome: null }));
    assertEquals((await store.listTasks()).tasks[0].currentRun.declaredOutcome, null);
    assertEquals(announced.length, 8); // the real reset must not be swallowed by stale cached facts
  } finally {
    await store.close();
  }
});

test("idle transitions persist on the run and task row and announce only changes", async () => {
  const raw = drizzleTaskStore(await makeTestDb());
  const announced: string[] = [];
  const feed = memoryTaskFeed();
  const unsubscribe = feed.subscribe((id) => announced.push(id));
  const store = publishTaskChanges(raw, feed);
  try {
    await seed(store, 1);
    announced.length = 0;
    const initial = (await store.getRun("r-1"))!;
    let seq = 0;
    for (const idleState of ["idle", "idle", "waiting-for-user", null] as const) {
      const beat: Run = {
        ...initial,
        state: "running",
        phase: "running",
        idleState,
        heartbeatSeq: ++seq,
        updatedAt: AT(2),
      };
      assert(await store.saveHeartbeat(beat));
      assertEquals((await store.getRun("r-1"))?.idleState, idleState);
      assertEquals((await store.listTasks()).tasks[0].currentRun.idleState, idleState);
    }
    assertEquals(announced, ["t-1", "t-1", "t-1"]);
    await store.saveRunResult({
      ...initial,
      state: "succeeded",
      phase: "running",
      idleState: "idle",
    });
    assertEquals((await store.listTasks()).tasks[0].currentRun.idleState, null);
  } finally {
    unsubscribe();
    await store.close();
  }
});

test("patches page by the same keyset, narrowed by state", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await seed(store, 1);
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "42",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      submissionPolicy: "require-approval",
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: AT(0),
      updatedAt: AT(0),
    });
    for (let i = 1; i <= 3; i++) {
      await store.createPatch({
        id: `p-${i}`,
        setId: `p-${i}`,
        path: "repo",
        line: "work",
        connectedRepoId: "cr-1",
        runId: "r-1",
        taskId: "t-1",
        branchName: `ryph/ada/r-1-${i}`,
        headSha: `sha-${i}`,
        baseSha: null,
        generation: 1,
        commits: [],
        carries: [],
        bundleKey: `r-1/sha-${i}.bundle`,
        state: i === 3 ? "submitted" : "pending_approval",
        title: null,
        description: null,
        forgeRef: null,
        forgeUrl: null,
        forgeBranch: null,
        diffRef: null,
        approvedBy: null,
        approvedAt: null,
        attempts: 0,
        leaseExpiresAt: null,
        lastError: null,
        nextAttemptAt: null,
        landed: null,
        memoryFateReportedAt: null,
        mergedCuedAt: null,
        heldReason: null,
        mergedCueClaimedAt: null,
        landingAskedAt: null,
        version: 0,
        supersededByPatchId: null,
        hookCheck: null,
        approvedHookPaths: [],
        createdAt: AT(i),
        updatedAt: AT(i),
      });
    }
    const first = await store.listPatches({ limit: 1 });
    assertEquals(first.patches.map((p) => p.id), ["p-3"]);
    assertEquals(
      (await store.listPatches({ limit: 1, cursor: first.nextCursor ?? undefined }))
        .patches.map((p) => p.id),
      ["p-2"],
    );
    const pending = await store.listPatches({ state: "pending_approval" });
    assertEquals(pending.patches.map((p) => p.id), ["p-2", "p-1"]);
    assertEquals(pending.nextCursor, null);
  } finally {
    await store.close();
  }
});

// ---- the HTTP surface ------------------------------------------------------------------
//
// Above the store now: what a browser sends, what comes back, and what a live tail pushes.
// The double is enough here — the SQL is pinned by the tests above — but the FEED is real:
// what is under test is that a write announces itself and a tail turns that into a frame.

const BREAK_GLASS = { kind: "break-glass" } as const;

function buildListApp(
  opts: { authenticate?: Authenticate } = {},
) {
  const base = memoryTaskStore();
  const taskFeed = memoryTaskFeed();
  const store = publishTaskChanges(base, taskFeed);
  const handler = makeHandler({
    store,
    provisioner: fakeProvisioner().provisioner,
    runnerControl: fakeRunnerControl().control,
    diag: silentDiagnostics(),
    authenticate: opts.authenticate ?? (() => Promise.resolve(BREAK_GLASS)),
    taskFeed,
    now: fakeClock().now,
    config: {
      publicUrl: "http://orchestrator.test",
      ...imageConfig(),
      gitGateway: null,
      runHistoryUrl: null,
      appUrl: null,
      services: DEFAULT_SERVICE_POLICY,
      egress: {
        policy: { mode: "proxy" as const, bundles: [], hosts: [], proxyUrl: null },
        key: null,
        tokenTtlMs: 0,
      },
      platformMemoryServerId: null,
      platformChatServerId: null,
      platformTools: {
        webServerId: "ms-platform-web",
        web: false,
        forge: null,
        pending: false,
      },
    },
  });
  return { handler, store };
}

type ListBody = {
  tasks: Array<{ id: string; state: string; title: string | null; agentName: string | null }>;
  nextCursor: string | null;
  hasMore: boolean;
};

const getList = async (
  handler: (req: Request) => Promise<Response>,
  query = "",
): Promise<{ status: number; body: ListBody }> => {
  const res = await handler(new Request(`http://orchestrator.test/v1/tasks${query}`));
  return { status: res.status, body: await res.json() as ListBody };
};

test("GET /v1/tasks answers a page and a cursor, never the table", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 3);

  const first = await getList(handler, "?limit=2");
  assertEquals(first.status, 200);
  assertEquals(first.body.tasks.map((t) => t.id), ["t-3", "t-2"]);
  assertEquals(first.body.hasMore, true);
  // The row carries what a list draws, the run's state included — with no per-row query behind it.
  assertEquals(first.body.tasks[0].state, "starting");
  assertEquals(first.body.tasks[0].agentName, "Ada");

  const second = await getList(
    handler,
    `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
  );
  assertEquals(second.body.tasks.map((t) => t.id), ["t-1"]);
  assertEquals(second.body.hasMore, false);
  assertEquals(second.body.nextCursor, null);

  // `?ids=` is the other question — these rows, by name, not a page of the list.
  const named = await getList(handler, "?ids=t-1,t-3,t-nope");
  assertEquals(named.body.tasks.map((t) => t.id), ["t-3", "t-1"]);
  assertEquals(named.body.hasMore, false);
});

test("metadata lookup includes abandoned drafts without exposing them in history", async () => {
  const { handler, store } = buildListApp();
  await store.createAgent(agentRow("a-1", "Ada"));
  await store.createTask(
    taskRow("t-1", { spec: { title: null, instructions: null } }),
    runRow("r-1", "t-1", { state: "cancelled" }),
  );
  assertEquals((await getList(handler)).body.tasks, []);
  assertEquals((await getList(handler, "?status=cancelled")).body.tasks, []);
  const named = await getList(handler, "?ids=t-1");
  assertEquals(named.status, 200);
  assertEquals(named.body.tasks.map((t) => ({ id: t.id, title: t.title })), [
    { id: "t-1", title: null },
  ]);
  assertEquals(named.body.hasMore, false);
});

test("the list route refuses a query it did not issue rather than answering something else", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 1);

  assertEquals((await getList(handler, "?limit=nope")).status, 400);
  assertEquals((await getList(handler, "?limit=0")).status, 400);
  assertEquals((await getList(handler, "?cursor=not-a-cursor")).status, 400);
  // An unknown status is a client bug; answering "no tasks" would hide it.
  assertEquals((await getList(handler, "?status=running")).status, 400);
  assertEquals((await getList(handler, "?origin=cron")).status, 400);
  assertEquals((await getList(handler, "?from=yesterday")).status, 400);
  // Break-glass is not a person and has no tasks of its own.
  assertEquals((await getList(handler, "?mine=true")).status, 400);
  // ...and the ones it does issue are answered.
  assertEquals((await getList(handler, "?status=live,succeeded&origin=user")).status, 200);
});

test("mine=true narrows to the caller, never to a user id from the query", async () => {
  const { handler, store } = buildListApp({
    authenticate: () =>
      Promise.resolve(
        {
          kind: "user",
          userId: "u-1",
          email: "ada@example.com",
          name: "Ada",
          caps: capsClaimOf("member"),
          emailVerified: true,
          sid: "s-1",
          via: "session",
        } as const,
      ),
  });
  await store.createAgent(agentRow("a-1", "Ada"));
  await store.createTask(
    taskRow("t-mine", { createdAt: AT(1), requestedByUserId: "u-1" }),
    runRow("r-mine", "t-mine", { createdAt: AT(1), updatedAt: AT(1) }),
  );
  await store.createTask(
    taskRow("t-theirs", { createdAt: AT(2), requestedByUserId: "u-2" }),
    runRow("r-theirs", "t-theirs", { createdAt: AT(2), updatedAt: AT(2) }),
  );

  assertEquals((await getList(handler, "?mine=true")).body.tasks.map((t) => t.id), ["t-mine"]);
  // There is no filter that asks about somebody else.
  assertEquals(
    (await getList(handler, "?mine=true&requestedByUserId=u-2")).body.tasks.map((t) => t.id),
    ["t-mine"],
  );
});

test("the stream opens with a comment before the snapshot is read, so its headers leave at once", async () => {
  const { handler, store } = buildListApp();
  // A snapshot read that never answers: whatever the stream says first, it says without it.
  store.listTasks = () => new Promise(() => {});
  const res = await handler(new Request("http://orchestrator.test/v1/tasks/stream"));
  const reader = res.body!.getReader();
  assertEquals(new TextDecoder().decode((await reader.read()).value), ": open\n\n");
  await reader.cancel();
});

for (const via of ["token", "session"] as const) {
  test(
    `a ${via}'s stream ${
      via === "token" ? "ends when its bearer expires" : "outlives its bearer, as before"
    }`,
    async () => {
      const { handler, store } = buildListApp({
        authenticate: () =>
          Promise.resolve(
            {
              kind: "user",
              userId: "u-1",
              email: "ada@example.com",
              name: "Ada",
              caps: capsClaimOf("member"),
              emailVerified: true,
              sid: "s-1",
              via,
            } as const,
          ),
      });
      await seed(store, 1);
      const b64url = (value: unknown) =>
        btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      // Expired a second ago: the gate (stubbed here) took it at open.
      const expired = `${b64url({ alg: "EdDSA" })}.${
        b64url({ sub: "u-1", via, exp: Math.floor(Date.now() / 1000) - 1 })
      }.sig`;
      const res = await handler(
        new Request("http://orchestrator.test/v1/tasks/stream", {
          headers: { authorization: `Bearer ${expired}` },
        }),
      );
      assertEquals(res.status, 200);
      const reader = res.body!.getReader();
      const closed = (async () => {
        while (!(await reader.read()).done) { /* drain */ }
        return true;
      })();
      const outcome = await Promise.race([
        closed,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      // A token's stream closes at once; a browser session's EventSource would reconnect with
      // the same expired cookie and be refused, so its stream is left open.
      assertEquals(outcome, via === "token");
      if (via === "session") await reader.cancel();
    },
  );
}

test("a failed stream snapshot closes so reconnect can repair the list", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 1);
  const listTasks = store.listTasks.bind(store);
  store.listTasks = () => Promise.reject(new Error("snapshot unavailable"));
  const url = "http://orchestrator.test/v1/tasks/stream";
  const failed = tail(await handler(new Request(url)));
  try {
    assertEquals(await failed.frames(1), []);
  } finally {
    await failed.close();
  }
  store.listTasks = listTasks;
  const recovered = tail(await handler(new Request(url)));
  try {
    assertStringIncludes((await recovered.frames(1))[0], "event: sync");
  } finally {
    await recovered.close();
  }
});

test("a failed stream delta closes rather than silently losing the update", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 1);
  const stream = tail(await handler(new Request("http://orchestrator.test/v1/tasks/stream")));
  try {
    assertStringIncludes((await stream.frames(1))[0], "event: sync");
    store.listTasks = () => Promise.reject(new Error("delta unavailable"));
    await store.createTask(taskRow("t-2"), runRow("r-2", "t-2"));
    assertEquals(await stream.frames(1), []);
  } finally {
    await stream.close();
  }
});

for (const phase of ["snapshot", "delta"] as const) {
  for (const read of ["tasks", "agents"] as const) {
    test(`a stalled ${phase} ${read} read closes and reconnect repairs the list`, async () => {
      jest.useFakeTimers();
      const { handler, store } = buildListApp();
      const streams: ReturnType<typeof tail>[] = [];
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const listTasks = store.listTasks.bind(store);
      const listAgents = store.listAgentsByIds.bind(store);
      const url = "http://orchestrator.test/v1/tasks/stream";
      const stall = () => {
        if (read === "tasks") {
          store.listTasks = async (query) => {
            const page = await listTasks(query);
            started.resolve();
            await release.promise;
            finished.resolve();
            return page;
          };
        } else {
          store.listAgentsByIds = async (ids) => {
            const agents = await listAgents(ids);
            started.resolve();
            await release.promise;
            finished.resolve();
            return agents;
          };
        }
      };
      try {
        await seed(store, 1);
        if (phase === "snapshot") stall();
        const stream = tail(await handler(new Request(url)));
        streams.push(stream);
        if (phase === "delta") {
          assertStringIncludes((await stream.frames(1))[0], "event: sync");
          // Only the heartbeat survives a successful snapshot; its read deadline is cleared.
          assertEquals(jest.getTimerCount(), 1);
          stall();
          await store.createTask(taskRow("t-2"), runRow("r-2", "t-2"));
          jest.advanceTimersByTime(150);
        }
        await started.promise;
        jest.advanceTimersByTime(25_000);
        if (phase === "delta") {
          assertStringIncludes((await stream.frames(1))[0], "event: heartbeat");
        }
        jest.advanceTimersByTime(5_000);
        assertEquals(await stream.frames(1), []);
        assertEquals(jest.getTimerCount(), 0);

        // Completion after the deadline cannot write a late sync/task or rearm any timers.
        release.resolve();
        await finished.promise;
        await Promise.resolve();
        await Promise.resolve();
        assertEquals(await stream.frames(1), []);
        assertEquals(jest.getTimerCount(), 0);
        store.listTasks = listTasks;
        store.listAgentsByIds = listAgents;
        // A write after closure must not leave a coalescing timer on the old subscription.
        await store.createTask(taskRow("t-3"), runRow("r-3", "t-3"));
        assertEquals(jest.getTimerCount(), 0);
        const recovered = tail(await handler(new Request(url)));
        streams.push(recovered);
        const [sync] = await recovered.frames(1);
        assertStringIncludes(sync, "event: sync");
        const ids = payload<ListBody>(sync).tasks.map((task) => task.id).sort();
        assertEquals(ids, phase === "delta" ? ["t-1", "t-2", "t-3"] : ["t-1", "t-3"]);
        await recovered.close();
        assertEquals(jest.getTimerCount(), 0);
      } finally {
        release.resolve();
        for (const stream of streams) await stream.close();
        jest.useRealTimers();
      }
    });
  }
}

test("task summaries publish declaration-only changes and clears over HTTP and SSE", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 1);
  const initial = (await store.getRun("r-1"))!;
  const beat = {
    ...initial,
    state: "running" as const,
    phase: "running" as const,
    idleState: "idle" as const,
  };
  await store.saveHeartbeat({ ...beat, heartbeatSeq: 1, declaredOutcome: "success" });
  const page = await handler(new Request("http://orchestrator.test/v1/tasks"));
  assertEquals((await page.json()).tasks[0].declaredOutcome, "success");
  const stream = tail(await handler(new Request("http://orchestrator.test/v1/tasks/stream")));
  try {
    const [sync] = await stream.frames(1);
    assertStringIncludes(sync, '"declaredOutcome":"success"');
    let seq = 1;
    for (const declaredOutcome of ["no-changes", "in-progress", null] as const) {
      await store.saveHeartbeat({ ...beat, heartbeatSeq: ++seq, declaredOutcome });
      const [frame] = await stream.frames(1);
      assertStringIncludes(frame, `"declaredOutcome":${JSON.stringify(declaredOutcome)}`);
    }
  } finally {
    await stream.close();
  }
});

test("the stream opens with a snapshot, then pushes every row that moves", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 2);

  const res = await handler(new Request("http://orchestrator.test/v1/tasks/stream"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  const stream = tail(res);
  try {
    // The snapshot: what the list holds right now, so a reconnect repairs itself and the window
    // between loading the page and opening the tail cannot swallow a change.
    const [sync] = await stream.frames(1);
    assertStringIncludes(sync, "event: sync");
    assertEquals(payload<ListBody>(sync).tasks.map((t) => t.id), ["t-2", "t-1"]);

    // A run moves; the tail hears it through the feed and reads the row back.
    await store.saveHeartbeat(runRow("r-1", "t-1", {
      state: "running",
      heartbeatSeq: 0,
      phase: "running",
      createdAt: AT(1),
      updatedAt: AT(5),
    }));
    const [moved] = await stream.frames(1);
    assertStringIncludes(moved, "event: task");
    assertEquals(payload<{ id: string; state: string }>(moved).id, "t-1");
    assertEquals(payload<{ id: string; state: string }>(moved).state, "running");

    // ...and a second task assigned while the tail is open arrives the same way.
    await store.createTask(
      taskRow("t-3", { createdAt: AT(6) }),
      runRow("r-3", "t-3", { createdAt: AT(6), updatedAt: AT(6) }),
    );
    const [born] = await stream.frames(1);
    assertEquals(payload<{ id: string }>(born).id, "t-3");
  } finally {
    await stream.close();
  }
});

test("an unfiltered tail removes a cancelled unprompted task and omits it on reconnect", async () => {
  const { handler, store } = buildListApp();
  await store.createAgent(agentRow("a-1", "Ada"));
  await store.createTask(
    taskRow("t-1", { spec: { title: null, instructions: null } }),
    runRow("r-1", "t-1"),
  );
  const url = "http://orchestrator.test/v1/tasks/stream";
  const stream = tail(await handler(new Request(url)));
  try {
    const [sync] = await stream.frames(1);
    assertEquals(payload<ListBody>(sync).tasks.map((t) => t.id), ["t-1"]);
    await store.saveRunTransition(
      runRow("r-1", "t-1", { state: "cancelled", updatedAt: AT(5) }),
      (await store.getRun("r-1"))!,
    );
    const [gone] = await stream.frames(1);
    assertStringIncludes(gone, "event: leave");
    assertEquals(payload<{ id: string }>(gone).id, "t-1");
  } finally {
    await stream.close();
  }
  const reconnected = tail(await handler(new Request(url)));
  try {
    const [sync] = await reconnected.frames(1);
    assertEquals(payload<ListBody>(sync).tasks, []);
  } finally {
    await reconnected.close();
  }
});

test("a tail with filters is told when a row leaves them", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 1);

  const res = await handler(new Request("http://orchestrator.test/v1/tasks/stream?status=live"));
  const stream = tail(res);
  try {
    const [sync] = await stream.frames(1);
    assertEquals(payload<ListBody>(sync).tasks.map((t) => t.id), ["t-1"]);

    // It finished, so it is no longer a live task — and a list showing live tasks must lose it.
    await store.saveRunResult(runRow("r-1", "t-1", {
      state: "succeeded",
      createdAt: AT(1),
      updatedAt: AT(5),
    }));
    const [gone] = await stream.frames(1);
    assertStringIncludes(gone, "event: leave");
    assertEquals(payload<{ id: string }>(gone).id, "t-1");
  } finally {
    await stream.close();
  }
});

test("the waiting run's claim moves the task row too, and only when it lands", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    // A run parked on an environment build: `starting`, no container, waiting on env-1. Every
    // path that moves one — the build settling, the reaper's backstop, a cancel — writes
    // through `saveRunIfWaiting`, and each of them changes the state the list draws.
    const waiting = runRow("r-1", "t-1", {
      state: "starting",
      environmentWait: { environmentId: "env-1", status: "building" },
      createdAt: AT(1),
      updatedAt: AT(1),
    });
    await store.createTask(taskRow("t-1", { createdAt: AT(1) }), waiting);
    assertEquals((await store.listTasks()).tasks[0].currentRun, {
      id: "r-1",
      state: "starting",
      phase: null,
      idleState: null,
      declaredOutcome: null,
    });

    // The build failed: the run is refused, and the row says so in the same transaction.
    const refused = {
      ...waiting,
      state: "errored" as const,
      environmentWait: null,
      updatedAt: AT(2),
    };
    assertEquals(await store.saveRunIfWaiting(refused, "env-1"), true);
    const [moved] = (await store.listTasks()).tasks;
    assertEquals(moved.currentRun, {
      id: "r-1",
      state: "errored",
      phase: null,
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(moved.lastActivityAt, AT(2));

    // The loser of the race wrote nothing, so it must say nothing: the run is no longer
    // `starting`, the claim does not land, and the row keeps the verdict that did.
    assertEquals(
      await store.saveRunIfWaiting({ ...waiting, state: "lost", updatedAt: AT(3) }, "env-1"),
      false,
    );
    const [unmoved] = (await store.listTasks()).tasks;
    assertEquals(unmoved.currentRun, {
      id: "r-1",
      state: "errored",
      phase: null,
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(unmoved.lastActivityAt, AT(2));
  } finally {
    await store.close();
  }
});

test("a launch's write lands only on a run still unlaunched, never over a cancel", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    const launching = runRow("r-1", "t-1", {
      state: "starting",
      createdAt: AT(1),
      updatedAt: AT(1),
    });
    await store.createTask(taskRow("t-1", { createdAt: AT(1) }), launching);
    const errored = { ...launching, state: "errored" as const, updatedAt: AT(3) };

    // A cancel landed while the launch ran: the launch's write does not undo it.
    await store.requestRunCancel(launching.id, AT(2));
    assertEquals(await store.saveRunIfUnlaunched(errored), false);
    const kept = (await store.getRun("r-1"))!;
    assertEquals([kept.state, kept.desiredState], ["starting", "cancelled"]);

    // Nobody asked this separate run to stop: the write lands, and moves its task row.
    // Cancellation is permanent within a run; resetting r-1 would not model a real launch.
    const unlaunched = { ...launching, id: "r-2", taskId: "t-2" };
    await store.createTask(taskRow("t-2", { createdAt: AT(1) }), unlaunched);
    assertEquals(
      await store.saveRunIfUnlaunched({ ...errored, id: "r-2", taskId: "t-2" }),
      true,
    );
    assertEquals((await store.getRun("r-2"))!.state, "errored");
    assertEquals(
      (await store.listTasks()).tasks.find((row) => row.task.id === "t-2")!.currentRun?.state,
      "errored",
    );

    // Waiting on a build is not unlaunched: that run is the wait's to move. It has no
    // cancellation intent, so the build wait itself must be what refuses the write.
    const waiting = {
      ...launching,
      id: "r-3",
      taskId: "t-3",
      environmentWait: { environmentId: "env-1", status: "queued" as const },
    };
    await store.createTask(taskRow("t-3", { createdAt: AT(1) }), waiting);
    assertEquals(
      await store.saveRunIfUnlaunched({ ...errored, id: "r-3", taskId: "t-3" }),
      false,
    );
  } finally {
    await store.close();
  }
});

test("a claim that lands announces itself; one that does not stays quiet", async () => {
  const feed = memoryTaskFeed();
  const store = publishTaskChanges(memoryTaskStore(), feed);
  const woken: string[] = [];
  feed.subscribe((id) => woken.push(id));

  await store.createAgent(agentRow("a-1", "Ada"));
  const waiting = runRow("r-1", "t-1", {
    state: "starting",
    environmentWait: { environmentId: "env-1", status: "building" },
    createdAt: AT(1),
    updatedAt: AT(1),
  });
  await store.createTask(taskRow("t-1", { createdAt: AT(1) }), waiting);
  assertEquals(woken, ["t-1"]);

  // `starting` → `errored` is the single most visible thing a row says, so the decorator has to
  // catch this write as it catches saveRun — a spread that passed it through would leave every
  // open tail showing a run that has been refused for as long as the tail stays open.
  assertEquals(
    await store.saveRunIfWaiting({
      ...waiting,
      state: "errored",
      environmentWait: null,
      updatedAt: AT(2),
    }, "env-1"),
    true,
  );
  assertEquals(woken, ["t-1", "t-1"]);

  // The caller that lost the race changed nothing, so it wakes nobody.
  assertEquals(
    await store.saveRunIfWaiting({ ...waiting, state: "lost", updatedAt: AT(3) }, "env-1"),
    false,
  );
  assertEquals(woken, ["t-1", "t-1"]);
});

test("a heartbeat that says nothing new wakes no tail", async () => {
  const feed = memoryTaskFeed();
  const store = publishTaskChanges(memoryTaskStore(), feed);
  const woken: string[] = [];
  feed.subscribe((id) => woken.push(id));

  await seed(store, 1);
  assertEquals(woken, ["t-1"], "a new task is news");

  // The runner beats again: same state, same phase, a newer clock. A list shows none of that,
  // so nothing is announced — this is what keeps a hundred live runs from waking every tail
  // every few seconds to send frames that change nothing.
  const beat = (at: string, seq: number) =>
    store.saveHeartbeat(runRow("r-1", "t-1", {
      state: "starting",
      createdAt: AT(1),
      updatedAt: at,
      lastHeartbeatAt: at,
      heartbeatSeq: seq,
    }));
  await beat(AT(2), 0);
  await beat(AT(3), 1);
  assertEquals(woken, ["t-1"]);

  // A phase change is news again.
  await store.saveHeartbeat(runRow("r-1", "t-1", {
    state: "running",
    heartbeatSeq: 2,
    phase: "cloning",
    createdAt: AT(1),
    updatedAt: AT(4),
  }));
  assertEquals(woken, ["t-1", "t-1"]);
});

test("a window wider than one page announces every row, and buries none", async () => {
  // `pending` has no bound — a deploy that touches every task puts everything into one 150ms
  // window. The read used to truncate to MAX_TASK_PAGE and then call every id past the
  // hundredth a `leave`, which on a client is the rest of its list disappearing.
  const { handler, store } = buildListApp();
  const count = MAX_TASK_PAGE + 25;
  await seed(store, count);

  const res = await handler(new Request("http://orchestrator.test/v1/tasks/stream"));
  const stream = tail(res);
  try {
    await stream.frames(1); // the snapshot

    // Every task moves inside one coalescing window.
    for (let i = 1; i <= count; i++) {
      await store.saveHeartbeat(runRow(`r-${i}`, `t-${i}`, {
        state: "running",
        heartbeatSeq: 0,
        phase: "cloning",
        createdAt: AT(i),
        updatedAt: AT(i + 1),
      }));
    }

    const frames = await stream.frames(count);
    const leaves = frames.filter((f) => f.startsWith("event: leave"));
    assertEquals(leaves, [], "every one of these rows still matches; none of them left");
    const announced = new Set(
      frames.filter((f) => f.startsWith("event: task")).map((f) => payload<{ id: string }>(f).id),
    );
    assertEquals(announced.size, count);
  } finally {
    await stream.close();
  }
});

test("from/to are normalized before they reach the store, never passed through", async () => {
  const { handler, store } = buildListApp();
  await seed(store, 3);

  // `created_at` is TEXT and every writer produces it with toISOString(), so the store compares
  // the bound value to it as text. A date this lenient parser accepts but never normalized
  // sorts before every row in the table, and the page came back empty with a 200 — which reads
  // as "you have no tasks" rather than "that is not a timestamp I can use".
  const loose = await getList(handler, `?from=${encodeURIComponent("Sep 1 2020")}`);
  assertEquals(loose.status, 200);
  assertEquals(loose.body.tasks.length, 3);

  // The same instant, spelled two ways, is the same page.
  const iso = await getList(handler, `?from=${encodeURIComponent(AT(2))}`);
  const offset = await getList(
    handler,
    `?from=${encodeURIComponent(new Date(AT(2)).toUTCString())}`,
  );
  assertEquals(offset.body.tasks.map((t) => t.id), iso.body.tasks.map((t) => t.id));

  // And what cannot be parsed at all is still a 400, not a quietly empty page.
  assertEquals((await getList(handler, "?to=whenever")).status, 400);
});

test("origin=chat is a page, not a 400 — chat tasks are tasks", async () => {
  const { handler, store } = buildListApp();
  await store.createAgent(agentRow("a-1", "Ada"));
  await store.createTask(
    taskRow("t-chat", { createdAt: AT(1), origin: "chat" }),
    runRow("r-chat", "t-chat", { createdAt: AT(1), updatedAt: AT(1) }),
  );
  const answered = await getList(handler, "?origin=chat");
  assertEquals(answered.status, 200);
  assertEquals(answered.body.tasks.map((t) => t.id), ["t-chat"]);
});

/**
 * One reader held across reads, because a task tail never ends: a helper that took the whole
 * response each time would lock the stream on its second call. `close()` is what cancels it —
 * and cancelling is also what the route's own cleanup hangs off, so every test must.
 */
function tail(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waiting: string[] = [];
  return {
    /** The next `count` frames, keepalive comments skipped — they are not news. */
    async frames(count: number): Promise<string[]> {
      const out: string[] = [];
      while (out.length < count) {
        if (waiting.length > 0) {
          out.push(waiting.shift()!);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!frame.startsWith(":")) waiting.push(frame);
        }
      }
      return out;
    },
    close: () => reader.cancel(),
  };
}

/** A frame's `data:` payload, parsed. */
function payload<T>(frame: string): T {
  return JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as T;
}

// ---- legacy tasks ------------------------------------------------------------------------
//
// A task stored before every task had to check out a connected repo: its entry names a raw git
// URL and no connected repo (core/legacy.ts). The dev cells hold such rows, so they must stay
// listed and readable, and private to their requester.

/** A task as one was stored before tasks had to check out a connected repo. */
function legacyTaskRow(id: string, over: Partial<Task> = {}): Task {
  const row = taskRow(id, over);
  return { ...row, repos: row.repos.map((r) => ({ ...r, connectedRepoId: null })) };
}

test("a legacy task stays in the store's pages, and only its requester sees it", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agentRow("a-1", "Ada"));
    await store.createTask(
      legacyTaskRow("t-old", { createdAt: AT(1), requestedByUserId: "u-1" }),
      runRow("r-old", "t-old", { createdAt: AT(1), updatedAt: AT(1) }),
    );
    await store.createTask(
      taskRow("t-new", { createdAt: AT(2), requestedByUserId: "u-1" }),
      runRow("r-new", "t-new", { createdAt: AT(2), updatedAt: AT(2) }),
    );

    const all = await store.listTasks({ limit: 10 });
    assertEquals(all.tasks.map((r) => r.task.id), ["t-new", "t-old"]);
    assertEquals((await store.getTask("t-old"))!.repos[0].connectedRepoId, null);

    // A writer of every connected repo still cannot see it: its entry has no repo to write.
    const writer = { kind: "principal" as const, userId: "u-2", writableRepoIds: ["cr-1"] };
    assertEquals(
      (await store.listTasks({ limit: 10, scope: writer })).tasks.map((r) => r.task.id),
      ["t-new"],
    );
    assertEquals(await store.getTask("t-old", writer), null);
    const requester = { kind: "principal" as const, userId: "u-1", writableRepoIds: [] };
    assertEquals((await store.getTask("t-old", requester))?.id, "t-old");
  } finally {
    await store.close();
  }
});

test("a legacy task is listed and opened over HTTP like any other", async () => {
  const { handler, store } = buildListApp();
  await store.createAgent(agentRow("a-1", "Ada"));
  await store.createTask(
    legacyTaskRow("t-old", { createdAt: AT(1) }),
    runRow("r-old", "t-old", {
      createdAt: AT(1),
      updatedAt: AT(1),
      state: "succeeded",
      result: {
        status: "success",
        summary: "Done.",
        branches: [{
          connectedRepoId: null,
          path: "repo",
          name: "ryph/ada/t-old",
          headSha: "a".repeat(40),
          commits: [{ sha: "a".repeat(40), subject: "old work" }],
          generation: 1,
        }],
      } as unknown as Run["result"],
    }),
  );

  const list = await getList(handler);
  assertEquals(list.status, 200);
  assertEquals(list.body.tasks.map((t) => t.id), ["t-old"]);
  const row = list.body.tasks[0] as unknown as { connectedRepoIds: string[] };
  assertEquals(row.connectedRepoIds, []);

  const res = await handler(new Request("http://orchestrator.test/v1/tasks/t-old"));
  assertEquals(res.status, 200);
  const view = await res.json();
  assertEquals(view.task.repos[0].connectedRepoId, null);
  assertEquals(view.runs[0].result.branches[0].connectedRepoId, null);
});
