// What a run may read of checks it did not ask for (`ryph__check_status` with commits, and
// `ryph__check_log`): the suites anyone ran on a commit of a repo its task holds — a change
// request's pushes above all, which a reviewing run needs — but never a person's own ask from
// their machine, and nothing on a repo the run does not hold.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ChangeRequestPush } from "../src/core/checks.ts";
import { checksWorld, HEAD, sha } from "./checks_world.ts";

type World = Awaited<ReturnType<typeof checksWorld>>;

const OTHER = sha("e");

const pushOf = (w: World, over: Partial<ChangeRequestPush> = {}): ChangeRequestPush => ({
  connectedRepoId: w.api.id,
  ref: "42",
  headSha: HEAD,
  baseRef: "main",
  fetchRef: "refs/pull/42/head",
  url: "https://github.com/acme/api/pull/42",
  ...over,
});

/** A change request's push on HEAD, run and settled: lint passes, test fails with a long log. */
async function pushedAndFailed(w: World, over: Partial<ChangeRequestPush> = {}) {
  assertEquals(await w.service.changeRequestPushed(pushOf(w, over)), "checks-requested");
  await w.service.tick();
  const suite = w.suites().find((s) => s.commit === (over.headSha ?? HEAD))!;
  const name = w.nameOf(suite);
  w.launched.logs.set(`${name}/check-lint`, "ok\n");
  w.launched.logs.set(
    `${name}/check-test`,
    `${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`,
  );
  w.launched.finish(name, { lint: 0, test: 1 });
  await w.service.tick();
  return (await w.checkStore.getSuite(suite.id))!;
}

const at = (commit: string, named = false, path = "api") => ({
  commits: [{ path, commit }],
  named,
});

test("a run that asked for nothing sees what a change request's push got on its head", async () => {
  const w = await checksWorld();
  const suite = await pushedAndFailed(w);
  assertEquals(suite.state, "failed");

  // asked without commits: only the run's own asks, as before
  assertStringIncludes((await w.service.statusForRun(w.run)).text, "asked for no checks yet");

  const { text } = await w.service.statusForRun(w.run, at(HEAD));
  assertStringIncludes(text, "This run has asked for no checks itself.");
  assertStringIncludes(text, `Checks on api at ${HEAD.slice(0, 10)}, the checked-out head`);
  assertStringIncludes(text, `suite ${suite.id} FAILED`);
  assertStringIncludes(text, "(for change request 42)");
  assertStringIncludes(text, "- test: FAILED (exit 1)");
  // the newest settled suite in full: its failing tail, fenced as the check's own words
  assertStringIncludes(text, "<<<check-output-NONCE>>>");
  assertStringIncludes(text, "line 199");
  assertStringIncludes(text, "ryph__check_log");

  const named = await w.service.statusForRun(w.run, at(HEAD, true));
  assertStringIncludes(named.text, `Checks on api at ${HEAD.slice(0, 10)}, newest first:`);
  assert(!named.text.includes("asked for no checks"), "named: the commit alone");

  const none = await w.service.statusForRun(w.run, at(OTHER, true));
  assertEquals(none.text, `No checks have run on api at ${OTHER.slice(0, 10)}.`);
  // unnamed, a head nothing ran on adds nothing
  assertStringIncludes(
    (await w.service.statusForRun(w.run, at(OTHER))).text,
    "Pass `commit` to look up the checks on another commit",
  );
});

test("a run's own suite on its head is said once, under its own asks", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  const { text } = await w.service.statusForRun(w.run, at(HEAD));
  assertStringIncludes(text, "Checks this run asked for");
  assert(!text.includes("the checked-out head"), text);
  assertEquals(text.split(`suite ${suite.id} PASSED`).length - 1, 1, "listed once");
  // named, the commit's suites are listed whoever asked: this run's own among them
  const named = await w.service.statusForRun(w.run, at(HEAD, true));
  assertStringIncludes(named.text, `suite ${suite.id} PASSED`);
  assertStringIncludes(named.text, "(for a run's ryph__run_checks)");
});

test("a person's ask from their own machine stays theirs", async () => {
  const w = await checksWorld();
  w.forge.readBranchHead = () => Promise.resolve({ kind: "head", sha: HEAD });
  const answer = await w.service.requestLocal({
    user: { userId: "u-1", name: "Ada" },
    repo: w.api,
    commit: HEAD,
    branch: "feat",
    bundled: false,
  });
  assert(answer.kind === "requested", JSON.stringify(answer));
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.logs.set(`${w.nameOf(suite)}/check-lint`, "secret-ish\n");
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(
    (await w.service.statusForRun(w.run, at(HEAD, true))).text,
    `No checks have run on api at ${HEAD.slice(0, 10)}.`,
  );
  const log = await w.service.logForRun(w.run, { suiteId: suite.id, check: "lint" });
  assert(log.kind === "refused");
  assertEquals(log.status, 404);
  assertStringIncludes(log.why, "this run may read");

  // once a change request's push asks for the same suite, it is the change request's too
  await w.service.changeRequestPushed(pushOf(w));
  await w.service.tick();
  const joined = await w.service.logForRun(w.run, { suiteId: suite.id, check: "lint" });
  assert(joined.kind === "log", JSON.stringify(joined));
  assertEquals(joined.text, "secret-ish\n");
});

test("nothing on a repo the run's task does not hold", async () => {
  const w = await checksWorld();
  w.setHead("acme/web", "main", { commit: sha("a"), tree: null });
  const suite = await pushedAndFailed(w, {
    connectedRepoId: w.web.id,
    url: "https://github.com/acme/web/pull/42",
  });
  assertEquals(suite.connectedRepoId, w.web.id);
  // the run holds only api: a path it does not hold is no repository of it
  assertEquals(
    (await w.service.statusForRun(w.run, at(HEAD, true, "web"))).text,
    "web is not a connected repository of this run, so the platform runs no checks for it.",
  );
  // and api at the same commit is a different repo's suite
  assertStringIncludes(
    (await w.service.statusForRun(w.run, at(HEAD, true))).text,
    "No checks have run on api",
  );
  const log = await w.service.logForRun(w.run, { suiteId: suite.id, check: "test" });
  assert(log.kind === "refused");
  assertEquals(log.status, 404);
});

test("a check's whole log, by generation, and refusals that say what there is", async () => {
  const w = await checksWorld();
  const suite = await pushedAndFailed(w);
  const log = await w.service.logForRun(w.run, { suiteId: suite.id, check: "test" });
  assert(log.kind === "log", JSON.stringify(log));
  assertEquals(log.generation, 1);
  assert(log.text.startsWith("line 0\n"), "the whole log, not its tail");
  assertStringIncludes(log.text, "line 199");

  const wrongCheck = await w.service.logForRun(w.run, { suiteId: suite.id, check: "build" });
  assert(wrongCheck.kind === "refused");
  assertStringIncludes(wrongCheck.why, "it runs lint, test");
  const wrongGen = await w.service.logForRun(w.run, {
    suiteId: suite.id,
    check: "test",
    generation: 2,
  });
  assert(wrongGen.kind === "refused");
  assertStringIncludes(wrongGen.why, "only generation 1");
  const missing = await w.service.logForRun(w.run, { suiteId: "cs-0000000000", check: "test" });
  assert(missing.kind === "refused");
  assertEquals(missing.status, 404);

  // a re-run: the latest generation unless an earlier one is named; no log until it has run
  const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  assertEquals(rerun.kind, "rerun");
  const pending = await w.service.logForRun(w.run, { suiteId: suite.id, check: "test" });
  assert(pending.kind === "refused");
  assertStringIncludes(pending.why, "no log in generation 2");
  const first = await w.service.logForRun(w.run, {
    suiteId: suite.id,
    check: "test",
    generation: 1,
  });
  assert(first.kind === "log");
  assertEquals(first.generation, 1);
});

test("another task's run_checks and unpublished patch stay that task's; a published patch does not", async () => {
  const w = await checksWorld();
  const started = await w.startRepo(w.api, "main");
  assert(started.kind === "started");
  const other = (await w.store.getRun(started.runId))!;
  assert(other.taskId !== w.run.taskId);
  const asked = await w.service.requestForRun(other, {
    path: "api",
    headSha: HEAD,
    branch: `${other.branchNamespace}/work`,
    baseSha: sha("a"),
  });
  assert(asked.suiteId !== null, JSON.stringify(asked));
  await w.service.tick();
  const suite = w.onlySuite();
  w.launched.logs.set(`${w.nameOf(suite)}/check-test`, "their work in progress\n");
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
  await w.service.tick();

  const unseen = async () => {
    assertEquals(
      (await w.service.statusForRun(w.run, at(HEAD, true))).text,
      `No checks have run on api at ${HEAD.slice(0, 10)}.`,
    );
    const log = await w.service.logForRun(w.run, { suiteId: suite.id, check: "test" });
    assert(log.kind === "refused" && log.status === 404, JSON.stringify(log));
  };
  await unseen();
  // the other task's own run reads it
  assert((await w.service.logForRun(other, { suiteId: suite.id, check: "test" })).kind === "log");

  // its patch on that head, not yet on the forge: still that task's own
  const patch = w.patchOf({ id: "p-other", runId: other.id, taskId: other.taskId });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  assertEquals(w.suites().length, 1, "the patch joins the suite");
  await unseen();

  // once it reached the forge, its head is anyone's to fetch
  await w.store.savePatch({ ...patch, forgeRef: "7", state: "submitted" });
  const seen = await w.service.statusForRun(w.run, at(HEAD, true));
  assertStringIncludes(seen.text, `suite ${suite.id} FAILED`);
  assertStringIncludes(seen.text, "(for a patch)");
  assert(!seen.text.includes("ryph__run_checks)"), "the other run's ask is not named");
  assert((await w.service.logForRun(w.run, { suiteId: suite.id, check: "test" })).kind === "log");
});

test("a status too long for one message is cut between sections, never inside a fence", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const own = w.onlySuite();
  const huge = `${"x".repeat(200)}\n`.repeat(400);
  w.launched.logs.set(`${w.nameOf(own)}/check-test`, huge);
  w.launched.finish(w.nameOf(own), { lint: 0, test: 1 });
  await w.service.tick();
  await pushedAndFailed(w, { headSha: OTHER });
  const { text } = await w.service.statusForRun(w.run, at(OTHER));
  const opens = text.split("<<<check-output-NONCE>>>").length - 1;
  const closes = text.split("<<<end-check-output-NONCE>>>").length - 1;
  assertEquals(opens, closes, "every fence that opens closes");
});

test("a status for many heads gives each note its share, and closes every fence", async () => {
  const w = await checksWorld();
  await w.request();
  await w.service.tick();
  const own = w.onlySuite();
  const huge = `${"x".repeat(200)}\n`.repeat(400);
  w.launched.logs.set(`${w.nameOf(own)}/check-test`, huge);
  w.launched.logs.set(`${w.nameOf(own)}/check-lint`, huge);
  w.launched.finish(w.nameOf(own), { lint: 1, test: 1 });
  await w.service.tick();
  await pushedAndFailed(w, { headSha: OTHER });
  const { text } = await w.service.statusForRun(w.run, {
    commits: [{ path: "api", commit: OTHER }],
    named: false,
  });
  assert(text.length <= 16 * 1024);
  assertEquals(
    text.split("<<<check-output-NONCE>>>").length,
    text.split("<<<end-check-output-NONCE>>>").length,
  );
  // both sections made it, each with its verdict
  assertStringIncludes(text, "Checks this run asked for");
  assertStringIncludes(text, `Checks on api at ${OTHER.slice(0, 10)}`);
});

test("the newest verdict on a commit is a decided one before a cancelled one", async () => {
  const w = await checksWorld();
  const failed = await pushedAndFailed(w);
  // a newer full suite on the same head, cancelled before it ran
  const cancelled = {
    ...failed,
    id: "cs-ffffffffff",
    checksBlob: sha("9"),
    state: "cancelled" as const,
    createdAt: new Date(Date.parse(failed.createdAt) + 60_000).toISOString(),
  };
  await w.checkStore.claimSuite(cancelled);
  const requests = await w.checkStore.listRequestsForSuite(failed.id);
  await w.checkStore.createRequest({ ...requests[0], id: "cq-ffffffffff", suiteId: cancelled.id });
  const { text } = await w.service.statusForRun(w.run, at(HEAD, true));
  assertStringIncludes(text, `suite ${cancelled.id} cancelled`);
  const note = text.slice(text.indexOf("The newest settled suite there:"));
  assertStringIncludes(note, `suite ${failed.id}, generation`);
});

test("with many heads and a long list of its own, a note with no room is pointed to, never mangled", async () => {
  const w = await checksWorld();
  // ten asks of its own, each a line in its list
  for (let i = 0; i < 10; i++) {
    await w.request({ headSha: sha(String(i)) });
    await w.service.tick();
  }
  for (const suite of w.suites()) {
    w.launched.finish(w.nameOf(suite), { lint: 1, test: 1 });
  }
  await w.service.tick();
  const commits = Array.from({ length: 8 }, () => ({ path: "api", commit: OTHER }));
  const { text } = await w.service.statusForRun(w.run, { commits, named: false });
  assert(text.length <= 16 * 1024);
  assertStringIncludes(text, "full report did not fit here");
  assertStringIncludes(text, "The newest settled suite:");
  assertEquals(
    text.split("<<<check-output-NONCE>>>").length,
    text.split("<<<end-check-output-NONCE>>>").length,
  );
});
