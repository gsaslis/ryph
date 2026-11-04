// A run whose environment image is gone from the machine at launch (a prune, a daemon reset):
// the build baked on it is retired, and the run's environment is resolved again exactly as a
// start resolves it — a build already going, a new build queued, or, with the builder down, the
// same fallback a start takes. Once: a second image lost the same way errors the run. A cancel
// that landed during the launch is kept. A launch that fails for any other reason retires nothing.

import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ImageGone } from "../src/ports/image_gone.ts";
import {
  daemonLacksImage,
  ImageRefused,
  judgeImage,
  localImagePrefix,
  localOnlyImage,
  noEnvironmentImageRef,
  ownImageRef,
  refusedImageSpelling,
} from "../src/adapters/environment_builder/local_images.ts";
import { type FakeImage, imageId, storeExec } from "./image_store.ts";
import { cancelRun } from "../src/core/cancel_run.ts";
import { fakeRunnerControl } from "./doubles.ts";
import { AGENT_IMAGE, sha, tree, world } from "./environment_world.ts";

const IMAGE_1 = `registry.test/ryph-envs/repo-cr-api@sha256:${"a".repeat(64)}`;
const IMAGE_2 = `registry.test/ryph-envs/repo-cr-api@sha256:${"b".repeat(64)}`;

/** acme/api with a Dockerfile, built once on IMAGE_1; launches of any image in `gone` throw. */
async function builtOnce() {
  const w = await world();
  w.setHead("acme/api", "main", { commit: sha("a"), tree: tree("a"), dockerfile: true });
  await w.startRepo();
  const [first] = await w.builder.parked(1);
  first.succeed(IMAGE_1);
  await w.service!.idle();
  assertEquals(w.launches.length, 1, "the first run launched on the build");
  const ready = (await w.environmentStore.listEnvironmentsForSubject("repo", "cr-api"))
    .find((r) => r.status === "ready")!;
  assertEquals(ready.image, IMAGE_1);

  const gone = new Set<string>();
  const launch = w.provisioner.launch.bind(w.provisioner);
  w.provisioner.launch = (spec) => {
    if (spec.image !== null && gone.has(spec.image)) {
      return Promise.reject(new ImageGone(`${spec.image} is no longer in docker's store`));
    }
    return launch(spec);
  };
  return { w, ready, gone };
}

const runOf = async (w: Awaited<ReturnType<typeof world>>, started: unknown) =>
  (await w.store.getRun((started as { runId: string }).runId))!;

test("image gone, no build going: the resolution queues one, and the run launches on it", async () => {
  const { w, ready, gone } = await builtOnce();
  gone.add(IMAGE_1);
  // The branch moved since that build, unannounced: the new build is of the branch as it is now.
  w.setHead("acme/api", "main", { commit: sha("d"), tree: tree("a"), dockerfile: true });

  let run = await runOf(w, await w.startRepo());
  assertEquals((await w.environmentStore.getEnvironment(ready.id))!.status, "superseded");
  const [rebuild] = await w.builder.parked(1);
  assertEquals(rebuild.spec.checkouts.map((c) => c.commit), [sha("d")]);
  assertEquals(run.state, "starting");
  assertEquals(run.handle, null);
  assertEquals(run.environmentWait?.environmentId, rebuild.spec.environmentId);
  const events = await w.store.listEvents(run.id);
  assert(!events.some((e) => e.kind === "launch-failed"), "the run is not errored");
  const missing = events.find((e) => e.kind === "environment.image_missing")!;
  assertStringIncludes(missing.detail!, IMAGE_1);
  assertStringIncludes(missing.detail!, rebuild.spec.environmentId);

  rebuild.succeed(IMAGE_2);
  await w.service!.idle();
  run = (await w.store.getRun(run.id))!;
  assertEquals(run.environmentWait, null);
  assertEquals(run.image, IMAGE_2);
  assertEquals(run.environmentId, rebuild.spec.environmentId);
  assert(run.handle !== null, "launched");
  assertEquals(w.launches.at(-1)!.image, IMAGE_2);
});

test("image gone, a build already going: the run waits for that one, and no second is queued", async () => {
  const { w, ready, gone } = await builtOnce();
  gone.add(IMAGE_1);
  // The default branch moved: its build is under way while the next run starts.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.service!.refreshSubject((await w.service!.loadSubject("repo", "cr-api"))!, "push");
  const [going] = await w.builder.parked(1);
  const builds = w.builder.specs.length;

  let run = await runOf(w, await w.startRepo());
  assertEquals((await w.environmentStore.getEnvironment(ready.id))!.status, "superseded");
  assertEquals(run.environmentWait?.environmentId, going.spec.environmentId);
  assertEquals(w.builder.specs.length, builds, "no rebuild beside the build already going");
  assertEquals(w.builder.pending.length, 1);

  going.succeed(IMAGE_2);
  await w.service!.idle();
  run = (await w.store.getRun(run.id))!;
  assertEquals(run.image, IMAGE_2);
  assert(run.handle !== null, "launched");
});

test("image gone twice: the rebuilt image missing too errors the run instead of looping", async () => {
  const { w, gone } = await builtOnce();
  gone.add(IMAGE_1);
  gone.add(IMAGE_2);

  const started = await w.startRepo();
  const [rebuild] = await w.builder.parked(1);
  rebuild.succeed(IMAGE_2);
  await w.service!.idle();
  const run = await runOf(w, started);
  assertEquals(run.state, "errored");
  const events = await w.store.listEvents(run.id);
  assertEquals(events.filter((e) => e.kind === "environment.image_missing").length, 1);
  const failed = events.find((e) => e.kind === "launch-failed")!;
  assertStringIncludes(failed.detail!, IMAGE_2);
  assertStringIncludes(failed.detail!, "second image");
  const rebuilt = (await w.environmentStore.getEnvironment(rebuild.spec.environmentId))!;
  assertEquals(rebuilt.status, "superseded", "the rebuild is retired as well");
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 2, "nothing queued a third build");
});

test("image gone with the builder down: the run falls back as a start would, not an error", async () => {
  const { w, ready, gone } = await builtOnce();
  // A build of the next commit finds the registry down: the builder is known faulty.
  w.setHead("acme/api", "main", { commit: sha("b"), tree: tree("b"), dockerfile: true });
  await w.service!.refreshSubject((await w.service!.loadSubject("repo", "cr-api"))!, "push");
  const [down] = await w.builder.parked(1);
  down.fail("registry unreachable", "refused");
  await w.service!.idle();
  assertEquals(w.service!.builderFault(), "registry unreachable");
  // The branch moved on again, so that failure says nothing about the build this run would need.
  w.setHead("acme/api", "main", { commit: sha("c"), tree: tree("b"), dockerfile: true });
  gone.add(IMAGE_1);
  const builds = w.builder.specs.length;

  const run = await runOf(w, await w.startRepo());
  assertEquals((await w.environmentStore.getEnvironment(ready.id))!.status, "superseded");
  assertEquals(run.state, "starting");
  assert(run.handle !== null, "launched");
  assertEquals(run.image, AGENT_IMAGE);
  assertEquals(run.environmentId, null);
  assertEquals(run.environmentWait, null);
  assertEquals(w.builder.specs.length, builds, "nothing queued on a builder that is down");
  const events = await w.store.listEvents(run.id);
  assert(!events.some((e) => e.kind === "launch-failed"), "the run is not errored");
  assertStringIncludes(
    events.find((e) => e.kind === "environment.image_missing")!.detail!,
    "the default image",
  );
  assertStringIncludes(
    events.find((e) => e.kind === "environment.fallback")!.detail!,
    "builder is not answering",
  );
});

test("a cancel that landed while the launch was failing is kept: no wait, no relaunch", async () => {
  const { w, ready } = await builtOnce();
  const launchesBefore = w.launches.length;
  w.provisioner.launch = async (spec) => {
    // The cancel lands while docker is still answering.
    await cancelRun(
      {
        store: w.store,
        runnerControl: fakeRunnerControl().control,
        environments: w.service,
        now: w.clock.now,
      },
      (await w.store.getRun(spec.runId))!,
    );
    throw new ImageGone(`${spec.image} is no longer in docker's store`);
  };

  const run = await runOf(w, await w.startRepo());
  assertEquals(run.state, "cancelled");
  assertEquals(run.desiredState, "cancelled");
  assertEquals(run.environmentWait, null);
  assertEquals(run.handle, null);
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 1, "no build queued for a cancelled run");
  assertEquals(w.launches.length, launchesBefore, "not launched again");
  // The image is gone all the same: the build is retired on the daemon's word.
  assertEquals((await w.environmentStore.getEnvironment(ready.id))!.status, "superseded");
  const events = await w.store.listEvents(run.id);
  assert(!events.some((e) => e.kind === "environment.image_missing"));
  assertStringIncludes(events.find((e) => e.kind === "launch-failed")!.detail!, "cancelled");
});

test("a launch that fails for another reason errors the run and retires nothing", async () => {
  const { w, ready } = await builtOnce();
  w.provisioner.launch = () => Promise.reject(new Error("docker run failed: no space left"));

  const run = await runOf(w, await w.startRepo());
  assertEquals(run.state, "errored");
  assertEquals((await w.environmentStore.getEnvironment(ready.id))!.status, "ready");
  await w.service!.idle();
  assertEquals(w.builder.specs.length, 1, "no rebuild");
  const events = await w.store.listEvents(run.id);
  assert(!events.some((e) => e.kind === "environment.image_missing"));
  assertStringIncludes(events.find((e) => e.kind === "launch-failed")!.detail!, "no space left");
});

test("docker's word that an image is gone: a local environment image, named as missing", () => {
  const id = `sha256:${"9".repeat(64)}`;
  assert(localOnlyImage(id), "an image id is in one store only");
  assert(localOnlyImage("ryph-env/repo-cr-api:baked-env-1"));
  assert(
    localOnlyImage(`${localImagePrefix("ryph")}repo-cr-api:baked-env-1`),
    "a deployment's tag",
  );
  assert(!localOnlyImage("quay.io/ryph/ryph-agent:latest"));
  const err = new Error(
    `docker run failed: docker: Error response from daemon: No such image: ${id}`,
  );
  assert(daemonLacksImage(err, id));
  assert(!daemonLacksImage(err, `sha256:${"8".repeat(64)}`), "another image's absence");
  assert(!daemonLacksImage(new Error(`docker run failed: ${id}: no space left`), id));
});

test("whose an image is: judged on the image docker resolves, never on the spelling", async () => {
  const mine = localImagePrefix("mine");
  const theirs = `${localImagePrefix("theirs")}repo:env-1`;
  const foreign: FakeImage = { id: imageId("f"), names: [theirs] };
  const untagged: FakeImage = { id: imageId("9"), names: [] };
  const own: FakeImage = { id: imageId("7"), names: [`${mine}repo:env-1`] };
  const pulled: FakeImage = { id: imageId("4"), names: ["postgres:16"] };
  const docker = storeExec([foreign, untagged, own, pulled]);
  const hex = foreign.id.slice("sha256:".length);

  // Refused before docker is asked: each would resolve to a local image (measured, Docker 29.8).
  for (
    const image of [
      hex.slice(0, 4),
      hex,
      `sha256:${hex.slice(0, 6)}`,
      `docker.io/${theirs}`,
      `index.docker.io/${theirs}`,
      `docker.io/library/${theirs}`,
    ]
  ) {
    assert(refusedImageSpelling(image) !== null, image);
    const never = () => Promise.reject(new Error("asked"));
    const err = await judgeImage(image, mine, never).catch((e) => e);
    assert(err instanceof ImageRefused, `${image}: ${String(err)}`);
  }
  for (const image of ["postgres:16", foreign.id, "ryph-env/x/y:z", "cafe/latte:1", "abc"]) {
    assertEquals(refusedImageSpelling(image), null, image);
  }

  // Another deployment's, by every spelling that is not refused, or an untagged one: no ref.
  for (const image of [theirs, foreign.id, `${theirs.split(":")[0]}@${foreign.id}`, untagged.id]) {
    assertEquals(await ownImageRef(image, mine, docker), null, image);
  }
  // Absent and spelled local-only: no ref either, the same answer.
  assertEquals(await ownImageRef(`${mine}gone:env-1`, mine, docker), null);
  assertEquals(await ownImageRef(imageId("3"), mine, docker), null);
  // Its own and a pulled image: the id; a registry image the store lacks: its name.
  assertEquals(await ownImageRef(own.names[0]!, mine, docker), own.id);
  assertEquals(await ownImageRef(own.id, mine, docker), own.id);
  assertEquals(await ownImageRef("docker.io/library/postgres:16", mine, docker), pulled.id);
  assertEquals(await ownImageRef("quay.io/x/y:1", mine, docker), "quay.io/x/y:1");

  // Where no environment image belongs, its own is refused too.
  for (const image of [own.names[0]!, own.id, theirs, untagged.id, `${mine}gone:env-1`]) {
    const err = await noEnvironmentImageRef(image, docker).catch((e) => e);
    assert(err instanceof ImageRefused, `${image}: ${String(err)}`);
  }
  assertEquals(await noEnvironmentImageRef("postgres:16", docker), pulled.id);
  assertEquals(await noEnvironmentImageRef("quay.io/x/y:1", docker), "quay.io/x/y:1");

  // A daemon that cannot say decides nothing: thrown, so no launch goes ahead on it.
  const down = () => Promise.reject(new Error("Cannot connect to the Docker daemon"));
  const err = await ownImageRef(own.id, mine, down).catch((e) => e);
  assert(err instanceof Error && !(err instanceof ImageRefused));
  // An answer that does not read as docker's is not taken for one.
  const garbled = await ownImageRef(own.id, mine, () => Promise.resolve("[]")).catch((e) => e);
  assert(garbled instanceof Error);
});
