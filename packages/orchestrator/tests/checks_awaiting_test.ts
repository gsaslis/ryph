// What a run's runner holds a finish on: the verdicts its own requests will still be told.
// Owed from the ask until the message is in, once per suite whoever of the run asked for it,
// and never for a request that was replaced or refused. Each is named, with the requests owed
// it, so a runner that gave up on one can tell it from a verdict asked for later.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { checksWorld, HEAD } from "./checks_world.ts";

const sha = (c: string) => c.repeat(40);

test("awaiting: owed from the ask until the verdict is in the inbox", async () => {
  const w = await checksWorld();
  assertEquals(await w.awaiting(), 0, "nothing asked, nothing owed");
  await w.request();
  assertEquals(await w.awaiting(), 1, "asked and not yet read at the base");
  await w.service.tick();
  const suite = w.onlySuite();
  assertEquals(suite.state, "running");
  assertEquals(await w.awaiting(), 1);
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 1 });
  await w.service.tick();
  assertEquals((await w.told()).length, 1);
  assertEquals(await w.awaiting(), 0, "told, so nothing is owed");
});

test("awaiting: a tool request and a patch of one head are one verdict", async () => {
  const w = await checksWorld();
  await w.request();
  const patch = w.patchOf({ headSha: HEAD });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  assertEquals(await w.awaiting(), 2, "two asks, neither resolved yet");
  await w.service.tick();
  assertEquals(w.suites().length, 1);
  assertEquals(await w.awaiting(), 1, "both on one suite");
  w.launched.finish(w.nameOf(w.onlySuite()), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(await w.awaiting(), 0);
});

test("awaiting: a replaced request is owed nothing; its successor is", async () => {
  const w = await checksWorld();
  await w.request({ headSha: sha("1") });
  await w.service.tick();
  await w.request({ headSha: sha("2") });
  await w.service.tick();
  assertEquals(await w.awaiting(), 1);
  const running = w.suites().filter((s) => s.state === "running");
  assertEquals(running.length, 1);
  w.launched.finish(w.nameOf(running[0]), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(await w.awaiting(), 0);
});

test("awaiting: a verdict is named by its request while read, then by its suite", async () => {
  const w = await checksWorld({ answerWithinMs: 5 });
  const read = w.forge.readChecksFile;
  let answer!: () => void;
  w.forge.readChecksFile = (...args) => new Promise((done) => (answer = () => done(read(...args))));
  await w.request();
  const [request] = [...w.checkStore.requests.values()];
  assertEquals(await w.owed(), [{ id: request.id, requests: [request.id] }]);
  answer();
  await w.service.idle();
  const suite = w.onlySuite();
  assertEquals(
    await w.owed(),
    [{ id: `${suite.id}@${suite.generation}`, requests: [request.id] }],
    "the request keeps its id, so a runner that gave up on it still knows it",
  );
  w.launched.finish(w.nameOf(suite), { lint: 0, test: 0 });
  await w.service.tick();
  assertEquals(await w.owed(), []);
  // A re-run is a new generation, owed again, to the same request.
  await w.service.rerun(suite.id, { kind: "user", userId: "u-1" });
  const again = w.onlySuite();
  assertEquals(again.generation, suite.generation + 1);
  assertEquals(await w.owed(), [{ id: `${suite.id}@${again.generation}`, requests: [request.id] }]);
});

test("awaiting: a tool request and a patch of one head share one name", async () => {
  const w = await checksWorld();
  await w.request();
  const patch = w.patchOf({ headSha: HEAD });
  await w.store.createPatch(patch);
  await w.service.patchOpened(patch);
  await w.service.tick();
  const ids = [...w.checkStore.requests.values()].map((r) => r.id);
  const owed = await w.owed();
  assertEquals(owed.length, 1);
  assertEquals(owed[0].id, `${w.onlySuite().id}@${w.onlySuite().generation}`);
  assertEquals([...owed[0].requests].sort(), [...ids].sort());
});
