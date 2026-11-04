// What every environment builder shares: the generated outer Dockerfile (the one string every
// backend hands BuildKit), the clone script that runs outside the build, the spec checks, and the
// factory that picks a backend from configuration.

import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertBuildable,
  BuildLog,
  cloneArgs,
  cloneScript,
  environmentDockerfile,
  failureLine,
  parseSetupWarnings,
  parseToolchains,
  proxyBuildArgs,
  relayerDockerfile,
  safeName,
  shellQuote,
} from "../src/adapters/environment_builder/dockerfile.ts";
import {
  buildSizeFromEnv,
  cacheDirFromEnv,
  createEnvironmentBuilder,
  registryAuthFromEnv,
} from "../src/adapters/environment_builder/mod.ts";
import {
  DEFAULT_ENVIRONMENTS_CONFIG,
  type EnvironmentsConfig,
} from "../src/core/environment_config.ts";
import type { BuildSpec } from "../src/ports/environment_builder.ts";
import { BUILD_COMMIT as COMMIT, buildSpec, recordingDiagnostics } from "./doubles.ts";
import { setupWarningsForBuild, summarizeSetupWarning } from "../src/core/setup_warnings.ts";

const failing = (message: string): never => {
  throw new Error(message);
};

test("the outer Dockerfile runs the stages in order, the harness last", () => {
  const file = environmentDockerfile();
  const at = (needle: string) => {
    const index = file.indexOf(needle);
    assert(index !== -1, `missing: ${needle}`);
    return index;
  };
  // The machine, then the base check, then the checkout, the baker, the bake, then the harness.
  const order = [
    "FROM ${RYPH_MACHINE} AS baked",
    "check-base.sh --base-only",
    "COPY --from=checkout --chown=1994:1994 / /ryph/work/",
    "COPY --from=harness /opt/ryph/bin/ryph-bake /usr/local/bin/ryph-bake",
    "RUN --network=default /usr/local/bin/ryph-bake --phase image /ryph/work",
    // The harness goes on in a stage of its own, so `baked` is an image without it.
    "FROM baked AS environment",
    "COPY --from=harness /opt/ryph /opt/ryph",
    "RUN /opt/ryph/lib/check-base.sh",
    'ENTRYPOINT ["/opt/ryph/bin/tini", "-s", "--", "/opt/ryph/bin/ryph-runner"]',
  ].map(at);
  assertEquals(order, [...order].sort((a, b) => a - b));
  // The bake runs as the run user, and so does the image.
  assert(at("USER 1994:1994") < at("RUN --network=default"));
  // No command: a launch appends no args, and the runner fetches its work on boot.
  assertEquals(file.includes("\nCMD "), false);
  const tail = file.slice(at("COPY --from=harness /opt/ryph /opt/ryph"));
  assertMatch(tail, /USER 1994:1994\nWORKDIR \/ryph\/work\nENV RYPH_INIT=tini\nENTRYPOINT/);
  // The toolchain record is its own target, read without starting the image.
  assertStringIncludes(file, "FROM scratch AS toolchains");
  assertStringIncludes(file, "COPY --from=environment /opt/ryph-env/toolchains.json");
  // ...with ryph-bake's setup warnings beside it, as a wildcard COPY may match nothing: an image
  // baked before the file existed (a re-layer's source) still builds.
  assertStringIncludes(file, " /opt/ryph-env/setup-warnings.jso[n] /\n");
  // Nothing above the harness copy reads the harness image except by one-file COPYs.
  assert(!file.includes("--mount=type=bind,from=harness"));
  // The parser directive must be the very first line to count.
  assert(file.startsWith("# check=skip=InvalidDefaultArgInFrom\n"));
});

test("default and repo environment images both start under the harness's init", async () => {
  const agent = await readFile(
    new URL("../../../images/agent/Dockerfile", import.meta.url),
    "utf8",
  );
  const entrypoint = 'ENTRYPOINT ["/opt/ryph/bin/tini", "-s", "--", "/opt/ryph/bin/ryph-runner"]';
  for (const file of [agent, environmentDockerfile(), relayerDockerfile()]) {
    assertStringIncludes(file, entrypoint);
    // -s and nothing else: a subreaper when not PID 1, and no group forwarding (-g), so tini
    // signals the runner alone, which owns orderly job shutdown and finalization. Exactly one
    // ENTRYPOINT, so the exact one above wins.
    assertEquals(file.match(/tini",\s*"-(?!-")[^"]*"/g), ['tini", "-s"']);
    assertNotMatch(file, /"-g"/);
    assertEquals(file.match(/^ENTRYPOINT /gm)?.length, 1);
    // The marker the runner reads to ignore the stray signals tini forwards.
    assertEquals(file.match(/^ENV RYPH_INIT=tini$/gm)?.length, 1);
  }
  // The generated build fails fast on a layer whose tini is missing or not runnable.
  assertStringIncludes(environmentDockerfile(), "/opt/ryph/bin/tini --version");
});

test("the re-layer file is stage 4 alone, on the baked image, ending as the full one does", () => {
  const relayer = relayerDockerfile();
  const full = environmentDockerfile();
  assert(relayer.startsWith("# check=skip=InvalidDefaultArgInFrom\n"));
  assertStringIncludes(relayer, "FROM ${RYPH_BAKED} AS environment");
  assert(!relayer.includes("RYPH_MACHINE"));
  assert(!relayer.includes("--from=checkout"));
  assert(!relayer.includes("--phase image"));
  // Everything from the harness copy on is the same bytes in both.
  const from = (file: string) => file.slice(file.indexOf("# 4. the harness"));
  assertEquals(from(relayer), from(full));
});

test("the outer Dockerfile is the same bytes for every build", () => {
  assertEquals(environmentDockerfile(), environmentDockerfile());
  assert(!environmentDockerfile().includes("heartwood"));
});

test("the clone script is one text for every build: what it clones are its arguments", () => {
  const spec = buildSpec({
    checkouts: [
      { path: "a", connectedRepoId: "1", ref: "refs/heads/main", commit: COMMIT },
      { path: "b", connectedRepoId: "2", ref: "feat/x", commit: COMMIT },
    ],
    clone: {
      urls: { a: "http://forge.test/git/it's.git", b: "http://forge.test/git/b.git" },
      env: { GIT_CONFIG_COUNT: "1" },
    },
  });
  assertEquals(cloneArgs(spec), [
    "a",
    "http://forge.test/git/it's.git",
    "main",
    COMMIT,
    "b",
    "http://forge.test/git/b.git",
    "feat/x",
    COMMIT,
  ]);
  // No value of the spec is script text; the credential is env, never either.
  const script = cloneScript();
  for (const value of [...cloneArgs(spec), "GIT_CONFIG_COUNT"]) {
    assert(value === "a" || value === "b" || !script.includes(value), value);
  }
  assertStringIncludes(script, "git clone --quiet --no-tags --single-branch --branch");
});

test("the clone script clones each checkout at its commit and writes the member order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ryph-clone-"));
  const sh = async (cwd: string, program: string, ...args: string[]) => {
    const out = await command(program, {
      args,
      cwd,
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder();
    return { code: out.code, out: text.decode(out.stdout) + text.decode(out.stderr) };
  };
  try {
    // A source whose path a shell would misread, on a branch with a slash in its name.
    const repo = async (dir: string, branch: string) => {
      await mkdir(dir);
      await sh(dir, "git", "-c", `init.defaultBranch=${branch}`, "init", "-q");
      await writeFile(join(dir, "f"), dir);
      await sh(dir, "git", "add", ".");
      await sh(dir, "git", "commit", "-q", "-m", "one");
      const first = (await sh(dir, "git", "rev-parse", "HEAD")).out.trim();
      await writeFile(join(dir, "f"), "later");
      await sh(dir, "git", "commit", "-q", "-am", "two");
      return first;
    };
    const a = await repo(join(root, "it's a $(x)"), "main");
    const b = await repo(join(root, "b"), "feat/x");
    await mkdir(join(root, "checkout"));
    const spec = buildSpec({
      checkouts: [
        { path: "zz", connectedRepoId: "1", ref: "refs/heads/main", commit: a },
        { path: "aa", connectedRepoId: "2", ref: "feat/x", commit: b },
      ],
      clone: { urls: { zz: join(root, "it's a $(x)"), aa: join(root, "b") }, env: {} },
    });
    const checkout = join(root, "checkout");
    const run = await sh(checkout, "bash", "-c", cloneScript(), "clone", ...cloneArgs(spec));
    assertEquals(run.code, 0, run.out);
    // Each at the commit the record names, not its branch's tip, in member order.
    assertEquals((await sh(join(checkout, "zz"), "git", "rev-parse", "HEAD")).out.trim(), a);
    assertEquals((await sh(join(checkout, "aa"), "git", "rev-parse", "HEAD")).out.trim(), b);
    assertEquals(await readFile(join(checkout, ".order"), "utf8"), "zz\naa\n");
    // Arguments that are not whole checkouts are refused before anything is cloned.
    const short = await sh(checkout, "bash", "-c", cloneScript(), "clone", "x", "y");
    assertEquals(short.code, 1);
    assertStringIncludes(short.out, "four arguments per checkout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shellQuote survives the quote character", () => {
  assertEquals(shellQuote("a'b"), `'a'\\''b'`);
});

test("a spec with a value no builder should splice is refused as a bug", () => {
  const bad: Array<[string, Partial<BuildSpec>]> = [
    ["subjectKey", { subjectKey: "Repo ABC" }],
    ["checkout path", {
      checkouts: [{ path: "../x", connectedRepoId: "1", ref: "main", commit: COMMIT }],
      dockerfileFrom: null,
    }],
    ["dotfile path", {
      checkouts: [{ path: ".order", connectedRepoId: "1", ref: "main", commit: COMMIT }],
      dockerfileFrom: null,
    }],
    ["ref", {
      checkouts: [{
        path: "heartwood",
        connectedRepoId: "1",
        ref: "--upload-pack=x",
        commit: COMMIT,
      }],
    }],
    ["commit", {
      checkouts: [{ path: "heartwood", connectedRepoId: "1", ref: "main", commit: "HEAD" }],
    }],
    ["dockerfileFrom", { dockerfileFrom: "other" }],
    ["clone url", { clone: { urls: {}, env: {} } }],
    ["env", { proxyEnv: { HTTPS_PROXY: "http://x\ny" } }],
  ];
  for (const [what, overrides] of bad) {
    assertThrows(() => assertBuildable(buildSpec(overrides)), Error, "environment build", what);
  }
  assertBuildable(buildSpec());
});

test("only BuildKit's predefined proxy arguments reach a build", () => {
  assertEquals(
    proxyBuildArgs({ HTTPS_PROXY: "http://a", no_proxy: "x", RYPH_EGRESS_CLAIM: "c" }),
    [["HTTPS_PROXY", "http://a"], ["no_proxy", "x"]],
  );
});

test("safeName keeps a clean id and tells two dirty ones apart", () => {
  assertEquals(safeName("env-1"), "env-1");
  const a = safeName("Env_One");
  const b = safeName("env-one");
  assert(a !== b);
  assertMatch(a, /^[a-z0-9-]+$/);
  assert(safeName("x".repeat(100), 40).length <= 40);
});

test("the failure line is ours when we spoke, BuildKit's when we did not", () => {
  const bake = [
    '#13 0.514 ryph-bake: heartwood: setup step "build" failed (exit 101): boom',
    "ERROR: failed to build: failed to solve: process did not complete successfully",
  ].join("\n");
  assertEquals(
    failureLine(bake),
    'ryph-bake: heartwood: setup step "build" failed (exit 101): boom',
  );
  assertEquals(
    failureLine('ERROR: failed to build: failed to solve: "/secret.txt": not found'),
    '"/secret.txt": not found',
  );
  assertEquals(failureLine("fatal: repository 'x' not found"), "repository 'x' not found");
  assertEquals(failureLine("ryph: cloning a at 1 (main)"), null);
  // check-base's rg/fd warnings, read from the script itself: a base without them is common, so
  // they must never stand in for why a later step failed.
  const warnings = readFileSync(
    new URL("../../../images/harness/check-base.sh", import.meta.url),
    "utf8",
  )
    .split("\n")
    .flatMap((line) => line.match(/echo "(== warning: [^"]+)"/)?.[1] ?? [])
    .map((warning, i) => `#7 0.0${i} ${warning}`);
  assertEquals(warnings.length, 2);
  assertEquals(
    failureLine([...warnings, 'ERROR: failed to solve: "/secret.txt": not found'].join("\n")),
    '"/secret.txt": not found',
  );
  // What a build is doing is never why it failed: a re-layer that dies on its push says BuildKit's
  // reason, not the line naming the image it started from.
  assertEquals(
    failureLine(
      "ryph: re-layering r/e@sha256:3e7d\nerror: failed to solve: DeadlineExceeded: context deadline exceeded",
    ),
    "DeadlineExceeded: context deadline exceeded",
  );
});

test("the build log drops its head past the cap, never its tail", () => {
  const log = new BuildLog(100);
  for (let i = 0; i < 20; i++) log.append(`line ${i} ${"x".repeat(10)}`);
  const text = log.text();
  assertStringIncludes(text, "earlier characters dropped");
  assertStringIncludes(text, "line 19");
  assert(!text.includes("line 0 "));
  assertEquals(log.tail(1), `line 19 ${"x".repeat(10)}`);
});

test("setup warnings are read cleaned and bounded; a malformed record reads as unreadable", () => {
  const step = {
    kind: "step" as const,
    path: "api",
    step: "npm \u001b[1mci\u001b[0m",
    index: 1,
    total: 2,
    code: 1,
    output: "fetch via http://r:claim@egress:3128 failed\u0007",
    discarded: true,
  };
  assertEquals(
    parseSetupWarnings(JSON.stringify([
      step,
      { kind: "invalid", path: "web", error: "setup.yml: not valid YAML" },
      // not warnings: a path that is no repo path, a step with no exit code, an unknown kind
      { ...step, path: "../etc" },
      { ...step, code: "1" },
      { kind: "other", path: "api" },
    ])),
    [
      {
        ...step,
        step: "npm ci",
        output: "fetch via http://[redacted]@egress:3128 failed",
      },
      { kind: "invalid", path: "web", error: "setup.yml: not valid YAML" },
    ],
  );
  // A discard for another repo's failed step is read as its own entry.
  assertEquals(
    parseSetupWarnings(
      JSON.stringify([{ kind: "discarded", path: "web", after: ["api", "../x"] }]),
    ),
    [{ kind: "discarded", path: "web", after: ["api"] }],
  );
  // What a finished setup left in the tree, its file names cleaned.
  assertEquals(
    parseSetupWarnings(
      JSON.stringify([
        { kind: "dirty", path: "api", files: ["Cargo.lock", "gen/\u0007a.rs"] },
        { kind: "dirty", path: "web", files: [3] },
      ]),
    ),
    [{ kind: "dirty", path: "api", files: ["Cargo.lock", "gen/a.rs"] }],
  );
  // No record is no warnings; one that is there but cannot be read is never a clean bill.
  assertEquals(parseSetupWarnings(null), []);
  assertEquals(parseSetupWarnings("[]"), []);
  const unreadable = [{ kind: "unreadable", path: "" }];
  assertEquals(parseSetupWarnings("[{"), unreadable);
  assertEquals(parseSetupWarnings("{}"), unreadable);
  assertEquals(parseSetupWarnings(""), unreadable);
  assertEquals(parseSetupWarnings(JSON.stringify([{ kind: "other", path: "api" }])), unreadable);
});

test("a build's warnings keep only its own checkouts, an unreadable record named on the first", () => {
  const invalid = (path: string) => ({ kind: "invalid" as const, path, error: "bad" });
  assertEquals(
    setupWarningsForBuild([invalid("api"), invalid("forged"), invalid("api"), invalid("web")], [
      "api",
      "web",
    ]),
    [invalid("api"), invalid("web")],
  );
  assertEquals(setupWarningsForBuild([{ kind: "unreadable", path: "" }], ["api", "web"]), [
    { kind: "unreadable", path: "api" },
  ]);
  // One per repo AND kind: an invalid setup.yml and a discard in one repo both stand. A
  // discard's list is held to the build's repos, and goes when none is left.
  assertEquals(
    setupWarningsForBuild([
      invalid("api"),
      { kind: "discarded", path: "api", after: ["forged", "web"] },
      { kind: "discarded", path: "web", after: ["forged"] },
    ], ["api", "web"]),
    [invalid("api"), { kind: "discarded", path: "api", after: ["web"] }],
  );
  assertEquals(
    summarizeSetupWarning({ kind: "unreadable", path: "api" }, "the build went on"),
    "`api/`: the build's record of which setup.yml steps finished could not be read, so " +
      "setup.yml may not have finished, and the build went on. This is the platform's " +
      "problem, not the repo's: no change to .ryph/ fixes it.",
  );
});

test("a malformed toolchain record reads as none", () => {
  assertEquals(parseToolchains('{"rustc":"1.97.1","n":3}'), { rustc: "1.97.1" });
  assertEquals(parseToolchains("not json"), {});
  assertEquals(parseToolchains("[1]"), {});
});

const config = (builder: EnvironmentsConfig["builder"], registry: string | null = null) => ({
  ...DEFAULT_ENVIRONMENTS_CONFIG,
  enabled: true,
  builder,
  registry,
});

test("the factory builds the backend the configuration names", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(createEnvironmentBuilder(config("docker"), { env: env({}) }).kind, "docker");
  assertEquals(createEnvironmentBuilder(config("manual"), { env: env({}) }).kind, "manual");
  assertEquals(
    createEnvironmentBuilder(
      {
        ...config("kubernetes", "us-central1-docker.pkg.dev/p/ryph-envs"),
        branchRegistry: "us-central1-docker.pkg.dev/p/ryph-env-branches",
      },
      {
        env: env({
          RYPH_K8S_API_URL: "http://127.0.0.1:8001",
          RYPH_K8S_NAMESPACE: "ryph-runs",
          RYPH_K8S_RUNTIME_CLASS: "gvisor",
        }),
      },
    ).kind,
    "kubernetes",
  );
  // A registry a RUN step can reach the push credential of needs a second one for branches.
  assertThrows(
    () =>
      createEnvironmentBuilder(config("kubernetes", "us-central1-docker.pkg.dev/p/ryph-envs"), {
        env: env({
          RYPH_K8S_API_URL: "http://127.0.0.1:8001",
          RYPH_K8S_NAMESPACE: "ryph-runs",
          RYPH_K8S_RUNTIME_CLASS: "gvisor",
        }),
      }),
    Error,
    "RYPH_ENV_BRANCH_REGISTRY",
  );
  // An open one (a laptop cluster's) has nothing to steal, and may serve both.
  assertEquals(
    createEnvironmentBuilder(config("kubernetes", "registry.local:5000/envs"), {
      env: env({
        RYPH_K8S_API_URL: "http://127.0.0.1:8001",
        RYPH_K8S_NAMESPACE: "ryph-runs",
        RYPH_K8S_RUNTIME_CLASS: "gvisor",
      }),
    }).kind,
    "kubernetes",
  );
  assertThrows(
    () =>
      createEnvironmentBuilder(config("kubernetes"), {
        env: env({
          RYPH_K8S_API_URL: "http://127.0.0.1:8001",
          RYPH_K8S_NAMESPACE: "ryph-runs",
          RYPH_K8S_RUNTIME_CLASS: "gvisor",
        }),
      }),
    Error,
    "RYPH_ENV_REGISTRY",
  );
});

test("the kubernetes builder refuses to boot with no runtime class unless told it may", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const k8s = { RYPH_K8S_API_URL: "http://127.0.0.1:8001", RYPH_K8S_NAMESPACE: "ryph-runs" };
  const kubernetes = config("kubernetes", "registry.local:5000/envs");
  // A build's BuildKit is unconfined; with no runtime class that is the node's own kernel.
  assertThrows(
    () => createEnvironmentBuilder(kubernetes, { env: env(k8s) }),
    Error,
    "RYPH_ENV_BUILD_ALLOW_UNSANDBOXED=on",
  );
  // A class of the builds' own, or the runs', is the boundary.
  for (const name of ["RYPH_ENV_BUILD_RUNTIME_CLASS", "RYPH_K8S_RUNTIME_CLASS"]) {
    assertEquals(
      createEnvironmentBuilder(kubernetes, { env: env({ ...k8s, [name]: "gvisor" }) }).kind,
      "kubernetes",
    );
  }
  // The laptop cluster's opt-in boots, and says so.
  const warned: string[] = [];
  const diag = { debug() {}, warn: (event: string) => void warned.push(event) };
  assertEquals(
    createEnvironmentBuilder(kubernetes, {
      env: env({ ...k8s, RYPH_ENV_BUILD_ALLOW_UNSANDBOXED: "on" }),
      diag,
    }).kind,
    "kubernetes",
  );
  assertEquals(warned, ["environment_builder.unsandboxed"]);
  // Anything but on or off is a typo, not a yes.
  assertThrows(
    () =>
      createEnvironmentBuilder(kubernetes, {
        env: env({ ...k8s, RYPH_ENV_BUILD_ALLOW_UNSANDBOXED: "yes" }),
      }),
    Error,
    "must be",
  );
});

test("RYPH_ENV_IMAGE_REMOVAL=off leaves a builder nothing that deletes, on every backend", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const k8s = {
    RYPH_K8S_API_URL: "http://127.0.0.1:8001",
    RYPH_K8S_NAMESPACE: "ryph-runs",
    RYPH_K8S_RUNTIME_CLASS: "gvisor",
  };
  const kubernetes = {
    ...config("kubernetes", "us-central1-docker.pkg.dev/acme-dev/ryph-envs/ryph"),
    branchRegistry: "us-central1-docker.pkg.dev/acme-dev/ryph-env-branches/ryph",
  };
  const on = createEnvironmentBuilder(kubernetes, { env: env(k8s) });
  assert(on.removeImages !== undefined && on.reconcileImages !== undefined);
  const off = createEnvironmentBuilder(kubernetes, {
    env: env({ ...k8s, RYPH_ENV_IMAGE_REMOVAL: "off" }),
  });
  assertEquals(
    [off.removeImages, off.pruneCache, off.reconcileImages, off.removalStats],
    [undefined, undefined, undefined, undefined],
  );
  assertEquals(off.kind, "kubernetes");
  const docker = createEnvironmentBuilder(config("docker"), {
    env: env({ RYPH_ENV_IMAGE_REMOVAL: "OFF" }),
  });
  assertEquals(docker.removeImages, undefined);
  assertThrows(
    () =>
      createEnvironmentBuilder(config("docker"), { env: env({ RYPH_ENV_IMAGE_REMOVAL: "no" }) }),
    Error,
    "RYPH_ENV_IMAGE_REMOVAL",
  );
});

test("manual narrates the build it does not run, without the credential", async () => {
  const { diag, events } = recordingDiagnostics();
  const result = await createEnvironmentBuilder(config("manual"), { diag }).build(
    buildSpec({
      clone: { urls: { heartwood: "http://forge.test/h.git" }, env: { TOKEN: "s3cr3t" } },
    }),
    { signal: new AbortController().signal },
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.kind, "refused");
  const narration = String(
    events.find((e) => e.event === "environment_builder.manual")?.fields?.narration,
  );
  assertStringIncludes(narration, "bash clone.sh 'heartwood' 'http://forge.test/h.git' 'main'");
  assertStringIncludes(narration, "FROM ${RYPH_MACHINE} AS baked");
  assert(!narration.includes("s3cr3t"));
});

test("RYPH_ENV_BUILD_SIZE reads like a size class, and a bad one names itself", () => {
  const size = buildSizeFromEnv(() => undefined, failing);
  assertEquals([size.cpu, size.memory, size.workVolume], ["4", "8Gi", "50Gi"]);
  const custom = buildSizeFromEnv(
    (n) => n === "RYPH_ENV_BUILD_SIZE" ? "cpu=8,memory=16Gi" : undefined,
    failing,
  );
  assertEquals([custom.cpu, custom.memory, custom.workVolume], ["8", "16Gi", null]);
  assertThrows(
    () => buildSizeFromEnv((n) => n === "RYPH_ENV_BUILD_SIZE" ? "cpu=lots" : undefined, failing),
    Error,
    "RYPH_ENV_BUILD_SIZE",
  );
});

test("registry auth follows the registry unless named", () => {
  const unset = () => undefined;
  assertEquals(
    registryAuthFromEnv(unset, failing, "us-central1-docker.pkg.dev/p/ryph-envs"),
    "gke-metadata",
  );
  assertEquals(registryAuthFromEnv(unset, failing, "registry.local:5000/envs"), "none");
  assertEquals(
    registryAuthFromEnv(
      (n) => n === "RYPH_ENV_REGISTRY_AUTH" ? "none" : undefined,
      failing,
      "x.pkg.dev/p/r",
    ),
    "none",
  );
  assertThrows(
    () =>
      registryAuthFromEnv(
        (n) => n === "RYPH_ENV_REGISTRY_AUTH" ? "basic" : undefined,
        failing,
        "r",
      ),
    Error,
    "RYPH_ENV_REGISTRY_AUTH",
  );
});

test("the docker cache root defaults under the user's cache dir", () => {
  assertEquals(
    cacheDirFromEnv((n) => ({ HOME: "/home/u" } as Record<string, string>)[n]),
    "/home/u/.cache/ryph/environments",
  );
  assertEquals(cacheDirFromEnv((n) => n === "RYPH_ENV_CACHE_DIR" ? "/c" : undefined), "/c");
  assertEquals(cacheDirFromEnv(() => undefined), null);
});

test("every backend answers the adoption question, and a builder that builds nothing says gone", async () => {
  // The port has one implementation per backend and the core calls `adopt` on whichever is
  // configured: a backend that never started anything must say so rather than leave a row
  // `building` for ever.
  const spec = {
    environmentId: "env-1",
    subjectKey: "repo-abc",
    defaultBranch: true,
    relayerFrom: null,
    timeoutMs: 60_000,
  };
  const opts = { signal: new AbortController().signal };
  for (const kind of ["manual", "docker"] as const) {
    const builder = createEnvironmentBuilder(config(kind), {
      diag: recordingDiagnostics().diag,
      env: () => undefined,
    });
    assertEquals((await builder.adopt(spec, opts)).kind, "gone", kind);
  }
});
