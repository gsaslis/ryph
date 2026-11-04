// The store decorator that announces a run's conclusion, in isolation. The composition roots
// (host, and any split-out historian later) close it over the historian's `concludeRun`; here a
// spy stands in for that signal, so the wrapper's one job — fire on terminal saves, stay silent
// otherwise, always after the write lands — is pinned without dragging the historian in.

import { test } from "bun:test";
import { assert, assertEquals } from "@std/assert";
import { NO_RUN_LIMITS, type Run, type RunEnvironmentWait } from "../src/core/types.ts";
import { concludeOnTerminal } from "../src/conclude_on_terminal.ts";
import { memoryTaskStore } from "./memory_store.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  const T0 = "2026-01-01T00:00:00.000Z";
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

test("a terminal save announces the run; a non-terminal save stays silent", async () => {
  const concluded: string[] = [];
  const store = concludeOnTerminal(memoryTaskStore(), (id) => concluded.push(id));

  await store.saveRun(makeRun({ id: "r-1", state: "starting" }));
  await store.saveHeartbeat(makeRun({ id: "r-1", state: "running", heartbeatSeq: 0 }));
  assertEquals(concluded, [], "a run still in flight must not be announced");

  await store.saveRunResult(makeRun({ id: "r-1", state: "succeeded" }));
  assertEquals(concluded, ["r-1"], "reaching a terminal state announces exactly once");
  assertEquals(
    await store.saveRunTransition(
      makeRun({ id: "r-1", state: "lost" }),
      makeRun({ id: "r-1", state: "running", heartbeatSeq: 0 }),
    ),
    null,
  );
  assertEquals(await store.saveRunResult(makeRun({ id: "r-1", state: "failed" })), null);
  assertEquals(concluded, ["r-1"], "refused transitions and results do not announce");
});

test("every terminal state announces, and the write lands first", async () => {
  const concluded: string[] = [];
  const inner = memoryTaskStore();
  const store = concludeOnTerminal(inner, (id) => {
    // The notification must fire AFTER the write, so a client reloading on the signal reads the
    // final state — assert the row is already persisted terminal at announce time.
    concluded.push(id);
  });

  for (const state of ["failed", "errored", "cancelled", "lost"] as const) {
    const live = makeRun({ id: `r-${state}`, state: "running" });
    await store.saveRun(live);
    await store.saveRunTransition({ ...live, state }, live);
    assertEquals((await inner.getRun(`r-${state}`))?.state, state);
  }
  assertEquals(concluded, ["r-failed", "r-errored", "r-cancelled", "r-lost"]);
});

test("the wrapper leaves the rest of the store untouched", async () => {
  const store = concludeOnTerminal(memoryTaskStore(), () => {});
  await store.saveRun(makeRun({ id: "r-2", state: "running" }));
  const back = await store.getRun("r-2");
  assert(back !== null);
  assertEquals(back.id, "r-2");
  assertEquals(back.state, "running");
});

test("a landed terminal claim on a waiting run announces; a losing claim does not", async () => {
  const concluded: string[] = [];
  const inner = memoryTaskStore();
  const store = concludeOnTerminal(inner, (id) => concluded.push(id));
  const wait: RunEnvironmentWait = { environmentId: "env-1", status: "building" };
  const waiting = makeRun({ id: "r-wait", state: "starting", handle: null, environmentWait: wait });
  await inner.saveRun(waiting);

  // A cancel while the build runs: the claim lands, the run is over, the historian hears it.
  const cancelled = { ...waiting, state: "cancelled" as const, environmentWait: null };
  assert(await store.saveRunIfWaiting(cancelled, "env-1"));
  assertEquals((await inner.getRun("r-wait"))?.state, "cancelled");
  assertEquals(concluded, ["r-wait"]);

  // The reaper read the same waiting run and tries to refuse it: its claim loses, nothing fires.
  const refused = { ...waiting, state: "errored" as const, environmentWait: null };
  assertEquals(await store.saveRunIfWaiting(refused, "env-1"), false);
  assertEquals(concluded, ["r-wait"], "a losing claim must not announce");
});

test("a landed non-terminal claim on a waiting run stays silent", async () => {
  const concluded: string[] = [];
  const inner = memoryTaskStore();
  const store = concludeOnTerminal(inner, (id) => concluded.push(id));
  const wait: RunEnvironmentWait = { environmentId: "env-2", status: "building" };
  const waiting = makeRun({ id: "r-go", state: "starting", handle: null, environmentWait: wait });
  await inner.saveRun(waiting);

  // The build settled and the run launches: still in flight, so no conclusion.
  assert(
    await store.saveRunIfWaiting({ ...waiting, handle: "h-1", environmentWait: null }, "env-2"),
  );
  assertEquals(concluded, []);
});
