// The image prefetch over a fake docker CLI: what it pulls, in what order, and what it reports.

import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { dockerImagePrefetch, fromRegistry } from "../src/adapters/image_prefetch/docker.ts";
import type { DockerExec } from "../src/adapters/check_launcher/docker.ts";
import { silentDiagnostics } from "./doubles.ts";

const AGENT = "quay.io/ryph/ryph-agent:sha-0123456789ab";
const GATE = "quay.io/ryph/ryph-run-gate:sha-0123456789ab";

/** A docker whose store holds `stored`, whose pulls of `broken` fail, and which logs every call. */
function fakeDocker(stored: string[], broken: string[] = []) {
  const store = new Set(stored);
  const calls: string[] = [];
  const exec: DockerExec = (args) => {
    calls.push(args.join(" "));
    const image = args.at(-1)!;
    if (args[0] === "image") {
      return store.has(image)
        ? Promise.resolve("sha256:abc")
        : Promise.reject(new Error(`docker image failed: Error: No such image: ${image}`));
    }
    if (broken.includes(image)) {
      return Promise.reject(new Error("docker pull failed: manifest unknown\nmore detail"));
    }
    store.add(image);
    return Promise.resolve("");
  };
  return { exec, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("pulls what is missing, one at a time, and leaves what is there", async () => {
  const { exec, calls } = fakeDocker([GATE]);
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: AGENT }, { name: "run-gate", image: GATE }],
    silentDiagnostics(),
    exec,
  );
  assertEquals((await prefetch.status()).map((i) => i.state), ["queued", "queued"]);
  prefetch.start();
  await settle();
  assertEquals((await prefetch.status()).map((i) => i.state), ["present", "present"]);
  assertEquals(calls.filter((c) => c.startsWith("pull")), [`pull --quiet ${AGENT}`]);
});

test("a failed pull says why in a line, and a second start tries it again", async () => {
  const { exec } = fakeDocker([], [AGENT]);
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: AGENT }],
    silentDiagnostics(),
    exec,
  );
  prefetch.start();
  await settle();
  assertEquals((await prefetch.status())[0], {
    name: "agent",
    image: AGENT,
    state: "failed",
    error: "manifest unknown",
  });
  prefetch.start();
  assertEquals((await prefetch.status())[0]!.state, "queued");
});

test("a local tag is never pulled", async () => {
  const { exec, calls } = fakeDocker([]);
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: "ryph-agent:dev" }],
    silentDiagnostics(),
    exec,
  );
  prefetch.start();
  await settle();
  assertEquals((await prefetch.status())[0]!.state, "failed");
  assertEquals(calls.some((c) => c.startsWith("pull")), false);
});

test("fromRegistry tells a registry ref from a bare local tag", () => {
  assertEquals(fromRegistry(AGENT), true);
  assertEquals(fromRegistry("localhost:5000/ryph-agent:dev"), true);
  assertEquals(fromRegistry("ryph-agent:dev"), false);
  assertEquals(fromRegistry("myorg/ryph-agent:1"), true);
});

test("a start during a pass retries what already failed in it", async () => {
  let releaseGate!: () => void;
  const gateHeld = new Promise<void>((resolve) => (releaseGate = resolve));
  let agentPulls = 0;
  const exec: DockerExec = (args) => {
    const image = args.at(-1)!;
    if (args[0] === "image") {
      return Promise.reject(new Error(`docker image failed: Error: No such image: ${image}`));
    }
    if (image === AGENT) {
      agentPulls++;
      return agentPulls === 1
        ? Promise.reject(new Error("docker pull failed: timeout"))
        : Promise.resolve("");
    }
    return gateHeld.then(() => "");
  };
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: AGENT }, { name: "run-gate", image: GATE }],
    silentDiagnostics(),
    exec,
  );
  prefetch.start();
  await settle();
  assertEquals((await prefetch.status()).map((i) => i.state), ["failed", "pulling"]);
  prefetch.start();
  assertEquals((await prefetch.status()).map((i) => i.state), ["queued", "pulling"]);
  releaseGate();
  await settle();
  await settle();
  assertEquals((await prefetch.status()).map((i) => i.state), ["present", "present"]);
  assertEquals(agentPulls, 2);
});

test("a start just as a pass ends is still acted on, and a ready image stays ready", async () => {
  const { exec, calls } = fakeDocker([AGENT]);
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: AGENT }],
    silentDiagnostics(),
    exec,
  );
  prefetch.start();
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    prefetch.start();
    assertEquals((await prefetch.status())[0]!.state === "failed", false);
  }
  await settle();
  assertEquals((await prefetch.status())[0]!.state, "present");
  const inspects = calls.filter((c) => c.startsWith("image")).length;
  prefetch.start();
  assertEquals((await prefetch.status())[0]!.state, "present");
  await settle();
  assertEquals(calls.filter((c) => c.startsWith("image")).length, inspects + 1);
});

test("a second look in the same pass clears the first look's error", async () => {
  let inspects = 0;
  let releaseInspect!: () => void;
  const inspectHeld = new Promise<void>((resolve) => (releaseInspect = resolve));
  const exec: DockerExec = (args) => {
    if (args[0] !== "image") return Promise.resolve("");
    inspects++;
    if (inspects === 1) {
      return inspectHeld.then(() =>
        Promise.reject(new Error("docker image failed: Cannot connect"))
      );
    }
    return Promise.resolve("sha256:abc");
  };
  const prefetch = dockerImagePrefetch(
    [{ name: "agent", image: AGENT }],
    silentDiagnostics(),
    exec,
  );
  prefetch.start();
  prefetch.start();
  releaseInspect();
  await settle();
  assertEquals((await prefetch.status())[0], {
    name: "agent",
    image: AGENT,
    state: "present",
    error: null,
  });
});
