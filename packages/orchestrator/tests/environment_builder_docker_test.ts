// The docker environment builder: the commands it runs, in order, and what it makes of their
// answers. The command runner is a fake that records every argv and plays the daemon's part —
// writing the image id file and the toolchain record where the real `docker buildx` would.

import { test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  bakedTag,
  buildArgvs,
  type CommandResult,
  type CommandRunner,
  confinedBuilderArgs,
  confinedBuilderName,
  confinedProxyEnv,
  currentCacheVersion,
  dockerEnvironmentBuilder,
  environmentTag,
  gateAddress,
  layoutRef,
  machineTag,
  promoteCache,
  proxyOffGate,
  redactedCommand,
  scopeDir,
  seedCacheVersion,
  trimCacheVersion,
  workdirs,
} from "../src/adapters/environment_builder/docker.ts";
import {
  createEnvironmentBuilder,
  everyBuildRefused,
} from "../src/adapters/environment_builder/mod.ts";
import { confinedNetworkFlags } from "../src/adapters/provisioner/docker.ts";
import { DEFAULT_ENVIRONMENTS_CONFIG } from "../src/core/environment_config.ts";
import type { BuildResult } from "../src/ports/environment_builder.ts";
import {
  BUILD_COMMIT as COMMIT,
  buildSpec,
  recordingDiagnostics,
  silentDiagnostics,
} from "./doubles.ts";
import {
  localImagePrefix,
  STORED_IMAGE_FORMAT,
} from "../src/adapters/environment_builder/local_images.ts";
import { type FakeImage, imageId, inspectAnswer } from "./image_store.ts";
import type { BuildSpec } from "../src/ports/environment_builder.ts";

/** The repository path of the deployment the tests run as (no network set). */
const LOCAL = localImagePrefix("default");

const IMAGE_ID = "sha256:" + "c".repeat(64);
/** The machine's local image id, as `docker image inspect -f {{.Id}}` reports it. */
const MACHINE_ID = "sha256:" + "d".repeat(64);
/** What an exported input image's OCI layout names, and what a confined machine's does. */
const LAYOUT_DIGEST = "sha256:" + "1".repeat(64);
const MACHINE_LAYOUT_DIGEST = "sha256:" + "2".repeat(64);
/** The run gate's address on the run network. */
const GATE_ADDRESS = "172.22.0.1";

/** The spec's base and harness images (`buildSpec`), as the store holds them. */
const BASE_IMAGE = "registry.example/ryph-universal@sha256:" + "a".repeat(64);
const BASE: FakeImage = { id: imageId("a"), names: ["registry.example/ryph-universal:1"] };
const HARNESS: FakeImage = { id: imageId("b"), names: ["registry.example/ryph-harness:1"] };

const layoutIndex = (digest: string) =>
  JSON.stringify({ schemaVersion: 2, manifests: [{ digest, size: 1 }] });

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/**
 * A daemon that builds whatever it is asked to. `override` answers a call first when it returns
 * something — the way a test makes one step fail or hang.
 */
function fakeDocker(
  opts: {
    containerd?: boolean;
    baseLocal?: boolean;
    /** What an incremental build reads out of the image it would start from. */
    recorded?: string;
    /** Write each `--cache-to` export to disk, as BuildKit's local exporter does. */
    exportCaches?: boolean;
    /** The setup warnings ryph-bake wrote beside the toolchain record; absent, no file (an image
     * baked before it existed). */
    setupWarnings?: string;
    override?: (call: Call, signal: AbortSignal) => Promise<CommandResult> | undefined;
    /** The store's images beyond the base and the harness; every tag under `LOCAL` not listed is
     * one of this deployment's, there. */
    images?: FakeImage[];
  } = {},
) {
  const calls: Call[] = [];
  /** The ownership judgement's reads (`STORED_IMAGE_FORMAT`), kept apart from the build's calls. */
  const judged: string[] = [];
  let baseLocal = opts.baseLocal !== false;
  const run: CommandRunner = async (cmd, args, { cwd, env, signal }) => {
    const call = { cmd, args, cwd, env };
    if (args.includes(STORED_IMAGE_FORMAT)) judged.push(args.at(-1)!);
    else calls.push(call);
    const overridden = opts.override?.(call, signal);
    if (overridden) return await overridden;
    if (cmd === "docker" && args[0] === "pull" && args.includes(BASE_IMAGE)) baseLocal = true;
    const ref = args.at(-1) ?? "";
    const answer = inspectAnswer([
      ...(opts.images ?? []),
      ...(baseLocal ? [BASE] : []),
      HARNESS,
      ...(ref.startsWith(LOCAL) ? [{ id: imageId("e"), names: [ref] }] : []),
    ], args);
    if (cmd === "docker" && answer !== undefined) {
      return answer instanceof Error ? { code: 1, stdout: "", stderr: answer.message } : ok(answer);
    }
    if (cmd === "docker" && args[0] === "info") {
      return ok(
        opts.containerd
          ? '[["driver-type","io.containerd.snapshotter.v1"]]'
          : '[["Backing Filesystem","extfs"]]',
      );
    }
    if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
      if (args.includes("{{.Id}}")) return ok(`${MACHINE_ID}\n`);
      if (args.includes("-f")) return ok("123456\n");
      return opts.baseLocal === false ? { code: 1, stdout: "", stderr: "No such image" } : ok("[]");
    }
    // A confined build's network, found by its labels (one left over, or the build's own).
    if (cmd === "docker" && args[0] === "network" && args[1] === "ls") return ok("net-1\n");
    if (cmd === "docker" && args[0] === "inspect") {
      return ok(JSON.stringify({
        bridge: { IPAddress: "172.17.0.3" },
        // The gate has an address on the run network too; a confined build dials the other.
        "ryph-runs": { IPAddress: "172.22.0.50" },
        [BUILDER]: { IPAddress: GATE_ADDRESS },
      }));
    }
    // A confined build's image export: `docker image save … | tar -x -C <dir>`.
    if (cmd === "bash" && args[1]?.includes("docker image save")) {
      await writeFile(`${args[4]}/index.json`, layoutIndex(LAYOUT_DIGEST));
      return ok();
    }
    if (cmd === "docker" && args[0] === "buildx" && args[1] === "build") {
      const cacheTo = args.indexOf("--cache-to");
      if (cacheTo !== -1 && opts.exportCaches) {
        const dest = args[cacheTo + 1].replace(/^type=local,dest=/, "").replace(/,mode=max$/, "");
        await mkdir(`${dest}/blobs`, { recursive: true });
        await writeFile(`${dest}/index.json`, args[args.indexOf("--target") + 1] ?? "");
      }
      const iid = args.indexOf("--iidfile");
      if (iid !== -1) await writeFile(args[iid + 1], `${IMAGE_ID}\n`);
      const out = args.indexOf("--output");
      if (out !== -1 && args[out + 1].startsWith("type=oci,")) {
        const dest = args[out + 1].replace(/^type=oci,dest=/, "").replace(/,tar=false$/, "");
        await mkdir(dest, { recursive: true });
        await writeFile(`${dest}/index.json`, layoutIndex(MACHINE_LAYOUT_DIGEST));
      } else if (out !== -1) {
        const dest = args[out + 1].replace(/^type=local,dest=/, "");
        await mkdir(dest, { recursive: true });
        if (dest.endsWith("/record")) {
          if (opts.recorded !== undefined) {
            await writeFile(`${dest}/machine`, opts.recorded);
          }
        } else {
          await writeFile(`${dest}/toolchains.json`, '{"rustc":"1.97.1"}');
          if (opts.setupWarnings !== undefined) {
            await writeFile(`${dest}/setup-warnings.json`, opts.setupWarnings);
          }
        }
      }
      return { code: 0, stdout: "", stderr: "#1 DONE 0.1s\n" };
    }
    return ok();
  };
  return { run, calls, judged };
}

const never = () => new AbortController().signal;

const entries = async (dir: string) => (await readdir(dir)).sort();

/** The calls as `cmd verb…` heads, which is the order a reader cares about. */
const heads = (calls: Call[]) =>
  calls.map((c) => [c.cmd, ...c.args.slice(0, c.cmd === "bash" ? 1 : 2)].join(" "));

function expectOk(result: BuildResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.kind}: ${result.message}`);
  return result;
}
function expectFailure(result: BuildResult) {
  if (result.ok) throw new Error("expected a failure");
  return result;
}

test("a setup.yml that did not finish is read off the toolchains target as a warning, not a failure", async () => {
  const { run } = fakeDocker({
    setupWarnings: JSON.stringify([{
      kind: "step",
      path: "heartwood",
      step: "npm ci",
      index: 1,
      total: 2,
      code: 1,
      output: "\u001b[31mnope\u001b[0m",
      discarded: false,
    }]),
  });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const result = expectOk(await builder.build(buildSpec(), { signal: never() }));
  assertEquals(result.setupWarnings, [{
    kind: "step",
    path: "heartwood",
    step: "npm ci",
    index: 1,
    total: 2,
    code: 1,
    output: "nope",
    discarded: false,
  }]);
});

test("a repo Dockerfile builds the machine, the environment, its baked stage, then reads toolchains", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const spec = buildSpec({ clone: { urls: { heartwood: "http://f/h.git" }, env: { TOK: "t0k" } } });
  const result = expectOk(await builder.build(spec, { signal: never() }));

  assertEquals(heads(calls), [
    "bash -c",
    "docker image inspect",
    // By the id the base resolved to, judged right before: these names every build reads.
    `docker tag ${BASE.id}`,
    `docker tag ${BASE.id}`,
    "docker buildx build",
    "docker image inspect",
    "docker buildx build",
    "docker buildx build",
    "docker buildx build",
    "docker image inspect",
    "docker image rm",
  ]);
  // The clone: the script, in the checkout directory, with git's credential as env only.
  assertEquals(calls[0].args.slice(2), ["clone", "heartwood", "http://f/h.git", "main", COMMIT]);
  assert(!calls[0].args[1].includes("http://f/h.git"), "a value is never script text");
  assertEquals(calls[0].env?.TOK, "t0k");
  assert(calls[0].cwd?.endsWith("/checkout"));
  // The universal image's public names point at the pinned copy.
  assertEquals(calls[2].args[2], "quay.io/ryph/ryph-universal:latest");
  assertEquals(calls[3].args[2], "quay.io/ryph/ryph-universal:1");
  // The machine: the repo's own Dockerfile, the repo as its context.
  const machine = calls[4].args;
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  assert(at(machine, "-f").endsWith("/checkout/heartwood/.ryph/Dockerfile"));
  assert(machine.at(-1)!.endsWith("/checkout/heartwood"));
  assertEquals(at(machine, "--tag"), machineTag(spec));
  assert(!machine.includes("SOURCE_DATE_EPOCH=0"), "the repo's own steps keep their clock");
  // The environment, on that machine, with the clones as `checkout` and the machine recorded.
  const env = calls[6].args;
  assert(env.includes(`RYPH_MACHINE_DIGEST=${MACHINE_ID}`));
  assertEquals(at(env, "--target"), "environment");
  assert(env.includes(`RYPH_MACHINE=${machineTag(spec)}`));
  assert(env.includes(`RYPH_HARNESS=${spec.harnessImage}`));
  assert(at(env, "--build-context").startsWith("checkout="));
  assertEquals(at(env, "--tag"), environmentTag(spec));
  // The same file's lower half, tagged for a later re-layer to build FROM.
  const baked = calls[7].args;
  assertEquals(at(baked, "--target"), "baked");
  assertEquals(at(baked, "--tag"), bakedTag(spec));
  // The machine's tag goes; the environment's stays, so prune leaves it alone.
  assertEquals(calls.at(-1)!.args, ["image", "rm", machineTag(spec)]);

  assertEquals(result.image, IMAGE_ID);
  assertEquals(result.bakedImage, bakedTag(spec));
  assertEquals(result.sizeBytes, 123456);
  assertEquals(result.toolchains, { rustc: "1.97.1" });
  // No warnings file beside the record is no warnings.
  assertEquals(result.setupWarnings, []);
  assertStringIncludes(result.log, "ryph: built " + IMAGE_ID);
  // The work dir is gone.
  const root = calls[0].cwd!.replace(/\/checkout$/, "");
  assertEquals(await stat(root).then(() => true, () => false), false);
});

test("a build works under its temp root, made if missing, and leaves nothing there", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ryph-temp-root-"));
  try {
    const tempRoot = join(parent, "not", "yet");
    const { run, calls } = fakeDocker();
    const builder = dockerEnvironmentBuilder({ cacheDir: null, tempRoot }, silentDiagnostics(), {
      run,
    });
    expectOk(await builder.build(buildSpec({ dockerfileFrom: null }), { signal: never() }));
    assert(calls[0].cwd?.startsWith(`${tempRoot}/ryph-env-`));
    assertEquals(await readdir(tempRoot), []);
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("RYPH_ENV_TEMP_DIR names the docker builder's temp root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ryph-temp-root-"));
  try {
    const { run, calls } = fakeDocker();
    const builder = createEnvironmentBuilder(
      { ...DEFAULT_ENVIRONMENTS_CONFIG, enabled: true, builder: "docker" },
      { env: (name) => name === "RYPH_ENV_TEMP_DIR" ? parent : undefined, run, soleTenant: true },
    );
    expectOk(await builder.build(buildSpec({ dockerfileFrom: null }), { signal: never() }));
    assert(calls[0].cwd?.startsWith(`${parent}/ryph-env-`));
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("a repo with no Dockerfile builds straight on the universal image", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const spec = buildSpec({ dockerfileFrom: null });
  expectOk(await builder.build(spec, { signal: never() }));
  assertEquals(heads(calls), [
    "bash -c",
    "docker buildx build",
    "docker buildx build",
    "docker buildx build",
    "docker image inspect",
  ]);
  assert(calls[1].args.includes(`RYPH_MACHINE=${spec.baseImage}`));
  // The base IS the machine, named by its pinned digest as every builder names it.
  assert(calls[1].args.includes(`RYPH_MACHINE_DIGEST=sha256:${"a".repeat(64)}`));
});

test("a re-layer clones nothing and builds stage 4 on the baked image it names", async () => {
  const { run, calls, judged } = fakeDocker({ containerd: true });
  const builder = dockerEnvironmentBuilder({ cacheDir: "/cache" }, silentDiagnostics(), { run });
  const from = `${LOCAL}repo-abc:baked-env-0`;
  const spec = buildSpec({ relayerFrom: from, clone: { urls: {}, env: {} } });
  const result = expectOk(await builder.build(spec, { signal: never() }));
  // Judged on what docker resolves, before anything is built.
  assert(judged.includes(from), judged.join("\n"));
  assertEquals(heads(calls), [
    "docker buildx build",
    "docker buildx build",
    "docker image inspect",
  ]);
  // The baked image is looked for in the store (judged), and never pulled.
  assert(!calls.some((c) => c.args[0] === "pull"));
  const env = calls[0].args;
  assert(env.includes(`RYPH_BAKED=${from}`));
  assert(!env.some((a) => a.startsWith("RYPH_MACHINE=") || a.startsWith("checkout=")));
  assert(!calls.some((c) => c.args.includes("--cache-from") || c.args.includes("--cache-to")));
  assertEquals(result.bakedImage, from);
});

test("a warm build on the same machine builds the warm file on its image, uncached", async () => {
  const { run, calls } = fakeDocker({ containerd: true, recorded: `${MACHINE_ID}\n` });
  const builder = dockerEnvironmentBuilder({ cacheDir: "/cache" }, silentDiagnostics(), { run });
  const from = `${LOCAL}repo-abc:baked-env-0`;
  const result = expectOk(await builder.build(buildSpec({ warmFrom: from }), { signal: never() }));
  const builds = calls.filter((c) => c.args[0] === "buildx").map((c) => c.args);
  const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  // The machine from the cache, the record read out of the image, then the three warm passes.
  assert(at(builds[0], "-f").endsWith("/.ryph/Dockerfile"));
  assert(builds[0].includes("--cache-to"), "the machine is what the cache makes the same");
  assertEquals(at(builds[1], "--target"), "machine-record");
  assert(builds[1].includes(`RYPH_WARM=${from}`));
  for (const pass of builds.slice(2)) {
    assert(at(pass, "-f").endsWith("/Dockerfile.warm"));
    assert(pass.includes(`RYPH_WARM=${from}`));
    assert(!pass.some((a) => a.startsWith("RYPH_MACHINE=")));
    assert(!pass.includes("--cache-from") && !pass.includes("--cache-to"));
  }
  assert(
    builds[2].some((a) => a.startsWith("checkout=")),
    "the fresh clone is the checkout context",
  );
  assertEquals(result.warm, true);
  assert(result.bakedImage !== from, "a warm build has a baked stage of its own");
});

test("a warm build whose machine changed, or whose image recorded none, builds cold", async () => {
  for (const recorded of [`sha256:${"e".repeat(64)}\n`, undefined]) {
    const { run, calls } = fakeDocker({ containerd: true, recorded });
    const builder = dockerEnvironmentBuilder({ cacheDir: "/cache" }, silentDiagnostics(), { run });
    const from = `${LOCAL}repo-abc:baked-env-0`;
    const result = expectOk(
      await builder.build(buildSpec({ warmFrom: from }), { signal: never() }),
    );
    const env = calls.filter((c) => c.args[0] === "buildx").map((c) => c.args)[2];
    assert(env.includes(`RYPH_MACHINE=${machineTag(buildSpec())}`));
    assert(env.includes(`RYPH_MACHINE_DIGEST=${MACHINE_ID}`));
    assert(!env.some((a) => a.startsWith("RYPH_WARM=")));
    assert(env.includes("--cache-to"), "a cold build uses the cache as any cold build does");
    assertEquals(result.warm, false);
    // A different record is a changed machine; no record is an image that could not be read.
    assertStringIncludes(
      result.log,
      recorded === undefined ? "could not be read" : "the machine changed",
    );
  }
});

test("a base image not in the local store is pulled before it is tagged", async () => {
  const { run, calls } = fakeDocker({ baseLocal: false });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  expectOk(await builder.build(buildSpec(), { signal: never() }));
  assertEquals(heads(calls).slice(1, 3), [
    "docker image inspect",
    "docker pull registry.example/ryph-universal@sha256:" + "a".repeat(64),
  ]);
});

test("the proxy reaches every build as predefined arguments, and never the log", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const proxy = "http://env-1:claim-token@egress:7460";
  const result = expectOk(
    await builder.build(
      buildSpec({ proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: "forge", RYPH_OTHER: "x" } }),
      { signal: never() },
    ),
  );
  for (const call of calls.filter((c) => c.args[0] === "buildx")) {
    assert(call.args.includes(`HTTPS_PROXY=${proxy}`));
    assert(call.args.includes("NO_PROXY=forge"));
    assert(!call.args.some((a) => a.includes("RYPH_OTHER")));
  }
  assert(!result.log.includes("claim-token"));
  assertStringIncludes(result.log, "HTTPS_PROXY=***");
  assertEquals(
    redactedCommand("docker", [
      "--build-arg",
      "HTTPS_PROXY=secret",
      "--build-arg",
      "RYPH_MACHINE=m",
    ]),
    "$ docker --build-arg HTTPS_PROXY=*** --build-arg RYPH_MACHINE=m",
  );
});

test("scoped caches: read every read scope, write only the write scope, or none", () => {
  const flags = (args: string[], flag: string) =>
    args.flatMap((a, i) => args[i - 1] === flag ? [a] : []);
  // Each read scope's current version, as the build resolved it before its first pass.
  const read = new Map([
    ["repo-abc/machine", "/cache/repo-abc/machine/v-env-0"],
    ["repo-abc/environment", "/cache/repo-abc/environment/v-env-0"],
  ]);
  const main = buildArgvs(
    buildSpec({ cacheScope: { read: ["repo-abc", "repo-none"], write: "repo-abc" } }),
    workdirs("/w"),
    { dir: "/cache", read },
    "linux/amd64",
  );
  // A scope with no version yet is not read.
  assertEquals(flags(main.machine!, "--cache-from"), [
    "type=local,src=/cache/repo-abc/machine/v-env-0",
  ]);
  // Written to a version of this build's own, which it makes current once the export is whole.
  assertEquals(flags(main.machine!, "--cache-to"), [
    "type=local,dest=/cache/repo-abc/machine/v-env-1,mode=max",
  ]);
  assertEquals(flags(main.environment, "--cache-to"), [
    "type=local,dest=/cache/repo-abc/environment/v-env-1,mode=max",
  ]);
  // The baked stage and the toolchain read are all hits, and must not race that export.
  assertEquals(flags(main.baked!, "--cache-to"), []);
  assertEquals(flags(main.toolchains, "--cache-to"), []);
  assertEquals(flags(main.environment, "--platform"), ["linux/amd64"]);

  // A branch reads the shared scope and writes nothing.
  const branch = buildArgvs(
    buildSpec({ defaultBranch: false, cacheScope: { read: ["repo-abc"], write: null } }),
    workdirs("/w"),
    { dir: "/cache", read },
  );
  assertEquals(flags(branch.environment, "--cache-from"), [
    "type=local,src=/cache/repo-abc/environment/v-env-0",
  ]);
  assert(!Object.values(branch).flat().includes("--cache-to"));
});

test("cache dirs only where the daemon can export a cache, said once otherwise", async () => {
  const containerd = fakeDocker({ containerd: true });
  await dockerEnvironmentBuilder({ cacheDir: "/cache" }, silentDiagnostics(), {
    run: containerd.run,
  }).build(buildSpec({ dockerfileFrom: null }), { signal: never() });
  assert(containerd.calls.some((c) => c.args.includes("--cache-to")));

  const classic = fakeDocker();
  const { diag, events } = recordingDiagnostics();
  const builder = dockerEnvironmentBuilder({ cacheDir: "/cache" }, diag, { run: classic.run });
  await builder.build(buildSpec({ dockerfileFrom: null }), { signal: never() });
  await builder.build(buildSpec({ dockerfileFrom: null }), { signal: never() });
  assert(!classic.calls.some((c) => c.args.includes("--cache-to")));
  assertEquals(
    events.filter((e) => e.event === "environment_builder.docker.shared_cache").length,
    1,
  );
  // Asked once, remembered.
  assertEquals(classic.calls.filter((c) => c.args[0] === "info").length, 1);
});

test("a cache export becomes its stage's current version, read by the next build", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { run, calls } = fakeDocker({ containerd: true, exportCaches: true });
    const builder = dockerEnvironmentBuilder({ cacheDir }, silentDiagnostics(), { run });
    expectOk(await builder.build(buildSpec({ environmentId: "env-1" }), { signal: never() }));
    for (const stage of ["machine", "environment"]) {
      const dir = scopeDir(cacheDir, "repo-abc-default", stage);
      assertEquals(await currentCacheVersion(dir), `${dir}/v-env-1`);
    }

    calls.length = 0;
    expectOk(await builder.build(buildSpec({ environmentId: "env-2" }), { signal: never() }));
    const machine = calls.find((c) => c.args.includes("--cache-to"))!.args;
    assertStringIncludes(machine.join(" "), `src=${cacheDir}/repo-abc-default/machine/v-env-1`);
    const dir = scopeDir(cacheDir, "repo-abc-default", "machine");
    assertEquals(await currentCacheVersion(dir), `${dir}/v-env-2`);
    // The version it replaced stays for builds still reading it, marked as retired.
    assertEquals(await entries(dir), ["current", "v-env-1", "v-env-1.retired", "v-env-2"]);
  } finally {
    await rm(cacheDir, { recursive: true });
  }
});

test("a version starts as links to the current one, and keeps only what its index reaches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const hex = (c: string) => c.repeat(64);
    const blobs = (v: string) => `${dir}/${v}/blobs/sha256`;
    await mkdir(blobs("v-old"), { recursive: true });
    await writeFile(`${dir}/current`, "v-old");
    // A manifest naming a config, which names a layer; and a layer nothing names any more.
    await writeFile(`${blobs("v-old")}/${hex("a")}`, `{"config":"sha256:${hex("b")}"}`);
    await writeFile(
      `${blobs("v-old")}/${hex("b")}`,
      `{"layers":[{"blob":"sha256:${hex("c")}"}]}`,
    );
    await writeFile(`${blobs("v-old")}/${hex("c")}`, "layer");
    await writeFile(`${blobs("v-old")}/${hex("d")}`, "stale layer");

    await seedCacheVersion(dir, `${dir}/v-new`);
    assertEquals(await entries(blobs("v-new")), [hex("a"), hex("b"), hex("c"), hex("d")]);
    assertEquals((await stat(`${blobs("v-new")}/${hex("c")}`)).nlink, 2, "a link, not a copy");

    // The export: an index naming the manifest.
    await writeFile(
      `${dir}/v-new/index.json`,
      `{"manifests":[{"digest":"sha256:${hex("a")}"}]}`,
    );
    await promoteCache(dir, `${dir}/v-new`, 30 * 60 * 1000);
    assertEquals(await entries(blobs("v-new")), [hex("a"), hex("b"), hex("c")]);
    assertEquals(await currentCacheVersion(dir), `${dir}/v-new`);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the trim follows what the index names however large, so a big cache keeps its layers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const hex = (c: string) => c.repeat(64);
    const blobs = `${dir}/v/blobs/sha256`;
    await mkdir(blobs, { recursive: true });
    // A manifest list past the size a layer is told apart by, naming one layer.
    await writeFile(
      `${blobs}/${hex("a")}`,
      `{"manifests":[{"digest":"sha256:${hex("b")}"}],"pad":"${" ".repeat(2 * 1024 * 1024)}"}`,
    );
    await writeFile(`${blobs}/${hex("b")}`, "layer");
    await writeFile(
      `${dir}/v/index.json`,
      `{"manifests":[{"digest":"sha256:${hex("a")}"}]}`,
    );
    await trimCacheVersion(`${dir}/v`);
    assertEquals(await entries(blobs), [hex("a"), hex("b")]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a retired cache version goes once no build can still be reading it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const old = Date.now() / 1000 - 3600;
    for (const name of ["v-a", "v-b", "v-c", "v-crashed", "blobs"]) {
      await mkdir(`${dir}/${name}`);
    }
    await writeFile(`${dir}/index.json`, "{}");
    await mkdir(`${dir}/v-c/blobs/sha256`, { recursive: true });
    await writeFile(`${dir}/v-c/index.json`, "{}");
    await writeFile(`${dir}/v-gone.retired`, "");
    await writeFile(`${dir}/v-a.retired`, "");
    await writeFile(`${dir}/v-b.retired`, "");
    await utimes(`${dir}/v-a.retired`, old, old);
    await utimes(`${dir}/v-crashed`, old, old);
    await promoteCache(dir, `${dir}/v-c`, 30 * 60 * 1000);
    // v-a retired an hour ago and v-crashed was created then: gone. v-b retired just now: a
    // build may still read it. The layout before versions, and a marker of no version: gone.
    assertEquals(await entries(dir), ["current", "v-b", "v-b.retired", "v-c"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a version two promotions displaced at once still waits out the grace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const old = Date.now() / 1000 - 3600;
    for (const name of ["v-a", "v-b", "v-c"]) {
      await mkdir(`${dir}/${name}/blobs/sha256`, { recursive: true });
      await writeFile(`${dir}/${name}/index.json`, "{}");
      await utimes(`${dir}/${name}`, old, old);
    }
    // v-b's promotion read v-a as current and marked it; v-c's read v-a too, before v-b's rename
    // landed, so v-b went from current to displaced with nobody marking it.
    await writeFile(`${dir}/v-a.retired`, "");
    await writeFile(`${dir}/current`, "v-b");
    await promoteCache(dir, `${dir}/v-c`, 30 * 60 * 1000);
    assertEquals(await entries(dir), [
      "current",
      "v-a",
      "v-a.retired",
      "v-b",
      "v-b.retired",
      "v-c",
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a failed build keeps the stage's current version, drops its own export and untags", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const dir = scopeDir(cacheDir, "repo-abc-default", "environment");
    await mkdir(`${dir}/v-env-0`, { recursive: true });
    await writeFile(`${dir}/current`, "v-env-0");
    const { run, calls } = fakeDocker({
      containerd: true,
      exportCaches: true,
      override: (call) =>
        call.args.includes("--target") && call.args.includes("baked")
          ? Promise.resolve({ code: 1, stdout: "", stderr: "ERROR: boom" })
          : undefined,
    });
    const builder = dockerEnvironmentBuilder({ cacheDir }, silentDiagnostics(), { run });
    const spec = buildSpec({ dockerfileFrom: null });
    expectFailure(await builder.build(spec, { signal: never() }));

    // The environment pass exported and was promoted before the baked pass failed; that is a
    // whole export all the same, and stays current.
    assertEquals(await currentCacheVersion(dir), `${dir}/v-env-1`);
    // Both tags the build made go: no row will record them.
    const removed = calls.filter((c) => c.args[0] === "image" && c.args[1] === "rm");
    assertEquals(removed.map((c) => c.args[2]), [environmentTag(spec), bakedTag(spec)]);
  } finally {
    await rm(cacheDir, { recursive: true });
  }
});

test("an export no pass promoted is removed when its build fails", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const { run } = fakeDocker({
      containerd: true,
      exportCaches: true,
      override: (call) =>
        call.args.includes("--iidfile")
          ? (async () => {
            const at = call.args.indexOf("--cache-to");
            const dest = call.args[at + 1].replace(/^type=local,dest=/, "").replace(
              /,mode=max$/,
              "",
            );
            await mkdir(dest, { recursive: true });
            return { code: 1, stdout: "", stderr: "ERROR: boom" };
          })()
          : undefined,
    });
    const builder = dockerEnvironmentBuilder({ cacheDir }, silentDiagnostics(), { run });
    expectFailure(await builder.build(buildSpec({ dockerfileFrom: null }), { signal: never() }));
    assertEquals(await entries(scopeDir(cacheDir, "repo-abc-default", "environment")), []);
  } finally {
    await rm(cacheDir, { recursive: true });
  }
});

test("removing a build's images untags the environment and the baked stage it was given", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const spec = {
    environmentId: "env-1",
    subjectKey: "repo-abc",
    defaultBranch: true,
    recorded: true,
    image: IMAGE_ID,
    machineImage: null,
  };
  assert(await builder.removeImages!({ ...spec, bakedImage: bakedTag(spec) }));
  assertEquals(calls.map((c) => c.args), [
    ["image", "rm", environmentTag(spec)],
    ["image", "rm", bakedTag(spec)],
  ]);

  // A baked image the core keeps, or one that is no tag of this adapter's, is left alone.
  calls.length = 0;
  assert(await builder.removeImages!({ ...spec, bakedImage: null }));
  assert(await builder.removeImages!({ ...spec, bakedImage: "debian:12" }));
  assertEquals(calls.map((c) => c.args), [
    ["image", "rm", environmentTag(spec)],
    ["image", "rm", environmentTag(spec)],
  ]);

  // A build no row recorded: its own baked tag goes too, whatever the core could name.
  calls.length = 0;
  assert(await builder.removeImages!({ ...spec, recorded: false, image: null, bakedImage: null }));
  assertEquals(calls.map((c) => c.args), [
    ["image", "rm", environmentTag(spec)],
    ["image", "rm", bakedTag(spec)],
  ]);
});

test("an image a container still uses is kept, and a missing one counts as removed", async () => {
  const answer = (stderr: string) => () => Promise.resolve({ code: 1, stdout: "", stderr });
  const spec = {
    environmentId: "env-1",
    subjectKey: "repo-abc",
    defaultBranch: true,
    recorded: true,
    image: IMAGE_ID,
    machineImage: null,
  };
  const removeWith = (stderr: string) =>
    dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), {
      run: fakeDocker({ override: answer(stderr) }).run,
    }).removeImages!({ ...spec, bakedImage: bakedTag(spec) });

  // What the daemon said, measured (engine 29): never forced, so a container keeps its image.
  assertEquals(
    await removeWith(
      "Error response from daemon: conflict: unable to delete ryph-env/repo-abc:env-1 (must be " +
        "forced) - container cc72772db3d3 is using its referenced image 9f10cb3eb05b",
    ),
    false,
  );
  assertEquals(await removeWith("Error response from daemon: No such image: ryph-env/x:y"), true);
  let thrown = false;
  await removeWith("Cannot connect to the Docker daemon").catch(() => thrown = true);
  assert(thrown, "a daemon that could not be asked is an error, not a removal");
});

test("a bake that fails fails the build, naming what ryph-bake said", async () => {
  const { run, calls } = fakeDocker({
    override: (call) =>
      call.args.includes("environment") && call.args.includes("--iidfile")
        ? Promise.resolve({
          code: 1,
          stdout: "",
          stderr:
            "#13 0.514 ryph-bake: heartwood: setup steps left the worktree dirty (out.txt)\n" +
            "ERROR: failed to build: failed to solve: process did not complete successfully\n",
        })
        : undefined,
  });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const failure = expectFailure(await builder.build(buildSpec(), { signal: never() }));
  assertEquals(failure.kind, "failed");
  assertEquals(
    failure.message,
    "the environment build failed: ryph-bake: heartwood: setup steps left the worktree dirty " +
      "(out.txt)",
  );
  assertStringIncludes(failure.logTail, "ryph-bake: heartwood");
  // The machine's tag is cleaned up on the way out regardless, and so is whatever the failed
  // pass may have tagged.
  assertEquals(calls.slice(-2).map((c) => c.args), [
    ["image", "rm", machineTag(buildSpec())],
    ["image", "rm", environmentTag(buildSpec())],
  ]);
});

test("a clone that fails stops before any build", async () => {
  const { run, calls } = fakeDocker({
    override: (call) =>
      call.cmd === "bash"
        ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: repository 'x' not found\n" })
        : undefined,
  });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const failure = expectFailure(await builder.build(buildSpec(), { signal: never() }));
  assertEquals(failure.message, "cloning the repositories failed: repository 'x' not found");
  assertEquals(calls.length, 1);
});

/** A build that runs until it is killed, as buildx does. */
const hangs = (call: Call, signal: AbortSignal) =>
  call.args[0] === "buildx"
    ? new Promise<CommandResult>((resolve) => {
      const aborted = () => resolve({ code: 143, stdout: "", stderr: "" });
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    })
    : undefined;

test("a build past its limit is killed and reported as a timeout", async () => {
  const { run } = fakeDocker({ override: hangs });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const failure = expectFailure(
    await builder.build(buildSpec({ timeoutMs: 20 }), { signal: never() }),
  );
  assertEquals(failure.kind, "timeout");
  assertStringIncludes(failure.message, "limit");
});

test("an aborted build is killed and reported as cancelled", async () => {
  const started = Promise.withResolvers<void>();
  const { run } = fakeDocker({
    override(call, signal) {
      const pending = hangs(call, signal);
      if (pending) started.resolve();
      return pending;
    },
  });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const abort = new AbortController();
  const pending = builder.build(buildSpec(), { signal: abort.signal });
  await started.promise;
  abort.abort();
  const failure = expectFailure(await pending);
  assertEquals(failure.kind, "failed");
  assertEquals(failure.message, "the build was cancelled");
});

test("a timeout or cancel during an inspect is reported as one, not thrown", async () => {
  // The real runner throws the abort itself, as `command()` does when its signal fires.
  // An inspect begun after the signal fired rejects at once, as `command()` does: listening for
  // an abort that already happened would hang it for good.
  let inspecting = Promise.withResolvers<void>();
  let inspectStarted = false;
  const inspectHangs = (call: Call, signal: AbortSignal) =>
    call.args[0] === "image" && call.args[1] === "inspect"
      ? new Promise<CommandResult>((_, reject) => {
        const aborted = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) aborted();
        else {
          signal.addEventListener("abort", aborted, { once: true });
          inspectStarted = true;
          inspecting.resolve();
        }
      })
      : undefined;
  const from = `${LOCAL}repo-abc:baked-env-0`;
  const timedOut = expectFailure(
    await dockerEnvironmentBuilder(
      { cacheDir: null },
      silentDiagnostics(),
      { run: fakeDocker({ override: inspectHangs }).run },
    ).build(buildSpec({ warmFrom: from, timeoutMs: 1_000 }), { signal: never() }),
  );
  assertEquals(timedOut.kind, "timeout");
  assert(inspectStarted, "the timeout actually interrupted an inspect");

  inspecting = Promise.withResolvers<void>();
  const abort = new AbortController();
  const pending = dockerEnvironmentBuilder(
    { cacheDir: null, confine: CONFINE },
    silentDiagnostics(),
    { run: fakeDocker({ override: inspectHangs }).run, ensureGate: gateReady },
  ).build(buildSpec(), { signal: abort.signal });
  // Cancel only after the inspect has installed its abort listener, not during setup.
  await inspecting.promise;
  abort.abort();
  assertEquals(expectFailure(await pending).message, "the build was cancelled");
});

test("nothing here outlives the process that built it: nothing to adopt, its tags untagged", async () => {
  // The honest answer, and the useful one: `gone` lets the control plane fail a row stuck
  // `building` inside a tick instead of holding a queue slot for a child process that died with
  // its parent. What that build had tagged goes with it.
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  const spec = {
    environmentId: "env-1",
    subjectKey: "repo-abc",
    defaultBranch: true,
    relayerFrom: null,
    timeoutMs: 60_000,
  };
  const outcome = await builder.adopt(spec, { signal: new AbortController().signal });
  assertEquals(outcome.kind, "gone");
  assertEquals(calls.map((c) => c.args), [
    ["image", "rm", environmentTag(spec)],
    ["image", "rm", bakedTag(spec)],
  ]);
  // A re-layer's baked image is its source's, and stays.
  calls.length = 0;
  await builder.adopt({ ...spec, relayerFrom: bakedTag({ ...spec, environmentId: "env-0" }) }, {
    signal: new AbortController().signal,
  });
  assertEquals(calls.map((c) => c.args), [["image", "rm", environmentTag(spec)]]);
});

test("the clone gets none of the host's git configuration and no LFS smudge", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });
  // A spec cannot turn them back on: they are set after its own env.
  const spec = buildSpec({
    clone: { urls: { heartwood: "http://f/h.git" }, env: { GIT_CONFIG_GLOBAL: "/home/x" } },
  });
  expectOk(await builder.build(spec, { signal: never() }));
  const clone = calls.find((c) => c.cmd === "bash")!;
  assertEquals(clone.env?.GIT_CONFIG_GLOBAL, "/dev/null");
  assertEquals(clone.env?.GIT_CONFIG_NOSYSTEM, "1");
  assertEquals(clone.env?.GIT_ATTR_NOSYSTEM, "1");
  assertEquals(clone.env?.GIT_LFS_SKIP_SMUDGE, "1");
});

test("an image a re-layer or warm build starts from is never pulled when it is gone", async () => {
  const from = `${LOCAL}repo-abc:baked-env-0`;
  const gone = (call: Call) =>
    call.args[0] === "image" && call.args[1] === "inspect" && call.args.at(-1) === from
      ? Promise.resolve({ code: 1, stdout: "", stderr: `No such image: ${from}` })
      : undefined;
  for (const confine of [undefined, CONFINE]) {
    const relayer = fakeDocker({ override: gone });
    const failure = expectFailure(
      await dockerEnvironmentBuilder({ cacheDir: null, confine }, silentDiagnostics(), {
        run: relayer.run,
        ensureGate: gateReady,
      }).build(buildSpec({ relayerFrom: from, clone: { urls: {}, env: {} } }), {
        signal: never(),
      }),
    );
    assertStringIncludes(failure.message, `${from} is not an image of this deployment`);
    assert(!relayer.calls.some((c) => c.args[0] === "pull" || c.args[0] === "buildx"));

    // A warm build builds cold instead: no record pass, the full file, nothing of the warm image.
    const warm = fakeDocker({ override: gone });
    const result = expectOk(
      await dockerEnvironmentBuilder({ cacheDir: null, confine }, silentDiagnostics(), {
        run: warm.run,
        ensureGate: gateReady,
      }).build(buildSpec({ warmFrom: from }), { signal: never() }),
    );
    assertEquals(result.warm, false);
    assertStringIncludes(result.log, `${from} is not an image of this deployment`);
    assert(!warm.calls.some((c) => c.args[0] === "pull"));
    assert(!warm.calls.some((c) => c.args.join(" ").includes(from) && c.args[1] !== "inspect"));
    assert(!passes(warm.calls).some((p) => p.includes("machine-record")));
  }
});

test("an unconfined build is given the host's name only when its proxy is served there", () => {
  const hostAlias = (proxyEnv: Record<string, string>) =>
    buildArgvs(buildSpec({ proxyEnv }), workdirs("/w"), null).environment.includes("--add-host");
  assertEquals(hostAlias({}), false);
  assertEquals(hostAlias({ HTTPS_PROXY: "http://e:t@egress.internal:7460" }), false);
  assertEquals(hostAlias({ HTTPS_PROXY: "http://e:t@host.docker.internal:7460" }), true);
  const argv = buildArgvs(
    buildSpec({ proxyEnv: { HTTPS_PROXY: "http://e:t@host.docker.internal:7460" } }),
    workdirs("/w"),
    null,
  ).environment;
  assertEquals(argv[argv.indexOf("--add-host") + 1], "host.docker.internal:host-gateway");
});

const CONFINE = {
  docker: {
    runNetwork: "ryph-runs",
    gate: {
      image: "ryph-run-gate:dev",
      routes: [{ listen: 7460, target: "host.docker.internal", port: 7460 }],
    },
  },
  buildkitImage: "moby/buildkit:v0.32.2@sha256:" + "f".repeat(64),
};
const GATE = "ryph-gate-default";
/** env-1's builder, and its network: named for this deployment too. */
const BUILDER = confinedBuilderName("env-1", CONFINE.docker);
/** How a builder is taken away: through buildx, then whatever of it buildx no longer knows. */
const removeBuilder = (name: string) => [
  ["buildx", "rm", "--force", name],
  ["rm", "-f", `buildx_buildkit_${name}0`],
  ["volume", "rm", "-f", `buildx_buildkit_${name}0_state`],
];
/** How a confined build's network is found: by its environment and this deployment. */
const NETWORK_LS = [
  "network",
  "ls",
  "-q",
  "--filter",
  "label=ryph.build=env-1",
  "--filter",
  "label=ryph.deployment=default",
];
const CLAIM = `http://env-1:claim-token@${GATE}:7460`;
const gateReady = () => Promise.resolve({ state: "current" as const, isolateGateway: true });
const flags = (args: string[], flag: string) =>
  args.flatMap((a, i) => args[i - 1] === flag ? [a] : []);
const flagAt = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const passes = (calls: Call[]) =>
  calls.filter((c) => c.args[0] === "buildx" && c.args[1] === "build").map((c) => c.args);
const saves = (calls: Call[]) =>
  calls.filter((c) => c.cmd === "bash" && c.args[1].includes("docker image save"));

test("a confined build runs every pass on a builder of its own, alone with the gate", async () => {
  const { run, calls } = fakeDocker();
  const gates: unknown[] = [];
  const builder = dockerEnvironmentBuilder(
    { cacheDir: "/cache", confine: CONFINE },
    silentDiagnostics(),
    { run, ensureGate: (opts) => (gates.push(opts), gateReady()) },
  );
  const spec = buildSpec({ proxyEnv: { HTTPS_PROXY: CLAIM, https_proxy: CLAIM, NO_PROXY: "x" } });
  const result = expectOk(await builder.build(spec, { signal: never() }));
  const name = confinedBuilderName(spec.environmentId, CONFINE.docker);
  const atGate = `http://env-1:claim-token@${GATE_ADDRESS}:7460`;

  // The gate first, as a confined launch makes it, then a network of the build's own with the
  // gate on it — any left over taken away first — then the gate's address there, then the builder.
  assertEquals(gates, [CONFINE.docker]);
  assertEquals(calls.slice(1, 11).map((c) => c.args), [
    // Leftovers first, the builder before the network it would hold — the network found by this
    // deployment's labels for the environment, the builder by a name that is this deployment's.
    ...removeBuilder(name),
    NETWORK_LS,
    ["network", "disconnect", "--force", "net-1", GATE],
    ["network", "rm", "net-1"],
    // Made as a run's services network is: internal, and no gateway on the host where it can.
    [
      "network",
      "create",
      ...confinedNetworkFlags({ ...CONFINE.docker, isolateGateway: true }),
      "--label",
      "ryph.build=env-1",
      "--label",
      "ryph.deployment=default",
      name,
    ],
    ["network", "connect", name, GATE],
    ["inspect", "-f", "{{json .NetworkSettings.Networks}}", GATE],
    calls[10].args,
  ]);
  assertEquals(calls[10].args.slice(0, 2), ["buildx", "create"]);
  const create = calls[10].args;
  assertEquals(flagAt(create, "--name"), name);
  assertEquals(flagAt(create, "--driver"), "docker-container");
  assertEquals(flags(create, "--driver-opt"), [
    `network=${name}`,
    `image=${CONFINE.buildkitImage}`,
    `env.HTTPS_PROXY=${atGate}`,
  ]);

  // Every image a pass starts from is exported for it: the harness and the base here, each by
  // the id it resolved to when judged. Side by side, so in no particular order.
  assertEquals(saves(calls).map((c) => c.args[3]).sort(), [HARNESS.id, BASE.id].sort());

  const builds = passes(calls);
  assertEquals(builds.length, 4);
  for (const pass of builds) {
    assertEquals(flagAt(pass, "--builder"), name);
    // No attestation, which would make the machine's layout digest new on every build.
    assert(pass.includes("--provenance=false"));
    assert(!pass.includes("--add-host"), "a confined build has no name for the host");
    // The proxy at the gate's address, which a step can dial without resolving anything.
    assert(pass.includes(`HTTPS_PROXY=${atGate}`));
    assert(pass.includes(`https_proxy=${atGate}`));
    assert(!pass.some((a) => a.includes(`@${GATE}:`)));
  }
  // The machine: the universal image's names as contexts, written out as a layout.
  const machine = builds[0];
  assertEquals(
    flags(machine, "--build-context").map((c) => c.replace(/=oci-layout:\/\/.*\/layouts\//, "=")),
    [
      `quay.io/ryph/ryph-universal=base:ryph@${LAYOUT_DIGEST}`,
      `quay.io/ryph/ryph-universal:1=base:ryph@${LAYOUT_DIGEST}`,
    ],
  );
  assert(flagAt(machine, "--output").startsWith("type=oci,dest="));
  assert(!machine.includes("--load"));
  // A confined build's cache is always the scoped directories, whatever the store.
  assert(machine.includes("--cache-to"));
  // The environment, on the machine and the harness as contexts, the machine recorded by its
  // layout's digest.
  const env = builds[1];
  assert(env.includes("RYPH_MACHINE=ryph-input/machine"));
  assert(env.includes("RYPH_HARNESS=ryph-input/harness"));
  assert(env.includes(`RYPH_MACHINE_DIGEST=${MACHINE_LAYOUT_DIGEST}`));
  const contexts = flags(env, "--build-context");
  assert(
    contexts.some((c) => /^ryph-input\/machine=oci-layout:\/\/.*\/machine:ryph@sha256:2+$/.test(c)),
  );
  assert(
    contexts.some((c) => /^ryph-input\/harness=oci-layout:\/\/.*\/harness:ryph@sha256:1+$/.test(c)),
  );
  assert(!env.includes("--iidfile"));
  assertEquals(flagAt(env, "--tag"), environmentTag(spec));

  // The image by the store's own id for it, and the builder gone with the build.
  assertEquals(result.image, MACHINE_ID);
  assertEquals(calls.slice(-6).map((c) => c.args), [
    ...removeBuilder(name),
    NETWORK_LS,
    ["network", "disconnect", "--force", "net-1", GATE],
    ["network", "rm", "net-1"],
  ]);
  assert(!calls.some((c) => c.args[0] === "tag"), "nothing is tagged in a store it cannot read");
  assert(!calls.some((c) => c.args[0] === "image" && c.args[1] === "rm"));
  // The claim never reaches the log, in the builder's env or a build argument.
  assert(!result.log.includes("claim-token"));
  assertStringIncludes(result.log, "env.HTTPS_PROXY=***");
});

test("a confined re-layer and warm build hand over the images they start from", async () => {
  const { run, calls } = fakeDocker({ recorded: `${MACHINE_LAYOUT_DIGEST}\n` });
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, confine: CONFINE },
    silentDiagnostics(),
    { run, ensureGate: gateReady },
  );
  const from = `${LOCAL}repo-abc:baked-env-0`;

  expectOk(
    await builder.build(buildSpec({ relayerFrom: from, clone: { urls: {}, env: {} } }), {
      signal: never(),
    }),
  );
  const relayer = passes(calls)[0];
  assert(relayer.includes("RYPH_BAKED=ryph-input/baked"));
  assert(relayer.some((a) => a.startsWith("ryph-input/baked=oci-layout://")));
  // By the ids they resolve to: the store's own (`fakeDocker`) for a tag under `LOCAL`.
  assertEquals(saves(calls).map((c) => c.args[3]).sort(), [HARNESS.id, imageId("e")].sort());
  calls.length = 0;

  const result = expectOk(await builder.build(buildSpec({ warmFrom: from }), { signal: never() }));
  assertEquals(result.warm, true);
  assert(saves(calls).some((c) => c.args[3] === imageId("e")));
  // The record is read off the warm image's layout, and the warm passes start from it.
  for (const pass of passes(calls).slice(1)) {
    assert(pass.includes("RYPH_WARM=ryph-input/warm"));
    assert(pass.some((a) => a.startsWith("ryph-input/warm=oci-layout://")));
  }
});

test("a confined build whose gate is not ready fails before any builder is made", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, confine: CONFINE },
    silentDiagnostics(),
    {
      run,
      ensureGate: () => Promise.reject(new Error("the run gate image is not in docker's store")),
    },
  );
  const failure = expectFailure(await builder.build(buildSpec(), { signal: never() }));
  assertStringIncludes(failure.message, "the run gate is not ready");
  assert(!calls.some((c) => c.args[0] === "buildx"), "nothing builds unconfined instead");
});

test("a confined build warns of a gate its own check replaced under live containers", async () => {
  const { run } = fakeDocker();
  const { diag, events } = recordingDiagnostics();
  const builder = dockerEnvironmentBuilder({ cacheDir: null, confine: CONFINE }, diag, {
    run,
    ensureGate: () =>
      Promise.resolve({
        state: "created" as const,
        isolateGateway: true,
        forced: [{
          gate: GATE,
          live: ["ryph-run-1", "buildx_buildkit_ryph-build-env-20"],
          why: "its image changed",
        }],
      }),
  });
  expectOk(await builder.build(buildSpec(), { signal: never() }));
  const warned = events.find((e) =>
    e.event === "environment_builder.docker.gate_recreated_under_live_runs"
  );
  assertEquals(warned?.fields?.live, ["ryph-run-1"]);
  assertEquals(warned?.fields?.builds, ["buildx_buildkit_ryph-build-env-20"]);

  // A gate kept out of date for live containers is said too, as every other caller says it.
  const kept = recordingDiagnostics();
  expectOk(
    await dockerEnvironmentBuilder({ cacheDir: null, confine: CONFINE }, kept.diag, {
      run,
      ensureGate: () =>
        Promise.resolve({ state: "deferred" as const, isolateGateway: true, live: ["ryph-run-1"] }),
    }).build(buildSpec(), { signal: never() }),
  );
  assert(kept.events.some((e) => e.event === "environment_builder.docker.gate_recreate_deferred"));
});

test("a confined build whose gate was replaced mid-build says so when it fails", async () => {
  let replaced = false;
  const { run } = fakeDocker({
    override: (call) => {
      if (call.args[0] === "inspect" && replaced) {
        return Promise.resolve(
          ok(JSON.stringify({ [BUILDER]: { IPAddress: "172.22.0.9" } })),
        );
      }
      if (call.args[1] === "build" && call.args.includes("environment")) {
        replaced = true;
        return Promise.resolve({ code: 1, stdout: "", stderr: "ryph: connection timed out" });
      }
      return undefined;
    },
  });
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, confine: CONFINE },
    silentDiagnostics(),
    { run, ensureGate: gateReady },
  );
  const failure = expectFailure(await builder.build(buildSpec(), { signal: never() }));
  assertStringIncludes(failure.message, "the environment build failed");
  assertStringIncludes(
    failure.message,
    `the run gate ${GATE} was replaced during the build (${GATE_ADDRESS} → 172.22.0.9)`,
  );

  // A failure with the gate where it was is only itself.
  replaced = false;
  const plain = fakeDocker({
    override: (call) =>
      call.args[1] === "build" && call.args.includes("environment")
        ? Promise.resolve({ code: 1, stdout: "", stderr: "ryph: setup failed" })
        : undefined,
  });
  const unmoved = expectFailure(
    await dockerEnvironmentBuilder({ cacheDir: null, confine: CONFINE }, silentDiagnostics(), {
      run: plain.run,
      ensureGate: gateReady,
    }).build(buildSpec(), { signal: never() }),
  );
  assert(!unmoved.message.includes("replaced"), unmoved.message);

  // Nor does one where docker could not say where the gate is now.
  let failedOnce = false;
  const daemonGone = fakeDocker({
    override: (call) => {
      if (call.args[0] === "inspect" && failedOnce) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "Cannot connect to the daemon" });
      }
      if (call.args[1] === "build" && call.args.includes("environment")) {
        failedOnce = true;
        return Promise.resolve({ code: 1, stdout: "", stderr: "ryph: setup failed" });
      }
      return undefined;
    },
  });
  const unknown = expectFailure(
    await dockerEnvironmentBuilder({ cacheDir: null, confine: CONFINE }, silentDiagnostics(), {
      run: daemonGone.run,
      ensureGate: gateReady,
    }).build(buildSpec(), { signal: never() }),
  );
  assert(!unknown.message.includes("replaced"), unknown.message);
});

test("a confined build handed a proxy that is not the gate fails before any builder is made", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, confine: CONFINE },
    silentDiagnostics(),
    { run, ensureGate: gateReady },
  );
  const elsewhere = "http://env-1:claim-token@host.docker.internal:7460";
  const failure = expectFailure(
    await builder.build(
      buildSpec({ proxyEnv: { HTTPS_PROXY: elsewhere, NO_PROXY: "localhost" } }),
      { signal: never() },
    ),
  );
  assertStringIncludes(
    failure.message,
    `the egress proxy http://host.docker.internal:7460 is not the run gate ${GATE}`,
  );
  assert(!failure.message.includes("claim-token"), "the claim never reaches the message");
  assert(!calls.some((c) => c.args[0] === "buildx" && c.args[1] !== "rm"), "no builder is made");
});

test("a confined builder's name is this deployment's, so no environment id spells another's", () => {
  const a = confinedBuilderName("b-env", { network: "a" });
  // buildx would start a BuildKit container of the name, and mount its state, whoever made it.
  assert(a !== confinedBuilderName("env", { network: "a-b" }));
  assert(a !== confinedBuilderName("b-env", { network: "c" }));
  assertEquals(a, confinedBuilderName("b-env", { network: "a" }));
  assert(/^ryph-build-[0-9a-f]{12}-b-env$/.test(a), a);
});

test("discard removes a confined build's builder and network, and does nothing unconfined", async () => {
  const confined = fakeDocker();
  await dockerEnvironmentBuilder({ cacheDir: null, confine: CONFINE }, silentDiagnostics(), {
    run: confined.run,
  }).discard("env-1");
  assertEquals(confined.calls.map((c) => c.args), [
    ...removeBuilder(BUILDER),
    NETWORK_LS,
    ["network", "disconnect", "--force", "net-1", GATE],
    ["network", "rm", "net-1"],
  ]);
  const open = fakeDocker();
  await dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run: open.run })
    .discard("env-1");
  assertEquals(open.calls, []);
});

test("a deployment that refuses branch builds still builds the default branch, when it trusts its caller", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, refuseBranchBuilds: "runs are sandboxed", trustDefaultBranch: true },
    silentDiagnostics(),
    { run },
  );
  const branch = buildSpec({ defaultBranch: false, cacheScope: { read: [], write: null } });
  const failure = expectFailure(await builder.build(branch, { signal: never() }));
  assertEquals(failure.kind, "failed");
  assertStringIncludes(failure.message, "branch builds are refused");
  assertEquals(calls, []);
  expectOk(await builder.build(buildSpec(), { signal: never() }));
});

test("one that does not trust its caller's word refuses every build, the default branch's too", async () => {
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, refuseBranchBuilds: "runs are sandboxed" },
    silentDiagnostics(),
    { run },
  );
  const failure = expectFailure(await builder.build(buildSpec(), { signal: never() }));
  assertStringIncludes(failure.message, "does not take a caller's word");
  assertEquals(calls, []);
});

test("the factory confines docker builds where runs are, and refuses branches when sandboxed", async () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const config = (builder: "docker") => ({
    ...DEFAULT_ENVIRONMENTS_CONFIG,
    builder,
  });
  // Confined runs and no gate is a configuration that confines nothing: refused at boot.
  assertThrows(
    () =>
      createEnvironmentBuilder(config("docker"), {
        env: env({}),
        docker: { runNetwork: "ryph-runs" },
      }),
    Error,
    "run gate",
  );
  // Confined runs and a build proxy of its own: a proxy the build cannot reach, refused at boot.
  assertThrows(
    () =>
      createEnvironmentBuilder(
        { ...config("docker"), buildProxyUrl: "http://host.docker.internal:7460" },
        { env: env({}), docker: CONFINE.docker },
      ),
    Error,
    "RYPH_ENV_EGRESS_PROXY_URL is unused when docker builds are confined",
  );
  // The kubernetes builder's rootless BuildKit, copied over: it cannot run in the container
  // driver, so every confined build would fail starting it.
  assertThrows(
    () =>
      createEnvironmentBuilder(config("docker"), {
        env: env({ RYPH_ENV_BUILDKIT_IMAGE: "moby/buildkit:v0.32.2-rootless" }),
        docker: CONFINE.docker,
      }),
    Error,
    "is rootless",
  );
  // Unconfined, the override is the proxy a build dials, as before.
  assertEquals(
    createEnvironmentBuilder(
      { ...config("docker"), buildProxyUrl: "http://host.docker.internal:7460" },
      { env: env({}) },
    ).kind,
    "docker",
  );
  // Confined runs: the build's first act after the clone is the gate's address.
  const docker = fakeDocker();
  const confined = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: docker.run,
    docker: CONFINE.docker,
  });
  assertEquals(confined.kind, "docker");
  await confined.discard("env-1");
  assertEquals(docker.calls.map((c) => c.args.slice(0, 2)), [
    ["buildx", "rm"],
    ["rm", "-f"],
    ["volume", "rm"],
    ["network", "ls"],
    ["network", "disconnect"],
    ["network", "rm"],
  ]);

  // Runs in a sandboxed runtime: the build's BuildKit is privileged runc, so branches are refused.
  const branch = buildSpec({ defaultBranch: false, cacheScope: { read: [], write: null } });
  const sandboxed = fakeDocker();
  const runsc = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: sandboxed.run,
    docker: { ...CONFINE.docker, runtime: "runsc" },
  });
  assertStringIncludes(
    expectFailure(await runsc.build(branch, { signal: never() })).message,
    "sandboxed by the runsc runtime",
  );
  assertEquals(sandboxed.calls, []);
  // And the default branch's too, unless the builder is told to take its caller's word for it.
  assertStringIncludes(
    expectFailure(await runsc.build(buildSpec(), { signal: never() })).message,
    "does not take a caller's word",
  );
  const trusting = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: fakeDocker().run,
    docker: { runtime: "runsc" },
    trustDefaultBranch: true,
    soleTenant: true,
  });
  expectOk(await trusting.build(buildSpec(), { signal: never() }));
  assertStringIncludes(
    expectFailure(await trusting.build(branch, { signal: never() })).message,
    "branch builds are refused",
  );
  // Unconfined just the same: there a branch would build on the daemon's default bridge.
  const open = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: fakeDocker().run,
    docker: { runtime: "runsc" },
    soleTenant: true,
  });
  assertStringIncludes(
    expectFailure(await open.build(branch, { signal: never() })).message,
    "sandboxed by the runsc runtime",
  );
  // runc is no sandbox to keep a build out of.
  const plainRunc = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: fakeDocker().run,
    docker: { runtime: "runc" },
    soleTenant: true,
  });
  expectOk(await plainRunc.build(branch, { signal: never() }));
  const shimRunc = createEnvironmentBuilder(config("docker"), {
    env: env({}),
    run: fakeDocker().run,
    docker: { runtime: "io.containerd.runc.v2" },
    soleTenant: true,
  });
  expectOk(await shimRunc.build(branch, { signal: never() }));
});

test("an unconfined factory builder refuses every build unless its deployment is the daemon's one tenant", async () => {
  const config = { ...DEFAULT_ENVIRONMENTS_CONFIG, builder: "docker" as const };
  // A standalone launcher with no run network: a build would tag the universal image's public
  // names on a daemon other deployments build on, so it never starts.
  const shared = fakeDocker();
  const refusing = createEnvironmentBuilder(config, { env: () => undefined, run: shared.run });
  const failure = expectFailure(await refusing.build(buildSpec(), { signal: never() }));
  assertStringIncludes(failure.message, "RYPH_DOCKER_RUN_NETWORK");
  assertStringIncludes(failure.message, "public names");
  assertEquals(shared.calls, []);
  // The binary's embedded launcher, the daemon's one tenant, builds unconfined as before, and
  // tags the public names.
  const sole = fakeDocker();
  const building = createEnvironmentBuilder(config, {
    env: () => undefined,
    run: sole.run,
    soleTenant: true,
  });
  expectOk(await building.build(buildSpec(), { signal: never() }));
  assert(
    sole.calls.some((c) =>
      c.args[0] === "tag" && c.args.at(-1) === "quay.io/ryph/ryph-universal:1"
    ),
  );
  // Confined, no tenant question arises: the public names are named contexts, never tags.
  assertEquals(
    everyBuildRefused({
      runtime: undefined,
      runNetwork: "ryph-runs",
      trustDefaultBranch: false,
      soleTenant: false,
    }),
    null,
  );
});

test("helpers: the gate's address, the proxy at it, a builder's argv, the redacted log", () => {
  assertEquals(gateAddress('{"ryph-runs":{"IPAddress":"172.22.0.1"}}', "ryph-runs"), "172.22.0.1");
  assertEquals(gateAddress('{"bridge":{"IPAddress":"172.17.0.3"}}', "ryph-runs"), null);
  assertEquals(gateAddress("not json", "ryph-runs"), null);
  assertEquals(
    confinedProxyEnv(
      { HTTPS_PROXY: CLAIM, NO_PROXY: "localhost", OTHER: "http://elsewhere:1" },
      GATE,
      "172.22.0.1",
    ),
    {
      HTTPS_PROXY: "http://env-1:claim-token@172.22.0.1:7460",
      NO_PROXY: "localhost",
      OTHER: "http://elsewhere:1",
    },
  );
  assertEquals(
    proxyOffGate({ HTTPS_PROXY: "http://e:t@172.22.0.1:7460", NO_PROXY: "x" }, "172.22.0.1"),
    null,
  );
  assertEquals(proxyOffGate({}, "172.22.0.1"), null);
  assertEquals(
    proxyOffGate(
      { HTTPS_PROXY: "http://e:t@172.22.0.1:7460", http_proxy: "http://e:t@elsewhere:1" },
      "172.22.0.1",
    ),
    "http://elsewhere:1",
  );
  assertEquals(
    proxyOffGate({ HTTPS_PROXY: "not a url" }, "172.22.0.1"),
    "a proxy URL that does not parse",
  );
  assertThrows(
    () => confinedBuilderArgs("b", "n", CONFINE, { HTTPS_PROXY: "http://a,b@x:1" }),
    Error,
    "buildx splits on",
  );
  assertEquals(
    redactedCommand("docker", ["buildx", "create", "--driver-opt", "env.HTTPS_PROXY=http://a:b@c"]),
    "$ docker buildx create --driver-opt env.HTTPS_PROXY=***",
  );
  assertEquals(layoutRef("/l/base", LAYOUT_DIGEST), `oci-layout:///l/base:ryph@${LAYOUT_DIGEST}`);
});

test("every tag a build makes is under its deployment's repository, and no two deployments share one", async () => {
  const spec = { environmentId: "env-1", subjectKey: "repo-abc" };
  const mine = localImagePrefix("ryph-a");
  const theirs = localImagePrefix("ryph-b");
  assert(mine !== theirs);
  assert(mine.startsWith("ryph-env/") && /^ryph-env\/[0-9a-f]{12}\/$/.test(mine), mine);
  for (const tag of [environmentTag, bakedTag, machineTag]) {
    assert(tag(spec, mine).startsWith(mine));
    // No subject key spells another deployment's path: it is one segment below the digest.
    assertEquals(tag(spec, mine).slice(mine.length).split("/").length, 1);
  }
  const { run, calls } = fakeDocker();
  const builder = dockerEnvironmentBuilder(
    { cacheDir: null, deployment: "ryph-a" },
    silentDiagnostics(),
    {
      run,
    },
  );
  const result = expectOk(await builder.build(buildSpec(), { signal: never() }));
  assert(result.bakedImage.startsWith(mine), result.bakedImage);
  const tags = calls.flatMap((c) =>
    c.args.flatMap((a, i) => (c.args[i - 1] === "--tag" ? [a] : []))
  );
  assert(tags.length > 0 && tags.every((t) => t.startsWith(mine)), tags.join(" "));
});

test("a build never reads, and a removal never untags, another deployment's local images", async () => {
  const spec = { environmentId: "env-1", subjectKey: "repo-abc" };
  const theirs = bakedTag({ ...spec, environmentId: "env-0" }, localImagePrefix("someone-else"));
  const preDigest = "ryph-env/repo-abc:baked-env-0";
  // In the store, so the judgement finds them there and reads their names.
  const { run, calls } = fakeDocker({ images: [{ id: imageId("f"), names: [theirs, preDigest] }] });
  const builder = dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), { run });

  // Removal: the environment's own tag, never the caller-named one; a build no row recorded has
  // its own baked tag untagged too, by the name this deployment gives it.
  const removal = { defaultBranch: true, image: null, machineImage: null };
  for (const bakedImage of [theirs, preDigest]) {
    calls.length = 0;
    assert(await builder.removeImages!({ ...spec, ...removal, recorded: true, bakedImage }));
    assertEquals(calls.map((c) => c.args), [["image", "rm", environmentTag(spec)]]);
    calls.length = 0;
    assert(await builder.removeImages!({ ...spec, ...removal, recorded: false, bakedImage }));
    assertEquals(calls.map((c) => c.args), [
      ["image", "rm", environmentTag(spec)],
      ["image", "rm", bakedTag(spec)],
    ]);
  }

  // A re-layer on it fails before anything runs; a warm build on it builds cold; a base on it is
  // refused.
  for (const from of [theirs, preDigest]) {
    calls.length = 0;
    const relayer = expectFailure(
      await builder.build(buildSpec({ relayerFrom: from, clone: { urls: {}, env: {} } }), {
        signal: never(),
      }),
    );
    // Worded as an absent image is, so a build tells nobody what another deployment holds.
    assertStringIncludes(relayer.message, `${from} is not an image of this deployment`);
    assert(!calls.some((c) => c.args.join(" ").includes(from)), "never built on");

    calls.length = 0;
    expectOk(await builder.build(buildSpec({ warmFrom: from }), { signal: never() }));
    assert(!calls.some((c) => c.args.some((a) => a.includes(from))), "built cold, without it");

    const base = expectFailure(
      await builder.build(buildSpec({ baseImage: from }), { signal: never() }),
    );
    assertStringIncludes(base.message, "cannot be built on");
  }
});

test("a build judges the image docker resolves, whatever the spelling, and never another deployment's", async () => {
  const theirs = bakedTag({ subjectKey: "x", environmentId: "e" }, localImagePrefix("other"));
  const mine = bakedTag({ subjectKey: "x", environmentId: "e" });
  const foreign: FakeImage = { id: imageId("d"), names: [theirs] };
  const untagged: FakeImage = { id: imageId("9"), names: [] };
  const own: FakeImage = { id: imageId("7"), names: [mine] };
  const images = [foreign, untagged, own];
  const build = async (spec: Partial<BuildSpec>) => {
    const docker = fakeDocker({ images });
    const result = await dockerEnvironmentBuilder({ cacheDir: null }, silentDiagnostics(), {
      run: docker.run,
    }).build(buildSpec({ clone: { urls: {}, env: {} }, ...spec }), { signal: never() });
    return { result, ...docker };
  };
  // Every spelling docker resolves to another deployment's image, or to an untagged one: a
  // re-layer on it fails before anything runs, as one gone; a base or harness on it is refused.
  for (
    const from of [
      foreign.id,
      `sha256:${foreign.id.slice(7, 13)}`,
      foreign.id.slice(7, 11),
      foreign.id.slice(7),
      `docker.io/${theirs}`,
      `index.docker.io/${theirs}`,
      `${theirs.replace(/:[^:]+$/, "")}@${foreign.id}`,
      untagged.id,
    ]
  ) {
    const relayer = await build({ relayerFrom: from });
    assert(!relayer.result.ok, from);
    assert(!relayer.calls.some((c) => c.args[0] === "buildx"), from);
    for (const field of ["baseImage", "harnessImage"] as const) {
      const refused = await build({ relayerFrom: own.id, [field]: from });
      assert(!refused.result.ok, `${field} ${from}`);
      assert(!refused.calls.some((c) => c.args[0] === "buildx"), `${field} ${from}`);
    }
  }
  // An id carrying this deployment's tag is its own; as a base, any environment image is refused.
  assert((await build({ relayerFrom: own.id })).result.ok);
  assert(!(await build({ relayerFrom: own.id, baseImage: own.id })).result.ok);
  assert(!(await build({ relayerFrom: own.id, baseImage: mine })).result.ok);
});
