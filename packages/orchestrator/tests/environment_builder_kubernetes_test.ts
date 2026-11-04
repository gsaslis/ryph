// The kubernetes environment builder: the Job it writes (the contract with the build pod), the
// script BuildKit runs, and a build's life against a fake API server — created suspended, its
// Secret owned by it, released, watched, read back, and deleted when it runs out of time or is
// cancelled.

import { test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "@ryph/process";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildJobManifest,
  buildJobName,
  buildLines,
  buildScript,
  buildSecretManifest,
  credentialHelper,
  gcKeepStorage,
  initScript,
  type KubernetesBuilderOptions,
  kubernetesEnvironmentBuilder,
  resultLines,
  scriptOptions,
} from "../src/adapters/environment_builder/kubernetes.ts";
import {
  LAYER_COMPRESSION,
  readScriptResult,
} from "../src/adapters/environment_builder/buildkit_script.ts";
import type { AdoptResult, AdoptSpec, BuildResult } from "../src/ports/environment_builder.ts";
import { runBuild, STUB_DIGESTS } from "./buildkit_harness.ts";
import { shellBody } from "../src/helpers/shell.ts";
import { WRITE_SCRIPTS } from "../src/adapters/environment_builder/cloud_build.ts";
import { cloneScript } from "../src/adapters/environment_builder/dockerfile.ts";
import { BUILD_COMMIT as COMMIT, buildSpec, silentDiagnostics, UNSIZED } from "./doubles.ts";

const OPTS: KubernetesBuilderOptions = {
  apiUrl: "https://kube.test",
  tokenFile: null,
  caFile: null,
  namespace: "ryph-builds",
  serviceAccount: "ryph-builder",
  branchServiceAccount: "ryph-branch-builder",
  runtimeClass: "gvisor",
  registry: "us-central1-docker.pkg.dev/p/ryph-envs",
  branchRegistry: "us-central1-docker.pkg.dev/p/ryph-env-branches",
  buildkitImage: "moby/buildkit:rootless",
  size: { ...UNSIZED, name: "build", cpu: "4", memory: "8Gi", workVolume: "50Gi" },
  volumeClass: "standard-rwo",
  registryAuth: "gke-metadata",
  pollIntervalMs: 1,
};

const DIGEST = "sha256:" + "d".repeat(64);
const BAKED = "sha256:" + "c".repeat(64);

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

interface Recorded {
  method: string;
  path: string;
  body: Json;
}

/** A fake API server: `answer` decides each reply; every request is recorded in order. */
function fakeApi(
  answer: (req: Recorded) => { status: number; body?: Json; text?: string } | undefined,
) {
  const requests: Recorded[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const req: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(req);
    const reply = answer(req) ?? { status: 200, body: {} };
    const body = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return Promise.resolve(new Response(body, { status: reply.status }));
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const JOBS = "/apis/batch/v1/namespaces/ryph-builds/jobs";
const NAME = buildJobName("env-1");

/** A cluster where the build runs `polls` times before it reaches `condition`. */
function cluster(
  opts: { condition?: "Complete" | "Failed" | null; buildkitLog?: string; cloneLog?: string } = {},
) {
  const condition = opts.condition === undefined ? "Complete" : opts.condition;
  const buildkitLog = opts.buildkitLog ??
    [
      "#1 [internal] load build definition",
      // A build step printing the marker: prefixed by BuildKit, so never a result line.
      `#12 0.51 @@ryph-result digest sha256:${"e".repeat(64)}`,
      `@@ryph-result digest ${DIGEST}`,
      `@@ryph-result baked ${BAKED}`,
      '@@ryph-result toolchains {"rustc": "1.97.1"}',
      `@@ryph-result setup-warnings ${'[{"kind":"invalid","path":"api","error":"setup.yml: not valid YAML"}]'}`,
    ].join("\n");
  return fakeApi((req) => {
    if (req.method === "POST" && req.path === JOBS) {
      return {
        status: 201,
        body: { ...req.body, metadata: { ...req.body.metadata, uid: "job-uid" } },
      };
    }
    if (req.method === "GET" && req.path === `${JOBS}/${NAME}`) {
      return {
        status: 200,
        body: {
          status: condition === null ? {} : {
            conditions: [{
              type: condition,
              status: "True",
              reason: condition === "Failed" ? "BackoffLimitExceeded" : undefined,
            }],
          },
        },
      };
    }
    if (req.method === "GET" && req.path.startsWith("/api/v1/namespaces/ryph-builds/pods?")) {
      return {
        status: 200,
        body: { items: [{ metadata: { name: `${NAME}-abcde` }, status: { phase: "Succeeded" } }] },
      };
    }
    if (req.path.endsWith("/log?container=buildkit")) return { status: 200, text: buildkitLog };
    if (req.path.endsWith("/log?container=clone")) {
      return { status: 200, text: opts.cloneLog ?? "ryph: cloning heartwood at x (main)\n" };
    }
    return undefined;
  });
}

function expectOk(result: BuildResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.kind}: ${result.message}`);
  return result;
}
function expectFailure(result: BuildResult) {
  if (result.ok) throw new Error("expected a failure");
  return result;
}

test("the build Job: suspended, sandboxed, tokenless, retried never, capped in time", () => {
  const spec = buildSpec({ timeoutMs: 60 * 60 * 1000 });
  const job = buildJobManifest(spec, OPTS);
  assertEquals(job.metadata.name, NAME);
  assertEquals(job.metadata.namespace, "ryph-builds");
  assertEquals(job.metadata.labels["app.kubernetes.io/component"], "environment-build");
  const s = job.spec as Json;
  assertEquals(s.suspend, true);
  assertEquals(s.backoffLimit, 0);
  assertEquals(s.activeDeadlineSeconds, 3600 + 120);
  const pod = s.template.spec;
  assertEquals(pod.serviceAccountName, "ryph-builder");
  assertEquals(pod.automountServiceAccountToken, false);
  // Named, never the cluster's globalDefault: real work must outrank reserved capacity.
  assertEquals(pod.priorityClassName, "ryph-workload");
  assertEquals(pod.enableServiceLinks, false);
  assertEquals(pod.runtimeClassName, "gvisor");
  assertEquals(pod.restartPolicy, "Never");
  assertEquals(pod.template, undefined);
  // The disk BuildKit's state and the clones share, from the size's work volume.
  assertEquals(
    pod.volumes[0].ephemeral.volumeClaimTemplate.spec.resources.requests.storage,
    "50Gi",
  );
  assertEquals(pod.volumes[0].ephemeral.volumeClaimTemplate.spec.storageClassName, "standard-rwo");
});

test("a build with no runtime class is refused unless unsandboxed builds are allowed", () => {
  // BuildKit's seccomp and AppArmor are unconfined, so the runtime class is a build's one boundary.
  const { runtimeClass: _, ...bare } = OPTS;
  assertThrows(
    () => kubernetesEnvironmentBuilder(bare, silentDiagnostics()),
    Error,
    "RuntimeClass",
  );
  assertThrows(
    () => buildJobManifest(buildSpec(), { ...bare, runtimeClass: "" }),
    Error,
    "RYPH_ENV_BUILD_ALLOW_UNSANDBOXED",
  );
  assertThrows(() => buildJobManifest(buildSpec(), { ...bare, allowUnsandboxed: false }), Error);
  const pod = (buildJobManifest(buildSpec(), { ...bare, allowUnsandboxed: true }).spec as Json)
    .template.spec;
  assertEquals("runtimeClassName" in pod, false);
  assertEquals(
    kubernetesEnvironmentBuilder({ ...bare, allowUnsandboxed: true }, silentDiagnostics())
      .kind,
    "kubernetes",
  );
});

test("the clone runs first, on the base image, with the credential from the Secret", () => {
  const spec = buildSpec({
    clone: { urls: { heartwood: "http://forge/h.git" }, env: { GIT_CONFIG_COUNT: "1" } },
  });
  const pod = (buildJobManifest(spec, OPTS).spec as Json).template.spec;
  const [clone] = pod.initContainers;
  assertEquals(clone.name, "clone");
  assertEquals(clone.image, spec.baseImage);
  assertEquals(clone.securityContext.allowPrivilegeEscalation, false);
  assertEquals(clone.securityContext.runAsNonRoot, true);
  assertEquals(
    clone.env.find((e: Json) => e.name === "GIT_CONFIG_COUNT").valueFrom.secretKeyRef,
    { name: NAME, key: "clone.GIT_CONFIG_COUNT" },
  );
  // The manifest names the credential's key, never its value.
  const script: string = clone.command[2];
  assertStringIncludes(script, "base64 -d > /work/outer/Dockerfile");
  assertEquals(initScript(spec), script);
  // What it clones are the script's arguments, never its text.
  assertEquals(clone.command.slice(3), ["init", "heartwood", "http://forge/h.git", "main", COMMIT]);
  assert(!script.includes("http://forge/h.git"));
});

test("BuildKit runs rootless, its registry traffic through the proxy", () => {
  const spec = buildSpec({
    proxyEnv: { HTTPS_PROXY: "http://env-1:claim@egress:7460", NO_PROXY: "forge.ryph.svc" },
  });
  const pod = (buildJobManifest(spec, OPTS).spec as Json).template.spec;
  const [buildkit] = pod.containers;
  assertEquals(buildkit.image, "moby/buildkit:rootless");
  assertEquals(buildkit.securityContext.runAsUser, 1000);
  assertEquals(buildkit.securityContext.runAsNonRoot, true);
  assertEquals(buildkit.securityContext.seccompProfile, { type: "Unconfined" });
  assertEquals(buildkit.resources.limits, { cpu: "4", memory: "8Gi" });
  const env = Object.fromEntries(buildkit.env.map((e: Json) => [e.name, e.value ?? e.valueFrom]));
  // `native` is not a preference: an overlay snapshotter dies on the first `COPY --from` under
  // gVisor, measured on GKE Autopilot. See DEFAULT_SNAPSHOTTER. The GC policy is the work volume's
  // own — buildkitd's default would start throwing this build's layers away at 39 of its 50
  // gigabytes, and under `native` every one thrown away is extracted again. See gcKeepStorage.
  assertEquals(
    env.BUILDKITD_FLAGS,
    "--oci-worker-no-process-sandbox --oci-worker-snapshotter=native " +
      "--oci-worker-gc-keepstorage=42949,2684,48318",
  );
  assertEquals(env.HTTPS_PROXY, { secretKeyRef: { name: NAME, key: "proxy.HTTPS_PROXY" } });
  // Not a secret, and the metadata server is reached around the proxy — by buildkitd's
  // credential helper. A build step's NO_PROXY is the spec's own, without it.
  assertEquals(env.NO_PROXY, "forge.ryph.svc,169.254.169.254,metadata.google.internal");
  assertEquals(env.RYPH_STEP_NO_PROXY, "forge.ryph.svc");
  assertStringIncludes(buildkit.command[2], '--opt "build-arg:NO_PROXY=${RYPH_STEP_NO_PROXY}"');
  // The claim is in the Secret and nowhere in the Job.
  assert(!JSON.stringify(buildJobManifest(spec, OPTS)).includes("claim@"));
  const secret = buildSecretManifest(spec, OPTS, "job-uid");
  assertEquals(secret.stringData, { "proxy.HTTPS_PROXY": "http://env-1:claim@egress:7460" });
  assertEquals(secret.metadata.ownerReferences[0].uid, "job-uid");
});

test("one buildkitd for every pass, started by the script and shut down with it", async () => {
  const script = buildScript(buildSpec(), scriptOptions(OPTS));
  // Upstream's daemonless helper starts a buildkitd per buildctl, and the next pass re-extracts
  // the whole base image; MEASURED locally at 8.8 minutes a pass against 12 seconds warm.
  assert(!script.includes("buildctl-daemonless.sh"), "no daemon per pass");
  const env = { BUILDKITD_FLAGS: "--oci-worker-snapshotter=native --x=1" };
  await runBuild(script, (run) => {
    assertEquals(run.code, 0, run.stderr);
    // Rootless, the backend's flags split into words, on the socket every pass then talks to.
    assertEquals(run.calls.filter((c) => c.startsWith("rootlesskit ")), [
      "rootlesskit buildkitd --oci-worker-snapshotter=native --x=1 " +
      "--addr=unix:///run/user/1000/buildkit/buildkitd.sock",
    ]);
    // The machine, the environment, its baked stage, its toolchains: four passes, one daemon.
    assertEquals(run.calls.filter((c) => c.startsWith("buildctl build ")).length, 4);
    // Whatever ends the script says what the build left on the volume.
    assertStringIncludes(run.stderr, "== work volume ");
  }, { env });
  // Readiness, and a daemon that died before it was ready ends the build with its log.
  await runBuild(script, (run) => {
    assertEquals(run.code, 1);
    assertStringIncludes(run.stderr, "ryph: buildkitd did not start");
    assertStringIncludes(run.stderr, "== buildkitd log ==");
    assert(!run.calls.some((c) => c.startsWith("buildctl build ")), "no pass without a daemon");
  }, { env, daemonDies: true });
  // The heading is not a `ryph:` line: failureLine reads the last of those as the reason.
  assert(!script.includes("ryph: buildkitd log"));
});

// The pod's shell pieces, run for real: `sh` with /work moved to a scratch directory and the tool
// they call replaced by a script that answers from a queue. `answers` is one script per call, and
// the stub records how many calls there were.
async function runShell(
  script: string,
  tool: string,
  answers: string[],
): Promise<{ code: number; stdout: string; stderr: string; calls: number }> {
  const dir = await mkdtemp(join(tmpdir(), "ryph-"));
  try {
    await mkdir(`${dir}/bin`);
    await mkdir(`${dir}/work/out`, { recursive: true });
    for (const [i, answer] of answers.entries()) {
      await writeFile(`${dir}/answer-${i + 1}`, answer);
    }
    await writeFile(
      `${dir}/bin/${tool}`,
      [
        "#!/bin/sh",
        `n=$(($(cat ${dir}/calls 2>/dev/null || echo 0) + 1))`,
        `echo "$n" > ${dir}/calls`,
        `. ${dir}/answer-$n`,
      ].join("\n"),
    );
    await chmod(`${dir}/bin/${tool}`, 0o755);
    // `sleep` too, so the waits between attempts cost the test nothing.
    await writeFile(`${dir}/bin/sleep`, "#!/bin/sh\n");
    await chmod(`${dir}/bin/sleep`, 0o755);
    const out = await command("sh", {
      args: ["-c", script.replaceAll("/work", `${dir}/work`)],
      env: { PATH: `${dir}/bin:${process.env.PATH}` },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = out.stdin.getWriter();
    await writer.write(new TextEncoder().encode("us-central1-docker.pkg.dev\n"));
    await writer.close();
    const { code, stdout, stderr } = await out.output();
    const calls = Number(await readFile(`${dir}/calls`, "utf8").catch(() => "0"));
    const text = new TextDecoder();
    return { code, stdout: text.decode(stdout), stderr: text.decode(stderr), calls };
  } finally {
    await rm(dir, { recursive: true });
  }
}

const PUSH_FAILED = [
  'echo "#12 pushing layers 60.5s done"',
  'echo "#12 ERROR: failed to push r/e:env-1: failed to authorize: DeadlineExceeded: context deadline exceeded"',
  'echo "error: failed to solve: DeadlineExceeded: context deadline exceeded" >&2',
  "exit 1",
].join("\n");
const BUILT = 'echo "#12 pushing manifest done"';
const passes = (answers: string[]) =>
  runShell(`set -eu\n${buildLines().join("\n")}\nbuild --opt x`, "buildctl", answers);

test("a pass whose push failed runs again from the cache, and the build goes on", async () => {
  const { code, stdout, stderr, calls } = await passes([PUSH_FAILED, PUSH_FAILED, BUILT]);
  assertEquals(code, 0);
  assertEquals(calls, 3);
  assertStringIncludes(stdout, "pushing manifest done");
  assertStringIncludes(
    stderr,
    "== the push failed; pushing again (attempt 3 of 3) ==",
  );
  // Not a `ryph:` line, so it is never taken for the reason a build failed.
  assert(!stderr.includes("ryph:"));
});

test("a push that keeps failing fails the build with buildctl's own status", async () => {
  const { code, calls } = await passes([PUSH_FAILED, PUSH_FAILED, PUSH_FAILED, BUILT]);
  assertEquals(code, 1);
  assertEquals(calls, 3);
});

test("a step that failed is not retried, whatever its command or its output said", async () => {
  // What a step prints carries its seconds; what it ran is quoted inside `ERROR: process "…"`.
  // Neither is BuildKit saying the push failed.
  const step = [
    'echo "#10 12.03 ERROR: failed to push: this is the build\'s own output"',
    'echo "#10 ERROR: process \\"/bin/sh -c echo failed to push\\" did not complete successfully: exit code: 2"',
    'echo "error: failed to solve: process did not complete successfully: exit code: 2" >&2',
    "exit 2",
  ].join("\n");
  const { code, calls } = await passes([step, BUILT]);
  assertEquals(code, 2);
  assertEquals(calls, 1);
});

test("a cache import that could not authorize does not make a later failure retry", async () => {
  // BuildKit carries on without a cache it could not import, and the pass fails later on a step:
  // only the error that ended the pass decides, or the failing step would run three times.
  const step = [
    'echo "#5 importing cache manifest from r/cache:environment"',
    'echo "#5 ERROR: failed to authorize: DeadlineExceeded: context deadline exceeded"',
    'echo "#10 ERROR: process \\"/bin/sh -c make\\" did not complete successfully: exit code: 2"',
    'echo "error: failed to solve: process \\"/bin/sh -c make\\" did not complete successfully: exit code: 2" >&2',
    "exit 2",
  ].join("\n");
  const { code, calls } = await passes([step, BUILT]);
  assertEquals(code, 2);
  assertEquals(calls, 1);
});

test("a cache import that could not authorize, then a push that could not either, retries", async () => {
  const both = [
    'echo "#5 ERROR: failed to authorize: DeadlineExceeded: context deadline exceeded"',
    PUSH_FAILED,
  ].join("\n");
  const { code, calls } = await passes([both, BUILT]);
  assertEquals(code, 0);
  assertEquals(calls, 2);
});

test("a pass buildctl finished stands even when its log could not be written", async () => {
  // /work full is the real case: the log is where tee writes, and its failure is not the build's.
  const broken = (answers: string[]) =>
    runShell(
      `set -eu\nmkdir -p /work/out/pass.log\n${buildLines().join("\n")}\nbuild --opt x`,
      "buildctl",
      answers,
    );
  assertEquals((await broken([BUILT])).code, 0);
  // And a pass that failed still fails with buildctl's own status, not tee's.
  const failed = await broken(['echo "#10 ERROR: process \\"make\\" did not complete"\nexit 2']);
  assertEquals(failed.code, 2);
  assertEquals(failed.calls, 1);
});

const helper = (answers: string[]) =>
  runShell(`set -- get\n${credentialHelper()}`, "wget", answers);

test("the credential helper asks the metadata server again when an ask fails", async () => {
  const { code, stdout, calls } = await helper([
    "exit 1",
    "exit 0",
    `echo '{"access_token":"ya29.token","expires_in":3599,"token_type":"Bearer"}'`,
  ]);
  assertEquals(code, 0);
  assertEquals(calls, 3);
  assertEquals(
    JSON.parse(stdout),
    {
      ServerURL: "us-central1-docker.pkg.dev",
      Username: "oauth2accesstoken",
      Secret: "ya29.token",
    },
  );
  // Every ask is cut off rather than left to wait on BuildKit's deadline.
  assertStringIncludes(credentialHelper(), "wget -q -T 5 ");
});

test("the credential helper gives up after three asks and says why", async () => {
  const { code, stderr, calls } = await helper(["exit 1", "exit 1", "exit 1", "exit 1"]);
  assertEquals(code, 1);
  assertEquals(calls, 3);
  assertStringIncludes(stderr, "ryph: no token from the metadata server");
});

test("the GC policy is the work volume's; a build with none keeps buildkitd's default", () => {
  assertEquals(gcKeepStorage("50Gi"), "42949,2684,48318");
  assertEquals(gcKeepStorage("20Gi"), "17179,1073,19326");
  // No volume of its own (emptyDir): the disk is the node's and so is the policy.
  assertEquals(gcKeepStorage(null), null);
  // Too small to be worth a policy, and not a quantity at all.
  assertEquals(gcKeepStorage("512Mi"), null);
  assertEquals(gcKeepStorage("lots"), null);
  const unsized = { ...OPTS, size: { ...OPTS.size, workVolume: null } };
  const env = (buildJobManifest(buildSpec(), unsized).spec as Json).template.spec
    .containers[0].env;
  assertEquals(
    env.find((e: Json) => e.name === "BUILDKITD_FLAGS").value,
    "--oci-worker-no-process-sandbox --oci-worker-snapshotter=native",
  );
});

test("the build script: machine, environment, baked stage; the scope it may write", async () => {
  const spec = buildSpec({
    cacheScope: { read: ["repo-abc-default"], write: "repo-abc-default" },
    proxyEnv: { HTTPS_PROXY: "http://p" },
  });
  const script = buildScript(spec, scriptOptions(OPTS));
  const reg = "us-central1-docker.pkg.dev/p/ryph-envs";
  // The repo's Dockerfile, with the universal image mapped to the pinned copy.
  assertStringIncludes(script, "--local context=/work/checkout/heartwood");
  assertStringIncludes(script, "--local dockerfile=/work/checkout/heartwood/.ryph");
  assertStringIncludes(
    script,
    `'context:quay.io/ryph/ryph-universal:1=docker-image://${spec.baseImage}'`,
  );
  assertStringIncludes(
    script,
    `'type=image,name=${reg}/repo-abc:machine-env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  // The environment on the machine's digest, the clones as `checkout`.
  assert(!script.includes("SOURCE_DATE_EPOCH"), "the repo's own steps keep their clock");
  assertStringIncludes(script, 'machine_digest="$(digest /work/out/machine.json)"');
  assertStringIncludes(script, `machine='${reg}/repo-abc@'"$machine_digest"`);
  assertStringIncludes(script, '--opt build-arg:RYPH_MACHINE="$machine"');
  assertStringIncludes(script, '--opt "build-arg:RYPH_MACHINE_DIGEST=$machine_digest"');
  // The pod's NetworkPolicy holds its steps; nothing is confined in the script.
  assertStringIncludes(script, "readonly RYPH_CONFINE_STEPS=''");
  assertStringIncludes(script, "--opt context:checkout=local:checkout");
  assertStringIncludes(
    script,
    `'type=image,name=${reg}/repo-abc:env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  // The lower half kept for a later re-layer.
  assertStringIncludes(script, "--opt target=baked");
  assertStringIncludes(
    script,
    `'type=image,name=${reg}/repo-abc:baked-env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  // The default branch reads and writes its subject's scope.
  assertStringIncludes(script, `type=registry,ref=${reg}/cache:repo-abc-default-environment'`);
  assertStringIncludes(
    script,
    `type=registry,ref=${reg}/cache:repo-abc-default-environment,mode=max`,
  );
  assertStringIncludes(script, `type=registry,ref=${reg}/cache:repo-abc-default-machine,mode=max`);
  // Every layer pushed, images and cache alike, is zstd: one compression, so one blob per layer.
  assertEquals(
    script.match(/type=(image|registry),[^']*push=true[^']*|--export-cache '[^']*'/g)
      ?.filter((out) => !out.includes(LAYER_COMPRESSION)),
    [],
  );
  assertStringIncludes(LAYER_COMPRESSION, "compression=zstd");
  // The proxy by reference, expanded from the Secret at run time.
  assertStringIncludes(script, '--opt "build-arg:HTTPS_PROXY=${HTTPS_PROXY}"');
  assert(!script.includes("http://p"));
  // Workload Identity's token, fresh per call, for the registries' host only.
  assertStringIncludes(script, "docker-credential-ryph-gke");
  assertStringIncludes(script, `'{"credHelpers":{"us-central1-docker.pkg.dev":"ryph-gke"}}'`);
  // Every key once, in order, the setup warnings LAST: Cloud Build keeps 4 KiB of the output,
  // and a cut must never cost a digest. `[]` when the image has no record of them.
  await runBuild(script, (run) => {
    assertEquals(run.code, 0, run.stderr);
    assertEquals(run.stdout.split("\n").filter((l) => l.startsWith("@@ryph-result ")), [
      `@@ryph-result digest ${STUB_DIGESTS.environment}`,
      `@@ryph-result baked ${STUB_DIGESTS.baked}`,
      `@@ryph-result machine ${STUB_DIGESTS.machine}`,
      "@@ryph-result warm none",
      '@@ryph-result toolchains {"rustc": "1.97.1"}',
      "@@ryph-result setup-warnings []",
    ]);
    // No step is confined here: the NetworkPolicy is the pod's.
    assert(!run.calls.some((c) => c.startsWith("iptables")));
  }, { env: { HTTPS_PROXY: "http://p" } });
  // JSON is printed through `printf '%s'`: a dash `echo` would expand its escaped `\n`.
  assertStringIncludes(script, `printf '%s toolchains %s\\n' "$RYPH_RESULT_MARKER"`);
  assert(
    !/echo "\$RYPH_RESULT_MARKER (toolchains|setup-warnings) \$\(/.test(script),
    "no echo of JSON",
  );
});

test("a branch build: its own identity and registry, the shared cache read, none written", () => {
  const spec = buildSpec({
    defaultBranch: false,
    cacheScope: { read: ["repo-abc-default"], write: null },
  });
  const pod = (buildJobManifest(spec, OPTS).spec as Json).template.spec;
  assertEquals(pod.serviceAccountName, "ryph-branch-builder");
  const script = buildScript(spec, scriptOptions(OPTS));
  const branches = "us-central1-docker.pkg.dev/p/ryph-env-branches";
  assertStringIncludes(
    script,
    `'type=image,name=${branches}/repo-abc:env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  assertStringIncludes(
    script,
    `'type=image,name=${branches}/repo-abc:machine-env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  assert(!script.includes("p/ryph-envs/repo-abc:"), "nothing pushed to the shared registry");
  // The shared scope is read where it lives; no cache is exported anywhere.
  assertStringIncludes(
    script,
    "type=registry,ref=us-central1-docker.pkg.dev/p/ryph-envs/cache:repo-abc-default-environment'",
  );
  assert(!script.includes("--export-cache"));
});

test("a re-layer: stage 4 on the baked image, nothing cloned, no cache, no bake", async () => {
  const baked = `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`;
  const spec = buildSpec({ relayerFrom: baked, clone: { urls: {}, env: {} } });
  const script = buildScript(spec, scriptOptions(OPTS));
  assertStringIncludes(script, `--opt 'build-arg:RYPH_BAKED=${baked}'`);
  assert(!script.includes("build-arg:RYPH_MACHINE"));
  assert(!script.includes("/work/checkout"), "no checkout context, no repo Dockerfile");
  assert(!script.includes("-cache "));
  await runBuild(script, async (run) => {
    assertEquals(run.code, 0, run.stderr);
    // One pass for the image and one for its toolchains: no machine, no baked stage.
    const passes = run.calls.filter((c) => c.startsWith("buildctl build "));
    assertEquals(passes.map((c) => c.match(/--opt target=(\S+)/)?.[1]), [
      "environment",
      "toolchains",
    ]);
    assertStringIncludes(run.stdout, "@@ryph-result baked none\n");
    assertStringIncludes(run.stdout, "@@ryph-result machine none\n");
    assertEquals(await run.file("out/baked.json"), null);
  });
  assertStringIncludes(
    script,
    `'type=image,name=us-central1-docker.pkg.dev/p/ryph-envs/repo-abc:env-1,push=true,${LAYER_COMPRESSION}'`,
  );
  const init = initScript(spec);
  assert(!init.includes("clone "), "the init container only writes the file");
  const file = atob(init.match(/printf '%s' '([^']+)'/)![1]);
  assertStringIncludes(file, "FROM ${RYPH_BAKED} AS environment");
  assert(!file.includes("--phase image"), "nothing is baked again");
});

test("a warm build: the machine from the cache, its record checked, warm passes or cold ones", async () => {
  const baked = `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`;
  const spec = buildSpec({ warmFrom: baked });
  const script = buildScript(spec, scriptOptions(OPTS));
  // The machine is built on every build: it is what the image's record is checked against.
  assertStringIncludes(script, "machine.json");
  assertStringIncludes(script, "--opt target=machine-record");
  assertStringIncludes(
    script,
    'if [ -n "$machine_digest" ] && [ "$recorded" = "$machine_digest" ]',
  );
  // A record that could not be read says so, apart from a machine that changed.
  assertStringIncludes(script, "could not be read; building from scratch");
  const branches = script.slice(script.indexOf('if [ -n "$machine_digest" ]'));
  const [warm, cold] = branches.split("\nelse\n");
  const warmPasses = warm.slice(warm.indexOf("  warm=1"));
  assertStringIncludes(warmPasses, "--opt filename=Dockerfile.warm");
  assertStringIncludes(warmPasses, `--opt 'build-arg:RYPH_WARM=${baked}'`);
  assert(!warmPasses.includes("cache"), "a warm pass neither reads nor writes the cache");
  assert(!warmPasses.includes("RYPH_MACHINE="));
  assertStringIncludes(cold, "  warm=0");
  assertStringIncludes(cold, '--opt build-arg:RYPH_MACHINE="$machine"');
  assertStringIncludes(cold, "--import-cache");
  // The record names the machine just built: warm passes, and the result says so. A record of
  // another machine: the cold passes, from the cache.
  const targets = (calls: string[]) =>
    calls.filter((c) => c.startsWith("buildctl build ")).map((c) =>
      `${c.match(/--opt target=(\S+)/)?.[1]}${c.includes("Dockerfile.warm") ? " warm" : ""}`
    );
  await runBuild(script, (run) => {
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(run.stdout, "@@ryph-result warm 1\n");
    assertEquals(targets(run.calls), [
      "undefined",
      "machine-record warm",
      "environment warm",
      "baked warm",
      "toolchains warm",
    ]);
  });
  await runBuild(script, (run) => {
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(run.stdout, "@@ryph-result warm 0\n");
    assertStringIncludes(run.stdout, "the machine changed since the image this would build on");
    assertEquals(targets(run.calls).slice(2), ["environment", "baked", "toolchains"]);
  }, { recorded: "sha256:" + "0".repeat(64) });
  assertStringIncludes(script, "--opt context:checkout=local:checkout");
  const init = initScript(spec);
  assertStringIncludes(init, "clone ");
  const files = [...init.matchAll(/printf '%s' '([^']+)' \| base64 -d > (\S+)/g)]
    .map(([, body, path]) => [path, atob(body)]);
  assertEquals(files.map(([path]) => path), [
    "/work/outer/Dockerfile",
    "/work/outer/Dockerfile.warm",
  ]);
  assertStringIncludes(files[1][1], "FROM ${RYPH_WARM} AS baked");
  assertStringIncludes(files[1][1], "FROM scratch AS machine-record");
  assertStringIncludes(files[1][1], "--mount=type=bind,from=checkout,target=/ryph/incoming");
  assertStringIncludes(
    files[0][1],
    "RUN printf '%s\\n' \"$RYPH_MACHINE_DIGEST\" > /usr/local/lib/ryph/machine",
  );
});

test("without a Dockerfile the environment builds on the base, and an open registry needs no helper", () => {
  const spec = buildSpec({ dockerfileFrom: null });
  const script = buildScript(spec, scriptOptions({ ...OPTS, registryAuth: "none" }));
  assert(!script.includes("machine.json"));
  assertStringIncludes(script, `--opt build-arg:RYPH_MACHINE='${spec.baseImage}'`);
  assert(!script.includes("credHelpers"));
});

test("the .sh files read only their header's constants, and the header holds no unread one", async () => {
  const dir = new URL("../src/adapters/environment_builder/sh/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sh"));
  // The code only: what a comment names is not read.
  const code = (await Promise.all(files.map((name) => readFile(new URL(name, dir), "utf8"))))
    .map(shellBody).join("\n");
  const read = new Set([...code.matchAll(/\bRYPH_[A-Z0-9_]*/g)].map(([name]) => name));
  const header = (script: string) =>
    [...script.matchAll(/^readonly (RYPH_[A-Z0-9_]+)=/gm)].map(([, name]) => name);
  const constants = new Set([
    ...header(buildScript(buildSpec(), scriptOptions(OPTS))),
    ...header(WRITE_SCRIPTS),
    ...header(cloneScript()),
  ]);
  assertEquals([...read].filter((name) => !constants.has(name)), [], "read, never set");
  assertEquals([...constants].filter((name) => !read.has(name)), [], "set, never read");
});

test("only an unprefixed line is a result", () => {
  const log = `#9 0.1 @@ryph-result digest sha256:bad\n@@ryph-result digest ${DIGEST}\n`;
  assertEquals(resultLines(log, "digest"), [DIGEST]);
  assertEquals(resultLines("#9 0.1 @@ryph-result digest x", "digest"), []);
});

test("a build: job, owned secret, release, watch, logs, digest", async () => {
  const api = cluster();
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const result = expectOk(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertEquals(result.image, `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${DIGEST}`);
  assertEquals(result.toolchains, { rustc: "1.97.1" });
  assertEquals(result.setupWarnings, [
    { kind: "invalid", path: "api", error: "setup.yml: not valid YAML" },
  ]);
  const calls = api.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`);
  assertEquals(calls.slice(0, 4), [
    `POST ${JOBS}`,
    "POST /api/v1/namespaces/ryph-builds/secrets",
    `PATCH ${JOBS}/${NAME}`,
    `GET ${JOBS}/${NAME}`,
  ]);
  assertEquals(api.requests[0].body.spec.suspend, true);
  assertEquals(api.requests[1].body.metadata.ownerReferences[0].uid, "job-uid");
  assertEquals(api.requests[2].body, { spec: { suspend: false } });
  assertEquals(result.bakedImage, `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`);
  assertStringIncludes(result.log, "── buildkit ──");
  // Reading the log does NOT end the Job. It is the only record of this result until the core has
  // written the row, and the core says when it may go (`discard`).
  assertEquals(api.requests.filter((r) => r.method === "DELETE"), []);
});

test("discard is what deletes the Job, and a Job already gone is not an error", async () => {
  const api = cluster();
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  expectOk(await builder.build(buildSpec(), { signal: new AbortController().signal }));
  const read = api.requests.findIndex((r) => r.path.includes("/log?"));
  await builder.discard("env-1");
  const deleted = api.requests.findIndex((r) => r.method === "DELETE");
  assertEquals(api.requests[deleted].path, `${JOBS}/${NAME}?propagationPolicy=Background`);
  assert(read !== -1 && deleted > read, "deleted, and after the log was read");

  // Asked twice — the core discards from the settle that lost as well as the one that won — and
  // asked for a build that was never started.
  const gone = fakeApi(() => ({ status: 404, body: { message: 'jobs "x" not found' } }));
  const other = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: gone.fetch });
  await other.discard("env-1");
  assertEquals(gone.requests.length, 1);
});

test("a re-layer answers the baked image it was given", async () => {
  const api = cluster({
    buildkitLog: `@@ryph-result digest ${DIGEST}
@@ryph-result toolchains {}
`,
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const baked = `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`;
  const result = expectOk(
    await builder.build(buildSpec({ relayerFrom: baked, clone: { urls: {}, env: {} } }), {
      signal: new AbortController().signal,
    }),
  );
  assertEquals(result.bakedImage, baked);
});

test("a full build that reports no baked digest has nothing to re-layer later", async () => {
  const api = cluster({
    buildkitLog: `@@ryph-result digest ${DIGEST}
`,
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertStringIncludes(failure.message, "baked stage");
});

test("an API call that hangs is cut off, so a build cannot hold its slot for ever", async () => {
  const fetch =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
  const builder = kubernetesEnvironmentBuilder(
    { ...OPTS, requestTimeoutMs: 20 },
    silentDiagnostics(),
    { fetch },
  );
  const failure = expectFailure(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertStringIncludes(failure.message, "could not start the build job");
});

test("a failed build reports what the clone or the bake said", async () => {
  const api = cluster({
    condition: "Failed",
    buildkitLog: "",
    cloneLog:
      "ryph: cloning heartwood at x (main)\nfatal: repository 'http://forge/h.git' not found\n",
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertEquals(failure.kind, "failed");
  assertStringIncludes(failure.message, "BackoffLimitExceeded");
  assertStringIncludes(failure.message, "repository 'http://forge/h.git' not found");
});

test("a build that reports no digest has built nothing a run can use", async () => {
  const api = cluster({ buildkitLog: "#1 done\n" });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertStringIncludes(failure.message, "no image digest");
});

test("a build past its limit is a timeout, read before the core ends it", async () => {
  const api = cluster({ condition: null });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    await builder.build(buildSpec({ timeoutMs: 30 }), { signal: new AbortController().signal }),
  );
  assertEquals(failure.kind, "timeout");
  // The logs were read — and the Job left standing, still running, for the discard that follows
  // the row. `activeDeadlineSeconds` bounds it either way.
  assert(api.requests.some((r) => r.path.includes("/log?")));
  assertEquals(api.requests.filter((r) => r.method === "DELETE"), []);
  await builder.discard("env-1");
  assertEquals(
    api.requests.at(-1)?.path,
    `${JOBS}/${NAME}?propagationPolicy=Background`,
  );
});

test("an aborted build is read out and handed back for the core to discard", async () => {
  const api = cluster({ condition: null });
  const builder = kubernetesEnvironmentBuilder(
    { ...OPTS, pollIntervalMs: 1000 },
    silentDiagnostics(),
    { fetch: api.fetch },
  );
  const abort = new AbortController();
  const pending = builder.build(buildSpec(), { signal: abort.signal });
  setTimeout(() => abort.abort(), 10);
  const failure = expectFailure(await pending);
  assertEquals(failure.message, "the build was cancelled");
  assertEquals(api.requests.filter((r) => r.method === "DELETE"), []);
});

test("a Secret the API server refuses takes the suspended Job down with it", async () => {
  const api = fakeApi((req) => {
    if (req.method === "POST" && req.path === JOBS) {
      return { status: 201, body: { metadata: { name: NAME, uid: "job-uid" } } };
    }
    if (req.method === "POST") return { status: 403, body: { message: "forbidden" } };
    return undefined;
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    await builder.build(buildSpec(), { signal: new AbortController().signal }),
  );
  assertStringIncludes(failure.message, "could not start the build job");
  assertEquals(api.requests.at(-1)?.method, "DELETE");
});

// Adoption: a Job this process did not create, found by its deterministic name and read to the
// end exactly as the process that created it would have. What a redeploy mid-build costs.

/** What the core hands `adopt`: the stored row, and nothing that needs a forge or a credential. */
const adoptSpec = (overrides: Partial<AdoptSpec> = {}): AdoptSpec => ({
  environmentId: "env-1",
  subjectKey: "repo-abc",
  defaultBranch: true,
  relayerFrom: null,
  timeoutMs: 60 * 60 * 1000,
  ...overrides,
});

function expectSettled(outcome: AdoptResult) {
  if (outcome.kind !== "settled") throw new Error(`expected a settled build, got ${outcome.kind}`);
  return outcome.result;
}

test("adopting a job still running: watched to its end, and settled as if we started it", async () => {
  // Two polls before the Job completes — a build genuinely still going when the replacement
  // control plane finds it.
  let polls = 0;
  const running = fakeApi((req) => {
    if (req.method === "GET" && req.path === `${JOBS}/${NAME}`) {
      polls += 1;
      return polls <= 2
        ? { status: 200, body: { status: {} } }
        : { status: 200, body: { status: { conditions: [{ type: "Complete", status: "True" }] } } };
    }
    if (req.method === "GET" && req.path.startsWith("/api/v1/namespaces/ryph-builds/pods?")) {
      return {
        status: 200,
        body: { items: [{ metadata: { name: `${NAME}-abcde` }, status: { phase: "Succeeded" } }] },
      };
    }
    if (req.path.endsWith("/log?container=buildkit")) {
      return {
        status: 200,
        text: [
          `@@ryph-result digest ${DIGEST}`,
          `@@ryph-result baked ${BAKED}`,
          '@@ryph-result toolchains {"rustc": "1.97.1"}',
        ].join("\n"),
      };
    }
    if (req.path.endsWith("/log?container=clone")) return { status: 200, text: "" };
    return undefined;
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: running.fetch });
  const result = expectOk(
    expectSettled(await builder.adopt(adoptSpec(), { signal: new AbortController().signal })),
  );
  assertEquals(result.image, `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${DIGEST}`);
  assertEquals(result.toolchains, { rustc: "1.97.1" });
  assert(polls >= 3, "it waited for the build rather than reading a verdict that was not there");
  // Nothing was created, and nothing destroyed: an adoption only ever watches and reads. The Job
  // is the only place this result exists until the core has written the row.
  assertEquals(running.requests.filter((r) => r.method === "POST"), []);
  assertEquals(running.requests.filter((r) => r.method === "DELETE"), []);
});

test("adopting a job that finished while nobody watched: its result is still in the pod log", async () => {
  const api = cluster();
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const result = expectOk(
    expectSettled(await builder.adopt(adoptSpec(), { signal: new AbortController().signal })),
  );
  assertEquals(result.image, `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${DIGEST}`);
  assertEquals(result.bakedImage, `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`);
});

test("adopting a job that failed while nobody watched reports what it said", async () => {
  const api = cluster({
    condition: "Failed",
    buildkitLog: "#8 0.3 error: RUN cargo build exited 101\n",
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    expectSettled(await builder.adopt(adoptSpec(), { signal: new AbortController().signal })),
  );
  assertStringIncludes(failure.message, "cargo build exited 101");
});

test("a Complete job whose pod is gone says so, and does not blame the build", async () => {
  // The Job outlives its pod: on GKE the build node is scaled down minutes after the build that
  // asked for it, and the pod — with the log the digests were printed to — goes with the node.
  // The build really did succeed and really did push; what is lost is the name of what it pushed.
  const api = fakeApi((req) => {
    if (req.method === "GET" && req.path === `${JOBS}/${NAME}`) {
      return {
        status: 200,
        body: { status: { conditions: [{ type: "Complete", status: "True" }] } },
      };
    }
    if (req.method === "GET" && req.path.startsWith("/api/v1/namespaces/ryph-builds/pods?")) {
      return { status: 200, body: { items: [] } };
    }
    return undefined;
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const failure = expectFailure(
    expectSettled(await builder.adopt(adoptSpec(), { signal: new AbortController().signal })),
  );
  assertStringIncludes(failure.message, "its pod was gone before its result could be read");
  assertEquals(
    failure.message.includes("reported no image digest"),
    false,
    "the build is not blamed for a log that is not there",
  );
});

test("adopting a re-layer answers the baked image the row already carries", async () => {
  const api = cluster({
    buildkitLog: `@@ryph-result digest ${DIGEST}\n@@ryph-result toolchains {}\n`,
  });
  const baked = `us-central1-docker.pkg.dev/p/ryph-envs/repo-abc@${BAKED}`;
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const result = expectOk(expectSettled(
    await builder.adopt(adoptSpec({ relayerFrom: baked }), {
      signal: new AbortController().signal,
    }),
  ));
  assertEquals(result.bakedImage, baked);
});

test("no such job is an answer: gone, so the core can fail the row at once", async () => {
  const api = fakeApi(() => ({ status: 404, body: { message: 'jobs "x" not found' } }));
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const outcome = await builder.adopt(adoptSpec(), { signal: new AbortController().signal });
  assertEquals(outcome.kind, "gone");
  assertEquals(api.requests.length, 1, "one GET, and nothing deleted on the way out");
});

test("an API server that cannot be asked is not an answer, and fails nothing", async () => {
  const api = fakeApi(() => ({ status: 503, body: { message: "apiserver is shutting down" } }));
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const outcome = await builder.adopt(adoptSpec(), { signal: new AbortController().signal });
  assertEquals(outcome.kind, "unknown");
  if (outcome.kind === "unknown") assertStringIncludes(outcome.why, "503");
});

test("a job left suspended never ran and never will: it goes, and the row fails now", async () => {
  // The creator died between `POST` and the release. A suspended Job's activeDeadlineSeconds does
  // not count down, so watching it would hold the queue slot for the whole build timeout.
  const api = fakeApi((req) => {
    if (req.method === "GET" && req.path === `${JOBS}/${NAME}`) {
      return { status: 200, body: { spec: { suspend: true }, status: {} } };
    }
    return undefined;
  });
  const builder = kubernetesEnvironmentBuilder(OPTS, silentDiagnostics(), { fetch: api.fetch });
  const outcome = await builder.adopt(adoptSpec(), { signal: new AbortController().signal });
  assertEquals(outcome.kind, "gone");
  assertEquals(api.requests.at(-1)?.method, "DELETE");
});

test("a build reports the machine it pushed, by digest, and none where the machine is the base", async () => {
  const spec = buildSpec();
  const lines = async (script: string) =>
    await runBuild(script, (run) => {
      assertEquals(run.code, 0, run.stderr);
      return run.stdout.split("\n").filter((l) => l.startsWith("@@ryph-result "));
    });
  const built = await lines(buildScript(spec, scriptOptions(OPTS)));
  assert(built.includes(`@@ryph-result machine ${STUB_DIGESTS.machine}`), built.join("\n"));
  // Every key printed on every build, `none` where it has no value: a forged line is a second.
  const universal = await lines(
    buildScript(buildSpec({ dockerfileFrom: null }), scriptOptions(OPTS)),
  );
  assert(universal.includes("@@ryph-result machine none"), "the base is not ours to delete");
  assert(universal.includes("@@ryph-result warm none"));
  const relayer = await lines(buildScript(
    buildSpec({ relayerFrom: `${OPTS.registry}/repo-abc@${BAKED}` }),
    scriptOptions(OPTS),
  ));
  assert(relayer.includes("@@ryph-result machine none"));
  assert(relayer.includes("@@ryph-result baked none"));

  const machine = "sha256:" + "e".repeat(64);
  const read = readScriptResult(
    [
      `@@ryph-result digest ${DIGEST}`,
      `@@ryph-result baked ${BAKED}`,
      `@@ryph-result machine ${machine}`,
    ].join("\n"),
    spec,
    OPTS,
  );
  assert(read.ok);
  assertEquals(read.machineImage, `${OPTS.registry}/repo-abc@${machine}`);
  const none = readScriptResult(
    `@@ryph-result digest ${DIGEST}\n@@ryph-result baked ${BAKED}`,
    spec,
    OPTS,
  );
  assert(none.ok);
  assertEquals(none.machineImage, null);
});

test("a result key reported twice fails the build: one of the two is not the script's", () => {
  const spec = buildSpec();
  const forged = "sha256:" + "f".repeat(64);
  const lines = [
    `@@ryph-result digest ${DIGEST}`,
    `@@ryph-result baked ${BAKED}`,
    `@@ryph-result machine none`,
    `@@ryph-result warm none`,
    `@@ryph-result setup-warnings []`,
  ];
  for (
    const extra of [
      `@@ryph-result machine ${forged}`,
      `@@ryph-result digest ${forged}`,
      // A step that prints a clean bill for setup.yml is a second warnings line, not the answer.
      `@@ryph-result setup-warnings []`,
    ]
  ) {
    // Before the script's own lines or after them: neither wins.
    for (const log of [[extra, ...lines], [...lines, extra]]) {
      const read = readScriptResult(log.join("\n"), spec, OPTS);
      assert(!read.ok, extra);
      assertStringIncludes(read.message, "more than once");
    }
  }
  const clean = readScriptResult(lines.join("\n"), spec, OPTS);
  assert(clean.ok);
  assertEquals([clean.machineImage, clean.warm, clean.setupWarnings], [null, undefined, []]);
});

test("a setup-warnings line cut short, or missing, reads as unreadable, never as clean", async () => {
  const spec = buildSpec();
  const head = [`@@ryph-result digest ${DIGEST}`, `@@ryph-result baked ${BAKED}`];
  for (const log of [[...head, `@@ryph-result setup-warnings [{"kind":"step","pa`], head]) {
    const read = readScriptResult(log.join("\n"), spec, OPTS);
    assert(read.ok);
    assertEquals(read.setupWarnings, [{ kind: "unreadable", path: "" }]);
  }
  // The script prints the line on every build: `[]` where the image has no record.
  await runBuild(buildScript(spec, scriptOptions(OPTS)), (run) => {
    assertStringIncludes(run.stdout, "\n@@ryph-result setup-warnings []\n");
  });
});
