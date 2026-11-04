// The pure state machine, transition by transition, against a hand-moved clock.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { applyHeartbeat, applyResult, composeWorkItem, planSweep } from "../src/core/lifecycle.ts";
import { sweep } from "../src/core/reaper.ts";
import type { CancelTarget } from "../src/ports/runner_control.ts";
import { DEFAULT_IDLE_MS, NO_RUN_LIMITS, type Run, type Task } from "../src/core/types.ts";
import { AGENT } from "./environment_world.ts";
import { memoryTaskStore } from "./memory_store.ts";
import { fakeClock, fakeProvisioner, silentDiagnostics } from "./doubles.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:15.000Z";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r-test",
    taskId: "t-test",
    agentId: "a-test",
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
    handle: "h-test",
    launchedAt: null,
    branchNamespace: "ryph/ada/r-test",
    image: null,
    environmentId: null,
    environment: null,
    environmentWait: null,
    workItem: {
      id: "r-test",
      agent: { name: "Ada", email: "ada@example.com" },
      spec: { title: "t", instructions: "i" },
      repos: [{
        connectedRepoId: "cr-1",
        name: "u",
        url: "u",
        ref: "main",
        path: "repo",
        branchNamespace: "ryph/ada/r-test",
        description: null,
      }],
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
    ...overrides,
  };
}

test("first heartbeat flips starting to running and records the transition", () => {
  const outcome = applyHeartbeat(makeRun(), { seq: 0, phase: "cloning" }, T1);
  assert(outcome.kind === "applied");
  assertEquals(outcome.run.state, "running");
  assertEquals(outcome.run.phase, "cloning");
  assertEquals(outcome.run.lastHeartbeatAt, T1);
  assertEquals(outcome.events.map((e) => e.kind), ["first-heartbeat", "phase-changed"]);
});

test("heartbeats carry idle intent only in the settled running phase", () => {
  const run = makeRun({ state: "running", phase: "running", idleState: "waiting-for-user" });
  for (const idleState of ["idle", "waiting-for-user", null] as const) {
    const outcome = applyHeartbeat(run, {
      seq: 1,
      phase: "running",
      idleDeadlineAt: "2026-01-01T00:05:00.000Z",
      idleState,
    }, "2026-01-01T00:00:00.000Z");
    assert(outcome.kind === "applied");
    assertEquals(outcome.run.idleState, idleState);
  }
  for (const phase of ["running", "finalizing"] as const) {
    const outcome = applyHeartbeat(run, { seq: 1, phase }, "2026-01-01T00:00:00.000Z");
    assert(outcome.kind === "applied");
    assertEquals(outcome.run.idleState, null, "old runners and active phases clear stale intent");
  }
});

test("an idle deadline dated before the beat is floored at the beat, never past the one on record", () => {
  const at = "2026-01-01T00:10:00.000Z";
  const past = "2026-01-01T00:00:00.000Z";
  // A run that settles with a deadline already behind it cannot make itself the reaper's at once:
  // it is now, and the idle grace runs from there like any other run's.
  const fresh = applyHeartbeat(
    makeRun({ state: "running", phase: "running" }),
    { seq: 1, phase: "running", idleDeadlineAt: past },
    at,
  );
  assert(fresh.kind === "applied");
  assertEquals(fresh.run.idleDeadlineAt, at);
  const sweepCfg = {
    heartbeatTimeoutMs: 60_000,
    startupGraceMs: 300_000,
    cancelGraceMs: 30_000,
    idleGraceMs: 30_000,
  };
  assertEquals(planSweep(fresh.run, Date.parse(at) + 1_000, sweepCfg).kind, "none");

  // A runner whose clock lapsed and keeps beating it keeps the deadline on record: the floor does
  // not carry it along with each beat, so the reaper still backstops it.
  const recorded = "2026-01-01T00:05:00.000Z";
  const lapsed = applyHeartbeat(
    makeRun({ state: "running", phase: "running", heartbeatSeq: 1, idleDeadlineAt: recorded }),
    { seq: 2, phase: "running", idleDeadlineAt: recorded },
    at,
  );
  assert(lapsed.kind === "applied");
  assertEquals(lapsed.run.idleDeadlineAt, recorded);
  // Nor can a later beat date it further back than that.
  const earlier = applyHeartbeat(
    lapsed.run,
    { seq: 3, phase: "running", idleDeadlineAt: past },
    at,
  );
  assert(earlier.kind === "applied");
  assertEquals(earlier.run.idleDeadlineAt, recorded);
});

test("the outcome the agent declared stands until a beat names another or clears it", () => {
  const run = makeRun({ state: "running", phase: "running" });
  const said = applyHeartbeat(run, { seq: 1, phase: "running", declaredOutcome: "success" }, T1);
  assert(said.kind === "applied");
  assertEquals(said.run.declaredOutcome, "success");
  const silent = applyHeartbeat(said.run, { seq: 2, phase: "running" }, T1);
  assert(silent.kind === "applied");
  assertEquals(silent.run.declaredOutcome, "success");
  const changed = applyHeartbeat(silent.run, {
    seq: 3,
    phase: "running",
    declaredOutcome: "failed",
  }, T1);
  assert(changed.kind === "applied");
  assertEquals(changed.run.declaredOutcome, "failed");
  // Work remains: in progress stands like any outcome, and a later beat moves it on.
  const working = applyHeartbeat(makeRun({ state: "running", phase: "running" }), {
    seq: 1,
    phase: "running",
    declaredOutcome: "in-progress",
  }, T1);
  assert(working.kind === "applied");
  assertEquals(working.run.declaredOutcome, "in-progress");
  const still = applyHeartbeat(working.run, { seq: 2, phase: "running" }, T1);
  assert(still.kind === "applied");
  assertEquals(still.run.declaredOutcome, "in-progress");
  // A message reached the agent: null clears what it said, and a beat that says nothing keeps
  // the clear.
  const cleared = applyHeartbeat(changed.run, {
    seq: 4,
    phase: "running",
    declaredOutcome: null,
  }, T1);
  assert(cleared.kind === "applied");
  assertEquals(cleared.run.declaredOutcome, null);
  const quiet = applyHeartbeat(cleared.run, { seq: 5, phase: "running" }, T1);
  assert(quiet.kind === "applied");
  assertEquals(quiet.run.declaredOutcome, null);
});

test("the beat that first says the agent finished is on the trail, and the finish stands", () => {
  const run = makeRun({ state: "running", phase: "running", declaredOutcome: "success" });
  const said = applyHeartbeat(run, { seq: 1, phase: "running", finished: true }, T1);
  assert(said.kind === "applied");
  assertEquals(said.run.agentFinished, true);
  assertEquals(said.events.map((e) => [e.kind, e.detail]), [["finished", "success"]]);
  const again = applyHeartbeat(said.run, { seq: 2, phase: "running", finished: true }, T1);
  assert(again.kind === "applied");
  assertEquals(again.events, [], "said once");
  const silent = applyHeartbeat(again.run, { seq: 3, phase: "running" }, T1);
  assert(silent.kind === "applied");
  assertEquals(silent.run.agentFinished, true);
});

test("a stale or reordered heartbeat is answered but never applied", () => {
  const run = makeRun({ state: "running", heartbeatSeq: 5, phase: "running" });
  const outcome = applyHeartbeat(run, { seq: 5, phase: "cloning" }, T1);
  assertEquals(outcome.kind, "stale");
});

test("a heartbeat against a terminal run is refused", () => {
  const outcome = applyHeartbeat(makeRun({ state: "lost" }), { seq: 0, phase: "running" }, T1);
  assertEquals(outcome.kind, "terminal");
});

test("a pending cancel does not ride the heartbeat — a beat is a report, not a channel", () => {
  const run = makeRun({
    state: "running",
    phase: "running",
    desiredState: "cancelled",
    cancelRequestedAt: T0,
  });
  const outcome = applyHeartbeat(run, { seq: 0, phase: "running" }, T1);
  // The beat is applied exactly as any other; the intent stays recorded for the reaper alone.
  assert(outcome.kind === "applied");
  assertEquals(outcome.run.desiredState, "cancelled");
  assertEquals(outcome.events, []);
});

test("results map statuses onto terminal states", () => {
  const success = applyResult(
    makeRun({ state: "running" }),
    {
      status: "success",
      branches: [{
        connectedRepoId: "cr-1",
        path: "repo",
        line: "work",
        name: "b",
        headSha: "sha",
        commits: [],
        carries: [],
        generation: 1,
      }],
      summary: "done",
    },
    T1,
  );
  assert(success.kind === "applied");
  assertEquals(success.run.state, "succeeded");

  const failure = applyResult(
    makeRun({ state: "running" }),
    { status: "failure", reason: "no changes", summary: "could not", branches: [] },
    T1,
  );
  assert(failure.kind === "applied");
  assertEquals(failure.run.state, "failed");

  // a success without a branch: the agent declared the task needed no code changes
  const noChanges = applyResult(
    makeRun({ state: "running" }),
    { status: "success", branches: [], summary: "nothing to change" },
    T1,
  );
  assert(noChanges.kind === "applied");
  assertEquals(noChanges.run.state, "succeeded");
});

test("a boot-failure result lands from starting, before any heartbeat", () => {
  const outcome = applyResult(
    makeRun({ state: "starting" }),
    {
      status: "error",
      reason: "the fetched run spec: workItem: invalid",
      during: "booting",
      branches: [],
    },
    T1,
  );
  assert(outcome.kind === "applied");
  assertEquals(outcome.run.state, "errored");
});

test("a re-POSTed result is a duplicate, which makes the report idempotent", () => {
  const applied = applyResult(
    makeRun({ state: "running" }),
    { status: "failure", reason: "r", summary: "s", branches: [] },
    T1,
  );
  assert(applied.kind === "applied");
  const again = applyResult(
    applied.run,
    { status: "failure", reason: "r", summary: "s", branches: [] },
    T1,
  );
  assertEquals(again.kind, "duplicate");
});

test("a late result upgrades lost — the runner's report beats the orchestrator's guess", () => {
  const outcome = applyResult(
    makeRun({ state: "lost" }),
    {
      status: "success",
      branches: [{
        connectedRepoId: "cr-1",
        path: "repo",
        line: "work",
        name: "b",
        headSha: "sha",
        commits: [],
        carries: [],
        generation: 1,
      }],
      summary: "made it",
    },
    T1,
  );
  assert(outcome.kind === "applied");
  assertEquals(outcome.run.state, "succeeded");
});

const CFG = {
  heartbeatTimeoutMs: 60_000,
  startupGraceMs: 300_000,
  cancelGraceMs: 120_000,
  idleGraceMs: 60_000,
};

test("planSweep marks a silent run lost, measured from the last beat", () => {
  const run = makeRun({ state: "running", lastHeartbeatAt: T0 });
  const fresh = planSweep(run, Date.parse(T0) + 30_000, CFG);
  assertEquals(fresh.kind, "none");
  const stale = planSweep(run, Date.parse(T0) + 61_000, CFG);
  assert(stale.kind === "mark-lost");
  assertEquals(stale.run.state, "lost");
});

test("planSweep gives a run that never beat the startup grace, not the beat timeout", () => {
  const booting = planSweep(makeRun(), Date.parse(T0) + 61_000, CFG);
  assertEquals(booting.kind, "none");
  const action = planSweep(makeRun(), Date.parse(T0) + 301_000, CFG);
  assertEquals(action.kind, "mark-lost");
});

test("planSweep escalates an overdue cancel to a graceful kill", () => {
  const run = makeRun({
    state: "running",
    lastHeartbeatAt: T1, // still beating — healthy, but the cancel never reached it
    desiredState: "cancelled",
    cancelRequestedAt: T0,
  });
  // 121s past the last beat is also past the heartbeat timeout — silence wins over the cancel.
  const action = planSweep(run, Date.parse(T1) + 121_000, CFG);
  assertEquals(action.kind, "mark-lost");

  const beating = planSweep(
    { ...run, lastHeartbeatAt: new Date(Date.parse(T0) + 121_000).toISOString() },
    Date.parse(T0) + 121_000,
    CFG,
  );
  assertEquals(beating.kind, "kill-graceful");
});

test("a pre-start cancel ends when its container exits, with one kill event across retries", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, kills } = fakeProvisioner();
  let status: "running" | "exited" = "running";
  provisioner.inspect = () => Promise.resolve(status);
  const run = makeRun({
    desiredState: "cancelled",
    cancelRequestedAt: T0,
    modelScope: {
      providerKeyId: "pk-1",
      provider: "anthropic",
      allowedModels: "*",
      model: null,
      thinking: null,
    },
  });
  await store.saveRun(run);
  const revoked: string[] = [];
  const deps = {
    store: {
      ...store,
      listEvents: () => Promise.reject(new Error("the sweep must not load the full transcript")),
    },
    provisioner,
    diag: silentDiagnostics(),
    now: clock.now,
    modelAccess: {
      revokeRunCredentials: (id: string) => {
        revoked.push(id);
        return Promise.resolve();
      },
    },
  };
  clock.advance(121_000);
  await sweep(deps, CFG);
  await sweep(deps, CFG);
  assertEquals((await store.getRun(run.id))?.state, "starting");
  assertEquals(kills.length, 2);
  assertEquals((await store.listEvents(run.id)).map((e) => e.kind), ["kill-requested"]);
  status = "exited";
  await sweep(deps, CFG);
  await sweep(deps, CFG);
  assertEquals((await store.getRun(run.id))?.state, "cancelled");
  assertEquals((await store.getRun(run.id))?.result, null);
  assertEquals(revoked, [run.id]);
  assertEquals((await store.listEvents(run.id)).map((e) => e.kind), [
    "kill-requested",
    "cancel-confirmed",
  ]);
});

test("a pre-start cancel with a gone container ends even before the cancel grace", async () => {
  const store = memoryTaskStore();
  const { provisioner } = fakeProvisioner();
  provisioner.inspect = () => Promise.resolve("exited");
  const run = makeRun({ desiredState: "cancelled", cancelRequestedAt: T0 });
  await store.saveRun(run);
  await sweep({ store, provisioner, diag: silentDiagnostics(), now: fakeClock().now }, CFG);
  assertEquals((await store.getRun(run.id))?.state, "cancelled");
});

test("unknown runtime retries failed cancel kills without duplicating the event, then cancels at timeout", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner } = fakeProvisioner();
  let fail = true;
  provisioner.kill = () =>
    fail ? Promise.reject(new Error("runtime unavailable")) : Promise.resolve();
  const run = makeRun({ desiredState: "cancelled", cancelRequestedAt: T0 });
  await store.saveRun(run);
  const deps = { store, provisioner, diag: silentDiagnostics(), now: clock.now };
  clock.advance(121_000);
  await sweep(deps, CFG);
  await sweep(deps, CFG);
  assertEquals((await store.listEvents(run.id)).map((e) => e.kind), ["kill-requested"]);
  clock.advance(180_000);
  await sweep(deps, CFG);
  assertEquals((await store.getRun(run.id))?.state, "starting");
  fail = false;
  await sweep(deps, CFG);
  assertEquals((await store.getRun(run.id))?.state, "cancelled");
});

for (const during of ["inspect", "exit-kill", "timeout-kill"] as const) {
  for (const arrival of ["heartbeat", "result"] as const) {
    test(`pre-start cancellation preserves a ${arrival} arriving during ${during}`, async () => {
      const store = memoryTaskStore();
      const clock = fakeClock();
      const { provisioner } = fakeProvisioner();
      const run = makeRun({
        desiredState: "cancelled",
        cancelRequestedAt: T0,
        // As a stored row reads them: the save below is the insert that writes the defaults.
        declaredOutcome: null,
        agentFinished: false,
        modelScope: {
          providerKeyId: "pk-1",
          provider: "anthropic",
          allowedModels: "*",
          model: null,
          thinking: null,
        },
      });
      await store.saveRun(run);
      if (during === "timeout-kill") clock.advance(CFG.startupGraceMs + 1);
      const at = clock.now().toISOString();
      const update = arrival === "heartbeat"
        ? applyHeartbeat(run, { seq: 0, phase: "running" }, at)
        : applyResult(run, { status: "success", summary: "runner finished", branches: [] }, at);
      assert(update.kind === "applied");
      const landUpdate = async () => {
        if (arrival === "heartbeat") await store.saveHeartbeat(update.run);
        else await store.saveRunResult(update.run);
        for (const event of update.events) await store.appendEvent(event);
      };
      provisioner.inspect = async () => {
        if (during === "inspect") await landUpdate();
        return during === "timeout-kill" ? "unknown" : "exited";
      };
      provisioner.kill = async () => {
        if (during !== "inspect") await landUpdate();
      };
      const revoked: string[] = [];
      const deps = {
        store,
        provisioner,
        diag: silentDiagnostics(),
        now: clock.now,
        modelAccess: {
          revokeRunCredentials: (id: string) => {
            revoked.push(id);
            return Promise.resolve();
          },
        },
      };
      await sweep(deps, CFG);
      assertEquals(await store.getRun(run.id), update.run);
      assertEquals(await store.listEvents(run.id), update.events);
      assertEquals(revoked, []);

      // A heartbeat that won the race leaves an active run after the hard kill. Do not
      // guess cancelled: allow the report to arrive, otherwise the normal silence rule wins.
      if (arrival === "heartbeat") {
        provisioner.kill = () => Promise.resolve();
        clock.advance(CFG.heartbeatTimeoutMs + 1);
        await sweep(deps, CFG);
        assertEquals((await store.getRun(run.id))?.state, "lost");
        assertEquals(revoked, [run.id]);
      }
    });
  }
}

test("sweep persists the lost verdict and hard-kills the leftover container", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, kills } = fakeProvisioner();
  const run = makeRun({ state: "running", lastHeartbeatAt: clock.now().toISOString() });
  await store.saveRun(run);

  clock.advance(61_000);
  await sweep({ store, provisioner, diag: silentDiagnostics(), now: clock.now }, CFG);

  assertEquals((await store.getRun(run.id))?.state, "lost");
  assertEquals(kills, [{ handle: "h-test", graceful: false }]);
  assertEquals((await store.listEvents(run.id)).map((e) => e.kind), ["marked-lost"]);
});

test("a lost verdict revokes the run's credentials, the way a reported one does", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner } = fakeProvisioner();
  const revoked: Record<string, string[]> = { model: [], tool: [] };
  const revoker = (which: string) => ({
    revokeRunCredentials(runId: string) {
      revoked[which].push(runId);
      return Promise.resolve();
    },
  });
  const run = makeRun({
    state: "running",
    lastHeartbeatAt: clock.now().toISOString(),
    modelScope: {
      providerKeyId: "pk-1",
      provider: "anthropic",
      allowedModels: "*",
      model: null,
      thinking: null,
    },
    forgeScope: null,
    networkScope: { mode: "open", bundles: [], hosts: [] },
    limits: NO_RUN_LIMITS,
    egressRefusals: null,
    skills: null,
    toolScope: { servers: [{ serverId: "ms-1", allowedTools: "*" }] },
  });
  // The git key a task mints at provision time — the third credential a conclusion must kill.
  await store.createTask(
    {
      id: "t-test",
      agentId: "a-test",
      spec: { title: "t", instructions: "i" },
      repos: [{
        connectedRepoId: "cr-1",
        name: "u",
        url: "u",
        ref: "main",
        path: "repo",
        branchNamespace: "ryph/ada/r-test",
        description: null,
      }],
      workspaceId: null,
      origin: "break-glass",
      requestedByUserId: null,
      requestedVia: null,
      chatConversation: null,
      targetChangeRequest: null,
      landings: {},
      lifetime: { idleMs: 300_000, attendedIdleMs: 1_800_000 },
      purpose: null,
      createdAt: T0,
    },
    run,
    {
      id: "gk-1",
      runId: run.id,
      tokenHash: "git-hash",
      expiresAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null,
      createdAt: T0,
    },
  );

  clock.advance(61_000);
  await sweep(
    {
      store,
      provisioner,
      diag: silentDiagnostics(),
      modelAccess: revoker("model"),
      toolAccess: revoker("tool"),
      now: clock.now,
    },
    CFG,
  );

  assertEquals((await store.getRun(run.id))?.state, "lost");
  assertEquals(revoked, { model: [run.id], tool: [run.id] });
  assertEquals(
    (await store.getGitKeyByTokenHash("git-hash"))?.revokedAt,
    "2026-01-01T00:01:01.000Z",
  );
});

test("the sweep reconciles the runtime against the active set — including after success", async () => {
  // The bug this pins: `kill` is reached only by mark-lost and kill-graceful, so a run that
  // simply FINISHES is never killed. On docker that left its service containers running and
  // its per-run network allocated until the control plane next restarted — the happy path
  // leaking, and the ~31-network address pool exhausted on success rather than on failure.
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, kills } = fakeProvisioner();
  const reconciled: string[][] = [];
  const deps = {
    store,
    provisioner,
    diag: silentDiagnostics(),
    now: clock.now,
    reconcile: async (listActiveRunIds: () => Promise<string[]>) => {
      reconciled.push(await listActiveRunIds());
    },
  };

  const live = makeRun({
    id: "r-live",
    state: "running",
    lastHeartbeatAt: clock.now().toISOString(),
  });
  const done = makeRun({ id: "r-done", state: "succeeded" });
  await store.saveRun(live);
  await store.saveRun(done);

  await sweep(deps, CFG);
  // Nothing was killed — the live run is behaving and the finished one is out of the active
  // set — and the reconcile still ran, naming only the live one. That is what makes the
  // finished run's containers and network reclaimable at all: `kill` never sees it.
  assertEquals(kills, []);
  assertEquals(reconciled, [[live.id]]);

  // The reconcile reads the store when it asks, not the tick's opening snapshot — so a run
  // marked lost during this very tick is already out of the set it sees.
  clock.advance(61_000);
  await sweep(deps, CFG);
  assertEquals(reconciled.at(-1), []);
});

test("a launch landing mid-sweep is active to the reconcile, so its network survives", async () => {
  // The race this pins: the sweep lists active runs at the top of its tick, a task starts and
  // creates its network while the loop is still running, and a reconcile handed that opening
  // snapshot reclaims a healthy launch. The lister reads the store at the moment it is called.
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner } = fakeProvisioner();
  let seen: string[] = [];
  await sweep({
    store,
    provisioner,
    diag: silentDiagnostics(),
    now: clock.now,
    reconcile: async (listActiveRunIds) => {
      // start_task writes the row before `launch` creates anything, after the snapshot.
      await store.saveRun(makeRun({ id: "r-launching" }));
      seen = await listActiveRunIds();
    },
  }, CFG);
  assertEquals(seen, ["r-launching"]);
});

test("a failing reconcile never costs the liveness sweep", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, kills } = fakeProvisioner();
  const run = makeRun({ state: "running", lastHeartbeatAt: clock.now().toISOString() });
  await store.saveRun(run);

  clock.advance(61_000);
  await sweep({
    store,
    provisioner,
    diag: silentDiagnostics(),
    now: clock.now,
    reconcile: () => Promise.reject(new Error("docker is not running")),
  }, CFG);

  // Reclaiming leftovers is housekeeping; deciding a run is lost is not.
  assertEquals((await store.getRun(run.id))?.state, "lost");
  assertEquals(kills, [{ handle: "h-test", graceful: false }]);
});

test("planSweep counts a run's startup grace from launch, not from creation", () => {
  // The shape this guards against: a run waits 13 minutes for its environment to
  // build, then launches. Measured from creation the whole wait reads as silence and the run is
  // lost in the second it started — which killed every run that waited out a build, the wait
  // being the feature. Measured from launch it has its full grace, as any other run does.
  const waitedMs = 13 * 60_000;
  const launchedAt = new Date(Date.parse(T0) + waitedMs).toISOString();
  const justLaunched = { ...makeRun(), handle: "c-1", launchedAt, environmentWait: null };

  const atLaunch = planSweep(justLaunched, Date.parse(launchedAt) + 1_000, CFG);
  assertEquals(atLaunch.kind, "none");
  // Still inside the grace, though far past it when counted from createdAt.
  const midGrace = planSweep(justLaunched, Date.parse(launchedAt) + 299_000, CFG);
  assertEquals(midGrace.kind, "none");
  // And a container that genuinely never comes up is still given up on, on the same clock.
  const dead = planSweep(justLaunched, Date.parse(launchedAt) + 301_000, CFG);
  assertEquals(dead.kind, "mark-lost");
});

test("planSweep still counts from creation for a run that never launched", () => {
  // No handle means nothing was ever asked to exist, so creation IS the zero — and a row
  // written before `launchedAt` existed falls back to the same place rather than never expiring.
  const neverLaunched = { ...makeRun(), handle: null, launchedAt: null };
  assertEquals(planSweep(neverLaunched, Date.parse(T0) + 301_000, CFG).kind, "mark-lost");
});

// ── the limit arms ─────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;

test("planSweep cancels a run past its wall clock, counted from launch and never from creation", () => {
  const launched = new Date(Date.parse(T0) + 10 * 60_000).toISOString();
  const run = makeRun({
    state: "running",
    launchedAt: launched,
    limits: { ...NO_RUN_LIMITS, wallClockMs: HOUR },
  });
  const beating = (nowMs: number) => ({
    ...run,
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  });
  // An hour after CREATION is fifty minutes after launch: nothing yet.
  assertEquals(
    planSweep(beating(Date.parse(T0) + HOUR + 1), Date.parse(T0) + HOUR + 1, CFG).kind,
    "none",
  );
  const nowMs = Date.parse(launched) + HOUR + 1;
  const action = planSweep(beating(nowMs), nowMs, CFG);
  assert(action.kind === "limit-reached");
  assertEquals(action.run.desiredState, "cancelled");
  assertEquals(action.run.cancelRequestedAt, new Date(nowMs).toISOString());
  assertEquals(action.events.map((e) => [e.kind, e.detail]), [
    ["limit-reached", "wall-clock: 1h"],
    ["cancel-requested", undefined],
  ]);
});

test("no wall-clock arm without a cap, before launch, or on a run already asked to cancel", () => {
  const late = Date.parse(T0) + 2 * HOUR;
  const beat = new Date(late).toISOString();
  const capped = { ...NO_RUN_LIMITS, wallClockMs: HOUR };
  assertEquals(
    planSweep(makeRun({ state: "running", launchedAt: T0, lastHeartbeatAt: beat }), late, CFG).kind,
    "none",
  );
  assertEquals(
    planSweep(makeRun({ state: "running", lastHeartbeatAt: beat, limits: capped }), late, CFG).kind,
    "none",
  );
  const cancelling = makeRun({
    state: "running",
    launchedAt: T0,
    lastHeartbeatAt: beat,
    limits: capped,
    desiredState: "cancelled",
    cancelRequestedAt: beat,
  });
  assertEquals(planSweep(cancelling, late, CFG).kind, "none");
});

test("planSweep cancels a run at its spend cap and names the amount; a null read cancels nothing", () => {
  const run = makeRun({
    state: "running",
    launchedAt: T0,
    lastHeartbeatAt: T1,
    limits: { ...NO_RUN_LIMITS, spendUsd: 20 },
  });
  const nowMs = Date.parse(T1);
  assertEquals(planSweep(run, nowMs, CFG, 19.99).kind, "none");
  assertEquals(planSweep(run, nowMs, CFG, null).kind, "none");
  const action = planSweep(run, nowMs, CFG, 20);
  assert(action.kind === "limit-reached");
  assertEquals(action.events[0].detail, "spend: $20.00");
  // An uncapped run is never over, whatever the proxy says it spent.
  assertEquals(
    planSweep(makeRun({ state: "running", lastHeartbeatAt: T1 }), nowMs, CFG, 1e6).kind,
    "none",
  );
});

test("silence wins over a limit: a run past its wall clock that stopped beating is lost", () => {
  const run = makeRun({
    state: "running",
    launchedAt: T0,
    lastHeartbeatAt: T0,
    limits: { ...NO_RUN_LIMITS, wallClockMs: 30_000 },
  });
  assertEquals(planSweep(run, Date.parse(T0) + 61_000, CFG).kind, "mark-lost");
});

test("sweep applies a reached limit like an idle expiry, and asks spendOf only for capped runs", async () => {
  const store = memoryTaskStore();
  const clock = fakeClock();
  const { provisioner, kills } = fakeProvisioner();
  const asked: string[] = [];
  const modelAccess = {
    revokeRunCredentials: () => Promise.resolve(),
    spendOf: (runId: string) => {
      asked.push(runId);
      return Promise.resolve(runId === "r-capped" ? 5 : 0);
    },
  };
  const pushed: string[] = [];
  const runnerControl = {
    requestCancel: (target: CancelTarget) => {
      pushed.push(target.id);
      return Promise.resolve(true);
    },
  };
  const beat = clock.now().toISOString();
  await store.saveRun(makeRun({
    id: "r-capped",
    state: "running",
    launchedAt: beat,
    lastHeartbeatAt: beat,
    limits: { ...NO_RUN_LIMITS, spendUsd: 5 },
  }));
  await store.saveRun(makeRun({
    id: "r-free",
    state: "running",
    launchedAt: beat,
    lastHeartbeatAt: beat,
  }));
  // Capped, but the plan could not act on the figure: not launched yet, or already stopping.
  await store.saveRun(makeRun({
    id: "r-unlaunched",
    state: "starting",
    launchedAt: null,
    limits: { ...NO_RUN_LIMITS, spendUsd: 5 },
  }));
  await store.saveRun(makeRun({
    id: "r-stopping",
    state: "running",
    launchedAt: beat,
    lastHeartbeatAt: beat,
    desiredState: "cancelled",
    cancelRequestedAt: beat,
    limits: { ...NO_RUN_LIMITS, spendUsd: 5 },
  }));

  await sweep({
    store,
    provisioner,
    diag: silentDiagnostics(),
    modelAccess,
    runnerControl,
    now: clock.now,
  }, CFG);

  assertEquals(
    asked,
    ["r-capped"],
    "spend is read only for a capped run the plan could cancel over it",
  );
  const capped = (await store.getRun("r-capped"))!;
  assertEquals(capped.state, "running");
  assertEquals(capped.desiredState, "cancelled");
  assertEquals((await store.listEvents("r-capped")).map((e) => e.kind), [
    "limit-reached",
    "cancel-requested",
    "cancel-pushed",
  ]);
  assertEquals(pushed, ["r-capped"]);
  assertEquals((await store.getRun("r-free"))?.desiredState, null);
  assertEquals(kills, [], "a reached limit is a cancel, never a kill");

  // A proxy that cannot answer is a warning and no cancel: the run keeps running, and the
  // proxy's own refusal bounds it until the sweep can count again.
  const broken = { ...modelAccess, spendOf: () => Promise.reject(new Error("down")) };
  await store.saveRun(makeRun({
    id: "r-blind",
    state: "running",
    launchedAt: beat,
    lastHeartbeatAt: beat,
    limits: { ...NO_RUN_LIMITS, spendUsd: 1 },
  }));
  await sweep({
    store,
    provisioner,
    diag: silentDiagnostics(),
    modelAccess: broken,
    now: clock.now,
  }, CFG);
  assertEquals((await store.getRun("r-blind"))?.desiredState, null);
});

test("the work item's harness carries the run's model and thinking level, only where chosen", () => {
  // Only what composeWorkItem reads of a task.
  const task = {
    spec: { title: "t", instructions: "do it" },
    lifetime: { idleMs: DEFAULT_IDLE_MS, attendedIdleMs: DEFAULT_IDLE_MS },
    origin: "user",
    purpose: null,
  } as unknown as Task;
  const agent = {
    ...AGENT,
    harnessKind: "pi",
    modelPolicy: {
      providerKeyId: "pk-1",
      provider: "anthropic",
      allowedModels: "*" as const,
      defaultModel: null,
      defaultThinking: null,
    },
  };
  assertEquals(
    composeWorkItem(task, agent, "r-1", [], { model: "claude-sonnet-5", thinking: "xhigh" })
      .harness,
    { kind: "pi", provider: "anthropic", model: "claude-sonnet-5", thinking: "xhigh" },
  );
  // A level without a model: the harness's default model, at the level asked.
  assertEquals(
    composeWorkItem(task, agent, "r-1", [], { model: null, thinking: "low" }).harness,
    { kind: "pi", provider: "anthropic", thinking: "low" },
  );
  // Neither chosen: nothing rides the wire, and the harness keeps its own defaults.
  assertEquals(composeWorkItem(task, agent, "r-1", []).harness, {
    kind: "pi",
    provider: "anthropic",
  });
});

test("finalizing is the last phase: a later beat that names another does not move the run back", () => {
  const run = makeRun({ state: "running", phase: "running" });
  const last = applyHeartbeat(run, { seq: 1, phase: "finalizing" }, T1);
  assert(last.kind === "applied");
  assertEquals(last.events.map((e) => [e.kind, e.detail]), [["phase-changed", "finalizing"]]);
  const back = applyHeartbeat(last.run, {
    seq: 2,
    phase: "running",
    idleDeadlineAt: "2026-01-01T00:05:00.000Z",
    idleState: "idle",
  }, T1);
  assert(back.kind === "applied");
  assertEquals([back.run.phase, back.run.idleState, back.events], ["finalizing", null, []]);
});
