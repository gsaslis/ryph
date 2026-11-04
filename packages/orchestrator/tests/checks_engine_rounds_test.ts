// The checks engine under load and at its edges: a slow forge, many waiting suites, repos
// competing for slots, a launch slower than its lease, the last attempt, a check that failed on
// its own account beside a platform fault, a re-run that lands on another suite, a setup step
// that never ends. The fake launcher and forge of tests/checks_world.ts throughout.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeChecksService } from "../src/core/checks.ts";
import type { CheckSuite } from "../src/core/check_types.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";
import type { CheckLauncher } from "../src/ports/check_launcher.ts";
import type { Environment } from "../src/core/types.ts";
import { sha256Hex } from "@ryph/sealed";
import { APP_URL, BASE, checksFile, checksWorld, sha, T0 } from "./checks_world.ts";
import { tree } from "./environment_world.ts";
import { fakeCheckLauncher } from "./check_doubles.ts";

type World = Awaited<ReturnType<typeof checksWorld>>;

/** A second control plane over the same store, with a launcher of its own. */
function replica(w: World, launcher: CheckLauncher) {
  return makeChecksService({
    store: w.checkStore,
    tasks: w.store,
    launcher,
    forge: w.forge,
    environments: null,
    logs: w.logs,
    diag: w.diag,
    now: w.clock.now,
    config: {
      policy: w.policy,
      agentImage: w.config.agentImage,
      runSizes: w.config.runSizes,
      gitGateway: w.config.gitGateway,
      services: DEFAULT_SERVICE_POLICY,
      egress: w.config.egress,
      appUrl: APP_URL,
    },
  });
}

/** A suite written straight into the store, shaped like `template`. */
function plant(w: World, template: CheckSuite, over: Partial<CheckSuite>): CheckSuite {
  const suite: CheckSuite = structuredClone({ ...template, ...over });
  w.checkStore.suites.set(suite.id, suite);
  return suite;
}

/** A ready build of the base's `.ryph/` tree `a`, in the store. */
async function readyEnvironment(w: World): Promise<Environment> {
  const env: Environment = {
    id: "env-ready",
    subjectKind: "repo",
    subjectId: w.api.id,
    ref: "main",
    defaultBranch: false,
    commits: { api: sha("a") },
    definition: tree("a"),
    baseDigest: "base@x",
    harnessDigest: "harness@x",
    image: `registry.test/x@sha256:${"9".repeat(64)}`,
    bakedImage: null,
    machineImage: null,
    status: "ready",
    toolchains: {},
    sizeBytes: null,
    trigger: "check",
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
    startedAt: T0,
    finishedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
  await w.environmentStore.createEnvironment(env);
  return env;
}

/** The token a launch handed its clone, from the spec's extraheader. */
const tokenOf = (header: string) => atob(header.replace("Authorization: Basic ", "")).split(":")[1];

test(
  "a slow forge costs the tick its reads, never its launches, polls and settles",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    // Ten more asks, and every read at the base takes the forge a minute.
    const read = w.forge.readChecksFile;
    w.forge.readChecksFile = (...args) => {
      w.clock.advance(60_000);
      return read(...args);
    };
    for (const [i, c] of [..."123456789b"].entries()) {
      // Stored, so the release sweep finds their patches alive and keeps their pending asks.
      const patch = w.patchOf({ id: `p-${i}`, setId: `ps-${i}`, headSha: sha(c) });
      await w.store.createPatch(patch);
      await w.service.patchOpened(patch);
    }
    const before = w.reads.length;
    await w.service.tick();
    assertEquals((await w.checkStore.getSuite(suite.id))!.state, "passed", "settled first");
    assertEquals(w.reads.length - before, 4, "one round of four reads, then the budget is spent");
    // The rest are read on the ticks after.
    await w.service.tick();
    await w.service.tick();
    assertEquals(w.reads.length - before, 10);
  },
);

test(
  "a waiting suite's read of its base is under the forge budget, after the settles",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const running = w.onlySuite();
    w.launched.finish(w.nameOf(running), { lint: 0, test: 0 });
    // Six suites with no build to wait on yet: each reads its base's `.ryph/` tree to ask for one,
    // and every read takes the forge a minute.
    for (let i = 0; i < 6; i++) {
      plant(w, running, {
        id: `cs-w${String(i).padStart(8, "0")}`,
        commit: sha(String(i)),
        state: "waiting",
        image: null,
        environmentKey: `tree:${tree("a")}`,
        environmentId: null,
        waitingSince: T0,
      });
    }
    const read = w.forge.ryphTree;
    const settledFirst: boolean[] = [];
    w.forge.ryphTree = async (...args) => {
      settledFirst.push((await w.checkStore.getSuite(running.id))!.state === "passed");
      w.clock.advance(60_000);
      return read(...args);
    };
    await w.service.tick();
    assertEquals((await w.checkStore.getSuite(running.id))!.state, "passed");
    assert(settledFirst.length > 0 && settledFirst.every(Boolean), "no read before the settle");
    // One base, so one worker: two reads, then the budget is spent.
    assertEquals(settledFirst.length, 2);
    // The rest on the ticks after, until every one was looked at.
    await w.service.tick();
    await w.service.tick();
    assertEquals(settledFirst.length, 6);
    assertEquals(w.suites().filter((s) => s.state === "waiting").length, 0);
  },
);

test("waiting suites are paged by id, so every one is looked at within two ticks", async () => {
  const w = await checksWorld();
  await w.request();
  const template = w.onlySuite();
  w.checkStore.suites.clear();
  const env = await readyEnvironment(w);
  // Sixty waiting suites, the higher the id the longer since it was written.
  for (let i = 0; i < 60; i++) {
    plant(w, template, {
      id: `cs-${String(i).padStart(10, "0")}`,
      commit: sha(String(i % 10)),
      state: "waiting",
      image: null,
      environmentKey: `tree:${tree("a")}`,
      environmentId: env.id,
      waitingSince: T0,
      updatedAt: new Date(Date.parse(T0) - i * 1000).toISOString(),
    });
  }
  await w.service.tick();
  await w.service.tick();
  assertEquals(w.suites().filter((s) => s.state === "waiting").length, 0);
});

test(
  "a read of a base that hangs holds up neither the reports nor a build that is ready",
  async () => {
    const w = await checksWorld();
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    await w.service.tick();
    const running = w.onlySuite();
    assertEquals(running.state, "running");
    const env = await readyEnvironment(w);
    // One waiting suite with no build yet, whose base the forge never answers for; one whose
    // build is ready. And the running suite settles, so its report is due.
    const stuck = plant(w, running, {
      id: "cs-stuck",
      commit: sha("1"),
      state: "waiting",
      image: null,
      environmentKey: `tree:${tree("b")}`,
      environmentId: null,
      waitingSince: T0,
    });
    const ready = plant(w, stuck, {
      id: "cs-ready",
      commit: sha("2"),
      environmentKey: `tree:${tree("a")}`,
      environmentId: env.id,
    });
    w.launched.finish(w.nameOf(running), { lint: 0, test: 0 });
    const before = w.reports.length;
    let reportedWhileHanging = false;
    let queuedWhileHanging = false;
    w.forge.ryphTree = async () => {
      // Hangs until the tick's other work is done, or long enough to say it never was.
      for (let i = 0; i < 2_000 && w.reports.length === before; i++) {
        await new Promise((done) => setTimeout(done, 1));
      }
      reportedWhileHanging = w.reports.length > before;
      queuedWhileHanging = (await w.checkStore.getSuite(ready.id))!.state === "queued";
      w.clock.advance(120_000);
      throw new Error("the forge did not answer in time");
    };
    await w.service.tick();
    assert(reportedWhileHanging, "the report went out while the read hung");
    assert(queuedWhileHanging, "the ready build was followed before the read");
    assertEquals(w.reports.at(-1)!.suite.state, "passed");
    // The failed read is said on the suite, and not tried again before its backoff.
    const after = (await w.checkStore.getSuite(stuck.id))!;
    assertStringIncludes(after.reason!, "the forge did not answer in time");
    assert(after.nextAttemptAt !== null);
    let reads = 0;
    w.forge.ryphTree = () => {
      reads++;
      return Promise.reject(new Error("still down"));
    };
    await w.service.tick();
    assertEquals(reads, 0, "backing off");
    w.clock.advance(30 * 60_000);
    await w.service.tick();
    assertEquals(reads, 1);
  },
);

test("more waiting suites than a page are all read, backed off and given up on", async () => {
  const w = await checksWorld();
  await w.request();
  const template = w.onlySuite();
  w.checkStore.suites.clear();
  for (let i = 0; i < 60; i++) {
    plant(w, template, {
      id: `cs-${String(i).padStart(10, "0")}`,
      commit: sha(String(i % 10)),
      state: "waiting",
      image: null,
      environmentKey: `tree:${tree("a")}`,
      environmentId: null,
      waitingSince: T0,
    });
  }
  const read = new Set<string>();
  w.forge.ryphTree = () => Promise.reject(new Error("forge down"));
  const lookedAt = () =>
    w.suites().filter((s) => s.reason?.includes("forge down") && s.nextAttemptAt !== null);
  await w.service.tick();
  for (const s of lookedAt()) read.add(s.id);
  assert(read.size < 60, "one page on the first tick");
  await w.service.tick();
  for (const s of lookedAt()) read.add(s.id);
  assertEquals(read.size, 60, "the next page on the next");
  // A day on, every one is given up on, a page a tick.
  w.clock.advance(24 * 60 * 60_000);
  await w.service.tick();
  await w.service.tick();
  assertEquals(w.suites().filter((s) => s.state === "waiting").length, 0);
  assert(w.suites().every((s) => s.state === "error" && s.reason!.includes("within a day")));
});

test(
  "slots are shared: repos take turns, and one holds at most half while another waits",
  async () => {
    const w = await checksWorld({ policy: { maxConcurrent: 4 } });
    await w.request();
    const template = w.onlySuite();
    w.checkStore.suites.clear();
    const queued = (repo: string, i: number) =>
      plant(w, template, {
        id: `cs-${repo}${String(i).padStart(7, "0")}`,
        connectedRepoId: repo === "api" ? w.api.id : w.web.id,
        commit: sha(String(i)),
        state: "queued",
        // The api's suites have waited longest.
        updatedAt: new Date(Date.parse(T0) + (repo === "api" ? i : 100 + i) * 1000).toISOString(),
      });
    for (let i = 0; i < 6; i++) queued("api", i);
    for (let i = 0; i < 3; i++) queued("web", i);
    await w.service.tick();
    const running = () => w.suites().filter((s) => s.state === "running");
    const byRepo = (repoId: string) => running().filter((s) => s.connectedRepoId === repoId).length;
    assertEquals([byRepo(w.api.id), byRepo(w.web.id)], [2, 2], "turns, oldest first in each");
    assertEquals(
      running().map((s) => s.id).sort(),
      ["cs-api0000000", "cs-api0000001", "cs-web0000000", "cs-web0000001"],
    );

    // Two of web's finish: api is at its half while web still has one queued.
    for (const suite of running().filter((s) => s.connectedRepoId === w.web.id)) {
      w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    }
    await w.service.tick(); // settles
    await w.service.tick(); // launches
    assertEquals([byRepo(w.api.id), byRepo(w.web.id)], [3, 1], "then api may take what is left");

    // Nobody else waiting: one repo may fill every slot.
    for (const suite of running().filter((s) => s.connectedRepoId === w.web.id)) {
      w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    }
    await w.service.tick();
    await w.service.tick();
    assertEquals([byRepo(w.api.id), byRepo(w.web.id)], [4, 0]);
  },
);

test(
  "a launch slower than its lease revokes only its own key, never its successor's",
  async () => {
    const w = await checksWorld();
    // This replica's launcher hangs until the test lets it fail.
    let fail!: (err: Error) => void;
    const slow: CheckLauncher = {
      ...w.launched.launcher,
      launch: () => new Promise((_, reject) => (fail = reject)),
    };
    const stuck = replica(w, slow);
    await w.request();
    const hung = stuck.tick();
    await new Promise((r) => setTimeout(r, 10));
    const suite = w.onlySuite();
    assertEquals(suite.state, "running");
    // Past its lease, another replica finds no pod, and launches again.
    w.clock.advance(11 * 60_000);
    await w.service.tick();
    await w.service.tick();
    assertEquals(w.launched.specs.length, 1, "the successor launched");
    const token = tokenOf(w.launched.specs[0].clone.env.GIT_CONFIG_VALUE_0);
    assert(await w.service.gitGrant(await sha256Hex(token)) !== null);
    // The first launch finally fails: the successor's key still resolves.
    fail(new Error("the API server timed out"));
    await hung;
    assert(await w.service.gitGrant(await sha256Hex(token)) !== null, "the successor's key");
    assertEquals(w.onlySuite().attempts, 2);
  },
);

test(
  "the last attempt settles with the checks' own verdicts; only the faulted one is error",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.checkStore.suites.set(suite.id, { ...suite, attempts: 3 });
    w.launched.finish(w.nameOf(suite), { lint: { exitCode: 137, reason: "Evicted" }, test: 0 });
    await w.service.tick();
    const settled = w.onlySuite();
    assertEquals(settled.state, "error");
    assertEquals(
      (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
      [["lint", "error"], ["test", "passed"]],
    );
    assertEquals(w.launched.specs.length, 1, "not relaunched");
  },
);

test("a check that failed on its own account is never relaunched away", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  // Over its disk share (the launcher's own exit 1), and its sibling evicted with it.
  w.launched.finish(w.nameOf(suite), {
    lint: { exitCode: 1, reason: "used more disk than its share (2Gi)" },
    test: { exitCode: 125, reason: "Evicted" },
  });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertStringIncludes(settled.reason!, "lint used more disk than its share (2Gi)");
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
    [["lint", "failed"], ["test", "error"]],
  );
  assertEquals(w.launched.specs.length, 1);
});

test("the engine waits out a pod's scheduling before it calls the deadline", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const deadlineMs = w.launched.specs[0].deadlineSeconds * 1000;
  // Past the deadline counted from the launch, but a pod may start ten minutes after it.
  w.clock.advance(deadlineMs + 6 * 60_000);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running");
  w.clock.advance(7 * 60_000);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "error");
});

test(
  "a setup step still running past the deadline is the head's hang, as on kubernetes",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    const pending = { kind: "pending" as const, cloneDone: true, why: "setup-0", running: 0 };
    w.launched.inspections.set(w.nameOf(suite), pending);
    w.clock.advance(2 * 60 * 60_000);
    await w.service.tick();
    const settled = w.onlySuite();
    assertEquals(settled.state, "failed");
    assertStringIncludes(settled.reason!, "setup step 1 ran past the suite's deadline");
    assertEquals(
      (await w.checkStore.listResults(suite.id, 1)).map((r) => r.state),
      ["setup_failed", "setup_failed"],
    );
  },
);

test("a newer ryph__run_checks sets an earlier settled suite aside, verdict kept", async () => {
  const w = await checksWorld();
  await w.request({ headSha: sha("1") });
  await w.service.tick();
  const first = w.onlySuite();
  w.launched.finish(w.nameOf(first), { lint: 0, test: 1 });
  await w.service.tick();
  const toldBefore = (await w.told()).length;
  await w.request({ headSha: sha("2") });
  const earlier = [...w.checkStore.requests.values()].find((r) => r.commit === sha("1"))!;
  assertEquals(earlier.state, "superseded");
  assertEquals((await w.checkStore.getSuite(first.id))!.state, "failed", "not cancelled");
  // Still on the run's record: its status, and the run card's list.
  const { text } = await w.service.statusForRun(w.run);
  assertStringIncludes(text, `${first.id} FAILED`);
  const view = (await w.service.view(first.id, SCOPE_ALL))!;
  assert(view.requestedBy.some((r) => r.runId === w.run.id));
  // A re-run of the old suite is not the run's any more: it hears nothing about that commit.
  const second = w.suites().find((s) => s.commit === sha("2"))!;
  w.launched.finish(w.nameOf((await w.checkStore.getSuite(second.id))!), { lint: 0, test: 0 });
  await w.service.tick();
  await w.service.rerun(first.id, { kind: "user", userId: "u-1" });
  await w.service.tick();
  w.launched.finish(w.nameOf((await w.checkStore.getSuite(first.id))!), { lint: 0, test: 0 });
  await w.service.tick();
  await w.service.tick();
  assertEquals((await w.checkStore.getSuite(first.id))!.state, "passed");
  const told = await w.told();
  assertEquals(told.length, toldBefore + 1, "told about the new commit's suite only");
  assert(!told.at(-1)!.text.includes(first.id));
});

test("the approval queue's suite is the patch's own, as its forge shows", async () => {
  const w = await checksWorld();
  const patch = w.patchOf();
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  const own = w.onlySuite();
  // A newer suite on the same head: the base's checks file changed since.
  w.files.set("*", checksFile({ blob: sha("f") }));
  await w.request();
  assertEquals(w.suites().length, 2);
  assertEquals((await w.service.forPatch(patch))!.id, own.id);
});

test(
  "a re-run that lands on a new suite takes the patch, its run and its forge report along",
  async () => {
    const w = await checksWorld({ services: { ...DEFAULT_SERVICE_POLICY, enabled: true } });
    const yml = "checks:\n  - name: e2e\n    run: x\n    services: [db]\n";
    const declares = (text: string) =>
      checksFile({ text: yml, services: { kind: "file", text: `services:\n${text}` } });
    w.files.set("*", declares("  cache:\n    uses: redis@8\n    port: 6379\n"));
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    const refused = w.onlySuite();
    assertEquals(refused.state, "error");
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.suiteId, refused.id);

    // The base's services.yml fixed, then a re-run: another suite of the same head.
    w.files.set("*", declares("  db:\n    uses: postgres@18\n    port: 5433\n"));
    const outcome = await w.service.rerun(refused.id, { kind: "user", userId: "u-1" });
    assert(outcome.kind === "rerun" && outcome.suite.id !== refused.id);
    const fresh = outcome.suite;
    const [asked] = await w.checkStore.listRequestsForPatches([patch.id]);
    assertEquals(asked.suiteId, fresh.id);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.suiteId, fresh.id);

    await w.service.tick();
    w.launched.finish(w.nameOf((await w.checkStore.getSuite(fresh.id))!), { e2e: 0 });
    await w.service.tick();
    const last = w.reports.at(-1)!;
    assertEquals(last.suiteId, fresh.id);
    assertEquals(last.checks.map((c) => c.conclusion), ["success"]);
    assertStringIncludes((await w.told()).at(-1)!.text, "PASSED");
  },
);

test("a re-run whose base could not be read yet follows once it is, on the tick", async () => {
  const w = await checksWorld({ services: { ...DEFAULT_SERVICE_POLICY, enabled: true } });
  const yml = "checks:\n  - name: e2e\n    run: x\n    services: [db]\n";
  const declares = (text: string) =>
    checksFile({ text: yml, services: { kind: "file", text: `services:\n${text}` } });
  w.files.set("*", declares("  cache:\n    uses: redis@8\n    port: 6379\n"));
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  const refused = w.onlySuite();
  assertEquals(refused.state, "error");

  // The re-run reads the base again, and the forge cannot answer: said as a retry.
  w.files.set("*", { kind: "unavailable", detail: "timed out" });
  const outcome = await w.service.rerun(refused.id, { kind: "user", userId: "u-1" });
  assert(outcome.kind === "refused");
  assertStringIncludes(outcome.why, "tried again on its own");
  assertEquals(w.suites().length, 1);

  // Fixed, and read on a later tick: the patch, its forge row and its run move to the new suite.
  w.files.set("*", declares("  db:\n    uses: postgres@18\n    port: 5433\n"));
  w.clock.advance(60_000);
  await w.service.tick();
  const fresh = w.suites().find((s) => s.id !== refused.id)!;
  assert(fresh !== undefined, "a new suite of the same head");
  const [asked] = await w.checkStore.listRequestsForPatches([patch.id]);
  assertEquals(asked.suiteId, fresh.id);
  assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.suiteId, fresh.id);
});

test(
  "a new generation's report names the one the forge last heard of while it ran",
  async () => {
    const w = await checksWorld();
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.state, "running");
    assertEquals(w.reports.at(-1)!.suite.previousGenerations, undefined);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, [
      { suiteId: suite.id, generation: 1 },
    ]);
    // Its settled report never lands before a re-run starts generation 2.
    w.reportAnswer.fn = () => ({ kind: "failed", message: "flaky", terminal: false });
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "failed");
    await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    w.reportAnswer.fn = null;
    w.clock.advance(60 * 60_000);
    await w.service.tick();
    const gen2 = w.reports.at(-1)!;
    assertEquals([gen2.generation, gen2.suite.previousGenerations], [2, [1]]);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, [
      { suiteId: suite.id, generation: 2 },
    ]);
    // Settled and told: nothing is left open, and nothing older is named again.
    w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
    await w.service.tick();
    const last = w.reports.at(-1)!;
    assertEquals([last.suite.state, last.suite.previousGenerations], ["passed", undefined]);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, []);
  },
);

test(
  "a cancelled generation is left going, and the next one's report finishes it",
  async () => {
    const w = await checksWorld();
    await w.request();
    // A patch with no request of its own yet: born under a minute before the release sweep, so the
    // relays' backstop has not filed one.
    const patch = w.patchOf({
      state: "submitted",
      forgeRef: "7",
      createdAt: "2026-01-01T00:00:30.000Z",
    });
    await w.store.createPatch(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.state, "running");
    await w.store.saveRunResult({ ...w.run, state: "succeeded" });
    w.clock.advance(61_000);
    await w.service.tick();
    assertEquals(w.onlySuite().state, "cancelled");
    await w.service.tick();
    assertEquals(w.reports.at(-1)!.suite.state, "cancelled");
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, [
      { suiteId: suite.id, generation: 1 },
    ]);
    await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    await w.service.tick();
    const gen2 = w.reports.at(-1)!;
    assertEquals([gen2.generation, gen2.suite.previousGenerations], [2, [1]]);
  },
);

test(
  "a pass whose settled report never landed is not named as failed by the next",
  async () => {
    const w = await checksWorld();
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, [
      { suiteId: suite.id, generation: 1 },
    ]);
    w.reportAnswer.fn = () => ({ kind: "failed", message: "flaky", terminal: false });
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "passed");
    await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    w.reportAnswer.fn = null;
    w.clock.advance(60 * 60_000);
    await w.service.tick();
    const gen2 = w.reports.at(-1)!;
    assertEquals([gen2.generation, gen2.suite.previousGenerations], [2, undefined]);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.openGenerations, [
      { suiteId: suite.id, generation: 2 },
    ]);
  },
);

test("a cancelled suite is reported cancelled, neither passed nor failed", async () => {
  const w = await checksWorld();
  await w.request();
  // A patch submitted on the head with no request of its own: reported from the head's suite.
  // Born under a minute before the release sweep, so the relays' backstop has not filed one.
  const patch = w.patchOf({
    state: "submitted",
    forgeRef: "7",
    createdAt: "2026-01-01T00:00:30.000Z",
  });
  await w.store.createPatch(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  await w.store.saveRunResult({ ...w.run, state: "succeeded" });
  w.clock.advance(61_000);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "cancelled");
  await w.service.tick();
  const last = w.reports.at(-1)!;
  assertEquals([last.suite.state, last.suite.conclusion], ["cancelled", null]);
  assertEquals(last.checks.map((c) => c.conclusion), ["cancelled", "cancelled"]);
});

test(
  "two patches of one head are reported one after the other, never side by side",
  async () => {
    const w = await checksWorld();
    let inFlight = 0;
    let most = 0;
    const report = w.forge.reportChecks;
    w.forge.reportChecks = async (...args) => {
      most = Math.max(most, ++inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return await report(...args);
    };
    for (const id of ["p-1", "p-2", "p-3"]) {
      const patch = w.patchOf({ id, state: "submitted", forgeRef: "7" });
      await w.store.createPatch(patch);
      await w.service.patchOpened(patch);
      await w.service.patchSubmitted(patch);
    }
    await w.service.tick();
    assertEquals(w.reports.length, 3);
    assertEquals(most, 1);
  },
);

test("the task page's suite for a patch is the one its forge is told about", async () => {
  const w = await checksWorld();
  const patch = w.patchOf();
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  const own = w.onlySuite();
  // A newer suite on the same head: the base's checks file changed since.
  w.files.set("*", checksFile({ blob: sha("f") }));
  await w.request();
  assertEquals(w.suites().length, 2);
  const other = w.patchOf({ id: "p-2", headSha: sha("9") });
  await w.store.createPatch(other);
  assertEquals(await w.service.suiteIdsForPatches([patch, other]), { [patch.id]: own.id });
});

// ---- a check's own verdict, as soon as its container exits ----------------------------------

const STARTED = "2026-01-01T00:01:00.000Z";

/** A pod still running its checks: the named ones exited with these codes, the rest running. */
function midway(
  w: World,
  suite: CheckSuite,
  exits: Record<string, number | { exitCode: number; reason: string }>,
  running: string[],
) {
  w.launched.finish(w.nameOf(suite), exits, "2026-01-01T00:02:00.000Z");
  const seen = w.launched.inspections.get(w.nameOf(suite))!;
  assert(seen.kind === "checks");
  for (const name of running) seen.checks[name] = { state: "running", startedAt: STARTED };
  seen.done = false;
}

/** A submitted patch on the head, its suite launched. */
async function submittedAndLaunched(w: World): Promise<CheckSuite> {
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.state, "running");
  return suite;
}

test(
  "a failing check settles while its sibling runs: row, log and forge at once, the run told at the end",
  async () => {
    const w = await checksWorld();
    const suite = await submittedAndLaunched(w);
    w.launched.logs.set(`${w.nameOf(suite)}/check-lint`, "src/a.ts: 3 problems\n");
    midway(w, suite, { lint: 1 }, ["test"]);
    await w.service.tick();

    assertEquals(w.onlySuite().state, "running");
    const [lint, testResult] = await w.checkStore.listResults(suite.id, 1);
    assertEquals([lint.state, lint.exitCode, lint.finishedAt], [
      "failed",
      1,
      "2026-01-01T00:02:00.000Z",
    ]);
    assertEquals(lint.logKey, `checks/${suite.id}/1/lint.log`);
    assertEquals(w.logs.logs.get(lint.logKey!), "src/a.ts: 3 problems\n");
    assertStringIncludes(lint.logTail!, "3 problems");
    assertEquals(testResult.state, "running");

    const report = w.reports.at(-1)!;
    assertEquals(report.checks.map((c) => [c.name, c.status, c.conclusion]), [
      ["lint", "completed", "failure"],
      ["test", "in_progress", null],
    ]);
    assertEquals(report.suite.conclusion, null, "the suite is still going");
    assertEquals(await w.told(), [], "the run hears once, when the suite settles");

    w.launched.finish(w.nameOf(suite), { lint: 1, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "failed");
    assertEquals((await w.told()).length, 1);
    assertEquals(w.reports.at(-1)!.suite.conclusion, "failure");
  },
);

test(
  "a passing check settles early, and the suite's settle keeps its row and its log",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    const name = w.nameOf(suite);
    w.launched.logs.set(`${name}/check-lint`, "clean\n");
    midway(w, suite, { lint: 0 }, ["test"]);
    await w.service.tick();
    const early = (await w.checkStore.listResults(suite.id, 1))[0];
    assertEquals([early.state, early.exitCode], ["passed", 0]);

    // What the pod says of lint by the end is not read again: its first answer stands.
    w.launched.logs.set(`${name}/check-lint`, "changed\n");
    w.launched.finish(name, { lint: 1, test: 0 }, "2026-01-01T00:09:00.000Z");
    await w.service.tick();
    const settled = w.onlySuite();
    assertEquals(settled.state, "passed");
    const lint = (await w.checkStore.listResults(suite.id, 1))[0];
    assertEquals(lint, early);
    assertEquals(w.logs.logs.get(lint.logKey!), "clean\n");
  },
);

test("an early verdict tells the running suite whether .ryph/ changed", async () => {
  const w = await checksWorld();
  const suite = await submittedAndLaunched(w);
  const name = w.nameOf(suite);
  w.launched.logs.set(
    `${name}/clone`,
    "@@ryph-changed .ryph/checks.yml\n@@ryph-changed src/a.ts\n@@ryph-changed-end 2\n",
  );
  midway(w, suite, { lint: 0 }, ["test"]);
  await w.service.tick();
  assertEquals([w.onlySuite().state, w.onlySuite().ryphChanged], ["running", true]);

  w.launched.finish(name, { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals([w.onlySuite().state, w.onlySuite().ryphChanged], ["passed", true]);
});

test("an early verdict on a list it cannot trust leaves .ryph/ unknown", async () => {
  const w = await checksWorld();
  const suite = await submittedAndLaunched(w);
  w.launched.logs.set(`${w.nameOf(suite)}/clone`, "@@ryph-changed src/a.ts\n");
  midway(w, suite, { lint: 0 }, ["test"]);
  await w.service.tick();
  assertEquals([w.onlySuite().state, w.onlySuite().ryphChanged], ["running", null]);
});

test("a relaunch after a platform fault keeps the verdicts the first pod gave", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  midway(w, suite, { lint: 0 }, ["test"]);
  await w.service.tick();
  w.launched.finish(name, { lint: 0, test: { exitCode: 137, reason: "Evicted" } });
  await w.service.tick();
  w.launched.inspections.delete(name);
  assertEquals(w.onlySuite().state, "queued");
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
    [["lint", "passed"], ["test", "running"]],
  );

  await w.service.tick();
  assertEquals(w.launched.specs.length, 2, "relaunched");
  // The second pod runs every check again; only test's answer is read.
  w.launched.finish(name, { lint: { exitCode: 125, reason: "Evicted" }, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
    [["lint", "passed"], ["test", "passed"]],
  );
  assertEquals(w.launched.specs.length, 2, "a kept check's fault in the second pod is not ours");
});

test(
  "a check that failed early blocks a relaunch; the platform giving up keeps it",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    midway(w, suite, { lint: 2 }, ["test"]);
    await w.service.tick();
    w.launched.finish(w.nameOf(suite), { lint: 2, test: { exitCode: 137, reason: "Evicted" } });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "failed");
    assertEquals(w.launched.specs.length, 1);

    // A suite the platform gives up on still shows what a check said for itself.
    const w2 = await checksWorld();
    const s2 = await submittedAndLaunched(w2);
    w2.checkStore.suites.set(s2.id, { ...w2.onlySuite(), attempts: 3 });
    midway(w2, s2, { lint: 1 }, ["test"]);
    await w2.service.tick();
    w2.launched.inspections.delete(w2.nameOf(s2));
    w2.launched.records.delete(w2.nameOf(s2));
    await w2.service.tick();
    assertEquals(w2.onlySuite().state, "failed", "lint's own failure decides it");
    assertEquals(
      (await w2.checkStore.listResults(s2.id, 1)).map((r) => [r.name, r.state]),
      [["lint", "failed"], ["test", "error"]],
    );
    assertEquals(w2.reports.at(-1)!.checks.map((c) => c.conclusion), [
      "failure",
      "action_required",
    ]);
  },
);

test("a replica polling a stale view never takes back a check's settled verdict", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  midway(w, suite, { lint: 1 }, ["test"]);
  await w.service.tick();
  // The other replica's launcher still sees lint running.
  const other = fakeCheckLauncher();
  other.records.add(name);
  other.inspections.set(name, {
    kind: "checks",
    checks: {
      lint: { state: "running", startedAt: STARTED },
      test: { state: "running", startedAt: STARTED },
    },
    done: false,
  });
  await replica(w, other.launcher).tick();
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
    [["lint", "failed"], ["test", "running"]],
  );
});

test(
  "a kill by signal mid-run waits for the pod's reason; out of memory settles at once",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    const name = w.nameOf(suite);
    midway(w, suite, { lint: { exitCode: 137, reason: "Error" } }, ["test"]);
    await w.service.tick();
    assertEquals(
      (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
      [["lint", "running"], ["test", "running"]],
      "no verdict on the head yet",
    );
    // The pod's own reason lands: the node's, so the suite tries again.
    w.launched.finish(name, { lint: { exitCode: 137, reason: "DisruptionTarget" }, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "queued");

    const w2 = await checksWorld();
    await w2.request();
    await w2.service.tick();
    const s2 = w2.onlySuite();
    midway(w2, s2, { lint: { exitCode: 137, reason: "OOMKilled" } }, ["test"]);
    await w2.service.tick();
    assertEquals(
      (await w2.checkStore.listResults(s2.id, 1)).map((r) => [r.name, r.state]),
      [["lint", "failed"], ["test", "running"]],
    );
  },
);

test(
  "a pod gone after a check failed on its own settles failed, never relaunched",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    midway(w, suite, { lint: 1 }, ["test"]);
    await w.service.tick();
    w.launched.inspections.delete(w.nameOf(suite));
    w.launched.records.delete(w.nameOf(suite));
    await w.service.tick();
    await w.service.tick();
    assertEquals(w.onlySuite().state, "failed");
    assertEquals(
      (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
      [["lint", "failed"], ["test", "error"]],
    );
    assertEquals(w.launched.specs.length, 1);
    assertEquals((await w.told()).length, 1);
  },
);

test("a pod unread past its deadline after a check failed on its own is failed", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  midway(w, suite, { lint: 1 }, ["test"]);
  await w.service.tick();
  w.launched.state.unreachable = true;
  w.clock.advance(24 * 60 * 60_000);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => [r.name, r.state]),
    [["lint", "failed"], ["test", "error"]],
  );
});

test(
  "a pod gone after every check answered settles on their verdicts, never relaunched",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    midway(w, suite, { lint: 0, test: 0 }, []);
    await w.service.tick();
    w.launched.inspections.delete(w.nameOf(suite));
    w.launched.records.delete(w.nameOf(suite));
    await w.service.tick();
    await w.service.tick();
    const settled = w.onlySuite();
    assertEquals([settled.state, settled.reason], ["passed", null]);
    assertEquals(w.launched.specs.length, 1);
  },
);

test(
  "a re-run of a suite whose environment failed builds it again; a new ask does not",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const [build] = await w.builder.parked(1);
    build.fail("RUN apt-get failed");
    await w.wired!.service.idle();
    const failed = w.onlySuite();
    assertEquals(failed.state, "error");
    assertStringIncludes(failed.reason!, "a re-run builds it again");
    // Another head at the same base: the failure is its answer, with no build of its own.
    await w.request({ headSha: sha("e") });
    const other = w.suites().find((s) => s.id !== failed.id)!;
    assertEquals(other.state, "error");
    assertEquals(w.builder.specs.length, 1);

    const rerun = await w.service.rerun(failed.id, { kind: "user", userId: "u-1" });
    assert(rerun.kind === "rerun");
    assertEquals(rerun.suite.state, "waiting");
    assert(
      rerun.suite.environmentId !== null && rerun.suite.environmentId !== failed.environmentId,
    );
    // The tick does not answer it with the old failure either.
    await w.service.tick();
    assertEquals((await w.checkStore.getSuite(failed.id))!.state, "waiting");
    const [again] = await w.builder.parked(1);
    again.succeed();
    await w.wired!.service.idle();
    assertEquals((await w.checkStore.getSuite(failed.id))!.state, "queued");
  },
);

/** A passed suite whose build was since retired, and its images removed from the machine. */
async function passedOnRemovedImage(w: Awaited<ReturnType<typeof checksWorld>>) {
  await w.service.tick();
  const suite = w.onlySuite();
  assert(suite.environmentId !== null && suite.image !== null);
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  const env = w.environmentStore.rows.get(suite.environmentId)!;
  w.environmentStore.rows.set(env.id, {
    ...env,
    status: "superseded",
    imagesRemovedAt: w.clock.now().toISOString(),
  });
  // What the machine says of it from now on.
  w.launched.state.images = { kind: "gone", why: `${suite.image} is no longer in the store` };
  return suite;
}

/** acme/api's main with a ready default-branch build, so a suite there is keyed on its image. */
async function onDefaultImage(w: Awaited<ReturnType<typeof checksWorld>>) {
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
  await w.environmentService!.enqueue({
    subject: (await w.environmentService!.loadSubject("repo", w.api.id))!,
    ref: "main",
    defaultBranch: true,
    checkouts: [{ path: "api", connectedRepoId: w.api.id, ref: "main", commit: BASE }],
    definition: tree("a"),
    dockerfile: true,
    machine: null,
    trigger: "push",
  });
  (await w.builder.parked(1))[0].succeed();
  await w.wired!.service.idle();
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
}

test(
  "a re-run keyed on its base's tree whose image is gone waits for that environment again",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    (await w.builder.parked(1))[0].succeed();
    await w.wired!.service.idle();
    const suite = await passedOnRemovedImage(w);
    assert(suite.environmentKey.startsWith("tree:"));

    assert((await w.service.rerun(suite.id, { kind: "user", userId: "u-1" })).kind === "rerun");
    const launches = w.launched.specs.length;
    await w.service.tick();
    // Found at launch, and never handed to the launcher.
    assertEquals(w.launched.specs.length, launches);
    const waiting = (await w.checkStore.getSuite(suite.id))!;
    assertEquals([waiting.state, waiting.image, waiting.attempts], ["waiting", null, 0]);
    assert(waiting.environmentId !== null && waiting.environmentId !== suite.environmentId);
    w.launched.state.images = { kind: "ready" };
    const [again] = await w.builder.parked(1);
    again.succeed(`registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`, {
      bakedImage: `registry.test/ryph-envs/repo-cr-api@sha256:${"9".repeat(64)}`,
    });
    await w.wired!.service.idle();
    const queued = (await w.checkStore.getSuite(suite.id))!;
    assertEquals(queued.state, "queued");
    assert(queued.image !== suite.image, "it runs in the new build, not the removed one");
  },
);

test(
  "a re-run keyed on an image retention removed reads the base again, as a new ask",
  async () => {
    const w = await checksWorld();
    await onDefaultImage(w);
    await w.request();
    const suite = await passedOnRemovedImage(w);
    assert(suite.environmentKey.startsWith("image:"), suite.environmentKey);
    // The default branch built again since: that is what a new ask runs in.
    w.clock.advance(60_000);
    await w.environmentService!.enqueue({
      subject: (await w.environmentService!.loadSubject("repo", w.api.id))!,
      ref: "main",
      defaultBranch: true,
      checkouts: [{ path: "api", connectedRepoId: w.api.id, ref: "main", commit: sha("f") }],
      definition: tree("a"),
      dockerfile: true,
      machine: null,
      trigger: "push",
      force: true,
    });
    (await w.builder.parked(1))[0].succeed(
      `registry.test/ryph-envs/repo-cr-api@sha256:${"f".repeat(64)}`,
      { bakedImage: `registry.test/ryph-envs/repo-cr-api@sha256:${"9".repeat(64)}` },
    );
    await w.wired!.service.idle();

    const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(rerun.kind === "rerun", JSON.stringify(rerun));
    assert(rerun.suite.id !== suite.id, "a different suite: its image is its identity");
    assert(rerun.suite.image !== suite.image);
  },
);

test(
  "a re-run keyed on an image still on the machine restarts, whatever its build's stamp says",
  async () => {
    const w = await checksWorld();
    await onDefaultImage(w);
    await w.request();
    const suite = await passedOnRemovedImage(w);
    // A re-layer took the baked image over: its source is stamped, the image is still there.
    w.launched.state.images = { kind: "ready" };
    const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(rerun.kind === "rerun", JSON.stringify(rerun));
    assertEquals(rerun.suite.id, suite.id);
    assertEquals(rerun.suite.image, suite.image);
  },
);

test(
  "where the launcher cannot tell (kubernetes pulls in the pod), a re-run goes by the stamp",
  async () => {
    const w = await checksWorld();
    await onDefaultImage(w);
    await w.request();
    const suite = await passedOnRemovedImage(w);
    // A cluster pulls after the launch, so it has no `prepare` to ask before one.
    delete (w.launched.launcher as { prepare?: unknown }).prepare;
    const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(rerun.kind === "rerun", JSON.stringify(rerun));
    assert(rerun.suite.id !== suite.id, "retention removed it from the registry: a new ask");

    // A re-layer still naming the image as its baked one keeps it there.
    const again = await checksWorld();
    await onDefaultImage(again);
    await again.request();
    const kept = await passedOnRemovedImage(again);
    delete (again.launched.launcher as { prepare?: unknown }).prepare;
    const source = again.environmentStore.rows.get(kept.environmentId!)!;
    again.environmentStore.rows.set("env-relayer", {
      ...source,
      id: "env-relayer",
      status: "ready",
      imagesRemovedAt: null,
      bakedImage: kept.image,
    });
    const restarted = await again.service.rerun(kept.id, { kind: "user", userId: "u-1" });
    assert(restarted.kind === "rerun", JSON.stringify(restarted));
    assertEquals(restarted.suite.id, kept.id);
  },
);

test(
  "where the launcher cannot tell, a re-run keyed on its tree waits for it, not the removed image",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    (await w.builder.parked(1))[0].succeed();
    await w.wired!.service.idle();
    const suite = await passedOnRemovedImage(w);
    assert(suite.environmentKey.startsWith("tree:"), suite.environmentKey);
    delete (w.launched.launcher as { prepare?: unknown }).prepare;
    const launches = w.launched.specs.length;
    const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(rerun.kind === "rerun", JSON.stringify(rerun));
    await w.service.tick();
    const after = (await w.checkStore.getSuite(rerun.suite.id))!;
    assertEquals(after.state, "waiting");
    assertEquals(after.image, null);
    assertEquals(w.launched.specs.length, launches, "never launched on the removed image");
  },
);

test(
  "a ready build whose image is gone from the machine is retired, and built again",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    (await w.builder.parked(1))[0].succeed();
    await w.wired!.service.idle();
    const suite = w.onlySuite();
    assertEquals(suite.state, "queued");
    // `image prune -a`, a daemon reset: nothing retention did.
    w.launched.state.images = { kind: "gone", why: "no longer in the store" };
    await w.service.tick();
    assertEquals(w.environmentStore.rows.get(suite.environmentId!)!.status, "superseded");
    const waiting = (await w.checkStore.getSuite(suite.id))!;
    assertEquals(waiting.state, "waiting");
    assert(
      waiting.environmentId !== suite.environmentId,
      "waits for a new build, not the dead one",
    );
    assertEquals((await w.builder.parked(1)).length, 1);
  },
);

test("a suite keyed on an image found gone at launch ends, saying to ask again", async () => {
  const w = await checksWorld();
  await onDefaultImage(w);
  await w.request();
  const suite = w.onlySuite();
  assert(suite.environmentKey.startsWith("image:"), suite.environmentKey);
  w.launched.state.images = { kind: "gone", why: "removed" };
  await w.service.tick();
  assertEquals(w.launched.specs.length, 0);
  const ended = (await w.checkStore.getSuite(suite.id))!;
  assertEquals(ended.state, "error");
  assertStringIncludes(ended.reason!, "ask for checks again");
});

test(
  "an image gone from the machine retires the ready re-layer that shares it too",
  async () => {
    const w = await checksWorld();
    await onDefaultImage(w);
    await w.request();
    const suite = w.onlySuite();
    const source = w.environmentStore.rows.get(suite.environmentId!)!;
    assertEquals(source.bakedImage, suite.image);
    // A harness deploy re-layered it: the re-layer is ready on the same baked image.
    w.environmentStore.rows.set(source.id, { ...source, status: "superseded" });
    w.environmentStore.rows.set("env-relayer", { ...source, id: "env-relayer", status: "ready" });
    w.launched.state.images = { kind: "gone", why: "image prune -a" };
    await w.service.tick();
    assertEquals((await w.checkStore.getSuite(suite.id))!.state, "error");
    assertEquals(w.environmentStore.rows.get("env-relayer")!.status, "superseded");
  },
);

test(
  "asked again at once, a suite whose image left the machine is not joined again",
  async () => {
    const w = await checksWorld();
    await onDefaultImage(w);
    await w.request();
    const suite = w.onlySuite();
    w.launched.state.images = { kind: "gone", why: "removed" };
    await w.service.tick();
    assertEquals((await w.checkStore.getSuite(suite.id))!.state, "error");
    // Within the minute a choice is cached for: the dead image is not it any more.
    await w.request();
    const ended = (await w.checkStore.getSuite(suite.id))!;
    assertEquals([ended.state, ended.generation], ["error", suite.generation]);
    const others = [...w.checkStore.suites.values()].filter((s) => s.id !== suite.id);
    assertEquals(others.length, 1);
    assert(others[0].environmentId !== suite.environmentId, "a new suite, not on the dead build");
  },
);

test("a re-run's ask lands before its generation does", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  const seen: string[] = [];
  const create = w.checkStore.createRequest;
  w.checkStore.createRequest = (request) => {
    seen.push(`ask ${request.kind}`);
    return create(request);
  };
  const save = w.checkStore.saveSuiteIf;
  w.checkStore.saveSuiteIf = (next, expected) => {
    seen.push(`suite g${next.generation}`);
    return save(next, expected);
  };
  assertEquals((await w.service.rerun(suite.id, { kind: "user", userId: "u-1" })).kind, "rerun");
  assertEquals(seen.slice(0, 2), ["ask rerun", "suite g2"]);
});

test(
  "a suite held by a launch or a settle is not cancelled under it, but once it is let go",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const running = w.onlySuite();
    assertEquals(running.state, "running");
    // Another replica's launch in flight: its lease runs for minutes yet.
    const lease = new Date(w.clock.now().getTime() + 5 * 60_000).toISOString();
    plant(w, running, { leaseUntil: lease, launchedAt: null });
    await w.store.saveRunResult({ ...w.run, state: "succeeded" });
    w.clock.advance(61_000);
    await w.service.tick();
    assertEquals(w.onlySuite().state, "running", "the launch still holds it");
    assertEquals(w.launched.discarded, []);
    // The launch done, the next sweep finds nobody asking.
    plant(w, w.onlySuite(), { leaseUntil: null, launchedAt: w.clock.now().toISOString() });
    w.clock.advance(61_000);
    await w.service.tick();
    assertEquals(w.onlySuite().state, "cancelled");
    assert(w.launched.discarded.includes(w.nameOf(running)));
  },
);

test("a patch still being read is reported only from a suite of the same base", async () => {
  const w = await checksWorld();
  await w.request();
  const own = w.onlySuite();
  // A newer full suite of the same head, judged by another base.
  plant(w, own, {
    id: "cs-elsewhere",
    checksRef: "release",
    createdAt: new Date(Date.parse(T0) + 1000).toISOString(),
  });
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  w.files.set("*", { kind: "unavailable", detail: "forge down" });
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  assertEquals(w.reports.at(-1)!.suiteId, own.id, "the suite read on main, as the patch is");

  // With only the other base's suite on the head, nothing stands in for the patch's own.
  const lone = await checksWorld();
  await lone.request();
  plant(lone, lone.onlySuite(), { checksRef: "release" });
  const p = lone.patchOf({ state: "submitted", forgeRef: "7" });
  await lone.store.createPatch(p);
  lone.files.set("*", { kind: "unavailable", detail: "forge down" });
  await lone.service.patchOpened(p);
  await lone.service.patchSubmitted(p);
  await lone.service.tick();
  assertEquals(lone.reports, []);
});

test(
  "a patch whose relays were lost gets its request and its forge row from the sweep",
  async () => {
    const w = await checksWorld();
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    // Both relays fail, and say nothing to their callers.
    const create = w.checkStore.createRequest;
    const upsert = w.checkStore.upsertForgeReport;
    w.checkStore.createRequest = () => Promise.reject(new Error("db down"));
    w.checkStore.upsertForgeReport = () => Promise.reject(new Error("db down"));
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    w.checkStore.createRequest = create;
    w.checkStore.upsertForgeReport = upsert;
    assertEquals(w.checkStore.requests.size, 0);
    assertEquals(await w.checkStore.findForgeReport({ patchId: patch.id }), null);

    // Within its first minute the sweep leaves it to the relays; after it, files both.
    await w.service.tick();
    assertEquals(w.checkStore.requests.size, 0);
    w.clock.advance(61_000);
    await w.service.tick();
    const [request] = [...w.checkStore.requests.values()];
    assertEquals([request.kind, request.patchId], ["patch", patch.id]);
    assert(await w.checkStore.findForgeReport({ patchId: patch.id }) !== null);
    await w.service.tick();
    assertEquals(w.reports.at(-1)!.suiteId, w.onlySuite().id);
    // Filed once: the next sweep finds both.
    w.clock.advance(61_000);
    await w.service.tick();
    assertEquals(w.checkStore.requests.size, 1);
  },
);

test("a patch born before checks came up is never filed by the sweep", async () => {
  const w = await checksWorld();
  // Born an hour before the service: checks were off, or another process had it.
  const born = new Date(w.clock.now().getTime() - 60 * 60_000).toISOString();
  const patch = w.patchOf({ state: "submitted", forgeRef: "7", createdAt: born });
  await w.store.createPatch(patch);
  w.clock.advance(61_000);
  await w.service.tick();
  assertEquals(w.checkStore.requests.size, 0);
  assertEquals(await w.checkStore.findForgeReport({ patchId: patch.id }), null);
});

test(
  "a patch whose relay a restart cut short is still filed, as checks were on then",
  async () => {
    const w = await checksWorld();
    const hourAgo = w.clock.now().getTime() - 60 * 60_000;
    // Before this service came up, a patch's birth filed its request: checks were on.
    const filed = w.patchOf({ id: "p-1", createdAt: new Date(hourAgo).toISOString() });
    await w.store.createPatch(filed);
    await w.service.patchOpened(filed);
    // A later one, still before the restart, whose relay was cut short.
    const lost = w.patchOf({
      id: "p-2",
      headSha: "e".repeat(40),
      createdAt: new Date(hourAgo + 60_000).toISOString(),
    });
    await w.store.createPatch(lost);
    w.clock.advance(61_000);
    await w.service.tick();
    const asked = [...w.checkStore.requests.values()].map((r) => r.patchId).sort();
    assertEquals(asked, ["p-1", "p-2"]);
  },
);

test(
  "a suite whose images are still pulling waits in the queue, spending no attempt",
  async () => {
    const w = await checksWorld();
    w.launched.state.images = { kind: "pulling" };
    await w.request();
    await w.service.tick();
    const waiting = w.onlySuite();
    assertEquals([waiting.state, waiting.attempts], ["queued", 0]);
    assertEquals(w.launched.specs, [], "nothing launched");
    assertEquals(w.launched.prepared.at(-1), [waiting.image!]);
    assertEquals(w.launched.preparedSince.at(-1), waiting.updatedAt, "asked as of its last change");
    // In: launched on the next tick.
    w.launched.state.images = { kind: "ready" };
    await w.service.tick();
    assertEquals([w.onlySuite().state, w.onlySuite().attempts], ["running", 1]);
  },
);

test(
  "a pull that failed is a failed launch attempt naming why, and launches nothing",
  async () => {
    const w = await checksWorld();
    w.launched.state.images = { kind: "failed", why: "docker pull failed: manifest unknown" };
    await w.request();
    await w.service.tick();
    const failed = w.onlySuite();
    assertEquals([failed.state, failed.attempts], ["queued", 1]);
    assertStringIncludes(failed.reason!, "its image could not be pulled: docker pull failed");
    assertEquals(w.launched.specs, []);
  },
);

test(
  "a suite still pulling holds no slot: the next one in the queue launches in its place",
  async () => {
    const w = await checksWorld({ policy: { maxConcurrent: 1 } });
    w.launched.state.images = { kind: "pulling" };
    await w.request();
    // A patch on another head asks too: a second suite, younger, which supersedes nothing.
    const patch = w.patchOf({
      id: "p-2",
      headSha: "e".repeat(40),
      createdAt: new Date(w.clock.now().getTime() + 1).toISOString(),
    });
    await w.store.createPatch(patch);
    w.clock.advance(1_000);
    await w.service.patchOpened(patch);
    await w.service.tick();
    assertEquals(w.suites().map((x) => x.state), ["queued", "queued"], "both wait on their images");
    // The older suite's images are still coming; the younger one's are in.
    const asked = w.launched.prepared.length;
    w.launched.state.images = (call) =>
      call === asked + 1 ? { kind: "pulling" } : { kind: "ready" };
    await w.service.tick();
    const [older, younger] = w.suites().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    assertEquals([older.state, older.attempts], ["queued", 0]);
    assertEquals([younger.state, younger.attempts], ["running", 1]);
  },
);

test(
  "an image that will not pull errors the suite on its third attempt, naming why",
  async () => {
    const w = await checksWorld();
    w.launched.state.images = { kind: "failed", why: "docker pull failed: manifest unknown" };
    await w.request();
    for (let attempt = 1; attempt <= 3; attempt++) await w.service.tick();
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.attempts], ["error", 3]);
    assertStringIncludes(suite.reason!, "its image could not be pulled: docker pull failed");
    assertStringIncludes(suite.reason!, "after 3 attempts");
    assertEquals(w.launched.specs, []);
  },
);

test(
  "a launch that failed holds no slot: the next suite launches in the same tick",
  async () => {
    const w = await checksWorld({ policy: { maxConcurrent: 1 } });
    w.launched.state.images = { kind: "pulling" };
    await w.request();
    const patch = w.patchOf({ id: "p-2", headSha: "e".repeat(40) });
    await w.store.createPatch(patch);
    w.clock.advance(1_000);
    await w.service.patchOpened(patch);
    await w.service.tick();
    // The older suite's pull failed; the younger one's images are in.
    const asked = w.launched.prepared.length;
    w.launched.state.images = (call) =>
      call === asked + 1
        ? { kind: "failed", why: "docker pull failed: timeout" }
        : { kind: "ready" };
    await w.service.tick();
    const [older, younger] = w.suites().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    assertEquals([older.state, older.attempts], ["queued", 1]);
    assertEquals([younger.state, younger.attempts], ["running", 1]);
  },
);

test(
  "a launch that threw holds no slot: the next suite launches in the same tick",
  async () => {
    const w = await checksWorld({ policy: { maxConcurrent: 1 } });
    w.launched.state.images = { kind: "pulling" };
    await w.request();
    const patch = w.patchOf({ id: "p-2", headSha: "e".repeat(40) });
    await w.store.createPatch(patch);
    w.clock.advance(1_000);
    await w.service.patchOpened(patch);
    await w.service.tick();
    w.launched.state.images = { kind: "ready" };
    w.launched.state.failLaunch = { error: "docker run failed: no space left", once: true };
    await w.service.tick();
    const [older, younger] = w.suites().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    assertEquals([older.state, older.attempts], ["queued", 1]);
    assertEquals([younger.state, younger.attempts], ["running", 1]);
  },
);
