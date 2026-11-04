// The progress comment: the pure composer, and the sweep that keeps one comment per
// forge-triggered run edited through the run's life — with a fake forge and a memory store.

import { test } from "bun:test";
import { NO_RUN_LIMITS } from "../src/core/types.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { composeProgressComment, composeReport } from "../src/core/report.ts";
import { openProgressComment, sweepProgressComments } from "../src/core/reaper.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { noopForge } from "../src/adapters/forge/noop.ts";
import { fakeClock, fakeIdentityDirectory, silentDiagnostics } from "./doubles.ts";
import type { Agent, ConnectedRepo, Patch, ProgressComment, Run, Task } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The composer, pure.
// ---------------------------------------------------------------------------

const COMPOSE_BASE = {
  runId: "r-1",
  taskId: "t-1",
  agentName: "Ada",
  appUrl: "https://ryph.example" as string | null,
  report: null as string | null,
};

test("a live comment names the state and phase, links the run, and says it will update", () => {
  const body = composeProgressComment({
    ...COMPOSE_BASE,
    state: "running",
    phase: "cloning",
  });
  assertStringIncludes(body, "**Ada**");
  assertStringIncludes(body, "`r-1`");
  assertStringIncludes(body, "**running** (cloning)");
  assertStringIncludes(body, "[View the run](https://ryph.example/tasks/t-1)");
  assertStringIncludes(body, "updates as the run progresses");
});

test("no appUrl, no link — and nothing else changes", () => {
  const body = composeProgressComment({
    ...COMPOSE_BASE,
    appUrl: null,
    state: "starting",
    phase: null,
  });
  assert(!body.includes("View the run"));
  assertStringIncludes(body, "**starting**");
});

test("a terminal comment embeds the report and drops the will-update line", () => {
  const report = composeReport({
    runId: "r-1",
    agentName: "Ada",
    summary: "Pinned the clock.",
    branches: [{ path: "app", commits: [{ sha: "a".repeat(40), subject: "fix the flaky test" }] }],
    noChanges: false,
    provenance: { origin: "forge", requestedByLogin: "ada", requestedVia: null },
  });
  const body = composeProgressComment({
    ...COMPOSE_BASE,
    state: "succeeded",
    phase: null,
    report,
  });
  assertStringIncludes(body, "**succeeded**");
  assertStringIncludes(body, "Pinned the clock.");
  assertStringIncludes(body, "**@ada** via a /ryph command");
  assert(!body.includes("updates as the run progresses"));
});

// ---------------------------------------------------------------------------
// Opening a comment: user-token GitHub is quiet; App GitHub and Radicle are unchanged.
// ---------------------------------------------------------------------------

for (
  const mode of [
    { provider: "github", installationId: null, expected: 0 },
    { provider: "github", installationId: "42", expected: 1 },
    { provider: "radicle", installationId: null, expected: 1 },
  ] as const
) {
  for (const kind of ["issue", "change_request"] as const) {
    test(`open progress: ${mode.provider}/${mode.installationId} ${kind}`, async () => {
      const repo: ConnectedRepo = {
        id: "cr-1",
        provider: mode.provider,
        installationId: mode.installationId,
        repoRef: "acme/app",
        url: "https://github.com/acme/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      };
      const saved: ProgressComment[] = [];
      let posts = 0;
      await openProgressComment({
        store: {
          saveProgressComment: (comment) => {
            saved.push(comment);
            return Promise.resolve();
          },
        },
        forge: {
          postComment: () => {
            posts++;
            return Promise.resolve({ commentId: "1001" });
          },
        },
        diag: silentDiagnostics(),
        now: () => new Date(T0),
        appUrl: "http://localhost:3000",
      }, {
        repo,
        thread: { kind, ref: "7" },
        runId: "r-1",
        taskId: "t-1",
        agentName: "Ada",
        state: "starting",
      });
      assertEquals(posts, mode.expected);
      assertEquals(saved.length, mode.expected);
      if (mode.expected === 1) {
        assertEquals(saved[0].commentId, "1001");
        assertEquals(saved[0].threadKind, kind);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

const agent: Agent = {
  id: "a-1",
  name: "Ada",
  handle: "ada",
  email: "ada@example.com",
  systemPrompt: null,
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
  memoryPolicy: null,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

const task: Task = {
  id: "t-1",
  agentId: "a-1",
  spec: { title: "/ryph on acme/app#7", instructions: "fix it" },
  repos: [{
    connectedRepoId: "cr-1",
    name: "acme/app",
    url: "https://github.com/acme/app.git",
    ref: "main",
    path: "app",
    branchNamespace: "ryph/ada/r-1",
    description: null,
  }],
  workspaceId: null,
  origin: "forge",
  requestedByUserId: "u-1",
  requestedVia: null,
  chatConversation: null,
  targetChangeRequest: null,
  landings: {},
  lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  purpose: null,
  createdAt: T0,
};

const run: Run = {
  id: "r-1",
  launchedAt: null,
  taskId: "t-1",
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
  tokenHash: "hash",
  controlToken: "control",
  handle: null,
  branchNamespace: "ryph/ada/r-1",
  image: null,
  environmentId: null,
  environment: null,
  environmentWait: null,
  workItem: {
    id: "r-1",
    agent: { name: "Ada", email: "ada@example.com" },
    spec: task.spec,
    repos: task.repos,
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
  createdAt: T0,
  updatedAt: T0,
};

const openComment: ProgressComment = {
  runId: "r-1",
  taskId: "t-1",
  connectedRepoId: "cr-1",
  threadKind: "issue",
  threadRef: "7",
  commentId: "1001",
  lastPosted: { state: "starting", phase: null },
  attempts: 0,
  concludedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

async function makeWorld(initial: Run = run) {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const forge = noopForge(silentDiagnostics());
  await store.createAgent(agent);
  await store.createTask(task, initial);
  await store.createConnectedRepo({
    id: "cr-1",
    provider: "github" as const,
    installationId: "42",
    repoRef: "acme/app",
    url: "https://github.com/acme/app.git",
    defaultBranch: "main",
    submissionPolicy: "require-approval",
    sizeClass: null,
    allowForkPushes: false,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
  const identities = fakeIdentityDirectory();
  identities.link("u-1", "ada");
  await store.saveProgressComment(openComment);
  const deps = {
    store,
    forge,
    githubConnect: noopForge(silentDiagnostics()),
    identityDirectory: identities.directory,
    diag: silentDiagnostics(),
    now: clock.now,
    appUrl: "https://ryph.example" as string | null,
  };
  return { store, clock, forge, deps };
}

test("a phase change produces exactly one edit; an unchanged run produces none", async () => {
  const world = await makeWorld();

  await world.store.saveHeartbeat({ ...run, state: "running", phase: "cloning", heartbeatSeq: 0 });
  await sweepProgressComments(world.deps);
  assertEquals(world.forge.commentUpdates.length, 1);
  assertEquals(world.forge.commentUpdates[0].commentId, "1001");
  assertStringIncludes(world.forge.commentUpdates[0].body, "**running** (cloning)");

  // Nothing moved: the next tick edits nothing.
  await sweepProgressComments(world.deps);
  assertEquals(world.forge.commentUpdates.length, 1);
});

test("a failed edit retries next tick — lastPosted only advances after GitHub answers", async () => {
  const world = await makeWorld();
  await world.store.saveHeartbeat({ ...run, state: "running", phase: "cloning", heartbeatSeq: 0 });

  let failures = 1;
  const flakyDeps = {
    ...world.deps,
    forge: {
      ...world.forge,
      updateComment: (...args: Parameters<typeof world.forge.updateComment>) =>
        failures-- > 0 ? Promise.reject(new Error("502")) : world.forge.updateComment(...args),
    },
  };
  await sweepProgressComments(flakyDeps); // fails, swallowed, lastPosted untouched
  assertEquals(world.forge.commentUpdates.length, 0);
  await sweepProgressComments(flakyDeps); // same evidence, retried, lands
  assertEquals(world.forge.commentUpdates.length, 1);
});

/** A run that finished claiming it already spoke in its thread. */
const minimal = {
  ...run,
  state: "succeeded" as const,
  result: {
    status: "success" as const,
    branches: [],
    summary: "Pinned the clock.",
    statusComment: "minimal" as const,
  },
};

/** One settled write of run r-1, as the ledger holds it. */
const wrote = (over: { tool: "add_comment" | "submit_review"; threadRef: string }) => ({
  id: `fa-${over.threadRef}`,
  runId: "r-1",
  connectedRepoId: "cr-1",
  provider: "github" as const,
  repoRef: "acme/app",
  state: "done" as const,
  url: "https://github.com/acme/app/issues/7#c1",
  createdThreadRef: null,
  detail: null,
  createdAt: T0,
  completedAt: T0,
  ...over,
});

test("a minimal status comment the ledger cannot back keeps the whole summary", async () => {
  const world = await makeWorld();
  // A write of this run's, but on another thread: this comment is not where it spoke.
  await world.store.reserveForgeToolAction(wrote({ tool: "add_comment", threadRef: "99" }), 20);
  await world.store.saveRunResult(minimal);

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "Pinned the clock.");
  assert(
    !body.includes("posted what it did in this thread"),
    "an agent that wrote nothing here does not get to point elsewhere",
  );
});

test("a minimal status comment stands where the run really did write in the thread", async () => {
  const world = await makeWorld();
  await world.store.reserveForgeToolAction(wrote({ tool: "add_comment", threadRef: "7" }), 20);
  await world.store.saveRunResult(minimal);

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "posted what it did in this thread");
  assert(!body.includes("Pinned the clock."), "said once, in the thread, not twice");
});

test("a cap spent to the last one is said in the thread, not only to the model", async () => {
  const world = await makeWorld({
    ...run,
    state: "succeeded",
    forgeScope: {
      repos: [{
        connectedRepoId: "cr-1",
        provider: "github" as const,
        repoRef: "acme/app",
        tenantId: "42",
      }],
      sourceRepos: [],
      origin: { connectedRepoId: "cr-1", kind: "issue", ref: "7" },
      capabilities: {
        read: true,
        createIssues: null,
        comment: { where: "origin", max: 2 },
        review: null,
        closeIssues: null,
        labels: [],
      },
      provenance: { agentName: "Ada", runUrl: null, requestedBy: "ada", requestedVia: null },
    },
    result: { status: "success", branches: [], summary: "Answered both." },
  });
  // Both of the two comments it was allowed, spent.
  await world.store.reserveForgeToolAction(wrote({ tool: "add_comment", threadRef: "7" }), 2);
  await world.store.reserveForgeToolAction(
    { ...wrote({ tool: "add_comment", threadRef: "7" }), id: "fa-second" },
    2,
  );

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "Budget spent");
  assertStringIncludes(body, "all 2 comments it may post");
  // A capability it still has budget for is not announced as spent.
  assert(!body.includes("issues it may open"));
});

test("a terminal run gets the report-bearing edit, the row concludes, later ticks skip it", async () => {
  const world = await makeWorld();
  await world.store.saveRunResult({
    ...run,
    state: "succeeded",
    result: {
      status: "success",
      branches: [{
        connectedRepoId: "cr-1",
        path: "app",
        line: "work",
        name: "ryph/ada/r-1/work",
        headSha: "a".repeat(40),
        commits: [{ sha: "a".repeat(40), subject: "fix the flaky test" }],
        carries: [],
        generation: 1,
      }],
      summary: "Pinned the clock.",
    },
  });

  await sweepProgressComments(world.deps);
  assertEquals(world.forge.commentUpdates.length, 1);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "**succeeded**");
  assertStringIncludes(body, "Pinned the clock.");
  assertStringIncludes(body, "**@ada** via a /ryph command");
  assertStringIncludes(body, "[View the run](https://ryph.example/tasks/t-1)");
  assertEquals(await world.store.listOpenProgressComments(), []);

  await sweepProgressComments(world.deps);
  assertEquals(world.forge.commentUpdates.length, 1); // concluded rows are done
});

test("a ref in a commit subject reads as text; only the summary's kept images stay refs", async () => {
  const world = await makeWorld();
  const shot = "img-aaaaaaaaaaaa";
  const subject = "fix ![the old page](img-000000000000)";
  // The head became a patch, so the comment lists its commits.
  const patch: Patch = {
    id: "p-1",
    connectedRepoId: "cr-1",
    runId: "r-1",
    taskId: "t-1",
    setId: "ps-1",
    path: "app",
    line: "work",
    branchName: "ryph/ada/r-1",
    headSha: "a".repeat(40),
    bundleKey: `r-1/cr-1/${"a".repeat(40)}.bundle`,
    baseSha: "b".repeat(40),
    generation: 1,
    title: null,
    description: null,
    commits: [{ sha: "a".repeat(40), subject }],
    carries: [],
    state: "pending_approval",
    attempts: 0,
    nextAttemptAt: null,
    leaseExpiresAt: null,
    lastError: null,
    approvedBy: null,
    approvedAt: null,
    forgeRef: null,
    forgeUrl: null,
    forgeBranch: null,
    diffRef: null,
    landed: null,
    supersededByPatchId: null,
    hookCheck: null,
    approvedHookPaths: [],
    memoryFateReportedAt: null,
    mergedCuedAt: null,
    mergedCueClaimedAt: null,
    landingAskedAt: null,
    heldReason: null,
    version: 0,
    createdAt: T0,
    updatedAt: T0,
  };
  await world.store.createPatch(patch);
  await world.store.saveRunResult({
    ...run,
    state: "succeeded",
    result: {
      status: "success",
      branches: [{
        connectedRepoId: "cr-1",
        path: "app",
        line: "work",
        name: "ryph/ada/r-1/work",
        headSha: "a".repeat(40),
        // The agent's own `git commit -m`: nothing checked the ref, and the forge would refuse
        // the whole comment over it, on every tick.
        commits: [{ sha: "a".repeat(40), subject }],
        carries: [],
        generation: 1,
      }],
      summary: `Pinned the clock. ![after](${shot})`,
      images: [{ ref: shot, attachmentId: "att-1", mime: "image/png", alt: "after" }],
    },
  });

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "fix the old page");
  assert(!body.includes("img-000000000000"), body);
  assertStringIncludes(body, `![after](${shot})`);
});

test("a run that may not open patches lists no commits, and claims no changes were needed", async () => {
  const world = await makeWorld({
    ...run,
    // What the run was told at its start decides, not the live switch.
    workItem: { ...run.workItem, canOpenPatches: false },
    state: "succeeded",
    result: {
      status: "success",
      // What a compromised runner might report: a branch, with subjects of its choosing.
      branches: [{
        connectedRepoId: "cr-1",
        path: "app",
        line: "work",
        name: "ryph/ada/r-1/work",
        headSha: "a".repeat(40),
        commits: [{ sha: "a".repeat(40), subject: "subject the runner chose" }],
        carries: [],
        generation: 1,
      }],
      summary: "Audited it.",
    },
  });

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assert(!body.includes("subject the runner chose"), body);
  assert(!body.includes("No code changes were needed"), body);
});

test("a reported head that never became a patch is not listed as shipped", async () => {
  const world = await makeWorld();
  await world.store.saveRunResult({
    ...run,
    state: "succeeded",
    result: {
      status: "success",
      // No patch row has this head: the control plane refused it at birth.
      branches: [{
        connectedRepoId: "cr-1",
        path: "app",
        line: "work",
        name: "ryph/ada/r-1/work",
        headSha: "e".repeat(40),
        commits: [{ sha: "e".repeat(40), subject: "a head that was refused" }],
        carries: [],
        generation: 1,
      }],
      summary: "Done.",
    },
  });
  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assert(!body.includes("a head that was refused"), body);
});

test("a terminal run whose agent posted in the thread keeps the comment minimal", async () => {
  const world = await makeWorld();
  // The review it says it posted, in the ledger — which is what makes the claim checkable.
  await world.store.reserveForgeToolAction(wrote({ tool: "submit_review", threadRef: "7" }), 20);
  await world.store.saveRunResult({
    ...run,
    state: "succeeded",
    result: {
      status: "success",
      branches: [],
      summary: "Reviewed the PR: two findings, posted as a review.",
      statusComment: "minimal",
    },
  });

  await sweepProgressComments(world.deps);
  const body = world.forge.commentUpdates[0].body;
  assertStringIncludes(body, "**succeeded**");
  assert(!body.includes("two findings"), "the summary stays on the run, not in the thread");
  assertStringIncludes(body, "posted what it did in this thread");
  assertStringIncludes(body, "**@ada** via a /ryph command");
  assertStringIncludes(body, "[View the run](https://ryph.example/tasks/t-1)");
});

test("a run born terminal closes its row without an edit — nothing new to say", async () => {
  const world = await makeWorld();
  // The intake posted the initial comment for an already-errored launch: lastPosted matches.
  await world.store.saveRunTransition({ ...run, state: "errored" }, run);
  await world.store.saveProgressComment({
    ...openComment,
    lastPosted: { state: "errored", phase: null },
    attempts: 0,
  });

  await sweepProgressComments(world.deps);
  assertEquals(world.forge.commentUpdates.length, 0);
  assertEquals(await world.store.listOpenProgressComments(), []);
});

test("a dangling row (its run deleted) is closed with a warning, not retried forever", async () => {
  const world = await makeWorld();
  await world.store.saveProgressComment({ ...openComment, runId: "r-gone", taskId: "t-1" });

  await sweepProgressComments(world.deps);
  const open = await world.store.listOpenProgressComments();
  assertEquals(open.map((c) => c.runId), ["r-1"]); // r-gone concluded; the real row stays
});

test("a permanently failing edit exhausts its budget and the row closes for good", async () => {
  const world = await makeWorld();
  await world.store.saveHeartbeat({ ...run, state: "running", phase: "cloning", heartbeatSeq: 0 });
  // One failure away from the budget: this tick's failure is the one that gives up.
  await world.store.saveProgressComment({ ...openComment, attempts: 179 });

  const deadDeps = {
    ...world.deps,
    forge: {
      ...world.forge,
      updateComment: () => Promise.reject(new Error("404 — the comment was deleted")),
    },
  };
  await sweepProgressComments(deadDeps);
  assertEquals(await world.store.listOpenProgressComments(), []);
  // And later ticks spend nothing on it.
  await sweepProgressComments(deadDeps);
});

test("a landed edit resets the failure budget", async () => {
  const world = await makeWorld();
  await world.store.saveHeartbeat({ ...run, state: "running", phase: "cloning", heartbeatSeq: 0 });
  await world.store.saveProgressComment({ ...openComment, attempts: 42 });

  await sweepProgressComments(world.deps);
  assertEquals((await world.store.listOpenProgressComments())[0].attempts, 0);
});
