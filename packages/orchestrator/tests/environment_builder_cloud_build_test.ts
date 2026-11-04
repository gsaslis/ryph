// The Cloud Build builder: the build it creates (steps, identities, the pool, the tag adoption
// finds it by), how it watches one to its end and reads the result out of the `build` step's
// lines, and what adopt and discard do with a build another process started.

import { test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildRequest,
  buildTag,
  cloudBuildEnvironmentBuilder,
  type CloudBuildOptions,
  literal,
  MAX_STEP_ARG,
  parsePool,
  proxyAddress,
  scriptFiles,
  stepLines,
  stepScriptPath,
  WRITE_SCRIPTS,
} from "../src/adapters/environment_builder/cloud_build.ts";
import { WORK } from "../src/adapters/environment_builder/buildkit_script.ts";
import type { BuildResult } from "../src/ports/environment_builder.ts";
import { buildSpec, silentDiagnostics } from "./doubles.ts";
import { runBuild } from "./buildkit_harness.ts";

const OPTS: CloudBuildOptions = {
  pool: "projects/acme-dev/locations/us-central1/workerPools/ryph-builds",
  logsBucket: "acme-dev-build-logs",
  branchLogsBucket: "acme-dev-branch-build-logs",
  serviceAccount: "ryph-builder@acme-dev.iam.gserviceaccount.com",
  branchServiceAccount: "ryph-branch-builder@acme-dev.iam.gserviceaccount.com",
  registry: "us-central1-docker.pkg.dev/acme-dev/ryph-envs/ryph",
  branchRegistry: "us-central1-docker.pkg.dev/acme-dev/ryph-env-branches/ryph",
  buildkitImage: "us-central1-docker.pkg.dev/acme-dev/ryph/buildkit@sha256:" + "c".repeat(64),
  disk: "500Gi",
  pollIntervalMs: 1,
  logWaitMs: 0,
};

const BUILDS =
  "https://cloudbuild.googleapis.com/v1/projects/acme-dev/locations/us-central1/builds";
const DIGEST = `sha256:${"1".repeat(64)}`;
const BAKED = `sha256:${"2".repeat(64)}`;

/** The script a step runs, as `prepare` writes it onto the volume: back out of its chunks. */
function stepScript(request: ReturnType<typeof buildRequest>, id: string): string {
  const step = request.steps.find((s) => s.id === id)!;
  assertEquals(step.args[0], stepScriptPath(id));
  const args = request.steps[0].args.slice(3).map((a) => a.replaceAll("$$", "$"));
  for (let at = 0; at < args.length;) {
    const [path, count] = [args[at], Number(args[at + 1])];
    const chunks = args.slice(at + 2, at + 2 + count);
    if (path === stepScriptPath(id)) return chunks.join("");
    at += 2 + count;
  }
  throw new Error(`no script for ${id}`);
}

/** A log as Cloud Build writes it: every step's line prefixed with its number and id. */
function cloudLog(build: string[], clone: string[] = ["ryph: cloning heartwood"]): string {
  return [
    "starting build",
    ...clone.map((l) => `Step #1 - "clone": ${l}`),
    ...build.map((l) => `Step #2 - "build": ${l}`),
    "DONE",
  ].join("\n") + "\n";
}

/** What the script hands Cloud Build as the build step's output. */
const RESULT = [
  `@@ryph-result digest ${DIGEST}`,
  `@@ryph-result baked ${BAKED}`,
  '@@ryph-result toolchains {"rustc":"1.97.1"}',
  `@@ryph-result setup-warnings ${'[{"kind":"invalid","path":"api","error":"setup.yml: not valid YAML"}]'}`,
].join("\n") + "\n";

/** A log that claims another image: what a branch build that reached the log bucket could write. */
const FORGED = `sha256:${"f".repeat(64)}`;
const SUCCESS_LOG = cloudLog([`@@ryph-result digest ${FORGED}`, `@@ryph-result baked ${FORGED}`]);

/** A fake Cloud Build + GCS: builds progress through the statuses given, one per poll. */
function fakeGoogle(opts: {
  statuses?: string[];
  log?: string | null;
  existing?: Array<{ id: string; status: string; createTime: string; tags: string[] }>;
  failCreate?: boolean;
  failList?: boolean;
} = {}) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const statuses = [...(opts.statuses ?? ["QUEUED", "WORKING", "SUCCESS"])];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url.startsWith("https://storage.googleapis.com/")) {
      return Promise.resolve(
        opts.log === null
          ? new Response("not found", { status: 404 })
          : new Response(opts.log ?? SUCCESS_LOG),
      );
    }
    if (method === "POST" && url === BUILDS) {
      if (opts.failCreate) return json({ error: { message: "PERMISSION_DENIED" } }, 403);
      return json({ metadata: { build: { id: "b-1" } } });
    }
    if (method === "GET" && url.startsWith(`${BUILDS}?filter=`)) {
      if (opts.failList) return json({ error: { message: "unavailable" } }, 503);
      const tag = decodeURIComponent(url.split("filter=")[1].split("&")[0]).match(/"(.+)"/)![1];
      return json({ builds: (opts.existing ?? []).filter((b) => b.tags.includes(tag)) });
    }
    if (method === "GET" && url.startsWith(`${BUILDS}/`)) {
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return json({
        id: url.split("/").at(-1),
        status,
        failureInfo: { detail: "step exited 1" },
        results: { buildStepOutputs: status === "SUCCESS" ? ["", "", btoa(RESULT)] : [] },
      });
    }
    if (method === "POST" && url.endsWith(":cancel")) return json({});
    return json({ error: "unexpected" }, 500);
  };
  const builder = cloudBuildEnvironmentBuilder(OPTS, silentDiagnostics(), {
    fetch: fetch as typeof globalThis.fetch,
    token: () => Promise.resolve("token"),
  });
  return { builder, requests };
}

const never = () => new AbortController().signal;

function expectOk(result: BuildResult) {
  if (!result.ok) throw new Error(`expected a built image, got: ${result.message}`);
  return result;
}

test("the pool names the project and region builds are created in", () => {
  assertEquals(parsePool(OPTS.pool), { project: "acme-dev", location: "us-central1" });
  assertEquals(parsePool("ryph-builds"), null);
  assertEquals(parsePool("projects/x/locations/y/workerPools/z;rm"), null);
});

test("the build: prepare, clone on the base image, then the rootful script, all on one volume", async () => {
  const spec = buildSpec({
    clone: {
      urls: { heartwood: "http://10.10.0.9:7412/git/h.git" },
      env: { GIT_CONFIG_COUNT: "1" },
    },
    proxyEnv: { HTTPS_PROXY: "http://env-1:claim@10.10.0.8:7460", NO_PROXY: "localhost" },
  });
  const request = buildRequest(spec, OPTS);
  assertEquals(request.steps.map((s) => s.id), ["prepare", "clone", "build"]);
  for (const step of request.steps) assertEquals(step.volumes, [{ name: "work", path: "/work" }]);
  assertEquals(request.steps[1].name, spec.baseImage);
  assert(request.steps[1].env!.includes("GIT_CONFIG_COUNT=1"), "the clone holds the credential");
  assert(!request.steps[2].env!.some((e) => e.startsWith("GIT_CONFIG")), "the build never does");
  assertEquals(request.steps[2].name, OPTS.buildkitImage);
  const script = stepScript(request, "build");
  assertStringIncludes(script, "readonly RYPH_DAEMON='rootful'");
  assert(request.steps[2].env!.includes("HTTPS_PROXY=http://env-1:claim@10.10.0.8:7460"));
  assert(
    request.steps[2].env!.includes(
      "NO_PROXY=localhost,169.254.169.254,metadata.google.internal," +
        "us-central1-docker.pkg.dev,registry.example",
    ),
    "buildkitd reaches the metadata server and the registries directly",
  );
  assert(request.steps[2].env!.includes("RYPH_STEP_NO_PROXY=localhost"), "a step does not");
  assert(
    request.steps[2].env!.some((e) => e.startsWith("BUILDKITD_FLAGS=--oci-worker-gc-keepstorage=")),
  );
  assertEquals(request.options, { pool: { name: OPTS.pool }, logging: "GCS_ONLY" });
  assertEquals(request.logsBucket, "gs://acme-dev-build-logs");
  assertEquals(request.timeout, `${60 * 60 + 120}s`);
  assert(request.tags.includes(buildTag("env-1")));
  // A step is root: buildkitd itself, no rootlesskit, on root's socket.
  await runBuild(script, (run) => {
    assertEquals(run.code, 0, run.stderr);
    assert(!run.calls.some((c) => c.startsWith("rootlesskit")), "a step is root: no rootlesskit");
    assertEquals(
      run.calls.find((c) => c.startsWith("buildkitd ")),
      "buildkitd --config=/work/buildkitd.toml --addr=unix:///run/buildkit/buildkitd.sock",
    );
  }, {
    env: { HTTPS_PROXY: "http://env-1:claim@10.10.0.8:7460", RYPH_STEP_NO_PROXY: "localhost" },
  });
});

test("every $ is the shell's: Cloud Build's substitution syntax is escaped", () => {
  assertEquals(literal("a $b ${c:-d} $$"), "a $$b $${c:-d} $$$$");
  const request = buildRequest(buildSpec(), OPTS);
  for (const step of request.steps) {
    for (const text of [...step.args, ...(step.env ?? [])]) {
      assert(
        !/(^|[^$])\$(\$\$)*[A-Za-z_{]/.test(text),
        `an unescaped substitution in ${text.slice(0, 60)}`,
      );
    }
  }
});

test("no step argument outgrows Cloud Build's cap, even an incremental workspace build's", () => {
  const paths = ["app", "api", "status-page"];
  const spec = buildSpec({
    dockerfileFrom: "api",
    checkouts: paths.map((path) => ({
      path,
      connectedRepoId: path,
      ref: "main",
      commit: "e".repeat(40),
    })),
    clone: {
      urls: Object.fromEntries(paths.map((p) => [p, `http://10.10.0.9:7412/git/${p}.git`])),
      env: {},
    },
    warmFrom: OPTS.registry + "@sha256:" + "d".repeat(64),
    proxyEnv: { HTTPS_PROXY: "http://env-1:claim@10.10.0.8:7460" },
  });
  const request = buildRequest(spec, OPTS);
  const build = stepScript(request, "build");
  assert(build.length > MAX_STEP_ARG, "the script alone is past the cap: the case this is for");
  for (const step of request.steps) {
    for (const arg of step.args) {
      const bytes = new TextEncoder().encode(arg).length;
      assert(bytes <= MAX_STEP_ARG, `${step.id}: ${bytes}`);
    }
  }
  // The clone's values are its step's arguments.
  assert(request.steps[1].args.includes("status-page"));
});

test("prepare writes every script back byte for byte, whatever falls on a chunk's edge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    const scripts: Array<[string, string]> = [
      // A `$` on the first cut and a surrogate pair astride the second.
      ["a", "x".repeat(2_999) + "$" + "y".repeat(2_999) + "\u{1F600}" + "-n" + "\n\n\n"],
      // A chunk that reads as a printf flag.
      ["b", "-n"],
      ["c", "%s \\c ${HOME} $((1 + 1))\n"],
      ["d", ""],
      // A lone surrogate at the end: what this guards is that the chunker ends at all (both sides
      // read it as U+FFFD, so the bytes prove nothing more).
      ["e", "ends high \uD83D"],
    ];
    const args = scriptFiles(scripts.map(([name, text]) => [`${WORK}/steps/${name}.sh`, text]));
    for (const arg of args) {
      assert(new TextEncoder().encode(arg).length <= MAX_STEP_ARG);
    }
    // As Cloud Build hands them to the step: each `$$` back to `$`, and /work where the test can write.
    const unescape = (text: string) => text.replaceAll("$$", "$").replaceAll(WORK, dir);
    const out = await command("sh", {
      args: ["-c", unescape(literal(WRITE_SCRIPTS)), "prepare", ...args.map(unescape)],
    }).output();
    assert(out.success, new TextDecoder().decode(out.stderr));
    for (const [name, text] of scripts) {
      const written = new Uint8Array(await readFile(`${dir}/steps/${name}.sh`));
      assertEquals(written, new TextEncoder().encode(text), name);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a branch build runs as the branch identity and pushes to the branch registry", () => {
  const request = buildRequest(buildSpec({ defaultBranch: false }), OPTS);
  assertEquals(
    request.serviceAccount,
    "projects/acme-dev/serviceAccounts/ryph-branch-builder@acme-dev.iam.gserviceaccount.com",
  );
  assertStringIncludes(stepScript(request, "build"), "ryph-env-branches/ryph/repo-abc:env-1");
  const main = buildRequest(buildSpec(), OPTS);
  assertEquals(
    main.serviceAccount,
    "projects/acme-dev/serviceAccounts/ryph-builder@acme-dev.iam.gserviceaccount.com",
  );
});

test("only the build step's lines count, with Cloud Build's prefix off", () => {
  const log = cloudLog(["@@ryph-result digest x"], ["@@ryph-result digest forged-in-clone"]);
  assertEquals(stepLines(log, "build"), "@@ryph-result digest x");
  assertEquals(stepLines(log, "clone"), "@@ryph-result digest forged-in-clone");
});

test("a build is watched to SUCCESS, its result read from the step's output, never its log", async () => {
  const { builder, requests } = fakeGoogle();
  const result = expectOk(await builder.build(buildSpec(), { signal: never() }));
  assertEquals(result.image, `${OPTS.registry}/repo-abc@${DIGEST}`, "never the log's claim");
  assertEquals(result.bakedImage, `${OPTS.registry}/repo-abc@${BAKED}`);
  assertEquals(result.toolchains, { rustc: "1.97.1" });
  // A setup.yml that did not finish rides the same output, as a warning on a successful build.
  assertEquals(result.setupWarnings, [
    { kind: "invalid", path: "api", error: "setup.yml: not valid YAML" },
  ]);
  assertEquals(requests[0].method, "POST");
  assert(
    requests.some((r) => r.url.endsWith("/o/log-b-1.txt?alt=media")),
    "the log is read from the bucket",
  );
  assert(!requests.some((r) => r.url.endsWith(":cancel")), "a finished build is not cancelled");
});

test("a failed build says what the build step said", async () => {
  const { builder } = fakeGoogle({
    statuses: ["WORKING", "FAILURE"],
    log: cloudLog(["#9 12.1 ryph-bake: heartwood: step 2 (cargo build) exited 101"]),
  });
  const result = await builder.build(buildSpec(), { signal: never() });
  assert(!result.ok);
  assertStringIncludes(result.message, "FAILURE");
  assertStringIncludes(result.message, "cargo build) exited 101");
});

test("a log that cannot be read is said in the log, and costs the build nothing", async () => {
  const { builder } = fakeGoogle({ log: null });
  const result = expectOk(await builder.build(buildSpec(), { signal: never() }));
  assertStringIncludes(result.log, "could not be read from gs://acme-dev-build-logs");
});

test("a branch build logs to the branch bucket, and is read back from there", async () => {
  assertEquals(
    buildRequest(buildSpec({ defaultBranch: false }), OPTS).logsBucket,
    "gs://acme-dev-branch-build-logs",
  );
  const { builder, requests } = fakeGoogle();
  expectOk(await builder.build(buildSpec({ defaultBranch: false }), { signal: never() }));
  assert(requests.some((r) => r.url.includes("/b/acme-dev-branch-build-logs/o/log-b-1.txt")));
});

test("a refused create is a failed build, and nothing is left running", async () => {
  const { builder, requests } = fakeGoogle({ failCreate: true });
  const result = await builder.build(buildSpec(), { signal: never() });
  assert(!result.ok);
  assertStringIncludes(result.message, "could not start the build");
  // A create whose answer was lost may still have started one: it is looked for, and there is
  // none to cancel here.
  assertEquals(requests.map((r) => r.method), ["POST", "GET"]);
  assert(requests[1].url.includes("filter="));
});

test("a create that failed after all cancels the build it started", async () => {
  const tag = buildTag("env-1");
  const { builder, requests } = fakeGoogle({
    failCreate: true,
    existing: [{ id: "b-5", status: "QUEUED", createTime: "2026-09-29T10:00:00Z", tags: [tag] }],
  });
  assert(!(await builder.build(buildSpec(), { signal: never() })).ok);
  assert(requests.some((r) => r.url === `${BUILDS}/b-5:cancel`));
});

test("a step reaches the proxy and the metadata resolver, and nothing else", async () => {
  const spec = buildSpec({ proxyEnv: { HTTPS_PROXY: "http://env-1:claim@10.10.0.19:7460" } });
  const script = stepScript(buildRequest(spec, OPTS), "build");
  await runBuild(script, async (run) => {
    assertEquals(run.code, 0, run.stderr);
    // The steps on a bridge of their own, whose one resolver is the metadata server's.
    assertEquals(
      await run.file("buildkitd.toml"),
      [
        "[worker.oci]",
        '  networkMode = "bridge"',
        '  bridgeName = "ryph0"',
        '  bridgeSubnet = "172.30.0.0/16"',
        "[dns]",
        '  nameservers = ["169.254.169.254"]',
        "",
      ].join("\n"),
    );
    assertStringIncludes(
      run.calls.find((c) => c.startsWith("buildkitd "))!,
      "--config=/work/buildkitd.toml",
    );
    // Its own chain in `mangle`, where CNI never writes: the proxy and DNS go on, the rest drops.
    // Set before any pass, and checked again before every one.
    const passAt = run.calls.findIndex((c) => c.startsWith("buildctl build "));
    assertEquals(run.calls.slice(0, passAt).filter((c) => c.startsWith("iptables")), [
      "iptables -t mangle -N RYPH-STEPS",
      "iptables -t mangle -A RYPH-STEPS -d 10.10.0.19 -p tcp --dport 7460 -j RETURN",
      "iptables -t mangle -A RYPH-STEPS -d 169.254.169.254 -p udp --dport 53 -j RETURN",
      "iptables -t mangle -A RYPH-STEPS -d 169.254.169.254 -p tcp --dport 53 -j RETURN",
      "iptables -t mangle -A RYPH-STEPS -j DROP",
      "iptables -t mangle -I PREROUTING 1 -i ryph0 -j RYPH-STEPS",
      "iptables -t mangle -C PREROUTING -i ryph0 -j RYPH-STEPS",
      "iptables -t mangle -C RYPH-STEPS -j DROP",
    ]);
    const checks = run.calls.filter((c) => c.startsWith("iptables -t mangle -C PREROUTING"));
    const passes = run.calls.filter((c) => c.startsWith("buildctl build "));
    assertEquals(checks.length, passes.length);
    assert(!run.calls.some((c) => c.includes("FORWARD")), "never in the chains CNI rewrites");
  }, { env: { HTTPS_PROXY: "http://env-1:claim@10.10.0.19:7460" } });
  assertStringIncludes(script, "could not be confined");
  assert(!script.includes("claim@"), "the claim's secret is never in the rules");
});

test("the proxy's address, from the spec's HTTPS proxy", () => {
  assertEquals(proxyAddress({ HTTPS_PROXY: "http://u:p@10.10.0.19:7460" }), {
    host: "10.10.0.19",
    port: 7460,
  });
  assertEquals(proxyAddress({ https_proxy: "http://proxy.internal" }), {
    host: "proxy.internal",
    port: 80,
  });
  assertEquals(proxyAddress({}), null);
});

test("an aborted build is cancelled at Cloud Build", async () => {
  const { builder, requests } = fakeGoogle({ statuses: ["WORKING"] });
  const controller = new AbortController();
  const pending = builder.build(buildSpec(), { signal: controller.signal });
  controller.abort("superseded");
  const result = await pending;
  assert(!result.ok);
  assertStringIncludes(result.message, "cancelled");
  assert(requests.some((r) => r.method === "POST" && r.url === `${BUILDS}/b-1:cancel`));
});

test("adopt: a build found by its tag is watched to its end; none is gone; no answer is unknown", async () => {
  const tag = buildTag("env-1");
  const found = fakeGoogle({
    existing: [{ id: "b-9", status: "WORKING", createTime: "2026-09-29T10:00:00Z", tags: [tag] }],
  });
  const adopted = await found.builder.adopt(
    {
      environmentId: "env-1",
      subjectKey: "repo-abc",
      defaultBranch: true,
      relayerFrom: null,
      timeoutMs: 60_000,
    },
    { signal: never() },
  );
  assertEquals(adopted.kind, "settled");
  if (adopted.kind === "settled") expectOk(adopted.result);
  assert(found.requests.some((r) => r.url === `${BUILDS}/b-9`));

  const none = fakeGoogle();
  assertEquals(
    (await none.builder.adopt(
      {
        environmentId: "env-1",
        subjectKey: "repo-abc",
        defaultBranch: true,
        relayerFrom: null,
        timeoutMs: 60_000,
      },
      { signal: never() },
    )).kind,
    "gone",
  );

  const down = fakeGoogle({ failList: true });
  assertEquals(
    (await down.builder.adopt(
      {
        environmentId: "env-1",
        subjectKey: "repo-abc",
        defaultBranch: true,
        relayerFrom: null,
        timeoutMs: 60_000,
      },
      { signal: never() },
    )).kind,
    "unknown",
  );
});

test("discard cancels a build still running, and leaves a finished one be", async () => {
  const tag = buildTag("env-1");
  const running = fakeGoogle({
    existing: [{ id: "b-3", status: "WORKING", createTime: "2026-09-29T10:00:00Z", tags: [tag] }],
  });
  await running.builder.discard("env-1");
  assert(running.requests.some((r) => r.url === `${BUILDS}/b-3:cancel`));

  const done = fakeGoogle({
    existing: [{ id: "b-4", status: "SUCCESS", createTime: "2026-09-29T10:00:00Z", tags: [tag] }],
  });
  await done.builder.discard("env-1");
  assert(!done.requests.some((r) => r.url.endsWith(":cancel")));
  await fakeGoogle().builder.discard("env-never");
});

test("liveLog: the running build's log object as it stands, prefixes off; nothing found is null", async () => {
  const tag = buildTag("env-1");
  const { builder, requests } = fakeGoogle({
    existing: [{ id: "b-7", status: "WORKING", createTime: "2026-09-29T10:00:00Z", tags: [tag] }],
    log: cloudLog(["#5 3.1 Compiling serde"]),
  });
  const live = await builder.liveLog({ environmentId: "env-1", defaultBranch: true });
  assertStringIncludes(live!, "#5 3.1 Compiling serde");
  assert(!live!.includes('Step #2 - "build"'), "Cloud Build's prefix is taken off");
  assert(requests.some((r) => r.url.includes("/b/acme-dev-build-logs/o/log-b-7.txt")));
  assertEquals(
    await fakeGoogle().builder.liveLog({ environmentId: "env-1", defaultBranch: true }),
    null,
  );
  assertEquals(
    await fakeGoogle({ failList: true }).builder.liveLog({
      environmentId: "env-1",
      defaultBranch: true,
    }),
    null,
    "an API that does not answer is nothing to show, never a throw",
  );
});
