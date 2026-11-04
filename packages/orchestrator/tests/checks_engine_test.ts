// The checks engine (core/checks.ts) against a fake launcher and a fake forge: suites claimed on
// their identity and joined, launched once under a lease and adopted after a crash, waiting on
// the base's environment, settled from what the launcher observed, told to the run once per
// generation, reported to the forge, re-run, and never answered "no checks" for a read that
// failed.

import { test } from "bun:test";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  checkRecordName,
  makeChecksService,
  resultFromContainer,
  settlesEarly,
  suiteVerdict,
} from "../src/core/checks.ts";
import {
  claimSentence,
  planForgeReport,
  reportFingerprint,
  stripAnsi,
} from "../src/core/check_feedback.ts";
import { ID_BODY, sha256Hex } from "@ryph/sealed";
import { DEFAULT_SERVICE_POLICY } from "../src/core/services.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";
import { verifyEgressToken } from "../src/core/egress.ts";
import { MAX_MESSAGE_CHARS, type Run } from "../src/core/types.ts";
import { APP_URL, BASE, BLOB, checksFile, checksWorld, HEAD, sha, T0 } from "./checks_world.ts";
import { tree } from "./environment_world.ts";
import type { Environment } from "../src/core/types.ts";
import type { BundleSource } from "../src/core/check_types.ts";

test("a container's end maps to a verdict: 0, 124, OOM, the deadline, anything else", () => {
  const exited = (exitCode: number, reason: string | null = null) => ({
    state: "exited" as const,
    exitCode,
    startedAt: null,
    finishedAt: null,
    reason,
  });
  assertEquals(resultFromContainer(exited(0)).state, "passed");
  assertEquals(resultFromContainer(exited(124)).state, "timed_out");
  assertEquals(resultFromContainer(exited(137, "DeadlineExceeded")).state, "timed_out");
  assertEquals(resultFromContainer(exited(137, "OOMKilled")), {
    state: "failed",
    exitCode: 137,
    oom: true,
  });
  assertEquals(resultFromContainer(exited(1)).state, "failed");
  assertEquals(resultFromContainer(exited(125)).state, "error", "the entrypoint's own failure");
  assertEquals(resultFromContainer(exited(122, "was stopped…")), {
    state: "failed",
    exitCode: 122,
    oom: false,
  }, "the pool's stop is the check's own failure");
  assertEquals(resultFromContainer({ state: "running", startedAt: null }).state, "error");
  assertEquals(resultFromContainer(undefined).state, "error");
  assertEquals(suiteVerdict([{ state: "passed" }, { state: "passed" }]), "passed");
  assertEquals(suiteVerdict([{ state: "passed" }, { state: "timed_out" }]), "failed");
  assertEquals(suiteVerdict([]), "failed");
  // Taken while the pod runs: the head's own answers only. A kill by signal waits for the pod.
  assert(settlesEarly(exited(0)));
  assert(settlesEarly(exited(1)));
  assert(settlesEarly(exited(124)));
  assert(settlesEarly(exited(122)));
  assert(settlesEarly(exited(137, "DeadlineExceeded")));
  assert(settlesEarly(exited(137, "OOMKilled")));
  assert(!settlesEarly(exited(137, "Error")));
  assert(!settlesEarly(exited(143)));
  assert(!settlesEarly(exited(125)));
  assert(!settlesEarly(exited(1, "Evicted")));
  assert(!settlesEarly({ state: "running", startedAt: null }));
});

test(
  "a tool request reads the base, claims a suite in the default image and launches it once",
  async () => {
    const w = await checksWorld();
    const answer = await w.request();
    assertEquals(answer.status, 202);
    assertEquals(answer.reused, false);
    assertEquals(answer.state, "queued");
    assertEquals(w.reads, ["main"], "read on the run's base, never the head");
    const suite = w.onlySuite();
    assertEquals(answer.suiteId, suite.id);
    assertMatch(suite.id, new RegExp(`^cs-${ID_BODY}$`));
    assertEquals(suite.environmentKey, `default:${w.config.agentImage}`);
    assertEquals(suite.image, w.config.agentImage);
    assertEquals(suite.checksCommit, BASE);
    assertEquals(suite.checksBlob, BLOB);
    assertEquals(suite.definition.checks.map((c) => c.timeoutSeconds), [900, 1200]);
    assertEquals(suite.source, {
      runId: w.run.id,
      path: "api",
      bundleKey: `${w.run.id}/work/${w.api.id}/${HEAD}.bundle`,
      branchName: `${w.run.branchNamespace}/work`,
      baseRef: "main",
    });
    assertStringIncludes(answer.text, suite.id);

    await w.service.tick();
    await w.service.tick();
    assertEquals(w.launched.specs.length, 1, "two ticks, one launch");
    const [spec] = w.launched.specs;
    assertEquals(spec.name, `ryph-check-${suite.id}-g1`);
    assertEquals(spec.image, w.config.agentImage);
    assertEquals(
      spec.clone.url,
      `http://gateway.test:7412/v1/git/${suite.id}/${w.api.id}/repo.git`,
    );
    assertEquals(spec.clone.commit, HEAD);
    assertEquals(spec.clone.baseCommit, BASE);
    assertEquals(Object.keys(spec.clone.env).sort(), [
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]);
    assertEquals(spec.setup, [{ run: "npm ci" }]);
    assertEquals(spec.checks.map((c) => [c.name, c.timeoutSeconds]), [["lint", 900], [
      "test",
      1200,
    ]]);
    assertEquals(spec.deadlineSeconds, 20 * 60 + 1200 + 300);
    assertEquals(spec.proxyEnv, {}, "no boundary claimed in this world");
    const running = w.onlySuite();
    assertEquals([running.state, running.attempts], ["running", 1]);
    assert(running.launchedAt !== null);
  },
);

test("a tool request of another line reads at that line's base, and a fork head checks only its own", async () => {
  const w = await checksWorld();
  const getTask = w.store.getTask.bind(w.store);
  const ns = w.run.branchNamespace;
  // The `fix` line of this run merged into `release`; another run's `docs` line merged into
  // `stale`, which is no base of this run's `docs`.
  const landing = (onto: string, runId: string) => ({
    connectedRepoId: w.api.id,
    thread: "8",
    onto,
    generation: 1,
    moved: true,
    at: T0,
    runId,
  });
  let forkHead = false;
  w.store.getTask = async (id, scope) => {
    const task = await getTask(id, scope);
    if (task === null) return null;
    return {
      ...task,
      repos: task.repos.map((r) => (forkHead ? { ...r, forkHead: true } : r)),
      landings: {
        api: {
          [`${w.run.id}/fix`]: landing("release", w.run.id),
          "r-other/docs": landing("stale", "r-other"),
        },
      },
    };
  };
  const fix = await w.request({ branch: `${ns}/fix-2` });
  assertEquals(fix.status, 202, fix.text);
  const docs = await w.request({ branch: `${ns}/docs`, headSha: sha("e") });
  assertEquals(docs.status, 202, docs.text);
  const bases = Object.fromEntries(
    w.suites().map((s) => [s.source.branchName, s.source.baseRef]),
  );
  assertEquals(bases, { [`${ns}/fix-2`]: "release", [`${ns}/docs`]: "main" });

  forkHead = true;
  const refused = await w.request({ branch: `${ns}/fix-2`, headSha: sha("f") });
  assertEquals(refused.status, 400);
  assertStringIncludes(refused.text, "is a pull request from a fork");
  assertStringIncludes(refused.text, '"fix"');
});

test("a tool request is held to the asking run's namespace, never the task's first run's", async () => {
  // A later run of the task (as a resume starts): the task's entries still name the first run's
  // namespace, and this run ships under its own.
  const w = await checksWorld();
  const getTask = w.store.getTask.bind(w.store);
  w.store.getTask = async (id, scope) => {
    const task = await getTask(id, scope);
    if (task === null) return null;
    return {
      ...task,
      repos: task.repos.map((r) => ({ ...r, branchNamespace: "ryph/ada/r-first" })),
    };
  };
  const own = await w.request({ branch: `${w.run.branchNamespace}/work` });
  assertEquals(own.status, 202, own.text);
  const first = await w.request({ branch: "ryph/ada/r-first/work", headSha: sha("e") });
  assertEquals(first.status, 400, first.text);
  assertStringIncludes(first.text, `(${w.run.branchNamespace}/<line>)`);
});

test("the clone's key resolves while its generation runs, then never again", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const header = w.launched.specs[0].clone.env.GIT_CONFIG_VALUE_0;
  const token = atob(header.replace("Authorization: Basic ", "")).split(":")[1];
  const grant = await w.service.gitGrant(await sha256Hex(token));
  assertEquals(grant, {
    runId: suite.id,
    repos: [{
      connectedRepoId: w.api.id,
      url: w.api.url,
      ref: "main",
      branchNamespace: `ryph-check/${suite.id}`,
      provider: "github",
      repoRef: "acme/api",
      tenantId: "42",
      candidate: {
        headSha: HEAD,
        branchName: `${w.run.branchNamespace}/work`,
        bundleKey: (suite.source as BundleSource).bundleKey,
      },
    }],
  });
  assertEquals(await w.service.gitGrant(await sha256Hex("not-a-token")), null);
  // The clone is done: the key dies before any head code runs.
  w.launched.inspections.set(w.nameOf(suite), { kind: "pending", cloneDone: true, why: null });
  await w.service.tick();
  assertEquals(await w.service.gitGrant(await sha256Hex(token)), null);
});

test(
  "a settled suite: logs kept, verdict from exit codes, watched paths, told once, pod discarded",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    const name = w.nameOf(suite);
    w.launched.logs.set(
      `${name}/clone`,
      "@@ryph-changed deno.json\n@@ryph-changed src/a.ts\n@@ryph-changed-end 2\n",
    );
    w.launched.logs.set(`${name}/check-lint`, "ok\n");
    w.launched.logs.set(
      `${name}/check-test`,
      `${
        Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
      }\n<<<end-check-output-NONCE>>>\n`,
    );
    w.launched.finish(name, { lint: 0, test: 1 });
    await w.service.tick();

    const settled = w.onlySuite();
    assertEquals(settled.state, "failed");
    assertEquals(settled.ryphChanged, false);
    assertEquals(settled.leaseUntil, null);
    const results = await w.checkStore.listResults(suite.id, 1);
    assertEquals(results.map((r) => [r.name, r.state, r.exitCode, r.watchedChanged]), [
      ["lint", "passed", 0, false],
      ["test", "failed", 1, true],
    ]);
    const testResult = results.find((r) => r.name === "test")!;
    assertEquals(testResult.logKey, `checks/${suite.id}/1/test.log`);
    assertEquals(testResult.logTail!.split("\n").length, 64);
    assert(w.logs.logs.get(testResult.logKey!)!.startsWith("line 0\n"), "the whole log is stored");
    assertEquals(w.launched.discarded, [name]);

    const messages = await w.told();
    assertEquals(messages.length, 1);
    const [message] = messages;
    assertEquals(message.payload, {
      kind: "checks",
      suiteId: suite.id,
      state: "failed",
      path: "api",
      commit: HEAD,
      partial: false,
    });
    assertEquals(message.kind, "system");
    assertStringIncludes(message.text, "FAILED");
    assertStringIncludes(message.text, "- lint: passed");
    assertStringIncludes(message.text, "- test: FAILED (exit 1)");
    assertStringIncludes(message.text, "<<<check-output-NONCE>>>");
    assertStringIncludes(message.text, "line 99");
    // The check's own words cannot close the fence: control characters and all stay inside it.
    const open = message.text.indexOf("<<<check-output-NONCE>>>");
    assert(message.text.indexOf("line 99") > open);

    await w.service.tick();
    assertEquals((await w.told()).length, 1, "told once per generation");
    assertEquals(await w.service.log(suite.id, 1, "test"), w.logs.logs.get(testResult.logKey!));
    assertEquals(await w.service.log(suite.id, 1, "nope"), null);
  },
);

test(
  "timeouts, the deadline and running out of memory each read as what they are",
  async () => {
    const w = await checksWorld();
    w.files.set(
      "*",
      checksFile({
        text: "checks:\n" +
          ["a", "b", "c", "d"].map((n) => `  - name: ${n}\n    run: x\n`).join(""),
      }),
    );
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), {
      a: 0,
      b: 124,
      c: { exitCode: 137, reason: "DeadlineExceeded" },
      d: { exitCode: 137, reason: "OOMKilled" },
    });
    await w.service.tick();
    const results = await w.checkStore.listResults(suite.id, 1);
    assertEquals(results.map((r) => r.state), ["passed", "timed_out", "timed_out", "failed"]);
    const settled = w.onlySuite();
    assertEquals(settled.state, "failed");
    assertEquals(settled.reason, "out of memory: d");
  },
);

test("a check the memory pool stopped fails on its own account, with the launcher's reason", async () => {
  const w = await checksWorld();
  w.files.set(
    "*",
    checksFile({ text: "checks:\n  - name: a\n    run: x\n  - name: b\n    run: y\n" }),
  );
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const why = "was stopped when the suite ran short of memory, as the check furthest over its " +
    "share (4Gi of the suite's 8Gi); its log says what it used";
  w.launched.finish(w.nameOf(suite), { a: 0, b: { exitCode: 122, reason: why } });
  await w.service.tick();
  const results = await w.checkStore.listResults(suite.id, 1);
  assertEquals(results.map((r) => [r.state, r.exitCode]), [["passed", 0], ["failed", 122]]);
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertEquals(settled.reason, `b ${why}`);
  const [message] = await w.told();
  assertStringIncludes(
    message.text,
    "- b: FAILED (exit 122: stopped when the suite ran short of memory)",
  );
  // The reason is b's alone: a passing sibling's check run never reads as if it was stopped.
  const report = planForgeReport(settled, results, null);
  const [a, b] = ["a", "b"].map((n) => report.checks.find((c) => c.name === n)!);
  assert(!a.summary.includes("Why:"));
  assertStringIncludes(b.summary, `Why: b ${why}.`);
});

test("the keep list reaches the pod: the declared one, or the default", async () => {
  const w = await checksWorld();
  w.files.set("*", checksFile({ text: "keep: [/dist]\nchecks:\n  - name: a\n    run: x\n" }));
  await w.request();
  await w.service.tick();
  assertEquals(w.launched.specs[0].keep, ["/dist"]);
  const d = await checksWorld();
  await d.request();
  await d.service.tick();
  assertEquals(d.launched.specs[0].keep, ["node_modules", "target", ".venv"]);
});

test("a setup step failing fails every check, with its log kept once", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  w.launched.logs.set(`${name}/setup-0`, "npm ERR! nope\n");
  w.launched.inspections.set(name, {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: 1,
    why: "exited 1",
  });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.state, "failed");
  assertStringIncludes(settled.reason!, "setup step 1 failed (exit 1)");
  const results = await w.checkStore.listResults(suite.id, 1);
  assertEquals(results.map((r) => r.state), ["setup_failed", "setup_failed"]);
  assertEquals(results.map((r) => r.logKey), [
    `checks/${suite.id}/1/_setup.log`,
    `checks/${suite.id}/1/_setup.log`,
  ]);
  const [message] = await w.told();
  assertEquals(message.text.split("<<<check-output-NONCE>>>").length, 2, "one fence for the step");
});

test("the clone failing is the platform's to retry; the third failure is error", async () => {
  const w = await checksWorld();
  await w.request();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await w.service.tick(); // launch
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.attempts], ["running", attempt]);
    w.launched.inspections.set(w.nameOf(suite), {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: 128,
      why: "the candidate was not served",
    });
    await w.service.tick(); // poll
    w.launched.inspections.delete(w.nameOf(suite));
    if (attempt < 3) assertEquals(w.onlySuite().state, "queued");
  }
  const suite = w.onlySuite();
  assertEquals(suite.state, "error");
  assertStringIncludes(suite.reason!, "the clone step failed");
  assertStringIncludes(suite.reason!, "after 3 attempts");
  assertEquals(w.launched.specs.length, 3);
  const results = await w.checkStore.listResults(suite.id, 1);
  assertEquals(results.map((r) => r.state), ["error", "error"]);
});

test("a launch that throws is retried twice, then the suite is error", async () => {
  const w = await checksWorld();
  w.launched.state.failLaunch = { error: "quota exceeded" };
  await w.request();
  await w.service.tick();
  assertEquals(w.onlySuite().state, "queued");
  assertStringIncludes(w.onlySuite().reason!, "quota exceeded; retrying");
  await w.service.tick();
  await w.service.tick();
  assertEquals(w.onlySuite().state, "error");
  assertEquals(w.onlySuite().attempts, 3);
});

test(
  "two replicas ticking together launch once; a replica that died after its claim is adopted, not relaunched",
  async () => {
    const w = await checksWorld();
    const other = makeChecksService({
      store: w.checkStore,
      tasks: w.store,
      launcher: w.launched.launcher,
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
    await w.request();
    await Promise.all([w.service.tick(), other.tick()]);
    assertEquals(w.launched.specs.length, 1);

    // A replica claims and launches, then dies before stamping `launchedAt`.
    const suite = w.onlySuite();
    w.checkStore.suites.set(suite.id, {
      ...suite,
      launchedAt: null,
      leaseUntil: new Date(w.clock.now().getTime() + 60_000).toISOString(),
    });
    w.launched.inspections.set(w.nameOf(suite), {
      kind: "checks",
      checks: { lint: { state: "running", startedAt: null }, test: { state: "waiting" } },
      done: false,
    });
    await other.tick();
    assertEquals(w.onlySuite().launchedAt, null, "the lease is still held: nobody touches it");
    w.clock.advance(2 * 60_000);
    await other.tick();
    const adopted = w.onlySuite();
    assert(adopted.launchedAt !== null, "adopted");
    assertEquals(adopted.state, "running");
    assertEquals(w.launched.specs.length, 1, "never relaunched");
    const lint = (await w.checkStore.listResults(suite.id, 1)).find((r) => r.name === "lint")!;
    assertEquals(lint.state, "running", "progress is shown");
  },
);

test("a pod that vanishes mid-run goes back to the queue", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.records.delete(w.nameOf(suite));
  await w.service.tick();
  const requeued = w.onlySuite();
  assertEquals([requeued.state, requeued.attempts], ["queued", 1]);
  assertStringIncludes(requeued.reason!, "disappeared");
  await w.service.tick();
  assertEquals([w.onlySuite().state, w.onlySuite().attempts], ["running", 2]);
  assertEquals(w.launched.specs.length, 2);
});

test(
  "an unanswerable launcher decides nothing — until the pod would be over anyway",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    w.launched.state.unreachable = true;
    w.clock.advance(30 * 60_000);
    await w.service.tick();
    assertEquals(w.onlySuite().state, "running");
    // Past the deadline and its backstop, the slot it holds is given back.
    w.clock.advance(24 * 60 * 60_000);
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.state, "error");
    assertStringIncludes(suite.reason!, "could not be read past its deadline");
    assertEquals(w.launched.discarded, [w.nameOf(suite)]);
  },
);

test(
  "dedupe: a patch of the same head joins the suite; a finished suite launches nothing more",
  async () => {
    const w = await checksWorld();
    await w.request();
    const patch = w.patchOf();
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.tick();
    assertEquals(w.suites().length, 1);
    const suite = w.onlySuite();
    const requests = await w.checkStore.listRequestsForSuite(suite.id);
    assertEquals(requests.map((r) => r.kind).sort(), ["patch", "tool"]);

    w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "passed");
    assertEquals((await w.told()).length, 1, "one message for the run, not one per request");

    const again = await w.request();
    assertEquals(again.status, 202);
    assertEquals(again.reused, true);
    assertEquals(again.state, "passed");
    assertStringIncludes(again.text, "does not run twice");
    assertStringIncludes(again.text, "PASSED");
    await w.service.tick();
    assertEquals(w.launched.specs.length, 1);
    assertEquals((await w.told()).length, 1, "the answer rode the tool's reply");
  },
);

test(
  "a newer tool request supersedes the run's earlier one — and cancels only an unshared suite",
  async () => {
    const w = await checksWorld();
    await w.request({ headSha: sha("1") });
    await w.service.tick();
    const first = w.onlySuite();
    assertEquals(first.state, "running");
    await w.request({ headSha: sha("2") });
    const cancelled = (await w.checkStore.getSuite(first.id))!;
    assertEquals(cancelled.state, "cancelled");
    assertEquals(w.launched.discarded, [w.nameOf(first)]);
    assertEquals(
      (await w.checkStore.listResults(first.id, 1)).map((r) => r.state),
      ["cancelled", "cancelled"],
    );

    // A suite a patch also asked for keeps running.
    const patch = w.patchOf({ id: "p-3", headSha: sha("3") });
    await w.store.createPatch(patch);
    await w.request({ headSha: sha("3") });
    await w.service.patchOpened(patch);
    await w.service.tick();
    const shared = w.suites().find((s) => s.commit === sha("3"))!;
    await w.request({ headSha: sha("4") });
    assert((await w.checkStore.getSuite(shared.id))!.state !== "cancelled");
  },
);

test("a newer tool request supersedes only the earlier ones of its own line", async () => {
  const w = await checksWorld();
  const branchOf = (line: string, generation = 1) =>
    `${w.run.branchNamespace}/${line}${generation === 1 ? "" : `-${generation}`}`;
  await w.request({ headSha: sha("1"), branch: branchOf("work") });
  await w.request({ headSha: sha("2"), branch: branchOf("fix-a") });
  await w.service.tick();
  const suiteOf = (commit: string) => w.suites().find((s) => s.commit === commit)!;
  const work = suiteOf(sha("1"));
  const fix = suiteOf(sha("2"));
  // Another line's ask replaced nothing: both run.
  assertEquals([work.state, fix.state], ["running", "running"]);
  // A later generation of the fix line replaces the fix line's ask, and leaves the work line's.
  await w.request({ headSha: sha("3"), branch: branchOf("fix-a", 2) });
  assertEquals((await w.checkStore.getSuite(fix.id))!.state, "cancelled");
  assertEquals((await w.checkStore.getSuite(work.id))!.state, "running");
});

test("the per-run cap refuses with a 429; a bad path or branch is a 400", async () => {
  const w = await checksWorld({ policy: { maxPerRun: 1 } });
  assertEquals((await w.request()).status, 202);
  const capped = await w.request({ headSha: sha("e") });
  assertEquals(capped.status, 429);
  assertStringIncludes(capped.text, "RYPH_CHECKS_MAX_PER_RUN");
  assertEquals((await w.request({ path: "nope" })).status, 400);
  assertEquals((await w.request({ branch: "main" })).status, 400);
});

test(
  "no checks file, an empty one, an invalid one: no suite, and the note says why",
  async () => {
    const w = await checksWorld();
    w.files.set("*", { kind: "absent", commit: BASE });
    const absent = await w.request();
    assertEquals([absent.status, absent.suiteId], [200, null]);
    assertStringIncludes(absent.text, "declares no checks");

    w.files.set("*", checksFile({ text: "checks: []\n" }));
    assertStringIncludes((await w.request({ headSha: sha("e") })).text, "declares no checks");

    w.files.set("*", checksFile({ text: "checks:\n  - name: BAD\n    run: x\n" }));
    const invalid = await w.request({ headSha: sha("f") });
    assertStringIncludes(invalid.text, "is not valid");
    assertEquals(w.suites().length, 0);
  },
);

test(
  "a read the forge could not answer is retried with backoff — never read as no checks",
  async () => {
    const w = await checksWorld();
    w.files.set("*", { kind: "unavailable", detail: "upstream down" });
    const answer = await w.request();
    assertEquals([answer.status, answer.suiteId], [202, null]);
    assertStringIncludes(answer.text, "could not read");
    const [request] = [...w.checkStore.requests.values()];
    assertEquals(request.state, "pending");
    assertEquals(request.attempts, 1);
    await w.service.tick();
    assertEquals(w.reads.length, 1, "not due yet");
    w.clock.advance(30_000);
    await w.service.tick();
    assertEquals(w.reads.length, 2);
    assertEquals(w.checkStore.requests.get(request.id)!.attempts, 2);
    // Back: the suite is claimed from the next due read, and launched on the tick after.
    w.files.set("*", checksFile());
    w.clock.advance(60_000);
    await w.service.tick();
    assertEquals(w.onlySuite().state, "queued");
    await w.service.tick();
    assertEquals(w.onlySuite().state, "running");
    // And a read failing for a day is given up on, out loud.
    w.files.set("*", { kind: "unavailable", detail: "still down" });
    const late = await w.request({ headSha: sha("e") });
    const pending = w.checkStore.requests.get(
      [...w.checkStore.requests.values()].find((r) => r.commit === sha("e"))!.id,
    )!;
    assertEquals(pending.state, "pending");
    assertEquals(late.suiteId, null);
    w.clock.advance(25 * 60 * 60_000);
    await w.service.tick();
    const given = w.checkStore.requests.get(pending.id)!;
    assertEquals(given.state, "refused");
    assertStringIncludes(given.note!, "could not be read for a day");
  },
);

test("a base with a Dockerfile waits for its environment, then runs in its image", async () => {
  const w = await checksWorld();
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
  await w.request();
  const waiting = w.onlySuite();
  assertEquals(waiting.state, "waiting");
  assertEquals(waiting.environmentKey, `tree:${tree("a")}`);
  assert(waiting.environmentId !== null);
  const env = (await w.environmentStore.getEnvironment(waiting.environmentId))!;
  // Never a default-branch row: it builds the base as it was, which runs must not pick up.
  assertEquals([env.trigger, env.ref, env.defaultBranch, env.definition], [
    "check",
    "main",
    false,
    tree("a"),
  ]);
  await w.service.tick();
  assertEquals(w.launched.specs.length, 0, "nothing launches before the image exists");

  const [build] = await w.builder.parked(1);
  build.succeed();
  await w.wired!.service.idle();
  const queued = w.onlySuite();
  assertEquals(queued.state, "queued");
  assert(queued.image!.includes("@sha256:"));
  await w.service.tick();
  assertEquals(w.launched.specs[0].image, queued.image);
  // The build baked this repo's checkout, so every check starts from it.
  assertEquals(w.launched.specs[0].bakedCheckout, "api");
});

test("a check's tree: key is its repo's own definition, never its workspace's", async () => {
  const w = await checksWorld();
  // acme/api is a member of a workspace whose ready image holds the same base: keyed on every
  // member's .ryph/, so it is not the repo's machine and the suite does not take it.
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
  w.setHead("acme/web", "main", { commit: sha("c"), tree: null });
  const wsPlan = await w.wired!.service.planFor(
    (await w.wired!.service.loadSubject("workspace", "ws-1"))!,
    "main",
  );
  assert(wsPlan.definition !== null && wsPlan.definition !== tree("a"));
  const repoPlan = await w.wired!.service.planFor(
    (await w.wired!.service.loadSubject("repo", w.api.id))!,
    "main",
  );
  assertEquals(repoPlan.definition, tree("a"), "a one-repo definition is its tree");
  const ws = await plantImage(w, "env-ws", { tree: tree("a"), dockerfile: true });
  await w.environmentStore.saveEnvironment({
    ...ws,
    subjectKind: "workspace",
    subjectId: "ws-1",
    definition: wsPlan.definition,
  });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
  await w.request();
  const waiting = w.onlySuite();
  assertEquals(waiting.state, "waiting");
  assertEquals(waiting.environmentKey, `tree:${tree("a")}`);
  const env = (await w.environmentStore.getEnvironment(waiting.environmentId!))!;
  assertEquals([env.subjectKind, env.definition, env.trigger], ["repo", tree("a"), "check"]);
});

/** A ready image of acme/api in the environments store, built from `tree` on `ref`. */
async function plantImage(
  w: Awaited<ReturnType<typeof checksWorld>>,
  id: string,
  over: {
    tree: string;
    defaultBranch?: boolean;
    ref?: string;
    dockerfile?: boolean;
    at?: string;
    bakedImage?: string;
    checkouts?: Environment["plan"]["checkouts"];
    setupWarnings?: Environment["setupWarnings"];
  },
): Promise<Environment> {
  const at = over.at ?? T0;
  const env: Environment = {
    id,
    subjectKind: "repo",
    subjectId: w.api.id,
    ref: over.ref ?? "main",
    defaultBranch: over.defaultBranch ?? true,
    commits: { api: sha("7") },
    definition: over.tree,
    baseDigest: "base@x",
    harnessDigest: "harness@old",
    image: `registry.test/${id}@sha256:${"9".repeat(64)}`,
    bakedImage: over.bakedImage ?? null,
    machineImage: null,
    status: "ready",
    toolchains: {},
    sizeBytes: null,
    trigger: "push",
    plan: {
      checkouts: over.checkouts ?? [],
      dockerfileFrom: over.dockerfile ? ".ryph/Dockerfile" : null,
      cacheScope: { read: [], write: null },
      relayerOf: null,
    },
    logRef: null,
    logTail: null,
    failure: null,
    egressRefusals: null,
    setupWarnings: over.setupWarnings ?? null,
    imagesRemovedAt: null,
    startedAt: at,
    finishedAt: at,
    createdAt: at,
    updatedAt: at,
  };
  await w.environmentStore.createEnvironment(env);
  return env;
}

test(
  "the pod is told where the image baked this repo's checkout, and only when it did",
  async () => {
    const checkout = (path: string, connectedRepoId: string) => ({
      path,
      connectedRepoId,
      ref: "main",
      commit: sha("7"),
    });
    const w = await checksWorld();
    await plantImage(w, "env-1", {
      tree: tree("b"),
      checkouts: [checkout("web", "cr-other"), checkout("api-checkout", w.api.id)],
    });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await w.service.tick();
    assertEquals(w.launched.specs[0].bakedCheckout, "api-checkout");

    // An image that baked other repos only: the pod sets up a tree of its own.
    const w2 = await checksWorld();
    await plantImage(w2, "env-1", { tree: tree("b"), checkouts: [checkout("web", "cr-other")] });
    w2.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w2.request();
    await w2.service.tick();
    assertEquals(w2.launched.specs[0].bakedCheckout, null);

    // The default image bakes nothing.
    const w3 = await checksWorld();
    w3.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w3.request();
    await w3.service.tick();
    assertEquals(w3.launched.specs[0].image, w3.config.agentImage);
    assertEquals(w3.launched.specs[0].bakedCheckout, null);
  },
);

test(
  "a setup-only base with nothing ready runs in the agent image at once, building nothing",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: false });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.environmentKey, suite.image, suite.environmentId], [
      "queued",
      `default:${w.config.agentImage}`,
      w.config.agentImage,
      null,
    ]);
    assertEquals(w.builder.pending.length, 0, "no build of its own");
    await w.service.tick();
    assertEquals(w.launched.specs[0].image, w.config.agentImage);
  },
);

test(
  "a setup-only base takes the default branch's newest ready image, whatever its tree",
  async () => {
    const w = await checksWorld();
    await plantImage(w, "env-old", { tree: tree("c"), at: "2020-01-01T00:00:00.000Z" });
    const newest = await plantImage(w, "env-new", { tree: tree("b") });
    // Another branch's image is never one to take.
    await plantImage(w, "env-branch", { tree: tree("a"), defaultBranch: false, ref: "feature" });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.environmentKey, suite.image, suite.environmentId], [
      "queued",
      `image:${newest.image}`,
      newest.image,
      newest.id,
    ]);
    assertEquals(w.builder.pending.length, 0, "no build of its own");
    await w.service.tick();
    assertEquals(w.launched.specs[0].image, newest.image);
  },
);

test(
  "asks at one base commit join one suite, though a newer image turns ready between them",
  async () => {
    const w = await checksWorld();
    const first = await plantImage(w, "env-1", { tree: tree("b"), at: "2020-01-01T00:00:00.000Z" });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await plantImage(w, "env-2", { tree: tree("c") });
    await w.service.patchOpened(w.patchOf());
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.image, first.image);
    assertEquals((await w.checkStore.listRequestsForSuite(suite.id)).length, 2);
  },
);

test(
  "a setup-only branch base skips a default-branch image built from a Dockerfile",
  async () => {
    const w = await checksWorld();
    const task = (await w.store.getTask(w.run.taskId))!;
    w.store.getTask = () =>
      Promise.resolve({ ...task, repos: task.repos.map((r) => ({ ...r, targetRef: "develop" })) });
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    await plantImage(w, "env-machine", { tree: tree("b"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.checksRef, suite.environmentKey, suite.state], [
      "develop",
      `default:${w.config.agentImage}`,
      "queued",
    ]);
  },
);

test(
  "a Dockerfile base with nothing to wait on takes the fallback while the builder is down",
  async () => {
    const w = await checksWorld();
    w.environmentService!.builderFault = () => "registry unreachable";
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const onDefault = w.onlySuite();
    assertEquals([onDefault.state, onDefault.environmentKey], [
      "queued",
      `default:${w.config.agentImage}`,
    ]);
    assertEquals(w.builder.pending.length, 0);

    // With an older default-branch image ready, that one, as a run would take.
    const w2 = await checksWorld();
    w2.environmentService!.builderFault = () => "registry unreachable";
    const ready = await plantImage(w2, "env-main", { tree: tree("b"), dockerfile: true });
    w2.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w2.request();
    assertEquals(w2.onlySuite().environmentKey, `image:${ready.image}`);

    // A branch base with a machine of its own and a ready image of exactly its tree uses it as
    // ever, builder or not.
    const w3 = await checksWorld();
    w3.environmentService!.builderFault = () => "registry unreachable";
    onBranch(w3, "develop");
    w3.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    const exact = await plantImage(w3, "env-exact", {
      tree: tree("a"),
      dockerfile: true,
      defaultBranch: false,
      ref: "develop",
    });
    w3.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w3.request();
    const suite = w3.onlySuite();
    assertEquals([suite.environmentKey, suite.state, suite.image], [
      `tree:${tree("a")}`,
      "queued",
      exact.image,
    ]);
  },
);

/** The run's checks are judged at `ref`, not the default branch. */
function onBranch(w: Awaited<ReturnType<typeof checksWorld>>, ref: string) {
  const getTask = w.store.getTask.bind(w.store);
  w.store.getTask = async (id) => {
    const task = (await getTask(id))!;
    return { ...task, repos: task.repos.map((r) => ({ ...r, targetRef: ref })) };
  };
}

test(
  "a Dockerfile repo's default-branch base takes the newest ready image of any tree, never waiting",
  async () => {
    const w = await checksWorld();
    // main merged an edit to .ryph/: its head's tree has no image yet, an older one is ready.
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    const older = await plantImage(w, "env-old", {
      tree: tree("b"),
      dockerfile: true,
      bakedImage: `registry.test/env-old@sha256:${"8".repeat(64)}`,
    });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.environmentKey, suite.image, suite.environmentId], [
      "queued",
      `image:${older.bakedImage}`,
      older.bakedImage,
      older.id,
    ]);
    assertEquals(w.builder.pending.length, 0, "no build of its own");
    await w.service.tick();
    assertEquals(w.launched.specs[0].image, older.bakedImage, "the baked image under the harness");
  },
);

test(
  "a failed build of the default branch's new tree errors no suite that can use an older image",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    const older = await plantImage(w, "env-old", { tree: tree("b"), dockerfile: true });
    await w.environmentStore.createEnvironment({
      ...older,
      id: "env-failed",
      definition: tree("a"),
      commits: { api: BASE },
      image: null,
      status: "failed",
      failure: "RUN apt-get failed",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.state, suite.environmentKey], ["queued", `image:${older.image}`]);
  },
);

test(
  "a branch base waits for its own machine only when its tree differs and a side has a Dockerfile",
  async () => {
    // Its own Dockerfile and another tree: its tree, waited for.
    const w = await checksWorld();
    onBranch(w, "develop");
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    w.setHead("acme/api", "develop", { commit: sha("9"), tree: tree("c"), dockerfile: true });
    await plantImage(w, "env-main", { tree: tree("b"), dockerfile: true });
    w.files.set("*", checksFile({ commit: sha("9"), ryphTree: tree("c"), dockerfile: true }));
    await w.request();
    const waiting = w.onlySuite();
    assertEquals([waiting.checksRef, waiting.state, waiting.environmentKey], [
      "develop",
      "waiting",
      `tree:${tree("c")}`,
    ]);

    // The default branch's tree: the default branch's image, at once.
    const same = await checksWorld();
    onBranch(same, "develop");
    same.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    const ready = await plantImage(same, "env-main", { tree: tree("b"), dockerfile: true });
    same.files.set("*", checksFile({ ryphTree: tree("b"), dockerfile: true }));
    await same.request();
    assertEquals([same.onlySuite().state, same.onlySuite().environmentKey], [
      "queued",
      `image:${ready.image}`,
    ]);
    assertEquals(same.builder.pending.length, 0);

    // Another tree, no Dockerfile on either side: the default branch's image too.
    const plain = await checksWorld();
    onBranch(plain, "develop");
    plain.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: false });
    const plainReady = await plantImage(plain, "env-main", { tree: tree("b") });
    plain.files.set("*", checksFile({ ryphTree: tree("c"), dockerfile: false }));
    await plain.request();
    assertEquals(plain.onlySuite().environmentKey, `image:${plainReady.image}`);
  },
);

test(
  "a branch base behind a main that moved its .ryph takes main's image, building nothing",
  async () => {
    // develop forked when main's `.ryph/` was tree(c); main moved on to tree(b). The
    // base still carries tree(c) without having changed it, so it merges into main's machine.
    const w = await checksWorld();
    onBranch(w, "develop");
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    w.setHead("acme/api", "develop", { commit: sha("9"), tree: tree("c"), dockerfile: true });
    const ready = await plantImage(w, "env-main", { tree: tree("b"), dockerfile: true });
    w.bases.set(sha("9"), { base: BASE, mergeBase: sha("7"), tree: tree("c"), changed: [] });
    w.files.set("*", checksFile({ commit: sha("9"), ryphTree: tree("c"), dockerfile: true }));
    await w.request();
    assertEquals([w.onlySuite().state, w.onlySuite().environmentKey], [
      "queued",
      `image:${ready.image}`,
    ]);
    assertEquals(w.builder.pending.length, 0);

    // The same branch having changed `.ryph/` since its merge base: its own tree, waited for.
    const changed = await checksWorld();
    onBranch(changed, "develop");
    changed.setHead("acme/api", "main", { commit: BASE, tree: tree("b"), dockerfile: true });
    changed.setHead("acme/api", "develop", { commit: sha("9"), tree: tree("c"), dockerfile: true });
    await plantImage(changed, "env-main", { tree: tree("b"), dockerfile: true });
    changed.bases.set(sha("9"), {
      base: BASE,
      mergeBase: sha("7"),
      tree: tree("a"),
      changed: [".ryph/Dockerfile"],
    });
    changed.files.set("*", checksFile({ commit: sha("9"), ryphTree: tree("c"), dockerfile: true }));
    await changed.request();
    assertEquals([changed.onlySuite().state, changed.onlySuite().environmentKey], [
      "waiting",
      `tree:${tree("c")}`,
    ]);
  },
);

const UNFINISHED: Environment["setupWarnings"] = [{
  kind: "invalid",
  path: "api",
  error: "setup.yml: not valid YAML",
}];

test(
  "a check takes the newest image whose setup.yml finished over a newer one whose did not",
  async () => {
    const w = await checksWorld();
    const clean = await plantImage(w, "env-clean", {
      tree: tree("a"),
      at: "2020-01-01T00:00:00.000Z",
    });
    await plantImage(w, "env-warned", { tree: tree("a"), setupWarnings: UNFINISHED });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    const suite = w.onlySuite();
    assertEquals([suite.environmentId, suite.image], [clean.id, clean.image]);
  },
);

test(
  "a check run on a clean image over a newer unfinished one says it ran on an older image",
  async () => {
    const w = await checksWorld();
    const clean = await plantImage(w, "env-clean", {
      tree: tree("a"),
      at: "2020-01-01T00:00:00.000Z",
    });
    await plantImage(w, "env-warned", { tree: tree("a"), setupWarnings: UNFINISHED });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.environmentId, clean.id);
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    const [message] = await w.told();
    assertStringIncludes(
      message.text,
      "These checks ran on an older image of this .ryph/ definition (built " +
        "2020-01-01T00:00:00.000Z), because the newest build's .ryph/setup.yml did not finish",
    );
    assert(!message.text.includes("did not finish its .ryph/setup.yml"), message.text);
    const older = { builtAt: clean.finishedAt };
    const report = planForgeReport(w.onlySuite(), [], null, null, older);
    assertStringIncludes(report.suite.summary, "ran on an older image");
    assertStringIncludes(report.checks[0].summary, "**Older image:**");
    assert(!planForgeReport(w.onlySuite(), [], null).suite.summary.includes("older image"));
  },
);

test(
  "a clean image newer than every unfinished build says nothing of its age",
  async () => {
    const w = await checksWorld();
    await plantImage(w, "env-old-def", {
      tree: tree("b"),
      setupWarnings: UNFINISHED,
      at: "2019-01-01T00:00:00.000Z",
    });
    await plantImage(w, "env-clean", { tree: tree("a") });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    const [message] = await w.told();
    assert(!message.text.includes("older image"), message.text);
  },
);

test(
  "a check run on an image whose setup.yml did not finish says so, to the run and the forge",
  async () => {
    const w = await checksWorld();
    const warned = await plantImage(w, "env-warned", {
      tree: tree("a"),
      setupWarnings: UNFINISHED,
    });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.environmentId, warned.id, "with no other, it is taken");
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    const [message] = await w.told();
    assertStringIncludes(
      message.text,
      "The image these checks ran on did not finish its .ryph/setup.yml (in `api/`)",
    );
    assertStringIncludes(message.text, "may be setup's rather than this change's");
    const report = planForgeReport(w.onlySuite(), [], null, ["api"]);
    assertStringIncludes(report.suite.summary, "did not finish its .ryph/setup.yml");
    assertStringIncludes(report.checks[0].summary, "**Setup unfinished:**");
    assert(!planForgeReport(w.onlySuite(), [], null).suite.summary.includes("setup.yml"));
  },
);

test(
  "only a repo whose own setup stopped is named as not finishing: not a discarded or unreadable one",
  async () => {
    const w = await checksWorld();
    await plantImage(w, "env-warned", {
      tree: tree("a"),
      setupWarnings: [
        {
          kind: "step",
          path: "api",
          step: "npm ci",
          index: 1,
          total: 1,
          code: 1,
          output: "",
          discarded: false,
        },
        { kind: "discarded", path: "web", after: ["api"] },
        { kind: "unreadable", path: "docs" },
      ],
    });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    const [message] = await w.told();
    assertStringIncludes(
      message.text,
      "The image these checks ran on did not finish its .ryph/setup.yml (in `api/`):",
    );
  },
);

test("an image whose only setup warning is an unreadable record is not said to be unfinished", async () => {
  const w = await checksWorld();
  await plantImage(w, "env-warned", {
    tree: tree("a"),
    setupWarnings: [{ kind: "unreadable", path: "api" }],
  });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
  await w.service.tick();
  const [message] = await w.told();
  assert(!message.text.includes("did not finish"), message.text);
});

test("a re-layer onto a new harness keeps the suite: the key is the baked image", async () => {
  const w = await checksWorld();
  const baked = `registry.test/env-1-baked@sha256:${"8".repeat(64)}`;
  const first = await plantImage(w, "env-1", {
    tree: tree("b"),
    bakedImage: baked,
    at: "2020-01-01T00:00:00.000Z",
  });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
  await w.request();
  const suite = w.onlySuite();
  assertEquals(suite.environmentKey, `image:${baked}`);
  // A deploy re-layers it: a newer ready row, a new image, the same baked image under it.
  const relayered = await plantImage(w, "env-2", { tree: tree("b"), bakedImage: baked });
  assert(relayered.image !== first.image);
  w.clock.advance(5 * 60_000);
  await w.service.patchOpened(w.patchOf());
  await w.service.tick();
  assertEquals(w.suites().length, 1, "the submit joins the suite run_checks started");
  assertEquals((await w.checkStore.listRequestsForSuite(suite.id)).length, 2);
});

test(
  "a suite on its own build takes a ready default-branch image of its tree that lands first",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const waiting = w.onlySuite();
    assertEquals(waiting.state, "waiting");
    const own = waiting.environmentId!;
    const ready = await plantImage(w, "env-main", { tree: tree("a"), dockerfile: true });
    await w.service.tick();
    const suite = (await w.checkStore.getSuite(waiting.id))!;
    assertEquals([suite.image, suite.environmentId], [ready.image, ready.id]);
    // The check's own build, now waited on by nobody, is called off.
    const left = (await w.environmentStore.getEnvironment(own))!;
    assertEquals([left.status, left.failure], [
      "superseded",
      "Nothing waits for this build any more.",
    ]);
  },
);

test(
  "a waiting suite superseded by a new ask leaves its build for the next suite",
  async () => {
    const w = await checksWorld({ answerWithinMs: 5 });
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    // A slow machine runs past the short wait on this ask too, and its resolve finishes later.
    await w.service.idle();
    const first = w.onlySuite();
    assertEquals(first.state, "waiting");
    const own = first.environmentId!;

    // The agent pushes a fix and asks again; the read at the base takes a while.
    w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("a"), dockerfile: true });
    const read = w.forge.readChecksFile;
    let answer!: () => void;
    w.forge.readChecksFile = (...args) =>
      new Promise((done) => (answer = () => done(read(...args))));
    w.files.set("*", checksFile({ commit: sha("b"), ryphTree: tree("a"), dockerfile: true }));
    assertEquals((await w.request({ headSha: sha("e") })).status, 202);
    assertEquals((await w.checkStore.getSuite(first.id))!.state, "cancelled");
    const status = (await w.environmentStore.getEnvironment(own))!.status;
    assert(status === "queued" || status === "building", `the build stays, got ${status}`);

    answer();
    await w.service.idle();
    const next = w.suites().find((s) => s.id !== first.id)!;
    assertEquals([next.state, next.environmentId], ["waiting", own]);
  },
);

test("with environments off, a base with a .ryph tree runs in the default image", async () => {
  const w = await checksWorld({ noEnvironments: true });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: false }));
  await w.request();
  const suite = w.onlySuite();
  assertEquals(suite.environmentKey.startsWith("default:"), true);
  assertEquals(suite.state, "queued");
  assertEquals(w.builder.pending.length, 0);
});

test("the base's environment failing to build is the suite's error", async () => {
  const w = await checksWorld();
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
  await w.request();
  const [build] = await w.builder.parked(1);
  build.fail("RUN apt-get failed");
  await w.wired!.service.idle();
  const suite = w.onlySuite();
  assertEquals(suite.state, "error");
  assertStringIncludes(suite.reason!, "the base's environment failed to build");
  await w.service.tick();
  const [message] = await w.told();
  assertStringIncludes(message.text, "could not be run");
});

test(
  "services: only the named ones, resolved at the base; a refusal is the suite's error",
  async () => {
    const on = { ...DEFAULT_SERVICE_POLICY, enabled: true };
    const w = await checksWorld({ services: on });
    const text = "checks:\n  - name: e2e\n    run: x\n    services: [db]\n";
    w.files.set(
      "*",
      checksFile({
        text,
        services: {
          kind: "file",
          text: "services:\n  db:\n    uses: postgres@18\n    port: 5433\n" +
            "  cache:\n    uses: redis@8\n    port: 6379\n",
        },
      }),
    );
    await w.request();
    const suite = w.onlySuite();
    assertEquals(suite.services.map((s) => s.name), ["db"], "cache is not named by any check");
    await w.service.tick();
    assertEquals(w.launched.specs[0].services.map((s) => s.name), ["db"]);

    // Services off: the suite cannot run as declared, and says so rather than dropping them.
    const off = await checksWorld();
    off.files.set(
      "*",
      checksFile({
        text,
        services: {
          kind: "file",
          text: "services:\n  db:\n    uses: postgres@18\n    port: 5433\n",
        },
      }),
    );
    await off.request();
    const refused = off.onlySuite();
    assertEquals(refused.state, "error");
    assertStringIncludes(refused.reason!, "RYPH_SERVICES is off");
    assertEquals(
      (await off.service.rerun(refused.id, { kind: "user", userId: "u-1" })).kind,
      "refused",
    );
  },
);

test("a checks-only service is started for the check that names it, as any other is", async () => {
  // `checks_only` hides a service from runs, never from the checks: it is what the key is for.
  const w = await checksWorld({ services: { ...DEFAULT_SERVICE_POLICY, enabled: true } });
  w.files.set(
    "*",
    checksFile({
      text: "checks:\n  - name: unit\n    run: x\n    services: [db]\n",
      services: {
        kind: "file",
        text: "services:\n  db:\n    uses: postgres@18\n    port: 5433\n    checks_only: true\n",
      },
    }),
  );
  await w.request();
  const suite = w.onlySuite();
  assertEquals(suite.services.map((s) => [s.name, s.port]), [["db", 5433]]);
  await w.service.tick();
  assertEquals(w.launched.specs[0].services.map((s) => s.name), ["db"]);
});

test(
  "a submitted patch is reported queued at once, then settled; the same report is not sent twice",
  async () => {
    const w = await checksWorld();
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    // Resolved, then reported, in one tick; launched on the next.
    assert(w.reports.length >= 1);
    const first = w.reports[0];
    const suite = w.onlySuite();
    assertEquals(first.headSha, HEAD);
    assertEquals(first.detailsUrl, `${APP_URL}/checks/${suite.id}`);
    assertEquals(first.checks.map((c) => [c.name, c.status, c.conclusion]), [
      ["lint", "queued", null],
      ["test", "queued", null],
    ]);
    assertEquals(first.checks[0].externalId, `${suite.id}:1:lint`);
    assertMatch(
      first.checks[0].externalId,
      new RegExp(`^cs-${ID_BODY}:\\d{1,6}:[a-z0-9-]{1,40}$`),
    );
    await w.service.tick();
    assertEquals(w.onlySuite().state, "running");
    const before = w.reports.length;
    await w.service.tick();
    await w.service.tick();
    assertEquals(w.reports.length, before, "nothing changed, nothing sent");

    w.launched.finish(w.nameOf(suite), { lint: 0, test: 2 });
    await w.service.tick();
    const last = w.reports.at(-1)!;
    assertEquals(last.checks.map((c) => [c.status, c.conclusion]), [
      ["completed", "success"],
      ["completed", "failure"],
    ]);
    assertEquals(last.suite.conclusion, "failure");
    // The ids the forge answered are kept, and sent back to update in place.
    const results = await w.checkStore.listResults(suite.id, 1);
    assert(results.every((r) => r.forgeRef !== null));
    assertEquals(last.checks.map((c) => c.forgeRef), results.map((r) => r.forgeRef));
    assertStringIncludes(last.checks[1].summary, claimSentence(w.onlySuite()));
  },
);

test(
  "a submitted patch on a local repo files no report row: its suite still settles, and the backstop stays quiet",
  async () => {
    const w = await checksWorld();
    // The run's repo as a directory on the forge's disk: there is no check run to post anywhere.
    await w.store.saveConnectedRepo({
      ...w.api,
      provider: "local",
      repoRef: "/srv/api",
      url: "/srv/api",
    });
    const patch = w.patchOf({ state: "submitted", forgeRef: `${w.run.branchNamespace}/work` });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    assertEquals(w.checkStore.reports.size, 0, "no row is queued for a forge with nowhere to post");
    await w.service.tick();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "passed");
    assertEquals(w.reports, [], "nothing was ever sent to the forge");

    // Past the relays' grace, the backstop finds a submitted patch with no row — and leaves it so,
    // rather than refiling one every sweep for as long as the patch is recent.
    for (let i = 0; i < 3; i++) {
      w.clock.advance(10 * 60_000);
      await w.service.tick();
    }
    assertEquals(w.checkStore.reports.size, 0);
    assertEquals(w.diagEvents.filter((e) => e.event === "checks.report_refiled"), []);
    assertEquals(w.reports, []);
  },
);

test("a suite that could not run is action_required with a page, failure without", async () => {
  for (const appUrl of [APP_URL, null]) {
    const w = await checksWorld({ appUrl });
    w.launched.state.failLaunch = { error: "no nodes" };
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    // Read on the first tick, then three launches that throw.
    for (let i = 0; i < 4; i++) await w.service.tick();
    assertEquals(w.onlySuite().state, "error");
    const last = w.reports.at(-1)!;
    assertEquals(
      last.checks.map((c) => c.conclusion),
      appUrl === null ? ["failure", "failure"] : ["action_required", "action_required"],
    );
    assertStringIncludes(last.checks[0].title, "Could not run");
  }
});

test("a forge that cannot take checks is asked again only after a while", async () => {
  const w = await checksWorld();
  w.reportAnswer.fn = () => ({ kind: "unsupported", reason: "the App cannot post checks here" });
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  assertEquals(w.reports.length, 1);
  const row = (await w.checkStore.findForgeReport({ patchId: patch.id }))!;
  assertEquals(row.lastError, "the App cannot post checks here");
  assert(row.disabledUntil !== null);
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.reports.length, 1, "state changed, but the forge is not asked yet");
  w.reportAnswer.fn = null;
  w.clock.advance(11 * 60_000);
  await w.service.tick();
  assertEquals(w.reports.length, 2);
  assertEquals(w.reports[1].checks.map((c) => c.conclusion), ["success", "success"]);
});

test(
  "a forge failing transiently is retried on a backoff; a terminal failure stops",
  async () => {
    const w = await checksWorld();
    w.reportAnswer.fn = () => ({ kind: "failed", message: "502", terminal: false });
    const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    // Read, then launched: the suite stands still from here.
    await w.service.tick();
    await w.service.tick();
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    assertEquals(w.reports.length, 1);
    let row = (await w.checkStore.findForgeReport({ patchId: patch.id }))!;
    assertEquals([row.attempts, row.lastError], [1, "502"]);
    assertEquals(Date.parse(row.nextAttemptAt!) - w.clock.now().getTime(), 30_000);
    await w.service.tick();
    assertEquals(w.reports.length, 1, "not due yet");
    w.clock.advance(30_000);
    await w.service.tick();
    assertEquals(w.reports.length, 2);
    row = (await w.checkStore.findForgeReport({ patchId: patch.id }))!;
    assertEquals(Date.parse(row.nextAttemptAt!) - w.clock.now().getTime(), 60_000);
    w.reportAnswer.fn = () => ({ kind: "failed", message: "gone", terminal: true });
    w.clock.advance(60_000);
    await w.service.tick();
    row = (await w.checkStore.findForgeReport({ patchId: patch.id }))!;
    assertEquals([row.nextAttemptAt, row.lastError], [null, "gone"]);
  },
);

test("a head with no checks posts nothing — a required check stays expected", async () => {
  const w = await checksWorld();
  w.files.set("*", { kind: "absent", commit: BASE });
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  await w.service.tick();
  assertEquals(w.reports.length, 0);
  const row = (await w.checkStore.findForgeReport({ patchId: patch.id }))!;
  assertEquals(row.nextAttemptAt, null);
  assertStringIncludes(row.lastError!, "declares no checks");
});

test(
  "a re-run adds a generation, resets its checks, and the run hears the new verdict",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
    await w.service.tick();
    assertEquals((await w.told()).length, 1);

    const passed = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(passed.kind === "rerun");
    assertEquals([passed.suite.generation, passed.suite.state], [2, "queued"]);
    assertEquals(
      (await w.checkStore.listResults(suite.id, 2)).map((r) => r.state),
      ["queued", "queued"],
    );
    assertEquals(
      (await w.checkStore.listResults(suite.id, 1)).length,
      2,
      "the old generation stays",
    );
    const running = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
    assert(running.kind === "refused");
    assertEquals(running.status, 409);

    await w.service.tick();
    const gen2 = w.onlySuite();
    assertEquals(w.launched.specs.at(-1)!.name, checkRecordName(gen2));
    assertEquals(gen2.generation, 2);
    w.launched.finish(checkRecordName(gen2), { lint: 0, test: 0 });
    await w.service.tick();
    assertEquals(w.onlySuite().state, "passed");
    const messages = await w.told();
    assertEquals(messages.length, 2);
    assertStringIncludes(messages[1].text, "generation 2");
    assertEquals(
      (await w.service.rerun("cs-0000000000", { kind: "user", userId: "u" })).kind,
      "refused",
    );
  },
);

test(
  "a forge re-request names one of our suites on this head, or re-runs nothing",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    w.launched.finish(w.nameOf(suite), { lint: 1, test: 0 });
    await w.service.tick();
    const ask = (externalId: string, headSha = HEAD, connectedRepoId = w.api.id) =>
      w.service.forgeRerequested({ connectedRepoId, headSha, externalId, deliveryId: "d-1" });
    assertEquals(await ask("nonsense"), "no-such-suite");
    assertEquals(await ask(`${suite.id}:1:lint`, sha("9")), "no-such-suite");
    assertEquals(await ask(`${suite.id}:1:lint`, HEAD, w.web.id), "no-such-suite");
    assertEquals(await ask(`${suite.id}:1:lint`), "checks-rerun");
    assertEquals(w.onlySuite().generation, 2);
    assertEquals(await ask(`${suite.id}:1:lint`), "no-such-suite", "queued now: nothing to re-run");
  },
);

test("the tool's status: nothing asked, then each suite and the newest verdict", async () => {
  const w = await checksWorld();
  assertStringIncludes((await w.service.statusForRun(w.run)).text, "asked for no checks");
  await w.request();
  await w.service.tick();
  assertStringIncludes((await w.service.statusForRun(w.run)).text, "running");
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  const { text } = await w.service.statusForRun(w.run);
  assertStringIncludes(text, "The newest settled suite");
  assertStringIncludes(text, "PASSED");
});

test("views: a suite as the page shows it, a task's suites, a patch's", async () => {
  const w = await checksWorld();
  const patch = w.patchOf();
  await w.store.createPatch(patch);
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const view = (await w.service.view(suite.id, SCOPE_ALL))!;
  assertEquals(view.repoRef, "acme/api");
  assertEquals(view.detailsUrl, `${APP_URL}/checks/${suite.id}`);
  assertEquals(view.checks.map((c) => [c.name, c.timeoutSeconds, c.hasLog]), [
    ["lint", 900, false],
    ["test", 1200, false],
  ]);
  assertEquals(view.requestedBy, [{ kind: "tool", runId: w.run.id, patchId: null }]);
  const task = (await w.store.getTask(w.run.taskId))!;
  assertEquals(
    (await w.service.viewsForTask(task, [w.run], [patch], SCOPE_ALL)).map((v) => v.id),
    [suite.id],
  );
  assertEquals((await w.service.forPatch(patch))!.id, suite.id, "none of its own: the head's");
  assertEquals(await w.service.forPatch({ ...patch, id: "p-none", headSha: sha("9") }), null);
  assertEquals(await w.service.view("cs-nothere00", SCOPE_ALL), null);
});

test(
  "a suite judging another task's patch shows on that task, and its readers may open it",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    // A second task's run lands a patch on the same head, and asks for nothing itself.
    const other = await w.startRepo(w.api, "main");
    assert(other.kind === "started");
    const run = (await w.store.getRun(other.runId))!;
    const patch = w.patchOf({ id: "p-2", runId: run.id, taskId: run.taskId });
    await w.store.createPatch(patch);
    const task = (await w.store.getTask(run.taskId))!;
    assertEquals(
      (await w.service.viewsForTask(task, [run], [patch], SCOPE_ALL)).map((v) => v.id),
      [suite.id],
    );
    assert((await w.service.taskIdsOf(suite.id)).includes(task.id));
  },
);

test("off, or refused: every door says so and nothing is written", async () => {
  const off = await checksWorld({ policy: { enabled: false } });
  const answer = await off.request();
  assertEquals([answer.status, answer.suiteId], [200, null]);
  assertStringIncludes(answer.text, "RYPH_CHECKS is off");
  await off.service.patchOpened(off.patchOf());
  await off.service.tick();
  assertEquals(off.checkStore.requests.size, 0);

  const refused = await checksWorld({ noLauncher: true });
  assertStringIncludes(refused.service.refusedReason!, "cannot run check pods");
  assertStringIncludes((await refused.request()).text, "cannot run checks on this deployment");
});

test("records nobody owns are discarded by the orphan sweep", async () => {
  const w = await checksWorld();
  w.launched.records.add("ryph-check-cs-deadbeef00-g1");
  w.launched.records.add("someone-elses-job");
  await w.request();
  await w.service.tick();
  assertEquals(w.launched.discarded, ["ryph-check-cs-deadbeef00-g1"]);
  assert(w.launched.records.has(w.nameOf(w.onlySuite())));
});

test("the forge report planner, pure: pending names, fenced tails, fingerprints", () => {
  const suite = {
    id: "cs-0123456789",
    connectedRepoId: "cr-api",
    commit: HEAD,
    checksRef: "main",
    checksCommit: BASE,
    checksBlob: BLOB,
    checksPath: ".ryph/checks.yml",
    definition: {
      setup: [],
      checks: [{ name: "t", run: "echo ```", timeoutSeconds: 60, services: [], watch: [] }],
    },
    environmentKey: "default:img",
    inputsKey: "k",
    networkScope: { mode: "open" as const, bundles: [], hosts: [] },
    environmentId: null,
    image: "img",
    services: [],
    source: { runId: "r", path: "api", bundleKey: "k", branchName: "b", baseRef: "main" },
    state: "waiting" as const,
    generation: 3,
    reason: null,
    attempts: 0,
    ryphChanged: true,
    leaseUntil: null,
    pods: null,
    version: 0,
    waitingSince: null,
    nextAttemptAt: null,
    launchedAt: null,
    finishedAt: null,
    createdAt: "t",
    updatedAt: "t",
  };
  const waiting = planForgeReport(suite, [], null);
  assertEquals(waiting.checks[0].status, "queued");
  assertStringIncludes(waiting.checks[0].title, "environment");
  assertEquals(waiting.suite, {
    state: "waiting",
    conclusion: null,
    summary: waiting.suite.summary,
  });
  assertEquals(waiting.detailsUrl, null);
  const result = {
    suiteId: suite.id,
    generation: 3,
    name: "t",
    state: "failed" as const,
    exitCode: 2,
    startedAt: null,
    finishedAt: null,
    logKey: "k",
    logTail: "boom ```` fence\u001b[2J",
    watchedChanged: true,
    forgeRef: "99",
    inheritedFrom: null,
  };
  const failed = planForgeReport(
    { ...suite, state: "failed" },
    [result],
    APP_URL,
  );
  const [check] = failed.checks;
  assertEquals([check.status, check.conclusion, check.forgeRef], ["completed", "failure", "99"]);
  assertStringIncludes(check.summary, "`````text", "a fence longer than the tail's own");
  assertStringIncludes(check.summary, "Watched paths changed");
  assertStringIncludes(check.summary, ".ryph/` changed");
  assert(!check.summary.includes("\u001b"), "control characters scrubbed");
  // The ids a forge answered with are not what it was told: a refs-only change sends nothing.
  const renamed = { ...result, forgeRef: "other", logTail: "other" };
  assertEquals(
    reportFingerprint({ generation: 3, state: "failed" }, [result]),
    reportFingerprint({ generation: 3, state: "failed" }, [renamed]),
  );
  assert(
    reportFingerprint({ generation: 3, state: "failed" }, [result]) !==
      reportFingerprint({ generation: 4, state: "failed" }, [result]),
  );
});

// ---------------------------------------------------------------------------
// Review round 1: what a check pod may reach, what it may print, whose commit it clones.
// ---------------------------------------------------------------------------

const EGRESS_KEY = new Uint8Array(32).fill(7);
const PROXY = "http://proxy.test:3128";

/** A second run of the same task, as the tests need one: same branch, its own id and scope. */
async function secondRun(
  w: Awaited<ReturnType<typeof checksWorld>>,
  over: Partial<Run> = {},
): Promise<Run> {
  const run: Run = { ...w.run, id: "r-second0000", ...over };
  await w.store.saveRun(run);
  return (await w.store.getRun(run.id))!;
}

test(
  "a check pod reaches what its requesting run may, and a narrower run gets a suite of its own",
  async () => {
    const w = await checksWorld({
      world: {
        egress: {
          policy: { mode: "proxy", bundles: [], hosts: ["a.test", "b.test"], proxyUrl: PROXY },
          key: EGRESS_KEY,
          tokenTtlMs: 3_600_000,
        },
      },
    });
    assertEquals(w.run.networkScope.hosts, ["a.test", "b.test"]);
    await w.request();
    const narrow = await secondRun(w, {
      networkScope: { mode: "proxy", bundles: [], hosts: ["a.test"] },
    });
    const other = await w.service.requestForRun(narrow, {
      path: "api",
      headSha: HEAD,
      branch: `${narrow.branchNamespace}/work`,
      baseSha: BASE,
    });
    assertEquals(other.reused, false, "a narrower scope never joins a wider suite");
    assertEquals(w.suites().length, 2);
    await w.service.tick();
    const hostsOf = async (spec: { proxyEnv: Record<string, string> }) => {
      const url = new URL(spec.proxyEnv.HTTPS_PROXY);
      const claim = await verifyEgressToken(
        decodeURIComponent(url.password),
        EGRESS_KEY,
        Date.parse(T0) / 1000,
      );
      return claim?.hosts;
    };
    const bySuite = new Map(w.launched.specs.map((s) => [s.suiteId, s]));
    const wide = w.suites().find((s) => s.networkScope.hosts.length === 2)!;
    const tight = w.suites().find((s) => s.networkScope.hosts.length === 1)!;
    assertEquals(await hostsOf(bySuite.get(wide.id)!), ["a.test", "b.test"]);
    assertEquals(await hostsOf(bySuite.get(tight.id)!), ["a.test"]);
  },
);

test("what a pod printed is stored and told with its credentials taken out", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  const token = `v1.${"A".repeat(40)}.${"B".repeat(43)}`;
  w.launched.logs.set(
    `${name}/check-test`,
    `HTTPS_PROXY=http://${suite.id}:${token}@proxy.test:3128\n` +
      `token ${token}\nAuthorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0\nFAIL\n`,
  );
  w.launched.finish(name, { lint: 0, test: 1 });
  await w.service.tick();
  const [result] = (await w.checkStore.listResults(suite.id, 1)).filter((r) => r.name === "test");
  const stored = w.logs.logs.get(result.logKey!)!;
  for (const text of [stored, result.logTail!, (await w.told())[0].text]) {
    assert(!text.includes(token), "the claim");
    assert(!text.includes("eC1hY2Nlc3MtdG9rZW46c2VjcmV0"), "the git key");
    assertStringIncludes(text, "FAIL");
  }
  assertStringIncludes(stored, "http://[redacted]@proxy.test:3128");
});

test("a kept log has no terminal escapes, and is still redacted", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  const token = `v1.${"A".repeat(40)}.${"B".repeat(43)}`;
  w.launched.logs.set(
    `${name}/check-test`,
    "\u001b[0m\u001b[32mDownload\u001b[0m https://jsr.io/x\n" +
      `HTTPS_PROXY=http://${suite.id}:${token}\u001b[0m@proxy.test:3128\n` +
      "\u001b]8;;https://a.test\u0007link\u001b]8;;\u0007 \u001b[1;31mFAIL\u001b[0m\n",
  );
  w.launched.finish(name, { lint: 0, test: 1 });
  await w.service.tick();
  const [result] = (await w.checkStore.listResults(suite.id, 1)).filter((r) => r.name === "test");
  const stored = w.logs.logs.get(result.logKey!)!;
  assertEquals(
    stored,
    "Download https://jsr.io/x\nHTTPS_PROXY=http://[redacted]@proxy.test:3128\nlink FAIL\n",
  );
  assert(!result.logTail!.includes("\u001b"));
});

test("stripAnsi takes out CSI, OSC and two-byte escapes, in linear time", () => {
  assertEquals(stripAnsi("\u001b[0m\u001b[32mDownload\u001b[0m x"), "Download x");
  assertEquals(stripAnsi("\u001b(Bplain\u001b7 \u009b2Ktext"), "plain text");
  assertEquals(stripAnsi("no escapes [0m here"), "no escapes [0m here");
  // Unterminated sequences, many of them: each scan stops at the next ESC.
  const big = ("\u001b[" + "1;".repeat(50)).repeat(40_000) +
    ("\u001b]" + "a".repeat(50)).repeat(40_000);
  const started = performance.now();
  stripAnsi(big);
  assert(performance.now() - started < 2_000, "quadratic on unterminated escapes");
});

test(
  "a clone that cannot fetch the first asker's commit retries on another asker's bundle",
  async () => {
    const w = await checksWorld();
    await w.request();
    const shipped = await secondRun(w);
    const bundleKey = `${shipped.id}/work/${w.api.id}/${HEAD}.bundle`;
    const patch = w.patchOf({ runId: shipped.id, bundleKey });
    await w.store.createPatch(patch);
    await w.service.patchOpened(patch);
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.source.runId, w.run.id);
    assertEquals(suite.state, "running");
    w.launched.inspections.set(w.nameOf(suite), {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: 128,
      why: "the candidate was not served",
    });
    await w.service.tick();
    const retried = w.onlySuite();
    assertEquals(retried.state, "queued");
    assertEquals((retried.source as BundleSource).bundleKey, bundleKey);
  },
);

test("changed paths that cannot be trusted are said to be unknown, never nothing", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  const name = w.nameOf(suite);
  // The front of the list was cut: two paths read, three counted.
  w.launched.logs.set(
    `${name}/clone`,
    "@@ryph-changed src/a.ts\n@@ryph-changed src/b.ts\n@@ryph-changed-end 3\n",
  );
  w.launched.finish(name, { lint: 0, test: 0 });
  await w.service.tick();
  const settled = w.onlySuite();
  assertEquals(settled.ryphChanged, null);
  const results = await w.checkStore.listResults(suite.id, 1);
  assertEquals(results.map((r) => r.watchedChanged), [null, null]);
  const [message] = await w.told();
  assertStringIncludes(message.text, "Could not tell which files this commit changed");
  const report = planForgeReport(settled, results, null);
  assertStringIncludes(report.checks[0].summary, "Watched paths unknown");
});

// ---------------------------------------------------------------------------
// Review round 1: builds, joins, cancels, clocks and the forge row.
// ---------------------------------------------------------------------------

test(
  "a build a suite waits on is never superseded, and a check's build supersedes nothing",
  async () => {
    const w = await checksWorld();
    w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
    w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
    await w.request();
    const first = w.onlySuite();
    const b1 = first.environmentId!;

    // main moves on and changes its machine: the push's build does not cancel the suite's.
    w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("b"), dockerfile: true });
    const environments = w.environmentService!;
    const subject = (await environments.loadSubject("repo", w.api.id))!;
    await environments.refreshSubject(subject, "push");
    const history = () => w.environmentStore.listEnvironmentsForSubject("repo", w.api.id);
    const pushed = (await history()).find((e) => e.trigger === "push")!;
    assertEquals((await w.environmentStore.getEnvironment(b1))!.status !== "superseded", true);

    // Another run's suite on another base machine asks for a build of its own: the push's stands.
    w.setHead("acme/api", "old", { commit: sha("9"), tree: tree("c"), dockerfile: true });
    w.files.set("*", checksFile({ commit: sha("9"), ryphTree: tree("c"), dockerfile: true }));
    const other = await secondRun(w);
    await w.service.requestForRun(other, {
      path: "api",
      headSha: sha("e"),
      branch: `${other.branchNamespace}/work`,
      baseSha: BASE,
    });
    const statuses = new Map((await history()).map((e) => [e.id, e.status]));
    assert(statuses.get(b1) !== "superseded", "the first suite's build");
    assert(statuses.get(pushed.id) !== "superseded", "the branch's own build");
    await w.service.tick();
    assertEquals(w.suites().map((s) => s.state), ["waiting", "waiting"]);
  },
);

test(
  "a cancelled suite joined again runs again; a pending ask of its head keeps it",
  async () => {
    const w = await checksWorld();
    await w.request();
    const first = w.onlySuite();
    // A patch of the same head is born but not yet read at its base.
    await w.service.patchOpened(w.patchOf());
    await w.request({ headSha: sha("e") });
    assertEquals((await w.checkStore.getSuite(first.id))!.state, "queued", "kept by the patch");

    const w2 = await checksWorld();
    await w2.request();
    const a = w2.onlySuite();
    await w2.request({ headSha: sha("e") });
    assertEquals((await w2.checkStore.getSuite(a.id))!.state, "cancelled");
    const again = await w2.request();
    assertEquals(again.suiteId, a.id);
    const rerun = (await w2.checkStore.getSuite(a.id))!;
    assertEquals([rerun.state, rerun.generation], ["queued", 2]);
  },
);

test("an errored suite joined again runs again, from the joiner's bundle", async () => {
  const w = await checksWorld();
  await w.request();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await w.service.tick();
    w.launched.inspections.set(w.nameOf(w.onlySuite()), {
      kind: "setup_failed",
      cloneDone: false,
      step: "clone",
      exitCode: 128,
      why: "the candidate was not served",
    });
    await w.service.tick();
    w.launched.inspections.delete(w.nameOf(w.onlySuite()));
  }
  assertEquals(w.onlySuite().state, "error");
  const shipped = await secondRun(w);
  const bundleKey = `${shipped.id}/work/${w.api.id}/${HEAD}.bundle`;
  const patch = w.patchOf({ runId: shipped.id, bundleKey });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  const restarted = w.onlySuite();
  assertEquals([restarted.generation, (restarted.source as BundleSource).bundleKey], [
    2,
    bundleKey,
  ]);
  assert(restarted.state === "queued" || restarted.state === "running");
});

test("the platform's failures are relaunched, never read as the head's", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const name = w.nameOf(w.onlySuite());
  // Evicted under the checks: exit 137, but the pod's reason.
  w.launched.finish(name, { lint: { exitCode: 137, reason: "Evicted" }, test: 0 });
  await w.service.tick();
  w.launched.inspections.delete(name);
  let suite = w.onlySuite();
  assertEquals(suite.state, "queued");
  assertStringIncludes(suite.reason!, "lint (Evicted)");
  // The entrypoint's own exit. `test` passed in the first pod and keeps that verdict.
  await w.service.tick();
  w.launched.finish(name, { lint: 125, test: 0 });
  await w.service.tick();
  w.launched.inspections.delete(name);
  assertEquals(w.onlySuite().state, "queued");
  // A setup step the pod ended under, with no exit code of its own.
  await w.service.tick();
  w.launched.inspections.set(name, {
    kind: "setup_failed",
    cloneDone: true,
    step: 0,
    exitCode: null,
    why: "the pod was evicted",
  });
  await w.service.tick();
  suite = w.onlySuite();
  assertEquals(suite.state, "error", "the third platform failure");
  assertStringIncludes(suite.reason!, "setup step 1 could not run");
  assertEquals((await w.told())[0].text.includes("FAILED"), false);
});

test("a pod that never starts its checks is the platform's error", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  w.launched.inspections.set(w.nameOf(w.onlySuite()), {
    kind: "pending",
    cloneDone: false,
    why: "ContainerCreating",
  });
  w.clock.advance(2 * 60 * 60_000);
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.state, "error");
  assertStringIncludes(suite.reason!, "did not start its checks");
  assertEquals(
    (await w.checkStore.listResults(suite.id, 1)).map((r) => r.state),
    ["error", "error"],
  );
});

test("a suite waiting a day on its environment is given up on", async () => {
  const w = await checksWorld();
  w.setHead("acme/api", "main", { commit: BASE, tree: tree("a"), dockerfile: true });
  w.files.set("*", checksFile({ ryphTree: tree("a"), dockerfile: true }));
  await w.request();
  await w.service.tick();
  assertEquals(w.onlySuite().state, "waiting");
  w.clock.advance(25 * 60 * 60_000);
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.state, "error");
  assertStringIncludes(suite.reason!, "not ready within a day");
});

test(
  "a run that ended, or a patch set aside, stops asking — and its suite is cancelled",
  async () => {
    const w = await checksWorld();
    await w.request();
    await w.service.tick();
    const suite = w.onlySuite();
    assertEquals(suite.state, "running");
    await w.store.saveRunResult({ ...w.run, state: "succeeded" });
    w.clock.advance(61_000);
    await w.service.tick();
    const cancelled = w.onlySuite();
    assertEquals(cancelled.state, "cancelled");
    assert(w.launched.discarded.includes(w.nameOf(suite)));

    const p = await checksWorld();
    const patch = p.patchOf();
    await p.store.createPatch(patch);
    await p.service.patchOpened(patch);
    await p.service.tick();
    await p.service.tick();
    assertEquals(p.onlySuite().state, "running");
    await p.store.savePatch({ ...patch, state: "superseded" });
    p.clock.advance(61_000);
    await p.service.tick();
    assertEquals(p.onlySuite().state, "cancelled");
  },
);

test(
  "a tool request slow to read answers 'requested', and a later refusal is sent",
  async () => {
    const w = await checksWorld({ answerWithinMs: 5 });
    let answer!: (file: ReturnType<typeof checksFile> | { kind: "absent"; commit: string }) => void;
    w.forge.readChecksFile = () => new Promise((done) => (answer = done));
    const asked = await w.request();
    assertEquals([asked.status, asked.suiteId], [202, null]);
    assertStringIncludes(asked.text, "taking a while");
    answer({ kind: "absent", commit: BASE });
    await w.service.idle();
    const [request] = [...w.checkStore.requests.values()];
    assertEquals(request.state, "refused");
    const told = await w.told();
    assertEquals(told.length, 1);
    assertStringIncludes(told[0].text, "No checks run for");
  },
);

test("a refusal written while the tool's wait runs out is the tool's answer", async () => {
  const w = await checksWorld({ answerWithinMs: 5 });
  w.files.set("*", { kind: "absent", commit: BASE });
  const save = w.checkStore.saveRequestIf;
  w.checkStore.saveRequestIf = async (request, states) => {
    if (request.state === "refused") await new Promise((done) => setTimeout(done, 30));
    return await save(request, states);
  };
  const asked = await w.request();
  assertEquals(asked.status, 200);
  assertStringIncludes(asked.text, "No checks run for");
  assertEquals([...w.checkStore.requests.values()][0].state, "refused");
  assertEquals(await w.told(), [], "answered once, by the tool");
});

test("a refusal whose message fails stays pending, and the tick sends it", async () => {
  const w = await checksWorld({ answerWithinMs: 5 });
  let answer!: (file: { kind: "absent"; commit: string }) => void;
  w.forge.readChecksFile = () => new Promise((done) => (answer = done));
  assertEquals((await w.request()).status, 202);
  const append = w.store.appendRunMessage;
  w.store.appendRunMessage = () => Promise.reject(new Error("inbox down"));
  answer({ kind: "absent", commit: BASE });
  await w.service.idle();
  const [request] = [...w.checkStore.requests.values()];
  assertEquals(request.state, "pending");
  assertEquals(await w.awaiting(), 1, "the run keeps waiting");

  w.store.appendRunMessage = append;
  w.forge.readChecksFile = () => Promise.resolve({ kind: "absent", commit: BASE });
  w.clock.advance(60_000);
  await w.service.tick();
  assertEquals([...w.checkStore.requests.values()][0].state, "refused");
  assertEquals((await w.told()).length, 1);
  assertEquals(await w.awaiting(), 0);
});

test(
  "a refusal whose message is in is sent once, though the bookkeeping after it throws",
  async () => {
    const w = await checksWorld({ answerWithinMs: 5 });
    let answer!: (file: { kind: "absent"; commit: string }) => void;
    w.forge.readChecksFile = () => new Promise((done) => (answer = done));
    assertEquals((await w.request()).status, 202);
    w.store.findResponseByRun = () => Promise.reject(new Error("responses down"));
    answer({ kind: "absent", commit: BASE });
    await w.service.idle();
    assertEquals([...w.checkStore.requests.values()][0].state, "refused");
    w.clock.advance(60_000);
    await w.service.tick();
    assertEquals((await w.told()).length, 1);
  },
);

test("a refusal too long for the inbox is cut to fit, and sent", async () => {
  const w = await checksWorld({ answerWithinMs: 5 });
  let answer!: (file: { kind: "invalid"; commit: null; detail: string }) => void;
  w.forge.readChecksFile = () => new Promise((done) => (answer = done));
  assertEquals((await w.request()).status, 202);
  answer({ kind: "invalid", commit: null, detail: "x".repeat(MAX_MESSAGE_CHARS + 100) });
  await w.service.idle();
  assertEquals([...w.checkStore.requests.values()][0].state, "refused");
  const [told] = await w.told();
  assertEquals(told.text.length, MAX_MESSAGE_CHARS);
});

test("a refusal of a request replaced meanwhile is not sent", async () => {
  const w = await checksWorld({ answerWithinMs: 5 });
  const answers: Array<(file: { kind: "absent"; commit: string }) => void> = [];
  w.forge.readChecksFile = () => new Promise((done) => answers.push(done));
  assertEquals((await w.request()).status, 202);
  assertEquals((await w.request({ headSha: sha("e") })).status, 202);
  const [first] = [...w.checkStore.requests.values()];
  assertEquals(first.state, "superseded");
  answers[0]({ kind: "absent", commit: BASE });
  answers[1]({ kind: "absent", commit: BASE });
  await w.service.idle();
  assertEquals(w.checkStore.requests.get(first.id)!.state, "superseded");
  // The run hears of the request that replaced it alone.
  const told = await w.told();
  assertEquals(told.length, 1);
  assertStringIncludes(told[0].text, `No checks run for ${sha("e").slice(0, 10)}`);
});

test("a suite that moves while its report is in flight is reported again", async () => {
  const w = await checksWorld();
  await w.request();
  await w.store.createPatch(w.patchOf());
  await w.service.patchSubmitted(w.patchOf());
  w.reportAnswer.fn = (report) => {
    // The suite moves on while the forge is being told about it.
    void w.checkStore.touchForgeReports(w.onlySuite(), "2026-01-01T00:00:00.001Z");
    return {
      kind: "reported",
      refs: Object.fromEntries(report.checks.map((c) => [c.name, `cr-${c.name}`])),
    };
  };
  await w.service.tick();
  const row = (await w.checkStore.findForgeReport({ patchId: "p-1" }))!;
  assert(row.nextAttemptAt !== null, "the touch's clock stands");
  assert(row.reportedFingerprint !== null, "and what the report said lands");
});

test(
  "a patch still being read is reported from the head's newest suite, never bound to it",
  async () => {
    const w = await checksWorld();
    await w.request();
    const toolSuite = w.onlySuite();
    // The patch comes from a run with a narrower network: its own suite differs.
    assertEquals(w.run.networkScope.mode, "proxy");
    const narrow = await secondRun(w, {
      networkScope: { mode: "open", bundles: [], hosts: [] },
    });
    const patch = w.patchOf({
      runId: narrow.id,
      bundleKey: `${narrow.id}/work/${w.api.id}/${HEAD}.bundle`,
    });
    await w.store.createPatch(patch);
    w.files.set("*", { kind: "unavailable", detail: "forge down" });
    await w.service.patchOpened(patch);
    await w.service.patchSubmitted(patch);
    await w.service.tick();
    assertEquals(w.reports.at(-1)!.suiteId, toolSuite.id, "the newest suite on the head");
    assertEquals(
      (await w.checkStore.findForgeReport({ patchId: patch.id }))!.suiteId,
      null,
      "not remembered",
    );

    w.files.set("*", checksFile());
    w.clock.advance(31_000);
    await w.service.tick();
    const own = w.suites().find((s) => s.id !== toolSuite.id)!;
    assertEquals(w.reports.at(-1)!.suiteId, own.id);
    assertEquals((await w.checkStore.findForgeReport({ patchId: patch.id }))!.suiteId, own.id);
  },
);

test("a re-run: any settled suite, the forge's button included; off is a 409", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  const again = await w.service.forgeRerequested({
    connectedRepoId: w.api.id,
    headSha: HEAD,
    externalId: `${suite.id}:1:lint`,
    deliveryId: "d-1",
  });
  assertEquals(again, "checks-rerun");
  assertEquals(w.onlySuite().generation, 2);

  const refused = await checksWorld({ noLauncher: true });
  const outcome = await refused.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  assertEquals(outcome.kind === "refused" && outcome.status, 409);
});

test("the forge's re-run all: what was reported on the head re-runs, nothing else", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  const all = (headSha: string, deliveryId: string) =>
    w.service.forgeSuiteRerequested({ connectedRepoId: w.api.id, headSha, deliveryId });
  // Only a run's tool asked: the forge was never told, so the button was not ryph's to show.
  assertEquals(await all(HEAD, "d-1"), "no-such-suite");
  assertEquals(w.onlySuite().generation, 1);

  await w.store.createPatch(w.patchOf());
  await w.service.patchSubmitted(w.patchOf());
  await w.service.tick();
  // The patch reports the tool's suite as its fallback: no suite of its own on the row.
  assertEquals(w.reports.at(-1)!.suiteId, suite.id);
  assertEquals(await all("f".repeat(40), "d-2"), "no-such-suite", "another head");
  assertEquals(await all(HEAD, "d-3"), "checks-rerun");
  assertEquals(w.onlySuite().generation, 2);

  // A row re-pointed onto its own suite stands on that, whatever its last report still names.
  await w.service.tick();
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "passed");
  const row = [...w.checkStore.reports.values()][0];
  w.checkStore.reports.set(row.id, {
    ...row,
    suiteId: suite.id,
    reportedFingerprint: "cs-0000000000:1:passed:stale",
  });
  assertEquals(await all(HEAD, "d-4"), "checks-rerun");
  assertEquals(w.onlySuite().generation, 3);
});

test(
  "a services refusal is part of the identity: fixed, the next ask is a new suite",
  async () => {
    const w = await checksWorld({ services: { ...DEFAULT_SERVICE_POLICY, enabled: true } });
    const yml = "checks:\n  - name: e2e\n    run: x\n    services: [db]\n";
    const declares = (text: string) =>
      checksFile({ text: yml, services: { kind: "file", text: `services:\n${text}` } });
    w.files.set("*", declares("  cache:\n    uses: redis@8\n    port: 6379\n"));
    await w.request();
    const refused = w.onlySuite();
    assertEquals(refused.state, "error");
    // Asked again unchanged: the same answer, and nothing runs again.
    await w.request();
    assertEquals([w.suites().length, w.onlySuite().generation], [1, 1]);
    // The base's services.yml fixed (same checks.yml blob): a suite of its own, that runs.
    w.files.set("*", declares("  db:\n    uses: postgres@18\n    port: 5433\n"));
    const fixed = await w.request();
    assert(fixed.suiteId !== refused.id);
    assertEquals(fixed.state, "queued");
  },
);
