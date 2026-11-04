// A new suite takes the passes its commit already has (`reusePasses`): an agent that ran the
// checks it broke first, then all of them, pays only for the rest. Only passes, never on a
// re-run of the whole suite, and only from a suite that ran the check the same way.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checksFile, checksWorld, HEAD, sha } from "./checks_world.ts";
import { tree } from "./environment_world.ts";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";

type World = Awaited<ReturnType<typeof checksWorld>>;

/** Runs a suite on the world's head to its end, each check exiting as given: a subset of those
 * checks, or with `full`, the whole suite. */
async function ranSubset(w: World, exits: Record<string, number>, full = false) {
  const asked = await w.request(full ? {} : { checks: Object.keys(exits) });
  await w.service.tick();
  const suite = w.checkStore.suites.get(asked.suiteId!)!;
  w.launched.finish(w.nameOf(suite), exits);
  await w.service.tick();
  return w.checkStore.suites.get(suite.id)!;
}

const states = async (w: World, suiteId: string, generation = 1) =>
  (await w.checkStore.listResults(suiteId, generation)).map((r) => [r.name, r.state]);

test("a full suite after a passing subset runs only the rest, and shows the pass", async () => {
  const w = await checksWorld();
  const partial = await ranSubset(w, { lint: 0 });
  assertEquals(partial.state, "passed");
  const kept = (await w.checkStore.listResults(partial.id, 1))[0];

  const full = await w.request();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  const lintRow = (await w.checkStore.listResults(suite.id, 1)).find((r) => r.name === "lint")!;
  // The earlier run's row, its output included, as this suite's.
  assertEquals([lintRow.state, lintRow.exitCode, lintRow.logKey], ["passed", 0, kept.logKey]);
  assertEquals(await states(w, suite.id), [["lint", "passed"], ["test", "queued"]]);

  await w.service.tick();
  // The pod runs only what has no verdict yet, so it gets the whole class.
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["test"]);
  w.launched.finish(w.nameOf(suite), { test: 0 });
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(suite.id)!.state, "passed");
  assertEquals(await states(w, suite.id), [["lint", "passed"], ["test", "passed"]]);
  // Marked wherever it is shown: the page's view, the run's note.
  const rows = await w.checkStore.listResults(suite.id, 1);
  assertEquals(rows.map((r) => [r.name, r.inheritedFrom]), [["lint", partial.id], ["test", null]]);
  const view = (await w.service.view(suite.id, SCOPE_ALL))!;
  assertEquals(view.checks.map((c) => [c.name, c.inherited]), [["lint", true], ["test", false]]);
  const lines = (await w.told()).at(-1)!.text.split("\n");
  const marked = "(from an earlier run on this commit, not run again)";
  assert(lines.find((l) => l.startsWith("- lint:"))!.includes(marked), lines.join("\n"));
  assert(!lines.find((l) => l.startsWith("- test:"))!.includes(marked), lines.join("\n"));
});

test("every check already passed: the suite passes with no pod, answered at once", async () => {
  const w = await checksWorld();
  const lint = await ranSubset(w, { lint: 0 });
  await ranSubset(w, { test: 0 });
  // What the clones said about `.ryph/`: this suite has no clone of its own to ask.
  await w.checkStore.setSuiteRyphChanged(lint.id, true);
  const launches = w.launched.specs.length;
  const toldBefore = (await w.told()).length;

  const full = await w.request();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  assertEquals(suite.state, "passed");
  assertEquals(suite.ryphChanged, true);
  // The verdict is in the tool's own answer, so no message repeats it.
  assertStringIncludes(full.text, "The result is below.");
  assert(!full.text.includes("arrives as a message"), full.text);
  await w.service.tick();
  assertEquals(w.launched.specs.length, launches, "nothing launched");
  assertEquals((await w.told()).length, toldBefore);
  assertEquals(await w.awaiting(), 0);
});

test("a pass from another base takes no .ryph/ answer: the suite's own clone says", async () => {
  const w = await checksWorld();
  const lint = await ranSubset(w, { lint: 0 });
  // Against another base the change to `.ryph/` may read otherwise.
  w.checkStore.suites.set(lint.id, { ...lint, checksCommit: sha("9"), ryphChanged: true });

  const full = await w.request();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  assertEquals(await states(w, suite.id), [["lint", "passed"], ["test", "queued"]]);
  assertEquals(suite.ryphChanged, null);
  await w.service.tick();
  const name = w.nameOf(suite);
  w.launched.logs.set(`${name}/clone`, "@@ryph-changed src/a.ts\n@@ryph-changed-end 1\n");
  w.launched.finish(name, { test: 0 });
  await w.service.tick();
  const settled = w.checkStore.suites.get(suite.id)!;
  assertEquals([settled.state, settled.ryphChanged], ["passed", false]);
});

test("a failure is not taken: the full suite runs that check again", async () => {
  const w = await checksWorld();
  await ranSubset(w, { lint: 1 });
  const full = await w.request();
  assertEquals(await states(w, full.suiteId!), [["lint", "queued"], ["test", "queued"]]);
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["lint", "test"]);
});

test("a pass recorded while its suite still runs is taken", async () => {
  const w = await checksWorld();
  const both = await w.request({ checks: ["lint", "test"] }).then(() => w.onlySuite());
  await w.service.tick();
  // lint exited with its own verdict; test still runs.
  w.launched.inspections.set(w.nameOf(both), {
    kind: "checks",
    done: false,
    checks: {
      lint: {
        state: "exited",
        exitCode: 0,
        startedAt: "2026-01-01T00:01:00.000Z",
        finishedAt: "2026-01-01T00:02:00.000Z",
        reason: null,
      },
      test: { state: "running", startedAt: "2026-01-01T00:01:00.000Z" },
    },
  } as never);
  await w.service.tick();
  assertEquals(await states(w, both.id), [["lint", "passed"], ["test", "running"]]);

  // A subset of lint alone, on the same commit: taken from the running suite.
  const lint = await w.request({ checks: ["lint"] });
  assertEquals(w.checkStore.suites.get(lint.suiteId!)!.state, "passed");
});

test("a pass is taken only from a suite that ran the check the same way", async () => {
  const w = await checksWorld();
  const partial = await ranSubset(w, { lint: 0 });

  // Another commit.
  const other = await w.request({ headSha: sha("e") });
  assertEquals(await states(w, other.suiteId!), [["lint", "queued"], ["test", "queued"]]);

  // Another image: the source was keyed on one no longer chosen.
  w.checkStore.suites.set(partial.id, { ...partial, environmentKey: "image:elsewhere" });
  let full = await w.request();
  assertEquals(await states(w, full.suiteId!), [["lint", "queued"], ["test", "queued"]]);
  w.checkStore.suites.delete(full.suiteId!);

  // Another network scope.
  w.checkStore.suites.set(partial.id, {
    ...partial,
    networkScope: { ...partial.networkScope, hosts: ["registry.example"] },
  });
  full = await w.request();
  assertEquals(await states(w, full.suiteId!), [["lint", "queued"], ["test", "queued"]]);
  w.checkStore.suites.delete(full.suiteId!);

  // The base's checks file changed.
  w.checkStore.suites.set(partial.id, partial);
  w.files.set("*", checksFile({ blob: sha("b") }));
  full = await w.request();
  assertEquals(await states(w, full.suiteId!), [["lint", "queued"], ["test", "queued"]]);
});

test("a pass is taken across a base that moved, when what it read there did not", async () => {
  const w = await checksWorld();
  const partial = await ranSubset(w, { lint: 0 });

  // A merge moved the base; its checks file, image and services are as they were.
  w.files.set("*", checksFile({ commit: sha("f") }));
  const full = await w.request();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  assert(suite.checksCommit !== partial.checksCommit);
  assertEquals(await states(w, suite.id), [["lint", "passed"], ["test", "queued"]]);
});

test("a re-run runs every check again, passes included", async () => {
  const w = await checksWorld();
  await ranSubset(w, { lint: 0 });
  const full = await w.request();
  await w.service.tick();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  w.launched.finish(w.nameOf(suite), { test: 1 });
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(suite.id)!.state, "failed");

  const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  assert(rerun.kind === "rerun");
  assertEquals(await states(w, suite.id, 2), [["lint", "queued"], ["test", "queued"]]);
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["lint", "test"]);
});

test("the forge's re-run of one check runs it and the failures, keeping the other passes", async () => {
  const w = await checksWorld();
  const full = await w.request();
  await w.service.tick();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
  await w.service.tick();
  const press = (generation: number, check: string, deliveryId: string) =>
    w.service.forgeRerequested({
      connectedRepoId: w.api.id,
      headSha: HEAD,
      externalId: `${suite.id}:${generation}:${check}`,
      deliveryId,
    });

  // Re-run on the flaky one: only it runs, lint's pass stays, marked as the first run's.
  assertEquals(await press(1, "test", "d-1"), "checks-rerun");
  assertEquals(await states(w, suite.id, 2), [["lint", "passed"], ["test", "queued"]]);
  const lint = (await w.checkStore.listResults(suite.id, 2)).find((r) => r.name === "lint")!;
  assertEquals(lint.inheritedFrom, suite.id);
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["test"]);
  w.launched.finish(w.nameOf(w.checkStore.suites.get(suite.id)!), { test: 0 });
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(suite.id)!.state, "passed");

  // Re-run on a green one: that one runs, the other keeps its pass.
  assertEquals(await press(2, "lint", "d-2"), "checks-rerun");
  assertEquals(await states(w, suite.id, 3), [["lint", "queued"], ["test", "passed"]]);
  await w.service.tick();
  w.launched.finish(w.nameOf(w.checkStore.suites.get(suite.id)!), { lint: 0 });
  await w.service.tick();

  // A name the suite does not declare runs everything, as "Re-run all" would.
  assertEquals(await press(3, "gone", "d-3"), "checks-rerun");
  assertEquals(await states(w, suite.id, 4), [["lint", "queued"], ["test", "queued"]]);
});

test("the forge's re-run of one check runs the suite's other failures, a sibling's pass aside", async () => {
  const w = await checksWorld();
  const full = await w.request();
  await w.service.tick();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  w.launched.finish(w.nameOf(suite), { lint: 1, test: 1 });
  await w.service.tick();
  // Another suite on the head passed test since.
  await ranSubset(w, { test: 0 });

  const again = await w.service.forgeRerequested({
    connectedRepoId: w.api.id,
    headSha: HEAD,
    externalId: `${suite.id}:1:lint`,
    deliveryId: "d-1",
  });
  assertEquals(again, "checks-rerun");
  assertEquals(await states(w, suite.id, 2), [["lint", "queued"], ["test", "queued"]]);
});

test("joining a suite a subset ask cancelled takes the passes since", async () => {
  const w = await checksWorld();
  const full = await w.request();
  await w.service.tick();
  // The agent narrows down: the subset call replaces the full one, which is cancelled.
  await ranSubset(w, { lint: 0 });
  assertEquals(w.checkStore.suites.get(full.suiteId!)!.state, "cancelled");

  const again = await w.request();
  assertEquals(again.suiteId, full.suiteId);
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  assertEquals(suite.generation, 2);
  assertEquals(await states(w, suite.id, 2), [["lint", "passed"], ["test", "queued"]]);
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["test"]);
});

test("asking a failed suite again after its failure passed alone passes it, with no pod", async () => {
  const w = await checksWorld();
  const failed = await ranSubset(w, { lint: 0, test: 1 }, true);
  assertEquals(failed.state, "failed");
  // The flaky one, retried by itself.
  const alone = await ranSubset(w, { test: 0 });
  const launches = w.launched.specs.length;

  const again = await w.request();
  assertEquals(again.suiteId, failed.id);
  const suite = w.checkStore.suites.get(failed.id)!;
  assertEquals([suite.generation, suite.state], [2, "passed"]);
  const rows = await w.checkStore.listResults(suite.id, 2);
  assertEquals(rows.map((r) => [r.name, r.inheritedFrom]), [["lint", failed.id], [
    "test",
    alone.id,
  ]]);
  await w.service.tick();
  assertEquals(w.launched.specs.length, launches, "nothing launched");
});

test("asking a failed suite again runs only its failures", async () => {
  const w = await checksWorld();
  const failed = await ranSubset(w, { lint: 0, test: 1 }, true);

  const again = await w.request();
  // It runs, so the answer says so, as a cancelled suite's does.
  assertEquals(again.reused, false);
  assert(!again.text.includes("does not run twice"), again.text);
  const suite = w.checkStore.suites.get(failed.id)!;
  assertEquals(suite.generation, 2);
  assertEquals(await states(w, suite.id, 2), [["lint", "passed"], ["test", "queued"]]);
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["test"]);
});

test("a patch's ask of a failed suite keeps the failure", async () => {
  const w = await checksWorld();
  const failed = await ranSubset(w, { lint: 0, test: 1 }, true);
  await ranSubset(w, { test: 0 });

  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  const suite = w.checkStore.suites.get(failed.id)!;
  const [asked] = await w.checkStore.listRequestsForPatches([patch.id]);
  assertEquals(asked.suiteId, failed.id);
  assertEquals([suite.generation, suite.state], [1, "failed"]);
});

test("a relaunched pod leaves out the checks that already answered", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const name = w.nameOf(w.onlySuite());
  // test passed; lint was evicted, the platform's fault.
  w.launched.finish(name, { lint: { exitCode: 137, reason: "Evicted" }, test: 0 });
  await w.service.tick();
  w.launched.inspections.delete(name);
  assertEquals(w.onlySuite().state, "queued");
  await w.service.tick();
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["lint"]);
  w.launched.finish(name, { lint: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
});

test(
  "a queued suite whose every check holds a verdict settles at launch, with no pod",
  async () => {
    const w = await checksWorld();
    const full = await w.request();
    const rows = await w.checkStore.listResults(full.suiteId!, 1);
    // Verdicts that landed between the claim and the launch.
    await w.checkStore.upsertResults(
      rows.map((r) => ({ ...r, state: "passed" as const, exitCode: 0, finishedAt: r.startedAt })),
    );
    await w.service.tick();
    assertEquals(w.launched.specs.length, 0);
    assertEquals(w.checkStore.suites.get(full.suiteId!)!.state, "passed");
  },
);

test("a suite waiting on its environment passes at once when every check passed", async () => {
  const w = await checksWorld();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
  const lint = await w.request({ checks: ["lint"] });
  const testSuite = w.checkStore.suites.get(lint.suiteId!)!;
  assertEquals(testSuite.state, "waiting");
  // Both checks passed on suites keyed on the same tree.
  const rows = await w.checkStore.listResults(testSuite.id, 1);
  await w.checkStore.upsertResults(
    rows.map((r) => ({ ...r, state: "passed" as const, exitCode: 0 })),
  );
  const other = await w.request({ checks: ["test"] });
  await w.checkStore.upsertResults(
    (await w.checkStore.listResults(other.suiteId!, 1)).map((r) => ({
      ...r,
      state: "passed" as const,
      exitCode: 0,
    })),
  );
  const full = await w.request();
  const suite = w.checkStore.suites.get(full.suiteId!)!;
  assertEquals(suite.environmentKey, `tree:${tree("a")}`);
  assertEquals([suite.state, suite.waitingSince], ["passed", null]);
});

test("a pass is taken only where the services its check names were the same", async () => {
  const w = await checksWorld({ services: { ...DEFAULT_SERVICE_POLICY, enabled: true } });
  w.files.set(
    "*",
    checksFile({
      text: "checks:\n  - name: lint\n    run: x\n  - name: e2e\n    run: y\n" +
        "    services: [db]\n",
      services: { kind: "file", text: "services:\n  db:\n    uses: postgres@18\n    port: 5433\n" },
    }),
  );
  await ranSubset(w, { lint: 0 });
  const e2e = await ranSubset(w, { e2e: 0 });
  assertEquals(e2e.services.map((s) => s.name), ["db"]);
  // The db that pass ran beside was not the one this suite gets.
  w.checkStore.suites.set(e2e.id, {
    ...e2e,
    services: e2e.services.map((s) => ({ ...s, image: "postgres:17" })),
  });
  const full = await w.request();
  assertEquals(await states(w, full.suiteId!), [["e2e", "queued"], ["lint", "passed"]]);
});

test(
  "a join takes its own last generation's early passes, with no other suite to take from",
  async () => {
    const w = await checksWorld();
    const full = await w.request();
    await w.service.tick();
    const suite = w.checkStore.suites.get(full.suiteId!)!;
    // lint answered before the suite was cancelled; nothing else on the commit has it.
    w.launched.inspections.set(w.nameOf(suite), {
      kind: "checks",
      done: false,
      checks: {
        lint: {
          state: "exited",
          exitCode: 0,
          startedAt: "2026-01-01T00:01:00.000Z",
          finishedAt: "2026-01-01T00:02:00.000Z",
          reason: null,
        },
        test: { state: "running", startedAt: "2026-01-01T00:01:00.000Z" },
      },
    } as never);
    await w.service.tick();
    await w.request({ headSha: sha("e") });
    await w.service.tick();
    assertEquals(w.checkStore.suites.get(suite.id)!.state, "cancelled");

    const again = await w.request();
    assertEquals(again.suiteId, suite.id);
    assertEquals(await states(w, suite.id, 2), [["lint", "passed"], ["test", "queued"]]);
  },
);

test(
  "a suite waiting on its environment keeps the .ryph/ answer it took with a pass",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    const lint = await w.request({ checks: ["lint"] });
    const source = w.checkStore.suites.get(lint.suiteId!)!;
    await w.checkStore.upsertResults(
      (await w.checkStore.listResults(source.id, 1)).map((r) => ({
        ...r,
        state: "passed" as const,
        exitCode: 0,
      })),
    );
    await w.checkStore.setSuiteRyphChanged(source.id, true);
    const full = await w.request();
    const suite = w.checkStore.suites.get(full.suiteId!)!;
    assertEquals(suite.state, "waiting");
    assert(suite.environmentId !== null, "attached to its build");
    assertEquals(suite.ryphChanged, true);
  },
);
