// `pod: own`: a check that runs in a pod of its own, alone, optionally in a size class of its own.
// A suite is then several records — the shared pod and one per own check — launched together,
// and from then on each pod lives its own life (`pollPods` in core/checks.ts): settled and
// discarded as soon as its own checks are, relaunched alone, held to its own deadline. A
// declaration without the key is the one shared pod, unchanged.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkPods,
  checkRecordName,
  makeChecksService,
  ownRecordName,
} from "../src/core/checks.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import type { CheckLauncher } from "../src/ports/check_launcher.ts";
import { ImageGone } from "../src/ports/image_gone.ts";
import { parseRunSizes, type RunSizes } from "../src/core/run_sizes.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";
import {
  CHECK_RECORD_NAME,
  type CheckDeclaration,
  type CheckSuite,
} from "../src/core/check_types.ts";
import { mintId } from "@ryph/sealed";
import {
  APP_URL,
  BASE,
  checksFile,
  checksWorld,
  type ChecksWorldOptions,
  sha,
  T0,
} from "./checks_world.ts";
import { fakeCheckLauncher } from "./check_doubles.ts";
import { tree } from "./environment_world.ts";

const OWN_YML = `setup:
  - run: npm ci
checks:
  - name: lint
    run: deno lint
  - name: test
    run: deno task test
    timeout: 20m
    services: [db]
  - name: orchestrator
    run: bun test
    timeout: 30m
    services: [db2]
    pod: own
    size: large
`;

const SERVICES_YML = `services:
  db:
    uses: postgres@18
    port: 5432
  db2:
    uses: postgres@18
    port: 5433
`;

const SIZES: RunSizes = (() => {
  const parsed = parseRunSizes(
    "standard:cpu=4,memory=8Gi,ephemeral-storage=10Gi;large:cpu=8,memory=16Gi",
    "standard",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.sizes;
})();

/** The shared pod's deadline and the own pod's, as the control plane holds them, plus a margin. */
const SHARED_PAST = (20 * 60 + 20 * 60 + 300) * 1000 + 13 * 60_000;
const OWN_PAST = (20 * 60 + 30 * 60 + 300) * 1000 + 13 * 60_000;

async function ownWorld(yml = OWN_YML, opts: ChecksWorldOptions = {}) {
  const w = await checksWorld({
    services: { ...DEFAULT_SERVICE_POLICY, enabled: true },
    runSizes: SIZES,
    ...opts,
    policy: { ownSizes: ["large"], ...opts.policy },
  });
  w.files.set("*", checksFile({ text: yml, services: { kind: "file", text: SERVICES_YML } }));
  return w;
}

type World = Awaited<ReturnType<typeof ownWorld>>;

const own = (suite: CheckSuite, check = "orchestrator") => ownRecordName(suite, check);
/** Each check's state, in declared order. */
const states = async (w: World, suiteId: string, generation = 1) => {
  const rows = await w.checkStore.listResults(suiteId, generation);
  const order = ["lint", "test", "orchestrator"];
  return rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    .map((r) => [r.name, r.state]);
};
/** Each record discarded, once. */
const discarded = (w: World) => [...new Set(w.launched.discarded)].sort();
/** The suite's clone keys not yet revoked. */
const liveKeys = (w: World, suite: CheckSuite) =>
  [...w.checkStore.keys.values()].filter((k) => k.suiteId === suite.id && k.revokedAt === null);

/** A full suite on the world's head, launched. */
async function launched(w: World): Promise<CheckSuite> {
  const asked = await w.request();
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  assertEquals(suite.state, "running");
  return suite;
}

test("an own check launches a pod of its own: its check, its services, its size", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  const [shared, alone] = w.launched.specs;
  assertEquals(w.launched.specs.length, 2);

  assertEquals(shared.name, checkRecordName(suite));
  assertEquals(shared.checks.map((c) => c.name), ["lint", "test"]);
  assertEquals(shared.services.map((s) => s.name), ["db"]);
  assertEquals(shared.size.name, "standard");
  assertEquals(shared.deadlineSeconds, 20 * 60 + 20 * 60 + 300);

  // A real suite id: the own pod's name still fits what every launcher takes.
  assertEquals(alone.name, `ryph-check-${suite.id}-g1-o0-orche`);
  assert(CHECK_RECORD_NAME.test(alone.name));
  assertEquals(alone.checks.map((c) => c.name), ["orchestrator"]);
  assertEquals(alone.services.map((s) => s.name), ["db2"]);
  assertEquals([alone.size.name, alone.size.memory], ["large", "16Gi"]);
  assertEquals(alone.deadlineSeconds, 20 * 60 + 30 * 60 + 300);
  // Its own clone and setup, from the same head.
  assertEquals(alone.setup, shared.setup);
  assertEquals(alone.clone.commit, shared.clone.commit);
  // A clone key each: neither pod holds the other's.
  assert(alone.clone.env.GIT_CONFIG_VALUE_0 !== shared.clone.env.GIT_CONFIG_VALUE_0);
  assertEquals([...w.checkStore.keys.values()].filter((k) => k.suiteId === suite.id).length, 2);
  // Each pod's life starts at the launch.
  assertEquals(
    Object.entries(w.onlySuite().pods!).map(([name, life]) => [name, life.attempts]),
    [[shared.name, 1], [alone.name, 1]],
  );

  const view = (await w.service.view(suite.id, SCOPE_ALL))!;
  assertEquals(
    view.checks.map((c) => [c.name, c.pod, c.size]),
    [["lint", undefined, undefined], ["test", undefined, undefined], [
      "orchestrator",
      "own",
      "large",
    ]],
  );
});

test("without a size, an own pod gets the size the shared pod gets", async () => {
  const w = await ownWorld(OWN_YML.replace("    size: large\n", ""), { policy: { ownSizes: [] } });
  await launched(w);
  assertEquals(w.launched.specs.map((s) => s.size.name), ["standard", "standard"]);
});

test("a declaration without pod: own is the one shared pod, as always", async () => {
  const w = await ownWorld(OWN_YML.replace("    pod: own\n    size: large\n", ""));
  const suite = await launched(w);
  assertEquals(w.launched.specs.length, 1);
  const [spec] = w.launched.specs;
  assertEquals(spec.name, checkRecordName(suite));
  assertEquals(spec.checks.map((c) => c.name), ["lint", "test", "orchestrator"]);
  assertEquals(spec.services.map((s) => s.name), ["db", "db2"]);
  assertEquals(checkPods(suite).map((p) => p.name), [checkRecordName(suite)]);
  // Its one life names only its clone key, revoked by id past the clone.
  const keyId = w.onlySuite().pods![checkRecordName(suite)].keyId;
  assertEquals(Object.keys(w.onlySuite().pods!), [checkRecordName(suite)]);
  assert(keyId !== null);
});

test("every check its own: no shared pod at all", async () => {
  const w = await ownWorld(`checks:
  - name: lint
    run: x
    pod: own
  - name: test
    run: y
    pod: own
`);
  const suite = await launched(w);
  assertEquals(w.launched.specs.map((s) => s.name), [own(suite, "lint"), own(suite, "test")]);
  w.launched.finish(own(suite, "lint"), { lint: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running", "the other pod has not answered");
  assertEquals(discarded(w), [own(suite, "lint")], "the pod that answered is done with");
  w.launched.finish(own(suite, "test"), { test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  assertEquals(discarded(w), [own(suite, "lint"), own(suite, "test")].sort());
});

test("one pod passes and the other fails: each check its own verdict, the suite failed", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.logs.set(`${own(suite)}/check-orchestrator`, "FAIL orchestrator\n");
  w.launched.finish(own(suite), { orchestrator: 1 });
  await w.service.tick();
  // The own pod's verdict is in as soon as it is, while the shared pod still runs, and the own
  // pod is gone.
  assertEquals(w.onlySuite().state, "running");
  assertEquals(await states(w, suite.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "failed"],
  ]);
  assertEquals(discarded(w), [own(suite)]);
  w.launched.logs.set(`${checkRecordName(suite)}/check-lint`, "lint ok\n");
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "failed"],
  ]);
  // Each check's log from the pod that ran it.
  const rows = await w.checkStore.listResults(suite.id, 1);
  assertEquals(rows.find((r) => r.name === "lint")!.logTail, "lint ok");
  assertEquals(rows.find((r) => r.name === "orchestrator")!.logTail, "FAIL orchestrator");
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
  assertEquals(liveKeys(w, suite), []);
});

test("a finished pod that vanishes while another runs keeps its verdicts and logs", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  // Killed by a signal, which is not settled while its pod still runs: its pod's end decides.
  w.launched.logs.set(`${checkRecordName(suite)}/check-lint`, "Killed\n");
  w.launched.finish(checkRecordName(suite), { lint: 137, test: 0 });
  w.launched.inspections.set(own(suite), {
    kind: "checks",
    checks: { orchestrator: { state: "running", startedAt: null } },
    done: false,
  });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running");
  assertEquals(await states(w, suite.id), [
    ["lint", "failed"],
    ["test", "passed"],
    ["orchestrator", "running"],
  ]);
  // Done with: discarded, and never read again — its Job's TTL, say, may take it any time.
  assert(!w.launched.records.has(checkRecordName(suite)));
  w.launched.finish(own(suite), { orchestrator: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertEquals(w.launched.specs.length, 2, "nothing relaunched");
  const lint = (await w.checkStore.listResults(suite.id, 1)).find((r) => r.name === "lint")!;
  assertEquals([lint.exitCode, lint.logTail], [137, "Killed"]);
});

test("each pod's clone key is revoked as soon as that pod is past its clone", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  const lives = w.onlySuite().pods!;
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "checks",
    checks: { lint: { state: "running", startedAt: null }, test: { state: "waiting" } },
    done: false,
  });
  await w.service.tick();
  assertEquals(
    liveKeys(w, suite).map((k) => k.id),
    [lives[own(suite)].keyId],
    "the own pod is still cloning with its key; the shared pod's is gone",
  );
  w.launched.inspections.set(own(suite), { kind: "pending", cloneDone: true, why: null });
  await w.service.tick();
  assertEquals(liveKeys(w, suite), []);
});

test("a setup failure in an own pod fails its check at once; the shared pod runs on", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.logs.set(`${own(suite)}/setup-0`, "npm ERR! out of memory\n");
  w.launched.inspections.set(own(suite), {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 1,
    why: "exit 1",
  });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running");
  const failed = (await w.checkStore.listResults(suite.id, 1)).find((r) =>
    r.name === "orchestrator"
  )!;
  assertEquals([failed.state, failed.exitCode], ["setup_failed", 1]);
  assertEquals(failed.logTail, "npm ERR! out of memory");
  assertEquals(failed.logKey, `checks/${suite.id}/1/_setup-orchestrator.log`);
  assertEquals(discarded(w), [own(suite)]);

  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertEquals(settled.reason, "setup step 1 failed in orchestrator's own pod (exit 1): exit 1");
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "setup_failed"],
  ]);
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
});

test("a setup failure in the shared pod leaves the own pod's verdict standing", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 2,
    why: "exit 2",
  });
  w.launched.finish(own(suite), { orchestrator: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertStringIncludes(settled.reason!, "setup step 1 failed in the shared check pod (exit 2)");
  assertEquals(await states(w, suite.id), [
    ["lint", "setup_failed"],
    ["test", "setup_failed"],
    ["orchestrator", "passed"],
  ]);
});

test("one pod's platform failure relaunches only that pod; the others run on", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "checks",
    checks: {
      lint: { state: "exited", exitCode: 0, startedAt: null, finishedAt: null, reason: null },
      test: { state: "running", startedAt: null },
    },
    done: false,
  });
  w.launched.inspections.set(own(suite), {
    kind: "unschedulable",
    why: null,
    detail: "no node fits 16Gi",
  });
  await w.service.tick();
  const running = w.onlySuite();
  assertEquals(running.state, "running");
  // Only the own pod went, and came back with a key of its own; the shared pod's answer stands.
  assertEquals(discarded(w), [own(suite)]);
  assert(w.launched.records.has(checkRecordName(suite)));
  assertEquals(w.launched.specs.slice(2).map((s) => [s.name, s.size.name]), [[
    own(suite),
    "large",
  ]]);
  assertEquals(running.pods![own(suite)].attempts, 2);
  assertEquals(running.pods![checkRecordName(suite)].attempts, 1);
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "running"],
    ["orchestrator", "queued"],
  ]);
  // A pod gone is the same: only it goes again.
  w.launched.records.delete(own(suite));
  await w.service.tick();
  assertEquals(w.onlySuite().pods![own(suite)].attempts, 3);
  assertEquals(w.launched.specs.length, 4);
  w.launched.finish(own(suite), { orchestrator: 0 });
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
});

test("a pod past its attempts ends only its own checks error, saying why", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  for (let i = 0; i < 3; i++) {
    w.launched.inspections.set(own(suite), {
      kind: "unschedulable",
      why: null,
      detail: "no node fits 16Gi",
    });
    await w.service.tick();
  }
  assertEquals(w.launched.specs.length, 4, "the first launch and two relaunches of its own");
  assertEquals(w.onlySuite().state, "running", "the shared pod still runs");
  assertEquals(await states(w, suite.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "error"],
  ]);
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "error");
  assertEquals(
    settled.reason,
    "orchestrator's own pod could not be scheduled with size class large (after 3 attempts)",
  );
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "error"],
  ]);
});

test("a check the platform could not run relaunches its own pod, keeping what answered", async () => {
  const w = await ownWorld(`checks:
  - name: lint
    run: x
  - name: test
    run: y
  - name: orchestrator
    run: z
    pod: own
`);
  const suite = await launched(w);
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 125 });
  await w.service.tick();
  assertEquals(w.launched.specs.slice(2).map((s) => [s.name, s.checks.map((c) => c.name)]), [
    [checkRecordName(suite), ["test"]],
  ]);
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "running"],
    ["orchestrator", "queued"],
  ]);
  assert(w.launched.records.has(own(suite)), "the own pod runs on");
});

test("a pod the backend cannot read hides nothing the others answered", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.inspections.set(own(suite), { kind: "unknown", why: "api timeout" });
  w.launched.logs.set(`${checkRecordName(suite)}/check-test`, "1 failed\n");
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 1 });
  await w.service.tick();
  // The readable pod's results are in, and it is done with; the unreadable one decides nothing.
  assertEquals(w.onlySuite().state, "running");
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "failed"],
    ["orchestrator", "queued"],
  ]);
  assertEquals(discarded(w), [checkRecordName(suite)]);
  w.clock.advance(SHARED_PAST);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running", "the own pod's deadline is its own, and longer");
  // Past its deadline only its check is `error`; the others keep their verdicts and logs.
  w.clock.advance(OWN_PAST - SHARED_PAST);
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertEquals(
    settled.reason,
    "orchestrator's own pod could not be read past its deadline (api timeout)",
  );
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "failed"],
    ["orchestrator", "error"],
  ]);
  const test = (await w.checkStore.listResults(suite.id, 1)).find((r) => r.name === "test")!;
  assertEquals(test.logTail, "1 failed");
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
});

test("past its deadline, an own pod still setting up is its hang, one not started the platform's", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  w.launched.inspections.set(own(suite), {
    kind: "pending",
    cloneDone: true,
    why: null,
    running: 0,
  });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running", "the own pod is still within its deadline");
  w.clock.advance(OWN_PAST);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "setup_failed"],
  ]);

  const g = await ownWorld();
  const other = await launched(g);
  g.launched.finish(checkRecordName(other), { lint: 0, test: 0 });
  g.launched.inspections.set(own(other), { kind: "pending", cloneDone: false, why: "pulling" });
  g.clock.advance(OWN_PAST);
  await g.service.tick();
  const errored = g.onlySuite();
  assertEquals(errored.state, "error");
  assertEquals(
    errored.reason,
    "orchestrator's own pod did not start its checks within its deadline (pulling)",
  );
  assertEquals(await states(g, other.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "error"],
  ]);
});

test("a pod whose every check has answered is not waited on", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.finish(own(suite), { orchestrator: 0 });
  await w.service.tick();
  // The own pod's record vanishes (its backend kept it only so long): nothing relaunches.
  w.launched.records.delete(own(suite));
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  assertEquals(w.launched.specs.length, 2);
});

test("a launch interrupted before any pod's life was written relaunches the suite", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  // As a replica that died between its launches and its write leaves it.
  const stored = w.checkStore.suites.get(suite.id)!;
  stored.launchedAt = null;
  stored.pods = null;
  w.launched.records.delete(own(suite));
  await w.service.tick();
  const requeued = w.onlySuite();
  assertEquals(requeued.state, "queued");
  assertStringIncludes(requeued.reason!, "its launch was interrupted");
  assert(w.launched.discarded.includes(checkRecordName(suite)), "the shared pod went too");
});

test("a cancelled suite discards every pod", async () => {
  const w = await ownWorld();
  const first = (await w.request({ headSha: sha("1") })).suiteId!;
  await w.service.tick();
  const suite = w.checkStore.suites.get(first)!;
  await w.request({ headSha: sha("2") });
  assertEquals(w.checkStore.suites.get(first)!.state, "cancelled");
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
});

test("the orphan sweep keeps a running suite's own pods and takes anyone else's", async () => {
  const w = await ownWorld();
  const orphan = `ryph-check-${mintId("cs")}-g1-o0-orche`;
  w.launched.records.add(orphan);
  const suite = await launched(w);
  assertEquals(w.launched.discarded, [orphan]);
  assert(w.launched.records.has(own(suite)));
  assert(w.launched.records.has(checkRecordName(suite)));
});

test("an own check whose pass is kept launches no pod", async () => {
  const w = await ownWorld();
  const subset = (await w.request({ checks: ["orchestrator"] })).suiteId!;
  await w.service.tick();
  const partial = w.checkStore.suites.get(subset)!;
  // A subset of only the own check: only its pod.
  assertEquals(w.launched.specs.map((s) => s.name), [own(partial)]);
  w.launched.finish(own(partial), { orchestrator: 0 });
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(subset)!.state, "passed");

  const full = (await w.request()).suiteId!;
  await w.service.tick();
  const suite = w.checkStore.suites.get(full)!;
  assertEquals(w.launched.specs.slice(1).map((s) => s.name), [checkRecordName(suite)]);
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(full)!.state, "passed");
  assertEquals(await states(w, full), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "passed"],
  ]);
});

test("a size the operator has not listed fails the suite, launches nothing and names no class", async () => {
  for (const [size, listed] of [["large", []], ["huge", ["large"]]] as const) {
    const w = await ownWorld(OWN_YML.replace("size: large", `size: ${size}`), {
      policy: { ownSizes: [...listed] },
    });
    const asked = await w.request();
    await w.service.tick();
    const suite = w.checkStore.suites.get(asked.suiteId!)!;
    assertEquals(suite.state, "error");
    assertEquals(
      suite.reason,
      `checks.orchestrator.size: "${size}" is not a size class checks may use on this ` +
        "deployment (its operator lists those in RYPH_CHECKS_OWN_SIZES)",
    );
    assertEquals(w.launched.specs, []);
    assertEquals(liveKeys(w, suite), []);
  }
});

test("a slot is a pod: a suite with an own pod takes two", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 2 } });
  // Two lines of the run, so neither ask replaces the other.
  await w.request({ headSha: sha("1"), branch: `${w.run.branchNamespace}/work` });
  await w.request({ headSha: sha("2"), branch: `${w.run.branchNamespace}/fix-a` });
  await w.service.tick();
  assertEquals(
    w.suites().map((s) => s.state).sort(),
    ["queued", "running"],
    "the second waits for a slot",
  );
  assertEquals(await w.service.capacity(), { inUse: 2, total: 2 });
});

test("a suite launches once all its pods fit, and nobody behind it takes their slots", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 3 } });
  const branch = (name: string) => `${w.run.branchNamespace}/${name}`;
  const a = (await w.request({ headSha: sha("1"), branch: branch("work") })).suiteId!;
  await w.service.tick();
  const b = (await w.request({ headSha: sha("2"), branch: branch("fix-a") })).suiteId!;
  w.clock.advance(1_000);
  // One pod: it would fit the one slot left, and still waits its turn behind the suite of two.
  const c = (await w.request({ headSha: sha("3"), branch: branch("fix-b"), checks: ["lint"] }))
    .suiteId!;
  await w.service.tick();
  const state = (id: string) => w.checkStore.suites.get(id)!.state;
  assertEquals([state(a), state(b), state(c)], ["running", "queued", "queued"]);
  assertEquals(await w.service.capacity(), { inUse: 2, total: 3 });

  // The first suite's own pod is done: its slot is free, and the suite of two fits.
  const first = w.checkStore.suites.get(a)!;
  w.launched.finish(own(first), { orchestrator: 0 });
  await w.service.tick();
  assertEquals(await w.service.capacity(), { inUse: 1, total: 3 });
  await w.service.tick();
  assertEquals([state(a), state(b), state(c)], ["running", "running", "queued"]);
  assertEquals(await w.service.capacity(), { inUse: 3, total: 3 });
});

test("a suite with more pods than the deployment runs at once fails, saying so", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 1 } });
  const asked = await w.request();
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  assertEquals(suite.state, "error");
  assertEquals(
    suite.reason,
    "it needs 2 check pods at once, more than this deployment runs (RYPH_CHECKS_CONCURRENCY)",
  );
  assertEquals(w.launched.specs, []);
});

test("own record names fit every launcher and never meet, whatever the checks are named", () => {
  const checks = (...names: string[]): CheckDeclaration[] =>
    names.map((name) => ({
      name,
      run: "x",
      timeoutSeconds: null,
      services: [],
      watch: [],
      pod: "own" as const,
    }));
  const definition = {
    setup: [],
    checks: [
      { name: "lint", run: "x", timeoutSeconds: null, services: [], watch: [] },
      ...checks("a", "a-svc-x", `${"a".repeat(39)}b`, `${"a".repeat(39)}c`),
    ],
  };
  for (const generation of [1, 42, 123456]) {
    const suite = { id: mintId("cs"), generation, definition };
    const [shared, ...owns] = checkPods(suite).map((p) => p.name);
    assertEquals(owns.length, 4);
    for (const name of [shared, ...owns]) assert(CHECK_RECORD_NAME.test(name), name);
    // Every docker object is `<record>-<stage>`. Two own records' objects could meet only were
    // one record the other's prefix up to a dash; an own record's and the shared record's only
    // were a stage to begin with `o` and a digit, and none does (clone, setup-, check-, svc-…).
    for (const a of owns) {
      assert(/^o\d+(-|$)/.test(a.slice(`${shared}-`.length)), a);
      for (const b of owns) assert(a === b || !b.startsWith(`${a}-`), `${a} / ${b}`);
    }
    assertEquals(new Set(owns).size, owns.length);
  }
});

test("a pod name no launcher could make fails the suite before anything launches", async () => {
  const w = await ownWorld();
  const asked = await w.request();
  // A generation long enough that the shared record's name leaves an own pod no room.
  const stored = w.checkStore.suites.get(asked.suiteId!)!;
  stored.generation = 1_000_000_000;
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  assertEquals(suite.state, "error");
  assertStringIncludes(suite.reason!, "is longer than the 52 characters a check pod's name may be");
  assertEquals(w.launched.specs, []);
  assertEquals(liveKeys(w, suite), []);
});

/** A second control plane over the same store, with a launcher and a clock of its own. */
function replica(w: World, launcher: CheckLauncher, now = w.clock.now) {
  return makeChecksService({
    store: w.checkStore,
    tasks: w.store,
    launcher,
    forge: w.forge,
    environments: null,
    logs: w.logs,
    diag: w.diag,
    now,
    config: {
      policy: w.policy,
      agentImage: w.config.agentImage,
      runSizes: SIZES,
      gitGateway: w.config.gitGateway,
      services: { ...DEFAULT_SERVICE_POLICY, enabled: true },
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

/** `template`'s declaration with only `lint`: one pod. */
const onePod = (template: CheckSuite) => ({
  ...template.definition,
  checks: template.definition.checks.filter((c) => c.name === "lint"),
});
/** `template`'s declaration (the shared pod and `orchestrator`'s) and one more own check. */
const threePods = (template: CheckSuite) => ({
  ...template.definition,
  checks: [...template.definition.checks, {
    name: "e2e",
    run: "x",
    timeoutSeconds: null,
    services: [],
    watch: [],
    pod: "own" as const,
  }],
});
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

test("two replicas acting on one pod relaunch it once, in one millisecond or not", async () => {
  for (const moving of [true, false]) {
    const w = await ownWorld();
    const suite = await launched(w);
    const unschedulable = {
      kind: "unschedulable" as const,
      why: null,
      detail: "no node fits 16Gi",
    };
    w.launched.inspections.set(own(suite), unschedulable);
    const other = fakeCheckLauncher();
    for (const name of [checkRecordName(suite), own(suite)]) other.records.add(name);
    other.inspections.set(own(suite), unschedulable);
    // The other replica reads the pod, and before it acts this one relaunches it.
    const poll = other.launcher.poll;
    let raced = false;
    other.launcher.poll = async (name) => {
      const seen = await poll(name);
      if (name === own(suite) && !raced) {
        raced = true;
        await w.service.tick();
      }
      return seen;
    };
    // Moving: every read of the clock is a millisecond on. Frozen: every write in one millisecond.
    const now = moving
      ? () => {
        w.clock.advance(1);
        return w.clock.now();
      }
      : w.clock.now;
    await replica(w, other.launcher, now).tick();
    assert(raced);
    assertEquals(w.launched.specs.length, 3, "the first launch and one relaunch");
    assertEquals(other.specs, [], "the replica that read first launched nothing");
    assertEquals(other.discarded, []);
    const after = w.onlySuite();
    assertEquals(after.pods![own(suite)].attempts, 2);
    assertEquals(after.pods![own(suite)].reason, null);
    assertEquals(after.leaseUntil, null);
  }
});

test("while another repo waits, a repo launches only what keeps it within its half", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 4 } });
  await w.request();
  const template = w.onlySuite();
  w.checkStore.suites.clear();
  // api holds one of the four slots; half is two.
  const holding = plant(w, template, {
    id: "cs-api0000000",
    commit: sha("1"),
    state: "running",
    launchedAt: T0,
    definition: onePod(template),
    updatedAt: at(0),
  });
  w.launched.records.add(checkRecordName(holding));
  const big = plant(w, template, {
    id: "cs-api0000001",
    commit: sha("2"),
    state: "queued",
    definition: threePods(template),
    updatedAt: at(1),
  });
  const small = plant(w, template, {
    id: "cs-web0000000",
    connectedRepoId: w.web.id,
    commit: sha("3"),
    state: "queued",
    definition: onePod(template),
    updatedAt: at(2),
  });
  await w.service.tick();
  const state = (id: string) => w.checkStore.suites.get(id)!.state;
  assertEquals(
    [state(big.id), state(small.id)],
    ["queued", "running"],
    "one held and three brought is past api's half while web waits; web's one is not",
  );
});

test("a suite bigger than half the slots launches while another repo waits, from nothing held", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 4 } });
  await w.request();
  const template = w.onlySuite();
  w.checkStore.suites.clear();
  const holding = plant(w, template, {
    id: "cs-web0000000",
    connectedRepoId: w.web.id,
    commit: sha("1"),
    state: "running",
    launchedAt: T0,
    definition: onePod(template),
    updatedAt: at(0),
  });
  w.launched.records.add(checkRecordName(holding));
  const big = plant(w, template, {
    id: "cs-api0000000",
    commit: sha("2"),
    state: "queued",
    definition: threePods(template),
    updatedAt: at(1),
  });
  const small = plant(w, template, {
    id: "cs-web0000001",
    connectedRepoId: w.web.id,
    commit: sha("3"),
    state: "queued",
    definition: onePod(template),
    updatedAt: at(2),
  });
  await w.service.tick();
  const state = (id: string) => w.checkStore.suites.get(id)!.state;
  // Three pods are more than api's half of four ever is: from nothing held, they may go.
  assertEquals([state(big.id), state(small.id)], ["running", "queued"]);
  assertEquals(await w.service.capacity(), { inUse: 4, total: 4 });
});

test("a suite waiting for its slots pulls meanwhile, so nobody behind it jumps it once they free", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 3 } });
  const branch = (name: string) => `${w.run.branchNamespace}/${name}`;
  const a = (await w.request({ headSha: sha("1"), branch: branch("work") })).suiteId!;
  await w.service.tick();
  // Each image set pulls on its first ask, and is in on the next.
  const asked = new Set<string>();
  w.launched.state.images = () => {
    const key = JSON.stringify(w.launched.prepared.at(-1));
    if (asked.has(key)) return { kind: "ready" };
    asked.add(key);
    return { kind: "pulling" };
  };
  const b = (await w.request({ headSha: sha("2"), branch: branch("fix-a") })).suiteId!;
  // An image each, so each suite's pull is its own.
  w.checkStore.suites.get(b)!.image = "env-b";
  w.clock.advance(1_000);
  const c = (await w.request({ headSha: sha("3"), branch: branch("fix-b"), checks: ["lint"] }))
    .suiteId!;
  w.checkStore.suites.get(c)!.image = "env-c";
  const prepared = w.launched.prepared.length;
  await w.service.tick();
  const state = (id: string) => w.checkStore.suites.get(id)!.state;
  assertEquals([state(a), state(b), state(c)], ["running", "queued", "queued"]);
  assert(
    w.launched.prepared.slice(prepared).some((images) => images.includes("env-b")),
    "the suite of two, waiting for its slots, started its pull",
  );
  w.launched.finish(own(w.checkStore.suites.get(a)!), { orchestrator: 0 });
  await w.service.tick();
  await w.service.tick();
  assertEquals([state(a), state(b), state(c)], ["running", "running", "queued"]);
});

test("a check named setup keeps its own log beside a failed setup step's", async () => {
  const w = await ownWorld(`setup:
  - run: npm ci
checks:
  - name: lint
    run: x
  - name: setup
    run: y
    pod: own
`);
  const suite = await launched(w);
  w.launched.logs.set(`${own(suite, "setup")}/check-setup`, "own check ok\n");
  w.launched.finish(own(suite, "setup"), { setup: 0 });
  await w.service.tick();
  w.launched.logs.set(`${checkRecordName(suite)}/setup-0`, "npm ERR!\n");
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 1,
    why: "exit 1",
  });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  const rows = await w.checkStore.listResults(suite.id, 1);
  const check = rows.find((r) => r.name === "setup")!;
  assertEquals([check.state, check.logKey], ["passed", `checks/${suite.id}/1/setup.log`]);
  assertEquals(await w.logs.get(check.logKey!), "own check ok\n");
  const lint = rows.find((r) => r.name === "lint")!;
  assertEquals([lint.state, lint.logKey], ["setup_failed", `checks/${suite.id}/1/_setup.log`]);
  assertEquals(await w.logs.get(lint.logKey!), "npm ERR!\n");
});

test("a relaunch that finds the image gone takes the suite back to wait for its environment", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  // Keyed on its base's `.ryph/` tree, as a suite on a built environment is.
  w.checkStore.suites.get(suite.id)!.environmentKey = `tree:${tree("a")}`;
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a") });
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "checks",
    checks: {
      lint: { state: "exited", exitCode: 0, startedAt: null, finishedAt: null, reason: null },
      test: { state: "running", startedAt: null },
    },
    done: false,
  });
  w.launched.inspections.set(own(suite), {
    kind: "unschedulable",
    why: null,
    detail: "no node fits 16Gi",
  });
  w.launched.launcher.launch = (spec) =>
    Promise.reject(new ImageGone(`${spec.image} is no longer in docker's store`));
  await w.service.tick();
  const after = w.onlySuite();
  assertEquals(after.state, "waiting", after.reason ?? "");
  assertEquals([after.image, after.pods], [null, null]);
  // Every pod goes with it, and every key; what answered keeps its verdict for the next launch.
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
  assertEquals(liveKeys(w, suite), []);
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "running"],
    ["orchestrator", "queued"],
  ]);
});

test("a requeue, an adoption and a re-run each start every open pod's life afresh", async () => {
  // A launch interrupted after a life was written: requeued, the lives with it.
  const w = await ownWorld();
  const suite = await launched(w);
  const stored = w.checkStore.suites.get(suite.id)!;
  stored.launchedAt = null;
  stored.pods![own(suite)].attempts = 3;
  w.launched.records.delete(own(suite));
  await w.service.tick();
  const requeued = w.onlySuite();
  assertEquals([requeued.state, requeued.pods], ["queued", null]);

  // Adopted from a replica that died before it wrote: an earlier attempt's lives do not count.
  const g = await ownWorld();
  const adopt = await launched(g);
  const row = g.checkStore.suites.get(adopt.id)!;
  row.launchedAt = null;
  row.pods![own(adopt)].attempts = 3;
  await g.service.tick();
  const adopted = g.onlySuite();
  assert(adopted.launchedAt !== null);
  assertEquals(adopted.pods, null);

  // Settled, then re-run: the new generation's pods start at their first attempt.
  const r = await ownWorld();
  const first = await launched(r);
  r.launched.inspections.set(own(first), {
    kind: "unschedulable",
    why: null,
    detail: "no node fits 16Gi",
  });
  await r.service.tick();
  r.launched.finish(own(first), { orchestrator: 0 });
  r.launched.finish(checkRecordName(first), { lint: 0, test: 0 });
  await r.service.tick();
  assertEquals(r.onlySuite().state, "passed");
  assertEquals(r.onlySuite().pods![own(first)].attempts, 2);
  assertEquals((await r.service.rerun(first.id, { kind: "user", userId: "u-1" })).kind, "rerun");
  assertEquals(r.onlySuite().pods, null);
  await r.service.tick();
  const again = r.onlySuite();
  assertEquals(again.generation, 2);
  assertEquals(Object.values(again.pods!).map((life) => life.attempts), [1, 1]);
});

test("an unschedulable pod's reason names a size class only when its check asked for one", async () => {
  // An own pod of the shared pod's size: the operator's class is not the forge's to read.
  const w = await ownWorld(OWN_YML.replace("    size: large\n", ""), { policy: { ownSizes: [] } });
  const suite = await launched(w);
  for (let i = 0; i < 3; i++) {
    w.launched.inspections.set(own(suite), {
      kind: "unschedulable",
      why: null,
      detail: "0/5 nodes are available: 3 Insufficient memory, 2 node(s) had untolerated taint",
    });
    await w.service.tick();
  }
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  // The scheduler's words name the cluster's nodes: the operator's log has them, the reason not.
  assertEquals(
    w.onlySuite().reason,
    "orchestrator's own pod could not be scheduled (after 3 attempts)",
  );
  assertEquals(
    w.diagEvents.filter((e) => e.event === "checks.unschedulable").map((e) => e.fields?.detail),
    Array(3).fill(
      "0/5 nodes are available: 3 Insufficient memory, 2 node(s) had untolerated taint",
    ),
  );

  // One own check and no shared pod: the single pod's path says the same.
  for (const [size, said] of [["", ""], ["    size: large\n", " with size class large"]]) {
    const g = await ownWorld(`checks:
  - name: e2e
    run: x
    pod: own
${size}`);
    const alone = await launched(g);
    g.launched.inspections.set(own(alone, "e2e"), {
      kind: "unschedulable",
      why: null,
      detail: "0/5 nodes are available",
    });
    await g.service.tick();
    assertEquals(g.onlySuite().reason, `the check pod could not be scheduled${said}; retrying`);
    assert(g.diagEvents.some((e) => e.fields?.detail === "0/5 nodes are available"));
  }
});

test("a container that cannot start says why in the reason, in the kubelet's words", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "unschedulable",
    why: "svc-db: ImagePullBackOff: postgres:99 not found",
  });
  await w.service.tick();
  assertEquals(
    w.onlySuite().reason,
    "the check pod could not be scheduled: svc-db: ImagePullBackOff: postgres:99 not found; retrying",
  );
});

test("the repos view shows each declared check's pod and size", async () => {
  const w = await ownWorld();
  const [file] = await w.service.declaredOnDefault([w.api]);
  assert(file.state === "declared");
  assertEquals(file.checks.map((c) => [c.name, c.pod, c.size]), [
    ["lint", undefined, undefined],
    ["test", undefined, undefined],
    ["orchestrator", "own", "large"],
  ]);
});

test("a check answered error is never launched again in its generation, nor holds a slot", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.checkStore.suites.get(suite.id)!.environmentKey = `tree:${tree("a")}`;
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a") });
  // The own pod spends its attempts: its check is `error`, the shared pod runs on.
  for (let i = 0; i < 3; i++) {
    w.launched.inspections.set(own(suite), {
      kind: "unschedulable",
      why: null,
      detail: "no node fits 16Gi",
    });
    await w.service.tick();
  }
  assertEquals(await states(w, suite.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "error"],
  ]);
  // The shared pod's relaunch finds the image gone: the suite waits for its environment again.
  w.launched.inspections.set(checkRecordName(suite), {
    kind: "unschedulable",
    why: null,
    detail: "full",
  });
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = (spec) =>
    Promise.reject(new ImageGone(`${spec.image} is no longer in docker's store`));
  await w.service.tick();
  assertEquals(w.onlySuite().state, "waiting");
  // Its image back, queued again.
  w.launched.launcher.launch = launch;
  w.launched.inspections.delete(checkRecordName(suite));
  const waiting = w.checkStore.suites.get(suite.id)!;
  Object.assign(waiting, { state: "queued", image: suite.image, reason: null });
  const before = w.launched.specs.length;
  await w.service.tick();
  // Only the shared pod goes: the own pod's check answered, `error` as it is.
  assertEquals(w.launched.specs.slice(before).map((s) => s.name), [checkRecordName(suite)]);
  assertEquals(await w.service.capacity(), { inUse: 1, total: 4 });
  const relaunched = w.onlySuite();
  assertEquals(relaunched.state, "running");
  assertEquals(relaunched.pods![own(suite)].attempts, 3, "the done pod keeps its life");
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "error");
  assertEquals(
    settled.reason,
    "orchestrator's own pod could not be scheduled with size class large (after 3 attempts)",
  );
  assertEquals(await states(w, suite.id), [
    ["lint", "passed"],
    ["test", "passed"],
    ["orchestrator", "error"],
  ]);
});

test("a settle from a stale read lands nothing over another replica's write", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.finish(own(suite), { orchestrator: 0 });
  await w.service.tick();
  // The shared pod's rows are in, as a replica writes them before its own release.
  const rows = await w.checkStore.listResults(suite.id, 1);
  await w.checkStore.upsertResults(
    rows.filter((r) => r.name !== "orchestrator").map((r) => ({ ...r, state: "passed" as const })),
  );
  // This replica reads the suite; before it settles, another one writes the shared pod's reason.
  const other = fakeCheckLauncher();
  const listResults = w.checkStore.listResults;
  let raced = false;
  w.checkStore.listResults = async (id, generation) => {
    if (id === suite.id && !raced) {
      raced = true;
      const row = w.checkStore.suites.get(id)!;
      row.pods![checkRecordName(suite)].reason = "the shared check pod was slow";
      row.version += 1;
    }
    return await listResults(id, generation);
  };
  await replica(w, other.launcher).tick();
  w.checkStore.listResults = listResults;
  assert(raced);
  assertEquals(w.onlySuite().state, "running", "the stale settle did not land");
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "passed");
  assertEquals(settled.reason, "the shared check pod was slow");
});

test("a relaunched pod's new key is on the row at once, or revoked once the lease is lost", async () => {
  // A crash after the first relaunch: its key and attempt are already written.
  const w = await ownWorld();
  const suite = await launched(w);
  for (const name of [checkRecordName(suite), own(suite)]) {
    w.launched.inspections.set(name, { kind: "unschedulable", why: null, detail: "full" });
  }
  const save = w.checkStore.saveSuiteIf;
  let crashed = false;
  w.checkStore.saveSuiteIf = async (next, expected) => {
    if (crashed) throw new Error("the replica died");
    const landed = await save(next, expected);
    if (landed && next.pods?.[checkRecordName(suite)]?.attempts === 2) crashed = true;
    return landed;
  };
  await w.service.tick().catch(() => {});
  w.checkStore.saveSuiteIf = save;
  assert(crashed);
  const life = w.checkStore.suites.get(suite.id)!.pods![checkRecordName(suite)];
  assertEquals(life.attempts, 2);
  const key = w.checkStore.keys.get(life.keyId!)!;
  assertEquals(key.revokedAt, null, "the relaunch's own key, recorded");
  assertEquals(w.launched.specs[2].name, checkRecordName(suite));

  // The lease lost under the relaunch: the key it minted goes, and the row is not written.
  const g = await ownWorld();
  const lost = await launched(g);
  g.launched.inspections.set(own(lost), { kind: "unschedulable", why: null, detail: "full" });
  const launch = g.launched.launcher.launch;
  g.launched.launcher.launch = async (spec) => {
    await launch(spec);
    // Another replica wrote the row meanwhile.
    g.checkStore.suites.get(lost.id)!.version += 1;
  };
  await g.service.tick();
  assertEquals(g.launched.specs.length, 3);
  const row = g.onlySuite();
  assertEquals(row.pods![own(lost)].attempts, 1, "nothing written over it");
  // Three keys: the launch's two and the relaunch's. Only the shared pod's is live.
  assertEquals([...g.checkStore.keys.values()].filter((k) => k.suiteId === lost.id).length, 3);
  assertEquals(liveKeys(g, lost).map((k) => k.id), [row.pods![checkRecordName(lost)].keyId]);
});

test("a launch that throws part way discards the pod it half made too", async () => {
  const w = await ownWorld();
  // The orphan sweep's first pass, out of the way: it is not what discards here.
  await w.service.tick();
  const asked = await w.request();
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = async (spec) => {
    if (spec.name.includes("-o0-")) {
      // A Secret made, then the Job refused.
      w.launched.records.add(spec.name);
      throw new Error("the API server refused the Job");
    }
    await launch(spec);
  };
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  assertEquals(suite.state, "queued");
  assertEquals(discarded(w), [checkRecordName(suite), own(suite)].sort());
  assertEquals(w.launched.records.size, 0);
  assertEquals(liveKeys(w, suite), []);
});

test("the orphan sweep takes a done pod whose discard failed while its siblings run", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  const discard = w.launched.launcher.discard;
  w.launched.launcher.discard = (name) =>
    name === own(suite) ? Promise.reject(new Error("api timeout")) : discard(name);
  w.launched.finish(own(suite), { orchestrator: 0 });
  await w.service.tick();
  assertEquals(await states(w, suite.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "passed"],
  ]);
  assert(w.launched.records.has(own(suite)), "its discard failed");
  w.launched.launcher.discard = discard;
  w.clock.advance(61_000);
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running");
  assertEquals(discarded(w), [own(suite)]);
  assert(w.launched.records.has(checkRecordName(suite)), "the shared pod runs on");
});

test("a pod's clone key is revoked once, and its life says so", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  const keyId = w.onlySuite().pods![own(suite)].keyId!;
  const revoke = w.checkStore.revokeCheckGitKey;
  let revoked = 0;
  w.checkStore.revokeCheckGitKey = (id, at) => {
    if (id === keyId) revoked++;
    return revoke(id, at);
  };
  w.launched.inspections.set(own(suite), { kind: "pending", cloneDone: true, why: null });
  await w.service.tick();
  await w.service.tick();
  await w.service.tick();
  assertEquals(revoked, 1);
  assertEquals(w.onlySuite().pods![own(suite)].keyId, null);
  assertEquals(w.onlySuite().pods![own(suite)].attempts, 1);
});

test("a lone own pod keeps a failed setup step's log under the own pod's setup key", async () => {
  const w = await ownWorld(`setup:
  - run: npm ci
checks:
  - name: e2e
    run: x
    pod: own
`);
  const suite = await launched(w);
  w.launched.logs.set(`${own(suite, "e2e")}/setup-0`, "npm ERR!\n");
  w.launched.inspections.set(own(suite, "e2e"), {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 1,
    why: "exit 1",
  });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  const [row] = await w.checkStore.listResults(suite.id, 1);
  assertEquals([row.state, row.logKey], ["setup_failed", `checks/${suite.id}/1/_setup-e2e.log`]);
});

test("a size or a scope refused on one pod's relaunch ends only that pod's checks error", async () => {
  // The operator stopped listing the class since the launch.
  const w = await ownWorld();
  const suite = await launched(w);
  w.launched.inspections.set(own(suite), { kind: "unschedulable", why: null, detail: "full" });
  w.policy.ownSizes = [];
  await w.service.tick();
  assertEquals(w.onlySuite().state, "running");
  assertEquals(await states(w, suite.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "error"],
  ]);
  assert(w.launched.records.has(checkRecordName(suite)), "the shared pod runs on");
  assertEquals(w.launched.specs.length, 2);
  w.launched.finish(checkRecordName(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertStringIncludes(
    w.onlySuite().reason!,
    "orchestrator's own pod could not be launched again: checks.orchestrator.size:",
  );

  // The requesting run's network scope no longer fits the deployment's.
  const g = await ownWorld(OWN_YML, {
    world: {
      egress: {
        policy: {
          mode: "proxy",
          bundles: [],
          hosts: ["a.test"],
          proxyUrl: "http://proxy.test:3128",
        },
        key: new Uint8Array(32).fill(7),
        tokenTtlMs: 3_600_000,
      },
    },
  });
  const scoped = await launched(g);
  g.checkStore.suites.get(scoped.id)!.networkScope = {
    mode: "proxy",
    bundles: [],
    hosts: ["elsewhere.test"],
  };
  g.launched.inspections.set(own(scoped), { kind: "unschedulable", why: null, detail: "full" });
  await g.service.tick();
  assertEquals(g.onlySuite().state, "running");
  assertEquals(await states(g, scoped.id), [
    ["lint", "queued"],
    ["test", "queued"],
    ["orchestrator", "error"],
  ]);
  assertEquals(liveKeys(g, scoped).length, 1, "only the shared pod's key is live");
});

test("the repos view says when a file needs more pods than the deployment runs", async () => {
  const fits = await ownWorld();
  const [file] = await fits.service.declaredOnDefault([fits.api]);
  assert(file.state === "declared");
  assertEquals([file.podsNeeded, file.warning], [2, undefined]);

  const tight = await ownWorld(OWN_YML, { policy: { maxConcurrent: 1 } });
  const [over] = await tight.service.declaredOnDefault([tight.api]);
  assert(over.state === "declared");
  assertEquals(over.podsNeeded, 2);
  assertEquals(
    over.warning,
    "A full suite fails here: it needs 2 check pods at once, more than this deployment runs " +
      "(RYPH_CHECKS_CONCURRENCY).",
  );
});

test("a stale poll of an interrupted launch tears down nothing of a successor's relaunch", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  // As a replica that died between its launches and its write leaves it, its own pod lost.
  const stored = w.checkStore.suites.get(suite.id)!;
  stored.launchedAt = null;
  stored.pods = null;
  w.launched.records.delete(own(suite));
  // This replica reads the own pod gone; before it acts, another requeues and relaunches.
  const poll = w.launched.launcher.poll;
  let raced = false;
  const stale: CheckLauncher = {
    ...w.launched.launcher,
    poll: async (name) => {
      const seen = await poll(name);
      if (name === own(suite) && !raced) {
        raced = true;
        await w.service.tick();
        assertEquals(w.onlySuite().state, "queued");
        await w.service.tick();
      }
      return seen;
    },
  };
  await replica(w, stale).tick();
  assert(raced);
  const after = w.onlySuite();
  assertEquals(after.state, "running");
  assertEquals(w.launched.specs.length, 4, "the first launch and the successor's");
  assert(w.launched.records.has(checkRecordName(suite)));
  assert(w.launched.records.has(own(suite)));
  // The successor's two keys, each its pod's.
  assertEquals(
    liveKeys(w, suite).map((k) => k.id).sort(),
    Object.values(after.pods!).map((life) => life.keyId).sort(),
  );
});

test("a stale poll of one pod's platform failure tears down nothing of a successor's relaunch", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  const name = checkRecordName(suite);
  w.launched.inspections.set(name, { kind: "unschedulable", why: null, detail: "full" });
  const poll = w.launched.launcher.poll;
  let raced = false;
  const stale: CheckLauncher = {
    ...w.launched.launcher,
    poll: async (record) => {
      const seen = await poll(record);
      if (record === name && !raced) {
        raced = true;
        await w.service.tick();
        assertEquals(w.onlySuite().state, "queued");
        w.launched.inspections.delete(name);
        await w.service.tick();
      }
      return seen;
    },
  };
  await replica(w, stale).tick();
  assert(raced);
  assertEquals(w.onlySuite().state, "running");
  assertEquals(w.launched.specs.length, 2, "the first launch and the successor's");
  assert(w.launched.records.has(name));
  assertEquals(liveKeys(w, suite).length, 1, "the successor's key");
});

test("a launch that outlives its claim holds no slot and leaves its pods to the successor", async () => {
  const w = await ownWorld(OWN_YML, { policy: { maxConcurrent: 3 } });
  const branch = (name: string) => `${w.run.branchNamespace}/${name}`;
  const a = (await w.request({ headSha: sha("1"), branch: branch("work") })).suiteId!;
  w.clock.advance(1_000);
  const b = (await w.request({ headSha: sha("2"), branch: branch("fix-a") })).suiteId!;
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = async (spec) => {
    await launch(spec);
    // The first suite's last pod: its lease ran out meanwhile, and a successor adopted it.
    if (spec.name === ownRecordName(w.checkStore.suites.get(a)!, "orchestrator")) {
      const row = w.checkStore.suites.get(a)!;
      row.launchedAt = w.clock.now().toISOString();
      row.version += 1;
    }
  };
  await w.service.tick();
  const first = w.checkStore.suites.get(a)!;
  assertEquals(first.state, "running");
  assertEquals(first.pods, null, "the lost launch wrote nothing");
  assert(w.launched.records.has(checkRecordName(first)));
  assert(w.launched.records.has(own(first)));
  assertEquals(liveKeys(w, first).length, 2);
  assertEquals(w.checkStore.suites.get(b)!.state, "running", "the lost launch counted no slot");
});

test("a launch that throws after its claim is lost discards nothing", async () => {
  const w = await ownWorld();
  const asked = await w.request();
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = async (spec) => {
    if (spec.name.includes("-o0-")) throw new Error("the API server refused the Job");
    await launch(spec);
    // A successor took the suite over between the two launches.
    w.checkStore.suites.get(asked.suiteId!)!.version += 1;
  };
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  assertEquals(w.launched.discarded, []);
  assert(w.launched.records.has(checkRecordName(suite)));
});

test("a relaunch's key written to the row survives a lease lost before the next pod's", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  for (const name of [checkRecordName(suite), own(suite)]) {
    w.launched.inspections.set(name, { kind: "unschedulable", why: null, detail: "full" });
  }
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = async (spec) => {
    await launch(spec);
    // The shared pod's relaunch is written; the lease is lost under the own pod's.
    if (spec.name === own(suite)) w.checkStore.suites.get(suite.id)!.version += 1;
  };
  await w.service.tick();
  assertEquals(w.launched.specs.length, 4);
  const row = w.onlySuite();
  assertEquals(row.pods![checkRecordName(suite)].attempts, 2);
  assertEquals(row.pods![own(suite)].attempts, 1, "nothing written over it");
  const keys = [...w.checkStore.keys.values()].filter((k) => k.suiteId === suite.id);
  assertEquals(keys.length, 4, "the launch's two and both relaunches'");
  assertEquals(liveKeys(w, suite).map((k) => k.id), [row.pods![checkRecordName(suite)].keyId]);
});

test("the repos view warns of nothing where another deployment runs the checks", async () => {
  const w = await checksWorld({
    remote: {
      endpoint: "https://checks.example",
      readChecksFile: () =>
        Promise.resolve(
          checksFile({ text: OWN_YML, services: { kind: "file", text: SERVICES_YML } }),
        ),
      submit: () => Promise.reject(new Error("unused")),
      read: () => Promise.reject(new Error("unused")),
      cancel: () => Promise.reject(new Error("unused")),
      log: () => Promise.reject(new Error("unused")),
    },
    noLauncher: true,
    noEnvironments: true,
    policy: { maxConcurrent: 1 },
  });
  const [file] = await w.service.declaredOnDefault([w.api]);
  assert(file.state === "declared");
  assertEquals([file.podsNeeded, file.warning], [2, undefined]);
});

test("a stale replica's .ryph/ stamp costs a relaunch under another's lease nothing", async () => {
  const w = await ownWorld();
  const suite = await launched(w);
  const shared = checkRecordName(suite);
  const running = { state: "running" as const, startedAt: null };
  w.launched.inspections.set(shared, {
    kind: "checks",
    checks: { lint: running, test: running },
    done: false,
  });
  w.launched.inspections.set(own(suite), {
    kind: "unschedulable",
    why: null,
    detail: "no node fits 16Gi",
  });
  // The other replica reads lint answered, on a list that touched `.ryph/`.
  const other = fakeCheckLauncher();
  for (const name of [shared, own(suite)]) other.records.add(name);
  other.inspections.set(shared, {
    kind: "checks",
    checks: {
      lint: { state: "exited", exitCode: 0, startedAt: null, finishedAt: null, reason: null },
      test: running,
    },
    done: false,
  });
  other.inspections.set(own(suite), {
    kind: "checks",
    checks: { orchestrator: running },
    done: false,
  });
  other.logs.set(`${shared}/clone`, "@@ryph-changed .ryph/checks.yml\n@@ryph-changed-end 1\n");
  // This replica relaunches the own pod under its lease; the other, having read before the
  // lease, stamps `.ryph/` while the relaunch is in flight.
  let inLaunch!: () => void;
  const launching = new Promise<void>((resolve) => (inLaunch = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const launch = w.launched.launcher.launch;
  w.launched.launcher.launch = async (spec) => {
    await launch(spec);
    inLaunch();
    await released;
  };
  let acting: Promise<void> | null = null;
  const poll = other.launcher.poll;
  other.launcher.poll = async (name) => {
    const seen = await poll(name);
    if (name === shared && acting === null) {
      acting = w.service.tick();
      await launching;
    }
    return seen;
  };
  await replica(w, other.launcher).tick();
  assertEquals(w.onlySuite().ryphChanged, true);
  release();
  await acting!;
  const after = w.onlySuite();
  assertEquals(after.ryphChanged, true);
  assertEquals(after.leaseUntil, null);
  assertEquals(after.pods![own(suite)].attempts, 2);
  assertEquals(after.pods![own(suite)].reason, null);
  assertEquals(
    liveKeys(w, suite).map((k) => k.id),
    [after.pods![own(suite)].keyId],
    "the relaunched pod's key",
  );
});

test("a stale poll past one pod's clone revokes no key a successor minted", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  const name = checkRecordName(suite);
  w.launched.inspections.set(name, { kind: "unschedulable", why: null, detail: "full" });
  // The other replica reads the pod past its clone; before it acts, this one requeues the suite
  // and relaunches it with a key of its own.
  const other = fakeCheckLauncher();
  other.records.add(name);
  other.inspections.set(name, {
    kind: "checks",
    checks: { lint: { state: "running", startedAt: null } },
    done: false,
  });
  const poll = other.launcher.poll;
  let raced = false;
  other.launcher.poll = async (record) => {
    const seen = await poll(record);
    if (!raced) {
      raced = true;
      await w.service.tick();
      assertEquals(w.onlySuite().state, "queued");
      w.launched.inspections.delete(name);
      // The clock stands still: the key is told apart by id, not by when it was minted.
      await w.service.tick();
    }
    return seen;
  };
  await replica(w, other.launcher).tick();
  assert(raced);
  assertEquals(w.onlySuite().state, "running");
  assertEquals(w.launched.specs.length, 2, "the first launch and the successor's");
  assertEquals(liveKeys(w, suite).length, 1, "the successor's key");
});

test("a settle's revoke takes no key of a re-run's next generation", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  // Between the settle's write and its revoke, a re-run launches generation 2 on another replica.
  const revoke = w.checkStore.revokeCheckGitKeys;
  let raced = false;
  w.checkStore.revokeCheckGitKeys = async (...args) => {
    if (!raced) {
      raced = true;
      await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
      await replica(w, w.launched.launcher).tick();
    }
    return await revoke(...args);
  };
  w.launched.finish(checkRecordName(suite), { lint: 0 });
  await w.service.tick();
  assert(raced);
  const rerun = w.onlySuite();
  assertEquals([rerun.state, rerun.generation], ["running", 2]);
  assertEquals(liveKeys(w, suite).map((k) => k.generation), [2], "the re-run's key");
});

test("an adopted single pod past its clone revokes its generation's keys under the lease, once", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  const name = checkRecordName(suite);
  // The launching replica died before it wrote the launch down: its key has no name.
  w.checkStore.suites.set(suite.id, { ...w.onlySuite(), launchedAt: null, pods: null });
  w.launched.inspections.set(name, {
    kind: "checks",
    checks: { lint: { state: "running", startedAt: null } },
    done: false,
  });
  await w.service.tick();
  const adopted = w.onlySuite();
  assertEquals(liveKeys(w, suite), []);
  assertEquals(adopted.leaseUntil, null);
  assertEquals(adopted.pods![name].keyId, null);
  await w.service.tick();
  assertEquals(w.onlySuite().version, adopted.version, "written down: nothing more to revoke");
});

test("an adopted single pod whose write is beaten gives its lease back", async () => {
  const w = await ownWorld("checks:\n  - name: lint\n    run: deno lint\n");
  const suite = await launched(w);
  const name = checkRecordName(suite);
  w.checkStore.suites.set(suite.id, { ...w.onlySuite(), launchedAt: null, pods: null });
  w.launched.inspections.set(name, {
    kind: "checks",
    checks: { lint: { state: "running", startedAt: null } },
    done: false,
  });
  // An unleased writer (an asker joining, say) moves the row while the keys go.
  const revoke = w.checkStore.revokeCheckGitKeys;
  let raced = false;
  w.checkStore.revokeCheckGitKeys = async (...args) => {
    if (!raced) {
      raced = true;
      const now = w.onlySuite();
      w.checkStore.suites.set(suite.id, { ...now, version: now.version + 1 });
    }
    return await revoke(...args);
  };
  await w.service.tick();
  assert(raced);
  assertEquals(liveKeys(w, suite), []);
  assertEquals(w.onlySuite().leaseUntil, null, "not idle until the lease runs out");
});
