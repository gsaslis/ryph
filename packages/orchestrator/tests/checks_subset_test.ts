// A run of only some checks: `ryph__run_checks` naming them. Its own suite (the names are part of
// the identity), a pod of just those checks, the run told as usual, and never the forge's or a
// patch's: a patch is always judged by the whole declaration.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { checksFile, checksWorld, HEAD, sha } from "./checks_world.ts";
import { SCOPE_ALL } from "../src/core/scope.ts";

test("a subset suite runs only the named checks, in a pod of its own", async () => {
  const w = await checksWorld();
  const asked = await w.request({ checks: ["test"] });
  assertEquals(asked.status, 202);
  const suite = w.onlySuite();
  assertEquals(suite.definition.partial, true);
  assertEquals(suite.definition.checks.map((c) => c.name), ["test"]);
  assertEquals((await w.checkStore.listResults(suite.id, 1)).map((r) => r.name), ["test"]);
  await w.service.tick();
  // The pod carries the one check, so it gets the whole size class.
  assertEquals(w.launched.specs.at(-1)!.checks.map((c) => c.name), ["test"]);
  assertEquals((await w.service.view(suite.id, SCOPE_ALL))!.partial, true);

  w.launched.finish(w.nameOf(suite), { test: 1 });
  await w.service.tick();
  assertEquals(w.onlySuite().state, "failed");
  const told = await w.told();
  assertEquals(told.length, 1, "told as any request is");
  assertStringIncludes(told[0].text, "only test of the checks");
  assertEquals(told[0].payload, {
    kind: "checks",
    suiteId: suite.id,
    state: "failed",
    path: "api",
    commit: HEAD,
    partial: true,
  });
});

test("the subset is part of the identity: equal subsets join, a full ask never does", async () => {
  const w = await checksWorld();
  const lint = await w.request({ checks: ["lint"] });
  // The same subset, named twice over: the same suite.
  const again = await w.request({ checks: ["lint", "lint"] });
  assertEquals(again.suiteId, lint.suiteId);
  assertEquals(again.reused, true);
  const full = await w.request();
  assert(full.suiteId !== lint.suiteId);
  // Naming every check is asking for all of them: the full suite.
  const every = await w.request({ checks: ["test", "lint"] });
  assertEquals(every.suiteId, full.suiteId);
  assertEquals(w.checkStore.suites.get(full.suiteId!)!.definition.partial, undefined);
  // An empty list is all of them too.
  assertEquals((await w.request({ checks: [] })).suiteId, full.suiteId);
  // A subset asked after the full suite is still its own.
  const lintLater = await w.request({ checks: ["lint"] });
  assert(lintLater.suiteId !== full.suiteId);
  // No subset ever carries the ask's names into what the pod clones from.
  for (const suite of w.suites()) assertEquals(suite.source.checks, undefined);
});

test("a name the base does not declare is refused, with the names it does", async () => {
  const w = await checksWorld();
  const refused = await w.request({ checks: ["lint", "typecheck"] });
  assertEquals([refused.status, refused.suiteId], [200, null]);
  assertStringIncludes(refused.text, "typecheck is not a check in .ryph/checks.yml on main");
  assertStringIncludes(refused.text, "Its checks: lint, test");
  assertEquals(w.suites().length, 0);
});

test("subset asks count toward the per-run cap", async () => {
  const w = await checksWorld({ policy: { maxPerRun: 2 } });
  assertEquals((await w.request({ checks: ["lint"] })).status, 202);
  assertEquals((await w.request({ headSha: sha("e"), checks: ["test"] })).status, 202);
  const capped = await w.request({ headSha: sha("f") });
  assertEquals(capped.status, 429);
});

test("a subset suite is never reported to the forge, nor judges a patch", async () => {
  const w = await checksWorld();
  const subset = await w.request({ checks: ["lint"] });
  await w.service.tick();
  const partial = w.checkStore.suites.get(subset.suiteId!)!;
  w.launched.finish(w.nameOf(partial), { lint: 0 });
  // A patch on the same head reaches the forge before its own request is read.
  const patch = w.patchOf({ state: "submitted", forgeRef: "7" });
  await w.store.createPatch(patch);
  await w.service.patchSubmitted(patch);
  await w.service.tick();
  assertEquals(w.checkStore.suites.get(partial.id)!.state, "passed");
  assertEquals(w.reports.filter((r) => r.suiteId === partial.id), []);
  assertEquals(await w.service.forPatch(patch), null, "a subset says nothing about the head");

  // The patch's own request makes the full suite, which is the one reported.
  await w.service.patchOpened(patch);
  await w.service.tick();
  const full = w.suites().find((s) => s.id !== partial.id)!;
  assertEquals(full.definition.partial, undefined);
  assertEquals(full.commit, HEAD);
  assertEquals((await w.service.forPatch(patch))!.id, full.id);
  assert(w.reports.length > 0);
  assert(w.reports.every((r) => r.suiteId === full.id));
  assertEquals(w.reports.at(-1)!.checks.map((c) => c.name), ["lint", "test"]);
  assertEquals(
    await w.service.suiteIdsForPatches([patch]),
    { [patch.id]: full.id },
  );
});

test("a subset suite re-runs from the app as the same subset; the forge cannot re-run it", async () => {
  const w = await checksWorld();
  const subset = await w.request({ checks: ["lint"] });
  await w.service.tick();
  const suite = w.checkStore.suites.get(subset.suiteId!)!;
  w.launched.finish(w.nameOf(suite), { lint: 1 });
  await w.service.tick();
  const rerun = await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  assert(rerun.kind === "rerun");
  assertEquals(rerun.suite.generation, 2);
  assertEquals(rerun.suite.definition.checks.map((c) => c.name), ["lint"]);
  assertEquals(
    await w.service.forgeRerequested({
      connectedRepoId: suite.connectedRepoId,
      headSha: suite.commit,
      externalId: `${suite.id}:2:lint`,
      deliveryId: "d-1",
    }),
    "no-such-suite",
  );
});

test("check_status marks a subset ask", async () => {
  const w = await checksWorld();
  await w.request({ checks: ["lint"] });
  const { text } = await w.service.statusForRun(w.run);
  assertStringIncludes(text, "(ryph__run_checks, only lint)");
  assertStringIncludes(text, "lint queued");
  assert(!text.includes("test queued"), text);
});

test("the declared checks for the prompt: bounded, never a throw, unread repos named", async () => {
  const w = await checksWorld();
  const { declared: [api], unread } = await w.service.declaredForRun(w.run);
  assertEquals(api.checks.map((c) => [c.name, c.run]), [["lint", "deno lint"], [
    "test",
    "deno task test",
  ]]);
  assertEquals(api.setup, ["npm ci"]);
  assertEquals(unread, []);
  // No checks file: in neither list.
  w.files.set("*", { kind: "absent", commit: sha("a") });
  w.clock.advance(61_000);
  assertEquals(await w.service.declaredForRun(w.run), { declared: [], unread: [] });
  w.files.set("*", { kind: "invalid", commit: sha("a"), detail: "too big" });
  w.clock.advance(61_000);
  assertEquals(await w.service.declaredForRun(w.run), { declared: [], unread: [] });
  // Unavailable, throwing, too slow: unread.
  w.files.set("*", { kind: "unavailable", detail: "down" });
  w.clock.advance(61_000);
  assertEquals(await w.service.declaredForRun(w.run), { declared: [], unread: ["api"] });
  w.forge.readChecksFile = () => Promise.reject(new Error("forge down"));
  assertEquals(await w.service.declaredForRun(w.run), { declared: [], unread: ["api"] });
  w.forge.readChecksFile = () => new Promise(() => {});
  assertEquals(await w.service.declaredForRun(w.run, 20), { declared: [], unread: ["api"] });
  // The task itself not read in time: every repo is unknown.
  w.store.getTask = () => new Promise(() => {});
  assertEquals(await w.service.declaredForRun(w.run, 20), { declared: [], unread: ["*"] });
  w.store.getTask = () => Promise.reject(new Error("db down"));
  assertEquals(await w.service.declaredForRun(w.run), { declared: [], unread: ["*"] });
});

test("the declared checks: one read per repo and ref a minute, a failed one not kept", async () => {
  const w = await checksWorld();
  let reads = 0;
  let answer!: (file: ReturnType<typeof checksFile>) => void;
  w.forge.readChecksFile = () => {
    reads++;
    return new Promise((done) => (answer = done));
  };
  // A burst of boots while the first read hangs past their deadline: one read between them.
  assertEquals(await w.service.declaredForRun(w.run, 10), { declared: [], unread: ["api"] });
  assertEquals(await w.service.declaredForRun(w.run, 10), { declared: [], unread: ["api"] });
  assertEquals(reads, 1);
  answer(checksFile());
  assertEquals((await w.service.declaredForRun(w.run)).declared.length, 1);
  assertEquals(reads, 1);
  w.clock.advance(61_000);
  w.forge.readChecksFile = () => {
    reads++;
    return Promise.resolve({ kind: "unavailable", detail: "down" });
  };
  assertEquals((await w.service.declaredForRun(w.run)).unread, ["api"]);
  assertEquals((await w.service.declaredForRun(w.run)).unread, ["api"]);
  assertEquals(reads, 3, "an unanswered read is asked again");
});

test("the declared checks: a slow repo costs only itself, and is named", async () => {
  const w = await checksWorld();
  const task = (await w.store.getTask(w.run.taskId))!;
  const [api] = task.repos;
  const web = { ...api, path: "web", connectedRepoId: w.web.id, url: w.web.url };
  w.store.getTask = () => Promise.resolve({ ...task, repos: [api, web] });
  w.forge.readChecksFile = (_repo, url) =>
    url === w.web.url ? new Promise(() => {}) : Promise.resolve(checksFile());
  const started = Date.now();
  const { declared, unread } = await w.service.declaredForRun(w.run, 50);
  assert(Date.now() - started < 2_000, "bounded");
  assertEquals(declared.map((d) => d.path), ["api"]);
  assertEquals(unread, ["web"]);
});

test("check_status says 'only' of a subset, never of an ask naming every check", async () => {
  const w = await checksWorld();
  await w.request({ checks: ["lint", "test"] });
  const { text } = await w.service.statusForRun(w.run);
  assert(!text.includes("only"), text);
  assertStringIncludes(text, "lint queued, test queued");

  // Not read yet: the base's full suite says every check was named.
  const w2 = await checksWorld({ answerWithinMs: 5 });
  await w2.request();
  await w2.service.idle();
  w2.forge.readChecksFile = () => new Promise(() => {});
  await w2.request({ headSha: sha("e"), checks: ["test", "lint"] });
  const pending = (await w2.service.statusForRun(w2.run)).text;
  assert(!pending.includes("only"), pending);
  await w2.request({ headSha: sha("9"), checks: ["lint"] });
  assertStringIncludes((await w2.service.statusForRun(w2.run)).text, "only lint");
});

test("a subset suite nobody wants is cancelled, though a full ask of its head is pending", async () => {
  const w = await checksWorld();
  await w.request({ checks: ["lint"] });
  const subset = w.onlySuite();
  // A patch of the same head, not yet read: it asks for every check, so never this suite.
  await w.service.patchOpened(w.patchOf());
  await w.request({ headSha: sha("e") });
  assertEquals((await w.checkStore.getSuite(subset.id))!.state, "cancelled");
});

test("a local repository reaches the run by its folder name, never its host path", async () => {
  // The prompt's declared checks, the tool's answer and the settled note all name the repo; for
  // a repository on the deployment's disk the name is its folder, not where the owner keeps it.
  const w = await checksWorld();
  const path = "/Users/ada/secret-client/api";
  await w.store.saveConnectedRepo({ ...w.api, provider: "local", repoRef: path, url: path });
  const { declared: [api] } = await w.service.declaredForRun(w.run);
  assertEquals(api.repoRef, "api");
  const asked = await w.request();
  assertStringIncludes(asked.text, "on api");
  assert(!asked.text.includes(path), asked.text);
  await w.service.tick();
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  const told = await w.told();
  assert(told.length > 0);
  for (const message of told) assert(!message.text.includes(path), message.text);
  // Nothing the run was ever told carries the path.
  for (const message of await w.store.listRunMessages(w.run.id)) {
    assert(!message.text.includes("/Users/ada"), message.text);
  }
});
