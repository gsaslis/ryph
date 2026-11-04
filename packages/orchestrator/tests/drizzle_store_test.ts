// The drizzle adapter round-trips the same shapes the memory store does, on an in-memory db
// with the schema pushed straight from db/schema.ts (see tests/db.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { AttachmentClaimConflict } from "../src/core/attachments.ts";
import { drizzleTaskStore, retryOnDeadlock } from "../src/adapters/store/drizzle.ts";
import { drizzleEnvironmentStore } from "../src/adapters/store/drizzle_environments.ts";
import {
  type Agent,
  type GitlabProject,
  NO_RUN_LIMITS,
  type Patch,
  type PatchPayload,
  type Run,
  type Task,
} from "../src/core/types.ts";
import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { reconcileMergeSettles } from "../src/core/merge_settle.ts";
import { reconcileMergeReleases } from "../src/core/merge_release.ts";
import { DEFAULT_MERGE_POLL_CONFIG, pollChangeRequestEnds } from "../src/core/merge_poll.ts";
import { admitGitlabHook } from "../src/core/event_repos.ts";
import type { ForgeRepoRef, GitlabMode } from "../src/ports/forge.ts";
import { reusableDbSuite } from "./reusable_db.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { sweep } from "../src/core/reaper.ts";
import { cancelRun } from "../src/core/cancel_run.ts";
import { fakeProvisioner, fakeRunnerControl, silentDiagnostics } from "./doubles.ts";
import {
  HELD_REASON,
  landedVerdict,
  overlapReason,
  settlePatch,
  unrebasedReason,
} from "../src/core/patch_lifecycle.ts";

const { test, makeTestDb } = reusableDbSuite("drizzle store");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";

const agent: Agent = {
  id: "a-1",
  name: "Ada",
  handle: "ada",
  email: "ada@example.com",
  systemPrompt: "You are Ada.",
  harnessKind: "pi",
  modelPolicy: {
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5"],
    defaultModel: "claude-sonnet-5",
    defaultThinking: "high",
  },
  toolPolicy: {
    servers: [{ serverId: "ms-1", allowedTools: ["search_issues", "create_issue"] }],
  },
  forgePolicy: null,
  skillPolicy: null,
  networkPolicy: null,
  limitPolicy: null,
  canOpenPatches: true,
  canPublishArtifacts: false,
  browserEnabled: false,
  memoryPolicy: { budgetTokens: 2_000 },
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

const task: Task = {
  id: "t-1",
  agentId: "a-1",
  spec: { title: "Do the thing", instructions: "Please do the thing." },
  repos: [{
    connectedRepoId: "cr-1",
    name: "example/repo",
    url: "https://example.com/repo.git",
    ref: "main",
    path: "repo",
    branchNamespace: "ryph/ada/r-1",
    description: null,
  }],
  workspaceId: null,
  origin: "user",
  requestedByUserId: null,
  requestedVia: null,
  chatConversation: null,
  // Non-null on purpose: a round trip of null would pass with the column never written.
  targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
  landings: {},
  lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
  // Non-null for the same reason.
  purpose: "environment-setup",
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
  idleState: null,
  declaredOutcome: null,
  agentFinished: false,
  // Null here, unlike targetChangeRequest above — and the difference is the point: that one is
  // jsonb carrying a repo id it never constrains, while these are real columns with a FOREIGN
  // KEY, and most tests in this file build a database holding no connected repo at all. The
  // dedicated test below creates the repo and proves the round trip where it can.
  originThreadRepoId: null,
  originThreadKind: null,
  originThreadRef: null,
  originChatroomId: null,
  originThreadKey: null,
  tokenHash: "hash",
  controlToken: "control",
  handle: null,
  branchNamespace: "ryph/ada/r-1",
  image: "ryph-agent@sha256:" + "b".repeat(64),
  environmentId: "env-1",
  environment: {
    id: "env-1",
    image: "ryph-agent@sha256:" + "b".repeat(64),
    baked: true,
    commits: { repo: "c".repeat(40) },
    builtAt: T0,
    toolchains: { rustc: "1.97.1" },
    ref: "main",
  },
  environmentWait: null,
  workItem: {
    id: "r-1",
    agent: { name: "Ada", email: "ada@example.com" },
    spec: { title: "Do the thing", instructions: "Please do the thing." },
    repos: [{
      connectedRepoId: "cr-1",
      name: "example/repo",
      url: "https://example.com/repo.git",
      ref: "main",
      path: "repo",
      branchNamespace: "ryph/ada/r-1",
      description: null,
    }],
    workspace: null,
    harness: { kind: "pi", provider: "anthropic", model: "claude-sonnet-5" },
    lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
    canOpenPatches: true,
    canPublishArtifacts: false,
    chat: { kind: "zulip", roomTitle: "Radicle", botHandle: "ryph" },
  },
  injectedContext: { systemPrompt: "You are Ada." },
  modelScope: {
    providerKeyId: "pk-1",
    provider: "anthropic",
    allowedModels: ["claude-sonnet-5"],
    model: "claude-sonnet-5",
    thinking: "high",
  },
  forgeScope: null,
  networkScope: { mode: "open", bundles: [], hosts: [] },
  limits: NO_RUN_LIMITS,
  egressRefusals: null,
  skills: null,
  toolScope: {
    servers: [{ serverId: "ms-1", allowedTools: ["search_issues", "create_issue"] }],
  },
  services: {
    services: [{
      name: "db",
      image: "postgres:18@sha256:" + "a".repeat(64),
      command: ["postgres", "-p", "5433"],
      env: { POSTGRES_PASSWORD: "password" },
      port: 5433,
      security: { capabilities: ["CHOWN", "SETGID", "SETUID"], allowPrivilegeEscalation: false },
      resources: { cpus: "1", memory: "1g" },
    }],
    stale: false,
  },
  result: null,
  memoryOutcomeReportedAt: null,
  skillsReportedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

test("drizzle store round-trips agents, tasks, runs, and events", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    // Agents: create, read back verbatim, update in place (archive is just a save).
    await store.createAgent(agent);
    assertEquals(await store.getAgent("a-1"), agent);
    assertEquals((await store.listAgents()).map((a) => a.id), ["a-1"]);
    await store.saveAgent({ ...agent, archivedAt: T1, updatedAt: T1 });
    assertEquals((await store.getAgent("a-1"))?.archivedAt, T1);

    await store.createTask(task, run);
    assertEquals(await store.getTask("t-1"), task);
    assertEquals((await store.listTasks()).tasks.map((t) => t.task.id), ["t-1"]);
    // The run row IS a core Run — including the frozen workItem/context JSON snapshots.
    assertEquals(await store.getRun("r-1"), run);
    assertEquals((await store.runsForTask("t-1")).map((r) => r.id), ["r-1"]);

    // Active until terminal; a result write concludes it, including the result JSON.
    assertEquals((await store.listActiveRuns()).map((r) => r.id), ["r-1"]);
    const succeeded: Run = {
      ...run,
      state: "succeeded",
      result: {
        status: "success",
        branches: [{
          connectedRepoId: "cr-1",
          path: "repo",
          line: "work",
          name: "ryph/ada/r-1/work",
          headSha: "abc",
          commits: [],
          carries: [],
          generation: 1,
        }],
        summary: "did the thing",
      },
      updatedAt: T1,
    };
    await store.saveRunResult(succeeded);
    assertEquals(await store.listActiveRuns(), []);
    assertEquals(await store.getRun("r-1"), succeeded);

    await store.appendEvent({ runId: "r-1", at: T0, kind: "created" });
    await store.appendEvent({ runId: "r-1", at: T0, kind: "result-received", detail: "success" });
    const events = await store.listEvents("r-1");
    assertEquals(events.map((e) => e.kind), ["created", "result-received"]);
    assertEquals(events[1].detail, "success");
    assert(!("detail" in events[0]));
  } finally {
    await store.close();
  }
});

test("a model policy stored before the thinking default reads back with it null", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    // The JSON as an older build wrote it: no `defaultThinking` key at all.
    const { defaultThinking: _, ...older } = agent.modelPolicy!;
    await store.createAgent({ ...agent, modelPolicy: older as NonNullable<Agent["modelPolicy"]> });
    const filled = { ...agent.modelPolicy!, defaultThinking: null };
    assertEquals((await store.getAgent("a-1"))?.modelPolicy, filled);
    assertEquals((await store.getAgentByHandle("ada"))?.modelPolicy, filled);
    assertEquals((await store.listAgents())[0].modelPolicy, filled);
    assertEquals((await store.listAgentsByIds(["a-1"]))[0].modelPolicy, filled);
  } finally {
    await store.close();
  }
});

test("event existence is scoped to both run and kind in both stores", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createTask({ ...task, id: "t-2" }, { ...run, id: "r-2", taskId: "t-2" });
      assertEquals(await store.hasRunEvent(run.id, "kill-requested"), false);
      await store.appendEvent({ runId: run.id, at: T0, kind: "cancel-requested" });
      await store.appendEvent({ runId: "r-2", at: T0, kind: "kill-requested" });
      assertEquals(await store.hasRunEvent(run.id, "kill-requested"), false);
      assertEquals(await store.hasRunEvent("r-2", "kill-requested"), true);
      await store.appendEvent({ runId: run.id, at: T0, kind: "kill-requested" });
      assertEquals(await store.hasRunEvent(run.id, "kill-requested"), true);
      assertEquals(await store.hasRunEvent("missing", "kill-requested"), false);
    } finally {
      await store.close();
    }
  }
});

test("result writes preserve cancellation intent and its first timestamp", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.requestRunCancel(run.id, T0);
      // The result handler can hold a copy read before the cancellation request.
      await store.saveRunResult({ ...run, state: "succeeded", updatedAt: T1 });
      const saved = await store.getRun(run.id);
      assertEquals(saved!.state, "succeeded");
      assertEquals(saved!.desiredState, "cancelled");
      assertEquals(saved!.cancelRequestedAt, T0);
      // Even a second request must not restart the cancellation grace clock.
      await store.requestRunCancel(run.id, T1);
      assertEquals((await store.getRun(run.id))!.cancelRequestedAt, T0);
    } finally {
      await store.close();
    }
  }
});

test("run creation rejects existing ids; results are first-writer-wins and can recover lost", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      await assertRejects(async () => await store.saveRun({ ...run, state: "lost" }));
      assertEquals(await store.getRun(run.id), run);
      assert(await store.saveRunTransition({ ...run, state: "lost", updatedAt: T1 }, run));
      const result: Run = {
        ...run,
        state: "succeeded",
        result: { status: "success", summary: "first result", branches: [] },
        updatedAt: T2,
      };
      assert(await store.saveRunResult(result));
      assertEquals(await store.saveRunResult({ ...result, state: "errored" }), null);
      assertEquals(await store.getRun(run.id), result);
      assertEquals(await store.saveRunTransition({ ...run, state: "lost" }, run), null);
      assertEquals((await store.listTasks()).tasks[0].currentRun.state, "succeeded");
    } finally {
      await store.close();
    }
  }
});

test("late launch metadata preserves a delivered result and the task's activity clock", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      const delivered = await store.saveRunResult({
        ...run,
        state: "succeeded",
        result: { status: "success", summary: "finished during launch", branches: [] },
        updatedAt: T1,
      });
      const launched = await store.recordRunLaunch(run.id, "container", T2);
      assertEquals(launched, { ...delivered!, handle: "container", launchedAt: T2 });
      assertEquals((await store.listTasks()).tasks[0].lastActivityAt, T1);
      assertEquals((await store.listTasks()).tasks[0].currentRun.state, "succeeded");
    } finally {
      await store.close();
    }
  }
});

test("stale lifecycle writes cannot undo a newer heartbeat or its idle deadline", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      const beat: Run = {
        ...run,
        state: "running",
        heartbeatSeq: 0,
        lastHeartbeatAt: T1,
        idleDeadlineAt: T2,
        phase: "running",
        updatedAt: T1,
      };
      assert(await store.saveHeartbeat(beat));
      assertEquals(
        await store.saveRunTransition({ ...run, state: "lost", updatedAt: T2 }, run),
        null,
      );
      assertEquals(
        (await store.requestRunCancel(run.id, T2, { idleDeadlineAt: run.idleDeadlineAt })).applied,
        false,
      );
      assertEquals(await store.getRun(run.id), beat);
      const delivered = await store.saveRunResult({
        ...run,
        state: "succeeded",
        result: { status: "success", summary: "done", branches: [] },
        updatedAt: T2,
      });
      assertEquals(delivered?.heartbeatSeq, 0);
      assertEquals(delivered?.idleDeadlineAt, T2);
    } finally {
      await store.close();
    }
  }
});

for (const race of ["lost", "cancel", "idle-expired", "limit-reached"] as const) {
  test(`a delivered result survives a stale ${race} writer`, async () => {
    for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
      try {
        const live: Run = {
          ...run,
          state: "running",
          launchedAt: T0,
          lastHeartbeatAt: race === "lost" ? T0 : T1,
          handle: "container",
          idleDeadlineAt: race === "idle-expired" ? T0 : null,
          limits: race === "limit-reached"
            ? { ...NO_RUN_LIMITS, wallClockMs: 1000 }
            : NO_RUN_LIMITS,
        };
        await store.createAgent(agent);
        await store.createTask(task, live);
        const delivered: Run = {
          ...live,
          state: "succeeded",
          result: { status: "success", summary: "a delivered result", branches: [] },
          updatedAt: T1,
        };
        const deliver = () => store.saveRunResult(delivered);
        const { provisioner, kills } = fakeProvisioner();
        const { control, cancels } = fakeRunnerControl({ reachable: true });
        const revoked: string[] = [];
        if (race === "cancel") {
          await deliver();
          // The HTTP caller already holds the live snapshot when the result lands.
          const outcome = await cancelRun({
            store,
            runnerControl: control,
            now: () => new Date(T1),
          }, live);
          assertEquals(outcome, { kind: "terminal", pushed: false });
        } else {
          if (race === "lost") {
            const kill = provisioner.kill;
            provisioner.kill = async (handle, options) => {
              await kill(handle, options);
              // This is the await between the sweep's read and the write it used to lose.
              await deliver();
            };
          } else {
            const listActiveRuns = store.listActiveRuns.bind(store);
            store.listActiveRuns = async () => {
              const snapshot = await listActiveRuns();
              await deliver();
              return snapshot;
            };
          }
          await sweep({
            store,
            provisioner,
            runnerControl: control,
            diag: silentDiagnostics(),
            now: () => new Date(T1),
            modelAccess: {
              revokeRunCredentials: (id) => {
                revoked.push(id);
                return Promise.resolve();
              },
            },
          }, {
            heartbeatTimeoutMs: 60_000,
            startupGraceMs: 300_000,
            cancelGraceMs: 30_000,
            idleGraceMs: 30_000,
          });
        }
        assertEquals(await store.getRun(run.id), delivered);
        assertEquals((await store.listTasks()).tasks[0].currentRun.state, "succeeded");
        const events = await store.listEvents(run.id);
        assertEquals(
          events.filter((event) =>
            ["marked-lost", "cancel-requested", "cancel-confirmed", "idle-expired", "limit-reached"]
              .includes(event.kind)
          ),
          [],
        );
        assertEquals(cancels, []);
        assertEquals(revoked, []);
        assertEquals(kills.length, race === "lost" ? 1 : 0);
      } finally {
        await store.close();
      }
    }
  });
}

for (const race of ["limit-reached", "idle-expired", "idle-moved"] as const) {
  test(
    `a heartbeat during the sweep ${
      race === "idle-moved" ? "that moves the idle deadline refuses" : "does not refuse"
    } a ${race === "limit-reached" ? "limit" : "idle"} cancel`,
    async () => {
      for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
        try {
          const live: Run = {
            ...run,
            state: "running",
            launchedAt: T0,
            heartbeatSeq: 0,
            lastHeartbeatAt: T1,
            handle: "container",
            idleDeadlineAt: race === "limit-reached" ? null : T0,
            limits: race === "limit-reached"
              ? { ...NO_RUN_LIMITS, wallClockMs: 1000 }
              : NO_RUN_LIMITS,
          };
          await store.createAgent(agent);
          await store.createTask(task, live);
          const listActiveRuns = store.listActiveRuns.bind(store);
          store.listActiveRuns = async () => {
            const snapshot = await listActiveRuns();
            // The runner keeps beating while the sweep reads spends and works through other runs.
            assert(
              await store.saveHeartbeat({
                ...live,
                heartbeatSeq: 1,
                idleDeadlineAt: race === "idle-moved" ? T2 : live.idleDeadlineAt,
              }),
            );
            return snapshot;
          };
          const { provisioner } = fakeProvisioner();
          const { control, cancels } = fakeRunnerControl({ reachable: true });
          await sweep({
            store,
            provisioner,
            runnerControl: control,
            diag: silentDiagnostics(),
            now: () => new Date(T1),
          }, {
            heartbeatTimeoutMs: 60_000,
            startupGraceMs: 300_000,
            cancelGraceMs: 30_000,
            idleGraceMs: 30_000,
          });
          const applied = race !== "idle-moved";
          const saved = await store.getRun(run.id);
          assertEquals(saved!.heartbeatSeq, 1);
          assertEquals(saved!.desiredState, applied ? "cancelled" : null);
          const kinds = (await store.listEvents(run.id)).map((event) => event.kind);
          assertEquals(
            kinds.includes(race === "limit-reached" ? "limit-reached" : "idle-expired"),
            applied,
          );
          assertEquals(cancels.length, applied ? 1 : 0);
        } finally {
          await store.close();
        }
      }
    },
  );
}

test("launch metadata moves a live run's activity clock forward", async () => {
  for (const store of [memoryTaskStore(), drizzleTaskStore(await makeTestDb())]) {
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      const launched = await store.recordRunLaunch(run.id, "container", T2);
      assertEquals(launched?.updatedAt, T2);
      assertEquals((await store.listTasks()).tasks[0].lastActivityAt, T2);
    } finally {
      await store.close();
    }
  }
});

test("recordSkillsReport lands one report per run, and a lifecycle transition keeps its mark", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);

    // An empty first report claims the run all the same.
    assertEquals(await store.recordSkillsReport("r-1", T0, []), true);
    assertEquals((await store.getRun("r-1"))!.skillsReportedAt, T0);
    assertEquals(
      await store.recordSkillsReport("r-1", T1, [{ kind: "skills.dropped", detail: "x" }]),
      false,
    );
    assertEquals(
      (await store.listEvents("r-1")).filter((e) => e.kind.startsWith("skills.")),
      [],
      "a refused report appends nothing",
    );

    // A transition from a run read before the report must not put the null back.
    assert(await store.saveRunTransition({ ...run, updatedAt: T1 }, run));
    assertEquals((await store.getRun("r-1"))!.skillsReportedAt, T0);

    // The events land with the claim, in order, at its time.
    await store.createAgent({ ...agent, id: "a-2", handle: "ada2", email: "ada2@example.com" });
    await store.createTask(
      { ...task, id: "t-2", agentId: "a-2" },
      { ...run, id: "r-2", taskId: "t-2", agentId: "a-2" },
    );
    assertEquals(
      await store.recordSkillsReport("r-2", T1, [
        { kind: "skills.repo", detail: "release (`repo/`)" },
        { kind: "skills.dropped", detail: "lint (`repo/`): cap" },
      ]),
      true,
    );
    assertEquals(
      (await store.listEvents("r-2")).map((e) => [e.kind, e.at, e.detail]),
      [["skills.repo", T1, "release (`repo/`)"], ["skills.dropped", T1, "lint (`repo/`): cap"]],
    );
  } finally {
    await store.close();
  }
});

test("reserveCredentialSlot admits exactly the cap, and a release gives its slot back", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);

    // The cap is 2, and only two of three admit. This is a correctness check, not a proof the
    // row lock closes the race: `makeTestDb`'s pglite serves one connection, so this `Promise.all`
    // runs its three transactions one after another regardless of the lock — the same three
    // reservers would still admit exactly two if `reserveCredentialSlot`'s `for update` were
    // deleted. Proving the race needs two real connections against one database, which the test
    // suite does not have.
    const results = await Promise.all([
      store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2),
      store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2),
      store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2),
    ]);
    assertEquals(results.filter((r) => r.reserved).length, 2, "exactly the cap admits");
    assertEquals(results.filter((r) => !r.reserved).length, 1);
    const issued = (await store.listEvents("r-1")).filter((e) => e.kind === "credentials-issued");
    assertEquals(issued.length, 2, "one row per admitted reservation, not per attempt");

    // A fourth reservation is refused at the cap...
    const fourth = await store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2);
    assertEquals(fourth.reserved, false);

    // ...until a mint that "failed" releases its slot, which is then free to reserve again.
    const [admitted] = results.filter((r) => r.reserved);
    assert(admitted.reserved);
    await store.releaseCredentialSlot("r-1", admitted.seq);
    assertEquals(
      (await store.listEvents("r-1")).filter((e) => e.kind === "credentials-issued").length,
      1,
    );
    assertEquals(
      (await store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2)).reserved,
      true,
    );
    assertEquals(
      (await store.reserveCredentialSlot("r-1", { at: T0, detail: "pk-1" }, 2)).reserved,
      false,
    );

    // Releasing a seq that belongs to a different run touches nothing.
    await store.createAgent({ ...agent, id: "a-2", handle: "ada2", email: "ada2@example.com" });
    await store.createTask(
      { ...task, id: "t-2", agentId: "a-2" },
      { ...run, id: "r-2", taskId: "t-2", agentId: "a-2", tokenHash: "h2" },
    );
    const otherRunReserve = await store.reserveCredentialSlot("r-2", { at: T0, detail: "pk-1" }, 2);
    assert(otherRunReserve.reserved);
    await store.releaseCredentialSlot("r-1", otherRunReserve.seq);
    assertEquals(
      (await store.listEvents("r-2")).filter((e) => e.kind === "credentials-issued").length,
      1,
      "a release scoped to the wrong run is a no-op",
    );
  } finally {
    await store.close();
  }
});

test("createTask is atomic: a failing run insert rolls the task back", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    // Same run id → unique violation inside the batch; the new task must not survive.
    let threw = false;
    try {
      await store.createTask({ ...task, id: "t-2" }, { ...run, taskId: "t-2" });
    } catch {
      threw = true;
    }
    assert(threw);
    assertEquals(await store.getTask("t-2"), null);
  } finally {
    await store.close();
  }
});

test("git virtual keys ride createTask, resolve by hash, and revoke per run", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run, {
      id: "gk-1",
      runId: "r-1",
      tokenHash: "abc123",
      expiresAt: T1,
      revokedAt: null,
      createdAt: T0,
    });

    const key = await store.getGitKeyByTokenHash("abc123");
    assert(key !== null);
    assertEquals(key.runId, "r-1");
    assertEquals(key.revokedAt, null);
    assertEquals(await store.getGitKeyByTokenHash("nope"), null);

    await store.revokeGitKeysForRun("r-1", T1);
    assertEquals((await store.getGitKeyByTokenHash("abc123"))!.revokedAt, T1);
    // Idempotent: a second revoke pass leaves the original stamp.
    await store.revokeGitKeysForRun("r-1", "2026-01-02T00:00:00.000Z");
    assertEquals((await store.getGitKeyByTokenHash("abc123"))!.revokedAt, T1);
  } finally {
    await store.close();
  }
});

test("phase-2 rows round-trip: installations, connected repos, identities, patches", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    // Idempotent on the GitHub-side id: re-landing the install flow updates, never duplicates.
    await store.saveInstallation({
      id: "gi-2",
      installationId: "12345",
      accountLogin: "acme-renamed",
      createdAt: T1,
    });
    assertEquals((await store.listInstallations()).length, 1);
    const installation = await store.getInstallationByInstallationId("12345");
    assertEquals(installation!.accountLogin, "acme-renamed");

    const repo = {
      id: "cr-1",
      provider: "github" as const,
      installationId: "12345",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      submissionPolicy: "require-approval" as const,
      sizeClass: null as string | null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    };
    await store.createConnectedRepo(repo);
    assertEquals(await store.getConnectedRepo("cr-1"), repo);
    await store.saveConnectedRepo({ ...repo, submissionPolicy: "auto", updatedAt: T1 });
    assertEquals((await store.getConnectedRepo("cr-1"))!.submissionPolicy, "auto");
    await store.saveConnectedRepo({ ...repo, sizeClass: "large", updatedAt: T1 });
    assertEquals((await store.getConnectedRepo("cr-1"))!.sizeClass, "large");

    // A patch needs its anchors (agent, task+run) to exist.
    await store.createAgent(agent);
    await store.createTask(task, run);
    const patch = {
      id: "p-1",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "ps-1",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "r-1/cr-1/abc123.bundle",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      state: "pending_approval" as const,
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
      heldReason: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      version: 0,
      createdAt: T0,
      updatedAt: T0,
    };
    await store.createPatch(patch);
    assertEquals(await store.getPatch("p-1"), patch);
    assertEquals(await store.findPatchByRepoAndHead("cr-1", "abc123"), patch);
    assertEquals(await store.findPatchByRepoAndHead("cr-1", "nope"), null);
    assertEquals((await store.listPatches({ state: "pending_approval" })).patches.length, 1);
    assertEquals((await store.listPatches({ state: "queued" })).patches.length, 0);
    // Waiting on a person is not the sweep's business: only a queued patch is in its working set.
    assertEquals((await store.listActivePatches()).length, 0);
    await store.savePatch({ ...patch, state: "queued" });
    assertEquals((await store.listActivePatches()).map((p) => p.id), ["p-1"]);
    // A failure is the sweep's only while its retry clock runs; without one it waits on a person.
    await store.savePatch({ ...patch, state: "failed", nextAttemptAt: null });
    assertEquals((await store.listActivePatches()).length, 0);
    await store.savePatch({ ...patch, state: "failed", nextAttemptAt: T1 });
    assertEquals((await store.listActivePatches()).map((p) => p.id), ["p-1"]);
    assertEquals((await store.patchesForTask("t-1")).length, 1);
    assertEquals((await store.patchesForSet("ps-1")).map((p) => p.id), ["p-1"]);

    await store.savePatch({
      ...patch,
      state: "submitted",
      approvedBy: { kind: "user", userId: "u-1" },
      forgeRef: "42",
      forgeUrl: "https://github.com/acme/app/pull/42",
      forgeBranch: "ryph/ada/r-1",
      diffRef: null,
      updatedAt: T1,
    });
    assertEquals((await store.getPatch("p-1"))!.approvedBy, { kind: "user", userId: "u-1" });
    assertEquals((await store.listActivePatches()).length, 0);

    // The submit claim is a conditional write, and the condition is read from the STORED row —
    // the whole point being that a caller holding a stale copy loses. This row is `submitted`
    // now, so a claim expecting `queued` must decline and leave it untouched.
    const stale = { ...patch, state: "submitting" as const, attempts: 1, updatedAt: T1 };
    assertEquals(await store.savePatchIfState(stale, ["queued"]), null);
    assertEquals((await store.getPatch("p-1"))!.state, "submitted");

    // ...and one whose expectation matches wins, writing the row through, and answers the row's
    // new version.
    const won = await store.savePatchIfState(stale, ["submitted"]);
    assertEquals(won, (await store.getPatch("p-1"))!.version);
    assertEquals(typeof won, "number");
    assertEquals((await store.getPatch("p-1"))!.state, "submitting");

    // Narrowed to a lease, only the submitter holding that exact lease writes: a hand-back
    // from a sweep whose lease another sweep has since replaced declines.
    await store.savePatch({ ...stale, leaseExpiresAt: T1 });
    assertEquals(
      await store.savePatchIfState({ ...patch, state: "queued" }, ["submitting"], T0),
      null,
    );
    assertEquals((await store.getPatch("p-1"))!.state, "submitting");
    assertEquals(
      typeof await store.savePatchIfState({ ...patch, state: "queued" }, ["submitting"], T1),
      "number",
    );
    assertEquals((await store.getPatch("p-1"))!.state, "queued");

    // Narrowed to the row as it was read, a write over a row changed since declines even when its
    // state still matches: a person's decision is about the patch they were shown.
    const read = (await store.getPatch("p-1"))!;
    assertEquals(
      await store.savePatchIfState(
        { ...read, state: "rejected", updatedAt: T1 },
        ["queued"],
        undefined,
        read.version - 1,
      ),
      null,
    );
    assertEquals((await store.getPatch("p-1"))!.state, "queued");
    assertEquals(
      typeof await store.savePatchIfState(
        { ...read, state: "rejected", updatedAt: T1 },
        ["queued"],
        undefined,
        read.version,
      ),
      "number",
    );
    assertEquals((await store.getPatch("p-1"))!.state, "rejected");
    await store.savePatch(read);

    // A patch that does not exist is never a claim, whatever the expectation.
    assertEquals(await store.savePatchIfState({ ...stale, id: "p-nope" }, ["queued"]), null);
    assertEquals(await store.getPatch("p-nope"), null);

    // The webhook's lookup finds a patch by its pull request whatever became of it — a closed
    // one reopened and merged arrives as a second webhook for the same row.
    const submitted = { ...patch, state: "submitted" as const, forgeRef: "42", updatedAt: T1 };
    await store.savePatch(submitted);
    assertEquals((await store.patchesByRepoAndForgeRef("cr-1", "42")).map((p) => p.id), ["p-1"]);
    assertEquals(await store.patchesByRepoAndForgeRef("cr-1", "43"), []);

    // The memory reconciliation's working set: settled, and not yet acknowledged.
    assertEquals(await store.listPatchesAwaitingMemoryFate(), []);
    const landed = { ...submitted, landed: { kind: "merged" as const, at: T1 } };
    await store.savePatch(landed);
    assertEquals((await store.listPatchesAwaitingMemoryFate()).map((p) => p.id), ["p-1"]);
    await store.savePatch({ ...landed, memoryFateReportedAt: T1 });
    assertEquals(await store.listPatchesAwaitingMemoryFate(), []);
    // A failed patch is owed one too (the clock is judged in core, not in SQL).
    await store.savePatch({ ...patch, state: "failed", lastError: "403" });
    assertEquals((await store.listPatchesAwaitingMemoryFate()).map((p) => p.id), ["p-1"]);
  } finally {
    await store.close();
  }
});

test("a patch's hook check round-trips, and the hook sweep lists only unchecked local waiters", async () => {
  // Against the generated migrations (makeTestDb applies them): the columns exist, the default
  // holds, and the sweep's query narrows by provider in SQL.
  const store = drizzleTaskStore(await makeTestDb());
  try {
    const repoRow = (id: string, provider: "github" | "local", repoRef: string) => ({
      id,
      provider,
      installationId: provider === "github" ? "12345" : null,
      repoRef,
      url: provider === "github" ? `https://github.com/${repoRef}.git` : repoRef,
      defaultBranch: "main",
      submissionPolicy: "auto" as const,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    await store.createConnectedRepo(repoRow("cr-gh", "github", "acme/app"));
    await store.createConnectedRepo(repoRow("cr-local", "local", "/Users/ada/code/app"));
    await store.createAgent(agent);
    await store.createTask(task, run);
    const patch = (id: string, connectedRepoId: string) => ({
      id,
      connectedRepoId,
      runId: "r-1",
      taskId: "t-1",
      setId: "ps-1",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: id.padEnd(40, "0"),
      bundleKey: `r-1/${connectedRepoId}/${id}.bundle`,
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      state: "queued" as const,
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
      approvedHookPaths: [] as string[],
      memoryFateReportedAt: null,
      mergedCuedAt: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      heldReason: null,
      version: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await store.createPatch(patch("p-gh", "cr-gh"));
    await store.createPatch(patch("p-local", "cr-local"));
    await store.createPatch({ ...patch("p-local-2", "cr-local"), state: "pending_approval" });
    await store.createPatch({ ...patch("p-local-3", "cr-local"), state: "submitted" });
    assertEquals(
      (await store.listPatchesAwaitingHookCheck()).map((p) => p.id).sort(),
      ["p-local", "p-local-2"],
    );
    const check = {
      touched: [".husky/pre-commit"],
      hooksPaths: [".husky"],
      more: false,
      at: T1,
    };
    await store.savePatch({
      ...patch("p-local", "cr-local"),
      hookCheck: check,
      approvedHookPaths: [".husky/pre-commit"],
    });
    const read = (await store.getPatch("p-local"))!;
    assertEquals(read.hookCheck, check);
    assertEquals(read.approvedHookPaths, [".husky/pre-commit"]);
    assertEquals((await store.getPatch("p-gh"))!.approvedHookPaths, []);
    assertEquals((await store.listPatchesAwaitingHookCheck()).map((p) => p.id), ["p-local-2"]);
  } finally {
    await store.close();
  }
});

test("agent handles: looked up, unique in SQL, and NULLs coexist", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent); // handle "ada"
    assertEquals((await store.getAgentByHandle("ada"))?.id, "a-1");
    assertEquals(await store.getAgentByHandle("nobody"), null);

    // The unique index is the backstop under the read-then-write race in the handler.
    let threw = false;
    try {
      await store.createAgent({ ...agent, id: "a-2" }); // same handle
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    // Legacy rows (handle NULL) coexist in any number — Postgres unique indexes admit NULLs.
    await store.createAgent({ ...agent, id: "a-3", handle: null });
    await store.createAgent({ ...agent, id: "a-4", handle: null });
    assertEquals((await store.listAgents()).length, 3);
  } finally {
    await store.close();
  }
});

test("agent patch switch: a full-row save never writes it; the conditional write does", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    assertEquals((await store.getAgent("a-1"))!.canOpenPatches, true);
    assertEquals(await store.setAgentCanOpenPatches("a-1", true, false), true);
    // A save from a copy read before the lock leaves the lock alone.
    await store.saveAgent({ ...agent, name: "Renamed", canOpenPatches: true });
    const saved = (await store.getAgent("a-1"))!;
    assertEquals([saved.name, saved.canOpenPatches], ["Renamed", false]);
    // A stale `from` writes nothing, nor does an unknown id.
    assertEquals(await store.setAgentCanOpenPatches("a-1", true, false), false);
    assertEquals(await store.setAgentCanOpenPatches("a-nope", false, true), false);
    assertEquals(await store.setAgentCanOpenPatches("a-1", false, true), true);
    assertEquals((await store.getAgent("a-1"))!.canOpenPatches, true);
  } finally {
    await store.close();
  }
});

test("agent artifact switch: a full-row save never writes it; the conditional write does", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent({ ...agent, canPublishArtifacts: true });
    assertEquals(await store.setAgentCanPublishArtifacts("a-1", true, false), true);
    // A save from a copy read before an admin switched it off leaves it off.
    await store.saveAgent({ ...agent, name: "Renamed", canPublishArtifacts: true });
    const saved = (await store.getAgent("a-1"))!;
    assertEquals([saved.name, saved.canPublishArtifacts], ["Renamed", false]);
    assertEquals(await store.setAgentCanPublishArtifacts("a-1", true, false), false);
    assertEquals(await store.setAgentCanPublishArtifacts("a-nope", false, true), false);
    assertEquals(await store.setAgentCanPublishArtifacts("a-1", false, true), true);
    assertEquals((await store.getAgent("a-1"))!.canPublishArtifacts, true);
  } finally {
    await store.close();
  }
});

test("forge events: the claim insert admits exactly one winner per delivery id", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    const record = {
      deliveryId: "gh-1",
      kind: "issue_comment.created",
      outcome: "processing" as const,
      taskId: null,
      receivedAt: T0,
      createdAt: T0,
      claimedAt: T0,
    };
    assertEquals(await store.claimForgeEvent(record), true);
    assertEquals(await store.claimForgeEvent(record), false);

    // recordForgeEvent finalizes in place — an upsert, never a second row.
    await store.recordForgeEvent({ ...record, outcome: "started", taskId: "t-1" });
    assertEquals(await store.claimForgeEvent(record), false);
  } finally {
    await store.close();
  }
});

test("progress comments: upsert by run, and only open rows surface for the sweep", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    await store.saveInstallation({
      id: "gi-1",
      installationId: "42",
      accountLogin: "acme",
      createdAt: T0,
    });
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

    const comment = {
      runId: "r-1",
      taskId: "t-1",
      connectedRepoId: "cr-1",
      threadKind: "issue" as const,
      threadRef: "7",
      commentId: "1001",
      lastPosted: { state: "starting" as const, phase: null },
      attempts: 0,
      concludedAt: null,
      createdAt: T0,
      updatedAt: T0,
    };
    await store.saveProgressComment(comment);
    assertEquals(await store.listOpenProgressComments(), [comment]);

    // Concluding closes the row: later sweeps see nothing.
    await store.saveProgressComment({ ...comment, concludedAt: T1, updatedAt: T1 });
    assertEquals(await store.listOpenProgressComments(), []);
  } finally {
    await store.close();
  }
});

test("workspaces: adds and archives serialize on the workspace — no member past the cap, none left bound", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    const repo = (i: number) => ({
      id: `cr-${i}`,
      provider: "github" as const,
      installationId: "12345",
      repoRef: `acme/r${i}`,
      url: `https://github.com/acme/r${i}.git`,
      defaultBranch: "main",
      submissionPolicy: "require-approval" as const,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    for (let i = 0; i < 25; i++) await store.createConnectedRepo(repo(i));
    const workspace = (id: string) => ({
      id,
      name: id,
      description: null,
      sizeClass: null,
      environmentRepoId: null,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    const member = (workspaceId: string, i: number) => ({
      workspaceId,
      connectedRepoId: `cr-${i}`,
      ref: null,
      path: `r${i}`,
      description: null,
      createdAt: T1,
      updatedAt: T1,
    });

    // One slot left, three adds racing for it: exactly one lands.
    await store.createWorkspace(workspace("ws-1"));
    for (let i = 0; i < 4; i++) {
      assertEquals(await store.addWorkspaceRepo(member("ws-1", i), 5), "added");
    }
    const raced = await Promise.all(
      [4, 5, 6].map((i) => store.addWorkspaceRepo(member("ws-1", i), 5)),
    );
    assertEquals(raced.filter((r) => r === "added").length, 1);
    assertEquals(raced.filter((r) => r === "full").length, 2);
    assertEquals((await store.listWorkspaceRepos("ws-1")).length, 5);
    assertEquals((await store.getWorkspace("ws-1"))!.updatedAt, T1, "an add touches its workspace");

    // An add racing an archive: whichever order they land in, no member stays bound.
    await store.createWorkspace(workspace("ws-2"));
    const [added, archived] = await Promise.all([
      store.addWorkspaceRepo(member("ws-2", 10), 20),
      store.archiveWorkspace("ws-2", T1),
    ]);
    assert(added === "added" || added === "archived", added);
    assertEquals(archived!.archivedAt, T1);
    assertEquals(await store.listWorkspaceRepos("ws-2"), []);
    assertEquals(await store.findWorkspaceRepo("cr-10"), null);
    assertEquals(await store.addWorkspaceRepo(member("ws-2", 11), 20), "archived");

    // A repeat archive keeps the first timestamp and still finishes the release.
    assertEquals(
      (await store.archiveWorkspace("ws-2", "2026-02-01T00:00:00.000Z"))!.archivedAt,
      T1,
    );
    assertEquals(await store.archiveWorkspace("ws-nope", T1), null);

    // The name and description write refuses an archived workspace and touches nothing else.
    assertEquals(
      await store.updateWorkspace("ws-2", {
        name: "renamed",
        description: null,
        sizeClass: null,
        environmentRepoId: null,
        updatedAt: T1,
      }),
      false,
    );
    assertEquals((await store.getWorkspace("ws-2"))!.name, "ws-2");
    assertEquals(
      await store.updateWorkspace("ws-1", {
        name: "renamed",
        description: "d",
        sizeClass: "large",
        environmentRepoId: "cr-1",
        updatedAt: T1,
      }),
      true,
    );
    assertEquals((await store.getWorkspace("ws-1"))!.name, "renamed");
    assertEquals((await store.getWorkspace("ws-1"))!.sizeClass, "large");
    assertEquals((await store.getWorkspace("ws-1"))!.environmentRepoId, "cr-1");

    // A repo already in a workspace is taken, whichever workspace asks.
    await store.createWorkspace(workspace("ws-3"));
    assertEquals(await store.addWorkspaceRepo(member("ws-3", 0), 20), "taken");
  } finally {
    await store.close();
  }
});

test("runs: memory's acknowledgement is the mark's alone, and the sweep lists what it still owes", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    const before = "2026-01-02T00:00:00.000Z";
    assertEquals(await store.listRunsAwaitingMemoryOutcome(before, 10), [], "not terminal yet");
    await store.saveRunResult({ ...run, state: "succeeded", updatedAt: T1 });
    assertEquals((await store.listRunsAwaitingMemoryOutcome(before, 10)).map((r) => r.id), ["r-1"]);
    assertEquals(await store.listRunsAwaitingMemoryOutcome(T0, 10), [], "inside the grace");

    await store.markRunMemoryOutcomeReported("r-1", T1);
    assertEquals(await store.listRunsAwaitingMemoryOutcome(before, 10), []);
    // A duplicate result from before the mark does not put the null back.
    await store.saveRunResult({ ...run, state: "succeeded", updatedAt: T1 });
    assertEquals((await store.getRun("r-1"))!.memoryOutcomeReportedAt, T1);
  } finally {
    await store.close();
  }
});

test("a run remembers the forge thread it answers, and only a LIVE one holds it", async () => {
  // The columns behind "one thread, one run": written on the run, found by the /ryph intake,
  // and released the moment the run stops going. Against real SQL rather than the memory
  // double, because this is an indexed lookup and a double cannot fail on the index.
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github" as const,
      installationId: "12345",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      submissionPolicy: "require-approval" as const,
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    const commanded: Run = {
      ...run,
      originThreadRepoId: "cr-1",
      originThreadKind: "change_request",
      originThreadRef: "7",
    };
    await store.createTask(task, commanded);

    // Round-tripped verbatim — which is what a null-only fixture could never prove.
    assertEquals(await store.getRun("r-1"), commanded);
    const at = (connectedRepoId: string, threadKind: "issue" | "change_request", ref: string) =>
      store.findLiveRunByOrigin({ kind: "forge", connectedRepoId, threadKind, ref });
    assertEquals(await at("cr-1", "change_request", "7"), commanded);

    // Keyed on all three: issue #7 is not pull request #7, and neither is #8 or another repo.
    assertEquals(await at("cr-1", "issue", "7"), null);
    assertEquals(await at("cr-1", "change_request", "8"), null);
    assertEquals(await at("cr-2", "change_request", "7"), null);
    // Nor is a chat thread, whatever it is called.
    assertEquals(
      await store.findLiveRunByOrigin({ kind: "chat", chatroomId: "cr-1", threadKey: "7" }),
      null,
    );

    // And it is the LIVE run that holds a thread: once it ends, the thread is free again —
    // which is what lets the next /ryph start a fresh run instead of being refused forever.
    await store.saveRunResult({ ...commanded, state: "succeeded", updatedAt: T1 });
    assertEquals(await at("cr-1", "change_request", "7"), null);
  } finally {
    await store.close();
  }
});

test("a change request is held by the run that targets it, not only by one commanded there", async () => {
  // The claim behind the mid-run swap, against real SQL: the origin columns answer the run that
  // was COMMANDED from the thread, and the task's `targetChangeRequest` — jsonb, unindexed, read
  // through the task's denormalized current attempt — answers the one that moved onto it later.
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.createAgent(agent);
    const targeting: Task = {
      ...task,
      targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
    };
    await store.createTask(targeting, run);

    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "7"))?.id, "r-1");
    // Keyed on both halves, and on nothing else's thread.
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "8"), null);
    assertEquals(await store.findLiveRunOnChangeRequest("cr-2", "7"), null);

    // The re-target is decided over the rows as they stand and writes exactly the columns it
    // moves: the current attempt's denormalized state — `saveRun`'s — is left alone.
    await store.saveHeartbeat({
      ...run,
      state: "running",
      phase: "running",
      heartbeatSeq: 0,
      lastHeartbeatAt: T1,
      updatedAt: T1,
    });
    const args = {
      taskId: "t-1",
      runId: "r-1",
      path: "repo",
      connectedRepoId: "cr-1",
      thread: "9",
      headRef: "feat/scheduler",
      headSha: "a".repeat(40),
      targetRef: "main",
      at: T1,
    };
    assert(await store.applyRetarget(args) !== null);
    const moved = (await store.getTask("t-1"))!;
    assertEquals([moved.repos[0].ref, moved.repos[0].targetRef], ["feat/scheduler", "main"]);
    assertEquals(moved.targetChangeRequest, { connectedRepoId: "cr-1", thread: "9" });
    assertEquals((await store.listTasks()).tasks[0].currentRun.state, "running");
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "7"), null);
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "9"))?.id, "r-1");

    // The run's part: the frozen spec and the forge scope, and nothing a concurrent cancel,
    // attend or result wrote while the forge was being asked.
    await store.requestRunCancel(run.id, T2);
    await store.markRunAttended(run.id, T2);
    await store.applyRetarget({ ...args, headRef: "feat/scheduler-b", at: T2 });
    const written = (await store.getRun("r-1"))!;
    assertEquals(written.workItem.repos[0].ref, "feat/scheduler-b");
    assertEquals(written.desiredState, "cancelled", "a cancel is not written back over");
    assertEquals(written.cancelRequestedAt, T2);
    assertEquals(written.attended, true);
    assertEquals(written.state, "running", "nor is the state the caller read before the forge");

    // And a thread is held only while the run goes on, exactly as the origin reading is.
    await store.saveRunResult({ ...run, state: "succeeded", updatedAt: T2 });
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "9"), null);

    // A terminal run is not written back to; its task still moves.
    const ended = (await store.getRun("r-1"))!.workItem;
    await store.applyRetarget({ ...args, headRef: "feat/other", at: T2 });
    assertEquals((await store.getRun("r-1"))!.workItem, ended);
    assertEquals((await store.getTask("t-1"))!.repos[0].ref, "feat/other");

    // An OLDER live holder is still the answer when a newer targeting task's run has ended.
    // `current_run_state` is a DENORMALIZATION, so the two can disagree — which is why the
    // lookup reads every live-targeting task instead of stopping at the newest one. The
    // divergence is written by hand here: it is the state a crash between `saveRun`'s two
    // statements would leave, and no store method produces it on purpose.
    for (const n of ["2", "3"]) {
      await store.createTask(
        {
          ...targeting,
          id: `t-${n}`,
          createdAt: T2,
          targetChangeRequest: { connectedRepoId: "cr-1", thread: "5" },
        },
        { ...run, id: `r-${n}`, taskId: `t-${n}`, state: "running", createdAt: T2, updatedAt: T2 },
      );
    }
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "5"))?.id, "r-3");
    await handle.db.execute(sql`update "runs" set "state" = 'succeeded' where "id" = 'r-3'`);
    assertEquals(
      (await handle.db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, "t-3") }))
        ?.currentRunState,
      "running",
      "the task still calls its ended run live — the case the fix is about",
    );
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "5"))?.id, "r-2");
  } finally {
    await store.close();
  }
});

test("a change request is held by the live run whose patch opened it", async () => {
  // a run summoned from an issue opens a pull request through submit_patch. Neither
  // its origin (the issue) nor its task (which targets nothing) names that pull request; only
  // the patch's `forge_ref` does, and the lookup has to read it or a `/ryph` on the pull request
  // starts a second run onto the same branch.
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      submissionPolicy: "auto",
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    await store.createAgent(agent);
    const fromIssue: Run = {
      ...run,
      state: "running",
      originThreadRepoId: "cr-1",
      originThreadKind: "issue",
      originThreadRef: "3",
    };
    await store.createTask(task, fromIssue);
    const patch: Patch = {
      id: "p-1",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "ps-1",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "r-1/cr-1/abc123.bundle",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      state: "queued",
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
      heldReason: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      version: 0,
      createdAt: T0,
      updatedAt: T0,
    };
    await store.createPatch(patch);
    // Not yet at the forge: nothing names #12.
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "12"), null);

    await store.savePatch({ ...patch, state: "submitted", forgeRef: "12", updatedAt: T1 });
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "12"))?.id, "r-1");
    // Keyed on both halves.
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "13"), null);
    // Landed or not: a follow-up on the just-merged pull request still reaches its author.
    await store.savePatch({
      ...patch,
      state: "submitted",
      forgeRef: "12",
      landed: { kind: "merged", at: T2 },
      updatedAt: T2,
    });
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "12"))?.id, "r-1");

    // Only while the run goes on: once it ends, the pull request is free for a fresh run.
    await store.saveRunResult({ ...fromIssue, state: "succeeded", updatedAt: T2 });
    assertEquals(await store.findLiveRunOnChangeRequest("cr-1", "12"), null);
  } finally {
    await store.close();
  }
});

test("a message claims its images in its own append: one image, one message", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    await store.createTask({ ...task, id: "t-2" }, { ...run, id: "r-2", taskId: "t-2" });
    const attachment = (id: string, runId: string) => ({
      id,
      runId,
      mime: "image/png" as const,
      bytes: 8,
      sha256: "0".repeat(64),
      ref: null,
      source: "user" as const,
      storageKey: `attachments/${runId}/${id}`,
      claimedBy: null,
      createdAt: T0,
    });
    await store.createUnclaimedAttachment(attachment("att-1", "r-1"), 20);
    await store.createUnclaimedAttachment(attachment("att-2", "r-2"), 20);
    const message = (id: string, refs: string[]) => ({
      id,
      runId: "r-1",
      kind: "user" as const,
      sender: { kind: "user" as const, userId: "u-1" },
      text: "look",
      payload: null,
      attachments: refs.map((ref) => ({ id: ref, mime: "image/png" as const })),
      createdAt: T0,
      deliveredAt: null,
    });
    // Two messages racing for one image: exactly one carries it, the other writes nothing.
    const raced = await Promise.allSettled([
      store.appendRunMessage(message("rm-a", ["att-1"])),
      store.appendRunMessage(message("rm-b", ["att-1"])),
    ]);
    const won = raced.filter((r) => r.status === "fulfilled");
    const lost = raced.filter((r) => r.status === "rejected");
    assertEquals([won.length, lost.length], [1, 1]);
    assert((lost[0] as PromiseRejectedResult).reason instanceof AttachmentClaimConflict);
    const stored = await store.listRunMessages("r-1");
    assertEquals(stored.length, 1);
    assertEquals(stored[0].attachments, [{ id: "att-1", mime: "image/png" }]);
    assertEquals((await store.getAttachment("att-1"))?.claimedBy, stored[0].id);
    // Another run's image is not this run's to carry, and the append rolls back whole.
    await assertRejects(
      () => store.appendRunMessage(message("rm-c", ["att-2"])),
      AttachmentClaimConflict,
    );
    assertEquals((await store.listRunMessages("r-1")).length, 1);
    assertEquals((await store.getAttachment("att-2"))?.claimedBy, null);
    assertEquals(
      (await store.listAttachmentsByIds(["att-1", "att-2", "att-none"])).map((a) => a.id).sort(),
      ["att-1", "att-2"],
    );
    // A message of text alone carries an empty list.
    const plain = await store.appendRunMessage(message("rm-d", []));
    assertEquals(plain.attachments, []);
  } finally {
    await store.close();
  }
});

test("a run's start images land in its own insert; unclaimed uploads are counted, aged and taken back conditionally", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    const attachment = (id: string, runId: string, claimedBy: string | null, createdAt = T0) => ({
      id,
      runId,
      mime: "image/png" as const,
      bytes: 8,
      sha256: "0".repeat(64),
      ref: null,
      source: "forge" as const,
      storageKey: `attachments/${runId}/${id}`,
      claimedBy,
      createdAt,
    });
    // Refused as full: neither the run nor its images' rows exist.
    await store.createTask(task, run);
    const full = await store.createTask(
      { ...task, id: "t-full" },
      { ...run, id: "r-full", taskId: "t-full" },
      undefined,
      { maxLive: 1, attachments: [attachment("att-full", "r-full", "task")] },
    );
    assertEquals(full, "full");
    assertEquals(await store.getAttachment("att-full"), null);
    // Created: the rows are there the moment the run is.
    assertEquals(
      await store.createTask(
        { ...task, id: "t-2" },
        { ...run, id: "r-2", taskId: "t-2" },
        undefined,
        {
          maxLive: null,
          attachments: [attachment("att-a", "r-2", "task"), attachment("att-b", "r-2", "task")],
        },
      ),
      "created",
    );
    assertEquals((await store.getAttachment("att-a"))?.claimedBy, "task");

    // The unclaimed half: counted per run, read oldest first before a cutoff, deleted only
    // while still this run's and unclaimed.
    await store.createUnclaimedAttachment(
      attachment("att-old", "r-1", null, "2026-01-01T00:00:00.000Z"),
      20,
    );
    await store.createUnclaimedAttachment(
      attachment("att-new", "r-1", null, "2026-01-03T00:00:00.000Z"),
      20,
    );
    await store.createUnclaimedAttachment(
      attachment("att-sent", "r-1", "rm-1", "2026-01-01T00:00:00.000Z"),
      20,
    );
    assertEquals(await store.countUnclaimedAttachments("r-1"), 2);
    assertEquals(await store.countUnclaimedAttachments("r-2"), 0);
    assertEquals(
      (await store.listUnclaimedAttachmentsBefore("2026-01-02T00:00:00.000Z", 10)).map((a) => a.id),
      ["att-old"],
    );
    assertEquals(await store.deleteUnclaimedAttachment("r-2", "att-old"), null, "another run's");
    assertEquals(await store.deleteUnclaimedAttachment("r-1", "att-sent"), null, "a sent one");
    assertEquals((await store.deleteUnclaimedAttachment("r-1", "att-old"))?.id, "att-old");
    assertEquals(await store.getAttachment("att-old"), null);
    assertEquals(await store.deleteUnclaimedAttachment("r-1", "att-old"), null);
    assertEquals(await store.countUnclaimedAttachments("r-1"), 1);
  } finally {
    await store.close();
  }
});

test("the unclaimed cap is counted and written in one step: racing uploads cannot overfill it", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    const attachment = (id: string, claimedBy: string | null = null) => ({
      id,
      runId: "r-1",
      mime: "image/png" as const,
      bytes: 8,
      sha256: "0".repeat(64),
      ref: null,
      source: "user" as const,
      storageKey: `attachments/r-1/${id}`,
      claimedBy,
      createdAt: T0,
    });
    // A sent image is no slot's: only unclaimed rows count.
    assertEquals(await store.createUnclaimedAttachment(attachment("att-sent", "rm-1"), 3), true);
    assertEquals(await store.createUnclaimedAttachment(attachment("att-0"), 3), true);
    // Thirty uploads racing for the two slots left: exactly two are written.
    const raced = await Promise.all(
      Array.from(
        { length: 30 },
        (_, i) => store.createUnclaimedAttachment(attachment(`att-r${i}`), 3),
      ),
    );
    assertEquals(raced.filter((written) => written).length, 2);
    assertEquals(await store.countUnclaimedAttachments("r-1"), 3);
  } finally {
    await store.close();
  }
});

test("landing a merge is one conditional write of task, run, landings and event", async () => {
  // Against real SQL: the repo moves onto where the forge says it merged, each repo
  // list in its own spelling; the run's spec moves only while the run is live; the landing and
  // the event land with the move; any later or concurrent call finds it landed and answers the
  // same landings; and a merge of an older generation never moves it back.
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
      repoRef: "acme/app",
      url: "https://github.com/acme/app.git",
      defaultBranch: "main",
      submissionPolicy: "auto",
      sizeClass: null,
      allowForkPushes: false,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
    await store.createAgent(agent);
    const entry = { ...task.repos[0], connectedRepoId: "cr-1" };
    const web = { ...task.repos[0], connectedRepoId: "cr-2", path: "web", ref: "main" };
    // A stacked pull request: opened against feature-a, which merged first and was deleted, so
    // GitHub retargeted this one onto main before it merged. And a second repo of the checkout.
    const onPr: Task = {
      ...task,
      repos: [{ ...entry, ref: "refs/heads/feat/x", targetRef: "refs/heads/feature-a" }, web],
      targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
    };
    const live: Run = {
      ...run,
      state: "running",
      workItem: {
        ...run.workItem,
        repos: [{ ...entry, ref: "feat/x", targetRef: "feature-a" }, web],
      },
    };
    await store.createTask(onPr, live);
    const patch = {
      id: "p-none",
      taskId: "t-1",
      runId: "r-1",
      connectedRepoId: "cr-1",
      path: "repo",
      line: "work",
      forgeRef: "7",
      generation: 1,
    };
    // The forge's word is "main" unless a test says otherwise; `null` stands for its silence.
    const land = (over: Partial<typeof patch> = {}, said: string | null = "main") =>
      store.landMerge({
        patch: { ...patch, ...over },
        mergedInto: said ?? undefined,
        defaultBranch: "main",
        at: T2,
      });

    // A cancel lands on the run before the merge does; the landing must not undo it. And two
    // deliveries of the merge race: exactly one lands, the other keeps what it wrote.
    await store.requestRunCancel(live.id, T1);
    const [a, b] = await Promise.all([land(), land()]);
    assertEquals([a.outcome.kind, b.outcome.kind].toSorted(), ["kept", "landed"]);
    const landing = {
      connectedRepoId: "cr-1",
      thread: "7",
      onto: "main",
      generation: 1,
      moved: true,
      at: T2,
    };
    const kept = [a.outcome, b.outcome].find((o) => o.kind === "kept");
    assert(kept?.kind === "kept");
    assertEquals(kept.landing, landing);
    const task1 = (await store.getTask("t-1"))!;
    assertEquals(task1.targetChangeRequest, null);
    assertEquals(task1.landings, { repo: { work: landing } });
    assertEquals(task1.repos, [{ ...entry, ref: "refs/heads/main" }, web]);
    const run1 = (await store.getRun("r-1"))!;
    assertEquals(run1.workItem.repos, [{ ...entry, ref: "main" }, web]);
    assertEquals(run1.updatedAt, T2);
    assertEquals(run1.desiredState, "cancelled");
    assertEquals(
      (await store.listEvents("r-1")).filter((e) => e.kind === "merge-landed").map((e) => e.detail),
      ["#7 merged into main; repo now on main (the task had feature-a)"],
    );

    // The other repo lands on its own, by its own path, and the first stays as it is.
    const webLanded = await land(
      { connectedRepoId: "cr-2", path: "web", forgeRef: "9" },
      "release",
    );
    assert(webLanded.outcome.kind === "landed");
    const task2 = (await store.getTask("t-1"))!;
    assertEquals(task2.repos, [{ ...entry, ref: "refs/heads/main" }, { ...web, ref: "release" }]);
    assertEquals(Object.keys(task2.landings).toSorted(), ["repo", "web"]);

    // A later generation moves it on; a late merge of the earlier one never moves it back.
    assert((await land({ forgeRef: "11", generation: 2 }, "next")).outcome.kind === "landed");
    const back = await land({ forgeRef: "7", generation: 1 }, "main");
    assertEquals(back.outcome.kind, "kept");
    assertEquals((await store.getTask("t-1"))!.repos[0].ref, "refs/heads/next");
    assertEquals((await store.getTask("t-1"))!.landings.repo.work.generation, 2);

    // Another LINE of the same repo lands on its own record: the default line's landing, and its
    // generation, stay exactly where they were, and a late merge of the line's own first
    // generation is kept, as for any line.
    const fixA = await land({ line: "fix-a", forgeRef: "13", generation: 1 }, "next");
    assert(fixA.outcome.kind === "landed");
    const lined = (await store.getTask("t-1"))!.landings.repo;
    assertEquals(Object.keys(lined).toSorted(), ["r-1/fix-a", "work"]);
    assertEquals([lined.work.generation, lined.work.thread], [2, "11"]);
    assertEquals([lined["r-1/fix-a"].generation, lined["r-1/fix-a"].thread], [1, "13"]);
    assertEquals(
      (await land({ line: "fix-a", forgeRef: "13", generation: 1 })).outcome.kind,
      "kept",
    );
    // A later run's line of the same name is other work: its first generation lands on a record
    // of its own, and the earlier run's next merge of its line leaves that one be.
    await store.saveRun({ ...live, id: "r-later", branchNamespace: "ryph/ada/r-later" });
    const other = await land(
      { runId: "r-later", line: "fix-a", forgeRef: "15", generation: 1 },
      "hotfix",
    );
    assert(other.outcome.kind === "landed");
    assert(
      (await land({ line: "fix-a", forgeRef: "16", generation: 2 }, "next")).outcome.kind ===
        "landed",
    );
    const both = (await store.getTask("t-1"))!.landings.repo;
    assertEquals(Object.keys(both).toSorted(), ["r-1/fix-a", "r-later/fix-a", "work"]);
    assertEquals([both["r-later/fix-a"].onto, both["r-later/fix-a"].thread], ["hotfix", "15"]);
    assertEquals([both["r-1/fix-a"].generation, both["r-1/fix-a"].thread], [2, "16"]);

    // The verdict on a patch is written once, with its event, however many deliveries race —
    // and a merge may still revise a close.
    const submitted: Patch = {
      id: "p-1",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "ps-1",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "r-1/cr-1/abc123.bundle",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      state: "submitted",
      attempts: 1,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      lastError: null,
      approvedBy: null,
      approvedAt: null,
      forgeRef: "7",
      forgeUrl: "https://github.com/acme/app/pull/7",
      forgeBranch: "feat/x",
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
    await store.createPatch(submitted);
    const event = (detail: string) => ({
      runId: "r-1",
      at: T2,
      kind: "patch-settled" as const,
      detail,
    });
    const closed = { ...submitted, landed: { kind: "closed" as const, at: T1 }, updatedAt: T1 };
    assertEquals(await store.settlePatchIf(closed, null, [event("closed")]), true);
    const merged = { ...submitted, landed: { kind: "merged" as const, at: T2 }, updatedAt: T2 };
    const settles = await Promise.all([
      store.settlePatchIf(merged, "closed", [event("merged")]),
      store.settlePatchIf(merged, "closed", [event("merged")]),
    ]);
    assertEquals(settles.toSorted(), [false, true]);
    assertEquals((await store.getPatch("p-1"))!.landed, { kind: "merged", at: T2 });
    assertEquals(
      (await store.listEvents("r-1")).filter((e) => e.kind === "patch-settled").map((e) =>
        e.detail
      ),
      ["closed", "merged"],
    );

    // The cue is claimed by one poster at a time, however many race for it, and a claim older
    // than the lease is free again.
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => store.claimMergedCue("p-1", T2, T1)),
    );
    assertEquals(claims.filter(Boolean).length, 1);
    assertEquals(await store.claimMergedCue("p-1", T2, T1), false);
    assertEquals(await store.claimMergedCue("p-1", T2, "2099-01-01T00:00:00.000Z"), true);
    // A write over the row as it was read: a version that moved since loses.
    const read = (await store.getPatch("p-1"))!;
    await store.savePatch({ ...read, title: "moved" });
    assertEquals(
      await store.savePatchIfState(
        { ...read, title: "stale" },
        ["submitted"],
        undefined,
        read.version,
      ),
      null,
    );
    assertEquals((await store.getPatch("p-1"))!.title, "moved");
    // The cue is marked once.
    // Only over the verdict cued: a mark for another verdict writes nothing.
    assertEquals(await store.markPatchMergedCued("p-1", T2, { kind: "missed" }), false);
    assertEquals(await store.markPatchMergedCued("p-1", T2, { kind: "merged" }), true);
    assertEquals(await store.markPatchMergedCued("p-1", T2, { kind: "merged" }), false);
    assertEquals((await store.getPatch("p-1"))!.mergedCuedAt, T2);

    // The landing rule's working set: a waiting sibling of the merged generation, not yet held.
    const sibling = {
      ...(await store.getPatch("p-1"))!,
      id: "p-w",
      headSha: "def456",
      bundleKey: "r-1/cr-1/def456.bundle",
      state: "pending_approval" as const,
      forgeRef: null,
      forgeUrl: null,
      landed: null,
      mergedCuedAt: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      memoryFateReportedAt: null,
      version: 0,
      createdAt: T1,
    };
    await store.createPatch(sibling);
    assertEquals((await store.listPatchesDueLandingRule(10)).map((p) => p.id), ["p-w"]);
    // The hold and its event in one transaction: a write that loses writes no event either.
    const events = () =>
      store.listEvents("r-1").then((e) => e.filter((x) => x.kind === "patch-held"));
    const hold = { ...sibling, heldReason: HELD_REASON, updatedAt: T2 };
    const heldEvent = { runId: "r-1", at: T2, kind: "patch-held" as const, detail: "held" };
    assertEquals(
      await store.savePatchIfState(hold, ["pending_approval"], undefined, 7, [heldEvent]),
      null,
    );
    assertEquals(await events(), []);
    assertEquals(
      await store.savePatchIfState(hold, ["pending_approval"], undefined, 0, [heldEvent]),
      1,
    );
    assertEquals((await events()).map((e) => e.detail), ["held"]);
    // Held, and nothing newer: nothing left to rule. A next generation replaces it: due again.
    assertEquals(await store.listPatchesDueLandingRule(10), []);
    await store.createPatch({
      ...sibling,
      id: "p-n",
      headSha: "fed789",
      bundleKey: "r-1/cr-1/fed789.bundle",
      // Past the landing recorded above (generation 2), so nothing has ended it.
      generation: 3,
      createdAt: T2,
    });
    assertEquals((await store.listPatchesDueLandingRule(10)).map((p) => p.id), ["p-w"]);

    // Memory's acknowledgement writes only itself, and only over the verdict it was about: a
    // stale copy of the row cannot put anything back.
    await store.savePatch({ ...(await store.getPatch("p-1"))!, supersededByPatchId: "p-9" });
    await store.markPatchFateReported({ ...submitted, landed: null }, T2);
    assertEquals(
      (await store.getPatch("p-1"))!.memoryFateReportedAt,
      null,
      "about another verdict",
    );
    await store.markPatchFateReported(merged, T2);
    const acked = (await store.getPatch("p-1"))!;
    assertEquals([acked.memoryFateReportedAt, acked.supersededByPatchId], [T2, "p-9"]);

    // The live run still holds #7, through the patch it pushed there.
    assertEquals((await store.findLiveRunOnChangeRequest("cr-1", "7"))?.id, "r-1");

    // A run that ended keeps the spec it ran with; its task moves alone. The forge said nothing:
    // the base the task recorded is the best word there is.
    await store.createTask(
      { ...onPr, id: "t-2" },
      { ...live, id: "r-2", taskId: "t-2", state: "succeeded" },
    );
    const ended = await land({ taskId: "t-2", runId: "r-2" }, null);
    assert(ended.outcome.kind === "landed");
    assertEquals(ended.outcome.run, null);
    assertEquals((await store.getTask("t-2"))!.landings.repo.work.onto, "feature-a");
    assertEquals((await store.getRun("r-2"))!.workItem, live.workItem);
  } finally {
    await store.close();
  }
});

for (
  const [name, open] of [
    ["drizzle", async () => drizzleTaskStore(await makeTestDb())],
    ["memory", () => Promise.resolve(memoryTaskStore())],
  ] as const
) {
  test(`${name}: a tool's image is written claimed, capped per run by the agent's own rows`, async () => {
    const store = await open();
    try {
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createTask({ ...task, id: "t-2" }, { ...run, id: "r-2", taskId: "t-2" });
      const attachment = (id: string, runId = "r-1") => ({
        id,
        runId,
        mime: "image/png" as const,
        bytes: 8,
        sha256: "0".repeat(64),
        ref: `img-${id}`,
        source: "agent" as const,
        storageKey: `attachments/${runId}/${id}`,
        claimedBy: "tool",
        createdAt: T0,
      });
      const limits = { maxCount: 3, maxBytes: 1_000 };
      // The composer's uploads hold none of the agent's slots, nor the agent's any of theirs.
      await store.createUnclaimedAttachment({
        ...attachment("att-user"),
        source: "user",
        claimedBy: null,
      }, 20);
      assertEquals(await store.createAgentAttachment(attachment("att-0"), limits), {
        kind: "created",
      });
      // The same ref again is the row already there, whatever the new row's id.
      const same = await store.createAgentAttachment(
        { ...attachment("att-dup"), ref: "img-att-0" },
        limits,
      );
      assertEquals(same.kind === "existing" && same.attachment.id, "att-0");
      assertEquals(
        (await store.agentAttachmentsByRefs("r-1", ["img-att-0", "img-none"])).map((a) => a.id),
        ["att-0"],
      );
      assertEquals(await store.agentAttachmentsByRefs("r-2", ["img-att-0"]), []);
      const raced = await Promise.all(
        Array.from(
          { length: 10 },
          (_, i) => store.createAgentAttachment(attachment(`att-r${i}`), limits),
        ),
      );
      assertEquals(raced.filter((written) => written.kind === "created").length, 2);
      assertEquals(await store.countUnclaimedAttachments("r-1"), 1);
      const kept = (await store.getAttachment("att-0"))!;
      assertEquals([kept.source, kept.claimedBy], ["agent", "tool"]);
      // Another run's count is its own.
      assertEquals(await store.createAgentAttachment(attachment("att-x", "r-2"), limits), {
        kind: "created",
      });
      // Never swept, never taken back.
      assertEquals(
        await store.listUnclaimedAttachmentsBefore("9999", 100).then((a) => a.length),
        1,
      );
      assertEquals(await store.deleteUnclaimedAttachment("r-1", "att-0"), null);
      assertEquals(await store.agentAttachmentUsage("r-1"), { count: 3, bytes: 24 });
      assertEquals(await store.agentAttachmentUsage("r-3"), { count: 0, bytes: 0 });

      // The bytes are a budget of their own, summed under the same lock: r-2 holds 8 of 1000,
      // so of ten racing 200-byte images exactly four fit.
      const racedBytes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.createAgentAttachment(
            { ...attachment(`att-b${i}`, "r-2"), bytes: 200 },
            { maxCount: 100, maxBytes: 1_000 },
          )),
      );
      assertEquals(racedBytes.filter((written) => written.kind === "created").length, 4);
      assertEquals(await store.agentAttachmentUsage("r-2"), { count: 5, bytes: 808 });
    } finally {
      await store.close();
    }
  });
}

test("the inbox takes one seq per run, in order, and the poll's cursor acknowledges", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    await store.createTask({ ...task, id: "t-2" }, { ...run, id: "r-2", taskId: "t-2" });
    const message = (runId: string, text: string) => ({
      id: `rm-${runId}-${text}`,
      runId,
      kind: "user" as const,
      sender: { kind: "user" as const, userId: "u-1" },
      text,
      payload: null,
      attachments: [],
      createdAt: T0,
      deliveredAt: null,
    });
    // Two appends racing for one run cannot both take a seq: the row lock serializes them.
    const [a, b] = await Promise.all([
      store.appendRunMessage(message("r-1", "a")),
      store.appendRunMessage(message("r-1", "b")),
    ]);
    assertEquals(new Set([a.seq, b.seq]), new Set([0, 1]));
    // Seqs are per run: the other run starts at zero, and a system payload rides whole.
    const other = await store.appendRunMessage({
      ...message("r-2", "note"),
      kind: "system",
      sender: { kind: "platform" },
      payload: {
        kind: "patch",
        patchId: "p-1",
        path: "repo",
        line: "work",
        headSha: "abc",
        generation: 1,
        state: "merged",
        forgeUrl: null,
        reason: null,
      },
    });
    assertEquals(other.seq, 0);
    assertEquals(
      ((await store.listRunMessages("r-2"))[0].payload as PatchPayload | null)?.state,
      "merged",
    );

    const all = await store.listRunMessages("r-1");
    assertEquals(all.map((m) => m.seq), [0, 1]);
    assertEquals((await store.listRunMessages("r-1", 0)).map((m) => m.seq), [1]);
    await store.markRunMessagesDelivered("r-1", 0, T1);
    assertEquals((await store.listRunMessages("r-1")).map((m) => m.deliveredAt), [T1, null]);
    // Idempotent: a later acknowledgement never moves an earlier stamp.
    await store.markRunMessagesDelivered("r-1", 1, "2026-01-02T00:00:00.000Z");
    assertEquals((await store.listRunMessages("r-1")).map((m) => m.deliveredAt), [
      T1,
      "2026-01-02T00:00:00.000Z",
    ]);
  } finally {
    await store.close();
  }
});

test("responses round-trip, and the open one per automation and key is found by state", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    const response = {
      id: "resp-1",
      automationId: "auto-1",
      taskId: "t-1",
      runId: "r-1",
      chatroomId: "chr-1",
      state: "open" as const,
      key: "",
      title: null,
      conversation: "per-response" as const,
      alerts: 1,
      openedAt: T0,
      lastAlertAt: T0,
      lastActivityAt: T0,
      closedAt: null,
      closedReason: null,
    };
    await store.createResponse(response);
    assertEquals(await store.getResponse("resp-1"), response);
    assertEquals(await store.findOpenResponse("auto-1", ""), response);
    assertEquals(await store.findResponseByRun("r-1"), response);
    assertEquals(await store.findOpenResponse("auto-2", ""), null);
    await store.markResponseActivity("resp-1", T1, true);
    assertEquals((await store.findOpenResponse("auto-1", ""))?.state, "attended");
    await store.recordResponseAlert("resp-1", 3, T1);
    assertEquals((await store.findOpenResponse("auto-1", ""))?.alerts, 3);
    assertEquals((await store.listOpenResponses()).map((r) => r.id), ["resp-1"]);

    assertEquals(await store.closeResponse("resp-1", T1, "succeeded"), true);
    assertEquals(await store.findOpenResponse("auto-1", ""), null);
    assertEquals((await store.listOpenResponses()).length, 0);
    // Closed is closed: a second close writes nothing, and neither an activity stamp nor a
    // joining alert may bring the row back — that is the whole reason these are not full-row
    // writes read from a caller's copy.
    assertEquals(await store.closeResponse("resp-1", T2, "closed-by-user"), false);
    await store.markResponseActivity("resp-1", T2, true);
    await store.recordResponseAlert("resp-1", 9, T2);
    const settled = await store.getResponse("resp-1");
    assertEquals(settled?.state, "closed");
    assertEquals(settled?.closedAt, T1);
    assertEquals(settled?.closedReason, "succeeded");
    assertEquals(settled?.alerts, 3);
    assertEquals((await store.listResponses()).map((r) => r.id), ["resp-1"]);

    // One OPEN response per (automation, key): the index decides, and the conflict target
    // must name both columns and the predicate or Postgres refuses the statement outright.
    const keyed = (id: string, key: string) => ({
      ...response,
      id,
      key,
      title: `about ${key}`,
      openedAt: T2,
    });
    assertEquals(await store.createResponse(keyed("resp-a", "grp-a")), true);
    assertEquals(await store.createResponse(keyed("resp-a2", "grp-a")), false, "same slot");
    assertEquals(await store.createResponse(keyed("resp-b", "grp-b")), true, "another key");
    assertEquals(await store.createResponse(keyed("resp-0", "")), true, "the closed one freed it");
    assertEquals(await store.createResponse(keyed("resp-02", "")), false);
    assertEquals(
      await store.createResponse({ ...keyed("resp-x", "grp-a"), automationId: "auto-2" }),
      true,
    );
    assertEquals((await store.findOpenResponse("auto-1", "grp-a"))?.id, "resp-a");
    assertEquals((await store.findOpenResponse("auto-1", "grp-a"))?.title, "about grp-a");
    assertEquals((await store.findOpenResponse("auto-1", "grp-b"))?.id, "resp-b");
    assertEquals((await store.findOpenResponse("auto-1", ""))?.id, "resp-0");
    assertEquals(await store.findOpenResponse("auto-1", "grp-c"), null);
    await store.closeResponse("resp-a", T2, "succeeded");
    assertEquals(await store.findOpenResponse("auto-1", "grp-a"), null);
    assertEquals(
      await store.createResponse(keyed("resp-a3", "grp-a")),
      true,
      "reopens once closed",
    );
    // The previous responses are the automation's newest other SHARED ones, closed or not,
    // never one opened per-response and never another automation's — newest first, as many as
    // asked for. (Those opened in the same instant fall to the id, so the answer is stable.)
    const shared = (id: string, openedAt: string, automationId = "auto-3") => ({
      ...response,
      id,
      key: id,
      automationId,
      openedAt,
      conversation: "shared" as const,
    });
    await store.createResponse(shared("resp-s1", T0));
    await store.createResponse(shared("resp-s2", T1));
    await store.createResponse(shared("resp-s3", T2));
    await store.createResponse({ ...shared("resp-p", T2), conversation: "per-response" });
    await store.createResponse(shared("resp-other", T2, "auto-4"));
    const ids = async (except: string, limit: number) =>
      (await store.listSharedResponses("auto-3", except, limit)).map((r) => r.id);
    assertEquals(await ids("resp-s3", 5), ["resp-s2", "resp-s1"]);
    assertEquals(await ids("resp-new", 2), ["resp-s3", "resp-s2"]);
    assertEquals(await store.listSharedResponses("auto-1", "resp-b", 5), []);
  } finally {
    await store.close();
  }
});

test("forge tool actions: the cap holds under concurrent reserves, settlement is once", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  await store.createAgent(agent);
  await store.createTask(task, run);
  const action = (id: string) => ({
    id,
    runId: run.id,
    tool: "create_issue" as const,
    connectedRepoId: "cr-1",
    provider: "github" as const,
    repoRef: "acme/api",
    threadRef: null,
    state: "reserved" as const,
    url: null,
    createdThreadRef: null,
    detail: null,
    createdAt: T0,
    completedAt: null,
  });
  const verdicts = await Promise.all(
    ["fa-1", "fa-2", "fa-3", "fa-4"].map((id) => store.reserveForgeToolAction(action(id), 2)),
  );
  assertEquals(verdicts.filter(Boolean).length, 2, "exactly the cap, however the race lands");
  // A different tool counts against its own cap.
  assert(await store.reserveForgeToolAction({ ...action("fa-5"), tool: "add_comment" }, 2));

  const [first] = (await store.listForgeToolActions(run.id)).filter((a) =>
    a.tool === "create_issue"
  );
  const done = {
    state: "done" as const,
    url: "https://github.com/acme/api/issues/9",
    createdThreadRef: "9",
    detail: null,
    completedAt: T1,
  };
  assert(await store.completeForgeToolAction(first.id, run.id, done));
  assertEquals(await store.completeForgeToolAction(first.id, run.id, done), false);
  assertEquals(await store.completeForgeToolAction("fa-5", "r-other", done), false);
  const settled = (await store.listForgeToolActions(run.id)).find((a) => a.id === first.id);
  assertEquals(settled?.createdThreadRef, "9");
  assertEquals(settled?.state, "done");
});

test("the egress allowlist is one row, and absent is not empty", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  // The distinction the whole seeding rule rests on: no row means the environment still owns
  // the ceiling, an empty allowlist means an admin decided runs reach nothing. Returning `[]`
  // for the first would silently override a deployment's own configuration with nothing.
  assertEquals(await store.getEgressAllowlist(), null);

  await store.saveEgressAllowlist({
    bundles: ["npm", "deno"],
    hosts: ["internal.example.com"],
    updatedAt: T0,
    updatedBy: "u-1",
  });
  assertEquals(await store.getEgressAllowlist(), {
    bundles: ["npm", "deno"],
    hosts: ["internal.example.com"],
    updatedAt: T0,
    updatedBy: "u-1",
  });

  // A second save is an upsert onto the same row, never a second ceiling.
  await store.saveEgressAllowlist({
    bundles: [],
    hosts: [],
    updatedAt: T1,
    updatedBy: null,
  });
  const narrowed = await store.getEgressAllowlist();
  assertEquals(narrowed?.bundles, []);
  assertEquals(narrowed?.updatedBy, null);
});

test("reserved capacity is one row, read whole, and a second save replaces it", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  assertEquals(await store.getReservedCapacity(), null);

  await store.saveReservedCapacity({
    slots: { standard: 2, large: 1 },
    updatedAt: T0,
    updatedBy: "u-1",
  });
  assertEquals(await store.getReservedCapacity(), {
    slots: { standard: 2, large: 1 },
    updatedAt: T0,
    updatedBy: "u-1",
  });

  // A full replace, never a merge: a class left out of the save is no longer reserved.
  await store.saveReservedCapacity({ slots: { standard: 1 }, updatedAt: T1, updatedBy: null });
  assertEquals(await store.getReservedCapacity(), {
    slots: { standard: 1 },
    updatedAt: T1,
    updatedBy: null,
  });
});

test("patch builds: one check per patch, one delivery, and the backstop's working set", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  const environments = drizzleEnvironmentStore(handle);
  try {
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
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
    await store.createAgent(agent);
    await store.createTask(task, run);
    for (const id of ["p-1", "p-2", "p-3"]) {
      await store.createPatch({
        id,
        connectedRepoId: "cr-1",
        runId: "r-1",
        taskId: "t-1",
        setId: "ps-1",
        path: "repo",
        line: "work",
        branchName: "ryph/ada/r-1/work",
        headSha: `${id}-head`,
        bundleKey: `r-1/cr-1/${id}.bundle`,
        baseSha: null,
        generation: 1,
        title: null,
        description: null,
        commits: [],
        carries: [],
        state: "submitted",
        attempts: 1,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError: null,
        approvedBy: null,
        approvedAt: null,
        forgeRef: "7",
        forgeUrl: null,
        forgeBranch: "ryph/ada/r-1",
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
      });
    }
    await environments.createEnvironment({
      id: "env-9",
      subjectKind: "repo",
      subjectId: "cr-1",
      ref: "ryph/ada/r-1",
      defaultBranch: false,
      commits: { repo: "a".repeat(40) },
      definition: "b".repeat(40),
      baseDigest: "base",
      harnessDigest: "harness",
      image: null,
      bakedImage: null,
      machineImage: null,
      status: "queued",
      toolchains: {},
      sizeBytes: null,
      trigger: "patch",
      plan: {
        checkouts: [],
        dockerfileFrom: "repo",
        cacheScope: { read: ["repo-cr-1"], write: null },
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
    const built = {
      patchId: "p-1",
      runId: "r-1",
      environmentId: "env-9",
      branch: "ryph/ada/r-1",
      note: null,
      checkedAt: T1,
      claimedUntil: null,
      reportedAt: null,
    };
    const skipped = {
      ...built,
      patchId: "p-2",
      environmentId: null,
      note: "its .ryph/ is the same as main's",
      checkedAt: T2,
      reportedAt: T2,
    };
    // The backstop's anti-join: submitted patches with no row yet, since a cutoff.
    assertEquals(
      (await environments.listUncheckedPatches(T0, 10)).map((p) => p.id),
      ["p-1", "p-2", "p-3"],
    );
    assertEquals(await environments.listUncheckedPatches(T1, 10), [], "older than the window");
    assertEquals((await environments.listUncheckedPatches(T0, 1)).length, 1);
    assertEquals(await environments.createPatchBuild(built), true);
    assertEquals(
      await environments.createPatchBuild({ ...built, environmentId: null }),
      false,
      "a second check of the same patch does not land",
    );
    assertEquals(await environments.createPatchBuild(skipped), true);
    assertEquals(await environments.getPatchBuild("p-1"), built);
    assertEquals(await environments.getPatchBuild("p-nope"), null);
    assertEquals(
      (await environments.listPatchBuildsForRun("r-1")).map((b) => b.patchId),
      ["p-1", "p-2"],
    );
    assertEquals(await environments.listPatchBuildsForEnvironment("env-9"), [built]);
    // Only a build asked for and not yet told is the backstop's business.
    assertEquals(await environments.listUnreportedPatchBuilds(), [built]);

    assertEquals(await environments.markPatchBuildReported("p-1", T2), true);
    assertEquals(await environments.markPatchBuildReported("p-1", T2), false, "told once");
    assertEquals(await environments.listUnreportedPatchBuilds(), []);
    assertEquals((await environments.getPatchBuild("p-1"))!.reportedAt, T2);
    assertEquals((await environments.listUncheckedPatches(T0, 10)).map((p) => p.id), ["p-3"]);

    // A claimed check: unresolved, leased, and only the lease holder writes it.
    const claim = {
      patchId: "p-3",
      runId: "r-1",
      environmentId: null,
      branch: null,
      note: null,
      checkedAt: T1,
      claimedUntil: T2,
      reportedAt: null,
    };
    assertEquals(await environments.createPatchBuild(claim), true);
    assertEquals(await environments.listUncheckedPatches(T0, 10), []);
    assertEquals(await environments.listUnreportedPatchBuilds(), [claim], "unresolved is due");
    const retaken = { ...claim, claimedUntil: "2026-01-01T03:00:00.000Z" };
    assertEquals(await environments.updatePatchBuildIfClaimed(retaken, T1), false, "not its lease");
    assertEquals(await environments.updatePatchBuildIfClaimed(retaken, T2), true);
    assertEquals(await environments.updatePatchBuildIfClaimed(retaken, T2), false, "taken once");
    const resolved = { ...retaken, environmentId: "env-9", branch: "b", claimedUntil: null };
    assertEquals(
      await environments.updatePatchBuildIfClaimed(resolved, retaken.claimedUntil),
      true,
    );
    assertEquals(await environments.getPatchBuild("p-3"), resolved);
    assertEquals(
      await environments.updatePatchBuildIfClaimed({ ...resolved, note: "x" }, "anything"),
      false,
      "a resolved check is never written again",
    );

    // The task's purpose rides its own column.
    assertEquals((await store.getTask("t-1"))!.purpose, "environment-setup");
  } finally {
    await handle.close();
  }
});

test("patches and responses list under a scope that reads the tasks table", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
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
    await store.createAgent(agent);
    const owned: Task = {
      ...task,
      requestedByUserId: "u-ada",
      repos: [{ ...task.repos[0], connectedRepoId: "cr-1" }],
    };
    await store.createTask(owned, run);
    await store.createPatch({
      id: "p-1",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "ps-1",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "r-1/cr-1/abc123.bundle",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
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
      heldReason: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      version: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await store.createResponse({
      id: "resp-1",
      automationId: "auto-1",
      taskId: "t-1",
      runId: "r-1",
      chatroomId: "chr-1",
      state: "open",
      key: "",
      title: null,
      conversation: "per-response" as const,
      alerts: 1,
      openedAt: T0,
      lastAlertAt: T0,
      lastActivityAt: T0,
      closedAt: null,
      closedReason: null,
    });

    const ada = { kind: "principal" as const, userId: "u-ada", writableRepoIds: [] };
    const bob = { kind: "principal" as const, userId: "u-bob", writableRepoIds: [] };
    const bobWriter = { ...bob, writableRepoIds: ["cr-1"] };
    assertEquals((await store.listPatches({ scope: ada })).patches.map((p) => p.id), ["p-1"]);
    assertEquals((await store.listPatches({ scope: bob })).patches.length, 0);
    assertEquals((await store.listPatches({ scope: bobWriter })).patches.map((p) => p.id), ["p-1"]);
    assertEquals((await store.listResponses(50, ada)).map((r) => r.id), ["resp-1"]);
    assertEquals((await store.listResponses(50, bob)).length, 0);
    assertEquals((await store.listResponses(50, bobWriter)).map((r) => r.id), ["resp-1"]);
  } finally {
    await store.close();
  }
});

test("a run remembers the chat thread it answers; the room's recent starts are counted", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    const chatRun: Run = { ...run, originChatroomId: "chr-1", originThreadKey: "1001" };
    await store.createTask({ ...task, origin: "chat", targetChangeRequest: null }, chatRun);
    assertEquals(await store.getRun("r-1"), chatRun);
    assertEquals((await store.getTask("t-1"))!.origin, "chat");

    const at = (chatroomId: string, threadKey: string) =>
      store.findLiveRunByOrigin({ kind: "chat", chatroomId, threadKey });
    assertEquals(await at("chr-1", "1001"), chatRun);
    assertEquals(await at("chr-1", "1002"), null);
    assertEquals(await at("chr-2", "1001"), null);

    // Counted from `since`, inclusive, whatever became of the run.
    assertEquals(await store.countRunsStartedFromChatroom("chr-1", T0), 1);
    assertEquals(await store.countRunsStartedFromChatroom("chr-1", T1), 0);
    assertEquals(await store.countRunsStartedFromChatroom("chr-2", T0), 0);

    await store.saveRunResult({ ...chatRun, state: "succeeded", updatedAt: T1 });
    assertEquals(await at("chr-1", "1001"), null);
    assertEquals(await store.countRunsStartedFromChatroom("chr-1", T0), 1);
  } finally {
    await store.close();
  }
});

test("command rooms: saved whole, channels replaced as a unit, deleted with their rows", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    assertEquals(await store.getCommandRoom("chr-1"), null);
    const room = {
      chatroomId: "chr-1",
      ownerUserId: "u-1",
      agentIds: ["a-1"],
      defaultAgentId: "a-1",
      defaultTarget: { kind: "workspace" as const, workspaceId: "ws-1" },
      commanders: { kind: "group" as const, groupId: "31" },
      startsPerHour: 5,
      channels: [
        {
          channelId: "20",
          channelName: "desktop",
          target: { kind: "repo" as const, connectedRepoId: "cr-1", ref: null },
          createdAt: T0,
          updatedAt: T0,
        },
        {
          channelId: "7",
          channelName: "bugs",
          target: { kind: "repo" as const, connectedRepoId: "cr-2", ref: "develop" },
          createdAt: T0,
          updatedAt: T0,
        },
      ],
      createdAt: T0,
      updatedAt: T0,
    };
    await store.saveCommandRoom(room);
    const read = await store.getCommandRoom("chr-1");
    // Channels come back in name order — what an admin's form lists.
    assertEquals(read, { ...room, channels: [room.channels[1], room.channels[0]] });

    await store.saveCommandRoom({
      ...room,
      createdAt: T1,
      updatedAt: T1,
      commanders: { kind: "room" },
      defaultTarget: null,
      channels: [room.channels[0]],
    });
    const resaved = (await store.getCommandRoom("chr-1"))!;
    assertEquals(resaved.createdAt, T0, "first saved stays first saved");
    assertEquals(resaved.updatedAt, T1);
    assertEquals(resaved.commanders, { kind: "room" });
    assertEquals(resaved.defaultTarget, null);
    assertEquals(resaved.channels, [room.channels[0]]);

    assertEquals(await store.deleteCommandRoom("chr-1"), true);
    assertEquals(await store.deleteCommandRoom("chr-1"), false);
    assertEquals(await store.getCommandRoom("chr-1"), null);
    // Re-saving after a delete finds no orphaned channel rows in its way.
    await store.saveCommandRoom(room);
    assertEquals((await store.getCommandRoom("chr-1"))!.channels.length, 2);
  } finally {
    await store.close();
  }
});

test("chat mentions: one winner per (room, message), a stale claim adopted, a verdict final", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    const record = {
      chatroomId: "chr-1",
      messageId: "1001",
      outcome: "processing" as const,
      taskId: null,
      receivedAt: T0,
      createdAt: T0,
      claimedAt: T0,
    };
    assertEquals(await store.claimChatMention(record), true);
    assertEquals(await store.claimChatMention(record), false);
    // The same message id in another room is another mention.
    assertEquals(await store.claimChatMention({ ...record, chatroomId: "chr-2" }), true);

    // A fresh claim is not adopted; a stale one is, once.
    assertEquals(await store.claimChatMention({ ...record, claimedAt: T1 }, T0), false);
    assertEquals(await store.claimChatMention({ ...record, claimedAt: T2 }, T1), true);
    assertEquals(await store.claimChatMention({ ...record, claimedAt: T2 }, T1), false);

    // A verdict is final: a later record does not overwrite it, and it is never adopted.
    await store.recordChatMention({ ...record, outcome: "started", taskId: "t-1" });
    await store.recordChatMention({ ...record, outcome: "refused", taskId: null });
    assertEquals(
      await store.claimChatMention({ ...record, claimedAt: "2026-01-02T00:00:00.000Z" }, T2),
      false,
    );
  } finally {
    await store.close();
  }
});

test("createTask refuses `full` at the live-run cap and inserts nothing; concurrent creators admit one", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    assertEquals(await store.createTask(task, run, undefined, { maxLive: 2 }), "created");
    const second = { ...task, id: "t-2" };
    const third = { ...task, id: "t-3" };
    // Two creators at the cap minus one: the lock serializes them, and exactly one lands.
    const verdicts = await Promise.all([
      store.createTask(second, { ...run, id: "r-2", taskId: "t-2", tokenHash: "h2" }, undefined, {
        maxLive: 2,
      }),
      store.createTask(third, { ...run, id: "r-3", taskId: "t-3", tokenHash: "h3" }, undefined, {
        maxLive: 2,
      }),
    ]);
    assertEquals(verdicts.toSorted(), ["created", "full"]);
    assertEquals((await store.listActiveRuns()).length, 2);
    // A finished run frees its slot; no cap admits anything.
    const [live] = await store.listActiveRuns();
    await store.saveRunResult({ ...live, state: "succeeded" });
    assertEquals(
      await store.createTask(
        { ...task, id: "t-4" },
        { ...run, id: "r-4", taskId: "t-4", tokenHash: "h4" },
        undefined,
        { maxLive: 2 },
      ),
      "created",
    );
    assertEquals(
      await store.createTask(
        { ...task, id: "t-5" },
        { ...run, id: "r-5", taskId: "t-5", tokenHash: "h5" },
        undefined,
        { maxLive: null },
      ),
      "created",
    );
  } finally {
    await store.close();
  }
});

test("saveHeartbeat writes a beat's columns only, and only onto a live run a newer beat has not passed", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    const beat = (seq: number, at: string): Run => ({
      ...run,
      state: "running",
      phase: "running",
      heartbeatSeq: seq,
      lastHeartbeatAt: at,
      updatedAt: at,
    });

    // The first beat lands, and the task's copy of its current attempt moves with it.
    assertEquals(await store.saveHeartbeat(beat(0, T1)), { desiredState: null });
    const stored = await store.getRun("r-1");
    assertEquals([stored?.state, stored?.phase, stored?.heartbeatSeq], ["running", "running", 0]);
    const [row] = (await store.listTasks()).tasks;
    assertEquals(row.currentRun, {
      id: "r-1",
      state: "running",
      phase: "running",
      idleState: null,
      declaredOutcome: null,
    });
    assertEquals(row.lastActivityAt, T1);

    // A cancel requested after the handler read the run survives the beat — only the beat's
    // columns are written, never the stale copy of the rest — and the beat's answer carries it.
    await store.requestRunCancel(run.id, T1);
    assertEquals(await store.saveHeartbeat(beat(1, T2)), { desiredState: "cancelled" });
    assertEquals((await store.getRun("r-1"))?.desiredState, "cancelled");

    // The outcome the agent declared is written as applyHeartbeat left it: named, still in
    // progress, cleared (a message reached the agent), named again. That the agent finished
    // stands for good.
    const before = (await store.getRun("r-1"))!;
    await store.saveHeartbeat({ ...beat(4, T2), declaredOutcome: "success" });
    assertEquals((await store.getRun("r-1"))?.declaredOutcome, "success");
    await store.saveHeartbeat({ ...beat(5, T2), declaredOutcome: "in-progress" });
    assertEquals((await store.getRun("r-1"))?.declaredOutcome, "in-progress");
    await store.saveHeartbeat({ ...beat(6, T2), declaredOutcome: null, agentFinished: true });
    assertEquals((await store.getRun("r-1"))?.declaredOutcome, null);
    await store.saveHeartbeat({
      ...beat(7, T2),
      declaredOutcome: "no-changes",
      agentFinished: false,
    });
    assertEquals((await store.getRun("r-1"))?.declaredOutcome, "no-changes");
    assertEquals((await store.getRun("r-1"))?.agentFinished, true);
    // A lifecycle transition from before the newer beats is refused, taking neither back.
    assertEquals(await store.saveRunTransition({ ...before, updatedAt: T2 }, before), null);
    assertEquals((await store.getRun("r-1"))?.declaredOutcome, "no-changes");
    assertEquals((await store.getRun("r-1"))?.agentFinished, true);

    // A reordered beat is refused rather than rolling the gauge back.
    assertEquals(await store.saveHeartbeat(beat(1, T2)), null);
    assertEquals(await store.saveHeartbeat(beat(0, T2)), null);

    // A run concluded between the read and the write stays concluded.
    await store.saveRunResult({
      ...(await store.getRun("r-1"))!,
      state: "succeeded",
      updatedAt: T2,
    });
    assertEquals(await store.saveHeartbeat(beat(8, T2)), null);
    assertEquals((await store.getRun("r-1"))?.state, "succeeded");
    assertEquals((await store.listTasks()).tasks[0].currentRun?.state, "succeeded");
  } finally {
    await store.close();
  }
});

test("a re-target never puts back another repo a landing moved meanwhile", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.createAgent(agent);
    const web = { ...task.repos[0], connectedRepoId: "cr-2", path: "web", name: "example/web" };
    const two: Task = { ...task, repos: [{ ...task.repos[0], connectedRepoId: "cr-1" }, web] };
    const live: Run = {
      ...run,
      state: "running",
      workItem: { ...run.workItem, repos: [{ ...run.workItem.repos[0] }, { ...web }] },
    };
    await store.createTask(two, live);
    // What the re-target route read before its forge round trip...
    const stale = (await store.getTask("t-1"))!;
    assertEquals(stale.repos[1].ref, "main");
    // ...and, during it, a merge of web's own pull request lands web onto `release`.
    const landed = await store.landMerge({
      patch: {
        id: "p-none",
        taskId: "t-1",
        runId: "r-1",
        connectedRepoId: "cr-2",
        path: "web",
        line: "work",
        forgeRef: "5",
        generation: 1,
      },
      mergedInto: "release",
      defaultBranch: "main",
      at: T1,
    });
    assertEquals(landed.outcome.kind, "landed");
    await store.applyRetarget({
      taskId: "t-1",
      runId: "r-1",
      path: "repo",
      connectedRepoId: "cr-1",
      thread: "9",
      headRef: "feat/scheduler",
      headSha: "a".repeat(40),
      targetRef: "main",
      at: T2,
    });
    const after = (await store.getTask("t-1"))!;
    assertEquals(after.repos.map((r) => r.ref), ["feat/scheduler", "release"]);
    assertEquals((await store.getRun("r-1"))!.workItem.repos.map((r) => r.ref), [
      "feat/scheduler",
      "release",
    ]);
  } finally {
    await store.close();
  }
});

test("the reconcile's SQL and landedVerdict agree, patch for patch", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
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
    await store.createAgent(agent);
    const states = [
      "pending_approval",
      "queued",
      "submitting",
      "submitted",
      "failed",
      "rejected",
      "superseded",
    ] as const;
    // A seeded generator: the same sets every run, many shapes of them.
    let seed = 172;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const all: Patch[] = [];
    const landings = new Map<string, Task["landings"]>();
    for (let t = 0; t < 40; t++) {
      const taskId = `t-${t}`;
      // Two runs of the task (as a resume starts a second), each with its own `fix-a` line:
      // unrelated work under one name, whose landings SQL and the rule must keep apart.
      const runIds = [`r-${t}`, `r-${t}-b`];
      const landingAt = (thread: string) => ({
        connectedRepoId: "cr-1",
        thread,
        onto: "main",
        generation: 1,
        moved: false,
        at: T1,
      });
      // Some tasks with a landing at the first generation of `repo`, of the default line and of
      // either run's `fix-a`, each drawn on its own.
      const atRepo: Task["landings"][string] = {
        ...(rand(4) === 0 ? { work: landingAt("7") } : {}),
        ...Object.fromEntries(
          runIds.filter(() => rand(3) === 0).map((r) => [
            `${r}/fix-a`,
            { ...landingAt("8"), runId: r },
          ]),
        ),
      };
      const landed: Task["landings"] = Object.keys(atRepo).length === 0 ? {} : { repo: atRepo };
      landings.set(taskId, landed);
      await store.createTask({ ...task, id: taskId, landings: landed }, {
        ...run,
        id: runIds[0],
        taskId,
      });
      await store.saveRun({
        ...run,
        id: runIds[1],
        taskId,
        branchNamespace: `ryph/ada/${runIds[1]}`,
      });
      const count = 2 + rand(5);
      for (let i = 0; i < count; i++) {
        const runId = runIds[rand(2)];
        const state = states[rand(states.length)];
        const merged = state === "submitted" && rand(2) === 0;
        const p: Patch = {
          id: `p-${t}-${i}`,
          connectedRepoId: "cr-1",
          runId,
          taskId,
          setId: `s-${t}-${i}`,
          path: rand(5) === 0 ? "web" : "repo",
          // Two lines of the repo too, outside the seeded draws: SQL and the rule must agree that
          // one line never judges the other.
          line: (t + i) % 4 === 3 ? "fix-a" : "work",
          branchName: "ryph/ada/r/work",
          headSha: `${t}-${i}`.padEnd(12, "0"),
          bundleKey: `b-${t}-${i}`,
          baseSha: null,
          generation: 1 + rand(2),
          title: null,
          description: null,
          commits: [],
          carries: [],
          state,
          attempts: 0,
          nextAttemptAt: state === "failed" && rand(2) === 0 ? T2 : null,
          leaseExpiresAt: null,
          lastError: null,
          approvedBy: null,
          approvedAt: null,
          forgeRef: state === "submitted" ? "7" : null,
          forgeUrl: null,
          forgeBranch: null,
          diffRef: null,
          landed: merged
            ? rand(3) === 0 ? { kind: "missed", at: T1 } : { kind: "merged", at: T1 }
            : state === "submitted" && rand(2) === 0
            ? { kind: "closed", at: T1 }
            : null,
          supersededByPatchId: null,
          hookCheck: null,
          approvedHookPaths: [],
          memoryFateReportedAt: null,
          mergedCuedAt: null,
          mergedCueClaimedAt: null,
          landingAskedAt: null,
          // A landing hold, a review hold (never a landing hold), or none.
          heldReason: [HELD_REASON, unrebasedReason("main"), overlapReason(["b"]), null, null][
            rand(5)
          ],
          version: 0,
          // Ties included: the order is by text, the same in both.
          createdAt: `2026-01-01T00:00:0${rand(6)}.000Z`,
          updatedAt: T0,
        };
        await store.createPatch(p);
        all.push(p);
      }
    }
    // And one task drawn by hand: run A's `fix-a` landed, and each run has a `fix-a` patch of
    // that generation waiting. Only A's is ruled: B's line merely shares the name.
    {
      const taskId = "t-two-runs";
      const [a, b] = ["r-two-a", "r-two-b"];
      const landed: Task["landings"] = {
        repo: {
          [`${a}/fix-a`]: {
            connectedRepoId: "cr-1",
            thread: "8",
            onto: "main",
            generation: 1,
            moved: false,
            at: T1,
            runId: a,
          },
        },
      };
      landings.set(taskId, landed);
      await store.createTask({ ...task, id: taskId, landings: landed }, { ...run, id: a, taskId });
      await store.saveRun({ ...run, id: b, taskId, branchNamespace: `ryph/ada/${b}` });
      for (const runId of [a, b]) {
        const p: Patch = {
          ...all[0],
          id: `p-two-${runId}`,
          runId,
          taskId,
          setId: `s-two-${runId}`,
          path: "repo",
          line: "fix-a",
          headSha: `two-${runId}`.padEnd(12, "0"),
          bundleKey: `b-two-${runId}`,
          generation: 1,
          state: "queued",
          nextAttemptAt: null,
          forgeRef: null,
          landed: null,
          heldReason: null,
        };
        await store.createPatch(p);
        all.push(p);
      }
    }
    const expected = all
      .filter((p) =>
        p.state !== "submitting" &&
        landedVerdict(p, all.filter((q) => q.taskId === p.taskId), landings.get(p.taskId)).kind !==
          "none"
      )
      .map((p) => p.id)
      .toSorted();
    const got = (await store.listPatchesDueLandingRule(1_000)).map((p) => p.id).toSorted();
    assert(expected.length > 5, `a matrix with something to rule (${expected.length})`);
    assert(expected.includes("p-two-r-two-a"), "a run's `fix-a` is ruled by its own landing");
    assert(!expected.includes("p-two-r-two-b"), "and never by another run's `fix-a` landing");
    assert(
      all.some((p) => expected.includes(p.id) && p.heldReason === overlapReason(["b"])),
      "a review hold among what is ruled",
    );
    assertEquals(got, expected);
  } finally {
    await store.close();
  }
});

test("a re-target asks its refusals again over the locked rows", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    for (const id of ["cr-1", "cr-2"]) {
      await store.createConnectedRepo({
        id,
        provider: "github",
        installationId: "12345",
        repoRef: `acme/${id}`,
        url: `https://github.com/acme/${id}.git`,
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
    }
    await store.createAgent(agent);
    await store.createTask(
      {
        ...task,
        repos: [{ ...task.repos[0], connectedRepoId: "cr-1" }],
        targetChangeRequest: null,
      },
      { ...run, state: "running" },
    );
    const args = {
      taskId: "t-1",
      runId: "r-1",
      path: "repo",
      connectedRepoId: "cr-1",
      thread: "9",
      headRef: "feat/x",
      headSha: "a".repeat(40),
      targetRef: "main",
      at: T1,
    };
    // A patch for the repo was born after the route's own check, during the forge round trip.
    await store.createPatch({
      id: "p-late",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "s-late",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "b",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
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
      createdAt: T1,
      updatedAt: T1,
    });
    const before = (await store.getTask("t-1"))!;
    assertEquals(await store.applyRetarget(args), { kind: "refused", why: "shipped" });
    assertEquals(await store.getTask("t-1"), before, "nothing written");
    // Another repo's change request is targeted meanwhile: one per run.
    await store.applyRetarget({ ...args, connectedRepoId: "cr-2", path: "repo", thread: "3" })
      .then((r) => assert(r !== null && !("kind" in r), JSON.stringify(r)));
    assertEquals(await store.applyRetarget({ ...args, connectedRepoId: "cr-9" }), {
      kind: "refused",
      why: "other-change-request",
    });
  } finally {
    await store.close();
  }
});

test("a transaction the database broke as a deadlock is run again, at most three times", async () => {
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const wrapped = Object.assign(new Error("query failed"), { cause: deadlock });
  let calls = 0;
  assertEquals(
    await retryOnDeadlock(() => {
      calls++;
      return calls < 3 ? Promise.reject(calls === 1 ? deadlock : wrapped) : Promise.resolve("ok");
    }),
    "ok",
  );
  assertEquals(calls, 3);
  calls = 0;
  await assertRejects(() => retryOnDeadlock(() => (calls++, Promise.reject(deadlock))));
  assertEquals(calls, 3);
  calls = 0;
  await assertRejects(() => retryOnDeadlock(() => (calls++, Promise.reject(new Error("other")))));
  assertEquals(calls, 1);
});

for (
  const [name, open] of [
    ["drizzle", async () => drizzleTaskStore(await makeTestDb())],
    ["memory", () => Promise.resolve(memoryTaskStore())],
  ] as const
) {
  test(`${name}: a merge no branch can be recorded for lets the change request go, with its event, and lands nothing`, async () => {
    const store = await open();
    try {
      await store.createAgent(agent);
      const worked: Task = {
        ...task,
        repos: [{ ...task.repos[0], connectedRepoId: "cr-1", ref: "refs/heads/pull/7/head" }],
        targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
      };
      await store.createTask(worked, { ...run, state: "running" });
      const { outcome } = await store.landMerge({
        patch: {
          id: "p-none",
          taskId: "t-1",
          runId: "r-1",
          connectedRepoId: "cr-1",
          path: "repo",
          line: "work",
          forgeRef: "7",
          generation: 1,
        },
        mergedInto: "pull/7/head",
        defaultBranch: "HEAD",
        at: T1,
      });
      assertEquals(outcome.kind, "released");
      const after = (await store.getTask("t-1"))!;
      assertEquals(after.targetChangeRequest, null);
      assertEquals(after.landings, {});
      assertEquals(after.repos, worked.repos);
      const events = (await store.listEvents("r-1")).filter((e) => e.kind === "merge-landed");
      assertEquals(events.length, 1);
      assert(events[0].detail!.includes("no longer targets it"));
      // Said once: the task no longer targets it, so a redelivery lands and says nothing.
      const again = await store.landMerge({
        patch: {
          id: "p-none",
          taskId: "t-1",
          runId: "r-1",
          connectedRepoId: "cr-1",
          path: "repo",
          line: "work",
          forgeRef: "7",
          generation: 1,
        },
        mergedInto: "pull/7/head",
        defaultBranch: "HEAD",
        at: T2,
      });
      assertEquals(again.outcome.kind, "none");
    } finally {
      await store.close();
    }
  });
}

for (
  const [name, open] of [
    ["drizzle", async () => drizzleTaskStore(await makeTestDb())],
    ["memory", () => Promise.resolve(memoryTaskStore())],
  ] as const
) {
  test(`${name}: a merged patch's landing is owed until the store answers it, released and nothing to land included`, async () => {
    const store = await open();
    try {
      await store.createAgent(agent);
      await store.saveInstallation({
        id: "gi-1",
        installationId: "12345",
        accountLogin: "acme",
        createdAt: T0,
      });
      await store.createConnectedRepo({
        id: "cr-1",
        provider: "github",
        installationId: "12345",
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
      // The task works #7, and no branch passes the rules: its landing is a release.
      await store.createTask({
        ...task,
        repos: [{ ...task.repos[0], connectedRepoId: "cr-1", ref: "refs/heads/pull/7/head" }],
        targetChangeRequest: { connectedRepoId: "cr-1", thread: "7" },
      }, { ...run, state: "running" });
      const T3 = "2026-01-01T03:00:00.000Z";
      const row = (id: string, over: Partial<Patch>): Patch => ({
        id,
        connectedRepoId: "cr-1",
        runId: "r-1",
        taskId: "t-1",
        setId: `s-${id}`,
        path: "repo",
        line: "work",
        branchName: "ryph/ada/r-1/work",
        headSha: id.padEnd(40, "0"),
        bundleKey: "b",
        baseSha: null,
        generation: 1,
        title: null,
        description: null,
        commits: [],
        carries: [],
        state: "submitted",
        attempts: 1,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError: null,
        approvedBy: null,
        approvedAt: null,
        forgeRef: "7",
        forgeUrl: null,
        forgeBranch: null,
        diffRef: null,
        landed: { kind: "merged", at: T1, mergedInto: "pull/7/head" },
        supersededByPatchId: null,
        hookCheck: null,
        approvedHookPaths: [],
        memoryFateReportedAt: null,
        mergedCuedAt: null,
        mergedCueClaimedAt: null,
        landingAskedAt: null,
        heldReason: null,
        version: 0,
        createdAt: T1,
        updatedAt: T1,
        ...over,
      });
      await store.createPatch(row("p-owed", {}));
      // Settled later, on another path the task's checkout does not hold.
      await store.createPatch(row("p-young", {
        path: "gone",
        landed: { kind: "merged", at: T2 },
        createdAt: T2,
      }));
      await store.createPatch(row("p-asked", { landingAskedAt: T1 }));
      await store.createPatch(row("p-closed", { landed: { kind: "closed", at: T1 } }));
      await store.createPatch(row("p-open", { landed: null, forgeRef: "8" }));
      const owed = async (before: string) =>
        (await store.listPatchesAwaitingLanding(10, before)).map((p) => p.id);
      // Only the merged and unanswered, settled before the cut, oldest first.
      assertEquals(await owed(T2), ["p-owed"]);
      assertEquals(await owed(T3), ["p-owed", "p-young"]);
      assertEquals((await store.listPatchesAwaitingLanding(1, T3)).map((p) => p.id), ["p-owed"]);
      // Released: the change request is let go and nothing is recorded, but it is answered.
      const released = await store.landMerge({
        patch: row("p-owed", {}),
        mergedInto: "pull/7/head",
        defaultBranch: "HEAD",
        at: T2,
      });
      assertEquals(released.outcome.kind, "released");
      assertEquals((await store.getPatch("p-owed"))!.landingAskedAt, T2);
      // Nothing to land (the path is not in the checkout): answered too.
      const none = await store.landMerge({
        patch: row("p-young", { path: "gone" }),
        mergedInto: undefined,
        defaultBranch: "main",
        at: T3,
      });
      assertEquals(none.outcome.kind, "none");
      assertEquals(await owed(T3), []);
      // A repeat keeps the first answer.
      await store.landMerge({
        patch: row("p-owed", {}),
        mergedInto: "pull/7/head",
        defaultBranch: "HEAD",
        at: T3,
      });
      assertEquals((await store.getPatch("p-owed"))!.landingAskedAt, T2);
      // A landing asked of a patch still open marks nothing.
      await store.landMerge({
        patch: row("p-open", {}),
        mergedInto: undefined,
        defaultBranch: "main",
        at: T3,
      });
      assertEquals((await store.getPatch("p-open"))!.landingAskedAt, null);

      // The settle writes whether a landing is owed: a merge's verdict owes one, merged or
      // missed; and a whole-row write of the patch never changes it.
      const open8 = (await store.getPatch("p-open"))!;
      const heard = settlePatch(open8, "merged", T3, { mergedInto: "main" });
      assert(heard.kind === "applied");
      assertEquals(await store.settlePatchIf(heard.patch, null, heard.events), true);
      const settled = (await store.getPatch("p-open"))!;
      assertEquals([settled.landed, settled.landingAskedAt], [
        { kind: "merged", at: T3, mergedInto: "main" },
        null,
      ]);
      assertEquals(await owed("2027-01-01T00:00:00.000Z"), ["p-open"]);
      assert(
        await store.savePatchIfState({ ...settled, landingAskedAt: T3 }, ["submitted"]) !== null,
      );
      assertEquals((await store.getPatch("p-open"))!.landingAskedAt, null);
      await store.createPatch(row("p-late", { landed: null, forgeRef: "9" }));
      const late = settlePatch((await store.getPatch("p-late"))!, "missed", T3, {
        mergedInto: "main",
      });
      assert(late.kind === "applied");
      assertEquals(await store.settlePatchIf(late.patch, null, late.events), true);
      assertEquals((await store.getPatch("p-late"))!.landingAskedAt, null);
      assertEquals((await owed("2027-01-01T00:00:00.000Z")).toSorted(), ["p-late", "p-open"]);
    } finally {
      await store.close();
    }
  });
}

test("the cue outbox counts a landing only for the patch's own repo", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await store.createAgent(agent);
    await store.createTask(
      { ...task, repos: [{ ...task.repos[0], connectedRepoId: "cr-1" }] },
      { ...run, state: "running" },
    );
    await store.saveInstallation({
      id: "gi-1",
      installationId: "12345",
      accountLogin: "acme",
      createdAt: T0,
    });
    await store.createConnectedRepo({
      id: "cr-1",
      provider: "github",
      installationId: "12345",
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
    await store.createPatch({
      id: "p-m",
      connectedRepoId: "cr-1",
      runId: "r-1",
      taskId: "t-1",
      setId: "s-m",
      path: "repo",
      line: "work",
      branchName: "ryph/ada/r-1/work",
      headSha: "abc123",
      bundleKey: "b",
      baseSha: null,
      generation: 1,
      title: null,
      description: null,
      commits: [],
      carries: [],
      state: "submitted",
      attempts: 1,
      nextAttemptAt: null,
      leaseExpiresAt: null,
      lastError: null,
      approvedBy: null,
      approvedAt: null,
      forgeRef: "7",
      forgeUrl: null,
      forgeBranch: null,
      diffRef: null,
      landed: { kind: "merged", at: T1 },
      supersededByPatchId: null,
      hookCheck: null,
      approvedHookPaths: [],
      memoryFateReportedAt: null,
      mergedCuedAt: null,
      mergedCueClaimedAt: null,
      landingAskedAt: null,
      heldReason: null,
      version: 0,
      createdAt: T1,
      updatedAt: T1,
    });
    const landing = (connectedRepoId: string) =>
      JSON.stringify({
        repo: {
          work: { connectedRepoId, thread: "7", onto: "main", generation: 1, moved: true, at: T1 },
        },
      });
    const owed = async () =>
      (await store.listPatchesAwaitingMergedCue(10, "2000-01-01T00:00:00.000Z")).map((p) => p.id);
    // Same path, another repo: not this patch's landing.
    await handle.db.execute(
      sql`update tasks set landings = ${landing("cr-2")}::jsonb where id = 't-1'`,
    );
    assertEquals(await owed(), []);
    await handle.db.execute(
      sql`update tasks set landings = ${landing("cr-1")}::jsonb where id = 't-1'`,
    );
    assertEquals(await owed(), ["p-m"]);
    // A merge record of its change request that waits on a settle against every head holds its
    // patches back from both backstops: that settle lands and cues them.
    const landingOwed = async () =>
      (await store.listPatchesAwaitingLanding(10, T2)).map((p) => p.id);
    assertEquals(await landingOwed(), ["p-m"]);
    const merge = await store.recordChangeRequestMerge({
      connectedRepoId: "cr-1",
      forgeRef: "7",
      mergedInto: "main",
      heads: ["f".repeat(40)],
      at: T1,
    });
    assertEquals(merge.settledAt, null);
    assertEquals(await owed(), []);
    assertEquals(await landingOwed(), []);
    assertEquals(
      await store.stampChangeRequestMerge("cr-1", "7", merge, {
        settledAt: T2,
        attempts: 0,
        nextAskAt: null,
      }),
      true,
    );
    assertEquals(await owed(), ["p-m"]);
    assertEquals(await landingOwed(), ["p-m"]);

    // Another line's landing is kept under its run (`landingKey`): a later run's line of the same
    // name, landed, owes this run's patch of it nothing.
    const fixPatch = (await store.getPatch("p-m"))!;
    await store.createPatch({
      ...fixPatch,
      id: "p-f",
      setId: "s-f",
      line: "fix-a",
      branchName: "ryph/ada/r-1/fix-a",
      headSha: "def456",
      forgeRef: "8",
      mergedCuedAt: null,
      version: 0,
    });
    await store.markPatchMergedCued("p-m", T2, { kind: "merged" });
    const lineLanding = (key: string, runId: string) =>
      JSON.stringify({
        repo: {
          [key]: {
            connectedRepoId: "cr-1",
            thread: "8",
            onto: "main",
            generation: 1,
            moved: false,
            at: T1,
            runId,
          },
        },
      });
    await handle.db.execute(
      sql`update tasks set landings = ${
        lineLanding("r-later/fix-a", "r-later")
      }::jsonb where id = 't-1'`,
    );
    assertEquals(await owed(), []);
    await handle.db.execute(
      sql`update tasks set landings = ${lineLanding("r-1/fix-a", "r-1")}::jsonb where id = 't-1'`,
    );
    assertEquals(await owed(), ["p-f"]);
  } finally {
    await store.close();
  }
});

for (
  const [name, open] of [
    ["drizzle", async () => drizzleTaskStore(await makeTestDb())],
    ["memory", () => Promise.resolve(memoryTaskStore())],
  ] as const
) {
  test(`${name}: the cue outbox marks the cues of runs that are over, oldest first, and never a live run's`, async () => {
    const store = await open();
    try {
      await store.createAgent(agent);
      await store.createTask(task, { ...run, state: "running" });
      await store.createTask({ ...task, id: "t-2" }, { ...run, id: "r-2", taskId: "t-2" });
      await store.saveRunResult({ ...run, id: "r-2", taskId: "t-2", state: "succeeded" });
      await store.saveInstallation({
        id: "gi-1",
        installationId: "12345",
        accountLogin: "acme",
        createdAt: T0,
      });
      await store.createConnectedRepo({
        id: "cr-1",
        provider: "github",
        installationId: "12345",
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
      const merged = (id: string, runId: string, createdAt: string, cued: string | null = null) =>
        store.createPatch({
          id,
          connectedRepoId: "cr-1",
          runId,
          taskId: runId === "r-1" ? "t-1" : "t-2",
          setId: `s-${id}`,
          path: "repo",
          line: "work",
          branchName: `ryph/ada/${runId}/work`,
          headSha: id,
          bundleKey: "b",
          baseSha: null,
          generation: 1,
          title: null,
          description: null,
          commits: [],
          carries: [],
          state: "submitted",
          attempts: 1,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          lastError: null,
          approvedBy: null,
          approvedAt: null,
          forgeRef: "7",
          forgeUrl: null,
          forgeBranch: null,
          diffRef: null,
          landed: { kind: "merged", at: createdAt },
          supersededByPatchId: null,
          hookCheck: null,
          approvedHookPaths: [],
          memoryFateReportedAt: null,
          mergedCuedAt: cued,
          mergedCueClaimedAt: null,
          landingAskedAt: null,
          heldReason: null,
          version: 0,
          createdAt,
          updatedAt: createdAt,
        });
      await merged("p-live", "r-1", T0);
      await merged("p-new", "r-2", T2);
      await merged("p-old", "r-2", T1);
      await merged("p-told", "r-2", T0, T0);
      const cuedAt = async () =>
        Object.fromEntries(
          await Promise.all(
            ["p-live", "p-old", "p-new", "p-told"].map(async (id) =>
              [id, (await store.getPatch(id))!.mergedCuedAt] as const
            ),
          ),
        );
      assertEquals(await store.markMergedCuesOfEndedRuns(1, T2), 1);
      assertEquals(await cuedAt(), { "p-live": null, "p-old": T2, "p-new": null, "p-told": T0 });
      assertEquals(await store.markMergedCuesOfEndedRuns(10, T2), 1);
      assertEquals(await store.markMergedCuesOfEndedRuns(10, T2), 0);
      assertEquals(await cuedAt(), { "p-live": null, "p-old": T2, "p-new": T2, "p-told": T0 });
    } finally {
      await store.close();
    }
  });
}

test("a prompt claims the task once: two first messages race, one becomes its instructions", async () => {
  // Over the migrations too (RYPH_TEST_DB): both spec columns must take null.
  for (const store of [drizzleTaskStore(await makeTestDb()), memoryTaskStore()]) {
    try {
      await store.createAgent(agent);
      const awaiting: Task = { ...task, spec: { title: null, instructions: null } };
      await store.createTask(awaiting, {
        ...run,
        workItem: { ...run.workItem, spec: { title: null, instructions: null } },
      });
      assertEquals((await store.getTask("t-1"))?.spec, { title: null, instructions: null });
      await store.createUnclaimedAttachment({
        id: "att-1",
        runId: "r-1",
        mime: "image/png",
        bytes: 8,
        sha256: "0".repeat(64),
        ref: null,
        source: "user",
        storageKey: "attachments/r-1/att-1",
        claimedBy: null,
        createdAt: T0,
      }, 20);
      const message = (id: string, text: string, withImage: boolean) => ({
        id,
        runId: "r-1",
        kind: "user" as const,
        sender: { kind: "user" as const, userId: "u-1" },
        text,
        payload: null,
        attachments: withImage ? [{ id: "att-1", mime: "image/png" as const }] : [],
        createdAt: T1,
        deliveredAt: null,
      });
      const [a, b] = await Promise.all([
        store.claimTaskPrompt(
          { taskId: "t-1", instructions: "first\n\n(attached: [image 1])", title: "first" },
          message("rm-1", "first", true),
        ),
        store.claimTaskPrompt(
          { taskId: "t-1", instructions: "second", title: "second" },
          message("rm-2", "second", false),
        ),
      ]);
      // Exactly one won, and the loser wrote nothing at all.
      assertEquals([a, b].filter((c) => c.kind === "claimed").length, 1);
      const won = a.kind === "claimed" ? a.message : b.kind === "claimed" ? b.message : null;
      if (won === null) throw new Error("no claim won");
      assertEquals(won.seq, 0);
      const stored = (await store.getTask("t-1"))!;
      assertEquals(
        stored.spec.instructions,
        won.id === "rm-1" ? "first\n\n(attached: [image 1])" : "second",
      );
      assertEquals((await store.listRunMessages("r-1")).map((m) => m.id), [won.id]);
      // The run's work item took the same spec, and the prompt's images, for a re-run.
      const after = (await store.getRun("r-1"))!;
      assertEquals(after.workItem.spec, stored.spec);
      assertEquals(after.workItem.attachments ?? [], won.attachments);
      // Claimed for good: a later claim finds nothing to claim.
      assertEquals(
        await store.claimTaskPrompt(
          { taskId: "t-1", instructions: "third", title: "third" },
          message("rm-3", "third", false),
        ),
        { kind: "taken" },
      );
    } finally {
      await store.close();
    }
  }
});

test("a prompt is refused once its run has ended, and nothing is written", async () => {
  for (const store of [drizzleTaskStore(await makeTestDb()), memoryTaskStore()]) {
    try {
      await store.createAgent(agent);
      const awaiting: Task = { ...task, spec: { title: null, instructions: null } };
      await store.createTask(awaiting, {
        ...run,
        workItem: { ...run.workItem, spec: { title: null, instructions: null } },
      });
      // The run idled out between the route's read and the claim.
      await store.saveRunResult({
        ...(await store.getRun("r-1"))!,
        state: "succeeded",
        updatedAt: T1,
      });
      assertEquals(
        await store.claimTaskPrompt({ taskId: "t-1", instructions: "late", title: "late" }, {
          id: "rm-1",
          runId: "r-1",
          kind: "user",
          sender: { kind: "user", userId: "u-1" },
          text: "late",
          payload: null,
          attachments: [],
          createdAt: T2,
          deliveredAt: null,
        }),
        { kind: "terminal", state: "succeeded" },
      );
      assertEquals((await store.getTask("t-1"))?.spec, { title: null, instructions: null });
      assertEquals(await store.listRunMessages("r-1"), []);
    } finally {
      await store.close();
    }
  }
});

test("a title is replaced only while it is still the one it replaces", async () => {
  const store = drizzleTaskStore(await makeTestDb());
  try {
    await store.createAgent(agent);
    await store.createTask(task, run);
    assertEquals(await store.retitleTask("t-1", "Not the title", "Hijacked"), false);
    assertEquals((await store.getTask("t-1"))?.spec.title, "Do the thing");
    assertEquals(await store.retitleTask("t-1", "Do the thing", "Thing, done"), true);
    assertEquals((await store.getTask("t-1"))?.spec.title, "Thing, done");
  } finally {
    await store.close();
  }
});

/** cr-1, connected: what a patch row's foreign key needs. */
const connectRepo = (store: Awaited<ReturnType<typeof memoryTaskStore>>) =>
  store.createConnectedRepo({
    id: "cr-1",
    provider: "github",
    installationId: null,
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

/** A patch of r-1's at `repo`, generation 1, waiting for a person: the merge suites' fixture. */
const patchOf = (id: string, headSha: string): Patch => ({
  id,
  connectedRepoId: "cr-1",
  runId: "r-1",
  taskId: "t-1",
  setId: `s-${id}`,
  path: "repo",
  line: "work",
  branchName: "ryph/ada/r-1/work",
  headSha,
  bundleKey: "b",
  baseSha: null,
  generation: 1,
  title: null,
  description: null,
  commits: [],
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
  createdAt: T1,
  updatedAt: T1,
});

for (
  const [name, open] of [
    ["drizzle", async () => drizzleTaskStore(await makeTestDb())],
    ["memory", () => Promise.resolve(memoryTaskStore())],
  ] as const
) {
  test(`${name}: a merge record grows its heads, is stamped only over the version and settle it read, and lists when due`, async () => {
    const store = await open();
    try {
      // Connected without an installation, as GitHub's user mode does: the merge poll's tenant.
      await store.createConnectedRepo({
        id: "cr-1",
        provider: "github",
        installationId: null,
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
      const [A, B] = ["a", "b"].map((c) => c.repeat(40));
      const first = await store.recordChangeRequestMerge({
        connectedRepoId: "cr-1",
        forgeRef: "7",
        mergedInto: undefined,
        heads: [A],
        at: T0,
      });
      assertEquals(first, {
        connectedRepoId: "cr-1",
        forgeRef: "7",
        mergedInto: null,
        heads: [A],
        mergedAt: T0,
        version: 1,
        settledAt: null,
        attempts: 0,
        nextAskAt: null,
        releasedAt: null,
        releaseRetryAt: null,
      });
      // Due until settled; a clock in the future keeps it out.
      assertEquals((await store.listChangeRequestMergesDue(T1, 10)).map((m) => m.forgeRef), ["7"]);
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 1,
          settledAt: null,
          nextAskAt: null,
        }, {
          settledAt: null,
          attempts: 1,
          nextAskAt: T2,
        }),
      );
      assertEquals(await store.listChangeRequestMergesDue(T1, 10), []);
      assertEquals((await store.listChangeRequestMergesDue(T2, 10)).length, 1);
      // Another process that read the same record starts no second ask: the clock it read moved.
      assertEquals(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 1,
          settledAt: null,
          nextAskAt: null,
        }, { settledAt: null, attempts: 0, nextAskAt: T1 }),
        false,
      );
      // A repeat names nothing new: nothing moves but a branch first named now.
      const again = await store.recordChangeRequestMerge({
        connectedRepoId: "cr-1",
        forgeRef: "7",
        mergedInto: "main",
        heads: [A],
        at: T1,
      });
      assertEquals([again.mergedInto, again.version, again.attempts], ["main", 1, 1]);
      // A new head: the record is due again, at once, and a settle that read the old heads
      // cannot mark it settled.
      const grown = await store.recordChangeRequestMerge({
        connectedRepoId: "cr-1",
        forgeRef: "7",
        mergedInto: "release",
        heads: [B, A],
        at: T1,
      });
      assertEquals([grown.heads, grown.version, grown.attempts, grown.nextAskAt], [
        [B, A],
        2,
        0,
        null,
      ]);
      assertEquals(grown.mergedInto, "main");
      assertEquals(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 1,
          settledAt: null,
          nextAskAt: null,
        }, {
          settledAt: T1,
          attempts: 0,
          nextAskAt: null,
        }),
        false,
      );
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 2,
          settledAt: null,
          nextAskAt: null,
        }, {
          settledAt: T1,
          attempts: 0,
          nextAskAt: null,
        }),
      );
      // A retry's clock from a settle that read the record before that one closed it never
      // reopens it, though the heads are the same.
      assertEquals(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 2,
          settledAt: null,
          nextAskAt: null,
        }, {
          settledAt: null,
          attempts: 2,
          nextAskAt: T2,
        }),
        false,
      );
      assertEquals(await store.listChangeRequestMergesDue(T2, 10), []);
      assertEquals((await store.getChangeRequestMerge("cr-1", "7"))?.settledAt, T1);
      assertEquals(await store.getChangeRequestMerge("cr-1", "8"), null);
      // Settled with a clock (an ask under way for a late push): due once its clock passes, and
      // not before.
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 2,
          settledAt: T1,
          nextAskAt: null,
        }, {
          settledAt: T1,
          attempts: 0,
          nextAskAt: T2,
        }),
      );
      assertEquals(await store.listChangeRequestMergesDue(T1, 10), []);
      assertEquals((await store.listChangeRequestMergesDue(T2, 10)).map((m) => m.forgeRef), ["7"]);
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", {
          version: 2,
          settledAt: T1,
          nextAskAt: T2,
        }, {
          settledAt: T1,
          attempts: 0,
          nextAskAt: null,
        }),
      );
      assertEquals(await store.listChangeRequestMergesDue(T2, 10), []);
      // Its releases are owed until they are marked made; one deferred waits out its retry.
      assertEquals((await store.listMergesOwingRelease(T0, 10)).map((m) => m.forgeRef), ["7"]);
      await store.deferMergeRelease("cr-1", "7", T1);
      assertEquals(await store.listMergesOwingRelease(T0, 10), []);
      assertEquals((await store.listMergesOwingRelease(T1, 10)).map((m) => m.forgeRef), ["7"]);
      await store.markMergeReleased("cr-1", "7", T2);
      assertEquals(await store.listMergesOwingRelease(T2, 10), []);
      assertEquals((await store.getChangeRequestMerge("cr-1", "7"))?.releasedAt, T2);
      // Settled, but a push with no verdict reached it since: due again.
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        id: "p-late",
        connectedRepoId: "cr-1",
        runId: "r-1",
        taskId: "t-1",
        setId: "s-late",
        path: "repo",
        line: "work",
        branchName: "ryph/ada/r-1/work",
        headSha: "c".repeat(40),
        bundleKey: "b",
        baseSha: null,
        generation: 1,
        title: null,
        description: null,
        commits: [],
        carries: [],
        state: "submitted",
        attempts: 1,
        nextAttemptAt: null,
        leaseExpiresAt: null,
        lastError: null,
        approvedBy: null,
        approvedAt: null,
        forgeRef: "7",
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
        createdAt: T1,
        updatedAt: T1,
      });
      assertEquals((await store.listChangeRequestMergesDue(T2, 10)).map((m) => m.forgeRef), ["7"]);
      // And the merge poll asks about a change request only while its merge is not recorded.
      const late = (await store.getPatch("p-late"))!;
      await store.createPatch({ ...late, id: "p-open", forgeRef: "9", headSha: "d".repeat(40) });
      assertEquals(
        (await store.listChangeRequestsDueMergePoll(T2, T0, 10, ["github"])).map((d) => d.forgeRef),
        ["9"],
      );
    } finally {
      await store.close();
    }
  });

  test(`${name}: the merge poll lists the polled providers' repos only — GitHub user-mode, GitLab on its instance`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      const base = {
        installationId: null,
        defaultBranch: "main",
        submissionPolicy: "require-approval" as const,
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      };
      // GitLab rows carry no tenant in either mode; an App-mode GitHub row is never polled.
      await store.createConnectedRepo({
        ...base,
        id: "cr-gl",
        provider: "gitlab",
        repoRef: "acme/platform/app",
        url: "https://gitlab.example/acme/platform/app.git",
      });
      await store.createConnectedRepo({
        ...base,
        id: "cr-app",
        provider: "github",
        installationId: "42",
        repoRef: "acme/other",
        url: "https://github.com/acme/other.git",
      });
      await store.createConnectedRepo({
        ...base,
        id: "cr-gl-old",
        provider: "gitlab",
        repoRef: "acme/platform/old",
        url: "https://gitlab.old.example/acme/platform/old.git",
      });
      await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      await store.createGitlabProject("cr-gl-old", "42", "https://gitlab.old.example", T0);
      await store.createAgent(agent);
      await store.createTask(task, run);
      const submitted = (id: string, connectedRepoId: string, forgeRef: string): Patch => ({
        ...patchOf(id, "e".repeat(40)),
        connectedRepoId,
        setId: `s-${id}`,
        line: id,
        state: "submitted",
        attempts: 1,
        forgeRef,
      });
      await store.createPatch(submitted("p-gh", "cr-1", "7"));
      await store.createPatch(submitted("p-gl", "cr-gl", "mr-3"));
      await store.createPatch(submitted("p-app", "cr-app", "8"));
      await store.createPatch(submitted("p-gl-old", "cr-gl-old", "mr-4"));
      const here = { instance: "https://gitlab.example", bot: false };
      const listed = async (
        polled: Array<"github" | "gitlab">,
        gitlab: { instance: string; bot: boolean } | null = here,
      ) =>
        (await store.listChangeRequestsDueMergePoll(T2, T0, 10, polled, gitlab))
          .map((d) => `${d.connectedRepoId}:${d.forgeRef}`).toSorted();
      assertEquals(await listed(["github"]), ["cr-1:7"]);
      assertEquals(await listed(["gitlab"]), ["cr-gl:mr-3"]);
      assertEquals(await listed(["github", "gitlab"]), ["cr-1:7", "cr-gl:mr-3"]);
      assertEquals(await listed([]), []);
      // Bot mode lists every GitLab repo of the instance; a row of another one, never.
      assertEquals(await listed([], { ...here, bot: true }), ["cr-gl:mr-3"]);
      assertEquals(
        await listed(["gitlab"], { instance: "https://gitlab.old.example", bot: false }),
        ["cr-gl-old:mr-4"],
      );
      // No GitLab here: no GitLab row is anybody's.
      assertEquals(await listed(["github", "gitlab"], null), ["cr-1:7"]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: GitLab in user mode is polled for merges by the forge's own read; in bot mode slowly while its hook is heard`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createConnectedRepo({
        id: "cr-gl",
        provider: "gitlab",
        installationId: null,
        repoRef: "acme/platform/app",
        url: "https://gitlab.example/acme/platform/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-gl", "e".repeat(40)),
        connectedRepoId: "cr-gl",
        state: "submitted",
        attempts: 1,
        forgeRef: "mr-3",
      });
      let gitlab: GitlabMode = {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: true,
      };
      const asked: string[] = [];
      let at = Date.parse(T2);
      const forge = {
        providers: () =>
          Promise.resolve({ providers: ["gitlab" as const], github: null, gitlab, radicle: null }),
        fetchChangeRequestHead: (repo: ForgeRepoRef, ref: string) => {
          asked.push(`${repo.provider}:${repo.repoRef}:${ref}`);
          return Promise.resolve({
            kind: "head" as const,
            head: {
              ref,
              state: "closed" as const,
              merged: true,
              headSha: "e".repeat(40),
              authorHeadSha: "e".repeat(40),
              baseRef: "main",
              openedByUs: true,
              mergedHeads: ["e".repeat(40)],
            },
          });
        },
      };
      await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      const deps = { store, diag: silentDiagnostics(), now: () => new Date(at), forge };
      // A bot whose webhook delivered a merge request event a minute ago hears merges by it:
      // nothing is asked now, and the change request's clock starts at the slowest cadence.
      await store.recordGitlabHookDelivery("cr-gl", new Date(at - 60_000).toISOString(), T0, true);
      await pollChangeRequestEnds(deps);
      assertEquals(asked, []);
      // One person's token takes no webhooks: the merge request is read, and its merge recorded
      // as the event's would be. A fresh forge, as the mode is kept for a minute per forge; the
      // clock the bot started still stands.
      gitlab = { ...gitlab, mode: "user", login: "ada" };
      await pollChangeRequestEnds({ ...deps, forge: { ...forge } });
      assertEquals(asked, []);
      at += DEFAULT_MERGE_POLL_CONFIG.heardIntervalMs;
      await pollChangeRequestEnds({ ...deps, forge: { ...forge } });
      assertEquals(asked, ["gitlab:acme/platform/app:mr-3"]);
      assertEquals((await store.getChangeRequestMerge("cr-gl", "mr-3"))?.heads, ["e".repeat(40)]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: GitLab rows stranded on another instance never hold the merge poll's queue`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      const base = {
        installationId: null,
        defaultBranch: "main",
        submissionPolicy: "require-approval" as const,
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      };
      const gitlabRow = async (id: string, instance: string | null) => {
        await store.createConnectedRepo({
          ...base,
          id,
          provider: "gitlab",
          repoRef: `acme/${id}`,
          url: `${instance ?? "https://gitlab.example"}/acme/${id}.git`,
        });
        if (instance !== null) await store.createGitlabProject(id, "42", instance, T0);
      };
      // More stranded rows than a tick asks about, each sorting ahead of the live ones: two
      // connected on the instance the deployment used to point at, one with no project at all.
      await gitlabRow("cr-0-old-a", "https://gitlab.old.example");
      await gitlabRow("cr-0-old-b", "https://gitlab.old.example");
      await gitlabRow("cr-0-old-c", null);
      await gitlabRow("cr-gl", "https://gitlab.example");
      await store.createConnectedRepo({
        ...base,
        id: "cr-zgh",
        provider: "github",
        repoRef: "acme/other",
        url: "https://github.com/acme/other.git",
      });
      await store.createAgent(agent);
      await store.createTask(task, run);
      for (const repo of ["cr-0-old-a", "cr-0-old-b", "cr-0-old-c", "cr-gl", "cr-zgh"]) {
        await store.createPatch({
          ...patchOf(`p-${repo}`, "e".repeat(40)),
          connectedRepoId: repo,
          setId: `s-${repo}`,
          line: repo,
          state: "submitted",
          attempts: 1,
          forgeRef: "9",
        });
      }
      let gitlab: GitlabMode | null = {
        mode: "user",
        login: "ada",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: false,
      };
      const asked: string[] = [];
      let at = Date.parse(T2);
      const forge = {
        providers: () =>
          Promise.resolve({
            providers: gitlab === null
              ? ["github" as const]
              : ["github" as const, "gitlab" as const],
            github: { mode: "user" as const, login: "ada" },
            gitlab,
            radicle: null,
          }),
        fetchChangeRequestHead: (repo: ForgeRepoRef, ref: string) => {
          asked.push(`${repo.provider}:${repo.repoRef}`);
          return Promise.resolve({
            kind: "head" as const,
            head: {
              ref,
              state: "open" as const,
              merged: false,
              headSha: "e".repeat(40),
              authorHeadSha: "e".repeat(40),
              baseRef: "main",
              openedByUs: true,
              mergedHeads: [],
            },
          });
        },
      };
      const userMode = { mode: "user" as const, login: "ada" };
      const deps = {
        store,
        diag: silentDiagnostics(),
        now: () => new Date(at),
        forge,
        githubMode: { current: () => userMode, get: () => Promise.resolve(userMode) },
      };
      const cfg = { ...DEFAULT_MERGE_POLL_CONFIG, perTick: 2 };
      // The live GitLab merge request and the user-mode pull request are the ones asked, on the
      // first tick and every interval after; the stranded rows are never listed at all.
      await pollChangeRequestEnds(deps, cfg);
      assertEquals(asked.toSorted(), ["github:acme/other", "gitlab:acme/cr-gl"]);
      at += cfg.intervalMs;
      await pollChangeRequestEnds(deps, cfg);
      assertEquals(asked.length, 4);
      const listed = await store.listChangeRequestsDueMergePoll(
        new Date(at + cfg.intervalMs).toISOString(),
        T0,
        10,
        ["github", "gitlab"],
        { instance: "https://gitlab.example", bot: false },
      );
      assertEquals(listed.map((d) => d.connectedRepoId).toSorted(), ["cr-gl", "cr-zgh"]);
      // No GitLab here at all: no GitLab row is anybody's, and GitHub's go on being asked.
      gitlab = null;
      at += cfg.intervalMs;
      await pollChangeRequestEnds({ ...deps, forge: { ...forge } }, cfg);
      assertEquals(asked.slice(4), ["github:acme/other"]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a bot-mode GitLab repo whose hook was never heard is polled, an open one slowly`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createConnectedRepo({
        id: "cr-gl",
        provider: "gitlab",
        installationId: null,
        repoRef: "acme/platform/app",
        url: "https://gitlab.example/acme/platform/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-gl", "e".repeat(40)),
        connectedRepoId: "cr-gl",
        state: "submitted",
        attempts: 1,
        forgeRef: "mr-3",
      });
      const gitlab: GitlabMode = {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: true,
      };
      const asked: string[] = [];
      let open = true;
      let now = Date.parse(T2);
      const forge = {
        providers: () =>
          Promise.resolve({ providers: ["gitlab" as const], github: null, gitlab, radicle: null }),
        fetchChangeRequestHead: (_repo: ForgeRepoRef, ref: string) => {
          asked.push(ref);
          return Promise.resolve({
            kind: "head" as const,
            head: {
              ref,
              state: open ? "open" as const : "closed" as const,
              merged: !open,
              headSha: "e".repeat(40),
              authorHeadSha: "e".repeat(40),
              baseRef: "main",
              openedByUs: true,
              mergedHeads: open ? [] : ["e".repeat(40)],
            },
          });
        },
      };
      const deps = {
        store,
        diag: silentDiagnostics(),
        now: () => new Date(now),
        forge,
        gitlabUrl: () => Promise.resolve("https://gitlab.example"),
      };
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3"], "no delivery was ever heard: the merge request is read");
      // Open: asked again only after the slow interval, not the user mode's minute.
      now += DEFAULT_MERGE_POLL_CONFIG.intervalMs;
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3"]);
      now += DEFAULT_MERGE_POLL_CONFIG.unheardIntervalMs;
      open = false;
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3", "mr-3"]);
      assertEquals((await store.getChangeRequestMerge("cr-gl", "mr-3"))?.heads, ["e".repeat(40)]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a bot-mode GitLab hook heard only for pushes and notes still has its merges polled`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createConnectedRepo({
        id: "cr-gl",
        provider: "gitlab",
        installationId: null,
        repoRef: "acme/platform/app",
        url: "https://gitlab.example/acme/platform/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-gl", "e".repeat(40)),
        connectedRepoId: "cr-gl",
        state: "submitted",
        attempts: 1,
        forgeRef: "mr-3",
      });
      const gitlab: GitlabMode = {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: true,
      };
      const asked: string[] = [];
      let now = Date.parse(T2);
      const forge = {
        providers: () =>
          Promise.resolve({ providers: ["gitlab" as const], github: null, gitlab, radicle: null }),
        fetchChangeRequestHead: (_repo: ForgeRepoRef, ref: string) => {
          asked.push(ref);
          return Promise.resolve({
            kind: "head" as const,
            head: {
              ref,
              state: "open" as const,
              merged: false,
              headSha: "e".repeat(40),
              authorHeadSha: "e".repeat(40),
              baseRef: "main",
              openedByUs: true,
              mergedHeads: [],
            },
          });
        },
      };
      const deps = {
        store,
        diag: silentDiagnostics(),
        now: () => new Date(now),
        forge,
        gitlabUrl: () => Promise.resolve("https://gitlab.example"),
      };
      // A hook without "Merge request events" ticked rings for pushes and notes all day: the
      // page sees deliveries, but no merge is ever heard, so merges are still polled.
      assertEquals(await admitGitlabHook(deps, "42", "1", "other"), {
        admission: "current",
        connectedAt: T0,
      });
      assertEquals(
        (await store.getGitlabProject("cr-gl"))?.lastHookAt,
        new Date(now).toISOString(),
      );
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3"], "pushes and notes say nothing about merges");
      // A merge request event is what slows the poll to the heard cadence: the ask already due
      // is the last for an hour.
      now += DEFAULT_MERGE_POLL_CONFIG.unheardIntervalMs;
      await admitGitlabHook(deps, "42", "1", "merge_request");
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3", "mr-3"]);
      now += DEFAULT_MERGE_POLL_CONFIG.unheardIntervalMs;
      await admitGitlabHook(deps, "42", "1", "merge_request");
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3", "mr-3"], "a merge request event was heard just now");
    } finally {
      await store.close();
    }
  });

  test(`${name}: a merge whose event was lost in a repo whose hook is heard is still found, slowly`, async () => {
    // The repo's hook delivers merge request events all day, but this one merge's never came: a
    // 429 burst (GitLab never retries), a merge request `locked` past the retry ladder, a 403
    // GitLab answered for a moment. Each change request is asked about anyway, once an hour, so
    // no loss leaves its patch submitted for good.
    const store = await open();
    try {
      await connectRepo(store);
      await store.createConnectedRepo({
        id: "cr-gl",
        provider: "gitlab",
        installationId: null,
        repoRef: "acme/platform/app",
        url: "https://gitlab.example/acme/platform/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-gl", "e".repeat(40)),
        connectedRepoId: "cr-gl",
        state: "submitted",
        attempts: 1,
        forgeRef: "mr-3",
      });
      const gitlab: GitlabMode = {
        mode: "bot",
        login: "ryph-bot",
        accountId: "1@https://gitlab.example",
        url: "https://gitlab.example",
        signIn: true,
      };
      const asked: string[] = [];
      let merged = false;
      let now = Date.parse(T2);
      const forge = {
        providers: () =>
          Promise.resolve({ providers: ["gitlab" as const], github: null, gitlab, radicle: null }),
        fetchChangeRequestHead: (_repo: ForgeRepoRef, ref: string) => {
          asked.push(ref);
          return Promise.resolve({
            kind: "head" as const,
            head: {
              ref,
              state: merged ? "closed" as const : "open" as const,
              merged,
              headSha: "e".repeat(40),
              authorHeadSha: "e".repeat(40),
              baseRef: "main",
              openedByUs: true,
              mergedHeads: merged ? ["e".repeat(40)] : [],
            },
          });
        },
      };
      const deps = { store, diag: silentDiagnostics(), now: () => new Date(now), forge };
      const heardNow = () =>
        store.recordGitlabHookDelivery("cr-gl", new Date(now).toISOString(), T0, true);
      await heardNow();
      // Heard: a merge request event will most likely say it first, so nothing is read yet.
      await pollChangeRequestEnds(deps);
      assertEquals(asked, []);
      now += DEFAULT_MERGE_POLL_CONFIG.unheardIntervalMs;
      await heardNow();
      await pollChangeRequestEnds(deps);
      assertEquals(asked, []);

      // It merged; its event was lost, while other merge requests' events kept arriving.
      merged = true;
      now += DEFAULT_MERGE_POLL_CONFIG.heardIntervalMs;
      await heardNow();
      await pollChangeRequestEnds(deps);
      assertEquals(asked, ["mr-3"]);
      assertEquals((await store.getChangeRequestMerge("cr-gl", "mr-3"))?.heads, ["e".repeat(40)]);
    } finally {
      await store.close();
    }
  });

  test(`${name}: under a line cap a patch of a new line is written only while there is room`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createAgent(agent);
      await store.createTask(task, run);
      const of = (id: string, line: string, head: string, over: Partial<Patch> = {}): Patch => ({
        ...patchOf(id, head.repeat(40)),
        line,
        branchName: `ryph/ada/r-1/${line}`,
        ...over,
      });
      const cap = { maxLinesPerRepo: 2 };
      assertEquals(await store.createPatch(of("p-1", "work", "1"), cap), true);
      assertEquals(await store.createPatch(of("p-2", "fix-a", "2"), cap), true);
      // A third line is past it; another patch of a line it has never is.
      assertEquals(await store.createPatch(of("p-3", "docs", "3"), cap), false);
      assertEquals(await store.createPatch(of("p-4", "fix-a", "4"), cap), true);
      // Lines are counted per repo path: another path has room of its own.
      assertEquals(await store.createPatch(of("p-5", "docs", "5", { path: "web" }), cap), true);
      // Three new lines racing for two places: exactly two are written.
      const race = await Promise.all([
        store.createPatch(of("p-6", "x1", "6", { path: "lib" }), cap),
        store.createPatch(of("p-7", "x2", "7", { path: "lib" }), cap),
        store.createPatch(of("p-8", "x3", "8", { path: "lib" }), cap),
      ]);
      assertEquals(race.filter(Boolean).length, 2);
      // Without a cap: as ever.
      assertEquals(await store.createPatch(of("p-9", "docs", "9")), true);
      assertEquals(
        (await store.patchesForTask("t-1")).map((p) => p.id).toSorted(),
        ["p-1", "p-2", "p-4", "p-5", "p-9", ...race.flatMap((ok, i) => ok ? [`p-${i + 6}`] : [])]
          .toSorted(),
      );
    } finally {
      await store.close();
    }
  });

  test(`${name}: a task working a merged change request is found, and let go of it once`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createAgent(agent);
      await store.createTask(task, run);
      // The task targets #7 of cr-1 (the fixture): found by it, and by nothing else.
      assertEquals(
        (await store.listTasksTargetingChangeRequest("cr-1", "7")).map((t) => t.id),
        ["t-1"],
      );
      assertEquals(await store.listTasksTargetingChangeRequest("cr-1", "8"), []);
      assertEquals(await store.listTasksTargetingChangeRequest("cr-2", "7"), []);
      const args = {
        taskId: "t-1",
        connectedRepoId: "cr-1",
        thread: "7",
        mergedInto: "release",
        defaultBranch: "main",
        at: T2,
      };
      // A patch of the run waiting, built on the change request's head (no change request of its
      // own yet).
      await store.createPatch({ ...patchOf("p-wait", "e".repeat(40)), state: "queued" });
      assertEquals(await store.listPatchesDueLandingRule(10), []);
      const released = await store.releaseMergedTarget(args);
      assertEquals([released.outcome.kind, released.cuedRunId], ["moved", "r-1"]);
      const after = (await store.getTask("t-1"))!;
      assertEquals([after.targetChangeRequest, after.repos[0].ref], [null, "release"]);
      // The run's generation there is over, as a landing's would be.
      assertEquals(after.landings, {
        repo: {
          work: {
            connectedRepoId: "cr-1",
            thread: "7",
            onto: "release",
            generation: 1,
            moved: true,
            at: T2,
            releasedRun: "r-1",
          },
        },
      });
      // So the waiting patch is the landing rule's.
      assertEquals((await store.listPatchesDueLandingRule(10)).map((p) => p.id), ["p-wait"]);
      // The release cue went into the run's inbox with it.
      assertEquals((await store.listRunMessages("r-1")).map((m) => m.payload), [
        {
          kind: "released",
          path: "repo",
          line: "work",
          onto: "release",
          forgeRef: "7",
          generation: 1,
        },
      ]);
      // The live run's spec moved with it, and the trail says so.
      assertEquals((await store.getRun("r-1"))!.workItem.repos[0].ref, "release");
      const events = (await store.listEvents("r-1")).filter((e) => e.kind === "merge-landed");
      assertEquals(events.length, 1);
      // Let go: asked again, nothing happens.
      assertEquals((await store.releaseMergedTarget(args)).outcome.kind, "none");
      assertEquals(await store.listTasksTargetingChangeRequest("cr-1", "7"), []);
      assertEquals((await store.listRunMessages("r-1")).length, 1);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a task whose current run has a patch on the merged change request is not released`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-on", "f".repeat(40)),
        state: "submitted",
        forgeRef: "7",
      });
      const released = await store.releaseMergedTarget({
        taskId: "t-1",
        connectedRepoId: "cr-1",
        thread: "7",
        mergedInto: "release",
        defaultBranch: "main",
        at: T2,
      });
      assertEquals([released.outcome.kind, released.cuedRunId], ["none", null]);
      assertEquals((await store.getTask("t-1"))!.targetChangeRequest?.thread, "7");
      assertEquals(await store.listRunMessages("r-1"), []);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a poll asked for a change request a live task works is kept and listed with no patch on it`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.stampMergePoll("cr-1", "7", { dueAt: T0, failures: 0, gone: 0 });
      assertEquals(await store.pruneMergePolls(T0, 10), 0);
      assertEquals(await store.listChangeRequestsDueMergePoll(T2, T0, 10, ["github"]), [
        { connectedRepoId: "cr-1", forgeRef: "7", failures: 0, gone: 0, open: true, asked: true },
      ]);
      // Once the task no longer works it, the clock goes.
      await store.releaseMergedTarget({
        taskId: "t-1",
        connectedRepoId: "cr-1",
        thread: "7",
        mergedInto: "main",
        defaultBranch: "main",
        at: T2,
      });
      assertEquals(await store.listChangeRequestsDueMergePoll(T2, T0, 10, ["github"]), []);
      assertEquals(await store.pruneMergePolls(T0, 10), 1);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a cue's mark holds only over the verdict and the claim it was made for`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      await store.createAgent(agent);
      await store.createTask(task, run);
      await store.createPatch({
        ...patchOf("p-m", "1".repeat(40)),
        state: "submitted",
        forgeRef: "7",
        landed: { kind: "missed", at: T1 },
      });
      assert(await store.claimMergedCue("p-m", T1, T0));
      // A revision to merged clears the claim: the missed note's late mark writes nothing.
      const read = (await store.getPatch("p-m"))!;
      assert(
        await store.settlePatchIf(
          {
            ...read,
            landed: { kind: "merged", at: T2 },
            mergedCuedAt: null,
            mergedCueClaimedAt: null,
          },
          "missed",
          [],
        ),
      );
      assertEquals(
        await store.markPatchMergedCued("p-m", T2, { kind: "missed", claimedAt: T1 }),
        false,
      );
      assertEquals(
        await store.markPatchMergedCued("p-m", T2, { kind: "merged", claimedAt: T1 }),
        false,
      );
      assert(await store.claimMergedCue("p-m", T2, T1));
      assert(await store.markPatchMergedCued("p-m", T2, { kind: "merged", claimedAt: T2 }));
      assertEquals((await store.getPatch("p-m"))!.mergedCuedAt, T2);
    } finally {
      await store.close();
    }
  });

  test(`${name}: a read from before an ask never matches the record again, even with its clock back`, async () => {
    const store = await open();
    try {
      await connectRepo(store);
      const read = await store.recordChangeRequestMerge({
        connectedRepoId: "cr-1",
        forgeRef: "7",
        mergedInto: "main",
        heads: ["a".repeat(40)],
        at: T0,
      });
      const mark = { settledAt: null, attempts: 0 };
      // One replica stamps its ask's deadline, then its answer puts the clock back to none.
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", read, {
          ...mark,
          nextAskAt: T1,
          asking: true,
        }),
      );
      const asking = (await store.getChangeRequestMerge("cr-1", "7"))!;
      assertEquals(asking.version, read.version + 1);
      assert(
        await store.stampChangeRequestMerge("cr-1", "7", asking, { ...mark, nextAskAt: null }),
      );
      // Another that read the record before all that starts no second ask.
      assertEquals(
        await store.stampChangeRequestMerge("cr-1", "7", read, {
          ...mark,
          nextAskAt: T2,
          asking: true,
        }),
        false,
      );
    } finally {
      await store.close();
    }
  });

  test(`${name}: a GitLab project's drops over budget add up, and a rotation forgets them`, async () => {
    const store = await open();
    try {
      await store.createConnectedRepo({
        id: "cr-gl",
        provider: "gitlab",
        installationId: null,
        repoRef: "acme/app",
        url: "https://gitlab.example/acme/app.git",
        defaultBranch: "main",
        submissionPolicy: "require-approval",
        sizeClass: null,
        allowForkPushes: false,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      const created = await store.createGitlabProject("cr-gl", "42", "https://gitlab.example", T0);
      const counts = (g: GitlabProject | null | undefined) => [
        g?.droppedCommentHookCount,
        g?.droppedOtherHookCount,
        g?.lastDroppedHookAt,
      ];
      assertEquals(counts(created), [0, 0, null]);
      await store.recordGitlabHookDrops("cr-gl", "other", 3, T1);
      await store.recordGitlabHookDrops("cr-gl", "comments", 2, T1);
      await store.recordGitlabHookDrops("cr-gl", "other", 4, T2);
      assertEquals(counts(await store.getGitlabProject("cr-gl")), [2, 7, T2]);
      const rotated = await store.rotateGitlabHook("cr-gl", T2);
      assertEquals(counts(rotated), [0, 0, null]);
    } finally {
      await store.close();
    }
  });
}

/** The merge record backfill (0054) over the store's rows as they stand. */
async function backfillMergeRecords(handle: Awaited<ReturnType<typeof makeTestDb>>) {
  const migration = await readFile(
    new URL("../drizzle/0054_merge_record_backfill.sql", import.meta.url),
    "utf8",
  );
  await handle.db.execute(sql.raw(migration));
}

/** As the old settle left a merged patch: cued, landed, reported. */
const oldMerged = (id: string, head: string, forgeRef: string, at: string): Patch => ({
  ...patchOf(id, head),
  state: "submitted",
  forgeRef,
  landed: { kind: "merged", at },
  mergedCuedAt: at,
  landingAskedAt: at,
  memoryFateReportedAt: at,
  createdAt: at,
});

/** A settle's deps over `store`, with a forge that answers each question from `answer`. */
function settleDeps(
  store: ReturnType<typeof drizzleTaskStore>,
  forge: {
    mergeContainment?: (heads: string[]) => { contained: string[]; missed: string[] };
    mergedHeads?: string[];
  },
  asked: string[][],
) {
  return {
    store,
    forge: {
      mergeContainment: (_r: unknown, _u: unknown, _m: unknown, heads: string[]) => {
        asked.push(heads);
        const answer = forge.mergeContainment?.(heads) ?? { contained: [], missed: heads };
        return Promise.resolve({ kind: "answered" as const, ...answer });
      },
      fetchChangeRequestHead: () =>
        forge.mergedHeads === undefined ? Promise.reject(new Error("not asked")) : Promise.resolve({
          kind: "head" as const,
          head: {
            ref: "7",
            state: "closed",
            merged: true,
            headSha: forge.mergedHeads[0],
            authorHeadSha: forge.mergedHeads[0],
            baseRef: "main",
            openedByUs: true,
            mergedHeads: forge.mergedHeads,
          },
        }),
    },
    diag: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => new Date("2026-01-02T00:00:00.000Z"),
  } as unknown as Parameters<typeof reconcileMergeSettles>[0];
}

test("the merge record backfill: settled where nothing owes a verdict, and asking the forge what merged where something does", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await connectRepo(store);
    await store.createAgent(agent);
    await store.createTask(task, run);
    // #7: two patches merged, and a push that reached it after its merge with no verdict. #9:
    // merged twice, nothing owing. #8: merged, its record exists already.
    const [A, B, C, D, E, M, G] = ["a", "b", "c", "d", "e", "f", "1"].map((c) => c.repeat(40));
    await store.createPatch(oldMerged("p-a", A, "7", T0));
    await store.createPatch(oldMerged("p-b", B, "7", T1));
    await store.createPatch({
      ...patchOf("p-late", C),
      state: "submitted",
      forgeRef: "7",
      createdAt: T2,
    });
    await store.createPatch(oldMerged("p-e", E, "9", T1));
    await store.createPatch(oldMerged("p-g", G, "9", T2));
    await store.createPatch(oldMerged("p-d", D, "8", T1));
    await store.recordChangeRequestMerge({
      connectedRepoId: "cr-1",
      forgeRef: "8",
      mergedInto: "main",
      heads: [D],
      at: T1,
    });
    // A task whose run is over still targets #9, as the old code left one with nothing of its
    // run on a change request that merged.
    await store.createTask(
      { ...task, id: "t-3", targetChangeRequest: { connectedRepoId: "cr-1", thread: "9" } },
      { ...run, id: "r-3", taskId: "t-3", tokenHash: "hash-3", controlToken: "control-3" },
    );
    await store.saveRunResult({
      ...run,
      id: "r-3",
      taskId: "t-3",
      tokenHash: "hash-3",
      controlToken: "control-3",
      state: "succeeded",
      updatedAt: T1,
    });
    const finishedBefore = await store.getTask("t-3");
    await backfillMergeRecords(handle);
    // Owing: no heads (the old settle's may name pushes that never merged), unsettled; and its
    // release owed, since a task whose run is live still targets it.
    const owing = (await store.getChangeRequestMerge("cr-1", "7"))!;
    assertEquals(
      [owing.heads, owing.version, owing.settledAt, owing.releasedAt, owing.mergedAt],
      [[], 1, null, null, T0],
    );
    // Nothing owing: settled at its merge, with what merged, and never due; only a finished task
    // targets it, so its releases count as made and that task is never touched. Its heads newest
    // first, as the record keeps them.
    const settled = (await store.getChangeRequestMerge("cr-1", "9"))!;
    assertEquals([settled.heads, settled.settledAt, settled.releasedAt], [[G, E], T1, T1]);
    // An existing record is left as it was.
    assertEquals((await store.getChangeRequestMerge("cr-1", "8"))!.releasedAt, null);
    assertEquals(
      (await store.listChangeRequestMergesDue("2026-01-02T00:00:00.000Z", 10)).map((m) =>
        m.forgeRef
      ),
      // Never asked, both: the freshest merge first, so a backlog never delays a fresh one.
      ["8", "7"],
    );
    // The first settle reads what merged off the change request; the next asks only about the
    // push that owes a verdict, and leaves the merged rows as they were.
    const asked: string[][] = [];
    const deps = settleDeps(store, {
      mergedHeads: [M],
      mergeContainment: (heads) => ({ contained: [], missed: heads }),
    }, asked);
    const before = await Promise.all(["p-a", "p-b"].map((id) => store.getPatch(id)));
    await reconcileMergeSettles(deps, { waitMs: 1_000 });
    assertEquals((await store.getChangeRequestMerge("cr-1", "7"))!.heads, [M]);
    await reconcileMergeSettles(deps, { waitMs: 1_000 });
    assert(asked.some((h) => h.length === 1 && h[0] === C));
    assert(!asked.some((h) => h.includes(A) || h.includes(B)));
    assertEquals(await Promise.all(["p-a", "p-b"].map((id) => store.getPatch(id))), before);
    assertEquals((await store.getPatch("p-late"))!.landed?.kind, "missed");
    assert((await store.getChangeRequestMerge("cr-1", "7"))!.settledAt !== null);
    // #7's release is owed once, and stands aside: the live task's run has patches there, whose
    // landing is what lets it go. Nothing moves, and the record's releases are made.
    assertEquals(
      (await store.listMergesOwingRelease("2026-01-02T00:00:00.000Z", 10)).map((m) => m.forgeRef)
        .toSorted(),
      ["7", "8"],
    );
    const liveBefore = await store.getTask("t-1");
    await reconcileMergeReleases(deps);
    assertEquals(await store.listMergesOwingRelease("2026-01-02T00:00:00.000Z", 10), []);
    assertEquals(await store.getTask("t-1"), liveBefore);
    assertEquals(await store.getTask("t-3"), finishedBefore);
    assertEquals(await store.listRunMessages("r-3"), []);
  } finally {
    await store.close();
  }
});

test("a merge from before the landings is never landed, ruled or cued again by the backfill's settle", async () => {
  const handle = await makeTestDb();
  const store = drizzleTaskStore(handle);
  try {
    await connectRepo(store);
    await store.createAgent(agent);
    // An old task with no landings, its run over, a patch of it merged on #7 under the old code,
    // and a sibling of its generation still waiting for approval.
    await store.createTask({ ...task, targetChangeRequest: null, landings: {} }, run);
    await store.saveRunResult({ ...run, state: "succeeded", updatedAt: T1 });
    const [A, C, M] = ["a", "c", "f"].map((c) => c.repeat(40));
    await store.createPatch(oldMerged("p-a", A, "7", T0));
    await store.createPatch({ ...patchOf("p-wait", "b".repeat(40)), createdAt: T1 });
    // A push of another task's run reached #7 after it merged, so the record owes a verdict and
    // is settled — the old patch's landing must not be asked again with it.
    await store.createTask({ ...task, id: "t-2", targetChangeRequest: null }, {
      ...run,
      id: "r-2",
      taskId: "t-2",
      tokenHash: "hash-2",
      controlToken: "control-2",
    });
    await store.createPatch({
      ...patchOf("p-late", C),
      runId: "r-2",
      taskId: "t-2",
      state: "submitted",
      forgeRef: "7",
      createdAt: T2,
    });
    await backfillMergeRecords(handle);
    const taskBefore = await store.getTask("t-1");
    const patchesBefore = await Promise.all(["p-a", "p-wait"].map((id) => store.getPatch(id)));
    const eventsBefore = await store.listEvents("r-1");
    const asked: string[][] = [];
    const deps = settleDeps(store, {
      mergedHeads: [M],
      mergeContainment: (heads) => ({ contained: heads, missed: [] }),
    }, asked);
    await reconcileMergeSettles(deps, { waitMs: 1_000 });
    await reconcileMergeSettles(deps, { waitMs: 1_000 });
    assertEquals((await store.getPatch("p-late"))!.landed?.kind, "merged");
    // The old merged patch, its waiting sibling, its task and its run's trail are as they were.
    assertEquals(await Promise.all(["p-a", "p-wait"].map((id) => store.getPatch(id))), [
      patchesBefore[0],
      patchesBefore[1],
    ]);
    assertEquals((await store.getTask("t-1"))!.landings, taskBefore!.landings);
    assertEquals((await store.getTask("t-1"))!.repos, taskBefore!.repos);
    assertEquals(
      (await store.listEvents("r-1")).filter((e) => e.kind === "merge-landed"),
      eventsBefore.filter((e) => e.kind === "merge-landed"),
    );
    assertEquals(
      (await store.listRunMessages("r-1")).filter((m) => m.payload?.kind === "patch"),
      [],
    );
  } finally {
    await store.close();
  }
});
